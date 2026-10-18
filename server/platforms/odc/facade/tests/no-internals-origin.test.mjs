import './fixtures/isolated-profile.mjs';
// Round 4 of fix/no-internals (re-review C:\t\revisoes\no-internals-3\REVISAO.md): the hub decides every call on what the
// tool RUNS and on WHOSE answer it serves, never on the arguments as written.
// - MEDIUM 1: the day and the documentation mode read the arguments the tool runs (the input layer renames File, FILE,
//   files and fi_le to file on a read-only tool);
// - LOW 1: a continuation {continueTask} is decided as the call that detached: never refused by the day, counted in the
//   meter of that call;
// - MEDIUM 2: an answer kept for a later read (an omitted part, a paged answer, the final answer of a detached call) is read
//   back with ssam_evidence under the rule of the tool that answered, in every shape of the reader, and a kept answer of
//   ssam_reference counts in the reference day like a reference file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { servedBytesStore } from '../served-bytes.mjs';
import { findings } from './fixtures/internal-text.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const kernel = path.resolve(here, '..', '..', '..', '..', 'kernel');
const cliBuilt = fs.existsSync(path.join(kernel, '.local', 'cli', 'anvil.dll')) && fs.existsSync(path.join(kernel, '.local', 'lane-odc', 'cli', 'anvil-odc.dll'));
const skip = !cliBuilt && 'the lane CLIs are not built in this checkout';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'no-internals-origin-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const shown = list => list.map(f => f.family + ' ' + f.at + ' ' + f.sample.replace(/\s+/g, ' ').slice(0, 120));
// A table cell or a count has no key, so the guard cannot tell a handle (a whole path under a .local work folder that the
// next call takes back, exact by design) from a server path there: in those keyless cells the guard's own handle rule
// (internal-text.mjs handlePath: under .local, never a CLI, suite or cache folder) is applied to every path in the text.
const HANDLE_IN_TEXT = /[A-Za-z]:[\\/][^"'`\s<>|*?]*?[\\/]\.local[\\/][^"'`\s<>|*?,]*/g;
const unhandled = cell => (typeof cell === 'string' ? cell.replace(HANDLE_IN_TEXT, m => (/[\\/](?:cli|test-work|discovery|readers)[\\/]/i.test(m) ? m : '<handle>')) : cell);
const keyless = read => ({ ...read, ...(Array.isArray(read?.rows) ? { rows: read.rows.map(row => (Array.isArray(row) ? row.map(unhandled) : row)) } : {}),
  ...(Array.isArray(read?.groups) ? { groups: read.groups.map(group => (Array.isArray(group) ? group.map(unhandled) : group)) } : {}) });
// A kept MCP result (the final answer of a detached call) carries its answer twice: structuredContent and the same JSON as the
// text of a content part; the guard reads that text as the JSON it is, with its keys.
const textParts = value => (Array.isArray(value) ? value.map(textParts) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'text' && value.type === 'text' && typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return v; } })() : textParts(v)]))
  : value);
const guard = read => shown(findings(textParts(keyless(read))));

async function session(exposure, extra = {}, deps = {}) {
  const { createSsamServer } = await import('../ssam.mjs');
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { Client } = await import('@modelcontextprotocol/client');
  const store = extra.store ?? servedBytesStore({ dir: fs.mkdtempSync(path.join(tmp, 'day-')) });
  const server = await createSsamServer({ profile: 'all', deps: { ...deps, exposure: { profile: exposure, caller: () => 'origin-' + exposure + '-' + process.pid, ...extra, store } } });
  const client = new Client({ name: 'no-internals-origin', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const once = async (name, args) => { const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 }); return r.structuredContent ?? JSON.parse(r.content[0].text); };
  // a call the deadline detached is followed with continueTask to its final answer
  const follow = async body => {
    for (let i = 0; i < 120; i++) {
      const next = [body?.continuation, body?.next].find(c => c && typeof c === 'object' && c.arguments && Object.hasOwn(c.arguments, 'continueTask'));
      if (!next) break;
      await sleep(500);
      body = await once(next.tool, next.arguments);
    }
    return body;
  };
  const call = async (name, args) => follow(await once(name, args));
  return { once, call, follow, store, close: async () => { await client.close(); await server.close(); } };
}
const referenceFileOf = async s => {
  const first = await s.call('ssam_reference', { lane: 'o11', kind: 'recipe', query: 'timer' });
  const file = first.continuation?.arguments?.file;
  assert.ok(file && fs.existsSync(file), JSON.stringify(first).slice(0, 300));
  return file;
};
const dayShut = async s => {
  await s.call('ssam_reference', { lane: 'o11', kind: 'recipe', query: 'timer' });
  assert.equal((await s.call('ssam_reference', { lane: 'o11', kind: 'recipe', query: 'timer' })).code, 'REFERENCE_DAY_LIMIT');
};

