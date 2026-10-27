// Owner rule of 2026-10-15 (every text SSAM emits is English only, no bilingual line), the family M5 of the review of
// server/english-agent: the answers only a hosted server gives, which the licensee's client reads. The real functions
// are called with synthetic inputs and every string of their answers is checked with the detector of
// fixtures/portuguese.mjs (no accented letter, none of its Portuguese words, no "English. / Portuguese" line):
//   - hosted/network-check.mjs: every verdict of summarizeProbes (and each of its forms), the refusals of networkCheck,
//     and the message and continuation.why of uploadsHint;
//   - hosted/destructive.mjs: destructiveUnavailable of every tool it refuses (the general delete refusal and the
//     o11_access apply one), and the detail (with the RECIPE) of hostedDestructiveFiles;
//   - hosted/policy.mjs: prototypeUnavailable, generatorUnavailable and verifiedPatchUnavailable;
//   - ssam.mjs: the hosted doctor (the continuation of an account without a lane, laneContinuation of a lane with other
//     versions, a closed Studio and an open one), HOSTED_RESTART_NEXT and the local answer to network:true;
//   - agent-paths.mjs outsideWorkspaceRefusal and the PATH_OUTSIDE_WORKSPACE continuation (continuations.mjs).
// Then a static floor: every string literal of hosted/*.mjs and agent-paths.mjs. The structured values of the network check
// are English since the owner's decision of 2026-10-19 (they were 'boa' | 'lenta' | 'perde' and 'desconhecida'): paths[].status
// 'good' | 'slow' | 'losing' and the exit key 'unknown' (UNKNOWN_EXIT); the one Portuguese literal left is the input alias
// LEGACY_UNKNOWN_EXIT ('desconhecida', an older answer's exit, read as unknown and never answered). The markers that stand for
// withheld data are English since phase 3 of the a7 line
// (Integradora, by the owner rule of 15/10): '<server>' (a path of the server, hosted/policy.mjs SERVER_MARK),
// '<customer omitted>' and '<fixture omitted>' (hosted/evidence.mjs). studio-identity.mjs is translated on
// feat/studio-build-identity and is not checked here.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { portuguese, BILINGUAL } from './fixtures/portuguese.mjs';
import { summarizeProbes, networkCheck, uploadsHint } from '../hosted/network-check.mjs';
import { destructiveUnavailable, hostedDestructiveFiles, HOSTED_OFF } from '../hosted/destructive.mjs';
import { prototypeUnavailable, generatorUnavailable, verifiedPatchUnavailable } from '../hosted/policy.mjs';
import { hostedDoctor, HOSTED_RESTART_NEXT } from '../ssam.mjs';
import { outsideWorkspaceRefusal } from '../agent-paths.mjs';
import { CONTINUATIONS } from '../continuations.mjs';

const facade = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The exit key of an upload whose address the hub could not read (network-check.mjs UNKNOWN_EXIT, agent-hub.mjs maskAddress).
const UNKNOWN_EXIT = 'unknown';
// The input alias of an older answer's exit (network-check.mjs LEGACY_UNKNOWN_EXIT): recognized only, never answered.
const LEGACY_UNKNOWN_EXIT = 'desconhecida';
const STATUSES = ['good', 'slow', 'losing'];
// No structured value of an answer is exempt any more: every one of them is English (owner decision of 2026-10-19).
const DATA = [];
// The literals of the source that are no text: the input alias only (the markers of withheld data are English).
const MARKERS = [LEGACY_UNKNOWN_EXIT];

