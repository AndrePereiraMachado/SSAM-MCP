"""Prova do worker residente (item 5): a suite inteira de jobs (tests/jobs) N vezes no MESMO worker, comparada job a job com
o processo frio. Assinatura de um job = ops, objetos, isValid, mensagens, detalhes do Verify, tipos de objeto e validacao do
OML resultante (inspect). Se alguma assinatura mudar entre rodadas ou contra o frio, o worker nao entra: seria o
"as vezes funciona".

Uso: python scripts/anvil_worker.py start && python scripts/worker_soak.py --rounds 10 [--jobs tests/jobs] [--filter tickets]
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys
import time
from datetime import datetime

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import anvil_cli  # noqa: E402

WORK = anvil_cli.LANE.soak


def step(msg: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def job_base(job: pathlib.Path) -> str:
    return json.loads(job.read_text(encoding="utf-8-sig")).get("base") or "tests/fixtures/blank-service.oml"


class Round:
    """Uma rodada: aplica cada job (resolvendo `job:` pelas saidas da propria rodada) e guarda assinatura e tempos."""

    def __init__(self, tag: str, jobs_dir: pathlib.Path, cold: bool) -> None:
        self.tag, self.jobs_dir, self.cold = tag, jobs_dir, cold
        self.outs: dict[str, str] = {}
        self.sigs: dict[str, str] = {}
        self.ms: dict[str, int] = {}
        self.errors: dict[str, str] = {}

    def base_of(self, job: pathlib.Path) -> str:
        b = job_base(job)
        if b.startswith("job:"):
            dep = self.jobs_dir / (b[4:] + ".json")
            if dep.stem not in self.outs:
                self.apply(dep)
            return self.outs[dep.stem]
        return str(ROOT / b) if not pathlib.Path(b).is_absolute() else b

    def apply(self, job: pathlib.Path) -> None:
        if job.stem in self.sigs or job.stem in self.errors:
            return
        base = self.base_of(job)
        out = WORK / self.tag / (job.stem + ".oml")
        out.parent.mkdir(parents=True, exist_ok=True)
        env = anvil_cli.apply(base, str(job), str(out), str(WORK / "work"), cold=self.cold)
        if not env.get("ok") or not (env.get("data") or {}).get("accepted"):
            self.errors[job.stem] = str(env.get("error") or (env.get("data") or {}).get("policyMessages"))[:300]
            self.ms[job.stem] = env.get("wallMs", 0)
            return
        d = env["data"]
        snap = anvil_cli.run(["inspect", "--oml", str(out), "--work", str(WORK / "work")], cold=self.cold)
        s = snap.get("data") or {}
        validation = dict(s.get("Validation") or {})
        validation.pop("Sample", None)  # o Sample cita ObjectKeys ("@ 9UKfT+..."), que sao gerados de novo em cada execucao: nao e resultado, e identidade
        sig = {"ops": d["ops"], "objects": d["objects"], "isValid": d["isValid"], "messages": d["messages"], "details": d.get("details"),
               "validation": validation, "refs": sorted(r.get("Name") or "" for r in (s.get("References") or []))}
        # TopObjectTypes fica FORA da assinatura: e um top-15 por contagem, e o desempate no 15o lugar segue a ordem de travessia,
        # que varia entre execucoes (tambem entre dois processos frios). Objects + validation + details ja cobrem o resultado.
        # refs como CONJUNTO: a ordem em que o Model API enumera as referencias varia entre execucoes (tambem no processo frio) e nao faz parte do resultado
        self.sigs[job.stem] = json.dumps(sig, sort_keys=True)
        self.outs[job.stem] = str(out)
        self.ms[job.stem] = env.get("wallMs", 0)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rounds", type=int, default=10)
    ap.add_argument("--jobs", default="tests/jobs")
    ap.add_argument("--filter", default="")
    args = ap.parse_args()
    jobs_dir = ROOT / args.jobs
    jobs = sorted(p for p in jobs_dir.glob("*.json") if args.filter in p.name)
    if anvil_cli.ping() is None:
        print("worker ausente: python scripts/anvil_worker.py start"); return 2
    step(f"{len(jobs)} jobs; rodada 0 = processo frio, rodadas 1..{args.rounds} = worker pid {anvil_cli.ping()['pid']}")

    cold = Round("cold", jobs_dir, cold=True)
    t0 = time.perf_counter()
    for j in jobs:
        cold.apply(j)
    cold_s = time.perf_counter() - t0
    step(f"rodada 0 (frio): {cold_s:.0f} s, {len(cold.sigs)} ok, {len(cold.errors)} erros {cold.errors if cold.errors else ''}")

    verdict_ok = True
    for r in range(1, args.rounds + 1):
        rd = Round(f"r{r}", jobs_dir, cold=False)
        t0 = time.perf_counter()
        for j in jobs:
            rd.apply(j)
        secs = time.perf_counter() - t0
        diff = [k for k in cold.sigs if rd.sigs.get(k) != cold.sigs[k]]
        errs = {k: v for k, v in rd.errors.items() if k not in cold.errors}
        p = anvil_cli.ping() or {}
        g = (anvil_cli.run(["gc"]).get("data") or {}) if p else {}
        step(f"rodada {r}: {secs:.0f} s ({secs / max(cold_s, 1e-9) * 100:.0f}% do frio), assinaturas diferentes do frio: {len(diff)} {diff[:5]}, erros novos: {len(errs)} {errs}, worker {p.get('workingSetMB')} MB / heap {p.get('gcMB')} MB -> apos GC forcado {g.get('afterMB')} MB (working set {g.get('workingSetMB')} MB) / {p.get('served')} pedidos")
        if diff or errs:
            verdict_ok = False
            for k in diff[:3]:
                print("   frio  :", cold.sigs[k][:600]); print("   worker:", (rd.sigs.get(k) or "")[:600])
    step("VEREDICTO: " + ("DETERMINISTICO, worker aprovado" if verdict_ok else "NAO DETERMINISTICO, worker REPROVADO"))
    slow = sorted(cold.ms.items(), key=lambda kv: -kv[1])[:3]
    step(f"mais lentos no frio: {slow}")
    return 0 if verdict_ok else 1


if __name__ == "__main__":
    sys.exit(main())
