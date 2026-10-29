"""No SSH, Docker or VPS access: exercise the actual remote recipe with fakes."""
import base64
import importlib.util
import io
import json
import pathlib
import tarfile
import tempfile
import unittest
import os
from types import SimpleNamespace
from unittest.mock import patch

source = pathlib.Path(os.environ["VIGIA_REVIEW_ROOT"]) / "deploy/vigia/remote-release.py" if "VIGIA_REVIEW_ROOT" in os.environ else pathlib.Path(__file__).with_name("remote-release.py")
spec = importlib.util.spec_from_file_location("remote", source)
remote = importlib.util.module_from_spec(spec)
spec.loader.exec_module(remote)
real_assert_fence = remote.assert_fence


class RemoteTests(unittest.TestCase):
    def test_fence_requires_the_recorded_pid_to_hold_the_kernel_lock(self):
        def read(p):
            return json.dumps({'token': 'current', 'pid': 51}) if p.name.endswith('.owner') else '1: FLOCK ADVISORY WRITE 51 00:12:123 0 EOF'
        with patch.object(remote.pathlib.Path, 'read_text', autospec=True, side_effect=read), patch.object(remote.os, 'kill'), patch.object(remote.os, 'stat', return_value=SimpleNamespace(st_ino=123)):
            real_assert_fence('current')
        def changed(p):
            return json.dumps({'token': 'current', 'pid': 51}) if p.name.endswith('.owner') else '1: FLOCK ADVISORY WRITE 52 00:12:123 0 EOF'
        with patch.object(remote.pathlib.Path, 'read_text', autospec=True, side_effect=changed), patch.object(remote.os, 'kill'), patch.object(remote.os, 'stat', return_value=SimpleNamespace(st_ino=123)):
            with self.assertRaisesRegex(RuntimeError, 'LOCK_LOST'):
                real_assert_fence('current')

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.settings = {"directory": self.temp.name, "composeProject": "fixture", "postgresContainer": "postgres-fixture", "healthUrl": "https://example.test/health", "warmTimeoutSeconds": 0}
        if hasattr(remote, 'assert_fence'):
            patcher=patch.object(remote, 'assert_fence', return_value=None); patcher.start(); self.addCleanup(patcher.stop)
        self.calls = []
        self.inputs = []

    def docker(self, *args, data=None):
        self.calls.append(args)
        if data:
            self.inputs.append(data.decode())
        if args[0] == "ps":
            self.assertIn("label=com.docker.compose.project=fixture", args)
            return b"backend"
        if args[0] == "inspect":
            return json.dumps([{"Id": "backend", "Image": "sha256:old", "State": {"Running": True}, "Config": {"Image": "image:old", "Labels": {"ssam.o11": "11.55.93", "ssam.odc": "1.7.29"}}, "Mounts": [{"Type": "volume", "Name": "fixture_state"}]}]).encode()
        if args[0] == "image":
            return json.dumps(["image@sha256:" + "a" * 64]).encode()
        if args[0] == "exec" and args[1] == "postgres-fixture":
            return b"SQL backup"
        if args[0] == "exec" and args[1] == "-i":
            return json.dumps({"ok": True, "kernel": {"odc": "1.7.29", "o11": "11.55.93"}, "budget": {"tools": 90}, "telemetry": {"tokens": {}}}).encode()
        if args[0] == "run":
            mount = next(x for x in args if x.endswith(":/backup"))[:-8]
            name = next(x for x in args if x.startswith("/backup/"))[8:]
            pathlib.Path(mount, name).write_bytes(b"volume archive")
        if args[0] == "logs":
            return json.dumps({"event": "warm", "indexes": {"ok": True}, "delivery": {"builder": {"ok": True}, "worker": {"ok": True}}}).encode()
        return b""

    def command(self, args, data=None, env=None):
        self.calls.append(tuple(args))
        return b""

    def request(self, action, **kwargs):
        with patch.object(remote, "docker", self.docker), patch.object(remote, "command", self.command):
            return remote.dispatch({"fence": 'synthetic-token', "settings": self.settings, "action": action, **kwargs})

    def archive(self):
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode="w:gz") as tar:
            for name in ["server", "server/deploy", "server/deploy/coolify"]:
                item = tarfile.TarInfo(name)
                item.type = tarfile.DIRTYPE
                tar.addfile(item)
            for name in ["server/deploy/coolify/ssamctl.sh", "server/deploy/kernel-pair-check.mjs"]:
                item = tarfile.TarInfo(name)
                item.size = 1
                tar.addfile(item, io.BytesIO(b"x"))
        return base64.b64encode(data.getvalue()).decode()

    def test_backup_contains_database_and_each_current_volume(self):
        result = self.request("backup", id="pair")
        self.assertTrue(result["ok"])
        directory = pathlib.Path(result["directory"])
        self.assertTrue((directory / "postgres.sql.gz").exists())
        self.assertEqual(json.loads((directory / "volumes.json").read_text()), ["fixture_state"])

    def test_prepare_stays_stopped_writes_via_ssamctl_and_preserves_volumes(self):
        result = self.request("prepare", id="o11-11.55.94-odc-1.7.30", archive=self.archive(), features=base64.b64encode(b"<Features/>").decode(), kernel={},
                              built={"image": "private/image", "tag": "prod-fixed", "sha256": "a" * 64},
                              compose={"services": {"ssam-server-v1": {"labels": {}, "environment": {"SSAM_RUNTIME_DIR": "/data/server/versions/new"}, "volumes": [{"source": "state", "target": "/data/server"}]}}, "volumes": {"state": {}}})
        self.assertTrue(result["ok"])
        self.assertTrue(any(c[0] == "create" for c in self.calls))
        self.assertFalse(any(c[0] in ["start", "stop"] or "compose" in c for c in self.calls))
        self.assertTrue(any("kernel" in c and "write" in c for c in self.calls))
        self.assertTrue(any("features" in c and "put" in c for c in self.calls))
        self.assertTrue(any(c[0] == "rm" and "-v" not in c for c in self.calls))
        self.assertFalse(list(pathlib.Path(self.temp.name).rglob("Features.plain.xml")))

    def test_rollback_checks_actual_previous_image_identity(self):
        expected = [{"o11": "11.55.93", "odc": "1.7.29", "image": "sha256:old"}]
        self.assertTrue(self.request("check", expectedBackends=expected, checkSource="synthetic")['ok'])
        expected[0]["image"] = "wrong"
        with self.assertRaisesRegex(RuntimeError, "NOT_WARM"):
            self.request("check", expectedBackends=expected, checkSource="synthetic")

    def test_low_memory_rejected_without_any_write(self):
        with patch.object(pathlib.Path, "read_text", return_value="MemAvailable: 3144704 kB\n"):
            with self.assertRaisesRegex(RuntimeError, "MEMORY_LOW"):
                self.request("preflight", backendCount=3)
        self.assertEqual(self.calls, [])

    def test_low_disk_rejected_before_backup_directory(self):
        with patch.object(remote.shutil, "disk_usage", return_value=SimpleNamespace(free=1)):
            with self.assertRaisesRegex(RuntimeError, "DISK_LOW"):
                self.request("backup", id="low-disk")
        self.assertFalse((pathlib.Path(self.temp.name) / "backups").exists())

    def test_only_five_complete_backups_are_retained(self):
        home = pathlib.Path(self.temp.name) / "backups"
        home.mkdir()
        for index in range(6):
            item = home / str(index)
            item.mkdir()
            (item / "complete").write_text("ok")
            os.utime(item, (index, index))
        self.request("backup", id="new")
        self.assertEqual(len(list(home.iterdir())), 5)
        self.assertFalse((home / "0").exists())

    def prepare(self, volumes=None):
        return self.request("prepare", id="o11-11.55.94-odc-1.7.30", archive=self.archive(), features=base64.b64encode(b"private").decode(), kernel={}, built={"image": "private/image", "tag": "prod-fixed", "sha256": "a"*64}, compose={"services": {"ssam-server-v1": {"labels": {}, "environment": {"SSAM_RUNTIME_DIR": "/data/server/versions/new"}, "volumes": volumes or []}}, "volumes": {"friction": {}}})

    def test_generated_friction_volume_is_allowed_and_extra_mount_is_refused(self):
        self.assertTrue(self.prepare([{"type": "volume", "source": "friction", "target": "/data/friction"}])["ok"])
        with self.assertRaisesRegex(RuntimeError, "Unexpected backend volume"):
            self.prepare([{"type": "bind", "source": "/secret", "target": "/secret"}])

    def test_pull_failure_removes_features(self):
        original = self.docker
        def failed(*args, **kwargs):
            if args[0] == "pull":
                raise RuntimeError("pull failed")
            return original(*args, **kwargs)
        with patch.object(self, "docker", failed):
            with self.assertRaisesRegex(RuntimeError, "pull failed"):
                self.prepare()
        self.assertFalse(list(pathlib.Path(self.temp.name).rglob("Features.plain.xml")))

    def test_stale_staging_container_is_removed_by_exact_name_before_creation(self):
        self.prepare()
        expected = "ssam-vigia-prepare-o11-11.55.94-odc-1.7.30"
        removed = next(i for i,c in enumerate(self.calls) if c == ("rm", "-f", expected))
        created = next(i for i,c in enumerate(self.calls) if c[0] == "create")
        self.assertLess(removed, created)

    def test_snapshot_reads_live_kernel_digest_and_old_listing_budget(self):
        value = self.request("snapshot", checkSource="capture-live")
        self.assertEqual(value["backends"][0]["budget"]["tools"], 90)
        self.assertEqual(value["backends"][0]["kernel"]["odc"], "1.7.29")
        self.assertEqual(value["backends"][0]["reference"], "image:old")

    def test_rollback_uses_old_ninety_tool_check_not_new_budget(self):
        self.request("check", checkSource="new-92", checkSources={"11.55.93|1.7.29": "old-90"})
        self.assertIn("old-90", self.inputs)
        self.assertNotIn("new-92", self.inputs)


if __name__ == "__main__":
    unittest.main()
