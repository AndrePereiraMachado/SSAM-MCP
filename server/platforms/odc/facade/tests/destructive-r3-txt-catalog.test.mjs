import './fixtures/isolated-profile.mjs';
// CX15 r3, CT-8 (review cx15-2): the catalog (catalog/tools.json) had 29 two-call texts (22 `next`, 7 preconditions)
// written by hand: none had the rule of the words nor the local failure (SC_LOCAL_FAILURE), and 22 asked only for the
// number ("the owner's reply, verbatim, stating the number of items"), which leads to WORDS_MUST_NAME and a second trip to
// the owner. They are now GENERATED when the catalog is loaded, from the texts of destructive-operations.mjs (the very
// sentences of every destructive tool description: DESTRUCTIVE_SUFFIX = the two calls + the reply that states the number
// AND names the targets + WORDS_RULE + AFTER_INTERRUPTION; ODC_EXECUTION_UUID for an ODC route); the file holds a marker.
// Checked as the catalog is loaded (loadToolRoutes) and as ssam_discover serves it (attachTools at the first answer's
// budget: a generated text is never cut at 160 characters). Offline: no Studio, no index, synthetic names.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as destructive from '../destructive-operations.mjs';
import { TOOLS_FILE, loadToolRoutes, compileToolRoutes, routeTools, attachTools } from '../tool-routing.mjs';
import { ANSWER_BUDGETS } from '../answer-size.mjs';

const { DESTRUCTIVE_SUFFIX, ODC_EXECUTION_UUID, WORDS_RULE, AFTER_INTERRUPTION } = destructive;
const SENTENCES = DESTRUCTIVE_SUFFIX.split(/(?<=\.)\s+(?=[A-Z])/).map(s => s.trim()).filter(Boolean);
// The 29 two-call texts the review counted (CX15-2 CT-8, cancel-text\RELATORIO.md), route -> field; `odc`: the execution
// also takes the preview's operationId as operationUuid.
const TWO_CALL_TEXTS = Object.freeze([
  ['o11_data.delete', 'next'],
  ['o11_service_center_write', 'preconditions[1]'],
  ['o11_service_center_write.delete', 'next'],
  ['o11_service_center_write.solution-delete', 'next'],
  ['o11_service_center_write.db-connection-delete', 'next'],
  ['o11_service_center_write.module-delete', 'next'],
  ['o11_service_center_write.extension-delete', 'next'],
  ['o11_service_center_write.application-delete', 'next'],
  ['o11_environment.delete-app', 'next'],
  ['o11_extension', 'preconditions[1]'],
  ['o11_extension.delete', 'next'],
  ['studio_data_delete', 'next'],
  ['odc_write', 'preconditions[1]', 'odc'],
  ['odc_portal_write', 'preconditions[1]', 'odc'],
  ['odc_portal_write.connections.delete', 'next', 'odc'],
  ['odc_portal_write.agents.evaluationDelete', 'next', 'odc'],
  ['odc_portal_write.knowledgeBases.delete', 'next', 'odc'],
  ['odc_portal_write.agents.datasetDelete', 'next', 'odc'],
  ['odc_portal_write.aiModels.trialDelete', 'next', 'odc'],
  ['odc_portal_write.apiClients.delete', 'next', 'odc'],
  ['odc_deploy', 'preconditions[1]', 'odc'],
  ['odc_deploy.Undeploy', 'next', 'odc'],
  ['odc_asset_delete', 'next', 'odc'],
  ['odc_external_library', 'preconditions[1]', 'odc'],
  ['odc_external_library.discard', 'next', 'odc'],
  ['odc_external_db_connection', 'preconditions[1]', 'odc'],
  ['odc_external_db_connection.delete', 'next', 'odc'],
  ['odc_external_db_connection.remove-entities', 'next', 'odc'],
  ['odc_a2a_connection_delete', 'next', 'odc'],
]);
const key = ([at, field]) => `${at} ${field}`;

