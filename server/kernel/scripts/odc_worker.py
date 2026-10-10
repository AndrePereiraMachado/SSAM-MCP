"""Cliente do worker residente da faixa ODC (`anvil-odc serve`).

O mesmo protocolo do worker da faixa O11 (`anvil serve`): uma linha JSON
`{"args": [...], "authorization": "<credencial>"}` em 127.0.0.1, uma linha de envelope de volta. A diferenca e o CLI
(`.local/lane-odc/cli/anvil-odc.dll`), a porta (4547) e a pasta de trabalho (`.local/lane-odc`).

Por que existe: sem worker, cada job da faixa ODC paga de novo o carregamento das DLLs do ODC Studio e do modulo
(~4 s num modulo de 59 mil objetos, 14 s no total). Com o worker, paga uma vez por processo.

Uso: `run(["apply", "--job", ..., "--out", ...])`. Se o worker nao estiver de pe, `ensure()` o levanta; se nem assim,
quem chama roda o processo frio (o resultado e o mesmo, so mais lento).
"""
from __future__ import annotations

import json
import os
import pathlib
import socket
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import anvil_authority  # noqa: E402
import worker_process  # noqa: E402

_workspace_file = ROOT.parent / '.ssam-workspace.json'
_default_port = json.loads(_workspace_file.read_text(encoding='utf-8'))['workers']['odc'] if _workspace_file.is_file() else 4547
PORT = int(os.environ.get("ANVIL_ODC_PORT", str(_default_port)))
LOCAL = ROOT / ".local" / "lane-odc"
CLI = LOCAL / "cli" / "anvil-odc.dll"


def _credential() -> str | None:
    try:
        return anvil_authority.key_path().read_text(encoding="ascii").strip()
    except (FileNotFoundError, PermissionError, ValueError):
        return None


def call(argv: list[str], port: int = PORT, timeout: float = 600.0) -> dict:
    """Um pedido, uma resposta. Lanca OSError quando o worker nao atende."""
    with socket.create_connection(("127.0.0.1", port), timeout=timeout) as s:
        s.settimeout(timeout)
        s.sendall((json.dumps({"args": [str(a) for a in argv], "authorization": _credential()}) + "\n").encode("utf-8"))
        data = b""
        while b"\n" not in data:
            chunk = s.recv(1 << 20)
            if not chunk:
                raise ConnectionError("o worker fechou a ligacao")
            data += chunk
    return json.loads(data.split(b"\n", 1)[0].decode("utf-8"))


def ping(port: int = PORT, timeout: float = 3.0) -> dict | None:
    try:
        return call(["ping"], port=port, timeout=timeout).get("data")
    except (OSError, ValueError):
        return None


def launch(port: int = PORT) -> subprocess.Popen | None:
    """Sobe o worker desligado do console, com o log em .local/lane-odc."""
    if not CLI.is_file():
        return None
    LOCAL.mkdir(parents=True, exist_ok=True)
    flags = subprocess.CREATE_NO_WINDOW | subprocess.DETACHED_PROCESS if os.name == "nt" else 0
    return subprocess.Popen(
        ["dotnet", str(CLI), "serve", "--port", str(port), "--log-dir", str(LOCAL)],
        cwd=str(ROOT), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=flags if os.name == "nt" else 0,
    )


def ensure(port: int = PORT, wait: float = 90) -> dict | None:
    """Worker de pe, ou None quando nao da (quem chama roda frio). O ODC Studio nao precisa estar aberto."""
    status = ping(port)
    if status:
        return status
    if not CLI.is_file():
        return None
    with worker_process.startup_lock(LOCAL, port, wait):
        status = ping(port)
        if status:
            return status
        launch(port)
        deadline = time.monotonic() + wait
        while time.monotonic() < deadline:
            status = ping(port, timeout=1.0)
            if status:
                return status
            time.sleep(0.5)
    return None


def stop(port: int = PORT) -> dict | None:
    try:
        return call(["shutdown"], port=port, timeout=30)
    except (OSError, ValueError):
        return None


def run(argv: list[str], port: int = PORT) -> dict | None:
    """O envelope do worker, ou None quando ele nao esta disponivel."""
    if ensure(port) is None:
        return None
    try:
        return call(argv, port=port)
    except (OSError, ValueError):
        return None


if __name__ == "__main__":
    comando = sys.argv[1] if len(sys.argv) > 1 else "ping"
    if comando == "stop":
        print(json.dumps(stop(), ensure_ascii=False, indent=2))
    elif comando == "ensure":
        print(json.dumps(ensure(), ensure_ascii=False, indent=2))
    else:
        print(json.dumps(call(sys.argv[1:] or ["ping"]), ensure_ascii=False, indent=2))
