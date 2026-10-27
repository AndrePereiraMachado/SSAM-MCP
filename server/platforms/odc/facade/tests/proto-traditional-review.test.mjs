// The facade findings of the independent review of integ/proto-traditional at 3ab12209 (the port of the proto line's
// Traditional html into the product candidate), one test per finding. Each one failed on 3ab12209 and passes with the
// correction round; the module names below exist on both sides, so a test fails for its own finding, never for an import.
//   H1 a known merge-order loss keeps its repair job; only the kernel code decides MERGE_CONTENT_MISMATCH.
//   H2 session=vault without a private profile store reads no vault and opens no prompt.
//   M1 ssam_app_url: an app open in neither Studio answers from the ODC session; the O11 probe only reads.
//   M2 a flow action that fits the budget is one page, as before the port.
//   M3 an O11 request of unknown kind gets the answers it had before the port (no Traditional capability or example).
//   M4 a Traditional request keeps its proven example and a compact Traditional section in an 8 KB packet.
//   M5 evidence redaction keeps every secret key of before (opaque values), counters of tokens stay readable.
//   L1 the Reactive OutSystems UI library gains no public actions; L2 a logic packet has no UI catalog hint;
//   L3 no rerun of the model part for the tools; L4 a delivered answer carries verdicts and counts, not whole proofs;
//   L7 no prototype receipt writer; L8 neutral hosts; the store generation names both extractors, as the kernel does.
// (L5, the packet budget: context-budget-packet*.test.mjs; L6, preview conflicts and errors: merge-order-deferred.test.mjs.)
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deliverOutcome } from '../o11-cycle.mjs';
import { main as serviceCenter } from '../service-center/index.mjs';
import { resolveApplicationUrls } from '../app-urls.mjs';
import * as o11Studio from '../o11-studio.mjs';
import * as moduleMapModule from '../module-map.mjs';
import { moduleMap } from '../module-map.mjs';
import { redact } from '../ssam-evidence.mjs';
import { attachTools } from '../tool-routing.mjs';
import { discoverAll } from '../tool-routing.mjs';
import { snapshotSources } from './fixtures/discovery-results.mjs';
import { writeCapture } from './fixtures/module-index.mjs';
import { FLOW_EXTRACTOR } from '../module-flow.mjs';
import { DIGEST_EXTRACTOR } from '../module-digest.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const facade = path.join(here, '..');
const kernel = path.join(facade, '..', '..', '..', 'kernel');
const read = file => fs.readFileSync(file, 'utf8');
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
// The folder of this release in the module index store: store-generation.mjs (absent before the round: the old 'v1').
const storeGeneration = async () => (await import('../store-generation.mjs').then(m => m.STORE_GENERATION, () => 'v1'));
let sources = null;
const o11 = () => (sources ??= snapshotSources('o11'));

// ---- H1
test('H1: a known merge-order loss keeps the kernel repair job as its continuation', () => {
  // The kernel answer for a merge-order KNOWN loss (Delivery.cs): the content proof refused only for the lost default the
  // repair job sets again; the kernel does not say MERGE_CONTENT_MISMATCH.
  const state = { delivered: false, writeState: 'applied', validation: { newErrors: 0 }, stage: 'checks', taskId: '20261023-000000-aaaaaaaa',
    error: 'Merge kept for review: the native merge did not keep 1 default value(s): Pet.SpeciesId = Entities.Species.Dog; nothing else differs.',
    failures: [{ stage: 'checks', error: 'Merge kept for review: the native merge did not keep 1 default value(s).' }],
    contentProof: { accepted: false, checked: 10, differences: [{ address: 'Entity:Pet/Attribute:SpeciesId', property: 'api:DefaultValue', expected: 'Entities.Species.Dog', actual: '' }] },
    mergeOrder: { missing: [{ element: 'Pet.SpeciesId', value: 'Entities.Species.Dog', objectKey: 'k1' }], rule: 'r',
      repair: { ops: [{ op: 'set', target: '@k1', prop: 'DefaultValue', value: 'Entities.Species.Dog' }] }, forcedDeleteRules: [], declare: null } };
  const value = deliverOutcome({ envelope: { data: state } }, { work: '.', job: null, input: { module: 'Pets' } });
  assert.notEqual(value.code, 'MERGE_CONTENT_MISMATCH');
  assert.equal(value.continuation?.tool, 'o11_deliver');
  assert.deepEqual(value.continuation.arguments.job, state.mergeOrder.repair);
});

