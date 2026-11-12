#!/bin/bash
# retier-window.test.sh: retier-window.sh against a fake docker (no VPS, no flock), in the mold of r45/tests/r45-window.test.sh:
# check writes nothing and refuses a stored compose that is not the r45 one; apply needs the lock, refuses a busy server,
# exports, backs up, applies, waits for the Redeploy WITH the new router label (a Redeploy that keeps the old label is not
# one), runs env-check; a failing env-check asks for the rollback; a second apply refuses; rollback goes back to the r45
# compose and checks it with env-check-base.sh; WINDOW OK deletes only its own container copy; cleanup needs the owner's
# confirmation and deletes the r45 kit's copies only with that kit's MARK; a tampered staged file stops it.
# Revision 2: the dry run must add exactly the environment keys of kit.env (ENV_KEYS, empty for a tier-only kit): check
# and apply stop otherwise, nothing applied; check warns about Coolify resource variables that already hold those names.
# V3 (trilha I): apply keeps the rendered compose and .env of the running containers (refused, nothing applied, when they
# are missing or name other images); r2-before writes BEFORE back and runs `compose up --pull never` with them, without a
# Restart; refused when an image of before left the host, the host's .env changed, or the kept files changed.
# The VPS (11/11 20:09): after a by-hand up, r2-before and verify make the Restart's network joins again (the proxy on <uuid>,
# each container on the networks apply saw it on) and check them; a join that cannot be made stops with exit 3.
# A7 (C run8, Compose 5.6.0): apply that closes over a by-hand up does the same before WINDOW OK. A join the daemon refuses
# prints what docker said; a join already there is read, not made again (as Coolify does).
# C run11/12/14: a join is read whole, then matched (a `| grep -q` under pipefail read 141 as "not on the network" when the
# writer wrote line by line); a refused "already exists" names the endpoint and container ids (an orphan endpoint, G and the
# integradora); K1: the plain rollback checks the joins too.
# Run: bash tests/retier-window.test.sh <kit dir made by retier-kit.mjs>
set -uo pipefail
src=${1:?usage: bash tests/retier-window.test.sh <kit dir made by retier-kit.mjs>}
MARK=$(sed -n 's/^MARK=//p' "$src/kit.env")
BEFORE=$(sed -n 's/^BEFORE=//p' "$src/kit.env")
AFTER=$(sed -n 's/^AFTER=//p' "$src/kit.env")
ENVKEYS=$(sed -n 's/^ENV_KEYS=//p' "$src/kit.env")
IMGS=$(sed -n 's/^IMAGES=//p' "$src/kit.env")
# A kit made before its dry run has no AFTER yet: the window refuses it (tested below); the other cases use a stand-in.
case "$AFTER" in [0-9a-f]*) [ ${#AFTER} = 64 ] || AFTER=;; *) AFTER=;; esac
REALAFTER=$AFTER; [ -n "$AFTER" ] || AFTER=$(printf 'af%.0s' $(seq 32))
R44=ceff8bc99b93a8c13e75af8a532829e45b840a9d628b1899e0ee3ff2a10cd439
LNEW='{"hot":"v5"}'; LBASE='{"hot":"v4"}'
SNEW=$(printf %s "$LNEW" | sha256sum | cut -d' ' -f1); SBASE=$(printf %s "$LBASE" | sha256sum | cut -d' ' -f1)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
pass=0; failn=0
ok() { echo "ok   $1"; pass=$((pass+1)); }
bad() { echo "FAIL $1"; failn=$((failn+1)); }
SUMS="kit.env deploy-retier.php export-retier-raw.php rollback-retier.php read-labels.php read-raw-sha.php env-check.sh env-check-base.sh oom-check.sh retier-window.sh with-release-lock.sh backup-before-redeploy.sh ssamctl.sh window-backup.sh"
kit() { # a staged copy of the kit with stubs for the backup and the two checks; the router label shas of the fake labels
  rm -rf "$T/kit"; cp -r "$src" "$T/kit"; rm -f "$T/kit"/coolify-before.json* "$T/kit"/cleanup.log "$T/kit"/labels-after.json "$T/kit"/rollback-check-after.txt "$T/kit"/written.epoch
  [ -z "${RETIER_WINDOW_SH:-}" ] || cp "$RETIER_WINDOW_SH" "$T/kit/retier-window.sh"   # a kit of an older pin, this checkout's window
  sed -i "s/^AFTER=.*/AFTER=$AFTER/; s/^ROUTER_SIZING_SHA=.*/ROUTER_SIZING_SHA=$SNEW/; s/^BASE_ROUTER_SIZING_SHA=.*/BASE_ROUTER_SIZING_SHA=$SBASE/" "$T/kit/kit.env"
  printf '#!/bin/sh\necho "backup $1" >> "$FAKE/log"\n' > "$T/kit/backup-before-redeploy.sh"
  printf '#!/bin/bash\n[ -f "$FAKE/envfail" ] && { echo "FAIL ssam-server-v5 CpuShares"; echo "ENVCHECK FAIL 1"; exit 0; }\necho ENVCHECK OK\n' > "$T/kit/env-check.sh"
  printf '#!/bin/bash\n[ -f "$FAKE/basefail" ] && { echo "ENVCHECK FAIL 2"; exit 0; }\necho ENVCHECK OK\n' > "$T/kit/env-check-base.sh"
  (cd "$T/kit" && sha256sum $SUMS > SHA256SUMS)
}
mkdir -p "$T/bin" "$T/lock" "$T/prev"
export FAKE=$T
cat > "$T/bin/docker" <<'FAKEDOCKER'
#!/bin/bash
state=$(cat "$FAKE/state")
echo "docker $*" >> "$FAKE/log"
path_of() { case "$1" in /tmp/ssam-r45h-coolify-before.json) echo "$FAKE/tmpcopy";; /tmp/ssam-r45-coolify-before.json) echo "$FAKE/prevtmp";; *) echo "$FAKE/other";; esac; }
if [ "$1" = exec ]; then
  shift; env=; [ "$1" = -i ] && shift
  while [ "$1" = -e ]; do env="$env $2"; shift 2; done
  c=$1; shift
  if [ "$c" = coolify ] && [ "$1" = php ]; then
    src=$(cat)
    case "$src" in
      *read-raw-sha.php*) echo "{\"rawSha256\":\"$state\",\"bytes\":1}";;
      *deploy-retier.php*)
        [ "$state" = "@BEFORE@" ] || { echo "STOP: not the r45 compose" >&2; exit 2; }
        case "$env" in *SSAM_RELEASE_APPLY=@MARK@*) echo "@AFTER@" > "$FAKE/state"; echo copy > "$FAKE/tmpcopy";; esac
        keys="@ENVKEYS@"; [ -f "$FAKE/otherkeys" ] && keys=SSAM_SOMETHING_ELSE
        imgs="@IMGS@"; [ -f "$FAKE/otherimages" ] && imgs="${imgs:+$imgs,}ssam-server-v9"
        names=; [ -n "$imgs" ] && names=",
    \"imageNames\": \"$imgs\""
        printf '{\n    "mode": "x",\n    "afterRawSha256": "%s",\n    "changedPaths": 43,\n    "tierPaths": 13,\n    "envAddedPaths": 30,\n    "envAddedKeys": "%s"%s\n}\n' "@AFTER@" "$keys" "$names";;
      *export-retier-raw.php*) echo "{\"uuid\":\"u\",\"docker_compose_raw\":\"#c\\n{}\",\"beforeRawSha256\":\"$state\",\"releaseRawSha256\":\"@AFTER@\"}";;
      *rollback-retier.php*) grep -q otherkit "$FAKE/tmpcopy" 2>/dev/null && { echo "STOP: wrong or damaged rollback copy" >&2; exit 2; }; case "$env" in *SSAM_RELEASE_ROLLBACK=@MARK@*) echo "@BEFORE@" > "$FAKE/state";; esac; echo '{"mode":"check"}';;
      *read-labels.php*) echo '{"routerSizing":"{}"}';;
      *) echo "unexpected php" >&2; exit 9;;
    esac; exit 0
  fi
  if [ "$c" = coolify ] && [ "$1" = test ]; then [ -f "$(path_of "$3")" ]; exit; fi
  if [ "$c" = coolify ] && [ "$1" = rm ]; then rm -f "$(path_of "$3")"; exit 0; fi
  if [ "$c" = coolify ] && [ "$1" = sh ]; then cat > "$FAKE/tmpcopy"; echo "restore $3" >> "$FAKE/log"; exit 0; fi
  if [ "$c" = coolify-db ]; then cat > "$FAKE/sql"; cat "$FAKE/rows" 2>/dev/null; exit 0; fi
  case "$*" in *node*) cat > /dev/null; cat "$FAKE/busy"; exit 0;; esac
  exit 0
