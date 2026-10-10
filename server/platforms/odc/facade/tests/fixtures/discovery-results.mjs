// A committed snapshot of the stamped job results of both lane suites, for the index tests (discover-tools.test.mjs,
// discovery-shared.test.mjs). The real results live in kernel/.local/test-work and kernel/.local/lane-odc/test-work:
// empty in a fresh worktree, rewritten by the lane suites while other suites run, and the discovery index key includes
// their file stamps, so an answer read from them changed with the machine and the moment. The tests read this snapshot
// instead, materialized once per process in a private folder of their own with fixed names, bytes and mtimes (a stable
// index key, nothing another process writes).
//
// Each result keeps exactly what discovery.mjs reads (executionOf): accepted, isValid, flowLayoutEngine, the coverage
// ledgers, the whole provenance stamp and, per op, the result fields executionsOf attributes for that verb (a list keeps
// only its length). The Studio assembly hashes of the stamps are stored once per distinct set. The stamp is kept as it
// was written, so a snapshot result classifies like the real one: historical once the kernel or the Studio differs,
// never promoted to current.
//
// Refresh (after the O11 and ODC JobTests ran in a worktree):
//   node tests/fixtures/discovery-results.mjs <kernel dir of that worktree> [label, e.g. the commit]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { laneSources } from '../../discovery.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const RESULTS_BUNDLE = path.join(here, 'discovery-results.json');
const SCHEMA = 'ssam-discovery-results-snapshot/1';
const LANES = { odc: { results: ['.local', 'lane-odc', 'test-work'], jobs: 'jobs-odc' }, o11: { results: ['.local', 'test-work'], jobs: 'jobs' } };
// The result fields executionsOf (discovery.mjs) reads, per verb; any other verb only needs "an object".
const FIELDS = { get: ['iface', 'type'], dump: ['iface', 'type'], create: ['iface', 'type'], duplicate: ['iface', 'type', 'name'], usages: ['target', 'count', 'real'],
  replace: ['replaced', 'consumers', 'rewired', 'stillPointingAtFrom', 'consumersOfTo'], rename: ['renamed', 'consumers', 'expressionsRewritten'], move: ['target', 'moved', 'order'], delete: ['brokenConsumers'], set: ['set'] };

export function reduceResult(text, assemblySets) {
  let r = JSON.parse(text.replace(/^﻿/, ''));
  if (r.provenance == null && r.data && typeof r.data === 'object' && (r.data.provenance || r.data.coverage)) r = r.data;
  const reduceOne = (verb, res) => {
    if (res == null || typeof res !== 'object') return res ?? null;
    if (Array.isArray(res)) return res.map(() => 0);
    const out = {};
    for (const k of FIELDS[verb] ?? []) if (res[k] !== undefined) out[k] = res[k];
    if (verb === 'delete' && res.deleted && typeof res.deleted === 'object') out.deleted = { iface: res.deleted.iface ?? null, type: res.deleted.type ?? null };
    return out;
  };
  let provenance = r.provenance ?? null;
  if (provenance?.nativeAssemblies && typeof provenance.nativeAssemblies === 'object') {
    const key = JSON.stringify(provenance.nativeAssemblies);
    let at = assemblySets.findIndex(s => JSON.stringify(s) === key); if (at < 0) at = assemblySets.push(provenance.nativeAssemblies) - 1;
    provenance = { ...provenance, nativeAssemblies: { $set: at } };
  }
  return {
    accepted: r.accepted ?? null, isValid: r.isValid ?? null, flowLayoutEngine: r.flowLayoutEngine ?? null,
    ...(r.coverage ? { coverage: { ...(r.coverage.porTipo ? { porTipo: r.coverage.porTipo } : {}), ...(r.coverage.porInterface ? { porInterface: r.coverage.porInterface } : {}) } } : {}),
    // `opResults`: the reduced `results[i].result` of every op, in order (materialized back as results[i].result).
    ...(Array.isArray(r.results) ? { opResults: r.results.map(x => reduceOne(x?.op, x?.result)) } : {}),
    provenance,
  };
}

