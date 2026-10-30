// fase4-28 r2-preview: the hosted tool ssam_render (DESENHO-PREVIEW-UPLOAD 2.1, 2.5, 2.8, 2.9 and 4) end to end: a hosted
// server whose agent link is the REAL hub (HTTP/NDJSON) with a scripted agent, and a fake kernel (render-document is piece
// C, another session). The listing gate (switch, kernel, the agent's Hello), the ceilings with the tool listed, the core
// unchanged, problems and verdicts, images, the facts file read back by ssam_evidence, every refusal (no agent call when
// the kernel's package is refused), the privacy of the facts (no text), the texts of discover/reference, the doctor's
// fields and the classification as a read.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { runWithExecutor, prepareWorkspace } from '../executor.mjs';
import { createSsamServer } from '../ssam.mjs';
import { serverRoots } from '../hosted/policy.mjs';
import { toolListingBytes } from '../tool-listing.mjs';
import { frictionTool } from '../../../../facade/friction-boundary.mjs';
import { startHub, scriptedAgent, BASE_KINDS, waitFor } from './fixtures/render-hub.mjs';

const HOSTED_LISTING_CEILING = 261330;
const HOSTED_CORE_CEILING = 34097;
const CORE = ['ssam_doctor', 'ssam_connect', 'ssam_discover', 'ssam_map', 'ssam_code', 'ssam_reference', 'ssam_evidence', 'ssam_task', 'o11_inspect',
  'o11_deliver', 'o11_publish', 'o11_studio', 'studio_deliver', 'studio_inspect', 'studio_status'];
const sha = text => createHash('sha256').update(text).digest('hex');
const SECRET = 'SECRET-SCREEN-TEXT';

// ---- the fake kernel: ssam-render-document/1 in the real shape of render-document at fase4-28/r3-runtime-dom 7cfb8fe9
// (RenderDocument.Compose/Probes): keyForm "safe" (every key as RenderDocument.SafeKey), platform {osui, runtime, sheets},
// styles {id, origin, sha256, css}, documents {id, screen, key, html, sha256, styles, bodyClasses, sampleData, unexpanded},
// probes {key, viewport, property, warning, document, winner, patch, expect? | expectNot?} with the five platform codes, and
// warnings [{code: RENDER_PLATFORM_SHEETS_MISSING, message}] when the sheets are not present.
const htmlOf = (body = '') => '<!doctype html><html><head><style>.menu{position:fixed}</style></head><body>'
  + '<div class="menu" data-ssam-key="m1">Menu</div><label data-ssam-key="a1">' + SECRET + '</label><button data-ssam-key="b2">Save</button>' + body + '</body></html>';
function packageOf({ html = htmlOf(), css = '.x{color:red} .menu{position:fixed}', screens = ['Dashboard'], probes = null, sheets = 'present' } = {}) {
  return { schema: 'ssam-render-document/1', keyForm: 'safe', lane: 'o11', module: 'App', sourceSha256: 'a'.repeat(64),
    platform: { osui: '2.28.1', runtime: '11.55.92', sheets },
    styles: [{ id: 'osui', origin: 'osui@2.28.1', sha256: sha(css), css }],
    documents: screens.map((screen, i) => ({ id: 's' + (i + 1), screen, key: 'k' + i, html, sha256: sha(html), styles: ['osui'],
      bodyClasses: { desktop: ['desktop'], tablet: ['tablet', 'portrait'], phone: ['phone', 'portrait'] }, sampleData: 'synthetic', unexpanded: [] })),
    probes: probes ?? [
      { key: 'a1', viewport: 'tablet', property: 'white-space', warning: 'HTML_PLATFORM_INHERITED', document: 's1', winner: 'OutSystemsUI.css span[data-expression]',
        patch: '.cell span[data-expression]{white-space:inherit}', expect: 'normal' },
      { key: 'b2', viewport: 'tablet', property: 'coveredBy', warning: 'HTML_PLATFORM_FIXED_LAYOUT', document: 's1', winner: 'OutSystemsUI.css .app-menu-content', patch: null },
      { key: 'b2', viewport: 'desktop', property: 'margin-left', warning: 'HTML_PLATFORM_INJECTED', document: 's1', winner: 'OutSystemsUI.css .OSFillParent',
        patch: '.chart.OSFillParent{margin-left:0px}', expect: '0px' },
      { key: 'zz', viewport: 'phone', property: 'width', warning: 'HTML_PLATFORM_SPECIFICITY', document: 's1', winner: 'theme.css .x', patch: '.x{width:100%}', expect: '100%' }],
    ...(sheets === 'present' ? {} : { warnings: [{ code: 'RENDER_PLATFORM_SHEETS_MISSING', message: 'the platform stylesheets are ' + sheets }] }) };
}
// ---- the scripted agent's facts for a request: a1 wraps in pre-wrap, b2 covered by the fixed menu on the tablet
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 7)]);
function factsFor(request, { unknownKey = false, nonFinite = false } = {}) {
  const images = [];
  return { schema: 'ssam-render-facts/1', engine: { name: 'electron', version: '44.9.2', chromium: '146.0.0.0', protocol: 1 },
    documents: request.documents.map(document => ({ id: document.id, sha256: document.sha256, text: SECRET,
      viewports: request.viewports.map(viewport => {
        let image = null;
        if (request.image) { image = images.length; images.push({ document: document.id, viewport: viewport.name, mime: 'image/jpeg', width: Math.min(viewport.width, request.image.maxEdge),
          height: Math.min(viewport.height, request.image.maxEdge), sha256: sha(jpeg), base64: jpeg.toString('base64') }); }
        const tablet = viewport.name === 'tablet';
        return { name: viewport.name, width: viewport.width, height: viewport.height, ms: 120, innerText: SECRET,
          page: { scrollWidth: viewport.name === 'phone' ? 420 : viewport.width, scrollHeight: 1200, overflowX: viewport.name === 'phone' },
          fonts: { missing: [] },
          elements: [
            { k: unknownKey ? 'nope' : 'a1', box: [16, 64, 120, 40], visible: true, coveredBy: null, clippedBy: null, lines: tablet ? 2 : 1, textLength: 18, overflowX: false,
              text: SECRET, innerText: SECRET, styles: { 'white-space': tablet ? 'pre-wrap' : 'normal', 'margin-left': '0px' } },
            { k: 'b2', box: [16, 120, nonFinite ? Infinity : 80, 32], visible: true, coveredBy: tablet ? { k: 'm1', tag: 'div', classes: ['menu'] } : null, clippedBy: null,
              lines: 1, textLength: 4, overflowX: false, styles: { 'white-space': 'normal', 'margin-left': viewport.name === 'desktop' ? '12px' : '0px' } },
            { k: 'm1', box: [0, 0, 200, 1024], visible: true, coveredBy: null, clippedBy: null, lines: 1, textLength: 4, overflowX: false, styles: {} }],
          truncated: false, image };
      }), errors: [] })), images };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-render-tool-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// A hosted session over the real hub. agent: scriptedAgent options, or null (no agent connected). render: the switch and the
// fake kernel ({env, kernelHas, renderDocument}).
async function session(t, { agent = {}, render = {}, pkg = input => packageOf({ screens: input.screens }) } = {}) {
  const hub = await startHub(); t.after(() => hub.close());
  const kernelCalls = [];
  const deps = { env: { SSAM_SCREEN_RENDER: '1' }, kernelHas: async () => true,
    renderDocument: async input => { kernelCalls.push(input); assert.ok(fs.existsSync(input.outDir), 'the kernel gets an output folder'); return pkg(input); }, ...render };
  let scripted = null;
  if (agent) { scripted = scriptedAgent(hub.base, hub.token.agentCredential, { answer: (call, params) => factsFor(params), ...agent }); await scripted.connect(); t.after(() => scripted.close()); }
  const link = hub.link();
  const workspace = path.join(tmp, 'customers', randomUUID().slice(0, 8));
  prepareWorkspace(workspace);
  fs.mkdirSync(path.join(workspace, 'o11', 'captures'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'o11', 'captures', 'App.oml'), 'capture');
  const executor = { id: 'render-executor', hosted: true, workspace, relayPort: () => 41997, o11Connection: () => null, close: async () => {},
    call: async () => ({ processes: [] }), quota: { full: () => false } };
  const context = { id: randomUUID(), hosted: true, tokenId: hub.token.id, customer: 'Render', lanes: ['odc', 'o11'], workspace, agent: link, executor, close: async () => {} };
  const server = await runWithExecutor(context, () => createSsamServer({ hosted: { context, session: { agent: link, lanes: context.lanes }, render: deps,
    presentation: { workspace, serverRoots: serverRoots({ tmp: '' }) } } }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'render-test', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await server.close(); });
  const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); return { result: r, value: r.structuredContent ?? JSON.parse(r.content[0].text) }; };
  return { hub, link, workspace, client, call, kernelCalls, agent: scripted, render: (args = {}) => call('ssam_render', { lane: 'o11', target: 'ws:o11/captures/App.oml', screens: ['Dashboard'], ...args }) };
}
const listed = async client => (await client.listTools()).tools;

