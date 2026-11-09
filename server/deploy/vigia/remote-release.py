"""Executed over SSH only after owner activation; JSON on stdin, receipts on stdout.
No SSH, Docker or Coolify operations run when this module is imported for tests.
"""
import base64
import gzip
import io
import json
import os
import pathlib
import re
import subprocess
import sys
import tarfile
import time
import shutil
try:
    import fcntl
except ImportError:
    fcntl = None

class RemoteError(RuntimeError):
    def __init__(self, code):
        super().__init__(code)
        self.code = code

active_fence = None
def assert_fence(token):
    try:
        owner = json.loads(pathlib.Path('/var/lock/ssam-release.owner').read_text())
        pid = owner['pid']
        if not isinstance(pid, int) or pid <= 0:
            raise ValueError()
        os.kill(pid, 0)
        inode = str(os.stat('/var/lock/ssam-release.lock').st_ino)
        locks = pathlib.Path('/proc/locks').read_text().splitlines()
    except (OSError, ValueError, KeyError, TypeError):
        raise RemoteError('LOCK_LOST')
    if not token or owner.get('token') != token:
        raise RemoteError('LOCK_LOST')
    if not any(len(parts) > 5 and parts[1] == 'FLOCK' and parts[3] == 'WRITE' and parts[4] == str(pid) and parts[5].endswith(':' + inode) for parts in (line.split() for line in locks)):
        raise RemoteError('LOCK_LOST')
    if json.loads(pathlib.Path('/var/lock/ssam-release.owner').read_text()) != owner:
        raise RemoteError('LOCK_LOST')


def command(args, data=None, env=None, timeout=900):
    if active_fence:
        assert_fence(active_fence)
    result = subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            env=env, timeout=timeout)
    if result.returncode:
        raise RuntimeError("Remote command failed: " + args[0])
    return result.stdout


def docker(*args, data=None, timeout=900):
    return command(["docker", *args], data=data, timeout=timeout)


# The usage count is advisory: a node stuck in the container must not hold a watcher round for the 900 s of command()
# (review R3 B2). The container's own timeout stops node at 25 s; the client gives up at 30 s; either is USAGE_UNREADABLE.
USAGE_TIMEOUT_S = 30


def backends(project):
    ids = docker("ps", "-aq", "--filter", "label=ssam.backend=true", "--filter", "label=com.docker.compose.project=" + project).decode().split()
    return json.loads(docker("inspect", *ids)) if ids else []


# Shared read-only volumes a backend may mount besides its /data state, each only at its own target. They are never
# mounted in the staging container (docker would create an empty volume): the plugins volume must already exist and hold
# exactly the pinned files (coolify/model-plugins.json) before anything is written.
MODEL_PLUGINS_TARGET = '/tmp/.local/share/OutSystems/ODC Studio/Plugins'
READ_ONLY_VOLUMES = {'/data/runtime-css': 'runtime-css', MODEL_PLUGINS_TARGET: 'odc-model-plugins'}
# The flags of ssamctl.sh's hardened one-off containers (coolify/ssamctl.sh "hardened").
HARDENED = ("--rm", "--init", "--security-opt", "no-new-privileges:true", "--cap-drop", "ALL", "--user", "10001:10001")
PLUGIN_LIST = ("const fs=require('fs'),c=require('crypto');console.log(JSON.stringify(fs.readdirSync('/plugins').sort()"
               ".map(n=>({name:n,sha256:c.createHash('sha256').update(fs.readFileSync('/plugins/'+n)).digest('hex')}))))")
# The capacity hot tier goes by real use (gen-compose sizing.usage): the request's usageSource (vigia/usage-count.cjs) runs
# inside a live backend over the shared server state and prints counts only ({"pairs": {pair: {heavy, active}},
# "skipped": n}), never a token id. Usage is advisory: whatever fails here (no source, docker, a timeout, bad output) is
# usage None plus a warning code, never an error of the snapshot, so it can never stop a watcher round (review R2 M1').
# Window 4x4 (S2): a backend of a backend window counts as odc-<v> (usage-count.cjs keys it so).
PAIR_NAME = re.compile(r"(?:o11-\d+\.\d+\.\d+-)?odc-\d+\.\d+\.\d+")


