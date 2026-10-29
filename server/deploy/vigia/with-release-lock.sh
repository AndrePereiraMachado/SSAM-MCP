#!/bin/sh
# All manual production writers must use this same lock as the watcher.
set -eu
exec flock -x -w 180 /var/lock/ssam-release.lock "$@"