test('listing: ssam_render only with the switch, a kernel with render-document and an agent whose Hello lists screen.render', async t => {
  const cases = [
    { label: 'all three', agent: {}, render: {}, expect: true },
    { label: 'an old agent (no screen.render in its Hello)', agent: { kinds: BASE_KINDS }, render: {}, expect: false },
    { label: 'an agent before 0.2.0 (no kinds)', agent: { kinds: null }, render: {}, expect: false },
    { label: 'the switch off', agent: {}, render: { env: {} }, expect: false },
    { label: 'a kernel without render-document', agent: {}, render: { kernelHas: async () => false }, expect: false },
    { label: 'no agent', agent: null, render: {}, expect: false }];
  for (const c of cases) {
    const s = await session(t, { agent: c.agent, render: c.render });
    const tools = await listed(s.client);
    assert.equal(tools.some(tool => tool.name === 'ssam_render'), c.expect, c.label);
    if (!c.expect) assert.doesNotMatch(JSON.stringify(tools), /ssam_render/, c.label + ': never named');
  }
});

test('listing with ssam_render listed holds the ceilings; the core is byte for byte the one without it', async t => {
  const measure = tools => {
    const all = tools.some(tool => tool.name === frictionTool.name) ? tools : [...tools, frictionTool];
    return { total: all.reduce((sum, tool) => sum + toolListingBytes(tool), 0), core: CORE.reduce((sum, name) => sum + toolListingBytes(tools.find(x => x.name === name)), 0),
      coreText: JSON.stringify(CORE.map(name => tools.find(x => x.name === name))) };
  };
  const on = await listed((await session(t)).client);
  const off = await listed((await session(t, { render: { env: {} } })).client);
  const a = measure(on), b = measure(off);
  const tool = on.find(x => x.name === 'ssam_render');
  assert.ok(tool, 'listed');
  assert.ok(a.total <= HOSTED_LISTING_CEILING, `hosted listing ${a.total} B > ${HOSTED_LISTING_CEILING} B`);
  assert.ok(a.core <= HOSTED_CORE_CEILING, `hosted core ${a.core} B > ${HOSTED_CORE_CEILING} B`);
  assert.equal(a.coreText, b.coreText, 'the core does not change by one byte');
  assert.equal(a.total - b.total, toolListingBytes(tool), 'ssam_render is the only difference');
  assert.ok(toolListingBytes(tool) <= 1045, 'ssam_render within the measured 1045 B');
  assert.equal(tool.description, 'Renders screens of a capture, open module or checked candidate in a sandbox on the SSAM agent of the user: no publish, no network, no app data. Returns layout problems per @key and viewport; facts via ssam_evidence. image:true adds a JPEG per screen and viewport.');
  assert.deepEqual(Object.keys(tool.inputSchema.properties).filter(k => k !== 'continueTask'), ['lane', 'target', 'screens', 'viewports', 'keys', 'properties', 'image']);
  assert.equal(tool.annotations.readOnlyHint, true);
});

test.todo('candidateRef (64 hex) renders a checked candidate: joins with the R2 integration (fase4-28/r2)');