test('H1: the kernel code MERGE_CONTENT_MISMATCH refuses with a summary of the proof that names its elements', () => {
  const differences = Array.from({ length: 25 }, (_, i) => ({ element: 'ServerAction:Save' + i, property: 'api:Action', missing: true }));
  const state = { code: 'MERGE_CONTENT_MISMATCH', delivered: false, writeState: 'applied', validation: { newErrors: 0 }, stage: 'checks', taskId: 't-1',
    contentProof: { accepted: false, checked: 40, differences, inputs: { candidate: 'C:\\work\\candidate.oml' }, coverage: ['a', 'b'] } };
  const value = deliverOutcome({ envelope: { data: state } }, { work: '.', job: null, input: { module: 'Pets' } });
  assert.equal(value.code, 'MERGE_CONTENT_MISMATCH');
  assert.equal(value.contentProof.differencesTotal, 25);
  assert.equal(value.contentProof.differences.length, 20);
  assert.equal(value.contentProof.differences[0].element, 'ServerAction:Save0');
  assert.equal(value.contentProof.inputs, undefined, 'the server paths of the proof stay in the evidence');
  assert.equal(value.contentProof.coverage, undefined);
  assert.equal(value.continuation.tool, 'ssam_evidence');
});

// ---- H2
function scFakes({ signedIn = true } = {}) {
  const opened = [], presentAsked = [];
  const bridge = { pid: 1, version: 'x', supports: async () => true, session: async () => ({ studio: { signedIn, user: 'dev.user' } }) };
  const deps = { locate: async () => bridge, present: async t => { presentAsked.push(t); return false; }, opener: async (...a) => { opened.push(a); return { ok: true }; },
    running: async () => true, promptWaitMs: 0, journal: { lookup: () => null, record: () => {} } };
  return { opened, presentAsked, deps };
}
test('H2: session=vault with a connected Studio and no private profile store reads no vault and opens no prompt', async () => {
  const f = scFakes();
  let error = null;
  try { await serviceCenter(['session-sign-in', '--host', 'sc.example.com', '--session', 'vault'], f.deps); } catch (e) { error = e; }
  assert.equal(f.opened.length, 0, 'a private prompt was opened');
  assert.equal(f.presentAsked.length, 0, 'the vault of this machine was read');
  assert.equal(error?.code, 'VAULT_UNAVAILABLE');
  assert.equal(error.continuation?.tool, 'o11_service_center_session');
});
test('H2: session=vault without a Studio and without a private profile store reads no vault and opens no prompt', async () => {
  const f = scFakes();
  f.deps.locate = async () => null; f.deps.running = async () => false;
  let error = null;
  try { await serviceCenter(['session-sign-in', '--host', 'sc.example.com', '--session', 'vault'], f.deps); } catch (e) { error = e; }
  assert.equal(f.opened.length + f.presentAsked.length, 0);
  assert.equal(error?.code, 'VAULT_UNAVAILABLE');
});
test('H2: sign-in without session=vault and a connected signed-in Studio answers from the Studio alone', async () => {
  const f = scFakes();
  const value = await serviceCenter(['session-sign-in', '--host', 'sc.example.com'], f.deps);
  assert.equal(value.auth.path, 'studio');
  assert.equal(f.opened.length + f.presentAsked.length, 0);
});

