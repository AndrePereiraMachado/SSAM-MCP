#!/bin/bash
# kit-check.sh <image> <odc> <default o11> <o11 kernels, comma>: what the S1 kit of trilha C (server/deploy/coolify/s1, RESULTADO.md 5.4 and
# pre-window-readings.sh part 11) expects of each new image of the window 4x4, checked on the image itself (the kit scripts
# of THIS checkout: deploy/coolify/s1, deploy/kernel-pair-check.mjs, deploy/vigia, deploy/coolify). Labels by `docker image inspect`;
# everything else in ONE throwaway container (--rm --network none --user 0, the kit scripts of the integration clone mounted
# read-only, synthetic data made inside the container, nothing of the host written):
#   1. ssam.kernels.o11 = the 4 kernels, ssam.kernels.odc = <odc>, ssam.kernels.o11.default;
#   2. sh node find tar stat sha256sum present; /app/platforms present;
#   3. copy-volume.sh /s -> /d (owners 10001 and 0, modes 0750/0640/0600, a link) and manifest.sh: the two manifests equal;
#   4. copy-state.sh copy then verify on a synthetic customer state (pair -> backend);
#   5. kernel-derive.mjs on a pair kernel.json, then kernel-pair-check.mjs check on the derived one, for each of the 4 O11
#      (exit 0: the image has that O11 and that ODC); and the refusal of a kernel.json of an O11 the image does not have;
#   6. the window-retiring notice modules (deploy/vigia + deploy/coolify of the kit, mounted at /app/deploy) import in /app.
# Last line: "KIT OK" or "KIT FAIL <n>".
set -uo pipefail
img=$1 odc=$2 def=$3 K4=$4
R=$(cd "$(dirname "$0")/.." && pwd)
[ -f "$R/coolify/s1/copy-volume.sh" ] || { echo "no S1 kit (deploy/coolify/s1) in this checkout"; echo "KIT FAIL 1"; exit 1; }
fail=0; ok() { echo "ok   $*"; }; no() { echo "FAIL $*"; fail=$((fail+1)); }
lab() { docker image inspect -f "{{index .Config.Labels \"$1\"}}" "$img"; }
[ "$(lab ssam.kernels.o11)" = "$K4" ] && ok "ssam.kernels.o11=$K4" || no "ssam.kernels.o11=$(lab ssam.kernels.o11)"
[ "$(lab ssam.kernels.odc)" = "$odc" ] && ok "ssam.kernels.odc=$odc" || no "ssam.kernels.odc=$(lab ssam.kernels.odc)"
[ "$(lab ssam.kernels.o11.default)" = "$def" ] && ok "ssam.kernels.o11.default=$def" || no "ssam.kernels.o11.default=$(lab ssam.kernels.o11.default)"
echo "storage: $(docker info -f '{{.Driver}}' 2>/dev/null) (Docker Desktop containerd store: no GraphDriver, the helpers are RUN here; the VPS reads them from overlay2 layers)"
w=$R; command -v cygpath >/dev/null 2>&1 && w=$(cygpath -m "$R")
MSYS_NO_PATHCONV=1 docker run --rm --pull=never --network none --user 0 --entrypoint sh \
  -v "$w/coolify/s1:/k:ro" -v "$w/kernel-pair-check.mjs:/c.mjs:ro" -v "$w/vigia:/app/deploy/vigia:ro" -v "$w/coolify:/app/deploy/coolify:ro" \
  "$img" -c '