test('the network statuses and the unknown exit are English; the older exit is only an input alias; the markers are English', async () => {
  const { UNKNOWN_EXIT: exit, LEGACY_UNKNOWN_EXIT: legacy } = await import('../hosted/network-check.mjs');
  const { SERVER_MARK } = await import('../hosted/policy.mjs');
  const { OMITTED, CLIENT_OMITTED } = await import('../hosted/evidence.mjs');
  assert.equal(exit, UNKNOWN_EXIT);
  assert.equal(legacy, LEGACY_UNKNOWN_EXIT);
  const source = fs.readFileSync(path.join(facade, 'hosted', 'network-check.mjs'), 'utf8');
  assert.deepEqual([...source.matchAll(/status: stalled \? '(\w+)' : slow \? '(\w+)' : '(\w+)'/g)].flatMap(m => m.slice(1)), ['losing', 'slow', 'good']);
  assert.deepEqual([...STATUSES, UNKNOWN_EXIT, SERVER_MARK, OMITTED, CLIENT_OMITTED].map(portuguese).flat(), []);
  // the only place the alias appears in the source is where it is read as UNKNOWN_EXIT
  assert.equal(source.split("'" + LEGACY_UNKNOWN_EXIT + "'").length - 1, 1, 'the alias is declared once');
});

function strings(value, at = '', out = []) {
  if (typeof value === 'string') out.push({ at, text: value });
  else if (Array.isArray(value)) value.forEach((item, index) => strings(item, at + '/' + index, out));
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) strings(item, at + '/' + key, out);
  return out;
}
// Every finding of the answers named, in one list: "<name><path>: <tokens> in: <text>".
function findings(answers) {
  const out = [];
  for (const [name, answer] of Object.entries(answers))
    for (const { at, text } of strings(answer)) {
      if (DATA.some(([pattern, values]) => pattern.test(at) && values.includes(text))) continue;
      const found = portuguese(text);
      if (found.length) out.push(`${name}${at}: ${[...new Set(found)].join(', ')} in: ${text.slice(0, 200)}`);
      if (BILINGUAL.test(text)) out.push(`${name}${at}: a bilingual line: ${text.slice(0, 200)}`);
    }
  return out;
}

// ---- hosted/network-check.mjs
const id = n => n.toString(16).padStart(32, '0');
let next = 0;
const probe = (bytes, ms, ok, via) => ({ id: id(++next), bytes, ms, ok, status: ok ? 200 : undefined, via });
const recordsOf = (probes, { stalled = [] } = {}) => probes.filter(p => p.ok || stalled.includes(p.id) || p.reach)
  .map(p => ({ id: p.id, via: p.via, received: p.ok ? p.bytes : 4096, complete: p.ok, ms: p.ms }));
const summary = (probes, options) => summarizeProbes(probes.map(({ via, reach, ...p }) => p), recordsOf(probes, options));
const A = '203.0.113.x', B = '198.51.100.x', C = '192.0.2.x';
function verdicts() {
  const smalls = (via, n, ms = 90) => Array.from({ length: n }, () => probe(1024, ms, true, via));
  const large = (via, ms = 900) => probe(1048576, ms, true, via);
  const stall = via => ({ ...probe(1048576, 4500, false, via), reach: true });
  const lost = via => probe(1024, 3000, false, via);
  const out = {};
  out.noProbes = summarizeProbes([], []);
  out.newConnectionsFailOne = summary([...smalls(A, 3), lost(A)]);
  out.newConnectionsFailMany = summary([...smalls(A, 2), lost(A), lost(B)]);
  out.oneExitLossy = summary([...smalls(A, 2), large(A), ...smalls(B, 2), stall(B)]);
  out.someExitsLossy = summary([...smalls(A, 2), large(A), ...smalls(C, 2), probe(1048576, 600, true, C), ...smalls(B, 2), stall(B), smalls('203.0.113.y', 1)[0], stall('203.0.113.y')]);
  out.unknownExitLossy = summary([...smalls(A, 2), large(A), ...smalls(undefined, 2), stall(undefined)]);
  out.uploadsLossyOneExit = summary([...smalls(A, 3), stall(A)]);
  out.uploadsLossyExits = summary([...smalls(A, 3), stall(A), ...smalls(B, 3), probe(1048576, 9000, true, B)]);
  out.slowLarge = summary([...smalls(A, 3), probe(1048576, 4200, true, A)]);
  out.slowSmall = summary(smalls(A, 3, 2500));
  out.okBoth = summary([...smalls(A, 3, 80), large(A, 400)]);
  out.okLargeOnly = summary([large(A, 400), large(A, 500)]);
  out.okSmallOnly = summary(smalls(A, 3, 80));
  out.okExitsUnreached = summary([...smalls(A, 4), ...smalls(B, 4), large(A), large(B), lost(A)]);
  out.okUnreachedTwo = summary([...smalls(A, 6), large(A), large(A), lost(A), lost(A)]);
  return out;
}

