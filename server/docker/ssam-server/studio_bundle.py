#!/usr/bin/env python3
"""Unpacks a studio bundle (studio-bundle.ps1 / studio-bundle.sh) into a Studio folder, checking every file.

  studio_bundle.py unpack <bundle.tar.gz> <outdir> --lane odc|o11 --only <studio-<lane>.txt>

The bundle holds bundle.txt (schema ssam-studio-bundle/1, lane, version, ...), SHA256SUMS (sha256sum format, paths
under files/) and files/<path>. Only the paths of --only come out, each written once and checked against SHA256SUMS
while it is written; the result is the same /studio/<lane> as from the installer. Refused, with nothing left in outdir:
another schema or lane (exit 2), a listed path the bundle or SHA256SUMS lacks (exit 2), a member that is not a plain
file or leaves files/ (exit 2), a file whose sha256 differs from SHA256SUMS (exit 3).
"""
import hashlib
import os
import shutil
import sys
import tarfile


def fail(code, message):
    print("studio bundle: " + message, file=sys.stderr)
    sys.exit(code)


def option(name):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else None


def unpack(bundle, outdir, lane, listfile):
    with open(listfile, encoding="utf-8") as fp:
        wanted = [l.strip() for l in fp if l.strip() and not l.lstrip().startswith("#")]
    with tarfile.open(bundle, "r:gz") as tar:
        members = {}
        for m in tar.getmembers():
            name = m.name[2:] if m.name.startswith("./") else m.name
            if m.isdir():
                continue
            if not m.isfile() or name.startswith("/") or ".." in name.split("/"):
                fail(2, "%s: member %s is not a plain file inside the bundle" % (bundle, m.name))
            members[name] = m

        def text(name):
            if name not in members:
                fail(2, "%s has no %s (not a studio bundle)" % (bundle, name))
            return tar.extractfile(members[name]).read().decode("utf-8")

        info = dict(line.split(" ", 1) for line in text("bundle.txt").splitlines() if " " in line)
        if info.get("schema") != "ssam-studio-bundle/1":
            fail(2, "%s: schema %r, expected ssam-studio-bundle/1" % (bundle, info.get("schema")))
        if info.get("lane") != lane:
            fail(2, "%s is a bundle of lane %r, not %r" % (bundle, info.get("lane"), lane))
        sums = {}
        for line in text("SHA256SUMS").splitlines():
            if line.strip():
                digest, path = line.split(None, 1)
                sums[path.strip().lstrip("*")] = digest.lower()
        lacking = [p for p in wanted if "files/" + p not in sums or "files/" + p not in members]
        if lacking:
            fail(2, "%s lacks %d listed file(s): %s" % (bundle, len(lacking), ", ".join(lacking)))
        written = 0
        try:
            for rel in wanted:
                dst = os.path.join(outdir, *rel.split("/"))
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                digest = hashlib.sha256()
                with tar.extractfile(members["files/" + rel]) as src, open(dst, "wb") as out:
                    for chunk in iter(lambda: src.read(1 << 20), b""):
                        digest.update(chunk)
                        out.write(chunk)
                if digest.hexdigest() != sums["files/" + rel]:
                    fail(3, "%s: %s has sha256 %s, SHA256SUMS says %s" % (bundle, rel, digest.hexdigest(), sums["files/" + rel]))
                written += 1
        except SystemExit:
            shutil.rmtree(outdir, ignore_errors=True)
            raise
    print("%s: %d file(s) of %s %s (%s) checked against SHA256SUMS into %s" % (
        os.path.basename(bundle), written, lane, info.get("version"), info.get("source", "?"), outdir))


def main():
    if len(sys.argv) < 4 or sys.argv[1] != "unpack" or not option("--lane") or not option("--only"):
        sys.exit(__doc__)
    unpack(sys.argv[2], sys.argv[3], option("--lane"), option("--only"))


if __name__ == "__main__":
    main()
