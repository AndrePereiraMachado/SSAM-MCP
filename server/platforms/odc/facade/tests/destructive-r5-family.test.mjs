import { isolatedProfile } from './fixtures/isolated-profile.mjs';
// CX15 r5, the family test extended (the r4 review: "0/40 did not cover validation refusals, publication, creation nor the
// debugger"): with ONE synthetic marker in the owner's words, in one process,
//   N-1 every validation refusal of the reviewer's probe (C1-C4, E1-E6, D1-D3) through the real hub;
//   N-2 studio_authorize, studio_publish, the standing grant, publishDelivered and studio_create_app behind the real
//       lib.mjs client() with a fake bridge (pipe lines, manifests, simulated publish-started / create-started);
//   N-3 the debugger's O11 wrapper grant -> run -> removal (its grant and receipts);
// then one sweep: every answer, every line of the fake bridge, and the files of the isolated profile, the hub's data and
// answers roots (.local\answers), the labs, manifests and evidence, and the debugger root. The marker must appear 0 times.
// CX15 r7: then every step {tool, arguments} written in ANY of those answers whose words are a text of the server is
// replayed verbatim through the hub (WORDS_REQUIRED, the kernel never called).
// The flows' own checks are asserted after the sweep, and a diagnostic line gives the counts. Fakes only, synthetic values.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createSsamServer } from '../ssam.mjs';
import { createFacadeServer } from '../mcp.mjs';
import { publishWithGrant } from '../studio-publish-log.mjs';
import { publishDelivered } from '../kernel-delivery.mjs';
import { createStudioCreateApp } from '../studio-create-app.mjs';
import { N1_CASES, M2_CASES } from './fixtures/destructive-r5-cases.mjs';
import { fakeBridge, delivery, BRIDGE_PID as PID, BRIDGE_HOST as HOST } from './fixtures/destructive-r5-bridge.mjs';
import { o11WrapperFixture, target, action } from './fixtures/destructive-r5-o11-wrapper.mjs';
import { MARK, count, filesWithMark, filesUnder } from './fixtures/destructive-r4-marker.mjs';
import * as ops from '../destructive-operations.mjs'; // a namespace: an older tree fails on the replays, not at import

process.env.SSAM_ODC_OFFLINE = '1';
const W = 'sim, pode seguir com ZZApp ' + MARK;

