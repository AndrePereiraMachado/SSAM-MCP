"""CLI client with a resident worker: auto-start, serialized command queue, responsive ping and explicit recycling.
ANVIL_WORKER=0 (or cold=True) selects a cold process. The result preserves the CLI envelope plus via/wallMs;
queuedMs comes from the worker. Only requests known not to have executed are retried.
"""
from __future__ import annotations

import json
import os
import pathlib
import socket
import subprocess
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
import sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import lanes  # noqa: E402
import worker_process  # noqa: E402
import threading
_STATE_LOCK = threading.Lock()
LANE = lanes.lane()
CLI = LANE.cli
PORT = int(os.environ.get("ANVIL_WORKER_PORT", str(LANE.worker)))


def _request(argv: list[str], port: int, timeout: float) -> dict:
    with socket.create_connection(("127.0.0.1", port), timeout=timeout) as s:
        from anvil_authority import key_path
        credential_file = key_path()
        try:
            credential = credential_file.read_text(encoding="ascii").strip()
        except (FileNotFoundError, PermissionError):
            credential = None
        s.sendall((json.dumps({"args": [str(a) for a in argv], "authorization": credential}) + "\n").encode("utf-8"))
        data = b""
        while b"\n" not in data:
            chunk = s.recv(1 << 20)
            if not chunk:
                raise ConnectionError("worker fechou a ligacao")
            data += chunk
    return json.loads(data.split(b"\n", 1)[0].decode("utf-8"))


def ping(port: int = PORT, timeout: float = 3.0) -> dict | None:
    """Worker status (busy/currentCommand/runningMs/queued/commands/served) or None when ping cannot complete."""
    try:
        env = _request(["ping"], port, timeout)
        status = env.get("data") if env.get("ok") else None
        if status:
            try:
                with _STATE_LOCK:
                    worker_process.remember(LANE.local, port, status)
            except OSError:
                pass  # A state-file race must not turn a successful ping into a hung worker.
        return status
    except (OSError, ValueError):
        return None


def worker_alive(port: int = PORT) -> bool:
    return os.environ.get("ANVIL_WORKER", "1") != "0" and ping(port) is not None


_EPOCH_FILETIME = 11644473600  # segundos entre 1601-01-01 (a era do FILETIME) e 1970-01-01 (a era do Unix)


def _nascimento_unix(pid: int) -> float | None:
    """Arranque do processo em segundos Unix, ou None quando nao se consegue saber. Em Linux o birth() devolve
    jiffies desde o arranque da maquina, que nao se comparam com um mtime sem ler /proc/stat -- fica por saber."""
    raw = worker_process.birth(pid)
    if raw is None or os.name != "nt":
        return None
    try:
        return int(raw) / 1e7 - _EPOCH_FILETIME
    except ValueError:
        return None


def _kernel_mais_novo_que(status: dict) -> bool:
    """O worker carrega o kernel UMA vez, ao arrancar; recompilar o dll depois disso nao o alcanca, e ele passa a
    servir codigo velho sem que nada o denuncie. Custou um diagnostico errado em 2026-09-17: o mesmo job deu verde
    num worker de onze horas antes e vermelho no teste com binarios frescos, e eu acusei o teste. Perder um
    arranque vale menos do que devolver uma prova falsa. Best-effort de ponta a ponta: na duvida, nao mexe."""
    try:
        pid = status.get("pid")
        if not pid or not CLI.is_file():
            return False
        nascimento = _nascimento_unix(int(pid))
        return nascimento is not None and CLI.stat().st_mtime > nascimento + 1.0
    except (OSError, TypeError, ValueError):
        return False


_AVISADO_DEPLOY = False


