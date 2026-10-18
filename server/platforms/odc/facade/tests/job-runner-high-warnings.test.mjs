// CX17 review 1 (M2): the answer of a job keeps the first 10 high warnings in the kernel's order (data access and the owner's
// rules before the visual ones of the html op) and says how many there were when it cuts. A fake CLI, temporary folders.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { odcRoot } from '../workspace.mjs';
import { runJob } from '../job-runner.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';

const fixtures = path.join(odcRoot, 'facade', 'tests', 'fixtures');
const accepted = () => { const e = JSON.parse(fs.readFileSync(path.join(fixtures, 'jobs-apply-envelope.json'), 'utf8')); e.data.accepted = true; return e; };

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-high-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'tests', 'jobs'), { recursive: true });
  const job = path.join(root, 'tests', 'jobs', 'high.json');
  fs.writeFileSync(job, JSON.stringify({ base: 'tests/fixtures/blank-service.oml', ops: [{ op: 'create', parent: '@espace', type: 'Structure', name: 'S' }] }));
  const auth = path.join(root, 'auth'); fs.mkdirSync(auth);
  const env = { USERPROFILE: root, HOME: root, APPDATA: root, LOCALAPPDATA: root, ANVIL_AUTHORITY_DIR: auth, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1' };
  let clock = 1000;
  return { job, deps: extra => ({ root, env, o11Lane: 'ss4', now: () => (clock += 10), ...extra }) };
}

test('a cut of the high warnings keeps the kernel order and says the total', async t => {
  const s = sandbox(t);
  const warning = (code, op) => ({ code, severity: 'high', op, owner: 'Root' + op, message: code + ' of op ' + op });
  // The kernel's order (Verbs.Receipt.HighWarningsByPriority): the data warning first, the visual ones, the classes without rule.
  const kernel = [warning('QUERY_IN_LOOP', 8), ...['HTML_THEME_TOKEN_SCOPED', 'HTML_SELECTOR_MISSES_RUNTIME', 'HTML_TEXT_JOINED', 'HTML_LIST_NOT_LAYOUT_CONTAINER'].map(c => warning(c, 6)),
    ...[0, 1, 2, 3, 4, 5].map(i => warning('HTML_CLASS_NO_RULE', i))];
  const envelope = accepted(); envelope.data.highWarnings = kernel;
  const runAnvil = fakeAnvil({ apply: () => ({ envelope }) });
  const r = await runJob({ lane: 'o11', job: s.job }, s.deps({ runAnvil }));
  assert.equal(r.highWarnings.length, 10);
  assert.equal(r.highWarnings[0].id, 'QUERY_IN_LOOP');
  assert.equal(r.highWarningsTotal, 11);
  // Ten or fewer: no total.
  const few = accepted(); few.data.highWarnings = kernel.slice(0, 5);
  const r2 = await runJob({ lane: 'o11', job: s.job }, s.deps({ runAnvil: fakeAnvil({ apply: () => ({ envelope: few }) }) }));
  assert.equal(r2.highWarnings.length, 5);
  assert.equal(r2.highWarningsTotal, undefined);
});
