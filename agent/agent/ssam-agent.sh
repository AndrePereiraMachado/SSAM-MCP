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

# The node of the installer (agent/node/node), SSAM_NODE, or the node on the PATH.
find_node() {
  for candidate in "$HERE/node/node" "${SSAM_NODE:-}"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then printf '%s\n' "$candidate"; return 0; fi
  done
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
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

NODE="$(find_node)" || { echo "Node not found: run install.sh again (docs/AGENTE-MAC.md) or set SSAM_NODE."; exit 1; }

if [ "$ACTION" = "doctor" ]; then
  exec "$NODE" --use-env-proxy --use-system-ca "$HERE/ssam-agent.mjs" doctor --root "$ROOT" "$@"
fi
if [ "$#" -gt 0 ]; then usage; exit 1; fi
exec "$NODE" "$HERE/lib/launcher.mjs" "$ACTION" --root "$ROOT"
