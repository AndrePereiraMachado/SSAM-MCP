// A03 (owner decision, 2026-10-06): only Verify ERRORS block a delivery; every other new warning, outside the security list
// and the anonymous-access family (kernel SecurityWarnings.cs), comes back in the answer as a non-blocking warning
// (contract I9 of docs/PACOTE-ATRITOS-2.md): {id, path, key?, detail (one line, at most 200 characters), fix}, at most 20
// plus warningsTotal. The O11 kernel task already carries the whole list (result.warnings, Delivery.cs); the ODC kernel apply
// carries its verdicts, read here with the same curated hints (kernel/catalog/verify-hints-*.json). Pure, except the cached
// read of the hint catalog.
import fs from 'node:fs';
import path from 'node:path';
import { anvilRoot } from './workspace.mjs';

export const NONBLOCKING = 'nonblocking';
export const HIGH = 'high';
export const WARNINGS_MAX = 20;
export const UNUSED_FIX = 'Remova o elemento ou use-o.';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const oneLine = (text, limit = 200) => {
  const line = String(text ?? '').split(/\s+/).filter(Boolean).join(' ');
  return line.length > limit ? line.slice(0, limit - 1) + '…' : line;
};

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

// One warning in the I9 shape, from a kernel warning (already shaped) or from a verdict.
export function warningOf(entry, hints = {}) {
  if (!isObject(entry)) return null;
  const id = String(entry.id ?? '');
  const key = entry.key ?? entry.ownerKey ?? null;
  // A HIGH warning of the data-access rules (QUERY_IN_LOOP legacy/allowed, AGGREGATES_MERGEABLE) keeps its severity, op,
  // suggestion and why, and a longer detail.
  const high = entry.severity === HIGH;
  return { id, path: String(entry.path ?? ''), ...(typeof key === 'string' && key ? { key } : {}), detail: oneLine(entry.detail, high ? 400 : 200),
    fix: entry.fix === undefined ? fixOf(id, hints) : entry.fix,
    ...(high ? { severity: HIGH, ...Object.fromEntries(['op', 'suggestion', 'why'].filter(k => entry[k] != null).map(k => [k, entry[k]])) } : {}) };
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
  if (Array.isArray(state?.warnings)) return state.warnings.map(w => warningOf(w, hints ?? {})).filter(Boolean);
  // An apply refused before the task recorded its warnings still names its HIGH warnings first.
  return [...highWarningsOf(state?.apply?.highWarnings), ...warningsFromVerdicts(state?.apply?.validation?.verdicts, { hints })];
}

// The answer fields: warnings (at most WARNINGS_MAX, the HIGH ones first) and warningsTotal when there are more; the HIGH
// ones also in highWarnings, so a compacted answer (compactDelivery keeps the DELIVERY_FIELDS) always shows them;
// nothing when there is none.
export function warningFields(list, max = WARNINGS_MAX) {
  const all = Array.isArray(list) ? list.filter(Boolean) : [];
  if (!all.length) return {};
  const high = all.filter(w => w?.severity === HIGH);
  const warnings = [...high, ...all.filter(w => w?.severity !== HIGH)];
  return { warnings: warnings.slice(0, max), ...(warnings.length > max ? { warningsTotal: warnings.length } : {}),
    ...(high.length ? { highWarnings: high.slice(0, max) } : {}) };
}
