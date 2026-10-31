// The family of a cut merge, end to end (reviews G1, G11, G12, G15, G16, G21-G24, G27): every way a merge can be cut, every thing that may
// really have happened in the Studios, and two sessions: one that does what each answer says, and one that also keeps sending the same
// job, the mistake the check exists for. The count: a job is never applied over a module that already holds any of it, whatever the
// session does. What stops it is the check of the base sha (merge-cut.mjs and the bridge's own, modelled here as StartupHook.cs Run does
// it); the apply never refuses, the answers build no delivery, and a mutation of the check fails here.
// Offline: real deliverKernel, compactDelivery, publishWithGrant and reconcileMerge; fake Studios and a fake content proof.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deliverKernel } from '../kernel-delivery.mjs';
import { compactDelivery } from '../responses.mjs';
import { publishWithGrant } from '../studio-publish-log.mjs';
import { reconcileMerge } from '../merge-reconcile.mjs';

const MODULE = 'Fixture', KEY = 'k-fixture', HOST = 'fixture.test', PID = 5150, OTHER = 6160;
const hash = text => createHash('sha256').update(text).digest('hex').toUpperCase();
const contentOf = file => JSON.parse(fs.readFileSync(file, 'utf8')).content;
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function world(t, { order = 'none', truth, cut, restart = 'no', earlierClean = false, publish = false, oldBridge = false, ending = null, noPid = false }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-cut-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const lab = path.join(root, 'lab'); fs.mkdirSync(lab);
  const w = { root, lab, order, truth, cut, restart, pid: PID, studios: new Map([[PID, { content: ['base'], salt: 0, alive: true, applied: 0 }]]),
    runningTicks: 0, reached: { original: 0, repair: 0, other: 0 }, mergesOfCall: 0, doubled: [], published: 0, currentJob: null, states: new Set(), codes: new Set(), answers: [], cutDone: false, deliveries: 0, snapshotsAfterCut: 0, late: null };
  const here = () => w.studios.get(w.pid);
  // The raw sha256 of a capture also moves with the Studio state in the header of the file (header), which the content identity masks: the file here carries no header.
  const shaOf = studio => hash(JSON.stringify(studio.content) + '|' + studio.salt + '|' + (studio.header ?? 0));
  const sha = () => shaOf(here());
  const capture = () => {
    const file = path.join(root, 'capture-' + sha() + '.oml');
    fs.writeFileSync(file, JSON.stringify({ content: here().content, salt: here().salt }));
    return { ok: true, module: MODULE, moduleKey: KEY, host: HOST, developerId: 'dev', sha256: sha(), path: file, capturedAt: new Date().toISOString(), ...(noPid ? {} : { pid: w.pid }) };
  };
  // A job applied over a module that holds any of it: what makes a copy (WfPingPanel2) in a real kernel.
  const land = (studio, file, job) => {
    const adds = contentOf(file).filter(c => c !== 'base');
    // Pass 2 of a merge order is the same application as its pass 1.
    if (job === 'original' && w.mergesOfCall === 1) {
      studio.applied++;
      if (studio.holdsJob) w.doubled.push({ pid: [...w.studios].find(([, s]) => s === studio)?.[0], content: [...studio.content] });
      studio.holdsJob = true;
    }
    for (const c of adds) if (!studio.content.includes(c)) studio.content = [...studio.content, c];
  };
  const landLate = () => {
    const late = w.late; if (!late) return; w.late = null;
    // A merge queued in the Studio: the bridge's own comparison with its base, when its turn comes.
    if (!late.studio.alive || shaOf(late.studio) !== late.baseSha256) return;
    const calls = w.mergesOfCall; w.mergesOfCall = order === 'pass2' ? 2 : 1;
    land(late.studio, late.candidate, 'original');
    w.mergesOfCall = calls;
    late.write('merge-started.json', late.record); late.write('native-return.json', { outcome: 'x', publishInvoked: false });
  };
  const cutNow = () => !ending && (order === 'pass2' ? w.mergesOfCall === 2 : w.mergesOfCall === 1) && !w.cutDone;
  w.studio = async (args, pid) => {
    const [command, argument] = args.map(String);
    if (command === 'status') {
      if (w.truthRunning) { w.runningTicks++; if (w.runningTicks >= 2) w.finishRunning(); }
      return { ok: true, pid: w.pid, modules: [{ name: MODULE, key: KEY, host: HOST, loggedIn: true }], busy: w.truthRunning && w.runningIn === w.pid ? { command: 'merge', since: 'now' } : null };
    }
    if (command === 'snapshot') {
      if (w.truthRunning && w.runningIn === w.pid) throw Object.assign(new Error('The ODC bridge stayed busy for 10 s; a command is still running there'), { code: 'BRIDGE_BUSY', sent: false });
      // The merge that lands after the reading and before the capture of the next delivery (G24).
      if (truth === 'late' && w.cutDone && ++w.snapshotsAfterCut === 2) landLate();
      return capture();
    }
    if (command === 'authorize') return { ok: true };
    if (command === 'publish') { if (ending === 'publish-failed') return { ok: false, error: 'Publication of Fixture ended in state Failed' }; w.published++; return { ok: true, module: MODULE, published: { revision: 7 }, completedAt: 'now' }; }
    if (command !== 'merge') return { ok: true };
    // The merge that lands between the capture of a delivery and its merge.
    if (truth === 'late-before-merge' && w.cutDone) landLate();
    w.mergesOfCall++;
    const job = w.currentJob;
    const document = readJson(argument);
    const evidence = document.evidenceDir;
    const candidate = document.candidatePath;
    const write = (name, value) => { if (cut !== 'hosted-blind') { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, name), JSON.stringify(value)); } };
    const startedRecord = { at: new Date().toISOString(), pid: w.pid, module: MODULE };
    // The bridge, in this order (StartupHook.cs Run): the expected sha, the comparison with the base, then the hand-off.
    if (!oldBridge && document.expectedBaseSha256 && document.expectedBaseSha256 !== sha()) return { ok: false, error: 'MODULE_NOT_AT_BASE: the open module ' + MODULE + ' (sha256 ' + sha() + ') is not the module this delivery was checked against (sha256 ' + document.expectedBaseSha256 + '); nothing was merged.' };
    if (document.baseSha256 !== sha()) return { ok: false, error: 'Open ' + MODULE + ' differs from the captured base; capture a new snapshot and rebuild the candidate.' };
    w.reached[job]++;
    // A merge that ended, with a known answer: no cut.
    if (job === 'original' && (ending === 'security' || ending === 'incomplete') && !w.ended) {
      w.ended = true;
      fs.mkdirSync(evidence, { recursive: true });
      fs.writeFileSync(path.join(evidence, 'merge-started.json'), JSON.stringify(startedRecord));
      land(here(), candidate, job);
      fs.writeFileSync(path.join(evidence, 'native-return.json'), JSON.stringify({ outcome: 'x', publishInvoked: false }));
      if (ending === 'security') return { ok: false, code: 'MERGE_SECURITY_WARNING', merged: true, blocking: [{ message: 'A new security warning' }], error: 'The merge brought a new security warning.' };
      fs.writeFileSync(path.join(evidence, 'incomplete-receipt.json'), JSON.stringify({ ok: false, merged: true }));
      return { ok: false, code: 'MERGE_INCOMPLETE', outcome: 'incomplete', merged: true, missing: [], error: 'The merge kept known losses.' };
    }
    if (job === 'original' && cutNow()) {
      w.cutDone = true;
      if (truth === 'abandoned') write('not-started.json', { executed: false, abandoned: true });
      if (truth === 'ended-before') write('last-error.json', { ok: false, error: 'refused before the hand-off', handedOff: false });
      if (truth === 'ran') { write('merge-started.json', startedRecord); land(here(), candidate, job); write('native-return.json', { outcome: 'x', publishInvoked: false }); }
      if (truth === 'threw-in-part') { write('merge-started.json', startedRecord); here().holdsJob = true; here().content = [...here().content, 'part of ' + path.basename(path.dirname(argument))]; write('last-error.json', { ok: false, error: 'native threw', handedOff: true }); }
      if (truth === 'running') { write('merge-started.json', startedRecord); w.truthRunning = true; w.runningIn = w.pid; const studio = here(); studio.holdsJob = true;
        w.finishRunning = () => { w.truthRunning = false; if (studio.alive) { const calls = w.mergesOfCall; w.mergesOfCall = order === 'pass2' ? 2 : 1; if (order !== 'pass2') studio.holdsJob = false; land(studio, candidate, job); w.mergesOfCall = calls; } write('native-return.json', { outcome: 'x', publishInvoked: false }); }; }
      if (truth === 'late' || truth === 'late-before-merge') w.late = { studio: here(), candidate, baseSha256: document.baseSha256, record: startedRecord, write };
      if (cut === 'bridge') return { ok: false, code: 'MERGE_TIMEOUT', outcome: 'uncertain', gate: 'studio_busy', deadlineSeconds: 900, error: "Command 'merge' is still running after 00:15:00; it was not cancelled." };
      const code = cut === 'hosted-blind' ? 'PIPE_REPLY_TIMEOUT' : cut;
      throw Object.assign(new Error('the answer of the merge was lost'), { code, sent: true, ...(cut === 'hosted-blind' ? { evidenceSeen: false } : {}) });
    }
    // Any other merge goes through: the kernel never saves the session in this harness.
    const receiptOf = () => ({ ok: true, merged: true, module: MODULE, strictlyEqual: true, sha256: sha(), equivalence: 'strict' });
    fs.mkdirSync(evidence, { recursive: true });
    fs.writeFileSync(path.join(evidence, 'merge-started.json'), JSON.stringify(startedRecord));
    land(here(), candidate, job);
    fs.writeFileSync(path.join(evidence, 'native-return.json'), JSON.stringify({ outcome: 'x', publishInvoked: false }));
    fs.writeFileSync(path.join(evidence, 'receipt.json'), JSON.stringify(receiptOf()));
    return { ok: true, merged: true, strictlyEqual: true, equivalence: 'strict', sha256: sha() };
  };
  const prove = async ({ expected, actual }) => {
    const want = contentOf(expected), have = contentOf(actual);
    const differences = [...want.filter(c => !have.includes(c)), ...have.filter(c => !want.includes(c))].map(c => ({ element: c, property: 'content' }));
    return { ok: true, proof: { schema: 'ssam-merge-content-proof/1', accepted: differences.length === 0, checked: 1, differences,
      inputs: { expected: { path: expected, sha256: hash(fs.readFileSync(expected)).toLowerCase() }, actual: { path: actual, sha256: path.basename(actual).replace(/^capture-|\.oml$/g, '').toLowerCase() } }, coverage: { complete: true } } };
  };
  const reconcile = (input, more = {}) => reconcileMerge(input, { studio: w.studio, prove, ...more });
  const prepareManifest = async ({ base, candidate, output, feature, owners, changes }) => {
    fs.mkdirSync(output, { recursive: true });
    const copy = path.join(output, 'candidate.oml'); fs.copyFileSync(candidate, copy);
    const manifest = path.join(output, 'manifest.json');
    fs.writeFileSync(manifest, JSON.stringify({ schema: 'odc3-manifest/1', feature, module: MODULE, moduleKey: KEY, tenant: HOST, owners, changes, basePath: base, baseSha256: path.basename(base).replace(/^capture-|\.oml$/g, ''), candidatePath: copy, candidateSha256: hash(fs.readFileSync(copy)), evidenceDir: path.join(output, 'evidence') }));
    return { ok: true, manifest };
  };
  const deps = () => ({ root, nextLabDir: () => path.join(lab, 'attempt-' + (++w.deliveries)), journal: () => {}, cache: null, guide: null, prefetch: () => {}, check: null, studio: w.studio, prepareManifest, reconcile, signatureCache: null,
    otherPids: async () => [...w.studios].filter(([, s]) => s.alive).map(([pid]) => pid),
    apply: async ({ job, snapshot, output }) => {
      const document = readJson(job);
      const candidate = path.join(output, 'kernel-candidate.oml');
      fs.mkdirSync(output, { recursive: true });
      // A repair sets a default on an element a restart may have lost: the kernel refuses a target that is not there.
      if ((document.ops ?? []).some(op => op.prop === 'DefaultValue') && !contentOf(snapshot.path).includes('job')) return { ok: false, code: 'VALIDATION_REFUSED', error: 'The target of the repair is not in the module.', receipt: 'kernel-result.json' };
      // A repair job (ops that set DefaultValue) brings the defaults; the original, what it declares.
      const adds = document.adds ?? (document.ops ?? []).filter(op => op.prop === 'DefaultValue').map(() => 'defaults');
      fs.writeFileSync(candidate, JSON.stringify({ content: [...contentOf(snapshot.path), ...adds.filter(c => !contentOf(snapshot.path).includes(c))] }));
      return { ok: true, candidate, receipt: 'kernel-result.json' };
    },
    mergeOrder: order === 'none' ? null : async ({ candidate, output }) => {
      const firstPass = path.join(output, 'merge-order-first-pass.oml');
      const whole = contentOf(candidate);
      fs.writeFileSync(firstPass, JSON.stringify({ content: whole.filter(c => c !== 'defaults') }));
      // A repair sets a default on an element that exists: one plain merge.
      return w.currentJob === 'original' && whole.includes('defaults') ? { ok: true, deferred: [{ key: 'k', objectKey: 'o', element: 'E', property: 'DefaultValue', value: '1', baseValue: null }], firstPass, firstPassSha256: null, contentPreviewSupported: true, contentPreview: { accepted: true } } : { ok: true, deferred: [], firstPass: null, contentPreviewSupported: true, contentPreview: { accepted: true } };
    } });
  const jobFile = path.join(root, 'job.json');
  fs.writeFileSync(jobFile, JSON.stringify({ ops: [], adds: order === 'none' ? ['job'] : ['job', 'defaults'] }));
  w.jobFile = jobFile;
  // The session never adds words or publication: what it asked at the start, or what a call it obeys says.
  w.input = { module: MODULE, feature: 'f', job: jobFile, owners: ['O'], changes: ['C'], ...(publish ? { publish: true, authorize: 'pode publicar o Fixture agora' } : {}) };
  w.note = answer => {
    w.answers.push(answer);
    if (answer?.code) w.codes.add(answer.code);
    if (answer?.timeout?.now) w.states.add(answer.timeout.now.state);
    return answer;
  };
  w.deliver = async (args = w.input) => {
    const isOriginal = path.resolve(args.job) === jobFile;
    w.currentJob = isOriginal ? 'original' : /repair/.test(args.job) ? 'repair' : 'other';
    if (!isOriginal && !fs.existsSync(path.resolve(args.job))) throw new Error('a job that does not exist: ' + args.job);
    w.mergesOfCall = 0;
    const result = await deliverKernel({ ...args, feature: 'f', owners: ['O'], changes: ['C'] }, deps());
    const compact = compactDelivery('studio_deliver', args, result);
    if (result.repairJob && !compact.repairJob) compact.repairJob = result.repairJob;
    return w.note(compact);
  };
  w.publish = async args => w.note(await publishWithGrant(args, { studio: w.studio, readManifest: file => readJson(path.resolve(root, file)), lab, root, catalog: () => null, grants: { findGrant: async () => null }, reconcile }));
  w.read = async () => { await w.studio(['status']); await w.studio(['status']); };
  // What happens to the Studios once the delivery was cut.
  w.happen = () => {
    if (restart === 'no') return;
    const before = here();
    if (restart === 'other-studio') { w.studios.set(OTHER, { content: ['base'], salt: 0, alive: true, applied: 0 }); w.pid = OTHER; return; }
    before.alive = false; w.truthRunning = false; w.late = null;
    const lost = restart.startsWith('lost');
    w.studios.set(OTHER, { content: lost ? ['base'] : [...before.content], salt: restart.endsWith('other-bytes') ? 1 : 0, alive: true, applied: 0, holdsJob: !lost && before.content.length > 1, header: 1 });
    w.pid = OTHER;
  };
  w.here = here;
  // A clean delivery of the same module before this one, the one a wrong answer would cite.
  w.earlier = async () => {
    if (!earlierClean) return;
    const dir = path.join(lab, 'attempt-0'); const manifestDir = path.join(dir, 'delivery'); const evidence = path.join(manifestDir, 'evidence');
    fs.mkdirSync(evidence, { recursive: true });
    const manifest = path.join(manifestDir, 'manifest.json');
    fs.writeFileSync(path.join(manifestDir, 'candidate.oml'), JSON.stringify({ content: ['base'] }));
    fs.writeFileSync(manifest, JSON.stringify({ schema: 'odc3-manifest/1', feature: 'earlier', module: MODULE, moduleKey: KEY, tenant: HOST, owners: ['O'], changes: ['C'], candidatePath: path.join(manifestDir, 'candidate.oml'), candidateSha256: 'A', evidenceDir: evidence }));
    fs.writeFileSync(path.join(evidence, 'merge-started.json'), JSON.stringify({ at: '2026-10-01T00:00:00Z', pid: w.pid, module: MODULE }));
    fs.writeFileSync(path.join(evidence, 'receipt.json'), JSON.stringify({ ok: true, merged: true, strictlyEqual: true, sha256: 'A' }));
  };
  return w;
}

