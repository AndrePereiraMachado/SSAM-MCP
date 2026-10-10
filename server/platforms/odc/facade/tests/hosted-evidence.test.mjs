// hosted/evidence.mjs (docs/O11-BRIDGE-FINA.md 7.2): the set of ODC suite jobs that run on a customer capture (a fixture
// of fixtures.excluded in scripts/release/client-content.json; the lane runs on the anonymized insurance-reactive-r8.oml) (directly, through job:<name>, or with no declared base) or whose text names a client of
// scripts/release/client-content.json, over a temporary catalog and over the real one, and the scrub of a hosted
// answer: their evidence leaves lists, becomes null as a field value, the capture's name becomes '<fixture omitida>',
// hostedEvidenceOmitted counts what left, a discover answer stops offering the examples taken out and, with clientText,
// loses every client name. The real discover answers of several intents, scrubbed, carry no client text. No Studio, no
// server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { thirdPartyJobs, scrubEvidence, clientPatterns, OMITTED, CLIENT_OMITTED } from '../hosted/evidence.mjs';
import { discover } from '../discovery.mjs';
import { anvilRoot, workspaceRoot } from '../workspace.mjs';

const CAPTURE = 'tests/fixtures/odc/wrightflood-personal-r8.oml';
const temps = [];
test.after(() => { for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true }); });
const readText = file => fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
const readJob = file => JSON.parse(readText(file));
const jobsIn = dir => fs.readdirSync(path.join(anvilRoot, 'tests', dir)).filter(f => f.endsWith('.json'))
  .map(f => ({ name: f.slice(0, -5), job: readJob(path.join(anvilRoot, 'tests', dir, f)), text: readText(path.join(anvilRoot, 'tests', dir, f)) }));
// The release scan's own list, read here independently of evidence.mjs.
const FORBIDDEN = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'scripts', 'release', 'client-content.json'), 'utf8')).forbidden.map(f => new RegExp(f.pattern, 'i'));
const clientHits = text => FORBIDDEN.filter(re => re.test(text)).map(re => re.source);

test('thirdPartyJobs over a temporary catalog: direct base, job: chains in any order, no base, client text, BOM and unreadable files; read once', () => {
  const kernel = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-evidence-'));
  temps.push(kernel);
  const put = (dir, name, content) => {
    fs.mkdirSync(path.join(kernel, 'tests', dir), { recursive: true });
    fs.writeFileSync(path.join(kernel, 'tests', dir, name + '.json'), typeof content === 'string' ? content : JSON.stringify(content));
  };
  put('jobs-odc', 'a-chained-twice', { base: 'job:b-chained', ops: [] });
  put('jobs-odc', 'b-chained', { base: 'job:direct', ops: [] });
  put('jobs-odc', 'direct', { base: CAPTURE, ops: [] });
  put('jobs-odc', 'windows-separators', { base: 'tests\\fixtures\\odc\\wrightflood-personal-r8.oml', ops: [] });
  put('jobs-odc', 'no-base', { ops: [] });
  put('jobs-odc', 'array-job', [{ op: 'get', target: '@espace' }]);
  put('jobs-odc', 'with-bom', '﻿' + JSON.stringify({ base: CAPTURE, ops: [] }));
  put('jobs-odc', 'unreadable', '{ not json');
  put('jobs-odc', 'neutral', { base: 'tests/fixtures/odc/blank-mobile.oml', ops: [] });
  put('jobs-odc', 'neutral-chained', { base: 'job:neutral', ops: [] });
  put('jobs-odc', 'unknown-chain', { base: 'job:not-in-the-catalog', ops: [] });
  put('jobs-odc', 'neutral-naming-client', { description: 'Uma app como o Wright Flood recusa isto', base: 'tests/fixtures/odc/blank-agent.oml', ops: [] });
  put('jobs-odc', 'chained-to-client-text', { base: 'job:neutral-naming-client', ops: [] });
  put('jobs-odc-negative', 'negative-direct', { base: CAPTURE, expectError: ['x'] });
  put('jobs-odc-negative', 'negative-chained', { base: 'job:b-chained', expectError: ['x'] });
  put('jobs-odc-negative', 'negative-neutral', { base: 'job:neutral', expectError: ['x'] });
  put('jobs-odc-negative', 'negative-client-message', { base: 'tests/fixtures/odc/blank-mobile.oml', expectError: ["can't be children of FloodQuotes objects"] });
  const jobs = thirdPartyJobs({ kernel });
  assert.deepEqual([...jobs].sort(), ['a-chained-twice', 'array-job', 'b-chained', 'chained-to-client-text', 'direct', 'negative-chained', 'negative-client-message', 'negative-direct',
    'neutral-naming-client', 'no-base', 'unreadable', 'windows-separators', 'with-bom']);
  put('jobs-odc', 'added-later', { base: CAPTURE, ops: [] });
  assert.equal(thirdPartyJobs({ kernel }), jobs, 'read once per process');
  assert.equal(jobs.has('added-later'), false);
});

