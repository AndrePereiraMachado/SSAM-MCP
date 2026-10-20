#!/bin/sh
# The by-hand operations of the SSAM server on a VPS run by Coolify (COOLIFY.md), over SSH, with docker alone: no compose
# file, no .env. Everything is read from the running (or stopped) ssam-server container Coolify created: its image (tag
# and digest) and its four volumes. The admin and ops commands then run one-off containers of that same image, without
# network, as the compose.prod.yml services ssam-admin and ssam-ops would.
#
#   sh ssamctl.sh status                                   image, volumes, health of the server container
#   sh ssamctl.sh token issue --customer "Name" --days 30 --lanes odc,o11
#   sh ssamctl.sh token list | revoke --id tok_... | agent-rotate --id tok_...
#   sh ssamctl.sh kernel print [released|previous|<tag>] <release-record.json>   the kernel.json of an image, from the record
#   sh ssamctl.sh kernel check <kernel.json>               the pair check inside the image that runs (0 = pair-ok)
#   sh ssamctl.sh kernel write <kernel.json>               writes /data/server/kernel.json and empties the version caches
#   sh ssamctl.sh kernel show                              the kernel.json in the volume
#   sh ssamctl.sh features put <Features.plain.xml>        writes /data/odc-features/Features.plain.xml
#   sh ssamctl.sh put <file> <path under /data>            any file into the state volumes (as uid 10001)
#   sh ssamctl.sh ops <command...>                         a shell command in the image over the volumes, no network
#   sh ssamctl.sh backup [<folder>]                        tar.gz of server, friction and odc-features (+ .sha256, .info)
#   sh ssamctl.sh restore <archive.tar.gz>                 the three folders back, with the server STOPPED (Coolify: Stop)
#   sh ssamctl.sh logs [<n>]                               the last n lines of the server's log (default 50)
#
# The container is found by its compose service label (com.docker.compose.service=ssam-server); SSAM_CONTAINER names it
# explicitly when the host runs more than one. kernel print/check need ../kernel-pair-check.mjs next to this folder (the
# deploy folder of the approved commit, as DEPLOY.md section 5 copies it).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
# Git Bash on Windows (the local rehearsal, COOLIFY.md 10): MSYS would rewrite the container paths of -v and of the
# commands (/data/server) into Windows paths; host paths go through cygpath instead. No-ops on Linux.
DOCKER="env MSYS_NO_PATHCONV=1 ${DOCKER:-docker}"
hostpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

die() { echo "ssamctl: $*" >&2; exit 2; }