fi
# An up recreates the containers: they keep the network of the rendered compose (<uuid>) and lose the joins made outside it
# (the predefined network); the proxy keeps its join unless the network was recreated (dropproxy).
if [ "$1" = compose ]; then [ -f "$FAKE/upfail" ] && { echo "pull access denied" >&2; exit 1; }
  awk -v u=ksqommjgowjjilpgpbmf7cdo -v d="$([ -f "$FAKE/dropproxy" ] && echo 1)" '($1=="coolify-proxy" && !($2==u && d=="1")) || ($1!="coolify-proxy" && $2==u)' "$FAKE/nets" > "$FAKE/nets.up"; mv "$FAKE/nets.up" "$FAKE/nets"; exit 0; fi
if [ "$1" = network ] && [ "$2" = connect ]; then [ -f "$FAKE/connectfail" ] && { echo "Error response from daemon: falso (connectfail)" >&2; exit 1; }; shift 2; [ "$1" = --alias ] && shift 2
  grep -qxF "$2 $1" "$FAKE/nets" && { echo "Error response from daemon: endpoint with name $2 already exists in network $1" >&2; exit 1; }; echo "$2 $1" >> "$FAKE/nets"; exit 0; fi
# the endpoint id of a container in a network: the container's own id, or an ep-… one when it is an orphan (G, C run11/12)
if [ "$1" = network ] && [ "$2" = inspect ] && case "$*" in *'$id'*) true;; *) false;; esac; then
  c=$(printf %s "$*" | grep -o 'eq [$]e.Name "[^"]*"' | cut -d'"' -f2); grep -qxF "$c $3" "$FAKE/nets" || exit 0
  if [ -f "$FAKE/orphan" ]; then echo ep-0a1b2c3d4e5f; else echo c0ffee000001; fi; exit 0; fi
if [ "$1" = network ] && [ "$2" = inspect ]; then awk -v n="$3" '$2==n{print $1}' "$FAKE/nets" | sort -u; exit 0; fi
if [ "$1" = image ] && [ "$2" = inspect ]; then ! grep -qxF "$3" "$FAKE/gone" 2>/dev/null; exit; fi
if [ "$1" = ps ] && [ "${*: -1}" = '{{.Image}}' ]; then cat "$FAKE/running"; exit 0; fi
if [ "$1" = ps ]; then case "$*" in *ssam.backend*) printf 'ssam-server-v%s-ksqommjgowjjilpgpbmf7cdo\n' 1 2 3 4 5;; *) printf '%s-ksqommjgowjjilpgpbmf7cdo\n' ssam-server-v1 ssam-router ssam-console ssam-ops;; esac; exit 0; fi
if [ "$1" = top ]; then echo "node facade/ssam.mjs serve"; exit 0; fi
if [ "$1" = inspect ]; then
  case "$*" in
    *NetworkSettings.Networks*) hide=; [ -f "$FAKE/orphan" ] && hide=coolify
      # slowlines (C run14): one key at a time, as docker and the busybox grep of the rig write; coolify is the first key
      awk -v c="${*: -1}" -v h="$hide" '$1==c && !($2==h && c!="coolify-proxy"){print $2}' "$FAKE/nets" | sort -u \
        | if [ -f "$FAKE/slowlines" ]; then while IFS= read -r l; do echo "$l"; sleep 0.2; done; else cat; fi;;
    *'.Id'*) echo c0ffee000001;;
    *State.Running*) echo true;;
    *State.StartedAt*) if [ -f "$FAKE/dropjoin" ]; then rm -f "$FAKE/dropjoin"; grep -vx "ssam-router-ksqommjgowjjilpgpbmf7cdo coolify" "$FAKE/nets" > "$FAKE/nets.x"; mv "$FAKE/nets.x" "$FAKE/nets"; fi
      if [ -f "$FAKE/noredeploy" ]; then echo 2026-01-01T00:00:00Z; else date -u -d '+30 seconds' +%Y-%m-%dT%H:%M:%S.000000000Z; fi;;
    *NanoCpus=*) echo "live NanoCpus=5000000000 Memory=10737418240 CpuShares=1024 tier=other";;
    *ssam.sizing*) # the Restart that brings AFTER: orphanjoin leaves an orphan endpoint with the router's name
      if [ "$state" = "@AFTER@" ] && [ -f "$FAKE/orphanjoin" ]; then touch "$FAKE/orphan"; rm -f "$FAKE/orphanjoin"; fi
      if [ -f "$FAKE/stalelabel" ] || [ "$state" != "@AFTER@" ]; then echo '@LBASE@'; else echo '@LNEW@'; fi;;
  esac; exit 0
