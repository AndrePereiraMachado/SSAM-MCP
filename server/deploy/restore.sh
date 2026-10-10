#!/bin/sh
# Restore of the SSAM server state from an archive of backup.sh: REPLACES the content of the volumes /data/server,
# /data/friction and /data/odc-features. Uses compose.prod.yml and the .env next to this script; run it from anywhere.
#
#   sh restore.sh <ssam-state-....tar.gz> [--yes]
#
#   1. checks the archive: its .sha256 when present, readable, only server/, friction/ and odc-features/, no absolute
#      path and no "..";
#   2. asks for the word "restore" (--yes skips it);
#   3. stops ssam-server and saves the current state in <BACKUP_DIR>/pre-restore (backup.sh --online, server stopped);
#   4. empties the three volumes and extracts the archive into them (ssam-ops: uid 10001, no network);
#   5. starts ssam-server and waits for it to be healthy.
# Restore with the image tag that made the archive (its .info says which) or a newer one; tokens issued after the archive
# are lost, tokens revoked after it come back: revoke them again (server-token list, then revoke).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
ENV_FILE=${SSAM_ENV_FILE:-$here/.env}
DOCKER=${DOCKER:-docker}
[ -f "$ENV_FILE" ] || { echo "restore: no $ENV_FILE (copy .env.prod.example to .env)" >&2; exit 2; }
envval() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | sed 's/^"\(.*\)"$/\1/'; }
compose() { $DOCKER compose --env-file "$ENV_FILE" -f "$here/compose.prod.yml" "$@"; }

FILE= YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) YES=1; shift ;;
    -*) echo "restore: unknown argument $1" >&2; exit 2 ;;
    *) [ -z "$FILE" ] || { echo "restore: one archive only" >&2; exit 2; }; FILE=$1; shift ;;
  esac
done
[ -n "$FILE" ] || { echo "usage: sh restore.sh <ssam-state-....tar.gz> [--yes]" >&2; exit 2; }
[ -f "$FILE" ] || { echo "restore: no file $FILE" >&2; exit 2; }
FILE=$(cd "$(dirname "$FILE")" && pwd)/$(basename "$FILE")

# 1. The archive.
if [ -f "$FILE.sha256" ]; then
  (cd "$(dirname "$FILE")" && sha256sum -c "$(basename "$FILE").sha256" >/dev/null) || { echo "restore: $FILE does not match its .sha256" >&2; exit 1; }
  echo "restore: sha256 ok"
else
  echo "restore: no $FILE.sha256; integrity not checked" >&2
fi
list=$(tar -tzf "$FILE") || { echo "restore: $FILE is not a readable tar.gz" >&2; exit 1; }
outside=$(printf '%s\n' "$list" | sed 's#^\./##' | grep -Ev '^(server|friction|odc-features)(/|$)' || true)
[ -z "$outside" ] || { echo "restore: the archive holds paths outside server/, friction/, odc-features/:" >&2; printf '%s\n' "$outside" | head -n 5 >&2; exit 1; }
if printf '%s\n' "$list" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then echo "restore: the archive holds an absolute path or .." >&2; exit 1; fi
if [ -f "$FILE.info" ]; then sed 's/^/restore: archive /' "$FILE.info"; fi
echo "restore: current image $(envval SSAM_IMAGE):$(envval SSAM_IMAGE_TAG)"

# 2. Confirmation.
if [ "$YES" = 0 ]; then
  printf 'restore: this REPLACES the server state with %s. Type restore to go on: ' "$FILE"
  read -r answer
  [ "$answer" = restore ] || { echo "restore: cancelled" >&2; exit 1; }
fi

# 3. Stop and keep what is there now.
compose stop ssam-server >/dev/null 2>&1 || true
DIR=${BACKUP_DIR:-$(envval BACKUP_DIR)}
DIR=${DIR:-/var/backups/ssam-server}
BACKUP_DIR="$DIR/pre-restore" BACKUP_KEEP_DAYS=0 sh "$here/backup.sh" --online

# 4. Empty the volumes, then extract.
compose run --rm --no-deps -T ssam-ops sh -c 'find /data/server /data/friction /data/odc-features -mindepth 1 -delete'
compose run --rm --no-deps -T ssam-ops tar -C /data -xzf - < "$FILE"
echo "restore: state extracted"

# 5. Start and wait for the health check.
compose up -d ssam-server >/dev/null
health=starting
i=0
while [ $i -lt 40 ]; do
  id=$(compose ps -q ssam-server)
  health=$($DOCKER inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id" 2>/dev/null || echo unknown)
  [ "$health" = healthy ] && break
  i=$((i + 1)); sleep 3
done
echo "restore: ssam-server $health"
[ "$health" = healthy ] || { echo "restore: look at: docker compose -f compose.prod.yml logs --tail 50 ssam-server" >&2; exit 1; }
