from __future__ import annotations

import hashlib
import hmac
import http.client
import json
import math
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
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
RETRYABLE_HTTP_STATUS = {408, 425, 429, 500, 502, 503, 504}


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


def md5_file(path: Path, cancel: threading.Event | None = None) -> str:
    digest = hashlib.md5(usedforsecurity=False)
    with path.open("rb") as source:
        while chunk := source.read(8 * 1024 * 1024):
            if cancel and cancel.is_set():
                raise Cancelled("Checksum cancelled.")
            digest.update(chunk)
    return digest.hexdigest()


def java_heap_bytes(options: str) -> int:
    match = re.search(r"(?:^|\s)-Xmx(\d+)([kKmMgGtT]?)\b", options)
    if not match:
        return 0
    units = {"": 1, "k": 1024, "m": 1024**2, "g": 1024**3, "t": 1024**4}
    return int(match.group(1)) * units[match.group(2).lower()]


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


class ChecksumMismatch(UpdateFailure):
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
    download_retries: int
    retry_base_seconds: int
    download_timeout_seconds: int
    scheduled_retry_minutes: int
    scheduled_retry_max_attempts: int
    disk_working_multiplier: float
    memory_reserve_mb: int
    min_available_memory_mb: int
    log_max_mb: int
    log_backups: int

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
            download_retries=max(1, int(os.environ.get("DOWNLOAD_RETRIES", "5"))),
            retry_base_seconds=max(1, int(os.environ.get("DOWNLOAD_RETRY_BASE_SECONDS", "5"))),
            download_timeout_seconds=max(30, int(os.environ.get("DOWNLOAD_TIMEOUT_SECONDS", "120"))),
            scheduled_retry_minutes=max(1, int(os.environ.get("SCHEDULED_RETRY_MINUTES", "30"))),
            scheduled_retry_max_attempts=max(1, int(os.environ.get("SCHEDULED_RETRY_MAX_ATTEMPTS", "5"))),
            disk_working_multiplier=max(2.0, float(os.environ.get("DISK_WORKING_MULTIPLIER", "8"))),
            memory_reserve_mb=max(256, int(os.environ.get("MEMORY_RESERVE_MB", "512"))),
            min_available_memory_mb=max(128, int(os.environ.get("MIN_AVAILABLE_MEMORY_MB", "256"))),
            log_max_mb=max(1, int(os.environ.get("WORKER_LOG_MAX_MB", "50"))),
            log_backups=max(1, int(os.environ.get("WORKER_LOG_BACKUPS", "3"))),
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
        self.log_lock = threading.Lock()
        self.job_lock = threading.Lock()
        self.cancel_event = threading.Event()
        self.process: subprocess.Popen[bytes] | None = None
        self.state = read_json(self.state_path, self._initial_state())
        self.state.setdefault("scheduled_retry", None)
        if self.state.get("job", {}).get("status") in {"queued", "running", "cancelling"}:
            interrupted = self.state.get("job", {})
            self.state["last_failure"] = {
                "at": utc_now(),
                "message": "The worker restarted during an update; the active basemap was not changed.",
                "category": "interrupted",
                "action": interrupted.get("action"),
                "stage": interrupted.get("stage"),
                "cancelled": False,
            }
            if interrupted.get("scheduled_kind"):
                self._schedule_retry(
                    action=str(interrupted.get("action") or "update"),
                    kind=str(interrupted["scheduled_kind"]),
                    key=str(interrupted.get("scheduled_key") or ""),
                    attempt=int(interrupted.get("scheduled_attempt") or 1),
                    detail="Worker restarted during the scheduled operation.",
                )
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
            "updated_at": utc_now(),
            "cancel_requested": False,
            "bytes_downloaded": 0,
            "bytes_total": 0,
            "bytes_per_second": 0,
            "eta_seconds": None,
            "attempt": None,
            "max_attempts": None,
            "resumed": False,
            "scheduled_kind": None,
            "scheduled_key": None,
            "scheduled_attempt": None,
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
            "scheduled_retry": None,
        }

    def _save(self) -> None:
        with self.state_lock:
            atomic_json(self.state_path, self.state)

    def _rotate_log_locked(self, incoming: int) -> None:
        maximum = self.settings.log_max_mb * 1024**2
        try:
            current = self.log_path.stat().st_size
        except FileNotFoundError:
            current = 0
        if current + incoming <= maximum:
            return
        oldest = self.log_path.with_name(f"{self.log_path.name}.{self.settings.log_backups}")
        oldest.unlink(missing_ok=True)
        for index in range(self.settings.log_backups - 1, 0, -1):
            source = self.log_path.with_name(f"{self.log_path.name}.{index}")
            if source.exists():
                os.replace(source, self.log_path.with_name(f"{self.log_path.name}.{index + 1}"))
        if self.log_path.exists():
            os.replace(self.log_path, self.log_path.with_name(f"{self.log_path.name}.1"))

    def _emit_log(self, payload: bytes) -> None:
        with self.log_lock:
            self._rotate_log_locked(len(payload))
            with self.log_path.open("ab") as target:
                target.write(payload)
                target.flush()
            try:
                sys.stdout.buffer.write(payload)
                sys.stdout.buffer.flush()
            except (AttributeError, OSError):
                print(payload.decode("utf-8", errors="replace"), end="", flush=True)

    def _log(self, message: str) -> None:
        self._emit_log(f"{utc_now()} {message}\n".encode("utf-8"))

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
            updates.setdefault("updated_at", utc_now())
            self.state["job"].update(updates)
            self._save()
            self._write_health()

    def _disk(self) -> dict[str, int]:
        usage = shutil.disk_usage(self.settings.root)
        return {"total": usage.total, "used": usage.used, "free": usage.free}

    @staticmethod
    def _memory() -> dict[str, int]:
        values: dict[str, int] = {}
        try:
            for line in Path("/proc/meminfo").read_text(encoding="ascii").splitlines():
                key, raw = line.split(":", 1)
                values[key] = int(raw.strip().split()[0]) * 1024
        except (FileNotFoundError, OSError, ValueError):
            pass
        total = values.get("MemTotal", 0)
        available = values.get("MemAvailable", 0)
        try:
            raw_limit = Path("/sys/fs/cgroup/memory.max").read_text(encoding="ascii").strip()
            limit = 0 if raw_limit == "max" else int(raw_limit)
            current = int(Path("/sys/fs/cgroup/memory.current").read_text(encoding="ascii").strip())
            if limit > 0:
                total = min(value for value in (total, limit) if value > 0)
                cgroup_available = max(0, limit - current)
                available = min(value for value in (available, cgroup_available) if value >= 0)
        except (FileNotFoundError, OSError, ValueError):
            pass
        return {"total": total, "available": available}

    def _resource_status(self, remote_size: int = 0) -> dict[str, Any]:
        disk = self._disk()
        memory = self._memory()
        heap = java_heap_bytes(self.settings.java_opts)
        disk_floor = self.settings.min_free_gb * 1024**3
        estimated_working = int(remote_size * self.settings.disk_working_multiplier)
        required_disk = max(disk_floor, estimated_working)
        reserve = self.settings.memory_reserve_mb * 1024**2
        minimum_available = self.settings.min_available_memory_mb * 1024**2
        warnings = []
        if disk["free"] < required_disk:
            warnings.append("disk")
        if memory["total"] and heap and heap + reserve > memory["total"]:
            warnings.append("memory-limit")
        if memory["available"] and memory["available"] < minimum_available:
            warnings.append("memory-pressure")
        return {
            "safe": not warnings,
            "warnings": warnings,
            "disk_required_free": required_disk,
            "disk_configured_floor": disk_floor,
            "memory_total": memory["total"],
            "memory_available": memory["available"],
            "java_heap": heap,
            "memory_reserve": reserve,
            "minimum_available_memory": minimum_available,
        }

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
            "retry": snapshot.get("scheduled_retry"),
        }
        remote_size = int((snapshot.get("last_check") or {}).get("content_length") or 0)
        snapshot["resources"] = self._resource_status(remote_size)
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

    def start(
        self,
        action: str,
        actor: str,
        *,
        scheduled_kind: str | None = None,
        scheduled_key: str | None = None,
        scheduled_attempt: int | None = None,
    ) -> dict[str, Any]:
        if action == "cancel":
            return self.cancel(actor)
        if action == "rollback":
            return self.rollback(actor)
        if not self.job_lock.acquire(blocking=False):
            raise UpdateFailure("Another basemap operation is already running.")
        self.cancel_event.clear()
        with self.state_lock:
            self.state["job"] = {
                **self._idle_job(),
                "status": "queued",
                "action": action,
                "stage": "queued",
                "progress": 0,
                "message": f"{action.capitalize()} queued",
                "started_at": utc_now(),
                "scheduled_kind": scheduled_kind,
                "scheduled_key": scheduled_key,
                "scheduled_attempt": scheduled_attempt,
            }
            self._save()
            self._write_health()
        threading.Thread(
            target=self._run,
            args=(action, actor, scheduled_kind, scheduled_key, scheduled_attempt),
            daemon=True,
        ).start()
        self._audit(actor, action, "accepted")
        self._log(f"Accepted {action} requested by {actor}")
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

    @staticmethod
    def _failure_category(cause: Exception, stage: str | None) -> str:
        message = str(cause).lower()
        if "disk" in message or "space" in message:
            return "disk"
        if "memory" in message or "heap" in message or "outofmemory" in message:
            return "memory"
        if "checksum" in message:
            return "checksum"
        if any(word in message for word in ("timed out", "url", "network", "connection", "http")):
            return "network"
        if stage == "building" or "planetiler" in message:
            return "build"
        if stage and (stage.startswith("validating") or stage == "range-test"):
            return "validation"
        return "internal"

    def _schedule_retry(self, action: str, kind: str, key: str, attempt: int, detail: str) -> dict[str, Any] | None:
        if attempt >= self.settings.scheduled_retry_max_attempts:
            return None
        due = datetime.now(UTC) + timedelta(minutes=self.settings.scheduled_retry_minutes)
        retry = {
            "kind": kind,
            "key": key,
            "action": action,
            "attempt": attempt + 1,
            "max_attempts": self.settings.scheduled_retry_max_attempts,
            "due_at": due.isoformat().replace("+00:00", "Z"),
            "last_error": detail,
        }
        self.state["scheduled_retry"] = retry
        return retry

    def _record_success(self, action: str, scheduled_kind: str | None, scheduled_key: str | None) -> None:
        completed_at = utc_now()
        with self.state_lock:
            failure = self.state.get("last_failure")
            if failure and not failure.get("resolved_at"):
                failure["resolved_at"] = completed_at
                failure["resolved_by"] = action
            retry = self.state.get("scheduled_retry")
            if retry and (
                (scheduled_kind and retry.get("kind") == scheduled_kind)
                or (not scheduled_kind and action in {"update", "rebuild"})
            ):
                self.state["scheduled_retry"] = None
            active = self.state.get("active") or {}
            self.state["last_success"] = {
                "at": completed_at,
                "action": action,
                "version": active.get("version", ""),
            }
            if scheduled_kind and scheduled_key:
                self.state[f"last_scheduled_{scheduled_kind}"] = scheduled_key
            self._save()

    def _run(
        self,
        action: str,
        actor: str,
        scheduled_kind: str | None = None,
        scheduled_key: str | None = None,
        scheduled_attempt: int | None = None,
    ) -> None:
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
            self._record_success(action, scheduled_kind, scheduled_key)
            self._audit(actor, action, "success")
            self._log(f"Completed {action} requested by {actor}")
        except Cancelled as cause:
            self._log(str(cause))
            self._audit(actor, action, "cancelled", str(cause))
            with self.state_lock:
                if scheduled_kind:
                    self.state["scheduled_retry"] = None
                self.state["last_failure"] = {
                    "at": utc_now(),
                    "message": str(cause),
                    "category": "cancelled",
                    "action": action,
                    "stage": self.state.get("job", {}).get("stage"),
                    "cancelled": True,
                }
        except Exception as cause:
            self._log(f"{action} failed: {cause}")
            self._audit(actor, action, "failed", str(cause))
            with self.state_lock:
                stage = self.state.get("job", {}).get("stage")
                retry = None
                if scheduled_kind and scheduled_key:
                    retry = self._schedule_retry(
                        action,
                        scheduled_kind,
                        scheduled_key,
                        scheduled_attempt or 1,
                        str(cause),
                    )
                self.state["last_failure"] = {
                    "at": utc_now(),
                    "message": str(cause),
                    "category": self._failure_category(cause, stage),
                    "action": action,
                    "stage": stage,
                    "cancelled": False,
                    "retry_at": retry.get("due_at") if retry else None,
                    "retry_exhausted": bool(scheduled_kind and not retry),
                }
                self._save()
                if retry:
                    self._log(
                        f"Scheduled {scheduled_kind} retry {retry['attempt']}/{retry['max_attempts']} "
                        f"for {retry['due_at']}"
                    )
        finally:
            self.process = None
            self._safe_remove_work(work_dir)
            self._job(**self._idle_job())
            self.job_lock.release()

    def _check_cancel(self) -> None:
        if self.cancel_event.is_set():
            raise Cancelled("The operation was cancelled; the active basemap was not changed.")

    def _check_resources(self, remote_size: int = 0) -> None:
        status = self._resource_status(remote_size)
        disk = self._disk()
        if "disk" in status["warnings"]:
            raise UpdateFailure(
                f"Insufficient disk space: {disk['free'] / 1024**3:.1f} GiB free; "
                f"{status['disk_required_free'] / 1024**3:.1f} GiB required for the safety floor and working data."
            )
        if "memory-limit" in status["warnings"]:
            raise UpdateFailure(
                f"Unsafe Java heap: {status['java_heap'] / 1024**3:.1f} GiB heap plus "
                f"{status['memory_reserve'] / 1024**3:.1f} GiB reserve exceeds the available memory limit."
            )
        if "memory-pressure" in status["warnings"]:
            raise UpdateFailure(
                f"Insufficient available memory: {status['memory_available'] / 1024**2:.0f} MiB available; "
                f"{status['minimum_available_memory'] / 1024**2:.0f} MiB required before starting."
            )

    @staticmethod
    def _retryable(cause: Exception) -> bool:
        if isinstance(cause, urllib.error.HTTPError):
            return cause.code in RETRYABLE_HTTP_STATUS
        if isinstance(cause, ChecksumMismatch):
            return True
        if isinstance(cause, OSError) and getattr(cause, "errno", None) in {13, 28, 30}:
            return False
        return isinstance(
            cause,
            (urllib.error.URLError, TimeoutError, socket.timeout, ConnectionError, http.client.IncompleteRead),
        )

    def _retry_wait(self, label: str, attempt: int, cause: Exception, stage: str) -> None:
        delay = min(300, self.settings.retry_base_seconds * 2 ** max(0, attempt - 1))
        self._log(
            f"{label} attempt {attempt}/{self.settings.download_retries} failed: {cause}; "
            f"retrying in {delay}s"
        )
        self._job(
            stage=stage,
            message=f"{label} interrupted · retrying in {delay}s",
            attempt=attempt + 1,
            max_attempts=self.settings.download_retries,
        )
        if self.cancel_event.wait(delay):
            raise Cancelled(f"{label} was cancelled during retry backoff.")

    def _request_bytes(
        self,
        request: urllib.request.Request,
        label: str,
        *,
        limit: int | None = None,
        optional: bool = False,
    ) -> tuple[bytes, dict[str, str], int]:
        last_error: Exception | None = None
        attempts_made = 0
        for attempt in range(1, self.settings.download_retries + 1):
            attempts_made = attempt
            self._check_cancel()
            try:
                with urllib.request.urlopen(request, timeout=self.settings.download_timeout_seconds) as response:
                    payload = response.read() if limit is None else response.read(limit)
                    return payload, dict(response.headers.items()), int(response.status)
            except Exception as cause:
                last_error = cause
                if not self._retryable(cause) or attempt >= self.settings.download_retries:
                    break
                self._retry_wait(label, attempt, cause, "retrying-network")
        if optional:
            self._log(f"{label} unavailable after {attempts_made} attempt(s): {last_error}")
            return b"", {}, 0
        raise UpdateFailure(
            f"{label} failed after {attempts_made} attempt(s): {last_error}"
        ) from last_error

    def _remote_info(self) -> dict[str, Any]:
        self._job(stage="checking", progress=5, message="Checking Geofabrik metadata")
        request = urllib.request.Request(self.settings.checksum_url, headers={"User-Agent": "DC-Geomap/0.1"})
        payload, _, _ = self._request_bytes(request, "Geofabrik checksum request", limit=4096)
        text = payload.decode("ascii", errors="strict").strip()
        checksum = text.split()[0].lower()
        if len(checksum) != 32 or any(char not in "0123456789abcdef" for char in checksum):
            raise UpdateFailure("Geofabrik returned an invalid MD5 checksum.")
        modified = ""
        content_length = 0
        head = urllib.request.Request(
            self.settings.osm_url, method="HEAD", headers={"User-Agent": "DC-Geomap/0.1"}
        )
        _, headers, _ = self._request_bytes(head, "Geofabrik source metadata request", limit=0, optional=True)
        modified = headers.get("Last-Modified", "")
        try:
            content_length = int(headers.get("Content-Length", "0") or 0)
        except ValueError:
            content_length = 0
        result = {
            "checksum_md5": checksum,
            "last_modified": modified,
            "content_length": content_length,
            "checked_at": utc_now(),
        }
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

    def _download(self, destination: Path, expected_md5: str, expected_size: int = 0) -> None:
        download_dir = self.private / "source" / "downloads"
        download_dir.mkdir(parents=True, exist_ok=True)
        complete = download_dir / f"philippines-{expected_md5}.osm.pbf"
        partial = complete.with_suffix(complete.suffix + ".partial")
        for stale in download_dir.glob("philippines-*.osm.pbf*"):
            if stale not in {complete, partial}:
                stale.unlink(missing_ok=True)

        if complete.is_file():
            self._job(stage="verifying-download", progress=30, message="Verifying cached Philippines extract")
            if md5_file(complete, self.cancel_event) == expected_md5:
                shutil.copy2(complete, destination)
                self._log(f"Reused verified download cache {complete.name}")
                return
            complete.unlink(missing_ok=True)

        last_error: Exception | None = None
        attempts_made = 0
        for attempt in range(1, self.settings.download_retries + 1):
            attempts_made = attempt
            self._check_cancel()
            offset = partial.stat().st_size if partial.is_file() else 0
            if expected_size and offset > expected_size:
                partial.unlink(missing_ok=True)
                offset = 0
            if expected_size and offset == expected_size:
                actual = md5_file(partial, self.cancel_event)
                if actual == expected_md5:
                    os.replace(partial, complete)
                    shutil.copy2(complete, destination)
                    return
                partial.unlink(missing_ok=True)
                offset = 0

            headers = {"User-Agent": "DC-Geomap/0.1"}
            if offset:
                headers["Range"] = f"bytes={offset}-"
            request = urllib.request.Request(self.settings.osm_url, headers=headers)
            started = time.monotonic()
            received_this_attempt = 0
            next_log_percent = -1
            try:
                with urllib.request.urlopen(request, timeout=self.settings.download_timeout_seconds) as response:
                    status = int(response.status)
                    resumed = bool(offset and status == HTTPStatus.PARTIAL_CONTENT)
                    if offset and not resumed:
                        self._log("Download server did not honor Range; restarting the partial file safely")
                        offset = 0
                    mode = "ab" if resumed else "wb"
                    content_length = int(response.headers.get("Content-Length", "0") or 0)
                    content_range = response.headers.get("Content-Range", "")
                    range_match = re.match(r"bytes\s+(\d+)-(\d+)/(\d+|\*)", content_range)
                    if resumed and (not range_match or int(range_match.group(1)) != offset):
                        raise UpdateFailure("Geofabrik returned an invalid Content-Range while resuming the PBF.")
                    total = (
                        int(range_match.group(3))
                        if range_match and range_match.group(3) != "*"
                        else expected_size or offset + content_length
                    )
                    self._job(
                        stage="downloading",
                        progress=10 if not total else min(30, 10 + int(offset / total * 20)),
                        message="Resuming Philippines extract" if resumed else "Downloading Philippines extract",
                        bytes_downloaded=offset,
                        bytes_total=total,
                        bytes_per_second=0,
                        eta_seconds=None,
                        attempt=attempt,
                        max_attempts=self.settings.download_retries,
                        resumed=resumed,
                    )
                    with partial.open(mode) as target:
                        while True:
                            try:
                                chunk = response.read(4 * 1024 * 1024)
                            except http.client.IncompleteRead as cause:
                                if cause.partial:
                                    target.write(cause.partial)
                                    received_this_attempt += len(cause.partial)
                                raise
                            if not chunk:
                                break
                            self._check_cancel()
                            target.write(chunk)
                            received_this_attempt += len(chunk)
                            received = offset + received_this_attempt
                            elapsed = max(0.001, time.monotonic() - started)
                            speed = int(received_this_attempt / elapsed)
                            eta = int((total - received) / speed) if total > received and speed else None
                            progress = min(30, 10 + int(received / total * 20)) if total else 10
                            self._job(
                                stage="downloading",
                                progress=progress,
                                message=f"Downloading source · {received / 1024**2:.0f} / {total / 1024**2:.0f} MiB"
                                if total
                                else f"Downloading source · {received / 1024**2:.0f} MiB",
                                bytes_downloaded=received,
                                bytes_total=total,
                                bytes_per_second=speed,
                                eta_seconds=eta,
                            )
                            percent = int(received / total * 100) if total else 0
                            if total and percent // 10 > next_log_percent // 10:
                                next_log_percent = percent
                                self._log(
                                    f"Download {percent}% · {received / 1024**2:.0f}/{total / 1024**2:.0f} MiB "
                                    f"· {speed / 1024**2:.1f} MiB/s"
                                )
                            self._check_resources(total)
                        target.flush()
                        os.fsync(target.fileno())

                self._job(stage="verifying-download", progress=32, message="Verifying downloaded PBF checksum")
                actual = md5_file(partial, self.cancel_event)
                if actual != expected_md5:
                    partial.unlink(missing_ok=True)
                    raise ChecksumMismatch("Downloaded PBF checksum did not match Geofabrik.")
                os.replace(partial, complete)
                shutil.copy2(complete, destination)
                self._log(f"Download verified: {complete.name}")
                return
            except Cancelled:
                raise
            except Exception as cause:
                last_error = cause
                if not self._retryable(cause) or attempt >= self.settings.download_retries:
                    break
                self._retry_wait("Philippines extract download", attempt, cause, "retrying-download")

        raise UpdateFailure(
            f"Philippines extract download failed after {attempts_made} attempt(s); "
            f"the partial file was retained for resume: {last_error}"
        ) from last_error

    def _run_command(self, command: list[str], cwd: Path, label: str) -> None:
        self._log(f"Starting {label}: {' '.join(command)}")
        process = subprocess.Popen(
            command,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        self.process = process

        def pump_output() -> None:
            assert process.stdout is not None
            while chunk := process.stdout.read(64 * 1024):
                self._emit_log(chunk)

        pump = threading.Thread(target=pump_output, daemon=True)
        pump.start()
        while process.poll() is None:
            if self.cancel_event.wait(1):
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                    process.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                pump.join(timeout=5)
                raise Cancelled(f"{label} was cancelled; the active basemap was not changed.")
        pump.join(timeout=5)
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
        self._check_resources(source.stat().st_size)
        self._job(
            stage="building",
            progress=45,
            message="Planetiler is building native zooms 0–15 · follow Build logs for detail",
            bytes_downloaded=0,
            bytes_total=0,
            bytes_per_second=0,
            eta_seconds=None,
        )
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
            headers={
                "Range": "bytes=0-126",
                "User-Agent": "DC-Geomap-Validator/0.1",
                "X-DCGeomap-Worker-Secret": self.settings.shared_secret,
            },
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = response.read()
            content_range = response.headers.get("Content-Range", "")
            if response.status != HTTPStatus.PARTIAL_CONTENT or len(payload) != 127 or not content_range.startswith("bytes 0-126/"):
                raise UpdateFailure("Caddy did not return a valid HTTP 206 Range response.")

    def _update(self, work_dir: Path, force_full: bool) -> None:
        self._check_resources()
        remote = self._remote_info()
        remote_size = int(remote.get("content_length") or 0)
        self._check_resources(remote_size)
        current_source = self.state.get("source") or {}
        if not force_full and current_source.get("remote_checksum_md5") == remote["checksum_md5"]:
            self._log("No new Geofabrik data; rebuild skipped")
            self._job(stage="complete", progress=100, message="No new OSM data; rebuild skipped")
            return

        candidate_source = work_dir / "philippines.osm.pbf"
        canonical_source = self.private / "source" / "philippines.osm.pbf"
        if force_full or not canonical_source.is_file():
            self._job(stage="downloading", progress=10, message="Downloading full Philippines extract")
            self._download(candidate_source, remote["checksum_md5"], remote_size)
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
            cached_download = (
                self.private
                / "source"
                / "downloads"
                / f"philippines-{remote['checksum_md5']}.osm.pbf"
            )
            cached_download.unlink(missing_ok=True)
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
            retry = self.state.get("scheduled_retry")
            retry_due = None
            if retry:
                try:
                    retry_due = datetime.fromisoformat(str(retry["due_at"]).replace("Z", "+00:00"))
                except (KeyError, TypeError, ValueError):
                    retry_due = datetime.now(UTC)
            if retry and retry_due and datetime.now(UTC) >= retry_due:
                try:
                    self.start(
                        str(retry["action"]),
                        f"scheduler-retry:{retry['kind']}",
                        scheduled_kind=str(retry["kind"]),
                        scheduled_key=str(retry["key"]),
                        scheduled_attempt=int(retry["attempt"]),
                    )
                except UpdateFailure:
                    pass
            elif (
                now.date() == monthly.date()
                and now.hour >= self.settings.monthly_hour
                and self.state.get("last_scheduled_monthly") != monthly_key
            ):
                try:
                    self.start(
                        "rebuild",
                        "scheduler:monthly",
                        scheduled_kind="monthly",
                        scheduled_key=monthly_key,
                        scheduled_attempt=1,
                    )
                    self.state["last_scheduled_monthly"] = monthly_key
                    self._save()
                except UpdateFailure:
                    pass
            elif now.hour >= self.settings.daily_hour and self.state.get("last_scheduled_daily") != daily_key:
                try:
                    self.start(
                        "update",
                        "scheduler:daily",
                        scheduled_kind="daily",
                        scheduled_key=daily_key,
                        scheduled_attempt=1,
                    )
                    self.state["last_scheduled_daily"] = daily_key
                    self._save()
                except UpdateFailure:
                    pass
            time.sleep(self.settings.check_interval)


class WorkerHandler(BaseHTTPRequestHandler):
    controller: BasemapController
    server_version = "DCGeomapWorker/0.1"

    def log_message(self, format: str, *args: Any) -> None:
        if self.command == "GET" and urlparse(self.path).path in {"/health", "/v1/status", "/v1/logs", "/v1/audit"}:
            return
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