// The session that does what the answers say, with the arguments they give, and nothing else: the continuation first, as a session reads it.
async function obey(w, first) {
  let answer = first;
  let reconciled = 0;
  const reconcileOnce = async () => { reconciled++; await w.read(); return w.publish({ module: MODULE, reconcile: true }); };
  for (let step = 0; step < 20; step++) {
    if (answer.ok === true && !answer.timeout) return answer;
    const next = answer.continuation;
    if (next?.tool === 'studio_deliver' && typeof next.arguments?.job === 'string') { answer = await w.deliver({ ...w.input, ...next.arguments, publish: undefined, authorize: undefined }); continue; }
    if (next?.tool === 'studio_publish' && next.arguments?.reconcile === true && reconciled < 3) { reconciled++; await w.read(); answer = await w.publish(next.arguments); continue; }
    // A cut says to read, then to reconcile (timeout.next), or says that nothing ran.
    if (answer.timeout && reconciled < 3 && answer.code !== 'MERGE_NOT_STARTED' && !['second-pass-did-not-run'].includes(answer.timeout.now?.state)) { assert.ok(answer.timeout.next.length >= 4, 'every cut carries its rules'); answer = await reconcileOnce(); continue; }
    if (next?.tool === 'studio_status' && /reconcile:true/.test(next.why ?? '') && reconciled < 3) { answer = await reconcileOnce(); continue; }
    return answer; // a reading: what to write next is a new job, of the session's own
  }
  assert.fail('the answers never end: ' + JSON.stringify(answer).slice(0, 400));
}

