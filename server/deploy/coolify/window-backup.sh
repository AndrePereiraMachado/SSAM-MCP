# Whole-window archive: one payload per named volume, with every container mapping retained.
# Loaded by ssamctl.sh after its Docker helpers.
window_backup() {
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT HUP INT TERM
  printf 'container\todc\to11\tdestination\tvolume\tpayload\n' > "$work/manifest.tsv"
  found=$(containers); [ -n "$found" ] || found=$c
  count=0
  for backend in $found; do
    odc=$($DOCKER inspect --format '{{index .Config.Labels "ssam.odc"}}' "$backend")
    o11=$($DOCKER inspect --format '{{index .Config.Labels "ssam.o11"}}' "$backend")
    for destination in /data/server /data/friction /data/odc-features /data/cache; do
      volume=$(volume_of "$backend" "$destination")
      payload=$(awk -F '\t' -v v="$volume" 'NR>1 && $5==v {print $6; exit}' "$work/manifest.tsv")
      if [ -z "$payload" ]; then
        count=$((count+1)); payload=volume-$count.tar
        $DOCKER run $hardened --network none -v "$volume:/source:ro" --entrypoint tar "$(image_of "$backend")" -C /source -cf - . > "$work/$payload"
      fi
      printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$backend" "$odc" "$o11" "$destination" "$volume" "$payload" >> "$work/manifest.tsv"
    done
  done
  (
    cd "$work" && tar --force-local -czf "$archive" manifest.tsv volume-*.tar
  )
  rm -rf "$work"; trap - EXIT HUP INT TERM
}
window_restore() {
  work=$(mktemp -d)
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
  tail -n +2 "$work/manifest.tsv" | while IFS="$(printf '\t')" read -r backend odc o11 destination volume payload; do
    case "$destination" in /data/server|/data/friction|/data/odc-features|/data/cache) ;; *) die "invalid volume destination";; esac
    case "$volume" in ''|*[!a-zA-Z0-9_.-]*) die "invalid volume name";; esac
    case "$payload" in volume-*.tar) ;; *) die "invalid volume payload";; esac
    grep -qxF "$payload" "$work/members" || die "missing volume payload"
    [ "$(volume_of "$backend" "$destination")" = "$volume" ] || die "volume mapping changed for $backend; restore the recorded mapping first"
    [ "$($DOCKER inspect --format '{{.State.Running}}' "$backend")" = false ] || die "stop all archived backends before restore"
    [ "$($DOCKER inspect --format '{{index .Config.Labels "ssam.odc"}}' "$backend")" = "$odc" ] || die "ODC version mapping changed"
    [ "$($DOCKER inspect --format '{{index .Config.Labels "ssam.o11"}}' "$backend")" = "$o11" ] || die "O11 version mapping changed"
  done
  awk -F '\t' 'NR>1 && !seen[$5]++ {print $5 "\t" $6}' "$work/manifest.tsv" | while IFS="$(printf '\t')" read -r volume payload; do
    $DOCKER run $hardened --network none -i -v "$volume:/restore" --entrypoint sh "$(image_of "$c")" -c 'find /restore -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && tar -C /restore -xf -' < "$work/$payload"
  done
  rm -rf "$work"; trap - EXIT HUP INT TERM
  echo 'Window volumes restored; start the server when ready.'
}