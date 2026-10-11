// hosted/tools.json (docs/FASE2-AGENTE.md section 5 and 6.4) against the live registry of the ssam MCP server: every
// tool is classified and nothing stale, classes and agent rules are valid, every path pointer exists in the tool's
// schema under the 6.4 grammar, and the totals are those of section 5. In-process server, listTools only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createSsamServer } from '../ssam.mjs';
import { hostedTools } from '../hosted/policy.mjs';
import { frictionTool } from '../../../../facade/friction-boundary.mjs';
import { APP_SESSION_TOOLS } from '../o11-app-session.mjs';

// The four hook tools of the controlled app profile (context, propose, continue, status) are listed by the ssam server only
// with SSAM_APP_HOOK_TOOLS=1 (16th release, I10); hosted they stay classified unavailable, so the list is taken with them.
process.env.SSAM_APP_HOOK_TOOLS = '1';

const tools = hostedTools();
let live = null;
async function liveTools() {
  if (live) return live;
  const server = await createSsamServer();
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'hosted-tools-test', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  // ssam_friction is added by the served mode (and the stdio launch boundary), not by createSsamServer.
  try { live = new Map([...(await client.listTools()).tools, frictionTool].map(t => [t.name, t])); return live; }
  finally { await client.close(); await server.close(); }
}

// 6.4 grammar: JSON Pointer segments; a named segment must be in `properties` (of any anyOf/oneOf alternative) or the
// parent must be a record (additionalProperties); '*' needs `items` or `additionalProperties` in the parent. A value of
// any shape (an empty schema, e.g. the z.unknown() values of ssam_reference's query record) takes any segment below it:
// check-job {basedOn: {job}} (servidor/fase4-23).
const alternatives = node => !node || typeof node !== 'object' ? [] : [node, ...[...(node.anyOf ?? []), ...(node.oneOf ?? [])].flatMap(alternatives)];
const anyValue = node => Object.keys(node).every(key => ['description', 'title', '$schema'].includes(key));
function pointerExists(schema, pointer) {
  let nodes = [schema];
  for (const segment of pointer.split('/').slice(1)) {
    const next = [];
    for (const node of nodes.flatMap(alternatives)) {
      if (node !== schema && anyValue(node)) { next.push(node); continue; }
      const record = node.additionalProperties && typeof node.additionalProperties === 'object' ? node.additionalProperties : node.additionalProperties === true ? {} : null;
      if (segment === '*') { if (node.items) next.push(node.items); if (record) next.push(record); }
      else if (node.properties?.[segment]) next.push(node.properties[segment]);
      else if (record) next.push(record);
    }
    if (!next.length) return false;
    nodes = next;
  }
  return true;
}
const enumOf = (schema, name) => alternatives(schema?.properties?.[name]).flatMap(a => a.enum ?? []);

test('every tool registered by createSsamServer() plus ssam_friction is classified, and every classified tool is live', async () => {
  const names = await liveTools();
  assert.equal(names.size, 83, 'the 78 tools of createSsamServer of the atritos 3 package (ssam_query_test is new), the 4 hook tools (SSAM_APP_HOOK_TOOLS=1) and ssam_friction');
  assert.deepEqual([...names.keys()].filter(n => !tools[n]), [], 'live tools without a hosted class');
  assert.deepEqual(Object.keys(tools).filter(n => !names.has(n)), [], 'stale hosted classes');
});

test('classes, lanes and agent rules are valid; unavailable tools take no path and need nothing', async () => {
  const names = await liveTools();
  const classes = new Set(['server', 'agent', 'tenant-agent', 'unavailable']);
  for (const [name, entry] of Object.entries(tools)) {
    const schema = names.get(name).inputSchema;
    assert.ok(classes.has(entry.class), name + ': class');
    // arg:none (ssam_connect): with lane the laned checks of that lane, without it only the agent checks.
    assert.ok(['o11', 'odc', 'none'].includes(entry.lane) || /^arg:(o11|odc|none)$/.test(entry.lane), name + ': lane ' + entry.lane);
    if (entry.lane.startsWith('arg:')) assert.ok(schema.properties?.lane, name + ': a lane argument exists');
    assert.equal(typeof entry.reason, 'string', name + ': reason');
    assert.ok(entry.reason.length > 5, name + ': reason');
    assert.ok(Array.isArray(entry.paths?.in) && Array.isArray(entry.paths?.out), name + ': paths {in, out}');
    const rule = entry.agent;
    if (typeof rule === 'string') assert.ok(['always', 'never', 'report'].includes(rule), name + ': agent ' + rule);
    else {
      assert.ok(['module-target', 'present', 'non-empty', 'in', 'not-in', 'absent-all'].includes(rule.when), name + ': when ' + rule.when);
      const args = rule.when === 'absent-all' ? rule.args : [rule.arg];
      for (const arg of args) assert.ok(schema.properties?.[arg], `${name}: rule argument ${arg} exists`);
      if (['in', 'not-in'].includes(rule.when)) {
        assert.ok(Array.isArray(rule.values) && rule.values.length, name + ': values');
        const values = enumOf(schema, rule.arg);
        if (values.length) for (const v of rule.values) assert.ok(values.includes(v), `${name}: ${rule.arg}=${v} is in the schema enum`);
      }
    }
    if (entry.class === 'server') assert.notEqual(rule, 'always', name + ': a server tool never always needs the agent');
    if (entry.class === 'agent' || entry.class === 'tenant-agent') assert.ok(rule !== 'never', name + ': an agent tool needs the agent somehow');
    if (entry.class === 'unavailable') assert.deepEqual([entry.lane, entry.agent, entry.paths], ['none', 'never', { in: [], out: [] }], name);
  }
  assert.deepEqual(tools.o11_service_center_read.agent, { when: 'not-in', arg: 'action', values: ['capabilities', 'receipt'] }, 'the line-57 rule');
});

