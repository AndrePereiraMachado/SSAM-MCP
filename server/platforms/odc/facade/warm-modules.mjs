// L3b (lote 3 de velocidade, plano 2026-10-24 §8): the modules a session will touch are warm before its first call.
// At startup (ssam.mjs warmBackground, behind SSAM_NO_WARM, once the lane's worker is up) the server asks each lane's worker
// to prepare the spare of the known captures of the modules open in the Studio (anvil-worker.mjs warmSpares, the worker's
// `warm`): the first read (`ssam_map` flow/digest through the worker, S14) and the first build of such a module then load
// nothing. The worker prepares them while idle and gives a load up for any request that needs another base, as for every
// spare (BaseModelCache); nothing here waits for them, and ssam_doctor reads how many are ready (spareStatus).
//   - o11: the tabs of the selected Service Studio (bridge list_open_modules, in their order), each with the capture of its
//     tab's model when the bridge gives the fingerprint (list_open_modules:model_sha256), else its newest capture; without a
//     Studio, the newest known captures (o11-capture-store.mjs recentCaptures). At most 3.
//   - odc: the newest ODC snapshots (<odcRoot>/snapshots/<module>-<sha>.oml with their .json: developerId, contentSha256);
//     the ODC worker keys a spare by its author, so the request carries the snapshot's developerId. At most 3.
// Never throws: a lane that cannot be warmed says why in its state and the call that needs the module loads it as before.
import fs from 'node:fs';
import path from 'node:path';
import { recentCaptures, findCapture, isModelSha } from './o11-capture-store.mjs';
import { warmSpares, workerDisabled, ping, workerTarget } from './anvil-worker.mjs';

export const WARM_LIMIT = 3;
const state = new Map(); // lane -> {asked:[{path, model, moduleKey?, module?}], source, at, used, note}
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; } };
const isFile = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };

// The O11 captures to warm: open tabs first (bridge), else the newest known ones. bridge(): an o11Bridge client.
export async function o11WarmCaptures({ local, bridge, limit = WARM_LIMIT } = {}) {
  let tabs = null;
  if (bridge) {
    try {
      const listed = await bridge().ok('list_open_modules', {}, { timeoutMs: 5000 });
      tabs = (Array.isArray(listed?.modules) ? listed.modules : []).filter(m => typeof m?.key === 'string' && m.key && m.hasESpace !== false);
    } catch { tabs = null; }
  }
  if (!tabs) return { source: 'known', captures: recentCaptures(local, { limit }) };
  const captures = [];
  for (const tab of tabs) {
    if (captures.length >= limit) break;
    let model = null;
    // the tab's model fingerprint, one module at a time (a bridge without it answers the list without modelSha256)
    try {
      const one = await bridge().ok('list_open_modules', { model_sha256_of: String(tab.name) }, { timeoutMs: 10000 });
      const row = (Array.isArray(one?.modules) ? one.modules : []).find(m => m?.key === tab.key);
      model = isModelSha(row?.modelSha256) ? row.modelSha256 : null;
    } catch { model = null; }
    const exact = model ? findCapture(local, { moduleKey: tab.key, model }) : null;
    // A tab whose model no capture has is not warmed (its newest capture is an older module); without a fingerprint, the newest.
    const row = exact ? { path: exact.path, model, moduleKey: tab.key, module: tab.name ?? null } : model ? null : recentCaptures(local, { moduleKeys: [tab.key], limit: 1 })[0] ?? null;
    if (row) captures.push(row);
  }
  return { source: 'studio', captures };
}

// The ODC snapshots to warm: the newest ones, each with its author and content identity from its .json.
export function odcWarmCaptures({ odcRoot, limit = WARM_LIMIT } = {}) {
  const dir = path.join(odcRoot ?? '', 'snapshots');
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => /-[a-f0-9]{64}\.oml$/i.test(n)); } catch { return { source: 'known', captures: [] }; }
  const rows = names.map(name => {
    const file = path.join(dir, name), meta = readJson(file + '.json') ?? {};
    let time = Date.parse(meta.capturedAt);
    if (!Number.isFinite(time)) { try { time = fs.statSync(file).mtimeMs; } catch { time = 0; } }
    return { path: file, module: meta.module ?? null, developerId: typeof meta.developerId === 'string' ? meta.developerId : null,
      contentSha256: typeof meta.contentSha256 === 'string' ? meta.contentSha256 : null, time };
  }).filter(r => isFile(r.path)).sort((a, b) => b.time - a.time);
  // one per module, newest first
  const seen = new Set(), captures = [];
  for (const row of rows) { const k = String(row.module ?? row.path).toLowerCase(); if (seen.has(k)) continue; seen.add(k); captures.push(row); if (captures.length >= limit) break; }
  return { source: 'known', captures };
}

