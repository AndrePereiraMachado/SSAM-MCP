// r44 rodada 3: deploy/publish.sh must fail when the push fails, and print the pin only from the registry's own digest.
// The push used to run as `docker push … | tee`, whose status is tee's, and the digest fell back to RepoDigests, which the
// containerd image store fills with the local id before any push: a refused push (not logged in) still printed "pushed".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
const bash=['C:/Program Files/Git/bin/bash.exe','/usr/bin/bash','/bin/bash'].find(p=>fs.existsSync(p));
const script=new URL('../publish.sh',import.meta.url);
const pin='a'.repeat(64),other='b'.repeat(64);
// A fake docker: the local image exists (containerd: RepoDigests already carries the local id), the tag is not in the
// registry, and the push and the registry answer as the scenario says.
const fake=`#!/bin/sh
case "$1 $2" in
  "image inspect") case "$*" in *revision*) echo abc1234;; *RepoDigests*) echo "andrepereiramachado/ssam-server@sha256:${pin}";; esac; exit 0;;
  "manifest inspect") exit 1;;
  "tag "*) exit 0;;
  "buildx imagetools") [ "$FAKE_REGISTRY" = none ] && { echo "ERROR: not found" >&2; exit 1; }; echo "Name: x"; echo "MediaType: application/vnd.oci.image.index.v1+json"; echo "Digest: sha256:$FAKE_REGISTRY"; exit 0;;
esac
[ "$1" = push ] || { echo "fake docker: $*" >&2; exit 9; }
case "$FAKE_PUSH" in
  denied) echo "The push refers to repository [docker.io/andrepereiramachado/ssam-server]"; echo "push access denied, repository does not exist or may require authorization: server message: insufficient_scope: authorization failed" >&2; exit 1;;
  denied0) echo "denied: requested access to the resource is denied"; exit 0;;
  ok) echo "prod: digest: sha256:${pin} size: 1234"; exit 0;;
esac`;
function run(push,registry){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'publish-'));
  fs.writeFileSync(path.join(dir,'docker'),fake.replace(/\r\n/g,'\n'));fs.writeFileSync(path.join(dir,'curl'),'#!/bin/sh\necho 404\n');
  const r=spawnSync(bash,['-c',`chmod +x "$0/docker" "$0/curl"; PATH="$0:$PATH" DOCKER="$0/docker" sh "$1" --image docker.io/andrepereiramachado/ssam-server --source docker.io/andrepereiramachado/ssam-server --tag prod --private-repo-ready`,dir.replaceAll('\\','/'),fileURLToPathCompat(script)],{encoding:'utf8',env:{...process.env,FAKE_PUSH:push,FAKE_REGISTRY:registry}});
  fs.rmSync(dir,{recursive:true,force:true});return r;
}
function fileURLToPathCompat(u){return decodeURIComponent(u.pathname.replace(/^\/([A-Za-z]:)/,'$1'));}
test('r44: a refused push fails and never prints a pin', {skip:!bash}, () => {
  for(const [push,registry] of [['denied','none'],['denied0','none']]){
    const r=run(push,registry);
    assert.notEqual(r.status,0,push+': '+r.stdout+r.stderr);
    assert.doesNotMatch(r.stdout,/publish: pushed/,push);
    assert.doesNotMatch(r.stdout,/SSAM_IMAGE_TAG=/,push);
  }
});
test('r44: a push is published only when the registry holds the pushed digest', {skip:!bash}, () => {
  const bad=run('ok',other);
  assert.notEqual(bad.status,0,bad.stdout+bad.stderr);assert.doesNotMatch(bad.stdout,/publish: pushed/);
  const missing=run('ok','none');
  assert.notEqual(missing.status,0,missing.stdout+missing.stderr);
  const good=run('ok',pin);
  assert.equal(good.status,0,good.stdout+good.stderr);
  assert.match(good.stdout,new RegExp('publish: the registry holds sha256:'+pin));
});