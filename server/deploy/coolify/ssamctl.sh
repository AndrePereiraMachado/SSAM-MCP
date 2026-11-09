#!/bin/sh
# The by-hand operations of the SSAM server on a VPS run by Coolify (COOLIFY.md), over SSH, with docker alone: no compose
# file, no .env. Everything is read from the running (or stopped) ssam-server container Coolify created: its image (tag
# and digest) and its four volumes. The admin and ops commands then run one-off containers of that same image, without
# network, as the compose.prod.yml services ssam-admin and ssam-ops would.
#
#   sh ssamctl.sh status                                   image, volumes, health of the server container
#   sh ssamctl.sh pull                                     pulls the image reference the server runs (latest): then Redeploy/Restart in Coolify
#   sh ssamctl.sh token issue --customer "Name" --days 30 --lanes odc,o11
#   sh ssamctl.sh token list | revoke --id tok_... | agent-rotate --id tok_... | import --from /data/server/tokens.json
#   sh ssamctl.sh db migrate | status                      the tokens' database (SSAM_DATABASE_URL of the server)
#   sh ssamctl.sh psql [<sql>]                             a psql session (or one statement) on the tokens' database
#   sh ssamctl.sh kernel print [released|previous|<tag>] <release-record.json>   the kernel.json of an image, from the record
#   sh ssamctl.sh kernel check <kernel.json>               the pair check inside the image that runs (0 = pair-ok)
#   sh ssamctl.sh kernel write <kernel.json>               writes /data/server/kernel.json and empties the version caches
#   sh ssamctl.sh kernel show                              the kernel.json in the volume
#   sh ssamctl.sh features put <Features.plain.xml>        writes /data/odc-features/Features.plain.xml
#   sh ssamctl.sh put <file> <path under /data>            any file into the state volumes (as uid 10001)
#   sh ssamctl.sh ops <command...>                         a shell command in the image over the volumes, no network
#   sh ssamctl.sh backup [--keep-days <n>] [<folder>]      3 databases + every volume of the resource (+ .sha256, .info)
#   sh ssamctl.sh restore <archive.tar.gz> [<tokens.sql.gz>]   volumes (and licenses) back, all STOPPED (Coolify: Stop)
#   sh ssamctl.sh logs [<n>]                               the last n lines of the server's log (default 50)
#   sh ssamctl.sh console status | logs [<n>] | audit [<n>]   the owner console (COOLIFY.md 11): state, its log, its audit
#
# The container is found by its compose service label (com.docker.compose.service=ssam-server); SSAM_CONTAINER names it
# explicitly when the host runs more than one. kernel print/check need ../kernel-pair-check.mjs next to this folder (the
# deploy folder of the approved commit, as DEPLOY.md section 5 copies it).
# Tokens live in the Postgres of SSAM_DATABASE_URL (the server's environment; a database resource of Coolify, COOLIFY.md
# 6): the token commands run on the server's network with that URL; db, psql, the dump of backup (pg_dump) and the load of
# restore (psql) run a one-off container of the database's own postgres image (pg_image) on that network, against that
# URL; backup refuses an empty dump, a dump without the license tables and a pg_dump older than the server. A
# server without SSAM_DATABASE_URL keeps tokens.json, and the same commands work on it (without dump, psql and db).
# backup (also the daily cron, COOLIFY.md 8) writes, with one stamp: ssam-tokens-<stamp>.sql.gz (licenses, above),
# ssam-db-update_server-<stamp>.sql.gz and ssam-db-coolify-<stamp>.sql.gz (pg_dump run INSIDE each database container,
# so always its own major, refused unless server and pg_dump majors match and the expected tables are in the dump),
# ssam-service-<stamp>.tar.gz (Coolify's docker-compose.yml and .env of the resource), and ssam-state-<stamp>.tar.gz with
# every named volume of the resource: the volumes mounted by every container of the default backend's compose project
# (backends, router, console) plus every <project>_* volume nothing mounts now; anonymous volumes are listed in the .info
# and skipped (a Redeploy recreates them). Each file has a .sha256; the .info is written last, so a set without it is
# incomplete. SSAM_BACKUP_DATABASES (default "licenses update_server coolify") chooses the databases; every one listed
# must dump, or the backup fails (exit 2, BACKUP_* code). --keep-days (else BACKUP_KEEP_DAYS) removes this folder's sets
# older than that after a good run; the run is refused when the disk has less than SSAM_BACKUP_MIN_FREE_GB (default 20)
# GiB free or less than 3 times the newest archive. The work folder is inside the backup folder, never /tmp (tmpfs).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
# Git Bash on Windows (the local rehearsal, COOLIFY.md 10): MSYS would rewrite the container paths of -v and of the
# commands (/data/server) into Windows paths; host paths go through cygpath instead. No-ops on Linux.
DOCKER="env MSYS_NO_PATHCONV=1 ${DOCKER:-docker}"
hostpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

