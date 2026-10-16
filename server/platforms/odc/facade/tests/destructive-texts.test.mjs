import './fixtures/isolated-profile.mjs';
// CX15 W7: the texts the model reads. Every tool of the destructive inventory says that the call without
// confirmationToken only shows the list, that the owner sees the exact list and confirms it, that the execution takes the
// token and the owner's reply, and to read ssam_task after an interruption; no text says "one call", "never prepare first"
// or "in one call" about deleting (descriptions, guides, the catalog entries of those tools, the delete section of the docs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { registerO11Operations } from '../o11-operations.mjs';
import { registerO11Environment } from '../o11-environment.mjs';
import { registerO11Extension } from '../o11-extension.mjs';
import { registerAccessTools } from '../odc-access.mjs';
import { registerExternalLibrary } from '../odc-external-library.mjs';
import { registerSsamTask } from '../ssam-task.mjs';
import { createFacadeServer } from '../mcp.mjs';
import { o11DataRequestSchema } from '../ssam.mjs';
import * as destructive from '../destructive-operations.mjs';
import { PORTAL_WRITES } from '../../portal/runtime/portal-routes.mjs';
import { loadToolRoutes } from '../tool-routing.mjs';

const FACADE = path.join(import.meta.dirname, '..');
// CX15 r2 (F4.4): the common suffix of every destructive description is ONE text, in destructive-operations.mjs; each of
// its sentences is checked on its own. (Read through the namespace so the suite runs, and fails, on the commit before it.)
const WORDS_RULE = destructive.WORDS_RULE ?? "The words are the owner's next message after the list, copied whole: never write, complete, translate or reuse words yourself "
  + '(not the request, not a template, not a reply to another list); without such a message, ask the owner and stop.';
const AFTER_INTERRUPTION = destructive.AFTER_INTERRUPTION ?? "Interrupted, CANCELLED, SC_LOCAL_FAILURE or another local failure, 'rejected' or no answer: read ssam_task {id:<operationId from the preview>} before telling the owner "
  + 'anything; never say nothing happened without it.';
const DESTRUCTIVE_SUFFIX = destructive.DESTRUCTIVE_SUFFIX ?? 'Deletes take two calls: without confirmationToken the call only previews (the exact list with its count; nothing is sent); '
  + "show the owner that EXACT list and ask; then call again with confirmationToken and the owner's reply, which states the number of items and names "
  + `the targets. ${WORDS_RULE} ${AFTER_INTERRUPTION}`;
const SUFFIX_SENTENCES = DESTRUCTIVE_SUFFIX.split(/(?<=\.)\s+(?=[A-Z])/).map(s => s.trim()).filter(Boolean);
const REPO = path.join(FACADE, '..', '..', '..');
const ONE_CALL = /\bone call\b|never prepare first|\bin one call\b|uma chamada só|numa chamada\b|em uma chamada\b/i;
const DELETING = /delet|discard|undeploy|remov|apag|exclu/i;
// The sentences (or list items) of a text that speak of deleting and of one call at the same time.
// JSON (schemas, catalog entries) is cut at its string boundaries first.
const oneCallDeletes = text => String(text).replace(/"\s*[,:{}[\]]+\s*"/g, '\n').split(/(?<=[.;!?])\s+|\n+/).filter(s => DELETING.test(s) && ONE_CALL.test(s));

async function descriptions() {
  const out = {};
  const capture = { registerTool: (name, config) => { out[name] = [config.description, JSON.stringify(config.inputSchema ?? {})].join('\n'); } };
  registerO11Operations(capture, schema => schema, {});
  registerO11Environment(capture, {});
  registerO11Extension(capture, {});
  registerAccessTools(capture, {}, fn => fn);
  registerExternalLibrary(capture, { access: {}, wrap: fn => fn });
  registerSsamTask(capture, {});
  // studio_data_delete and studio_command: the facade server, listed through a client (nothing is called).
  const server = await createFacadeServer({ deps: {} });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cx15-texts', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try { for (const tool of (await client.listTools()).tools) if (['studio_data_delete', 'studio_command'].includes(tool.name)) out[tool.name] = tool.description + '\n' + JSON.stringify(tool.inputSchema); }
  finally { await client.close(); await server.close(); }
  // o11_data: the description line belongs to CX13; the rule rides on the confirmationToken of each delete op.
  out.o11_data = JSON.stringify(o11DataRequestSchema);
  return out;
}

const DESTRUCTIVE = ['o11_service_center_write', 'o11_environment', 'o11_extension', 'o11_data', 'studio_data_delete', 'odc_asset_delete', 'odc_a2a_connection_delete',
  'odc_write', 'odc_deploy', 'odc_portal_write', 'odc_external_db_connection', 'odc_external_library'];

test('every destructive tool says: only the list without confirmationToken, the token and the owner reply after it, ssam_task after an interruption', async () => {
  const texts = await descriptions();
  for (const name of DESTRUCTIVE) {
    const text = texts[name];
    assert.ok(text, name + ' is registered');
    assert.match(text, /confirmationToken/, name);
    assert.match(text, /ssam_task/, name);
    // Every sentence of the common suffix, as written in destructive-operations.mjs (CX15 r2, F4.4).
    assert.equal(SUFFIX_SENTENCES.length, 3);
    for (const sentence of SUFFIX_SENTENCES) assert.ok(text.includes(sentence), `${name} misses: ${sentence}`);
    assert.deepEqual(oneCallDeletes(text), [], name);
  }
  // The passthrough says it never runs the destructive bridge commands; ssam_task says it lists them.
  assert.match(texts.studio_command, /never runs data-delete, portal-call, portal-private-call or portal-api-client-fixture-cleanup/);
  assert.match(texts.ssam_task, /Destructive operations/);
});

