// The job runner without Python (job-runner.mjs, the port of kernel/scripts/run_job.py): the same argv, the same
// <out>.result.json, the same ok rule, captures and ODC lane as run_job.py (line references in each test), measured
// with a fake CLI (fakeAnvil) and, for the worker route, an injected client or a fake TCP worker on an ephemeral port.
// Nothing here starts a process; every root, authority folder and user folder is temporary.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { odcRoot } from '../workspace.mjs';
import { runJob, jobTool, jobToolRequest } from '../job-runner.mjs';
import { createWorkerClient } from '../anvil-worker.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';
import { fakeWorker } from './fixtures/jobs-fake-worker.mjs';

const fixtures = path.join(odcRoot, 'facade', 'tests', 'fixtures');
const envelope = () => JSON.parse(fs.readFileSync(path.join(fixtures, 'jobs-apply-envelope.json'), 'utf8'));
const accepted = () => { const e = envelope(); e.data.accepted = true; return e; };
const readResult = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const KERNEL_ERROR = "op #0 (create Probe): InvalidOperationException: create: unknown key(s) 'bogus'; required: parent, type; optional: name, args, as, source, empty (api --op verbs)";

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-runner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'tests', 'jobs'), { recursive: true });
  const job = path.join(root, 'tests', 'jobs', 'spec-data.json');
  fs.writeFileSync(job, JSON.stringify({ base: 'tests/fixtures/blank-service.oml', ops: [{ op: 'create', parent: '@espace', type: 'Structure', name: 'S' }] }));
  const auth = path.join(root, 'auth'); fs.mkdirSync(auth);
  const env = { USERPROFILE: root, HOME: root, APPDATA: root, LOCALAPPDATA: root, ANVIL_AUTHORITY_DIR: auth, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1' };
  let clock = 1000;
  const now = () => (clock += 10); // two reads per run: wallMs is always 10
  return { root, job, auth, env, now, local: path.join(root, '.local'), deps: extra => ({ root, env, o11Lane: 'ss4', now, ...extra }) };
}
const withoutWorkerFlags = env => { const { ANVIL_WORKER, ANVIL_ODC_NO_WORKER, ...rest } = env; return rest; };
const buildOdcCli = root => { const file = path.join(root, '.local', 'lane-odc', 'cli', 'anvil-odc.dll'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, ''); return file; };

test('ODC explicit candidate seals native artifacts before/after execution and refuses input drift',async t=>{
 for(const drift of [false,true]){
  const s=sandbox(t);buildOdcCli(s.root);
  const base=path.join(s.root,'base.oml'),out=path.join(s.root,'candidate.oml');fs.writeFileSync(base,'OML base');
  const runAnvil=async()=>{
   fs.writeFileSync(out,'OML candidate');if(drift)fs.appendFileSync(base,'changed');
   return {envelope:{ok:true,data:{accepted:true,isValid:true,messages:0,outPath:out,handles:{'@espace':'native-key'}}}};
  };
  const result=await runJob({lane:'odc',job:s.job,base,out},s.deps({runAnvil}));
  const saved=readResult(result.resultFile);
  assert.equal(result.ok,!drift);
  if(drift){assert.equal(result.code,'JOB_ARTIFACT_BINDING_FAILED');assert.equal(saved.data.accepted,false);assert.equal(saved.artifacts,undefined);}
  else{assert.equal(saved.artifacts.schema,'ssam-job-artifacts/1');assert.equal(saved.artifacts.moduleKey,'native-key');assert.equal(saved.artifacts.base.file,base);assert.equal(saved.artifacts.candidate.file,out);assert.match(saved.artifacts.job.sha256,/^[a-f0-9]{64}$/);}
 }
});

