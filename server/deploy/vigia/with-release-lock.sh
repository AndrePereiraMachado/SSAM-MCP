#!/bin/sh
# with-release-lock.sh <command...>: runs <command> holding /var/lock/ssam-release.lock, with the owner file
# /var/lock/ssam-release.owner ({"token","pid"}) for as long as it runs. Waits at most SSAM_LOCK_WAIT seconds (default
# 30) for another holder, then stops with a message (never waits in silence). The owner file is removed on exit AND on
# HUP/INT/TERM (an ssh drop), so a dead release never leaves a stale owner behind.
set -eu
wait=${SSAM_LOCK_WAIT:-30}
case "$wait" in ''|*[!0-9]*) echo "STOP: SSAM_LOCK_WAIT must be whole seconds" >&2; exit 2 ;; esac
# -F: flock does not fork; the lock fd stays with the sh -c that runs the command (no exec here: the wait message below needs this shell).
flock -x -F -w "$wait" -E 75 /var/lock/ssam-release.lock sh -c '
  umask 077
  token=$(cat /proc/sys/kernel/random/uuid)
  identity=$(printf "{\"token\":\"%s\",\"pid\":%s}" "$token" "$$")
  printf %s "$identity" > /var/lock/ssam-release.owner
  clean() { [ "$(cat /var/lock/ssam-release.owner 2>/dev/null)" != "$identity" ] || rm -f /var/lock/ssam-release.owner; }
  trap clean EXIT
  trap "clean; trap - EXIT; exit 129" HUP
  trap "clean; trap - EXIT; exit 130" INT
  trap "clean; trap - EXIT; exit 143" TERM
  "$@"
' sh "$@" || { rc=$?; [ "$rc" != 75 ] || echo "STOP: another release holds /var/lock/ssam-release.lock (waited ${wait}s): $(cat /var/lock/ssam-release.owner 2>/dev/null || echo 'no owner file')" >&2; exit "$rc"; }
