#!/bin/bash
# retier-window.sh <check|apply|verify|rollback|r2-before|cleanup>: the r45 RETIER on the VPS: moves the capacity tiers of the stored r45
# compose (BEFORE, the AFTER of the r45 kit in production) to the tiers of a newer commit (AFTER), in ONE compose write
# and ONE Redeploy, under ONE flock of /var/lock/ssam-release.lock. The flow and every guard are r45-window.sh's (same
# folder layout, same lock, backup, export, dry run, Redeploy wait, env-check, copies and cleanup); what differs:
#   - the start is the r45 compose, not the r44 one, and the kit folder is /root/ssam-r45h (the r45 kit stays in PREV_DIR,
#     /root/ssam-r45, with its own rollback copy of the r44 compose);
#   - the container copy is /tmp/ssam-r45h-coolify-before.json (never the r45 kit's /tmp/ssam-r45-coolify-before.json);
#   - the Redeploy is seen when every service restarted after the write AND the router's ssam.sizing label is the new one
#     (sha256 ROUTER_SIZING_SHA): both composes are sized, so "a label is present" proves nothing;
#   - rollback goes back to the r45 compose (BEFORE) and checks the containers with env-check-base.sh (the env-check of the
#     base commit: the r45 tiers, HOT_FROM hot); from there the r45 kit in PREV_DIR can still roll back to r44;
#   - cleanup can also delete the r45 kit's rollback copies (PREV_DIR), with its own confirmation R45_PREV_CONFIRMED=<its
#     MARK> (review R5 B2: once the retier is stored, the r45 kit's own cleanup refuses for ever).
#   - revision 2: the retier may also ADD environment keys to every backend (kit.env ENV_KEYS, the rules in
#     gen-retier-php.mjs): the dry run must report exactly those names; check lists the Coolify resource variables that
#     already exist under those names (names only: Coolify 4.4.6 gives the container the ROW's value, not the compose
#     default, so a pre-existing row is a warning); env-check.sh then proves each backend got KEY=default.
# Committed in server/deploy/coolify/r45/retier and staged by retier-kit.mjs from the pin. Runs as root ON THE VPS:
#
#   bash /root/ssam-r45h/retier-window.sh check                    # read-only: no lock, no file, no write
#   sh /root/ssam-r45h/with-release-lock.sh env SSAM_RELEASE_LOCKED=1 bash /root/ssam-r45h/retier-window.sh apply
#   SSAM_LOCK_WAIT=900 sh /root/ssam-r45h/with-release-lock.sh env SSAM_RELEASE_LOCKED=1 bash /root/ssam-r45h/retier-window.sh rollback
#   R45_OWNER_CONFIRMED=<MARK> [R45_PREV_CONFIRMED=<MARK of PREV_DIR/kit.env>] sh /root/ssam-r45h/with-release-lock.sh env SSAM_RELEASE_LOCKED=1 bash /root/ssam-r45h/retier-window.sh cleanup
#   R45_STORED_ONLY=1 SSAM_LOCK_WAIT=900 sh /root/ssam-r45h/with-release-lock.sh env SSAM_RELEASE_LOCKED=1 bash /root/ssam-r45h/retier-window.sh rollback
#   sh /root/ssam-r45h/with-release-lock.sh env SSAM_RELEASE_LOCKED=1 bash /root/ssam-r45h/retier-window.sh verify
#   SSAM_LOCK_WAIT=900 sh /root/ssam-r45h/with-release-lock.sh env SSAM_RELEASE_LOCKED=1 bash /root/ssam-r45h/retier-window.sh r2-before
#
# R0 (trilha C's review, K1): rollback with R45_STORED_ONLY=1 writes BEFORE back WITHOUT waiting for a Restart. Only when NO
# container started after the apply's write (written.epoch): the Restart's first `up` failed and the containers of before
# never stopped. It checks them at once with env-check-base.sh; the host's compose file is still AFTER until the next
# Restart (with the registry back), which realigns it. Any container started after the write: refused, use the plain rollback.
# verify (K2): after a by-hand `up` (R2) with the Redeploy wait already over: with the stored compose = AFTER and every
# service started after the write with the new router label, runs env-check.sh and read-labels.php and closes the window
# as apply does (labels-after.json, the container copy deleted), so cleanup can run.
# r2-before (trilha I's review, V3): back to BEFORE WITHOUT the registry. Before its write, apply keeps the docker-compose.yml
# and .env Coolify rendered for the running containers (checked: the same images as the containers run) in
# $here/before-rendered (0600, never printed). r2-before writes BEFORE back into Coolify (as rollback does, without waiting
# for a Restart), runs `docker compose up -d --pull never` with the kept files in the service's own folder and project, makes
# the Restart's network joins again (the proxy on <uuid>, the containers on the networks apply saw them on) and checks them
# (exit 3 when one is missing; verify does the same after the R2 to AFTER), and checks the containers with env-check-base.sh. Refused when an image of before is no longer on the
# host (the Coolify cleanup, C1), or when the host's .env is not the kept one: then only the R2 to AFTER, and the R1 once the
# registry is back. cleanup deletes the kept files.
#
# apply: (1) no heavy call in the last 10 min; (2) stored compose = BEFORE; (3) export to $here/coolify-before.json (0600,
# never printed, sha checked); (4) backup-before-redeploy.sh <LABEL>; (5) dry run = AFTER; (6) apply (MARK), stored = AFTER;
# (7) the owner's Redeploy (every service restarted, the router carrying the new label); (8) env-check.sh = ENVCHECK OK,
# read-labels.php saved; (9) WINDOW OK deletes the container copy, the host copy stays until cleanup. Any STOP before (6)
# changed nothing; a STOP at (7) or (8) leaves the retier stored: run `rollback` at once (still within the window).
# The whole run must end within R45_LIMIT_S (default 4800 s): the daily backup cron waits at most 5400 s for this lock.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
mode=${1:-check}
. "$here/kit.env"
[ "${KIND:-}" = retier ] || { echo "STOP: kit.env is not a retier kit" >&2; exit 2; }
LOCK_DIR=${R45_LOCK_DIR:-/var/lock}
OWNER=$LOCK_DIR/ssam-release.owner
LIMIT=${R45_LIMIT_S:-4800}
WAIT=${R45_REDEPLOY_WAIT_S:-2400}
POLL=${R45_POLL_S:-15}
PREV_DIR=${R45_PREV_DIR:-/root/ssam-r45}
U=ksqommjgowjjilpgpbmf7cdo
START=$(date +%s)
say() { echo "retier-window: $*"; }
stop() { echo "STOP: $*" >&2; exit "${2:-2}"; }
left() { local used=$(( $(date +%s) - START )); [ "$used" -lt "$LIMIT" ] || stop "the window passed ${LIMIT} s (the backup cron waits 5400 s for the lock): finish by hand or roll back" 4; }
php() { docker exec -i "$@" coolify php; }
field() { sed -n "s/.*\"$1\": *\"\\([^\"]*\\)\".*/\\1/p" | head -n 1; }
raw_sha() { php < "$here/read-raw-sha.php" | field rawSha256; }
ENV_KEYS=${ENV_KEYS:-}
# The dry run (stdin) must add exactly the environment keys of kit.env; prints its counts (no value).
IMAGES=${IMAGES:-}
sorted() { printf %s "$1" | tr ',' '\n' | sort -u | paste -sd, -; }
# ...and move exactly the images of kit.env (review C A3: a tier kit never moves an image; none when IMAGES is absent).
dry_keys() { local o; o=$(cat); [ "$(printf %s "$o" | field envAddedKeys)" = "$ENV_KEYS" ] || return 1
  [ "$(sorted "$(printf %s "$o" | field imageNames)")" = "$(sorted "$IMAGES")" ] || { say "dry run moves images: $(printf %s "$o" | field imageNames | grep . || echo none); kit.env IMAGES: ${IMAGES:-none}"; return 1; }
  say "dry run: $(printf %s "$o" | tr -d ' \n' | grep -o '"changedPaths":[0-9]*,"tierPaths":[0-9]*,"envAddedPaths":[0-9]*' | tr -d '"' | tr ',' ' ') envAddedKeys=${ENV_KEYS:-none} images=${IMAGES:-none}"; }
env_rows() { [ -n "$ENV_KEYS" ] || return 0; local in; in=$(printf "'%s'," ${ENV_KEYS//,/ }); in=${in%,}
  docker exec -i coolify-db psql -U coolify -d coolify -tA <<SQL
select v.key from environment_variables v join services s on s.id = v.resourceable_id
where v.resourceable_type like '%Service' and s.uuid = '$U' and v.key in ($in) order by v.key;
SQL
}
SVC=${R45_SERVICES_DIR:-/data/coolify/services}/$U
RENDERED=$here/before-rendered
# The images a rendered compose names (sorted, one per line) and the images of the resource's containers.
rendered_images() { sed -n "s/^[[:space:]]*image:[[:space:]]*[\"']\{0,1\}\([^\"' ]*\).*/\1/p" "$1" | sort -u; }
container_images() { docker ps -a --filter "name=-$U" --format '{{.Image}}' | sort -u; }
# One spelling per image reference, to compare a rendered compose with the containers (the VPS, measured 11/11: the file says
# docker.io/<repo>:<tag>, the containers <repo>:<tag>): the Docker Hub hosts and library/ dropped, a digest after a tag
# dropped (env-check checks the digests), :latest made explicit. Another registry host stays: it is another image.
norm_refs() { sed -E 's#^(docker\.io|index\.docker\.io|registry-1\.docker\.io)/##; s#^library/([^/]+)$#\1#; s#^(.*/)?([^/:@]+):([^/:@]+)@sha256:[0-9a-f]{64}$#\1\2:\3#; /@/!{/^(.*\/)?[^\/:]+$/s/$/:latest/}' | sort -u; }
# V3: before the write, the rendered compose and .env of the running containers (BEFORE's), for r2-before. No value printed.
keep_rendered() {
  [ -s "$SVC/docker-compose.yml" ] && [ -s "$SVC/.env" ] || { say "no rendered docker-compose.yml and .env in $SVC"; return 1; }
  [ "$(rendered_images "$SVC/docker-compose.yml" | norm_refs)" = "$(container_images | norm_refs)" ] || { say "the rendered compose in $SVC does not name the images the containers run"; return 1; }
  rm -rf "$RENDERED.part"; (umask 077; mkdir "$RENDERED.part") || return 1
  cp "$SVC/docker-compose.yml" "$SVC/.env" "$RENDERED.part/" && chmod 600 "$RENDERED.part/docker-compose.yml" "$RENDERED.part/.env" \
    && extra_networks > "$RENDERED.part/networks" \
    && (cd "$RENDERED.part" && sha256sum docker-compose.yml .env networks > SHA256SUMS) || { rm -rf "$RENDERED.part"; return 1; }
  rm -rf "$RENDERED"; mv "$RENDERED.part" "$RENDERED"
  say "rendered compose and .env of the running containers kept: $RENDERED (0600, not printed; for r2-before)"
  say "networks of the running containers besides $U kept: $(awk '{print $2}' "$RENDERED/networks" | sort | uniq -c | awk '{printf "%s %s; ", $2, $1}')(for the by-hand up)"; }
# The joins the Restart makes that a by-hand `up` does not (Coolify 4.7.5 StartService, read 11/11; the VPS, measured 11/11
# 20:09: the coolify-proxy container on the network <uuid>, the router also on coolify): (a) after its `up`,
# `docker network connect <uuid> coolify-proxy`, which only the proxy container holds and an `up` of the project keeps while
# the network <uuid> (external in the rendered compose) stays; (b) with "connect to predefined network", each service container
# joins the destination network by `docker network connect --alias <container>`, outside the rendered compose: a by-hand `up`
# that recreates a container drops that join. apply keeps (b) as "<container> <network>" lines (names only); after a by-hand
# up, join_networks makes both joins again and check_networks says whether the proxy and every container are where they were.
running_names() { docker ps --filter "name=-$U" --format '{{.Names}}' | sort; }
networks_of() { docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{println $k}}{{end}}' "$1" 2>/dev/null | grep .; }
# on_network <container> <network>: read whole, then matched. Never `networks_of c | grep -q n` under pipefail (C run14, 12/11):
# grep -q leaves at the first match, and a writer still writing (busybox grep, line by line; coolify is the first key) dies
# of SIGPIPE: 141, read as "not on the network" with the container on it.
on_network() { local o; o=$(networks_of "$1" || true); grep -qxF "$2" <<<"$o"; }
extra_networks() { local c n; for c in $(running_names); do for n in $(networks_of "$c"); do [ "$n" = "$U" ] || echo "$c $n"; done; done; }
# A join refused as "already exists": the network holds an endpoint with the container's name. Its id against the
# container's (read only, short ids) says which: the same id, the container is on it (the read before the join was wrong);
# another id, an orphan endpoint that a dirty stop or a dead dockerd left (G, integradora). The kit never clears it.
endpoint_ids() { local ep ct
  ep=$(docker network inspect "$2" -f "{{range \$id, \$e := .Containers}}{{if eq \$e.Name \"$1\"}}{{printf \"%.12s\" \$id}}{{end}}{{end}}" 2>/dev/null || true)
  ct=$(docker inspect -f '{{printf "%.12s" .Id}}' "$1" 2>/dev/null || true)
  if [ -n "$ep" ] && [ "$ep" != "$ct" ]; then echo "[orphan endpoint of $1 in the network $2: the endpoint is $ep, the container is ${ct:-?}; the kit does not clear it (the roteiro's manual step, with the integradora)]"
  else echo "[the endpoint $1 in $2 is ${ep:-?}, the container is ${ct:-?}]"; fi; }
# Each join is read first and made only when missing (as Coolify does). What docker answers to a join that fails is kept in
# JOIN_ERR and printed when the check fails (the C run8: a refused connect was swallowed, and the stop could not say why).
join_networks() {
  JOIN_ERR=; local c n e
  if ! on_network coolify-proxy "$U"; then
    e=$(docker network connect "$U" coolify-proxy 2>&1) || JOIN_ERR+="docker network connect coolify-proxy -> $U: $(printf %s "$e" | tr '\n' ' ')"$'\n'; fi
  [ -s "$RENDERED/networks" ] || return 0
  while read -r c n; do [ -n "$n" ] || continue
    on_network "$c" "$n" && continue
    e=$(docker network connect --alias "$c" "$n" "$c" 2>&1) || { case "$e" in *"already exists"*) e+=" $(endpoint_ids "$c" "$n")";; esac
      JOIN_ERR+="docker network connect $c -> $n: $(printf %s "$e" | tr '\n' ' ')"$'\n'; }
  done < "$RENDERED/networks"; }
check_networks() { # prints each missing join; the count of members of the network <uuid> when none is missing
  local members c n miss=0 want=0
  members=$(docker network inspect "$U" -f '{{range .Containers}}{{println .Name}}{{end}}' 2>/dev/null | grep . || true)
  for c in coolify-proxy $(running_names); do want=$((want+1)); grep -qxF "$c" <<<"$members" || { echo "$c is not on the network $U"; miss=1; }; done
  if [ -s "$RENDERED/networks" ]; then while read -r c n; do [ -n "$n" ] || continue; on_network "$c" "$n" || { echo "$c is not on the network $n"; miss=1; }; done < "$RENDERED/networks"; fi
  [ "$miss" = 0 ] || return 1
  echo "network $U: $want members (the $((want-1)) running containers and coolify-proxy); the joins kept at the apply: $(cat "$RENDERED/networks" 2>/dev/null | grep -c . || true), all back"; }
after_hand_up() { # $1 what to do when a join is missing
  join_networks; local why; why=$(check_networks) || { printf '%s\n' "$why"; [ -z "$JOIN_ERR" ] || printf '%s' "$JOIN_ERR" | sed 's/^/retier-window: /'; stop "a join of the Restart is missing after the by-hand up: the proxy may not reach the router. $1" 3; }
  say "$why"; }
ROLLBACK_CMD="SSAM_LOCK_WAIT=900 sh $here/with-release-lock.sh env SSAM_RELEASE_LOCKED=1 bash $here/retier-window.sh rollback"
TMPCOPY=/tmp/ssam-r45h-coolify-before.json
PREV_TMPCOPY=/tmp/ssam-r45-coolify-before.json
copy_in_coolify() { docker exec coolify test -e "${1:-$TMPCOPY}"; }
logclean() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $mode $MARK deleted $1" >> "$here/cleanup.log"; say "deleted $1"; }
locked() { [ "${SSAM_RELEASE_LOCKED:-}" = 1 ] && [ -s "$OWNER" ] || stop "run under the release lock: sh $here/with-release-lock.sh env SSAM_RELEASE_LOCKED=1 bash $here/retier-window.sh $mode"; }
(cd "$here" && sha256sum -c --quiet SHA256SUMS) || stop "a staged file differs from SHA256SUMS"
case "$AFTER" in [0-9a-f]*) [ ${#AFTER} = 64 ] || stop "kit.env has no reviewed AFTER sha (run the dry run, regenerate the kit)";; *) stop "kit.env has no reviewed AFTER sha (run the dry run, regenerate the kit)";; esac
busy() {
  docker exec -i "ssam-server-v1-$U" timeout 25 node - <<'JS'
const fs=require('fs'),path=require('path');const root='/data/server/versions',now=Date.now(),H=new Set(['studio_deliver','o11_deliver','ssam_code']);let n=0;
const day=d=>new Date(d).toISOString().slice(0,10).replaceAll('-','');
for(const pair of fs.readdirSync(root))for(const d of new Set([day(now),day(now-600000)])){let t='';try{t=fs.readFileSync(path.join(root,pair,'quality-'+d+'.jsonl'),'utf8');}catch{continue;}
 for(const line of t.split('\n')){let r;try{r=JSON.parse(line);}catch{continue;}const at=Date.parse(r?.time);if(r?.kind==='call'&&H.has(r.tool)&&now-at<600000&&at<=now)n++;}}
console.log(n);
JS
}
kernels() { local n=0 c; for c in $(docker ps --filter label=ssam.backend=true --format '{{.Names}}'); do n=$((n + $(docker top "$c" -eo args | grep -c '[d]otnet' || true))); done; echo "$n"; }
started_after() {
  local c t; for c in $(docker ps -a --filter "name=-$U" --format '{{.Names}}'); do
    case "$c" in ssam-admin-*|ssam-ops-*) continue;; esac
    [ "$(docker inspect -f '{{.State.Running}}' "$c")" = true ] || return 1
    t=$(date -d "$(docker inspect -f '{{.State.StartedAt}}' "$c")" +%s); [ "$t" -gt "$1" ] || return 1
  done; }
# R0: no service stopped or started after $1 (every one running, started at or before it). Prints the first that did.
none_started_after() {
  local c t; for c in $(docker ps -a --filter "name=-$U" --format '{{.Names}}'); do
    case "$c" in ssam-admin-*|ssam-ops-*) continue;; esac
    [ "$(docker inspect -f '{{.State.Running}}' "$c")" = true ] || { echo "$c is not running"; return 1; }
    t=$(date -d "$(docker inspect -f '{{.State.StartedAt}}' "$c")" +%s); [ "$t" -le "$1" ] || { echo "$c started after the write"; return 1; }
  done; }
written_at() { local w; w=$(cat "$here/written.epoch" 2>/dev/null || true); case "$w" in ''|*[!0-9]*) stop "no written.epoch in $here: this folder never applied (or it was applied by an older kit): $1" 2;; esac; echo "$w"; }
# The end of a window once the containers are AFTER's: env-check.sh, the labels, the container copy deleted.
finish_after() {
  if bash "$here/env-check.sh" > "$here/env-check-after.txt" 2>&1 && tail -n 1 "$here/env-check-after.txt" | grep -qx 'ENVCHECK OK'; then say "ENVCHECK OK"
  else cat "$here/env-check-after.txt"; stop "env-check failed: ROLL BACK NOW: $ROLLBACK_CMD" 3; fi
  php < "$here/read-labels.php" > "$here/labels-after.json"
  if copy_in_coolify; then docker exec coolify rm -f "$TMPCOPY"; ! copy_in_coolify || stop "the retier is live and checked, but coolify:$TMPCOPY could not be deleted: delete it by hand (docker exec coolify rm -f $TMPCOPY)" 3; logclean "coolify:$TMPCOPY"; fi
  say "rollback copy kept until the owner confirms: $here/coolify-before.json (then: cleanup)"
  say "WINDOW OK: copy $here/labels-after.json home and run label-proof.mjs on it with the pin $PIN; then remove the vigia PAUSE"; }
