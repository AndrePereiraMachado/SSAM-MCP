#!/bin/sh
# Linux proof of the ssam-server image on a clean machine (WSL Ubuntu 24.04), from the official installers or studio bundles.
#
#   sh docker/ssam-server/prova-linux.sh [--installers <dir>] [--keep] [--no-install]
#
#  1. Docker Engine, buildx and compose v2 from Ubuntu (docker.io, docker-buildx, docker-compose-v2), unless present;
#  2. per Studio, the official installer, else a studio bundle (from --installers or docker/installers), else a bundle
#     packed now from the Windows install (/mnt/c/Program Files/OutSystems/...) with studio-bundle.sh, staged in
#     ~/ssam-prova/installers and passed as the installers context;
#  3. docker compose build + up of ssam-server only (project ssam-prova, its own volumes; no tunnel, no ngrok secret);
#  4. health check (/health and the container HEALTHCHECK);
#  5. offline kernel calls per lane inside the container, on the repository fixtures (nothing leaves the container):
#     O11 anvil verify-catalog + apply smoke-data-logic; ODC anvil-odc verify-catalog + apply workflow-nodes;
#     ODC3.Builder list + inspect of the anonymized ODC lane fixture;
#  6. an MCP token issued with the ssam-admin profile (customer prova-linux, 1 day; the token is never printed), then
#     over HTTP /mcp, per lane, ssam_reference {kind:"api"} and ssam_discover (server tools, read-only, no agent);
#  7. the token revoked; with --keep the containers stay up, otherwise `compose down` (the volumes stay).
# Exit code 0 when every step passed. Run it from the repository root or from anywhere (it finds the root).
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
INSTALLERS=/mnt/c/Users/$(whoami)/Downloads
KEEP=0 INSTALL=1
while [ $# -gt 0 ]; do
  case "$1" in
    --installers) INSTALLERS=$2; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --no-install) INSTALL=0; shift ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
O11_INSTALLER=${SERVICE_STUDIO_INSTALLER:-ServiceStudio-11.55.91.65258.exe}
ODC_INSTALLER=${ODC_STUDIO_INSTALLER:-ODCStudio-1.7.27.10846.exe}
STAGE=$HOME/ssam-prova
FAIL=0
step() { printf '\n== %s\n' "$*"; }
ok() { printf '  OK   %s\n' "$*"; }
bad() { printf '  FAIL %s\n' "$*"; FAIL=1; }

step "1. Docker"
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  if [ "$INSTALL" = 1 ]; then
    sudo apt-get update
    sudo apt-get install -y docker.io docker-buildx docker-compose-v2
  else
    echo "docker or docker compose missing (run without --no-install)" >&2; exit 1
  fi
fi
if ! docker info >/dev/null 2>&1; then
  sudo service docker start >/dev/null 2>&1 || sudo systemctl start docker
  sleep 3
fi
DOCKER=docker
docker info >/dev/null 2>&1 || DOCKER="sudo docker"
$DOCKER version --format '  engine {{.Server.Version}}' && $DOCKER compose version

