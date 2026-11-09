"""No SSH, Docker or VPS access: exercise the actual remote recipe with fakes."""
import base64
import shutil
import subprocess
import time
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
PINS = json.loads((source.parent.parent / "coolify/model-plugins.json").read_text(encoding="utf-8"))
PLUG = PINS["target"]
PLUGINS_MOUNT = {"source": "odc-model-plugins", "target": PLUG, "read_only": True, "type": "volume", "volume": {}}
CSS_MOUNT = {"source": "runtime-css", "target": "/data/runtime-css", "read_only": True, "type": "volume", "volume": {}}


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
        self.extra_mounts = []
        self.listing = [{"name": f["name"], "sha256": f["sha256"]} for f in PINS["files"]]
        self.missing_volume = False
        self.env = ["SSAM_BACKEND_NAME=o11-11.55.93-odc-1.7.29", "SSAM_SERVED_VERSIONS={\"odc\":[\"1.7.29\"],\"o11\":[\"11.55.93\"]}"]
        self.usage = {"pairs": {"o11-11.55.93-odc-1.7.29": {"heavy": 2, "active": 1}}, "skipped": 0}
        self.receipt = {"ok": True, "kernel": {"odc": "1.7.29", "o11": "11.55.93"}, "budget": {"tools": 90}, "telemetry": {"tokens": {}}}

    def docker(self, *args, data=None):
        self.calls.append(args)
        if data:
            self.inputs.append(data.decode())
        if args[0] == "ps":
            self.assertIn("label=com.docker.compose.project=fixture", args)
            return b"backend"
        if args[0] == "inspect":
            return json.dumps([{"Id": "backend", "Image": "sha256:old", "State": {"Running": True}, "Config": {"Image": "image:old", "Env": self.env, "Labels": {"ssam.o11": "11.55.93", "ssam.odc": "1.7.29"}}, "Mounts": [{"Type": "volume", "Name": "fixture_state"}] + self.extra_mounts}]).encode()
        if args[:2] == ("volume", "inspect"):
            if self.missing_volume:
                raise RuntimeError("Remote command failed: docker")
            return b"[{}]"
        if args[0] == "run" and any(str(x).endswith(":/plugins:ro") for x in args):
            self.assertIn("--network", args)
            self.assertNotIn("/backup", " ".join(map(str, args)))
            return json.dumps(self.listing).encode()
        if args[0] == "image":
            return json.dumps(["image@sha256:" + "a" * 64]).encode()
        if args[0] == "exec" and args[1] == "postgres-fixture":
            return getattr(self, "dump", b"CREATE TABLE public.schema_migrations (\n);\nCREATE TABLE public.server_tokens (\n);\n")
        if args[0] == "exec" and args[1] == "-i" and data and b"usage-count" in data:
            if callable(self.usage):
                return self.usage(data)
            if isinstance(self.usage, Exception):
                raise self.usage
            return self.usage if isinstance(self.usage, bytes) else json.dumps(self.usage).encode()
        if args[0] == "exec" and args[1] == "-i":
            return json.dumps(self.receipt).encode()
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

    def test_backup_refuses_a_database_without_the_license_tables(self):
        self.dump = b"CREATE TABLE public.releases (\n);\n"
        with self.assertRaisesRegex(RuntimeError, "no license table server_tokens"):
            self.request("backup", id="wrong-db")
        self.assertFalse(any((pathlib.Path(self.temp.name) / "backups").glob("wrong-db-*/complete")))

    def test_prepare_stays_stopped_writes_via_ssamctl_and_preserves_volumes(self):
        result = self.request("prepare", id="o11-11.55.94-odc-1.7.30", archive=self.archive(), features=base64.b64encode(b"<Features/>").decode(), kernel={},
                              built={"image": "private/image", "tag": "prod-fixed", "sha256": "a" * 64}, modelPlugins=PINS,
                              compose={"services": {"ssam-server-v1": {"labels": {}, "environment": {"SSAM_RUNTIME_DIR": "/data/server/versions/new"}, "volumes": [{"source": "state", "target": "/data/server"}, PLUGINS_MOUNT]}}, "volumes": {"state": {}, "odc-model-plugins": {}}})
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

    def prepare(self, volumes=None, pins=PINS, plugins=True):
        mounts = (volumes or []) + ([PLUGINS_MOUNT] if plugins else [])
        return self.request("prepare", id="o11-11.55.94-odc-1.7.30", archive=self.archive(), features=base64.b64encode(b"private").decode(), kernel={}, built={"image": "private/image", "tag": "prod-fixed", "sha256": "a"*64}, modelPlugins=pins, compose={"services": {"ssam-server-v1": {"labels": {}, "environment": {"SSAM_RUNTIME_DIR": "/data/server/versions/new"}, "volumes": mounts}}, "volumes": {"friction": {}, "odc-model-plugins": {}, "runtime-css": {}}})

    # Review round 2, A2: the template's read-only volumes (runtime-css, the ODC model plugins) at exactly their targets; the
    # plugins volume must exist and hold exactly the pinned files before anything is written; nothing else outside /data.
    def test_a2_prepare_accepts_the_reviewed_read_only_volumes_without_mounting_them_in_staging(self):
        self.assertTrue(self.prepare([{"type": "volume", "source": "friction", "target": "/data/friction"}, CSS_MOUNT])["ok"])
        create = next(c for c in self.calls if c[0] == "create")
        self.assertFalse(any(PLUG in str(x) or "runtime-css" in str(x) for x in create))
        self.assertTrue(any(c[:3] == ("volume", "inspect", "fixture_odc-model-plugins") for c in self.calls))

    def test_a2_prepare_refuses_a_missing_or_different_plugins_volume_before_any_write(self):
        cases = [("MODEL_PLUGINS_MISSING", dict(missing_volume=True)),
                 ("MODEL_PLUGINS_MISMATCH", dict(listing=[{"name": "MobileUI-1.4.0.0.xif", "sha256": PINS["files"][0]["sha256"]}])),
                 ("MODEL_PLUGINS_MISMATCH", dict(listing=[{"name": f["name"], "sha256": "0" * 64} for f in PINS["files"]])),
                 ("MODEL_PLUGINS_MISMATCH", dict(listing=[{"name": f["name"], "sha256": f["sha256"]} for f in PINS["files"]] + [{"name": "Evil.xif", "sha256": "1" * 64}]))]
        for code, state in cases:
            self.calls = []
            for key, value in state.items():
                setattr(self, key, value)
            with self.assertRaisesRegex(RuntimeError, code):
                self.prepare()
            self.assertFalse(any(c[0] == "create" for c in self.calls), code)
            self.assertFalse(any("kernel" in c and "write" in c for c in self.calls), code)
            self.missing_volume = False
            self.listing = [{"name": f["name"], "sha256": f["sha256"]} for f in PINS["files"]]
        with self.assertRaisesRegex(RuntimeError, "MODEL_PLUGINS_UNPINNED"):
            self.prepare(pins=None)

    def test_a2_prepare_refuses_no_plugins_mount_a_writable_one_another_source_or_a_bind_there(self):
        with self.assertRaisesRegex(RuntimeError, "MODEL_PLUGINS_MOUNT"):
            self.prepare(plugins=False)
        with self.assertRaisesRegex(RuntimeError, "MODEL_PLUGINS_MOUNT"):
            self.prepare([PLUGINS_MOUNT])
        for bad, message in [({**PLUGINS_MOUNT, "read_only": False}, "Unexpected read-only backend volume"),
                             ({**PLUGINS_MOUNT, "source": "server-state"}, "Unexpected read-only backend volume"),
                             ({**CSS_MOUNT, "target": PLUG}, "Unexpected read-only backend volume"),
                             ({"type": "bind", "source": "/srv/plugins", "target": PLUG, "read_only": True}, "Unexpected mount type"),
                             ({**PLUGINS_MOUNT, "target": "/tmp/plugins"}, "Unexpected backend volume target")]:
            with self.assertRaisesRegex(RuntimeError, message):
                self.prepare([bad], plugins=False)

    def test_a2_check_rolls_back_a_deployment_whose_backend_lacks_the_read_only_plugins_mount(self):
        mount = {"Type": "volume", "Name": "fixture_odc-model-plugins", "Destination": PLUG, "RW": False}
        self.extra_mounts = [mount]
        self.assertTrue(self.request("check", checkSource="new", modelPlugins=PINS)["ok"])
        for bad in ([], [{**mount, "RW": True}], [{**mount, "Type": "bind"}], [mount, mount]):
            self.extra_mounts = bad
            with self.assertRaisesRegex(RuntimeError, "MODEL_PLUGINS_MOUNT"):
                self.request("check", checkSource="new", modelPlugins=PINS)
        # A rollback restores what was live and asks no plugins.
        self.extra_mounts = []
        self.assertTrue(self.request("check", checkSource="new", checkSources={"11.55.93|1.7.29": "old"}, expectedBackends=[{"o11": "11.55.93", "odc": "1.7.29", "image": "sha256:old"}])["ok"])

    # Review round 2, B4: the published pack's hello must have been presented by exactly one backend; a failed receipt fails.
    def test_b4_check_requires_the_published_hello_presented_once(self):
        with self.assertRaisesRegex(RuntimeError, "PACK_HELLO_NOT_PRESENTED"):
            self.request("check", checkSource="new", requirePresented=True)
        self.receipt = {**self.receipt, "presented": True}
        self.assertTrue(self.request("check", checkSource="new", requirePresented=True)["ok"])
        self.receipt = {"ok": False}
        with self.assertRaisesRegex(RuntimeError, "CHECK_RECEIPT"):
            self.request("check", checkSource="new")

    # F1 review A1: the signed offers are keyed to the new pair; with several running backends exactly one (the new pair's)
    # must have offered and delivered all of them (offersChecked == requireOffers) and every retained one none.
    def test_f1_a1_check_requires_all_offers_from_exactly_one_backend(self):
        def backend(name, o11, odc):
            return {"Id": name, "Image": "sha256:" + name, "State": {"Running": True}, "Config": {"Image": "image:" + name, "Env": self.env, "Labels": {"ssam.o11": o11, "ssam.odc": odc}}, "Mounts": [{"Type": "volume", "Name": "fixture_state"}]}
        running = [backend("new", "11.55.95", "1.7.33"), backend("v5", "11.55.95", "1.7.32"), backend("v2", "11.55.93", "1.7.29")]
        receipts = {}
        base = self.docker
        def docker(*args, data=None):
            if args[0] == "exec" and args[1] == "-i":
                self.calls.append(args)
                return json.dumps({"ok": True, "presented": args[2] == "new", "offersChecked": receipts[args[2]]}).encode()
            return base(*args, data=data)
        def check(**kwargs):
            with patch.object(remote, "docker", docker), patch.object(remote, "command", self.command), patch.object(remote, "backends", lambda project: running):
                return remote.dispatch({"fence": 'synthetic-token', "settings": self.settings, "action": "check", "checkSource": "new", **kwargs})
        receipts.update({"new": 2, "v5": 0, "v2": 0})
        self.assertEqual(check(requirePresented=True, requireOffers=2), {"ok": True, "backends": 3})
        # A retained backend asked the new pair's offers (the F1 defect), the new one checked fewer, none checked, or a count
        # that is not an integer: the deployment fails (and is rolled back by the vigia).
        for bad in ({"new": 2, "v5": 2, "v2": 0}, {"new": 1, "v5": 0, "v2": 0}, {"new": 0, "v5": 0, "v2": 0}, {"new": True, "v5": 0, "v2": 0}, {"new": "2", "v5": 0, "v2": 0}, {"new": 1, "v5": 1, "v2": 0}):
            receipts.update(bad)
            with self.assertRaisesRegex(RuntimeError, "OFFERS_NOT_CHECKED"):
                check(requirePresented=True, requireOffers=2)
        # server-only (no requireOffers) and a receipt without the count (an older image) keep their rule.
        receipts.update({"new": 0, "v5": 0, "v2": 0})
        self.assertTrue(check(requirePresented=True)["ok"])

    # Review round 3, N1: a deployment fails when a running backend's served list is not the pin's (a retained backend's
    # list changed, or none, two or an unreadable one); the comparison is by value, not by text.
    def test_n1_check_fails_when_a_backend_served_list_differs_from_the_pin(self):
        served = {"11.55.93|1.7.29": json.dumps({"odc": ["1.7.29"], "o11": ["11.55.93"]}, indent=1)}
        self.assertTrue(self.request("check", checkSource="new", expectedServed=served)["ok"])
        for env in (["SSAM_SERVED_VERSIONS={\"odc\":[\"1.7.30\",\"1.7.29\"],\"o11\":[\"11.55.93\"]}"], [], ["SSAM_SERVED_VERSIONS=not json"],
                    ["SSAM_SERVED_VERSIONS={\"odc\":[\"1.7.29\"],\"o11\":[\"11.55.93\"]}"] * 2):
            self.env = env
            with self.assertRaisesRegex(RuntimeError, "SERVED_LIST_CHANGED"):
                self.request("check", checkSource="new", expectedServed=served)
        self.env = ["SSAM_SERVED_VERSIONS={\"odc\":[\"1.7.29\"],\"o11\":[\"11.55.93\"]}"]
        with self.assertRaisesRegex(RuntimeError, "SERVED_LIST_CHANGED"):
            self.request("check", checkSource="new", expectedServed={"11.55.94|1.7.30": served["11.55.93|1.7.29"]})
        # A rollback restores the live compose verbatim and sends no list.
        self.env = []
        self.assertTrue(self.request("check", checkSource="new", checkSources={"11.55.93|1.7.29": "old"}, expectedBackends=[{"o11": "11.55.93", "odc": "1.7.29", "image": "sha256:old"}])["ok"])

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

    def test_snapshot_returns_usage_counts_only_and_never_fails_on_them(self):
        # R2 M1': usage is advisory. Good counts come back; anything else is usage None (or the good part) plus a warning, and
        # the snapshot itself always succeeds, so an odd state file never stops a watcher round.
        source = "// usage-count fixture"
        value = self.request("snapshot", checkSource="capture-live", usageSource=source)
        self.assertEqual(value["usage"], {"o11-11.55.93-odc-1.7.29": {"heavy": 2, "active": 1}})
        self.assertEqual(value["warnings"], [])
        self.assertIn(source, self.inputs)
        P = "o11-11.55.93-odc-1.7.29"
        for bad, usage, warning in (
                ({"pairs": {"": 1}}, {}, "USAGE_PARTIAL"),
                ({"pairs": {"not-a-pair": {"heavy": 1, "active": 1}, P: {"heavy": 3, "active": 0}}}, {P: {"heavy": 3, "active": 0}}, "USAGE_PARTIAL"),
                ({"pairs": {P: {"heavy": -1, "active": 0}}}, {}, "USAGE_PARTIAL"),
                ({"pairs": {P: {"heavy": True, "active": 0}}}, {}, "USAGE_PARTIAL"),
                ({"pairs": {P: {"heavy": 1, "active": 0}}, "skipped": 4}, {P: {"heavy": 1, "active": 0}}, "USAGE_PARTIAL"),
                ({"pairs": [1]}, None, "USAGE_UNREADABLE"), ({"schema": 2}, None, "USAGE_UNREADABLE"), ([1], None, "USAGE_UNREADABLE"),
                (b"not json", None, "USAGE_UNREADABLE"), (RuntimeError("Remote command failed: docker"), None, "USAGE_UNREADABLE")):
            self.usage = bad
            value = self.request("snapshot", checkSource="capture-live", usageSource=source)
            self.assertTrue(value["ok"])
            if isinstance(bad, dict) and isinstance(bad.get("pairs"), dict):
                self.assertEqual((value["usage"], value["warnings"]), (usage, [warning]), bad)
            else:
                self.assertEqual((value["usage"], value["warnings"]), (None, ["USAGE_UNREADABLE"]), bad)
        # No usage source in the request (an older watcher): no usage, a warning, the snapshot as before.
        value = self.request("snapshot", checkSource="capture-live")
        self.assertEqual((value["usage"], value["warnings"]), (None, ["USAGE_UNREADABLE"]))

    def test_snapshot_runs_the_real_usage_counter_and_returns_counts_only(self):
        # The real vigia/usage-count.cjs, run by node over a sample server state (R2 B6): what the snapshot returns is what
        # the script counts, and no token id or customer label leaves it.
        node = shutil.which("node") or "C:/Program Files/nodejs/node.exe"
        if not os.path.exists(node) and not shutil.which("node"):
            self.skipTest("node is not available")
        root = pathlib.Path(self.temp.name) / "server"
        P = "o11-11.55.94-odc-1.7.31"
        (root / "versions" / P / "state").mkdir(parents=True)
        now = 1794200000000
        day = time.strftime("%Y%m%d", time.gmtime(now / 1000 - 86400))
        line = lambda tool: json.dumps({"kind": "call", "time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now / 1000 - 86400)), "tokenId": "tok_hidden", "customer": "Hidden Customer", "tool": tool})
        (root / "versions" / P / ("quality-" + day + ".jsonl")).write_text(chr(10).join([line("studio_deliver"), line("ssam_code"), line("ssam_map"), "{broken"]) + chr(10))
        (root / "versions" / P / "state" / "studio-versions.json").write_text(json.dumps({"schema": 1, "tokens": {"tok_hidden": {"customer": "Hidden Customer", "seen": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now / 1000 - 3600))}}}))
        script = (pathlib.Path(__file__).parent / "usage-count.cjs").read_text()
        printed = []
        def run(data):
            result = subprocess.run([node], input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60,
                                    env={**os.environ, "SSAM_USAGE_ROOT": str(root), "SSAM_USAGE_NOW": str(now)})
            self.assertEqual(result.returncode, 0, result.stderr)
            printed.append(result.stdout.decode())
            return result.stdout
        self.usage = run
        value = self.request("snapshot", checkSource="capture-live", usageSource=script)
        self.assertEqual(value["usage"], {P: {"heavy": 2, "active": 1}})
        self.assertEqual(value["warnings"], ["USAGE_PARTIAL"])
        self.assertNotIn("tok_hidden", printed[0])
        self.assertNotIn("Hidden", printed[0])

    def test_rollback_uses_old_ninety_tool_check_not_new_budget(self):
        self.request("check", checkSource="new-92", checkSources={"11.55.93|1.7.29": "old-90"})
        self.assertIn("old-90", self.inputs)
        self.assertNotIn("new-92", self.inputs)

    def test_r5_5_event_journal_line_carries_only_a_bounded_cause_code(self):
        self.request("event", event="abandoned", id="o11-11.55.95-odc-1.7.31", code="LIVE_CHANGED")
        self.request("event", event="abandoned", id="pair", code="not a code; rm -rf /")
        lines = [call[3] for call in self.calls if call[:3] == ("logger", "-t", "ssam-vigia")]
        self.assertEqual(lines, ["abandoned o11-11.55.95-odc-1.7.31 LIVE_CHANGED", "abandoned pair"])


if __name__ == "__main__":
    unittest.main()