test('end to end: problems per @key and viewport, verdicts with the confirmed first, facts read back by ssam_evidence', async t => {
  const s = await session(t);
  const { value } = await s.render();
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.deepEqual(value.rendered.viewports, ['desktop', 'tablet', 'phone']);
  assert.deepEqual(value.rendered.screens, ['Dashboard']);
  assert.equal(value.rendered.platform.sheets, 'present');
  const codes = value.problems.map(p => `${p.code} ${p.viewport} ${p.key}`);
  assert.ok(codes.includes('RENDER_COVERED tablet @b2'), codes.join('\n'));
  assert.ok(codes.includes('RENDER_TEXT_WRAPPED tablet @a1'));
  assert.ok(codes.includes('RENDER_PAGE_OVERFLOW_X phone null'));
  assert.equal(value.problems.find(p => p.code === 'RENDER_COVERED').by, '@m1');
  assert.deepEqual(value.verifier.map(v => [v.verdict, v.key, v.viewport]), [
    ['confirmed', '@a1', 'tablet'], ['confirmed', '@b2', 'tablet'], ['confirmed', '@b2', 'desktop'], ['not-rendered', '@zz', 'phone']]);
  // review round 3: the kernel's patch is named (hasPatch) and stays in the facts file, never inline
  assert.equal(value.verifier[0].hasPatch, true, 'the verdict says its warning has a patch');
  assert.equal(value.verifier[0].patch, undefined);
  assert.deepEqual(value.verdicts, { confirmed: 3, notObserved: 0, notRendered: 1 });
  assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 9216, 'the answer is at most 9 KB');
  assert.match(value.facts.file, /^ws:o11\/render\/[0-9a-f]{64}\.json$/, 'a workspace name, never a server path');
  assert.equal(value.continuation.tool, 'ssam_evidence');
  const { value: evidence } = await s.call('ssam_evidence', { file: value.facts.file });
  assert.notEqual(evidence.ok, false, JSON.stringify(evidence).slice(0, 400));
  assert.match(JSON.stringify(evidence), /ssam-render-evidence\/1|ssam-render-facts\/1/);
  assert.equal(s.kernelCalls.length, 1);
  assert.deepEqual(s.kernelCalls[0].viewports, ['desktop', 'tablet', 'phone']);
  assert.ok(!fs.existsSync(s.kernelCalls[0].outDir), 'the kernel output folder is removed');
  const call = s.agent.calls.find(c => c.kind === 'screen.render');
  assert.ok(call.deadline - Date.now() > 60000, 'the server waits the request time plus 15 s');
});

test('image:true: the answer carries JPEG image items (at most 3); without it, none', async t => {
  const s = await session(t);
  const plain = await s.render();
  assert.equal(plain.result.content.filter(c => c.type === 'image').length, 0);
  const shown = await s.render({ image: true });
  assert.equal(shown.value.ok, true, JSON.stringify(shown.value));
  const items = shown.result.content.filter(c => c.type === 'image');
  assert.equal(items.length, 3);
  for (const item of items) { assert.equal(item.mimeType, 'image/jpeg'); assert.equal(item.data, jpeg.toString('base64')); }
  assert.deepEqual(shown.value.images, { shown: 3, total: 3, omitted: 0 });
  const two = await s.render({ image: true, screens: ['Dashboard', 'Orders'] });
  assert.equal(two.result.content.filter(c => c.type === 'image').length, 3, 'six rendered, three answered');
  assert.equal(two.value.images.total, 6);
});

test('privacy: text and innerText of the agent are dropped from the answer and from the facts file', async t => {
  const s = await session(t);
  const { value } = await s.render({ image: true });
  assert.equal(value.ok, true);
  assert.ok(!JSON.stringify(value).includes(SECRET), 'not in the answer');
  const file = path.join(s.workspace, 'o11', 'render', value.facts.sha256 + '.json');
  const kept = fs.readFileSync(file, 'utf8');
  assert.ok(!kept.includes(SECRET), 'not in the facts file');
  assert.ok(!/"(?:text|innerText)"/.test(kept));
});

test('refusals before the agent: a script or an outside address in the kernel package, a package too large', async t => {
  const rows = [
    { label: 'script', pkg: () => packageOf({ html: htmlOf('<script>alert(1)</script>') }), code: 'RENDER_DOCUMENT_REFUSED' },
    { label: 'outside image', pkg: () => packageOf({ html: htmlOf('<img src="https://cdn.example.com/x.png">') }), code: 'RENDER_DOCUMENT_REFUSED' },
    { label: 'outside css', pkg: () => packageOf({ css: '.a{background:url(//cdn.example.com/x.png)}' }), code: 'RENDER_DOCUMENT_REFUSED' },
    { label: 'an html of more than 4 MiB', pkg: () => packageOf({ html: htmlOf('<p>' + 'x'.repeat(4 * 1024 * 1024) + '</p>') }), code: 'RENDER_TOO_LARGE' },
    { label: 'more than 8 documents', pkg: () => packageOf({ screens: Array.from({ length: 9 }, (_, i) => 'S' + i) }), code: 'RENDER_TOO_LARGE' },
    { label: 'not ssam-render-document/1', pkg: () => ({ schema: 'other' }), code: 'RENDER_DOCUMENT_REFUSED' }];
  for (const row of rows) {
    const s = await session(t, { pkg: row.pkg });
    const { value } = await s.render();
    assert.equal(value.ok, false, row.label);
    assert.equal(value.code, row.code, row.label + ': ' + value.error);
    assert.equal(value.executed, false);
    assert.equal(value.continuation.tool, 'ssam_app_url');
    await new Promise(r => setTimeout(r, 50));
    assert.equal(s.agent.calls.length, 0, row.label + ': the agent got no call');
  }
});

test('refusals from the agent side: facts outside the contract or with an unknown key are AGENT_PROTOCOL_VIOLATION', async t => {
  const rows = [
    { label: 'unknown key', answer: (call, params) => factsFor(params, { unknownKey: true }) },
    { label: 'not a finite number', answer: (call, params) => { const f = factsFor(params); f.documents[0].viewports[0].elements[1].box[2] = 'wide'; return f; } },
    { label: 'another schema', answer: () => ({ schema: 'x' }) },
    { label: 'ten images', answer: (call, params) => { const f = factsFor({ ...params, image: { format: 'jpeg', quality: 70, maxEdge: 1568, fullPage: false } }); f.images = Array.from({ length: 10 }, () => f.images[0]); return f; } }];
  for (const row of rows) {
    const s = await session(t, { agent: { answer: row.answer } });
    const { value } = await s.render();
    assert.equal(value.ok, false, row.label);
    assert.equal(value.code, 'AGENT_PROTOCOL_VIOLATION', row.label + ': ' + value.error);
    assert.equal(fs.existsSync(path.join(s.workspace, 'o11', 'render')) ? fs.readdirSync(path.join(s.workspace, 'o11', 'render')).filter(f => f.endsWith('.json')).length : 0, 0, row.label + ': no facts kept');
  }
});