router_sizing_sha() { docker inspect -f '{{index .Config.Labels "ssam.sizing"}}' "ssam-router-$U" 2>/dev/null | head -c -1 | sha256sum | cut -d' ' -f1; }
# The running limits of the backends (numbers only): shows a live `docker update` that the Redeploy will replace.
live_limits() { local v; for v in 1 2 3 4 5; do docker inspect -f "ssam-server-v$v NanoCpus={{.HostConfig.NanoCpus}} Memory={{.HostConfig.Memory}} CpuShares={{.HostConfig.CpuShares}} tier={{index .Config.Labels \"ssam.sizing\"}}" "ssam-server-v$v-$U" 2>/dev/null || echo "ssam-server-v$v: no container"; done; }
wait_redeploy() { # $1 epoch of the compose write, $2 the router label sha256 the new containers must carry
  say "PRESS REDEPLOY in Coolify now (resource $U); waiting up to ${WAIT} s"
  local t0; t0=$(date +%s)
  while :; do
    left
    if started_after "$1" && [ "$(router_sizing_sha)" = "$2" ]; then say "every service restarted after the write, the router carries the expected sizing"; return 0; fi
    [ $(( $(date +%s) - t0 )) -lt "$WAIT" ] || stop "no Redeploy within ${WAIT} s: the stored compose is written; press Redeploy and then run verify, or roll back: $ROLLBACK_CMD (if no container restarted: R45_STORED_ONLY=1 before it)" 3
    sleep "$POLL"
  done; }