test('O11: the argv of anvil_cli.apply, <out>.result.json as run_job.py writes it, and a short JSON answer', async t => {
  const s = sandbox(t);
  const runAnvil = fakeAnvil({ apply: () => ({ envelope: accepted(), stderr: ['warn: slow load'] }) });
  const r = await runJob({ lane: 'o11', job: 'tests/jobs/spec-data.json', base: 'tests/fixtures/base.oml', producers: ['Core=prod/core.oml', 'Bare'] }, s.deps({ runAnvil }));
  const out = path.join(s.local, 'jobs', 'spec-data.oml');
  // anvil_cli.py:258-264 (paths resolved against the kernel root, run_job.py's cwd); run_job.py:157 (default out).
  assert.deepEqual(runAnvil.calls[0].args, ['apply', '--job', s.job, '--out', out, '--work', path.join(s.local, 'work'),
    '--base', path.join(s.root, 'tests', 'fixtures', 'base.oml'), '--producer', 'Core=' + path.join(s.root, 'prod', 'core.oml'), '--producer', 'Bare']);
  assert.equal(runAnvil.calls[0].options.cwd, s.root);
  assert.equal(runAnvil.calls.length, 1, 'the worker is off (ANVIL_WORKER=0): one cold process');
  // run_job.py:177-178 with anvil_cli.py:243-250: the envelope as printed, via "process", the end of stderr, wallMs.
  const resultFile = path.join(s.local, 'jobs', 'spec-data.result.json');
  assert.deepEqual(readResult(resultFile), { ...accepted(), via: 'process', stderr: 'warn: slow load', wallMs: 10 });
  assert.equal(r.ok, true); assert.equal(r.lane, 'o11'); assert.equal(r.job, s.job); assert.equal(r.out, out); assert.equal(r.resultFile, resultFile);
  assert.equal(r.via, 'process'); assert.equal(r.wallMs, 10);
  assert.deepEqual([r.accepted, r.isValid, r.ops, r.objects, r.messages, r.applyMs], [true, false, 14, 181, 2, 567]);
  // A success answers in about 1 KB (C19): non-zero validation counts and totals; the details, the policy messages and
  // the message texts stay in resultFile (a failure keeps them, next test).
  assert.deepEqual(r.validation, { new: 2, unexpected: 2 });
  assert.equal(r.details, undefined); assert.equal(r.detailsTotal, 12); assert.equal(r.policyMessages, undefined);
  assert.deepEqual(r.dataContract, { count: 0, accepted: true });
  // What run_job.py printed of the results without --quiet: get (non-default properties), find, dump (walk); inline while
  // the answer fits, else their count and the ssam_evidence read of them.
  if (r.results) assert.deepEqual(r.results, [
    { op: 'get', type: 'IServerAction', name: 'Text_Tail', properties: { Name: 'Text_Tail', Function: 'True' } },
    { op: 'find', total: 2, found: [['IServerAction', 'Text_Tail'], ['IAssignNode', 'CalculaCauda']] },
    { op: 'dump', tree: ['IServerAction Text_Tail', '  IAssignNode CalculaCauda', '    IAssignment  = Right(Value, 1)'] }]);
  else { assert.ok(r.resultsTotal >= 3); assert.deepEqual(r.continuation.arguments, { file: resultFile, pointer: '/data/results' }); }
  assert.equal(r.stderr, undefined, 'stderr only on a failure');
  // What the job creates (job-summary.mjs, 2026-10-12): outside the 1 KB budget, as the HIGH warnings.
  assert.deepEqual(r.summary, { ops: 1, structures: [{ name: 'S', attributes: 0 }] });
  const { summary: _summary, ...budgeted } = r;
  assert.ok(Buffer.byteLength(JSON.stringify(budgeted)) <= 1024 - 120, 'the answer stays within 1 KB with the job identity jobTool adds');
  const quiet = await runJob({ lane: 'o11', job: s.job, quiet: true }, s.deps({ runAnvil }));
  assert.equal(quiet.results, undefined);
});

