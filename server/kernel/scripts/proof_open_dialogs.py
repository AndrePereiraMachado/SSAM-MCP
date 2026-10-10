"""Prova 13b num consumidor de laboratorio com produtor republicado (preparacao: proof_refs_dialog.py).
Nao publica nem atualiza referencias. A aba precisa estar guardada: close_module recusa edicoes pendentes.
ANVIL_LANE=ss5 python scripts/proof_open_dialogs.py --module Davitest_UI --mode silent|interactive|timeout
interactive/timeout podem deixar um dialogo: Cancel no Studio conserva as referencias e permite continuar.
"""
from __future__ import annotations
import argparse
import json
import time
from anvil_client import AnvilBridge


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--module", default="Davitest_UI")
    ap.add_argument("--mode", choices=["silent", "interactive", "timeout"], default="silent")
    args = ap.parse_args()
    bridge = AnvilBridge(timeout=25)
    closed = bridge.ok("close_module", name=args.module)
    if not closed.get("closed"):
        raise RuntimeError("test tab did not close")
    start = time.perf_counter()
    result = bridge.call("open_module", name=args.module, silent=args.mode != "interactive", timeout=0 if args.mode == "timeout" else 20)
    elapsed = time.perf_counter() - start
    modules = bridge.ok("list_open_modules")["modules"]
    assert all(m.get("serverSilentMode") is False for m in modules), modules
    data = result.get("data") or {}
    print(json.dumps({"mode": args.mode, "elapsedSeconds": round(elapsed, 3), "result": result, "flagsReset": True}, ensure_ascii=False))
    if args.mode == "silent":
        assert data.get("opened") and not data.get("alreadyOpen"), result
        assert data.get("referencesOutdated") is True and data.get("referencesCheck") == "complete", result
        assert elapsed < 20 and not data.get("blockedBy"), result
    elif args.mode == "interactive":
        assert data.get("opened") is False and data.get("blockedBy"), result
        assert elapsed < 5, elapsed
    else:
        assert not result.get("success") and "0 s" in result.get("error", ""), result
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
