#!/bin/bash
# The SSAM agent on this Mac (the macOS counterpart of agent/ssam-agent.ps1; docs/AGENTE-MAC.md).
#   ~/SSAM-Agent/agent/ssam-agent.sh start       starts in the background and waits for the connection (up to 30 s)
#   ~/SSAM-Agent/agent/ssam-agent.sh status
#   ~/SSAM-Agent/agent/ssam-agent.sh stop        clean stop: tells the server and exits
#   ~/SSAM-Agent/agent/ssam-agent.sh doctor [--json]
#   ~/SSAM-Agent/agent/ssam-agent.sh uninstall   removes what the pack and install.sh put in the folder
# A node process in the background: no launchd job, no administrator, nothing starts by itself (as on Windows). Only an
# OUTBOUND connection to the server; no port is opened here. The pid, the state and the log stay in private/ (only this
# user reads it). Corporate proxy: HTTPS_PROXY (node starts with --use-env-proxy); corporate CA: --use-system-ca.
# Written for the bash 3.2 of macOS.
set -u

HERE="$(cd "$(dirname "$0")" && pwd -P)"
ROOT="$(dirname "$HERE")"

# A Node 24 with both options answers the word below (any other program, or another Node, does not); install.sh uses the
# same check.
node_ok() {
  [ -n "$1" ] && [ -x "$1" ] || return 1
  [ "$("$1" -e 'const major = Number(process.versions.node.split(".")[0]); const flags = process.allowedNodeEnvironmentFlags; process.stdout.write(major === 24 && flags.has("--use-env-proxy") && flags.has("--use-system-ca") ? "ssam-node-24" : "no")' 2>/dev/null)" = "ssam-node-24" ]
}
# SSAM_NODE, the Node install.sh chose (private/node), the Node it downloaded (agent/node/node), else the node on the
# PATH: the first one that is a Node 24 (a new Terminal may put another node first on the PATH).
find_node() {
  RECORDED=""
  if [ -f "$ROOT/private/node" ]; then IFS= read -r RECORDED < "$ROOT/private/node" || true; fi
  for candidate in "${SSAM_NODE:-}" "$RECORDED" "$HERE/node/node" "$(command -v node 2>/dev/null)"; do
    if node_ok "$candidate"; then printf '%s\n' "$candidate"; return 0; fi
  done
  return 1
}

usage() {
  echo "Usage: $0 start|status|stop|doctor [--json]|uninstall"
}

ACTION="${1:-}"
case "$ACTION" in
  start|stop|status|uninstall|doctor) ;;
  *) usage; exit 1 ;;
esac
shift

NODE="$(find_node)" || { echo "No Node 24 with --use-env-proxy and --use-system-ca found (SSAM_NODE, private/node, agent/node/node, the PATH): run install.sh again (docs/AGENTE-MAC.md), or set SSAM_NODE to a Node 24."; exit 1; }

if [ "$ACTION" = "doctor" ]; then
  exec "$NODE" --use-env-proxy --use-system-ca "$HERE/ssam-agent.mjs" doctor --root "$ROOT" "$@"
fi
if [ "$#" -gt 0 ]; then usage; exit 1; fi
exec "$NODE" "$HERE/lib/launcher.mjs" "$ACTION" --root "$ROOT"
