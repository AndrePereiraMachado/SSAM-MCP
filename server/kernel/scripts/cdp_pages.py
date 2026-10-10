"""Le (e opcionalmente clica) o texto visivel de cada pagina web do Studio (ReactView) pelo CDP.

python scripts/cdp_pages.py [--port 9226] [--chars 800]            # lista texto e botoes de cada pagina
python scripts/cdp_pages.py --click Discard                        # clica o primeiro botao/link com esse texto (na primeira pagina que o tiver)

Troubleshooting sem screenshot: os dialogos do Studio sao paginas React; o verbo `windows` do bridge ve a janela mas nao o texto.
Exemplo real (2026-09-04): apos matar o Studio, o arranque mostra o dialogo de recuperacao com botoes "Open | Discard".
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request

import websocket  # websocket-client

BUTTONS_JS = "Array.from(document.querySelectorAll('button, [role=button], a')).map(b => (b.innerText||'').trim()).filter(Boolean).slice(0,15).join(' | ')"
TEXT_JS = "(document.body && document.body.innerText || '').replace(/\\s+/g, ' ').trim()"


def evaluate(ws_url: str, expr: str, timeout: float = 5.0):
    ws = websocket.create_connection(ws_url, timeout=timeout, suppress_origin=True)
    try:
        ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate", "params": {"expression": expr, "returnByValue": True}}))
        while True:
            msg = json.loads(ws.recv())
            if msg.get("id") == 1:
                return (msg.get("result") or {}).get("result", {}).get("value")
    finally:
        ws.close()


def click_js(text: str) -> str:
    safe = json.dumps(text)
    return ("(() => { const t = " + safe + "; const els = Array.from(document.querySelectorAll('button, [role=button], a'));"
            " const el = els.find(b => (b.innerText||'').trim() === t) || els.find(b => (b.innerText||'').trim().includes(t));"
            " if (!el) return 'not found'; el.click(); return 'clicked: ' + (el.innerText||'').trim(); })()")


def main() -> int:
    ap = argparse.ArgumentParser()
    import pathlib, sys
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
    import lanes
    ap.add_argument("--port", type=int, default=lanes.lane().cdp, help="porta CDP (omissao: a da faixa ANVIL_LANE)")
    ap.add_argument("--chars", type=int, default=800)
    ap.add_argument("--click", help="texto do botao a clicar")
    args = ap.parse_args()
    targets = json.load(urllib.request.urlopen(f"http://127.0.0.1:{args.port}/json", timeout=5))
    for i, t in enumerate(targets):
        if t.get("type") != "page" or not t.get("webSocketDebuggerUrl"):
            continue
        try:
            txt = evaluate(t["webSocketDebuggerUrl"], TEXT_JS) or ""
            buttons = evaluate(t["webSocketDebuggerUrl"], BUTTONS_JS) or ""
            if args.click:
                if args.click.lower() in buttons.lower():
                    print(f"[{i}] {evaluate(t['webSocketDebuggerUrl'], click_js(args.click))}")
                    return 0
                continue
        except Exception as ex:  # noqa: BLE001
            print(f"[{i}] error: {ex}")
            continue
        print(f"[{i}] {len(txt)} chars | text: {txt[: args.chars]} | buttons: {buttons}")
    if args.click:
        print(f"no page has a button with text {args.click!r}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
