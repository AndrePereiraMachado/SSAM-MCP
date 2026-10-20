#!/bin/sh
# Publish an image deploy/build.sh already built and proved (a local ssam-server:<tag>) to a PRIVATE registry, so a VPS
# (Coolify: coolify/COOLIFY.md; or compose.prod.yml, DEPLOY.md 6B) pulls it. build.sh --push builds AND pushes; this one
# only pushes an image that already exists here, which is what a rehearsed image needs (DEPLOY.md section 12: the image
# that was proved is the image that goes).
#
#   sh deploy/publish.sh --image docker.io/<namespace>/ssam-server --tag prod-20261020-7770621 [--source ssam-server]
#
#   1. `docker login` must have been done by the person (the script never takes a password);
#   2. the local image <source>:<tag> is tagged <image>:<tag> and pushed;
#   3. the digest of the push is read back (docker buildx imagetools inspect) and the line to pin in Coolify (or in .env)
#      is printed: SSAM_IMAGE=<image> and SSAM_IMAGE_TAG=<tag>@sha256:<digest>;
#   4. on Docker Hub (docker.io), the repository is checked ANONYMOUSLY afterwards: a repository anyone can read is a
#      LICENSE problem (the image carries OutSystems Studio binaries) and the script says so, loudly, with exit 3. A
#      repository that does not exist yet is created PUBLIC by Docker Hub on the first push unless the account's default
#      is private: create it private in the Hub first (COOLIFY.md 1), then push.
set -eu
DOCKER=${DOCKER:-docker}
IMAGE= TAG= SOURCE=ssam-server
while [ $# -gt 0 ]; do
  case "$1" in
    --image) IMAGE=$2; shift 2 ;;
    --tag) TAG=$2; shift 2 ;;
    --source) SOURCE=$2; shift 2 ;;
    *) echo "publish: unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$IMAGE" ] || { echo "publish: --image <registry>/<namespace>/ssam-server is required" >&2; exit 2; }
[ -n "$TAG" ] || { echo "publish: --tag prod-<yyyymmdd>-<commit> is required (the local image to publish)" >&2; exit 2; }
case "$IMAGE" in */*) ;; *) echo "publish: --image must name the registry or the namespace (docker.io/<namespace>/ssam-server)" >&2; exit 2 ;; esac
case "$TAG" in *@*) echo "publish: --tag takes the tag alone, without a digest" >&2; exit 2 ;; esac

$DOCKER image inspect "$SOURCE:$TAG" >/dev/null 2>&1 || { echo "publish: no local image $SOURCE:$TAG (deploy/build.sh builds it)" >&2; exit 2; }
revision=$($DOCKER image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$SOURCE:$TAG")
case "$revision" in *-dirty) echo "publish: the image $SOURCE:$TAG was built from a dirty tree ($revision): not published" >&2; exit 2 ;; esac
echo "publish: $SOURCE:$TAG (revision $revision) -> $IMAGE:$TAG"
$DOCKER tag "$SOURCE:$TAG" "$IMAGE:$TAG"
$DOCKER push "$IMAGE:$TAG"
digest=$($DOCKER buildx imagetools inspect "$IMAGE:$TAG" --format '{{json .Manifest.Digest}}' 2>/dev/null | tr -d '"' || true)
[ -n "$digest" ] || digest=$($DOCKER image inspect --format '{{range .RepoDigests}}{{.}}{{"\n"}}{{end}}' "$IMAGE:$TAG" | sed -n "s|^$IMAGE@||p" | head -n 1)
echo "publish: pushed. Pin it in Coolify (Environment Variables) or in .env:"
echo "  SSAM_IMAGE=$IMAGE"
echo "  SSAM_IMAGE_TAG=$TAG@$digest"

# 4. Visibility on Docker Hub: an anonymous GET of the repository answers 200 for a public one, 404 for a private one.
case "$IMAGE" in
  docker.io/*|index.docker.io/*)
    repo=${IMAGE#docker.io/}; repo=${repo#index.docker.io/}
    case "$repo" in */*) ;; *) repo=library/$repo ;; esac
    if command -v curl >/dev/null 2>&1; then
      code=$(curl -s -o /dev/null -w '%{http_code}' "https://hub.docker.com/v2/repositories/$repo/" || echo 000)
      case "$code" in
        404) echo "publish: Docker Hub repository $repo is private (anonymous read: 404). Good." ;;
        200) echo "publish: WARNING: Docker Hub repository $repo is PUBLIC: anyone can pull the OutSystems binaries in it. Make it private NOW (Hub > repository > Settings > Visibility) or delete the tag." >&2; exit 3 ;;
        *) echo "publish: could not check the visibility of $repo (HTTP $code); check it in the Hub yourself" >&2 ;;
      esac
    fi
    ;;
esac
