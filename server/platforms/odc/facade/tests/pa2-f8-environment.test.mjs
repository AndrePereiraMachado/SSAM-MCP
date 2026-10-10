// Lane F8 of the atritos 2 package (docs/PACOTE-ATRITOS-2.md, A16 and I7). A16: create-app {blank:true} answered ok in
// 62 s but the UI and the back office were born empty (no theme, no layouts, no LayoutBlank); three DELIVERY_FAILED of
// LayoutBlank followed and the modules were deleted and recreated (session of 06/10, 12:57). blank now refuses UI
// modules with BLANK_UI_MODULE before the CLI, and the receipt lists the template, LayoutBlank and Content per module.
// I7: downloadModule, the published OML of one module for F4's reads, in <lane.local>/environment/download/<time>.
// The CLI is always a fake; nothing live.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { registerO11Environment, downloadModule, validateEnvironmentInput, BLANK_UI_KINDS } from '../o11-environment.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';
import { envelopes, tempKernel, linked, outOf } from './fixtures/o11env-kernel.mjs';

const WORDS = 'Sim, pode criar o app Cardapio';
const NOW = () => new Date('2026-10-06T12:57:39.000Z');

async function harness(t, { handlers = envelopes, cli = true } = {}) {
  const kernel = tempKernel({ cli });
  const run = fakeAnvil(handlers);
  const selected = { calls: 0 };
  const deps = { root: kernel.root, lane: 'ss4', env: kernel.env, runAnvil: run, now: NOW, uuid: () => '00000000-0000-4000-8000-000000000001',
    assertSelected: async () => { selected.calls++; } };
  const mcp = await linked(registerO11Environment, deps);
  t.after(async () => { await mcp.close(); kernel.cleanup(); });
  return { ...mcp, run, selected, kernel };
}

test('A16: blank:true with a Reactive, Traditional or Mobile module is BLANK_UI_MODULE before the CLI; the fake runner is never called', async t => {
  const h = await harness(t);
  // The real request of 06/10: Cardapio_UI and Cardapio_BackOffice as Reactive, blank:true.
  const cases = [
    { action: 'create-app', name: 'Cardapio', modules: [{ name: 'Cardapio_UI', kind: 'Reactive' }, { name: 'Cardapio_BackOffice', kind: 'Reactive' }, { name: 'Cardapio_CS', kind: 'Service' }], blank: true, authorize: WORDS },
    { action: 'add-modules', app: 'Cardapio', modules: [{ name: 'Cardapio_Web', kind: 'Traditional' }], blank: true, authorize: WORDS },
    { action: 'add-modules', app: 'Cardapio', modules: [{ name: 'Cardapio_App', kind: 'Mobile' }], blank: true, authorize: WORDS },
  ];
  for (const input of cases) {
    const value = await h.call('o11_environment', input);
    assert.deepEqual([value.ok, value.code, value.isError, value.fix], [false, 'BLANK_UI_MODULE', true, 'omit blank'], input.action);
    assert.deepEqual(value.modules, input.modules.filter(m => BLANK_UI_KINDS.includes(m.kind)).map(m => m.name));
    // The continuation is the same call without blank.
    const { blank, ...same } = input;
    assert.deepEqual(value.continuation, { tool: 'o11_environment', arguments: same, why: 'omit blank: UI modules come from the application template' });
    assert.match(value.error, /Service and Library/);
  }
  assert.equal(h.run.calls.length, 0, 'nothing reached the CLI');
  assert.equal(h.selected.calls, 0, 'not even the Studio check');
  // Without words the same refusal comes first (nothing is asked of the user for a call that cannot run).
  assert.equal(validateEnvironmentInput({ ...cases[0], authorize: undefined }).code, 'BLANK_UI_MODULE');
});

test('A16: blank stays valid for Service and Library modules, and a UI module without blank runs from the template', async t => {
  const h = await harness(t);
  const lib = await h.call('o11_environment', { action: 'add-modules', app: 'Demo', modules: [{ name: 'Demo_Lib', kind: 'Library' }], blank: true, authorize: WORDS });
  assert.equal(lib.ok, true);
  assert.ok(h.run.calls[0].args.includes('--blank'));
  const service = await h.call('o11_environment', { action: 'create-app', name: 'Demo App', modules: [{ name: 'Demo_CS', kind: 'Service' }], blank: true, authorize: WORDS });
  assert.equal(service.ok, true);
  const ui = await h.call('o11_environment', { action: 'create-app', name: 'Demo App', modules: [{ name: 'Demo_UI', kind: 'Reactive' }], authorize: WORDS });
  assert.equal(ui.ok, true);
  assert.ok(!h.run.calls[2].args.includes('--blank'));
});

test('A16: the kernel refusal (AppFactory.RefuseBlankUi) comes back as BLANK_UI_MODULE, not CLI_REFUSED', async t => {
  const h = await harness(t, { handlers: { ...envelopes, 'create-app': () => ({ ok: false, command: 'create-app', code: 'BLANK_UI_MODULE',
    error: 'KernelRefusalException: blank creates only Service and Library modules; omit blank for X_UI (UI modules come from the application template); nothing was created' }) } });
  const value = await h.call('o11_environment', { action: 'create-app', name: 'X', modules: [{ name: 'X_CS', kind: 'Service' }], blank: true, authorize: WORDS });
  assert.deepEqual([value.code, value.fix, value.outcome], ['BLANK_UI_MODULE', 'omit blank', 'refused']);
  assert.equal(value.continuation.arguments.blank, undefined);
});