test('every in/out pointer exists in the tool schema under the 6.4 grammar', async () => {
  const names = await liveTools();
  const missing = [];
  for (const [name, entry] of Object.entries(tools))
    for (const pointer of [...entry.paths.in, ...entry.paths.out]) if (!pointerExists(names.get(name).inputSchema, pointer)) missing.push(name + ' ' + pointer);
  assert.deepEqual(missing, []);
  for (const name of ['o11_deliver', 'o11_job', 'ssam_job', 'studio_deliver']) assert.ok(tools[name].paths.in.includes('/basedOn/job'), name + ' confines /basedOn/job');
  // servidor/fase4-23: check-job over basedOn (patch by name, partial job) and the list target of ssam_map search/uses.
  assert.deepEqual(tools.ssam_reference.paths.in, ['/query', '/query/basedOn/job', '/query/job'], 'ssam_reference confines the job files of check-job');
  assert.deepEqual(tools.ssam_map.paths.in, ['/target', '/target/*'], 'ssam_map confines each target of a list');
  assert.equal(pointerExists(names.get('ssam_map').inputSchema, '/target/*'), true, 'a list target');
  assert.equal(pointerExists(names.get('studio_open').inputSchema, '/module/x'), false, 'a string takes no segment');
  assert.equal(pointerExists(names.get('o11_studio').inputSchema, '/args/path'), true, 'a record parent');
  assert.equal(pointerExists(names.get('studio_command').inputSchema, '/args/*'), true, 'items');
  assert.equal(pointerExists(names.get('studio_open').inputSchema, '/nope'), false);
});

test('the totals of section 5: 22 server (10 with a mode that uses the agent), 32 agent, 19 tenant-agent, 10 unavailable', () => {
  const count = klass => Object.values(tools).filter(t => t.class === klass).length;
  assert.deepEqual({ server: count('server'), agent: count('agent'), tenant: count('tenant-agent'), unavailable: count('unavailable') },
    { server: 22, agent: 32, tenant: 19, unavailable: 10 });
  assert.equal(Object.values(tools).filter(t => t.class === 'server' && typeof t.agent === 'object').length, 10);
  assert.deepEqual(Object.entries(tools).filter(([, t]) => t.agent === 'report').map(([n]) => n).sort(), ['hybrid_tenants', 'odc_auth_status', 'ssam_doctor', 'studio_doctor']);
});

// The ninth release (docs/FASE2-AGENTE.md 5, O11-BRIDGE-FINA.md 14): ssam_grant is a server tool of this customer only
// (no lane, no agent, no path), ssam_task needs the agent only to close, ssam_connect without lane is laned only when the
// lane is named, and publish:true adds no path to the deliveries.
test('the ninth release tools: ssam_grant, ssam_task close, ssam_connect without lane, publish:true and o11_data batch', async () => {
  const names = await liveTools();
  assert.deepEqual({ class: tools.ssam_grant.class, lane: tools.ssam_grant.lane, agent: tools.ssam_grant.agent, paths: tools.ssam_grant.paths },
    { class: 'server', lane: 'none', agent: 'never', paths: { in: [], out: [] } });
  assert.deepEqual(tools.ssam_task.agent, { when: 'present', arg: 'close' });
  assert.ok(names.get('ssam_task').inputSchema.properties.close, 'ssam_task has close');
  assert.equal(tools.ssam_connect.lane, 'arg:none');
  for (const name of ['o11_deliver', 'studio_deliver']) {
    assert.ok(names.get(name).inputSchema.properties.publish, name + ' has publish');
    assert.equal(tools[name].class, 'agent'); assert.equal(tools[name].agent, 'always');
    assert.ok(!tools[name].paths.in.includes('/publish') && !tools[name].paths.out.includes('/publish'), name + ': publish is no path');
  }
  assert.deepEqual(tools.o11_data.paths, { in: ['/oml'], out: [] }, 'a batch adds no path: $ref names records');
});
// The 16th release (product 78 tools: 77 of createSsamServer plus ssam_friction): ssam_preview, o11_extension and
// odc_external_library are unavailable hosted (local preview processes, builds of customer code on the server machine),
// and the four hook tools stay unavailable whether the server lists them or not. The gate answers HOSTED_UNAVAILABLE
// with the reason and a continuation, never a silent absence.
test('the 16th release tools: preview, .NET extension and External Library answer HOSTED_UNAVAILABLE', async () => {
  const { wrapHostedTool } = await import('../hosted/policy.mjs');
  const names = await liveTools();
  for (const name of ['ssam_preview', 'o11_extension', 'odc_external_library', ...APP_SESSION_TOOLS]) {
    assert.ok(names.has(name), name + ' is a live tool');
    assert.equal(tools[name].class, 'unavailable', name);
    let ran = false;
    const gated = wrapHostedTool(name, { inputSchema: {} }, async () => { ran = true; return { content: [] }; },
      { context: { workspace: 'C:\\ws', lanes: ['odc', 'o11'], agent: { info: () => ({}), connected: () => true } } });
    const answer = await gated({}, {});
    assert.equal(ran, false, name + ': the handler never runs');
    assert.equal(answer.isError, true);
    assert.equal(answer.structuredContent.code, 'HOSTED_UNAVAILABLE');
    assert.ok(answer.structuredContent.error.includes(tools[name].reason), name + ': the reason is in the answer');
    assert.equal(answer.structuredContent.continuation.tool, 'ssam_discover');
  }
});

