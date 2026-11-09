# Whole-window archive: one payload per named volume, with every container mapping retained.
# Loaded by ssamctl.sh after its Docker helpers.
#
# Which volumes: every named volume mounted by every container of the compose project of the default backend $c (on
# Coolify the resource: backends v1..vN, router, console), whatever the destination (/data/server, /data/cache,
# /data/runtime-css, the ODC plugins folder, ...), plus every volume named <project>_* that nothing mounts now. Anonymous
# volumes (64 hex characters) are skipped and listed in window_skipped: Coolify recreates them on each Redeploy, so a
# restore could never map them back. Without a project label it falls back to the ssam.backend containers.
# The work folder is next to the archive (the backup disk), never /tmp: on the VPS /tmp is a tmpfs in RAM and the
# volumes are gigabytes. GNU tar exit 1 (a file changed while it was read: an online copy) is accepted with a note; any
# other failure, an empty payload, or an empty server-state stops the backup before the archive gets its final name.
# Sets window_containers, window_volumes, window_skipped, window_state_files and window_state_bytes for the .info.
window_backup() {
  wb_tab=$(printf '\t')
  work=$(mktemp -d "$(dirname "$archive")/.ssam-window-XXXXXX")
  trap 'st=$?; rm -rf "$work" "$archive.partial"; backup_on_exit "$st"' EXIT
  trap 'exit 130' HUP INT TERM
  printf 'container\todc\to11\tdestination\tvolume\tpayload\n' > "$work/manifest.tsv"
  wb_project=${project:-}
  if [ -n "$wb_project" ]; then found=$($DOCKER ps -a --filter "label=com.docker.compose.project=$wb_project" --format '{{.Names}}'); else found=$(containers); fi
  [ -n "$found" ] || found=$c
  wb_image=$(image_of "$c")
  count=0; window_containers=; window_volumes=; window_skipped=
  for backend in $found; do
    window_containers="$window_containers $backend"
    odc=$($DOCKER inspect --format '{{index .Config.Labels "ssam.odc"}}' "$backend")
    o11=$($DOCKER inspect --format '{{index .Config.Labels "ssam.o11"}}' "$backend")
    $DOCKER inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{printf "%s\t%s\n" .Destination .Name}}{{end}}{{end}}' "$backend" > "$work/mounts"
    while IFS="$wb_tab" read -r destination volume; do
      [ -n "$volume" ] || continue
      window_add "$backend" "$odc" "$o11" "$destination" "$volume"
    done < "$work/mounts"
  done
  if [ -n "$wb_project" ]; then
    $DOCKER volume ls -q --filter "name=${wb_project}_" > "$work/project-volumes"
    while IFS= read -r volume; do
      case "$volume" in "${wb_project}"_*) ;; *) continue;; esac
      awk -F '\t' -v v="$volume" 'NR>1 && $5==v {f=1} END{exit !f}' "$work/manifest.tsv" && continue
      window_add - - - - "$volume"
    done < "$work/project-volumes"
  fi
  [ "$count" -gt 0 ] || die "BACKUP_NO_VOLUMES: no named volume found for ${wb_project:-the backends}"
  # The shared state must hold what a live server has (kernel.json, the customers' workspaces; SSAM_BACKUP_STATE_REQUIRED)
  # and must not have shrunk below SSAM_BACKUP_MIN_RATIO percent (default 50) of the previous complete set, in files or
  # bytes (a reset or recreated volume): BACKUP_SHRANK, nothing written, nothing pruned. SSAM_BACKUP_ALLOW_SHRINK=1
  # accepts an intended clean-up once.
  wb_state=$(volume_of "$c" /data/server)
  wb_payload=$(awk -F '\t' -v v="$wb_state" 'NR>1 && $5==v {print $6; exit}' "$work/manifest.tsv")
  tar -tf "$work/$wb_payload" | sed 's#^\./##' > "$work/state-list" || die "BACKUP_STATE_EMPTY: the server-state copy does not read back"
  window_state_files=$(grep -c '[^/]$' "$work/state-list" || true)
  window_state_bytes=$(wc -c < "$work/$wb_payload" | tr -d ' ')
  [ "$window_state_files" -gt 0 ] || die "BACKUP_STATE_EMPTY: the server-state volume $wb_state is empty; no archive was made"
  for wb_need in ${SSAM_BACKUP_STATE_REQUIRED-kernel.json customers/}; do
    grep -qx -- "$wb_need" "$work/state-list" || die "BACKUP_STATE_EMPTY: the server-state volume $wb_state has no $wb_need; no archive was made"
  done
  wb_ratio=${SSAM_BACKUP_MIN_RATIO:-50}
  if [ "${SSAM_BACKUP_ALLOW_SHRINK:-0}" != 1 ] && [ -n "${prev_state_files:-}" ] && [ -n "${prev_state_bytes:-}" ]; then
    [ $((window_state_files * 100)) -ge $((prev_state_files * wb_ratio)) ] && [ $((window_state_bytes * 100)) -ge $((prev_state_bytes * wb_ratio)) ] ||
      die "BACKUP_SHRANK: server-state has $window_state_files files / $window_state_bytes bytes, the previous set $prev_state_files / $prev_state_bytes (below $wb_ratio%); nothing was written or pruned (SSAM_BACKUP_ALLOW_SHRINK=1 if intended)"
  fi
  (
    cd "$work" && tar --force-local -czf "$archive.partial" manifest.tsv volume-*.tar
  )
  # It must read back with exactly the manifest and every payload.
  wb_expect=$( { echo manifest.tsv; awk -F '\t' 'NR>1 && !s[$6]++ {print $6}' "$work/manifest.tsv"; } | sort)
  wb_got=$(tar --force-local -tzf "$archive.partial" | sort)
  [ "$wb_got" = "$wb_expect" ] || die "BACKUP_ARCHIVE_INVALID: the window archive does not read back with its manifest and payloads"
  mv "$archive.partial" "$archive"
  rm -rf "$work"; trap 'backup_on_exit $?' EXIT
}
# window_add <container> <odc> <o11> <destination> <volume>: one manifest row; the payload once per volume.
window_add() {
  case "$5" in *[!a-zA-Z0-9_.-]*|'') die "invalid volume name: $5";; esac
  if printf '%s' "$5" | grep -Eq '^[0-9a-f]{64}$'; then
    case " $window_skipped " in *" $5 "*) ;; *) window_skipped="$window_skipped $5";; esac
    return 0
  fi
  payload=$(awk -F '\t' -v v="$5" 'NR>1 && $5==v {print $6; exit}' "$work/manifest.tsv")
  if [ -z "$payload" ]; then
    count=$((count+1)); payload=volume-$count.tar
    # shellcheck disable=SC2086
    $DOCKER run $hardened --network none -v "$5:/source:ro" --entrypoint sh "$wb_image" -c \
      'tar -C /source -cf - .; s=$?; if [ "$s" -eq 1 ]; then echo "backup: a file changed while it was read (online copy, tar exit 1); kept" >&2; s=0; fi; exit "$s"' \
      < /dev/null > "$work/$payload" || die "BACKUP_VOLUME_FAILED: the copy of volume $5 failed; no archive was made"
    [ -s "$work/$payload" ] || die "BACKUP_VOLUME_FAILED: the copy of volume $5 is empty; no archive was made"
    window_volumes="$window_volumes $5"
  fi
  # Empty labels (router, console) are written as "-": read splits on runs of tabs, so an empty field would shift the row.
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "${2:--}" "${3:--}" "$4" "$5" "$payload" >> "$work/manifest.tsv"
}
window_restore() {
  work=$(mktemp -d "$(dirname "$archive")/.ssam-restore-XXXXXX")
  trap 'rm -rf "$work"' EXIT HUP INT TERM
  tar --force-local -tzf "$archive" > "$work/members"
  if ! grep -qx 'manifest.tsv' "$work/members"; then
    # Existing single-container backups remain readable.
    $DOCKER run $hardened --network none -i $(mounts "$c") "$(image_of "$c")" sh -c 'rm -rf /data/server/* /data/friction/* /data/odc-features/* && tar -C /data -xzf -' < "$archive"
    rm -rf "$work"; trap - EXIT HUP INT TERM; return
  fi
  if grep -Ev '^(manifest.tsv|volume-[0-9]+\.tar)$' "$work/members"; then die "invalid window archive members"; fi
  tar --force-local -C "$work" -xzf "$archive"
  # Validate every original mapping before touching any volume. Recreated containers must use the recorded volumes.
  # Rows with container "-" are project volumes nothing mounted at backup time: restored by name, no mapping to check.
  tail -n +2 "$work/manifest.tsv" | while IFS="$(printf '\t')" read -r backend odc o11 destination volume payload; do
    case "$volume" in ''|*[!a-zA-Z0-9_.-]*) die "invalid volume name";; esac
    case "$payload" in volume-*.tar) ;; *) die "invalid volume payload";; esac
    grep -qxF "$payload" "$work/members" || die "missing volume payload"
    if [ "$backend" = - ]; then
      [ "$destination" = - ] || die "invalid volume destination"
      $DOCKER volume inspect "$volume" >/dev/null 2>&1 || die "the volume $volume no longer exists; create it (docker volume create $volume) first"
      continue
    fi
    case "$destination" in /data/*|/tmp/.local/share/OutSystems/*) ;; *) die "invalid volume destination";; esac
    case "$destination" in *..*) die "invalid volume destination";; esac
    [ "$(volume_of "$backend" "$destination")" = "$volume" ] || die "volume mapping changed for $backend; restore the recorded mapping first"
    [ "$($DOCKER inspect --format '{{.State.Running}}' "$backend")" = false ] || die "stop all archived containers (backends, router, console) before restore"
    [ "$odc" != - ] || odc=; [ "$o11" != - ] || o11=
    [ "$($DOCKER inspect --format '{{index .Config.Labels "ssam.odc"}}' "$backend")" = "$odc" ] || die "ODC version mapping changed"
    [ "$($DOCKER inspect --format '{{index .Config.Labels "ssam.o11"}}' "$backend")" = "$o11" ] || die "O11 version mapping changed"
  done
  awk -F '\t' 'NR>1 && !seen[$5]++ {print $5 "\t" $6}' "$work/manifest.tsv" | while IFS="$(printf '\t')" read -r volume payload; do
    $DOCKER run $hardened --network none -i -v "$volume:/restore" --entrypoint sh "$(image_of "$c")" -c 'find /restore -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && tar -C /restore -xf -' < "$work/$payload"
  done
  rm -rf "$work"; trap - EXIT HUP INT TERM
  echo 'Window volumes restored; start the server when ready.'
}
