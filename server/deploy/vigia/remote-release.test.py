"""No SSH, Docker or VPS access: exercise the actual remote recipe with fakes."""
import base64
import importlib.util
import io
import json
import pathlib
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("remote", pathlib.Path(__file__).with_name("remote-release.py"))
remote = importlib.util.module_from_spec(spec)
spec.loader.exec_module(remote)


class RemoteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.settings = {"directory": self.temp.name, "composeProject": "fixture", "postgresContainer": "postgres-fixture", "healthUrl": "https://example.test/health", "warmTimeoutSeconds": 0}
        self.calls = []

    def docker(self, *args, data=None):
        self.calls.append(args)
        if args[0] == "ps":
            self.assertIn("label=com.docker.compose.project=fixture", args)
            return b"backend"
        if args[0] == "inspect":
            return json.dumps([{"Id": "backend", "Image": "sha256:old", "State": {"Running": True}, "Config": {"Image": "image:old", "Labels": {"ssam.o11": "11.55.93", "ssam.odc": "1.7.29"}}, "Mounts": [{"Type": "volume", "Name": "fixture_state"}]}]).encode()
        if args[0] == "image":
            return json.dumps(["image@sha256:" + "a" * 64]).encode()
        if args[0] == "exec" and args[1] == "postgres-fixture":
            return b"SQL backup"
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
            return remote.dispatch({"settings": self.settings, "action": action, **kwargs})

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
        with self.assertRaisesRegex(RuntimeError, "timed out"):
            self.request("check", expectedBackends=expected, checkSource="synthetic")


if __name__ == "__main__":
    unittest.main()
