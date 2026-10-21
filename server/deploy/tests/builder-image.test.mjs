// Run against a LOCAL image: SSAM_TEST_IMAGE=ssam-server:<tag> node --test deploy/tests/builder-image.test.mjs
// No pull, network, persistent container or host writes. Check as the image's non-root runtime user.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('production image contains a complete ODC builder accepted by the warm freshness check', () => {
  const image = process.env.SSAM_TEST_IMAGE;
  assert.ok(image, 'Set SSAM_TEST_IMAGE to the local production image to test');
  const code = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { paths, builderNeedsBuild } from '/app/platforms/odc/facade/lib.mjs';
    for (const file of [paths.builder, paths.builder.replace(/\\.dll$/, '.deps.json'), paths.builder.replace(/\\.dll$/, '.runtimeconfig.json')])
      assert.ok(fs.statSync(file).size > 0, 'Missing builder runtime file: ' + file);
    assert.equal(builderNeedsBuild(), false, 'The ODC warm would reject this image: builder missing or stale');
    console.log('ODC builder runtime files present; builderNeedsBuild=false');
  `;
  const result = spawnSync('docker', ['run', '--rm', '--pull=never', '--network=none', '--read-only',
    '--entrypoint=node', image, '--input-type=module', '-e', code], { encoding: 'utf8', timeout: 60000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});