test('CX15 r5 family: validation refusals, publication, creation and the debugger never keep the owner\'s words in clear', async t => {
  const family = fs.mkdtempSync(path.join(os.tmpdir(), 'cx15r5-family-')); t.after(() => fs.rmSync(family, { recursive: true, force: true }));
  const sweep = [family, isolatedProfile];
  const answers = [], flows = [], expect = (ok, message) => flows.push({ ok: Boolean(ok), message });
  const connect = async (server, values = null) => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'cx15r5-family', version: '1.0.0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    t.after(async () => { await client.close(); await server.close(); });
    return async (tool, args) => { const r = await client.callTool({ name: tool, arguments: args });
      answers.push((r.content ?? []).map(c => String(c.text ?? '')).join(''), JSON.stringify(r.structuredContent ?? null));
      let value; try { value = r.structuredContent ?? JSON.parse(r.content?.[0]?.text ?? 'null'); } catch { value = { ok: false, text: r.content?.[0]?.text }; }
      values?.push(value); return value; };
  };

  // ---- N-1: the validation refusals, through the real hub.
  let hub = null;
  {
    const dataRoot = path.join(family, 'n1', 'data'), answersRoot = path.join(family, 'n1', 'answers'), lockRoot = path.join(family, 'n1', 'lock');
    for (const d of [dataRoot, answersRoot, lockRoot]) fs.mkdirSync(d, { recursive: true });
    const runs = [], hubValues = [];
    const call = await connect(await createSsamServer({ o11: true, odc: true, deps: { runAnvil: async argv => { runs.push(argv[0]); return { ok: false, exitCode: 2, envelope: { ok: false, error: 'fake' } }; },
      dataRoot, answersRoot, lock: { o11Root: lockRoot, odcRoot: lockRoot } } }), hubValues);
    let refused = 0;
    for (const [, [tool, args]] of Object.entries(N1_CASES(path.join(family, 'x.oml'), W))) if ((await call(tool, args))?.ok === false) refused++;
    expect(refused === Object.keys(N1_CASES('x', W)).length, 'N-1: every case is a refusal (' + refused + ')');
    expect(runs.length === 0, 'N-1: nothing ran');
    expect(filesUnder(path.join(answersRoot, '.local', 'answers')).length >= 1, 'N-1: the fitter kept a long refusal (the sweep sees .local\\answers)');
    // ---- CX15 r6 (M-2): the studio_command forms of the r5 review, through the same hub.
    let refusedM2 = 0;
    for (const [, args] of Object.entries(M2_CASES(path.join(family, 'synth', 'manifest.json'), W))) if ((await call('studio_command', args))?.ok === false) refusedM2++;
    expect(refusedM2 === Object.keys(M2_CASES('x', W)).length, 'M-2: every studio_command form is a refusal (' + refusedM2 + ')');
    hub = { call, runs };
  }

  // ---- N-2: publication and creation behind the real client().
  const bridge = fakeBridge();
  {
    const call = await connect(await createFacadeServer({ deps: { studio: bridge.studio, destructive: { root: path.join(family, 'n2', 'destructive') } } }));
    const lab = path.join(family, 'n2');
    const A = delivery(lab, 'a', 'ZZAppA'), B = delivery(lab, 'b', 'ZZAppB'), C = delivery(lab, 'c', 'ZZAppC'), E = delivery(lab, 'e', 'ZZAppE');
    expect((await call('studio_authorize', { manifest: A.manifest, kind: 'publish', text: W, pid: PID }))?.ok === true, 'N-2: studio_authorize');
    expect((await call('studio_publish', { manifest: B.manifest, authorize: W, wait: true, minutes: 1, pid: PID }))?.ok !== false, 'N-2: studio_publish');
    const granted = await publishWithGrant({ manifest: C.manifest, wait: true, minutes: 1, pid: PID }, { studio: bridge.studio, readManifest: f => JSON.parse(fs.readFileSync(path.resolve(f), 'utf8')),
      lab: path.join(lab, 'lab'), root: path.join(lab, 'grant-root'), catalog: () => null, grants: { findGrant: async () => ({ grantId: 'zz-grant-1', words: W }) } });
    answers.push(JSON.stringify(granted)); expect(granted?.ok !== false, 'N-2: the standing grant');
    const cli = path.join(lab, 'cli', 'anvil-odc.dll'); fs.mkdirSync(path.dirname(cli), { recursive: true }); fs.writeFileSync(cli, '');
    const runAnvil = async argv => {
      const outDir = argv[argv.indexOf('--out') + 1] ?? path.join(lab, 'create-out'), manifest = path.join(outDir, 'manifest.json');
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(manifest, JSON.stringify({ schema: 'odc3-manifest/1', module: 'ZZLibN2', moduleKey: 'zz-libkey', tenant: HOST, author: 'zz-dev', create: true, evidenceDir: path.join(outDir, 'evidence') }));
      return { envelope: { ok: true, data: { ok: true, manifest, moduleKey: 'zz-libkey', content: {} } }, stderr: [] };
    };
    const created = await createStudioCreateApp({ root: path.join(lab, 'kernel-root'), cli, runAnvil, studio: bridge.studio, tenants: async () => ({ tenants: {} }), appUrl: async () => ({ appUrl: 'https://zz' }) })(
      { action: 'create', kind: 'library', name: 'ZZLibN2', authorize: 'pode criar e publicar a ZZLibN2 ' + MARK, publish: true, pid: PID });
    answers.push(JSON.stringify(created)); expect(created?.ok !== false, 'N-2: studio_create_app');
    const delivered = await publishDelivered({ manifest: E.manifest, module: 'ZZAppE', words: W, pid: PID, minutes: 1 }, { studio: bridge.studio });
    answers.push(JSON.stringify(delivered)); expect(delivered?.publish?.outcome !== 'refused', 'N-2: publishDelivered');
    expect(bridge.lines.filter(l => l.startsWith('authorize ')).length >= 4, 'N-2: the authorize lines crossed the fake bridge');
    expect(fs.readFileSync(A.manifest, 'utf8').includes('sha256:'), 'N-2: the sweep sees the hashed words in a manifest');
  }

  // ---- N-3: the debugger's O11 wrapper grant -> run -> removal.
  {
    const f = o11WrapperFixture(t);
    sweep.push(f.root);
    answers.push(JSON.stringify(await f.runner({ ...target, op: 'authorize', words: W })));
    const ran = await f.runner({ ...target, op: 'run', action: action.name });
    answers.push(JSON.stringify(ran)); expect(ran?.ok === true, 'N-3: the wrapper run works with the hashed grant');
  }

  // ---- CX15 r6 (M-1) / r7: EVERY step {tool, arguments} the server wrote in ANY answer of the flows above (a refusal's
  // continuation, corrected, next steps, the hub, the facade, the publication, the creation and the debugger answers), whose
  // words field (WORD_KEYS at any depth, the text of studio_authorize, the words of a studio_command line) holds a text of
  // the server, is replayed verbatim through the real hub: each one is WORDS_REQUIRED and the kernel runner is never called.
  // The test finds those steps with its own oracle (serverWords: a <template>, the marker, OWNER_REPLY, a sha256, a text with
  // no letter), independent of the predicate under test; callWordsProblems only adds to them.
  {
    const SERVER_LINE = /<the user's own words>|<palavras do usu[aá]rio>|<the owner's next message|sha256:[0-9a-f]{64}/i; // the English marker since 16/10, the one before as alias
    const serverText = v => typeof v === 'string' && v.trim() !== '' && (/^<[^<>]*>$/s.test(v.trim()) || SERVER_LINE.test(v) || !/[\p{L}\p{N}]/u.test(v));
    const serverWords = (tool, args) => {
      let found = false;
      const walk = v => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
        if (['authorization', 'authorize', 'words', 'ownerRequest'].includes(k) && serverText(x)) found = true; else walk(x); } };
      walk(args);
      if (tool === 'studio_authorize' && serverText(args?.text)) found = true;
      if (tool === 'studio_command' && SERVER_LINE.test([args?.command ?? '', ...[].concat(args?.args ?? [])].join(' '))) found = true;
      return found;
    };
    const all = new Map(), collect = v => { if (Array.isArray(v)) v.forEach(collect); else if (v && typeof v === 'object') {
      if (typeof v.tool === 'string' && v.arguments && typeof v.arguments === 'object') all.set(JSON.stringify([v.tool, v.arguments]), v); Object.values(v).forEach(collect); } };
    for (const a of [...answers]) { try { collect(JSON.parse(a)); } catch { /* a text answer */ } }
    const steps = [...all.values()].filter(s => serverWords(s.tool, s.arguments) || (ops.callWordsProblems?.(s.tool, s.arguments) ?? []).length);
    const runsBefore = hub.runs.length, replays = [];
    for (const s of steps) { const r = await hub.call(s.tool, structuredClone(s.arguments)); replays.push({ tool: s.tool, ok: r?.ok, code: r?.code ?? null }); }
    t.diagnostic('cx15r7-replays ' + JSON.stringify({ stepsInAnswers: all.size, withServerWords: steps.length, others: [...all.values()].filter(s => !steps.includes(s)).map(s => s.tool + '{' + Object.keys(s.arguments).join(',') + '}'), tools: [...new Set(steps.map(s => s.tool))], codes: replays.map(r => r.tool + ':' + r.code) }));
    expect(steps.length >= 10, 'r6: the steps with server words in the answers (' + steps.length + ')');
    // r7: the hub refuses a server text as words before any tool rule, so every replay is WORDS_REQUIRED.
    expect(replays.every(r => r.ok === false && r.code === 'WORDS_REQUIRED'), 'r7: every step replayed verbatim is WORDS_REQUIRED: ' + JSON.stringify(replays.filter(r => r.code !== 'WORDS_REQUIRED')));
    expect(hub.runs.length === runsBefore, 'r6: the replays ran nothing');
  }

  // ---- The sweep: the marker 0 times.
  const marked = filesWithMark(sweep);
  t.diagnostic('cx15r5-family ' + JSON.stringify({ answers: answers.length, answersWithMark: answers.filter(a => count(a) > 0).length,
    bridgeLines: bridge.lines.length, bridgeLinesWithMark: bridge.lines.filter(l => count(l) > 0).length, filesSwept: sweep.flatMap(d => filesUnder(d)).length,
    filesWithMark: marked.map(p => path.relative(os.tmpdir(), p).replace(/[0-9a-f]{8}-[0-9a-f-]{27}|[0-9a-f]{64}/gi, '<id>')) }));
  assert.deepEqual(answers.map((a, i) => [i, count(a)]).filter(([, c]) => c > 0), [], 'every answer');
  assert.deepEqual(bridge.lines.filter(l => count(l) > 0).map(l => l.split(' ')[0]), [], 'every line of the fake bridge');
  assert.deepEqual(marked.map(p => path.relative(os.tmpdir(), p)), [], 'the isolated profile, .local\\answers, the labs, manifests, evidence and the debugger root');
  assert.deepEqual(flows.filter(f => !f.ok).map(f => f.message), [], 'every flow ran as it should');
});