test('ok is envelope.ok && data.accepted (run_job.py:215); an error envelope and a non-JSON answer still write the result', async t => {
  const s = sandbox(t);
  for (const [label, reply, ok] of [['ok and accepted', accepted(), true], ['ok, not accepted', envelope(), false], ['not ok, accepted', { ...accepted(), ok: false }, false]]) {
    const r = await runJob({ lane: 'o11', job: s.job }, s.deps({ runAnvil: fakeAnvil({ apply: () => ({ exitCode: 0, envelope: reply }) }) }));
    assert.equal(r.ok, ok, label);
  }
  // The kernel refused an op: no data, the error; run_job.py still writes the result (run_job.py:174-178).
  const failed = { ok: false, command: 'apply', elapsedMs: 3, error: KERNEL_ERROR, stack: 'at Anvil.Core...' };
  const r = await runJob({ lane: 'o11', job: s.job }, s.deps({ runAnvil: fakeAnvil({ apply: () => ({ exitCode: 1, envelope: failed, stderr: ['trace'] }) }) }));
  assert.equal(r.ok, false); assert.equal(r.error, KERNEL_ERROR); assert.deepEqual(r.stderr, ['trace']);
  assert.deepEqual(readResult(r.resultFile), { ...failed, via: 'process', stderr: 'trace', wallMs: 10 });
  // anvil_cli.py:247: a CLI that printed no JSON becomes an error envelope with the end of its output.
  const garbled = await runJob({ lane: 'o11', job: s.job }, s.deps({ runAnvil: fakeAnvil({ apply: () => ({ exitCode: 134, envelope: null, stderr: ['Unhandled exception'] }) }) }));
  assert.equal(garbled.ok, false); assert.equal(garbled.error, 'Unhandled exception');
  assert.deepEqual(readResult(garbled.resultFile), { ok: false, command: 'apply', error: 'Unhandled exception', via: 'process', stderr: 'Unhandled exception', wallMs: 10 });
});

test('captureProducers: anvil signature per producer into <lane.jobs>/captured/<stem>, bound before the job (run_job.py:102-125)', async t => {
  const s = sandbox(t);
  const receipt = args => ({ producer: args[2], kind: 'module', versionIdBefore: 7, signatureHash: 'h-' + args[6], avsigPath: args[8], avsigSha256: 's' });
  const runAnvil = fakeAnvil({ signature: args => ({ ok: true, command: 'signature', data: receipt(args) }), apply: () => accepted() });
  const r = await runJob({ lane: 'o11', job: s.job, producers: { Bound: path.join(s.root, 'bound.oml') }, captureProducers: ['System=(System)', 'Core'] }, s.deps({ runAnvil }));
  const folder = path.join(s.local, 'jobs', 'captured', 'spec-data');
  assert.deepEqual(runAnvil.calls.map(c => c.args), [
    ['signature', '--producer', '(System)', '--job', s.job, '--binding', 'System', '--out', path.join(folder, 'System.avsig'), '--bridge-port', '4516'],
    ['signature', '--producer', 'Core', '--job', s.job, '--binding', 'Core', '--out', path.join(folder, 'Core.avsig'), '--bridge-port', '4516'],
    ['apply', '--job', s.job, '--out', path.join(s.local, 'jobs', 'spec-data.oml'), '--work', path.join(s.local, 'work'),
      '--producer', 'Bound=' + path.join(s.root, 'bound.oml'), '--producer', 'System=' + path.join(folder, 'System.avsig'), '--producer', 'Core=' + path.join(folder, 'Core.avsig')]]);
  assert.ok(fs.existsSync(folder));
  const saved = readResult(r.resultFile);
  assert.deepEqual(saved.capturedProducers, [receipt(runAnvil.calls[0].args), receipt(runAnvil.calls[1].args)]);
  assert.equal(r.ok, true); assert.deepEqual(r.capturedProducers.map(c => c.producer), ['(System)', 'Core']);
  // A capture that fails stops before the job, and no result is written (run_job.py:120-122).
  const refused = fakeAnvil({ signature: () => ({ exitCode: 1, envelope: { ok: false, command: 'signature', error: 'producer (System) not found' } }), apply: () => accepted() });
  const stop = await runJob({ lane: 'o11', job: s.job, out: 'out/other.oml', captureProducers: ['System=(System)'] }, s.deps({ runAnvil: refused }));
  assert.deepEqual([stop.ok, stop.code, stop.stage, stop.producer, stop.error], [false, 'capture-failed', 'capture-producer', '(System)', 'producer (System) not found']);
  assert.deepEqual(refused.calls.map(c => c.args[0]), ['signature']);
  assert.equal(fs.existsSync(path.join(s.root, 'out', 'other.result.json')), false);
});

