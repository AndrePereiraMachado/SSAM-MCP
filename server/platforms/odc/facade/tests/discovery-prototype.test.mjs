// The prototype import is turned off (prototype-disabled.mjs, owner decision of 2026-10-22): ssam_discover never offers the
// op prototype. A request to import an HTML prototype or a mockup reaches the html op: the text route ui.screen-html (the
// ssam-html/1 document written with ssam_code part html, or the html op in the delivery job), the capability ui.html-page,
// and no tool route with the verb prototype. The index checks need the lane CLI and skip otherwise; the routes, the catalog
// and the descriptors need nothing but this checkout.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { laneSources, discover } from '../discovery.mjs';
import { discoverAll, routeTools, loadToolRoutes } from '../tool-routing.mjs';
import { classifyTextRoute, textRouteSection } from '../text-routes.mjs';
import { composeCatalog } from '../catalog.mjs';
import { rewriteText } from '../responses.mjs';

const facade = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = file => JSON.parse(fs.readFileSync(path.join(facade, file), 'utf8'));
const INTENTS = ['import this HTML prototype into a screen', 'importar o protótipo como telas nativas', 'implementar o protótipo pixel perfect com dados mockados',
  'turn this mockup into a screen', 'converter o mockup em telas'];
const TOOL_INTENTS = [...INTENTS, 'importar protótipo', 'html para telas nativas', 'prototype to screens'];
const lanes = { o11: laneSources('o11'), odc: laneSources('odc') };
const built = { o11: fs.existsSync(lanes.o11.cli), odc: fs.existsSync(lanes.odc.cli) };
const opPrototype = /"op"\s*:\s*"prototype"|op:\\?"prototype/;

test('the text route of every prototype or mockup request is ui.screen-html: the html op written with ssam_code part html', () => {
  for (const intent of INTENTS) {
    assert.equal(classifyTextRoute(intent)?.id, 'ui.screen-html', intent);
    for (const lane of ['o11', 'odc']) {
      const route = textRouteSection(intent, lane);
      assert.equal(route.id, 'ui.screen-html', `${lane}: ${intent}`);
      assert.equal(route.call.arguments.job.ops[0].op, 'html', `${lane}: the delivery call writes the html op`);
      assert.deepEqual(route.code.read.arguments, { lane, action: 'grammar', part: 'html' });
      assert.equal(route.code.write.arguments.part, 'html');
      assert.doesNotMatch(JSON.stringify(route), opPrototype, `${lane}: ${intent}`);
    }
  }
  // "import" creates only a prototype's screens: an import of data rows stays outside the texts.
  assert.equal(classifyTextRoute('importar dados de um CSV para a entidade Cliente'), null);
});

test('no tool route offers the verb prototype: tools.json has none, and every prototype intent routes elsewhere', () => {
  const compiled = loadToolRoutes();
  assert.deepEqual(compiled.problems, []);
  const tools = readJson('catalog/tools.json').tools;
  for (const [name, tool] of Object.entries(tools)) assert.ok(!Object.hasOwn(tool.verbs ?? {}, 'prototype'), name);
  assert.doesNotMatch(fs.readFileSync(path.join(facade, 'catalog', 'tools.json'), 'utf8'), opPrototype);
  for (const lane of ['o11', 'odc']) for (const intent of TOOL_INTENTS) {
    const routed = routeTools({ intent, lane }, compiled).tools ?? [];
    assert.ok(routed.every(r => r.verb !== 'prototype'), `${lane}: ${intent}`);
    assert.doesNotMatch(JSON.stringify(routed), opPrototype, `${lane}: ${intent}`);
  }
});

test('the catalog and the lane descriptors carry no prototype route; the html page capability answers the prototype words', () => {
  const composed = composeCatalog({ shared: readJson('discovery-capabilities-shared.json') }).shared;
  assert.ok(!composed.capabilities.some(c => c.id === 'ui.prototype-import'));
  assert.ok(!composed.capabilities.some(c => c.route?.kind === 'prototype' || opPrototype.test(JSON.stringify(c.route ?? {}))));
  const page = composed.capabilities.find(c => c.id === 'ui.html-page');
  assert.ok(page.keywords.includes('prototype') && /"op":"html"/.test(page.route.operation));
  for (const file of ['discovery-capabilities.json', 'discovery-capabilities-o11.json']) {
    const descriptor = readJson(file);
    assert.ok(!Object.hasOwn(descriptor.routes, 'prototype'), file);
    assert.doesNotMatch(JSON.stringify(descriptor), opPrototype, file);
  }
});

test('a CLI line of the former rehearsal (ssam prototype) becomes the first call of the html op path, never a prototype call', () => {
  const out = []; rewriteText('run .\\ssam prototype C:\\p\\farma --lane odc --module Haiku --dry first', {}, out);
  assert.equal(out[0].tool, 'ssam_code');
  assert.deepEqual(out[0].arguments, { lane: 'odc', action: 'grammar', part: 'html' });
});

for (const lane of ['o11', 'odc']) {
  test(`${lane}: ssam_discover answers a prototype request with the html op, never the op prototype`, { skip: !built[lane] && `${lane} lane CLI not built`, timeout: 600000 }, async () => {
    for (const intent of INTENTS) {
      const answer = await discover({ lane, intent, sources: lanes[lane] });
      assert.equal(answer.ok, true, JSON.stringify(answer).slice(0, 300));
      assert.ok(!(answer.matches ?? []).some(m => m.id === 'ui.prototype-import'), `${lane} ${intent}`);
      assert.ok(!answer.routes?.prototype, `${lane} ${intent}: no prototype route`);
      assert.equal(answer.textRoute?.id, 'ui.screen-html', `${lane} ${intent}`);
      assert.doesNotMatch(JSON.stringify(answer), opPrototype, `${lane} ${intent}`);
    }
    const all = await discoverAll({ lane, intent: INTENTS[0] });
    assert.ok((all.tools ?? []).every(t => t.verb !== 'prototype'));
    assert.doesNotMatch(JSON.stringify(all), opPrototype);
  });
}
