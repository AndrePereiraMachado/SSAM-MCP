#!/bin/bash
# r45-window.sh <check|apply|rollback|cleanup>: the capacity release (r45) on the VPS, steps 3-8 of RESULTADO-R3.md section
# 3 in ONE process, so ONE flock holds /var/lock/ssam-release.lock for all of them (review R3 M3.2). Committed in
# server/deploy/coolify/r45 and staged by kit.mjs from the pin with the option's kit in /root/ssam-r45 (kit.env, the PHP,
# env-check.sh, rollback-check.sh, oom-check.sh, SHA256SUMS of the option folder, and deploy/vigia/with-release-lock.sh +
# backup-before-redeploy.sh + ssamctl.sh + window-backup.sh of the same commit). Runs as root ON THE VPS:
#
#   bash /root/ssam-r45/r45-window.sh check                     # read-only: no lock, no file, no write
#   sh /root/ssam-r45/with-release-lock.sh env SSAM_RELEASE_LOCKED=1 bash /root/ssam-r45/r45-window.sh apply
#   SSAM_LOCK_WAIT=900 sh /root/ssam-r45/with-release-lock.sh env SSAM_RELEASE_LOCKED=1 bash /root/ssam-r45/r45-window.sh rollback
#   R45_OWNER_CONFIRMED=<MARK> sh /root/ssam-r45/with-release-lock.sh env SSAM_RELEASE_LOCKED=1 bash /root/ssam-r45/r45-window.sh cleanup
#
# apply: (1) no heavy call in the last 10 min; (2) stored compose = BEFORE; (3) export of the stored compose to
# /root/ssam-r45/coolify-before.json (0600, written on the VPS, never printed; its sha checked); (4) main's
# backup-before-redeploy.sh <LABEL> (three databases and every volume, inside this lock as COOLIFY.md 8 says); (5) the
# deploy dry run must give AFTER; (6) the apply (MARK) and the stored compose = AFTER; (7) waits for the owner's Redeploy in
# Coolify (every service restarted after the apply, the router carrying ssam.sizing); (8) env-check.sh must end ENVCHECK OK,
# and read-labels.php is saved for label-proof.mjs; (9) WINDOW OK deletes the second copy of the stored compose, the one the
# apply left in the coolify container (/tmp/ssam-r45-coolify-before.json): the rollback copy stays ONLY in
# /root/ssam-r45/coolify-before.json (0600), and rollback copies it back into the container. Any STOP before (6) changed
# nothing; a STOP at (7) or (8) leaves the compose applied: run `rollback` at once (still within the window).
# rollback: SSAM_LOCK_WAIT=900, so a backup cron that took the lock between the failed apply and the rollback is waited for
# (review R4 B4) instead of the wrapper's 30 s.
# cleanup (review R4 B3), only after the owner confirms that no rollback is needed (R45_OWNER_CONFIRMED=<MARK of kit.env>),
# with the stored compose at AFTER after WINDOW OK, or at BEFORE after ROLLED BACK: deletes /root/ssam-r45/coolify-before.json,
# a leftover /root/ssam-r45/coolify-before.json.part and /tmp/ssam-r45-coolify-before.json in the coolify container, checks
# they are gone and appends each deleted path with the UTC time to /root/ssam-r45/cleanup.log. Nothing else holds the
# stored compose (the pre-<LABEL> backup set keeps its own copy under the backup retention).
# The whole run must end within R45_LIMIT_S (default 4800 s): the daily backup cron waits at most 5400 s for this lock.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
mode=${1:-check}
. "$here/kit.env"
LOCK_DIR=${R45_LOCK_DIR:-/var/lock}
OWNER=$LOCK_DIR/ssam-release.owner
LIMIT=${R45_LIMIT_S:-4800}
WAIT=${R45_REDEPLOY_WAIT_S:-2400}
POLL=${R45_POLL_S:-15}
U=ksqommjgowjjilpgpbmf7cdo
START=$(date +%s)
say() { echo "r45-window: $*"; }
stop() { echo "STOP: $*" >&2; exit "${2:-2}"; }
left() { local used=$(( $(date +%s) - START )); [ "$used" -lt "$LIMIT" ] || stop "the window passed ${LIMIT} s (the backup cron waits 5400 s for the lock): finish by hand or roll back" 4; }
php() { docker exec -i "$@" coolify php; }
field() { sed -n "s/.*\"$1\": *\"\\([^\"]*\\)\".*/\\1/p" | head -n 1; }
raw_sha() { php < "$here/read-raw-sha.php" | field rawSha256; }
ROLLBACK_CMD="SSAM_LOCK_WAIT=900 sh $here/with-release-lock.sh env SSAM_RELEASE_LOCKED=1 bash $here/r45-window.sh rollback"
TMPCOPY=/tmp/ssam-r45-coolify-before.json
copy_in_coolify() { docker exec coolify test -e "$TMPCOPY"; }
logclean() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $mode $MARK deleted $1" >> "$here/cleanup.log"; say "deleted $1"; }
locked() { [ "${SSAM_RELEASE_LOCKED:-}" = 1 ] && [ -s "$OWNER" ] || stop "run under the release lock: sh $here/with-release-lock.sh env SSAM_RELEASE_LOCKED=1 bash $here/r45-window.sh $mode"; }
# The staged files are the reviewed ones.
(cd "$here" && sha256sum -c --quiet SHA256SUMS) || stop "a staged file differs from SHA256SUMS"
case "$AFTER" in [0-9a-f]*) [ ${#AFTER} = 64 ] || stop "kit.env has no reviewed AFTER sha (run the dry run, regenerate the kit)";; *) stop "kit.env has no reviewed AFTER sha";; esac
# Heavy calls (studio_deliver, o11_deliver, ssam_code) recorded in the last 10 minutes on any pair (counts only).
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
started_after() { # every service of the resource started after $1 (epoch s)
  local c t; for c in $(docker ps -a --filter "name=-$U" --format '{{.Names}}'); do
    case "$c" in ssam-admin-*|ssam-ops-*) continue;; esac
    [ "$(docker inspect -f '{{.State.Running}}' "$c")" = true ] || return 1
    t=$(date -d "$(docker inspect -f '{{.State.StartedAt}}' "$c")" +%s); [ "$t" -gt "$1" ] || return 1
  done; }
router_sizing() { docker inspect -f '{{index .Config.Labels "ssam.sizing"}}' "ssam-router-$U" 2>/dev/null || true; }
wait_redeploy() { # $1 epoch of the compose write, $2 "sized" | "unsized"
  say "PRESS REDEPLOY in Coolify now (resource $U); waiting up to ${WAIT} s"
  local t0; t0=$(date +%s)
  while :; do
    left
    if started_after "$1"; then
      local s; s=$(router_sizing)
      if { [ "$2" = sized ] && [ -n "$s" ]; } || { [ "$2" = unsized ] && [ -z "$s" ]; }; then say "every service restarted after the write"; return 0; fi
    fi
    [ $(( $(date +%s) - t0 )) -lt "$WAIT" ] || stop "no Redeploy within ${WAIT} s: the stored compose is written; press Redeploy and run env-check.sh by hand, or roll back: $ROLLBACK_CMD" 3
    sleep "$POLL"
  done; }

case "$mode" in
check)
  say "option $OPTION, pin $PIN, mark $MARK"
  now=$(raw_sha); say "stored compose $now"
  [ "$now" = "$BEFORE" ] || stop "the stored compose is not the r44 production one ($BEFORE)"
  out=$(php < "$here/deploy-coolify.php"); [ "$(printf %s "$out" | field afterRawSha256)" = "$AFTER" ] || stop "the dry run does not give the reviewed AFTER"
  say "dry run gives $AFTER"
  php < "$here/rollback-coolify.php" >/dev/null || stop "rollback check failed"
  say "heavy calls in the last 10 min: $(busy); dotnet processes in the backends: $(kernels)"
  say "release lock owner: $(cat "$OWNER" 2>/dev/null || echo none)"
  say "copies of the stored compose: $here/coolify-before.json $([ -e "$here/coolify-before.json" ] && echo present || echo absent), coolify:$TMPCOPY $(copy_in_coolify && echo present || echo absent)"
  say "CHECK OK (nothing was written)";;