// ---- MEDIUM 1: the name of the argument is the tool's, never the hub's guess
const forms = file => [['File', { File: file }], ['FILE', { FILE: file }], ['files', { files: file }], ['fi_le', { fi_le: file }]];
test('live: a reference file named by File, FILE, files or fi_le is documentation under the day and refused past it (MEDIUM 1)', { skip, timeout: 900000 }, async () => {
  const open = await session('licensee');
  try {
    const file = await referenceFileOf(open);
    for (const [label, args] of forms(file)) {
      const page = await open.call('ssam_evidence', { ...args, budgetBytes: 28672 });
      assert.equal(page.ok, true, label + ' ' + JSON.stringify(page).slice(0, 200));
      assert.deepEqual(guard(page), [], label);
    }
  } finally { await open.close(); }
  const shut = await session('licensee', { dayBytes: 3000 });
  try {
    const file = await referenceFileOf(shut);
    assert.equal((await shut.call('ssam_reference', { lane: 'o11', kind: 'recipe', query: 'timer' })).code, 'REFERENCE_DAY_LIMIT');
    for (const [label, args] of forms(file)) assert.equal((await shut.call('ssam_evidence', { ...args, budgetBytes: 28672 })).code, 'REFERENCE_DAY_LIMIT', label);
  } finally { await shut.close(); }
});

// ---- LOW 1: a continuation is the call that detached
test('live: a job check that detached past the day reaches its final answer, counted as a check (LOW 1)', { skip, timeout: 900000 }, async () => {
  const s = await session('licensee', { dayBytes: 3000 }, { callDeadlineMs: 1 });
  try {
    await dayShut(s);
    const check = { lane: 'o11', kind: 'check-job', query: { description: 'x', ops: [] } };
    const first = await s.once('ssam_reference', check);
    assert.equal(first.state, 'running', 'the check detached (deadline 1 ms): ' + JSON.stringify(first).slice(0, 200));
    const final = await s.follow(first);
    assert.notEqual(final.code, 'REFERENCE_DAY_LIMIT', JSON.stringify(final).slice(0, 300));
    assert.notEqual(final.state, 'running');
    const callers = Object.values(s.store.day().callers ?? {});
    assert.ok(callers.some(tools => (tools['ssam_reference:check']?.calls ?? 0) >= 2), 'the continuation is counted in the meter of the check: ' + JSON.stringify(callers));
  } finally { await s.close(); }
});

// ---- MEDIUM 2: a kept answer is read back under the rule of the tool that answered
// Every shape of the reader on one file: the whole value, a tree listing, a table, a projection, a count, a filter.
const shapes = file => [['whole', { file, budgetBytes: 28672 }], ['deep', { file, deep: true, budgetBytes: 28672 }],
  ['table', { file, deep: true, table: true, budgetBytes: 28672 }], ['fields', { file, deep: true, fields: ['path', 'root', 'file', 'cli', 'studioDir', 'directory'], budgetBytes: 28672 }],
  ['groupBy', { file, deep: true, groupBy: 'path', budgetBytes: 28672 }], ['where', { file, deep: true, where: 'path ~ \\', budgetBytes: 28672 }]];
