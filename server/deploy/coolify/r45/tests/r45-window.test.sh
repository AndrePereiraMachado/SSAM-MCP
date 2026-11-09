#!/bin/bash
# r45-window.test.sh: r45-window.sh against a fake docker (no VPS, no flock): check writes nothing; apply needs the lock,
# refuses a busy server, exports, backs up, applies, waits for the Redeploy, runs env-check; a second apply refuses;
# rollback restores (with SSAM_LOCK_WAIT=900 in every rollback instruction); WINDOW OK deletes the container copy and
# keeps the host one; cleanup needs the owner's confirmation and deletes and logs both; a tampered staged file and a missing
# Redeploy stop it. Run: bash tests/r45-window.test.sh <kit dir made by kit.mjs>
set -uo pipefail
src=${1:?usage: bash tests/r45-window.test.sh <kit dir made by kit.mjs>}
MARK=$(sed -n 's/^MARK=//p' "$src/kit.env")
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
pass=0; failn=0
ok() { echo "ok   $1"; pass=$((pass+1)); }
bad() { echo "FAIL $1"; failn=$((failn+1)); }
BEFORE=ceff8bc99b93a8c13e75af8a532829e45b840a9d628b1899e0ee3ff2a10cd439
AFTER=130826ffac94f1102d186ba931dbc11fdf672098d6588aaeee7b0684c1a37020
kit() { # a staged copy of option-c with stubs for the backup and the two checks
  rm -rf "$T/kit"; cp -r "$src" "$T/kit"; rm -f "$T/kit"/coolify-before.json* "$T/kit"/cleanup.log "$T/kit"/labels-after.json "$T/kit"/rollback-check-after.txt
  printf '#!/bin/sh\necho "backup $1" >> "$FAKE/log"\n' > "$T/kit/backup-before-redeploy.sh"
  printf '#!/bin/bash\necho ENVCHECK OK\n' > "$T/kit/env-check.sh"
  printf '#!/bin/bash\necho ROLLBACK OK\n' > "$T/kit/rollback-check.sh"
  (cd "$T/kit" && sha256sum kit.env deploy-coolify.php export-coolify-raw.php rollback-coolify.php read-labels.php read-raw-sha.php env-check.sh rollback-check.sh oom-check.sh r45-window.sh with-release-lock.sh backup-before-redeploy.sh ssamctl.sh window-backup.sh > SHA256SUMS)
}
mkdir -p "$T/bin" "$T/lock"
export FAKE=$T
cat > "$T/bin/docker" <<'FAKEDOCKER'
#!/bin/bash
state=$(cat "$FAKE/state")
echo "docker $*" >> "$FAKE/log"
if [ "$1" = exec ]; then
  shift; env=; [ "$1" = -i ] && shift
  while [ "$1" = -e ]; do env="$env $2"; shift 2; done
  c=$1; shift
  if [ "$c" = coolify ] && [ "$1" = php ]; then
    src=$(cat)
    case "$src" in
      *read-raw-sha.php*) echo "{\"rawSha256\":\"$state\",\"bytes\":1}";;
      *deploy-coolify.php*)
        case "$env" in *SSAM_RELEASE_APPLY=$MARK*) [ "$state" = "$BEFORE" ] || { echo "STOP: not before" >&2; exit 2; }; echo "$AFTER" > "$FAKE/state"; echo copy > "$FAKE/tmpcopy";; esac
        printf '{\n    "mode": "x",\n    "afterRawSha256": "%s"\n}\n' "$AFTER";;
      *export-coolify-raw.php*) echo "{\"uuid\":\"u\",\"docker_compose_raw\":\"#c\\n{}\",\"beforeRawSha256\":\"$state\",\"releaseRawSha256\":\"$AFTER\"}";;
      *rollback-coolify.php*) case "$env" in *SSAM_RELEASE_ROLLBACK=$MARK*) echo "$BEFORE" > "$FAKE/state";; esac; echo '{"mode":"check"}';;
      *read-labels.php*) echo '{"routerSizing":"{}"}';;
    esac; exit 0
  fi
  if [ "$c" = coolify ] && [ "$1" = test ]; then [ -f "$FAKE/tmpcopy" ]; exit; fi
  if [ "$c" = coolify ] && [ "$1" = rm ]; then echo "rm $*" >> "$FAKE/log"; rm -f "$FAKE/tmpcopy"; exit 0; fi
  if [ "$c" = coolify ] && [ "$1" = sh ]; then cat > "$FAKE/tmpcopy"; exit 0; fi
  case "$*" in *node*) cat > /dev/null; cat "$FAKE/busy"; exit 0;; esac
  exit 0
