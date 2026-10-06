import hashlib
import io
import tempfile
import unittest
import urllib.error
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfo

from worker import (
    BasemapController,
    Settings,
    UpdateFailure,
    first_sunday,
    java_heap_bytes,
    next_schedules,
    xyz,
)


def settings(root: Path) -> Settings:
    return Settings(
        root=root,
        shared_secret="x" * 32,
        osm_url="https://example.invalid/philippines.osm.pbf",
        checksum_url="https://example.invalid/philippines.osm.pbf.md5",
        caddy_url="http://web",
        timezone=ZoneInfo("Asia/Manila"),
        daily_hour=2,
        monthly_hour=1,
        check_interval=60,
        java_opts="-Xmx1g",
        threads=1,
        max_zoom=15,
        min_free_gb=1,
        download_retries=3,
        retry_base_seconds=0,
        download_timeout_seconds=30,
        scheduled_retry_minutes=5,
        scheduled_retry_max_attempts=3,
        disk_working_multiplier=2,
        memory_reserve_mb=256,
        min_available_memory_mb=128,
        log_max_mb=1,
        log_backups=2,
    )


class FakeResponse:
    def __init__(self, payload: bytes, status: int, headers: dict[str, str]):
        self.stream = io.BytesIO(payload)
        self.status = status
        self.headers = headers

    def read(self, size: int = -1) -> bytes:
        return self.stream.read(size)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return None