restore_copy() {
  [ -s "$here/coolify-before.json" ] || stop "no rollback copy, neither in the coolify container nor in $here (cleanup.log says when it was deleted): restore from the pre-$LABEL backup set"
  docker exec -i coolify sh -c "umask 077; cat > $TMPCOPY" < "$here/coolify-before.json"
  say "rollback copy restored into the coolify container from $here/coolify-before.json"
}
# Every retier kit uses the same container copy: after the rollback of a later retier (day 2 of the image canary) the copy
# there is that kit's, and this kit's PHP refuses it. This kit's own copy (its folder) then replaces it; the other kit
# keeps its copy in its own folder. A copy this kit's PHP refuses after that is a real refusal.
rollback_copy() {
  if ! docker exec coolify test -s "$TMPCOPY"; then restore_copy
  elif ! php < "$here/rollback-retier.php" >/dev/null 2>&1 && [ -s "$here/coolify-before.json" ]; then
    say "the copy in the coolify container is not this kit's (another retier left it): replacing it with this kit's"
    restore_copy
  fi; }

case "$mode" in
check)
  say "retier $BASE -> $PIN (hot $HOT_FROM -> $HOT_TO), mark $MARK"
  now=$(raw_sha); say "stored compose $now"
  [ "$now" = "$BEFORE" ] || stop "the stored compose is not the r45 one this kit starts from ($BEFORE)"
  out=$(php < "$here/deploy-retier.php"); [ "$(printf %s "$out" | field afterRawSha256)" = "$AFTER" ] || stop "the dry run does not give the reviewed AFTER"
  say "dry run gives $AFTER"
  printf %s "$out" | dry_keys || stop "the dry run does not add exactly the environment keys (${ENV_KEYS:-none}) or move exactly the images (${IMAGES:-none}) of kit.env"
  rows=$(env_rows | tr '\n' ' ' | sed 's/ *$//') || rows="(the SELECT failed)"
  [ -z "$rows" ] && say "no Coolify resource variable yet for the added keys (the Redeploy creates them with the defaults)" || say "WARN Coolify resource variables already exist for: $rows (the container gets the row, not the default: env-check.sh will tell)"
  php < "$here/rollback-retier.php" >/dev/null || stop "rollback check failed"
  say "heavy calls in the last 10 min: $(busy); dotnet processes in the backends: $(kernels)"
  say "release lock owner: $(cat "$OWNER" 2>/dev/null || echo none)"
  live_limits | sed 's/^/retier-window: live /'
  say "copies of the stored compose: $here/coolify-before.json $([ -e "$here/coolify-before.json" ] && echo present || echo absent), coolify:$TMPCOPY $(copy_in_coolify && echo present || echo absent)"
  say "r45 kit copies (r44 compose): $PREV_DIR/coolify-before.json $([ -e "$PREV_DIR/coolify-before.json" ] && echo present || echo absent), coolify:$PREV_TMPCOPY $(copy_in_coolify "$PREV_TMPCOPY" && echo present || echo absent)"
  say "CHECK OK (nothing was written)";;
