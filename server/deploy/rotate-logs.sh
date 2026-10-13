#!/bin/sh
# Log rotation and retention inside the state volume, for cron (DEPLOY.md section 10). Runs in the ssam-ops container
# (the server image, uid 10001, no network, read-only root), so the paths and owners are right by construction and nothing
# on the host has to walk /var/lib/docker (root 0710: a host logrotate running as uid 10001 cannot reach the volume).
# Uses compose.prod.yml and the .env next to this script; run it from anywhere.
#
#   sh rotate-logs.sh [--log-keep-days <n>] [--audit-keep-days <n>] [--quality-keep-days <n>] [--index-keep-days <n>]
#
#   - /data/server/server.log -> server.log.<stamp>.gz when not empty. The server appends with appendFileSync, which
#     opens the file for every line, so the next line after the rename starts a new server.log (a line written during the
#     rename lands in the old file, which is compressed 2 s later);
#   - rotated logs older than LOG_KEEP_DAYS (default 56) are removed;
#   - audit-<yyyymmdd>.jsonl of past days (UTC dates; the server writes only today's) are compressed, and with
#     AUDIT_KEEP_DAYS > 0 (default 0: keep all) the compressed ones older than that are removed;
#   - quality-<yyyymmdd>.jsonl (the quality records: codes, counts and times per tool call, DEPLOY.md section 10) of past
#     days are compressed the same way, today's file is never touched, and with QUALITY_KEEP_DAYS > 0 (default 0: keep
#     all) the compressed ones older than that are removed;
#   - with INDEX_KEEP_DAYS > 0 (default 0: off), module index files of /data/cache/module-index not written for that many
#     days are removed (a cache: the next ssam_map of that capture indexes it again).
# Values: flags, else the environment, else .env. Exit code 0 when everything ran.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
ENV_FILE=${SSAM_ENV_FILE:-$here/.env}
DOCKER=${DOCKER:-docker}
[ -f "$ENV_FILE" ] || { echo "rotate: no $ENV_FILE (copy .env.prod.example to .env)" >&2; exit 2; }
envval() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | sed 's/^"\(.*\)"$/\1/'; }
compose() { $DOCKER compose --env-file "$ENV_FILE" -f "$here/compose.prod.yml" "$@"; }

LOG_KEEP=${LOG_KEEP_DAYS:-$(envval LOG_KEEP_DAYS)}
AUDIT_KEEP=${AUDIT_KEEP_DAYS:-$(envval AUDIT_KEEP_DAYS)}
QUALITY_KEEP=${QUALITY_KEEP_DAYS:-$(envval QUALITY_KEEP_DAYS)}
INDEX_KEEP=${INDEX_KEEP_DAYS:-$(envval INDEX_KEEP_DAYS)}
while [ $# -gt 0 ]; do
  case "$1" in
    --log-keep-days) LOG_KEEP=$2; shift 2 ;;
    --audit-keep-days) AUDIT_KEEP=$2; shift 2 ;;
    --quality-keep-days) QUALITY_KEEP=$2; shift 2 ;;
    --index-keep-days) INDEX_KEEP=$2; shift 2 ;;
    *) echo "rotate: unknown argument $1" >&2; exit 2 ;;
  esac
done
LOG_KEEP=${LOG_KEEP:-56} AUDIT_KEEP=${AUDIT_KEEP:-0} QUALITY_KEEP=${QUALITY_KEEP:-0} INDEX_KEEP=${INDEX_KEEP:-0}
for n in "$LOG_KEEP" "$AUDIT_KEEP" "$QUALITY_KEEP" "$INDEX_KEEP"; do
  case "$n" in ''|*[!0-9]*) echo "rotate: the day counts must be numbers" >&2; exit 2 ;; esac
done

compose run --rm --no-deps -T -e "LOG_KEEP=$LOG_KEEP" -e "AUDIT_KEEP=$AUDIT_KEEP" -e "QUALITY_KEEP=$QUALITY_KEEP" -e "INDEX_KEEP=$INDEX_KEEP" ssam-ops sh -eu -c '
cd /data/server
stamp=$(date -u +%Y%m%dT%H%M%SZ)
if [ -s server.log ]; then
  mv server.log "server.log.$stamp"
  sleep 2
  gzip "server.log.$stamp"
  echo "rotate: server.log -> server.log.$stamp.gz"
fi
old=$(find . -maxdepth 1 -type f -name "server.log.*.gz" -mtime +"$LOG_KEEP" -print)
for f in $old; do rm -f "$f" && echo "rotate: removed $f (older than $LOG_KEEP days)"; done
today="audit-$(date -u +%Y%m%d).jsonl"
for f in audit-*.jsonl; do
  [ -f "$f" ] && [ "$f" != "$today" ] || continue
  gzip "$f" && echo "rotate: $f -> $f.gz" || echo "rotate: could not compress $f" >&2
done
if [ "$AUDIT_KEEP" -gt 0 ]; then
  old=$(find . -maxdepth 1 -type f -name "audit-*.jsonl.gz" -mtime +"$AUDIT_KEEP" -print)
  for f in $old; do rm -f "$f" && echo "rotate: removed $f (older than $AUDIT_KEEP days)"; done
fi
today="quality-$(date -u +%Y%m%d).jsonl"
for f in quality-*.jsonl; do
  [ -f "$f" ] && [ "$f" != "$today" ] || continue
  gzip "$f" && echo "rotate: $f -> $f.gz" || echo "rotate: could not compress $f" >&2
done
if [ "$QUALITY_KEEP" -gt 0 ]; then
  old=$(find . -maxdepth 1 -type f -name "quality-*.jsonl.gz" -mtime +"$QUALITY_KEEP" -print)
  for f in $old; do rm -f "$f" && echo "rotate: removed $f (older than $QUALITY_KEEP days)"; done
fi
if [ "$INDEX_KEEP" -gt 0 ] && [ -d /data/cache/module-index ]; then
  n=$(find /data/cache/module-index -type f -mtime +"$INDEX_KEEP" -print -exec rm -f {} + | wc -l)
  echo "rotate: removed $n module index files (older than $INDEX_KEEP days)"
fi
echo "rotate: done; /data/server $(du -sh /data/server | cut -f1), /data/cache $(du -sh /data/cache | cut -f1)"
'