apply)
  locked
  [ "$(busy)" = 0 ] || [ "${R45_ALLOW_BUSY:-}" = 1 ] || stop "a heavy call ran in the last 10 minutes: wait (an interrupted delivery becomes an uncertain outcome)"
  now=$(raw_sha)
  [ "$now" != "$AFTER" ] || stop "the release is already applied ($AFTER): run env-check.sh, or rollback"
  [ "$now" = "$BEFORE" ] || stop "the stored compose is not the r44 production one: $now"
  umask 077
  php < "$here/export-coolify-raw.php" > "$here/coolify-before.json.part" || { rm -f "$here/coolify-before.json.part"; stop "export failed"; }
  [ "$(field beforeRawSha256 < "$here/coolify-before.json.part")" = "$BEFORE" ] || { rm -f "$here/coolify-before.json.part"; stop "the export is not the production compose"; }
  mv "$here/coolify-before.json.part" "$here/coolify-before.json"; chmod 600 "$here/coolify-before.json"
  say "export: $here/coolify-before.json ($(stat -c '%a %s' "$here/coolify-before.json"), sha checked; not printed)"
  left
  SSAM_SSH='sh -c' sh "$here/backup-before-redeploy.sh" "$LABEL" || stop "the backup failed: nothing was applied"
  left
  out=$(php < "$here/deploy-coolify.php"); [ "$(printf %s "$out" | field afterRawSha256)" = "$AFTER" ] || stop "the dry run does not give the reviewed AFTER: nothing was applied"
  written=$(date +%s)
  php -e "SSAM_RELEASE_APPLY=$MARK" < "$here/deploy-coolify.php" > "$here/deploy-report.json" || stop "the apply refused (see $here/deploy-report.json): read-raw-sha.php decides whether anything was written"
  [ "$(raw_sha)" = "$AFTER" ] || stop "the stored compose is not AFTER after the apply: ROLL BACK NOW: $ROLLBACK_CMD" 3
  say "compose applied: $AFTER"
  wait_redeploy "$written" sized
  sleep "${R45_SETTLE_S:-20}"
  if bash "$here/env-check.sh" > "$here/env-check-after.txt" 2>&1 && tail -n 1 "$here/env-check-after.txt" | grep -qx 'ENVCHECK OK'; then say "ENVCHECK OK"
  else cat "$here/env-check-after.txt"; stop "env-check failed: ROLL BACK NOW: $ROLLBACK_CMD" 3; fi
  php < "$here/read-labels.php" > "$here/labels-after.json"
  # Review R4 B3: one rollback copy only, the 0600 file in this folder; the copy the apply left in the container goes now.
  if copy_in_coolify; then docker exec coolify rm -f "$TMPCOPY"; ! copy_in_coolify || stop "could not delete coolify:$TMPCOPY" 3; logclean "coolify:$TMPCOPY"; fi
  say "rollback copy kept until the owner confirms: $here/coolify-before.json (then: cleanup)"
  say "WINDOW OK: copy $here/labels-after.json home and run label-proof.mjs on it; then remove the vigia PAUSE";;