step "2. Studios: installer, else bundle ($INSTALLERS)"
mkdir -p "$STAGE/installers"
O11_BUNDLE=${SERVICE_STUDIO_BUNDLE:-o11-studio-11.55.91.65258.tar.gz}
ODC_BUNDLE=${ODC_STUDIO_BUNDLE:-odc-studio-1.7.27.10846.tar.gz}
stage_studio() { # lane installer bundle installed-folder
  for dir in "$INSTALLERS" "$ROOT/docker/installers"; do
    if [ -f "$dir/$2" ]; then cp -u "$dir/$2" "$STAGE/installers/"; ok "$1 installer $2"; return 0; fi
  done
  for dir in "$INSTALLERS" "$ROOT/docker/installers"; do
    if [ -f "$dir/$3" ]; then cp -u "$dir/$3" "$STAGE/installers/"; [ -f "$dir/$3.sha256" ] && cp -u "$dir/$3.sha256" "$STAGE/installers/"
      ok "$1 bundle $3"; return 0; fi
  done
  if [ -d "$4" ]; then
    sh "$ROOT/docker/ssam-server/studio-bundle.sh" --lane "$1" --studio "$4" --out "$STAGE/installers" | sed 's/^/  /'
    [ -f "$STAGE/installers/$3" ] && { ok "$1 bundle $3 packed from $4"; return 0; }
  fi
  bad "$1: neither $2 nor $3, and no installed Studio at $4"
}
stage_studio o11 "$O11_INSTALLER" "$O11_BUNDLE" "/mnt/c/Program Files/OutSystems/Service Studio 11/Service Studio"
stage_studio odc "$ODC_INSTALLER" "$ODC_BUNDLE" "/mnt/c/Program Files/OutSystems/ODC Studio/ODC Studio"
[ "$FAIL" = 0 ] || { echo "missing Studios: stop" >&2; exit 1; }
# compose needs the tunnel variables to parse the file; the tunnel service is never started here.
cat > "$STAGE/prova.env" <<EOF
STUDIO_INSTALLERS_DIR=$STAGE/installers
SERVICE_STUDIO_INSTALLER=$O11_INSTALLER
ODC_STUDIO_INSTALLER=$ODC_INSTALLER
SERVICE_STUDIO_BUNDLE=$O11_BUNDLE
ODC_STUDIO_BUNDLE=$ODC_BUNDLE
NGROK_DOMAIN=prova.invalid
NGROK_AUTHTOKEN=unused-by-the-proof
SSAM_IMAGE_TAG=prova
SSAM_HOST_PORT=17310
EOF
COMPOSE="$DOCKER compose -p ssam-prova --env-file $STAGE/prova.env -f $ROOT/docker-compose.yml"

step "3. Build and start ssam-server"
start=$(date +%s)
$COMPOSE build ssam-server || { bad "compose build"; exit 1; }
ok "build in $(( $(date +%s) - start ))s; image $($DOCKER image inspect ssam-server:prova --format '{{.Size}}' | awk '{ printf "%.0f MB", $1/1048576 }')"
$COMPOSE up -d ssam-server || { bad "compose up"; exit 1; }

step "4. Health"
health=unknown
for i in $(seq 1 60); do
  health=$($DOCKER inspect --format '{{.State.Health.Status}}' "$($COMPOSE ps -q ssam-server)" 2>/dev/null || echo unknown)
  [ "$health" = healthy ] && break
  sleep 3
done
[ "$health" = healthy ] && ok "container healthy" || { bad "container $health"; $COMPOSE logs --tail 40 ssam-server; }
if curl -fsS "http://127.0.0.1:17310/health" >/dev/null 2>&1; then ok "GET /health from the host"; else bad "GET /health from the host"; fi

step "5. Offline kernel calls per lane (inside the container)"
EXEC="$COMPOSE exec -T ssam-server"
$EXEC sh -c 'ls /studio/o11 | wc -l; ls /studio/odc | wc -l; du -sh /studio/o11 /studio/odc; readlink -f /studio/o11/libe_sqlite3.so' | sed 's/^/  /'
kernel() { # name, command
  out=$($EXEC sh -c "cd /app/kernel && $2" 2>&1) && echo "$out" | grep -q '"ok": *true' && ok "$1" || { bad "$1"; echo "$out" | tail -n 15 | sed 's/^/    /'; }
}
kernel "O11 anvil verify-catalog" "dotnet .local/cli/anvil.dll verify-catalog | head -c 400"
kernel "O11 anvil apply smoke-data-logic" "mkdir -p /tmp/prova/o11 && dotnet .local/cli/anvil.dll apply --base tests/fixtures/blank-service.oml --job tests/jobs/smoke-data-logic.json --out /tmp/prova/o11/smoke.oml >/dev/null && cat /tmp/prova/o11/smoke.result.json | grep -E '\"(isValid|accepted)\"' && echo '\"ok\": true'"
kernel "ODC anvil-odc verify-catalog" "dotnet .local/lane-odc/cli/anvil-odc.dll verify-catalog | head -c 400"
kernel "ODC anvil-odc apply workflow-nodes" "mkdir -p /tmp/prova/odc && dotnet .local/lane-odc/cli/anvil-odc.dll apply --base tests/fixtures/odc/blank-workflow.oml --job tests/jobs-odc/workflow-nodes.json --out /tmp/prova/odc/wf.oml >/dev/null && grep -E '\"(isValid|accepted)\"' /tmp/prova/odc/wf.result.json && echo '\"ok\": true'"
kernel "ODC3.Builder list" "dotnet /app/platforms/odc/studio/builder/bin/Release/net10.0/ODC3.Builder.dll list | head -n 3 && echo '\"ok\": true'"
kernel "ODC3.Builder inspect" "mkdir -p /tmp/prova/odc && SSAM_HYBRID_ODC_ROOT=/app/platforms/odc dotnet /app/platforms/odc/studio/builder/bin/Release/net10.0/ODC3.Builder.dll inspect tests/fixtures/odc/insurance-reactive-r8.oml --out /tmp/prova/odc/inspect.json | head -c 300"