// ---- M1
const odcConfig = { tenants: { 'tenant.example.com': { stages: { Development: { origin: 'https://tenant.example.com' } } } } };
const odcStatus = async () => ({ ok: true, modules: [{ name: 'OtherApp', host: 'tenant.example.com', loggedIn: true }], sessions: [{ host: 'tenant.example.com', loggedIn: true }] });
test('M1: an app open in neither Studio, both connected, answers from the signed-in ODC session as before', async () => {
  const o11Status = async () => ({ ok: true, openModules: [{ name: 'SomeO11Module', environment: 'o11.example.com' }], environments: ['o11.example.com'] });
  const value = await resolveApplicationUrls({ app: 'Sales', screen: 'Home' }, { config: odcConfig, status: odcStatus, o11Status });
  assert.equal(value.url, 'https://tenant.example.com/Sales/Home');
});
test('M1: the O11 probe of ssam_app_url only pings and lists the open modules, and never throws', async () => {
  assert.equal(typeof o11Studio.o11OpenModules, 'function', 'o11-studio.mjs exports the read-only probe');
  const verbs = [];
  const bridge = { ok: async verb => { verbs.push(verb); if (verb === 'ping') return { bridge: 'anvil', pid: 7 };
    if (verb === 'list_open_modules') return { modules: [{ name: 'Orders', environment: 'o11.example.com', hasESpace: true }], environments: ['o11.example.com'],
      pendingDialogs: [{ title: 'Manage Dependencies' }] };
    throw new Error('unexpected verb ' + verb); } };
  const value = await o11Studio.o11OpenModules({ bridge });
  assert.deepEqual(verbs, ['ping', 'list_open_modules']);
  assert.deepEqual(value.openModules, [{ name: 'Orders', environment: 'o11.example.com' }]);
  const down = await o11Studio.o11OpenModules({ bridge: { ok: async () => { throw new Error('ECONNREFUSED'); } } });
  assert.equal(down.ok, false);
  // The wiring of ssam_app_url (lib.mjs appUrl): that probe and the stored module kind, never the status command (it answers
  // the dependencies dialog) nor a module digest (it captures the module).
  const lib = read(path.join(facade, 'lib.mjs'));
  const appUrl = lib.slice(lib.indexOf('export function appUrl('), lib.indexOf('\n}\n', lib.indexOf('export function appUrl(')));
  assert.match(appUrl, /o11OpenModules/);
  assert.match(appUrl, /storedModuleKind/);
  assert.doesNotMatch(appUrl, /moduleDigest|command: 'status'/);
});
test('M1: lane o11 with a screen reads the module kind from the stored digest, without a reader or a Studio', async t => {
  assert.equal(typeof moduleMapModule.storedModuleKind, 'function', 'module-map.mjs exports storedModuleKind');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-review-kind-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, SSAM_MODULE_INDEX_ROOT: root };
  const dir = path.join(root, await storeGeneration(), 'o11');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a'.repeat(64) + '.kernel.digest.e' + DIGEST_EXTRACTOR + '.json'), JSON.stringify({ module: { name: 'Orders', kind: 'WebResponsive' } }));
  assert.equal(moduleMapModule.storedModuleKind('o11', 'Orders', env), 'WebResponsive');
  assert.equal(moduleMapModule.storedModuleKind('o11', 'Missing', env), null);
  let odcAsked = 0;
  const value = await resolveApplicationUrls({ app: 'Orders', screen: 'List', lane: 'o11' }, { config: odcConfig, status: async () => { odcAsked++; return odcStatus(); },
    o11Status: async () => ({ ok: true, openModules: [{ name: 'Orders', environment: 'o11.example.com' }], environments: ['o11.example.com'] }),
    o11ModuleKind: async app => moduleMapModule.storedModuleKind('o11', app, env) });
  assert.equal(odcAsked, 0);
  assert.equal(value.url, 'https://o11.example.com/Orders/List.aspx');
});

