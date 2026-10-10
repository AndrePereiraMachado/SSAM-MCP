"""Prova viva do item 13a: um dialogo aberto no Studio (o de recuperacao apos um kill com modulo modificado) faz open_module
devolver `opened:false` + `blockedBy` em segundos, em vez de ficar mudo ate ao timeout. Faixa de ANVIL_LANE (use ss5).

Passos: 1) aplica um job no modulo aberto por merge (modulo fica modificado); 2) mata e reabre o Studio da faixa (aparece o
dialogo Open | Discard); 3) chama open_module e mede; 4) Discard, login, open_module de novo. Nada e publicado.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from anvil_client import AnvilBridge  # noqa: E402
import anvil_cli  # noqa: E402
import lanes  # noqa: E402

LANE = lanes.lane()


def step(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--module", required=True)
    ap.add_argument("--job", default="tests/jobs/service-action.json")
    ap.add_argument("--credentials", required=True)
    args = ap.parse_args()
    b = AnvilBridge(timeout=120)
    mod = b.ok("get_active_module")
    if mod["name"].lower() != args.module.lower():
        print("ABORT: modulo ativo e", mod["name"]); return 5
    base = LANE.proofs / f"{mod['name']}.dialogs.base.oml"
    foreign = LANE.proofs / f"{mod['name']}.dialogs.foreign.oml"
    b.ok("snapshot_module", path=str(base))
    env = anvil_cli.apply(str(base), str(ROOT / args.job), str(foreign), str(LANE.work))
    if not env.get("ok"): print("apply falhou:", env.get("error")); return 3
    m = b.ok("merge_from_oml", foreign_path=str(foreign), base_path=str(base), mode="auto")
    step(f"1) merge para deixar o modulo modificado: {m.get('result')}")
    step("2) kill + reabrir o Studio da faixa (dialogo de recuperacao esperado)")
    r = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ROOT / "scripts" / "open_studio.ps1"), "-Lane", LANE.name, "-ForceRestart", "-NoBuild"], capture_output=True, text=True, encoding="utf-8", errors="replace")
    step(r.stdout.strip().splitlines()[-1][:120] if r.stdout.strip() else r.stderr[-200:])
    # esperar a janela do Studio e o dialogo (cliente NOVO: o socket antigo morreu com o processo)
    deadline = time.time() + 90
    seen = None
    while time.time() < deadline:
        try:
            b = AnvilBridge(timeout=30)
            w = b.ok("windows")
            modal = [x for x in w.get("windows", []) if x.get("isModal") or (x.get("contentKind") == "web" and x.get("isVisible"))]
            if modal:
                seen = modal; break
        except Exception:
            pass
        time.sleep(2)
    step(f"dialogos vistos: {[(x.get('type'), x.get('contentKind'), x.get('owner'), (x.get('texts') or [])[:6]) for x in (seen or [])]}")
    # o cenario real (15:13): Studio LOGADO e o dialogo a bloquear o open; o login pela bridge nao depende do dialogo
    b = AnvilBridge(timeout=300)
    lg0 = b.ok("login", credentials_file=str(pathlib.Path(args.credentials).resolve()))
    step(f"login com o dialogo ainda aberto: {lg0.get('host')}")
    t = time.perf_counter()
    r = b.call("open_module", name=args.module, timeout=60)
    dt = time.perf_counter() - t
    d = r.get("data") or {}
    step(f"3) open_module com dialogo aberto -> {dt:.1f} s: opened={d.get('opened')} blockedBy={json.dumps(d.get('blockedBy'), ensure_ascii=False)[:400]} hint={d.get('hint')} error={r.get('error')}")
    verdict = d.get("opened") is False and d.get("blockedBy") and dt < 10
    step("4) Discard + login + open_module")
    subprocess.run([sys.executable, str(ROOT / "scripts" / "cdp_pages.py"), "--click", "Discard"], capture_output=True, text=True)
    b = AnvilBridge(timeout=300)
    o = b.ok("open_module", name=args.module, timeout=180)
    step(f"depois do Discard: open_module={o}")
    a = b.ok("get_active_module")
    step(f"activeMatch={a.get('activeMatch')} pendingDialogs={a.get('pendingDialogs')} counts={a.get('counts')}")
    step("VEREDICTO: " + ("open_module devolveu blockedBy em segundos" if verdict else "FALHOU: sem blockedBy ou lento"))
    return 0 if verdict else 1


if __name__ == "__main__":
    sys.exit(main())
