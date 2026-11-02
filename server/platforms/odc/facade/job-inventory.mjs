// C-01 (c), 27/10/2026 (F-FitBody-21, F-FitBody-40): what a job declares, by group, so that a refusal's patch is never
// offered as "verified" nor applied by fix:"apply" when the job it gives has less than the job had. Before, "verified" was
// only the union of the problems' patches without a conflict of path (verified-patch.mjs): the patch of DDL_BASE_REQUIRED
// replaced /ddl with the module's read (7 entities, 7 structures and 6 attributes left the job after fix:"apply"), and the
// one of HTML_PROPERTY_UNKNOWN left <aggregate k name max/> without its from, join, where and sort.
// The groups, each a list of names compared by its count (a rename a patch makes, as the cut name of an index, is no loss):
//   ddl (spec data.ddl): the top-level statements by kind (entity, static entity, type, index, site property, drop...) and
//     the members of each (attributes, structure members, records), by owner;
//   spec JSON sections: entities, static, structures by name, and the attributes of each;
//   logic: the actions of the texts (data.flow, by their headers) and of data.actions, by name, in one group;
//   html, per document (the screen of an edit, else the root of data.html): the elements with k, the named data (aggregate,
//     var, input, event, data-action), the data attributes of each aggregate (from, join, where, sort, group), and the
//     entries of data.edits;
//   raw ops: the creates, by type and name.
// Nothing else is counted: what a certain fix legitimately rewrites (a node of a flow text, a step of a JSON action, an
// unknown attribute of a widget, a <script>) is no part of the inventory.
//   jobInventory(job)          -> Map(group -> [names])
//   inventoryLoss(before, after) -> [{group, lost: [names], before: n, after: m}] (every group whose count goes down)
//   patchLoss(job, patch, apply) -> the loss of the job the patch gives (apply(job, patch) -> patched job), or [] when it
//                                   cannot be applied (a patch that does not apply is refused where it is applied)
// Pure: no file, no import.
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const opsOf = job => (Array.isArray(job) ? job : Array.isArray(job?.ops) ? job.ops : null);
const texts = value => (Array.isArray(value) ? value : value == null ? [] : [value])
  .map(t => (typeof t === 'string' ? t : isObject(t) && typeof t.text === 'string' ? t.text : null)).filter(t => typeof t === 'string');

// ---- ddl (ssam-ddl/1): one statement per top-level line, its members indented under it
const DDL_TOP = /^(create\s+unique\s+index|create\s+index|create\s+static\s+entity|create\s+entity|type|site\s+property|setting|client\s+variable|session\s+variable|timer|drop\s+[a-z]+(?:\s+[a-z]+)?)\s+([A-Za-z_][\w.]*)/i;
const MEMBER = /^\s+([A-Za-z_]\w*)\b/;
function ddlInventory(text, add) {
  let owner = null;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/\s+--\s+@\S+\s*$/, '');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('///') || trimmed.startsWith('--')) continue;
    if (!/^\s/.test(line)) {
      const top = DDL_TOP.exec(trimmed);
      if (top) {
        const kind = top[1].toLowerCase().replace(/\s+/g, ' ').replace(/^create unique index$/, 'create index');
        add('ddl ' + kind.replace(/^create /, ''), top[2]);
        owner = /entity$|^type$/.test(kind) ? top[2] : null;
      }
      // values, ), ); and } close nothing an owner keeps: the records after values are its members too.
      continue;
    }
    const member = MEMBER.exec(line);
    if (owner && member && !/^(values)$/i.test(member[1])) add('ddl member ' + owner, member[1]);
  }
}

// ---- logic: the actions a text declares (several per text are possible)
const HEADER = /^[ \t]*(?:server action|service action|client action|data action|action|preparation)[ \t]+((?:[\w/]+\.)?[A-Za-z_]\w*)/gm;
function logicInventory(text, add) { for (const m of String(text ?? '').matchAll(HEADER)) add('logic action', m[1]); }

