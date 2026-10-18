// Offline answer-size replay. All writes are confined to the caller's scratch root.
import './fixtures/isolated-profile.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { discoverAll } from '../tool-routing.mjs';
import { snapshotSources } from './fixtures/discovery-results.mjs';
import { shapeToolResult } from '../responses.mjs';
import { pageAnswer } from '../ssam.mjs';
import { fitAnswer, fitResult } from '../answer-size.mjs';
import { deliverOutcome } from '../o11-cycle.mjs';
import { deliverKernel, interpretKernelResult, requiredFlowLayoutEngine } from '../kernel-delivery.mjs';
import { moduleMap, digestFile, flowFile, richFile, ROLES } from '../module-map.mjs';
import { RICH_SCHEMA, RICH_EXTRACTOR, PROPERTY_TYPES } from '../module-rich.mjs';
import { DIGEST_EXTRACTOR, DIGEST_SECTIONS } from '../module-digest.mjs';
import { FLOW_EXTRACTOR } from '../module-flow.mjs';
import { writeCapture, writeIndex } from './fixtures/module-index.mjs';
import { registerSsamReference } from '../ssam-reference.mjs';
import { warningFields } from '../delivery-warnings.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const fixture = name => readJson(path.join(here, 'fixtures', name));
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
// Count executed recovery calls separately from the six fixed R7 requests.
// Cut calls can share a round; continuations depend on the preceding response.
export async function observeRecovery(initial, execute, { maxCalls = 1000 } = {}) {
  const queue = [{ call: initial, depth: 0 }], records = [], seen = new Set();
  while (queue.length) {
    if (records.length >= maxCalls) throw new Error('Recovery call limit exceeded');
    const { call, depth } = queue.shift(), key = JSON.stringify(call);
    if (seen.has(key)) throw new Error('Recovery repeated the same call');
    seen.add(key);
    const response = await execute(call);
    const value = response.structuredContent ?? (response.content ? JSON.parse(response.content[0].text) : response);
    records.push({ call, depth, bytes: bytes(value), value });
    const next = [...(value.cuts ?? []).map(cut => cut.recover), value.continuation, ...(value.continuation?.more ?? []),
      value.omitted, ...(value.omitted?.more ?? []), value.next].filter(c => c?.tool && c.arguments);
    if (call.tool === 'ssam_evidence' && Number.isInteger(value.next)) {
      if (value.next <= (call.arguments.offset ?? 0)) throw new Error('Evidence recovery offset did not advance');
      next.push({ tool: call.tool, arguments: { ...call.arguments, offset: value.next } });
    }
    for (const continuation of next) queue.push({ call: { tool: continuation.tool, arguments: continuation.arguments }, depth: depth + 1 });
  }
  return { initialCalls: 1, recoveryCalls: records.length - 1, calls: records.length, bytes: records.reduce((n,r) => n+r.bytes,0),
    sequentialRounds: records.length, parallelRounds: Math.max(...records.map(r=>r.depth))+1, records };
}
export function replayKind(tool, args, value) {
  if (value?.ok === false) return 'refusal';
  if (tool === 'ssam_discover' && (args.packet || value?.schemaVersion === 'ssam-packet/1')) return 'packet';
  if (['o11_deliver', 'studio_deliver', 'ssam_job', 'o11_job'].includes(tool) || (tool === 'ssam_code' && (args.action === 'write' || args.mode === 'write'))) return 'receipt';
  if (tool === 'ssam_discover' && !['expand', 'detail', 'type', 'packet', 'catalog'].some(k => args[k])) return 'discoverFirst';
  return ['ssam_map', 'ssam_reference', 'o11_inspect', 'studio_inspect'].includes(tool) ? 'read' : 'other';
}