// ---- M2
async function flowCase(t, lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-review-flow-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = path.join(dir, 'store');
  const env = { ...process.env, SSAM_MODULE_INDEX_ROOT: store, SSAM_READER_CACHE_ROOT: path.join(dir, 'readers') };
  const c = writeCapture(dir);
  const text = ['server action Login @A1', '  in Id: Long Integer @p1', ...Array.from({ length: lines }, (_, i) => '  assign Total = Total + ' + i + ' @n' + (i + 1)), '  end @n' + (lines + 1)].join('\n') + '\n';
  const flow = { schema: 'ssam-flow/1', extractor: FLOW_EXTRACTOR, lane: 'o11', adapter: 'kernel', sourceSha256: c.sha256, sourceBytes: 42, createdAt: '2026-10-11T00:00:00Z',
    module: { name: 'Quotes', key: 'R0' }, notWritten: {}, actions: [{ key: 'A1', kind: 'ServerAction', name: 'Login', fixedPoint: true, nodes: lines + 2, digestBytes: 100, text, ids: {}, problems: [] }] };
  const file = path.join(store, await storeGeneration(), 'o11', c.sha256 + '.kernel.flow.json');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(flow));
  const noReader = async () => { throw new Error('the reader must not be called on a hit'); };
  return { text, call: args => moduleMap(args, { env, read: noReader }), read: args => moduleMap({ lane: 'o11', target: c.file, view: 'flow', element: 'Login', ...args }, { env, read: noReader }) };
}
test('M2: a flow action whose whole text fits the budget is one page, as before the port', async t => {
  const f = await flowCase(t, 20);
  const whole = await f.read({ budgetBytes: 4096 });
  assert.equal(whole.ok, true, whole.code + ' ' + whole.error);
  assert.equal(whole.pages, 1);
  assert.equal(whole.text, f.text);
  assert.ok(whole.size.bytes <= 4096);
});
test('M2: a longer action at the same budget comes in the pages it had before the port, each within the budget', async t => {
  const f = await flowCase(t, 60);
  const first = await f.read({ budgetBytes: 4096 });
  assert.equal(first.ok, true, first.code + ' ' + first.error);
  assert.equal(first.pages, 3);
  const pages = [first];
  while (pages.at(-1).continuations?.next && pages.length < 10) pages.push(await f.call(pages.at(-1).continuations.next.arguments));
  for (const p of pages) { assert.equal(p.ok, true, p.error); assert.ok(bytes(p) <= 4096, 'page ' + p.page + ': ' + bytes(p)); }
  assert.equal(pages.length, 3);
  assert.equal(pages.map(p => p.text).join(''), f.text);
});

// ---- M3
// The answers of 3458f518 (the candidate before the port) for O11 requests of unknown kind that the port changed: the
// direct matches and the proven example are the same again (the review's comparison over every corpus).
const UNKNOWN_KIND = [
  { intent: 'evento onclick de um botao e um extended event ligados a uma screen action', direct: ['ui.event', 'logic.app-event', 'logic.screen-action', 'ui.screen'] },
  { intent: 'criar uma tela de cadastro de clientes com formulário e botão salvar', direct: ['ui.form', 'ui.screen', 'ui.screen-spec'], proven: 'screen-form-reactive' },
  { intent: 'mostrar o botão Salvar só para o administrador na tela Produto', direct: ['ui.screen', 'ui.form'], proven: 'screen-form-reactive' },
  { intent: 'change the button color on the Orders screen', direct: ['ui.event', 'ui.screen', 'ui.widget', 'ui.html-visual', 'logic.app-event'] },
  { intent: 'rename the Save button label to Confirm on the Edit screen', proven: 'rename-logic-propagation' },
  { intent: 'show the Save button only when the user is admin on the Product screen', proven: 'screen-form-reactive' },
];
test('M3: O11 requests of unknown kind keep the answers of before the port (no Traditional capability or example)', async () => {
  for (const c of UNKNOWN_KIND) {
    const a = await discoverAll({ lane: 'o11', intent: c.intent, sources: o11() });
    const direct = (a.matches ?? []).filter(m => m.via === 'match').map(m => m.id);
    assert.ok(!direct.some(id => id.startsWith('ui.traditional')), c.intent + ': ' + direct);
    if (c.direct) assert.deepEqual(direct, c.direct, c.intent);
    if (c.proven) assert.equal(a.provenExample?.job ?? null, c.proven, c.intent);
  }
});
test('M3: the OutSystems UI section of an O11 request of unknown kind has the libraries and size it had', async () => {
  const a = await discoverAll({ lane: 'o11', intent: 'add an if statement in the flow', sources: o11() });
  const section = a.outsystemsUi;
  assert.ok(section, 'the section of a request of unknown kind');
  assert.deepEqual(section.libraries.map(l => l.library.split(' ')[0]), ['OutSystemsUI', 'OutSystemsUIWeb']);
  assert.ok(section.libraries.every(l => l.actions === undefined), 'no public actions for the whole lane');
  assert.ok(bytes(section) <= 868, 'section bytes ' + bytes(section));
});

