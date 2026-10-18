import './fixtures/isolated-profile.mjs';
// No internals in a licensee's answers (fix/no-internals, 17/10/2026; the audit of a licensee's token found the kernel
// layout, the suite counts, proof levels, blind tests and the work packet's mechanism rebuilt from ssam_discover and
// ssam_reference answers). The guard runs the server in this process twice, exposure owner and exposure licensee
// (SSAM_EXPOSURE), over the same calls: the read tools a licensee leans on (ssam_reference of the kinds that need no CLI,
// ssam_doctor) and, when the lane CLIs are built in this checkout, ssam_reference api, ssam_discover (intents, a detail,
// an expansion, a work packet) and the refusals of ssam_job on synthetic jobs. Every string leaf and every key of every
// licensee answer is scanned for the families below; the owner answers must show the same families (the scan is not
// vacuous: what the licensee answers lack is what the filter took out), and each family catches its own sample (mutation).
// What USE needs is asserted to stay: the fix, patch and continuation of a refusal, the contracts, example ids and
// expansions of a discover, the text of a rules section.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUARD_KEYS, findings } from './fixtures/internal-text.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const kernel = path.resolve(here, '..', '..', '..', '..', 'kernel');
const cliBuilt = fs.existsSync(path.join(kernel, '.local', 'cli', 'anvil.dll')) && fs.existsSync(path.join(kernel, '.local', 'lane-odc', 'cli', 'anvil-odc.dll'));

// ---- the families and the scan: fixtures/internal-text.mjs (independent of the filter's own rules)
const bodyOf = result => result.structuredContent ?? (() => { try { return JSON.parse(result.content?.[0]?.text ?? 'null'); } catch { return result.content?.[0]?.text ?? null; } })();
// Every text part too: a prose part is scanned as it is.
const scanned = result => [bodyOf(result), ...(result.content ?? []).filter(c => c.type === 'text').map(c => { try { return JSON.parse(c.text); } catch { return c.text; } })];

const o11Base = path.join(kernel, 'tests', 'fixtures', 'blank-service.oml');
const odcBase = path.join(kernel, 'tests', 'fixtures', 'odc', 'insurance-reactive-r8.oml');
const badJob = base => ({ description: 'synthetic probe', base, ops: [
  { op: 'spec', data: { entities: [{ name: 'Customer', attributes: [{ name: 'Name', type: 'Txt' }] }] } },
  { op: 'creat', type: 'ServerAction', name: 'Sum' }] });
const CALLS = [
  ['ssam_reference', { lane: 'o11', kind: 'rules', query: 'session' }],
  ['ssam_reference', { lane: 'o11', kind: 'rules', query: '1' }],
  ['ssam_reference', { lane: 'odc', kind: 'rules', query: 'standards' }],
  ['ssam_reference', { lane: 'o11', kind: 'example', query: { find: 'table' } }],
  ['ssam_reference', { lane: 'odc', kind: 'example', query: 'timer-action' }],
  ['ssam_reference', { lane: 'odc', kind: 'example', query: 'rest-openapi-import' }],
  ['ssam_reference', { lane: 'o11', kind: 'recipe', query: 'timer' }],
  ['ssam_reference', { lane: 'odc', kind: 'recipe', query: 'timer' }],
  ['ssam_reference', { lane: 'o11', kind: 'tool', query: 'o11_deliver' }],
  ['ssam_doctor', {}],
  ...(cliBuilt ? [
    ['ssam_reference', { lane: 'o11', kind: 'api', query: { op: 'logic' } }],
    ['ssam_reference', { lane: 'odc', kind: 'api', query: { op: 'native', type: 'IServerAction' } }],
    ['ssam_discover', { lane: 'o11', intent: 'create a server action that sums two integers' }],
    ['ssam_discover', { lane: 'odc', intent: 'add a server action that calls a REST API' }],
    ['ssam_discover', { lane: 'o11', intent: 'generate the CRUD actions of an entity with entity-actions' }],
    ['ssam_discover', { lane: 'o11', detail: 'timer.schedule' }],
    ['ssam_discover', { lane: 'odc', expand: 'logic.server-action:contract+example+evidence+operations+native+bindings' }],
    ['ssam_discover', { lane: 'o11', intent: 'create an entity Customer with name and email and its CRUD actions', packet: true }],
    ['ssam_job', { lane: 'o11', job: badJob(o11Base) }],
    ['ssam_job', { lane: 'odc', job: badJob(odcBase) }],
  ] : []),
];