test('thirdPartyJobs over the real catalog: the lane runs on the anonymized fixture, so no suite job, negative or proven example is third-party', () => {
  const jobs = thirdPartyJobs();
  const odc = jobsIn('jobs-odc'), negative = jobsIn('jobs-odc-negative');
  const examples = jobsIn(path.join('jobs-odc', 'examples')).filter(j => Array.isArray(j.job.ops) || Array.isArray(j.job.jobs)).map(j => ({ ...j, name: 'examples/' + j.name }));
  assert.ok(examples.length > 200, 'the proven examples are read');
  assert.deepEqual([...odc, ...negative, ...examples].filter(j => j.job.base === CAPTURE).map(j => j.name), [], 'no job runs on the client capture');
  for (const { name, job } of [...odc, ...negative, ...examples]) {
    if (/^tests\/fixtures\/odc\/(blank-|insurance-reactive-r8\.oml)/.test(job.base ?? '')) assert.equal(jobs.has(name), false, name);
    if (String(job.base).startsWith('job:')) assert.equal(jobs.has(name), jobs.has(job.base.slice(4)) || jobs.has('examples/' + job.base.slice(4)), name + ' follows ' + job.base);
  }
  for (const name of ['screen-list', 'logic-steps', 'security-settings', 'delete-data-in-use', 'workflow-nodes', 'examples/ecommerce-04-catalog', 'examples/blocked-editable-table'])
    assert.equal(jobs.has(name), false, name);
  // Only a job that declares no base stays third-party (fail closed), and none of the lane does.
  assert.deepEqual([...jobs].sort(), [...odc, ...negative].filter(j => !(j.job && typeof j.job === 'object' && !Array.isArray(j.job) && typeof j.job.base === 'string' && j.job.base.trim())).map(j => j.name).sort());
  // What a hosted customer is shown carries no client name: description, notes and expected messages of every job left.
  for (const { name, text } of [...odc, ...negative]) if (!jobs.has(name)) assert.deepEqual(clientHits(text), [], name);
  assert.equal(clientPatterns().length, FORBIDDEN.length, 'evidence.mjs reads the same list');
});

