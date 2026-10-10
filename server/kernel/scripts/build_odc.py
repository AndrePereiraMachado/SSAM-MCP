"""Constroi o CLI da faixa ODC sem deixar um worker velho de pe: para o worker, constroi, arranca o worker.

    python scripts/build_odc.py            # -> .local/lane-odc/cli/anvil-odc.dll, worker de pe
    python scripts/build_odc.py --no-start # so parar + construir

Com o worker de pe o build FALHA (as DLLs ficam presas: MSB3027), exatamente como na faixa O11; por isso este e o
unico caminho documentado. O equivalente da faixa O11 e `scripts/build.py`.
"""
from __future__ import annotations

import argparse
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import odc_worker  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--no-start", action="store_true")
    ap.add_argument("--port", type=int, default=odc_worker.PORT)
    a = ap.parse_args()
    out = odc_worker.LOCAL / "cli"
    odc_worker.stop(a.port)
    r = subprocess.run(["dotnet", "build", str(ROOT / "src" / "Anvil.Cli.Odc"), "-c", "Release", "-o", str(out),
                        "-nologo", "-v", "q"], capture_output=True, text=True, encoding="utf-8", errors="replace",
                       cwd=str(ROOT))
    errors = [line for line in (r.stdout + r.stderr).splitlines() if " error " in line or "Erro(s)" in line or "error(s)" in line]
    print("\n".join(errors[-6:]) if errors else f"build ok -> {out}")
    if r.returncode != 0:
        return r.returncode
    if a.no_start:
        return 0
    status = odc_worker.ensure(a.port)
    print(f"worker odc: {'de pe, pid ' + str(status['pid']) if status else 'nao subiu (os jobs rodam frios)'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