apply)
  locked
  [ "$(busy)" = 0 ] || [ "${R45_ALLOW_BUSY:-}" = 1 ] || stop "a heavy call ran in the last 10 minutes: wait (an interrupted delivery becomes an uncertain outcome)"
  now=$(raw_sha)
  [ "$now" != "$AFTER" ] || stop "the retier is already applied ($AFTER): run env-check.sh, or rollback"
  [ "$now" = "$BEFORE" ] || stop "the stored compose is not the r45 one this kit starts from: $now"
  umask 077
  php < "$here/export-retier-raw.php" > "$here/coolify-before.json.part" || { rm -f "$here/coolify-before.json.part"; stop "export failed"; }
  [ "$(field beforeRawSha256 < "$here/coolify-before.json.part")" = "$BEFORE" ] || { rm -f "$here/coolify-before.json.part"; stop "the export is not the r45 compose"; }
  mv "$here/coolify-before.json.part" "$here/coolify-before.json"; chmod 600 "$here/coolify-before.json"
  say "export: $here/coolify-before.json ($(stat -c '%a %s' "$here/coolify-before.json"), sha checked; not printed)"
  left
  SSAM_SSH='sh -c' sh "$here/backup-before-redeploy.sh" "$LABEL" || stop "the backup failed: nothing was applied"
  left
  out=$(php < "$here/deploy-retier.php"); [ "$(printf %s "$out" | field afterRawSha256)" = "$AFTER" ] || stop "the dry run does not give the reviewed AFTER: nothing was applied"
  printf %s "$out" | dry_keys || stop "the dry run does not add exactly the environment keys (${ENV_KEYS:-none}) or move exactly the images (${IMAGES:-none}) of kit.env: nothing was applied"
  keep_rendered || stop "the rendered compose of the running containers could not be kept (r2-before needs it): nothing was applied"
  written=$(date +%s); echo "$written" > "$here/written.epoch"
  php -e "SSAM_RELEASE_APPLY=$MARK" < "$here/deploy-retier.php" > "$here/deploy-report.json" || stop "the apply refused (see $here/deploy-report.json): read-raw-sha.php decides whether anything was written"
  [ "$(raw_sha)" = "$AFTER" ] || stop "the stored compose is not AFTER after the apply: ROLL BACK NOW: $ROLLBACK_CMD" 3
  say "compose applied: $AFTER"
  wait_redeploy "$written" "$ROUTER_SIZING_SHA"
  # A7 (integradora 12/11, C run8 on Compose 5.6.0; read by the G): the R2 up by hand while apply waits brings AFTER's
  # containers up without the Restart's joins. apply then closes over them: it joins again and checks, as verify does. After
  # a Restart the joins are there, and it only reads and checks them. A join missing: exit 3, no WINDOW OK.
  # The settle comes before the check, as in r2-before and rollback (C run14 measured no lag: the run11/12 stop was SIGPIPE).
  sleep "${R45_SETTLE_S:-20}"
  after_hand_up "the window is applied and the containers are AFTER's: join it by hand (the line above names the container and the network), then verify"
  finish_after;;