// The session that does the work: it reads the module and sends a new job, of what is missing, until it is delivered. It always ends.
async function correct(w) {
  const job = path.join(w.root, 'correction.json');
  fs.writeFileSync(job, JSON.stringify({ ops: [], adds: ['what is missing'] }));
  let answer = null;
  for (let attempt = 0; attempt < 4 && answer?.ok !== true; attempt++) {
    await w.read();
    await w.publish({ module: MODULE, reconcile: true });
    answer = await w.deliver({ ...w.input, job });
  }
  return answer;
}

// The session that makes the mistake: after what it was told to do, the same job again, and again.
async function insist(w, first) {
  let answer = await obey(w, first);
  for (let attempt = 0; attempt < 4 && answer?.ok !== true; attempt++) {
    await w.read();
    answer = await w.deliver();
    if (answer.ok !== true) answer = await obey(w, answer);
  }
  return answer;
}

const CUTS = ['bridge', 'PIPE_REPLY_TIMEOUT', 'PIPE_TRANSPORT', 'PIPE_NO_REPLY', 'AGENT_TIMEOUT', 'AGENT_DISCONNECTED', 'hosted-blind'];
const TRUTHS = ['abandoned', 'ended-before', 'silent', 'ran', 'threw-in-part', 'running', 'late', 'late-before-merge'];
const ORDERS = ['none', 'pass1', 'pass2'];
const RESTARTS = ['no', 'kept', 'kept-other-bytes', 'lost', 'lost-other-bytes', 'other-studio'];
const SESSIONS = { obey, insist, correct };
const seen = { states: new Set(), codes: new Set(), scenarios: 0, second: 0, atBase: 0 };

