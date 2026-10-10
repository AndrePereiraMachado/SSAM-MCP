import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Golden: the REAL private worker over the ORIGINAL published Headless_UI runtime assets cached by an earlier proof
// (read only through SSAM_DEBUG_EVIDENCE_ROOT), with a synthetic in-process origin (no network, no vault, no window).
const evidence = process.env.SSAM_DEBUG_EVIDENCE_ROOT;
const harness = fileURLToPath(new URL('./fixtures/debug-o11-native-worker-harness.mjs', import.meta.url));

test('original runtime: typed stub scenarios, server exception, defaults, data action and traced client action', { skip: !evidence, timeout: 180000 }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-o11-golden-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = spawnSync(process.execPath, ['--experimental-webstorage', harness, evidence, root], { encoding: 'utf8', timeout: 170000, windowsHide: true });
  assert.equal(run.status, 0, 'harness exited ' + run.status);
  const { out, posts } = JSON.parse(run.stdout.trim().split('\n').at(-1));
  const [stub, data, slug] = out;

  // Server action through its original screen stub, typed inputs (Unicode), typed output, one POST per scenario.
  assert.equal(stub.entryKind, 'server-stub'); assert.equal(stub.viewName, 'MainFlow.Home'); assert.equal(stub.authenticated, true);
  assert.deepEqual(stub.results[0].outputs, { Url: 'https://example.invalid/back#Tool Ü' });
  assert.deepEqual(stub.results[0].requests, { submitted: 1, answered: 1 });
  assert.deepEqual(stub.results[1].exception, { type: 'ServerException', specificType: 'Users.SyntheticFailure', origin: 'server', message: 'synthetic server failure for [private]' });
  assert.equal(stub.results[1].uncertain, false);
  assert.deepEqual(stub.results[2].outputs, { Url: '#' }); // omitted inputs keep the type default
  assert.deepEqual(stub.submissions.map(s => s.seq), [1, 2, 3]);
  assert.equal(stub.receipt.memoryCleared, true); assert.equal(stub.receipt.requestUncertain, false);

  // Data action of a block, hosted by its screen's view name; outputs read from the original data record.
  assert.deepEqual(data.results[0].outputs, { UserName: 'Display Name of [private]' });
  // Module-level client action with client trace: node visits and variables from the original debugger hooks.
  assert.equal(slug.entryKind, 'client-action'); assert.deepEqual(slug.results[0].outputs, { Slug: 'Olá Mundo' });
  assert.equal(slug.results[0].visitCount, 4);
  assert.deepEqual(slug.results[0].visits.at(-1).values, { vars: { Text: 'Olá Mundo' }, makeSlugJSResult: { Slug: 'Olá Mundo' }, outVars: { Slug: 'Olá Mundo' } });
  assert.equal(slug.results[1].visits[0].values, undefined); // trace=nodes: visits only
  assert.deepEqual(slug.submissions, []);

  // The login went through the app's own Login screen stub; every later POST carried the authenticated CSRF token.
  const logins = posts.filter(p => p.path.endsWith('/ActionDoLogin'));
  assert.equal(logins.length, 3); assert.ok(logins.every(p => p.viewName === 'Common.Login'));
  assert.ok(posts.filter(p => !p.path.endsWith('/ActionDoLogin')).every(p => p.csrf === 'SyntheticCsrf123='));
  assert.equal(out.some(o => o.leaks), false); // credentials never in receipts or results
});
