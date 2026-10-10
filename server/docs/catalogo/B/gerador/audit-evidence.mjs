// Front B evidence audit (read-only; uses the index this checkout already built, or builds it through the lane CLI).
// Run after each announced distribution of CLIs and stamped results:
//   1. overstatement: B role statements whose computed evidence is not proven-current although they declare
//      applicable/conditional (declared-not-proven, proven-historical);
//   2. understatement: (B-owned qualified interface, operation) pairs that CURRENT stamped results execute (qualified
//      ledger or per-op executions) but that no B role statement declares applicable/conditional on that lane.
//   node docs/catalogo/B/gerador/audit-evidence.mjs [--json]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.cwd();
const d = await import(pathToFileURL(path.join(root, 'platforms', 'odc', 'facade', 'discovery.mjs')).href);
const own = JSON.parse(fs.readFileSync(path.join(root, 'platforms', 'odc', 'facade', 'catalog', 'ownership.json'), 'utf8'));
const VERB_OP = { get: 'read', dump: 'read', find: 'read', usages: 'usages', create: 'create', spec: 'create', set: 'set', link: 'set', rename: 'rename', replace: 'replace', move: 'move', duplicate: 'duplicate', delete: 'delete' };
const out = {};
for (const lane of ['odc', 'o11']) {
  const { index } = await d.buildIndex(lane, { sources: d.laneSources(lane) });
  const mine = index.capabilities.filter(x => x.origin?.front === 'B');
  const over = []; const declared = new Set();
  for (const cap of mine) {
    const ops = cap.operations ? d.operationsOf(index, cap) : {};
    for (const [op, o] of Object.entries(ops ?? {})) for (const [role, r] of Object.entries(o.roles ?? {})) {
      if (!['applicable', 'conditional'].includes(r.status)) continue;
      if (r.native) declared.add(r.native + '|' + op);
      if (!['proven-current', 'refusal-proven'].includes(r.evidence)) over.push({ capability: cap.id, op, role, status: r.status, evidence: r.evidence, proofs: (r.proofs ?? []).map(p => p.job ?? p) });
    }
  }
  // A coverage entry of the accounting may state an operation of a type no role represents (born-with-parent IContent).
  const accounting = JSON.parse(fs.readFileSync(path.join(root, 'platforms', 'odc', 'facade', 'catalog', 'fragments', 'B', 'accounting.json'), 'utf8'));
  for (const c of accounting.coverage) if (c.type.startsWith(lane + ':')) for (const [op, o] of Object.entries(c.operations ?? {})) if (['applicable', 'conditional'].includes(o.status)) declared.add(c.type.slice(lane.length + 1) + '|' + op);
  const found = new Map();
  for (const job of index.jobs.filter(j => j.executed?.current)) {
    const add = (iface, verb) => {
      const op = VERB_OP[verb]; if (!op || !iface || own.types[`${lane}:${iface}`]?.owner !== 'B') return;
      const k = iface + '|' + op; if (declared.has(k)) return;
      if (!found.has(k)) found.set(k, new Set()); found.get(k).add(job.name);
    };
    for (const [iface, v] of Object.entries(job.executed.coverageQualified ?? {})) for (const verb of v.verbs) add(iface, verb);
    for (const x of job.executed.executions ?? []) add(x.iface, x.verb);
  }
  const under = [...found].sort().map(([k, jobs]) => { const [type, op] = k.split('|'); return { type, op, jobs: [...jobs] }; });
  out[lane] = { index: index.key, jobs: index.identity.jobs, overstatement: over, understatement: under };
}
if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 1));
else for (const [lane, r] of Object.entries(out)) {
  console.log(`== ${lane} (index ${r.index}; jobs current ${r.jobs.current}/${r.jobs.count})`);
  console.log(`  declared applicable/conditional without current proof: ${r.overstatement.length}`);
  for (const x of r.overstatement) console.log(`    ${x.capability} ${x.op} '${x.role}' ${x.status} -> ${x.evidence} ${JSON.stringify(x.proofs)}`);
  console.log(`  current evidence not declared: ${r.understatement.length}`);
  for (const x of r.understatement) console.log(`    ${x.type}  op=${x.op}  ${x.jobs.slice(0, 4).join(',')}${x.jobs.length > 4 ? ` (+${x.jobs.length - 4})` : ''}`);
}