for (const order of ORDERS) for (const cut of CUTS) {
  test(`${order}, cut ${cut}: a job is never applied over a module that holds any of it, whatever the session does`, async t => {
    for (const truth of TRUTHS) for (const restart of RESTARTS) for (const earlierClean of [false, true]) for (const [name, session] of Object.entries(SESSIONS)) for (const noPid of restart === 'other-studio' ? [false, true] : [false]) {
      const label = JSON.stringify({ order, cut, truth, restart, earlierClean, session: name, noPid });
      const w = world(t, { order, truth, cut, restart, earlierClean, noPid });
      await w.earlier();
      const answer = await w.deliver();
      // merged:true of a cut only when the module holds something of it.
      if (answer.timeout && answer.merged === true) assert.ok(w.here().content.length > 1, `merged:true over a module with nothing of it: ${label}`);
      w.happen();
      const end = await session(w, answer);
      // A cut of pass 2 says what is missing: the repair, never the rule of a whole delivery.
      if (order === 'pass2' && answer.timeout) {
        assert.match(answer.timeout.next[0].then, /repair job/, label);
        // Pass 1 is in the module: no rule of this answer may say that nothing ran.
        for (const rule of answer.timeout.next) assert.doesNotMatch(rule.then, /nothing of it ran/, label);
      }
      assert.deepEqual(w.doubled, [], `applied over a module that held it: ${label}; ended ${JSON.stringify(end).slice(0, 400)}`);
      // The work continues: a session that reads and sends a new job always ends delivered.
      if (name === 'correct') {
        assert.equal(end?.ok, true, `the new job stayed stuck: ${label}; ${JSON.stringify(end).slice(0, 500)}`);
        assert.ok(w.here().content.includes('what is missing'), label);
      }
      assert.ok(w.reached.repair <= 1, `the repair ran ${w.reached.repair} times: ${label}`);
      if (name !== 'correct') assert.equal(w.reached.other, 0, label);
      // Another Studio that may hold it, still open: the job does not go there too. Only a cut proven not to have run leaves no doubt.
      const proven = ['abandoned', 'ended-before'].includes(truth) && cut !== 'hosted-blind';
      if (restart === 'other-studio' && !proven) assert.equal(w.here().applied, 0, `the job went to the other Studio too: ${label}`);
      // Publication is never added: nothing here asked for it.
      assert.equal(w.published, 0, `published without being asked: ${label}`);
      for (const said of w.answers) {
        assert.ok(!/ENOENT/.test(JSON.stringify(said)), `a raw error for an answer: ${label}; ${JSON.stringify(said).slice(0, 300)}`);
        // Never a call that sends the job again, and merged:false only from the evidence that nothing ran.
        const next = said?.continuation;
        if (next?.tool === 'studio_deliver') assert.notEqual(path.resolve(String(next.arguments?.job)), w.jobFile, `an answer that sends the job again: ${label}`);
        if (said?.merged === false && said.timeout) assert.ok(proven, `merged:false without that proof: ${label}`);
        if (said?.timeout?.now) assert.deepEqual(Object.keys(said.timeout.now), ['state'], 'a state, never a permission');
        if (said?.timeout?.mergeStarted === 'unknown') assert.ok(said.merged === null || said.merged === true, `merged beside unknown: ${label}`);
        if (said?.merged === false && said.timeout) assert.notEqual(said.timeout.mergeStarted, true, label);
      }
      // Nothing is ever said to be clean over a module that lacks what the delivery asks for.
      if (name !== 'correct' && end?.ok === true && !w.here().content.includes('job') && !w.here().content.some(c => /^part of/.test(c))) assert.fail(`a clean answer of another merge: ${label}; ${JSON.stringify(end).slice(0, 300)}`);
      // Pass 1 alone is never a delivered candidate: its default values are missing.
      if (name !== 'correct' && end?.ok === true && order !== 'none' && end.result !== 'delivered' && !w.here().content.includes('defaults') && !w.here().content.some(c => /^part of/.test(c))) assert.fail(`pass 1 alone called clean: ${label}; ${JSON.stringify(end).slice(0, 300)}`);
      seen.scenarios++;
      if (w.reached.original >= (order === 'pass2' ? 3 : 2)) seen.second++;
      for (const s of w.states) seen.states.add(s); for (const c of w.codes) seen.codes.add(c);
    }
  });
}

