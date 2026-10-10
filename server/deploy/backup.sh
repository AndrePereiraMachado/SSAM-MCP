#!/bin/sh
# Backup of the SSAM server state: the volumes /data/server (tokens.json with the token hashes, kernel.json, customers'
# workspaces, audit, server.log), /data/friction and /data/odc-features, in one tar.gz on this host, with a .sha256 and an
# .info (image tag, project, and mode: "online" when the server was running during the copy, else "stopped"). Uses
# compose.prod.yml and the .env next to this script; run it from anywhere.
#
#   sh backup.sh [--online] [--dir <folder>] [--keep-days <n>]
#
# By default ssam-server stops for the copy (seconds to a few minutes), so the files are consistent, and starts again
# afterwards, also when the copy fails. --online copies with the server running (a file being written may come out torn).
# Folder: --dir, else BACKUP_DIR (environment, then .env), else /var/backups/ssam-server. Retention: --keep-days, else
# BACKUP_KEEP_DAYS, else 0 (keep all); only ssam-state-* archives older than that are removed, never the one just made.
# The archive holds customer data, customer names and the token hashes: keep it private, encrypt the off-site copy.
# Exit code 0 when the archive was written and checked.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
ENV_FILE=${SSAM_ENV_FILE:-$here/.env}
DOCKER=${DOCKER:-docker}
[ -f "$ENV_FILE" ] || { echo "backup: no $ENV_FILE (copy .env.prod.example to .env)" >&2; exit 2; }
# One KEY=value of the .env, never sourced (the file is not executed).
envval() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | sed 's/^"\(.*\)"$/\1/'; }
compose() { $DOCKER compose --env-file "$ENV_FILE" -f "$here/compose.prod.yml" "$@"; }

ONLINE=0
DIR=${BACKUP_DIR:-$(envval BACKUP_DIR)}
KEEP=${BACKUP_KEEP_DAYS:-$(envval BACKUP_KEEP_DAYS)}
while [ $# -gt 0 ]; do
  case "$1" in
    --online) ONLINE=1; shift ;;
    --dir) DIR=$2; shift 2 ;;
    --keep-days) KEEP=$2; shift 2 ;;
    *) echo "backup: unknown argument $1" >&2; exit 2 ;;
  esac
done
DIR=${DIR:-/var/backups/ssam-server}
KEEP=${KEEP:-0}
case "$KEEP" in ''|*[!0-9]*) echo "backup: --keep-days must be a number of days" >&2; exit 2 ;; esac

umask 077
mkdir -p "$DIR"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
out="$DIR/ssam-state-$stamp.tar.gz"
was_running=0
finish() {
  status=$?
  rm -f "$out.partial"
  if [ "$was_running" = 1 ]; then
    compose start ssam-server >/dev/null 2>&1 && echo "backup: ssam-server started again" || echo "backup: START ssam-server BY HAND (docker compose -f compose.prod.yml start ssam-server)" >&2
  fi
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT TERM

if [ "$ONLINE" = 0 ] && [ -n "$(compose ps -q --status running ssam-server)" ]; then
  was_running=1
  echo "backup: stopping ssam-server for a consistent copy"
  compose stop ssam-server >/dev/null
fi

mode=stopped
if [ -n "$(compose ps -q --status running ssam-server)" ]; then mode=online; fi
# tar runs in the ssam-ops container (the server image, uid 10001, no network, read-only) and writes to stdout only. GNU
# tar exits 1 when a file changed while it was read (server.log grows all the time in an online copy): that copy is kept,
# with the warning; any other failure stops the backup.
compose run --rm --no-deps -T ssam-ops sh -c 'tar -C /data -czf - server friction odc-features; s=$?
  if [ "$s" -eq 1 ]; then echo "backup: a file changed during the copy (tar exit 1); the archive is kept" >&2; exit 0; fi; exit "$s"' > "$out.partial"
# The archive must read back and hold the three folders and nothing else.
members=$(tar -tzf "$out.partial" | sed 's#^\./##' | cut -d/ -f1 | sort -u | tr '\n' ' ')
[ "$members" = "friction odc-features server " ] || { echo "backup: unexpected archive content: $members" >&2; exit 1; }
mv "$out.partial" "$out"
(cd "$DIR" && sha256sum "$(basename "$out")" > "$(basename "$out").sha256")
{
  echo "created $stamp"
  project=${COMPOSE_PROJECT_NAME:-$(envval COMPOSE_PROJECT_NAME)}
  echo "project ${project:-ssam-prod}"
  echo "image $(envval SSAM_IMAGE):$(envval SSAM_IMAGE_TAG)"
  echo "mode $mode"
} > "$out.info"
echo "backup: $out ($(wc -c < "$out" | awk '{ printf "%.1f MB", $1 / 1048576 }')), sha256 $(cut -d' ' -f1 "$out.sha256")"

if [ "$KEEP" -gt 0 ]; then
  find "$DIR" -maxdepth 1 -type f -name 'ssam-state-*.tar.gz*' -mtime +"$KEEP" ! -name "ssam-state-$stamp.*" -print \
    | while IFS= read -r old; do rm -f "$old" && echo "backup: removed $old (older than $KEEP days)"; done
fi