// Warms one lane. deps (tests): captures() -> {source, captures}, warm (warmSpares), now.
export async function warmModules(lane, { env = process.env, local, odcRoot, bridge, limit = WARM_LIMIT } = {}, deps = {}) {
  const { warm = warmSpares, now = () => new Date() } = deps;
  if (env.SSAM_NO_WARM === '1') return { lane, used: false, note: 'SSAM_NO_WARM=1' };
  if (workerDisabled(lane, env)) return { lane, used: false, note: 'worker disabled (ANVIL_WORKER=0 or ANVIL_ODC_NO_WORKER)' };
  let found;
  try {
    if (!deps.captures && lane === 'o11') {
      // the selected lane's folder and bridge, as the cycle reads them
      const { o11Lane } = await import('./workspace.mjs');
      if (local == null) local = (await import('./o11-lane.mjs')).o11LaneOf(o11Lane.lane, { env }).local;
      if (bridge === undefined) { const { o11Bridge, bridgeTarget } = await import('./o11-bridge.mjs'); bridge = () => o11Bridge(bridgeTarget({ lane: o11Lane.lane, env })); }
    }
    if (!deps.captures && lane === 'odc' && odcRoot == null) odcRoot = (await import('./workspace.mjs')).odcRoot;
    found = deps.captures ? await deps.captures() : lane === 'odc' ? odcWarmCaptures({ odcRoot, limit }) : await o11WarmCaptures({ local, bridge, limit });
  } catch (error) { found = { source: 'error', captures: [], note: String(error?.message ?? error) }; }
  const captures = (found.captures ?? []).slice(0, limit);
  const entry = { lane, source: found.source, asked: captures.map(c => ({ path: c.path, model: c.model ?? null, module: c.module ?? null })), at: now().toISOString(), used: false, note: found.note ?? null };
  state.set(lane, entry);
  if (!captures.length) { entry.note ??= 'no known capture to warm'; return { ...entry }; }
  // ODC: one request per author (a spare is loaded for its author); O11: one request.
  const groups = new Map();
  for (const c of captures) { const k = lane === 'odc' ? c.developerId ?? '' : ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); }
  const wanted = [];
  for (const [developerId, group] of groups) {
    const r = await warm(lane, { captures: group.map(c => ({ path: c.path, ...(c.contentSha256 ? { contentSha256: c.contentSha256 } : {}) })), developerId: developerId || null }, { env });
    if (!r.used) { entry.note = r.note; continue; }
    entry.used = true; entry.port = r.port;
    wanted.push(...(r.wanted ?? []));
  }
  // the worker's own model hash of each capture (a capture's recorded model is a hint; the worker read the file)
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  entry.asked = entry.asked.map(a => ({ ...a, model: wanted.find(w => typeof w?.file === 'string' && same(w.file, a.path))?.modelSha256 ?? a.model ?? null }));
  entry.wanted = wanted.filter(w => w?.wanted === true).length;
  return { ...entry };
}

export const warmState = () => Object.fromEntries([...state].map(([lane, e]) => [lane, { ...e }]));
export const resetWarmState = () => state.clear();

// What ssam_doctor says about the spares of each lane warmed in this process: asked, ready (a spare of its model is held now),
// warming (the worker is preparing one) and held. One ping per lane, 300 ms; null when nothing was warmed here.
export async function spareStatus({ lanes = null, env = process.env, pingWorker } = {}, deps = {}) {
  const wanted = [...state.keys()].filter(lane => !lanes || lanes.includes(lane));
  if (!wanted.length) return null;
  const out = {};
  await Promise.all(wanted.map(async lane => {
    const e = state.get(lane);
    let status = null;
    try { status = await (pingWorker ?? (name => ping(workerTarget(name, { env }), deps.pingMs ?? 300)))(lane); } catch { status = null; }
    const cache = status?.baseCache ?? null;
    const keys = new Set((Array.isArray(cache?.keys) ? cache.keys : []).map(k => String(k).toLowerCase()));
    const ready = e.asked.filter(a => isModelSha(a.model) && keys.has(a.model.slice(0, 16).toLowerCase())).length;
    out[lane] = { asked: e.asked.length, ready, held: Number(cache?.entries ?? status?.cachedModules ?? 0) || 0,
      warming: Array.isArray(cache?.warming) ? cache.warming.length : 0, source: e.source, since: e.at,
      ...(status ? {} : { worker: 'not answering' }), ...(e.used ? {} : { note: e.note }) };
  }));
  return out;
}