async function answersOf(exposure) {
  const before = process.env.SSAM_EXPOSURE;
  process.env.SSAM_EXPOSURE = exposure;
  // a caller of its own: the day's reference bytes of earlier runs never refuse this one (served-bytes.mjs)
  process.env.SSAM_EXPOSURE_CALLER = 'guard-' + process.pid + '-' + Date.now();
  try {
    const { createSsamServer } = await import('../ssam.mjs');
    const { InMemoryTransport } = await import('@modelcontextprotocol/server');
    const { Client } = await import('@modelcontextprotocol/client');
    const server = await createSsamServer({ profile: 'all' });
    const client = new Client({ name: 'no-internals-' + exposure, version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const answers = [];
    try {
      // a call the deadline detached (a cold CLI past its budget) is followed with continueTask to its final answer
      const settled = async (name, args) => {
        let result = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
        for (let i = 0; i < 40; i++) {
          const body = result.structuredContent ?? {};
          const next = [body.continuation, body.next].find(c => c && typeof c === 'object' && c.arguments && Object.hasOwn(c.arguments, 'continueTask'));
          if (!next) break;
          await new Promise(resolve => setTimeout(resolve, 1000));
          result = await client.callTool({ name: next.tool, arguments: next.arguments }, undefined, { timeout: 600000 });
        }
        return result;
      };
      for (const [name, args] of CALLS) answers.push({ name, args, result: await settled(name, args) });
    } finally { await client.close(); await server.close(); }
    return answers;
  } finally { if (before === undefined) delete process.env.SSAM_EXPOSURE; else process.env.SSAM_EXPOSURE = before; }
}
let owner, licensee;
const ready = (async () => { owner = await answersOf('owner'); licensee = await answersOf('licensee'); })();
const label = a => a.name + ' ' + JSON.stringify(a.args).slice(0, 90);

test('every family catches its own sample (mutation): a guard that misses one fails here', () => {
  const samples = {
    'absolute path': ['C:\\Users\\x\\SSAM\\kernel\\src\\a.txt', 'the Studio under /studio/o11 on the server'],
    'file:line or source file': ['at JobRunner.cs:line 158', 'see FlowApplyScenarios.cs'],
    'kernel or suite path': ['kernel/tests/jobs/a.json', 'tests/jobs/timer-action.json', 'platforms/odc/facade/x.mjs'],
    'suite command or count': ['dotnet test kernel/tests/Anvil.Tests', '301 jobs on O11 and 356 on ODC', 'results.trx'],
    'proof level or stamp': ['proven-historical', 'C-executed-current', 'kernelSha256: a vs b'],
    'round or review name': ['finding of CX15 r7', 'decision D-M3-26', 'workflow wf_52d1259c-641'],
    'internal reason': ['it still waits for its independent blind test', 'The owner\'s decision (2026-10-09)', 'blind-test-pending'],
    'project document': ['kernel/docs/NAO-DA.md:371', 'see PLANO-24', 'docs/COBERTURA-EXEMPLOS-O11.md'],
    'kernel class': ['Anvil.Core.JobRunner.Run', 'ExamplesO11Tests checks it', '   at Anvil.Cli.Program.Main(String[] args)'],
    'packet mechanism': ['the rules are chosen by keywords', 'up to 16 rules', 'each takes its share of the room'],
  };
  for (const [family, texts] of Object.entries(samples))
    for (const text of texts) assert.ok(findings({ text }).some(f => f.family === family), family + ' misses ' + text);
  for (const key of GUARD_KEYS) assert.ok(findings({ [key]: 1 }).some(f => f.family === 'internal key'), key);
  // a handle stays allowed only where a later call takes it back, and only under .local
  assert.equal(findings({ job: 'C:\\w\\kernel\\.local\\jobs\\inline\\a.json' }).length, 0);
  assert.equal(findings({ continuation: { tool: 'ssam_evidence', arguments: { file: 'C:\\w\\kernel\\.local\\answers\\a.json' } } }).length, 0);
  assert.ok(findings({ note: 'C:\\w\\kernel\\.local\\jobs\\inline\\a.json' }).length > 0);
  assert.ok(findings({ file: 'C:\\w\\kernel\\.local\\cli\\anvil.dll' }).length > 0);
});

test('no licensee answer tells how SSAM is built; the owner answers of the same calls do (the scan is not vacuous)', { timeout: 1800000 }, async () => {
  await ready;
  assert.equal(licensee.length, CALLS.length);
  const ownerFamilies = new Set(owner.flatMap(a => scanned(a.result).flatMap(v => findings(v))).map(f => f.family));
  for (const family of ['absolute path', 'kernel or suite path', 'project document', ...(cliBuilt ? ['proof level or stamp', 'kernel class', 'internal key'] : [])])
    assert.ok(ownerFamilies.has(family), 'the owner answers no longer show ' + family + ': this guard needs a call that does');
  const leaks = licensee.flatMap(a => scanned(a.result).flatMap(v => findings(v)).map(f => label(a) + ' ' + f.family + ' at ' + f.at + ': ' + f.sample));
  assert.deepEqual([...new Set(leaks)].slice(0, 40), []);
});

test('the licensee answers keep what using SSAM needs', { timeout: 1800000 }, async () => {
  await ready;
  const of = (list, name, pick) => list.find(a => a.name === name && pick(a.args));
  // a rules section: its text
  const rules = bodyOf(of(licensee, 'ssam_reference', a => a.kind === 'rules' && a.query === '1').result);
  assert.ok(typeof rules.text === 'string' && rules.text.length > 1000, JSON.stringify(rules).slice(0, 300));
  // a proven example by id: its job
  const example = bodyOf(of(licensee, 'ssam_reference', a => a.kind === 'example' && a.query === 'timer-action').result);
  assert.equal(example.ok, true, JSON.stringify(example).slice(0, 300));
  if (!cliBuilt) return;
  // a refusal keeps every problem with its fix, the job to base the patch on, and its discovery continuation
  for (const lane of ['o11', 'odc']) {
    const o = bodyOf(of(owner, 'ssam_job', a => a.lane === lane).result);
    const l = bodyOf(of(licensee, 'ssam_job', a => a.lane === lane).result);
    assert.equal(l.code, o.code);
    assert.deepEqual(l.problems.map(p => [p.code, p.pointer, p.fix, p.patch ?? null]), o.problems.map(p => [p.code, p.pointer, p.fix, p.patch ?? null]));
    // the job to patch over: the same content (an inline job gets a new file per call), a path the next call takes back
    assert.equal(l.nextBasedOn?.sha256 ?? null, o.nextBasedOn?.sha256 ?? null);
    if (o.nextBasedOn) assert.ok(fs.existsSync(l.nextBasedOn.job), l.nextBasedOn.job);
    assert.deepEqual(l.discovery?.continuation, o.discovery?.continuation);
  }
  // round 2 (review HIGH 1): every string under a code path of every owner answer passes the exit rule unchanged (a whole
  // value that is a suite or server path is the only exception), and every expression of an answer stays somewhere in it
  {
    const { exposedResult: exit } = await import('../exposure.mjs');
    const CODE = /(?<!\/operations)\/(?:ops|patch|patchByName|arguments|Signature|Examples|default|condition|value|set|card|contract|contracts|definition|content|route|expand)(?:\/|$)/;
    const strings = (v, p = '', out = new Map()) => { if (typeof v === 'string') out.set(p, v); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) strings(x, p + '/' + k, out); return out; };
    const pathValue = s => /^(?:[A-Za-z]:[\\/]|(?:kernel[\\/])?tests[\\/])/.test(s.trim());
    for (const o of owner) {
      const after = strings(bodyOf(exit(o.result, { exposure: 'licensee', tool: o.name, args: o.args })));
      for (const [p, s] of strings(bodyOf(o.result))) if (CODE.test(p) && after.has(p) && !pathValue(s)) assert.equal(after.get(p), s, label(o) + ' ' + p);
      const exprs = text => new Set(text.match(/\b[A-Za-z_][\w.]*\((?:[^()"\\]|\([^()"\\]*\))*\)/g) ?? []);
      const kept = JSON.stringify(bodyOf(exit(o.result, { exposure: 'licensee', tool: o.name, args: o.args })));
      for (const e of exprs(JSON.stringify(bodyOf(o.result)))) if (!/\bAnvil\.|^at /.test(e) && !(o.name === 'ssam_reference' && o.args.query === 'all')) assert.ok(kept.includes(e), label(o) + ' lost ' + e);
    }
  }
  // a discover keeps its matches, contracts, example ids and every continuation call. A discover answer depends on the
  // calls before it in its session (a repeated intent is answered with more), so the owner answer itself passes the
  // licensee rule here (the hub's exit, exposedResult) and the two are compared.
  const { exposedResult } = await import('../exposure.mjs');
  for (const o of owner.filter(a => a.name === 'ssam_discover')) {
    const ob = bodyOf(o.result); const lb = bodyOf(exposedResult(o.result, { exposure: 'licensee' }));
    assert.equal(lb.ok, ob.ok, label(o));
    assert.deepEqual((lb.matches ?? []).map(m => m.id), (ob.matches ?? []).map(m => m.id), label(o));
    assert.deepEqual(Object.keys(lb.contracts ?? {}), Object.keys(ob.contracts ?? {}), label(o));
    assert.deepEqual(Object.values(lb.examples ?? {}).map(e => e.job), Object.values(ob.examples ?? {}).map(e => e.job), label(o));
    const calls = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) && typeof x.tool === 'string' && x.arguments ? { tool: x.tool, arguments: x.arguments } : x)).match(/\{"tool":"[^"]+","arguments":/g) ?? [];
    assert.equal(calls(lb).length, calls(ob).length, 'every continuation call stays: ' + label(o));
  }
});