// The Linux server image (docker/ssam-server) carries no Integration Studio: the XIF engine is net472 x86 and Windows only.
// A .NET extension asked of the hosted server is refused before anything runs, with the cause as a stable code and a
// continuation that leads to referencing an extension published from the user's Windows machine, never back to
// o11_extension itself (a discover of the tool's own title would offer it again).
test('o11_extension hosted: cause XIF_ENGINE_WINDOWS_ONLY and a continuation to reference the extension', async () => {
  const { wrapHostedTool } = await import('../hosted/policy.mjs');
  const names = await liveTools();
  let ran = false;
  const gated = wrapHostedTool('o11_extension', { title: names.get('o11_extension').title, inputSchema: {} }, async () => { ran = true; return { content: [] }; },
    { context: { workspace: '/data/server/ws/acme', lanes: ['odc', 'o11'], agent: { info: () => ({}), connected: () => true } } });
  const answer = await gated({ action: 'publish', host: 'acme.outsystemscloud.com', spec: { name: 'Lib', actions: [] } }, {});
  assert.equal(ran, false, 'the engine is never reached');
  const value = answer.structuredContent;
  assert.equal(answer.isError, true);
  assert.equal(value.code, 'HOSTED_UNAVAILABLE');
  assert.equal(value.cause, 'XIF_ENGINE_WINDOWS_ONLY');
  assert.match(value.error, /Windows only/);
  assert.match(value.error, /your own Windows machine/);
  assert.deepEqual(value.continuation.arguments, { intent: 'reference an existing .NET extension (XIF) from an O11 module', lane: 'o11' });
  assert.equal(value.continuation.tool, 'ssam_discover');
  assert.ok(!JSON.stringify(value.continuation).includes('o11_extension'), 'the continuation does not lead back to o11_extension');
  // the other unavailable tools keep the generic continuation and no cause
  const preview = await wrapHostedTool('ssam_preview', { title: 'preview', inputSchema: {} }, async () => ({ content: [] }),
    { context: { workspace: '/ws', lanes: ['odc'], agent: { info: () => ({}), connected: () => true } } })({}, {});
  assert.equal(preview.structuredContent.cause, undefined);
  assert.deepEqual(preview.structuredContent.continuation.arguments, { intent: 'preview' });
});
// The atritos 3 package (fase4): ssam_query_test runs the ODC Studio's own TestQuery through the agent, its capture sent by
// sha256 (/source is an input path); the O11 lane answers HOSTED_UNAVAILABLE before anything is sent (the thin bridge
// has no query test).
test('ssam_query_test hosted: an agent tool of the ODC lane with /source as input; O11 refused before the agent', async () => {
  const names = await liveTools();
  assert.deepEqual({ class: tools.ssam_query_test.class, lane: tools.ssam_query_test.lane, agent: tools.ssam_query_test.agent, paths: tools.ssam_query_test.paths },
    { class: 'agent', lane: 'arg:odc', agent: 'always', paths: { in: ['/source'], out: [] } });
  assert.ok(names.get('ssam_query_test').inputSchema.properties.source);
  const { queryTest } = await import('../query-test.mjs');
  const { runWithExecutor } = await import('../executor.mjs');
  let sent = false;
  const context = { hosted: true, workspace: 'C:\\ws', executor: { call: async () => { sent = true; return {}; } } };
  const value = await runWithExecutor(context, () => queryTest({ op: 'describe', lane: 'o11', source: 'C:\\ws\\o11\\snapshots\\A.oml', expectedSourceSha256: 'a'.repeat(64),
    moduleKey: 'k', environment: 'h.example', query: '@q' }, { o11: async () => { sent = true; return { ok: true }; } }));
  assert.equal(value.ok, false); assert.equal(value.code, 'HOSTED_UNAVAILABLE'); assert.equal(value.execution, 'not-sent');
  assert.equal(sent, false);
});