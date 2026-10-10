#!/bin/sh
# Puts the files a lane needs from an official OutSystems Studio installer, or from a studio bundle, into <out>,
# inside a build stage.
#
#   studio-extract.sh <lane> <installer file> <url> <sha256> <marker> <list> <out> [<bundle file> <bundle sha256>]
#
# Two inputs, in this order:
#   1. the official installer: <url> (downloaded at build time, needs <sha256>), else the `installers` build context
#      (${INSTALLERS_DIR:-/installers}/<installer file>). A pinned <sha256> is checked; the installer is only read,
#      never run. STUDIO_EXTRACTOR picks the reader:
#        nsis (default) nsis_extract.py, Python standard library only (proven byte for byte against the installed Studios);
#        7z             7-Zip (7zip or p7zip-full of the distribution), then the listed files are copied from the folder
#                       that holds <marker>.
#   2. when that installer is absent: a studio bundle (studio-bundle.ps1 / studio-bundle.sh, packed from an INSTALLED
#      Studio) in the same context, ${INSTALLERS_DIR:-/installers}/<bundle file>. A pinned <bundle sha256> is checked
#      (else its .sha256 sidecar, integrity only); studio_bundle.py checks every file against the bundle's SHA256SUMS.
# Either way every path of <list> (relative to the Studio folder, # comments) must come out, or the build stops naming it.
set -eu
lane=$1 file=$2 url=$3 sha=$4 marker=$5 list=$6 out=$7 bundle=${8:-} bundle_sha=${9:-}
here=$(dirname "$0")
work=$(mktemp -d)
ctx=${INSTALLERS_DIR:-/installers}

if [ -z "$url" ] && [ ! -f "$ctx/$file" ] && [ -n "$bundle" ] && [ -f "$ctx/$bundle" ]; then
  src="$ctx/$bundle"
  echo "ssam-server: the $lane installer '$file' is absent; using the studio bundle $bundle"
  if [ -n "$bundle_sha" ]; then
    echo "$bundle_sha  $src" | sha256sum -c - >/dev/null || { echo "ssam-server: $bundle does not match the pinned SHA256 $bundle_sha" >&2; exit 1; }
    echo "ssam-server: $bundle matches the pinned SHA256"
  elif [ -f "$src.sha256" ]; then
    expected=$(cut -d' ' -f1 "$src.sha256")
    echo "$expected  $src" | sha256sum -c - >/dev/null || { echo "ssam-server: $bundle does not match its $bundle.sha256" >&2; exit 1; }
    echo "ssam-server: $bundle matches its .sha256 sidecar (not pinned: set the bundle SHA256 build arg)" >&2
  else
    echo "ssam-server: no SHA256 pinned for $bundle ($(sha256sum "$src" | cut -d' ' -f1)); pin it with the build arg" >&2
  fi
  mkdir -p "$out"
  python3 "$here/studio_bundle.py" unpack "$src" "$out" --lane "$lane" --only "$list"
  expected=$(grep -v '^[[:space:]]*#' "$list" | sed '/^[[:space:]]*$/d' | wc -l)
  actual=$(find "$out" -type f | wc -l)
  if [ "$expected" -ne "$actual" ]; then echo "ssam-server: $lane has $actual files in $out, the list names $expected" >&2; exit 1; fi
  echo "ssam-server: $lane: $actual files ($(du -sh "$out" | cut -f1)) from the bundle $bundle into $out"
  rm -rf "$work"
  exit 0
fi

if [ -n "$url" ]; then
  if [ -z "$sha" ]; then
    echo "ssam-server: the $lane installer URL needs its SHA256 (build arg) so the download is pinned" >&2; exit 1
  fi
  src="$work/$file"
  echo "ssam-server: downloading the $lane installer $file"
  python3 -c 'import sys, urllib.request; urllib.request.urlretrieve(sys.argv[1], sys.argv[2])' "$url" "$src"
else
  src="$ctx/$file"
  if [ ! -f "$src" ]; then
    echo "ssam-server: neither the $lane installer '$file' nor the studio bundle '${bundle:-<none>}' is in the installers build context (docker/installers by default)." >&2
    echo "  Drop the official installer there, or a bundle made with studio-bundle.ps1/.sh on a machine with the Studio installed;" >&2
    echo "  or pass their names as build args, or set the installer URL and SHA256 build args." >&2
    echo "  The installers context holds: $(ls "$ctx" 2>/dev/null | tr '\n' ' ')" >&2
    exit 1
  fi
fi

if [ -n "$sha" ]; then
  echo "$sha  $src" | sha256sum -c - >/dev/null || { echo "ssam-server: $file does not match the pinned SHA256 $sha" >&2; exit 1; }
  echo "ssam-server: $file matches the pinned SHA256"
else
  echo "ssam-server: no SHA256 pinned for $file ($(sha256sum "$src" | cut -d' ' -f1)); pin it with the build arg" >&2
fi

mkdir -p "$out"
case "${STUDIO_EXTRACTOR:-nsis}" in
  nsis)
    python3 "$here/nsis_extract.py" extract "$src" "$out" --marker "$marker" --only "$list"
    ;;
  7z)
    seven=$(command -v 7zz || command -v 7z || true)
    if [ -z "$seven" ]; then echo "ssam-server: STUDIO_EXTRACTOR=7z but no 7z/7zz in the stage" >&2; exit 1; fi
    "$seven" x -y -bd -o"$work/x" "$src" >/dev/null
    found=$(find "$work/x" -type f -name "$marker" | awk '{ print length($0) "\t" $0 }' | sort -n | head -n 1 | cut -f2-)
    if [ -z "$found" ]; then echo "ssam-server: 7z found no $marker in $file" >&2; exit 1; fi
    root=$(dirname "$found")
    missing=0
    grep -v '^[[:space:]]*#' "$list" | sed '/^[[:space:]]*$/d' | while IFS= read -r rel; do
      if [ -f "$root/$rel" ]; then mkdir -p "$out/$(dirname "$rel")"; cp "$root/$rel" "$out/$rel"
      else echo "ssam-server: $file does not carry $rel" >&2; echo x >> "$work/missing"; fi
    done
    if [ -f "$work/missing" ]; then exit 2; fi
    ;;
  *) echo "ssam-server: STUDIO_EXTRACTOR must be nsis or 7z" >&2; exit 1 ;;
esac

# Every listed file is there, and nothing else.
expected=$(grep -v '^[[:space:]]*#' "$list" | sed '/^[[:space:]]*$/d' | wc -l)
actual=$(find "$out" -type f | wc -l)
if [ "$expected" -ne "$actual" ]; then
  echo "ssam-server: $lane has $actual files in $out, the list names $expected" >&2; exit 1
fi
echo "ssam-server: $lane: $actual files ($(du -sh "$out" | cut -f1)) from $file into $out"
rm -rf "$work"
