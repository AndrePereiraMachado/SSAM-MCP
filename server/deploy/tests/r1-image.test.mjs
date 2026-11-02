import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('R1 image carries the reference maps and all three current-window compatibility manifests', () => {
  const image = process.env.SSAM_TEST_IMAGE;
  assert.ok(image, 'Set SSAM_TEST_IMAGE to the local R1 image');
  const code = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    for (const name of ['blank-service','mobile-ui','reactive-ui','traditional-ui']) {
      const file = '/app/kernel/docs/mapa/criar-' + name + '.json';
      assert.ok(fs.statSync(file).size > 0, file);
      assert.ok(JSON.parse(fs.readFileSync(file,'utf8')), file);
    }
    const kernels = JSON.parse(fs.readFileSync('/app/deploy/coolify/r1-kernels.json','utf8'));
    // R4 (U1): v106 on the net10 pair, v101 kept so a Studio that loaded it keeps service, v107 (the net8 pack) accepted.
    assert.deepEqual(kernels.v1,{o11:'11.55.94',odc:'1.7.30',odcBridge:'v106',odcBridgeAccepted:['v98','v101','v102','v107']});
    for (const name of ['v2','v3']) {
      assert.equal(kernels[name].odcBridge,'v97');
      assert.ok(kernels[name].odcBridgeAccepted.includes('v98'));
      assert.ok(kernels[name].odcBridgeAccepted.includes('v102'));
      assert.ok(kernels[name].odcBridgeAccepted.includes('v107'));
    }
    assert.equal(kernels.v2.odc,'1.7.29');
    assert.equal(kernels.v3.odc,'1.7.28');
  `;
  const result = spawnSync(process.env.DOCKER_EXE ?? 'docker', ['--context','desktop-linux','run','--rm','--pull=never','--network=none','--read-only',
    '--entrypoint=node',image,'--input-type=module','-e',code], {encoding:'utf8',timeout:60000,windowsHide:true});
  assert.ifError(result.error);
  assert.equal(result.status,0,result.stderr || result.stdout);
});

// F1c A5: the hosted run lease is tried with flock(1), the advisory lock .NET holds on run.lock; without it the lease is never
// reported free (platforms/odc/facade/delivery-lineage.mjs). Every runtime image carries it (util-linux), and it really locks.
test('R4 image carries flock(1) and it reports a held lock as held', () => {
  const image = process.env.SSAM_TEST_IMAGE;
  assert.ok(image, 'Set SSAM_TEST_IMAGE to the local R1 image');
  const script = 'command -v flock && f=/tmp/ssam-flock-probe && : > $f && flock $f sleep 3 & sleep 1; '
    + 'if flock -n /tmp/ssam-flock-probe true; then echo FREE; else echo HELD; fi; wait; flock -n /tmp/ssam-flock-probe true && echo FREE-AFTER';
  const result = spawnSync(process.env.DOCKER_EXE ?? 'docker', ['--context','desktop-linux','run','--rm','--pull=never','--network=none','--read-only',
    '--tmpfs','/tmp','--entrypoint=sh',image,'-c',script], {encoding:'utf8',timeout:60000,windowsHide:true});
  assert.ifError(result.error);
  assert.equal(result.status,0,result.stderr || result.stdout);
  assert.match(result.stdout,/\/flock\n/);
  assert.match(result.stdout,/\nHELD\n/);
  assert.match(result.stdout,/FREE-AFTER/);
});
