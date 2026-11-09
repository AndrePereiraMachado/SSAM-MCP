#!/bin/sh
# Owner-only, before every Stop/Redeploy in Coolify: the licenses database and the whole window's volumes, on the VPS, in
# /var/backups/ssam-server/pre-<label>. Run from this machine (Git Bash), from the deploy/coolify folder of the commit
# going up:
#
#   sh backup-before-redeploy.sh <label>          label: letters, digits, . _ - (the short sha of the release)
#
# It sends ssamctl.sh and window-backup.sh of THIS folder over SSH to a temporary folder on the VPS (removed at the end)
# and runs `ssamctl.sh backup` there with SSAM_BACKUP_REQUIRE_DATABASE=1. So the licenses come from the server's own
# SSAM_DATABASE_URL (the Coolify PostgreSQL resource), dumped by the database's own image (same major version), and
# the backup is refused loudly (exit 2, BACKUP_* code) when the dump is empty, has no license tables (server_tokens,
# schema_migrations), or pg_dump is older than the server. The earlier copy of this script in C:\t\r3\img dumped the
# update_server's PostgreSQL (postgres-88dw...) instead, and `ssamctl.sh backup` with pg_dump 17 against 18.6 wrote an
# empty file: neither held the licenses (2026-11-01).
# Files in the folder: ssam-tokens-<stamp>.sql.gz (licenses), ssam-db-update_server-<stamp>.sql.gz and
# ssam-db-coolify-<stamp>.sql.gz (each dumped by the pg_dump inside its own container), ssam-service-<stamp>.tar.gz
# (Coolify compose + .env of the resource), ssam-state-<stamp>.tar.gz (every volume of the resource, for ssamctl.sh
# restore) and its .info, each with .sha256, and state-<stamp>.tar.gz (server-state and friction of the default backend, the format
# rollback-kernels.sh reads the kernels of the way back from).
# The SSH command is SSAM_SSH (default below); the base folder on the VPS is SSAM_BACKUP_BASE. No value of the
# environment of any container is printed: the URL stays inside the VPS.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
die() { echo "backup-before-redeploy: $*" >&2; exit 2; }
label=${1:-}
case "$label" in ''|*[!A-Za-z0-9._-]*) die "usage: sh backup-before-redeploy.sh <label> (letters, digits, . _ -)";; esac
base=${SSAM_BACKUP_BASE:-/var/backups/ssam-server}
case "$base" in /*) ;; *) die "SSAM_BACKUP_BASE must be an absolute path";; esac
case "$base" in *[!A-Za-z0-9._/-]*) die "SSAM_BACKUP_BASE may hold only letters, digits and . _ - /";; esac
SSH=${SSAM_SSH:-ssh -i $HOME/.ssh/ssam_vps -o ConnectTimeout=15 root@187.127.8.241}
for f in ssamctl.sh window-backup.sh; do [ -f "$here/$f" ] || die "no $here/$f"; done

remote=$(cat <<'REMOTE'
set -eu
umask 077
D=${DOCKER:-docker}
say() { echo "backup-before-redeploy: $*" >&2; exit 2; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
tar -x -C "$work" -f -
mkdir -p "$dir"
SSAM_BACKUP_REQUIRE_DATABASE=1 sh "$work/ssamctl.sh" backup "$dir"
tokens=$(ls -1t "$dir"/ssam-tokens-*.sql.gz 2>/dev/null | head -n 1)
window=$(ls -1t "$dir"/ssam-state-*.tar.gz 2>/dev/null | head -n 1)
[ -n "$tokens" ] && [ -s "$tokens" ] || say "BACKUP_DUMP_EMPTY: no licenses dump in $dir"
[ -n "$window" ] && [ -s "$window" ] || say "BACKUP_STATE_EMPTY: no window archive in $dir"
[ -s "$window.info" ] || say "BACKUP_INCOMPLETE: $window has no .info (the set did not finish)"
dbs=
for kind in update_server coolify; do
  f=$(ls -1t "$dir"/ssam-db-$kind-*.sql.gz 2>/dev/null | head -n 1)
  [ -n "$f" ] && [ -s "$f" ] || say "BACKUP_DUMP_EMPTY: no $kind dump in $dir"
  dbs="$dbs, $kind $f ($(wc -c < "$f" | tr -d " ") bytes)"
done
for table in server_tokens schema_migrations; do
  gzip -dc "$tokens" | grep -q "^CREATE TABLE \(public\.\)\{0,1\}$table (" || say "BACKUP_DUMP_NO_LICENSE_TABLES: $tokens has no $table"
done
version=$(gzip -dc "$tokens" | sed -n 's/^-- Dumped from database version \([0-9.]*\).*/\1/p' | head -n 1)
# The server-state and friction of the default backend in the layout rollback-kernels.sh reads (state/..., friction/...).
c=$($D ps -a --filter label=ssam.backend=true --filter label=ssam.default=true --format '{{.Names}}' | head -n 1)
[ -n "$c" ] || say "no default backend (label ssam.default=true)"
vol() { $D inspect --format "{{range .Mounts}}{{if eq .Destination \"$2\"}}{{.Name}}{{end}}{{end}}" "$1"; }
state_volume=$(vol "$c" /data/server); friction_volume=$(vol "$c" /data/friction)
[ -n "$state_volume" ] && [ -n "$friction_volume" ] || say "the default backend $c has no /data/server or /data/friction volume"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
# An online copy: GNU tar exit 1 (a file changed while it was read, e.g. a server.log that grows) keeps the archive, as
# window-backup.sh does; any other failure stops with a code, and the archive gets its final name only once it reads back.
part=$dir/state-$stamp.tar.gz.partial
$D run --rm --network none --security-opt no-new-privileges:true --cap-drop ALL --user 10001:10001 \
  -v "$state_volume:/source/state:ro" -v "$friction_volume:/source/friction:ro" --entrypoint sh \
  "$($D inspect --format '{{.Image}}' "$c")" -c 'tar -czf - -C /source state friction; s=$?; if [ "$s" -eq 1 ]; then echo "backup-before-redeploy: a file changed while it was read (online copy, tar exit 1); kept" >&2; s=0; fi; exit "$s"' \
  < /dev/null > "$part" || { rm -f "$part"; say "BACKUP_STATE_FAILED: the kernels state copy of $c failed"; }
[ -s "$part" ] && gzip -t "$part" || { rm -f "$part"; say "BACKUP_STATE_EMPTY: state-$stamp.tar.gz is empty or does not read back"; }
mv "$part" "$dir/state-$stamp.tar.gz"
(cd "$dir" && sha256sum "state-$stamp.tar.gz" > "state-$stamp.tar.gz.sha256")
echo "OK: licenses $tokens ($(wc -c < "$tokens") bytes, PostgreSQL ${version:-?}), window $window ($(du -h "$window" | cut -f1)), kernels state $dir/state-$stamp.tar.gz ($(du -h "$dir/state-$stamp.tar.gz" | cut -f1))$dbs"
REMOTE
)

# shellcheck disable=SC2086
tar -C "$here" -cf - ssamctl.sh window-backup.sh | $SSH "dir='$base/pre-$label'
$remote"
