"""Prova viva dos itens 12 e 13a no cenario REAL: produtor republicado -> consumidor abre com o dialogo de referencias ->
`open_module` devolve `blockedBy` em segundos e `merge_from_oml` recusa (nunca "Matches cannot be set already" nem 180 s mudos).
So em modulos de TESTE (app Davitest). Faixa de ANVIL_LANE (use ss5). Publica 3 vezes (produtor, consumidor, produtor).

Passos: A) Davitest_CS: entidade publica (spec) + publish; B) download do OML do produtor; C) Davitest_UI: reference ao produtor
+ publish; D) Davitest_CS: atributo novo na entidade + publish; E) kill + reabrir o Studio, login, open_module Davitest_UI e medir.
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
import lanes  # noqa: E402

LANE = lanes.lane()


def step(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def sh(args: list[str], timeout: int = 900) -> str:
    r = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout, cwd=str(ROOT))
    return (r.stdout + r.stderr).strip()


def deliver(module: str, job: pathlib.Path, publish: bool, checks: str, producers: list[str] | None = None) -> str:
    args = [sys.executable, str(ROOT / "scripts" / "proof_merge.py"), "--module", module, "--job", str(job), "--checks", checks, "--flow", ""]
    for producer in producers or []:
        args += ["--producer", producer]
    if publish:
        args.append("--publish")
    out = sh(args)
    tail = [l for l in out.splitlines() if "TrueChange" in l or "publish" in l or "ABORT" in l or "apply falhou" in l]
    return " | ".join(t[-160:] for t in tail[-3:]) or out[-300:]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--producer", default="Davitest_CS")
    ap.add_argument("--consumer", default="Davitest_UI")
    ap.add_argument("--credentials", required=True)
    ap.add_argument("--from-step", default="A", help="A (tudo) ou D (produtor e consumidor ja publicados)")
    args = ap.parse_args()
    creds = str(pathlib.Path(args.credentials).resolve())
    work = LANE.work / "refs-dialog"; work.mkdir(parents=True, exist_ok=True)

    prod_dir = LANE.local / "producers"; prod_dir.mkdir(parents=True, exist_ok=True)
    prod_oml = next((p for p in prod_dir.glob("*.oml") if args.producer.lower() in p.name.lower()), None)
    if args.from_step.upper() < "D":
        # A) produtor: entidade publica
      job_a = work / "producer-entity.json"
      job_a.write_text(json.dumps({"description": "prova 12/13a: entidade publica no produtor", "base": "tests/fixtures/blank-service.oml", "expectValid": True,
          "ops": [{"op": "spec", "data": {"entities": [{"name": "RefProbe", "public": True, "description": "prova do dialogo de referencias",
                   "attributes": [{"name": "Name", "type": "Text", "mandatory": True, "length": 50}]}]}}]}, ensure_ascii=False), encoding="utf-8")
      sh([sys.executable, str(ROOT / "scripts" / "studio_env.py"), "open", "--module", args.producer])
      step(f"A) {args.producer}: entidade publica RefProbe + publish -> {deliver(args.producer, job_a, True, 'RefProbe')}")

      # B) OML do produtor (publicado)
      prod_dir = LANE.local / "producers"; prod_dir.mkdir(parents=True, exist_ok=True)
      out = sh(["dotnet", str(LANE.cli), "download", "--credentials", creds, "--module", args.producer, "--out", str(prod_dir)])
      prod_oml = next((p for p in prod_dir.glob("*.oml") if args.producer.lower() in p.name.lower()), None)
      step(f"B) download do produtor -> {prod_oml} ({'ok' if prod_oml and prod_oml.exists() else out[-200:]})")
      if not prod_oml:
          return 3

      # C) consumidor: reference ao produtor + publish
      job_c = work / "consumer-reference.json"
      job_c.write_text(json.dumps({"description": "prova 12/13a: consumidor referencia a entidade publica", "base": "tests/fixtures/reactive-ui.oml", "expectValid": True,
          "ops": [{"op": "reference", "producer": args.producer, "elements": ["IServerEntity:RefProbe"], "as": "$cs"}]}, ensure_ascii=False), encoding="utf-8")
      sh([sys.executable, str(ROOT / "scripts" / "studio_env.py"), "open", "--module", args.consumer])
      step(f"C) {args.consumer}: reference RefProbe + publish -> {deliver(args.consumer, job_c, True, 'RefProbe', [args.producer + '=' + str(prod_oml)])}")

    # D) produtor: atributo novo na entidade publica + publish (muda a assinatura que o consumidor referencia)
    job_d = work / "producer-change.json"
    job_d.write_text(json.dumps({"description": "prova 12/13a: atributo novo na entidade referenciada", "base": "tests/fixtures/blank-service.oml", "expectValid": True,
        "ops": [{"op": "rename", "target": "IServerEntity:RefProbe/Name", "name": "Title"}]}, ensure_ascii=False), encoding="utf-8")
    sh([sys.executable, str(ROOT / "scripts" / "studio_env.py"), "open", "--module", args.producer])
    step(f"D) {args.producer}: rename Name->Title (incompativel) + publish -> {deliver(args.producer, job_d, True, 'Title')}")

    # E) reiniciar o Studio da faixa, login, abrir o consumidor (dialogo de referencias esperado)
    r = sh(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ROOT / "scripts" / "open_studio.ps1"), "-Lane", LANE.name, "-ForceRestart", "-NoBuild"], timeout=300)
    step("E) restart: " + (r.splitlines()[-1][:100] if r else ""))
    time.sleep(3)
    sh([sys.executable, str(ROOT / "scripts" / "cdp_pages.py"), "--click", "Discard"])
    b = AnvilBridge(timeout=300)
    lg = b.ok("login", credentials_file=creds)
    step(f"   login {lg.get('host')}")
    t = time.perf_counter()
    o = b.call("open_module", name=args.consumer, timeout=90)
    dt = time.perf_counter() - t
    d = o.get("data") or {}
    step(f"   open_module {args.consumer} -> {dt:.1f} s: opened={d.get('opened')} alreadyOpen={d.get('alreadyOpen')} blockedBy={json.dumps(d.get('blockedBy'), ensure_ascii=False)[:500]} error={o.get('error')}")
    pages = sh([sys.executable, str(ROOT / "scripts" / "cdp_pages.py")])
    step("   cdp_pages: " + " || ".join(l[:160] for l in pages.splitlines() if "buttons:" in l and "buttons: $" not in l)[:600])
    m = b.call("merge_from_oml", foreign_path=str(prod_oml), base_path=str(prod_oml), mode="preview")
    step(f"   merge_from_oml com o dialogo pendente -> success={m.get('success')} error={(m.get('error') or '')[:300]}")
    a = b.call("get_active_module").get("data") or {}
    step(f"   get_active_module: activeMatch={a.get('activeMatch')} pendingDialogs={json.dumps(a.get('pendingDialogs'), ensure_ascii=False)[:300]}")
    verdict = (d.get("opened") is False and d.get("blockedBy")) or (m.get("success") is False and "pending" in (m.get("error") or ""))
    step("VEREDICTO: " + ("bloqueio detetado e ensinado" if verdict else "sem bloqueio detetado (ver linhas acima)"))
    return 0 if verdict else 1


if __name__ == "__main__":
    sys.exit(main())
