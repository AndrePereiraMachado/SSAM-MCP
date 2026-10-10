// A15 (package of 2026-10-06, lane F7a): the central input layer. The friction report's real refusals are reproduced
// synthetically: "data/budgetBytes must be >= 4096" (ssam_discover budgetBytes 4000, x17), "select: Too big: expected array
// to have <=32 items" (inspect select of 40), "close.reason: Too big: expected string to have <=500 characters" (ssam_task
// close with a long reason). Each becomes an adjustment reported in inputAdjusted; what cannot be adjusted answers
// INPUT_INVALID with every violation and the corrected arguments, without running the tool. In-process McpServer, no Studio.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { McpServer, InMemoryTransport, fromJsonSchema } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { relaxTool, normalizeArguments, INPUT_INVALID, NEVER_ADJUSTED, WORDS_MARKER, AS_SENT } from '../tool-input.mjs';

const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');
const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });

async function serve(register) {
  const server = new McpServer({ name: 'pa2-f7a-input', version: '1.0.0' });
  const calls = [];
  register(server, calls);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'pa2-f7a-input-client', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, calls, close: async () => { await client.close(); await server.close(); } };
}
const relaxed = (server, name, config, handler) => { const r = relaxTool(name, config, handler); server.registerTool(name, r.config, r.handler); };

const zodTool = calls => ['probe_zod', {
  description: 'zod probe',
  inputSchema: z.object({
    budgetBytes: z.number().int().min(4096).max(1048576).default(40960),
    select: z.array(z.string().min(1)).min(1).max(32).optional(),
    lane: z.enum(['o11', 'odc']).default('odc'),
    close: z.object({ reason: z.string().min(1).max(500) }).strict().optional(),
    authorize: z.string().min(8).max(500).optional(),
    job: z.string().max(100).optional(),
    pid: z.number().int().positive().optional(),
  }).strict(),
}, async args => {
  calls.push(args);
  return reply({ ok: true, budgetBytes: args.budgetBytes, lane: args.lane, entries: (args.select ?? []).map(s => ({ selector: s })), requested: args.select?.length ?? 0, complete: true,
    ...(args.close ? { reasonLength: args.close.reason.length } : {}) });
}];

test('budgetBytes below the minimum is moved to the edge and reported; the tool runs once with its own defaults', async t => {
  const { client, calls, close } = await serve((server, calls) => relaxed(server, ...zodTool(calls))); t.after(close);
  const r = await client.callTool({ name: 'probe_zod', arguments: { budgetBytes: 1000 } });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { budgetBytes: 4096, lane: 'odc' }, 'the zod defaults still apply');
  assert.deepEqual(r.structuredContent.inputAdjusted, [{ path: '/budgetBytes', from: 1000, to: 4096, rule: 'clamp' }]);
  assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent, 'the text carries the same adjustment');
  // the listing keeps the limits as guidance for the model
  const listed = (await client.listTools()).tools.find(x => x.name === 'probe_zod').inputSchema;
  assert.equal(listed.properties.budgetBytes.minimum, 4096); assert.equal(listed.properties.select.maxItems, 32); assert.equal(listed.additionalProperties, false);
});

test('a select of 40 runs as internal batches of 32 + 8 and answers once, merged', async t => {
  const { client, calls, close } = await serve((server, calls) => relaxed(server, ...zodTool(calls))); t.after(close);
  const select = Array.from({ length: 40 }, (_, i) => '@k' + i);
  const r = await client.callTool({ name: 'probe_zod', arguments: { select, budgetBytes: 50000 } });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  assert.deepEqual(calls.map(c => c.select.length), [32, 8]);
  assert.deepEqual(r.structuredContent.entries.map(e => e.selector), select, 'every entry, in order');
  assert.equal(r.structuredContent.requested, 40); assert.equal(r.structuredContent.complete, true); assert.equal(r.structuredContent.ok, true);
  assert.deepEqual(r.structuredContent.inputAdjusted, [{ path: '/select', from: 40, to: 32, rule: 'batch', batches: 2 }]);
});

