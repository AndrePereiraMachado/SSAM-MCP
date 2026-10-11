#!/bin/sh
# Build of the production image (../Dockerfile, context ..), ALWAYS after the client-name guard: no other way of building
# is documented, and compose.prod.yml has no `build:` (a `docker compose build` cannot skip the guard).
#
#   sh deploy/build.sh [--tag <tag>] [--image <name>] [--push] [--no-cache] [-- <more buildx args>]
#
#   1. the guard platforms/odc/facade/tests/hosted-image-denylist.test.mjs, in the pinned node image of the Dockerfile,
#      without network and with the tree read-only: it reads the context exactly as Docker sends it (.dockerignore) and
#      fails on any client name of docker/ssam-server/client-denylist.json. A failure stops here;
#   2. docker buildx build for linux/amd64, with the Studio inputs of docker/installers (or STUDIO_INSTALLERS_DIR) and
#      their pinned SHA256 (the Dockerfile refuses an unpinned Studio), the OCI labels (version = tag, revision = commit,
#      created = now), loaded into the local Docker (default) or pushed to a PRIVATE registry (--push);
#   3. prints the tag and the image id, and with --push the digest to pin in .env (SSAM_IMAGE_TAG=<tag>@sha256:...).
# It never edits .env: switching SSAM_IMAGE_TAG is step 3 of the upgrade (DEPLOY.md section 8), after a good build.
#
# Values: flags, else the environment, else the .env next to this script (when present): SSAM_IMAGE (default ssam-server),
# STUDIO_INSTALLERS_DIR (relative to this folder), ODC_STUDIO_BUNDLE_SHA256, SERVICE_STUDIO_BUNDLE_SHA256 and, for other
# Studio files, ODC_STUDIO_BUNDLE, SERVICE_STUDIO_BUNDLE, ODC_STUDIO_INSTALLER, ODC_STUDIO_SHA256,
# SERVICE_STUDIO_INSTALLER, SERVICE_STUDIO_SHA256, STUDIO_EXTRACTOR. Default tag: prod-<yyyymmdd>-<short commit>, with
# "-dirty" when the work tree has uncommitted changes. Needs docker with buildx, and git for the default tag.
# LICENSE: the image carries OutSystems Studio binaries: load it locally or push it to a PRIVATE registry only.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
server=$(cd "$here/.." && pwd)
ENV_FILE=${SSAM_ENV_FILE:-$here/.env}
DOCKER=${DOCKER:-docker}
envval() { [ -f "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | sed 's/^"\(.*\)"$/\1/' || true; }
setting() { eval "v=\${$1:-}"; [ -n "$v" ] && printf '%s' "$v" || envval "$1"; }

TAG= IMAGE= PUSH=0 NOCACHE=
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG=$2; shift 2 ;;
    --image) IMAGE=$2; shift 2 ;;
    --push) PUSH=1; shift ;;
    --no-cache) NOCACHE=--no-cache; shift ;;
    --) shift; break ;;
    *) echo "build: unknown argument $1 (extra buildx arguments go after --)" >&2; exit 2 ;;
  esac
done
IMAGE=${IMAGE:-$(setting SSAM_IMAGE)}
IMAGE=${IMAGE:-ssam-server}

# Version and revision from git (the label org.opencontainers.image.revision is what a rollback checks out).
ref=unknown
if command -v git >/dev/null 2>&1 && git -C "$server" rev-parse HEAD >/dev/null 2>&1; then
  ref=$(git -C "$server" rev-parse HEAD)
  dirty=
  if [ -n "$(git -C "$server" status --porcelain --untracked-files=no -- . 2>/dev/null)" ]; then
    dirty=-dirty
    echo "build: WARNING: uncommitted changes under $server; the tag and the revision label say -dirty" >&2
  fi
  ref=$ref$dirty
  TAG=${TAG:-prod-$(date -u +%Y%m%d)-$(git -C "$server" rev-parse --short HEAD)$dirty}
fi
[ -n "$TAG" ] || { echo "build: no git here; give the tag: --tag prod-<yyyymmdd>-<commit>" >&2; exit 2; }
case "$TAG" in *[!A-Za-z0-9_.-]*) echo "build: the tag $TAG has characters a Docker tag does not take" >&2; exit 2 ;; esac

