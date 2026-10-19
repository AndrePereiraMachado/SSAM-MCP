// The checks of ssam_code on a hosted server (review of feat/ssam-code-hosted, M2): a check is a cold apply of the kernel,
// a plan hands each of up to 8 subagents a check, and every customer shares the container's few CPUs. So at most a few
// checks of one customer run at once and at most a few of the whole server, the others wait in one queue in the order they
// came (a customer at its ceiling never holds the queue for another); a check's candidate.oml and work folder are removed
// when it ends (its job stays, the base of a correction), and those an interrupted check left are removed once old, so the
// candidates of a plan never pile up in the workspace quota. Fake checks: no kernel, no agent, no Studio.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { checkSlots, checkCeilings, hostedCheck, CANDIDATE_MAX_AGE_MS } from '../hosted/checks.mjs';
import { createSsamServer } from '../ssam.mjs';
import { runWithExecutor } from '../executor.mjs';
import { fakeAgentLink, hostedDirs, cleanupHostedDirs } from './fixtures/fake-agent-link.mjs';

test.after(cleanupHostedDirs);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const write = (file, content = 'x') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file; };

// A fake check that holds a slot for `ms` and notes how many of its customer and of the server run beside it.
function meter() {
  const now = { total: 0, by: {} }, peak = { total: 0, by: {} }, order = [];
  const check = (key, id, ms = 40) => async () => {
    now.total++; now.by[key] = (now.by[key] ?? 0) + 1; order.push('start ' + id);
    peak.total = Math.max(peak.total, now.total); peak.by[key] = Math.max(peak.by[key] ?? 0, now.by[key]);
    await sleep(ms);
    now.total--; now.by[key]--; order.push('end ' + id);
    return { ok: true, id };
  };
  return { check, peak, order };
}

test('M2: the slots hold a ceiling per customer and one for the server; the waiting checks run in the order they came, and a customer at its ceiling never holds another', async () => {
  const slots = checkSlots({ global: 3, perCustomer: 2 });
  const m = meter();
  const a = Array.from({ length: 8 }, (_, i) => slots.run('A', m.check('A', 'A' + i)));
  await sleep(5);
  const b = [0, 1].map(i => slots.run('B', m.check('B', 'B' + i)));
  const answers = await Promise.all([...a, ...b]);
  assert.deepEqual(answers.map(x => x.id), ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'B0', 'B1']);
  assert.equal(m.peak.by.A, 2, 'never more than 2 checks of one customer');
  assert.equal(m.peak.total, 3, 'never more than 3 of the server');
  assert.ok(m.order.indexOf('start B0') < m.order.indexOf('start A3'), 'B ran while A waited at its ceiling: ' + m.order.join(', '));
  const startsA = m.order.filter(e => e.startsWith('start A'));
  assert.deepEqual(startsA, ['start A0', 'start A1', 'start A2', 'start A3', 'start A4', 'start A5', 'start A6', 'start A7'], 'first come, first served');
  assert.deepEqual(slots.state(), { running: 0, waiting: 0, byCustomer: {} });
  // a check that fails gives its slot back
  await assert.rejects(slots.run('A', async () => { throw new Error('boom'); }), /boom/);
  assert.deepEqual(slots.state(), { running: 0, waiting: 0, byCustomer: {} });
});

test('M2: the ceilings come from the CPUs of the container (its cgroup quota too) or from the owner\'s settings', () => {
  assert.deepEqual(checkCeilings({}, 2), { global: 1, perCustomer: 1 }, '2 CPUs: one check at a time, one CPU left to the server');
  assert.deepEqual(checkCeilings({}, 3), { global: 2, perCustomer: 2 });
  assert.deepEqual(checkCeilings({}, 16), { global: 4, perCustomer: 2 });
  assert.deepEqual(checkCeilings({}, 1), { global: 1, perCustomer: 1 });
  assert.deepEqual(checkCeilings({ SSAM_CODE_CHECKS: '6', SSAM_CODE_CHECKS_PER_CUSTOMER: '3' }, 2), { global: 6, perCustomer: 3 });
  assert.deepEqual(checkCeilings({ SSAM_CODE_CHECKS: '2', SSAM_CODE_CHECKS_PER_CUSTOMER: '5' }, 2), { global: 2, perCustomer: 2 }, 'a customer never above the server');
  assert.deepEqual(checkCeilings({ SSAM_CODE_CHECKS: 'many', SSAM_CODE_CHECKS_PER_CUSTOMER: '0' }, 3), { global: 2, perCustomer: 2 }, 'a value that is no positive integer is ignored');
});