test('network check: every verdict and form of summarizeProbes, the refusals of networkCheck and uploadsHint are English', async () => {
  const all = verdicts();
  assert.deepEqual(Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v.verdict])), {
    noProbes: 'no-probes', newConnectionsFailOne: 'new-connections-fail', newConnectionsFailMany: 'new-connections-fail',
    oneExitLossy: 'one-exit-lossy', someExitsLossy: 'one-exit-lossy', unknownExitLossy: 'one-exit-lossy', uploadsLossyOneExit: 'uploads-lossy',
    uploadsLossyExits: 'uploads-lossy', slowLarge: 'slow', slowSmall: 'slow', okBoth: 'ok', okLargeOnly: 'ok', okSmallOnly: 'ok',
    okExitsUnreached: 'ok', okUnreachedTwo: 'ok' }, 'the inputs reach every verdict');
  assert.ok(all.unknownExitLossy.paths.some(p => p.via === UNKNOWN_EXIT), 'an exit the hub could not read keeps its key');
  const link = over => ({ connected: () => true, supports: () => true, info: () => ({ agentVersion: '0.3.1' }),
    call: async () => ({ probes: [] }), probes: () => [], ...over });
  all.notConnected = await networkCheck(link({ connected: () => false }));
  all.kindMissing = await networkCheck(link({ supports: () => false }));
  all.kindMissingNoVersion = await networkCheck(link({ supports: () => false, info: () => null }));
  all.agentError = await networkCheck(link({ call: async () => { throw Object.assign(new Error('the call timed out'), { code: 'AGENT_TIMEOUT' }); } }));
  all.ran = await networkCheck(link());
  const hint = recent => uploadsHint({ uploads: () => ({ parts: 5, slow: recent.length || 1, recent }) });
  all.hintOne = hint([{ bytes: 70000, ms: 21000, via: B }]);
  all.hintMany = hint([{ bytes: 70000, ms: 21000, via: B }, { bytes: 2200000, ms: 135000, via: UNKNOWN_EXIT }]);
  all.hintNoVia = hint([{ bytes: 2048, ms: 1500 }]);
  all.hintNoWorst = uploadsHint({ uploads: () => ({ parts: 2, slow: 1, recent: [] }) });
  assert.deepEqual([all.notConnected.code, all.kindMissing.code, all.agentError.code, all.ran.ran, all.hintOne.code], ['AGENT_NOT_CONNECTED', 'AGENT_KIND_MISSING', 'AGENT_TIMEOUT', true, 'UPLOADS_SLOW']);
  assert.deepEqual(findings(all), []);
});

// ---- hosted/destructive.mjs
test('destructive: the refusal of every tool it refuses and the detail of a manifest with revokes are English', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-hosted-english-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manifest = (name, text) => { const file = path.join(dir, name); fs.writeFileSync(file, text); return file; };
  const answers = Object.fromEntries([...Object.keys(HOSTED_OFF), 'o11_access', 'some_tool_delete'].map(name => [name, destructiveUnavailable(name)]));
  const one = hostedDestructiveFiles('o11_access', { action: 'apply', manifestPath: manifest('one.json', JSON.stringify({ entries: [{ action: 'revoke', user: 'u', role: 'R' }] })) });
  const two = hostedDestructiveFiles('o11_access', { action: 'apply', manifestPath: manifest('two.json', JSON.stringify({ entries: [{ action: 'revoke' }, { action: 'Remove' }, { action: 'grant' }] })) });
  const unreadable = hostedDestructiveFiles('o11_access', { action: 'apply', manifestPath: manifest('bad.json', '{"entries": [') });
  assert.deepEqual([one.revokes, two.revokes, unreadable.revokes], [1, 2, null]);
  answers['o11_access with the files'] = destructiveUnavailable('o11_access', one);
  Object.assign(answers, { one, two, unreadable });
  assert.match(answers.o11_access.error, /^Applying access changes/);
  assert.match(answers.odc_asset_delete.error, /^Deleting \(/);
  assert.match(one.detail, /an o11_access apply with grants only still works here/);
  assert.deepEqual(findings(answers), []);
});

