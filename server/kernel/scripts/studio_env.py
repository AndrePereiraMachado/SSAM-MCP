"""Ambiente do Studio da faixa (ANVIL_LANE: ss4 = SS4 porta 4516, ss5 = SS5 porta 4536) pela bridge: ver, trocar de ambiente e abrir um modulo, sem GUI.

  python scripts/studio_env.py status
  python scripts/studio_env.py login --credentials <arquivo .credentials.json> [--open <Modulo>]
  python scripts/studio_env.py open --module <Modulo>

O arquivo de credenciais fica fora do repo (ex.: C:/Users/<eu>/GitSSAM/.ssam/local/<env>.credentials.json) e e lido pelo
Studio, nunca por este script: aqui so se imprimem host e utilizador. O Studio mantem UMA ligacao de cada vez: login num
ambiente substitui o anterior (nenhum modulo do anterior e tocado). Depois de `login` os modulos abertos continuam abertos,
mas pertencem ao ambiente anterior: feche-os ou abra os do novo com --open.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from anvil_client import AnvilBridge  # noqa: E402
import lanes  # noqa: E402
LANE = lanes.lane()


def environment_text(b: AnvilBridge) -> str:
    w = b.ok("windows")
    for win in w.get("windows", []):
        for t in win.get("texts", []):
            if "outsystems" in t.lower() or " - " in t and "." in t:
                return t
    return "?"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["status", "login", "open"])
    ap.add_argument("--credentials", help="arquivo de credenciais (nunca impresso)")
    ap.add_argument("--module", help="modulo a abrir (cmd open)")
    ap.add_argument("--open", help="modulo a abrir depois do login")
    ap.add_argument("--port", type=int, default=LANE.bridge, help="porta da bridge (omissao: a da faixa ANVIL_LANE)")
    ap.add_argument("--timeout", type=int, default=240, help="segundos para open_module")
    args = ap.parse_args()
    b = AnvilBridge(port=args.port, timeout=args.timeout + 60)

    if args.cmd == "status":
        print("ambiente:", environment_text(b))
        mods = b.ok("list_open_modules")
        print("modulos abertos:", [m.get("name") for m in mods.get("modules", [])] or "nenhum")
        try:
            a = b.ok("get_active_module")
            print("ativo:", a["name"], a["kind"], a["counts"])
        except Exception as ex:  # noqa: BLE001
            print("ativo: nenhum (" + str(ex).split(":")[-1].strip() + ")")
        return 0

    if args.cmd == "login":
        if not args.credentials:
            print("login exige --credentials <arquivo>"); return 2
        path = pathlib.Path(args.credentials)
        if not path.exists():
            print(f"arquivo de credenciais nao encontrado: {path}"); return 2
        before = environment_text(b)
        lg = b.ok("login", credentials_file=str(path.resolve()))
        print(f"login: {before} -> host={lg['host']} user={lg['user']} connected={bool(lg.get('connected'))}")
        if args.open:
            o = b.ok("open_module", name=args.open, timeout=args.timeout)
            print("open_module:", o)
        return 0

    if not args.module:
        print("open exige --module <Modulo>"); return 2
    o = b.ok("open_module", name=args.module, timeout=args.timeout)
    print("open_module:", o)
    a = b.ok("get_active_module")
    print("ativo:", a["name"], a["kind"], a["counts"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
