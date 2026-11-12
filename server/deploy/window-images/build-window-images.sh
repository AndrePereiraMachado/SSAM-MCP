#!/bin/bash
# build-window-images.sh: the production images of a release in one command (trilha D, IMAGENS.md section 12). From server/:
#
#   bash deploy/window-images/build-window-images.sh --commit <sha of the signed merge on main> --release rNN
#        --owner-key <owner's ssh public key file> [--mode backends|pairs] [--only 1.7.32,1.7.31] [--out <dir>] [--min-free-gb 12]
#   bash deploy/window-images/build-window-images.sh --commit <sha> --ensaio ...      (a rehearsal: tags ensaio-..., any commit)
#   bash deploy/window-images/build-window-images.sh --source <sha> --fix <commit|patch file>[,...] --mode pairs --only <odcs>
#        --release rNN --owner-key <file> --expect-fix <sha40>[,...] --expect-blob <server/path>=<blob>[,...] [--ensaio] ...
#        (a CORRECTION image: a production commit plus the correction commits,
#        in the order --fix names them, X1 then X1d: --source is one commit on the production commit, source-rules.mjs)
#
# What it does, in order, and it STOPS at the first failure:
#   1. refuses unless the tree under server/ is clean (no change, no untracked file);
#      --commit: HEAD must be --commit (the image is that commit); without --ensaio, --commit must be on the remote main
#        (refs/remotes/origin/main: run `git fetch` first) and signed by the OWNER'S KEY (--owner-key: git verify-commit against
#        that one key, source-rules.mjs signed; `%G?` is no such check: without an allowed-signers file it says N for her signed
#        merge, with one it says G for any key the file lists);
#      --source (the correction window, X1): the tooling (this script, the generator, the smoke) is this checkout's, which must
#        be on the remote main without --ensaio (the production commits 60e13ec and dfb584d have none of it); pairs mode and
#        --only; the pairs and the Studio sources are origin/main's versions.json (this checkout's must list the same images);
#   2. window-images.mjs specs: one spec per image from that versions.json, every Studio from a pair image of that file (the
#      trust list of gen-dockerfile.mjs, D1), and the tags (vigia format, --release after the date; --source: its short sha);
#   3. refuses unless every source pair image is already in the local image store (the build never pulls a Studio, and no
#      credential is used: DOCKER_CONFIG is an empty folder for every docker call of this script);
#   3b. --source: the rule of source-rules.mjs source (not on main; its one parent is the production commit of every pair of
#      --only, the revision label of the pair image; it changes exactly what --fix changes, never the build recipe; --fix is
#      the reviewed --expect-fix and each corrected file the reviewed --expect-blob; without --ensaio, signed by the owner's
#      SSH key, and --expect-fix / --expect-blob required), then a CLEAN TREE of --source in <out>/tree (git read-tree + checkout-index with a throwaway index: no
#      worktree, no checkout, this work tree and its index untouched), checked with diff-files and a file count;
#   4. per image, newest ODC first: gen-dockerfile.mjs (checkout trust) and deploy/build.sh --load (empty installers, no env
#      file, the build metadata kept); --source instead builds an OVERLAY (overlay.mjs, trilha C's I4): FROM the production
#      image of its pair by digest plus one COPY per corrected file with production's mode and owner, nothing compiled or
#      installed (a rebuild moved libsqlite3-0 2.8 -> 2.9); both under a disk guard that stops the buildx process below
#      --min-free-gb free; then the smoke (smoke.sh; --source: SMOKE_LAYOUT=overlay), /health (health.sh), for the window
#      4x4 the S1 kit checks (kit-check.sh), and for --source image-diff.mjs (equal, file for file, to the production image
#      of its pair but the correction's files) and overlay.mjs proof (read from docker save: production's layers first,
#      byte for byte, then only the planned files);
#   5. prints, per image, the tag, the local id and the exact `docker push` the owner runs after her own `docker login`, and
#      writes <out>/built.json for the next step (window-images.mjs images, after the push).
# It NEVER pushes, logs in, or touches a running container or another image. Everything goes to <out> (default
# deploy/.generated/window-images-<commit>, git-ignored with deploy/.generated).
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd); server=$(cd "$here/../.." && pwd)
commit= source= fix= expectfix= expectblob= ownerkey= ensaio=0 release= mode=backends only= out= minfree=12 image=docker.io/andrepereiramachado/ssam-server
while [ $# -gt 0 ]; do case "$1" in
  --commit) commit=$2; shift 2 ;; --source) source=$2; shift 2 ;; --fix) fix=$2; shift 2 ;; --owner-key) ownerkey=$2; shift 2 ;;
  --expect-fix) expectfix=$2; shift 2 ;; --expect-blob) expectblob=$2; shift 2 ;;
  --ensaio) ensaio=1; shift ;; --release) release=$2; shift 2 ;; --mode) mode=$2; shift 2 ;;
  --only) only=$2; shift 2 ;; --out) out=$2; shift 2 ;; --min-free-gb) minfree=$2; shift 2 ;; --image) image=$2; shift 2 ;;
  *) echo "build-window-images: unknown argument $1" >&2; exit 2 ;; esac; done
