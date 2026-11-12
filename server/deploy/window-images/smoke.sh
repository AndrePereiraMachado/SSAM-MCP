#!/bin/bash
# smoke.sh <new image> <source image@digest> <o11 versions, comma> <default o11> <odc>: the smoke of an image built with
# Studios from images (trilha D, IMAGENS.md; run by build-window-images.sh). Every container is a new throwaway one (--rm, --pull=never, --network none);
# nothing running is touched. Steps:
#   1. labels and the Studio provenance files of the new image;
#   2. check-image again, as the runtime user, on every Studio folder;
#   3. the bytes: every file of /app/studio-from-image/<lane>-<v>.sha256sums checked INSIDE the source image (same bytes);
#   4. startupKernel with kernel.json {o11: default, odc}: both lanes on, o11-kernels off [];
#   5. the SkiaSharp probe on every Studio folder;
#   6. ssam doctor (local verb of facade/ssam.mjs) in the container.
# SMOKE_LAYOUT=single (a correction image, gen-dockerfile.mjs --single): the production pair layout, the one Service Studio
# at /studio/o11 (not /studio/o11/<version>), and the server of the source commit (no o11-kernels event before the window 4x4).
# SMOKE_LAYOUT=overlay (a correction image ON the production image, overlay.mjs): the single layout, and step 3 checks that
# the source image's layers are the new image's first layers (the Studios are in them, byte for byte; there are no
# /app/studio-from-image lists, nothing was copied). overlay.mjs proof reads those layers again from outside the image.
set -uo pipefail
img=$1 src=$2 o11s=$3 def=$4 odc=$5 layout=${SMOKE_LAYOUT:-multi}
case "$layout" in multi|single|overlay) ;; *) echo "SMOKE_LAYOUT is multi, single or overlay"; exit 2 ;; esac
o11dir() { if [ "$layout" != multi ]; then echo /studio/o11; else echo "/studio/o11/$1"; fi; }
here=$(cd "$(dirname "$0")" && pwd -W 2>/dev/null || pwd)
run() { MSYS_NO_PATHCONV=1 docker run --rm --pull=never --network none "$@"; }
fail=0; step() { echo; echo "== $*"; }
step "1. labels"
docker image inspect "$img" --format '{{json .Config.Labels}}' | tr ',' '\n' | grep -E 'ssam\.|org.opencontainers.image.(version|revision|licenses|description)'
echo "size: $(docker image inspect "$img" --format '{{.Size}}' | awk '{printf "%.2f GB", $1/1e9}')"
run --entrypoint sh "$img" -c 'ls -l /app/studio-from-image; cat /app/studio-from-image/*.image; cat /app/studio-provenance.json; echo'
step "2. check-image (user 10001)"
pairs=""; for v in ${o11s//,/ }; do pairs="$pairs $(o11dir "$v")=$v"; done
run --entrypoint node "$img" /app/platforms/odc/facade/kernel-image.mjs check-image $pairs "/studio/odc=$odc" || fail=$((fail+1))
step "3. the same bytes as the source image"
if [ "$layout" = overlay ]; then
  ol=$(docker image inspect -f '{{json .RootFS.Layers}}' "$src") nl=$(docker image inspect -f '{{json .RootFS.Layers}}' "$img")
  if node -e 'const [o,n]=process.argv.slice(1).map(JSON.parse);process.exit(o.length&&n.length>o.length&&o.every((l,i)=>n[i]===l)?0:1)' "$ol" "$nl"; then
    echo "ok   the $(node -e 'console.log(JSON.parse(process.argv[1]).length)' "$ol") layers of $src are the first layers of the new image (Studios included)"
  else echo "FAIL the new image does not start with the layers of $src"; fail=$((fail+1)); fi
else
tmp=$(mktemp -d); MSYS_NO_PATHCONV=1 docker create --name smoke-sums-$$ "$img" >/dev/null && docker cp smoke-sums-$$:/app/studio-from-image "$tmp/" >/dev/null; docker rm -v smoke-sums-$$ >/dev/null
for f in "$tmp"/studio-from-image/*.sha256sums; do
  b=$(basename "$f" .sha256sums); lane=${b%%-*}; v=${b#*-}
  srcdir=/studio/$lane; [ "$lane" = o11 ] && [ -n "${SRC_O11_PATH:-}" ] && srcdir=$SRC_O11_PATH
  ref=$(cat "$tmp/studio-from-image/$b.image"); n=$(wc -l < "$f")
  if run -i -w "$srcdir" --entrypoint sha256sum "$ref" -c --quiet - < "$f"; then echo "ok   $b: $n files, the same sha256 inside $ref ($srcdir)"; else echo "FAIL $b"; fail=$((fail+1)); fi
  newdir=/studio/$lane; [ "$lane" = o11 ] && newdir=$(o11dir "$v")
  if run -i -w "$newdir" --entrypoint sha256sum "$img" -c --quiet - < "$f"; then echo "ok   $b: the same sha256 inside the new image ($newdir)"; else echo "FAIL $b in the new image"; fail=$((fail+1)); fi
done
rm -rf "$tmp"
fi
step "4. startupKernel (kernel.json o11 $def, odc $odc)"
run -v "$here:/smoke:ro" --entrypoint node "$img" /smoke/startup.mjs "$def" "$odc" "$([ "$layout" = overlay ] && echo single || echo "$layout")" || fail=$((fail+1))
step "5. SkiaSharp probe on every Studio folder"
for d in ${o11s//,/ }; do run --entrypoint dotnet "$img" /usr/local/lib/ssam-skia-probe/ssam-skia-probe.dll "$(o11dir "$d")" | tail -n 1 || fail=$((fail+1)); done
run --entrypoint dotnet "$img" /usr/local/lib/ssam-skia-probe/ssam-skia-probe.dll /studio/odc | tail -n 1 || fail=$((fail+1))
step "6. ssam doctor"
start=$(date +%s); run -w /app --entrypoint node "$img" facade/ssam.mjs doctor > "${TMPDIR:-/tmp}/doctor-$$.json" 2>&1; rc=$?
echo "doctor exit $rc in $(( $(date +%s) - start )) s"; head -c 4000 "${TMPDIR:-/tmp}/doctor-$$.json"; echo
echo; echo "SMOKE FAILURES $fail"; [ "$fail" = 0 ]
