import './fixtures/isolated-profile.mjs';
// Review refusal-followups M-B (C:\t\revisoes\refusal-followups\REVISAO.md; a9-followups-line H, the same rule): never change
// semantics in silence. E2 took the type of an exception of SSAM out of the prose a licensee is served ("KernelRefusalException:
// <message>"), and its rule (exposure.mjs EXCEPTION_TYPE, "...Exception:" with no space required after the colon) also took
// the kind out of SSAM's own references to exception elements, Type:Name with no space (IUserException:OrderClosed,
// ISystemException:All Exceptions, IRoleException:...): the fix of REFERENCE_UNRESOLVED "use one of: IUserException:OrderClosed"
// became "use one of: OrderClosed", which is a literal, not a reference (JobPreflight.BaseReferences); the summary of the
// catalog's exception capability lost "IUserException:" too. The family: only the name of a .NET exception before its message
// ("<Type>: <message>", always a space after the colon, as the kernel writes it) leaves the prose; a reference stays as it is.
// Here: the rule (scrubRuntimeText, scrubText), the end of the hub for a licensee (exposedResult of ssam_job and ssam_discover,
// and ssam_job on a fake CLI), the catalog's own references, a real .NET name, and the guard's detector.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jobTool } from '../job-runner.mjs';
import { exposedResult, scrubRuntimeText, scrubText } from '../exposure.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';
import { findings } from './fixtures/internal-text.mjs';
import { servedBytesStore } from '../served-bytes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'no-internals-exception-refs-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const brief = value => String(JSON.stringify(value) ?? '').slice(0, 1500);
const asResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: value?.ok === false });

// SSAM's texts with references to exception elements, as the kernel writes them.
const REFERENCES = {
  // JobRunner.cs REFERENCE_UNRESOLVED: its message, and its fix ("use one of: " + Type + ":" + name, ...)
  unresolved: 'IUserException:OrderClosd does not resolve in the base module: no IUserException named OrderClosd',
  fix: 'use one of: IUserException:OrderClosed, IUserException:OrderCancelled; or create it earlier in this job',
  // Errors.cs ForwardRefs.Explain
  forward: 'IUserException:OrderClosed does not exist yet at this point of the job: it is created at op #3 (IUserException). Create it before op #1, or move op #1 after op #3',
  // LogicExpander.cs: the system exception and a user exception, each as a reference
  system: 'ISystemException:All Exceptions does not resolve in the base module: raise ISystemException:NotRegistered or IUserException:OrderClosed instead',
  // a role exception reference (kernel/tests/jobs-negative/delete-role-exception-in-use.json)
  role: 'set Exception to IRoleException:Not DelExcRole on the handler',
};
// The type of an exception before its message: these leave the prose, the message stays.
const TYPED = [
  ['op #0 (html Login): KernelRefusalException: the base changed', 'op #0 (html Login): the base changed'],
  ['the apply failed <- InvalidOperationException: the reading is gone', 'the apply failed <- the reading is gone'],
  ['Anvil.Core.Kernel.KernelRefusalException: Login is not the reading', 'Login is not the reading'],
  // a real .NET name and message (System.Linq)
  ['System.InvalidOperationException: Sequence contains no elements', 'Sequence contains no elements'],
  ['cause <- System.IO.IOException: The process cannot access the file', 'cause <- The process cannot access the file'],
];
const referencesIn = text => String(text).match(/\bI[A-Z][A-Za-z]*Exception:(?=\S)[^\s,;)]*/g) ?? [];

test('M-B: the rule keeps SSAM\'s references to exception elements (Type:Name), in runtime and in documentation prose', () => {
  for (const [name, text] of Object.entries(REFERENCES)) {
    assert.equal(scrubRuntimeText(text), text, 'runtime ' + name);
    assert.equal(scrubText(text), text, 'documentation ' + name);
  }
});

test('M-B: the type of a .NET exception before its message still leaves the prose; an OutSystems exception a flow raises stays', () => {
  for (const [text, out] of TYPED) {
    assert.equal(scrubRuntimeText(text), out, 'runtime: ' + text);
    assert.equal(scrubText(text), out, 'documentation: ' + text);
  }
  const platform = 'the scenario raised UserException: Order is closed, and DatabaseException: duplicate key';
  assert.equal(scrubRuntimeText(platform), platform);
  // a reference and a typed message in one text: the reference stays, the type goes
  assert.equal(scrubRuntimeText('IUserException:OrderClosed is raised <- KernelRefusalException: the base changed'), 'IUserException:OrderClosed is raised <- the base changed');
});

