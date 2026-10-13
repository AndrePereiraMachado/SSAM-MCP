// Lane wp on the hosted server (servidor/fase4): several customers build at the same time, with per-customer fairness. An
// offline load test: 3 customers x 3 studio_deliver of 3 modules each, every Studio command through the customer's own
// AgentExecutor and a fake agent (the mirror, file.sync and the odc.pipe of a fake ODC bridge), the real phased delivery
// (odc-build-phase.mjs, lib.mjs deliver, kernel-delivery.mjs) with a fake kernel apply (BUILD_MS) and a fake builder
// (MANIFEST_MS), and one build pool of 4 slots for the whole server. First one delivery after the other (serial), then
// all nine at once. The parallel wall time must stay well under the serial one; the merges of one customer's Studio never
// overlap; every customer's first build starts before any customer's third (fairness); each delivery has its own lab
// folder. The numbers go to the test output (diagnostic). No Studio, agent process, hub or port.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AgentExecutor } from '../hosted/agent-executor.mjs';
import { runWithExecutor } from '../executor.mjs';
import { withStudioWriteLock } from '../studio-write-lock.mjs';
import { createBuildPool } from '../build-pool.mjs';
import { phasedDeliver, phasedDeliveryDeps } from '../odc-build-phase.mjs';
import * as lib from '../lib.mjs';
import { fakeAgentLink, hostedDirs, cleanupHostedDirs, agentPaths } from './fixtures/fake-agent-link.mjs';

test.after(cleanupHostedDirs);
const BUILD_MS = 400, MANIFEST_MS = 100, SNAPSHOT_MS = 40, MERGE_MS = 80, SLOTS = 4;
const CUSTOMERS = ['tok_alpha', 'tok_beta', 'tok_gamma'];
const MODULES = ['Orders', 'Customers', 'Catalog'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = text => createHash('sha256').update(text).digest('hex').toUpperCase();
const overlap = (a, b) => a.start < b.end && b.start < a.end;
const line = value => ({ line: JSON.stringify(value), paths: agentPaths(value) });

// One customer of the hosted server: its workspace, its agent (a fake link with a fake ODC bridge), its executor.
function customer(tokenId, index, log) {
  const dirs = hostedDirs(os.tmpdir());
  let captures = 0;
  const handlers = {
    'studio.processes': () => ({ processes: [{ pid: 7000 + index, path: 'C:\\ODC\\ODCStudio.exe', version: '1.7.28.1' }] }),
    'odc.pipe': async ({ args }, link) => {
      const [command, ...rest] = args;
      if (command === 'status') return line({ ok: true, busy: null });
      if (command === 'snapshot') {
        await sleep(SNAPSHOT_MS);
        const bytes = 'capture ' + tokenId + ' ' + rest[0] + ' ' + (++captures);
        const file = 'agent:odc/snapshots/' + rest[0] + '-' + sha(bytes) + '.oml';
        link.writeAgent(file, bytes);
        link.writeAgent(file + '.json', JSON.stringify({ ok: true, module: rest[0], sha256: sha(bytes) }));
        return line({ ok: true, module: rest[0], sha256: sha(bytes), path: file, host: 'customer-' + index + '.example.com', moduleKey: 'K-' + rest[0], developerId: 'dev@customer.example' });
      }
      if (command === 'merge') {
        const manifest = JSON.parse(link.readAgent(rest[0].startsWith('agent:') ? rest[0] : 'agent:' + path.relative(dirs.agentRoot, rest[0]).split(path.sep).join('/')));
        const merge = { customer: tokenId, module: manifest.module, start: Date.now() };
        await sleep(MERGE_MS);
        merge.end = Date.now(); log.merges.push(merge);
        return line({ ok: true, merged: true, strictlyEqual: true, outcome: 'merged' });
      }
      return line({ ok: false, error: 'fake bridge: ' + command });
    },
  };
  const link = fakeAgentLink({ tokenId, customer: tokenId, agentRoot: dirs.agentRoot, sync: true, handlers });
  const executor = new AgentExecutor({ link, workspace: dirs.workspace, o11: {} });
  const context = { id: 'ctx-' + tokenId, hosted: true, tokenId, customer: tokenId, lanes: ['odc'], workspace: dirs.workspace, agent: link, executor, close: async () => {} };
  const job = path.join(dirs.workspace, 'inbox', 'job.json');
  fs.writeFileSync(job, JSON.stringify({ ops: [{ op: 'rename', path: 'Entity:Old', to: 'New' }] }));
  return { tokenId, dirs, link, context, job };
}

// The hosted server's delivery of one call: the Studio lock in phases, the build pool, the customer's executor.
function server(log) {
  const pool = createBuildPool({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'fase4-pool-')), size: SLOTS, queueMs: 120000 });
  const kernel = {
    applyKernel: async ({ snapshot, output }) => {
      const build = { start: Date.now() };
      await sleep(BUILD_MS);
      const candidate = path.join(output, 'kernel-candidate.oml');
      fs.writeFileSync(candidate, 'candidate of ' + path.basename(snapshot.path));
      build.end = Date.now(); build.customer = log.customerOf(output); log.builds.push(build);
      return { ok: true, candidate, receipt: null, warnings: [] };
    },
    checkJobKernel: async () => ({ ok: true }),
  };
  const prepareManifest = async ({ base, candidate, output, feature }) => {
    await sleep(MANIFEST_MS);
    fs.mkdirSync(output, { recursive: true });
    const file = path.join(output, 'manifest.json');
    fs.writeFileSync(file, JSON.stringify({ schema: 'odc3-manifest/1', feature, module: log.moduleOf(output), basePath: base, candidatePath: candidate, evidenceDir: path.join(output, 'evidence') }, null, 2));
    return { ok: true, manifest: file };
  };
  return async (c, module) => runWithExecutor(c.context, () => withStudioWriteLock({ tool: 'studio_deliver', args: { module, feature: 'f-' + module, pid: 7000 }, lane: 'odc', phased: true },
    () => phasedDeliver({ job: c.job, module, feature: 'f-' + module, owners: ['owner'], changes: ['rename'], pid: 7000 + CUSTOMERS.indexOf(c.tokenId) },
      phasedDeliveryDeps({ root: lib.root, studio: lib.studio, prepareManifest, env: process.env, pool, kernel }), { deliver: lib.deliver })));
}

