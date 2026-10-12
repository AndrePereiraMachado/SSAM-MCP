// The discover route of the prototype importer (docs/PROTOTIPO-NATIVO.md 7.6 test 7): the intents of the owner's request
// (pt and en) reach ui.prototype-import with the ready one-call example of each lane in the first answer (routes.prototype
// entries[0]: call, rehearsal, slots, rules) and the delivery tool's own route (tools: o11_deliver / studio_deliver, verb prototype); the ODC
// example passes the live studio_deliver schema of the ssam server (feature, owners, changes; no until apply). The index
// checks need the lane CLI and skip otherwise; the routes and the schema need nothing but this checkout.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import Ajv from 'ajv';
import { laneSources, discover } from '../discovery.mjs';
import { discoverAll, routeTools, loadToolRoutes } from '../tool-routing.mjs';
import { createSsamServer } from '../ssam.mjs';
import { prototypeCall, PROTOTYPE_DELIVER_TEXT } from '../prototype-op.mjs';
import { rewriteText } from '../responses.mjs';

process.env.SSAM_APP_HOOK_TOOLS = '1';
const INTENTS = ['implementar o protótipo C:\\protos\\farmavirtual pixel perfect com dados mockados', 'importar protótipo', 'html para telas', 'prototype to screens'];
const TOOL_INTENTS = ['implementar o protótipo pixel perfect', 'importar protótipo', 'html para telas nativas', 'prototype to screens'];
const lanes = { o11: laneSources('o11'), odc: laneSources('odc') };
const built = { o11: fs.existsSync(lanes.o11.cli), odc: fs.existsSync(lanes.odc.cli) };
const ROUTE_TOOL = { o11: 'o11_deliver', odc: 'studio_deliver' };

test('tools: every prototype intent routes to the delivery tool of the lane with the op prototype in its arguments', () => {
  const compiled = loadToolRoutes();
  assert.deepEqual(compiled.problems, []);
  for (const lane of ['o11', 'odc']) for (const intent of TOOL_INTENTS) {
    const first = routeTools({ intent, lane }, compiled).tools[0];
    assert.equal(first?.tool, ROUTE_TOOL[lane], `${lane}: ${intent}`); assert.equal(first.verb, 'prototype');
    assert.equal(first.args.job.ops[0].op, 'prototype'); assert.equal(first.args.publish, true); assert.match(first.args.authorize, /^<.+>$/);
    if (lane === 'odc') { assert.ok(first.args.feature && first.args.owners?.length && first.args.changes?.length); assert.equal(first.args.until, undefined); }
  }
  // A CLI line of the rehearsal never sends the model to a shell: it becomes the one MCP call.
  const out = []; rewriteText('run .\\ssam prototype C:\\p\\farma --lane odc --module Haiku --dry first', {}, out);
  assert.equal(out[0].tool, 'studio_deliver'); assert.equal(out[0].arguments.job.ops[0].data.source, 'C:\\p\\farma');
});

async function liveTools() {
  const server = await createSsamServer();
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'discovery-prototype-test', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try { return (await client.listTools()).tools; } finally { await client.close(); await server.close(); }
}

test('the ready calls pass the live schemas of the ssam server: studio_deliver with feature, owners and changes (no until apply), o11_deliver', async () => {
  const tools = new Map((await liveTools()).map(t => [t.name, t]));
  const ajv = new Ajv({ strict: false, allErrors: true });
  for (const lane of ['odc', 'o11']) {
    const tool = tools.get(ROUTE_TOOL[lane]);
    assert.ok(tool.description.includes(PROTOTYPE_DELIVER_TEXT), `${tool.name} documents the op`);
    const { $schema: _s, ...schema } = tool.inputSchema;
    const validate = ajv.compile(schema);
    for (const call of [prototypeCall({ lane, source: 'C:\\protos\\farmavirtual', module: 'Haiku_UI', prefix: 'FarmaVirtual' }), prototypeCall({ lane, rehearsal: true })]) {
      assert.equal(call.tool, tool.name);
      assert.ok(validate(call.arguments), `${tool.name}: ${JSON.stringify(validate.errors)}`);
    }
    if (lane === 'odc') {
      const call = prototypeCall({ lane });
      for (const key of ['feature', 'owners', 'changes']) assert.ok(call.arguments[key], key);
      assert.ok(!['apply'].includes(call.arguments.until)); assert.ok(!(tool.inputSchema.properties.until?.enum ?? []).includes('apply'), 'ODC has no until apply');
      assert.ok(!(tool.inputSchema.required ?? []).includes('feature'), 'feature may be left out: the proxy fills it from the prototype');
    }
  }
});

for (const lane of ['o11', 'odc']) {
  test(`${lane}: the discover intents reach ui.prototype-import with routes.prototype (call, slots, rules) and the tool route, in the first answer`, { skip: !built[lane] && `${lane} lane CLI not built`, timeout: 600000 }, async () => {
    for (const intent of INTENTS) {
      const answer = await discover({ lane, intent, sources: lanes[lane] });
      assert.equal(answer.ok, true, JSON.stringify(answer).slice(0, 300));
      const match = (answer.matches ?? []).find(m => m.id === 'ui.prototype-import');
      assert.ok(match && match.via === 'match', `${lane} ${intent}: ${(answer.matches ?? []).map(m => m.id + ':' + m.via).join(', ')}`);
      // The ready call of both lanes rides on the match's own route operation (kept down to the minimal answer); the lane's
      // route adds the rehearsal, the slots and the rules in its entries (the part of routes the budget keeps longest).
      const calls = Object.fromEntries(match.route.operation.split(' ;; ').map(part => { const [, lane_, tool, json] = /^(O11|ODC) => (\w+) (\{.*\})$/.exec(part); return [lane_.toLowerCase(), { tool, arguments: JSON.parse(json) }]; }));
      for (const l of ['o11', 'odc']) { assert.equal(calls[l].tool, ROUTE_TOOL[l]); assert.equal(calls[l].arguments.job.ops[0].op, 'prototype'); }
      assert.deepEqual(calls.odc.arguments.owners, ['<Prefixo>']); assert.equal(calls.odc.arguments.until, undefined);
      assert.ok(calls.odc.arguments.feature && calls.odc.arguments.changes.length);
      assert.ok(answer.routes?.prototype, `${lane} ${intent}: routes.prototype`);
      const route = answer.routes.prototype.entries[0];
      assert.deepEqual(route.call, calls[lane]);
      assert.equal(route.call.tool, ROUTE_TOOL[lane]); assert.equal(route.call.arguments.job.ops[0].op, 'prototype');
      assert.ok(route.slots.source && route.slots.module);
      assert.ok(route.rules.some(r => /Do not read the prototype/.test(r)) && route.rules.some(r => /words in authorize cover the import, the publication and the demo data/.test(r)));
      assert.ok(route.rules.some(r => /mapping only when a refusal asks/.test(r)));
      if (lane === 'odc') { assert.deepEqual(route.call.arguments.owners, ['<Prefixo>']); assert.equal(route.rehearsal.arguments.until, 'preview'); }
      else assert.equal(route.rehearsal.arguments.until, 'apply');
    }
    // The single entry (ssam_discover): the tool of the lane first, with the ready arguments, beside the capability.
    const all = await discoverAll({ lane, intent: INTENTS[0] });
    assert.equal(all.tools?.[0]?.tool, ROUTE_TOOL[lane], JSON.stringify(all.tools ?? null).slice(0, 300));
    assert.equal(all.tools[0].verb, 'prototype');
    assert.ok((all.matches ?? []).some(m => m.id === 'ui.prototype-import'));
  });
}