def avisar_se_o_deploy_esta_velho() -> None:
    """O worker corre o CLI de .local/cli, que SO o build.py actualiza. Compilar com `dotnet build src/...` nao
    chega la: o `dotnet test` passa a ver o codigo novo e o run_job.py continua a ver o velho, e os dois
    discordam sem que nada o diga.

    Custou dois diagnosticos errados em 2026-09-17. De manha dei um job por consertado porque passou no worker;
    a noite dei uma falha do `rename` por minha quando era do contrato de dados -- nas duas vezes o .local/cli
    era de 11:38 e eu estava a comparar codigo de horas diferentes. Compara-se o .cs mais novo com o binario
    implantado, que e o sinal directo do erro; um aviso chega, porque compilar por conta propria a meio do
    trabalho de outrem seria pior do que o problema."""
    global _AVISADO_DEPLOY
    if _AVISADO_DEPLOY:
        return
    try:
        if not CLI.is_file():
            return
        # O mais novo da PASTA, nao o anvil.dll: o MSBuild nao reescreve o assembly de entrada quando so o
        # Anvil.Core muda, e comparar com ele daria alarme falso a cada deploy. Um guarda que grita a toa
        # ensina a ignora-lo, que e pior do que nao existir.
        implantado = max((p.stat().st_mtime for p in CLI.parent.glob("*.dll")), default=0.0)
        if implantado == 0.0:
            return
        fontes = (ROOT / "src").rglob("*.cs")
        mais_nova = max(((p.stat().st_mtime, p) for p in fontes if "/obj/" not in p.as_posix()
                         and "/bin/" not in p.as_posix()), default=None)
        if mais_nova and mais_nova[0] > implantado + 1.0:
            _AVISADO_DEPLOY = True
            atraso = (mais_nova[0] - implantado) / 60
            print(f"AVISO: {CLI.parent} tem {atraso:.0f} min de atraso em relacao ao codigo-fonte "
                  f"({mais_nova[1].relative_to(ROOT).as_posix()} e mais novo). O worker vai correr o kernel "
                  f"ANTIGO e o `dotnet test` corre o novo -- se discordarem, e por isto. Corra "
                  f"scripts/build.py antes de tirar conclusoes.", file=sys.stderr)
    except (OSError, ValueError):
        pass  # um aviso que falha nunca pode derrubar trabalho


def _worker_matches_studio(status: dict) -> bool:
    selected = os.environ.get("ANVIL_STUDIO_DIR")
    if not selected:
        return True
    actual = status.get("studio")
    return bool(actual) and os.path.normcase(os.path.abspath(actual)) == os.path.normcase(os.path.abspath(selected))


def ensure_worker(port: int = PORT, wait: float = 25) -> dict | None:
    avisar_se_o_deploy_esta_velho()
    status = ping(port)
    if status and not _worker_matches_studio(status):
        return None  # Run cold against the selected installation; never restart somebody else's worker.
    if status and not status.get("recycling"):
        if not _kernel_mais_novo_que(status):
            return status
        if status.get("busy") or status.get("queued"):
            # Numa piscina, matar um worker ocupado derruba o job de outrem para arrumar o nosso. Avisa-se e
            # serve-se; quem le o aviso decide.
            print(f"aviso: o worker da porta {port} carregou um kernel anterior ao {CLI.name} que esta em disco, "
                  "e esta ocupado; recicle-o (scripts/anvil_worker.py restart) antes de confiar no resultado",
                  file=sys.stderr)
            return status
        try:
            _request(["shutdown"], port, 900)
        except (OSError, ValueError):
            pass  # ja morreu, ou nunca respondeu: o caminho de baixo trata de ambos
        limite = time.monotonic() + 10
        while time.monotonic() < limite and ping(port, timeout=0.5) is not None:
            time.sleep(0.1)
        status = None
    studio = pathlib.Path(LANE.env().get("ANVIL_STUDIO_DIR", str(LANE.studio_dir)))
    if not (studio / "ServiceStudio.Framework.dll").is_file():
        return None  # run cold, with its exact installation error
    with worker_process.startup_lock(LANE.local, port, wait):
        status = ping(port)
        if status and not _worker_matches_studio(status):
            return None
        if status and not status.get("recycling"):
            return status
        if status and status.get("recycling"):
            deadline = time.monotonic() + wait
            while status and time.monotonic() < deadline:
                time.sleep(0.1)
                status = ping(port)
            if status:
                raise TimeoutError("worker did not finish recycling")
        else:
            # Only a process recorded by a successful protocol ping, with the same creation identity, can be killed.
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                    listening = True
            except ConnectionRefusedError:
                listening = False
            except OSError:
                listening = True
            if listening:
                worker_process.recover_unresponsive(LANE.local, port)
        proc = worker_process.launch(CLI, LANE.local, port, ROOT, LANE.env())
        deadline = time.monotonic() + wait
        while time.monotonic() < deadline:
            status = ping(port, timeout=0.5)
            if status:
                return status  # another starter winning the port is also success
            if proc.poll() is not None:
                status = ping(port)
                if status:
                    return status
                raise RuntimeError(f"worker startup failed (exit {proc.returncode}); see {LANE.local / f'worker-{port}-startup.log'}")
            time.sleep(0.1)
        raise TimeoutError(f"worker did not start within {wait} s")