stop() { echo "STOP: $1" >&2; exit "${2:-1}"; }
[ -n "$commit" ] && [ -n "$source" ] && stop "--commit (a release of main) or --source (a correction), not both" 2
[ -n "$commit$source" ] || stop "--commit <sha> (a release of main) or --source <sha> --fix <commit|patch> (a correction)" 2
case "$mode" in backends|pairs) ;; *) stop "--mode backends|pairs" 2 ;; esac
[ $ensaio = 1 ] && [ "$image" = docker.io/andrepereiramachado/ssam-server ] && image=ssam-ensaio
g() { git -C "$server" "$@"; }
win() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi; }
rules() { local verb=$1; shift; node "$(win "$here/source-rules.mjs")" "$verb" --repo "$(win "$server")" "$@"; }
clean() { [ -z "$(g status --porcelain --untracked-files=normal -- .)" ] || stop "the tree under server/ is not clean (git status): the image must be the commit, the tooling the checkout's" 2; }
production() { [ $ensaio = 1 ] && return 0
  g rev-parse --verify -q refs/remotes/origin/main >/dev/null || stop "no refs/remotes/origin/main: git fetch origin first" 2
  case "$release" in r[0-9]*) ;; *) stop "--release rNN is required for production tags (as r46)" 2 ;; esac
  [ -n "$ownerkey" ] && [ -f "$ownerkey" ] || stop "--owner-key <the owner's ssh public key file> is required for production tags: her signature is checked by her key" 2; }
if [ -n "$commit" ]; then
  [ -z "$fix$expectfix$expectblob" ] || stop "--fix, --expect-fix and --expect-blob are for --source" 2
  full=$(g rev-parse --verify "$commit^{commit}" 2>/dev/null) || stop "$commit is not a commit here" 2
  [ "$(g rev-parse HEAD)" = "$full" ] || stop "HEAD is $(g rev-parse --short HEAD), not $commit: check the commit out first (git checkout $commit)" 2
  clean; production
  if [ $ensaio = 0 ]; then
    g merge-base --is-ancestor "$full" refs/remotes/origin/main || stop "$commit is not on the remote main (origin/main $(g rev-parse --short refs/remotes/origin/main); git fetch, or --ensaio for a rehearsal)" 2
    rules signed --commit "$full" --owner-key "$(win "$ownerkey")" >/dev/null || stop "$commit is not signed by the owner's key $(basename "$ownerkey") (the release is her signed merge on main)" 2
  fi
  short=$(g rev-parse --short=7 HEAD) versions=$server/deploy/coolify/versions.json