// ---- html: elements with k, named data, the data attributes of an aggregate
const TAG = /<([A-Za-z][\w:-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g;
const ATTRIBUTE = /\s([^\s=>/]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;
const DATA_TAGS = new Set(['aggregate', 'var', 'input', 'event', 'data-action']);
export const AGGREGATE_DATA = Object.freeze(['from', 'join', 'where', 'sort', 'group']);
function attributesOf(text) {
  const out = new Map();
  for (const m of String(text ?? '').matchAll(ATTRIBUTE)) out.set(m[1], m[2] == null ? '' : m[2].replace(/^["']|["']$/g, ''));
  return out;
}
function htmlInventory(text, document, add) {
  for (const m of String(text ?? '').matchAll(TAG)) {
    const tag = m[1]; const attributes = attributesOf(m[2]);
    const k = attributes.get('k');
    if (k) add('html k ' + document, k);
    const name = attributes.get('name');
    if (DATA_TAGS.has(tag) && name && !(tag === 'input' && attributes.has('bind'))) add('html data ' + document, tag + ' ' + name);
    if (tag === 'aggregate') for (const a of AGGREGATE_DATA) if (attributes.has(a)) add('html aggregate ' + document + ' ' + (k ?? name ?? '?'), a);
  }
}
const ROOT = /<(screen|block)\b[^>]*?\sname\s*=\s*"([^"]+)"/;

export function jobInventory(job) {
  const groups = new Map();
  const add = (group, name) => { if (typeof name !== 'string' || !name) return; if (!groups.has(group)) groups.set(group, []); groups.get(group).push(name); };
  const ops = opsOf(job) ?? [];
  ops.forEach((op, i) => {
    if (!isObject(op)) return;
    const d = isObject(op.data) ? op.data : {};
    if (op.op === 'spec') {
      if (typeof d.ddl === 'string') ddlInventory(d.ddl, add);
      for (const section of ['entities', 'clientEntities', 'static', 'structures'])
        for (const record of Array.isArray(d[section]) ? d[section] : []) {
          if (!isObject(record)) continue;
          add('spec ' + section, record.name);
          for (const attribute of Array.isArray(record.attributes) ? record.attributes : []) if (isObject(attribute)) add('spec attribute ' + record.name, attribute.name);
        }
    } else if (op.op === 'logic') {
      for (const text of texts(d.flow)) logicInventory(text, add);
      for (const action of Array.isArray(d.actions) ? d.actions : []) if (isObject(action)) add('logic action', action.name);
    } else if (op.op === 'html') {
      const html = typeof d.html === 'string' ? d.html : null;
      const document = typeof d.screen === 'string' && d.screen ? d.screen : html && ROOT.exec(html)?.[2] ? ROOT.exec(html)[2] : 'op ' + i;
      if (html) { htmlInventory(html, document, add); const root = ROOT.exec(html); if (root) add('html document', root[1] + ' ' + root[2]); }
      for (const text of texts(d.edit)) htmlInventory(text, document, add);
      (Array.isArray(d.edits) ? d.edits : []).forEach((entry, j) => {
        if (!isObject(entry)) return;
        const target = ['set', 'replace', 'delete', 'into', 'after', 'before', 'find'].map(key => entry[key]).find(v => typeof v === 'string');
        add('html edits ' + document, String(target ?? '#' + j));
        for (const key of ['insert', 'with', 'html']) if (typeof entry[key] === 'string') htmlInventory(entry[key], document, add);
      });
    } else if (op.op === 'create' && typeof op.name === 'string') add('create ' + (op.type ?? '?'), op.name);
  });
  return groups;
}

export function inventoryLoss(before, after) {
  const loss = [];
  for (const [group, names] of before) {
    const now = after.get(group) ?? [];
    if (now.length >= names.length) continue;
    const left = [...now];
    const lost = names.filter(n => { const at = left.indexOf(n); if (at >= 0) { left.splice(at, 1); return false; } return true; });
    loss.push({ group, lost: lost.slice(0, 20), ...(lost.length > 20 ? { lostTotal: lost.length } : {}), before: names.length, after: now.length });
  }
  return loss;
}

export function patchLoss(job, patch, apply) {
  if (!opsOf(job) || !Array.isArray(patch) || !patch.length) return [];
  let patched;
  try { patched = apply(job, patch); } catch { return []; }
  return inventoryLoss(jobInventory(job), jobInventory(patched));
}

// The words of a loss, for a refusal (PATCH_DESTRUCTIVE) or a patch left out of a problem.
export const lossText = loss => loss.map(l => l.group + ': ' + l.lost.slice(0, 6).join(', ') + (l.lost.length > 6 || l.lostTotal ? ' and ' + ((l.lostTotal ?? l.lost.length) - 6) + ' more' : '')
  + ' (' + l.before + ' -> ' + l.after + ')').join('; ');
export const PATCH_DESTRUCTIVE = 'PATCH_DESTRUCTIVE';
export const DESTRUCTIVE_NOTE = 'the patch would leave the job without what it declares (statements, actions, elements or their data): '
  + 'never offered as verified nor applied by fix:"apply"; correct the job with your own patch, keeping all of it';
