#!/bin/sh
# Packs the part of an INSTALLED Studio that the ssam-server image needs (a "studio bundle"), the POSIX twin of
# studio-bundle.ps1 (same format), e.g. from WSL over /mnt/c/Program Files/... or from a copied Studio folder.
#
#   sh studio-bundle.sh [--lane odc|o11] [--studio <installed folder>] [--out <dir>] [--version <x.y.z.w>]
#
# Reads the folder (never writes there), copies exactly the files of studio-<lane>.txt and writes
#   <out>/<lane>-studio-<version>.tar.gz  (bundle.txt, SHA256SUMS, files/<listed paths>) and <...>.tar.gz.sha256.
# The version is the first word of the folder's Version.txt, or --version. The bundle carries OutSystems binaries.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
lane=odc studio= out="$here/../installers" version=
while [ $# -gt 0 ]; do
  case "$1" in
    --lane) lane=$2; shift 2 ;;
    --studio) studio=$2; shift 2 ;;
    --out) out=$2; shift 2 ;;
    --version) version=$2; shift 2 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
case "$lane" in
  odc) marker=OutSystems.ModelAPILoader.dll; : "${studio:=/mnt/c/Program Files/OutSystems/ODC Studio/ODC Studio}" ;;
  o11) marker=ServiceStudio.Framework.dll; : "${studio:=/mnt/c/Program Files/OutSystems/Service Studio 11/Service Studio}" ;;
  *) echo "--lane must be odc or o11" >&2; exit 2 ;;
esac
[ -f "$studio/$marker" ] || { echo "not a $lane Studio folder (no $marker): $studio" >&2; exit 1; }
if [ -z "$version" ] && [ -f "$studio/Version.txt" ]; then version=$(head -n 1 "$studio/Version.txt" | tr -d '\r' | cut -d' ' -f1); fi
echo "$version" | grep -Eq '^[0-9]+(\.[0-9]+){1,3}$' || { echo "no Studio version (Version.txt or --version): '$version'" >&2; exit 1; }

list="$here/studio-$lane.txt"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/files"
n=0 bytes=0 missing=0
grep -v '^[[:space:]]*#' "$list" | sed '/^[[:space:]]*$/d' > "$stage/paths"
while IFS= read -r rel; do
  if [ ! -f "$studio/$rel" ]; then echo "missing $rel" >&2; missing=$((missing + 1)); continue; fi
  mkdir -p "$stage/files/$(dirname "$rel")"
  cp "$studio/$rel" "$stage/files/$rel"
  n=$((n + 1)); bytes=$((bytes + $(wc -c < "$stage/files/$rel")))
done < "$stage/paths"
[ "$missing" -eq 0 ] || { echo "$studio lacks $missing listed file(s)" >&2; exit 1; }
(cd "$stage" && while IFS= read -r rel; do sha256sum "files/$rel"; done < paths) > "$stage/SHA256SUMS"
printf 'schema ssam-studio-bundle/1\nlane %s\nversion %s\nsource %s\ncreated %s\nfiles %s\nbytes %s\nlist studio-%s.txt %s\n' \
  "$lane" "$version" "$studio" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$n" "$bytes" "$lane" "$(sha256sum "$list" | cut -d' ' -f1)" > "$stage/bundle.txt"
mkdir -p "$out"
name="$lane-studio-$version.tar.gz"
tar -czf "$out/$name" -C "$stage" bundle.txt SHA256SUMS files
sha=$(sha256sum "$out/$name" | cut -d' ' -f1)
printf '%s  %s\n' "$sha" "$name" > "$out/$name.sha256"
echo "$out/$name: $n files ($bytes bytes) of $lane $version, sha256 $sha"
