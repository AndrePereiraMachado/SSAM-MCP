// Frictions of 2026-10-06, lane a, A3 (Astra item 3, 2026-10-05): o11_environment refresh-refs {publish:true} answered
// published:true and o11_studio publish-log kept showing the previous publication. Cause: refresh-refs publishes through
// the environment session (ReferenceRefresher.RefreshModule -> Publisher.Publish, Start1CP), while publish-log reads the
// Service Studio's 1-Click Publish tabs. Now the refresh-refs answer carries the published version, the time and the
// operationId of its journal line, and publish-log says which publications it observes and where the others are.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { registerO11Environment, REFRESH_COMMIT } from '../o11-environment.mjs';
import { publishLogView, PUBLISH_LOG_SCOPE } from '../o11-studio.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';
import { envelopes, tempKernel, linked } from './fixtures/o11env-kernel.mjs';

const WORDS = 'Sim, pode atualizar as referências do Demo_CS e publicar';
const NOW = '2026-10-02T12:00:00.000Z';
const OPERATION = '00000000-0000-4000-8000-0000000000a3';

async function harness(t, handlers = envelopes) {
  const kernel = tempKernel();
  const run = fakeAnvil(handlers);
  const mcp = await linked(registerO11Environment, { root: kernel.root, lane: 'ss4', env: kernel.env, runAnvil: run, now: () => new Date(NOW),
    uuid: () => OPERATION, assertSelected: async () => {} });
  t.after(async () => { await mcp.close(); kernel.cleanup(); });
  return { ...mcp, journal: path.join(kernel.root, '.local', 'journal', 'o11_environment.jsonl') };
}

test('A3: refresh-refs {publish:true} answers the published version, time and operationId, and where that publication is recorded', async t => {
  const h = await harness(t);
  const value = await h.call('o11_environment', { action: 'refresh-refs', module: 'Demo_CS', publish: true, authorize: WORDS, host: 'personal-test.outsystemscloud.com' });
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.equal(value.published, true);
  const p = value.publication;
  assert.equal(p.version, 70, 'the server VersionId of the new module version');
  assert.equal(p.at, NOW);
  assert.equal(p.operationId, OPERATION);
  assert.equal(p.channel, 'environment-session');
  assert.equal(p.comment, REFRESH_COMMIT);
  assert.match(p.note, /publish-log does not show it/);
  assert.deepEqual(p.versions.arguments, { action: 'versions', moduleKey: 'mod-1', host: 'personal-test.outsystemscloud.com' });
  assert.equal(p.versions.tool, 'o11_service_center_read');
  // The journal line of the same operationId keeps the version: the answer and the journal correlate.
  const lines = fs.readFileSync(h.journal, 'utf8').trim().split('\n').map(JSON.parse);
  const result = lines.find(l => l.phase === 'result');
  assert.equal(result.operationId, OPERATION); assert.equal(result.publishedVersion, 70); assert.equal(result.publishedAt, NOW);
  assert.ok(!JSON.stringify(lines).includes(WORDS), 'only the sha256 of the words');
});

test('A3: refresh-refs without publish carries the validation after the refresh and no publication', async t => {
  const h = await harness(t, { ...envelopes, 'refresh-refs': args => {
    const base = envelopes['refresh-refs'](args);
    return { ...base, data: { ...base.data, ValidationAfter: { Total: 2, ByType: { Error: 1, Warning: 1 }, Sample: ['Error: Incompatible or missing dependencies\nstack', 'Warning: x'] } } };
  } });
  const value = await h.call('o11_environment', { action: 'refresh-refs', module: 'Demo_CS', authorize: WORDS });
  assert.equal(value.ok, true);
  assert.equal(value.publication, undefined); assert.equal(value.published, undefined);
  assert.deepEqual(value.validation, { total: 2, byType: { Error: 1, Warning: 1 }, sample: ['Error: Incompatible or missing dependencies', 'Warning: x'] });
});

test('A3: publish-log says what it observes and where the publications made elsewhere are', () => {
  const found = publishLogView({ found: true, module: 'Demo_CS', moduleKey: 'mod-1', environment: 'personal-test.outsystemscloud.com', status: 'succeeded',
    triggeredBy: 'studio', messages: [], steps: [] });
  assert.equal(found.observes, PUBLISH_LOG_SCOPE);
  assert.match(found.observes, /1-Click Publish tabs of this Service Studio/);
  assert.deepEqual(found.elsewhere.arguments, { action: 'versions', moduleKey: 'mod-1', host: 'personal-test.outsystemscloud.com' });
  assert.equal(found.elsewhere.tool, 'o11_service_center_read');
  assert.match(found.elsewhere.why, /refresh-refs/);
  const none = publishLogView({ found: false, module: 'Demo_CS', moduleKey: 'mod-1', environment: 'h.outsystemscloud.com', reason: 'no tab' });
  assert.equal(none.found, false); assert.equal(none.observes, PUBLISH_LOG_SCOPE);
  assert.deepEqual(none.elsewhere.arguments, { action: 'versions', moduleKey: 'mod-1', host: 'h.outsystemscloud.com' });
});
