import { dependencyFacts, sortDependencies } from './part-dependencies.mjs';

// One capture and rich-index read per job; all target/descendant queries then run in memory.
// Conflicting names retain their order even when unrelated mutations separate deletes.
export async function orderDeleteDependencies(ops, { map, lane, module }) {
  const targetOf = op => op.target ?? op.path;
  const targets = [...new Set(ops.filter(op => op.op === 'delete').map(targetOf).filter(v => typeof v === 'string'))];
  if (targets.length < 2 || typeof map !== 'function') return { ops, notes: [] };
  const input = { lane, target: module, view: 'uses', element: targets[0], usageTargets: targets };
  let result;
  try { result = await map(input); } catch { return { ops, notes: ['Delete order retained: the native usage read failed'] }; }
  const readings = Array.isArray(result?.usages) ? new Map(result.usages.map(u => [u.target, u])) : null;
  if (!result?.ok || !readings || targets.some(target => !readings.get(target)?.resolved))
    return { ops, notes: ['Delete order retained: complete native usages were unavailable'] };
  const norm = value => String(value ?? '').replace(/^@/, '').toLowerCase();
  const parts = ops.map(op => ({ part: 'ops', ops: [op] })), edges = [], byKey = new Map(), byPath = new Map();
  const add = (map, key, i) => { if (!key) return; const list = map.get(key) ?? []; list.push(i); map.set(key, list); };
  let previousFixed = null;
  ops.forEach((op, i) => {
    if (op.op !== 'delete') { if (previousFixed !== null) edges.push([previousFixed, i]); previousFixed = i; return; }
    const resolved = readings.get(targetOf(op)).resolved;
    add(byKey, norm(resolved.key), i); add(byPath, norm(resolved.path), i);
  });
  ops.forEach((op, provider) => {
    if (op.op !== 'delete') return;
    for (const { consumer } of readings.get(targetOf(op)).entries) {
      if (!consumer) continue;
      const consumers = new Set(byKey.get(norm(consumer.key)) ?? []);
      let path = norm(consumer.path);
      while (path) { for (const i of byPath.get(path) ?? []) consumers.add(i); const slash = path.lastIndexOf('/'); if (slash < 0) break; path = path.slice(0, slash); }
      for (const i of consumers) if (i !== provider) edges.push([i, provider]);
    }
  });
  const facts = p => {
    const f = dependencyFacts(p), target = targetOf(p.ops[0]), resolved = readings.get(target)?.resolved;
    // A keyed deletion must conflict with a named recreation of the same native element.
    if (resolved) for (const name of [resolved.name, resolved.path]) if (name) {
      const key = name.split('/').at(-1).replace(/^[^:]+:/, '').toLowerCase(); f.writes.add(key); f.removes.add(key);
    }
    return f;
  };
  const ordered = sortDependencies(parts, facts, () => 0, edges, { creationDependencies: false }), next = ordered.parts.map(p => p.ops[0]);
  const notes = next.some((op, i) => op.op === 'delete' && op !== ops[i]) ? ['Deletes ordered by native consumers before providers in the pinned capture'] : [];
  if (ordered.cycle) notes.push('Input order retained inside conflicting dependency components');
  return { ops: next, notes };
}

// Direct delivery saves a new staged job; the source file and patch base stay intact.
export async function prepareDeleteJob(document, context) {
  const ops = Array.isArray(document) ? document : document?.ops;
  if (!Array.isArray(ops)) return { document, notes: [] };
  const ordered = await orderDeleteDependencies(ops, context);
  return { document: ordered.ops.some((op, i) => op !== ops[i])
    ? Array.isArray(document) ? ordered.ops : { ...document, ops: ordered.ops } : document,
    notes: ordered.notes };
}
