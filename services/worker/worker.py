from __future__ import annotations

import hashlib
import hmac
import json
import math
import os
import shutil
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo

try:
    import fcntl
except ImportError:  # pragma: no cover - the worker container is Linux
    fcntl = None


UTC = timezone.utc
PHILIPPINES_SAMPLES = {
    "luzon": (120.9842, 14.5995),
    "visayas": (123.8854, 10.3157),
    "mindanao": (125.4553, 7.1907),
}


def utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def read_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return fallback


def sha256_file(path: Path, cancel: threading.Event | None = None) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(8 * 1024 * 1024):
            if cancel and cancel.is_set():
                raise Cancelled("Checksum cancelled.")
            digest.update(chunk)
    return digest.hexdigest()


def xyz(longitude: float, latitude: float, zoom: int) -> tuple[int, int, int]:
    scale = 2**zoom
    x = int((longitude + 180.0) / 360.0 * scale)
    latitude_radians = math.radians(latitude)
    y = int((1.0 - math.asinh(math.tan(latitude_radians)) / math.pi) / 2.0 * scale)
    return zoom, x, y


def first_sunday(year: int, month: int, zone: ZoneInfo, hour: int) -> datetime:
    day = datetime(year, month, 1, hour, tzinfo=zone)
    return day + timedelta(days=(6 - day.weekday()) % 7)


def next_schedules(now: datetime, daily_hour: int, monthly_hour: int) -> tuple[datetime, datetime]:
    zone = now.tzinfo
    if not isinstance(zone, ZoneInfo):
        raise ValueError("A ZoneInfo timezone is required")
    daily = now.replace(hour=daily_hour, minute=0, second=0, microsecond=0)
    if daily <= now:
        daily += timedelta(days=1)
    monthly = first_sunday(now.year, now.month, zone, monthly_hour)
    if monthly <= now:
        if now.month == 12:
            monthly = first_sunday(now.year + 1, 1, zone, monthly_hour)
        else:
            monthly = first_sunday(now.year, now.month + 1, zone, monthly_hour)
    return daily, monthly


class Cancelled(RuntimeError):
    pass


class UpdateFailure(RuntimeError):
    pass


class ExclusiveFileLock:
    def __init__(self, path: Path):
        self.path = path
        self.handle: Any = None

    def __enter__(self) -> "ExclusiveFileLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.handle = self.path.open("a+")
        if fcntl is not None:
            try:
                fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as cause:
                self.handle.close()
                raise UpdateFailure("Another worker process holds the basemap update lock.") from cause
        return self

    def __exit__(self, *_: Any) -> None:
        if self.handle is not None:
            if fcntl is not None:
                fcntl.flock(self.handle.fileno(), fcntl.LOCK_UN)
            self.handle.close()


@dataclass(frozen=True)
class Settings:
    root: Path
    shared_secret: str
    osm_url: str
    checksum_url: str
    caddy_url: str
    timezone: ZoneInfo
    daily_hour: int
    monthly_hour: int
    check_interval: int
    java_opts: str
    threads: int
    max_zoom: int
    min_free_gb: int

    @classmethod
    def from_environment(cls) -> "Settings":
        secret = os.environ.get("WORKER_SHARED_SECRET", "")
        if len(secret) < 32:
            raise RuntimeError("WORKER_SHARED_SECRET must be at least 32 characters")
        max_zoom = int(os.environ.get("PLANETILER_MAX_ZOOM", "15"))
        if max_zoom != 15:
            raise RuntimeError("This deployment requires PLANETILER_MAX_ZOOM=15")
        return cls(
            root=Path(os.environ.get("DATA_ROOT", "/data")).resolve(),
            shared_secret=secret,
            osm_url=os.environ.get(
                "OSM_PBF_URL", "https://download.geofabrik.de/asia/philippines-latest.osm.pbf"
            ),
            checksum_url=os.environ.get(
                "OSM_CHECKSUM_URL",
                "https://download.geofabrik.de/asia/philippines-latest.osm.pbf.md5",
            ),
            caddy_url=os.environ.get("CADDY_INTERNAL_URL", "http://web").rstrip("/"),
            timezone=ZoneInfo(os.environ.get("TZ", "Asia/Manila")),
            daily_hour=int(os.environ.get("DAILY_UPDATE_HOUR", "2")),
            monthly_hour=int(os.environ.get("MONTHLY_REBUILD_HOUR", "1")),
            check_interval=max(15, int(os.environ.get("UPDATE_CHECK_INTERVAL_SECONDS", "60"))),
            java_opts=os.environ.get("PLANETILER_JAVA_OPTS", "-Xmx8g"),
            threads=max(1, int(os.environ.get("PLANETILER_THREADS", "4"))),
            max_zoom=max_zoom,
            min_free_gb=max(1, int(os.environ.get("MIN_FREE_DISK_GB", "25"))),
        )