test('a licensee\'s refusal still leads to the delivery: the patch over nextBasedOn passes, on both lanes', { skip: !cliBuilt && 'the lane CLIs are not built in this checkout', timeout: 600000 }, async () => {
  const before = { exposure: process.env.SSAM_EXPOSURE, caller: process.env.SSAM_EXPOSURE_CALLER };
  process.env.SSAM_EXPOSURE = 'licensee'; process.env.SSAM_EXPOSURE_CALLER = 'guard-patch-' + process.pid;
  const { createSsamServer } = await import('../ssam.mjs');
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { Client } = await import('@modelcontextprotocol/client');
  const server = await createSsamServer({ profile: 'all' });
  const client = new Client({ name: 'no-internals-patch', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    for (const [lane, base] of [['o11', o11Base], ['odc', odcBase]]) {
      const job = { description: 'synthetic probe', base, ops: [{ op: 'spec', data: { entities: [{ name: 'Customer', attributes: [{ name: 'Name', type: 'Txt' }] }] } }] };
      const refused = (await client.callTool({ name: 'ssam_job', arguments: { lane, job } }, undefined, { timeout: 300000 })).structuredContent;
      assert.equal(refused.code, 'PREFLIGHT_REFUSED');
      assert.ok(refused.problems.every(p => p.fix), JSON.stringify(refused.problems));
      assert.deepEqual(findings(refused), [], 'the refusal itself carries no internals');
      const patched = (await client.callTool({ name: 'ssam_job', arguments: { lane, basedOn: refused.nextBasedOn,
        patch: [{ op: 'replace', path: '/ops/0/data/entities/0/attributes/0/type', value: 'Text' }] } }, undefined, { timeout: 300000 })).structuredContent;
      assert.equal(patched.ok, true, lane + ': ' + JSON.stringify(patched).slice(0, 400));
    }
  } finally {
    await client.close(); await server.close();
    for (const [k, v] of [['SSAM_EXPOSURE', before.exposure], ['SSAM_EXPOSURE_CALLER', before.caller]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});
