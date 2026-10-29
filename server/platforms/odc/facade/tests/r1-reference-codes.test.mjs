// R1 item 3 (2026-10-28): ssam_reference answered a name the lookup does not have (ui-block of a sentence, a block of
// another library) as CLI_REFUSED, the code of a failure of the CLI. A refusal the kernel codes (KernelRefusalException:
// UI_BLOCK_NOT_FOUND, ASSEMBLY_NOT_FOUND, ...) keeps its code, the kernel's closest names and the next lookup of its kind;
// CLI_REFUSED stays for a CLI failure without a code. Fakes only: no Studio, no CLI.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerSsamReference } from '../ssam-reference.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';
import { tempKernel, linked } from './fixtures/o11env-kernel.mjs';

async function harness(t, handlers) {
  const kernel = tempKernel();
  const mcp = await linked(registerSsamReference, { root: kernel.root, lane: 'ss4', env: kernel.env, runAnvil: fakeAnvil(handlers), uuid: () => 'job-1' });
  t.after(async () => { await mcp.close(); kernel.cleanup(); });
  return (lane, kind, query) => mcp.call('ssam_reference', { lane, kind, query });
}

test('a block the catalog does not have is UI_BLOCK_NOT_FOUND with the closest names, and its continuation searches by text', async t => {
  const ask = await harness(t, { 'ui-block': args => ({ ok: false, command: 'ui-block', code: 'UI_BLOCK_NOT_FOUND', candidates: ['Popup', 'Upload'],
    error: `KernelRefusalException: block '${args[args.indexOf('--name') + 1]}' not in OutSystemsUI 2.28.1; try --find; closest: Popup, Upload\n   at ...` }) });
  const refused = await ask('o11', 'ui-block', 'html widgets popup upload select switch');
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'UI_BLOCK_NOT_FOUND');
  assert.doesNotMatch(refused.error, /\n/);
  assert.deepEqual(refused.candidates, ['Popup', 'Upload']);
  assert.deepEqual(refused.continuation.arguments, { lane: 'o11', kind: 'ui-block', query: { find: 'html widgets popup upload select switch' } });
  const library = await ask('o11', 'ui-block', { catalog: 'RichWidgets', name: 'ChartXAxis' });
  assert.equal(library.code, 'UI_BLOCK_NOT_FOUND');
  assert.deepEqual(library.continuation.arguments.query, { catalog: 'RichWidgets', find: 'ChartXAxis' });
});

test('an assembly the Studio folder does not have is ASSEMBLY_NOT_FOUND, and its continuation is the closest assembly', async t => {
  const ask = await harness(t, { types: () => ({ ok: false, command: 'types', code: 'ASSEMBLY_NOT_FOUND', candidates: ['ServiceStudio.Framework'],
    error: "KernelRefusalException: assembly 'ServiceStudio.Framwork' is not in the Studio's folder; closest: ServiceStudio.Framework" }) });
  const refused = await ask('o11', 'types', { assembly: 'ServiceStudio.Framwork', filter: 'MobileWidgets', max: 20 });
  assert.equal(refused.code, 'ASSEMBLY_NOT_FOUND');
  assert.deepEqual(refused.continuation.arguments, { lane: 'o11', kind: 'types', query: { assembly: 'ServiceStudio.Framework', filter: 'MobileWidgets', max: 20 } });
});

test('a CLI failure without a code is still CLI_REFUSED, with the next lookup of its kind', async t => {
  const ask = await harness(t, { 'where-can': () => ({ ok: false, command: 'where-can', error: "IOException: The process cannot access the file because it is being used by another process." }) });
  const refused = await ask('o11', 'where-can', 'IImage');
  assert.equal(refused.code, 'CLI_REFUSED');
  assert.equal(refused.candidates, undefined);
  assert.equal(refused.continuation.tool, 'ssam_doctor');
});

test('an unknown API operation without nearby names is still UNKNOWN_OP, with the supported verbs as continuation', async t => {
  const ask = await harness(t, { api: args => args.includes('verbs')
    ? { ok: true, data: { verbs: { create: {}, set: {} } } }
    : { ok: false, error: "ArgumentException: unknown op 'zzzzzzzz'; allowed: logic, spec; verbs (their line): create, set" } });
  const refused = await ask('o11', 'api', { op: 'zzzzzzzz' });
  assert.equal(refused.code, 'UNKNOWN_OP');
  assert.deepEqual(refused.candidates, []);
  assert.deepEqual(refused.continuation.arguments, { lane: 'o11', kind: 'api', query: { op: 'verbs' } });
});