else
  clean; production
  [ -n "$fix" ] || stop "--source needs --fix <the correction commit, or its patch file>" 2
  [ "$mode" = pairs ] || stop "--source builds pair images (--mode pairs): the correction keeps each backend on its pair" 2
  [ -n "$only" ] || stop "--source needs --only <the ODCs of the pairs of its production commit>" 2
  full=$(g rev-parse --verify "$source^{commit}" 2>/dev/null) || stop "$source is not a commit here" 2
  g rev-parse --verify -q refs/remotes/origin/main >/dev/null || stop "no refs/remotes/origin/main: git fetch origin first (the pairs are main's)" 2
  [ $ensaio = 1 ] || g merge-base --is-ancestor HEAD refs/remotes/origin/main || stop "the tooling checkout $(g rev-parse --short HEAD) is not on the remote main: run --source from a clean checkout of main" 2
  short=$(g rev-parse --short=7 "$full")
fi
date=$(date -u +%Y%m%d)
out=${out:-$server/deploy/.generated/window-images-$short}; mkdir -p "$out" || stop "cannot write $out" 2; out=$(cd "$out" && pwd)   # absolute: git -C reads a relative path from the repository root
cfg=$out/docker-config-empty inst=$out/empty-installers; mkdir -p "$cfg" "$inst"
export DOCKER_CONFIG=$cfg
if [ -n "$source" ]; then
  # The pairs of production: origin/main's versions.json; this checkout's (the generator's trust list) must list the same images.
  versions=$out/versions-origin-main.json
  g show refs/remotes/origin/main:server/deploy/coolify/versions.json > "$versions" || stop "cannot read versions.json of origin/main"
  node -e 'const [a,b]=process.argv.slice(1).map(f=>JSON.parse(require("fs").readFileSync(f,"utf8")));const k=v=>JSON.stringify({odc:v.odc,o11:v.o11,studioSources:v.studioSources??null});process.exit(k(a)===k(b)?0:1)' \
    "$(win "$versions")" "$(win "$server/deploy/coolify/versions.json")" || stop "the pair images of this checkout's versions.json are not origin/main's: the Studio sources and the parent rule are main's (git fetch; run from main)"
fi
freegb() { df -k "$server" | tail -1 | awk '{printf "%.2f", $4/1048576}'; }
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$out/run.txt"; }
t00=$(date +%s)
log "$([ -n "$source" ] && echo "source (correction) $short, fix $fix" || echo "commit $short") ($([ $ensaio = 1 ] && echo ENSAIO || echo "release $release, signed by the owner's key $(basename "$ownerkey")")), mode $mode, image $image, free $(freegb) GB"

# 2. specs and tags
node "$here/window-images.mjs" specs --versions "$(win "$versions")" --commit "$short" --date "$date" \
  ${release:+--release "$release"} --mode "$mode" $([ $ensaio = 1 ] && echo --ensaio) --image "$image" --out "$(win "$out")" | tee -a "$out/run.txt" \
  || stop "window-images.mjs specs refused"
plan=$out/plan.json
ids=$(node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1]));const o=process.argv[2]?process.argv[2].split(","):null;console.log(p.filter(x=>!o||o.includes(x.odc)).map(x=>x.id).join(" "))' "$(win "$plan")" "$only")
[ -n "$ids" ] || stop "--only $only names no ODC of the window"
field() { node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1])).find(x=>x.id===process.argv[2]);const v=p[process.argv[3]];console.log(Array.isArray(v)?v.join(process.argv[4]||","):v)' "$(win "$plan")" "$1" "$2" "${3:-}"; }

# 3. every source pair image local
for s in $(node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1]));const o=process.argv[2]?process.argv[2].split(","):null;console.log([...new Set(p.filter(x=>!o||o.includes(x.odc)).flatMap(x=>x.sources))].join(" "))' "$(win "$plan")" "$only"); do
  docker image inspect "$s" >/dev/null 2>&1 || stop "the source image $s is not in the local store: the owner pulls it after her login (docker pull $s), then run again"
done
log "sources: every pair image is local"