// The snapshot as result files: <tmp>/ssam-discovery-results-<pid>-*/<lane>/<job>.result.json, written once per process
// (removed at exit), every file with the capture time as mtime.
let materialized = null;
export function resultsSnapshot() {
  if (materialized) return materialized;
  const bundle = JSON.parse(fs.readFileSync(RESULTS_BUNDLE, 'utf8'));
  if (bundle.schema !== SCHEMA) throw new Error(`${path.basename(RESULTS_BUNDLE)}: schema ${bundle.schema}, expected ${SCHEMA}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ssam-discovery-results-${process.pid}-`));
  process.once('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp folder */ } });
  const mtime = new Date(bundle.capturedAt);
  const dirs = {};
  for (const [lane, results] of Object.entries(bundle.lanes)) {
    dirs[lane] = path.join(root, lane); fs.mkdirSync(dirs[lane]);
    for (const [job, { opResults, ...result }] of Object.entries(results)) {
      const p = result.provenance;
      const full = { ...result, ...(opResults ? { results: opResults.map(value => ({ result: value })) } : {}),
        provenance: p?.nativeAssemblies?.$set != null ? { ...p, nativeAssemblies: bundle.assemblySets[p.nativeAssemblies.$set] } : p };
      // A proven example is examples/<job>: its result lives in the examples subfolder, as the suites write it.
      const file = path.join(dirs[lane], ...job.split('/')) + '.result.json';
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(full)); fs.utimesSync(file, mtime, mtime);
    }
  }
  return (materialized = { root, dirs });
}
// The lane sources with the snapshot as the results folder (the rest as the lane resolves it).
export const snapshotSources = (lane, extra = {}) => ({ ...laneSources(lane), testWork: resultsSnapshot().dirs[lane], ...extra });

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // --merge keeps the snapshot's result of every job the source has no result for (a worktree that ran only some suites).
  const merge = process.argv.includes('--merge');
  const [from, label = null] = process.argv.slice(2).filter(a => a !== '--merge');
  if (!from) { console.error('usage: node tests/fixtures/discovery-results.mjs <kernel dir whose .local holds the stamped results> [label] [--merge]'); process.exit(2); }
  const kernelRepo = path.resolve(here, '..', '..', '..', '..', '..', 'kernel');
  const assemblySets = []; const lanes = {}; let capturedAt = null;
  const previous = merge ? JSON.parse(fs.readFileSync(RESULTS_BUNDLE, 'utf8')) : null;
  const kept = (lane, jobs) => Object.entries(previous?.lanes?.[lane] ?? {}).filter(([job]) => jobs.has(job) && !lanes[lane][job]).map(([job, entry]) => {
    const p = entry.provenance;
    if (p?.nativeAssemblies?.$set == null) return [job, entry];
    const set = previous.assemblySets[p.nativeAssemblies.$set]; const key = JSON.stringify(set);
    let at = assemblySets.findIndex(s => JSON.stringify(s) === key); if (at < 0) at = assemblySets.push(set) - 1;
    return [job, { ...entry, provenance: { ...p, nativeAssemblies: { $set: at } } }];
  });
  for (const [lane, def] of Object.entries(LANES)) {
    const source = path.join(from, ...def.results);
    // The suite jobs by name and the proven examples as examples/<job> (results in <test-work>/examples).
    const list = dir => { try { return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)); } catch { return []; } };
    const jobs = new Set([...list(path.join(kernelRepo, 'tests', def.jobs)), ...list(path.join(kernelRepo, 'tests', def.jobs, 'examples')).map(n => 'examples/' + n)]);
    const results = dir => { try { return fs.readdirSync(dir).filter(f => f.endsWith('.result.json')); } catch { return []; } };
    lanes[lane] = {};
    for (const file of [...results(source), ...results(path.join(source, 'examples')).map(f => 'examples/' + f)].sort()) {
      const job = file.slice(0, -'.result.json'.length); if (!jobs.has(job)) continue;
      const reduced = reduceResult(fs.readFileSync(path.join(source, ...file.split('/')), 'utf8'), assemblySets);
      lanes[lane][job] = reduced;
      const at = reduced.provenance?.at; if (at && (!capturedAt || at > capturedAt)) capturedAt = at;
    }
    const fresh = Object.keys(lanes[lane]).length;
    if (merge) lanes[lane] = Object.fromEntries([...Object.entries(lanes[lane]), ...kept(lane, jobs)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    console.log(`${lane}: ${fresh} results from ${source}${merge ? `, ${Object.keys(lanes[lane]).length - fresh} kept from the snapshot` : ''}`);
  }
  // One assembly set and one result per line, so a refresh reads as a diff per job.
  const line = (k, v) => `${JSON.stringify(k)}:${JSON.stringify(v)}`;
  const text = ['{', `"schema":${JSON.stringify(SCHEMA)},`, `"source":${JSON.stringify(label)},`, `"capturedAt":${JSON.stringify(capturedAt ?? new Date().toISOString())},`,
    '"assemblySets":[', assemblySets.map(s => JSON.stringify(s)).join(',\n'), '],',
    '"lanes":{', Object.entries(lanes).map(([lane, results]) => `${JSON.stringify(lane)}:{\n${Object.entries(results).map(([k, v]) => line(k, v)).join(',\n')}\n}`).join(',\n'), '}}', ''].join('\n');
  fs.writeFileSync(RESULTS_BUNDLE, text);
  console.log(`${path.basename(RESULTS_BUNDLE)}: ${Math.round(text.length / 1024)} KB, ${assemblySets.length} Studio assembly sets`);
}