fi
exit 0
FAKEDOCKER
sed -i "s/@BEFORE@/$BEFORE/g; s/@AFTER@/$AFTER/g; s/@MARK@/$MARK/g; s/@LNEW@/$LNEW/g; s/@LBASE@/$LBASE/g; s/@ENVKEYS@/$ENVKEYS/g; s/@IMGS@/$IMGS/g" "$T/bin/docker"; chmod +x "$T/bin/docker"
export PATH="$T/bin:$PATH" R45_LOCK_DIR=$T/lock R45_POLL_S=0 R45_SETTLE_S=0 R45_PREV_DIR=$T/prev R45_SERVICES_DIR=$T/svc
U=ksqommjgowjjilpgpbmf7cdo; SVC=$T/svc/$U
OLDIMGS='docker.io/x/ssam-router:1
docker.io/x/ssam-server:old-1
docker.io/x/ssam-server:old-2'
render() { # the compose Coolify renders for these images (quoted and plain image lines), and a .env with a value never printed
  mkdir -p "$SVC"; { echo services:; n=0; for i in $1; do n=$((n+1)); [ $((n%2)) = 0 ] && q="'" || q=; printf '  s%s:\n    image: %s%s%s\n    pull_policy: always\n' $n "$q" "$i" "$q"; done; } > "$SVC/docker-compose.yml"; }
reset() { echo "$BEFORE" > "$T/state"; echo 0 > "$T/busy"; : > "$T/log"; rm -f "$T/gone" "$T/upfail" "$T/tmpcopy" "$T/noredeploy" "$T/stalelabel" "$T/envfail" "$T/basefail" "$T/lock/ssam-release.owner" "$T/otherkeys" "$T/otherimages" "$T/rows" "$T/sql"
  rm -rf "$T/prev"; mkdir -p "$T/prev"; printf 'MARK=r45-c-prev\n' > "$T/prev/kit.env"; echo r44copy > "$T/prev/coolify-before.json"; rm -f "$T/prevtmp"; kit
  printf '%s\n' "$OLDIMGS" > "$T/running"; rm -rf "$T/svc"; render "$OLDIMGS"; echo 'SSAM_SECRET_VALUE=do-not-print-7f3' > "$SVC/.env"
  rm -f "$T/connectfail" "$T/dropproxy" "$T/slowlines" "$T/orphan" "$T/orphanjoin"   # the VPS, measured 11/11 20:09: the proxy on <uuid>, the router also on coolify
  { for c in ssam-server-v1 ssam-router ssam-console ssam-ops; do echo "$c-$U $U"; done; echo "ssam-router-$U coolify"; echo "coolify-proxy $U"; echo "coolify-proxy coolify"; } > "$T/nets"; }
lock() { echo '{"token":"t","pid":1}' > "$T/lock/ssam-release.owner"; }
run() { bash "$T/kit/retier-window.sh" "$@" > "$T/out" 2>&1; echo $? > "$T/rc"; }
rc() { cat "$T/rc"; }

if [ -z "$REALAFTER" ]; then
  rm -rf "$T/raw"; cp -r "$src" "$T/raw"; out=$(bash "$T/raw/retier-window.sh" check 2>&1); r=$?
  [ "$r" = 2 ] && printf %s "$out" | grep -q 'no reviewed AFTER' && ok 'a kit made before the dry run (no AFTER) is refused' || { echo "$out"; bad 'kit without AFTER'; }
fi

reset; run check
grep -q 'CHECK OK' "$T/out" && [ "$(rc)" = 0 ] && grep -q 'live ssam-server-v5\|live live NanoCpus' "$T/out" && grep -q "r45 kit copies (r44 compose): $T/prev/coolify-before.json present" "$T/out" && ok 'check: CHECK OK, live limits and both kits copies shown' || { cat "$T/out"; bad 'check'; }
[ ! -e "$T/kit/coolify-before.json" ] && ! grep -q SSAM_RELEASE "$T/log" && [ "$(cat "$T/state")" = "$BEFORE" ] && ok 'check writes nothing' || bad 'check wrote'

reset; echo "$R44" > "$T/state"; run check
grep -q 'not the r45 one this kit starts from' "$T/out" && [ "$(rc)" = 2 ] && ok 'check refuses a stored compose that is not the r45 one (e.g. r44)' || { cat "$T/out"; bad 'check r44'; }

reset; sed -i 's/^KIND=.*/KIND=other/' "$T/kit/kit.env"; run check
grep -q 'not a retier kit' "$T/out" && ok 'a kit.env that is not a retier kit is refused' || { cat "$T/out"; bad 'kind'; }

reset; run apply
grep -q 'run under the release lock' "$T/out" && [ "$(rc)" = 2 ] && [ "$(cat "$T/state")" = "$BEFORE" ] && ok 'apply without the lock refuses' || { cat "$T/out"; bad 'apply without lock'; }

reset; lock; echo 2 > "$T/busy"; SSAM_RELEASE_LOCKED=1 run apply
grep -q 'heavy call ran in the last 10 minutes' "$T/out" && [ "$(cat "$T/state")" = "$BEFORE" ] && ok 'apply refuses a busy server' || { cat "$T/out"; bad 'busy'; }

reset; lock; echo "$R44" > "$T/state"; SSAM_RELEASE_LOCKED=1 run apply
grep -q 'not the r45 one this kit starts from' "$T/out" && ! grep -q '^backup' "$T/log" && [ ! -e "$T/kit/coolify-before.json" ] && ok 'another stored compose: nothing done (no export, no backup)' || { cat "$T/out"; bad 'wrong before'; }

reset; lock; SSAM_RELEASE_LOCKED=1 run apply
if grep -q 'WINDOW OK' "$T/out" && [ "$(rc)" = 0 ] && [ "$(cat "$T/state")" = "$AFTER" ]; then ok 'apply: export, backup, apply, Redeploy with the new label, ENVCHECK OK'; else cat "$T/out"; bad 'apply happy path'; fi
grep -q '"beforeRawSha256":"'"$BEFORE" "$T/kit/coolify-before.json" && ok 'the export is written in the kit folder, with the r45 sha' || bad 'export'
grep -q "^backup $MARK\$" "$T/log" && ok 'backup ran with the retier label' || bad 'backup'
order=$(grep -nE '^backup r45h|SSAM_RELEASE_APPLY' "$T/log" | cut -d: -f1 | tr '\n' ' '); set -- $order
[ "$#" = 2 ] && [ "$1" -lt "$2" ] && ok 'backup before the apply' || bad "order $order"
[ -s "$T/kit/labels-after.json" ] && ok 'labels saved for label-proof' || bad 'labels'
[ ! -e "$T/tmpcopy" ] && grep -q "deleted coolify:/tmp/ssam-r45h-coolify-before.json" "$T/kit/cleanup.log" && [ -s "$T/kit/coolify-before.json" ] && ok 'WINDOW OK deletes its container copy, logs it, keeps the host rollback copy' || { cat "$T/out"; bad 'window cleanup'; }
[ -s "$T/prev/coolify-before.json" ] && ! grep -q 'ssam-r45-coolify-before' "$T/log" && ok 'the r45 kit copy (r44 compose) is not touched by the apply' || bad 'prev touched'

