"""Prova de determinismo AO VIVO: entrega o mesmo job N vezes no modulo aberto do SS4 e exige o mesmo resultado em todas.

Ciclo = snapshot (base limpa) -> apply headless (anvil CLI) -> merge de 3 vias -> TrueChange -> contagens -> reposicao do
modulo ao estado da base por merge inverso (foreign = base limpa, base = estado entregue) -> TrueChange e contagens da
reposicao. Nada e publicado. A assinatura de cada ciclo (contagens, erros, warnings, mensagens, objetos do OML aplicado)
tem de ser identica; senao a entrega "as vezes funciona" e nao entra.

Uso: python scripts/proof_cycles.py --module Headless_CS --job tests/jobs/tickets-all.json --cycles 5 [--checks A,B]
"""
from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import sys
import time
from datetime import datetime

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from anvil_client import AnvilBridge  # noqa: E402
import anvil_cli  # noqa: E402

import lanes  # noqa: E402
LANE = lanes.lane()
CLI = LANE.cli
OUT = LANE.proofs


def step(msg: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def counts_of(b: AnvilBridge) -> dict:
    m = b.ok("get_active_module")
    return m["counts"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--module", required=True)
    ap.add_argument("--job", required=True)
    ap.add_argument("--cycles", type=int, default=5)
    ap.add_argument("--checks", default="")
    ap.add_argument("--port", type=int, default=LANE.bridge)
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    b = AnvilBridge(port=args.port, timeout=600)

    mod = b.ok("get_active_module")
    if mod["name"].lower() != args.module.lower():
        print(f"ABORT: modulo ativo e {mod['name']}, nao {args.module}"); return 5
    step(f"modulo {mod['name']} counts={mod['counts']}")
    signatures: list[str] = []
    timings: list[dict] = []
    for cycle in range(1, args.cycles + 1):
        stamp = datetime.now().strftime("%H%M%S")
        t0 = time.perf_counter()
        base = OUT / f"{mod['name']}.cycle{cycle}.base.{stamp}.oml"
        snap = b.ok("snapshot_module", path=str(base))
        t_snap = time.perf_counter()
        foreign = OUT / f"{mod['name']}.cycle{cycle}.foreign.{stamp}.oml"
        env = anvil_cli.apply(str(base), args.job, str(foreign), str(OUT / "work"))
        if not env.get("ok"):
            print("apply falhou:", env.get("error")); return 3
        d = env["data"]
        if not d.get("accepted") or not d["isValid"]:
            print("apply rejeitado:", d.get("policyMessages")); return 4
        t_apply = time.perf_counter()
        merge = b.ok("merge_from_oml", foreign_path=str(foreign), base_path=str(base), mode="auto")
        t_merge = time.perf_counter()
        err = b.ok("get_errors", max=20)
        counts = counts_of(b)
        t_verify = time.perf_counter()
        finds = {}
        for name in [c for c in args.checks.split(",") if c]:
            finds[name] = sorted(r["type"] for r in b.ok("find_element", name=name, max=5)["results"])
        sig = json.dumps({"apply": {"ops": d["ops"], "objects": d["objects"], "isValid": d["isValid"], "messages": d["messages"], "details": d.get("details")},
                          "merge": {"merged": merge.get("merged"), "result": merge.get("result"), "conflicts": merge.get("hasConflicts")},
                          "truechange": {"errors": err["errors"], "warnings": err["warnings"], "messages": err["messages"]},
                          "counts": counts, "finds": finds}, sort_keys=True)
        signatures.append(sig)
        step(f"ciclo {cycle}: apply {d['objects']} obj valid={d['isValid']} msgs={d['messages']} | merge {merge.get('result')} | TrueChange erros={err['errors']} warnings={err['warnings']} | counts={counts}")
        # reposicao: merge inverso (foreign = base limpa, base = estado entregue)
        delivered = OUT / f"{mod['name']}.cycle{cycle}.delivered.{stamp}.oml"
        b.ok("snapshot_module", path=str(delivered))
        back = b.ok("merge_from_oml", foreign_path=str(base), base_path=str(delivered), mode="auto")
        err2 = b.ok("get_errors", max=10)
        counts2 = counts_of(b)
        t_reset = time.perf_counter()
        step(f"  reposicao: merge {back.get('result')} | TrueChange erros={err2['errors']} warnings={err2['warnings']} | counts={counts2}")
        timings.append({"snapshot": round(t_snap - t0, 1), "apply": round(t_apply - t_snap, 1), "merge": round(t_merge - t_apply, 1), "truechange": round(t_verify - t_merge, 1), "entrega": round(t_verify - t0, 1), "reposicao": round(t_reset - t_verify, 1)})
        if counts2 != mod["counts"] or err2["errors"] != 0:
            print("ABORT: a reposicao nao devolveu o modulo ao estado da base; ciclos seguintes nao seriam comparaveis"); break
    distinct = len(set(signatures))
    step(f"{len(signatures)} ciclos, {distinct} assinatura(s) distinta(s): {'DETERMINISTICO' if distinct == 1 and len(signatures) == args.cycles else 'NAO DETERMINISTICO'}")
    for i, t in enumerate(timings, 1):
        step(f"  ciclo {i}: entrega {t['entrega']} s (snapshot {t['snapshot']} + apply {t['apply']} + merge {t['merge']} + TrueChange {t['truechange']}), reposicao {t['reposicao']} s")
    if distinct > 1:
        for s in set(signatures): print(s[:1500])
    return 0 if distinct == 1 and len(signatures) == args.cycles else 1


if __name__ == "__main__":
    sys.exit(main())
