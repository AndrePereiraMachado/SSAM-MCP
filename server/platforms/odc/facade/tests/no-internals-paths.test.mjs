import './fixtures/isolated-profile.mjs';
// marco-a6, the family "no server path reaches a licensee" (the Integradora, 19/10): an answer a licensee is served names a
// path of the server only as a handle the next call takes back (a job, an out, a result, a capture, a receipt file...: under
// the server's .local, in any key since review marco-a6 B1, or in the arguments of a call) or as the very path the caller sent
// in that call. Any other path of the server (a root itself, a folder outside the roots, a temp or customers folder) is
// <server>, and a list that held only such paths is left out. The three of the integration: the roots of an OUTSIDE_ROOTS
// refusal of ssam_evidence, patchedJob of X3 (since review marco-a6 B1 out of a licensee's answer whole: nextBasedOn is the
// same job) and the "the part , whole" of an omitted root.
// The scan is generic: every string of every licensee answer of the calls below, by the rule above, whatever its key.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exposedResult } from '../exposure.mjs';
import { missingCall } from '../paged-answer.mjs';

const SERVER_PATH = /(?<![\w])[A-Za-z]:[\\/][^\s"'`<>|]*|\\\\[\w.$-]+\\[^\s"'`]*|(?<![\w.:/~-])\/(?:studio|opt|srv|var|home|root|usr|mnt|app|customers|tmp|workspace|Users|data\/(?:server|cache|friction|odc-features))\/[^\s"'`]*/g;
const DATA_KEYS = new Set(['records', 'rows', 'data', 'items', 'values', 'elements', 'nodes', 'children', 'properties', 'body']);
const isCall = v => v && typeof v === 'object' && !Array.isArray(v) && typeof v.tool === 'string' && v.arguments && typeof v.arguments === 'object';
// Every path of the server in a licensee answer that is no handle and no path the caller sent: [] when the family holds.
export function serverPaths(value, { roots, sent = [] }, at = '', key = null) {
  const below = p => roots.some(r => p.toLowerCase().startsWith(r.toLowerCase() + '\\') && !/[\\/](?:cli|test-work|discovery|readers|builder|bin|obj)(?:[\\/]|$)/i.test(p.slice(r.length)));
  if (typeof value === 'string') {
    const whole = value.trim();
    // (review marco-a6 B1: a handle is any path under a root, in any key)
    if (sent.includes(whole) || below(whole)) return [];
    return [...value.matchAll(SERVER_PATH)].map(m => at + ': ' + m[0].slice(0, 140));
  }
  if (Array.isArray(value)) return value.flatMap((v, i) => serverPaths(v, { roots, sent }, at + '/' + i, key));
  // the arguments of a call, the job a next call is based on and a patch are taken back as they are; the customer's records
  // (rows, records, data...) are the customer's, whatever text they hold
  if (value && typeof value === 'object')
    return Object.entries(value).flatMap(([k, v]) => (k === 'arguments' && isCall(value)) || ['nextBasedOn', 'basedOn', 'patch'].includes(k) || DATA_KEYS.has(k)
      ? [] : serverPaths(v, { roots, sent }, at + '/' + k, k));
  return [];
}
const roots = ['C:\\srv\\ssam\\kernel\\.local'];
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const licensee = (tool, value, args = {}) => exposedResult(result(value), { exposure: 'licensee', handleRoots: roots, tool, args }).structuredContent;

test('the scan catches every kind of server path (the scan is not vacuous)', () => {
  const answer = { ok: false, roots: ['C:\\srv\\ssam\\kernel\\.local'], sourceDirectory: 'C:\\srv\\ssam\\kernel\\.local\\jobs\\inline',
    patchedJob: { path: 'C:\\srv\\ssam\\kernel\\.local\\jobs\\a.oml.patched-job.json' }, workDir: '/data/server/customers/acme/work',
    temp: 'C:\\Users\\svc\\AppData\\Local\\Temp\\x.json', checks: ['C:\\srv\\ssam\\kernel\\.local\\answers\\a.json'] };
  // the root itself, the customers folder and the temp file (since review marco-a6 B1 a path under a root is a handle in any
  // key: the sidecar's folder, the corrected job and the checked answer are handles)
  assert.equal(serverPaths(answer, { roots }).length, 3);
  assert.deepEqual(serverPaths({ job: 'C:\\srv\\ssam\\kernel\\.local\\jobs\\inline\\a.json', receiptFile: 'C:\\srv\\ssam\\kernel\\.local\\data\\loads\\x\\receipt.json',
    files: [{ path: 'C:\\in\\orders.csv' }], continuation: { tool: 'ssam_evidence', arguments: { file: 'C:\\srv\\ssam\\kernel\\.local\\answers\\a.json' } } },
    { roots, sent: ['C:\\in\\orders.csv'] }), [], 'handles, the caller\'s own path and the arguments of a call');
});

test('the licensee rule leaves only handles and the caller\'s own paths; a list of server paths is left out', () => {
  const sent = 'C:\\in\\orders.csv';
  const answer = { ok: true, job: 'C:\\srv\\ssam\\kernel\\.local\\jobs\\inline\\a.json', receiptFile: 'C:\\srv\\ssam\\kernel\\.local\\data\\loads\\x\\receipt.json',
    nextBasedOn: { job: 'C:\\srv\\ssam\\kernel\\.local\\jobs\\inline\\a.json', sha256: 'a'.repeat(64) },
    patchedJob: { path: 'C:\\srv\\ssam\\kernel\\.local\\jobs\\a.oml.patched-job.json', sha256: 'b'.repeat(64),
      source: { path: 'C:\\srv\\ssam\\kernel\\.local\\jobs\\a.oml.patched-job.json.source.json', sha256: 'c'.repeat(64) } },
    updatedRows: [{ file: sent, row: 2 }], workDir: '/data/server/customers/acme/work', manifest: 'C:\\srv\\ssam\\platforms\\odc\\lab\\x\\manifest.json',
    checks: ['C:\\srv\\ssam\\kernel\\.local\\answers\\a.json', 'module index current'], roots: ['C:\\srv\\ssam\\kernel\\.local', 'D:\\cache\\ssam'],
    rows: [{ Code: 'A', Path: 'C:\\customer\\file.txt' }],
    continuation: { tool: 'ssam_evidence', arguments: { file: 'C:\\srv\\ssam\\kernel\\.local\\answers\\a.json' }, why: 'the receipt' } };
  const out = licensee('o11_data', answer, { request: { files: [sent] } });
  assert.deepEqual(serverPaths(out, { roots, sent: [sent] }), []);
  assert.equal(out.job, answer.job); assert.equal(out.receiptFile, answer.receiptFile); assert.deepEqual(out.nextBasedOn, answer.nextBasedOn);
  assert.equal(out.updatedRows[0].file, sent, 'the caller\'s own file');
  assert.deepEqual(out.rows, answer.rows, 'the customer\'s records are data');
  assert.deepEqual(out.continuation, answer.continuation);
  assert.equal(out.patchedJob, undefined, 'the corrected job goes on through nextBasedOn (review marco-a6 B1)');
  assert.equal(out.roots, undefined, 'a list of server folders says nothing a licensee can use');
  assert.deepEqual(out.checks, answer.checks, 'a handle under a root, in any key (review marco-a6 B1)');
  assert.deepEqual(exposedResult(result(answer), { exposure: 'owner', tool: 'o11_data' }).structuredContent, answer, 'the owner reads it whole');
});

test('the omitted part of an answer whose whole is kept aside says so, never "the part , whole"', () => {
  assert.equal(missingCall('C:\\srv\\ssam\\kernel\\.local\\answers\\a.json', [{ at: '' }]).why, 'the whole answer');
  assert.equal(missingCall('C:\\srv\\ssam\\kernel\\.local\\answers\\a.json', [{ at: '/problems' }]).why, 'the part /problems, whole');
});

// Through the server, licensee: ssam_evidence outside the roots, and an X3 delivery answer with a corrected job and the
// part kept aside, read back as a session reads it.
test('through the server: ssam_evidence outside the roots and a corrected job carry no server path for a licensee', { timeout: 120000 }, async t => {
  const { createSsamServer } = await import('../ssam.mjs');
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { Client } = await import('@modelcontextprotocol/client');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'no-internals-paths-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const jobs = path.join(tmp, '.local', 'jobs');
  fs.mkdirSync(path.join(jobs, 'inline'), { recursive: true });
  const corrected = path.join(jobs, 'a.oml.patched-job.json');
  fs.writeFileSync(corrected, '{"ops":[]}');
  fs.writeFileSync(corrected + '.source.json', JSON.stringify({ jobSha256: 'b'.repeat(64), sourceDirectory: path.join(jobs, 'inline') }));
  const jobTool = async () => ({ ok: true, lane: 'o11', job: corrected, accepted: true, nextBasedOn: { job: corrected, sha256: 'b'.repeat(64) },
    patchesApplied: [{ code: 'HTML_INVALID', pointer: '/ops/0/data/html', patchRule: 'TEXT_LITERAL_QUOTED', reason: 'quoted', from: 'a', to: '"a"', patchSha256: 'd'.repeat(64) }],
    patchedJob: { path: corrected, sha256: 'b'.repeat(64), source: { path: corrected + '.source.json', sha256: 'c'.repeat(64) } } });
  const server = await createSsamServer({ profile: 'all', deps: { jobTool, exposure: { profile: 'licensee', caller: () => 'paths-' + process.pid, handleRoots: [path.join(tmp, '.local')] } } });
  const client = new Client({ name: 'no-internals-paths', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await server.close(); });
  const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); return r.structuredContent ?? JSON.parse(r.content[0].text); };
  const serverRoots = [path.join(tmp, '.local')];
  const outside = await call('ssam_evidence', { file: path.join(tmp, 'elsewhere', 'x.json') });
  assert.equal(outside.code, 'OUTSIDE_ROOTS', JSON.stringify(outside).slice(0, 300));
  assert.deepEqual(serverPaths(outside, { roots: serverRoots, sent: [path.join(tmp, 'elsewhere', 'x.json')] }), []);
  assert.equal(outside.roots, undefined);
  assert.ok(outside.continuation?.arguments?.file, 'the refusal still says what to pass');
  const delivered = await call('ssam_job', { lane: 'o11', job: { ops: [] } });
  assert.deepEqual(serverPaths(delivered, { roots: serverRoots }), [], JSON.stringify(delivered).slice(0, 600));
  assert.equal(delivered.nextBasedOn?.job, corrected, 'the corrected job continues through nextBasedOn');
  const sidecar = await call('ssam_evidence', { file: corrected + '.source.json' });
  assert.deepEqual(serverPaths(sidecar, { roots: serverRoots, sent: [corrected + '.source.json'] }), [], JSON.stringify(sidecar).slice(0, 400));
});