die() { echo "ssamctl: $*" >&2; exit 2; }

containers() {
  $DOCKER ps -a --filter label=ssam.backend=true --format '{{.Names}}'
}
container() {
  if [ -n "${SSAM_CONTAINER:-}" ]; then printf '%s' "$SSAM_CONTAINER"; return; fi
  if [ -n "${SSAM_VERSION:-}" ]; then
    case "$SSAM_VERSION" in
      odc=*|o11=*) lane=${SSAM_VERSION%%=*}; value=${SSAM_VERSION#*=}; found=$($DOCKER ps -a --filter label=ssam.backend=true --filter "label=ssam.$lane=$value" --format '{{.Names}}');;
      *) found=$({ $DOCKER ps -a --filter label=ssam.backend=true --filter "label=ssam.odc=$SSAM_VERSION" --format '{{.Names}}'; $DOCKER ps -a --filter label=ssam.backend=true --filter "label=ssam.o11=$SSAM_VERSION" --format '{{.Names}}'; } | sort -u);;
    esac
    [ -n "$found" ] && [ "$(printf '%s\n' "$found" | wc -l)" -eq 1 ] || die "version must identify exactly one container; candidates: ${found:-none}. SSAM_CONTAINER takes precedence over --version and SSAM_VERSION"
    printf '%s' "$found"; return
  fi
  if [ -z "${SSAM_CONTAINER:-}" ]; then
    found=$($DOCKER ps -a --filter label=ssam.backend=true --filter label=ssam.default=true --format '{{.Names}}')
    if [ -n "$found" ]; then [ "$(printf '%s\n' "$found" | wc -l)" -eq 1 ] || die "multiple defaults; set SSAM_CONTAINER"; printf '%s' "$found"; return; fi
  fi
  if [ -n "${SSAM_CONTAINER:-}" ]; then printf '%s' "$SSAM_CONTAINER"; return; fi
  found=$($DOCKER ps -a --filter label=com.docker.compose.service=ssam-server --format '{{.Names}}' | head -n 2)
  [ -n "$found" ] || die "no ssam-server container on this host (deploy it in Coolify first, or set SSAM_CONTAINER)"
  [ "$(printf '%s\n' "$found" | wc -l)" -eq 1 ] || die "more than one ssam-server container: $(printf '%s' "$found" | tr '\n' ' '); set SSAM_CONTAINER"
  printf '%s' "$found"
}
# The image the container runs, as repo@digest when the registry gave one, else repo:tag.
image_of() {
  digest=$($DOCKER inspect --format '{{index .Image}}' "$1")
  printf '%s' "$digest"
}
# The volume mounted at $2 in container $1.
volume_of() {
  name=$($DOCKER inspect --format '{{range .Mounts}}{{if eq .Destination "'"$2"'"}}{{.Name}}{{end}}{{end}}' "$1")
  [ -n "$name" ] || die "the container $1 has no volume at $2"
  printf '%s' "$name"
}
mounts() {
  c=$1
  printf -- '-v %s:/data/server -v %s:/data/friction -v %s:/data/odc-features -v %s:/data/cache' \
    "$(volume_of "$c" /data/server)" "$(volume_of "$c" /data/friction)" "$(volume_of "$c" /data/odc-features)" "$(volume_of "$c" /data/cache)"
}
# The value of an environment variable of container $1 (empty when unset), its first network, and the postgres container
# of the same compose project (empty without one).
env_of() { $DOCKER inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$1" | sed -n "s/^$2=//p" | head -n 1; }
# The network of the server that reaches the database: the predefined network of Coolify ("coolify") when the container
# is on it, else its first network.
network_of() {
  nets=$($DOCKER inspect --format '{{range $k, $v := .NetworkSettings.Networks}}{{println $k}}{{end}}' "$1")
  printf '%s\n' "$nets" | grep -x coolify || printf '%s\n' "$nets" | head -n 1
}
# The postgres client tools (pg_dump, psql). pg_dump refuses a server of a newer major version, and on 2026-11-01 the
# pinned 17 client against the Coolify database (18.6) left an empty dump that looked like a backup. So the client is the
# image of the database container itself when it runs on this host (the host of SSAM_DATABASE_URL is that container's
# name on the coolify network): always the server's own major version. PG_IMAGE (environment) forces an image; the
# pinned fallback below is only for a database that is not a container here, and backup refuses it when it is older
# than the server.
PG_IMAGE_SET=${PG_IMAGE:-}
PG_IMAGE_FALLBACK=postgres:17.11-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24
db_url() { env_of "$1" SSAM_DATABASE_URL; }
# The host of a postgres URL (postgres://user:password@host:port/db), never printed with the rest of the URL.
db_host() { printf '%s' "$1" | sed -n 's#^[A-Za-z][A-Za-z0-9+.-]*://\([^@/]*@\)\{0,1\}\([^:/?]*\).*#\2#p'; }
# The container on this host named as the host of the server's SSAM_DATABASE_URL (empty when there is none).
db_container() {
  db_name=$(db_host "$(db_url "$1")")
  [ -n "$db_name" ] || return 0
  $DOCKER ps -a --filter "name=$db_name" --format '{{.Names}}' | grep -x -- "$db_name" | head -n 1 || true
}
pg_image() {
  if [ -n "$PG_IMAGE_SET" ]; then printf '%s' "$PG_IMAGE_SET"; return; fi
  db_found=$(db_container "$1")
  if [ -n "$db_found" ]; then $DOCKER inspect --format '{{.Image}}' "$db_found"; else printf '%s' "$PG_IMAGE_FALLBACK"; fi
}
# pg_tool <container> <tool> [args...]: the client tool (pg_image) on the server's network, with stdin and stdout as given.
pg_tool() { c=$1; shift; $DOCKER run --rm -i --network "$(network_of "$c")" --security-opt no-new-privileges:true --cap-drop ALL --user 70:70 -e HOME=/tmp "$(pg_image "$c")" "$@"; }
# The license tables a dump of the tokens' database must hold (migrations/0001-server-tokens.sql and db.mjs).
LICENSE_TABLES=${SSAM_LICENSE_TABLES:-server_tokens schema_migrations}
# dump_tokens <container> <url> <file.sql.gz>: the tokens' database as plain SQL, refused loudly (exit 2, nothing left
# with the final name) when the client is older than the server, when pg_dump fails, when the dump is empty, or when a
# license table is missing from it. A dump that is not a backup must never look like one.
dump_tokens() {
  dt_c=$1; dt_url=$2; dt_out=$3; dt_raw=$dt_out.partial
  rm -f "$dt_out" "$dt_raw"
  dt_server=$(pg_tool "$dt_c" psql "$dt_url" -XtAc 'show server_version_num' < /dev/null | tr -d '[:space:]') || true
  case "$dt_server" in ''|*[!0-9]*) die "BACKUP_DB_UNREACHABLE: could not read the version of the tokens' database (SSAM_DATABASE_URL of $dt_c); no dump was made";; esac
  dt_client=$(pg_tool "$dt_c" pg_dump --version < /dev/null | sed -n 's/^pg_dump (PostgreSQL) \([0-9][0-9]*\).*/\1/p' | head -n 1) || true
  case "$dt_client" in ''|*[!0-9]*) die "BACKUP_PG_DUMP_MISSING: the client image $(pg_image "$dt_c") has no pg_dump; no dump was made";; esac
  dt_major=$((dt_server / 10000))
  [ "$dt_client" -ge "$dt_major" ] || die "BACKUP_PG_DUMP_TOO_OLD: pg_dump $dt_client cannot dump a PostgreSQL $dt_major server; run where the database container is visible, or set PG_IMAGE to a postgres:$dt_major image. No dump was made"
  if ! pg_tool "$dt_c" pg_dump "$dt_url" --no-owner --no-privileges < /dev/null > "$dt_raw"; then rm -f "$dt_raw"; die "BACKUP_DUMP_FAILED: pg_dump $dt_client against PostgreSQL $dt_major failed; no dump was kept"; fi
  [ -s "$dt_raw" ] || { rm -f "$dt_raw"; die "BACKUP_DUMP_EMPTY: pg_dump wrote nothing; no dump was kept"; }
  for dt_table in $LICENSE_TABLES; do
    grep -q "^CREATE TABLE \(public\.\)\{0,1\}$dt_table (" "$dt_raw" || { rm -f "$dt_raw"; die "BACKUP_DUMP_NO_LICENSE_TABLES: the dump has no table $dt_table: SSAM_DATABASE_URL does not point at the licenses database; no dump was kept"; }
  done
  dt_rows=$(awk '/^COPY (public\.)?server_tokens /{on=1;next} on&&/^\\\.$/{on=0} on{n++} END{print n+0}' "$dt_raw")
  gzip -c "$dt_raw" > "$dt_raw.gz" && gzip -t "$dt_raw.gz" || { rm -f "$dt_raw" "$dt_raw.gz"; die "BACKUP_DUMP_FAILED: could not compress the dump"; }
  rm -f "$dt_raw"; mv "$dt_raw.gz" "$dt_out"
  echo "backup: licenses database: PostgreSQL $dt_major dumped by pg_dump $dt_client, tables: $LICENSE_TABLES, server_tokens rows: $dt_rows"
}
# The other PostgreSQL databases of the host, dumped by the pg_dump INSIDE their own container (its own major, the same
# binaries as the server; the credentials stay in that container's environment). The tables each dump must hold:
UPDATE_SERVER_TABLES=${SSAM_UPDATE_SERVER_TABLES:-releases artifacts apps _prisma_migrations}
COOLIFY_TABLES=${SSAM_COOLIFY_TABLES:-migrations servers instance_settings applications services}
# local_db_container <kind>: the update_server's database is the running postgres container whose POSTGRES_DB is
# update_server (dist.ssam.pro; exactly one); Coolify's own is coolify-db. SSAM_UPDATE_DB_CONTAINER and
# SSAM_COOLIFY_DB_CONTAINER name them explicitly.
local_db_container() {
  case "$1" in
    update_server)
      if [ -n "${SSAM_UPDATE_DB_CONTAINER:-}" ]; then printf '%s' "$SSAM_UPDATE_DB_CONTAINER"; return; fi
      ldc_found=
      for ldc in $($DOCKER ps --format '{{.Names}}'); do
        case "$($DOCKER inspect --format '{{.Config.Image}}' "$ldc")" in *postgres*) ;; *) continue;; esac
        [ "$(env_of "$ldc" POSTGRES_DB)" = update_server ] && ldc_found="$ldc_found $ldc"
      done
      set -- $ldc_found
      [ $# -eq 1 ] || die "BACKUP_DB_NOT_FOUND: expected one running postgres container with POSTGRES_DB=update_server, found ${*:-none}; set SSAM_UPDATE_DB_CONTAINER"
      printf '%s' "$1";;
    coolify) printf '%s' "${SSAM_COOLIFY_DB_CONTAINER:-coolify-db}";;
    *) die "unknown database kind $1";;
  esac
}
# dump_local_db <kind> <container> <tables> <file.sql.gz>: plain SQL, refused loudly (exit 2, nothing with the final name)
# when the container is not running, when its pg_dump and server majors differ (or the dump header says so), when
# pg_dump fails, when the dump is empty, or when an expected table is missing.
dump_local_db() {
  dl_kind=$1; dl_c=$2; dl_tables=$3; dl_out=$4; dl_raw=$4.partial
  rm -f "$dl_out" "$dl_raw"
  [ "$($DOCKER inspect --format '{{.State.Running}}' "$dl_c" 2>/dev/null || true)" = true ] || die "BACKUP_DB_NOT_FOUND: the $dl_kind database container $dl_c is not running on this host; no dump was made"
  dl_versions=$($DOCKER exec "$dl_c" sh -c 'postgres --version; pg_dump --version' < /dev/null 2>/dev/null) || true
  dl_server=$(printf '%s\n' "$dl_versions" | sed -n 's/^postgres (PostgreSQL) \([0-9][0-9]*\).*/\1/p' | head -n 1)
  dl_client=$(printf '%s\n' "$dl_versions" | sed -n 's/^pg_dump (PostgreSQL) \([0-9][0-9]*\).*/\1/p' | head -n 1)
  [ -n "$dl_server" ] && [ "$dl_server" = "$dl_client" ] || die "BACKUP_PG_DUMP_MAJOR: the $dl_kind container $dl_c has PostgreSQL ${dl_server:-?} and pg_dump ${dl_client:-?}; a dump needs the same major. No dump was made"
  if ! $DOCKER exec "$dl_c" sh -c 'exec pg_dump -U "${POSTGRES_USER:-postgres}" --no-owner --no-privileges "${POSTGRES_DB:-postgres}"' < /dev/null > "$dl_raw"; then
    rm -f "$dl_raw"; die "BACKUP_DUMP_FAILED: pg_dump of the $dl_kind database ($dl_c) failed; no dump was kept"
  fi
  [ -s "$dl_raw" ] || { rm -f "$dl_raw"; die "BACKUP_DUMP_EMPTY: pg_dump of the $dl_kind database wrote nothing; no dump was kept"; }
  dl_from=$(sed -n 's/^-- Dumped from database version \([0-9][0-9]*\).*/\1/p' "$dl_raw" | head -n 1)
  dl_by=$(sed -n 's/^-- Dumped by pg_dump version \([0-9][0-9]*\).*/\1/p' "$dl_raw" | head -n 1)
  [ "$dl_from" = "$dl_server" ] && [ "$dl_by" = "$dl_server" ] || { rm -f "$dl_raw"; die "BACKUP_PG_DUMP_MAJOR: the $dl_kind dump says server ${dl_from:-?}, pg_dump ${dl_by:-?} (expected $dl_server); no dump was kept"; }
  for dl_table in $dl_tables; do
    grep -q "^CREATE TABLE \(public\.\)\{0,1\}\"\{0,1\}$dl_table\"\{0,1\} (" "$dl_raw" || { rm -f "$dl_raw"; die "BACKUP_DUMP_NO_EXPECTED_TABLES: the $dl_kind dump ($dl_c) has no table $dl_table: wrong database; no dump was kept"; }
  done
  gzip -c "$dl_raw" > "$dl_raw.gz" && gzip -t "$dl_raw.gz" || { rm -f "$dl_raw" "$dl_raw.gz"; die "BACKUP_DUMP_FAILED: could not compress the $dl_kind dump"; }
  dl_bytes=$(wc -c < "$dl_raw" | tr -d ' ')
  rm -f "$dl_raw"; mv "$dl_raw.gz" "$dl_out"
  echo "backup: $dl_kind database: container $dl_c, PostgreSQL $dl_server dumped by pg_dump $dl_client, $dl_bytes bytes, tables: $dl_tables"
}
# The docker run options that give a one-off container the tokens' store of the server: the network and the URL when the
# server has a database, nothing (tokens.json in the volume) otherwise.
store_opts() {
  url=$(env_of "$1" SSAM_DATABASE_URL)
  if [ -n "$url" ]; then printf -- '--network %s -e SSAM_DATABASE_URL=%s' "$(network_of "$1")" "$url"; else printf -- '--network none'; fi
}
backup_exit_note() { [ "$1" = 0 ] || echo "backup: FAILED (exit $1) at $(date -u +%Y-%m-%dT%H:%M:%SZ)" >&2; }
hardened="--rm --init --security-opt no-new-privileges:true --cap-drop ALL --user 10001:10001"
# A terminal for the interactive commands only when there is one (a script or a pipe gets -i).
tty=-i; [ -t 0 ] && [ -t 1 ] && tty=-it