container() {
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
hardened="--rm --network none --init --security-opt no-new-privileges:true --cap-drop ALL --user 10001:10001"
# A terminal for the interactive commands only when there is one (a script or a pipe gets -i).
tty=-i; [ -t 0 ] && [ -t 1 ] && tty=-it

cmd=${1:-}; [ $# -gt 0 ] && shift
case "$cmd" in
  status)
    c=$(container)
    echo "container: $c"
    echo "image:     $($DOCKER inspect --format '{{.Config.Image}}' "$c") ($(image_of "$c"))"
    echo "version:   $($DOCKER inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}} rev {{index .Config.Labels "org.opencontainers.image.revision"}}' "$c")"
    echo "state:     $($DOCKER inspect --format '{{.State.Status}}{{if .State.Health}} / {{.State.Health.Status}}{{end}}' "$c")"
    for m in /data/server /data/friction /data/odc-features /data/cache; do echo "volume:    $m = $(volume_of "$c" $m)"; done
    ;;
  token)
    c=$(container)
    # No log driver: the plaintext token and credential are printed once to this terminal and kept nowhere else.
    # shellcheck disable=SC2086
    $DOCKER run $hardened --log-driver none $tty -v "$(volume_of "$c" /data/server):/data/server" --entrypoint node "$(image_of "$c")" facade/ssam.mjs server-token "$@"
    ;;
  kernel)
    c=$(container); sub=${1:-}; [ $# -gt 0 ] && shift
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
        node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$file" 2>/dev/null || { command -v node >/dev/null 2>&1 && die "$file is not valid JSON"; }
        # shellcheck disable=SC2086
        $DOCKER run $hardened -i $(mounts "$c") "$(image_of "$c")" sh -c 'cat > /data/server/kernel.json && rm -rf /data/cache/module-index/v1/o11 /data/cache/module-index/v1/odc /data/cache/readers/ss4 /data/cache/readers-prefetch/ss4 /data/cache/readers/ss4-prefetch /data/cache/module-index/kernel-studio.json && echo "kernel.json written, version caches emptied"' < "$file"
        ;;
      show)
        # shellcheck disable=SC2086
        $DOCKER run $hardened $(mounts "$c") "$(image_of "$c")" cat /data/server/kernel.json
        ;;
      *) die "kernel print|check|write|show" ;;
    esac
    ;;
  features)
    c=$(container); [ "${1:-}" = put ] || die "features put <Features.plain.xml>"
    file=${2:?Features.plain.xml}
    # shellcheck disable=SC2086
    $DOCKER run $hardened -i $(mounts "$c") "$(image_of "$c")" sh -c 'cat > /data/odc-features/Features.plain.xml && echo "Features.plain.xml written"' < "$file"
    ;;
  put)
    c=$(container); file=${1:?file}; dest=${2:?path under /data}
    case "$dest" in /data/*) ;; *) die "the destination must start with /data/" ;; esac
    # shellcheck disable=SC2086
    $DOCKER run $hardened -i $(mounts "$c") "$(image_of "$c")" sh -c "cat > '$dest' && echo '$dest written'" < "$file"
    ;;
  ops)
    c=$(container)
    # shellcheck disable=SC2086
    $DOCKER run $hardened $tty $(mounts "$c") "$(image_of "$c")" "$@"
    ;;
  backup)
    c=$(container); dir=${1:-/var/backups/ssam-server}
    [ -d "$dir" ] && [ -w "$dir" ] || die "the folder $dir must exist and be writable (sudo install -d -o \$USER -m 0700 $dir)"
    stamp=$(date -u +%Y%m%dT%H%M%SZ); archive=$dir/ssam-state-$stamp.tar.gz
    # shellcheck disable=SC2086
    $DOCKER run $hardened $(mounts "$c") "$(image_of "$c")" sh -c 'tar -C /data -czf - server friction odc-features' > "$archive"
    (cd "$dir" && sha256sum "$(basename "$archive")" > "$archive.sha256")
    printf 'image=%s\nimageId=%s\nrevision=%s\ncontainer=%s\nmode=%s\n' "$($DOCKER inspect --format '{{.Config.Image}}' "$c")" "$(image_of "$c")" \
      "$($DOCKER inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$c")" "$c" \
      "$([ "$($DOCKER inspect --format '{{.State.Running}}' "$c")" = true ] && echo online || echo stopped)" > "$archive.info"
    echo "backup: $archive ($(du -h "$archive" | cut -f1)); the archive holds customer data and token hashes: keep it private"
    ;;
  restore)
    c=$(container); archive=${1:?archive.tar.gz}
    [ "$($DOCKER inspect --format '{{.State.Running}}' "$c")" = false ] || die "stop the server in Coolify first (Stop), then restore"
    [ -f "$archive" ] || die "no $archive"
    (cd "$(dirname "$archive")" && [ ! -f "$(basename "$archive").sha256" ] || sha256sum -c "$(basename "$archive").sha256") || die "the archive does not match its .sha256"
    # shellcheck disable=SC2086
    $DOCKER run $hardened -i $(mounts "$c") "$(image_of "$c")" sh -c 'rm -rf /data/server/* /data/friction/* /data/odc-features/* && tar -C /data -xzf - && echo "restored; start the server in Coolify"' < "$archive"
    ;;
  logs)
    c=$(container); n=${1:-50}
    # shellcheck disable=SC2086
    $DOCKER run $hardened $(mounts "$c") "$(image_of "$c")" sh -c "tail -n $n /data/server/server.log | cut -c1-200"
    ;;
  *)
    sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