verify)
  locked
  now=$(raw_sha)
  [ "$now" = "$AFTER" ] || stop "the stored compose is not AFTER ($now): nothing to verify (apply, or rollback)"
  [ ! -s "$here/labels-after.json" ] || stop "this window is already closed (labels-after.json): run env-check.sh by hand to look again"
  written=$(written_at "verify closes only a window this folder applied")
  started_after "$written" && [ "$(router_sizing_sha)" = "$ROUTER_SIZING_SHA" ] \
    || stop "not every service started after the write ($(date -u -d "@$written" +%H:%M:%SZ)) with the new router label: they are not AFTER's yet (Restart, or the by-hand up, first)" 3
  say "every service started after the write, the router carries the expected sizing"
  sleep "${R45_SETTLE_S:-20}"
  after_hand_up "Join it by hand (the line above names the container and the network), then verify again"
  finish_after;;
rollback)
  locked
  now=$(raw_sha)
  [ "$now" = "$AFTER" ] || [ "$now" = "$BEFORE" ] || stop "the stored compose is neither the retier nor the r45 one ($now): owner review"
  rollback_copy
  php < "$here/rollback-retier.php" >/dev/null || stop "rollback check refused"
  if [ "${R45_STORED_ONLY:-}" = 1 ]; then
    # R0: refused unless no service restarted after the apply wrote AFTER (the containers are still BEFORE's).
    [ "$now" = "$AFTER" ] || stop "R45_STORED_ONLY: the stored compose is already the r45 one: nothing to write"
    applied=$(written_at "R45_STORED_ONLY needs the time of the apply's write")
    why=$(none_started_after "$applied") || stop "R45_STORED_ONLY refused: $why ($(date -u -d "@$applied" +%H:%M:%SZ)): the Restart ran, use the plain rollback (with its Restart)" 2
    php -e "SSAM_RELEASE_ROLLBACK=$MARK" < "$here/rollback-retier.php" || stop "rollback refused"
    [ "$(raw_sha)" = "$BEFORE" ] || stop "the stored compose is not the r45 one after the rollback" 3
    say "compose restored: $BEFORE (stored only: no service restarted after the apply, none is restarted now)"
    bash "$here/env-check-base.sh" > "$here/rollback-check-after.txt" 2>&1 || true
    tail -n 1 "$here/rollback-check-after.txt" | grep -qx 'ENVCHECK OK' || { cat "$here/rollback-check-after.txt"; stop "the running containers are not the r45 ones" 3; }
    say "ROLLED BACK (R0, stored only): the running containers are the r45 ones; the host's compose file is still AFTER until the next Restart, which with the registry up realigns it: no by-hand up before it"
    exit 0
  fi
  written=$(date +%s)
  if [ "$now" = "$AFTER" ]; then php -e "SSAM_RELEASE_ROLLBACK=$MARK" < "$here/rollback-retier.php" || stop "rollback refused"; fi
  [ "$(raw_sha)" = "$BEFORE" ] || stop "the stored compose is not the r45 one after the rollback" 3
  say "compose restored: $BEFORE"
  wait_redeploy "$written" "$BASE_ROUTER_SIZING_SHA"
  sleep "${R45_SETTLE_S:-20}"
  # K1 (G, 12/11): the Restart of Coolify 4.7.5 does not stop on a refused join (only a Warning), so ROLLED BACK reads them first.
  after_hand_up "the compose is the r45 one and the containers restarted: join it by hand (the line above names the container and the network), then run env-check-base.sh"
  bash "$here/env-check-base.sh" > "$here/rollback-check-after.txt" 2>&1 || true
  tail -n 1 "$here/rollback-check-after.txt" | grep -qx 'ENVCHECK OK' || { cat "$here/rollback-check-after.txt"; stop "the containers are not back to the r45 tiers ($HOT_FROM hot)" 3; }
  say "ROLLED BACK to the r45 tiers ($HOT_FROM hot): revert the usage on main (signed) and keep the vigia paused until then; the r45 kit in $PREV_DIR can still roll back to r44; the copies stay until cleanup";;
