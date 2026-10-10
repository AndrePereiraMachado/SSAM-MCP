// Package 3 integration (docs/PACOTE-ATRITOS-3.md section 8): what only exists once the lanes, the 17th release and the
// Codex branch are merged. close-module is one command: moduleKey of lane mb and the two refusal codes of the 16th
// release, each registered with its continuation; tools.json routes it once. Fake bridge on a loopback port only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { o11Studio, COMMANDS } from '../o11-studio.mjs';
import { o11Bridge } from '../o11-bridge.mjs';
import { CONTINUATIONS, O11_TAB_CODES } from '../continuations.mjs';
import { studioBridge } from './fixtures/o11-studio-bridge.mjs';
import { fitWithSteps } from '../discovery.mjs';

const ok = data => ({ success: true, data, error: null });
const fail = error => ({ success: false, data: null, error });

const here = path.dirname(fileURLToPath(import.meta.url));

async function runner(t, replies) {
  const fake = await studioBridge({ replies });
  t.after(() => fake.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa3-integracao-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sub = name => { const p = path.join(dir, name); fs.mkdirSync(p, { recursive: true }); return p; };
  const env = { ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', ANVIL_LANE: 'ss4', USERPROFILE: sub('home'), HOME: path.join(dir, 'home'),
    APPDATA: sub('appdata'), LOCALAPPDATA: sub('localappdata'), ANVIL_AUTHORITY_DIR: sub('authority') };
  const run = o11Studio({ bridge: o11Bridge({ port: fake.port, authorization: 'K' }), assertSelected: async () => {}, lane: 'ss4', root: sub('root'), env,
    inventory: async () => null, writeHolder: () => null });
  return { run, sent: () => fake.seen.filter(r => r.method === 'close_module').map(r => r.params) };
}

test('close-module is one command: moduleKey reaches the bridge and both refusal codes answer with their continuation', async t => {
  let mode = 'ok';
  const s = await runner(t, { close_module: p => mode === 'dirty'
    ? fail('InvalidOperationException: close_module: tab has unsaved changes, is opening, or has a pending operation; save or resolve it in Studio first')
    : mode === 'twins' ? fail('InvalidOperationException: close_module: multiple matching tabs; choose in Studio')
      : ok({ name: p.name, closed: true }) });
  assert.equal(COMMANDS.filter(c => c === 'close-module').length, 1);
  assert.deepEqual(await s.run({ command: 'close-module', args: { module: 'Orders', moduleKey: 'k2' } }), { ok: true, module: 'Orders', closed: true });
  assert.deepEqual(s.sent()[0], { name: 'Orders', module_key: 'k2' });
  mode = 'dirty';
  const dirty = await s.run({ command: 'close-module', args: { name: 'Orders' } });
  assert.equal(dirty.code, 'MODULE_TAB_NOT_CLOSABLE'); assert.equal(dirty.executed, false); assert.equal(dirty.outcome, 'not-sent');
  assert.equal(dirty.continuation.tool, CONTINUATIONS.MODULE_TAB_NOT_CLOSABLE.tool);
  mode = 'twins';
  const twins = await s.run({ command: 'close-module', args: { name: 'Orders' } });
  assert.equal(twins.code, 'MODULE_TAB_AMBIGUOUS'); assert.equal(twins.executed, false);
  assert.equal(twins.continuation.tool, CONTINUATIONS.MODULE_TAB_AMBIGUOUS.tool);
  for (const code of O11_TAB_CODES) assert.ok(CONTINUATIONS[code], code);
});

test('tools.json routes close-module once, with moduleKey', () => {
  const text = fs.readFileSync(path.join(here, '..', 'catalog', 'tools.json'), 'utf8');
  assert.equal(text.split('"close-module": {').length - 1, 1);
  JSON.parse(text);
  const route = text.slice(text.indexOf('"close-module": {'), text.indexOf('"dismiss-dialog": {', text.indexOf('"close-module": {')));
  assert.match(route, /"moduleKey": "<module key \(optional\)>"/);
  assert.match(route, /MODULE_TAB_NOT_CLOSABLE/);
});

test('C07: the grammar of the steps the intent names keeps a floor when the model part fills the budget', () => {
  const budget = 12000;
  // A model part that always fills the room it is given (the matches of an executed index), leaving ~100 bytes.
  const fitModel = room => { const a = { ok: true, lane: 'odc', matches: [{ id: 'logic.flow', via: 'match', detail: 'x'.repeat(room - 200) }], size: { bytes: 0, budgetBytes: room, status: 'reduced', truncated: [] } }; a.size.bytes = Buffer.byteLength(JSON.stringify(a)); return a; };
  const steps = { kinds: ['get', 'if'], grammar: { get: 'get {entity, where, as}', if: 'if {condition, then, else}' }, example: { job: 'logic-aggregate-if', ops: [{ op: 'logic', data: { pad: 'y'.repeat(4000) } }] } };
  const a = fitWithSteps(fitModel, { provenExample: null, steps, values: null }, budget);
  assert.deepEqual(a.steps?.kinds, ['get', 'if'], JSON.stringify(a.size));
  assert.equal(a.steps.example?.job, 'logic-aggregate-if', 'the proven job by reference');
  assert.ok(a.size.bytes <= budget && a.size.budgetBytes === budget, JSON.stringify(a.size));
  assert.ok(a.size.reserved?.steps > 0);
  // Without steps nothing is reserved and the model part keeps the whole budget.
  const plain = fitWithSteps(fitModel, { provenExample: null, steps: null, values: null }, budget);
  assert.equal(plain.size.reserved, undefined);
  // Battery (2026-10-08): when the whole steps form fits a quarter of the budget, the floor keeps the action to copy,
  // not only the job id (with proven-current stamps the o11 answer of pacote-laneE-discover lost its ops).
  const small = { ...steps, example: { job: 'logic-aggregate-if', ops: [{ op: 'logic', data: { pad: 'y'.repeat(2000) } }] } };
  const big = fitWithSteps(fitModel, { provenExample: null, steps: small, values: null }, 40960);
  assert.equal(big.steps?.example?.ops?.length, 1, JSON.stringify(big.size));
  assert.ok(big.size.bytes <= 40960 && big.size.reserved?.steps > 2000, JSON.stringify(big.size));
});