SSAM_RELEASE_LOCKED=1 run cleanup
grep -q "R45_OWNER_CONFIRMED=$MARK" "$T/out" && [ "$(rc)" = 2 ] && [ -s "$T/kit/coolify-before.json" ] && ok 'cleanup without the owner confirmation refuses and keeps the copy' || { cat "$T/out"; bad 'cleanup unconfirmed'; }

SSAM_RELEASE_LOCKED=1 run apply
grep -q 'already applied' "$T/out" && ok 'a second apply refuses' || { cat "$T/out"; bad 'second apply'; }

SSAM_RELEASE_LOCKED=1 run rollback
grep -q 'ROLLED BACK to the r45 tiers' "$T/out" && [ "$(cat "$T/state")" = "$BEFORE" ] && [ -f "$T/tmpcopy" ] && grep -q 'restore /tmp/ssam-r45h\|umask 077; cat > /tmp/ssam-r45h-coolify-before.json' "$T/log" && ok 'rollback: copy restored into coolify, compose back to r45, env-check-base OK' || { cat "$T/out"; bad 'rollback'; }

SSAM_RELEASE_LOCKED=1 R45_OWNER_CONFIRMED=$MARK run cleanup
grep -q 'CLEANUP OK' "$T/out" && [ ! -e "$T/kit/coolify-before.json" ] && [ ! -e "$T/tmpcopy" ] && [ -s "$T/prev/coolify-before.json" ] && ok 'cleanup after the rollback check, owner confirmed: own copies deleted, the r45 kit copy kept' || { cat "$T/out"; bad 'cleanup after rollback'; }

# Review C A1: a later retier's rollback left ITS copy in the container (same name for every retier kit): this kit's rollback
# replaces it with its own folder's copy instead of stopping at "rollback check refused".
reset; lock; SSAM_RELEASE_LOCKED=1 run apply >/dev/null; echo otherkit > "$T/tmpcopy"
SSAM_RELEASE_LOCKED=1 run rollback
grep -q 'not this kit.s (another retier left it)' "$T/out" && grep -q 'ROLLED BACK' "$T/out" && ! grep -q otherkit "$T/tmpcopy" && [ "$(cat "$T/state")" = "$BEFORE" ] && ok 'rollback replaces a container copy another retier left, with its own, and rolls back' || { cat "$T/out"; bad 'chained rollback copy'; }
reset; lock; SSAM_RELEASE_LOCKED=1 run apply >/dev/null; echo otherkit > "$T/tmpcopy"; rm -f "$T/kit/coolify-before.json"
SSAM_RELEASE_LOCKED=1 run rollback
grep -q 'rollback check refused' "$T/out" && [ "$(cat "$T/state")" = "$AFTER" ] && ok 'without its own copy, another kit copy is still refused (nothing written)' || { cat "$T/out"; bad 'other copy no own'; }

reset; lock; SSAM_RELEASE_LOCKED=1 run apply >/dev/null
echo copy > "$T/prevtmp"; SSAM_RELEASE_LOCKED=1 R45_OWNER_CONFIRMED=$MARK R45_PREV_CONFIRMED=wrong run cleanup
grep -q 'R45_PREV_CONFIRMED is not the MARK' "$T/out" && [ -s "$T/prev/coolify-before.json" ] && [ -f "$T/prevtmp" ] && ok 'a wrong R45_PREV_CONFIRMED keeps the r45 kit copies' || { cat "$T/out"; bad 'prev wrong'; }
SSAM_RELEASE_LOCKED=1 R45_OWNER_CONFIRMED=$MARK R45_PREV_CONFIRMED=r45-c-prev run cleanup
grep -q 'CLEANUP OK' "$T/out" && [ ! -e "$T/prev/coolify-before.json" ] && [ ! -e "$T/prevtmp" ] && grep -q 'deleted coolify:/tmp/ssam-r45-coolify-before.json' "$T/prev/cleanup.log" && [ "$(cat "$T/state")" = "$AFTER" ] && ok 'cleanup with the r45 kit MARK also deletes its copies and logs them in both folders; the retier stays' || { cat "$T/out"; bad 'prev cleanup'; }
SSAM_RELEASE_LOCKED=1 run rollback
grep -q 'restore from the pre-' "$T/out" && [ "$(cat "$T/state")" = "$AFTER" ] && ok 'rollback after cleanup stops and names the backup set' || { cat "$T/out"; bad 'rollback after cleanup'; }

reset; lock; touch "$T/stalelabel"; SSAM_RELEASE_LOCKED=1 R45_REDEPLOY_WAIT_S=1 run apply
grep -q 'no Redeploy within' "$T/out" && grep -q 'SSAM_LOCK_WAIT=900 sh .*with-release-lock.sh .*retier-window.sh rollback' "$T/out" && [ "$(rc)" = 3 ] && ok 'restarts that keep the old router label are not the Redeploy: exit 3, rollback with SSAM_LOCK_WAIT=900' || { cat "$T/out"; bad 'stale label'; }

reset; lock; touch "$T/envfail"; SSAM_RELEASE_LOCKED=1 run apply
grep -q 'env-check failed: ROLL BACK NOW' "$T/out" && [ "$(rc)" = 3 ] && [ ! -e "$T/kit/labels-after.json" ] && ok 'ENVCHECK FAIL after the Redeploy: exit 3, rollback instruction, no WINDOW OK' || { cat "$T/out"; bad 'envfail'; }
touch "$T/basefail"; SSAM_RELEASE_LOCKED=1 run rollback
grep -q 'not back to the r45 tiers' "$T/out" && [ "$(rc)" = 3 ] && ok 'a rollback whose containers are not the r45 tiers stops with exit 3' || { cat "$T/out"; bad 'basefail'; }