r2-before)
  locked
  [ -s "$RENDERED/docker-compose.yml" ] && [ -s "$RENDERED/.env" ] || stop "no rendered compose of before in $RENDERED (an apply of an older kit, or cleanup ran): no way back to before without the registry; R2 to AFTER (by-hand up, then verify), and R1 once the registry is back"
  (cd "$RENDERED" && sha256sum -c --quiet SHA256SUMS) || stop "the kept rendered files changed since the apply: owner review"
  cmp -s "$RENDERED/.env" "$SVC/.env" || stop "the host's .env is not the one kept at the apply (the Restart rendered other values): owner review, nothing done"
  now=$(raw_sha)
  [ "$now" = "$AFTER" ] || [ "$now" = "$BEFORE" ] || stop "the stored compose is neither the retier nor the r45 one ($now): owner review"
  missing=0; for i in $(rendered_images "$RENDERED/docker-compose.yml"); do docker image inspect "$i" >/dev/null 2>&1 || { say "not on the host: $i"; missing=$((missing+1)); }; done
  [ "$missing" = 0 ] || stop "$missing image(s) of before are not on the host (the Coolify cleanup?): no way back to before without the registry; R2 to AFTER, and R1 once the registry is back" 3
  if [ "$now" = "$AFTER" ]; then
    rollback_copy
    php < "$here/rollback-retier.php" >/dev/null || stop "rollback check refused"
    php -e "SSAM_RELEASE_ROLLBACK=$MARK" < "$here/rollback-retier.php" || stop "rollback refused"
  fi
  [ "$(raw_sha)" = "$BEFORE" ] || stop "the stored compose is not the r45 one after the rollback" 3
  say "compose restored: $BEFORE (no Restart: the registry is down)"
  docker compose --project-directory "$SVC" -f "$RENDERED/docker-compose.yml" --env-file "$RENDERED/.env" --project-name "$U" up -d --remove-orphans --pull never > "$here/r2-before-up.txt" 2>&1 \
    || stop "the up of before with --pull never failed (see $here/r2-before-up.txt): owner review" 3
  sleep "${R45_SETTLE_S:-20}"
  after_hand_up "BEFORE is stored and the r45 containers run: join it by hand (the line above names the container and the network) and call the owner"
  bash "$here/env-check-base.sh" > "$here/rollback-check-after.txt" 2>&1 || true
  tail -n 1 "$here/rollback-check-after.txt" | grep -qx 'ENVCHECK OK' || { cat "$here/rollback-check-after.txt"; stop "the containers of the up are not the r45 ones" 3; }
  say "ROLLED BACK (R2 to before, without the registry): the r45 containers run from the rendered compose kept at the apply; the host's compose file is still AFTER: no Restart while the registry is down; the next Restart with the registry up renders BEFORE";;
