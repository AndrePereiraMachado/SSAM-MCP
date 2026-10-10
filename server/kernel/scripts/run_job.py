"""Roda um job de verbos num fixture e imprime o resumo: python scripts/run_job.py <job.json> [--base <oml>] [--out <oml>]

`--lane odc` roda o MESMO job na faixa ODC, pelo CLI `anvil-odc` (o mesmo kernel compilado contra o ODC Studio,
src/Anvil.Cli.Odc), e imprime o mesmo resumo; sem a opcao, a faixa e a O11 de sempre. Assim a mesma sessao trabalha
nas duas plataformas sem trocar de pasta nem de comando. Entregar ao Studio aberto continua a ser outro verbo
(`anvil-odc deliver`, ou `ssam deliver --lane odc`): aqui so se aplica o job a um fixture. Detalhe em docs/lanes.md.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import lanes  # noqa: E402
LANE = lanes.lane()
CLI = LANE.cli
sys.path.insert(0, str(ROOT / "scripts"))
import anvil_cli  # noqa: E402  (worker residente quando esta de pe; senao processo frio)
import odc_worker  # noqa: E402  (o mesmo, para a faixa ODC)
try:
    import worker_pool  # noqa: E402  (piscina: varios workers, um despachante)
except Exception:
    worker_pool = None


def walk(n, ind=0, out=None, skip=("IUILifeCycleEvent", "IArgument")):
    out = [] if out is None else out
    if len(out) > 120:
        return out
    if n["type"] not in skip:
        out.append("  " * ind + f"{n['type']} {n.get('name') or ''}" + (f" = {n['text'][:120]}" if n.get("text") else ""))
    for c in n.get("children", []):
        walk(c, ind + 1, out, skip)
    return out


ODC_ROOT = pathlib.Path(os.environ.get("SSAM_HYBRID_ODC_ROOT", str(ROOT.parent / 'platforms' / 'odc')))


ODC_CLI = ROOT / ".local" / "lane-odc" / "cli" / "anvil-odc.dll"
ODC_WORK = ROOT / ".local" / "lane-odc" / "jobs"


def odc_lane(job: str, base: str | None, out: str | None, producers: list[str]) -> tuple[int, dict]:
    """Faixa ODC: o mesmo job pelo kernel compilado contra o ODC Studio. Primeiro pelo worker residente
    (`anvil-odc serve`, as DLLs do Studio ja carregadas); se ele nao estiver disponivel, processo frio, que da o
    mesmo resultado, so mais lento. O envelope devolvido e o mesmo da faixa O11."""
    if not ODC_CLI.exists():
        print(json.dumps({"ok": False, "lane": "odc", "job": job, "error": "CLI da faixa ODC nao construido",
                          "build": "dotnet build src/Anvil.Cli.Odc -c Release -o .local/lane-odc/cli",
                          "docs": "docs/lanes.md"}, ensure_ascii=False, indent=2))
        return 1, {}
    out = out or str(ODC_WORK / (pathlib.Path(job).stem + ".oml"))
    pathlib.Path(out).parent.mkdir(parents=True, exist_ok=True)
    argv = ["apply", "--job", str(pathlib.Path(job).resolve()), "--out", str(pathlib.Path(out).resolve())]
    if base:
        argv += ["--base", str(pathlib.Path(base).resolve())]
    for producer in producers:
        name, sep, path = producer.partition("=")
        argv += ["--producer", name + sep + str(pathlib.Path(path).resolve()) if sep and path else producer]

    started = time.monotonic()
    envelope, via = None, "worker odc"
    if not os.environ.get("ANVIL_ODC_NO_WORKER"):
        # Piscina primeiro: quando ha mais de um worker de pe, despacha para o livre e da-lhe a pasta de
        # trabalho DELE. Medido com os 48 jobs da faixa: 169 s num worker, 92 s em dois, 55 s em quatro (3,0x).
        # A pasta por worker nao e detalhe - com uma pasta unica o ganho cai de 2,5x para 1,3x, por contencao
        # de metadados do sistema de ficheiros, que nao aparece nem na CPU nem na memoria.
        if worker_pool is not None and len([l for l in worker_pool.estado("odc") if l["de_pe"]]) > 1:
            envelope = worker_pool.correr(argv, "odc", dono=pathlib.Path(job).stem)
            via = "piscina odc"
        else:
            envelope = odc_worker.run(argv + ["--work", str(ODC_WORK / "work")])
    if envelope is None:
        argv = argv + ["--work", str(ODC_WORK / "work")]
    if envelope is None:                                   # sem worker: processo frio, com o mesmo Dispatch
        via = "processo frio odc"
        done = subprocess.run(["dotnet", str(ODC_CLI), *argv], cwd=ROOT, capture_output=True, text=True,
                              encoding="utf-8", errors="replace")
        sys.stderr.write(done.stderr or "")
        try:
            envelope = json.loads(done.stdout)
        except json.JSONDecodeError:
            print(json.dumps({"ok": False, "lane": "odc", "job": job, "exitCode": done.returncode,
                              "error": "o CLI nao devolveu JSON", "stdout": (done.stdout or "")[:2000]},
                             ensure_ascii=False, indent=2))
            return 1, {}
    wall = int((time.monotonic() - started) * 1000)
    if envelope.get("data") is None:                       # erro: o envelope traz error/stack, nao data
        print(json.dumps({"lane": "odc", "job": job, "via": via, **envelope}, ensure_ascii=False, indent=2))
        return 1, {}
    return (0 if envelope.get("ok") else 1), {"ok": bool(envelope.get("ok")), "data": envelope["data"],
                                              "via": via, "wallMs": wall}


def capture_producers(job: str, entries: list[str], folder: pathlib.Path) -> tuple[list[str], list[dict]]:
    """--capture-producer Name[=Produtor]: le (so leitura, pelo Studio ja logado da faixa, sem arquivo de credencial)
    a assinatura atual do produtor com `anvil signature` e devolve os vinculos Name=<.avsig>. Os elementos sao os que
    os ops `reference` do job pedem a esse nome. E leitura ao vivo: o job continua a nao entregar nada ao Studio."""
    bindings, receipts = [], []
    folder.mkdir(parents=True, exist_ok=True)
    for entry in entries:
        binding, sep, producer = entry.partition("=")
        producer = producer if sep and producer else binding
        target = folder / f"{binding}.avsig"
        argv = ["dotnet", str(CLI), "signature", "--producer", producer, "--job", str(pathlib.Path(job).resolve()),
                "--binding", binding, "--out", str(target.resolve()), "--bridge-port", str(LANE.bridge)]
        done = subprocess.run(argv, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace")
        sys.stderr.write(done.stderr or "")
        try:
            envelope = json.loads(done.stdout)
        except json.JSONDecodeError:
            envelope = {"ok": False, "error": "o CLI nao devolveu JSON", "stdout": (done.stdout or "")[:2000]}
        if not envelope.get("ok"):
            raise SystemExit(json.dumps({"ok": False, "stage": "capture-producer", "producer": producer,
                                         "error": envelope.get("error")}, ensure_ascii=False, indent=2))
        receipts.append(envelope["data"])
        bindings.append(f"{binding}={target.resolve()}")
    return bindings, receipts


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("job")
    ap.add_argument("--base", help="fixture .oml (padrao: campo base do job; job:<nome> aplica esse job antes)")
    ap.add_argument("--out")
    ap.add_argument("--producer", action="append", default=[], metavar="Name=oml", help="vincula um snapshot ao nome usado no job; repetivel")
    ap.add_argument("--capture-producer", action="append", default=[], metavar="Name[=Produtor]",
                    help="captura so leitura (anvil signature, Studio logado) e vincula o .avsig ao nome; repetivel; faixa o11")
    ap.add_argument("--lane", choices=("o11", "odc"), default="o11",
                    help="o11 (padrao): este runner sobre um fixture do Anvil; odc: o mesmo job pelo CLI anvil-odc (docs/lanes.md)")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()
    captured = []
    if args.capture_producer:
        if args.lane == "odc":
            print(json.dumps({"ok": False, "error": "--capture-producer existe so na faixa o11 (assinaturas O11)"}, ensure_ascii=False))
            return 1
        bound, captured = capture_producers(args.job, args.capture_producer,
                                            LANE.jobs / "captured" / pathlib.Path(args.job).stem)
        args.producer += bound
        for receipt in captured:
            print(f"   captured {receipt.get('producer')} {receipt.get('kind')} version={receipt.get('versionIdBefore')} "
                  f"signatureHash={receipt.get('signatureHash')} avsig={receipt.get('avsigPath')} sha256={receipt.get('avsigSha256')}")
    if args.lane == "odc":
        code, d = odc_lane(args.job, args.base, args.out, args.producer)
        if not d:
            return code
        out = args.out or str(ODC_WORK / (pathlib.Path(args.job).stem + ".oml"))
    else:
        out = args.out or str(LANE.jobs / (pathlib.Path(args.job).stem + ".oml"))
        pathlib.Path(out).parent.mkdir(parents=True, exist_ok=True)
        d = None
        # Piscina O11, como a da ODC: com mais de um worker de pe, o job vai para um worker livre RESERVADO, com
        # a pasta de trabalho dele; a saida diz a porta. Sem piscina, o worker unico ou o processo frio de sempre.
        if (worker_pool is not None and os.environ.get("ANVIL_WORKER", "1") != "0"
                and len([l for l in worker_pool.estado("o11") if l["de_pe"]]) > 1):
            argv = ["apply", "--job", str(pathlib.Path(args.job).resolve()), "--out", str(pathlib.Path(out).resolve())]
            if args.base is not None:
                argv += ["--base", str(pathlib.Path(args.base).resolve())]
            for producer in args.producer:
                name, sep, path = producer.partition("=")
                argv += ["--producer", name + sep + str(pathlib.Path(path).resolve()) if sep and path else producer]
            d = worker_pool.correr(argv, "o11", dono=pathlib.Path(args.job).stem)
            if d is not None:
                d["via"] = f"piscina o11 porta {d.get('porta')}"
        if d is None:
            d = anvil_cli.apply(args.base, args.job, out, producers=args.producer)
    if captured:
        d["capturedProducers"] = captured
    result_path = pathlib.Path(out).with_suffix(".result.json")
    result_path.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
    x = d.get("data") or {}
    print("   result:", result_path.resolve())
    if contract := x.get("dataContract"):
        print(f"   data contract: {contract.get('count')} checks, accepted={contract.get('accepted')}; dataSummary saved in result")
        for difference in contract.get("differences", [])[:10]:
            print("   data mismatch:", difference)
    print(f"== {pathlib.Path(args.job).name}: ok={d['ok']}", d.get("error") or {k: x[k] for k in ("ops", "objects", "isValid", "messages", "applyMs")})
    print("   via", d.get("via"), "|", d.get("wallMs"), "ms de parede")
    if "validation" in x:
        print("   validation", {k: len(v) for k, v in x["validation"].items()}, "accepted=", x["accepted"])
    if timing := x.get("timings"):
        print("   timings", timing)
    if inventory := x.get("preflight"):
        if inventory.get("actions"):
            print("   logic declarations", {k: inventory[k] for k in ("actions", "publicActions", "helpers")})
            if inventory.get("alwaysRaises"):
                print("   always-raising endpoints (not completed integrations):", ", ".join(inventory["alwaysRaises"]))
            if inventory.get("identicalImplementations"):
                print("   identical bodies (review API intent):", [g["names"] for g in inventory["identicalImplementations"]])
    for m in (x.get("details") or [])[:10]:
        print("   ", m)
    if not args.quiet:
        for r in x.get("results", []):
            if r["op"] == "get":
                props = {k: v for k, v in r["result"]["properties"].items() if v not in (None, 0, "0", False, "False", "")}
                print("   get", r["result"]["type"], r["result"].get("name") or "", json.dumps(props, ensure_ascii=False)[:1500])
            if r["op"] == "dump":
                print("\n".join("   " + line for line in walk(r["result"])))
    if not args.quiet:
        for r in x.get("results", []):
            if r["op"] == "find":
                print("   find", [(x.get("type"), x.get("name")) for x in r["result"]][:20])
            if r["op"] in ("usages", "rename", "reference", "delete", "layout"):
                print("   " + r["op"], json.dumps(r["result"], ensure_ascii=False)[:1500])
    for message in x.get("policyMessages", []):
        print("   ", message)
    return 0 if d["ok"] and x.get("accepted") else 1


if __name__ == "__main__":
    sys.exit(main())