# 3b. a correction: the rule, then the clean tree of --source
src=$server
if [ -n "$source" ]; then
  fixarg=; old=$IFS; IFS=,; for f in $fix; do [ -f "$f" ] && f=$(win "$f"); fixarg=${fixarg:+$fixarg,}$f; done; IFS=$old
  expect=(); [ -n "$expectfix" ] && expect+=(--expect-fix "$expectfix"); [ -n "$expectblob" ] && expect+=(--expect-blob "$expectblob")
  if [ $ensaio = 1 ]; then rules source --source "$full" --fix "$fixarg" --plan "$(win "$plan")" --only "$only" "${expect[@]}" --ensaio > "$out/source.json"
  else rules source --source "$full" --fix "$fixarg" --plan "$(win "$plan")" --only "$only" "${expect[@]}" --owner-key "$(win "$ownerkey")" > "$out/source.json"; fi \
    || stop "the correction rule refused $source (source-rules.mjs above)"
  log "rule: $(cat "$out/source.json")"
  tree=$out/tree idx=$(win "$out/tree.index")
  if [ -e "$tree" ]; then [ -f "$tree/.ssam-source-tree" ] || stop "$tree exists and is no tree of this script: move it away"; rm -rf "$tree"; fi
  rm -f "$idx"; mkdir -p "$tree"
  GIT_INDEX_FILE=$idx g read-tree "$full" || stop "git read-tree $source"
  GIT_INDEX_FILE=$idx g ls-files -z -- . | GIT_INDEX_FILE=$idx g checkout-index -z --stdin --prefix="$(win "$tree")/" || stop "git checkout-index of $source"
  gd=$(g rev-parse --absolute-git-dir)
  GIT_INDEX_FILE=$idx git --git-dir="$gd" --work-tree="$tree" -C "$tree" update-index -q --refresh >/dev/null 2>&1
  GIT_INDEX_FILE=$idx git --git-dir="$gd" --work-tree="$tree" -C "$tree" diff-files --quiet -- server || stop "the tree of $source in $tree is not the commit (diff-files)"
  n=$(GIT_INDEX_FILE=$idx g ls-files -- . | wc -l) m=$(cd "$tree/server" && find . -type f -o -type l | wc -l)
  [ "$n" = "$m" ] || stop "the tree of $source has $m files, the commit $n"
  echo "$full" > "$tree/.ssam-source-tree"
  src=$tree/server
  log "tree: $source checked out clean into $tree ($n files of server/)"
fi

