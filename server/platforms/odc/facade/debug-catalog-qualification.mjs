// The ops.debugger platform limits of catalog/fragments/C/operations.json (what ssam_discover announces per lane) are
// the registry's qualification text, never a hand copy (port review B2). A hand copy kept announcing as live rows the
// registry marks unavailable in this build (port D7). tests/debug-catalog-qualification.test.mjs fails on any drift:
// a registry change, new evidence or an SC/Portal file arriving changes the generated text, and
//   node platforms/odc/facade/debug-catalog-qualification.mjs [--check | --write]
// reports it (--check, the default, exits 1 on drift) or rewrites exactly those two texts (--write).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeQualification } from './debug-adapter-registry.mjs';

export const CATALOG_FRAGMENT = fileURLToPath(new URL('./catalog/fragments/C/operations.json', import.meta.url));
export const CATALOG_CAPABILITY = 'ops.debugger';
export const CATALOG_LANES = Object.freeze(['odc', 'o11']);
export const CATALOG_QUALIFICATION_TAIL = 'Preparation is not a live execution proof; native login, roles and identity propagation are separate proofs; see docs/DEBUGGER-HEADLESS-FALTA.md.';
// The generated limit is the one whose text opens like describeQualification(lane, 'server').
const opening = lane => (lane === 'o11' ? 'O11' : 'ODC') + ' server adapters (generated from debug-adapter-registry';

// Registry arguments pass through (evidence index, rows, capabilities) so tests can simulate a delivery.
export function catalogQualification(lane, ...registry) {
  if (!CATALOG_LANES.includes(lane)) throw new Error('debug_catalog_qualification_lane_invalid');
  return describeQualification(lane, 'server', ...registry) + ' ' + describeQualification(lane, 'client', ...registry) + ' ' + CATALOG_QUALIFICATION_TAIL;
}

// One entry per lane: { lane, ok, current, expected }. current is null when the fragment has no generated limit.
export function catalogQualificationDrift(text = fs.readFileSync(CATALOG_FRAGMENT, 'utf8'), ...registry) {
  const capability = (JSON.parse(text.replace(/^﻿/, '')).capabilities ?? []).find(c => c?.id === CATALOG_CAPABILITY);
  return CATALOG_LANES.map(lane => {
    const limit = (capability?.platforms?.[lane]?.limits ?? []).find(l => typeof l?.text === 'string' && l.text.startsWith(opening(lane)));
    const expected = catalogQualification(lane, ...registry), current = limit ? limit.text : null;
    return { lane, ok: current === expected, current, expected };
  });
}

// Rewrites only the drifted texts, as JSON string literals in place: every other byte of the fragment stays as is.
export function syncCatalogQualification({ file = CATALOG_FRAGMENT, write = false } = {}, ...registry) {
  let text = fs.readFileSync(file, 'utf8');
  const drift = catalogQualificationDrift(text, ...registry).filter(d => !d.ok);
  if (!write || !drift.length) return { ok: !drift.length, written: false, drift };
  for (const d of drift) {
    const literal = d.current === null ? null : JSON.stringify(d.current);
    if (literal === null || text.split(literal).length !== 2) throw new Error('debug_catalog_qualification_not_rewritable:' + d.lane);
    text = text.replace(literal, () => JSON.stringify(d.expected));
  }
  if (catalogQualificationDrift(text, ...registry).some(d => !d.ok)) throw new Error('debug_catalog_qualification_rewrite_incomplete');
  fs.writeFileSync(file, text);
  return { ok: true, written: true, drift };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const write = process.argv.includes('--write');
  const result = syncCatalogQualification({ write });
  for (const d of result.drift) console.log((result.written ? 'rewrote ' : 'drift ') + CATALOG_CAPABILITY + ' platforms.' + d.lane + '.limits');
  if (!result.drift.length) console.log(CATALOG_CAPABILITY + ' platform limits match debug-adapter-registry');
  process.exitCode = result.ok ? 0 : 1;
}