reset; run check
grep -q "dry run: changedPaths:43 tierPaths:13 envAddedPaths:30 envAddedKeys=${ENVKEYS:-none} images=${IMGS:-none}" "$T/out" && ok "check: the dry run adds exactly the kit's environment keys (${ENVKEYS:-none})" || { cat "$T/out"; bad 'check env keys'; }
if [ -n "$ENVKEYS" ]; then
  grep -q 'no Coolify resource variable yet for the added keys' "$T/out" && inlist=$(printf "'%s'," ${ENVKEYS//,/ }) && grep -qF "v.key in (${inlist%,})" "$T/sql" && ok 'check: no resource variable holds the added names yet (names queried, no value)' || { cat "$T/out"; cat "$T/sql"; bad 'rows none'; }
  reset; printf 'SSAM_HUB_PART_GZIP\n' > "$T/rows"; run check
  grep -q 'WARN Coolify resource variables already exist for: SSAM_HUB_PART_GZIP' "$T/out" && grep -q 'CHECK OK' "$T/out" && ok 'check: a pre-existing resource variable of an added key is a warning (env-check.sh decides after the Redeploy)' || { cat "$T/out"; bad 'rows warn'; }
else
  [ ! -e "$T/sql" ] && ok 'a tier-only kit queries no resource variable' || bad 'tier-only rows'
fi
reset; touch "$T/otherkeys"; run check
grep -q 'does not add exactly the environment keys' "$T/out" && [ "$(rc)" = 2 ] && ok 'check: a dry run adding other environment keys stops' || { cat "$T/out"; bad 'check other keys'; }
reset; lock; touch "$T/otherkeys"; SSAM_RELEASE_LOCKED=1 run apply
grep -q 'does not add exactly the environment keys.*nothing was applied' "$T/out" && [ "$(cat "$T/state")" = "$BEFORE" ] && ! grep -q SSAM_RELEASE_APPLY "$T/log" && ok 'apply: a dry run adding other environment keys stops before the write' || { cat "$T/out"; bad 'apply other keys'; }

# Review C A3: a dry run that moves other images than kit.env's IMAGES (a tier kit: none) stops check and apply.
reset; touch "$T/otherimages"; run check
grep -q "dry run moves images: .*ssam-server-v9; kit.env IMAGES: ${IMGS:-none}" "$T/out" && [ "$(rc)" = 2 ] && ok "check: a dry run moving other images than the kit's (${IMGS:-none}) stops" || { cat "$T/out"; bad 'check other images'; }
reset; lock; touch "$T/otherimages"; SSAM_RELEASE_LOCKED=1 run apply
grep -q 'move exactly the images.*nothing was applied' "$T/out" && [ "$(cat "$T/state")" = "$BEFORE" ] && ! grep -q SSAM_RELEASE_APPLY "$T/log" && ok 'apply: a dry run moving other images stops before the write (a tier window never becomes an image window)' || { cat "$T/out"; bad 'apply other images'; }

# Review C K1, R0: the Restart's first `up` failed, no container restarted: rollback with R45_STORED_ONLY=1 writes BEFORE
# back without waiting for a Restart and checks the running containers at once; refused once any container restarted.
reset; lock; touch "$T/noredeploy"; SSAM_RELEASE_LOCKED=1 R45_REDEPLOY_WAIT_S=1 run apply
grep -q 'R45_STORED_ONLY=1 before it' "$T/out" && [ "$(rc)" = 3 ] && [ -s "$T/kit/written.epoch" ] && ok 'K1: no Redeploy: the stop names R0 (R45_STORED_ONLY=1); the time of the write is kept' || { cat "$T/out"; bad 'K1 stop'; }
SSAM_RELEASE_LOCKED=1 R45_STORED_ONLY=1 R45_REDEPLOY_WAIT_S=1 run rollback
grep -q 'ROLLED BACK (R0, stored only)' "$T/out" && [ "$(rc)" = 0 ] && [ "$(cat "$T/state")" = "$BEFORE" ] && ! grep -q 'PRESS REDEPLOY' "$T/out" && tail -n 1 "$T/kit/rollback-check-after.txt" | grep -qx 'ENVCHECK OK' \
  && ok 'K1: R0 writes BEFORE, waits for no Restart, checks the running containers with env-check-base' || { cat "$T/out"; bad 'K1 R0'; }
SSAM_RELEASE_LOCKED=1 R45_OWNER_CONFIRMED=$MARK run cleanup
grep -q 'CLEANUP OK' "$T/out" && ok 'K1: cleanup closes the kit after R0' || { cat "$T/out"; bad 'K1 cleanup'; }
reset; lock; SSAM_RELEASE_LOCKED=1 run apply >/dev/null; SSAM_RELEASE_LOCKED=1 R45_STORED_ONLY=1 run rollback
grep -q 'R45_STORED_ONLY refused: .* started after the write' "$T/out" && [ "$(cat "$T/state")" = "$AFTER" ] && ok 'K1: R0 refused once the containers restarted after the write (nothing written)' || { cat "$T/out"; bad 'K1 restarted'; }
reset; lock; echo "$AFTER" > "$T/state"; echo copy > "$T/tmpcopy"; cp "$T/kit/kit.env" "$T/kit/coolify-before.json"; touch "$T/noredeploy"; SSAM_RELEASE_LOCKED=1 R45_STORED_ONLY=1 run rollback
grep -q 'no written.epoch' "$T/out" && [ "$(cat "$T/state")" = "$AFTER" ] && ok 'K1: R0 without the time of an apply of this folder is refused' || { cat "$T/out"; bad 'K1 no epoch'; }
reset; lock; touch "$T/basefail" "$T/noredeploy"; SSAM_RELEASE_LOCKED=1 R45_REDEPLOY_WAIT_S=1 run apply >/dev/null; SSAM_RELEASE_LOCKED=1 R45_STORED_ONLY=1 run rollback
grep -q 'the running containers are not the r45 ones' "$T/out" && [ "$(rc)" = 3 ] && ok 'K1: R0 whose running containers fail env-check-base stops with exit 3' || { cat "$T/out"; bad 'K1 basefail'; }

# Review C K2: after a by-hand up (R2) with the Redeploy wait over, verify closes the window as apply does.
reset; lock; touch "$T/stalelabel"; SSAM_RELEASE_LOCKED=1 R45_REDEPLOY_WAIT_S=1 run apply >/dev/null
SSAM_RELEASE_LOCKED=1 run verify
grep -q 'not every service started after the write' "$T/out" && [ "$(rc)" = 3 ] && [ ! -e "$T/kit/labels-after.json" ] && ok 'K2: verify refuses while the containers are not AFTER (old router label)' || { cat "$T/out"; bad 'K2 stale'; }
rm -f "$T/stalelabel"; run verify
grep -q 'run under the release lock' "$T/out" && ok 'K2: verify needs the lock' || { cat "$T/out"; bad 'K2 lock'; }
SSAM_RELEASE_LOCKED=1 run verify
grep -q 'WINDOW OK' "$T/out" && [ "$(rc)" = 0 ] && [ -s "$T/kit/labels-after.json" ] && [ ! -e "$T/tmpcopy" ] && ok 'K2: verify after R2: ENVCHECK OK, labels-after.json, the container copy deleted' || { cat "$T/out"; bad 'K2 verify'; }
SSAM_RELEASE_LOCKED=1 run verify
grep -q 'already closed' "$T/out" && ok 'K2: a second verify refuses' || { cat "$T/out"; bad 'K2 twice'; }
SSAM_RELEASE_LOCKED=1 R45_OWNER_CONFIRMED=$MARK run cleanup
grep -q 'CLEANUP OK' "$T/out" && ok 'K2: cleanup closes the kit after verify' || { cat "$T/out"; bad 'K2 cleanup'; }
reset; lock; SSAM_RELEASE_LOCKED=1 run verify
grep -q 'not AFTER' "$T/out" && [ "$(rc)" = 2 ] && ok 'K2: verify with the r45 compose stored refuses' || { cat "$T/out"; bad 'K2 before'; }
reset; lock; touch "$T/stalelabel"; SSAM_RELEASE_LOCKED=1 R45_REDEPLOY_WAIT_S=1 run apply >/dev/null; rm -f "$T/stalelabel"; touch "$T/envfail"; SSAM_RELEASE_LOCKED=1 run verify
grep -q 'env-check failed: ROLL BACK NOW' "$T/out" && [ "$(rc)" = 3 ] && [ ! -e "$T/kit/labels-after.json" ] && ok 'K2: verify with ENVCHECK FAIL asks for the rollback, no WINDOW OK' || { cat "$T/out"; bad 'K2 envfail'; }

# Trilha I's review, V3: the way back to BEFORE without the registry (r2-before), from the rendered files kept at the apply.
reset; lock; SSAM_RELEASE_LOCKED=1 run apply
[ "$(rc)" = 0 ] && cmp -s "$T/kit/before-rendered/docker-compose.yml" "$SVC/docker-compose.yml" && cmp -s "$T/kit/before-rendered/.env" "$SVC/.env" && grep -q 'rendered compose and .env of the running containers kept' "$T/out" && ! grep -q do-not-print "$T/out" \
  && ok 'V3: apply keeps the rendered compose and .env of the running containers, printing no value' || { cat "$T/out"; bad 'V3 keep'; }
[ "$(cat "$T/kit/before-rendered/networks")" = "ssam-router-$U coolify" ] && grep -q '[ *]networks$' "$T/kit/before-rendered/SHA256SUMS" && grep -q "networks of the running containers besides $U kept: coolify 1; " "$T/out" \
  && ok 'integradora 20:09: apply keeps the joins outside <uuid> (the router on coolify), names only, under SHA256SUMS' || { cat "$T/out"; cat "$T/kit/before-rendered/networks"; bad 'nets keep'; }
o=$(grep -n 'running containers kept: ' "$T/out" | cut -d: -f1); a=$(grep -n 'compose applied' "$T/out" | cut -d: -f1)
[ -n "$o" ] && [ -n "$a" ] && [ "$o" -lt "$a" ] && ok 'V3: the rendered files are kept before the write' || bad "V3 order $o $a"
reset; lock; printf 'docker.io/x/ssam-server:old-1\n' > "$T/running"; SSAM_RELEASE_LOCKED=1 run apply
grep -q 'does not name the images the containers run' "$T/out" && grep -q 'nothing was applied' "$T/out" && [ "$(cat "$T/state")" = "$BEFORE" ] && ! grep -q SSAM_RELEASE_APPLY "$T/log" && [ ! -e "$T/kit/before-rendered" ] \
  && ok 'V3: a rendered compose that is not what runs stops the apply before the write' || { cat "$T/out"; bad 'V3 mismatch'; }
# Measured on the VPS (11/11 19:20): the rendered compose names docker.io/<repo>:<tag>, the containers show <repo>:<tag>. The
# same image: the check compares normalized references (Docker Hub host, library/, a digest after a tag, an implicit :latest).
reset; lock; printf '%s\n' x/ssam-router:1 x/ssam-server:old-1 x/ssam-server:old-2 > "$T/running"; SSAM_RELEASE_LOCKED=1 run apply
[ "$(rc)" = 0 ] && grep -q 'rendered compose and .env of the running containers kept' "$T/out" && ok 'V3: docker.io/<repo>:<tag> in the compose and <repo>:<tag> in the containers are the same image (the VPS)' || { cat "$T/out"; bad 'V3 docker.io prefix'; }
D64=$(printf 'd%.0s' $(seq 64))
reset; lock; render "index.docker.io/x/ssam-router:1 docker.io/library/postgres:17 registry-1.docker.io/x/ssam-server:old-1@sha256:$D64 x/ssam-server"
printf '%s\n' x/ssam-router:1 postgres:17 x/ssam-server:old-1 docker.io/x/ssam-server:latest > "$T/running"; SSAM_RELEASE_LOCKED=1 run apply
[ "$(rc)" = 0 ] && grep -q 'kept: ' "$T/out" && ok 'V3: index.docker.io/, registry-1.docker.io/, docker.io/library/, a digest after a tag and an implicit :latest compare equal' || { cat "$T/out"; bad 'V3 family'; }
reset; lock; render "c475-reg:5000/x/ssam-server:old-1 x/ssam-server@sha256:$D64"; printf '%s\n' x/ssam-server:old-1 x/ssam-server@sha256:$D64 > "$T/running"; SSAM_RELEASE_LOCKED=1 run apply
grep -q 'does not name the images the containers run' "$T/out" && [ "$(cat "$T/state")" = "$BEFORE" ] && ok 'V3: another registry host is another image (only the Docker Hub names are folded)' || { cat "$T/out"; bad 'V3 other host'; }
reset; lock; printf '%s\n' x/ssam-router:1 x/ssam-server:old-1 x/ssam-server:old-3 > "$T/running"; SSAM_RELEASE_LOCKED=1 run apply
grep -q 'does not name the images the containers run' "$T/out" && [ "$(cat "$T/state")" = "$BEFORE" ] && ! grep -q SSAM_RELEASE_APPLY "$T/log" && ok 'V3: after the normalization, another tag still stops the apply before the write' || { cat "$T/out"; bad 'V3 other tag'; }
reset; lock; rm -f "$SVC/.env"; SSAM_RELEASE_LOCKED=1 run apply
grep -q 'no rendered docker-compose.yml and .env' "$T/out" && [ "$(cat "$T/state")" = "$BEFORE" ] && ! grep -q SSAM_RELEASE_APPLY "$T/log" && ok 'V3: no rendered files: the apply stops before the write' || { cat "$T/out"; bad 'V3 none'; }
# The Restart stopped the containers and its second pull failed: the host's compose is AFTER's, the registry is down.
r2setup() { reset; lock; touch "$T/noredeploy"; SSAM_RELEASE_LOCKED=1 R45_REDEPLOY_WAIT_S=1 run apply >/dev/null; rm -f "$T/noredeploy"; render 'docker.io/x/ssam-router:1 docker.io/x/ssam-server:new-1 docker.io/x/ssam-server:new-2'; : > "$T/log"; }
r2setup; run r2-before
grep -q 'run under the release lock' "$T/out" && [ "$(cat "$T/state")" = "$AFTER" ] && ok 'V3: r2-before needs the lock' || { cat "$T/out"; bad 'V3 lock'; }
SSAM_RELEASE_LOCKED=1 run r2-before
grep -q 'ROLLED BACK (R2 to before, without the registry)' "$T/out" && [ "$(rc)" = 0 ] && [ "$(cat "$T/state")" = "$BEFORE" ] && ! grep -q 'PRESS REDEPLOY' "$T/out" \
  && grep -qF "docker compose --project-directory $SVC -f $T/kit/before-rendered/docker-compose.yml --env-file $T/kit/before-rendered/.env --project-name $U up -d --remove-orphans --pull never" "$T/log" \
  && grep -q 'coolify-proxy$' "$T/log" && grep -qx "coolify-proxy $U" "$T/nets" && ! grep -q "docker network connect $U coolify-proxy" "$T/log" && tail -n 1 "$T/kit/rollback-check-after.txt" | grep -qx 'ENVCHECK OK' && ! grep -q do-not-print "$T/out" \
  && ok 'V3: r2-before writes BEFORE, ups the kept compose with --pull never in the service project, reads the proxy still on <uuid> (no second join), env-check-base OK' || { cat "$T/out"; cat "$T/log"; bad 'V3 r2-before'; }
grep -qF "docker network connect --alias ssam-router-$U coolify ssam-router-$U" "$T/log" && grep -q "network $U: 5 members (the 4 running containers and coolify-proxy); the joins kept at the apply: 1, all back" "$T/out" && grep -qx "ssam-router-$U coolify" "$T/nets" \
  && ok 'integradora 20:09: after the up, r2-before joins the router to coolify again (the up dropped it) and checks the 5 members of <uuid>' || { cat "$T/out"; cat "$T/nets"; bad 'nets r2-before'; }
c=$(grep -n 'SSAM_RELEASE_ROLLBACK' "$T/log" | head -1 | cut -d: -f1); u=$(grep -n 'docker compose' "$T/log" | cut -d: -f1)
[ -n "$c" ] && [ -n "$u" ] && [ "$c" -lt "$u" ] && ok 'V3: BEFORE is written into Coolify before the up' || bad "V3 write order $c $u"
SSAM_RELEASE_LOCKED=1 R45_OWNER_CONFIRMED=$MARK run cleanup
grep -q 'CLEANUP OK' "$T/out" && [ ! -e "$T/kit/before-rendered" ] && grep -q "deleted $T/kit/before-rendered" "$T/kit/cleanup.log" && ok 'V3/V5: cleanup closes the kit after r2-before and deletes the kept .env' || { cat "$T/out"; bad 'V3 cleanup'; }
r2setup; printf 'docker.io/x/ssam-server:old-2\n' > "$T/gone"; SSAM_RELEASE_LOCKED=1 run r2-before
grep -q 'not on the host: docker.io/x/ssam-server:old-2' "$T/out" && grep -q '1 image(s) of before are not on the host' "$T/out" && [ "$(rc)" = 3 ] && [ "$(cat "$T/state")" = "$AFTER" ] && ! grep -q 'docker compose' "$T/log" \
  && ok 'V3: an image of before gone from the host (the cleanup): refused, nothing written, no up' || { cat "$T/out"; bad 'V3 gone'; }
r2setup; echo 'SSAM_SECRET_VALUE=other' > "$SVC/.env"; SSAM_RELEASE_LOCKED=1 run r2-before
grep -q "host's .env is not the one kept" "$T/out" && [ "$(cat "$T/state")" = "$AFTER" ] && ! grep -q 'docker compose' "$T/log" && ok "V3: the host's .env changed: refused, nothing done" || { cat "$T/out"; bad 'V3 env'; }
r2setup; echo x >> "$T/kit/before-rendered/docker-compose.yml"; SSAM_RELEASE_LOCKED=1 run r2-before
grep -q 'kept rendered files changed' "$T/out" && [ "$(cat "$T/state")" = "$AFTER" ] && ok 'V3: a changed kept file: refused' || { cat "$T/out"; bad 'V3 tamper'; }
r2setup; touch "$T/upfail"; SSAM_RELEASE_LOCKED=1 run r2-before
grep -q 'the up of before with --pull never failed' "$T/out" && [ "$(rc)" = 3 ] && ! grep -q 'ROLLED BACK' "$T/out" && ok 'V3: an up that fails (a pull despite --pull never) stops with exit 3' || { cat "$T/out"; bad 'V3 upfail'; }
r2setup; touch "$T/connectfail"; SSAM_RELEASE_LOCKED=1 run r2-before
grep -q "ssam-router-$U is not on the network coolify" "$T/out" && grep -q 'a join of the Restart is missing after the by-hand up' "$T/out" && [ "$(rc)" = 3 ] && ! grep -q 'ROLLED BACK' "$T/out" \
  && ok 'integradora 20:09: a join that cannot be made again stops r2-before with exit 3 and names it' || { cat "$T/out"; bad 'nets r2-before fail'; }
r2setup; touch "$T/dropproxy"; SSAM_RELEASE_LOCKED=1 run r2-before
grep -q 'ROLLED BACK (R2 to before' "$T/out" && grep -qx "coolify-proxy $U" "$T/nets" && grep -q "network $U: 5 members" "$T/out" && ok 'integradora 20:09: a network recreated by the up: the proxy joins <uuid> again' || { cat "$T/out"; cat "$T/nets"; bad 'nets dropproxy'; }
r2setup; touch "$T/dropproxy" "$T/connectfail"; SSAM_RELEASE_LOCKED=1 run r2-before
grep -q "coolify-proxy is not on the network $U" "$T/out" && [ "$(rc)" = 3 ] && ok 'integradora 20:09: the proxy off <uuid> after the up stops r2-before (exit 3)' || { cat "$T/out"; bad 'nets proxy fail'; }
# The R2 to AFTER: the by-hand up of the roteiro, then verify, which makes the joins again and checks them.
reset; lock; touch "$T/stalelabel"; SSAM_RELEASE_LOCKED=1 R45_REDEPLOY_WAIT_S=1 run apply >/dev/null; rm -f "$T/stalelabel"; "$T/bin/docker" compose up -d --pull never; : > "$T/log"
SSAM_RELEASE_LOCKED=1 run verify
grep -q 'WINDOW OK' "$T/out" && grep -qF "docker network connect --alias ssam-router-$U coolify ssam-router-$U" "$T/log" && grep -q "network $U: 5 members" "$T/out" && ok 'integradora 20:09: verify after the by-hand up joins the router to coolify again and checks <uuid>' || { cat "$T/out"; bad 'nets verify'; }
reset; lock; touch "$T/stalelabel"; SSAM_RELEASE_LOCKED=1 R45_REDEPLOY_WAIT_S=1 run apply >/dev/null; rm -f "$T/stalelabel"; "$T/bin/docker" compose up -d --pull never; touch "$T/connectfail"
SSAM_RELEASE_LOCKED=1 run verify
grep -q "ssam-router-$U is not on the network coolify" "$T/out" && [ "$(rc)" = 3 ] && [ ! -e "$T/kit/labels-after.json" ] && ok 'integradora 20:09: verify with a join missing stops with exit 3, no WINDOW OK' || { cat "$T/out"; bad 'nets verify fail'; }
r2setup; rm -rf "$T/kit/before-rendered"; SSAM_RELEASE_LOCKED=1 run r2-before
grep -q 'no rendered compose of before' "$T/out" && grep -q 'R2 to AFTER' "$T/out" && [ "$(cat "$T/state")" = "$AFTER" ] && ok 'V3: without the kept files (older kit, or cleanup): refused, names the R2 to AFTER' || { cat "$T/out"; bad 'V3 missing'; }

# A7 (integradora 12/11, C run8 on Compose 5.6.0; read by the G): the by-hand up of the R2 while apply still waits drops the
# Restart's join of the router to coolify (dropjoin: the first poll finds it gone); apply sees AFTER's containers and must join
# again and check before WINDOW OK, as verify does.
reset; lock; touch "$T/dropjoin"; SSAM_RELEASE_LOCKED=1 run apply
grep -q 'WINDOW OK' "$T/out" && grep -qx "ssam-router-$U coolify" "$T/nets" && grep -q "network $U: 5 members" "$T/out"   && ok 'A7: apply that closes over a by-hand up joins the router to coolify again and checks it before WINDOW OK' || { cat "$T/out"; cat "$T/nets"; bad 'A7: apply closed without the join of the router to coolify'; }
reset; lock; touch "$T/dropjoin" "$T/connectfail"; SSAM_RELEASE_LOCKED=1 run apply
[ "$(rc)" = 3 ] && grep -q "ssam-router-$U is not on the network coolify" "$T/out" && [ ! -e "$T/kit/labels-after.json" ] && ! grep -q 'WINDOW OK' "$T/out"   && ok 'A7: a join that cannot be made: apply stops with exit 3, no WINDOW OK, no labels-after.json' || { cat "$T/out"; bad 'A7: apply with a join missing'; }
reset; lock; SSAM_RELEASE_LOCKED=1 run apply
grep -q 'WINDOW OK' "$T/out" && grep -q "network $U: 5 members" "$T/out" && ! grep -q 'network connect' "$T/log"   && ok 'A7: after a Restart (the joins are there) apply only reads and checks them, joins nothing, and closes' || { cat "$T/out"; cat "$T/log"; bad 'A7: apply after a Restart'; }
# C run11/12/14 (12/11, measured 3 in 3): the rig's busybox grep writes line by line, coolify is the first key, and
# `networks_of c | grep -qxF coolify` gave PIPESTATUS 141 0 under pipefail: "not on the network coolify" for the 7, with
# the 7 on it, then "already exists". A grep that writes line by line (bbin) and a docker that writes one key at a time:
# apply after a clean Restart reads every join, makes none, and closes.
mkdir -p "$T/bbin"; printf '#!/bin/sh\nexec %s --line-buffered "$@"\n' "$(command -v grep)" > "$T/bbin/grep"; chmod +x "$T/bbin/grep"
reset; lock; touch "$T/slowlines"; PATH="$T/bbin:$PATH" SSAM_RELEASE_LOCKED=1 run apply
grep -q 'WINDOW OK' "$T/out" && grep -q "network $U: 5 members" "$T/out" && ! grep -q 'network connect' "$T/log" && ! grep -q 'is not on the network' "$T/out"   && ok 'C run14: a writer line by line (SIGPIPE under pipefail): apply reads each join whole, makes none, closes' || { cat "$T/out"; bad 'C run14 SIGPIPE'; }
# An orphan endpoint with the router's name (G, integradora: a dirty stop or a dead dockerd): the stop names it, read only.
reset; lock; touch "$T/orphanjoin"; SSAM_RELEASE_LOCKED=1 run apply
[ "$(rc)" = 3 ] && ! grep -q 'WINDOW OK' "$T/out" && [ ! -e "$T/kit/labels-after.json" ]   && grep -qF "already exists in network coolify [orphan endpoint of ssam-router-$U in the network coolify: the endpoint is ep-0a1b2c3d4e5f, the container is c0ffee000001; the kit does not clear it" "$T/out" && ! grep -q 'network disconnect' "$T/log"   && ok 'G: an orphan endpoint: apply stops with exit 3, names it (endpoint and container ids), clears nothing' || { cat "$T/out"; bad 'orphan'; }
# K1 (G): the plain rollback reads the joins after its Restart before ROLLED BACK.
reset; lock; SSAM_RELEASE_LOCKED=1 run apply >/dev/null; touch "$T/dropjoin" "$T/connectfail"; SSAM_RELEASE_LOCKED=1 run rollback
[ "$(rc)" = 3 ] && ! grep -q 'ROLLED BACK' "$T/out" && grep -q "ssam-router-$U is not on the network coolify" "$T/out"   && ok 'K1: a rollback whose Restart left a join missing stops with exit 3, no ROLLED BACK' || { cat "$T/out"; bad 'K1 miss'; }
reset; lock; SSAM_RELEASE_LOCKED=1 run apply >/dev/null; : > "$T/log"; SSAM_RELEASE_LOCKED=1 run rollback
grep -q 'ROLLED BACK to the r45 tiers' "$T/out" && grep -q "network $U: 5 members" "$T/out" && ! grep -q 'network connect' "$T/log"   && ok 'K1: a clean rollback reads the joins (all there, none made) and says ROLLED BACK' || { cat "$T/out"; bad 'K1 clean'; }
# The C (run8): a refused join was swallowed, and the stop could not say why. Now the stop prints what docker said.
r2setup; touch "$T/connectfail"; SSAM_RELEASE_LOCKED=1 run r2-before
grep -q "docker network connect ssam-router-$U -> coolify: Error response from daemon: falso (connectfail)" "$T/out" && [ "$(rc)" = 3 ] && ! grep -q 'ROLLED BACK' "$T/out"   && ok 'C run8: a join the daemon refuses: the stop prints the docker error of that connect' || { cat "$T/out"; bad 'C run8: the connect error is not shown'; }
# The VPS (integradora, 12/11 02:16 UTC): the 7 containers on coolify and <uuid>, the proxy on <uuid>. The same shape here
# (every container on coolify at the apply): after the by-hand up all come back, read from what apply kept, not fixed in code.
reset; for c in ssam-server-v1 ssam-console ssam-ops; do echo "$c-$U coolify" >> "$T/nets"; done; lock; touch "$T/noredeploy"; SSAM_RELEASE_LOCKED=1 R45_REDEPLOY_WAIT_S=1 run apply >/dev/null; rm -f "$T/noredeploy"
render 'docker.io/x/ssam-router:1 docker.io/x/ssam-server:new-1 docker.io/x/ssam-server:new-2'; : > "$T/log"; SSAM_RELEASE_LOCKED=1 run r2-before
[ "$(grep -c " coolify$" "$T/nets")" = 5 ] && grep -q "network $U: 5 members (the 4 running containers and coolify-proxy); the joins kept at the apply: 4, all back" "$T/out" && grep -q 'ROLLED BACK (R2 to before' "$T/out"   && ok 'VPS shape (every container on coolify at the apply): r2-before joins all of them again after its up and checks them' || { cat "$T/out"; cat "$T/nets"; bad 'VPS shape'; }

reset; echo tampered >> "$T/kit/deploy-retier.php"; run check
grep -q 'differs from SHA256SUMS' "$T/out" && ok 'a tampered staged file stops it' || { cat "$T/out"; bad 'tamper'; }

echo "# pass $pass fail $failn"; [ "$failn" = 0 ]