async function bench(parallel) {
  const log = { builds: [], merges: [], customers: new Map(), modules: new Map() };
  const customers = CUSTOMERS.map((token, i) => customer(token, i, log));
  log.customerOf = output => customers.find(c => output.startsWith(c.dirs.workspace))?.tokenId ?? null;
  log.moduleOf = output => MODULES.find(m => output.includes('f-' + m)) ?? null;
  const deliver = server(log);
  const calls = customers.flatMap(c => MODULES.map(module => ({ c, module })));
  const started = Date.now();
  let answers;
  if (parallel) answers = await Promise.all(calls.map(({ c, module }) => deliver(c, module)));
  else { answers = []; for (const { c, module } of calls) answers.push(await deliver(c, module)); }
  return { wallMs: Date.now() - started, answers, log, customers };
}

test('wp hosted: 3 customers x 3 deliveries through their agents build at the same time, fairly, and each Studio merges one at a time', { timeout: 120000 }, async t => {
  const serial = await bench(false);
  for (const answer of serial.answers) assert.equal(answer.result, 'entregue', JSON.stringify(answer).slice(0, 800));
  const parallel = await bench(true);
  for (const answer of parallel.answers) assert.equal(answer.result, 'entregue', JSON.stringify(answer).slice(0, 800));

  // Each delivery has its own lab folder, inside its own customer's workspace.
  const evidence = parallel.answers.map(a => a.evidence);
  assert.equal(new Set(evidence).size, evidence.length, 'two deliveries of one customer never share a lab folder');
  for (const c of parallel.customers) assert.equal(evidence.filter(e => e.startsWith(c.dirs.workspace)).length, MODULES.length);

  // The merges of one customer's Studio never overlap; different customers' Studios merge at the same time.
  for (const token of CUSTOMERS) {
    const own = parallel.log.merges.filter(m => m.customer === token);
    assert.equal(own.length, MODULES.length);
    for (let i = 0; i < own.length; i++) for (let j = i + 1; j < own.length; j++) assert.ok(!overlap(own[i], own[j]), token + ': two merges of one Studio overlapped');
  }
  // Fairness: every customer's first build starts before any customer's third.
  const builds = [...parallel.log.builds].sort((a, b) => a.start - b.start);
  assert.equal(builds.length, 9);
  const firstOf = token => builds.findIndex(b => b.customer === token);
  const thirdOf = token => builds.map((b, i) => [b, i]).filter(([b]) => b.customer === token)[2]?.[1] ?? Infinity;
  for (const a of CUSTOMERS) for (const b of CUSTOMERS) assert.ok(firstOf(a) < thirdOf(b), 'fairness: ' + a + ' first build after ' + b + ' third');
  // The most builds running at one instant (at the start of a build).
  const concurrent = Math.max(...builds.map(b => builds.filter(o => o.start <= b.start && b.start < o.end).length));
  assert.ok(concurrent > 1 && concurrent <= SLOTS, 'builds at once: ' + concurrent);
  // Nothing of one customer reached another's agent.
  for (const c of parallel.customers) for (const call of c.link.calls.filter(x => x.kind === 'odc.pipe')) assert.ok(!JSON.stringify(call.params).includes('tok_'), 'no foreign token in a command');

  const report = { customers: CUSTOMERS.length, deliveriesPerCustomer: MODULES.length, slots: SLOTS, buildMs: BUILD_MS, manifestMs: MANIFEST_MS, snapshotMs: SNAPSHOT_MS, mergeMs: MERGE_MS,
    serialMs: serial.wallMs, parallelMs: parallel.wallMs, speedup: Math.round(serial.wallMs / parallel.wallMs * 100) / 100, maxConcurrentBuilds: concurrent };
  t.diagnostic('fase4 wp load: ' + JSON.stringify(report));
  console.log('fase4 wp load: ' + JSON.stringify(report));
  assert.ok(parallel.wallMs < serial.wallMs * 0.5, JSON.stringify(report));
});
