// A preview profile prepared by ssam_preview itself when the target has none and it can be (proto dd4264de and d5394178,
// relato 84a4a6a3 of 23/10: profiles:[] and installationRequired:true left a migration without any visual comparison; meta
// of 20/10 item 18 had only said who prepares). Possible means: a qualified preparation input the integrator left in the
// private folder (<workspace>/.local/preview/inputs/<id>.json, schema ssam-preview-input/1: the arguments of prepareProfile
// but the directory, with the host and watcher configurations pinned by sha256), the engine of its lane installed
// (preview/engines/<lane>/host.mjs) and a private folder that can be written. Then prepareProfile writes a fresh folder
// under .local/preview/profiles, registerProfile adds it to the catalog and the answer says PREVIEW_PROFILE_PREPARED.
// Otherwise PREVIEW_PROFILE_NOT_PREPARED names what is missing and the exact path and command the integrator uses; nothing
// is guessed from a URL, a screen or an app.
//
// Confinement (r4-w3-preview, the line's rule for what a call may read): the call is an app session's, so everything this
// preparation READS is inside the workspace, lexically and by the real path of its nearest existing ancestor (a junction or
// a symbolic link that leads out is outside): the inputs folder, each input file, and the whole graph the host
// configuration pins (round 2, confinedGraph: every path of every JSON it reaches, transitively, because the engine reads
// them at open; the selectionFile prepareProfile copies included). A path outside is a reason PATH_OUTSIDE_WORKSPACE and
// nothing is prepared. An input with watcherConfig is never prepared here (round 2: the watcher loads the compiler code its
// configuration names and attaches to the Studio process it names): only the integrator's command prepares it, and the
// reason names that command. Every preparer takes the same prepare.lock (prepare.mjs withPrepareLock). The input's id names the new folder, so it is a profile id
// (^[a-z0-9][a-z0-9-]{0,79}$) before any path is built. A hosted call never prepares (the hosted gate
// already answers ssam_preview with HOSTED_UNAVAILABLE; this is the second wall): no input is read and nothing is written.
// The integrator's own command (prepare.mjs --input) runs in the integrator's shell and keeps reading the qualified files
// wherever they are installed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, readJson } from './profile.mjs';
import { freshFolder, notRegistered, prepareProfile, registerProfile, withPrepareLock, PREPARE_SCRIPT, INPUT_SCHEMA } from './prepare.mjs';
import { hostedContext, servedWithoutContext } from '../executor.mjs';

export { INPUT_SCHEMA };
const here = path.dirname(fileURLToPath(import.meta.url));
export const ENGINES = path.join(here, 'engines');
const validId = id => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(id);

export function inputsFolder(workspace, env = process.env) {
  return env.SSAM_PREVIEW_INPUTS ? path.resolve(env.SSAM_PREVIEW_INPUTS) : path.join(workspace, '.local', 'preview', 'inputs');
}

// True when file is inside workspace, lexically and by the real path of its nearest existing ancestor.
const within = (base, target) => { const rel = path.relative(base, target); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };
function nearestReal(target) {
  let probe = target;
  while (!fs.existsSync(probe)) { const up = path.dirname(probe); if (up === probe) break; probe = up; }
  return fs.realpathSync.native(probe);
}
export function insideWorkspace(workspace, file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || /[\x00-\x1f]/.test(file) || /^[\\/]{2}/.test(file)) return false;
  const full = path.resolve(file);
  if (!within(path.resolve(workspace), full)) return false;
  try {
    const real = nearestReal(full), wsReal = fs.realpathSync.native(workspace);
    return real === wsReal || within(wsReal, real);
  } catch { return false; }
}
const outside = (input, what) => ({ input, why: `PATH_OUTSIDE_WORKSPACE: ${what} is outside the workspace of this SSAM; nothing was read there` });

