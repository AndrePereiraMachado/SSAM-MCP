"""Worker-level proof and timing of the base cache (BaseModelCache, tier 1 'spare').

Starts ONE worker of the lane on the given port (its own process, killed at the end), applies the same job N times with
the think time a spare needs between rounds, and checks that from round 2 on the base is a hit and each result is the
same as a cold process's: the worker_soak signature (ops, objects, isValid, messages, Verify details, inspect of the
output without its sample, reference names) plus the validation lists and op results with every ObjectKey masked.
Never compares OML bytes: saves are not deterministic. `--cache off` starts the worker with the operator switch
(ANVIL_BASE_CACHE=off), for the timings without the cache.

  python scripts/base_cache_check.py --lane o11 --port 24500 --base tests/fixtures/hmisjha/HMISJHA_CS-v5578.oml --job <job.json>
  python scripts/base_cache_check.py --lane odc --port 24501 --base tests/fixtures/odc/insurance-reactive-r8.oml --job <job.json>
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import socket
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import anvil_authority  # noqa: E402

CLI = {"o11": ROOT / ".local" / "cli" / "anvil.dll", "odc": ROOT / ".local" / "lane-odc" / "cli" / "anvil-odc.dll"}


def call(port: int, argv: list[str], timeout: float = 900) -> dict:
    try:
        key = anvil_authority.key_path().read_text(encoding="ascii").strip()
    except (FileNotFoundError, PermissionError):
        key = None
    with socket.create_connection(("127.0.0.1", port), timeout=timeout) as s:
        s.settimeout(timeout)
        s.sendall((json.dumps({"args": [str(a) for a in argv], "authorization": key}) + "\n").encode("utf-8"))
        data = b""
        while b"\n" not in data:
            chunk = s.recv(1 << 20)
            if not chunk:
                raise ConnectionError("worker closed the connection")
            data += chunk
    return json.loads(data.split(b"\n", 1)[0].decode("utf-8"))


def ping(port: int) -> dict | None:
    try:
        return call(port, ["ping"], timeout=3).get("data")
    except (OSError, ValueError):
        return None


def masked(node):
    """ObjectKeys are identity, generated again on every run: drop every field named like a key."""
    if isinstance(node, dict):
        return {k: masked(v) for k, v in node.items() if not k.lower().endswith("key")}
    if isinstance(node, list):
        return [masked(v) for v in node]
    return node


def signature(result: dict, snapshot: dict) -> dict:
    validation = dict(snapshot.get("Validation") or {})
    validation.pop("Sample", None)  # cites ObjectKeys
    return {"ops": result.get("ops"), "objects": result.get("objects"), "isValid": result.get("isValid"),
            "messages": result.get("messages"), "accepted": result.get("accepted"), "details": result.get("details"),
            "validation": masked(result.get("validation")), "results": masked(result.get("results")),
            "output": {"objects": snapshot.get("Objects"), "isValid": snapshot.get("IsValid"), "validation": validation,
                       "refs": sorted(r.get("Name") or "" for r in snapshot.get("References") or [])}}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--lane", choices=sorted(CLI), required=True)
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--base", required=True)
    ap.add_argument("--job", required=True)
    ap.add_argument("--rounds", type=int, default=3)
    ap.add_argument("--cache", choices=("on", "off"), default="on")
    ap.add_argument("--no-cold", action="store_true", help="skip the cold reference run")
    ap.add_argument("--gap", type=float, default=0, help="think time between rounds when the cache is off (s)")
    ap.add_argument("--wait", type=float, default=180, help="longest wait for the spare between rounds (s)")
    ap.add_argument("--work", help="default: .local/base-cache-check/<lane>-<port>-<cache>")
    ap.add_argument("--authority", help="ANVIL_AUTHORITY_DIR for this worker and client (isolated runs)")
    a = ap.parse_args()

    cli = CLI[a.lane]
    base, job = pathlib.Path(a.base).resolve(), pathlib.Path(a.job).resolve()
    work = pathlib.Path(a.work or ROOT / ".local" / "base-cache-check" / f"{a.lane}-{a.port}-{a.cache}").resolve()
    (work / "logs").mkdir(parents=True, exist_ok=True)
    if a.authority:
        os.environ["ANVIL_AUTHORITY_DIR"] = str(pathlib.Path(a.authority).resolve())
    env = dict(os.environ, ANVIL_WORKER="0", ANVIL_ODC_NO_WORKER="1")
    env.pop("ANVIL_BASE_CACHE", None)
    if a.cache == "off":
        env["ANVIL_BASE_CACHE"] = "off"
    sha16 = hashlib.sha256(base.read_bytes()).hexdigest()[:16]
    apply = lambda out, w: ["apply", "--job", str(job), "--base", str(base), "--out", str(out), "--work", str(w)]  # noqa: E731

    rows, outputs = [], {}
    if not a.no_cold:
        t = time.monotonic()
        done = subprocess.run(["dotnet", str(cli), *apply(work / "cold.oml", work / "cold-work")], cwd=work, env=env,
                              capture_output=True, text=True, encoding="utf-8", errors="replace")
        envelope = json.loads(done.stdout)
        rows.append({"tag": "cold", "wallMs": int((time.monotonic() - t) * 1000), "envelope": envelope})
        outputs["cold"] = work / "cold.oml"

    if ping(a.port) is not None:
        raise SystemExit(f"port {a.port} already answers: use a free port of your own")
    proc = subprocess.Popen(["dotnet", str(cli), "serve", "--port", str(a.port), "--log-dir", str(work / "logs")], cwd=work, env=env,
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        limit = time.monotonic() + 120
        while ping(a.port) is None:
            if proc.poll() is not None or time.monotonic() > limit:
                raise SystemExit(f"worker did not start (exit {proc.poll()})")
            time.sleep(0.2)
        for i in range(1, a.rounds + 1):
            waited = 0.0
            if i > 1 and a.cache == "on":
                t = time.monotonic()
                while time.monotonic() - t < a.wait:
                    status = ping(a.port) or {}
                    if sha16 in ((status.get("baseCache") or {}).get("keys") or []) and not status.get("idleWork"):
                        break
                    time.sleep(0.1)
                waited = time.monotonic() - t
            elif i > 1:
                time.sleep(a.gap)
            out = work / f"r{i}.oml"
            t = time.monotonic()
            envelope = call(a.port, apply(out, work / "worker-work"))
            rows.append({"tag": f"r{i}", "wallMs": int((time.monotonic() - t) * 1000), "waitedMs": int(waited * 1000), "envelope": envelope})
            outputs[f"r{i}"] = out
        snapshots = {tag: (call(a.port, ["inspect", "--oml", str(path), "--work", str(work / "inspect-work")]).get("data") or {})
                     for tag, path in outputs.items()}
        stats = (ping(a.port) or {}).get("baseCache")
    finally:
        try:
            call(a.port, ["shutdown"], timeout=30)
        except (OSError, ValueError):
            pass
        try:
            proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            proc.kill()

    failures, reference = [], None
    for row in rows:
        env_ = row["envelope"]
        data = env_.get("data")
        if not data:  # an error envelope; an apply that ran but was not accepted still has a result to compare
            failures.append(f"{row['tag']}: {str(env_.get('error'))[:300]}")
            continue
        row["signature"] = json.dumps(signature(data, snapshots.get(row["tag"]) or {}), sort_keys=True)
        reference = reference or row["signature"]
        if row["signature"] != reference:
            failures.append(f"{row['tag']}: signature differs from {rows[0]['tag']}")
        hit = (data.get("baseCache") or {}).get("hit")
        if a.cache == "on" and row["tag"] not in ("cold", "r1") and hit is not True:
            failures.append(f"{row['tag']}: expected a spare hit, got {data.get('baseCache')}")

    print(f"{a.lane} cache={a.cache} base={base.name} ({sha16}) job={job.name}")
    for row in rows:
        data = row["envelope"].get("data") or {}
        tm, bc = data.get("timings") or {}, data.get("baseCache") or {}
        print(f"  {row['tag']:>4} wall={row['wallMs']:>6} waited={row.get('waitedMs', 0):>6} hit={bc.get('hit')!s:>5} "
              f"load={tm.get('loadMs')} acquire={tm.get('baseAcquireMs')} verifyBefore={tm.get('verifyBeforeMs')} apply={tm.get('applyMs')} "
              f"describe={tm.get('describeMs')} details={tm.get('detailsMs')} save={tm.get('saveMs')} total={tm.get('totalMs')}")
    print("  worker baseCache:", json.dumps(stats))
    summary = {"lane": a.lane, "cache": a.cache, "base": str(base), "sha16": sha16, "job": str(job), "failures": failures,
               "stats": stats, "rounds": [{"tag": r["tag"], "wallMs": r["wallMs"], "waitedMs": r.get("waitedMs"),
                                           "signatureSha": hashlib.sha256(r.get("signature", "").encode()).hexdigest()[:16],
                                           "timings": (r["envelope"].get("data") or {}).get("timings"),
                                           "baseCache": (r["envelope"].get("data") or {}).get("baseCache")} for r in rows]}
    (work / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print("  VERDICT:", "OK, every round equals the first" + (" and rounds 2.. are hits" if a.cache == "on" else "")
          if not failures else "FAILED: " + "; ".join(failures))
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
