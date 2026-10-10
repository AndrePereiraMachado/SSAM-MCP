"""Constroi o CLI da FAIXA sem deixar um worker velho de pe: para o worker, `dotnet build -o <cli da faixa>`, arranca o worker.

    python scripts/build.py            # faixa de ANVIL_LANE (ss4 -> .local/cli, ss5 -> .local/lane-ss5/cli)
    python scripts/build.py --no-start # so parar + construir

Com o worker de pe o build FALHA (DLLs bloqueadas), por isso o unico caminho documentado e este (plano, item 01a).
"""
from __future__ import annotations

import argparse
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import anvil_cli  # noqa: E402
import anvil_worker  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--no-start", action="store_true")
    ap.add_argument("--port", type=int, default=anvil_cli.PORT)
    a = ap.parse_args()
    lane = anvil_cli.LANE
    out = lane.local / "cli"
    anvil_worker.stop(a.port)
    r = subprocess.run(["dotnet", "build", str(ROOT / "src" / "Anvil.Cli"), "-c", "Release", "-o", str(out), "-nologo", "-v", "q"], capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=str(ROOT))
    errors = [line for line in (r.stdout + r.stderr).splitlines() if " error " in line or "Erro(s)" in line or "error(s)" in line]
    print("\n".join(errors[-6:]) if errors else f"build ok -> {out}")
    if r.returncode != 0:
        return r.returncode
    if a.no_start:
        return 0
    return anvil_worker.start(a.port)


if __name__ == "__main__":
    sys.exit(main())