test('ODC lane: anvil-odc apply with --work last, {ok, data, via, wallMs} saved; the refusals of run_job.py:54-58 and data null', async t => {
  const s = sandbox(t);
  const runAnvil = fakeAnvil({ apply: () => accepted() });
  // No CLI built: refused before anything runs, with an MCP continuation instead of a build command.
  const missing = await runJob({ lane: 'odc', job: s.job }, s.deps({ runAnvil }));
  assert.deepEqual([missing.ok, missing.code, missing.continuation.tool], [false, 'odc-cli-missing', 'ssam_doctor']);
  assert.doesNotMatch(JSON.stringify(missing), /dotnet build|python|\.ps1/);
  assert.equal(runAnvil.calls.length, 0);
  // Captures read O11 signatures: refused on ODC (run_job.py:141-144).
  const capture = await runJob({ lane: 'odc', job: s.job, captureProducers: ['System'] }, s.deps({ runAnvil }));
  assert.equal(capture.code, 'capture-o11-only');

  const cli = buildOdcCli(s.root);
  const odcJobs = path.join(s.local, 'lane-odc', 'jobs');
  const r = await runJob({ lane: 'odc', job: 'tests/jobs/spec-data.json', base: 'tests/fixtures/odc/base.oml', producers: ['P=p.oml'] }, s.deps({ runAnvil }));
  // run_job.py:59-66 and 79-85: --base and --producer resolved, then --work <lane-odc>/jobs/work, the anvil-odc CLI.
  assert.deepEqual(runAnvil.calls[0].args, ['apply', '--job', s.job, '--out', path.join(odcJobs, 'spec-data.oml'),
    '--base', path.join(s.root, 'tests', 'fixtures', 'odc', 'base.oml'), '--producer', 'P=' + path.join(s.root, 'p.oml'), '--work', path.join(odcJobs, 'work')]);
  assert.equal(runAnvil.calls[0].options.cli, cli); assert.equal(runAnvil.calls[0].options.cwd, s.root);
  // run_job.py:98-99 and 177-178.
  assert.deepEqual(readResult(path.join(odcJobs, 'spec-data.result.json')), { ok: true, data: accepted().data, via: 'processo frio odc', wallMs: 10 });
  assert.deepEqual([r.ok, r.lane, r.via, r.resultFile], [true, 'odc', 'processo frio odc', path.join(odcJobs, 'spec-data.result.json')]);
  // An error envelope (no data) answers the error and writes no result (run_job.py:95-97).
  const failing = fakeAnvil({ apply: () => ({ exitCode: 1, envelope: { ok: false, command: 'apply', elapsedMs: 11116, error: KERNEL_ERROR } }) });
  const failed = await runJob({ lane: 'odc', job: s.job, out: 'odc-out/x.oml' }, s.deps({ runAnvil: failing }));
  assert.deepEqual([failed.ok, failed.via, failed.error, failed.command], [false, 'processo frio odc', KERNEL_ERROR, 'apply']);
  assert.equal(fs.existsSync(path.join(s.root, 'odc-out', 'x.result.json')), false);
  const silent = await runJob({ lane: 'odc', job: s.job }, s.deps({ runAnvil: fakeAnvil({ apply: () => ({ exitCode: 3, envelope: null }) }) }));
  assert.deepEqual([silent.ok, silent.code, silent.exitCode], [false, 'no-json', 3]);
});

