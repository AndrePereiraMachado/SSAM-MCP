#!/bin/sh
# Publish an image deploy/build.sh already built and proved (a local ssam-server:<tag>) to a PRIVATE registry, so a VPS
# (Coolify: coolify/COOLIFY.md; or compose.prod.yml, DEPLOY.md 6B) pulls it. build.sh --push builds AND pushes; this one
# only pushes an image that already exists here, which is what a rehearsed image needs (DEPLOY.md section 12: the image
# that was proved is the image that goes).
#
#   sh deploy/publish.sh --image docker.io/<namespace>/ssam-server --tag prod-20261020-7770621 [--source ssam-server]
#                        [--private-repo-ready] [--latest | --latest-only]
#
#   1. `docker login` must have been done by the person (the script never takes a password);
#   2. on Docker Hub (docker.io) the repository must EXIST, created PRIVATE by the person in the Hub beforehand: a push
#      to a repository that does not exist makes the Hub create it PUBLIC (unless the account's default is private), and
#      from outside a private repository and a missing one look the same (anonymous 404, "no such manifest" with a login).
#      So the script refuses to push to docker.io without --private-repo-ready, the person's word that the private
#      repository is there, and refuses outright a repository anyone can already read (anonymous 200);
#   3. the local image <source>:<tag> is tagged <image>:<tag> and pushed; the digest is taken from the push itself;
#   4. the lines to pin are printed: SSAM_IMAGE=<image> and SSAM_IMAGE_TAG=<tag> for Coolify (its compose parser breaks a
#      reference with a digest into "<image>@sha256@sha256:..."), or SSAM_IMAGE_TAG=<tag>@sha256:<digest> for a plain
#      compose.prod.yml (.env). A tag already in the registry is never pushed again (step 3), so the tag alone is as fixed
#      as the digest; the digest is what ssamctl.sh status shows on the VPS, to compare;
#   5. on Docker Hub the repository is checked ANONYMOUSLY again after the push: readable by anyone = exit 3 and a loud
#      message (the image carries OutSystems Studio binaries: LICENSE, DEPLOY.md section 2);
#   6. --latest also moves the tag `latest` of the registry to this same image (the one tag that IS pushed again: a VPS
#      pinned to `latest` takes the next image with a plain Redeploy, COOLIFY.md 7). --latest-only moves `latest` to a
#      tag already in the registry without pushing the tag again (a rollback of `latest` to an older image, or `latest`
#      for an image published before this flag existed); the local image must be the registry's (same digest).
set -eu
DOCKER=${DOCKER:-docker}
IMAGE= TAG= SOURCE=ssam-server READY=0 LATEST=0 LATEST_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --image) IMAGE=$2; shift 2 ;;
    --tag) TAG=$2; shift 2 ;;
    --source) SOURCE=$2; shift 2 ;;
    --private-repo-ready) READY=1; shift ;;
    --latest) LATEST=1; shift ;;
    --latest-only) LATEST=1; LATEST_ONLY=1; shift ;;
    *) echo "publish: unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$IMAGE" ] || { echo "publish: --image <registry>/<namespace>/ssam-server is required" >&2; exit 2; }
[ -n "$TAG" ] || { echo "publish: --tag prod-<yyyymmdd>-<commit> is required (the local image to publish)" >&2; exit 2; }
case "$IMAGE" in */*) ;; *) echo "publish: --image must name the registry or the namespace (docker.io/<namespace>/ssam-server)" >&2; exit 2 ;; esac
case "$TAG" in *@*) echo "publish: --tag takes the tag alone, without a digest" >&2; exit 2 ;; esac

# The Docker Hub repository of --image (namespace/name), or empty for another registry.
hub_repo=
case "$IMAGE" in
  docker.io/*|index.docker.io/*) hub_repo=${IMAGE#docker.io/}; hub_repo=${hub_repo#index.docker.io/}; case "$hub_repo" in */*) ;; *) hub_repo=library/$hub_repo ;; esac ;;
  *.*/*|*:*/*) ;;
  *) hub_repo=$IMAGE ;;
esac
# Anonymous read of a Hub repository: 200 = anyone can read it, 404 = private or missing, other = could not check.
hub_visibility() { curl -s -o /dev/null -w '%{http_code}' "https://hub.docker.com/v2/repositories/$1/" 2>/dev/null || echo 000; }

$DOCKER image inspect "$SOURCE:$TAG" >/dev/null 2>&1 || { echo "publish: no local image $SOURCE:$TAG (deploy/build.sh builds it)" >&2; exit 2; }
revision=$($DOCKER image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$SOURCE:$TAG")
case "$revision" in *-dirty) echo "publish: the image $SOURCE:$TAG was built from a dirty tree ($revision): not published" >&2; exit 2 ;; esac

