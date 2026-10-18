// A03 (owner decision, 2026-10-06): only Verify ERRORS block a delivery; every other new warning, outside the security list
// and the anonymous-access family (kernel SecurityWarnings.cs), comes back in the answer as a non-blocking warning
// (contract I9 of docs/PACOTE-ATRITOS-2.md): {id, path, key?, detail (one line, at most 200 characters), fix, count?}, a
// data: URL or base64 run cut with its size, equal ones once with count, at most 20 entries plus warningsTotal. The O11
// kernel task already carries the whole list (result.warnings, Delivery.cs); the ODC kernel apply
// carries its verdicts, read here with the same curated hints (kernel/catalog/verify-hints-*.json). Pure, except the cached
// read of the hint catalog.
import fs from 'node:fs';
import path from 'node:path';
import { anvilRoot } from './workspace.mjs';

export const NONBLOCKING = 'nonblocking';
export const HIGH = 'high';
export const WARNINGS_MAX = 20;
export const UNUSED_FIX = 'Remove the element or use it.';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const oneLine = (text, limit = 200) => {
  const line = String(text ?? '').split(/\s+/).filter(Boolean).join(' ');
  return line.length > limit ? line.slice(0, limit - 1) + '…' : line;
};

// Machine text inside a warning is cut to its head with its original size, so the sentence around it is read
// (FarmaVirtual session, 2026-10-10): the Studio quotes a data: URL whole in each InvalidResourceURL_Offline, so the 20
// warnings shown (of 34) in call 99 were 19.8 k of its 37.9 k characters, each key the whole data:image/svg+xml URL (the MCP
// result carried the answer twice, 77 k, and the client cut it in the middle), and each detail, cut at 200 characters, ended
// inside the URL before it said what was wrong. A data: URL keeps its media type ("data:image/svg+xml,…(435 chars)"), a
// base64 run its first 12 characters; the size counts characters of the text (a JSON escape \uXXXX of the kernel's key is
// one). A base64 run: 80 or more characters of its alphabet with lower case, upper case and digits; one with a "/" also has
// a "+" or the "=" padding, which a slash path ("Theme/Resources/Icons2024/...") never has, so a path is never cut. A URL a
// text already cut ends in ("…": an older kernel cut the detail at 200) keeps no size, which is not known. A short data:
// URL, words and a run of one letter stay. The kernel cuts the detail of its own warnings the same way (VerifyHints.ShortText).
const DATA_URL = /data:((?:[\w.+\-/;=]|\\u[0-9A-Fa-f]{4}){0,100}),((?:[^\s'"<>\\)]|\\u[0-9A-Fa-f]{4})*)/g;
const BASE64 = /[A-Za-z0-9+/]{80,}={0,2}/g;
const BASE64_ANY = /[A-Za-z0-9+/]{80,}/;
const DATA_KEEP = 24;
const KEY_MAX = 300;
const chars = text => text.replace(/\\u[0-9A-Fa-f]{4}/g, '_').length;
const sized = (head, text) => head + '…(' + chars(text) + ' chars)';
const isBase64 = run => /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run) && (!run.includes('/') || /[+=]/.test(run));
export function shortText(text) {
  const s = String(text ?? '');
  if (!s.includes('data:') && !BASE64_ANY.test(s)) return s;
  return s.replace(DATA_URL, (url, media, payload) => (payload.length <= DATA_KEEP ? url : payload.endsWith('…') ? 'data:' + media + ',…' : sized('data:' + media + ',', url)))
    .replace(BASE64, run => (isBase64(run) ? sized(run.slice(0, 12), run) : run));
}
// The key names the message (id, owner, property, arguments): its machine text cut, then at most KEY_MAX characters.
function shortKey(key) {
  const short = shortText(key);
  if (short.length <= KEY_MAX) return short;
  const suffix = '…(' + chars(short) + ' chars)';
  return short.slice(0, KEY_MAX - suffix.length) + suffix;
}

// The curated hints by id, read once per catalog folder state; none when the catalog is absent (a hint never changes a
// delivery).
const hintsMemo = new Map();
export function readVerifyHints(root = anvilRoot) {
  const dir = path.join(root, 'catalog');
  let files;
  try { files = fs.readdirSync(dir).filter(n => /^verify-hints-.*\.json$/i.test(n)).sort(); } catch { return {}; }
  const stamp = files.map(n => { try { const s = fs.statSync(path.join(dir, n)); return n + ':' + s.size + ':' + s.mtimeMs; } catch { return n; } }).join('|');
  const memo = hintsMemo.get(dir);
  if (memo?.stamp === stamp) return memo.hints;
  const hints = {};
  for (const name of files) {
    try {
      for (const item of JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8').replace(/^﻿/, '')))
        if (typeof item?.id === 'string' && typeof item?.hint === 'string') hints[item.id] = item.hint;
    } catch { /* an unreadable catalog file adds no hint */ }
  }
  hintsMemo.set(dir, { stamp, hints });
  return hints;
}

// The suggested fix of a warning: the curated hint of its id, else one sentence per family (Unused*), else null.
export function fixOf(id, hints = {}) {
  const hint = hints?.[id];
  if (typeof hint === 'string' && hint.trim()) return hint;
  return /^Unused/.test(String(id ?? '')) ? UNUSED_FIX : null;
}

// The element each warning is on (the verdict's ownerKey), for groupWarnings: kept beside the warning, never in the answer.
const ownerOf = new WeakMap();

// One warning in the I9 shape, from a kernel warning (already shaped) or from a verdict.
export function warningOf(entry, hints = {}) {
  if (!isObject(entry)) return null;
  const id = String(entry.id ?? '');
  const key = entry.key ?? entry.ownerKey ?? null;
  // A HIGH warning of the data-access rules (QUERY_IN_LOOP legacy/allowed, AGGREGATES_MERGEABLE) keeps its severity, op,
  // suggestion and why, and a longer detail.
  const high = entry.severity === HIGH;
  const warning = { id, path: shortText(entry.path ?? ''), ...(typeof key === 'string' && key ? { key: shortKey(key) } : {}), detail: oneLine(shortText(entry.detail), high ? 400 : 200),
    fix: entry.fix === undefined ? fixOf(id, hints) : entry.fix,
    ...(high ? { severity: HIGH, ...Object.fromEntries(['op', 'suggestion', 'why'].filter(k => entry[k] != null).map(k => [k, entry[k]])) } : {}) };
  if (typeof entry.ownerKey === 'string' && entry.ownerKey) ownerOf.set(warning, entry.ownerKey);
  return warning;
}

// The HIGH warnings of a kernel apply (its `highWarnings`, QueryInLoopRule/AggregateConsolidationRule) in the I9 shape, as
// the kernel's QueryInLoopRule.HighWarnings writes them for the O11 task: {id, severity:"high", path, detail, fix, op?,
// suggestion?, why?}.
export function highWarningsOf(list) {
  return (Array.isArray(list) ? list : []).filter(isObject).map(w => warningOf({
    id: w.code ?? w.id, severity: HIGH, path: w.path ?? [w.flow ?? w.owner, w.loop, w.query].filter(Boolean).join(' / '),
    detail: w.message ?? w.detail, fix: w.fix ?? null, op: w.op, suggestion: w.suggestion, why: w.why })).filter(Boolean);
}

// The non-blocking warnings of a list of verdicts (the apply's K1 verdicts or the live contract's entries).
export function warningsFromVerdicts(verdicts, { hints } = {}) {
  const list = (Array.isArray(verdicts) ? verdicts : []).filter(v => isObject(v) && v.verdict === NONBLOCKING);
  if (!list.length) return [];
  const known = hints ?? readVerifyHints();
  return list.map(v => warningOf({ ...v, fix: undefined }, known)).filter(Boolean);
}

// The warnings of an O11 kernel task: its own list (Delivery.cs result.warnings), else the apply's verdicts (an older
// kernel that predates the list answers none, as it never judged a warning non-blocking).
export function taskWarnings(state, { hints } = {}) {
  // The kernel names the element of its own warnings in key (VerifyHints.Warnings: the verdict's ownerKey).
  if (Array.isArray(state?.warnings))
    return state.warnings.map(w => warningOf(isObject(w) && w.ownerKey == null && w.key != null ? { ...w, ownerKey: w.key } : w, hints ?? {})).filter(Boolean);
  // An apply refused before the task recorded its warnings still names its HIGH warnings first.
  return [...highWarningsOf(state?.apply?.highWarnings), ...warningsFromVerdicts(state?.apply?.validation?.verdicts, { hints })];
}

// Equal warnings come once, the first of them with count (only when more than one): the same id on the same element, named
// by its key (the verdict's ownerKey), and only without one by its path label (else its key, else its detail): two elements
// whose paths read the same are never merged. The 33 InvalidResourceURL_Offline of one stylesheet (one ownerKey) in call 105
// were 20 entries of the answer plus warningsTotal, all alike but the URL. A HIGH warning is never merged: each names its
// own op.
export function groupWarnings(list) {
  const seen = new Map(); const out = [];
  for (const w of Array.isArray(list) ? list : []) {
    if (!isObject(w) || w.severity === HIGH) { if (w) out.push(w); continue; }
    const owner = ownerOf.get(w) ?? (typeof w.ownerKey === 'string' && w.ownerKey ? w.ownerKey : null);
    const element = String(w.id ?? '') + '\u0000' + (owner ? 'owner\u0000' + owner : 'label\u0000' + (w.path || w.key || w.detail || ''));
    const first = seen.get(element);
    if (first) { first.count = (first.count ?? 1) + 1; continue; }
    const copy = { ...w }; seen.set(element, copy); out.push(copy);
  }
  return out;
}

// Source fields: warnings (equal ones grouped, at most WARNINGS_MAX, HIGH first), warningsTotal when entries do not count
// every warning, and highWarnings for A03. The shared output policy removes warnings entries repeated in highWarnings;
// source consumers retain the original fields. Nothing when there is none.
export function warningFields(list, max = WARNINGS_MAX) {
  const all = Array.isArray(list) ? list.filter(Boolean) : [];
  if (!all.length) return {};
  const high = all.filter(w => w?.severity === HIGH);
  const shown = groupWarnings([...high, ...all.filter(w => w?.severity !== HIGH)]).slice(0, max);
  const counted = shown.reduce((n, w) => n + (w.count ?? 1), 0);
  return { warnings: shown, ...(counted < all.length ? { warningsTotal: all.length } : {}),
    ...(high.length ? { highWarnings: high.slice(0, max) } : {}) };
}