test('M-B: every exception reference of the catalog\'s documentation reaches a licensee as it is (ssam_discover)', () => {
  const fragment = JSON.parse(fs.readFileSync(path.join(here, '..', 'catalog', 'fragments', 'A', 'logic-exception.json'), 'utf8'));
  const texts = [];
  JSON.stringify(fragment, (k, v) => { if (typeof v === 'string' && referencesIn(v).length) texts.push(v); return v; });
  assert.ok(texts.length >= 5, 'the fragment has references: ' + texts.length);
  for (const text of texts) assert.deepEqual(referencesIn(scrubText(text)), referencesIn(text), text.slice(0, 160));
  const capability = fragment.capabilities.find(c => c.id === 'logic.exception');
  assert.match(capability.summary, /\(IUserException:<Name>\)/);
  const discovery = { schemaVersion: 'ssam-discovery/1', intent: 'raise a user exception', capabilities: [capability] };
  const shown = exposedResult(asResult(discovery), { exposure: 'licensee', tool: 'ssam_discover', args: { intent: 'raise a user exception' } }).structuredContent.capabilities[0];
  assert.deepEqual(referencesIn(shown.summary), referencesIn(capability.summary), brief(shown.summary));
  assert.deepEqual(referencesIn(shown.route.operation), referencesIn(capability.route.operation), brief(shown.route));
});

test('M-B: a licensee\'s refused job keeps the references of its message and fix (exposedResult of ssam_job)', () => {
  const refusal = { ok: false, code: 'REFERENCE_UNRESOLVED', error: REFERENCES.unresolved,
    problems: [{ op: 1, pointer: '/ops/1/value', code: 'REFERENCE_UNRESOLVED', severity: 'error', message: REFERENCES.unresolved, fix: REFERENCES.fix },
      { op: 2, pointer: '/ops/2/target', code: 'REFERENCE_FORWARD', severity: 'error', message: REFERENCES.forward, fix: REFERENCES.system }] };
  for (const exposure of ['licensee', 'owner']) {
    const shown = exposedResult(asResult(refusal), { exposure, tool: 'ssam_job', args: { lane: 'odc' } }).structuredContent;
    assert.equal(shown.error, REFERENCES.unresolved, exposure);
    assert.deepEqual(shown.problems.map(p => [p.message, p.fix]), refusal.problems.map(p => [p.message, p.fix]), exposure + ': ' + brief(shown.problems));
  }
});

test('M-B: ssam_job on a fake CLI: the licensee reads the fix of REFERENCE_UNRESOLVED with its references, and no type of SSAM', async t => {
  const root = fs.mkdtempSync(path.join(tmp, 'root-'));
  const env = { ...process.env, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1' };
  const problem = { phase: 'preflight', op: 0, pointer: '/ops/0/value', code: 'REFERENCE_UNRESOLVED', severity: 'error', message: REFERENCES.unresolved, fix: REFERENCES.fix, patch: null };
  const runAnvil = fakeAnvil({ apply: () => ({ exitCode: 1, envelope: { ok: false, command: 'apply', elapsedMs: 5, code: 'REFERENCE_UNRESOLVED',
    error: 'op #0 (set Exception): KernelRefusalException: ' + REFERENCES.unresolved, problems: [problem] } }) });
  const guidance = async (_lane, _job, result) => result;
  const { createSsamServer } = await import('../ssam.mjs');
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { Client } = await import('@modelcontextprotocol/client');
  const store = servedBytesStore({ dir: fs.mkdtempSync(path.join(tmp, 'day-')) });
  const server = await createSsamServer({ profile: 'all', o11: false, odc: false, deps: { answersRoot: root,
    jobTool: input => jobTool(input, { root, env, o11Lane: 'ss4', runAnvil, guidance }),
    exposure: { profile: 'licensee', caller: () => 'exception-refs-' + process.pid, store, dayBytes: 500 * 1024 * 1024 } } });
  const client = new Client({ name: 'no-internals-exception-refs', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await server.close(); });
  const once = async (name, args) => { const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 }); return r.structuredContent ?? JSON.parse(r.content[0].text); };
  let body = await once('ssam_job', { lane: 'o11', job: { ops: [{ op: 'set', target: '$raise', prop: 'Exception', value: 'IUserException:OrderClosd' }] } });
  for (let i = 0; i < 240; i++) {
    const next = [body?.continuation, body?.next].find(c => c && typeof c === 'object' && c.arguments && Object.hasOwn(c.arguments, 'continueTask'));
    if (!next) break;
    await sleep(100); body = await once(next.tool, next.arguments);
  }
  assert.equal(body.ok, false, brief(body));
  const [p] = body.problems ?? [];
  assert.equal(p?.fix, REFERENCES.fix, brief(body));
  assert.equal(p.message, REFERENCES.unresolved);
  assert.doesNotMatch(JSON.stringify(body), /KernelRefusalException/);
  assert.deepEqual(findings(body).filter(f => f.family === 'exception type'), [], brief(findings(body)));
});

test('M-B: the guard\'s detector finds a type before its message, never a reference', () => {
  for (const text of Object.values(REFERENCES)) assert.deepEqual(findings({ fix: text }).filter(f => f.family === 'exception type'), [], text);
  for (const [text] of TYPED) assert.deepEqual(findings({ error: text }).map(f => f.family).filter(f => f === 'exception type'), ['exception type'], text);
  assert.deepEqual(findings({ note: 'the flow raised UserException: Order is closed' }), []);
});
