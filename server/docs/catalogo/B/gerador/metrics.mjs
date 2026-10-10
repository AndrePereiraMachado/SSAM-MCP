// Front B coverage metrics (read-only; uses the index this checkout already built, or builds it through the lane CLI).
// Separate denominators, no global percentage (TESTES-E-EVIDENCIAS.md "Métricas de cobertura separadas"):
//   1. inventory identities of B classified (represented by a capability role / accounted by a coverage entry);
//   2. capabilities with extracted contract pointers (api --op) and routes;
//   3. role x operation statements per lane by declared status;
//   4. the same statements by the evidence the ENGINE computes (proven-current, proven-historical, declared-not-proven,
//      refusal-proven, refusal-declared, undetermined): stamp + qualified ledger of the role's native type.
//   node docs/catalogo/B/gerador/metrics.mjs [--json]
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.cwd();
const facade = path.join(root, 'platforms', 'odc', 'facade');
const d = await import(pathToFileURL(path.join(facade, 'discovery.mjs')).href);
const c = await import(pathToFileURL(path.join(facade, 'catalog.mjs')).href);
const check = c.checkCatalog({ root, front: 'B' });
const out = { accounting: check.accounting.map(a => ({ lane: a.lane, types: a.types, represented: a.represented, classified: a.classified, unaccounted: a.unaccounted,
  byClass: Object.fromEntries(Object.entries(a.byClass).map(([k, v]) => [k, { types: v.types, represented: v.represented, classified: v.classified }])) })), lanes: {} };
for (const lane of ['odc', 'o11']) {
  const { index } = await d.buildIndex(lane, { sources: d.laneSources(lane) });
  const mine = index.capabilities.filter(x => x.origin?.front === 'B' || (x.id.startsWith('ui.') && !x.origin) || x.id === 'logic.app-event');
  const status = {}; const evidence = {}; const byCap = {};
  for (const cap of mine) {
    const ops = cap.operations ? d.operationsOf(index, cap) : {};
    const row = { level: d.levelOf(index, cap), fragment: cap.origin?.fragment ?? 'legacy', contractPointers: (cap.contract ?? []).length, route: cap.route?.kind ?? null, statements: 0, current: 0 };
    for (const o of Object.values(ops ?? {})) for (const r of Object.values(o.roles ?? {})) {
      status[r.status] = (status[r.status] ?? 0) + 1; evidence[r.evidence] = (evidence[r.evidence] ?? 0) + 1; row.statements++; if (r.evidence === 'proven-current') row.current++;
    }
    byCap[cap.id] = row;
  }
  out.lanes[lane] = { capabilities: mine.length, withContract: mine.filter(x => (x.contract ?? []).length).length, statementsByStatus: status, statementsByEvidence: evidence, byCapability: byCap,
    index: { key: index.key, builtAt: index.builtAt, jobs: index.identity.jobs } };
}
if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 1));
else {
  for (const a of out.accounting) console.log(`accounting ${a.lane}: ${a.types} types = represented ${a.represented} + classified ${JSON.stringify(a.classified)}; unaccounted ${a.unaccounted}; by class ${JSON.stringify(a.byClass)}`);
  for (const [lane, l] of Object.entries(out.lanes)) {
    console.log(`\n${lane}: ${l.capabilities} B capabilities (${l.withContract} with api --op contract pointers); index ${l.index.key} jobs ${JSON.stringify(l.index.jobs)}`);
    console.log('  statements by declared status', JSON.stringify(l.statementsByStatus));
    console.log('  statements by computed evidence', JSON.stringify(l.statementsByEvidence));
    for (const [id, r] of Object.entries(l.byCapability)) console.log(`  ${id.padEnd(22)} ${r.fragment.padEnd(20)} level ${r.level.padEnd(22)} statements ${String(r.statements).padStart(3)} current ${r.current}`);
  }
}