// ---- M4
test('M4: a Traditional request keeps its proven example, in the answer and in the packet', async () => {
  for (const intent of ['create a Traditional web screen with a table records of Customers', 'criar uma tela tradicional com um formulário de edição de registro']) {
    const a = await discoverAll({ lane: 'o11', intent, sources: o11() });
    assert.equal(a.provenExample?.job, 'screen-crud-traditional', intent);
  }
});
test('M4: an 8 KB Traditional packet keeps a compact Traditional section', async () => {
  for (const intent of ['create a Traditional web screen with a table records of Customers', 'add a button to the Traditional screen that navigates to the Detail screen']) {
    const p = await discoverAll({ lane: 'o11', intent, sources: o11(), packet: true, budgetBytes: 8192 });
    assert.equal(p.ok, true, p.error);
    assert.ok(bytes(p) <= 8192);
    assert.equal(p.text?.id, 'ui.traditional-screen', intent + ': text ' + JSON.stringify(p.text ?? null).slice(0, 120));
    assert.ok(p.text.use && p.text.forms.includes('ssam-html/1'));
    assert.ok(p.cuts.some(c => c.section === 'text'), 'the rest of the section is one cut away');
  }
});

// ---- M5
test('M5: evidence redaction keeps every secret key of before, with opaque values', () => {
  const keys = ['token', 'accessToken', 'access_token', 'idToken', 'refreshToken', 'csrfTokenValue', 'accessTokenValue', 'bearerTokenString', 'xsrfTokenHeader',
    'apiTokens', 'refreshTokens', 'tokenValue', 'PortalTokenCache', 'InputTokens', 'tokenCount', 'max_tokens', 'password', 'clientSecret', 'Cookie', 'Authorization'];
  const doc = Object.fromEntries(keys.map(k => [k, 'opaque-value-not-a-number-' + k]));
  const out = structuredClone(doc); redact(out);
  assert.deepEqual(keys.filter(k => out[k] === doc[k]), [], 'kept in clear');
  // Counters of tokens with a plain number stay readable (usage metrics), and so does any number value.
  const counters = { InputTokens: '1200', tokenCount: '42', max_tokens: '4096', OutputTokens: 77 };
  const kept = structuredClone(counters); redact(kept);
  assert.deepEqual(kept, counters);
});

// ---- L1
test('L1: the Reactive and ODC OutSystems UI libraries carry no public actions; the Traditional ones do', () => {
  const catalog = JSON.parse(read(path.join(facade, 'outsystems-ui', 'catalog.json')));
  for (const l of catalog.libraries) {
    const traditional = ['o11-outsystemsuiweb', 'o11-richwidgets'].includes(l.id);
    assert.equal((l.actions ?? []).length > 0, traditional, l.id + ': ' + (l.actions ?? []).length + ' actions');
  }
});

// ---- L2
test('L2: a logic or data packet carries no OutSystems UI catalog hint', async () => {
  for (const intent of ['criar uma server action que soma os itens do pedido com um aggregate', 'gravar username e password do cliente REST', 'criar um agente de IA com conexao MCP', 'did the publish finish?']) {
    const p = await discoverAll({ lane: 'o11', intent, sources: o11(), packet: true, budgetBytes: 8192 });
    assert.equal(p.ok, true, p.error);
    assert.equal(p.uiCatalog, undefined, intent);
  }
});

