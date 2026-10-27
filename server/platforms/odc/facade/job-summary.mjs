// What a delivered (or proven) job created or changed, in a few lines, read from the job itself: the answer of a delivery
// carries it so the model does not read the module again to learn what it now holds (2026-10-12 production test: a final
// ssam_map digest of 31 KB after "entregue", only to confirm the names and signatures it had just written).
//   actions     one line per action: "<kind >Name(Input: Type, Optional?: Type) -> (Output: Type)" (kind only when it is
//               not a server action; "(replaced)" when the job rewrote an existing one); from the logic op and from raw
//               create ops of an action with its parameters
//   entities, staticEntities, structures, clientEntities   {name, attributes, records?} from the spec op and raw creates
//   elements    the other top-level elements the job created, by interface: {IUserException: [...], ISiteProperty: [...]}
//   edited      raw ops on elements the job did not create (set, rename, delete, move...): {count, targets} (at most 10)
//   ops         how many ops the job has
// Pure: no I/O, no clock. A composite job ({jobs: [...]}) names its parts only. The whole summary stays under MAX_BYTES:
// over it, the action lines lose their parameters (names only), then the lists are cut and say how many were left out.
import { clipText } from './text-clip.mjs';
const MAX_BYTES = 4096;
const MAX_LIST = 60;
const LINE = 300;
const bytes = v => Buffer.byteLength(JSON.stringify(v), 'utf8');
const clip = (s, n = LINE) => clipText(s, n);
const ACTION_TYPES = new Map([['IServerAction', 'server'], ['IServiceAction', 'service'], ['IClientAction', 'client'], ['IScreenAction', 'screen'],
  ['IDataAction', 'data'], ['IPreparation', 'preparation']]);
const ENTITY_GROUPS = new Map([['IServerEntity', 'entities'], ['IEntity', 'entities'], ['IStaticEntity', 'staticEntities'], ['IStructure', 'structures'],
  ['IClientEntity', 'clientEntities'], ['ILocalEntity', 'clientEntities']]);
const iface = type => { const t = String(type ?? '').trim(); return !t ? '' : /^I[A-Z]/.test(t) ? t : 'I' + t; };

const param = p => {
  if (typeof p === 'string') return p;
  if (!p || typeof p !== 'object') return String(p);
  return `${p.name ?? '?'}${p.mandatory === false ? '?' : ''}${p.type ? ': ' + p.type : ''}`;
};
const signature = ({ kind, name, inputs, outputs, replace }) => clip(`${kind && kind !== 'server' ? kind + ' ' : ''}${name}(${(inputs ?? []).map(param).join(', ')})`
  + ((outputs ?? []).length ? ` -> (${outputs.map(param).join(', ')})` : '') + (replace ? ' (replaced)' : ''));