test('a reason of 800 characters is cut to the limit and the answer keeps the sha256 of the whole text', async t => {
  const { client, calls, close } = await serve((server, calls) => relaxed(server, ...zodTool(calls))); t.after(close);
  const reason = 'Não repetir nem desfazer a mesclagem. '.repeat(25).slice(0, 800);
  assert.equal(reason.length, 800);
  const r = await client.callTool({ name: 'probe_zod', arguments: { close: { reason } } });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  assert.equal(calls[0].close.reason, reason.slice(0, 500));
  assert.deepEqual(r.structuredContent.inputAdjusted, [{ path: '/close/reason', from: { length: 800, sha256: sha(reason) }, to: { length: 500 }, rule: 'truncate' }]);
});

test('authorize (the user\'s words) and the payloads are never adjusted: INPUT_INVALID, the tool never runs, the words never echo', async t => {
  const { client, calls, close } = await serve((server, calls) => relaxed(server, ...zodTool(calls))); t.after(close);
  assert.deepEqual(NEVER_ADJUSTED, ['authorize', 'words', 'text', 'job', 'patch', 'basedOn', 'html', 'request', 'records']);
  const words = 'sim, pode entregar o módulo Pedidos agora mesmo. '.repeat(20);
  const r = await client.callTool({ name: 'probe_zod', arguments: { authorize: words, job: 'x'.repeat(150), budgetBytes: 1000 } });
  assert.equal(r.isError, true);
  assert.equal(calls.length, 0, 'nothing ran');
  const v = r.structuredContent;
  assert.equal(v.code, INPUT_INVALID); assert.equal(v.ok, false);
  assert.deepEqual(v.violations.map(x => x.path).sort(), ['/authorize', '/job']);
  assert.match(v.violations.find(x => x.path === '/authorize').message, /at most 500/);
  assert.equal(v.corrected.authorize, WORDS_MARKER, 'the words never come back');
  assert.equal(v.corrected.budgetBytes, 4096, 'what could be adjusted is already adjusted in corrected');
  assert.doesNotMatch(JSON.stringify(v), /pode entregar/);
  assert.equal(v.continuation, undefined, 'no fix for a limit on the words: no continuation invented');
});

test('the rest answers INPUT_INVALID with every violation and the corrected arguments as the continuation', async t => {
  const { client, calls, close } = await serve((server, calls) => relaxed(server, ...zodTool(calls))); t.after(close);
  const r = await client.callTool({ name: 'probe_zod', arguments: { lanes: 'ODC', budgetBytes: '8192', pid: 0 } });
  assert.equal(r.isError, true); assert.equal(calls.length, 0);
  const v = r.structuredContent;
  assert.equal(v.code, 'INPUT_INVALID');
  const byPath = Object.fromEntries(v.violations.map(x => [x.path, x]));
  assert.match(byPath['/lanes'].message, /not a field here; closest: lane/); assert.match(byPath['/lanes'].accepted, /fields: budgetBytes, select, lane/);
  assert.match(byPath['/budgetBytes'].message, /expected integer, received string/); assert.match(byPath['/budgetBytes'].accepted, /integer 4096\.\.1048576/);
  assert.match(byPath['/pid'].message, /out of range/, 'a pid is never moved to an edge');
  assert.deepEqual(v.corrected, { lane: 'ODC', budgetBytes: 8192, pid: 0 }, 'unknown field renamed to the closest, the number parsed');
  assert.equal(v.continuation, undefined, 'the pid has no fix: no continuation');
  // every problem fixable: the continuation is the same tool with the corrected arguments
  const fixable = await client.callTool({ name: 'probe_zod', arguments: { lanes: 'odc', budgetBytes: '8192' } });
  assert.deepEqual(fixable.structuredContent.continuation, { tool: 'probe_zod', arguments: { lane: 'odc', budgetBytes: 8192 }, why: fixable.structuredContent.continuation.why });
  const again = await client.callTool({ name: fixable.structuredContent.continuation.tool, arguments: fixable.structuredContent.continuation.arguments });
  assert.equal(again.isError, undefined); assert.equal(calls.length, 1);
  // an enum value in another case
  const lane = await client.callTool({ name: 'probe_zod', arguments: { lane: 'ODC' } });
  assert.equal(lane.structuredContent.corrected.lane, 'odc');
});

