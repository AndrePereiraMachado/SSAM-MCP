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


def command(args, data=None, env=None):
    result = subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            env=env, timeout=900)
    if result.returncode:
        raise RuntimeError("Remote command failed: " + args[0])
    return result.stdout


def docker(*args, data=None):
    return command(["docker", *args], data=data)


def backends(project):
    ids = docker("ps", "-aq", "--filter", "label=ssam.backend=true", "--filter", "label=com.docker.compose.project=" + project).decode().split()
    return json.loads(docker("inspect", *ids)) if ids else []


def dispatch(request):
    settings = request["settings"]
    base = pathlib.Path(settings["directory"])
    if not base.is_absolute() or ".." in base.parts:
        raise ValueError("Remote directory must be absolute.")
    action = request["action"]
    if action == "snapshot":
        return {"ok": True, "backends": [{"o11": s["Config"]["Labels"].get("ssam.o11"), "odc": s["Config"]["Labels"].get("ssam.odc"), "image": s["Image"]} for s in backends(settings["composeProject"]) if s["State"]["Running"]]}
    if action == "event":
        # The system journal is available even without a console ingestion API.
        command(["logger", "-t", "ssam-vigia", request["event"] + " " + request["id"]])
        return {"ok": True}
    if action == "backup":
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
        return {"ok": True, "directory": str(directory), "volumes": len(volumes)}
    if action == "prepare":
        os.umask(0o077)
        if not re.fullmatch(r"o11-[0-9.]+-odc-[0-9.]+", request["id"]):
            raise ValueError("Invalid pair.")
        directory = base / "releases" / request["id"]
        directory.mkdir(parents=True, exist_ok=True)
        with tarfile.open(fileobj=io.BytesIO(base64.b64decode(request["archive"])), mode="r:gz") as archive:
            for member in archive.getmembers():
                name = member.name.rstrip("/")
                ancestor = member.isdir() and name in ("server", "server/deploy")
                if not (ancestor or name.startswith("server/deploy/")) or ".." in pathlib.PurePosixPath(name).parts or member.issym() or member.islnk():
                    raise ValueError("Unsafe deploy archive.")
            archive.extractall(directory, filter="data")
        kernel = directory / "kernel.json"
        features = directory / "Features.plain.xml"
        kernel.write_text(json.dumps(request["kernel"]))
        features.write_bytes(base64.b64decode(request["features"]))
        compose = request["compose"]
        service = compose["services"]["ssam-server-v1"]
        image = request["built"]["image"] + ":" + request["built"]["tag"]
        docker("pull", image)
        digests = json.loads(docker("image", "inspect", "--format", "{{json .RepoDigests}}", image))
        if not any(d.endswith("@sha256:" + request["built"]["sha256"]) for d in digests):
            raise RuntimeError("Pulled image digest differs from the tested digest.")
        name = "ssam-vigia-prepare-" + request["id"]
        # Explicit stopped staging container lets ssamctl initialize the exact
        # future Coolify volumes without starting the new router or backend.
        args = ["create", "--name", name, "--network", "none", "--label", "ssam.backend=true"]
        for key, value in service["labels"].items():
            args += ["--label", key + "=" + str(value)]
        args += ["-e", "SSAM_RUNTIME_DIR=" + service["environment"]["SSAM_RUNTIME_DIR"]]
        for mount in service["volumes"]:
            if mount.get("type", "volume") != "volume":
                raise RuntimeError("Unexpected mount type.")
            key = mount["source"]
            spec = compose["volumes"].get(key, {}) or {}
            volume = spec.get("name") or settings["composeProject"] + "_" + key
            args += ["-v", volume + ":" + mount["target"]]
        docker(*args, image)
        env = dict(os.environ, SSAM_CONTAINER=name)
        ctl = str(directory / "server/deploy/coolify/ssamctl.sh")
        try:
            command(["sh", ctl, "kernel", "write", str(kernel)], env=env)
            command(["sh", ctl, "features", "put", str(features)], env=env)
        finally:
            features.unlink(missing_ok=True)
            docker("rm", name)  # Deliberately no -v: never delete a pair volume.
        return {"ok": True}
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
            except Exception:
                if time.monotonic() >= deadline:
                    raise RuntimeError("Backend checks timed out.")
                time.sleep(3)
        # The executable check is copied with the release and runs inside each
        # image. Its synthetic credentials stay in memory and are revoked.
        check_source = request.get("checkSource")
        if not check_source:
            raise RuntimeError("Missing protocol check source.")
        for server in running:
            docker("exec", "-i", server["Id"], "node", "--input-type=module", data=check_source.encode())
        # Check the public aggregate router as well, including TLS validation.
        command(["curl", "--fail", "--silent", "--show-error", "--max-time", "30", settings["healthUrl"]])
        return {"ok": True, "backends": len(running)}
    raise ValueError("Unknown remote operation.")


if __name__ == "__main__":
    try:
        print(json.dumps(dispatch(json.load(sys.stdin))))
    except Exception:
        # No subprocess output or request data (it may contain private features).
        print(json.dumps({"ok": False, "code": "remote-release-failed"}))
        sys.exit(1)
