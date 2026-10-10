"""Faixas (lanes): uma instancia do Studio + bridge + CDP + worker + pastas de trabalho por SESSAO.

    ANVIL_LANE=ss4 (omissao) | ss5

| Faixa | Bridge | CDP  | Worker | Instalacao do Studio                          | Pastas          |
|-------|--------|------|--------|-----------------------------------------------|-----------------|
| ss4   | 4516   | 9226 | 4517   | %USERPROFILE%\\OutSystems\\Service Studio 11 - Anvil 4516 | .local/          |
| ss5   | 4536   | 9246 | 4537   | %USERPROFILE%\\OutSystems\\Service Studio 11 - Anvil 4536 | .local/lane-ss5/ |

Duas sessoes (duas LLMs, ou uma LLM e um humano) trabalham em paralelo, UMA POR FAIXA: cada faixa tem o seu Studio (um modulo
ativo de cada vez), a sua bridge, o seu worker, o seu build do CLI e as suas pastas de jobs/provas/produtores. O que e partilhado
e so o repositorio (codigo, jobs, fixtures) e o ambiente OutSystems. Reconstruir o CLI ou reiniciar o worker numa faixa nao toca na outra.

Todos os scripts (`anvil_cli`, `anvil_worker`, `run_job`, `proof_merge`, `proof_cycles`, `studio_env`, `cdp_pages`, `worker_soak`)
leem a faixa de `ANVIL_LANE`; `scripts/open_studio.ps1 -Lane ss5` clona a instalacao do Studio (uma vez), injeta a bridge e abre.
`python scripts/lanes.py [ss5] --json` imprime a faixa (usado pelo PowerShell).

O Studio da faixa e UMA selecao, a mesma da fachada (anvil-cli.mjs laneEnvironment, que o worker usa em anvil-worker.mjs
workerTarget): primeiro o registro de conexao que o ssam_connect grava (`.local/connections/<faixa>.json`, com studioDir e
authorityDir do Studio aberto), depois ANVIL_STUDIO_DIR, depois a copia "Anvil {bridge}" da faixa. Um registro invalido e
ignorado, como na fachada.
"""
from __future__ import annotations

import json
import os
import pathlib
import sys
from dataclasses import dataclass

ROOT = pathlib.Path(__file__).resolve().parents[1]
BASE_STUDIO = pathlib.Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "OutSystems" / "Service Studio 11" / "Service Studio"
TABLE = {
    "ss4": (4516, 9226, 4517, ".local"),
    "ss5": (4536, 9246, 4537, ".local/lane-ss5"),
}
_workspace_file = ROOT.parent / '.ssam-workspace.json'
if _workspace_file.is_file():
    _workers = json.loads(_workspace_file.read_text(encoding='utf-8'))['workers']
    TABLE = {name: (bridge, cdp, _workers['o11' + name], local)
             for name, (bridge, cdp, worker, local) in TABLE.items()}


def connection(name: str, root: pathlib.Path = ROOT) -> dict | None:
    """O registro de conexao do Studio selecionado na faixa (studio-session.mjs readConnection), ou None quando nao ha
    registro ou ele nao e valido. Lido a cada uso: um novo ssam_connect vale para o proximo comando."""
    try:
        record = json.loads((root / ".local" / "connections" / f"{name}.json").read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return None
    pid = record.get("pid") if isinstance(record, dict) else None
    if (not isinstance(record, dict) or record.get("ok") is not True or record.get("lane") != "o11" or record.get("anvilLane") != name
            or not isinstance(pid, int) or isinstance(pid, bool) or not isinstance(record.get("startedUtc"), str)
            or not all(isinstance(record.get(k), str) and os.path.isabs(record[k]) for k in ("studioDir", "authorityDir"))):
        return None
    return record


@dataclass(frozen=True)
class Lane:
    name: str
    bridge: int
    cdp: int
    worker: int
    local: pathlib.Path

    @property
    def connection(self) -> dict | None:
        return connection(self.name)

    @property
    def selection(self) -> str:
        """De onde vem o Studio da faixa: "connection" | "ANVIL_STUDIO_DIR" | "lane"."""
        return "connection" if self.connection else "ANVIL_STUDIO_DIR" if os.environ.get("ANVIL_STUDIO_DIR") else "lane"

    @property
    def studio_dir(self) -> pathlib.Path:
        record = self.connection
        if record:
            return pathlib.Path(record["studioDir"])
        configured = os.environ.get("ANVIL_STUDIO_DIR")
        if configured:
            return pathlib.Path(configured)
        home = pathlib.Path(os.environ.get("USERPROFILE") or pathlib.Path.home())
        return home / "OutSystems" / f"Service Studio 11 - Anvil {self.bridge}" / "Service Studio"

    @property
    def cli(self) -> pathlib.Path:
        for c in (self.local / "cli" / "anvil.dll", ROOT / ".local" / "cli" / "anvil.dll"):
            if c.exists():
                return c
        return ROOT / "src" / "Anvil.Cli" / "bin" / "Release" / "net8.0" / "anvil.dll"

    @property
    def jobs(self) -> pathlib.Path: return self.local / "jobs"

    @property
    def proofs(self) -> pathlib.Path: return self.local / "proofs"

    @property
    def work(self) -> pathlib.Path: return self.local / "work"

    @property
    def soak(self) -> pathlib.Path: return self.local / "soak"

    @property
    def bridge_log(self) -> pathlib.Path:
        return pathlib.Path(os.environ.get("LOCALAPPDATA", str(pathlib.Path.home()))) / "Anvil" / f"bridge-{self.bridge}.log"

    def env(self) -> dict:
        """Ambiente para processos filhos: a faixa e o Studio selecionado. Com registro de conexao, o Studio, a autoridade e
        a porta da bridge dele (como laneEnvironment na fachada); sem registro, ANVIL_STUDIO_DIR, ou a instalacao da faixa
        se ela existir."""
        e = dict(os.environ)
        e["ANVIL_LANE"] = self.name
        record = self.connection
        if record:
            e["ANVIL_STUDIO_DIR"] = record["studioDir"]
            e["ANVIL_AUTHORITY_DIR"] = record["authorityDir"]
            port = record.get("port")
            if isinstance(port, int) and not isinstance(port, bool) and "ANVIL_BRIDGE_PORT" not in e:
                e["ANVIL_BRIDGE_PORT"] = str(port)
        elif "ANVIL_STUDIO_DIR" not in e and self.studio_dir.exists():
            e["ANVIL_STUDIO_DIR"] = str(self.studio_dir)
        return e

    def as_dict(self) -> dict:
        return {"name": self.name, "bridge": self.bridge, "cdp": self.cdp, "worker": self.worker, "local": str(self.local),
                "studioDir": str(self.studio_dir), "studioExists": self.studio_dir.exists(), "baseStudio": str(BASE_STUDIO),
                "cli": str(self.cli), "bridgeLog": str(self.bridge_log), "selection": self.selection}


def lane(name: str | None = None) -> Lane:
    n = (name or os.environ.get("ANVIL_LANE") or "ss4").strip().lower()
    if n not in TABLE:
        raise SystemExit(f"ANVIL_LANE desconhecida: {n!r}; faixas: {', '.join(TABLE)}")
    bridge, cdp, worker, local = TABLE[n]
    ln = Lane(n, bridge, cdp, worker, ROOT / local)
    return ln


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    ln = lane(args[0] if args else None)
    if "--json" in sys.argv:
        print(json.dumps(ln.as_dict()))
    else:
        d = ln.as_dict()
        for k, v in d.items():
            print(f"{k}: {v}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