test('the deadline: an agent that never answers is AGENT_TIMEOUT with a continuation; an agent error passes its code', async t => {
  const s = await session(t, { agent: { answer: () => 'silent' } });
  const { renderScreens } = await import('../hosted/screen-render.mjs');
  // The link's call with a short deadline (the tool's own is 75 s): the hub's AGENT_TIMEOUT is answered as a refusal.
  const link = { connected: () => true, supports: () => true, call: (kind, params, options) => s.link.call(kind, params, { ...options, timeoutMs: 300 }) };
  const out = await renderScreens({ lane: 'o11', target: path.join(s.workspace, 'o11', 'captures', 'App.oml'), screens: ['Dashboard'] },
    { context: { workspace: s.workspace }, link, env: { SSAM_SCREEN_RENDER: '1' }, deps: { kernelHas: async () => true, renderDocument: async () => packageOf() } });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'AGENT_TIMEOUT');
  assert.equal(out.continuation.tool, 'ssam_render');
  assert.ok(out.staticWarnings.length > 0, 'the static warnings stay');
  const busy = await session(t, { agent: { answer: () => ({ error: { code: 'RENDER_BUSY', message: 'The agent is already rendering', executed: false } }) } });
  const { value } = await busy.render();
  assert.equal(value.code, 'RENDER_BUSY');
  assert.equal(value.continuation.tool, 'ssam_render');
});

test('without the agent or the kind: AGENT_NOT_CONNECTED / AGENT_KIND_MISSING with the static warnings and publish-and-open; never publishes', async t => {
  for (const [agent, code] of [[null, 'AGENT_NOT_CONNECTED'], [{ kinds: BASE_KINDS }, 'AGENT_KIND_MISSING']]) {
    const s = await session(t, { agent });
    const { value, result } = await s.render();
    assert.equal(result.isError, true);
    assert.equal(value.code, code);
    assert.equal(value.executed, false);
    assert.equal(value.staticWarnings.length, 4);
    assert.deepEqual(value.continuation, { tool: 'ssam_app_url', arguments: { app: 'App', screen: 'Dashboard', lane: 'o11' }, why: value.continuation.why });
    if (s.agent) assert.equal(s.agent.calls.length, 0);
  }
  const off = await session(t, { render: { env: {} } });
  assert.equal((await off.render()).value.code, 'RENDER_UNAVAILABLE');
  const noKernel = await session(t, { render: { kernelHas: async () => false } });
  assert.equal((await noKernel.render()).value.code, 'RENDER_KERNEL_MISSING');
});

test('texts: unavailable, discover and reference never name ssam_render; available, discover routes "see the screen without publishing" to it', async t => {
  const intents = ['see the screen without publishing', 'ver a tela sem publicar', 'preview the Dashboard screen'];
  const off = await session(t, { agent: { kinds: BASE_KINDS } });
  for (const intent of intents) assert.doesNotMatch(JSON.stringify((await off.call('ssam_discover', { intent, lane: 'o11' })).value), /ssam_render/, intent);
  assert.doesNotMatch(JSON.stringify((await off.call('ssam_reference', { kind: 'tool', query: 'ssam_render' })).value), /ssam_render/);
  const on = await session(t);
  for (const intent of intents) {
    const { value } = await on.call('ssam_discover', { intent, lane: 'o11' });
    assert.equal(value.tools?.[0]?.tool, 'ssam_render', intent + ': ' + JSON.stringify(value).slice(0, 300));
  }
  assert.doesNotMatch(JSON.stringify((await on.call('ssam_discover', { intent: 'create an entity Order with a name', lane: 'o11' })).value.tools ?? []), /ssam_render/, 'an unrelated intent');
  const reference = JSON.stringify((await on.call('ssam_reference', { kind: 'tool', query: 'ssam_render' })).value);
  assert.match(reference, /ssam_render/, 'available, ssam_reference names it: ' + reference.slice(0, 300));
});

test('ssam_doctor (hosted): render {available, reason} and uploads {agentKind}; the doctor listing does not change', async t => {
  const on = await session(t);
  const a = (await on.call('ssam_doctor', {})).value;
  assert.deepEqual(a.render, { available: true, lanes: ['odc', 'o11'] });
  assert.deepEqual(a.uploads, { agentKind: false });
  const old = await session(t, { agent: { kinds: BASE_KINDS } });
  const b = (await old.call('ssam_doctor', {})).value;
  assert.equal(b.render.available, false);
  assert.equal(b.render.code, 'AGENT_KIND_MISSING');
  assert.match(b.render.reason, /update the SSAM Agent to render screens/);
  const upload = await session(t, { agent: { kinds: [...BASE_KINDS, 'file.upload'] } });
  assert.deepEqual((await upload.call('ssam_doctor', {})).value.uploads, { agentKind: true });
  const doctor = (await listed(on.client)).find(x => x.name === 'ssam_doctor');
  assert.doesNotMatch(JSON.stringify(doctor), /render|ssam_render/i);
});

test('classification: ssam_render is a read outside the Studio write queue', async () => {
  const { classifyTool, STUDIO_WRITE_TOOLS } = await import('../tool-classification.mjs');
  const verdict = classifyTool('ssam_render', { lane: 'o11', screens: ['A'] });
  assert.equal(verdict.declared, true);
  assert.equal(verdict.isReadOnly, true);
  assert.equal(verdict.isWrite, false);
  assert.equal(Object.hasOwn(STUDIO_WRITE_TOOLS, 'ssam_render'), false);
  const { hostedTools } = await import('../hosted/policy.mjs');
  assert.equal(hostedTools().ssam_render?.class, 'agent');
});

test('the kernel probe: render-document --capabilities with schema ssam-render-document/1; an answer is kept, a failed start is asked again', async () => {
  const { kernelRendersDocuments } = await import('../hosted/screen-render.mjs');
  const calls = [];
  const yes = async args => { calls.push(args); return { ok: true, envelope: { ok: true, data: { schema: 'ssam-render-document/1', keyForm: 'safe', viewports: ['desktop', 'tablet', 'phone'] } } }; };
  assert.equal(await kernelRendersDocuments('o11', { runAnvil: yes, cli: 'probe-yes.dll' }), true);
  assert.equal(await kernelRendersDocuments('o11', { runAnvil: yes, cli: 'probe-yes.dll' }), true);
  assert.deepEqual(calls, [['render-document', '--capabilities']], 'asked once per process and lane');
  assert.equal(await kernelRendersDocuments('o11', { runAnvil: async () => ({ ok: false, exitCode: 64, envelope: null }), cli: 'probe-old.dll' }), false, 'a kernel without the verb');
  let starts = 0;
  const broken = async () => { starts++; throw new Error('spawn dotnet ENOENT'); };
  assert.equal(await kernelRendersDocuments('odc', { runAnvil: broken, cli: 'probe-broken.dll' }), false);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(await kernelRendersDocuments('odc', { runAnvil: broken, cli: 'probe-broken.dll' }), false);
  assert.equal(starts, 2, 'a failed start is not kept');
});