// ---- L3
test('L3: the tools of a mixed request never ask the model part again', async () => {
  const answer = { ok: true, lane: 'o11', intent: 'publish and add a screen', matches: [{ id: 'ui.screen', via: 'match', blob: 'x'.repeat(9000) }],
    size: { bytes: 0, budgetBytes: 8000, status: 'within', truncated: [] } };
  const routed = { mixed: true, tools: [{ tool: 'o11_publish', lane: 'o11', args: { module: '<Module>' }, when: 'publish' }] };
  let reran = 0;
  await attachTools(answer, routed, { budgetBytes: 8000, lane: 'o11', rerun: async () => { reran++; return { ok: true, lane: 'o11', intent: answer.intent, matches: [], size: { bytes: 0, budgetBytes: 4000, status: 'within', truncated: [] } }; } });
  assert.equal(reran, 0);
});

// ---- L4
test('L4: a delivered O11 answer carries the verdicts, counts and evidence pointers, never the whole proofs', () => {
  const state = { delivered: true, writeState: 'applied', validation: { newErrors: 0 }, stage: 'done', taskId: 't-2', strictlyEqual: true,
    contentProof: { accepted: true, checked: 12, differences: [], inputs: { candidate: 'C:\\work\\candidate.oml', module: 'C:\\work\\after.oml' }, coverage: Array.from({ length: 50 }, (_, i) => 'k' + i) },
    mergeContentPreview: { accepted: true, path: 'C:\\work\\preview.oml', sha256: 'P', contentProof: { accepted: true, checked: 12, differences: [], inputs: { candidate: 'C:\\x' } } } };
  const value = deliverOutcome({ envelope: { data: state } }, { work: '.', job: null, input: { module: 'Pets' } });
  assert.equal(value.contentProof.accepted, true);
  assert.equal(value.contentProof.checked, 12);
  assert.equal(value.contentProof.inputs, undefined);
  assert.equal(value.contentProof.coverage, undefined);
  assert.equal(value.contentProof.evidence.tool, 'ssam_evidence');
  assert.equal(value.mergeContentPreview.path, undefined);
  assert.ok(!JSON.stringify(value).includes('C:\\\\work'), 'no server path of the proofs in the answer');
});

// ---- L7
test('L7: the O11 delivery writes no prototype receipt file', () => {
  assert.doesNotMatch(read(path.join(facade, 'o11-cycle.mjs')), /prototype-receipts/);
});

// ---- L8
test('L8: the app URL tests use neutral hosts only', () => {
  assert.doesNotMatch(read(path.join(here, 'app-urls.test.mjs')), /personal-[a-z0-9]+\./);
});

// ---- the store generation
test('the module index store folder names the index and flow extractors, the same in the kernel and the facade', async () => {
  const generation = await storeGeneration();
  const index = read(path.join(kernel, 'src', 'Anvil.Core', 'Kernel', 'ModuleIndex.cs'));
  const flow = read(path.join(kernel, 'src', 'Anvil.Core', 'Kernel', 'ModuleFlow.cs'));
  const indexExtractor = Number(index.match(/public const int Extractor = (\d+);/)[1]);
  const flowExtractor = Number(flow.match(/public const int Extractor = (\d+);/)[1]);
  assert.equal(generation, 'v1-i' + indexExtractor + 'f' + flowExtractor);
  assert.match(index, /Generation = "v1-i" \+ ModuleIndex\.Extractor \+ "f" \+ ModuleFlow\.Extractor;/);
  assert.doesNotMatch(index, /Path\.Combine\(root, "v1"/, 'every store path uses the generation');
  for (const file of ['module-map.mjs', 'flow-edits.mjs', 'ui-precheck.mjs'])
    assert.doesNotMatch(read(path.join(facade, file)), /indexRoot\([^)]*\), 'v1'/, file);
});
