#!/bin/sh
# Backup of the SSAM server state: the volumes /data/server (tokens.json with the token hashes, kernel.json, customers'
# workspaces, audit, server.log), /data/friction and /data/odc-features, in one tar.gz on this host, with a .sha256 and an
# .info (image, image id, revision, project, and mode: "online" when the server was running during the copy, else
# "stopped"). Uses compose.prod.yml and the .env next to this script; run it from anywhere. The cache volume (module index,
# readers' copy) is not copied: the server rebuilds it.
#
#   sh backup.sh [--online] [--dir <folder>] [--keep-days <n>] [--local-only]
#
# By default ssam-server stops for the copy, so the files are consistent, and starts again afterwards, also when the copy
# fails. Stopping cuts every call in progress (an o11_deliver can run 60 min) and closes the sessions and agent channels:
# keep it for an announced window. --online copies with the server running (tokens.json is replaced by an atomic rename
# and the logs only grow, so a torn file is at most the last line of a log): the daily cron uses it.
# Folder: --dir, else BACKUP_DIR (environment, then .env), else /var/backups/ssam-server; it must exist and be writable by
# the user running this (DEPLOY.md section 5 creates it). Retention: --keep-days, else BACKUP_KEEP_DAYS, else 0 (keep all);
# only ssam-state-* archives older than that are removed, never the one just made.
# After a good archive, unless --local-only (restore.sh's pre-restore copy):
#   - off-site copy when BACKUP_AGE_RECIPIENT and BACKUP_RCLONE_REMOTE are set (.env): the archive encrypted with age
#     for that recipient, streamed by rclone to <remote>/<archive>.age, plus its .sha256 and .info; a failed upload fails
#     the backup;
#   - heartbeat when BACKUP_HEARTBEAT_URL is set: one GET at the very end, so the monitor (healthchecks.io, Uptime Kuma
#     push, ...) alerts when a day passes without one (cron not running, disk full, any failure above).
# The archive holds customer data, customer names and the token hashes: keep it private, encrypt the off-site copy.
# Exit code 0 when the archive was written and checked (and copied off-site when configured).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
ENV_FILE=${SSAM_ENV_FILE:-$here/.env}
DOCKER=${DOCKER:-docker}
[ -f "$ENV_FILE" ] || { echo "backup: no $ENV_FILE (copy .env.prod.example to .env)" >&2; exit 2; }
# One KEY=value of the .env, never sourced (the file is not executed).
envval() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | sed 's/^"\(.*\)"$/\1/'; }
compose() { $DOCKER compose --env-file "$ENV_FILE" -f "$here/compose.prod.yml" "$@"; }

ONLINE=0
LOCAL_ONLY=0
DIR=${BACKUP_DIR:-$(envval BACKUP_DIR)}
KEEP=${BACKUP_KEEP_DAYS:-$(envval BACKUP_KEEP_DAYS)}
while [ $# -gt 0 ]; do
  case "$1" in
    --online) ONLINE=1; shift ;;
    --dir) DIR=$2; shift 2 ;;
    --keep-days) KEEP=$2; shift 2 ;;
    --local-only) LOCAL_ONLY=1; shift ;;
    *) echo "backup: unknown argument $1" >&2; exit 2 ;;
  esac
done
DIR=${DIR:-/var/backups/ssam-server}
KEEP=${KEEP:-0}
case "$KEEP" in ''|*[!0-9]*) echo "backup: --keep-days must be a number of days" >&2; exit 2 ;; esac
AGE_RECIPIENT=${BACKUP_AGE_RECIPIENT:-$(envval BACKUP_AGE_RECIPIENT)}
RCLONE_REMOTE=${BACKUP_RCLONE_REMOTE:-$(envval BACKUP_RCLONE_REMOTE)}
HEARTBEAT=${BACKUP_HEARTBEAT_URL:-$(envval BACKUP_HEARTBEAT_URL)}
if [ "$LOCAL_ONLY" = 1 ]; then AGE_RECIPIENT= RCLONE_REMOTE= HEARTBEAT=; fi
if [ -n "$AGE_RECIPIENT$RCLONE_REMOTE" ]; then
  [ -n "$AGE_RECIPIENT" ] && [ -n "$RCLONE_REMOTE" ] || { echo "backup: the off-site copy needs both BACKUP_AGE_RECIPIENT and BACKUP_RCLONE_REMOTE" >&2; exit 2; }
  for tool in age rclone; do command -v "$tool" >/dev/null 2>&1 || { echo "backup: the off-site copy needs $tool on this host (sudo apt-get install -y age rclone)" >&2; exit 2; }; done