test('A16: the receipt lists, per module, the template it came from and whether LayoutBlank and Content exist', async t => {
  const publish = { Started: true, Completed: true, HasErrors: false, VersionId: 1, Messages: [] };
  const h = await harness(t, { handlers: { ...envelopes,
    'create-app': () => ({ ok: true, command: 'create-app', data: { ApplicationName: 'Cardapio', ApplicationKey: 'app-c', ApplicationOk: true, Succeeded: true,
      Modules: [{ Name: 'Cardapio_UI', Kind: 'CrossDevice', Key: 'm1', IsValid: true, Publish: publish, Succeeded: true, Template: 'tpl-reactive', LayoutBlank: true, Content: true },
        { Name: 'Cardapio_CS', Kind: 'Service', Key: 'm2', IsValid: true, Publish: publish, Succeeded: true, Template: 'blank', LayoutBlank: false, Content: false }] } }),
    'add-modules': () => ({ ok: true, command: 'add-modules', data: { application: { Name: 'Cardapio' }, succeeded: false,
      modules: [{ Name: 'Cardapio_BO', Kind: 'CrossDevice', Key: null, IsValid: false, Error: 'Batch preparation failed', Succeeded: false, Template: 'tpl-reactive', LayoutBlank: false, Content: false }] } }) } });
  const created = await h.call('o11_environment', { action: 'create-app', name: 'Cardapio', modules: [{ name: 'Cardapio_UI', kind: 'Reactive' }, { name: 'Cardapio_CS', kind: 'Service' }], authorize: WORDS });
  assert.deepEqual(created.templates, [
    { module: 'Cardapio_UI', template: 'tpl-reactive', layoutBlank: true, content: true },
    { module: 'Cardapio_CS', template: 'blank', layoutBlank: false, content: false }]);
  // A failed creation keeps the receipt too: a UI module without LayoutBlank is visible at once.
  const failed = await h.call('o11_environment', { action: 'add-modules', app: 'Cardapio', modules: [{ name: 'Cardapio_BO', kind: 'Reactive' }], authorize: WORDS });
  assert.equal(failed.code, 'ADD_MODULES_FAILED');
  assert.deepEqual(failed.templates, [{ module: 'Cardapio_BO', template: 'tpl-reactive', layoutBlank: false, content: false }]);
});

test('I7: downloadModule answers {ok, file, module, key, versionId, folder} in <lane.local>/environment/download/<time>, with the download argv', async t => {
  const kernel = tempKernel(); t.after(kernel.cleanup);
  const run = fakeAnvil({ download: args => ({ ok: true, command: 'download', data: { Name: 'Users', Key: 'WWAQZTkE5UuwES8B+6Svpg', Kind: 'eSpace', VersionId: 812,
    FilePath: path.join(outOf(args), 'Users.oml'), Status: 'ok' } }) });
  let selected = 0;
  const value = await downloadModule({ module: 'Users' }, { root: kernel.root, lane: 'ss4', env: kernel.env, runAnvil: run, assertSelected: async () => { selected++; }, now: NOW });
  const folder = path.join(kernel.root, '.local', 'environment', 'download', '20261006T125739000Z');
  assert.deepEqual(value, { ok: true, file: path.join(folder, 'Users.oml'), module: 'Users', key: 'WWAQZTkE5UuwES8B+6Svpg', versionId: 812, cached: false, folder });
  const cache = path.join(kernel.root, '.local', 'environment', 'published');
  assert.deepEqual(run.calls[0].args, ['download', '--module', 'Users', '--out', folder, '--cache', cache, '--read-only']);
  assert.equal(run.calls[0].options.cwd, kernel.root);
  assert.ok(fs.statSync(folder).isDirectory());
  assert.equal(selected, 1);
  // A second download in the same second gets its own folder (never mixes two OMLs).
  const again = await downloadModule({ module: 'Users', version: 811, host: 'personal-0000test.outsystemscloud.com' }, { root: kernel.root, lane: 'ss4', env: kernel.env, runAnvil: run, assertSelected: async () => {}, now: NOW });
  assert.equal(again.folder, folder + '-2');
  assert.deepEqual(run.calls[1].args, ['download', '--module', 'Users', '--out', folder + '-2', '--version', '811', '--cache', cache, '--host', 'personal-0000test.outsystemscloud.com', '--read-only']);
});

test('I7: downloadModule refuses with the codes of today and never runs the CLI for them', async t => {
  const kernel = tempKernel(); t.after(kernel.cleanup);
  const run = fakeAnvil({ download: () => ({ ok: true, command: 'download', data: { Name: 'Ghost', Status: 'failed: module not found' } }) });
  const base = { root: kernel.root, lane: 'ss4', env: kernel.env, runAnvil: run, now: NOW };
  const notSelected = await downloadModule({ module: 'Users' }, { ...base, assertSelected: async () => { throw new Error('no Studio'); } });
  assert.deepEqual([notSelected.ok, notSelected.code, notSelected.continuation.tool], [false, 'STUDIO_NOT_SELECTED', 'ssam_doctor']);
  assert.equal(run.calls.length, 0);
  const noCli = tempKernel({ cli: false }); t.after(noCli.cleanup);
  assert.equal((await downloadModule({ module: 'Users' }, { ...base, root: noCli.root, env: noCli.env, assertSelected: async () => {} })).code, 'CLI_NOT_BUILT');
  assert.equal((await downloadModule({}, { ...base, assertSelected: async () => {} })).code, 'MISSING_FIELD');
  assert.equal((await downloadModule({ module: '--confirm' }, { ...base, assertSelected: async () => {} })).code, 'BAD_VALUE');
  assert.equal(run.calls.length, 0);
  const failed = await downloadModule({ module: 'Ghost' }, { ...base, assertSelected: async () => {} });
  assert.deepEqual([failed.ok, failed.code, failed.continuation.arguments.action], [false, 'DOWNLOAD_FAILED', 'inventory']);
});