if [ -n "$hub_repo" ]; then
  if ! command -v curl >/dev/null 2>&1; then echo "publish: curl is needed to check the visibility of a Docker Hub repository" >&2; exit 2; fi
  case "$(hub_visibility "$hub_repo")" in
    200) echo "publish: REFUSED: the Docker Hub repository $hub_repo can be read by anyone. Make it private first (Hub > $hub_repo > Settings > Visibility)." >&2; exit 3 ;;
    404) [ "$READY" = 1 ] || { echo "publish: REFUSED: from here a private Docker Hub repository and a missing one look the same, and a push to a missing one creates it PUBLIC. Create $hub_repo as Private in the Hub (Create repository > Visibility: Private), then run again with --private-repo-ready." >&2; exit 2; } ;;
    *) echo "publish: could not check the visibility of $hub_repo (no answer from hub.docker.com); not pushing" >&2; exit 2 ;;
  esac
fi

out=$(mktemp)
trap 'rm -f "$out"' EXIT
# The digest of a push ("<tag>: digest: sha256:... size: ..."), else the repository digest Docker recorded (it drops the
# docker.io/ prefix of the name).
digest_of() {
  d=$(sed -n 's/.*digest: \(sha256:[0-9a-f]\{64\}\).*/\1/p' "$out" | tail -n 1)
  if [ -z "$d" ]; then
    short=${IMAGE#docker.io/}; short=${short#index.docker.io/}
    d=$($DOCKER image inspect --format '{{range .RepoDigests}}{{.}}{{"\n"}}{{end}}' "$1" | sed -n "s#^\($IMAGE\|$short\)@##p" | head -n 1)
  fi
  printf '%s' "$d"
}
# The digest the registry holds for a reference (its manifest list), or empty.
registry_digest() { $DOCKER buildx imagetools inspect "$1" 2>/dev/null | sed -n 's/^Digest: *\(sha256:[0-9a-f]\{64\}\).*/\1/p' | head -n 1; }

if [ "$LATEST_ONLY" = 1 ]; then
  # `latest` moved to a tag the registry already has: the local image must be that very image.
  in_registry=$(registry_digest "$IMAGE:$TAG")
  [ -n "$in_registry" ] || { echo "publish: REFUSED: $IMAGE:$TAG is not in the registry; publish it first (without --latest-only)" >&2; exit 2; }
  $DOCKER tag "$SOURCE:$TAG" "$IMAGE:$TAG"
  digest=$in_registry
  echo "publish: $IMAGE:$TAG is in the registry ($digest); only latest moves"
else
  # A tag already in the registry is never pushed again: what a VPS pinned by tag keeps meaning the same bits (Coolify
  # cannot take the digest form: COOLIFY.md 1). A new build gets a new tag.
  if $DOCKER manifest inspect "$IMAGE:$TAG" >/dev/null 2>&1; then
    echo "publish: REFUSED: $IMAGE:$TAG already exists in the registry; a tag is never pushed twice. Build with a new tag (deploy/build.sh --tag), or --latest-only to move latest to it." >&2; exit 2
  fi
  echo "publish: $SOURCE:$TAG (revision $revision) -> $IMAGE:$TAG"
  $DOCKER tag "$SOURCE:$TAG" "$IMAGE:$TAG"
  $DOCKER push "$IMAGE:$TAG" 2>&1 | tee "$out"
  digest=$(digest_of "$IMAGE:$TAG")
  [ -n "$digest" ] || { echo "publish: pushed, but the digest could not be read: docker buildx imagetools inspect $IMAGE:$TAG shows it" >&2; exit 1; }
  echo "publish: pushed. Pin it:"
  echo "  SSAM_IMAGE=$IMAGE"
  echo "  SSAM_IMAGE_TAG=$TAG                 (Coolify: the tag alone; its parser breaks a reference with a digest)"
  echo "  SSAM_IMAGE_TAG=$TAG@$digest   (compose.prod.yml .env: with the digest)"
  echo "publish: the digest to compare on the VPS (ssamctl.sh status, or docker image inspect RepoDigests): $digest"
fi

if [ "$LATEST" = 1 ]; then
  # The moving tag: the same bits as $TAG (checked by digest after the push), so a VPS on `latest` pulls this image next.
  $DOCKER tag "$SOURCE:$TAG" "$IMAGE:latest"
  : > "$out"
  $DOCKER push "$IMAGE:latest" 2>&1 | tee "$out"
  latest_digest=$(digest_of "$IMAGE:latest")
  [ "$latest_digest" = "$digest" ] || { echo "publish: latest was pushed but its digest ($latest_digest) is not the tag's ($digest); check the registry" >&2; exit 1; }
  echo "publish: latest -> $TAG ($digest). A VPS with SSAM_IMAGE_TAG=latest takes it at the next Redeploy (COOLIFY.md 7); ssamctl.sh status shows the digest it runs."
fi

if [ -n "$hub_repo" ]; then
  case "$(hub_visibility "$hub_repo")" in
    404) echo "publish: Docker Hub repository $hub_repo is private (anonymous read: 404). Good." ;;
    200) echo "publish: WARNING: Docker Hub repository $hub_repo is PUBLIC: anyone can pull the OutSystems binaries in it. Make it private NOW (Hub > $hub_repo > Settings > Visibility) or delete the repository." >&2; exit 3 ;;
    *) echo "publish: could not check the visibility of $hub_repo after the push; check it in the Hub yourself" >&2 ;;
  esac
fi