const readsOf = async (s, file) => { const out = []; for (const [label, args] of shapes(file)) out.push([label, await s.call('ssam_evidence', args)]); return out; };
// A read that names no filter answers ok; a filter or a count may refuse (no row has the field), its echo still clean.
const mustAnswer = label => /^(?:whole|deep|table|fields|omitted|continuation)\b/.test(label);
test('live: the omitted part of ssam_doctor is read back as a state report, in every shape of the reader (MEDIUM 2)', { skip, timeout: 900000 }, async () => {
  const out = {};
  for (const exposure of ['owner', 'licensee']) {
    const s = await session(exposure);
    try {
      out[exposure] = [];
      for (const args of [{}, { lane: 'odc' }]) {
        const doctor = await s.call('ssam_doctor', args);
        const file = doctor.omitted?.arguments?.file;
        assert.ok(file && fs.existsSync(file), exposure + ' ' + JSON.stringify(args) + ' ' + JSON.stringify(doctor).slice(0, 300));
        const calls = [doctor.omitted, ...(doctor.omitted.more ?? [])];
        for (const call of calls) out[exposure].push(['omitted ' + JSON.stringify(args) + ' ' + JSON.stringify(call.arguments).slice(-60), await s.call(call.tool, call.arguments)]);
        for (const [label, read] of await readsOf(s, file)) out[exposure].push([label + ' ' + JSON.stringify(args), read]);
      }
    } finally { await s.close(); }
  }
  assert.ok(out.owner.some(([, read]) => findings(read).length), 'the owner pages carry server paths (the test is not vacuous)');
  for (const [label, read] of out.licensee) {
    if (mustAnswer(label)) assert.equal(read.ok, true, label + ' ' + JSON.stringify(read).slice(0, 200));
    assert.deepEqual(guard(read), [], label);
  }
});
test('live: a paged answer and the final answer of a detached call are read back under the rule of the tool that answered (MEDIUM 2)', { skip, timeout: 900000 }, async () => {
  // a paged answer (the ceiling held low while it is kept): ssam_doctor (a state report) and ssam_reference rules
  // (documentation); a later session reads the pages
  const pages = [];
  const paging = await session('licensee', {}, { maxAnswerBytes: 600 });
  try {
    for (const [name, args] of [['ssam_doctor', {}], ['ssam_reference', { lane: 'o11', kind: 'rules', query: 'session' }]]) {
      const answer = await paging.call(name, args);
      assert.ok(answer.paged?.file && fs.existsSync(answer.paged.file), name + ' ' + JSON.stringify(answer).slice(0, 300));
      pages.push([name, answer]);
    }
  } finally { await paging.close(); }
  const reader = await session('licensee');
  try {
    for (const [name, answer] of pages) {
      const reads = [['continuation', await reader.call(answer.continuation.tool, answer.continuation.arguments)], ...await readsOf(reader, answer.paged.file)];
      for (const [label, read] of reads) {
        if (mustAnswer(label)) assert.equal(read.ok, true, name + ' ' + label + ' ' + JSON.stringify(read).slice(0, 200));
        assert.deepEqual(guard(read), [], name + ' ' + label);
      }
    }
  } finally { await reader.close(); }
  // the final answer of a detached call, kept for its continuation and named by its task record
  const detached = await session('licensee', { dayBytes: 3000 }, { callDeadlineMs: 1 });
  try {
    const first = await detached.once('ssam_doctor', {});
    assert.equal(first.state, 'running', 'the doctor detached (deadline 1 ms): ' + JSON.stringify(first).slice(0, 200));
    await detached.follow(first);
    const task = (await detached.call('ssam_task', { id: first.task.id })).task;
    assert.ok(task?.answer?.file && fs.existsSync(task.answer.file), JSON.stringify(task).slice(0, 300));
    for (const [label, read] of await readsOf(detached, task.answer.file)) {
      if (mustAnswer(label)) assert.equal(read.ok, true, 'task ' + label + ' ' + JSON.stringify(read).slice(0, 200));
      assert.deepEqual(guard(read), [], 'task ' + label);
    }
    // a kept answer of ssam_reference is the reference: past the day it is refused like a reference file
    const reference = await detached.once('ssam_reference', { lane: 'o11', kind: 'recipe', query: 'timer' });
    assert.equal(reference.state, 'running', JSON.stringify(reference).slice(0, 200));
    await detached.follow(reference);
    const kept = (await detached.call('ssam_task', { id: reference.task.id })).task?.answer?.file;
    assert.ok(kept && fs.existsSync(kept));
    assert.equal((await detached.call('ssam_reference', { lane: 'o11', kind: 'recipe', query: 'timer' })).code, 'REFERENCE_DAY_LIMIT');
    assert.equal((await detached.call('ssam_evidence', { file: kept, budgetBytes: 28672 })).code, 'REFERENCE_DAY_LIMIT');
  } finally { await detached.close(); }
});