test('the matrix ran every state and every refusal, and it does not just refuse everything', () => {
  // A bridge that names no pid (v98) only changes something with a second Studio open.
  assert.equal(seen.scenarios, ORDERS.length * CUTS.length * TRUTHS.length * (RESTARTS.length + 1) * 2 * Object.keys(SESSIONS).length);
  for (const state of ['not-started', 'ended-before-the-merge', 'unknown', 'merged', 'may-be-merged', 'second-pass-did-not-run'])
    assert.ok(seen.states.has(state), 'never seen: ' + state + ' in ' + [...seen.states].join(', '));
  assert.ok(seen.second > 0, 'the job does go again over its own base');
  for (const code of ['MERGE_TIMEOUT', 'MERGE_UNCERTAIN', 'MERGE_NOT_STARTED', 'MERGE_ORDER_INCOMPLETE', 'MERGE_NOT_IN_MODULE', 'MODULE_NOT_AT_BASE', 'DELIVERY_IN_OTHER_STUDIO'])
    assert.ok(seen.codes.has(code), 'never seen: ' + code + ' in ' + [...seen.codes].join(', '));
});

// The cases by name: what each one answers, not only that nothing doubled.
async function cutAndHappen(t, options) {
  const w = world(t, { order: 'none', cut: 'PIPE_REPLY_TIMEOUT', ...options });
  const answer = await w.deliver();
  w.happen();
  return { w, answer };
}
const lastCode = w => w.answers.at(-1)?.code;