def ensure(port: int = PORT, wait: float = 90) -> dict | None:
    """Worker pool interface (scripts/worker_pool.py), the same contract as odc_worker.ensure: the worker on this
    port is up, or None when it cannot start (the caller runs cold)."""
    return ensure_worker(port, wait)


def stop(port: int = PORT) -> dict | None:
    """Worker pool interface: shut down only the worker on this port. None when nothing answered."""
    try:
        return _request(["shutdown"], port, 30)
    except (OSError, ValueError):
        return None


def run(argv: list[str], timeout: float = 900, cold: bool = False, port: int = PORT) -> dict:
    t0 = time.perf_counter()
    use_worker = not cold and os.environ.get("ANVIL_WORKER", "1") != "0"
    status = ensure_worker(port) if use_worker else None
    if status:
        for attempt in range(3):
            try:
                env = _request(argv, port, timeout)
            except ConnectionRefusedError:
                # Connect failed before any command bytes were sent: safe to restart and retry.
                if attempt == 2:
                    raise
                ensure_worker(port)
                continue
            except (OSError, ConnectionError) as ex:
                raise RuntimeError("worker connection failed after submission; execution outcome is unknown, command was not replayed") from ex
            if not (env.get("retryable") is True and env.get("executed") is False):
                break
            if attempt == 2:
                raise RuntimeError("worker kept recycling before executing the request")
            ensure_worker(port)
        env["via"] = "worker"
    else:
        p = subprocess.run(["dotnet", str(CLI), *[str(a) for a in argv]], capture_output=True, text=True, timeout=timeout, cwd=str(ROOT), env=LANE.env())
        try:
            env = json.loads(p.stdout)
        except json.JSONDecodeError:
            env = {"ok": False, "command": argv[0] if argv else "?", "error": (p.stdout[-800:] + "\n" + p.stderr[-800:]).strip()}
        env["via"] = "process"
        env["stderr"] = p.stderr[-4000:]
    env["wallMs"] = int((time.perf_counter() - t0) * 1000)
    return env


def apply(base: str | None = None, job: str | None = None, out: str | None = None,
          work: str | None = None, producers: list[str] | None = None, **kw) -> dict:
    if not job or not out:
        raise ValueError("apply requires job and out")
    argv = ["apply", "--job", str(pathlib.Path(job).resolve()), "--out", str(pathlib.Path(out).resolve()),
            "--work", str(pathlib.Path(work).resolve()) if work else str(LANE.work)]
    if base is not None:
        argv += ["--base", str(pathlib.Path(base).resolve())]
    for producer in producers or []:
        name, sep, path = producer.partition("=")
        argv += ["--producer", name + sep + str(pathlib.Path(path).resolve()) if sep and path else producer]
    return run(argv, **kw)
