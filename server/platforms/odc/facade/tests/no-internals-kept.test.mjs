import './fixtures/isolated-profile.mjs';
// Round 5 of fix/no-internals (re-review C:\t\revisoes\no-internals-4\REVISAO.md):
// - LOW 2 (decision D13 of the Integradora, 17/10): on a licensee's server, an answer SSAM kept (.local/answers) is read back
//   only as the answer of the tool its origin record names; a kept answer without a valid record is refused
//   (ANSWER_ORIGIN_UNKNOWN), nothing read. The owner's server reads it as before;
// - LOW 3 (the family "kernel class"): a check of the licensee's job is SSAM's answer about that job, never the customer's
//   records: its `data` follows the runtime rule and its `scope` is prose, so no class or namespace of the kernel is served.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { servedBytesStore } from '../served-bytes.mjs';
import { exposedResult, presentedDocument } from '../exposure.mjs';
import { findings } from './fixtures/internal-text.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const kernel = path.resolve(here, '..', '..', '..', '..', 'kernel');
const cliBuilt = fs.existsSync(path.join(kernel, '.local', 'cli', 'anvil.dll'));
const skip = !cliBuilt && 'the O11 lane CLI is not built in this checkout';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'no-internals-kept-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const brief = body => JSON.stringify(body).slice(0, 300);
const shown = list => list.map(f => f.family + ' ' + f.at + ' ' + f.sample.replace(/\s+/g, ' ').slice(0, 120));

async function session(exposure) {
  const { createSsamServer } = await import('../ssam.mjs');
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { Client } = await import('@modelcontextprotocol/client');
  const store = servedBytesStore({ dir: fs.mkdtempSync(path.join(tmp, 'day-')) });
  const server = await createSsamServer({ profile: 'all', deps: { exposure: { profile: exposure, caller: () => 'kept-' + exposure + '-' + process.pid, store } } });
  const client = new Client({ name: 'no-internals-kept', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const once = async (name, args) => { const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 }); return r.structuredContent ?? JSON.parse(r.content[0].text); };
  const call = async (name, args) => {
    let body = await once(name, args);
    for (let i = 0; i < 240; i++) {
      const next = [body?.continuation, body?.next].find(c => c && typeof c === 'object' && c.arguments && Object.hasOwn(c.arguments, 'continueTask'));
      if (!next) break;
      await sleep(250);
      body = await once(next.tool, next.arguments);
    }
    return body;
  };
  return { call, close: async () => { await client.close(); await server.close(); } };
}

// ---- LOW 2 / D13: a kept answer without a valid origin record
test('live: on a licensee\'s server a kept answer without a valid origin record is refused, nothing read; the owner reads it as before (D13)', { skip, timeout: 900000 }, async () => {
  const L = await session('licensee');
  const doctor = await L.call('ssam_doctor', {});
  const file = doctor.omitted?.arguments?.file;
  assert.ok(file && fs.existsSync(file), brief(doctor));
  const record = file.replace(/\.json$/i, '') + '.origin';
  assert.ok(fs.existsSync(record), 'the licensee kept the omitted part with its origin record');
  const saved = fs.readFileSync(record, 'utf8');
  try {
    assert.equal((await L.call('ssam_evidence', { file, budgetBytes: 28672 })).ok, true, 'with its record it is read');
    for (const [label, body] of [['missing', null], ['not JSON', '{'], ['no tool', '{"kind":"rules"}'], ['a tool that is no name', '{"tool":"../ssam_doctor"}'], ['a number', '{"tool":5}']]) {
      if (body === null) fs.rmSync(record, { force: true }); else fs.writeFileSync(record, body);
      for (const args of [{ file, budgetBytes: 28672 }, { file, deep: true, table: true, budgetBytes: 28672 }]) {
        const read = await L.call('ssam_evidence', args);
        assert.equal(read.code, 'ANSWER_ORIGIN_UNKNOWN', label + ' ' + brief(read));
        assert.equal(read.value, undefined, label + ': nothing read');
        assert.deepEqual(shown(findings(read)), [], label);
      }
    }
    fs.rmSync(record, { force: true });
    const O = await session('owner');
    try { assert.equal((await O.call('ssam_evidence', { file, budgetBytes: 28672 })).ok, true, 'the owner reads it as before'); }
    finally { await O.close(); }
  } finally { fs.writeFileSync(record, saved); await L.close(); }
});

// ---- LOW 3: no kernel class in a check of the licensee's job
const checkAnswer = () => ({ ok: true, lane: 'o11', kind: 'check-job', job: 'C:\\srv\\ssam\\kernel\\.local\\jobs\\inline\\c1.json', verifyRan: false,
  data: { valid: false, ops: 1, errors: ['op #0 (logic) [NAME_UNKNOWN]: CustomerName is not declared'],
    problems: [{ op: 0, pointer: '/ops/0', code: 'NAME_UNKNOWN', severity: 'error', message: 'CustomerName is not declared (Anvil.Core.Kernel.JobPreflight)', fix: 'declare CustomerName in the job', patch: { op: 'replace', path: '/ops/0/data/name', value: 'CustomerName' } }],
    notes: [{ code: 'VERIFY_IDS_UNCHECKED', message: 'ids are checked at apply (see C:\\srv\\ssam\\kernel\\src\\Anvil.Core\\Kernel\\JobPreflight.cs:474)' }],
    scope: 'Validates syntax and the SQL the job carries, plus the rules of Anvil.Core.PreflightRules; warnings (never blocking) for List.Current without an empty guard.' } });
const asResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
test('a check of the licensee\'s job names no kernel class, inline and read back; the customer\'s words and the patch stay (LOW 3)', () => {
  const value = checkAnswer();
  for (const kind of ['check-job', 'check-delivery']) {
    const licensee = exposedResult(asResult(value), { exposure: 'licensee', handleRoots: [], tool: 'ssam_reference', args: { kind } });
    assert.deepEqual(shown(findings(licensee.structuredContent)), [], kind);
    assert.deepEqual(shown(findings(JSON.parse(licensee.content[0].text))), [], kind + ' text');
    const data = licensee.structuredContent.data;
    assert.match(data.problems[0].message, /^CustomerName is not declared/, 'the customer\'s words stay');
    assert.deepEqual(data.problems[0].patch, value.data.problems[0].patch, 'code stays');
    assert.deepEqual(data.errors, value.data.errors);
    assert.match(data.scope, /^Validates syntax/);
    // the same answer kept and read back with ssam_evidence
    const kept = presentedDocument(asResult(value), { exposure: 'licensee', handleRoots: [], origin: { tool: 'ssam_reference', kind } });
    assert.deepEqual(shown(findings(kept.structuredContent)), [], kind + ' kept');
  }
  // the owner's answer is the same object
  const result = asResult(value);
  assert.equal(exposedResult(result, { exposure: 'owner', tool: 'ssam_reference', args: { kind: 'check-job' } }), result);
});
test('live: ssam_reference check-job on a licensee\'s server names no kernel class (LOW 3)', { skip, timeout: 900000 }, async () => {
  const L = await session('licensee');
  try {
    const check = await L.call('ssam_reference', { lane: 'o11', kind: 'check-job', query: { description: 'x', ops: [] } });
    assert.equal(check.ok, true, brief(check));
    assert.deepEqual(shown(findings(check)), []);
  } finally { await L.close(); }
});