# 4. build and smoke, one at a time
echo '[' > "$out/built.json.part"; first=1
for id in $ids; do
  odc=$(field "$id" odc) tag=$(field "$id" tag) def=$(field "$id" default) kernels=$(field "$id" kernels)
  ref=$image:$tag d=$out/$id; mkdir -p "$d"
  docker image inspect "$ref" >/dev/null 2>&1 && stop "$ref already exists locally: a new build would retag it (remove it or use another date)"
  f=$(freegb); awk -v a="$f" -v m="$minfree" 'BEGIN{exit !(a<m)}' && stop "only $f GB free before $id (minimum $minfree)"
  log "$id: $ref (default O11 $def, kernels $kernels), free $f GB"
  srcimg=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).odc.fromImage)' "$(win "$out/specs/$id.json")")
  if [ -n "$source" ]; then
    # A correction is an OVERLAY on the production image of its pair (trilha C, I4): FROM <production>@<digest> plus one
    # COPY per corrected file, with production's mode and owner. Nothing is compiled or installed, so every production layer
    # (system packages, kernels, Studios) stays byte for byte; overlay.mjs proof checks it after the smoke.
    node "$(win "$here/overlay.mjs")" plan --old "$srcimg" --tree "$(win "$tree")" \
      --files "$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).files.join(","))' "$(win "$out/source.json")")" \
      > "$d/overlay-plan.json" 2> "$d/overlay.out" || { cat "$d/overlay.out"; stop "$id: overlay.mjs plan refused"; }
    node "$(win "$here/overlay.mjs")" dockerfile --old "$srcimg" --plan "$(win "$d/overlay-plan.json")" --tree "$(win "$tree")" \
      --version "$tag" --revision "$full" --created "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --out "$(win "$d/context")" >> "$d/overlay.out" 2>&1 \
      || { cat "$d/overlay.out"; stop "$id: overlay.mjs dockerfile refused"; }
  else
    ( cd "$server" && node deploy/gen-dockerfile.mjs "$(win "$out/specs/$id.json")" "$(win "$d/Dockerfile")" ) > "$d/gen.out" 2>&1 || { cat "$d/gen.out"; stop "$id: gen-dockerfile.mjs refused"; }
  fi
  t0=$(date +%s) min=$(freegb) guard=
  if [ -n "$source" ]; then
    # --pull=false: the FROM is the production image already in the local store (step 3); nothing is pulled.
    docker buildx build --platform linux/amd64 --pull=false --provenance=false --sbom=false --load --progress plain \
      --metadata-file "$(win "$d/meta.json")" -t "$ref" "$(win "$d/context")" > "$d/build.log" 2>&1 &
  else
  ( cd "$server" && STUDIO_INSTALLERS_DIR=$inst SSAM_ENV_FILE=$out/none.env SSAM_DOCKERFILE=$(win "$d/Dockerfile") SSAM_BUILD_METADATA_FILE=$(win "$d/meta.json") \
    sh deploy/build.sh --image "$image" --tag "$tag" -- --progress plain ) > "$d/build.log" 2>&1 &
  fi
  pid=$!
  while kill -0 $pid 2>/dev/null; do
    f=$(freegb); awk -v a="$f" -v b="$min" 'BEGIN{exit !(a<b)}' && min=$f
    if awk -v a="$f" -v m="$minfree" 'BEGIN{exit !(a<m)}'; then
      guard="stopped at $f GB free"
      if command -v powershell.exe >/dev/null 2>&1; then
        powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.CommandLine -like '*buildx*build*$tag*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }" >/dev/null 2>&1
      else pkill -f "buildx.*build.*$tag" 2>/dev/null; fi
      kill $pid 2>/dev/null; break
    fi
    sleep 5
  done
  wait $pid; rc=$?; secs=$(( $(date +%s) - t0 ))
  log "$id: build rc=$rc in $secs s (min free $min GB)${guard:+, GUARD $guard}"
  [ $rc = 0 ] && [ -z "$guard" ] || { tail -n 25 "$d/build.log"; stop "$id: the build failed (log $d/build.log)"; }
  t1=$(date +%s)
  SMOKE_LAYOUT=$([ -n "$source" ] && echo overlay || echo multi) bash "$here/smoke.sh" "$ref" "$srcimg" "$kernels" "$def" "$odc" > "$d/smoke.out" 2>&1; rc=$?
  log "$id: smoke $(grep 'SMOKE FAILURES' "$d/smoke.out") in $(( $(date +%s) - t1 )) s"
  [ $rc = 0 ] || stop "$id: the smoke failed ($d/smoke.out)"
  bash "$here/health.sh" "$ref" > "$d/health.out" 2>&1 || { cat "$d/health.out"; stop "$id: /health failed"; }
  log "$id: $(tail -n 1 "$d/health.out")"
  if [ "$mode" = backends ]; then
    bash "$here/kit-check.sh" "$ref" "$odc" "$def" "$kernels" > "$d/kit.out" 2>&1; rc=$?
    log "$id: kit $(tail -n 1 "$d/kit.out")"; [ $rc = 0 ] && tail -n 1 "$d/kit.out" | grep -qx 'KIT OK' || stop "$id: the S1 kit checks failed ($d/kit.out)"
  fi
  if [ -n "$source" ]; then
    # Each correction file with the sha256 it has in the clean tree of --source (trilha C, I1): the image must carry that
    # content. A file the correction deletes gets 64 zeros (absent from the tree; the image-diff only compares a file it carries).
    allow=$(node -e 'const fs=require("fs"),p=require("path"),c=require("crypto");const [j,t]=process.argv.slice(1);console.log(JSON.parse(fs.readFileSync(j)).files.map(f=>{const x=p.join(t,f);return f+"="+(fs.existsSync(x)?c.createHash("sha256").update(fs.readFileSync(x)).digest("hex"):"0".repeat(64));}).join(","))' "$(win "$out/source.json")" "$(win "$tree")")
    node "$(win "$here/image-diff.mjs")" --new "$ref" --old "$srcimg" --allow "$allow" --out "$(win "$d/image-diff.json")" > "$d/image-diff.out" 2>&1; rc=$?
    log "$id: against the production image: $(head -n 1 "$d/image-diff.out"); $(tail -n 1 "$d/image-diff.out")"
    [ $rc = 0 ] || { cat "$d/image-diff.out"; stop "$id: the image differs from the production image beyond the correction ($d/image-diff.json)"; }
    # The proof from outside the image (I4): production's layers first, then only the planned files.
    node "$(win "$here/overlay.mjs")" proof --new "$ref" --old "$srcimg" --plan "$(win "$d/overlay-plan.json")" --out "$(win "$d/overlay-proof.json")" > "$d/overlay-proof.out" 2>&1; rc=$?
    log "$id: overlay: $(head -n 1 "$d/overlay-proof.out"); $(tail -n 1 "$d/overlay-proof.out")"
    [ $rc = 0 ] || { cat "$d/overlay-proof.out"; stop "$id: the image is not the production image plus the correction's files ($d/overlay-proof.json)"; }
  fi
  imgid=$(docker image inspect -f '{{.Id}}' "$ref") size=$(docker image inspect -f '{{.Size}}' "$ref")
  digest=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1]))["containerimage.digest"]??"")}catch{console.log("")}' "$(win "$d/meta.json")")
  docker image inspect -f '{{json .Config.Labels}}' "$ref" > "$d/labels.json"
  [ $first = 1 ] || echo ',' >> "$out/built.json.part"; first=0
  node -e 'const [id,odc,tag,ref,imageId,def,k,metadataDigest,mode,secs,size,correction]=process.argv.slice(1);process.stdout.write(JSON.stringify({id,mode,odc,tag,ref,imageId,default:def,kernels:k.split(","),metadataDigest,buildSeconds:+secs,size:+size,...(correction?{layout:"single",correction:JSON.parse(require("fs").readFileSync(correction,"utf8"))}:{})}))' \
    "$id" "$odc" "$tag" "$ref" "$imgid" "$def" "$kernels" "$digest" "$mode" "$secs" "$size" "$([ -n "$source" ] && win "$out/source.json")" >> "$out/built.json.part"
  log "$id: OK $ref ${imgid:7:12} $(awk -v s="$size" 'BEGIN{printf "%.2f GB", s/1e9}')"
done
echo ']' >> "$out/built.json.part"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$(win "$out/built.json.part")" || stop "built.json is not JSON"
mv "$out/built.json.part" "$out/built.json"

# 5. what the owner runs
log "all $(echo $ids | wc -w) images built and smoked in $(( $(date +%s) - t00 )) s; nothing was pushed"
{
  echo; echo "Images (local, not pushed):"
  node -e 'for(const b of JSON.parse(require("fs").readFileSync(process.argv[1])))console.log(`  ${b.odc}\t${b.ref}\t${b.imageId.slice(7,19)}`)' "$(win "$out/built.json")"
  echo; if [ $ensaio = 1 ]; then echo "ENSAIO: these tags are never pushed."; else
  echo "The owner, in her own terminal, after: docker login docker.io -u andrepereiramachado"
  node -e 'for(const b of JSON.parse(require("fs").readFileSync(process.argv[1])))console.log(`  docker push ${b.ref}`)' "$(win "$out/built.json")"
  echo; echo "Then (no credential): node deploy/window-images/window-images.mjs images --built $(win "$out/built.json") --pairs deploy/coolify/versions.json --now <ISO switch time> --out <dir>"; fi
} | tee -a "$out/run.txt"
