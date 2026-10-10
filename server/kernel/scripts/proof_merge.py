"""Compatibility proof wrapper around `anvil deliver`. Delivery itself never publishes.
Use --publish only for laboratory modules; --login and --flow remain proof conveniences.
"""
from __future__ import annotations
import argparse
import pathlib
import time
from datetime import datetime
from anvil_client import AnvilBridge
import anvil_cli
import lanes
LANE = lanes.lane()


def step(message: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] {message}", flush=True)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--job", required=True)
    ap.add_argument("--module", required=True)
    ap.add_argument("--producer", action="append", default=[])
    ap.add_argument("--port", type=int, default=LANE.bridge)
    ap.add_argument("--checks", default="")
    ap.add_argument("--flow", default="")
    ap.add_argument("--login")
    ap.add_argument("--publish", action="store_true", help="publish after successful delivery (laboratory modules only)")
    args = ap.parse_args()
    bridge = AnvilBridge(port=args.port)
    if args.login:
        login = bridge.ok("login", credentials_file=str(pathlib.Path(args.login).resolve()))
        step(f"login: host={login['host']} connected={login['connected']}")
    argv = ["deliver", "--module", args.module, "--job", str(pathlib.Path(args.job).resolve()),
        "--port", str(args.port), "--checks", args.checks, "--work", str(LANE.work)]
    for producer in args.producer:
        name, sep, path = producer.partition("=")
        argv += ["--producer", name + sep + str(pathlib.Path(path).resolve()) if sep and path else producer]
    env = anvil_cli.run(argv)
    data = env.get("data") or {}
    validation = data.get("validation") or {}
    if validation:
        step(f"TrueChange: novas={len(validation.get('new', []))} corrigidas={len(validation.get('fixed', []))} pre-existentes={len(validation.get('preexisting', []))} novos-erros={validation.get('newErrors')}")
        for message in validation.get("new", []):
            step(f"  nova {message['type']} {message['id']}: {message['detail']} @ {message['path']}")
    step(f"deliver via {env.get('via')}: stage={data.get('stage')} delivered={data.get('delivered')} elapsedMs={data.get('elapsedMs')}")
    if data.get("work"):
        step("prova: " + str(pathlib.Path(data['work']) / "result.json"))
    if proof := data.get("dataProof"):
        step(f"data proof: {proof.get('count')} declared properties, accepted={proof.get('accepted')}")
    if data.get("sources"):
        step(f"receipt: {len(data['sources'])} source files hashed; check-delivery --result {pathlib.Path(data['work']) / 'result.json'}")
    if inventory := (data.get("apply") or {}).get("preflight"):
        if inventory.get("actions"):
            step(f"logic declarations: {inventory['actions']} total, {inventory['publicActions']} public, {inventory['helpers']} helpers, {len(inventory.get('alwaysRaises', []))} always-raising endpoints")
            if inventory.get("alwaysRaises"):
                step("not completed integrations: " + ", ".join(inventory["alwaysRaises"]))
    if not env.get("ok") or not data.get("delivered"):
        step("ABORT: " + str(data.get("error") or env.get("error") or "delivery failed"))
        return 1
    for check in data.get("checks", []):
        step(f"find {check.get('query')}: {check.get('count')} found")
    if args.flow:
        nodes = bridge.ok("get_flow_nodes", name=args.flow)
        step(f"flow {args.flow}: {nodes['count']} nodes")
    if args.publish:
        step("publish: " + str(bridge.ok("publish", message="Anvil delivery proof " + time.strftime("%H%M%S"),
            module_key=data.get("moduleKey"), environment=data.get("environment"), timeout=600)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
