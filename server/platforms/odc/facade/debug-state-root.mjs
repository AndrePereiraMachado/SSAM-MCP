// Debugger vault state (req 18). New records live outside %LOCALAPPDATA%, which each MSIX app (Claude, Codex) sees as
// its own private copy: %USERPROFILE%\.ssam-hybrid\debugger\<area> (SSAM_DEBUG_STATE_ROOT replaces the debugger
// folder; never .ssam, which is GitSSAM's). The legacy copies %LOCALAPPDATA%\SSAM\<Legacy> are listed READ ONLY:
// the process view (origin current, the only legacy copy this process may forget in), the real folder (real) and
// every package store %USERPROFILE%\AppData\Local\Packages\<PFN>\LocalCache\Local\SSAM\<Legacy> (package:<PFN>).
// Nothing in this module creates, writes or deletes; a symlink/junction anywhere below an anchor is refused, not
// followed. Precedent: service-center/index.mjs journalDefault, service-center/auth.mjs stateDir.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEBUG_STATE_AREAS = Object.freeze({ 'app-user': 'DebugAppUser', 'app-user-profiles': 'DebugAppUserProfiles', invoke: 'DebugInvoke', proofs: 'DebuggerProofs' });
const fail = code => { throw new Error('debug_state_root_' + code); };
const nonEmpty = value => typeof value === 'string' && value.trim() !== '';
const PFN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const legacyName = area => Object.hasOwn(DEBUG_STATE_AREAS, area) ? DEBUG_STATE_AREAS[area] : fail('area_invalid');
const homeOf = env => { const home = env.USERPROFILE || os.homedir(); if (!path.isAbsolute(home ?? '')) fail('profile_unavailable'); return home; };
const packageStore = value => /[\\/]Packages[\\/][^\\/]+[\\/]LocalCache([\\/]|$)/i.test(value);

export function debugStateBase(env = process.env) {
  if (nonEmpty(env.SSAM_DEBUG_STATE_ROOT)) {
    const value = env.SSAM_DEBUG_STATE_ROOT.replace(/[\\/]+$/, '');
    // Normalized absolute local folder only, and never inside another app's package store.
    if (!path.isAbsolute(value) || path.resolve(value) !== value || value.startsWith('\\\\') || packageStore(value)) fail('override_invalid');
    return value;
  }
  return path.join(homeOf(env), '.ssam-hybrid', 'debugger');
}
export function debugStateRoot(area, env = process.env) { legacyName(area); return path.join(debugStateBase(env), area); }

// The writable store of this process for an area. Its anchor is where the reparse walk starts.
export function debugStateStore(area, { env = process.env, stateRoot } = {}) {
  if (stateRoot !== undefined) { if (!path.isAbsolute(stateRoot ?? '')) fail('state_root_invalid'); return { origin: 'state', path: stateRoot, writable: true, anchor: path.dirname(stateRoot) }; }
  const root = debugStateRoot(area, env);
  return { origin: 'state', path: root, writable: true, anchor: nonEmpty(env.SSAM_DEBUG_STATE_ROOT) ? path.dirname(debugStateBase(env)) : homeOf(env) };
}

// %LOCALAPPDATA% as this process sees it (current) and the real folder under the profile (real), deduplicated.
export function localAppDataViews(env = process.env) {
  const views = [];
  if (nonEmpty(env.LOCALAPPDATA) && path.isAbsolute(env.LOCALAPPDATA)) views.push({ origin: 'current', path: env.LOCALAPPDATA });
  const real = path.join(homeOf(env), 'AppData', 'Local');
  if (!views.some(v => same(v.path, real))) views.push({ origin: 'real', path: real });
  return views;
}

// Read-only walk from the anchor down to the store: absent is an empty readable store; a link is refused.
export function inspectDebugStore(store) {
  const row = { origin: store.origin, path: store.path, writable: store.writable === true, exists: false, readable: false, entries: 0, names: [] };
  if (store.unreadable) return { ...row, error: store.error ?? 'unreadable' };
  const relative = path.relative(store.anchor ?? path.dirname(store.path), store.path);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return { ...row, error: 'anchor_invalid' };
  let current = store.anchor ?? path.dirname(store.path);
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { return error.code === 'ENOENT' ? { ...row, readable: true } : { ...row, error: error.code ?? 'unreadable' }; }
    if (stat.isSymbolicLink()) return { ...row, error: 'reparse' };
    if (!stat.isDirectory()) return { ...row, error: 'not_directory' };
  }
  try {
    const names = fs.readdirSync(store.path, { withFileTypes: true }).filter(entry => !entry.isDirectory()).map(entry => entry.name);
    return { ...row, exists: true, readable: true, entries: names.length, names };
  } catch (error) { return { ...row, error: error.code ?? 'unreadable' }; }
}

export function legacyDebugStateRoots(area, { env = process.env } = {}) {
  const legacy = legacyName(area), stores = [];
  for (const view of localAppDataViews(env))
    stores.push({ origin: view.origin, path: path.join(view.path, 'SSAM', legacy), writable: view.origin === 'current', anchor: view.path });
  const packages = path.join(homeOf(env), 'AppData', 'Local', 'Packages');
  let families;
  try { families = fs.readdirSync(packages, { withFileTypes: true }); }
  catch (error) {
    if (error.code !== 'ENOENT') stores.push({ origin: 'packages', path: packages, writable: false, anchor: path.dirname(packages), unreadable: true, error: error.code ?? 'unreadable' });
    return stores;
  }
  for (const family of families.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!family.isDirectory() && !family.isSymbolicLink()) continue;
    const store = { origin: 'package:' + (PFN.test(family.name) ? family.name : 'unrecognized'), path: path.join(packages, family.name, 'LocalCache', 'Local', 'SSAM', legacy), writable: false, anchor: packages };
    if (!PFN.test(family.name)) { stores.push({ ...store, unreadable: true, error: 'name_invalid' }); continue; }
    const seen = inspectDebugStore(store);
    if (seen.exists || !seen.readable) stores.push(seen.error === 'reparse' ? { ...store, unreadable: true, error: 'reparse' } : store);
  }
  return stores;
}

// The pending marker of a store that still holds entries or could not be read.
export const storePending = store => store.writable ? 'store:' + store.origin : 'legacy-store:' + store.origin.replace(/^package:/, '');
export const legacyInventoryOf = rows => rows.filter(r => r.origin !== 'state').map(r => ({ origin: r.origin, entries: r.entries, readable: r.readable }));

// Counts only (no record is opened): the new root plus every legacy copy, with a pending marker per non-empty store.
export function debugStoreInventory(area, { env = process.env, stateRoot, legacyRoots } = {}) {
  const state = debugStateStore(area, { env, stateRoot });
  const stores = [state, ...(legacyRoots ?? legacyDebugStateRoots(area, { env }))].map(inspectDebugStore).map(({ names, ...row }) => row);
  const pending = stores.filter(s => !s.readable || s.entries > 0).map(storePending);
  return { stateRoot: state.path, stores, legacyInventory: legacyInventoryOf(stores), empty: pending.length === 0, pending };
}