// ---- the review's corrections (REVISAO-SERVIDOR.md findings 1-3)
test('a key the kernel would refuse for its shape is BAD_ARGS before the kernel and the agent, with the exact rule', async t => {
  const s = await session(t);
  const { value } = await s.render({ keys: ['a.b'] });
  assert.equal(value.code, 'BAD_ARGS', JSON.stringify(value));
  assert.match(value.error, /\^@\?\[A-Za-z0-9\+\/=_-\]\{1,120\}\$/);
  assert.equal(s.kernelCalls.length, 0, 'the kernel never ran');
  assert.equal(s.agent.calls.length, 0, 'the agent got no call');
  assert.notEqual(value.continuation?.tool, 'ssam_app_url');
  const good = (await s.render({ keys: ['@a1', 'b2', 'm1'] })).value;
  assert.equal(good.ok, true, 'a well-formed @key passes: ' + JSON.stringify(good).slice(0, 300));
});

test('RENDER_KERNEL_FAILED never carries a stack line nor a source path of the kernel', async t => {
  const frame = '   at Anvil.Core.Kernel.RenderDocument.Build(String oml) in /src/kernel/src/Anvil.Core/Kernel/RenderDocument.cs:line 88';
  for (const reply of [{ ok: false, exitCode: 1, envelope: null, stderr: [frame] },
    { ok: false, exitCode: 1, envelope: { ok: false, error: 'System.InvalidOperationException: the screen Dashboard has no layout\n' + frame }, stderr: [frame] }]) {
    const s = await session(t, { render: { renderDocument: undefined, runAnvil: async () => reply } });
    const { value } = await s.render();
    assert.equal(value.code, 'RENDER_KERNEL_FAILED', JSON.stringify(value));
    const text = JSON.stringify(value);
    for (const leak of ['/src/', '.cs', 'line 88', 'Exception', 'Anvil.Core']) assert.ok(!text.includes(leak), leak + ' in ' + text);
    assert.doesNotMatch(text, /\bat [A-Za-z.]+\(/, 'no stack frame');
    // review round 3: a fixed sentence with typed fields; the kernel's own words never reach the answer
    assert.equal(value.error, 'The kernel did not build the render documents.');
    assert.equal(value.stage, 'render-document');
    assert.equal(value.exitCode, 1);
    assert.ok(!text.includes('no layout'), 'the kernel\'s words stay out of the answer');
  }
});

test('the retry continuation after AGENT_TIMEOUT repeats the exact arguments (keys, properties, image)', async t => {
  const s = await session(t, { agent: { answer: () => 'silent' } });
  const { renderScreens } = await import('../hosted/screen-render.mjs');
  const link = { connected: () => true, supports: () => true, call: (kind, params, options) => s.link.call(kind, params, { ...options, timeoutMs: 300 }) };
  const input = { lane: 'o11', target: path.join(s.workspace, 'o11', 'captures', 'App.oml'), screens: ['Dashboard'], viewports: ['tablet'], keys: ['a1'], properties: ['width'], image: true };
  const out = await renderScreens(input, { context: { workspace: s.workspace }, link, env: { SSAM_SCREEN_RENDER: '1' },
    deps: { kernelHas: async () => true, renderDocument: async () => packageOf() } });
  assert.equal(out.code, 'AGENT_TIMEOUT');
  assert.deepEqual(out.continuation.arguments, input);
});

// ---- the review's round 2 (REVISAO-SERVIDOR.md R2-1, R2-2): one scrubber for every text of the kernel or the agent
const HOSTILE = [
  'Error: spawn C:\\Program Files\\SSAM Agent\\SSAM Agent.exe ENOENT\n    at ChildProcess._handle.onexit (node:internal/child_process:286:19)',
  'Could not read /srv/x/App.oml: at Anvil.Core.Oml.Read() in /src/kernel/src/Anvil.Core/Oml.cs:line 9',
  'System.IO.IOException: The file C:\\Users\\maria.silva\\AppData\\Local\\SSAM\\x.json is locked at Anvil.Io.Lock(String p) in C:\\build\\Io.cs:line 4',
  'TypeError: x is undefined at render (file:///C:/Users/maria.silva/SSAM/agent/lib/render.mjs:88:3)',
  "ENOENT: no such file or directory, open '/home/joe/ssam/private/tmp/render-1/out.json'\n    at Object.openSync (node:fs:573:18)",
  'cannot open /Users/maria.silva/Library/SSAM/data.json nor \\\\fs01\\share\\maria\\x.oml'];
const LEAKS = ['Program Files', 'node:internal', 'node:fs', '/src/', '.cs', 'line 9', 'line 4', 'Anvil.Core', 'Anvil.Io', 'maria', 'joe', '/srv/', '/home/', '/Users/',
  'AppData', 'fs01', 'file:', 'render.mjs', 'IOException', 'TypeError'];
const leaksOf = text => LEAKS.filter(leak => text.includes(leak)).concat(/\bat [\w$.<>]+\s*\(/.test(text) ? ['a stack frame'] : []);

test('answerText: first line, no stack frame anywhere in the line, no exception prefix, no path of any system, no user name', async () => {
  const { answerText } = await import('../hosted/render-text.mjs');
  for (const text of HOSTILE) {
    const out = answerText(text);
    assert.deepEqual(leaksOf(out), [], JSON.stringify(out));
    assert.ok(!out.includes('\n') && out.length <= 300);
  }
  assert.equal(answerText(HOSTILE[1]), 'Could not read <path>');
  assert.equal(answerText('see https://example.com/help/x for more'), 'see https://example.com/help/x for more', 'a URL of the text stays');
  assert.equal(answerText('keys takes @keys matching ^@?[A-Za-z0-9_-]{1,80}$; not "a.b".'), 'keys takes @keys matching ^@?[A-Za-z0-9_-]{1,80}$; not "a.b".');
});

// ---- the review's round 3 (REVISAO-SERVIDOR.md, Rodada 3): an ssam_render answer never carries free text of the agent or
// the kernel. Each refusal is a fixed sentence by its code with typed fields, built from the server's own strings; the raw
// words go scrubbed to the account's own evidence (diagnosis), never inline. The proof: for every error path the answer is
// THE SAME whatever hostile text the agent, the kernel or the capture sent (diagnosis aside), and holds none of it.
const ROUND3 = [
  ...HOSTILE,
  "access denied for user 'CORP\\maria.souza' on the share",
  'run by joao.silva@corp.com on host JOAO-PC',
  'profile ~joao/ssam is locked',
  'the folder C:\\Users\\Maria Silva is locked',
  'cannot open /Users/joao/My Docs/a.oml now',
  'cannot open C%3A%5CUsers%5Cjoao%5Ca.oml',
  'cannot open file%3A%2F%2F%2FC%3A%2FUsers%2Fjoao%2Fa.oml or %2Fhome%2Fjoao%2Fa.oml',
  'source src\\Anvil.Core\\Kernel\\RenderDocument.cs failed',
  'Error: spawn C:\\Program Files\\SSAM Agent\\SSAM Agent.exe ENOENT for user \'CORP\\maria.souza\'\n    at ChildProcess._handle.onexit (node:internal/child_process:286:19)',
  "Could not read '/srv/data/App.oml' for CORP\\maria.souza"];
const INJECTED = ['maria', 'Maria', 'souza', 'Silva', 'joao', 'JOAO', 'CORP', 'corp.com', 'Docs', '%5C', '%2F', 'Anvil', 'RenderDocument', 'Program Files',
  'node:internal', '/src/', '/srv/', '/home/', '/Users/', 'AppData', 'fs01', 'file:', '.cs', 'line 9', 'line 4', 'IOException', 'TypeError', 'ENOENT', 'spawn',
  'Could not read', 'is locked', 'access denied', 'run by', 'cannot open', 'profile', 'on the share'];
const injectedIn = text => INJECTED.filter(part => text.includes(part)).concat(/\bat [\w$.<>]+\s*\(/.test(text) ? ['a stack frame'] : []);
const withoutDiagnosis = value => { const { diagnosis, ...rest } = value; return rest; };

test('round 3: every error path answers a fixed sentence by its code, the same for any hostile text, and none of it', async t => {
  const { renderScreens } = await import('../hosted/screen-render.mjs');
  const paths = {};
  const note = (label, value) => { (paths[label] ??= []).push(value); };
  // One session per path; each text of the corpus goes through it (current).
  let current = '', agentCode = '';
  const agentSession = await session(t, { agent: { answer: () => ({ error: { code: agentCode, message: current, executed: false } }) } });
  const kernel = await session(t, { render: { renderDocument: undefined, runAnvil: async () => ({ ok: false, exitCode: 3, envelope: { ok: false, error: current }, stderr: [current] }) } });
  const thrown = await session(t, { render: { renderDocument: async () => { throw new Error(current); } } });
  for (const text of ROUND3) {
    current = text;
    for (const code of ['RENDER_FAILED', 'AGENT_ERROR', 'RENDER_BUSY', 'VALUE_TOO_LARGE', 'RENDER_TIMEOUT', 'CORP_MARIA_SOUZA']) {
      agentCode = code;
      note('agent ' + code, (await agentSession.render({ keys: ['a1', 'b2', 'm1'] })).value);
    }
    note('kernel envelope', (await kernel.render()).value);
    note('kernel exception', (await thrown.render()).value);
    for (const code of ['SNAPSHOT_FAILED', 'CORP_MARIA_SOUZA']) {
      const c = await renderScreens({ lane: 'o11', target: 'App', screens: ['Dashboard'] }, { context: { workspace: kernel.workspace }, link: kernel.link,
        env: { SSAM_SCREEN_RENDER: '1' }, deps: { kernelHas: async () => true,
          capture: async () => ({ ok: false, refusal: { ok: false, code, error: text, hint: 'see C:\\Users\\Maria Silva\\log.txt', detail: text, why: text } }) } });
      note('capture ' + code, c);
    }
  }
  for (const [label, values] of Object.entries(paths)) {
    for (const value of values) {
      assert.equal(value.ok, false, label);
      // (review round 4: the diagnosis file is a path of this server, wherever TEMP lives: only its name is checked)
      if (value.diagnosis) assert.match(path.basename(value.diagnosis.file), /^[0-9a-f]{64}\.json$/, label);
      assert.deepEqual(injectedIn(JSON.stringify(withoutDiagnosis(value))), [], label + ': ' + JSON.stringify(withoutDiagnosis(value)).slice(0, 400));
      assert.deepEqual(withoutDiagnosis(value), withoutDiagnosis(values[0]), label + ': the same answer for every hostile text');
    }
  }
  assert.equal(paths['agent CORP_MARIA_SOUZA'][0].code, 'AGENT_ERROR', 'an agent code outside the closed set');
  assert.equal(paths['agent RENDER_FAILED'][0].error, 'The render worker of the SSAM agent failed. Nothing changed on the user\'s machine.');
  assert.equal(paths['kernel envelope'][0].error, 'The kernel did not build the render documents.');
  assert.equal(paths['kernel envelope'][0].exitCode, 3);
  assert.equal(paths['kernel exception'][0].stage, 'read-package');
  assert.equal(paths['capture CORP_MARIA_SOUZA'][0].code, 'CAPTURE_FAILED');
  assert.equal(paths['capture SNAPSHOT_FAILED'][0].continuation.tool, 'ssam_map');
});

test('round 3: the raw words go only to the account\'s diagnosis evidence, scrubbed, which ssam_evidence reads', async t => {
  const text = "Error: spawn C:\\Program Files\\SSAM Agent\\SSAM Agent.exe ENOENT\n    at ChildProcess._handle.onexit (node:internal/child_process:286:19)";
  const s = await session(t, { agent: { answer: () => ({ error: { code: 'RENDER_FAILED', message: text, executed: false } }) } });
  const { value } = await s.render();
  assert.match(value.diagnosis.file, /^ws:o11\/render\/errors\/[0-9a-f]{64}\.json$/);
  const kept = fs.readFileSync(path.join(s.workspace, 'o11', 'render', 'errors', path.basename(value.diagnosis.file)), 'utf8');
  assert.match(kept, /ssam-render-diagnosis\/1/);
  assert.match(kept, /spawn <path> ENOENT/, 'the words, scrubbed');
  assert.ok(!kept.includes('Program Files') && !kept.includes('node:internal'));
  const { value: evidence } = await s.call('ssam_evidence', { file: value.diagnosis.file });
  assert.notEqual(evidence.ok, false, JSON.stringify(evidence).slice(0, 300));
});

test('round 3: the facts of the agent bring no free text either (version, fonts, classes, style values)', async t => {
  const hostile = 'CORP\\maria.souza at C:\\Users\\Maria Silva';
  const answer = (call, params) => {
    const facts = factsFor(params);
    facts.engine.version = 'joao.silva@corp.com';
    for (const document of facts.documents) for (const view of document.viewports) {
      view.fonts.missing = ['Maria Silva Sans', 'Roboto'];
      view.elements[1].coveredBy = { k: null, tag: 'marquee', classes: ['maria-souza', 'menu'] };
      view.elements[1].styles['margin-left'] = hostile;
    }
    return facts;
  };
  const s = await session(t, { agent: { answer } });
  const { value } = await s.render();
  assert.equal(value.ok, true, JSON.stringify(value).slice(0, 300));
  assert.deepEqual(injectedIn(JSON.stringify(value)), [], JSON.stringify(value).slice(0, 600));
  assert.equal(value.rendered.engine.version, null);
  assert.ok(value.problems.some(p => p.code === 'RENDER_COVERED' && p.by === 'element.menu'), 'a tag or class the documents do not have is not shown');
  assert.ok(value.verifier.some(v => v.observed === '<value>'), 'a style value outside the closed grammar and the documents is a placeholder');
  assert.ok(!JSON.stringify(value).includes('"patch"'), 'the kernel\'s patch stays in the facts file');
  assert.ok(value.verifier.some(v => v.hasPatch === true));
});

// ---- the review's round 4 (REVISAO-SERVIDOR.md R4-1): a value of the agent is shown only when it EQUALS a token the server
// parsed from the markup and the sheets it sent (tags, classes, font families, declaration values), never a substring of
// the HTML: the text of the screen never comes back as a font, a class or a style value.
test('round 4: screen text returned as a font, a class or a style value never reaches the answer; real tokens still do', async t => {
  // (review round 5: the tokens come from the request's sheets; the markup gives only keys and tag names)
  const css = '.menu{position:fixed;font-family:Brand Sans, Arial} .gap{margin-left:7px}';
  const html = '<!doctype html><html><head></head><body>'
    + '<div class="menu" data-ssam-key="m1">Menu</div><label class="gap" data-ssam-key="a1">' + SECRET + '</label><button data-ssam-key="b2">Save</button></body></html>';
  const answer = (call, params) => {
    const facts = factsFor(params);
    for (const document of facts.documents) for (const view of document.viewports) {
      view.fonts.missing = [SECRET, 'Brand Sans', 'Menu'];
      view.elements[1].coveredBy = { k: null, tag: 'label', classes: [SECRET, 'menu', 'Save'] };
      view.elements[0].clippedBy = { k: null, tag: 'div', classes: [SECRET] };
      view.elements[0].styles = { 'white-space': SECRET, 'margin-left': SECRET };
      view.elements[1].styles = { 'white-space': 'normal', 'margin-left': '7px' };
    }
    return facts;
  };
  const probes = [{ key: 'a1', viewport: 'tablet', property: 'margin-left', expect: '0px', warning: 'INJECTED_MARGIN' },
    { key: 'b2', viewport: 'desktop', property: 'margin-left', expect: '0px', warning: 'INJECTED_MARGIN' }];
  const s = await session(t, { agent: { answer }, pkg: input => packageOf({ html, css, screens: input.screens, probes }) });
  const { value } = await s.render();
  assert.equal(value.ok, true, JSON.stringify(value).slice(0, 300));
  const text = JSON.stringify(value);
  assert.ok(!text.includes(SECRET), 'the screen text never comes back: ' + text.slice(0, 800));
  assert.ok(!/"by":"[^"]*Save/.test(text) && !/not loaded: [^"]*Menu/.test(text), 'text of the screen that is also a word is not a token either');
  const fonts = value.problems.find(p => p.code === 'RENDER_FONT_MISSING');
  assert.equal(fonts.detail, '3 font families not loaded: Brand Sans (line breaks may differ)', 'a font declared in a sheet still shows');
  assert.ok(value.problems.some(p => p.code === 'RENDER_COVERED' && p.by === 'label.menu'), 'a real class and tag of the document still show');
  assert.ok(value.problems.some(p => p.code === 'RENDER_CLIPPED' && p.by === 'div'));
  const observed = Object.fromEntries(value.verifier.filter(v => v.verdict === 'confirmed').map(v => [v.key, v.observed]));
  assert.deepEqual(observed, { '@a1': '<value>', '@b2': '7px' }, 'a declaration value of the document shows; the screen text is <value>');
});

test('documentsView: closed sets of the markup and the sheets, by exact membership', async () => {
  const { documentsView } = await import('../hosted/screen-render.mjs');
  const view = documentsView({ styles: [{ css: '/* .ghost */ @font-face{font-family:Body Font} @font-face{font-family:"Quoted Font"} .a .b-c:hover{color:#fff}'
    + ' @media (max-width:768.5px){.d{margin-left:0 !important;width:calc(100% - 2px)}} .e{content:"Hi";--label:red;width:10px}' }],
    documents: [{ html: '<style>.inline{margin-left:9px}</style><main class="x  y" style="width: 11px; font-family: Mono">hello .z world</main>' }] });
  for (const c of ['a', 'b-c', 'd', 'e']) assert.ok(view.cls(c), c);
  for (const c of ['ghost', 'z', 'hello', 'b', 'a .b-c', 'x', 'y', 'inline']) assert.ok(!view.cls(c), c);
  assert.ok(view.font('Body Font') && !view.font('Quoted Font') && !view.font('"Quoted Font"') && !view.font('Mono') && !view.font('hello'));
  assert.ok(view.value('#fff') && view.value('0') && view.value('10px') && !view.value('11px') && !view.value('9px') && !view.value('"Hi"') && !view.value('red')
    && !view.value('world') && !view.value('fff') && !view.value('calc(100% - 2px)'));
  assert.ok(view.tag('main') && !view.tag('hello'));
});

// ---- the review's round 5 (REVISAO-SERVIDOR.md, Rodada 5): only values that cannot carry free text are allowed: from the
// request's sheets, of the listed properties, made of identifiers, numbers and colors. CSS strings (content), custom
// properties and anything of a style="" attribute or of the screen markup never enter; fonts are unquoted names of the sheets.
test('round 5: CSS strings, custom properties and inline styles never come back through the answer', async t => {
  const css = `.badge::before{content:"Hello Maria Silva"} .pill::after{content:'Order 4711 of Bob'} .badge{margin-left:12px;font-family:Roboto, "Maria Silva"}`;
  const html = '<!doctype html><html><head><style>.x{font-family:"Bob Font"}</style></head><body><div class="badge" data-ssam-key="m1">Menu</div>'
    + `<span data-ssam-key="a1" style="--label:'Maria Silva';font-family:'Maria Silva';margin-left:3px">` + SECRET + '</span><button class="pill" data-ssam-key="b2">Save</button></body></html>';
  const hostile = ['"Hello Maria Silva"', "'Order 4711 of Bob'", "'Maria Silva'", 'Maria Silva', 'Hello Maria Silva', 'Bob Font'];
  let turn = 0;
  const answer = (call, params) => {
    const facts = factsFor(params);
    const pick = hostile[turn++ % hostile.length];
    for (const document of facts.documents) for (const view of document.viewports) {
      view.fonts.missing = ['Maria Silva', 'Bob Font', 'Roboto'];
      view.elements[0].styles = { 'white-space': 'normal', 'margin-left': pick };
      view.elements[1].styles = { 'white-space': 'normal', 'margin-left': '12px' };
      view.elements[1].coveredBy = { k: null, tag: 'div', classes: ['badge', 'x'] };
    }
    return facts;
  };
  const probes = [{ key: 'a1', viewport: 'tablet', property: 'margin-left', expect: '0px', warning: 'INJECTED_MARGIN' },
    { key: 'b2', viewport: 'desktop', property: 'margin-left', expect: '0px', warning: 'INJECTED_MARGIN' }];
  const s = await session(t, { agent: { answer }, pkg: input => packageOf({ html, css, screens: input.screens, probes }) });
  for (let i = 0; i < hostile.length; i++) {
    const { value } = await s.render();
    assert.equal(value.ok, true, JSON.stringify(value).slice(0, 300));
    const text = JSON.stringify(value);
    for (const word of ['Maria', 'Silva', 'Bob', '4711', 'Hello', SECRET]) assert.ok(!text.includes(word), word + ' in ' + text.slice(0, 600));
    assert.equal(value.problems.find(p => p.code === 'RENDER_FONT_MISSING').detail, '3 font families not loaded: Roboto (line breaks may differ)');
    assert.ok(value.problems.some(p => p.code === 'RENDER_COVERED' && p.by === 'div.badge'), 'a class of the sheets still shows');
    const observed = Object.fromEntries(value.verifier.filter(v => v.verdict === 'confirmed').map(v => [v.key, v.observed]));
    assert.deepEqual(observed, { '@a1': '<value>', '@b2': '12px' });
  }
});

// ---- after the acceptance: the kernel of R3-A (fase4-28/r3-runtime-dom 7cfb8fe9) speaks one key form ("safe", F6) and sends
// expect/expectNot in getComputedStyle form (F5).
test('keys: an @key of ssam_map with + / and = goes to the kernel and the agent in the safe form, never RENDER_REQUEST_INVALID', async t => {
  const { safeKey, KEY_FORM } = await import('../hosted/render-contract.mjs');
  assert.equal(KEY_FORM, 'safe');
  // the rows of RenderDocument.SafeKey
  assert.equal(safeKey('@AbC+d/e=='), 'AbC-d_e');
  assert.equal(safeKey('@@x+y'), 'x-y');
  assert.equal(safeKey('a.b c'), 'abc');
  assert.equal(safeKey('k'.repeat(90)), 'k'.repeat(80));
  const html = '<!doctype html><html><body><div class="menu" data-ssam-key="m1">Menu</div><label data-ssam-key="AbC-d_e">x</label><button data-ssam-key="b2">Save</button></body></html>';
  const probes = [{ key: 'AbC-d_e', viewport: 'tablet', property: 'margin-left', warning: 'HTML_PLATFORM_INJECTED', document: 's1', winner: 'w', patch: 'p', expect: '0px' }];
  const answer = (call, params) => {
    const facts = factsFor({ ...params, probes: { ...params.probes, keys: params.probes.keys === 'all' ? 'all' : params.probes.keys } });
    for (const document of facts.documents) for (const view of document.viewports) view.elements = view.elements.map(e => (e.k === 'a1' ? { ...e, k: 'AbC-d_e', styles: { 'margin-left': '16px' } } : e));
    return facts;
  };
  const s = await session(t, { agent: { answer }, pkg: input => packageOf({ html, screens: input.screens, probes }) });
  const { value } = await s.render({ keys: ['@AbC+d/e==', 'b2', 'm1'] });
  assert.equal(value.ok, true, JSON.stringify(value).slice(0, 400));
  assert.deepEqual(s.kernelCalls[0].probes, { keys: ['@AbC+d/e==', 'b2', 'm1'] }, 'the kernel gets the keys as given (it applies SafeKey itself)');
  const call = s.agent.calls.find(c => c.kind === 'screen.render');
  assert.ok(call, 'the agent got the call');
  assert.deepEqual(value.verifier.map(v => [v.verdict, v.key]), [['confirmed', '@AbC-d_e']]);
  assert.equal(value.verifier[0].observed, '16px');
});

test('expectNot: a probe confirms when the platform value it names shows, and is not observed when it does not', async t => {
  const probes = [{ key: 'm1', viewport: 'tablet', property: 'left', warning: 'HTML_PLATFORM_FIXED_LAYOUT', document: 's1', winner: 'OutSystemsUI.css .tablet .app-menu-content', patch: null, expectNot: '-300px' },
    { key: 'b2', viewport: 'tablet', property: 'margin-left', warning: 'HTML_PLATFORM_INJECTED', document: 's1', winner: 'w', patch: 'p', expectNot: '300px' }];
  const answer = (call, params) => {
    const facts = factsFor(params);
    for (const document of facts.documents) for (const view of document.viewports) view.elements = view.elements.map(e =>
      e.k === 'm1' ? { ...e, styles: { left: '-300px' } } : e.k === 'b2' ? { ...e, styles: { 'margin-left': '0px', 'white-space': 'normal' } } : e);
    return facts;
  };
  const s = await session(t, { agent: { answer }, pkg: input => packageOf({ screens: input.screens, probes, css: '.menu{position:fixed;left:-300px}' }) });
  const { value } = await s.render({ properties: ['left'] });
  assert.equal(value.ok, true, JSON.stringify(value).slice(0, 400));
  assert.deepEqual(value.verifier.map(v => [v.verdict, v.key, v.property]), [['confirmed', '@m1', 'left'], ['not-observed', '@b2', 'margin-left']]);
  assert.equal(value.verifier[0].observed, '-300px');
  assert.equal(value.verifier[0].hasPatch, undefined, 'a probe without patch says nothing of one');
});

test('the kernel probe needs keyForm "safe": a kernel of another key form is not served', async () => {
  const { kernelRendersDocuments } = await import('../hosted/screen-render.mjs');
  const old = async () => ({ ok: true, envelope: { ok: true, data: { schema: 'ssam-render-document/1' } } });
  assert.equal(await kernelRendersDocuments('o11', { runAnvil: old, cli: 'probe-no-key-form.dll' }), false);
  const safe = async () => ({ ok: true, envelope: { ok: true, data: { schema: 'ssam-render-document/1', keyForm: 'safe' } } });
  assert.equal(await kernelRendersDocuments('o11', { runAnvil: safe, cli: 'probe-safe.dll' }), true);
});

test('sheets "partial" of the kernel stays partial, with the warning', async t => {
  const s = await session(t, { pkg: input => packageOf({ screens: input.screens, sheets: 'partial' }) });
  const { value } = await s.render();
  assert.equal(value.rendered.platform.sheets, 'partial');
  assert.match(value.warning, /are partial on this server/);
});
