#!/bin/bash
# health.sh <image>: the server of the image in a throwaway container (--rm --init --pull=never --network none, no port, no
# volume of the host; removed with its anonymous volumes): seconds until /health answers, its answer, and the startup events
# o11-kernels / kernel of the log. Last line: "health ok in <n> s" or "health FAIL".
set -uo pipefail
img=$1 n=ssam-ensaio-health-$$
MSYS_NO_PATHCONV=1 docker run -d --rm --init --pull=never --network none --name "$n" "$img" >/dev/null || { echo "health FAIL (run)"; exit 1; }
t0=$(date +%s) h=
for _ in $(seq 1 60); do
  h=$(docker exec "$n" node -e "fetch('http://127.0.0.1:7310/health',{signal:AbortSignal.timeout(2000)}).then(r=>r.text()).then(t=>console.log(t)).catch(()=>process.exit(1))" 2>/dev/null) && break
  h=; sleep 1
done
s=$(( $(date +%s) - t0 ))
echo "/health: ${h:-none}"
docker logs "$n" 2>&1 | grep -E '"event":"(o11-kernels|kernel|kernel-version-missing)"' | head -n 5
docker rm -f -v "$n" >/dev/null 2>&1
case "$h" in *'"ok":true'*) echo "health ok in $s s" ;; *) echo "health FAIL"; exit 1 ;; esac