class WorkerTests(unittest.TestCase):
    def test_first_sunday_and_next_schedules(self):
        zone = ZoneInfo("Asia/Manila")
        now = datetime(2026, 9, 29, 12, 0, tzinfo=zone)
        daily, monthly = next_schedules(now, 2, 1)
        self.assertEqual(daily.isoformat(), "2026-09-30T02:00:00+08:00")
        self.assertEqual(monthly, first_sunday(2026, 10, zone, 1))
        self.assertEqual(monthly.isoformat(), "2026-10-04T01:00:00+08:00")

    def test_xyz_points_stay_in_valid_tile_range(self):
        for lon, lat in ((120.9842, 14.5995), (123.8854, 10.3157), (125.4553, 7.1907)):
            z, x, y = xyz(lon, lat, 15)
            self.assertEqual(z, 15)
            self.assertTrue(0 <= x < 2**z)
            self.assertTrue(0 <= y < 2**z)

    def test_java_heap_parser(self):
        self.assertEqual(java_heap_bytes("-XX:+UseG1GC -Xmx2g"), 2 * 1024**3)
        self.assertEqual(java_heap_bytes("-Xmx768m"), 768 * 1024**2)

    def test_download_resumes_existing_partial_with_range(self):
        payload = (b"philippines-osm" * 1024) + b"end"
        checksum = hashlib.md5(payload, usedforsecurity=False).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            controller = BasemapController(settings(root))
            download_dir = root / "private" / "source" / "downloads"
            download_dir.mkdir(parents=True, exist_ok=True)
            partial = download_dir / f"philippines-{checksum}.osm.pbf.partial"
            offset = len(payload) // 2
            partial.write_bytes(payload[:offset])
            response = FakeResponse(
                payload[offset:],
                206,
                {
                    "Content-Length": str(len(payload) - offset),
                    "Content-Range": f"bytes {offset}-{len(payload) - 1}/{len(payload)}",
                },
            )
            destination = root / "work" / "candidate.osm.pbf"
            with patch("worker.urllib.request.urlopen", return_value=response) as opened:
                controller._download(destination, checksum, len(payload))
            request = opened.call_args.args[0]
            self.assertEqual(request.get_header("Range"), f"bytes={offset}-")
            self.assertEqual(destination.read_bytes(), payload)

    def test_download_retries_transient_network_failure(self):
        payload = b"complete-pbf"
        checksum = hashlib.md5(payload, usedforsecurity=False).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            controller = BasemapController(settings(root))
            response = FakeResponse(payload, 200, {"Content-Length": str(len(payload))})
            destination = root / "work" / "candidate.osm.pbf"
            with patch(
                "worker.urllib.request.urlopen",
                side_effect=[urllib.error.URLError("temporary outage"), response],
            ) as opened:
                controller._download(destination, checksum, len(payload))
            self.assertEqual(opened.call_count, 2)
            self.assertEqual(destination.read_bytes(), payload)

    def test_scheduled_failure_creates_bounded_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            controller = BasemapController(settings(Path(directory)))
            retry = controller._schedule_retry("update", "daily", "2026-10-06", 1, "network timeout")
            self.assertIsNotNone(retry)
            self.assertEqual(retry["attempt"], 2)
            self.assertEqual(retry["max_attempts"], 3)
            self.assertIsNone(controller._schedule_retry("update", "daily", "2026-10-06", 3, "still down"))

    def test_scheduled_job_failure_records_retry_and_category(self):
        with tempfile.TemporaryDirectory() as directory:
            controller = BasemapController(settings(Path(directory)))
            controller.job_lock.acquire()
            controller.state["job"] = {
                **controller._idle_job(),
                "status": "running",
                "action": "update",
                "stage": "checking",
            }
            with patch.object(controller, "_update", side_effect=UpdateFailure("network connection timed out")):
                controller._run("update", "scheduler:daily", "daily", "2026-10-06", 1)
            self.assertEqual(controller.state["scheduled_retry"]["attempt"], 2)
            self.assertEqual(controller.state["last_failure"]["category"], "network")
            self.assertEqual(controller.state["job"]["status"], "idle")

    def test_success_marks_previous_failure_resolved(self):
        with tempfile.TemporaryDirectory() as directory:
            controller = BasemapController(settings(Path(directory)))
            controller.state["last_failure"] = {"at": "2026-10-06T01:00:00Z", "message": "timeout"}
            controller._record_success("update", None, None)
            self.assertEqual(controller.state["last_failure"]["resolved_by"], "update")
            self.assertIn("resolved_at", controller.state["last_failure"])

    def test_resource_check_rejects_unsafe_heap(self):
        with tempfile.TemporaryDirectory() as directory:
            unsafe = replace(settings(Path(directory)), java_opts="-Xmx2g", memory_reserve_mb=512)
            controller = BasemapController(unsafe)
            with patch.object(
                controller,
                "_memory",
                return_value={"total": 2 * 1024**3, "available": 1024**3},
            ):
                with self.assertRaisesRegex(UpdateFailure, "Unsafe Java heap"):
                    controller._check_resources()

    def test_resource_check_uses_remote_size_working_multiplier(self):
        with tempfile.TemporaryDirectory() as directory:
            controller = BasemapController(settings(Path(directory)))
            with (
                patch.object(
                    controller,
                    "_disk",
                    return_value={"total": 10 * 1024**3, "used": 5 * 1024**3, "free": 5 * 1024**3},
                ),
                patch.object(
                    controller,
                    "_memory",
                    return_value={"total": 4 * 1024**3, "available": 3 * 1024**3},
                ),
            ):
                with self.assertRaisesRegex(UpdateFailure, "Insufficient disk space"):
                    controller._check_resources(3 * 1024**3)

    def test_worker_file_log_rotates(self):
        with tempfile.TemporaryDirectory() as directory:
            controller = BasemapController(settings(Path(directory)))
            controller.log_path.write_bytes(b"x" * 1024**2)
            with controller.log_lock:
                controller._rotate_log_locked(1)
            self.assertTrue((controller.logs_dir / "worker.log.1").is_file())
            self.assertFalse(controller.log_path.exists())

    def test_rollback_is_atomic_at_manifest_level(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            controller = BasemapController(settings(root))
            active = {"version": "new", "url": "/basemap/philippines-new.pmtiles"}
            previous = {"version": "old", "url": "/basemap/philippines-old.pmtiles"}
            controller.state["active"] = active
            controller.state["previous"] = previous
            (controller.public / "philippines-old.pmtiles").write_bytes(b"pmtiles")
            result = controller.rollback("tester")
            self.assertEqual(result["active"]["version"], "old")
            self.assertEqual(controller.state["previous"]["version"], "new")
            manifest = (controller.public / "active.json").read_text(encoding="utf-8")
            self.assertIn('"version": "old"', manifest)


if __name__ == "__main__":
    unittest.main()