function storedReadings(root, lane, capture, env) {
  const actions = Array.from({ length: 20 }, (_, i) => ({ key: 'A' + i, kind: 'ServerAction', name: 'Read' + i, section: 'actions', public: false, function: false, in: 'Id: Long Integer', out: 'Value: Text', calls: [], calledBy: [] }));
  const sections = DIGEST_SECTIONS.map(id => ({ id, title: id, count: id === 'actions' ? actions.length : 0, blocks: id === 'actions' ? actions.map(a => ({ key: a.key, kind: a.kind, name: a.name, text: `server action ${a.name} @${a.key}\n  in Id: Long Integer\n  out Value: Text\n` + '  Value = "fixture"\n'.repeat(30) })) : [] }));
  sections[0].blocks.push({ key: 'R0', kind: 'ESpace', name: 'Quotes', text: 'ssam-digest/1 module=Quotes lane=' + lane + ' key=@R0' });
  const digest = { schema: 'ssam-digest/1', extractor: DIGEST_EXTRACTOR, lane, adapter: 'kernel', sourceSha256: capture.sha256, sourceBytes: 42, createdAt: '2026-10-13T00:00:00Z', module: { name: 'Quotes', key: 'R0', kind: 'Service' }, elements: 20, notRendered: 0, clipped: 0, readErrors: 0, sections, actions };
  const flow = { schema: 'ssam-flow/1', extractor: FLOW_EXTRACTOR, lane, adapter: 'kernel', sourceSha256: capture.sha256, sourceBytes: 42, createdAt: digest.createdAt, module: digest.module, notWritten: {}, actions: [{ key: 'A0', kind: 'ServerAction', name: 'Read0', fixedPoint: true, nodes: 2, digestBytes: 100, text: 'server action Read0 @A0\n  in Id: Long Integer @p1\n  end @n1\n', ids: { start: 'S0' }, problems: [] }] };
  const rich = { schema: RICH_SCHEMA, extractor: RICH_EXTRACTOR, lane, adapter: 'kernel', sourceSha256: capture.sha256, sourceBytes: 42, createdAt: digest.createdAt, module: digest.module, complete: true, readErrors: 0, errorSamples: [], counts: {}, roles: ROLES, propertyTypes: PROPERTY_TYPES, types: [{ kind: 'ESpace', answers: ['IESpace'] }], names: ['Description'], references: [], rows: [['R0', 0, 'Quotes', -1, ROLES.indexOf('module'), [[0, 't', 'Quote fixture module']], [], null]] };
  for (const [file, value] of [[digestFile(lane, capture.sha256, env), digest], [flowFile(lane, capture.sha256, env), flow], [richFile(lane, capture.sha256, env), rich]]) {
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value));
  }
}