test('two Studios: the merge ran in the first, still open, and the second has the base: the same job is refused, naming that process', async t => {
  const { w } = await cutAndHappen(t, { truth: 'ran', restart: 'other-studio' });
  const again = await w.deliver();
  assert.equal(again.code, 'MODULE_NOT_AT_BASE');
  assert.equal(again.merged, null);
  assert.match(again.error, new RegExp('process ' + PID));
  assert.equal(again.continuation.tool, 'studio_status');
  assert.equal(w.here().applied, 0);
});

test('two Studios and a bridge that names no pid (G32): refused, and with the first one gone the job goes', async t => {
  const { w } = await cutAndHappen(t, { truth: 'ran', restart: 'other-studio', noPid: true });
  const again = await w.deliver();
  assert.equal(again.code, 'MODULE_NOT_AT_BASE');
  assert.match(again.error, /more than one ODC Studio/);
  assert.equal(w.here().applied, 0);
  w.studios.get(PID).alive = false;
  assert.equal((await w.deliver()).ok, true, 'one open: it can only be that one');
  assert.equal(w.here().applied, 1);
});

test('two Studios: the first is gone and took the merge with it: the second is at the base, and the job goes there once', async t => {
  const { w } = await cutAndHappen(t, { truth: 'ran', restart: 'lost' });
  const again = await w.deliver();
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(w.here().applied, 1);
  const third = await w.deliver();
  assert.equal(third.code, 'MODULE_NOT_AT_BASE', 'and never a third time: the module holds it now');
  assert.equal(w.here().applied, 1);
});

test('a merge lost on a restart, and only the Studio state in the header differs: the module is the base, and the job goes once', async t => {
  // The header moves on every restart (header: 1 above): this is every "lost" case. The raw sha256 differs; the content does not.
  const { w, answer } = await cutAndHappen(t, { truth: 'ran', restart: 'lost' });
  assert.equal(answer.timeout.baseSha256.length, 64);
  const again = await w.deliver();
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(w.here().applied, 1);
});

test('G34: only the Studio state differs, and the module is at the base: the reading says so, and it says what the server does', async t => {
  const { w } = await cutAndHappen(t, { truth: 'ran', restart: 'lost' });
  const read = await w.publish({ module: MODULE, reconcile: true });
  assert.equal(read.code, 'MERGE_NOT_IN_MODULE', JSON.stringify(read));
  assert.equal(read.merged, null);
  assert.doesNotMatch(JSON.stringify(read), /[Nn]ever (this delivery|the job of this delivery)/);
  assert.match(read.continuation.why, /A new delivery of this job goes only while the open module is still this base/);
  assert.equal((await w.deliver()).ok, true, 'and the server does exactly that');
});

test('G35: stages that write nothing are never refused by a cut', async t => {
  const { w } = await cutAndHappen(t, { truth: 'ran' });
  assert.equal((await w.deliver()).code, 'MODULE_NOT_AT_BASE');
  for (const until of ['snapshot', 'build', 'check-base', 'preview']) {
    const answer = await w.deliver({ ...w.input, until });
    assert.notEqual(answer.code, 'MODULE_NOT_AT_BASE', until + ': ' + JSON.stringify(answer));
  }
  assert.equal(w.here().applied, 1);
});

test('a merge lost on a restart, with other bytes: nothing can tell, so the same job is refused and a reading comes next', async t => {
  const { w } = await cutAndHappen(t, { truth: 'ran', restart: 'lost-other-bytes' });
  const again = await w.deliver();
  assert.equal(again.code, 'MODULE_NOT_AT_BASE');
  assert.equal(again.continuation.tool, 'studio_publish');
  assert.equal(again.continuation.arguments.reconcile, true);
  assert.equal(w.here().applied, 0);
});

test('a late merge that lands after the reading and before the capture of the next delivery (G24): refused on that capture', async t => {
  const { w } = await cutAndHappen(t, { truth: 'late' });
  const read = await w.publish({ module: MODULE, reconcile: true });
  assert.equal(read.code, 'MERGE_NOT_IN_MODULE', 'the module is at the base when it is read');
  assert.equal(read.merged, null, 'and that does not say the merge will not come');
  const again = await w.deliver();
  assert.equal(again.code, 'MODULE_NOT_AT_BASE', JSON.stringify(again));
  assert.equal(w.here().applied, 1, 'the late merge, once');
});

test('a late merge that lands after that capture and before the merge: the manifest carries the sha, and the bridge refuses', async t => {
  const { w } = await cutAndHappen(t, { truth: 'late-before-merge' });
  const again = await w.deliver();
  assert.equal(again.code, 'MODULE_NOT_AT_BASE', JSON.stringify(again));
  assert.equal(again.merged, null);
  assert.equal(again.continuation.tool, 'studio_publish');
  assert.equal(w.here().applied, 1, 'the late merge, once');
  assert.deepEqual(w.doubled, []);
});