// ---- hosted/policy.mjs
test('policy: the prototype, generator and verified patch refusals are English, with their continuations', () => {
  const answers = {
    prototypeOdc: prototypeUnavailable('ssam_job', 'odc'), prototypeO11: prototypeUnavailable('o11_job', 'o11'),
    restConsume: generatorUnavailable('ssam_job', 'odc', 'rest-consume'), genScreen: generatorUnavailable('o11_job', 'o11', 'gen-screen'),
    crud: generatorUnavailable('studio_deliver', 'odc', 'gen-crud'), unreadable: generatorUnavailable('ssam_job', 'odc', 'unreadable'),
    verified: verifiedPatchUnavailable('ssam_job', 'odc', { lane: 'odc', basedOn: 'ws:jobs/a.json', patch: 'verified' }),
    verifiedQuery: verifiedPatchUnavailable('ssam_reference', 'odc', { kind: 'check-job', query: { basedOn: 'ws:jobs/a.json', patch: 'verified' } }, '/query/patch'),
    fixApply: verifiedPatchUnavailable('o11_deliver', 'o11', { module: 'M', basedOn: { job: 'ws:o11/jobs/a.json', sha256: 'a'.repeat(64) }, fix: 'apply' }, '/fix'),
  };
  for (const [name, answer] of Object.entries(answers)) assert.equal(answer.code, 'HOSTED_UNAVAILABLE', name);
  assert.deepEqual(findings(answers), []);
});

// ---- ssam.mjs: the hosted doctor
function doctorCall({ lanes, compatible = null, open = true, network = false, link: over = {} }) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-hosted-english-ws-'));
  const link = { connected: () => true, supports: () => true, call: async () => ({ probes: [] }), probes: () => [], uploads: () => null,
    info: () => ({ credential: true, instance: 'i-1', agentVersion: '0.3.1', kernel: { o11: '11.55.92', odc: '1.7.28', odcBridge: 'v97' },
      compatible, studios: null, agentRoot: 'C:\\SSAM-Agent' }), ...over };
  const executor = { o11Connection: () => null, quota: { full: () => false },
    call: async (kind, params) => (kind === 'studio.processes' ? { processes: open ? [{ pid: 4120, path: 'C:\\Studio\\' + params.image, version: '1.7.28.4021' }] : [] } : {}) };
  const context = { id: 'ctx', hosted: true, tokenId: 'tok_test', customer: 'Test', lanes, workspace, agent: link, executor, close: async () => {} };
  return hostedDoctor(null, { context, session: { agent: link } }, { network })
    .finally(() => fs.rmSync(workspace, { recursive: true, force: true }));
}