fi
if [ "$1" = ps ]; then case "$*" in *ssam.backend*) printf 'ssam-server-v%s-ksqommjgowjjilpgpbmf7cdo\n' 1 2 3 4 5;; *) printf '%s-ksqommjgowjjilpgpbmf7cdo\n' ssam-server-v1 ssam-router ssam-console ssam-ops;; esac; exit 0; fi
if [ "$1" = top ]; then echo "node facade/ssam.mjs serve"; exit 0; fi
if [ "$1" = inspect ]; then
  case "$*" in
    *State.Running*) echo true;;
    *State.StartedAt*) if [ -f "$FAKE/noredeploy" ]; then echo 2026-01-01T00:00:00Z; else date -u -d '+30 seconds' +%Y-%m-%dT%H:%M:%S.000000000Z; fi;;
    *ssam.sizing*) [ "$state" = "$AFTER" ] && echo '{"hot":{}}' || echo '';;
  esac; exit 0
fi
exit 0
FAKEDOCKER
sed -i "s/\$BEFORE/$BEFORE/g; s/\$AFTER/$AFTER/g; s/\$MARK/$MARK/g" "$T/bin/docker"; chmod +x "$T/bin/docker"
export PATH="$T/bin:$PATH" R45_LOCK_DIR=$T/lock R45_POLL_S=0 R45_SETTLE_S=0
reset() { echo "$BEFORE" > "$T/state"; echo 0 > "$T/busy"; : > "$T/log"; rm -f "$T/tmpcopy" "$T/noredeploy" "$T/lock/ssam-release.owner"; kit; }
run() { bash "$T/kit/r45-window.sh" "$@" > "$T/out" 2>&1; echo $? > "$T/rc"; }
rc() { cat "$T/rc"; }

reset; run check
grep -q 'CHECK OK' "$T/out" && [ "$(rc)" = 0 ] && ok 'check: CHECK OK' || { cat "$T/out"; bad 'check'; }
[ ! -e "$T/kit/coolify-before.json" ] && ! grep -q SSAM_RELEASE "$T/log" && [ "$(cat "$T/state")" = "$BEFORE" ] && ok 'check writes nothing' || bad 'check wrote'

reset; run apply
grep -q 'run under the release lock' "$T/out" && [ "$(rc)" = 2 ] && [ "$(cat "$T/state")" = "$BEFORE" ] && ok 'apply without the lock refuses' || { cat "$T/out"; bad 'apply without lock'; }

reset; echo '{"token":"t","pid":1}' > "$T/lock/ssam-release.owner"; echo 2 > "$T/busy"
SSAM_RELEASE_LOCKED=1 run apply
grep -q 'heavy call ran in the last 10 minutes' "$T/out" && [ "$(cat "$T/state")" = "$BEFORE" ] && ok 'apply refuses a busy server' || { cat "$T/out"; bad 'busy'; }

reset; echo '{"token":"t","pid":1}' > "$T/lock/ssam-release.owner"
SSAM_RELEASE_LOCKED=1 run apply
if grep -q 'WINDOW OK' "$T/out" && [ "$(rc)" = 0 ] && [ "$(cat "$T/state")" = "$AFTER" ]; then ok 'apply: export, backup, apply, Redeploy, ENVCHECK OK'; else cat "$T/out"; bad 'apply happy path'; fi
grep -q '"beforeRawSha256":"'"$BEFORE" "$T/kit/coolify-before.json" && ok 'the export is written in the kit folder (on the VPS), with the before sha' || bad 'export'
grep -q "^backup $MARK\$" "$T/log" && ok 'main backup ran with the release label' || bad 'backup'
order=$(grep -nE 'backup r45|SSAM_RELEASE_APPLY' "$T/log" | cut -d: -f1 | tr '\n' ' '); set -- $order
[ "$#" = 2 ] && [ "$1" -lt "$2" ] && ok 'backup before the apply' || bad "order $order"
grep -q 'labels-after' "$T/out" && [ -s "$T/kit/labels-after.json" ] && ok 'labels saved for label-proof' || bad 'labels'
[ ! -e "$T/tmpcopy" ] && grep -q "deleted coolify:/tmp/ssam-r45-coolify-before.json" "$T/kit/cleanup.log" && [ -s "$T/kit/coolify-before.json" ] && ok 'WINDOW OK deletes the container copy, logs it, keeps the host rollback copy' || { cat "$T/out"; bad 'window cleanup'; }

SSAM_RELEASE_LOCKED=1 run cleanup
grep -q "R45_OWNER_CONFIRMED=$MARK" "$T/out" && [ "$(rc)" = 2 ] && [ -s "$T/kit/coolify-before.json" ] && ok 'cleanup without the owner confirmation refuses and keeps the copy' || { cat "$T/out"; bad 'cleanup unconfirmed'; }