/** Fixed R1-R7 samples; rawValue is shaped before the final size layer. */
export async function createReplay({ root, includeDiscover = true, includeExtended = false }) {
  fs.mkdirSync(root, { recursive: true });
  const rows = [];
  const add = (id, tool, args, input) => {
    const resultInput = input?.content ? input : reply(input);
    // Match served_: packets and recoverable packet parts already carry their
    // exact executable calls. The common fit/page policy still applies below.
    const shaped = ['ssam-packet/1', 'ssam-packet-part/1'].includes(resultInput?.structuredContent?.schemaVersion)
      ? resultInput : shapeToolResult(tool, args, resultInput, { lane: args.lane ?? (tool === 'o11_deliver' ? 'o11' : 'odc') });
    const result = pageAnswer(fitResult(tool, args, shaped, { root }), { root });
    const value = result.structuredContent ?? JSON.parse(result.content[0].text);
    const rawValue = shaped.structuredContent ?? JSON.parse(shaped.content[0].text);
    const row = { id, source: id.split('-')[0].includes('R2') ? 'R2-R3' : id.split('-')[0], tool, args, value, rawValue };
    rows.push(row); return row;
  };
  const phrases = Object.values(fixture('text-routes-phrases.json').routes).flat().slice(0, 10);
  if (includeDiscover) for (const lane of ['o11', 'odc']) for (const [i, phrase] of phrases.entries()) {
    const args = { lane, intent: phrase.intent };
    add(`R1-${lane}-${i}`, 'ssam_discover', args, await discoverAll({ ...args, sources: snapshotSources(lane) }));
    if (includeExtended) {
      const packetArgs = { ...args, packet: true };
      // No app: the offline snapshot carries examples/contracts but no live module.
      add(`R5-${lane}-${i}`, 'ssam_discover', packetArgs, await discoverAll({ ...packetArgs, sources: snapshotSources(lane) }));
    }
  }
  for (const [name, envelope] of Object.entries(fixture('o11-cycle-envelopes.json'))) {
    if (!envelope || typeof envelope !== 'object') continue;
    add(`R2-R3-o11-${name}`, 'o11_deliver', { module: 'Orders' }, deliverOutcome({ envelope }, { trackId: 'replay', work: root, job: path.join(root, 'job.json'), input: { module: 'Orders' } }));
  }
  const apply = fixture('jobs-apply-envelope.json');
  // The fixture predates the layout-version field; attach the current offline engine stamp
  // so the replay exercises candidate validation rather than the stale-component guard.
  add('R2-odc-apply', 'studio_deliver', { module: 'Fixture' }, interpretKernelResult({ ...apply, data: { ...apply.data, flowLayoutEngine: requiredFlowLayoutEngine } }, { output: root }));
  fs.writeFileSync(path.join(root, 'job.json'), '{"ops":[]}');
  const deliveryReceipt = path.join(root, 'odc-delivery', 'deliver-result.json');
  // The immutable kernel fixture is reused on repeated measurements; the answer
  // shaping and budget policy below always run again with the current code.
  const delivered = fs.existsSync(deliveryReceipt) ? readJson(deliveryReceipt) : await deliverKernel({ module: 'Fixture', feature: 'replay', job: 'job.json', owners: ['Screen'], changes: ['Replay fixture'] }, {
    root, nextLabDir: () => path.join(root, 'odc-delivery'), journal: () => {}, cache: null, grants: [],
    studio: async ([step]) => step === 'snapshot' ? { ok: true, path: 'base.oml', sha256: 'HASH', host: 'fixture.test' }
      : step === 'merge' ? { ok: true, merged: true, strictlyEqual: true } : { ok: true },
    apply: async () => ({ ok: true, candidate: 'candidate.oml', receipt: 'kernel-result.json' }),
    prepareManifest: async () => ({ ok: true, manifest: 'manifest.json' }),
  });
  add('R3-odc-delivered', 'studio_deliver', { module: 'Fixture' }, delivered);
  // Same kernel HIGH fixture as query-rules-responses.test.mjs, through both lane adapters.
  const kernelHigh = [{ code: 'AGGREGATES_MERGEABLE', severity: 'high', op: 1, owner: 'QrSummary',
    message: "GetOrder, GetOrderLines in 'QrSummary' read related entities (QrLine.OrderId -> QrOrder) and are used together: one aggregate with a join would do",
    fix: 'replace them with the single aggregate of `suggestion`', suggestion: { get: 'QrOrder', sources: ['QrLine'] } }];
  if (includeExtended) for (const refused of [false, true]) {
    const name = refused ? 'refusal' : 'receipt';
    const envelope = structuredClone(fixture('o11-cycle-envelopes.json')[refused ? 'refusedBeforeMerge' : 'delivered']);
    envelope.data.apply.highWarnings = kernelHigh;
    add(`R6-o11-${name}`, 'o11_deliver', { module: 'Orders' }, deliverOutcome({ envelope }, { trackId: 'replay', work: root, job: path.join(root, 'job.json'), input: { module: 'Orders' } }));
    const interpreted = interpretKernelResult({ ok: !refused, ...(refused ? { error: 'refused' } : {}), data: {
      accepted: !refused, isValid: !refused, flowLayoutEngine: requiredFlowLayoutEngine, highWarnings: kernelHigh, validation: { verdicts: [] } } }, { output: root });
    // deliverKernel applies warningFields to the adapter warnings on its final answer.
    add(`R6-odc-${name}`, 'studio_deliver', { module: 'Fixture' }, { ...(refused ? interpreted : delivered), ...warningFields(interpreted.warnings) });
  }
  const store = path.join(root, 'store'), env = { ...process.env, SSAM_MODULE_INDEX_ROOT: store, SSAM_READER_CACHE_ROOT: path.join(root, 'readers') };
  const capture = writeCapture(root, 'answer-replay-fixed-capture');
  const noReader = async () => { throw new Error('Replay must use stored fixtures, never a live reader'); };
  for (const lane of ['o11', 'odc']) {
    writeIndex(store, lane, capture.sha256); storedReadings(root, lane, capture, env);
    for (const [name, extra] of [['map', {}], ['search', { view: 'search', text: 'Quote' }], ['digest-1', { view: 'digest', page: 1, budgetBytes: 4096 }], ['digest-2', { view: 'digest', page: 2, budgetBytes: 4096 }], ['flow', { view: 'flow', element: 'Read0' }]]) {
      const args = { lane, target: capture.file, ...extra };
      const value = await moduleMap(args, { env, read: noReader, prepare: noReader });
      if (value.ok === false) throw new Error(`Invalid replay ${lane}/${name}: ${JSON.stringify(value)}`);
      add(`R4-${lane}-${name}`, 'ssam_map', args, value);
    }
  }
  let reference;
  registerSsamReference({ registerTool(_name, _schema, handler) { reference = handler; } }, { root: path.resolve(here, '../../../../kernel'), outDir: path.join(root, 'references'), env, runAnvil: async () => { throw new Error('Replay reference must remain offline'); } });
  for (const lane of ['o11', 'odc']) for (const [kind, query] of [['rules', 'all'], ['example', 'html/visual/block-event.html']]) {
    const args = { lane, kind, query }, result = await reference(args);
    add(`R4-${lane}-${kind}`, 'ssam_reference', args, result);
  }
  // Six calls per lane, in session order. Reuse the actual answers, keeping R7
  // independent from corpus groups; repetition resets at each lane/session.
  if (includeExtended && includeDiscover) for (const lane of ['o11', 'odc']) {
    const ids = [`R1-${lane}-0`, `R5-${lane}-0`, `R4-${lane}-rules`, `R4-${lane}-example`, `R6-${lane}-refusal`, `R6-${lane}-receipt`];
    for (const [index, id] of ids.entries()) {
      const row = rows.find(r => r.id === id);
      rows.push({ ...row, id: `R7-${lane}-${index}`, source: 'R7', session: lane });
    }
  }
  return rows;
}