set -u; f=0; ok() { echo "ok   $*"; }; no() { echo "FAIL $*"; f=$((f+1)); }
miss=; for t in sh node find tar stat sha256sum; do command -v $t >/dev/null || miss="$miss $t"; done
[ -z "$miss" ] && ok "helpers: sh node find tar stat sha256sum ($(command -v tar) $(command -v stat) $(command -v sha256sum))" || no "helpers missing:$miss"
[ -d /app/platforms ] && ok "/app/platforms" || no "/app/platforms missing"
# 3. a volume copy
mkdir -p /s/sub /d && echo a > /s/a && echo b > /s/sub/b && ln -s a /s/l && chown -R 10001:10001 /s && chown 0:0 /s/sub/b && chmod 0750 /s && chmod 0640 /s/a && chmod 0600 /s/sub/b
sh /k/copy-volume.sh >/tmp/cv.out 2>&1 && ok "copy-volume.sh" || { no "copy-volume.sh"; cat /tmp/cv.out; }
sh /k/manifest.sh /s > /tmp/ms && sh /k/manifest.sh /d > /tmp/md && cmp -s /tmp/ms /tmp/md && ok "manifest.sh: /s and /d equal ($(wc -l < /tmp/ms) lines: owners, modes, sizes, sha256)" || { no "manifests differ"; diff /tmp/ms /tmp/md | head; }
mkdir -p /d2 && echo x > /d2/x && sh /k/copy-volume.sh >/dev/null 2>&1; true
# 4. per-customer state
P=o11-'"$def"'-odc-'"$odc"' B=odc-'"$odc"'
mkdir -p /data/server/customers/c1/state/versions/$P/grants /data/server/customers/c1/state/versions/$P/service-center /data/server/customers/c1/state/versions/$P/locks
echo g > /data/server/customers/c1/state/versions/$P/grants/g.json && echo s > /data/server/customers/c1/state/versions/$P/service-center/s.json
chown -R 10001:10001 /data/server/customers
sh /k/copy-state.sh copy "$P=$B" > /tmp/cs.out 2>&1 && ok "copy-state.sh copy $P=$B ($(tail -n 1 /tmp/cs.out))" || { no "copy-state.sh copy"; cat /tmp/cs.out; }
sh /k/copy-state.sh verify "$P=$B" > /tmp/cv2.out 2>&1 && ok "copy-state.sh verify ($(tail -n 1 /tmp/cv2.out))" || { no "copy-state.sh verify"; cat /tmp/cv2.out; }
[ ! -e /data/server/customers/c1/state/versions/$B/locks ] && ok "locks stay with the pair" || no "locks were copied"
# 5. kernel.json of each runtime
echo "{\"odc\":\"'"$odc"'\",\"o11\":\"'"$def"'\"}" > /tmp/pair.json
for v in '"${K4//,/ }"'; do
  node /k/kernel-derive.mjs /tmp/pair.json $v > /tmp/k-$v.json 2>/tmp/kd.err && node /c.mjs check /tmp/k-$v.json > /tmp/kc.out 2>&1 \
    && ok "kernel-derive + pair check o11 $v / odc '"$odc"': $(cat /tmp/kc.out)" || { no "kernel o11 $v"; cat /tmp/kd.err /tmp/kc.out; }
done
echo "{\"odc\":\"'"$odc"'\",\"o11\":\"1.0.0\"}" > /tmp/k-bad.json; node /c.mjs check /tmp/k-bad.json > /tmp/kb.out 2>&1; rc=$?
[ $rc = 2 ] && ok "pair check refuses o11 1.0.0 (exit 2: $(cat /tmp/kb.out | cut -c1-120))" || no "pair check of 1.0.0 exit $rc"
# 6. the notice modules import inside /app
cd /app && node --input-type=module -e "await import(\"/app/deploy/vigia/affected-customers.mjs\"); console.log(\"imports\")" > /tmp/n.out 2>&1 \
  && ok "affected-customers.mjs imports resolve in /app" || { no "affected-customers.mjs import"; head -5 /tmp/n.out; }
echo "IN-CONTAINER FAILURES $f"; exit $f'
rc=$?; [ $rc = 0 ] || fail=$((fail+rc))
[ "$fail" = 0 ] && echo "KIT OK" || echo "KIT FAIL $fail"