test('no catalog entry of a destructive tool, guide or delete section of the docs says "one call" about deleting', () => {
  // CX15 r3 (CT-8): the catalog as it is loaded and served (loadToolRoutes): its two-call texts are generated from the
  // texts of destructive-operations.mjs (the file holds a marker; destructive-r3-txt-catalog checks the file and the answer).
  const catalog = loadToolRoutes().data.tools;
  for (const name of [...DESTRUCTIVE, 'studio_command']) {
    const found = oneCallDeletes(JSON.stringify(catalog[name]).replace(/","/g, '".\n"'));
    assert.deepEqual(found, [], 'catalog ' + name);
  }
  // CX15 r2 (F4.4, T6): EVERY destructive route of the catalog (the inventory DESTRUCTIVE_TOOLS; the routes of
  // odc_portal_write whose effect is destructive) says the two calls, and its template is the preview: no words, no
  // operationId or operationUuid, no execute (the execution takes them from the preview's answer).
  const PREVIEW_ONLY = /^(words|authorize|authorization|operationUuid|operationId|execute|confirmationToken)$/;
  const STALE = /execute once|execute:\s*true|new UUID|a NEW operationUuid|<user's own words>|prepares\/simulates by default|prepare first|two calls: two calls/i;
  const portalDeletes = Object.entries(PORTAL_WRITES).filter(([, r]) => r.effect === 'destructive').map(([id]) => id);
  assert.ok(portalDeletes.length >= 6, portalDeletes.join(', '));
  const routes = [];
  for (const entry of destructive.DESTRUCTIVE_TOOLS) {
    if (entry.refuse) continue; // studio_command never runs them (checked above)
    const tool = catalog[entry.tool];
    assert.ok(tool, 'catalog ' + entry.tool);
    const verbs = entry.tool === 'odc_portal_write' ? portalDeletes : entry.verbs;
    // What an answer shows of a verb (tool-routing.mjs): its own when/preconditions/next/args, else the tool's; the first
    // two preconditions.
    const shown = v => ({ when: v.when ?? tool.when, preconditions: (v.preconditions ?? tool.preconditions ?? []).slice(0, 2), next: v.next ?? tool.next, args: v.args ?? tool.args });
    if (verbs) for (const verb of verbs) { assert.ok(tool.verbs?.[verb], `catalog ${entry.tool}.${verb}`); routes.push({ at: `${entry.tool}.${verb}`, route: shown(tool.verbs[verb]), field: tool.verbs[verb].field ?? tool.verbParam }); }
    else routes.push({ at: entry.tool, route: shown(tool), generic: entry.effect === 'destructive' });
  }
  const problems = [];
  const walk = (value, at, field) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) for (const [k, v] of Object.entries(value)) {
      const where = at ? `${at}.${k}` : k;
      if (PREVIEW_ONLY.test(k) && where !== field) problems.push(where);
      walk(v, where, field);
    }
  };
  for (const { at, route, field, generic } of routes) {
    const text = [route.when, ...(route.preconditions ?? []), route.next].filter(Boolean).join('\n');
    for (const rule of [/two calls/i, /confirmationToken/, /show the owner that EXACT list/, /ssam_task/])
      if (!rule.test(text)) problems.push(`${at}: says no ${rule}`);
    // CX15 r3 (CT-8): every sentence of the common suffix, as in the descriptions (the reply states the number AND names
    // the targets; the rule of the words; the step after an interruption or a local failure, SC_LOCAL_FAILURE).
    for (const sentence of SUFFIX_SENTENCES) if (!text.includes(sentence)) problems.push(`${at}: misses "${sentence.slice(0, 60)}..."`);
    // odc_write is the tool of every public mutation: its DELETE clause is checked above, its template is of any write.
    if (generic) continue;
    if (STALE.test(text)) problems.push(`${at}: the stale contract "${STALE.exec(text)[0]}"`);
    const before = problems.length; walk(route.args ?? {}, '', field);
    for (let i = before; i < problems.length; i++) problems[i] = `${at}: the template carries ${problems[i]}`;
  }
  assert.deepEqual(problems, []);
  for (const guide of ['o11.md', 'odc.md']) {
    const text = fs.readFileSync(path.join(FACADE, 'guides', guide), 'utf8');
    assert.deepEqual(oneCallDeletes(text), [], guide);
    assert.match(text, /confirmationToken/); assert.match(text, /ssam_task/);
  }
  const operations = fs.readFileSync(path.join(REPO, 'docs', 'OPERACOES-O11.md'), 'utf8');
  const section = operations.slice(operations.indexOf('## Apagar no ambiente'), operations.indexOf('\n## ', operations.indexOf('## Apagar no ambiente') + 5));
  assert.match(section, /Duas chamadas, sempre/);
  assert.deepEqual(oneCallDeletes(section.replace(/era uma chamada só/, '')), [], 'OPERACOES-O11 "Apagar no ambiente" (the history sentence aside)');
  const agents = fs.readFileSync(path.join(REPO, 'platforms', 'odc', 'AGENTS.md'), 'utf8');
  assert.match(agents, /duas chamadas \(CX15\)/);
  const contract = fs.readFileSync(path.join(REPO, 'docs', 'INTEGRACOES-GITSSAM.md'), 'utf8');
  assert.match(contract, /D4[\s\S]*CAIU em 14\/10/);
  assert.match(contract, /D2 vale só DEPOIS da prévia/);
  const engine = fs.readFileSync(path.join(FACADE, 'service-center', 'delete.mjs'), 'utf8').split('\n').slice(0, 30).join('\n');
  assert.match(engine, /TWO calls/); assert.doesNotMatch(engine, /in ONE call/);
});