// Replicated from the owner's repetition measurement: identical subtrees >=300
// chars, stop at a repeated subtree; whole-text duplicates; depth limit 6.
export function repetition(entries) {
  const seen = new Set(), per = {}, byKey = {};
  const hash = text => createHash('sha1').update(text).digest('hex');
  for (const { tool, text } of entries) {
    const p = per[tool] ??= { n: 0, chars: 0, repeated: 0, wholeDup: 0 };
    p.n++; p.chars += text.length;
    const th = 'T' + hash(text);
    if (seen.has(th)) { p.wholeDup++; p.repeated += text.length; continue; }
    seen.add(th);
    let object;
    try { object = JSON.parse(text.trim()); } catch {
      try { object = JSON.parse(text.slice(text.indexOf('{'))); } catch { continue; }
    }
    if (object && Array.isArray(object.content) && object.content[0]?.type === 'text') {
      try { object = JSON.parse(object.content[0].text); } catch { /* preserve wrapper */ }
    }
    if (!object || typeof object !== 'object') continue;
    const walk = (value, key, depth) => {
      const serialized = JSON.stringify(value);
      if (serialized == null || serialized.length < 300) return;
      const digest = hash(serialized);
      if (seen.has(digest)) { p.repeated += serialized.length; byKey[tool + ' ' + key] = (byKey[tool + ' ' + key] ?? 0) + serialized.length; return; }
      seen.add(digest);
      if (depth > 6 || typeof value !== 'object') return;
      if (Array.isArray(value)) value.forEach(v => walk(v, key + '[]', depth + 1));
      else for (const [child, v] of Object.entries(value)) walk(v, key ? key + '.' + child : child, depth + 1);
    };
    walk(object, '', 0);
  }
  const total = Object.values(per).reduce((all, item) => Object.fromEntries(Object.keys(all).map(key => [key, all[key] + item[key]])), { n: 0, chars: 0, repeated: 0, wholeDup: 0 });
  return { per, byKey, total: { ...total, percent: total.chars ? 100 * total.repeated / total.chars : 0 } };
}

