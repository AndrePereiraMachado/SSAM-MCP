// Front B fragment normalizer (idempotent). Applied to the hand-written capability fragments of catalog/fragments/B:
//  - operations in authoring order (create, set, read, usages, rename, move, duplicate, replace, delete): when an intent
//    names no operation, the discovery budget keeps the first two operations whole, and for UI those are create/set;
//  - at most MAX_PROOFS proof jobs per role statement (the capability-level platforms.<lane>.proofs keeps the full list),
//    in written order, with one slot given to a job whose result is stamped in the checkout (kernel/.local/.../test-work)
//    when the kept ones have none: every proof expands to up to 12 verified ops in the answer, so a long list costs the
//    budget without adding a new fact. The scope of a statement must only state what its kept proofs do.
// It never changes a status, a scope, a note or a negative. accounting.json is generated elsewhere and left untouched.
//   node docs/catalogo/B/gerador/normalize-fragments.mjs [--check]
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const dir = path.join(root, 'platforms', 'odc', 'facade', 'catalog', 'fragments', 'B');
const ORDER = ['create', 'set', 'read', 'usages', 'rename', 'move', 'duplicate', 'replace', 'delete'];
// Two proofs per role statement: enough for the scope to name the job of each fact it states (the independent review of
// 2026-09-23 found scopes describing jobs a one-proof cut had dropped). The scope must only state what the kept proofs do.
const MAX_PROOFS = () => 2;
const stamped = {
  odc: new Set(fs.readdirSync(path.join(root, 'kernel', '.local', 'lane-odc', 'test-work')).filter(n => n.endsWith('.result.json')).map(n => n.replace(/\.result\.json$/, ''))),
  o11: new Set(fs.readdirSync(path.join(root, 'kernel', '.local', 'test-work')).filter(n => n.endsWith('.result.json')).map(n => n.replace(/\.result\.json$/, ''))),
};
let changed = 0; const check = process.argv.includes('--check');
for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.json') && n !== 'accounting.json').sort()) {
  // Line endings are the checkout's business (core.autocrlf): compare the content, not the terminators.
  const file = path.join(dir, name); const before = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const fr = JSON.parse(before.replace(/^﻿/, ''));
  for (const c of fr.capabilities ?? []) {
    if (!c.operations) continue;
    const ops = {};
    for (const op of [...ORDER, ...Object.keys(c.operations).filter(o => !ORDER.includes(o))]) if (c.operations[op]) ops[op] = c.operations[op];
    for (const [op, def] of Object.entries(ops)) for (const byLane of Object.values(def.roles ?? {})) for (const [lane, r] of Object.entries(byLane ?? {})) {
      if (!Array.isArray(r.proofs) || r.proofs.length <= MAX_PROOFS(op)) continue;
      // Written order (the scope follows it), but when the kept ones have no stamped result and the list has one, the
      // last kept slot goes to the first stamped job, so the engine can compute current evidence.
      const s = stamped[lane] ?? new Set(); const max = MAX_PROOFS(op);
      const kept = r.proofs.slice(0, max); const firstStamped = r.proofs.find(j => s.has(j));
      if (firstStamped && !kept.some(j => s.has(j))) kept[max - 1] = firstStamped;
      r.proofs = kept;
    }
    c.operations = ops;
  }
  const after = JSON.stringify(fr, null, 1) + '\n';
  if (after !== before) { changed++; if (!check) fs.writeFileSync(file, after); console.log((check ? 'would change ' : 'normalized ') + name); }
}
if (check && changed) process.exitCode = 1;
if (!changed) console.log('fragments already normalized');