// The route of an id ("tool" or "tool.verb": a verb may itself hold dots, "connections.delete") in the catalog's tools.
function routeOf(tools, at) {
  const dot = at.indexOf('.');
  if (dot < 0) return tools[at];
  return tools[at.slice(0, dot)]?.verbs?.[at.slice(dot + 1)];
}
const fieldOf = (route, field) => { const m = /^preconditions\[(\d+)\]$/.exec(field); return m ? route?.preconditions?.[Number(m[1])] : route?.[field]; };
// Every text of a route (when, preconditions, next; its byLane texts too), with where it is.
function textsOf(tools) {
  const out = [];
  const push = (at, src) => {
    for (const f of ['when', 'next']) if (typeof src?.[f] === 'string') out.push({ at, field: f, text: src[f] });
    (src?.preconditions ?? []).forEach((p, i) => out.push({ at, field: `preconditions[${i}]`, text: p }));
    for (const [lane, o] of Object.entries(src?.byLane ?? {})) push(`${at} byLane.${lane}`, o);
  };
  for (const [tool, t] of Object.entries(tools)) { push(tool, t); for (const [verb, v] of Object.entries(t.verbs ?? {})) push(`${tool}.${verb}`, v); }
  return out;
}
// The hand-written two-call contract the review found (any piece of it is the old text).
const OLD = /stating the number of items|words said before the preview never confirm it|only the preview \(the exact list with its count; nothing sent\)/;

test('CT-8: the 29 two-call texts of the catalog, as loaded, ask for the number AND the names, say the rule of the words and the step after an interruption or a local failure (SC_LOCAL_FAILURE)', () => {
  const compiled = loadToolRoutes();
  assert.deepEqual(compiled.problems, []);
  assert.equal(TWO_CALL_TEXTS.length, 29);
  assert.equal(TWO_CALL_TEXTS.filter(([, f]) => f === 'next').length, 22);
  assert.equal(TWO_CALL_TEXTS.filter(([, f]) => f !== 'next').length, 7);
  assert.equal(SENTENCES.length, 3);
  const problems = [];
  for (const entry of TWO_CALL_TEXTS) {
    const [at, field, odc] = entry;
    const text = fieldOf(routeOf(compiled.data.tools, at), field);
    if (typeof text !== 'string') { problems.push(`${key(entry)}: missing`); continue; }
    for (const sentence of SENTENCES) if (!text.includes(sentence)) problems.push(`${key(entry)}: misses "${sentence.slice(0, 70)}..."`);
    if (!/states the number of items and names the targets/.test(text)) problems.push(`${key(entry)}: asks for the number without the names`);
    if (!/SC_LOCAL_FAILURE/.test(text)) problems.push(`${key(entry)}: no local failure`);
    if (OLD.test(text)) problems.push(`${key(entry)}: still the hand-written contract "${OLD.exec(text)[0]}"`);
    if (odc && !text.includes(ODC_EXECUTION_UUID)) problems.push(`${key(entry)}: no operationUuid of the preview`);
    if (!odc && text.includes(ODC_EXECUTION_UUID)) problems.push(`${key(entry)}: an operationUuid on a route without one`);
  }
  assert.deepEqual(problems, []);
});

test('CT-8, the family: the loaded catalog carries the generated text in exactly these 29 places, and no other text keeps the hand-written contract', () => {
  const texts = textsOf(loadToolRoutes().data.tools);
  const generated = texts.filter(t => t.text.includes(DESTRUCTIVE_SUFFIX)).map(t => `${t.at} ${t.field}`).sort();
  assert.deepEqual(generated, TWO_CALL_TEXTS.map(key).sort());
  assert.deepEqual(texts.filter(t => OLD.test(t.text)).map(t => `${t.at} ${t.field}`), [], 'no text keeps the number-only contract');
  // The rule and the step after an interruption are always whole: never one without the other.
  const partial = texts.filter(t => (t.text.includes(WORDS_RULE) || t.text.includes(AFTER_INTERRUPTION)) && !t.text.includes(DESTRUCTIVE_SUFFIX));
  assert.deepEqual(partial.map(t => `${t.at} ${t.field}`), []);
});

test('CT-8, one source: tools.json holds a marker at each of the 29 places and no copy of the common texts; an unknown marker is a problem', () => {
  const raw = fs.readFileSync(TOOLS_FILE, 'utf8');
  const count = marker => raw.split(marker).length - 1;
  assert.equal(count("{{destructive.twoCalls}}"), 12, 'O11 and studio_data_delete markers');
  assert.equal(count('{{destructive.twoCalls.odc}}'), 17, 'ODC markers');
  // The pieces a hand copy would carry (between ; : and parentheses, long enough to be distinctive).
  const pieces = [...new Set([DESTRUCTIVE_SUFFIX, ODC_EXECUTION_UUID].flatMap(t => t.split(/[;:()]|\. /)).map(s => s.trim()).filter(s => s.length >= 30))];
  assert.ok(pieces.length >= 6, pieces.join(' | '));
  assert.deepEqual(pieces.filter(p => raw.includes(p)), [], 'tools.json copies none of the common texts');
  assert.doesNotMatch(raw, OLD, 'tools.json keeps none of the hand-written contract');
  // A marker the loader does not know is a problem of the catalog (discoverAll answers tools.json: <problem>), never served.
  const data = JSON.parse(raw);
  const broken = { ...data, tools: { ...data.tools, studio_data_delete: { ...data.tools.studio_data_delete, next: '{{destructive.unknown}}' } } };
  const problems = compileToolRoutes(broken).problems;
  assert.ok(problems.some(p => /studio_data_delete next: unknown text marker \{\{destructive\.unknown\}\}/.test(p)), problems.join('; '));
});