export function sessionRepetition(rows) {
  return Object.fromEntries(['o11', 'odc'].map(lane => [lane, repetition(rows.filter(r => r.source === 'R7' && r.session === lane).map(row => ({ tool: row.tool, text: JSON.stringify(row.value) })))]));
}

export function summarize(rows) {
  const groups = new Map();
  for (const row of rows) {
    const kind = row.kind ?? replayKind(row.tool, row.args ?? {}, row.value), key = `${row.source ?? 'R1-R4'}|${row.tool}|${kind}`;
    if (!groups.has(key)) groups.set(key, []); groups.get(key).push(bytes(row.value));
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, sizes]) => {
    sizes.sort((a, b) => a - b); const middle = Math.floor(sizes.length / 2);
    const [source, tool, kind] = key.split('|');
    return { source, tool, kind, n: sizes.length, median: sizes.length % 2 ? sizes[middle] : (sizes[middle - 1] + sizes[middle]) / 2, max: sizes.at(-1) };
  });
}

// Corpus records keep the original client value. Both entry modes infer the same
// minimal arguments, so B is measured against identical immutable inputs.
export function recordedArgs(tool, value, supplied = {}) {
  return { ...(value?.lane ? { lane: value.lane } : {}),
    ...(tool === 'ssam_discover' && (value?.schemaVersion === 'ssam-packet/1' || (value?.packet && typeof value.packet === 'object')) ? { packet: true } : {}),
    ...supplied };
}

export function loadCorpus(directory) {
  const rows = [];
  const visit = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? visit(path.join(dir, entry.name)) : entry.name.endsWith('.json') ? [path.join(dir, entry.name)] : []);
  for (const file of visit(directory).sort()) {
    const record = readJson(file);
    // A manifest or report in the folder is metadata, not a recorded tool reply.
    if (!record || typeof record.tool !== 'string' || !Object.hasOwn(record, 'value')) continue;
    rows.push({ source: 'B', tool: record.tool, args: recordedArgs(record.tool, record.value, record.args), value: record.value });
  }
  return { rows, clientCut: 0 };
}

export function extractRollouts(directory, corpus) {
  fs.mkdirSync(corpus, { recursive: true }); const rows = []; let clientCut = 0, index = 0;
  const visit = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? visit(path.join(dir, e.name)) : e.name.endsWith('.jsonl') ? [path.join(dir, e.name)] : []);
  for (const file of visit(directory).sort()) {
    const calls = new Map();
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      let event; try { event = JSON.parse(line).payload; } catch { continue; }
      if (event?.type === 'custom_tool_call') {
        const matches = [...String(event.input ?? '').matchAll(/mcp__ssam[a-z_]*__(\w+)\s*\(/g)];
        if (matches.length === 1) calls.set(event.call_id, matches[0][1]);
      } else if (event?.type === 'custom_tool_call_output' && calls.has(event.call_id)) {
        const tool = calls.get(event.call_id); calls.delete(event.call_id);
        let output = event.output;
        if (Array.isArray(output)) output = output.map(x => x.text ?? '').join('\n');
        if (typeof output !== 'string') { clientCut++; continue; }
        try {
          const after = output.includes('Output:\n') ? output.slice(output.indexOf('Output:\n') + 8) : output;
          const start = after.indexOf('{'); if (start < 0) throw new Error('missing JSON');
          const value = JSON.parse(after.slice(start));
          const args = recordedArgs(tool, value);
          rows.push({ source: 'B', tool, args, value });
          fs.writeFileSync(path.join(corpus, `${String(++index).padStart(5, '0')}-${tool}.json`), JSON.stringify({ tool, args, value }));
        } catch { clientCut++; }
      }
    }
  }
  return { rows, clientCut };
}