// The whole graph a host configuration pins, confined (review of round 1: a host config inside the root whose own
// contextContract or runtimeAssets pinned files outside made open read and serve them). From the pin, every JSON file it
// reaches is read (sha256 checked when the pin has one) and walked: a string is a path when its key names one (file, path,
// *File, *Path, *Dir, *Root, *Directory, *Folder) or when it is written as one (a drive letter, \\ or // at the start, a
// leading \, a file: URL). Every path must be inside the workspace by path and real path; a relative one may not climb (no
// '..') and is checked against the workspace and the folder of the file that names it. The mutable state files
// prepareProfile replaces in the host configuration (statusFile, stateFile, ledgerFile, endpointFile, hostImplementation)
// are not read. The answer is the list of reasons ([] when all of it is inside), each PATH_OUTSIDE_WORKSPACE <where>.
const PATH_KEY = /^(?:file|path)$|(?:File|Path|Dir|Root|Directory|Folder)$/;
const REPLACED = new Set(['statusFile', 'stateFile', 'ledgerFile', 'endpointFile', 'hostImplementation']);
const WRITTEN_AS_PATH = /^(?:[A-Za-z]:|[\\/]{2}|\\|file:)/i;
const GRAPH_FILES = 256, GRAPH_BYTES = 16 * 1024 * 1024;
export function confinedGraph(workspace, pin, where) {
  const reasons = [], seen = new Set();
  const refuse = at => reasons.push(`PATH_OUTSIDE_WORKSPACE: ${at} is outside the workspace of this SSAM; nothing was read there and nothing is prepared`);
  const resolveIn = (value, folder) => {
    if (/^file:/i.test(value)) { try { value = fileURLToPath(value); } catch { return null; } }
    if (/[\x00-\x1f]/.test(value)) return null;
    if (path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return insideWorkspace(workspace, value) ? path.resolve(value) : null;
    if (value.split(/[\\/]/).includes('..')) return null;
    const fromFolder = path.resolve(folder, value), fromRoot = path.resolve(workspace, value);
    return insideWorkspace(workspace, fromFolder) && insideWorkspace(workspace, fromRoot) ? fromFolder : null;
  };
  const visit = (file, sha256, at) => {
    let real;
    try { real = fs.realpathSync.native(file); } catch { return; } // (a missing file: the engine refuses it, nothing to walk)
    if (seen.has(real.toLowerCase())) return;
    seen.add(real.toLowerCase());
    if (seen.size > GRAPH_FILES) { reasons.push(`PREVIEW_PIN_GRAPH_TOO_LARGE: ${where} reaches more than ${GRAPH_FILES} files`); return; }
    let bytes;
    try {
      if (fs.statSync(real).size > GRAPH_BYTES) { reasons.push(`PREVIEW_PIN_GRAPH_TOO_LARGE: ${at} is over ${GRAPH_BYTES} bytes`); return; }
      bytes = fs.readFileSync(real);
    } catch (error) { reasons.push(`${at}: ${error.code ?? 'PREVIEW_PIN'} ${error.message}`); return; }
    if (sha256 && digest(bytes) !== sha256) { reasons.push(`${at}: PREVIEW_PIN_CHANGED`); return; }
    let value;
    try { value = JSON.parse(bytes.toString('utf8').replace(/^﻿/, '')); } catch { return; } // (not JSON: a leaf the engine reads as it is)
    walk(value, at + '>', path.dirname(real), at === where);
  };
  const walk = (node, at, folder, top, key = null) => {
    if (typeof node === 'string') {
      if (!(key != null && PATH_KEY.test(key)) && !WRITTEN_AS_PATH.test(node)) return;
      // (a route of a scenario endpoint, {path:"/screenservices/..."}, is a URL path, not a file: only a pin's path is a file)
      if (key === 'path' && /^\/(?!\/)/.test(node)) return;
      const resolved = resolveIn(node, folder);
      if (!resolved) { refuse(at); return; }
      if (/\.json$/i.test(resolved)) visit(resolved, null, at);
      return;
    }
    if (Array.isArray(node)) { node.forEach((item, i) => walk(item, at + '/' + i, folder, false, key)); return; }
    if (!node || typeof node !== 'object') return;
    const pinKey = typeof node.sha256 === 'string' ? (typeof node.file === 'string' ? 'file' : typeof node.path === 'string' ? 'path' : null) : null;
    for (const [k, v] of Object.entries(node)) {
      if (top && REPLACED.has(k)) continue;
      // A provenance record (the compiler and archive a capture came from) is evidence: no engine follows a path of it
      // (o11/contracts.mjs and assemble-release.mjs only require that it exists), so nothing of it is read here either.
      if (k === 'provenance') continue;
      if (k === pinKey) {
        const resolved = resolveIn(v, folder);
        if (!resolved) { refuse(at + '/' + k); continue; }
        if (/\.json$/i.test(resolved)) visit(resolved, node.sha256, at + '/' + k);
        continue;
      }
      walk(v, at + '/' + k, folder, false, k);
    }
  };
  if (!insideWorkspace(workspace, pin?.file)) { refuse(where + '/file'); return reasons; }
  visit(pin.file, pin.sha256, where);
  return reasons;
}

const matches = (args, input) => (!args.profile || args.profile === input.id) && (!args.lane || args.lane === input.lane)
  && (!args.app || args.app === input.target?.app) && (!args.tenant || args.tenant === input.target?.tenant);

// The inputs of the folder that name this target, each read and checked (a bad one is a reason, never a crash).
function candidates(workspace, folder, args) {
  if (!insideWorkspace(workspace, folder)) return { found: [], reasons: [outside(folder, 'the inputs folder (SSAM_PREVIEW_INPUTS)')] };
  let names = [];
  try { names = fs.readdirSync(folder).filter(n => n.toLowerCase().endsWith('.json')).sort(); } catch { return { found: [], reasons: [] }; }
  const found = [], reasons = [];
  for (const name of names) {
    const file = path.join(folder, name);
    if (!insideWorkspace(workspace, file)) { reasons.push(outside(file, 'the input')); continue; }
    let input;
    try { input = readJson(file); } catch (error) { reasons.push({ input: file, why: 'not JSON: ' + error.message }); continue; }
    if (input?.schema !== INPUT_SCHEMA) { reasons.push({ input: file, why: `schema is not ${INPUT_SCHEMA}` }); continue; }
    if (matches(args, input)) found.push({ file, input });
  }
  return { found, reasons };
}

// {prepared} when a profile was prepared and registered, {notPrepared} with the reasons and the integrator's block otherwise.
export function autoPrepare(args, { workspace, catalogFile, env = process.env, engines = ENGINES, now = () => new Date() } = {}) {
  const folder = inputsFolder(workspace, env);
  const target = { ...(args.lane ? { lane: args.lane } : {}), ...(args.app ? { app: args.app } : {}), ...(args.tenant ? { tenant: args.tenant } : {}) };
  const slug = (validId(args.profile) ? args.profile : [args.lane, args.app].filter(Boolean).join('-').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+/, '').slice(0, 80)) || 'profile';
  const integrator = extra => ({
    by: 'integrator', why: 'no prepared local preview matches this target and none could be prepared here: ' + (extra.length ? extra.map(r => r.why).join('; ') : 'no qualified preparation input names it'),
    input: path.join(folder, slug + '.json'),
    schema: { schema: INPUT_SCHEMA, id: '<profile id: a-z0-9->', lane: args.lane ?? '<o11|odc>', target: { app: args.app ?? '<app>', moduleKey: '<module key>', tenant: args.tenant ?? '<host>' },
      screens: [{ name: '<screen>', key: '<screen key>' }], limitations: ['<what this preview does not show>'], hostConfig: { file: '<absolute qualified host config>', sha256: '<sha256>' },
      watcherConfig: '<optional, odc: { file, sha256 }; only the command above prepares an input with it>', port: '<loopback port>' },
    command: `node ${PREPARE_SCRIPT} --input "<the input above>"` + (catalogFile ? ` --catalog "${catalogFile}"` : ''),
    then: 'the next ssam_preview call prepares and registers it by itself when the input has no watcherConfig and every file its host configuration pins, transitively, is inside this workspace (PREVIEW_PROFILE_PREPARED)',
    api: PREPARE_SCRIPT + ' prepareProfile({directory, id, lane, target:{app, tenant}, screens, limitations, hostConfig, watcherConfig?, port})',
    doc: 'docs/PREVIEW-LOCAL.md',
    meanwhile: { tool: 'ssam_app_url', arguments: { app: args.app ?? '<app>', screen: '<screen>', ...(args.lane ? { lane: args.lane } : {}) },
      why: "the published screen opens in the person's browser; SSAM does not capture or compare it" },
    target,
    ...(extra.length ? { reasons: extra } : {}) });
  if (hostedContext() || servedWithoutContext()) return { notPrepared: integrator([{ why: 'HOSTED_UNAVAILABLE: a hosted server never prepares a local preview; nothing was read or written' }]) };
  const { found, reasons } = candidates(workspace, folder, args);
  if (found.length === 0) return { notPrepared: integrator(reasons) };
  if (found.length > 1) return { notPrepared: integrator([{ why: `${found.length} inputs name this target (${found.map(f => String(f.input.id)).join(', ')}): select profile` }]) };
  const [{ file, input }] = found;
  const problems = [];
  if (!validId(input.id)) problems.push({ input: file, why: 'PREVIEW_PROFILE_SCHEMA: id must match ^[a-z0-9][a-z0-9-]{0,79}$' });
  const engine = path.join(engines, String(input.lane ?? ''));
  if (!['o11', 'odc'].includes(input.lane)) problems.push({ input: file, why: 'lane must be o11 or odc' });
  else if (!fs.existsSync(path.join(engine, 'host.mjs'))) problems.push({ input: file, why: `the ${input.lane} engine is not installed (${path.join(engine, 'host.mjs')})` });
  // A watcher loads code its configuration names (compiler.file) and attaches to the Studio process it names: never from an
  // input of the folder, only through the integrator's command (r4-w3-preview, round 2).
  if (input.watcherConfig != null) problems.push({ input: file, why: `PREVIEW_WATCHER_INTEGRATOR_ONLY: an input with watcherConfig is prepared only by the integrator's command: node ${PREPARE_SCRIPT} --input "${file}"` + (catalogFile ? ` --catalog "${catalogFile}"` : '') });
  else problems.push(...confinedGraph(workspace, input.hostConfig, 'hostConfig').map(why => ({ input: file, why })));
  if (problems.length) return { notPrepared: integrator(problems) };
  let directory, profile, created = false;
  try {
    // (one preparation at a time per catalog, the integrator's command included: prepare.mjs withPrepareLock)
    withPrepareLock(catalogFile, () => {
      notRegistered({ catalogFile, id: input.id });
      directory = freshFolder(path.join(path.dirname(catalogFile), 'profiles'), input.id, now());
      try {
        profile = prepareProfile({ directory, id: input.id, lane: input.lane, target: input.target, screens: input.screens, limitations: input.limitations,
          hostConfig: input.hostConfig, port: input.port, engines });
      } catch (error) { created = error?.createdDirectory === directory; throw error; }
      created = true;
      registerProfile({ catalogFile, profile });
    });
  } catch (error) {
    // Only the folder this call created is removed (never another preparer's: PREVIEW_FRESH_DIRECTORY created nothing).
    if (created) fs.rmSync(directory, { recursive: true, force: true });
    return { notPrepared: integrator([{ input: file, why: `${error.code ?? 'PREVIEW_PREPARE_FAILED'}: ${error.message}` }]) };
  }
  return { prepared: { code: 'PREVIEW_PROFILE_PREPARED', profile: input.id, lane: input.lane, target: input.target, directory, input: file, pin: profile,
    why: 'no prepared profile matched this target; the qualified input in the private folder was prepared and registered by this call' } };
}