test('fromJsonSchema (the ODC proxies of ssam.mjs): the same clamp, and the tool\'s schema still decides what the layer does not model', async t => {
  const { client, calls, close } = await serve((server, calls) => {
    relaxed(server, 'probe_json', { description: 'json probe', inputSchema: fromJsonSchema({ type: 'object', additionalProperties: false, required: ['target'],
      properties: { target: { type: 'string', minLength: 1 }, budgetBytes: { type: 'integer', minimum: 4096, maximum: 1048576 }, sha: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        mode: { type: 'string', format: 'date-time' } } }) },
    async args => { calls.push(args); return reply({ ok: true, args }); });
  }); t.after(close);
  const r = await client.callTool({ name: 'probe_json', arguments: { target: 'Orders', budgetBytes: 4000 } });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  assert.deepEqual(calls[0], { target: 'Orders', budgetBytes: 4096 });
  assert.deepEqual(r.structuredContent.inputAdjusted, [{ path: '/budgetBytes', from: 4000, to: 4096, rule: 'clamp' }]);
  const missing = await client.callTool({ name: 'probe_json', arguments: { sha: 'XYZ' } });
  assert.equal(missing.structuredContent.code, 'INPUT_INVALID');
  assert.deepEqual(missing.structuredContent.violations.map(x => x.path).sort(), ['/sha', '/target']);
  assert.equal(missing.structuredContent.corrected.target, '<target>');
  // a rule the layer does not model (format): the tool's own validator refuses, still as INPUT_INVALID, and nothing runs
  const format = await client.callTool({ name: 'probe_json', arguments: { target: 'Orders', mode: 'yesterday' } });
  assert.equal(format.structuredContent.code, 'INPUT_INVALID'); assert.equal(calls.length, 1);
});

test('a schema it cannot read is returned unchanged; elicitation answers pass untouched', async () => {
  const handler = async () => reply({ ok: true });
  const config = { description: 'no schema' };
  const same = relaxTool('probe_none', config, handler);
  assert.equal(same.config, config); assert.equal(same.handler, handler);
  const odd = { description: 'odd', inputSchema: { not: 'a schema' } };
  assert.equal(relaxTool('probe_odd', odd, handler).config, odd);
  const input = { resultType: 'input_required', inputRequests: {} };
  const r = relaxTool('probe_elicit', { inputSchema: z.object({ max: z.number().int().max(5).optional() }).strict() }, async () => input);
  assert.equal(await r.handler({ max: 9 }, {}), input, 'an input_required answer is never rewritten');
});

test('normalizeArguments is pure and reports each adjustment and violation once', () => {
  const schema = { type: 'object', additionalProperties: false, properties: { max: { type: 'integer', minimum: 1, maximum: 500 }, depth: { type: 'integer', maximum: 12 },
    text: { type: 'string', maxLength: 4 }, records: { type: 'array', maxItems: 2 }, query: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'object' }] } } };
  const args = Object.freeze({ max: 9000, depth: 40, text: 'abcdef', records: [1, 2, 3], query: { find: 'x' } });
  const n = normalizeArguments(schema, args);
  assert.deepEqual(n.adjusted, [{ path: '/max', from: 9000, to: 500, rule: 'clamp' }, { path: '/depth', from: 40, to: 12, rule: 'clamp' }]);
  assert.deepEqual(n.violations.map(v => v.path), ['/text', '/records'], 'text and records are never adjusted');
  assert.deepEqual(args, { max: 9000, depth: 40, text: 'abcdef', records: [1, 2, 3], query: { find: 'x' } }, 'the input is not mutated');
  assert.equal(AS_SENT, '<como enviado>');
  const ok = normalizeArguments(schema, { query: '' });
  assert.equal(ok.violations.length, 1); assert.match(ok.violations[0].message, /none of the accepted forms/);
});