def usage_counts(container, source):
    if not container or not isinstance(source, str) or not source:
        return None, 'USAGE_UNREADABLE'
    try:
        value = json.loads(docker("exec", "-i", container, "timeout", str(USAGE_TIMEOUT_S - 5), "node", data=source.encode(), timeout=USAGE_TIMEOUT_S))
        pairs = value["pairs"]
        if not isinstance(pairs, dict):
            raise ValueError()
    except Exception:
        return None, 'USAGE_UNREADABLE'
    usage, dropped = {}, False
    for name, counts in pairs.items():
        good = PAIR_NAME.fullmatch(str(name)) and isinstance(counts, dict) and all(
            isinstance(counts.get(k), int) and not isinstance(counts.get(k), bool) and counts.get(k) >= 0 for k in ('heavy', 'active'))
        if good:
            usage[name] = {'heavy': counts['heavy'], 'active': counts['active']}
        else:
            dropped = True
    skipped = value.get('skipped') if isinstance(value, dict) else None
    return usage, ('USAGE_PARTIAL' if dropped or (isinstance(skipped, int) and skipped > 0) else None)


def pinned_files(pins):
    files = (pins or {}).get('files')
    if not isinstance(files, list) or not files:
        raise RemoteError('MODEL_PLUGINS_UNPINNED')
    return sorted(({'name': f['name'], 'sha256': f['sha256']} for f in files), key=lambda f: f['name'])


def verify_plugins_volume(volume, image, pins):
    try:
        docker("volume", "inspect", volume)
    except RuntimeError:
        raise RemoteError('MODEL_PLUGINS_MISSING')
    listing = json.loads(docker("run", "--rm", "--network", "none", "--entrypoint", "node", "-v", volume + ":/plugins:ro", image, "-e", PLUGIN_LIST))
    if sorted(listing, key=lambda f: f['name']) != pinned_files(pins):
        raise RemoteError('MODEL_PLUGINS_MISMATCH')


def backup_space(base, settings):
    disk = base
    while not disk.exists():
        disk = disk.parent
    if shutil.disk_usage(disk).free < settings.get("backupMinFreeMiB", 2048) * 1024 ** 2:
        raise RemoteError('DISK_LOW')