export function jobSummary(job) {
  const ops = Array.isArray(job) ? job : Array.isArray(job?.ops) ? job.ops : null;
  if (!ops) return Array.isArray(job?.jobs) ? { parts: job.jobs.slice(0, MAX_LIST).map(String) } : null;
  const actions = []; const groups = { entities: [], staticEntities: [], structures: [], clientEntities: [] }; const elements = {};
  // Raw creates: alias -> what it made, so parameters, attributes and DataType sets land on their owner.
  const made = new Map(); const rawActions = []; const edited = new Set(); let editedCount = 0;
  for (const op of ops) {
    if (!op || typeof op !== 'object') continue;
    if (op.op === 'logic') {
      for (const a of op.data?.actions ?? []) if (a && typeof a === 'object' && a.name) actions.push(signature({ kind: a.kind ?? 'server', name: a.name, inputs: a.inputs, outputs: a.outputs, replace: a.replace === true }));
      continue;
    }
    if (op.op === 'spec') {
      const d = op.data ?? {};
      for (const e of d.entities ?? []) if (e?.name) groups.entities.push({ name: e.name, attributes: (e.attributes ?? []).length });
      for (const e of d.static ?? []) if (e?.name) groups.staticEntities.push({ name: e.name, attributes: (e.attributes ?? []).length, records: (e.records ?? []).length });
      for (const e of d.structures ?? []) if (e?.name) groups.structures.push({ name: e.name, attributes: (e.attributes ?? []).length });
      for (const e of d.clientEntities ?? []) if (e?.name) groups.clientEntities.push({ name: e.name, attributes: (e.attributes ?? []).length });
      continue;
    }
    if (op.op === 'create') {
      const type = iface(op.type);
      const parent = typeof op.parent === 'string' ? made.get(op.parent) : null;
      const top = op.parent === '@espace' || (typeof op.parent === 'string' && op.parent.startsWith('IFolder:'));
      let item = null;
      if (top && ACTION_TYPES.has(type)) { item = { kind: ACTION_TYPES.get(type), name: op.name ?? '?', inputs: [], outputs: [] }; rawActions.push(item); }
      else if (top && ENTITY_GROUPS.has(type)) { item = { name: op.name ?? '?', attributes: 0 }; groups[ENTITY_GROUPS.get(type)].push(item); }
      else if (parent?.inputs && (type === 'IInputParameter' || type === 'IOutputParameter')) {
        item = { name: op.name ?? '?' }; (type === 'IInputParameter' ? parent.inputs : parent.outputs).push(item);
      } else if (parent && 'attributes' in parent && /Attribute$/.test(type)) parent.attributes++;
      else if (parent && 'records' in parent && /Record$/.test(type)) parent.records = (parent.records ?? 0) + 1;
      else if (top && type && op.name) (elements[type] ??= []).push(op.name);
      if (typeof op.as === 'string' && item) made.set(op.as, item);
      continue;
    }
    // A DataType or IsMandatory on a parameter the job created completes its line; anything else on an element the job
    // did not create is an edit of the module.
    const target = typeof op.target === 'string' ? op.target : null;
    const own = target ? made.get(target) : null;
    if (own && op.op === 'set' && 'name' in own && !('attributes' in own) && !own.inputs) {
      if (op.prop === 'DataType') own.type = String(op.value);
      if (op.prop === 'IsMandatory' && (op.value === false || op.value === 'False' || op.value === 'false')) own.mandatory = false;
      continue;
    }
    if (target && !own && !target.startsWith('$') && ['set', 'rename', 'delete', 'move', 'replace', 'link'].includes(op.op)) { editedCount++; edited.add(target); }
  }
  for (const a of rawActions) actions.push(signature(a));
  const value = { ops: ops.length };
  if (actions.length) value.actions = actions;
  for (const [k, list] of Object.entries(groups)) if (list.length) value[k] = list;
  if (Object.keys(elements).length) value.elements = elements;
  if (editedCount) value.edited = { count: editedCount, targets: [...edited].slice(0, 10).map(t => clip(t, 120)) };
  // Nothing to name (a prototype op, a read-only job): no summary.
  if (Object.keys(value).length === 1) return null;
  return fit(value);
}

// Over MAX_BYTES: action lines without parameters first, then every list cut to what fits, each cut counted.
function fit(value) {
  if (bytes(value) <= MAX_BYTES) return value;
  if (value.actions) value.actions = value.actions.map(line => line.replace(/\(.*$/, '()') + (/\(replaced\)$/.test(line) ? ' (replaced)' : ''));
  for (const key of ['actions', 'entities', 'structures', 'staticEntities', 'clientEntities']) {
    const list = value[key]; if (!Array.isArray(list)) continue;
    let keep = Math.min(list.length, MAX_LIST);
    while (keep > 0 && bytes({ ...value, [key]: list.slice(0, keep) }) > MAX_BYTES) keep = Math.floor(keep / 2);
    if (keep < list.length) { value[key] = list.slice(0, keep); value[key + 'Total'] = list.length; }
  }
  if (value.elements && bytes(value) > MAX_BYTES) value.elements = Object.fromEntries(Object.entries(value.elements).map(([k, names]) => [k, names.length]));
  return value;
}