test('scrubEvidence over a discover answer: no third-party job and no capture name is left, a neutral job stays, hostedEvidenceOmitted counts', () => {
  // The set the gate would read for a catalog whose jobs ran on the capture (the real lane no longer has any).
  const jobs = new Set(['screen-list', 'delete-data-in-use', 'logic-steps', 'security-settings']);
  const capture = path.join(anvilRoot, ...CAPTURE.split('/'));
  const answer = {
    ok: true, lane: 'odc', intent: 'tabela na tela',
    identity: { lane: 'odc', kernel: 'k', fixtureSha256: 'EB15CA88', fixture: { path: capture, sha256: 'EB15CA88' } },
    matches: [{
      id: 'screen-table', level: 'C-executed-current',
      proofs: [{ job: 'screen-list', level: 'C-executed-current' }, { job: 'workflow-nodes', level: 'C-suite' }],
      negative: [{ job: 'delete-data-in-use', refuses: ['delete: refused'] }],
      notes: [{ job: 'logic-steps', op: 3, verb: 'set', text: 'note' }],
      operations: { create: { roles: { table: {
        proofs: [{ job: 'tests/jobs-odc/screen-list.json', level: 'C-suite' }, { job: path.join(anvilRoot, 'tests', 'jobs-odc-negative', 'delete-data-in-use.json') }],
        observed: { ran: [{ job: 'security-settings', level: 'C-suite', ops: [] }, { job: 'workflow-nodes', level: 'C-suite', ops: [] }] } } } } },
    }],
    examples: { 'screen-table': { job: 'screen-list', path: 'tests/jobs-odc/screen-list.json', ops: [{ op: 'create' }] },
      workflow: { job: 'workflow-nodes', path: 'tests/jobs-odc/workflow-nodes.json', ops: [] } },
    bindings: [{ rule: 'Table.Source = Aggregate', job: 'screen-list', op: 2, rank: 1 }, { rule: 'Node.Next = Node', job: 'workflow-nodes', op: 1, rank: 2 }],
    evidence: { level: 'C-suite', proofs: [{ job: 'logic-steps', base: CAPTURE }], negative: [{ job: 'delete-data-in-use', description: 'd', expectError: [] }] },
    unavailable: [{ id: 'u', negative: ['delete-data-in-use', 'workflow-nodes'] }],
    run: { fixture: CAPTURE, where: 'an object without job that names the capture' },
    sources: [{ path: capture, bytes: 1 }, { path: 'tests/fixtures/odc/blank-workflow.oml', bytes: 2 }],
    note: 'proved on ' + capture + ' (WrightFlood-Personal-R8)',
  };
  const before = structuredClone(answer);
  const result = scrubEvidence({ content: [{ type: 'text', text: JSON.stringify(answer) }, { type: 'text', text: 'Proofs ran on ' + capture + '.' }], structuredContent: answer }, jobs);
  assert.deepEqual(answer, before, 'the original answer is not changed');
  const shown = result.structuredContent;
  assert.equal(shown.identity.fixture, null);
  assert.equal(shown.identity.fixtureSha256, 'EB15CA88', 'a hash is not a name');
  assert.deepEqual(shown.matches[0].proofs, [{ job: 'workflow-nodes', level: 'C-suite' }]);
  assert.deepEqual(shown.matches[0].negative, []);
  assert.deepEqual(shown.matches[0].notes, []);
  assert.deepEqual(shown.matches[0].operations.create.roles.table.proofs, []);
  assert.deepEqual(shown.matches[0].operations.create.roles.table.observed.ran, [{ job: 'workflow-nodes', level: 'C-suite', ops: [] }]);
  assert.equal(shown.matches[0].level, 'C-executed-current', 'the proof level stays');
  assert.equal(shown.examples['screen-table'], null);
  assert.deepEqual(shown.examples.workflow, answer.examples.workflow);
  assert.deepEqual(shown.bindings, [answer.bindings[1]]);
  assert.deepEqual(shown.evidence, { level: 'C-suite', proofs: [], negative: [] });
  assert.deepEqual(shown.unavailable[0].negative, ['workflow-nodes']);
  assert.equal(shown.run, null);
  assert.deepEqual(shown.sources, [answer.sources[1]]);
  assert.equal(shown.note, 'proved on ' + capture.replace('wrightflood-personal-r8', OMITTED) + ' (' + OMITTED + ')');
  assert.equal(shown.hostedEvidenceOmitted, 14);
  assert.equal(result.content[0].text, JSON.stringify(shown), 'the JSON text is written again from the cleaned answer');
  assert.equal(result.content[1].text, 'Proofs ran on ' + capture.replace('wrightflood-personal-r8', OMITTED) + '.');
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, /wrightflood-personal-r8/i);
  for (const name of jobs) assert.ok(!text.includes('"' + name + '"') && !text.includes(name + '.json'), name);
  assert.ok(text.includes('"workflow-nodes"'), 'the neutral job stays');
});

test('scrubEvidence without evidence adds nothing; a text-only answer only gets the replacement; other values pass', () => {
  const jobs = new Set(['screen-list']);
  const clean = { ok: true, proofs: [{ job: 'workflow-nodes' }], level: 'B' };
  const kept = scrubEvidence({ content: [{ type: 'text', text: JSON.stringify(clean) }], structuredContent: clean, isError: false }, jobs);
  assert.deepEqual(kept, { content: [{ type: 'text', text: JSON.stringify(clean) }], structuredContent: clean, isError: false });
  assert.equal(Object.hasOwn(kept.structuredContent, 'hostedEvidenceOmitted'), false);
  const prose = scrubEvidence({ content: [{ type: 'text', text: 'base tests/fixtures/odc/wrightflood-personal-r8.oml, job screen-list' }, { type: 'image', data: 'x' }] }, jobs);
  assert.deepEqual(prose.content, [{ type: 'text', text: 'base tests/fixtures/odc/' + OMITTED + '.oml, job screen-list' }, { type: 'image', data: 'x' }]);
  assert.equal(scrubEvidence(null, jobs), null);
  assert.equal(scrubEvidence(undefined, jobs), undefined);
  const list = scrubEvidence({ structuredContent: [{ job: 'screen-list' }, 'screen-list', 'other'] }, jobs);
  assert.deepEqual(list.structuredContent, ['other'], 'a list answer is cleaned; the count goes only on an object');
});