rollback)
  locked
  now=$(raw_sha)
  [ "$now" = "$AFTER" ] || [ "$now" = "$BEFORE" ] || stop "the stored compose is neither the release nor the r44 one ($now): owner review"
  if ! docker exec coolify test -s /tmp/ssam-r45-coolify-before.json; then
    [ -s "$here/coolify-before.json" ] || stop "no rollback copy, neither in the coolify container nor in $here (cleanup.log says when it was deleted): restore from the pre-$LABEL backup set"
    docker exec -i coolify sh -c 'umask 077; cat > /tmp/ssam-r45-coolify-before.json' < "$here/coolify-before.json"
    say "rollback copy restored into the coolify container from $here/coolify-before.json"
  fi
  php < "$here/rollback-coolify.php" >/dev/null || stop "rollback check refused"
  written=$(date +%s)
  if [ "$now" = "$AFTER" ]; then php -e "SSAM_RELEASE_ROLLBACK=$MARK" < "$here/rollback-coolify.php" || stop "rollback refused"; fi
  [ "$(raw_sha)" = "$BEFORE" ] || stop "the stored compose is not the r44 one after the rollback" 3
  say "compose restored: $BEFORE"
  wait_redeploy "$written" unsized
  sleep "${R45_SETTLE_S:-20}"
  bash "$here/rollback-check.sh" | tee "$here/rollback-check-after.txt" | tail -n 1 | grep -qx 'ROLLBACK OK' || { cat "$here/rollback-check-after.txt"; stop "the containers are not back to r44" 3; }
  say "ROLLED BACK: revert the sizing on main (signed) and keep the vigia paused until then; the copies stay until cleanup";;
cleanup)
  locked
  [ "${R45_OWNER_CONFIRMED:-}" = "$MARK" ] || stop "cleanup deletes the rollback copy: only after the owner confirms, with R45_OWNER_CONFIRMED=$MARK"
  now=$(raw_sha)
  if [ "$now" = "$AFTER" ]; then [ -s "$here/labels-after.json" ] || stop "the release is stored but this folder has no labels-after.json (no WINDOW OK): keep the rollback copy"
  elif [ "$now" = "$BEFORE" ]; then tail -n 1 "$here/rollback-check-after.txt" 2>/dev/null | grep -qx 'ROLLBACK OK' || stop "the r44 compose is stored but there is no ROLLBACK OK here: keep the rollback copy"
  else stop "the stored compose is neither the release nor the r44 one ($now): owner review, keep the rollback copy"; fi
  for p in "$here/coolify-before.json" "$here/coolify-before.json.part"; do
    if [ -e "$p" ]; then rm -f "$p"; [ ! -e "$p" ] || stop "could not delete $p" 3; logclean "$p"; fi
  done
  if copy_in_coolify; then docker exec coolify rm -f "$TMPCOPY"; ! copy_in_coolify || stop "could not delete coolify:$TMPCOPY" 3; logclean "coolify:$TMPCOPY"; fi
  say "CLEANUP OK: no copy of the stored compose is left from this release (see $here/cleanup.log); the pre-$LABEL backup set keeps its own";;
*) stop "usage: r45-window.sh check|apply|rollback|cleanup";;
esac