test('an inline job is written to <lane local>/jobs/inline/<uuid>.json and runs like a file; a missing job is refused', async t => {
  const s = sandbox(t);
  const runAnvil = fakeAnvil({ apply: () => accepted() });
  const job = { base: 'tests/fixtures/blank-service.oml', ops: [{ op: 'create', parent: '@espace', type: 'Structure', name: 'Inline' }] };
  const r = await runJob({ lane: 'o11', job }, s.deps({ runAnvil, uuid: () => 'inline-1' }));
  const file = path.join(s.local, 'jobs', 'inline', 'inline-1.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), job);
  assert.equal(r.job, file); assert.equal(runAnvil.calls[0].args[2], file);
  assert.equal(r.out, path.join(s.local, 'jobs', 'inline-1.oml'));
  buildOdcCli(s.root);
  const odc = await runJob({ lane: 'odc', job: job.ops }, s.deps({ runAnvil, uuid: () => 'inline-2' }));
  assert.equal(odc.job, path.join(s.local, 'lane-odc', 'jobs', 'inline', 'inline-2.json'));
  assert.deepEqual(JSON.parse(fs.readFileSync(odc.job, 'utf8')), job.ops);
  assert.equal((await runJob({ lane: 'o11', job: 'tests/jobs/none.json' }, s.deps({ runAnvil }))).code, 'job-not-found');
  assert.equal((await runJob({ lane: 'o11' }, s.deps({ runAnvil }))).code, 'job-required');
  assert.equal((await runJob({ lane: 'ss4', job: s.job }, s.deps({ runAnvil }))).code, 'unknown-lane');
});

test('the worker answers first when it is on; an unknown outcome is never replayed; off means never asked', async t => {
  const s = sandbox(t);
  const on = withoutWorkerFlags(s.env);
  const client = reply => { const calls = []; return { calls, run: async argv => { calls.push(argv); return typeof reply === 'function' ? reply(argv) : reply; } }; };
  const runAnvil = fakeAnvil({ apply: () => accepted() });
  const worker = client({ used: true, envelope: { ...accepted(), queuedMs: 0 } });
  const viaWorker = await runJob({ lane: 'o11', job: s.job }, s.deps({ env: on, runAnvil, worker }));
  assert.equal(viaWorker.via, 'worker'); assert.equal(runAnvil.calls.length, 0);
  assert.deepEqual(worker.calls[0].slice(0, 5), ['apply', '--job', s.job, '--out', path.join(s.local, 'jobs', 'spec-data.oml')]);
  assert.deepEqual(readResult(viaWorker.resultFile), { ...accepted(), queuedMs: 0, via: 'worker', wallMs: 10 }); // anvil_cli.py:241,250
  buildOdcCli(s.root);
  const odcWorker = client({ used: true, envelope: accepted() });
  const odc = await runJob({ lane: 'odc', job: s.job }, s.deps({ env: on, runAnvil, worker: odcWorker }));
  assert.equal(odc.via, 'worker odc'); assert.deepEqual(odcWorker.calls[0].slice(-2), ['--work', path.join(s.local, 'lane-odc', 'jobs', 'work')]);
  // Written, no reply: refused, and neither the worker nor a cold process runs it again.
  const lost = client({ used: true, unknown: true, code: 'WORKER_OUTCOME_UNKNOWN', error: 'worker connection failed after submission; execution outcome is unknown, command was not replayed' });
  const unknown = await runJob({ lane: 'o11', job: s.job, out: 'lost/x.oml' }, s.deps({ env: on, runAnvil, worker: lost }));
  assert.deepEqual([unknown.ok, unknown.code, lost.calls.length, runAnvil.calls.length], [false, 'worker-outcome-unknown', 1, 0]);
  assert.equal(fs.existsSync(path.join(s.root, 'lost', 'x.result.json')), false);
  // Not used (cold is safe: nothing executed there): the cold process runs and the answer says why.
  const cold = await runJob({ lane: 'o11', job: s.job }, s.deps({ env: on, runAnvil, worker: client({ used: false, note: 'worker CLI not built' }) }));
  assert.deepEqual([cold.ok, cold.via, cold.worker, runAnvil.calls.length], [true, 'process', 'worker CLI not built', 1]);
  // ANVIL_WORKER=0 (both lanes) and ANVIL_ODC_NO_WORKER (ODC) never ask the worker.
  const never = client({ used: true, envelope: accepted() });
  await runJob({ lane: 'o11', job: s.job }, s.deps({ runAnvil, worker: never }));
  await runJob({ lane: 'odc', job: s.job }, s.deps({ env: { ...on, ANVIL_ODC_NO_WORKER: '1' }, runAnvil, worker: never }));
  await runJob({ lane: 'odc', job: s.job }, s.deps({ env: { ...on, ANVIL_WORKER: '0' }, runAnvil, worker: never }));
  assert.equal(never.calls.length, 0);
});

// QuizLive, 2026-10-05: the ODC worker answered "Worker operation requires the trusted Hybrid controller" (executed:false)
// and ssam_job returned that refusal, which names no fix a session can apply. Nothing ran there, so the job runs cold.
test('a worker refusal that ran nothing (another controller key) runs the same job cold, in both lanes', async t => {
  const s = sandbox(t);
  const on = withoutWorkerFlags(s.env);
  const refused = { used: true, envelope: { ok: false, command: 'apply', error: 'Worker operation requires the trusted Hybrid controller', executed: false } };
  const worker = () => { const calls = []; return { calls, run: async argv => { calls.push(argv); return refused; } }; };
  const runAnvil = fakeAnvil({ apply: () => accepted() });
  const o11Worker = worker();
  const o11 = await runJob({ lane: 'o11', job: s.job }, s.deps({ env: on, runAnvil, worker: o11Worker }));
  assert.deepEqual([o11.ok, o11.via, o11Worker.calls.length, runAnvil.calls.length], [true, 'process', 1, 1]);
  assert.match(o11.worker, /did not run the request \(Worker operation requires the trusted Hybrid controller\); ran cold/);
  buildOdcCli(s.root);
  const odcWorker = worker();
  const odc = await runJob({ lane: 'odc', job: s.job }, s.deps({ env: on, runAnvil, worker: odcWorker }));
  assert.deepEqual([odc.ok, odc.via, odcWorker.calls.length, runAnvil.calls.length], [true, 'processo frio odc', 1, 2]);
  assert.doesNotMatch(JSON.stringify(odc.error ?? ''), /trusted Hybrid controller/);
  // A refusal the worker did run (executed is not false) stays the answer: it is never repeated cold.
  const ran = { calls: [], run: async argv => { ran.calls.push(argv); return { used: true, envelope: { ok: false, command: 'apply', error: 'op #0 failed' } }; } };
  const failed = await runJob({ lane: 'o11', job: s.job, out: 'ran/x.oml' }, s.deps({ env: on, runAnvil, worker: ran }));
  assert.deepEqual([failed.ok, failed.via, runAnvil.calls.length], [false, 'worker', 2]);
});

test('through a fake TCP worker: the request carries the key, and a connection lost after sending is not repeated', async t => {
  const s = sandbox(t);
  fs.writeFileSync(path.join(s.auth, 'bridge.key'), 'KEY\n');
  const studio = path.join(s.root, 'studio'); fs.mkdirSync(studio);
  let drop = false;
  const fake = await fakeWorker({ key: 'KEY', status: { studio }, handler: request => (drop ? 'drop' : { ...accepted(), command: request.args[0] }) });
  t.after(() => fake.close());
  const env = { ...withoutWorkerFlags(s.env), ANVIL_WORKER_PORT: String(fake.port), ANVIL_STUDIO_DIR: studio };
  const worker = createWorkerClient('o11', { root: s.root, env, o11: 'ss4', pingMs: 1000 });
  const runAnvil = fakeAnvil({ apply: () => accepted() });
  const ok = await runJob({ lane: 'o11', job: s.job }, s.deps({ env, runAnvil, worker }));
  assert.deepEqual([ok.ok, ok.via, runAnvil.calls.length], [true, 'worker', 0]);
  assert.equal(fake.requests('apply')[0].authorization, 'KEY');
  assert.equal(Object.hasOwn(fake.requests('ping')[0], 'authorization'), false, 'ping carries no key');
  drop = true;
  const lost = await runJob({ lane: 'o11', job: s.job }, s.deps({ env, runAnvil, worker }));
  assert.deepEqual([lost.ok, lost.code, fake.requests('apply').length, runAnvil.calls.length], [false, 'worker-outcome-unknown', 2, 0]);
});

test('jobTool: the MCP inputs are checked as ssam.mjs checks them, and only a failure gets the guidance', async t => {
  const s = sandbox(t);
  assert.equal(jobToolRequest({ job: 'x.json', producers: { Core: 'relative.oml' } }).code, 'invalid-producers');
  assert.equal(jobToolRequest({ job: 'x.json', producers: { '(System)': path.join(s.root, 'a.oml') } }).code, 'invalid-producers');
  assert.equal(jobToolRequest({ job: 'x.json', lane: 'odc', captureProducers: ['System'] }).code, 'capture-o11-only');
  assert.equal(jobToolRequest({ job: 'x.json', captureProducers: ['System='] }).code, 'invalid-capture');
  assert.equal(jobToolRequest({ job: 'x.json', producers: { Core: path.join(s.root, 'a.oml') }, captureProducers: ['Core'] }).code, 'invalid-capture');
  assert.equal(jobToolRequest({ job: 'x.json', execute: true }).code, 'unknown-argument');
  const guided = [];
  const guidance = async (lane, job, result) => { guided.push([lane, job]); return { ...result, discovery: { schemaVersion: 'ssam-job-guidance/1' } }; };
  const good = await jobTool({ job: 'tests/jobs/spec-data.json' }, s.deps({ runAnvil: fakeAnvil({ apply: () => accepted() }), guidance }));
  assert.equal(good.ok, true); assert.equal(good.discovery, undefined); assert.equal(guided.length, 0);
  const bad = await jobTool({ job: { ops: [] } }, s.deps({ runAnvil: fakeAnvil({ apply: () => envelope() }), guidance, uuid: () => 'inline-3' }));
  assert.equal(bad.ok, false); assert.equal(bad.discovery.schemaVersion, 'ssam-job-guidance/1');
  assert.deepEqual(guided, [['o11', path.join(s.local, 'jobs', 'inline', 'inline-3.json')]]);
  const thrown = await jobTool({ job: s.job }, s.deps({ runAnvil: async () => { throw new Error('spawn dotnet ENOENT'); }, guidance: async (l, j, r) => r }));
  assert.deepEqual(thrown, { ok: false, error: 'spawn dotnet ENOENT' });
});

// ---- patch + basedOn (job-patch.mjs): the corrected job is a new file; the answer names the job and its sha256
const sha = data => createHash('sha256').update(data).digest('hex');
const RENAME = [{ op: 'test', path: '/ops/0/name', value: 'S' }, { op: 'replace', path: '/ops/0/name', value: 'S2' }];

test('jobTool with patch + basedOn runs a new job file, leaves the base intact and answers job and jobSha256', async t => {
  const s = sandbox(t);
  const original = fs.readFileSync(s.job);
  const runAnvil = fakeAnvil({ apply: () => accepted() });
  const plain = await jobTool({ job: 'tests/jobs/spec-data.json' }, s.deps({ runAnvil }));
  assert.equal(plain.job, s.job); assert.equal(plain.jobSha256, sha(original), 'a plain run names its job too');
  const r = await jobTool({ patch: RENAME, basedOn: { job: plain.job, sha256: plain.jobSha256 } }, s.deps({ runAnvil, uuid: () => 'patch-1' }));
  const file = path.join(s.local, 'jobs', 'inline', 'patch-1.json');
  assert.equal(r.ok, true); assert.equal(r.job, file); assert.equal(r.jobSha256, sha(fs.readFileSync(file)));
  assert.equal(runAnvil.calls[1].args[2], file);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ...JSON.parse(original), ops: [{ op: 'create', parent: '@espace', type: 'Structure', name: 'S2' }] });
  assert.ok(fs.readFileSync(s.job).equals(original), 'the base is never rewritten');
  const line = JSON.parse(fs.readFileSync(path.join(s.local, 'journal', 'job-patch.jsonl'), 'utf8').trim());
  assert.deepEqual([line.tool, line.job, line.basedOn.job, line.patchOps], ['o11_job', file, s.job, 2]);
  // basedOn.job relative to the kernel root, as job is
  const relative = await jobTool({ patch: RENAME, basedOn: { job: 'tests/jobs/spec-data.json', sha256: sha(original) } }, s.deps({ runAnvil, uuid: () => 'patch-2' }));
  assert.equal(relative.job, path.join(s.local, 'jobs', 'inline', 'patch-2.json'));
  // basedOn {taskId}: the job of an O11 delivery task, checked against the sha256 the kernel recorded
  const id = 'a1'.repeat(16);
  const payload = JSON.stringify({ taskId: id, request: { Module: 'Orders', JobPath: s.job }, sources: [{ path: s.job, sha256: sha(original) }], writeState: 'not-sent', error: 'x' });
  fs.mkdirSync(path.join(s.local, 'work', 'deliver', id), { recursive: true });
  fs.writeFileSync(path.join(s.local, 'work', 'deliver', id, 'task.json'), JSON.stringify({ format: 1, sha256: sha(payload), payload }));
  assert.equal((await jobTool({ patch: RENAME, basedOn: { taskId: id } }, s.deps({ runAnvil, uuid: () => 'patch-3' }))).ok, true);
  // the ODC lane writes under lane-odc; an O11 task is not its base
  buildOdcCli(s.root);
  const odc = await jobTool({ lane: 'odc', patch: RENAME, basedOn: { job: s.job, sha256: sha(original) } }, s.deps({ runAnvil, uuid: () => 'patch-4' }));
  assert.equal(odc.job, path.join(s.local, 'lane-odc', 'jobs', 'inline', 'patch-4.json'));
  assert.equal((await jobTool({ lane: 'odc', patch: RENAME, basedOn: { taskId: id } }, s.deps({ runAnvil }))).code, 'BASE_TASK_UNSUPPORTED');
  assert.equal(runAnvil.calls.length, 5);
});