test('scrubEvidence with clientText: every client name of the list becomes <cliente omitido> (texts, keys, prose); without it the customer data stays', () => {
  const jobs = new Set();
  const answer = { ok: true, limits: [{ text: 'A real FloodQuotes DEV login read four role claims' }, { title: 'Download de assets ODC por bridge (tenant unimedpoa)' }],
    note: 'base tests/fixtures/odc/wrightflood-personal-r8.oml; medido no WrightFlood e no Wright-Flood', byHost: { 'personal-nv0s5uly.outsystems.dev': 1 } };
  const prose = 'Medido no WRIGHTFLOOD.';
  const redacted = scrubEvidence({ content: [{ type: 'text', text: JSON.stringify(answer) }, { type: 'text', text: prose }], structuredContent: answer }, jobs, { clientText: true });
  const shown = redacted.structuredContent;
  assert.equal(shown.limits[0].text, `A real ${CLIENT_OMITTED} DEV login read four role claims`);
  assert.equal(shown.limits[1].title, `Download de assets ODC por bridge (tenant ${CLIENT_OMITTED}poa)`);
  assert.equal(shown.note, `base tests/fixtures/odc/${OMITTED}.oml; medido no ${CLIENT_OMITTED} e no ${CLIENT_OMITTED}`);
  assert.deepEqual(Object.keys(shown.byHost), [`personal-${CLIENT_OMITTED}.outsystems.dev`]);
  assert.equal(Object.hasOwn(shown, 'hostedEvidenceOmitted'), false, 'a replaced name is not removed evidence');
  assert.equal(redacted.content[0].text, JSON.stringify(shown));
  assert.equal(redacted.content[1].text, `Medido no ${CLIENT_OMITTED}.`);
  assert.deepEqual(clientHits(JSON.stringify(redacted)), []);
  // Another tool's answer is the customer's own data: a module of theirs named like a client keeps its name.
  const own = { ok: true, module: 'FloodQuotes_CS', path: 'ws:odc/snapshots/FloodQuotes.oml' };
  assert.deepEqual(scrubEvidence({ structuredContent: own }, jobs).structuredContent, own);
});

test('scrubEvidence over a discover answer: continuation.omitted stops offering an example the scrub took out; other parts and examples stay', () => {
  const jobs = new Set(['screen-list', 'data-entity']);
  const answer = { ok: true,
    examples: { 'ui.list': { job: 'screen-list', fragment: true, ops: [] }, 'data.static': { job: 'data-entity', fragment: true, ops: [] },
      'ui.agent': { job: 'agent-calls', fragment: true, ops: [] }, 'ui.none': null },
    continuation: { expand: 'ssam_discover {...}', omitted: [
      { id: 'ui.list', parts: ['example', 'evidence', 'bindings'], expand: 'ui.list:example+evidence+bindings' },
      { id: 'data.static', parts: ['example'], expand: 'data.static:example' },
      { id: 'ui.agent', parts: ['example', 'evidence'], expand: 'ui.agent:example+evidence' },
      { id: 'ui.none', parts: ['example', 'evidence'], expand: 'ui.none:example+evidence' },
      { id: 'data.records', parts: ['evidence'], expand: 'data.records:evidence' }] } };
  const shown = scrubEvidence({ structuredContent: answer }, jobs).structuredContent;
  assert.deepEqual(shown.examples, { 'ui.list': null, 'data.static': null, 'ui.agent': answer.examples['ui.agent'], 'ui.none': null });
  assert.deepEqual(shown.continuation.omitted, [
    { id: 'ui.list', parts: ['evidence', 'bindings'], expand: 'ui.list:evidence+bindings' },
    { id: 'ui.agent', parts: ['example', 'evidence'], expand: 'ui.agent:example+evidence' },
    { id: 'ui.none', parts: ['example', 'evidence'], expand: 'ui.none:example+evidence' },
    { id: 'data.records', parts: ['evidence'], expand: 'data.records:evidence' }]);
  assert.equal(shown.continuation.expand, answer.continuation.expand);
  assert.equal(shown.hostedEvidenceOmitted, 2);
});

test('the real discover answers of several intents (list, agent, mobile, workflow, debugger), scrubbed as the hosted gate does, carry no client text', async () => {
  const jobs = thirdPartyJobs();
  let ownerHits = 0;
  for (const intent of ['tela com lista de registros', 'agente de IA que chama uma acao', 'app mobile com sync', 'workflow com nos de decisao', 'debugger de app user login']) {
    const answer = await discover({ lane: 'odc', intent });
    ownerHits += clientHits(JSON.stringify(answer)).length;
    const shown = scrubEvidence({ content: [{ type: 'text', text: JSON.stringify(answer) }], structuredContent: answer }, jobs, { clientText: true });
    assert.deepEqual(clientHits(JSON.stringify(shown)), [], intent);
    const examples = shown.structuredContent.examples ?? {};
    for (const entry of shown.structuredContent.continuation?.omitted ?? [])
      if (examples[entry.id] === null && answer.examples?.[entry.id] != null) assert.ok(!entry.parts.includes('example'), intent + ': ' + entry.id);
  }
  // The lane fixture is anonymized: the owner-side answers no longer need the scrub to be clean (counted, not required).
  assert.ok(ownerHits >= 0);
});
