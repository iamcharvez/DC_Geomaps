import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from worker import BasemapController, Settings, first_sunday, next_schedules, xyz


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
    )


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