export function comparison(before, after) {
  const index = new Map(after.groups.map(g => [[g.source, g.tool, g.kind].join('|'), g]));
  return ['| Set | Tool | Kind | n | Median before / after | Max before / after | Median change |', '| --- | --- | --- | ---: | ---: | ---: | ---: |', ...before.groups.map(a => {
    const b = index.get([a.source, a.tool, a.kind].join('|'));
    return `| ${a.source} | ${a.tool} | ${a.kind} | ${a.n} | ${a.median} / ${b?.median ?? '—'} | ${a.max} / ${b?.max ?? '—'} | ${b ? ((b.median / a.median - 1) * 100).toFixed(1) + '%' : '—'} |`;
  })].join('\n');
}

async function main(argv) {
  const at = flag => argv.indexOf(flag), option = flag => at(flag) >= 0 ? argv[at(flag) + 1] : null;
  if (at('--compare') >= 0) { console.log(comparison(readJson(argv[at('--compare') + 1]), readJson(argv[at('--compare') + 2]))); return; }
  const output = option('--json'), root = path.join(output ? path.dirname(path.resolve(output)) : path.resolve('C:/t/codex/cx11'), 'replay');
  let rows = await createReplay({ root, includeExtended: true }), clientCut = 0;
  if (option('--rollouts') && option('--corpus')) throw new Error('Use --rollouts once to extract, or --corpus to replay the frozen records; not both.');
  if (option('--rollouts') || option('--corpus')) {
    const real = option('--corpus') ? loadCorpus(option('--corpus'))
      : extractRollouts(option('--rollouts'), path.join(path.dirname(root), 'corpus'));
    rows.push(...real.rows.map(row => {
      // Recorded values have already crossed shapeToolResult. Replay just the new
      // output policy, retaining the original kind for an apples-to-apples table.
      const kind = replayKind(row.tool, row.args, row.value);
      const fitted = fitAnswer(row.tool, row.args, row.value, { root });
      const result = pageAnswer(reply(fitted), { root });
      return { ...row, kind, value: result.structuredContent ?? JSON.parse(result.content[0].text) };
    }));
    clientCut = real.clientCut;
  }
  const report = { schema: 'ssam-answer-replay/1', groups: summarize(rows), clientCut, repetition: sessionRepetition(rows),
    packetCuts: rows.filter(r => r.source === 'R5').map(({ id, value }) => ({ id, cuts: value.cuts ?? value.packet?.cuts ?? [], sections: Object.fromEntries(['module', 'text', 'environment', 'capabilities', 'example', 'rules', 'next'].map(key => [key, bytes(value[key] ?? null)])) })),
    warnings: rows.filter(r => r.source === 'R6').map(({ id, rawValue, value }) => ({ id, beforeBytes: bytes(rawValue), bytes: bytes(value), high: value.highWarnings?.length ?? 0,
      duplicated: (value.warnings ?? []).filter(w => (value.highWarnings ?? []).some(h => JSON.stringify(h) === JSON.stringify(w))).length, warningsTotal: value.warningsTotal ?? new Set([...(value.warnings ?? []), ...(value.highWarnings ?? [])].map(w => JSON.stringify(w))).size })),
    samples: rows.map(({ id, source, session, tool, args, value }) => ({ id, source: source ?? 'R1-R4', ...(session ? { session } : {}), tool, args, kind: replayKind(tool, args ?? {}, value), bytes: bytes(value) })) };
  if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(comparison(report, report)); console.log(`clientCut: ${clientCut}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