test('the same late merge with a bridge that ignores the sha (up to v100): its own comparison refuses, and the answer never sends the job again', async t => {
  const { w } = await cutAndHappen(t, { truth: 'late-before-merge', oldBridge: true });
  const again = await w.deliver();
  assert.equal(again.code, 'BASE_DRIFT', JSON.stringify(again));
  assert.equal(again.continuation.tool, 'studio_publish');
  assert.equal(again.continuation.arguments.reconcile, true);
  const third = await w.deliver();
  assert.equal(third.code, 'MODULE_NOT_AT_BASE', 'and the next capture finds it');
  assert.equal(w.here().applied, 1);
});

test('the repair a cut computed goes without a reading, over the module pass 1 left, and brings the defaults', async t => {
  const w = world(t, { order: 'pass2', cut: 'PIPE_REPLY_TIMEOUT', truth: 'abandoned' });
  const answer = await w.deliver();
  assert.equal(answer.code, 'MERGE_ORDER_INCOMPLETE');
  assert.equal(answer.continuation.tool, 'studio_deliver');
  const repair = await w.deliver({ ...w.input, job: answer.continuation.arguments.job });
  assert.equal(repair.ok, true, JSON.stringify(repair));
  assert.ok(w.here().content.includes('defaults'));
  assert.equal(w.reached.repair, 1);
});

test('a missing evidence folder (hosted, the start never seen): true answers, whatever the capture says (G23)', async t => {
  const candidateHeld = world(t, { order: 'none', cut: 'hosted-blind', truth: 'ran' });
  await candidateHeld.deliver();
  const proven = await candidateHeld.publish({ module: MODULE, reconcile: true });
  assert.equal(proven.ok, true, JSON.stringify(proven));
  const differs = world(t, { order: 'none', cut: 'hosted-blind', truth: 'ran' });
  await differs.deliver();
  differs.here().content = [...differs.here().content, 'an edit of the person'];
  const named = await differs.publish({ module: MODULE, reconcile: true });
  assert.equal(named.ok, false);
  assert.ok(!/ENOENT/.test(JSON.stringify(named)), JSON.stringify(named));
  assert.match(JSON.stringify(named), /an edit of the person/);
});

test('a correction goes only after a reading: a different job over a module that is not the base', async t => {
  const { w } = await cutAndHappen(t, { truth: 'threw-in-part' });
  const correction = path.join(w.root, 'correction.json');
  fs.writeFileSync(correction, JSON.stringify({ ops: [], adds: ['what is missing'] }));
  const unread = await w.deliver({ ...w.input, job: correction });
  assert.equal(unread.code, 'MODULE_NOT_AT_BASE', JSON.stringify(unread));
  assert.equal(unread.continuation.arguments.reconcile, true);
  const read = await w.publish({ module: MODULE, reconcile: true });
  assert.equal(read.ok, false);
  const after = await w.deliver({ ...w.input, job: correction });
  assert.equal(after.ok, true, JSON.stringify(after));
  assert.equal(w.reached.other, 2 - 1, 'one merge: the refused call never reached it');
  const same = await w.deliver();
  assert.equal(same.code, 'MODULE_NOT_AT_BASE', 'the job that was cut stays bound to its base');
});

// A merge that ended with a known answer is no cut: nothing to refuse, and "was cut" would be false (G30).
for (const ending of ['security', 'incomplete']) {
  test(`${ending}: a known ending leaves no record, and its fix is a new delivery, with no reading in between`, async t => {
    const w = world(t, { order: 'none', ending });
    const first = await w.deliver();
    assert.equal(first.merged, true, JSON.stringify(first));
    assert.equal(fs.existsSync(path.join(w.root, 'journal', 'merge-cuts')) && fs.readdirSync(path.join(w.root, 'journal', 'merge-cuts')).length > 0, false, 'no record');
    const job = path.join(w.root, 'fix.json');
    fs.writeFileSync(job, JSON.stringify({ ops: [], adds: ['the fix'] }));
    const fix = await w.deliver({ ...w.input, job });
    assert.equal(fix.ok, true, JSON.stringify(fix));
  });
}

test('a publication that failed and a restart: no cut, and the new job goes', async t => {
  const w = world(t, { order: 'none', ending: 'publish-failed', publish: true, restart: 'kept' });
  const first = await w.deliver();
  assert.equal(first.ok, false);
  assert.equal(first.merged, true, JSON.stringify(first));
  w.happen();
  const job = path.join(w.root, 'fix.json');
  fs.writeFileSync(job, JSON.stringify({ ops: [], adds: ['the fix'] }));
  const fix = await w.deliver({ ...w.input, publish: undefined, authorize: undefined, job });
  assert.equal(fix.ok, true, JSON.stringify(fix));
});

test('the folder of the delivery is gone: the reading still counts, and the new job goes', async t => {
  const { w } = await cutAndHappen(t, { truth: 'ran', restart: 'kept' });
  fs.rmSync(w.lab, { recursive: true, force: true });
  fs.mkdirSync(w.lab);
  const read = await w.publish({ module: MODULE, reconcile: true });
  assert.equal(read.code, 'NO_DELIVERY_TO_PUBLISH');
  const job = path.join(w.root, 'fix.json');
  fs.writeFileSync(job, JSON.stringify({ ops: [], adds: ['the fix'] }));
  const fix = await w.deliver({ ...w.input, job });
  assert.equal(fix.ok, true, JSON.stringify(fix));
  assert.equal((await w.deliver()).code, 'MODULE_NOT_AT_BASE', 'the job that was cut stays bound');
});