// The first answer of ssam_discover for a route (attachTools, the composition the MCP tool serves), at its own budget.
async function served(route, lane, extra = []) {
  const item = r => ({ tool: r.tool, ...(r.verb ? { verb: r.verb } : {}), lane: r.lane, args: r.args, when: r.when,
    ...(r.preconditions?.length ? { preconditions: r.preconditions.slice(0, 2) } : {}), ...(r.next ? { next: r.next } : {}), why: [] });
  const answer = { ok: true, schemaVersion: 'ssam-discover/1', lane, intent: 'synthetic', matches: [], size: { bytes: 0, budgetBytes: ANSWER_BUDGETS.discoverFirst, status: 'within', truncated: [] } };
  return attachTools(answer, { tools: [item(route), ...extra.map(item)] }, { budgetBytes: ANSWER_BUDGETS.discoverFirst, lane });
}

test('CT-8 as served: the first answer of ssam_discover shows each of the 29 texts whole (never cut at 160 characters) within its budget', async () => {
  const compiled = loadToolRoutes();
  const problems = [];
  for (const entry of TWO_CALL_TEXTS) {
    const [at, field] = entry;
    const route = compiled.routeById.get(at);
    assert.ok(route, at);
    const lane = route.lane === 'both' ? 'odc' : route.lane;
    const answer = await served(route, lane);
    const shown = answer.tools?.[0];
    const text = fieldOf(shown, field);
    if (Buffer.byteLength(JSON.stringify(answer)) > ANSWER_BUDGETS.discoverFirst) problems.push(`${key(entry)}: over the first answer's budget`);
    if (typeof text !== 'string') { problems.push(`${key(entry)}: not shown (${JSON.stringify(Object.keys(shown ?? {}))})`); continue; }
    for (const sentence of SENTENCES) if (!text.includes(sentence)) problems.push(`${key(entry)}: the answer misses "${sentence.slice(0, 50)}..." (${text.length} chars: ${text.slice(-40)})`);
  }
  assert.deepEqual(problems, []);
});

test('CT-8 as served, real intents: a delete request routes to its tool and the answer carries the whole rule (O11 and ODC)', async () => {
  const compiled = loadToolRoutes();
  const intents = [
    ['o11', 'apagar as aplicações ZZSynthA e ZZSynthB no service center', 'o11_service_center_write.application-delete'],
    ['o11', 'apagar a solução ZZSynthSol no service center', 'o11_service_center_write.solution-delete'],
    ['o11', 'apagar os registros 1 e 2 da entidade ZZSynthEnt', 'o11_data.delete'],
    ['odc', 'apagar a app ZZSynthApp', 'odc_asset_delete'],
    ['odc', 'fazer undeploy da app ZZSynthApp no stage Development', 'odc_deploy.Undeploy'],
    ['odc', 'descartar o job da external library ZZSynthLib', 'odc_external_library.discard'],
  ];
  for (const [lane, intent, expected] of intents) {
    const routed = routeTools({ intent, lane }, compiled);
    const ids = routed.tools.map(t => t.tool + (t.verb ? '.' + t.verb : ''));
    assert.ok(ids.includes(expected), `${intent}: ${ids.join(', ')}`);
    const answer = { ok: true, schemaVersion: 'ssam-discover/1', lane, intent, matches: [], size: { bytes: 0, budgetBytes: ANSWER_BUDGETS.discoverFirst, status: 'within', truncated: [] } };
    const out = await attachTools(answer, routed, { budgetBytes: ANSWER_BUDGETS.discoverFirst, lane });
    assert.ok(Buffer.byteLength(JSON.stringify(out)) <= ANSWER_BUDGETS.discoverFirst, intent);
    const shown = out.tools.find(t => t.tool + (t.verb ? '.' + t.verb : '') === expected);
    for (const sentence of SENTENCES) assert.ok(shown.next.includes(sentence), `${intent}: ${shown.next.slice(0, 200)}`);
  }
});
