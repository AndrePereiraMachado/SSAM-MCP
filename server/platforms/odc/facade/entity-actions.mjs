// The receipt of the kernel op entity-actions in a delivery answer (o11_deliver, studio_deliver, ssam_code write): what it
// generated, by entity, what it left as it was (unchanged), what it kept and why, and the decisions it named (notes). The
// kernel's report carries every key and the generated text of each kept action; the answer carries the names, counts and
// reasons, small enough beside the rest of the answer (the full report stays in the delivery's evidence).

const KEPT_MAX = 20;
const ENTITIES_MAX = 60;

/** The compact receipt of the entity-actions reports of a job (the kernel's data.entityActions), or null when none. */
export function entityActionsOf(reports) {
  const list = (Array.isArray(reports) ? reports : []).filter(r => r && typeof r === 'object');
  if (!list.length) return null;
  const byEntity = {};
  let created = 0, unchanged = 0;
  const kept = [], notes = new Map(), skipped = [], exceptions = new Set(), structures = new Set();
  for (const r of list) {
    for (const c of Array.isArray(r.created) ? r.created : []) {
      created++;
      (byEntity[c.entity] ??= []).push(c.name);
    }
    unchanged += Array.isArray(r.unchanged) ? r.unchanged.length : 0;
    for (const k of Array.isArray(r.kept) ? r.kept : []) kept.push({ name: k.name, entity: k.entity, why: k.why, ...(k.edit ? { edit: k.edit } : {}), ...(k.fix ? { fix: k.fix } : {}) });
    for (const n of Array.isArray(r.notes) ? r.notes : []) {
      const entry = notes.get(n.code) ?? { code: n.code, count: 0, first: n.message };
      entry.count++; notes.set(n.code, entry);
    }
    for (const s of Array.isArray(r.skipped) ? r.skipped : []) skipped.push(s);
    for (const e of Array.isArray(r.exceptions) ? r.exceptions : []) if (e?.created) exceptions.add(e.name);
    for (const s of Array.isArray(r.structures) ? r.structures : []) if (s?.created) structures.add(s.name);
  }
  const entities = Object.keys(byEntity);
  return {
    created, unchanged, ...(list.every(r => r.noChange === true) ? { noChange: true } : {}),
    actions: Object.fromEntries(entities.slice(0, ENTITIES_MAX).map(e => [e, byEntity[e]])),
    ...(entities.length > ENTITIES_MAX ? { entitiesTotal: entities.length } : {}),
    ...(kept.length ? { kept: kept.slice(0, KEPT_MAX), ...(kept.length > KEPT_MAX ? { keptTotal: kept.length } : {}) } : {}),
    ...(notes.size ? { notes: [...notes.values()].map(n => (n.count > 1 ? { code: n.code, count: n.count, first: n.first } : { code: n.code, message: n.first })) } : {}),
    ...(skipped.length ? { skipped: skipped.slice(0, KEPT_MAX) } : {}),
    ...(exceptions.size ? { exceptionsCreated: [...exceptions] } : {}),
    ...(structures.size ? { structuresCreated: [...structures].slice(0, ENTITIES_MAX) } : {}),
  };
}