SSAM_RELEASE_LOCKED=1 run apply
grep -q 'already applied' "$T/out" && ok 'a second apply refuses' || { cat "$T/out"; bad 'second apply'; }

SSAM_RELEASE_LOCKED=1 run rollback
grep -q 'ROLLED BACK' "$T/out" && [ "$(cat "$T/state")" = "$BEFORE" ] && [ -f "$T/tmpcopy" ] && ok 'rollback: copy restored into coolify, compose back, ROLLBACK OK' || { cat "$T/out"; bad 'rollback'; }

SSAM_RELEASE_LOCKED=1 R45_OWNER_CONFIRMED=$MARK run cleanup
grep -q 'CLEANUP OK' "$T/out" && [ ! -e "$T/kit/coolify-before.json" ] && [ ! -e "$T/tmpcopy" ] && grep -q "deleted $T/kit/coolify-before.json" "$T/kit/cleanup.log" && [ "$(grep -c 'deleted coolify:' "$T/kit/cleanup.log")" = 2 ] && ok 'cleanup (after ROLLBACK OK, owner confirmed): host and container copies deleted and logged' || { cat "$T/out"; cat "$T/kit/cleanup.log"; bad 'cleanup after rollback'; }

reset; echo '{"token":"t","pid":1}' > "$T/lock/ssam-release.owner"
SSAM_RELEASE_LOCKED=1 run apply >/dev/null; SSAM_RELEASE_LOCKED=1 R45_OWNER_CONFIRMED=$MARK run cleanup
grep -q 'CLEANUP OK' "$T/out" && [ ! -e "$T/kit/coolify-before.json" ] && [ "$(cat "$T/state")" = "$AFTER" ] && ok 'cleanup after WINDOW OK: the host copy goes, the release stays' || { cat "$T/out"; bad 'cleanup after window'; }
SSAM_RELEASE_LOCKED=1 run rollback
grep -q 'restore from the pre-' "$T/out" && [ "$(cat "$T/state")" = "$AFTER" ] && ok 'rollback after cleanup stops and names the backup set' || { cat "$T/out"; bad 'rollback after cleanup'; }

reset; echo '{"token":"t","pid":1}' > "$T/lock/ssam-release.owner"; echo "$AFTER" > "$T/state"
SSAM_RELEASE_LOCKED=1 R45_OWNER_CONFIRMED=$MARK run cleanup
grep -q 'no labels-after.json' "$T/out" && ok 'cleanup refuses a stored release without WINDOW OK in this folder' || { cat "$T/out"; bad 'cleanup without window'; }

reset; echo tampered >> "$T/kit/deploy-coolify.php"; run check
grep -q 'differs from SHA256SUMS' "$T/out" && ok 'a tampered staged file stops it' || { cat "$T/out"; bad 'tamper'; }

reset; echo '{"token":"t","pid":1}' > "$T/lock/ssam-release.owner"; touch "$T/noredeploy"
SSAM_RELEASE_LOCKED=1 R45_REDEPLOY_WAIT_S=1 run apply
grep -q 'no Redeploy within' "$T/out" && grep -q 'SSAM_LOCK_WAIT=900 sh .*with-release-lock.sh .*rollback' "$T/out" && [ "$(rc)" = 3 ] && ok 'no Redeploy: exit 3 with the instructions (rollback with SSAM_LOCK_WAIT=900)' || { cat "$T/out"; bad 'no redeploy'; }

reset; echo '{"token":"t","pid":1}' > "$T/lock/ssam-release.owner"; echo "0000" > "$T/state"
SSAM_RELEASE_LOCKED=1 run apply
grep -q 'not the r44 production one' "$T/out" && ! grep -q 'backup r45' "$T/log" && ok 'another stored compose: nothing done (no export, no backup)' || { cat "$T/out"; bad 'wrong before'; }

out=$(SSAM_LOCK_WAIT=soon sh "$T/kit/with-release-lock.sh" true 2>&1); rc=$?
[ "$rc" = 2 ] && printf %s "$out" | grep -q 'SSAM_LOCK_WAIT must be whole seconds' && ok 'with-release-lock.sh refuses a non-numeric SSAM_LOCK_WAIT before taking the lock' || bad "lock wait $rc $out"
grep -q 'flock -x -F -w "$wait" -E 75 /var/lock/ssam-release.lock' "$T/kit/with-release-lock.sh" && grep -q 'trap "clean; trap - EXIT; exit 129" HUP' "$T/kit/with-release-lock.sh" && ok 'with-release-lock.sh: bounded wait, exit 75 named, owner removed on HUP' || bad 'lock wrapper shape'

echo "# pass $pass fail $failn"; [ "$failn" = 0 ]