fi

# The folder is created once, with its owner, by DEPLOY.md section 5; here it must already be writable (a cron job that
# cannot write there would otherwise fail every night).
umask 077
if [ ! -d "$DIR" ]; then
  mkdir -p "$DIR" 2>/dev/null || { echo "backup: cannot create $DIR as $(id -un); create it once: sudo install -d -o $(id -un) -g $(id -gn) -m 0700 $DIR" >&2; exit 2; }
fi
[ -w "$DIR" ] || { echo "backup: $DIR is not writable by $(id -un); fix it once: sudo chown $(id -un):$(id -gn) $DIR && sudo chmod 0700 $DIR" >&2; exit 2; }
stamp=$(date -u +%Y%m%dT%H%M%SZ)
out="$DIR/ssam-state-$stamp.tar.gz"
was_running=0
finish() {
  status=$?
  rm -f "$out.partial"
  if [ "$was_running" = 1 ]; then
    compose start ssam-server >/dev/null 2>&1 && echo "backup: ssam-server started again" || echo "backup: START ssam-server BY HAND (docker compose -f compose.prod.yml start ssam-server)" >&2
  fi
  [ "$status" = 0 ] || echo "backup: FAILED (exit $status) at $(date -u +%Y-%m-%dT%H:%M:%SZ)" >&2
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
# What made the state: the image of the server container (its id, its revision label, its registry digest when pulled).
container=$(compose ps -a -q ssam-server 2>/dev/null | head -n 1)
image_id=$( [ -n "$container" ] && $DOCKER inspect --format '{{.Image}}' "$container" 2>/dev/null || true)
{
  echo "created $stamp"
  project=${COMPOSE_PROJECT_NAME:-$(envval COMPOSE_PROJECT_NAME)}
  echo "project ${project:-ssam-prod}"
  echo "image $(envval SSAM_IMAGE):$(envval SSAM_IMAGE_TAG)"
  if [ -n "$image_id" ]; then
    echo "image-id $image_id"
    echo "revision $($DOCKER image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id" 2>/dev/null || echo unknown)"
    echo "repo-digests $($DOCKER image inspect --format '{{join .RepoDigests " "}}' "$image_id" 2>/dev/null)"
  fi
  echo "mode $mode"
} > "$out.info"
echo "backup: $out ($(wc -c < "$out" | awk '{ printf "%.1f MB", $1 / 1048576 }')), sha256 $(cut -d' ' -f1 "$out.sha256")"

# The server is no longer needed: start it before the off-site upload (the trap would do it too).
if [ "$was_running" = 1 ]; then
  compose start ssam-server >/dev/null && echo "backup: ssam-server started again" && was_running=0
fi

if [ -n "$AGE_RECIPIENT" ]; then
  name=$(basename "$out")
  age -r "$AGE_RECIPIENT" < "$out" | rclone rcat "$RCLONE_REMOTE/$name.age"
  rclone copyto "$out.sha256" "$RCLONE_REMOTE/$name.sha256"
  rclone copyto "$out.info" "$RCLONE_REMOTE/$name.info"
  echo "backup: off-site copy $RCLONE_REMOTE/$name.age (age, recipient ${AGE_RECIPIENT%"${AGE_RECIPIENT#????????????}"}...)"
fi

if [ "$KEEP" -gt 0 ]; then
  find "$DIR" -maxdepth 1 -type f -name 'ssam-state-*.tar.gz*' -mtime +"$KEEP" ! -name "ssam-state-$stamp.*" -print \
    | while IFS= read -r old; do rm -f "$old" && echo "backup: removed $old (older than $KEEP days)"; done
fi

if [ -n "$HEARTBEAT" ]; then
  if command -v curl >/dev/null 2>&1 && curl -fsS -m 10 --retry 3 -o /dev/null "$HEARTBEAT"; then
    echo "backup: heartbeat sent"
  else
    echo "backup: the heartbeat did not go out (curl missing or the URL failed); the monitor will alert" >&2
  fi
fi
