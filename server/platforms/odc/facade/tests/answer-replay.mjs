// Offline answer-size replay. All writes are confined to the caller's scratch root.
import './fixtures/isolated-profile.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

const here = path.dirname(fileURLToPath(import.meta.url));
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const fixture = name => readJson(path.join(here, 'fixtures', name));
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
export function replayKind(tool, args, value) {
  if (value?.ok === false) return 'refusal';
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

/** Fixed R1-R4 samples; rawValue is shaped before the final size layer. */
export async function createReplay({ root, includeDiscover = true }) {
  fs.mkdirSync(root, { recursive: true });
  const rows = [];
  const add = (id, tool, args, input) => {
    const shaped = shapeToolResult(tool, args, input?.content ? input : reply(input), { lane: args.lane ?? (tool === 'o11_deliver' ? 'o11' : 'odc') });
    const result = pageAnswer(fitResult(tool, args, shaped, { root }), { root });
    const value = result.structuredContent ?? JSON.parse(result.content[0].text);
    const rawValue = shaped.structuredContent ?? JSON.parse(shaped.content[0].text);
    rows.push({ id, tool, args, value, rawValue });
  };
  const phrases = Object.values(fixture('text-routes-phrases.json').routes).flat().slice(0, 10);
  if (includeDiscover) for (const lane of ['o11', 'odc']) for (const [i, phrase] of phrases.entries()) {
    const args = { lane, intent: phrase.intent };
    add(`R1-${lane}-${i}`, 'ssam_discover', args, await discoverAll({ ...args, sources: snapshotSources(lane) }));
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
  return rows;
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
          const args = { ...(value?.lane ? { lane: value.lane } : {}),
            ...(tool === 'ssam_discover' && (value?.schemaVersion === 'ssam-packet/1' || (value?.packet && typeof value.packet === 'object')) ? { packet: true } : {}) };
          rows.push({ source: 'B', tool, args, value });
          fs.writeFileSync(path.join(corpus, `${String(++index).padStart(5, '0')}-${tool}.json`), JSON.stringify({ tool, value }));
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
  const output = option('--json'), root = path.join(output ? path.dirname(path.resolve(output)) : path.resolve('C:/t/codex/cx7'), 'replay');
  let rows = await createReplay({ root }), clientCut = 0;
  if (option('--rollouts')) {
    const real = extractRollouts(option('--rollouts'), path.join(path.dirname(root), 'corpus'));
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
  const report = { schema: 'ssam-answer-replay/1', groups: summarize(rows), clientCut, samples: rows.map(({ id, source, tool, args, value }) => ({ id, source: source ?? 'R1-R4', tool, args, kind: replayKind(tool, args ?? {}, value), bytes: bytes(value) })) };
  if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(comparison(report, report)); console.log(`clientCut: ${clientCut}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
