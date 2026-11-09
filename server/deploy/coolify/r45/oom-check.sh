#!/bin/bash
# oom-check.sh (r45 capacity, review R4 M2): READ-ONLY. Daily during the first week after the window (and after any burst):
# for each of the five backends, the container's OOM flag, restart count and start time (docker inspect), the cgroup
# memory.events counters oom and oom_kill, memory.peak and memory.max in MiB; then the host kernel's "oom-kill" lines since
# boot. Prints numbers only. Last line: OOM OK, or OOM FAIL <n>; any FAIL is the rollback trigger of step 9 and a tier review.
# The counters start at zero with each container (the Redeploy of the window recreates them), so they count since then.
# Run from the owner's machine:  ssh -i C:/Users/andre/.ssh/ssam_vps root@187.127.8.241 'bash -s' < oom-check.sh
# or on the VPS:                 bash /root/ssam-r45/oom-check.sh
set -u
U=ksqommjgowjjilpgpbmf7cdo
fail=0
for v in 1 2 3 4 5; do
  c=ssam-server-v$v-$U
  if ! docker inspect "$c" >/dev/null 2>&1; then echo "FAIL v$v: no container"; fail=$((fail+1)); continue; fi
  read -r killed restarts started <<<"$(docker inspect -f '{{.State.OOMKilled}} {{.RestartCount}} {{.State.StartedAt}}' "$c")"
  ev=$(docker exec "$c" cat /sys/fs/cgroup/memory.events 2>/dev/null)
  oom=$(printf '%s\n' "$ev" | awk '$1=="oom"{print $2}'); kill=$(printf '%s\n' "$ev" | awk '$1=="oom_kill"{print $2}')
  peak=$(docker exec "$c" cat /sys/fs/cgroup/memory.peak 2>/dev/null || echo 0); max=$(docker exec "$c" cat /sys/fs/cgroup/memory.max 2>/dev/null || echo 0)
  case "$max" in ''|*[!0-9]*) maxm=$max;; *) maxm=$((max/1048576));; esac
  echo "v$v oomKilled=$killed restarts=$restarts started=$started oom=${oom:-?} oom_kill=${kill:-?} peakMiB=$((${peak:-0}/1048576)) maxMiB=$maxm"
  [ "$killed" = false ] && [ "$restarts" = 0 ] && [ "${kill:-x}" = 0 ] || { echo "FAIL v$v: an OOM kill or a restart"; fail=$((fail+1)); }
done
host=$(dmesg 2>/dev/null | grep -c 'oom-kill' || true)
echo "host kernel oom-kill lines since boot: ${host:-0}"
[ "${host:-0}" = 0 ] || { echo "FAIL host: oom-kill in dmesg (read dmesg | grep -i oom)"; fail=$((fail+1)); }
[ "$fail" = 0 ] && echo "OOM OK" || echo "OOM FAIL $fail"