cleanup)
  locked
  [ "${R45_OWNER_CONFIRMED:-}" = "$MARK" ] || stop "cleanup deletes the rollback copy: only after the owner confirms, with R45_OWNER_CONFIRMED=$MARK"
  now=$(raw_sha)
  if [ "$now" = "$AFTER" ]; then [ -s "$here/labels-after.json" ] || stop "the retier is stored but this folder has no labels-after.json (no WINDOW OK): keep the rollback copy"
  elif [ "$now" = "$BEFORE" ]; then tail -n 1 "$here/rollback-check-after.txt" 2>/dev/null | grep -qx 'ENVCHECK OK' || stop "the r45 compose is stored but there is no rollback check OK here: keep the rollback copy"
  else stop "the stored compose is neither the retier nor the r45 one ($now): owner review, keep the rollback copy"; fi
  for p in "$here/coolify-before.json" "$here/coolify-before.json.part"; do
    if [ -e "$p" ]; then rm -f "$p"; [ ! -e "$p" ] || stop "could not delete $p" 3; logclean "$p"; fi
  done
  for p in "$RENDERED" "$RENDERED.part"; do
    if [ -e "$p" ]; then rm -rf "$p"; [ ! -e "$p" ] || stop "could not delete $p" 3; logclean "$p"; fi
  done
  if copy_in_coolify; then docker exec coolify rm -f "$TMPCOPY"; ! copy_in_coolify || stop "could not delete coolify:$TMPCOPY" 3; logclean "coolify:$TMPCOPY"; fi
  if [ -n "${R45_PREV_CONFIRMED:-}" ]; then
    prev=$(sed -n 's/^MARK=//p' "$PREV_DIR/kit.env" 2>/dev/null || true)
    [ -n "$prev" ] && [ "$R45_PREV_CONFIRMED" = "$prev" ] || stop "R45_PREV_CONFIRMED is not the MARK of $PREV_DIR/kit.env (${prev:-none}): the r45 kit's copies stay" 2
    for p in "$PREV_DIR/coolify-before.json" "$PREV_DIR/coolify-before.json.part"; do
      if [ -e "$p" ]; then rm -f "$p"; [ ! -e "$p" ] || stop "could not delete $p" 3; logclean "$p"; echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) retier $MARK deleted $p" >> "$PREV_DIR/cleanup.log"; fi
    done
    if copy_in_coolify "$PREV_TMPCOPY"; then docker exec coolify rm -f "$PREV_TMPCOPY"; ! copy_in_coolify "$PREV_TMPCOPY" || stop "could not delete coolify:$PREV_TMPCOPY" 3; logclean "coolify:$PREV_TMPCOPY"; echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) retier $MARK deleted coolify:$PREV_TMPCOPY" >> "$PREV_DIR/cleanup.log"; fi
    say "the r45 kit's copies of the r44 compose are gone: going back to r44 now means the pre-$prev backup set"
  fi
  say "CLEANUP OK: no copy of the stored compose is left from this retier (see $here/cleanup.log); the pre-$LABEL backup set keeps its own";;
*) stop "usage: retier-window.sh check|apply|verify|rollback|r2-before|cleanup";;
esac