test('M2: a hosted check removes its candidate.oml and work folder when it ends, keeps its job; nothing outside the check folders is touched', async () => {
  const dirs = hostedDirs(os.tmpdir());
  const context = { workspace: dirs.workspace };
  for (const folder of [['o11', 'jobs', 'check'], ['odc', 'lab', 'jobs', 'check']]) {
    const dir = path.join(dirs.workspace, ...folder, 'c-' + folder.length);
    const check = hostedCheck(context, async () => {
      write(path.join(dir, 'candidate.oml'), 'module rebuilt'); write(path.join(dir, 'candidate.oml.result.json'), '{}'); write(path.join(dir, 'work', 'model', 'a.json'), '{}');
      return { ok: true, action: 'check', job: write(path.join(dir, 'job.json'), '{"ops":[]}') };
    }, { slots: checkSlots({ global: 1, perCustomer: 1 }) });
    const answer = await check({ lane: 'odc', action: 'check' });
    assert.equal(answer.ok, true);
    assert.equal(fs.existsSync(path.join(dir, 'candidate.oml')), false, folder.join('/') + ': the candidate is gone');
    assert.equal(fs.existsSync(path.join(dir, 'work')), false, 'the work folder is gone');
    assert.equal(fs.existsSync(path.join(dir, 'candidate.oml.result.json')), false, 'the kernel result of the candidate is gone');
    assert.equal(fs.readFileSync(path.join(dir, 'job.json'), 'utf8'), '{"ops":[]}', 'the job stays: a correction is based on it');
  }
  // a refused check names a job of the customer elsewhere: nothing there is removed
  const own = write(path.join(dirs.workspace, 'inbox', 'candidate.oml'), 'the user\'s own file');
  const job = write(path.join(dirs.workspace, 'inbox', 'job.json'), '{}');
  const refused = await hostedCheck(context, async () => ({ ok: false, code: 'CHECK_REFUSED', job }), { slots: checkSlots() })({});
  assert.equal(refused.code, 'CHECK_REFUSED');
  assert.equal(fs.existsSync(own), true);
});

test('M2: the candidates an interrupted check left are removed once old, at the next check or plan of the customer; a recent one stays', async () => {
  const dirs = hostedDirs(os.tmpdir());
  const context = { workspace: dirs.workspace };
  const old = path.join(dirs.workspace, 'o11', 'jobs', 'check', 'old');
  const recent = path.join(dirs.workspace, 'odc', 'lab', 'jobs', 'check', 'recent');
  for (const dir of [old, recent]) { write(path.join(dir, 'candidate.oml'), 'left'); write(path.join(dir, 'work', 'x.bin'), 'left'); write(path.join(dir, 'job.json'), '{}'); }
  const past = new Date(Date.now() - CANDIDATE_MAX_AGE_MS - 60000);
  for (const file of [path.join(old, 'candidate.oml'), path.join(old, 'work', 'x.bin'), path.join(old, 'work'), old]) fs.utimesSync(file, past, past);
  let ran = 0;
  await hostedCheck(context, async () => { ran++; return { ok: false, code: 'INPUT_INVALID' }; }, { slots: checkSlots() })({});
  assert.equal(ran, 1);
  assert.equal(fs.existsSync(path.join(old, 'candidate.oml')), false, 'old: removed');
  assert.equal(fs.existsSync(path.join(old, 'work')), false);
  assert.equal(fs.existsSync(path.join(old, 'job.json')), true, 'its job stays');
  assert.equal(fs.existsSync(path.join(recent, 'candidate.oml')), true, 'recent: kept (a check may still be running)');
  assert.ok(CANDIDATE_MAX_AGE_MS >= 15 * 60000, 'older than the longest apply of a check (15 min)');
});

test('M2: through a hosted server, the checks of two customers share the server ceiling and each its own', async t => {
  const slots = checkSlots({ global: 3, perCustomer: 2 });
  const m = meter();
  const customer = async name => {
    const dirs = hostedDirs(os.tmpdir());
    const link = fakeAgentLink({ agentRoot: dirs.agentRoot, tokenId: 'tok_' + name, customer: name });
    const executor = { id: 'fake-' + name, hosted: true, quota: { full: () => false }, o11Connection: () => ({ pid: 6001 }), async call() { return {}; } };
    const context = { id: 'ctx-' + name, hosted: true, tokenId: 'tok_' + name, customer: name, lanes: ['odc', 'o11'], workspace: dirs.workspace, agent: link, executor, close: async () => {} };
    const session = { tokenId: 'tok_' + name, customer: name, lanes: ['odc', 'o11'], workspace: dirs.workspace, agent: link };
    let n = 0;
    // created in the customer's context, as the hosted server does (its task folder is the customer's)
    const server = await runWithExecutor(context, () => createSsamServer({ o11: false, odc: false, deps: { codeCheck: async () => m.check(name, name + n++, 500)() },
      hosted: { context, session, run: runWithExecutor, checkSlots: slots } }));
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'hosted-code-checks-' + name, version: '1.0.0' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    t.after(async () => { await client.close(); await server.close(); });
    return client;
  };
  const [a, b] = await Promise.all([customer('A'), customer('B')]);
  // distinct checks of one customer (the same call made twice at once is one run); B makes the same two calls as A, which
  // never join A's (the identical-call index is each customer's)
  const call = (client, i) => client.callTool({ name: 'ssam_code', arguments: { lane: 'odc', action: 'check', module: 'Orders', part: 'logic', text: 'action X' + i + ' {}' } });
  const results = await Promise.all([...Array.from({ length: 6 }, (_, i) => call(a, i)), call(b, 0), call(b, 1)]);
  for (const r of results) assert.equal(r.structuredContent?.ok, true, JSON.stringify(r).slice(0, 400));
  assert.equal(m.peak.by.A, 2, 'A never above its ceiling: ' + m.order.join(', '));
  assert.ok(m.peak.by.B >= 1 && m.peak.by.B <= 2, 'B: ' + m.order.join(', '));
  assert.equal(m.peak.total, 3, 'the server never above its ceiling');
  assert.ok(m.order.indexOf('start B0') < m.order.indexOf('start A5'), 'B ran while checks of A waited: ' + m.order.join(', '));
});