def dispatch(request):
    global active_fence
    active_fence = None
    if request['action'] in ('fence', 'backup', 'prepare', 'check', 'preflight'):
        assert_fence(request.get('fence'))
        active_fence = request['fence']
    if request['action'] == 'fence':
        return {'ok': True}
    settings = request["settings"]
    base = pathlib.Path(settings["directory"])
    if not base.is_absolute() or ".." in base.parts:
        raise ValueError("Remote directory must be absolute.")
    action = request["action"]
    if action in ('preflight','capacity'):
        meminfo = pathlib.Path("/proc/meminfo").read_text()
        available = int(re.search(r"^MemAvailable:\s+(\d+)", meminfo, re.M).group(1)) // 1024
        if available < max(1024, request["backendCount"] * 1024):
            raise RemoteError('MEMORY_LOW')
        backup_space(base, settings)
        return {"ok": True, "availableMiB": available}
    if action == "snapshot":
        rows = []
        telemetry = {"tokens": {}}
        live = []
        for server in backends(settings["composeProject"]):
            if not server["State"]["Running"]:
                continue
            live.append(server["Id"])
            measured = json.loads(docker("exec", "-i", server["Id"], "node", "--input-type=module", data=request["checkSource"].encode()))
            events = []
            for line in docker("logs", server["Id"]).decode().splitlines():
                try:
                    events.append(json.loads(line))
                except ValueError:
                    pass
            warm = next((x for x in reversed(events) if x.get("event") == "warm"), {})
            if not (warm.get("indexes", {}).get("ok") and warm.get("delivery", {}).get("builder", {}).get("ok") and warm.get("delivery", {}).get("worker", {}).get("ok")):
                raise RuntimeError("Live baseline is not warm.")
            refs = json.loads(docker("image", "inspect", "--format", "{{json .RepoDigests}}", server["Image"]))
            if not refs:
                raise RuntimeError("No registry digest for a live backend.")
            rows.append({"o11": server["Config"]["Labels"].get("ssam.o11"), "odc": server["Config"]["Labels"].get("ssam.odc"), "image": server["Image"], "reference": server["Config"]["Image"], "digest": refs[0].split("@")[1], "kernel": measured["kernel"], "budget": measured["budget"], "warm": warm})
            for key, value in measured.get("telemetry", {}).get("tokens", {}).items():
                if key not in telemetry["tokens"] or telemetry["tokens"][key]["seen"] < value["seen"]:
                    telemetry["tokens"][key] = value
        usage, warning = usage_counts(live[0] if live else None, request.get("usageSource"))
        return {"ok": True, "backends": rows, "telemetry": telemetry, "usage": usage, "warnings": [warning] if warning else []}
    if action == "event":
        # The system journal is available even without a console ingestion API.
        code = request.get("code")
        words = [request["event"], request["id"]] + ([code] if isinstance(code, str) and re.fullmatch(r"[A-Z_]{1,40}", code) else [])
        command(["logger", "-t", "ssam-vigia", " ".join(words)])
        return {"ok": True}
    if action == "backup":
        backup_space(base, settings)
        os.umask(0o077)
        directory = base / "backups" / (request["id"] + "-" + time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()))
        directory.mkdir(parents=True, exist_ok=False)
        servers = backends(settings["composeProject"])
        if not servers:
            raise RuntimeError("No live backend exists for backup.")
        pg = settings["postgresContainer"]
        dump = docker("exec", pg, "sh", "-c", 'exec pg_dump -U "${POSTGRES_USER:-postgres}" "${POSTGRES_DB:-postgres}"')
        if not dump:
            raise RuntimeError("Empty PostgreSQL backup.")
        # postgresContainer must be the licenses database (2026-11-01: the update_server's PostgreSQL was dumped instead).
        for table in ("server_tokens", "schema_migrations"):
            if not re.search(rb"^CREATE TABLE (public\.)?" + table.encode() + rb" \(", dump, re.M):
                raise RuntimeError("PostgreSQL backup has no license table " + table + ": postgresContainer is not the licenses database.")
        with gzip.open(directory / "postgres.sql.gz", "wb") as stream:
            stream.write(dump)
        volumes = sorted({m["Name"] for server in servers for m in server["Mounts"] if m["Type"] == "volume"})
        if not volumes:
            raise RuntimeError("No state volumes found.")
        # One archive per named volume, including pairs leaving the window.
        for index, volume in enumerate(volumes):
            docker("run", "--rm", "--network", "none", "--user", "0", "--entrypoint", "tar",
                   "-v", volume + ":/source:ro", "-v", str(directory) + ":/backup",
                   servers[0]["Config"]["Image"], "czf", "/backup/volume-" + str(index) + ".tar.gz", "-C", "/source", ".")
            if (directory / ("volume-" + str(index) + ".tar.gz")).stat().st_size == 0:
                raise RuntimeError("Empty volume backup.")
        (directory / "volumes.json").write_text(json.dumps(volumes))
        (directory / "complete").write_text("ok")
        complete = sorted((p for p in directory.parent.iterdir() if p.is_dir() and (p / "complete").is_file()), key=lambda p: p.stat().st_mtime, reverse=True)
        for old in complete[5:]:
            if old.resolve().parent != directory.parent.resolve():
                raise RuntimeError("Invalid backup retention path.")
            shutil.rmtree(old)
        return {"ok": True, "directory": str(directory), "volumes": len(volumes)}
    if action == "prepare":
        os.umask(0o077)
        # Window 4x4 (S2): a backend window prepares one backend at a time (id odc-<v>, its own compose service under the v1
        # name). kernelOnly belongs to an O11 round only (round o11-<v>, no features): it stages the kernel.json of a backend
        # that runs and touches nothing else of it, no reader copy, cache or stamp (review M4; the new image's start resets
        # what its kernel changed, kernel-image.mjs resetStaleCaches). Any other prepare needs the features.
        if not re.fullmatch(r"(?:o11-\d+\.\d+\.\d+-)?odc-\d+\.\d+\.\d+", request["id"]):
            raise ValueError("Invalid pair.")
        kernel_only = request.get("kernelOnly") is True
        if kernel_only and (request.get("features") or not re.fullmatch(r"o11-\d+\.\d+\.\d+", str(request.get("round", ""))) or not re.fullmatch(r"odc-\d+\.\d+\.\d+", request["id"])):
            raise ValueError("A kernel-only prepare is one backend of an O11 round.")
        if not kernel_only and not request.get("features"):
            raise ValueError("The new backend needs its features.")
        directory = base / "releases" / request["id"]
        directory.mkdir(parents=True, exist_ok=True)
        with tarfile.open(fileobj=io.BytesIO(base64.b64decode(request["archive"])), mode="r:gz") as archive:
            for member in archive.getmembers():
                name = member.name.rstrip("/")
                ancestor = member.isdir() and name in ("server", "server/deploy")
                if not (ancestor or name.startswith("server/deploy/")) or ".." in pathlib.PurePosixPath(name).parts or member.issym() or member.islnk():
                    raise ValueError("Unsafe deploy archive.")
            archive.extractall(directory, filter="data")
        # A new pair or backend is never one that already runs: a pair by its two labels, a backend of a backend window by its
        # ODC label or its SSAM_BACKEND_NAME (its ssam.o11 label is the served list, never one version).
        target = (request["compose"]["services"]["ssam-server-v1"].get("environment") or {}).get("SSAM_BACKEND_NAME")
        for live in backends(settings["composeProject"]):
            labels = live["Config"]["Labels"]
            if kernel_only or not live["State"]["Running"]:
                continue
            names = [e.split("=", 1)[1] for e in live["Config"].get("Env") or [] if e.startswith("SSAM_BACKEND_NAME=")]
            if target:
                if labels.get("ssam.odc") == request["kernel"].get("odc") or target in names:
                    raise RuntimeError("Refusing to prepare an already running backend.")
            elif labels.get("ssam.odc") == request["kernel"].get("odc") and labels.get("ssam.o11") == request["kernel"].get("o11"):
                raise RuntimeError("Refusing to prepare an already running pair.")
        kernel = directory / "kernel.json"
        features = directory / "Features.plain.xml"
        kernel.write_text(json.dumps(request["kernel"]))
        if not kernel_only:
            features.write_bytes(base64.b64decode(request["features"]))
        try:
            compose = request["compose"]
            service = compose["services"]["ssam-server-v1"]
            image = request["built"]["image"] + ":" + request["built"]["tag"]
            docker("pull", image)
            digests = json.loads(docker("image", "inspect", "--format", "{{json .RepoDigests}}", image))
            if not any(d.endswith("@sha256:" + request["built"]["sha256"]) for d in digests):
                raise RuntimeError("Pulled image digest differs from the tested digest.")
            if kernel_only:
                # The kernel.json of this backend's runtime folder only (the server-state volume, nothing else mounted): the pair
                # check runs inside the new image, then a hardened container of the new image writes the file atomically. The
                # running backend keeps its caches, reader copies and stamp; the new image's start resets what the kernel
                # changed (review M4). No ssamctl kernel write: it empties the version caches of the running backend.
                runtime = service.get("environment", {}).get("SSAM_RUNTIME_DIR", "")
                if runtime != "/data/server/versions/" + request["id"]:
                    raise ValueError("Invalid runtime directory.")
                state = [m for m in service["volumes"] if m.get("target") == "/data/server"]
                if len(state) != 1 or state[0].get("type", "volume") != "volume":
                    raise RuntimeError("Unexpected backend volume target.")
                spec = compose["volumes"].get(state[0]["source"], {}) or {}
                volume = spec.get("name") or settings["composeProject"] + "_" + state[0]["source"]
                check = directory / "server/deploy/kernel-pair-check.mjs"
                if not check.is_file():
                    raise RuntimeError("No pair checker in the deploy archive.")
                docker("run", "--rm", "--network", "none", "--entrypoint", "node", "-v", str(check) + ":/c.mjs:ro", "-v", str(kernel) + ":/k.json:ro", image, "/c.mjs", "check", "/k.json")
                docker("run", *HARDENED, "--network", "none", "-i", "-v", volume + ":/data/server", "-e", "SSAM_RUNTIME_DIR=" + runtime, image, "sh", "-c",
                       'mkdir -p "$SSAM_RUNTIME_DIR" && cat > "$SSAM_RUNTIME_DIR/kernel.json.next" && mv "$SSAM_RUNTIME_DIR/kernel.json.next" "$SSAM_RUNTIME_DIR/kernel.json"',
                       data=kernel.read_bytes())
                return {"ok": True, "kernelOnly": True}
            name = "ssam-vigia-prepare-" + request["id"]
            # Explicit stopped staging container lets ssamctl initialize the exact
            # future Coolify volumes without starting the new router or backend.
            try:
                docker("rm", "-f", name)
            except RuntimeError:
                pass
            args = ["create", "--name", name, "--network", "none", "--label", "ssam.backend=true"]
            for key, value in service["labels"].items():
                args += ["--label", key + "=" + str(value)]
            args += ["-e", "SSAM_RUNTIME_DIR=" + service["environment"]["SSAM_RUNTIME_DIR"]]
            allowed_targets = {'/data/server', '/data/cache', '/data/odc-features', '/data/friction'}
            plugins = 0
            for mount in service["volumes"]:
                target = mount.get('target')
                if target not in allowed_targets and target not in READ_ONLY_VOLUMES:
                    raise RuntimeError('Unexpected backend volume target.')
                if mount.get("type", "volume") != "volume":
                    raise RuntimeError("Unexpected mount type.")
                key = mount["source"]
                spec = compose["volumes"].get(key, {}) or {}
                volume = spec.get("name") or settings["composeProject"] + "_" + key
                if target in READ_ONLY_VOLUMES:
                    if key != READ_ONLY_VOLUMES[target] or mount.get('read_only') is not True:
                        raise RuntimeError('Unexpected read-only backend volume.')
                    if target == MODEL_PLUGINS_TARGET:
                        plugins += 1
                        verify_plugins_volume(volume, image, request.get("modelPlugins"))
                    continue
                args += ["-v", volume + ":" + mount["target"]]
            if plugins != 1:
                raise RemoteError('MODEL_PLUGINS_MOUNT')
            docker(*args, image)
            env = dict(os.environ, SSAM_CONTAINER=name)
            ctl = str(directory / "server/deploy/coolify/ssamctl.sh")
            try:
                command(["sh", ctl, "kernel", "write", str(kernel)], env=env)
                if not kernel_only:
                    command(["sh", ctl, "features", "put", str(features)], env=env)
            finally:
                docker("rm", name)  # Deliberately no -v: never delete a pair volume.
            return {"ok": True}
        finally:
            features.unlink(missing_ok=True)
    if action == "check":
        deadline = time.monotonic() + settings.get("warmTimeoutSeconds", 300)
        while True:
            try:
                servers = backends(settings["composeProject"])
                running = [s for s in servers if s["State"]["Running"]]
                if not running:
                    raise RuntimeError("No running backend.")
                if request.get("expectedBackends"):
                    actual = {(s["Config"]["Labels"].get("ssam.o11"), s["Config"]["Labels"].get("ssam.odc"), s["Image"]) for s in running}
                    before = {(s["o11"], s["odc"], s["image"]) for s in request["expectedBackends"]}
                    if actual != before:
                        raise RuntimeError("Rollback did not restore the previous images and window.")
                if request.get("pinned"):
                    expected = {(o["version"], d["version"]): o for o, d in zip(request["pinned"]["o11"], request["pinned"]["odc"])}
                    actual = {(s["Config"]["Labels"].get("ssam.o11"), s["Config"]["Labels"].get("ssam.odc")) for s in running}
                    if actual != set(expected):
                        raise RuntimeError("Backend window differs from the pin.")
                    for s in running:
                        labels = s["Config"]["Labels"]
                        entry = expected[(labels["ssam.o11"], labels["ssam.odc"])]
                        refs = json.loads(docker("image", "inspect", "--format", "{{json .RepoDigests}}", s["Image"]))
                        if not any(x.endswith("@sha256:" + entry["sha256"]) for x in refs):
                            raise RuntimeError("Running image digest differs from pin.")
                for server in running:
                    events = []
                    for line in docker("logs", server["Id"]).decode().splitlines():
                        try:
                            events.append(json.loads(line))
                        except ValueError:
                            pass
                    warm = next((x for x in reversed(events) if x.get("event") == "warm"), {})
                    if not (warm.get("indexes", {}).get("ok") and warm.get("delivery", {}).get("builder", {}).get("ok") and warm.get("delivery", {}).get("worker", {}).get("ok")):
                        raise RuntimeError("Backend warm failed.")
                break
            except RemoteError:
                raise
            except Exception:
                if time.monotonic() >= deadline:
                    raise RemoteError('NOT_WARM')
                time.sleep(3)
        # The executable check is copied with the release and runs inside each
        # image. Its synthetic credentials stay in memory and are revoked.
        check_source = request.get("checkSource")
        if not check_source:
            raise RuntimeError("Missing protocol check source.")
        # A deployment: every running backend mounts the reviewed plugins volume read-only at its target (the check inside
        # each backend then reads the pinned files there).
        if request.get("modelPlugins"):
            pinned_files(request["modelPlugins"])
            for server in running:
                at = [m for m in server.get("Mounts", []) if m.get("Destination") == MODEL_PLUGINS_TARGET]
                if len(at) != 1 or at[0].get("Type") != "volume" or at[0].get("RW") is not False:
                    raise RemoteError('MODEL_PLUGINS_MOUNT')
        # A deployment: every running backend runs with the served list of the pin (gen-compose servedLists), so a retained
        # backend keeps the list it was deployed with and the new one has the whole window.
        if request.get("expectedServed"):
            for server in running:
                labels = server["Config"]["Labels"]
                want = request["expectedServed"].get(labels.get("ssam.o11", "") + "|" + labels.get("ssam.odc", ""))
                have = [e.split("=", 1)[1] for e in server["Config"].get("Env") or [] if e.startswith("SSAM_SERVED_VERSIONS=")]
                try:
                    same = want is not None and len(have) == 1 and json.loads(have[0]) == json.loads(want)
                except ValueError:
                    same = False
                if not same:
                    raise RemoteError('SERVED_LIST_CHANGED')
        # A backend window (S2 R4, review M1): the image every running backend runs carries exactly the O11 kernels the pin
        # declares for that backend (its label ssam.kernels.o11, read from the image itself, never from the manifest).
        if request.get("expectedKernels"):
            for server in running:
                want = request["expectedKernels"].get(server["Config"]["Labels"].get("ssam.odc", ""))
                labels = json.loads(docker("image", "inspect", "--format", "{{json .Config.Labels}}", server["Image"])) or {}
                have = [v.strip() for v in str(labels.get("ssam.kernels.o11", "")).split(",") if v.strip()]
                if want is None or sorted(set(have)) != sorted(set(want)) or len(have) != len(set(have)):
                    raise RemoteError('IMAGE_KERNELS_DIFFER')
        presented = 0
        offered = []
        for server in running:
            labels = server["Config"]["Labels"]
            source = (request.get("checkSources") or {}).get(labels.get("ssam.o11", "") + "|" + labels.get("ssam.odc", ""), check_source)
            output = docker("exec", "-i", server["Id"], "node", "--input-type=module", data=source.encode()).decode().strip().splitlines()
            try:
                receipt = json.loads(output[-1]) if output else {}
            except ValueError:
                receipt = {}
            if receipt.get("ok") is not True:
                raise RemoteError('CHECK_RECEIPT')
            presented += 1 if receipt.get("presented") is True else 0
            checked = receipt.get("offersChecked")
            offered.append(checked if isinstance(checked, int) and not isinstance(checked, bool) else 0)
        # Server-only: exactly one backend (the new pair) presented the published pack's hello.
        if request.get("requirePresented") and presented != 1:
            raise RemoteError('PACK_HELLO_NOT_PRESENTED')
        # The signed offers of the new pair are keyed to it (check-backend.mjs): exactly one backend offered and delivered all
        # of them and every other one (a retained pair, even one sharing a Studio version) was asked none.
        required = request.get("requireOffers")
        if isinstance(required, int) and not isinstance(required, bool) and required > 0 and sorted(c for c in offered if c) != [required]:
            raise RemoteError('OFFERS_NOT_CHECKED')
        # Check the public aggregate router as well, including TLS validation.
        command(["curl", "--fail", "--silent", "--show-error", "--max-time", "30", settings["healthUrl"]])
        return {"ok": True, "backends": len(running)}
    raise ValueError("Unknown remote operation.")


if __name__ == "__main__":
    try:
        print(json.dumps(dispatch(json.load(sys.stdin))))
    except Exception as error:
        # No subprocess output or request data (it may contain private features).
        print(json.dumps({"ok": False, "code": getattr(error, 'code', 'REMOTE_FAILED')}))
        sys.exit(1)