. "$here/window-backup.sh"
cmd=${1:-}; [ $# -gt 0 ] && shift
case "$cmd" in
  status)
    found=$(containers); [ -n "$found" ] || found=$(container)
    for c in $found; do
    echo "container: $c"
    echo "image:     $($DOCKER inspect --format '{{.Config.Image}}' "$c") (id $(image_of "$c"))"
    echo "digest:    $($DOCKER image inspect --format '{{range .RepoDigests}}{{.}} {{end}}' "$(image_of "$c")" 2>/dev/null || echo '(not from a registry)')"
    echo "version:   $($DOCKER inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}} rev {{index .Config.Labels "org.opencontainers.image.revision"}}' "$c")"
    echo "state:     $($DOCKER inspect --format '{{.State.Status}}{{if .State.Health}} / {{.State.Health.Status}}{{end}}' "$c")"
    for m in /data/server /data/friction /data/odc-features /data/cache; do echo "volume:    $m = $(volume_of "$c" $m)"; done
    url=$(db_url "$c")
    if [ -n "$url" ]; then
      reach=$(pg_tool "$c" psql "$url" -tAc 'select count(*) from server_tokens' 2>&1 | tail -n 1)
      echo "tokens:    postgres ($(printf '%s' "$url" | sed 's#//[^:]*:[^@]*@#//***:***@#')), $(case "$reach" in [0-9]*) echo "$reach records, reachable";; *) echo "NOT reachable: $reach";; esac)"
    else echo "tokens:    /data/server/tokens.json (no SSAM_DATABASE_URL)"; fi
    done
    ;;
  pull)
    # The reference the container was created from (SSAM_IMAGE:SSAM_IMAGE_TAG), pulled again: with `latest` that is the
    # newest published image. Coolify's Redeploy pulls by itself; this is for when it did not (compare the digests).
    c=$(container); ref=$($DOCKER inspect --format '{{.Config.Image}}' "$c")
    echo "pulling $ref"; $DOCKER pull "$ref"
    echo "now: $($DOCKER image inspect --format '{{range .RepoDigests}}{{.}} {{end}}' "$ref")"
    echo "then Redeploy (or Restart) the resource in Coolify so the containers are recreated from it"
    ;;
  token)
    c=$(container)
    # No log driver: the plaintext token and credential are printed once to this terminal and kept nowhere else.
    # shellcheck disable=SC2086
    $DOCKER run $hardened $(store_opts "$c") --log-driver none $tty -v "$(volume_of "$c" /data/server):/data/server" --entrypoint node "$(image_of "$c")" facade/ssam.mjs server-token "$@"
    ;;
  kernel)
    sub=${1:-}; [ $# -gt 0 ] && shift
    if [ "${1:-}" = --version ]; then SSAM_VERSION=${2:?version}; shift 2; fi
    c=$(container)
    runtime=$(env_of "$c" SSAM_RUNTIME_DIR); runtime=${runtime:-/data/server}
    case "$runtime" in /data/server|/data/server/versions/*) ;; *) die "invalid runtime directory";; esac
    check=$here/../kernel-pair-check.mjs
    case "$sub" in
      print)
        which=${1:-released}; record=${2:-$here/../release-record.json}
        [ -f "$check" ] || die "no $check"; [ -f "$record" ] || die "no $record"
        $DOCKER run --rm --network none --entrypoint node -v "$(hostpath "$check"):/c.mjs:ro" -v "$(hostpath "$record"):/r.json:ro" "$(image_of "$c")" /c.mjs print "$which" /r.json
        ;;
      check)
        file=${1:?kernel.json}; [ -f "$check" ] || die "no $check"
        $DOCKER run --rm --network none --entrypoint node -v "$(hostpath "$check"):/c.mjs:ro" -v "$(hostpath "$(cd "$(dirname "$file")" && pwd)/$(basename "$file")"):/k.json:ro" "$(image_of "$c")" /c.mjs check /k.json
        ;;
      write)
        file=${1:?kernel.json}
        [ -f "$check" ] || die "no pair checker"
        $DOCKER run --rm --network none --entrypoint node -v "$(hostpath "$check"):/c.mjs:ro" -v "$(hostpath "$(cd "$(dirname "$file")" && pwd)/$(basename "$file")"):/k.json:ro" "$(image_of "$c")" /c.mjs check /k.json
        node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$file" 2>/dev/null || { command -v node >/dev/null 2>&1 && die "$file is not valid JSON"; }
        # shellcheck disable=SC2086
        $DOCKER run $hardened --network none -i $(mounts "$c") -e SSAM_RUNTIME_DIR="$runtime" "$(image_of "$c")" sh -c 'mkdir -p "$SSAM_RUNTIME_DIR" && cat > "$SSAM_RUNTIME_DIR/kernel.json" && rm -rf /data/cache/module-index/v1/o11 /data/cache/module-index/v1/odc /data/cache/readers/ss4 /data/cache/readers-prefetch/ss4 /data/cache/readers/ss4-prefetch /data/cache/module-index/kernel-studio.json && echo "kernel.json written, version caches emptied"' < "$file"
        ;;
      show)
        # shellcheck disable=SC2086
        $DOCKER run $hardened --network none $(mounts "$c") "$(image_of "$c")" cat "$runtime/kernel.json"
        ;;
      *) die "kernel print|check|write|show" ;;
    esac
    ;;
  db)
    c=$(container); [ -n "$(env_of "$c" SSAM_DATABASE_URL)" ] || die "the server has no SSAM_DATABASE_URL: tokens are in /data/server/tokens.json"
    # shellcheck disable=SC2086
    $DOCKER run $hardened $(store_opts "$c") --entrypoint node "$(image_of "$c")" facade/ssam.mjs db "$@"
    ;;
  psql)
    c=$(container); url=$(db_url "$c"); [ -n "$url" ] || die "the server has no SSAM_DATABASE_URL"
    if [ $# -gt 0 ]; then pg_tool "$c" psql "$url" -c "$*"; else $DOCKER run --rm $tty --network "$(network_of "$c")" --security-opt no-new-privileges:true --cap-drop ALL --user 70:70 -e HOME=/tmp "$(pg_image "$c")" psql "$url"; fi
    ;;
  features)
    [ "${1:-}" = put ] || die "features put [--version x.y.z] <Features.plain.xml>"
    shift
    if [ "${1:-}" = --version ]; then SSAM_VERSION=${2:?version}; shift 2; fi
    c=$(container)
    file=${1:?Features.plain.xml}
    # shellcheck disable=SC2086
    $DOCKER run $hardened --network none -i $(mounts "$c") "$(image_of "$c")" sh -c 'cat > /data/odc-features/Features.plain.xml && echo "Features.plain.xml written"' < "$file"
    ;;
  put)
    c=$(container); file=${1:?file}; dest=${2:?path under /data}
    case "$dest" in /data/*) ;; *) die "the destination must start with /data/" ;; esac
    # shellcheck disable=SC2086
    $DOCKER run $hardened --network none -i $(mounts "$c") "$(image_of "$c")" sh -c "cat > '$dest' && echo '$dest written'" < "$file"
    ;;
  ops)
    c=$(container)
    # shellcheck disable=SC2086
    $DOCKER run $hardened --network none $tty $(mounts "$c") "$(image_of "$c")" "$@"
    ;;
  backup)
    keep=${BACKUP_KEEP_DAYS:-0}
    if [ "${1:-}" = --keep-days ]; then keep=${2:?--keep-days <n>}; shift 2; fi
    case "$keep" in ''|*[!0-9]*) die "--keep-days must be a number of days";; esac
    c=$(container); dir=${1:-/var/backups/ssam-server}
    umask 077
    [ -d "$dir" ] && [ -w "$dir" ] || die "the folder $dir must exist and be writable (sudo install -d -o \$USER -m 0700 $dir)"
    dir=$(cd "$dir" && pwd)
    # A failure leaves a "backup:" line in cron.log (the console collector tails those), next to the ssamctl: code.
    trap 'backup_exit_note $?' EXIT
    trap 'exit 130' HUP INT TERM
    echo "backup: start $(date -u +%Y-%m-%dT%H:%M:%SZ) in $dir"
    # Room first: the work folder holds the volumes uncompressed until the archive is written.
    newest=$(ls -1t "$dir"/ssam-state-*.tar.gz 2>/dev/null | head -n 1 || true)
    need_kb=$(( ${SSAM_BACKUP_MIN_FREE_GB:-20} * 1048576 ))
    if [ -n "$newest" ]; then last_kb=$(( $(wc -c < "$newest") / 1024 * 3 )); [ "$last_kb" -le "$need_kb" ] || need_kb=$last_kb; fi
    free_kb=$(df -Pk "$dir" | awk 'END{print $4}')
    [ "${free_kb:-0}" -ge "$need_kb" ] || die "BACKUP_DISK_LOW: $dir has $((${free_kb:-0} / 1048576)) GiB free, the backup needs $((need_kb / 1048576)) GiB; nothing was written"
    find "$dir" -maxdepth 1 -type d -name '.ssam-window-*' -mmin +1440 -exec rm -rf {} + 2>/dev/null || true
    stamp=$(date -u +%Y%m%dT%H%M%SZ); archive=$dir/ssam-state-$stamp.tar.gz
    project=${SSAM_PROJECT:-$($DOCKER inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$c")}
    databases=${SSAM_BACKUP_DATABASES-licenses update_server coolify}
    url=$(db_url "$c"); dumps=
    # The databases first, as plain SQL (each loads back with psql): a refused dump stops the backup before the long
    # volume copy. A server without SSAM_DATABASE_URL (tokens.json) needs SSAM_BACKUP_REQUIRE_DATABASE=0.
    for kind in $databases; do
      case "$kind" in
        licenses)
          if [ -n "$url" ]; then
            dump_tokens "$c" "$url" "$dir/ssam-tokens-$stamp.sql.gz"
            [ -s "$dir/ssam-tokens-$stamp.sql.gz" ] || exit 2
            (cd "$dir" && sha256sum "ssam-tokens-$stamp.sql.gz" > "ssam-tokens-$stamp.sql.gz.sha256")
            dumps="$dumps licenses=ssam-tokens-$stamp.sql.gz"
          elif [ "${SSAM_BACKUP_REQUIRE_DATABASE:-1}" = 1 ]; then
            die "BACKUP_NO_DATABASE_URL: $c has no SSAM_DATABASE_URL, so this backup would hold no licenses (SSAM_BACKUP_REQUIRE_DATABASE=0 for a tokens.json server)"
          fi;;
        update_server|coolify)
          db_c=$(local_db_container "$kind")
          case "$kind" in update_server) tables=$UPDATE_SERVER_TABLES;; *) tables=$COOLIFY_TABLES;; esac
          dump_local_db "$kind" "$db_c" "$tables" "$dir/ssam-db-$kind-$stamp.sql.gz"
          (cd "$dir" && sha256sum "ssam-db-$kind-$stamp.sql.gz" > "ssam-db-$kind-$stamp.sql.gz.sha256")
          dumps="$dumps $kind=ssam-db-$kind-$stamp.sql.gz";;
        *) die "SSAM_BACKUP_DATABASES: unknown database $kind (licenses, update_server, coolify)";;
      esac
    done
    # Coolify's definition of the resource (the compose it deploys and its .env, which holds secrets): the restore path.
    services=${SSAM_COOLIFY_SERVICES_DIR:-/data/coolify/services}
    service_file=
    if [ -n "$project" ] && [ -f "$services/$project/docker-compose.yml" ]; then
      set -- "$project/docker-compose.yml"; [ ! -f "$services/$project/.env" ] || set -- "$@" "$project/.env"
      tar -C "$services" -czf "$dir/ssam-service-$stamp.tar.gz.partial" "$@" && mv "$dir/ssam-service-$stamp.tar.gz.partial" "$dir/ssam-service-$stamp.tar.gz"
      (cd "$dir" && sha256sum "ssam-service-$stamp.tar.gz" > "ssam-service-$stamp.tar.gz.sha256")
      service_file=ssam-service-$stamp.tar.gz
      echo "backup: Coolify service definition $service_file ($*)"
    else
      echo "backup: no Coolify service folder $services/${project:-?} on this host; the service definition is not in this set" >&2
    fi
    window_backup
    (cd "$dir" && sha256sum "$(basename "$archive")" > "$archive.sha256")
    # The .info last: its presence marks a complete set. "key value" lines, as backup.sh (the console collector reads them).
    {
      echo "created $stamp"
      echo "project ${project:-unknown}"
      echo "image $($DOCKER inspect --format '{{.Config.Image}}' "$c")"
      echo "image-id $(image_of "$c")"
      echo "revision $($DOCKER inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$c")"
      echo "container $c"
      echo "mode $([ "$($DOCKER inspect --format '{{.State.Running}}' "$c")" = true ] && echo online || echo stopped)"
      echo "containers $window_containers"
      echo "volumes $window_volumes"
      echo "skipped-anonymous-volumes ${window_skipped:-none}"
      echo "databases${dumps:- none}"
      echo "service ${service_file:-none}"
    } > "$archive.info.partial"
    mv "$archive.info.partial" "$archive.info"
    echo "backup: $archive ($(du -h "$archive" | cut -f1), $(printf '%s\n' $window_volumes | grep -c .) volumes), databases:${dumps:- none}; the files hold customer data and token hashes: keep them private"
    if [ "$keep" -gt 0 ]; then
      find "$dir" -maxdepth 1 -type f \( -name 'ssam-state-*' -o -name 'ssam-tokens-*' -o -name 'ssam-db-*' -o -name 'ssam-service-*' \) \
        -mtime +"$keep" ! -name "*-$stamp.*" -print | while IFS= read -r old; do rm -f "$old" && echo "backup: removed $old (older than $keep days)"; done
    fi
    echo "backup: OK $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    ;;
  restore)
    # restore <archive.tar.gz> [<ssam-tokens-....sql.gz>]: the volumes, and the tokens' database when a dump is given (the
    # database resource keeps running: Coolify's Stop on this resource stops only the server).
    c=$(container); archive=${1:?archive.tar.gz}; dump=${2:-}
    [ "$($DOCKER inspect --format '{{.State.Running}}' "$c")" = false ] || die "stop the server in Coolify first (Stop), then restore"
    for other in $(containers); do
      [ "$($DOCKER inspect --format '{{.State.Running}}' "$other")" = false ] || die "stop all version backends before restoring shared state"
    done
    [ -f "$archive" ] || die "no $archive"
    if [ -n "$dump" ]; then
      url=$(db_url "$c"); [ -n "$url" ] || die "the server has no SSAM_DATABASE_URL: nothing to load the dump into"
      [ -f "$dump" ] || die "no $dump"
      (cd "$(dirname "$dump")" && { [ ! -f "$(basename "$dump").sha256" ] || sha256sum -c "$(basename "$dump").sha256"; }) || die "the dump does not match its .sha256"
      pg_tool "$c" psql "$url" -v ON_ERROR_STOP=1 -c 'DROP TABLE IF EXISTS server_tokens; DROP TABLE IF EXISTS schema_migrations;' < /dev/null >/dev/null
      gzip -dc "$dump" | pg_tool "$c" psql "$url" -v ON_ERROR_STOP=1 -f - >/dev/null
      echo "tokens database restored from $dump"
    fi
    (cd "$(dirname "$archive")" && { [ ! -f "$(basename "$archive").sha256" ] || sha256sum -c "$(basename "$archive").sha256"; }) || die "the archive does not match its .sha256"
    # shellcheck disable=SC2086
    window_restore
    ;;
  logs)
    c=$(container); n=${1:-50}
    runtime=$(env_of "$c" SSAM_RUNTIME_DIR); runtime=${runtime:-/data/server}
    # shellcheck disable=SC2086
    $DOCKER run $hardened --network none $(mounts "$c") "$(image_of "$c")" sh -c "tail -n $n $runtime/server.log | cut -c1-200"
    ;;
  console)
    # The console container of the same compose project (label com.docker.compose.service=ssam-console). Its log is JSON
    # lines on stdout (codes only, no secret); its audit is /data/server/console-audit.jsonl in the server-state volume.
    sub=${1:-status}; [ $# -gt 0 ] && shift
    k=$($DOCKER ps -a --filter label=com.docker.compose.service=ssam-console --format '{{.Names}}' | head -n 1)
    [ -n "$k" ] || die "no ssam-console container on this host (COOLIFY.md 11)"
    case "$sub" in
      status)
        echo "container: $k"
        echo "image:     $($DOCKER inspect --format '{{.Config.Image}}' "$k")"
        echo "state:     $($DOCKER inspect --format '{{.State.Status}}{{if .State.Health}} / {{.State.Health.Status}}{{end}}' "$k")"
        echo "url:       $(env_of "$k" CONSOLE_PUBLIC_URL)"
        echo "logins:    $(env_of "$k" CONSOLE_GITHUB_ALLOWED_LOGINS)"
        ;;
      logs) $DOCKER logs --tail "${1:-50}" "$k" 2>&1 | cut -c1-300 ;;
      audit)
        c=$(container); n=${1:-50}
        # shellcheck disable=SC2086
        $DOCKER run $hardened --network none $(mounts "$c") "$(image_of "$c")" sh -c "tail -n $n /data/server/console-audit.jsonl 2>/dev/null || echo '(no audit yet)'"
        ;;
      *) die "console status|logs [n]|audit [n]" ;;
    esac
    ;;
  *)
    sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