installers=$(setting STUDIO_INSTALLERS_DIR)
installers=${installers:-../docker/installers}
case "$installers" in /*) ;; *) installers=$(cd "$here" && cd "$installers" 2>/dev/null && pwd) || { echo "build: no Studio folder $(setting STUDIO_INSTALLERS_DIR)" >&2; exit 2; } ;; esac
[ -d "$installers" ] || { echo "build: no Studio folder $installers" >&2; exit 2; }

# 1. The client-name guard. The bind mount needs the host's own path form (Windows: C:/...).
host_server=$server
if command -v cygpath >/dev/null 2>&1; then host_server=$(cygpath -m "$server"); fi
node_image=$(sed -n 's/^ARG NODE_IMAGE=//p' "$server/Dockerfile" | head -n 1)
[ -n "$node_image" ] || { echo "build: no ARG NODE_IMAGE in $server/Dockerfile" >&2; exit 2; }
echo "build: client-name guard (hosted-image-denylist.test.mjs, $node_image, no network, read-only)"
# MSYS_NO_PATHCONV: Git Bash on Windows would rewrite the container paths (-w /src/...) into Windows paths; only for this
# command, since git and the build need the usual conversion of host paths.
MSYS_NO_PATHCONV=1 $DOCKER run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  -v "$host_server:/src:ro" -w /src/platforms/odc/facade "$node_image" \
  node --test --test-reporter=dot tests/hosted-image-denylist.test.mjs \
  || { echo "build: the client-name guard FAILED: a client name would ship; nothing was built" >&2; exit 1; }

# 2. The build. Only the Studio settings that are set become build args (the Dockerfile keeps its defaults otherwise);
#    they go after the extra buildx arguments already in "$@".
for name in ODC_STUDIO_BUNDLE ODC_STUDIO_BUNDLE_SHA256 ODC_STUDIO_INSTALLER ODC_STUDIO_SHA256 SERVICE_STUDIO_BUNDLE \
            SERVICE_STUDIO_BUNDLE_SHA256 SERVICE_STUDIO_INSTALLER SERVICE_STUDIO_SHA256 STUDIO_EXTRACTOR; do
  value=$(setting "$name")
  if [ -n "$value" ]; then set -- "$@" --build-arg "$name=$value"; fi
done
host_installers=$installers
if command -v cygpath >/dev/null 2>&1; then host_installers=$(cygpath -m "$installers"); fi
created=$(date -u +%Y-%m-%dT%H:%M:%SZ)
meta=$(mktemp)
trap 'rm -f "$meta"' EXIT
if [ "$PUSH" = 1 ]; then output=--push; else output=--load; fi
echo "build: $IMAGE:$TAG (revision $ref)"
started=$(date +%s)
cd "$server"
$DOCKER buildx build -f Dockerfile --platform linux/amd64 --build-context "installers=$host_installers" \
  "$@" --build-arg "SSAM_VERSION=$TAG" --build-arg "VCS_REF=$ref" --build-arg "BUILD_DATE=$created" \
  --metadata-file "$meta" $NOCACHE $output -t "$IMAGE:$TAG" .

# 3. What was built.
echo "build: done in $(( $(date +%s) - started )) s: $IMAGE:$TAG"
if [ "$PUSH" = 1 ]; then
  digest=$(sed -n 's/.*"containerimage\.digest"[^"]*"\(sha256:[0-9a-f]*\)".*/\1/p' "$meta" | head -n 1)
  echo "build: pushed; pin it in .env: SSAM_IMAGE=$IMAGE and SSAM_IMAGE_TAG=$TAG@$digest"
else
  echo "build: image id $($DOCKER image inspect --format '{{.Id}}' "$IMAGE:$TAG"), $($DOCKER image inspect --format '{{.Size}}' "$IMAGE:$TAG" | awk '{ printf "%.2f GB", $1 / 1e9 }')"
  echo "build: for this VPS: SSAM_IMAGE=$IMAGE and SSAM_IMAGE_TAG=$TAG in .env (DEPLOY.md section 8, step 3)"
fi