test('ssam.mjs: the hosted doctor, HOSTED_RESTART_NEXT and the local network:true answer are English', async () => {
  const answers = {
    noLane: await doctorCall({ lanes: [] }),
    otherVersions: await doctorCall({ lanes: ['odc'], compatible: { odc: { ok: false, code: 'STUDIO_VERSION_DIFFERS', message: 'The ODC Studio 1.7.27 of this computer is not the 1.7.28 this server serves.' } } }),
    otherVersionsBare: await doctorCall({ lanes: ['odc'], compatible: { odc: { ok: false } } }),
    studioClosed: await doctorCall({ lanes: ['odc'], compatible: { odc: { ok: true } }, open: false }),
    studioOpen: await doctorCall({ lanes: ['odc'], compatible: null }),
    o11NotConnected: await doctorCall({ lanes: ['o11'], compatible: { o11: { ok: true } } }),
    network: await doctorCall({ lanes: ['odc'], compatible: { odc: { ok: true } }, network: true, link: { supports: () => false } }),
    uploadsHint: await doctorCall({ lanes: ['odc'], compatible: { odc: { ok: true } }, link: { uploads: () => ({ parts: 3, slow: 1, recent: [{ bytes: 70000, ms: 21000, via: '198.51.100.x' }] }) } }),
    restart: HOSTED_RESTART_NEXT,
  };
  assert.equal(answers.noLane.continuation.tool, 'ssam_doctor');
  assert.equal(answers.otherVersions.continuation.tool, 'ssam_doctor');
  assert.ok(answers.otherVersions.continuation.why.startsWith('The ODC Studio 1.7.27 of this computer'), 'the compatibility message comes first');
  assert.notEqual(answers.otherVersionsBare.continuation.why, answers.otherVersions.continuation.why, 'without a message, the fallback words');
  assert.deepEqual([answers.studioClosed.continuation.tool, answers.studioOpen.continuation.tool], ['ssam_connect', 'ssam_connect']);
  assert.notEqual(answers.studioClosed.continuation.why, answers.studioOpen.continuation.why);
  assert.equal(answers.network.network.code, 'AGENT_KIND_MISSING');
  assert.equal(answers.uploadsHint.network.code, 'UPLOADS_SLOW');
  // The local answer to network:true (createSsamServer, not hosted), read from its source: one literal next to NOT_HOSTED.
  const source = fs.readFileSync(path.join(facade, 'ssam.mjs'), 'utf8');
  const at = source.indexOf("code: 'NOT_HOSTED'");
  assert.ok(at > 0, 'the NOT_HOSTED answer of the local doctor');
  answers.localNetwork = /message: '((?:[^'\\]|\\.)*)'/.exec(source.slice(at, at + 400))?.[1];
  assert.ok(answers.localNetwork);
  assert.deepEqual(findings(answers), []);
});

// ---- agent-paths.mjs and the PATH_OUTSIDE_WORKSPACE continuation
test('agent paths: the PATH_OUTSIDE_WORKSPACE refusal and its continuation are English', () => {
  const answers = {
    inline: outsideWorkspaceRefusal('C:\\Users\\x\\job.json', { agentRoot: 'C:\\SSAM-Agent', tool: 'studio_deliver', args: { module: 'Shop' } }),
    file: outsideWorkspaceRefusal('C:\\Users\\x\\Quotes.oml', { agentRoot: 'C:\\SSAM-Agent', tool: 'o11_deliver', args: {}, field: 'oml' }),
    noTool: outsideWorkspaceRefusal('C:\\Users\\x\\a.json', { agentRoot: 'C:\\SSAM-Agent' }),
    noRoot: outsideWorkspaceRefusal('C:\\Users\\x\\a.json', { tool: 'ssam_job' }),
    continuation: CONTINUATIONS.PATH_OUTSIDE_WORKSPACE,
  };
  assert.deepEqual(findings(answers), []);
});

// ---- static floor: every string literal of the hosted modules
test('static: every string literal of hosted/*.mjs and agent-paths.mjs is English (the declared data values aside)', () => {
  const files = [...fs.readdirSync(path.join(facade, 'hosted')).filter(n => n.endsWith('.mjs')).map(n => path.join('hosted', n)), 'agent-paths.mjs'];
  const out = [];
  for (const file of files) {
    fs.readFileSync(path.join(facade, file), 'utf8').split(/\r?\n/).forEach((line, index) => {
      if (/^\s*\/\//.test(line)) return;
      for (const m of line.replace(/\s\/\/ .*$/, '').matchAll(/'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`|"((?:[^"\\]|\\.)*)"/g)) {
        const literal = m[1] ?? m[2] ?? m[3];
        if (MARKERS.includes(literal)) continue;
        const found = portuguese(literal);
        if (found.length) out.push(`${file}:${index + 1}: ${[...new Set(found)].join(', ')} in: ${literal.slice(0, 160)}`);
        if (BILINGUAL.test(literal)) out.push(`${file}:${index + 1}: a bilingual line: ${literal.slice(0, 160)}`);
      }
    });
  }
  assert.deepEqual(out, []);
});
