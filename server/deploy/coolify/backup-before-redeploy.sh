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

remote='set -eu
umask 077
work=$(mktemp -d)
trap '"'"'rm -rf "$work"'"'"' EXIT HUP INT TERM
tar -x -C "$work" -f -
dir='"$base/pre-$label"'
mkdir -p "$dir"
SSAM_BACKUP_REQUIRE_DATABASE=1 sh "$work/ssamctl.sh" backup "$dir"
tokens=$(ls -1t "$dir"/ssam-tokens-*.sql.gz 2>/dev/null | head -n 1)
state=$(ls -1t "$dir"/ssam-state-*.tar.gz 2>/dev/null | head -n 1)
[ -n "$tokens" ] && [ -s "$tokens" ] || { echo "backup-before-redeploy: BACKUP_DUMP_EMPTY: no licenses dump in $dir" >&2; exit 2; }
[ -n "$state" ] && [ -s "$state" ] || { echo "backup-before-redeploy: BACKUP_STATE_EMPTY: no volume archive in $dir" >&2; exit 2; }
for table in server_tokens schema_migrations; do
  gzip -dc "$tokens" | grep -q "^CREATE TABLE \(public\.\)\{0,1\}$table (" || { echo "backup-before-redeploy: BACKUP_DUMP_NO_LICENSE_TABLES: $tokens has no $table" >&2; exit 2; }
done
version=$(gzip -dc "$tokens" | sed -n "s/^-- Dumped from database version \([0-9.]*\).*/\1/p" | head -n 1)
echo "OK: licenses $tokens ($(wc -c < "$tokens") bytes, PostgreSQL ${version:-?}), volumes $state ($(du -h "$state" | cut -f1))"'

# shellcheck disable=SC2086
tar -C "$here" -cf - ssamctl.sh window-backup.sh | $SSH "$remote"