step "6. MCP over HTTP with an admin-issued token"
issued=$($COMPOSE run --rm -T ssam-admin server-token issue --customer prova-linux --days 1 --lanes odc,o11 2>/dev/null || true)
TOKEN=$(printf '%s' "$issued" | python3 -c 'import json,sys; t=sys.stdin.read(); print(json.loads(t[t.index("{"):]).get("token",""))' 2>/dev/null || true)
TOKEN_ID=$(printf '%s' "$issued" | python3 -c 'import json,sys; t=sys.stdin.read(); print(json.loads(t[t.index("{"):]).get("id",""))' 2>/dev/null || true)
if [ -z "$TOKEN" ]; then bad "server-token issue answered no token"; else
  ok "token issued (id $TOKEN_ID; the value is not printed)"
  $EXEC env SSAM_PROVA_TOKEN="$TOKEN" node --input-type=module - <<'EOF' | sed 's/^/  /' || FAIL=1
const url = `http://127.0.0.1:${process.env.SSAM_PORT || 7310}/mcp`;
let session = null, id = 0, failed = false;
async function rpc(method, params, notify = false) {
  const headers = { authorization: 'Bearer ' + process.env.SSAM_PROVA_TOKEN, 'content-type': 'application/json',
    accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) };
  const body = { jsonrpc: '2.0', method, ...(params ? { params } : {}), ...(notify ? {} : { id: ++id }) };
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  session = res.headers.get('mcp-session-id') ?? session;
  const text = await res.text();
  if (notify) return { status: res.status };
  const json = text.trim().startsWith('{') ? text : text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).pop();
  return { status: res.status, message: json ? JSON.parse(json) : null };
}
const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'prova-linux', version: '1' } });
console.log(`initialize: HTTP ${init.status}, server ${init.message?.result?.serverInfo?.name ?? '?'}`);
if (init.status !== 200) process.exit(1);
await rpc('notifications/initialized', null, true);
const calls = [
  ['ssam_reference', { lane: 'o11', kind: 'api', query: 'IServerEntity' }],
  ['ssam_reference', { lane: 'odc', kind: 'api', query: 'IServerEntity' }],
  ['ssam_discover', { lane: 'o11', intent: 'create an entity Customer with a Name attribute' }],
  ['ssam_discover', { lane: 'odc', intent: 'create an entity Customer with a Name attribute' }],
  ['o11_extension', { action: 'read', host: 'example.outsystemscloud.com', extension: 'X' }],
];
for (const [name, args] of calls) {
  const r = await rpc('tools/call', { name, arguments: args });
  const result = r.message?.result;
  const s = result?.structuredContent ?? {};
  const expectRefusal = name === 'o11_extension';
  const good = expectRefusal ? s.code === 'HOSTED_UNAVAILABLE' && s.cause === 'XIF_ENGINE_WINDOWS_ONLY' : r.status === 200 && result && !result.isError;
  if (!good) failed = true;
  console.log(`${good ? 'OK  ' : 'FAIL'} ${name} ${args.lane ?? ''}: HTTP ${r.status}${result?.isError ? ' ' + (s.code ?? 'error') + (s.cause ? '/' + s.cause : '') : ''} ${JSON.stringify(result?.content?.[0]?.text ?? r.message?.error ?? '').slice(0, 160)}`);
}
process.exit(failed ? 1 : 0);
EOF
  [ -n "$TOKEN_ID" ] && $COMPOSE run --rm -T ssam-admin server-token revoke --id "$TOKEN_ID" >/dev/null 2>&1 && ok "token revoked" || bad "token revoke"
fi
TOKEN=

step "7. End"
if [ "$KEEP" = 0 ]; then $COMPOSE down >/dev/null 2>&1 && ok "compose down (volumes kept: docker volume ls | grep ssam-prova)"; fi
if [ "$FAIL" = 0 ]; then echo "RESULT: OK"; else echo "RESULT: FAILED"; fi
exit "$FAIL"
