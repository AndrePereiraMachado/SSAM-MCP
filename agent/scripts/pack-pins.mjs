// The hash pins of a pack.json besides its integrity list (review A1/M3 of F5): xifEngine.sha256, o11Bridge.sha256 and each
// o11Builds[].sha256 name a file that files[] lists too. Every step that changes a file of the pack (signing, staging the
// native core) recomputes them from files[] here, in ONE place, and the release gate checks them against the bytes: a pin
// left behind would silently drop a kind (o11.xif) or refuse a bridge on every machine.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifyPack } from '../src/main/core/pack-sync.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const DEFAULT_O11_BRIDGE = { dev: 'bin/o11/bridge/Anvil.Bridge.dll', h1: 'studio/o11/bridge/b1/Anvil.Bridge.dll' };

// Every pin of the pack: {field, path, sha256}.
export function pinsOf(pack) {
  const pins = [];
  if (pack?.xifEngine) pins.push({ field: 'xifEngine', path: String(pack.xifEngine.path ?? ''), sha256: pack.xifEngine.sha256 });
  if (pack?.o11Bridge?.sha256 !== undefined && pack?.o11Bridge?.sha256 !== null)
    pins.push({ field: 'o11Bridge', path: String(pack.o11Bridge.path ?? DEFAULT_O11_BRIDGE[pack.o11Hook ?? 'dev'] ?? DEFAULT_O11_BRIDGE.dev), sha256: pack.o11Bridge.sha256 });
  (Array.isArray(pack?.o11Builds) ? pack.o11Builds : []).forEach((build, i) => pins.push({ field: `o11Builds[${i}]`, path: String(build?.path ?? ''), sha256: build?.sha256 }));
  return pins;
}

// The pack with every pin taken from files[] (the entry of the same path). A pin whose file is not listed is an error.
export function recomputePins(pack) {
  const listed = new Map((pack.files ?? []).map(f => [String(f.path), f.sha256]));
  const take = (where, file) => {
    if (!listed.has(file)) throw new Error(`pack.json ${where} names ${file}, which its files list does not have`);
    return listed.get(file);
  };
  const next = { ...pack };
  if (pack.xifEngine) next.xifEngine = { ...pack.xifEngine, sha256: take('xifEngine', String(pack.xifEngine.path)) };
  if (pack.o11Bridge?.sha256 !== undefined && pack.o11Bridge?.sha256 !== null) {
    const file = String(pack.o11Bridge.path ?? DEFAULT_O11_BRIDGE[pack.o11Hook ?? 'dev'] ?? DEFAULT_O11_BRIDGE.dev);
    next.o11Bridge = { ...pack.o11Bridge, sha256: take('o11Bridge', file) };
  }
  if (Array.isArray(pack.o11Builds)) next.o11Builds = pack.o11Builds.map((b, i) => ({ ...b, sha256: take(`o11Builds[${i}]`, String(b.path)) }));
  return next;
}

// pack.json of a folder rewritten with its pins recomputed; returns the pack.
export function recomputePinsIn(packDir) {
  const file = path.join(packDir, 'pack.json');
  const next = recomputePins(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')));
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  return next;
}

// The problems of an installed pack: its integrity list (verifyPack, what the app's supervisor checks at every start) and
// every pin against the file's bytes. [] when the app accepts its own pack and every pinned binary is the one pinned.
export function packProblems(packDir) {
  const check = verifyPack(packDir);
  if (!check.ok) return ['the pack is not whole: ' + check.detail];
  const problems = [];
  for (const pin of pinsOf(check.pack)) {
    const file = path.join(packDir, ...pin.path.split('/'));
    if (!fs.existsSync(file)) { problems.push(`${pin.field} names ${pin.path}, which is not in the pack`); continue; }
    const actual = sha256(fs.readFileSync(file));
    if (pin.sha256 !== actual) problems.push(`${pin.field} pins ${pin.path} to ${pin.sha256}, the file is ${actual}`);
  }
  return problems;
}
