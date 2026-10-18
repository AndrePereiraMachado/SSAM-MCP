"""Worker residente do CLI anvil (item 5): start | stop | status | restart [--port N] (omissao: o worker da faixa ANVIL_LANE, 4517 na ss4, 4537 na ss5).

O worker e `dotnet .local/cli/anvil.dll serve --port N` desanexado; `scripts/anvil_cli.run` usa-o sozinho quando esta de pe.
Poupa o arranque do processo (.NET + assemblies do Studio + JIT) em cada apply. Depois de `dotnet build ... -o .local/cli`
faca `restart`, senao o worker continua com o binario antigo. Log: .local/worker-<porta>.log.
"""
from __future__ import annotations

import argparse
import pathlib
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import anvil_cli  # noqa: E402

DETACHED_PROCESS = 0x00000008
CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_NO_WINDOW = 0x08000000


def start(port: int, wait: int = 25) -> int:
    status = anvil_cli.ensure_worker(port, wait)
    if not status:
        print("Studio unavailable; commands will use the cold path")
        return 1
    print(f"worker de pe na porta {port}: pid {status['pid']}, busy={status.get('busy')}, queued={status.get('queued')}, log worker-{port}-{status['pid']}.log")
    return 0


def _wait_exit(pid: int, birth: str, seconds: float) -> bool:
    """True quando o processo com aquele horario de criacao ja nao existe (saiu, ou o pid e de outro processo)."""
    deadline = time.monotonic() + seconds
    while anvil_cli.worker_process.birth(pid) == birth:
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.1)
    return True


def stop(port: int, wait: float = 10, exit_wait: float = 10) -> int:
    """Para o worker da porta. O ping diz o pid; o horario de criacao desse pid e lido ANTES do shutdown. Se o worker
    aceitou o shutdown e o mesmo processo (mesmo pid, mesmo horario de criacao) segue vivo depois de `wait` segundos,
    aquele pid e encerrado (worker_process.terminate_known confere o horario de novo) e a saida e esperada. Um pid cujo
    horario mudou e de outro processo e nunca e tocado."""
    status = anvil_cli.ping(port)
    if status is None:
        print(f"nenhum worker na porta {port}"); return 0
    pid = int(status["pid"])
    birth = anvil_cli.worker_process.birth(pid)
    env = anvil_cli._request(["shutdown"], port, 900)
    if env.get("ok") is not True:
        raise RuntimeError(f"worker na porta {port} recusou o shutdown: {env.get('error')}; nada foi parado")
    if birth is not None and not _wait_exit(pid, birth, wait):
        # Aceitou o shutdown e segue vivo: o mesmo processo que o ping nomeou para esta porta.
        anvil_cli.worker_process.terminate_known(pid, birth)
        if not _wait_exit(pid, birth, exit_wait):
            raise TimeoutError(f"worker pid {pid} accepted the shutdown, was ended and has not exited yet; the build has to wait")
        print(f"worker ended: pid {pid} accepted the shutdown and was still alive after {wait:g} s"); return 0
    print(f"worker parado: {env.get('data')}"); return 0


def status(port: int) -> int:
    p = anvil_cli.ping(port)
    if p is None:
        print(f"worker: ausente (porta {port}); o proximo comando faz auto-arranque"); return 1
    print(f"worker: pid {p['pid']}, working set {p['workingSetMB']} MB, GC {p['gcMB']} MB, {p['served']} pedidos, studio {p.get('studio')}, busy={p.get('busy')}, queued={p.get('queued')}, commands={p.get('commands')}"); return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["start", "stop", "status", "restart"])
    ap.add_argument("--port", type=int, default=anvil_cli.PORT)
    a = ap.parse_args()
    if a.cmd == "start": return start(a.port)
    if a.cmd == "stop": return stop(a.port)
    if a.cmd == "status": return status(a.port)
    stop(a.port); time.sleep(1); return start(a.port)


if __name__ == "__main__":
    sys.exit(main())