test('jobTool refuses a bad patch before anything runs and without guidance; a kernel failure names failedOp', async t => {
  const s = sandbox(t);
  const basedOn = { job: s.job, sha256: sha(fs.readFileSync(s.job)) };
  // patch-por-nome: job + basedOn is a partial job (a patch may come with it); patch still needs basedOn
  assert.equal(jobToolRequest({ job: 'x.json', patch: RENAME, basedOn }).ok, true);
  assert.equal(jobToolRequest({ job: 'x.json', basedOn }).ok, true);
  assert.equal(jobToolRequest({ job: 'x.json', patch: RENAME }).code, 'PATCH_INVALID');
  assert.match(jobToolRequest({ patch: RENAME }).error, /patch needs basedOn/);
  assert.match(jobToolRequest({ basedOn }).error, /basedOn goes with patch/);
  const guided = [];
  const guidance = async (lane, job, result) => { guided.push(job); return { ...result, discovery: { schemaVersion: 'ssam-job-guidance/1' } }; };
  const runAnvil = fakeAnvil({ apply: () => accepted() });
  const changed = await jobTool({ patch: RENAME, basedOn: { job: s.job, sha256: 'ab'.repeat(32) } }, s.deps({ runAnvil, guidance }));
  assert.deepEqual([changed.ok, changed.code, changed.jobSha256, changed.discovery], [false, 'BASE_CHANGED', undefined, undefined]);
  const failed = await jobTool({ patch: [{ op: 'test', path: '/ops/0/name', value: 'Other' }], basedOn }, s.deps({ runAnvil, guidance }));
  assert.deepEqual([failed.code, failed.at], ['PATCH_TEST_FAILED', 0]);
  assert.equal((await jobTool({ patch: [{ op: 'replace', path: '/base', value: 'x.oml' }], basedOn }, s.deps({ runAnvil, guidance }))).code, 'PATCH_PATH_FORBIDDEN');
  assert.deepEqual([guided.length, runAnvil.calls.length], [0, 0]);
  assert.equal(fs.existsSync(path.join(s.local, 'jobs', 'inline')), false);
  // the kernel refused op #0 (create Probe) of this job: failedOp 0, with the job and its sha256 for the next patch
  const probe = path.join(s.root, 'tests', 'jobs', 'probe.json');
  fs.writeFileSync(probe, JSON.stringify({ ops: [{ op: 'create', parent: '@espace', type: 'Structure', name: 'Probe', bogus: 1 }] }));
  const refused = fakeAnvil({ apply: () => ({ exitCode: 1, envelope: { ok: false, command: 'apply', elapsedMs: 3, error: KERNEL_ERROR } }) });
  const op = await jobTool({ job: probe }, s.deps({ runAnvil: refused, guidance }));
  assert.deepEqual([op.ok, op.failedOp, op.job, op.jobSha256], [false, 0, probe, sha(fs.readFileSync(probe))]);
  assert.equal(op.discovery.schemaVersion, 'ssam-job-guidance/1');
  // the same error over another job (op 0 is named S): no failedOp
  assert.equal((await jobTool({ job: s.job }, s.deps({ runAnvil: refused, guidance }))).failedOp, undefined);
});
