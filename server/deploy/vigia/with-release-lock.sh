#!/bin/sh
set -eu
# -F keeps the lock in the same PID that owns this shell and its child command.
exec flock -x -F /var/lock/ssam-release.lock sh -c '
  umask 077
  token=$(cat /proc/sys/kernel/random/uuid)
  identity=$(printf "{\"token\":\"%s\",\"pid\":%s}" "$token" "$$")
  printf %s "$identity" > /var/lock/ssam-release.owner
  trap '\''[ "$(cat /var/lock/ssam-release.owner 2>/dev/null)" != "$identity" ] || rm -f /var/lock/ssam-release.owner'\'' EXIT
  "$@"
' sh "$@"