class BasemapController:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.private = settings.root / "private"
        self.public = settings.root / "public"
        self.work = settings.root / "work"
        self.logs_dir = settings.root / "logs"
        self.state_path = self.private / "state.json"
        self.audit_path = self.logs_dir / "audit.jsonl"
        self.log_path = self.logs_dir / "worker.log"
        for directory in (self.private, self.public, self.work, self.logs_dir):
            directory.mkdir(parents=True, exist_ok=True)
        self.state_lock = threading.RLock()
        self.job_lock = threading.Lock()
        self.cancel_event = threading.Event()
        self.process: subprocess.Popen[bytes] | None = None
        self.state = read_json(self.state_path, self._initial_state())
        if self.state.get("job", {}).get("status") in {"queued", "running", "cancelling"}:
            self.state["last_failure"] = {
                "at": utc_now(),
                "message": "The worker restarted during an update; the active basemap was not changed.",
            }
            self.state["job"] = self._idle_job()
        self._safe_clear_work_root()
        self._remove_old_archives()
        self._save()
        self._write_health()

    @staticmethod
    def _idle_job() -> dict[str, Any]:
        return {
            "status": "idle",
            "action": None,
            "stage": None,
            "progress": 0,
            "message": "Ready",
            "started_at": None,
            "cancel_requested": False,
        }

    def _initial_state(self) -> dict[str, Any]:
        return {
            "service": "healthy",
            "active": None,
            "previous": None,
            "source": None,
            "job": self._idle_job(),
            "last_check": None,
            "last_success": None,
            "last_failure": None,
            "last_scheduled_daily": None,
            "last_scheduled_monthly": None,
        }

    def _save(self) -> None:
        with self.state_lock:
            atomic_json(self.state_path, self.state)

    def _log(self, message: str) -> None:
        line = f"{utc_now()} {message}"
        with self.log_path.open("a", encoding="utf-8") as target:
            target.write(line + "\n")

    def _audit(self, actor: str, action: str, outcome: str, detail: str = "") -> None:
        entry = {
            "at": utc_now(),
            "actor": actor,
            "action": action,
            "outcome": outcome,
            "detail": detail,
        }
        with self.audit_path.open("a", encoding="utf-8") as target:
            target.write(json.dumps(entry, sort_keys=True) + "\n")

    def _job(self, **updates: Any) -> None:
        with self.state_lock:
            self.state["job"].update(updates)
            self._save()
            self._write_health()

    def _disk(self) -> dict[str, int]:
        usage = shutil.disk_usage(self.settings.root)
        return {"total": usage.total, "used": usage.used, "free": usage.free}

    def status(self) -> dict[str, Any]:
        now = datetime.now(self.settings.timezone)
        daily, monthly = next_schedules(now, self.settings.daily_hour, self.settings.monthly_hour)
        with self.state_lock:
            snapshot = json.loads(json.dumps(self.state))
        snapshot["disk"] = self._disk()
        snapshot["schedule"] = {
            "timezone": str(self.settings.timezone),
            "daily_incremental": f"02:00" if self.settings.daily_hour == 2 else f"{self.settings.daily_hour:02d}:00",
            "monthly_full": f"First Sunday {self.settings.monthly_hour:02d}:00",
            "next_daily": daily.isoformat(),
            "next_monthly": monthly.isoformat(),
        }
        snapshot["native_max_zoom"] = self.settings.max_zoom
        snapshot["display_max_zoom"] = 22
        return snapshot

    def logs(self, tail: int) -> list[str]:
        try:
            lines = self.log_path.read_text(encoding="utf-8", errors="replace").splitlines()
        except FileNotFoundError:
            return []
        return lines[-tail:]

    def audit(self, tail: int = 500) -> list[dict[str, Any]]:
        try:
            lines = self.audit_path.read_text(encoding="utf-8", errors="replace").splitlines()
        except FileNotFoundError:
            return []
        result = []
        for line in lines[-tail:]:
            try:
                result.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return list(reversed(result))

    def start(self, action: str, actor: str) -> dict[str, Any]:
        if action == "cancel":
            return self.cancel(actor)
        if action == "rollback":
            return self.rollback(actor)
        if not self.job_lock.acquire(blocking=False):
            raise UpdateFailure("Another basemap operation is already running.")
        self.cancel_event.clear()
        self._job(
            status="queued",
            action=action,
            stage="queued",
            progress=0,
            message=f"{action.capitalize()} queued",
            started_at=utc_now(),
            cancel_requested=False,
        )
        threading.Thread(target=self._run, args=(action, actor), daemon=True).start()
        self._audit(actor, action, "accepted")
        return {"accepted": True, "action": action}

    def cancel(self, actor: str) -> dict[str, Any]:
        with self.state_lock:
            busy = self.state["job"]["status"] in {"queued", "running", "cancelling"}
        if not busy:
            return {"accepted": False, "message": "No update is running."}
        self.cancel_event.set()
        self._job(status="cancelling", cancel_requested=True, message="Cancellation requested")
        process = self.process
        if process and process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        self._audit(actor, "cancel", "accepted")
        return {"accepted": True, "message": "The worker will stop at the next safe point."}

    def rollback(self, actor: str) -> dict[str, Any]:
        if self.job_lock.locked():
            raise UpdateFailure("Cannot roll back while another operation is running.")
        with self.state_lock:
            previous = self.state.get("previous")
            active = self.state.get("active")
            if not previous or not active:
                raise UpdateFailure("No previous basemap is available for rollback.")
            previous_file = self.public / Path(previous["url"]).name
            if not previous_file.is_file():
                raise UpdateFailure("The previous PMTiles archive is missing.")
            self.state["active"], self.state["previous"] = previous, active
            atomic_json(self.public / "active.json", previous)
            self.state["last_success"] = {
                "at": utc_now(),
                "action": "rollback",
                "version": previous["version"],
            }
            self._save()
            self._write_health()
        self._audit(actor, "rollback", "success", previous["version"])
        self._log(f"Rollback activated {previous['version']}")
        return {"accepted": True, "active": previous}

    def _run(self, action: str, actor: str) -> None:
        job_id = uuid.uuid4().hex
        work_dir = (self.work / job_id).resolve()
        work_dir.mkdir(parents=True, exist_ok=False)
        try:
            with ExclusiveFileLock(self.private / "update.lock"):
                self._job(status="running", stage="starting", progress=1, message="Preparing operation")
                if action == "check":
                    self._check_only()
                elif action == "validate":
                    self._validate_active()
                elif action in {"update", "rebuild"}:
                    self._update(work_dir, force_full=action == "rebuild")
                else:
                    raise UpdateFailure(f"Unsupported action: {action}")
            self._audit(actor, action, "success")
        except Cancelled as cause:
            self._log(str(cause))
            self._audit(actor, action, "cancelled", str(cause))
            with self.state_lock:
                self.state["last_failure"] = {"at": utc_now(), "message": str(cause), "cancelled": True}
        except Exception as cause:
            self._log(f"{action} failed: {cause}")
            self._audit(actor, action, "failed", str(cause))
            with self.state_lock:
                self.state["last_failure"] = {"at": utc_now(), "message": str(cause), "cancelled": False}
        finally:
            self.process = None
            self._safe_remove_work(work_dir)
            self._job(**self._idle_job())
            self.job_lock.release()

    def _check_cancel(self) -> None:
        if self.cancel_event.is_set():
            raise Cancelled("The operation was cancelled; the active basemap was not changed.")

    def _check_disk(self) -> None:
        free = self._disk()["free"]
        required = self.settings.min_free_gb * 1024**3
        if free < required:
            raise UpdateFailure(
                f"Insufficient disk space: {free / 1024**3:.1f} GiB free; {self.settings.min_free_gb} GiB required."
            )

    def _remote_info(self) -> dict[str, str]:
        self._job(stage="checking", progress=5, message="Checking Geofabrik metadata")
        request = urllib.request.Request(self.settings.checksum_url, headers={"User-Agent": "DC-Geomap/0.1"})
        with urllib.request.urlopen(request, timeout=30) as response:
            text = response.read(4096).decode("ascii", errors="strict").strip()
        checksum = text.split()[0].lower()
        if len(checksum) != 32 or any(char not in "0123456789abcdef" for char in checksum):
            raise UpdateFailure("Geofabrik returned an invalid MD5 checksum.")
        modified = ""
        try:
            head = urllib.request.Request(
                self.settings.osm_url, method="HEAD", headers={"User-Agent": "DC-Geomap/0.1"}
            )
            with urllib.request.urlopen(head, timeout=30) as response:
                modified = response.headers.get("Last-Modified", "")
        except urllib.error.URLError:
            pass
        result = {"checksum_md5": checksum, "last_modified": modified, "checked_at": utc_now()}
        with self.state_lock:
            self.state["last_check"] = result
            self._save()
        return result

    def _check_only(self) -> None:
        remote = self._remote_info()
        installed = (self.state.get("source") or {}).get("remote_checksum_md5")
        changed = installed != remote["checksum_md5"]
        self._log(f"Update check completed: {'change available' if changed else 'current'}")
        self._job(stage="complete", progress=100, message="Update available" if changed else "Already current")

    def _download(self, destination: Path, expected_md5: str) -> None:
        partial = destination.with_suffix(destination.suffix + ".partial")
        request = urllib.request.Request(self.settings.osm_url, headers={"User-Agent": "DC-Geomap/0.1"})
        digest = hashlib.md5(usedforsecurity=False)
        with urllib.request.urlopen(request, timeout=120) as response, partial.open("wb") as target:
            total = int(response.headers.get("Content-Length", "0") or 0)
            received = 0
            while chunk := response.read(4 * 1024 * 1024):
                self._check_cancel()
                target.write(chunk)
                digest.update(chunk)
                received += len(chunk)
                if total:
                    self._job(
                        stage="downloading",
                        progress=min(30, 10 + int(received / total * 20)),
                        message=f"Downloading source · {received / 1024**2:.0f} / {total / 1024**2:.0f} MiB",
                    )
            target.flush()
            os.fsync(target.fileno())
        if digest.hexdigest().lower() != expected_md5:
            partial.unlink(missing_ok=True)
            raise UpdateFailure("Downloaded PBF checksum did not match Geofabrik.")
        os.replace(partial, destination)

    def _run_command(self, command: list[str], cwd: Path, label: str) -> None:
        self._log(f"Starting {label}: {' '.join(command)}")
        with self.log_path.open("ab") as log:
            process = subprocess.Popen(
                command,
                cwd=cwd,
                stdout=log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            self.process = process
            while process.poll() is None:
                if self.cancel_event.wait(1):
                    try:
                        os.killpg(process.pid, signal.SIGTERM)
                        process.wait(timeout=20)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                    raise Cancelled(f"{label} was cancelled; the active basemap was not changed.")
            if process.returncode != 0:
                raise UpdateFailure(f"{label} failed with exit code {process.returncode}.")
            self.process = None

    def _osmium_timestamp(self, source: Path) -> str:
        result = subprocess.run(
            ["osmium", "fileinfo", "-g", "header.option.osmosis_replication_timestamp", str(source)],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        value = result.stdout.strip()
        return value or utc_now()

    def _validate_source(self, source: Path, cwd: Path) -> str:
        self._job(stage="validating-source", progress=38, message="Validating OSM source")
        self._run_command(["osmium", "fileinfo", "-e", str(source)], cwd, "OSM source validation")
        return self._osmium_timestamp(source)

    def _build(self, source: Path, output: Path, cwd: Path) -> None:
        self._job(stage="building", progress=45, message="Planetiler is building native zooms 0–15")
        command = [
            "java",
            *self.settings.java_opts.split(),
            "-jar",
            "/opt/planetiler/planetiler.jar",
            "--area=philippines",
            f"--osm-path={source}",
            f"--output={output}",
            "--download",
            "--force",
            f"--threads={self.settings.threads}",
            f"--maxzoom={self.settings.max_zoom}",
            f"--render-maxzoom={self.settings.max_zoom}",
            f"--tmpdir={self.private / 'tmp'}",
        ]
        self._run_command(command, self.private / "planetiler", "Planetiler build")

    def _validate_archive(self, archive: Path, cwd: Path) -> None:
        self._job(stage="validating-archive", progress=82, message="Validating PMTiles archive")
        if not archive.is_file() or archive.stat().st_size < 127:
            raise UpdateFailure("Planetiler did not produce a valid-sized PMTiles archive.")
        self._run_command(["pmtiles", "verify", str(archive)], cwd, "PMTiles structure validation")
        header = subprocess.run(
            ["pmtiles", "show", str(archive), "--header-json"],
            capture_output=True,
            text=True,
            timeout=60,
            check=True,
        )
        metadata = json.loads(header.stdout)
        maximum = metadata.get("max_zoom", metadata.get("maxZoom"))
        if int(maximum) != self.settings.max_zoom:
            raise UpdateFailure(f"PMTiles max zoom is {maximum}; expected {self.settings.max_zoom}.")
        for region, (longitude, latitude) in PHILIPPINES_SAMPLES.items():
            for zoom in (5, 10, self.settings.max_zoom):
                z, x, y = xyz(longitude, latitude, zoom)
                result = subprocess.run(
                    ["pmtiles", "tile", str(archive), str(z), str(x), str(y)],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    timeout=60,
                    check=False,
                )
                if result.returncode != 0:
                    raise UpdateFailure(f"Missing or unreadable {region} tile at z{z}/{x}/{y}.")

    def _range_test(self, filename: str) -> None:
        self._job(stage="range-test", progress=94, message="Testing Caddy HTTP Range support")
        request = urllib.request.Request(
            f"{self.settings.caddy_url}/basemap/{filename}",
            headers={"Range": "bytes=0-126", "User-Agent": "DC-Geomap-Validator/0.1"},
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = response.read()
            content_range = response.headers.get("Content-Range", "")
            if response.status != HTTPStatus.PARTIAL_CONTENT or len(payload) != 127 or not content_range.startswith("bytes 0-126/"):
                raise UpdateFailure("Caddy did not return a valid HTTP 206 Range response.")

    def _update(self, work_dir: Path, force_full: bool) -> None:
        self._check_disk()
        remote = self._remote_info()
        current_source = self.state.get("source") or {}
        if not force_full and current_source.get("remote_checksum_md5") == remote["checksum_md5"]:
            self._log("No new Geofabrik data; rebuild skipped")
            self._job(stage="complete", progress=100, message="No new OSM data; rebuild skipped")
            return

        candidate_source = work_dir / "philippines.osm.pbf"
        canonical_source = self.private / "source" / "philippines.osm.pbf"
        if force_full or not canonical_source.is_file():
            self._job(stage="downloading", progress=10, message="Downloading full Philippines extract")
            self._download(candidate_source, remote["checksum_md5"])
            source_mode = "full"
        else:
            self._job(stage="incremental", progress=15, message="Preparing incremental OSM update")
            shutil.copy2(canonical_source, candidate_source)
            self._run_command(
                ["pyosmium-up-to-date", "--size", "20000", "-v", str(candidate_source)],
                work_dir,
                "Incremental OSM update",
            )
            source_mode = "incremental"
        self._check_cancel()
        osm_timestamp = self._validate_source(candidate_source, work_dir)
        source_checksum = sha256_file(candidate_source, self.cancel_event)
        version = f"{osm_timestamp[:10]}-{source_checksum[:6]}"
        filename = f"philippines-{version}.pmtiles"
        candidate_archive = work_dir / filename
        self._build(candidate_source, candidate_archive, work_dir)
        self._check_cancel()
        self._validate_archive(candidate_archive, work_dir)
        pmtiles_checksum = sha256_file(candidate_archive, self.cancel_event)
        public_archive = self.public / filename
        shutil.copy2(candidate_archive, public_archive)
        try:
            self._range_test(filename)
            self._check_cancel()
            manifest = {
                "version": version,
                "url": f"/basemap/{filename}",
                "osm_timestamp": osm_timestamp,
                "source_checksum": source_checksum,
                "pmtiles_checksum": pmtiles_checksum,
                "archive_size": public_archive.stat().st_size,
                "native_max_zoom": self.settings.max_zoom,
                "activated_at": utc_now(),
            }
            with self.state_lock:
                previous = self.state.get("active")
                self.state["previous"] = previous
                self.state["active"] = manifest
                self.state["source"] = {
                    "path": str(canonical_source),
                    "mode": source_mode,
                    "osm_timestamp": osm_timestamp,
                    "checksum_sha256": source_checksum,
                    "remote_checksum_md5": remote["checksum_md5"],
                    "updated_at": utc_now(),
                }
                self.state["last_success"] = {
                    "at": utc_now(),
                    "action": "rebuild" if force_full else "update",
                    "version": version,
                }
                os.replace(candidate_source, canonical_source)
                atomic_json(self.public / "active.json", manifest)
                self._save()
                self._write_health()
            self._remove_old_archives()
            self._job(stage="complete", progress=100, message=f"Activated {version}")
            self._log(f"Activated {filename}")
        except Exception:
            public_archive.unlink(missing_ok=True)
            raise

    def _validate_active(self) -> None:
        active = self.state.get("active")
        if not active:
            raise UpdateFailure("No active basemap is installed.")
        archive = self.public / Path(active["url"]).name
        self._validate_archive(archive, self.work)
        if sha256_file(archive, self.cancel_event) != active["pmtiles_checksum"]:
            raise UpdateFailure("The active PMTiles checksum has changed.")
        self._range_test(archive.name)
        self._job(stage="complete", progress=100, message="Active basemap is valid")

    def _remove_old_archives(self) -> None:
        keep = {
            Path(item["url"]).name
            for item in (self.state.get("active"), self.state.get("previous"))
            if item
        }
        for archive in self.public.glob("philippines-*.pmtiles"):
            if archive.name not in keep:
                archive.unlink(missing_ok=True)

    def _write_health(self) -> None:
        active = self.state.get("active")
        payload = {
            "status": "up" if active else "waiting_for_initial_build",
            "active_version": active.get("version") if active else None,
            "worker_status": self.state.get("job", {}).get("status", "unknown"),
            "updated_at": utc_now(),
        }
        atomic_json(self.public / "health.json", payload)

    def _safe_remove_work(self, target: Path) -> None:
        resolved = target.resolve()
        if resolved.parent != self.work.resolve():
            raise RuntimeError("Refusing to remove a path outside the worker staging directory")
        shutil.rmtree(resolved, ignore_errors=True)

    def _safe_clear_work_root(self) -> None:
        for item in self.work.iterdir():
            if item.is_dir():
                self._safe_remove_work(item)
            else:
                item.unlink(missing_ok=True)

    def scheduler(self) -> None:
        while True:
            now = datetime.now(self.settings.timezone)
            monthly = first_sunday(now.year, now.month, self.settings.timezone, self.settings.monthly_hour)
            monthly_key = monthly.date().isoformat()
            daily_key = now.date().isoformat()
            if (
                now.date() == monthly.date()
                and now.hour >= self.settings.monthly_hour
                and self.state.get("last_scheduled_monthly") != monthly_key
            ):
                try:
                    self.start("rebuild", "scheduler")
                    self.state["last_scheduled_monthly"] = monthly_key
                    self._save()
                except UpdateFailure:
                    pass
            elif now.hour >= self.settings.daily_hour and self.state.get("last_scheduled_daily") != daily_key:
                try:
                    self.start("update", "scheduler")
                    self.state["last_scheduled_daily"] = daily_key
                    self._save()
                except UpdateFailure:
                    pass
            time.sleep(self.settings.check_interval)


class WorkerHandler(BaseHTTPRequestHandler):
    controller: BasemapController
    server_version = "DCGeomapWorker/0.1"

    def log_message(self, format: str, *args: Any) -> None:
        self.controller._log(f"http {self.address_string()} {format % args}")

    def _send(self, status: int, payload: Any) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        supplied = self.headers.get("Authorization", "")
        expected = f"Bearer {self.controller.settings.shared_secret}"
        return hmac.compare_digest(supplied, expected)

    def _guard(self) -> bool:
        if self._authorized():
            return True
        self._send(HTTPStatus.UNAUTHORIZED, {"error": "Unauthorized"})
        return False

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self._send(HTTPStatus.OK, {"status": "ok"})
            return
        if not self._guard():
            return
        if parsed.path == "/v1/status":
            self._send(HTTPStatus.OK, self.controller.status())
        elif parsed.path == "/v1/logs":
            tail = min(max(int(parse_qs(parsed.query).get("tail", ["300"])[0]), 1), 5000)
            self._send(HTTPStatus.OK, {"lines": self.controller.logs(tail)})
        elif parsed.path == "/v1/audit":
            self._send(HTTPStatus.OK, {"events": self.controller.audit()})
        else:
            self._send(HTTPStatus.NOT_FOUND, {"error": "Not found"})

    def do_POST(self) -> None:
        if not self._guard():
            return
        prefix = "/v1/actions/"
        if not self.path.startswith(prefix):
            self._send(HTTPStatus.NOT_FOUND, {"error": "Not found"})
            return
        action = self.path[len(prefix) :]
        if action not in {"check", "update", "rebuild", "cancel", "validate", "rollback"}:
            self._send(HTTPStatus.NOT_FOUND, {"error": "Unknown action"})
            return
        actor = self.headers.get("X-DCGeomaps-Actor", "unknown")[:254]
        try:
            self._send(HTTPStatus.ACCEPTED, self.controller.start(action, actor))
        except UpdateFailure as cause:
            self._send(HTTPStatus.CONFLICT, {"error": str(cause)})


def main() -> None:
    settings = Settings.from_environment()
    controller = BasemapController(settings)
    WorkerHandler.controller = controller
    threading.Thread(target=controller.scheduler, daemon=True).start()
    bind = os.environ.get("WORKER_BIND", "127.0.0.1")
    port = int(os.environ.get("WORKER_PORT", "8788"))
    controller._log(f"Worker listening on {bind}:{port}")
    ThreadingHTTPServer((bind, port), WorkerHandler).serve_forever()


if __name__ == "__main__":
    main()