test('a delivery that ends clean over a record settles it: the next new job needs no reading', async t => {
  const { w } = await cutAndHappen(t, { truth: 'ran', restart: 'lost' });
  assert.equal((await w.deliver()).ok, true);
  const job = path.join(w.root, 'next.json');
  fs.writeFileSync(job, JSON.stringify({ ops: [], adds: ['the next thing'] }));
  const next = await w.deliver({ ...w.input, job });
  assert.equal(next.ok, true, JSON.stringify(next));
});

// The record fails closed (G31).
const recordDir = w => path.join(w.root, 'journal', 'merge-cuts');
test('the record cannot be written before the hand-off: nothing is delivered', async t => {
  const w = world(t, { order: 'none', truth: 'ran', cut: 'PIPE_REPLY_TIMEOUT' });
  fs.mkdirSync(path.join(w.root, 'journal'), { recursive: true });
  fs.writeFileSync(recordDir(w), 'a file where the folder goes');
  const answer = await w.deliver();
  assert.equal(answer.code, 'CUT_RECORD_NOT_WRITTEN', JSON.stringify(answer));
  assert.equal(answer.ok, false);
  assert.equal(w.reached.original, 0, 'the merge was never sent');
  assert.equal(w.here().applied, 0);
  assert.equal(answer.continuation.tool, 'studio_status');
});

test('the record is on disk before the hand-off, whole: a server that dies in the merge leaves it', async t => {
  const w = world(t, { order: 'none', truth: 'ran', cut: 'PIPE_REPLY_TIMEOUT' });
  let during = null;
  const studio = w.studio;
  w.studio = async (args, pid) => { if (args[0] === 'merge') during = fs.readdirSync(recordDir(w)).map(f => JSON.parse(fs.readFileSync(path.join(recordDir(w), f), 'utf8'))); return studio(args, pid); };
  await w.deliver();
  assert.equal(during?.length, 1, 'written before the merge');
  assert.equal(Object.keys(during[0].jobs).length, 1);
  assert.deepEqual(fs.readdirSync(recordDir(w)).filter(f => !f.endsWith('.json')), [], 'no temporary file left');
});

test('a merge that ends known takes back what it wrote before the hand-off', async t => {
  const w = world(t, { order: 'none', ending: 'security' });
  await w.deliver();
  assert.deepEqual(fs.existsSync(recordDir(w)) ? fs.readdirSync(recordDir(w)) : [], []);
  const { w: w2 } = await cutAndHappen(t, { truth: 'ran', restart: 'lost' });
  assert.equal((await w2.deliver()).ok, true, 'over its base, delivered');
  assert.equal((await w2.deliver()).code, 'MODULE_NOT_AT_BASE', 'the job on record stays bound');
});

test('an unreadable record: the same job does not go, the answer says why and what next, the file stays', async t => {
  const { w } = await cutAndHappen(t, { truth: 'ran' });
  const [name] = fs.readdirSync(recordDir(w));
  fs.writeFileSync(path.join(recordDir(w), name), '{"moduleKey":"k-fix');
  const refused = await w.deliver();
  assert.equal(refused.code, 'CUT_RECORD_UNREADABLE', JSON.stringify(refused));
  assert.equal(refused.merged, null);
  assert.equal(refused.continuation.tool, 'studio_publish');
  assert.equal(refused.continuation.arguments.reconcile, true);
  assert.match(refused.error, /cannot be read/);
  assert.match(refused.continuation.why, /sets the file aside/);
  assert.equal(w.here().applied, 1, 'not applied again');
  // A record that parses and is not a record says the same.
  fs.writeFileSync(path.join(recordDir(w), name), '{"a":1}');
  assert.equal((await w.deliver()).code, 'CUT_RECORD_UNREADABLE');
  await w.publish({ module: MODULE, reconcile: true });
  const kept = fs.readdirSync(recordDir(w)).filter(f => f.includes('unreadable'));
  assert.equal(kept.length, 1, 'set aside, never deleted: ' + fs.readdirSync(recordDir(w)));
  assert.equal(fs.readFileSync(path.join(recordDir(w), kept[0]), 'utf8'), '{"a":1}');
  const job = path.join(w.root, 'fix.json');
  fs.writeFileSync(job, JSON.stringify({ ops: [], adds: ['the fix'] }));
  assert.equal((await w.deliver({ ...w.input, job })).ok, true, 'after the reading, a new job goes');
});

test('publication never changes because of the cut: the new delivery publishes only when it asks, with its own words', async t => {
  const { w } = await cutAndHappen(t, { truth: 'ran', restart: 'lost' });
  const quiet = await w.deliver();
  assert.equal(quiet.ok, true);
  assert.equal(w.published, 0);
  const asked = await cutAndHappen(t, { truth: 'ran', restart: 'lost', publish: true });
  assert.equal(asked.w.published, 0, 'the cut delivery published nothing');
  const words = await asked.w.deliver();
  assert.equal(words.ok, true, JSON.stringify(words));
  assert.equal(asked.w.published, 1);
});
