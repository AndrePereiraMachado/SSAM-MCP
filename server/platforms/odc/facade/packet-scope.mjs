// The scope of the work packet (R4, 2026-10-24): the names an expression or a call of this change may use, read from the
// module digest the packet already holds (ssam-digest/1, module-digest.mjs) and, for the element the change edits, from the
// reading of its owner (the flow of an action: its text, @ids and textSha; a screen or block: its ssam-html/1 with k and
// basedOn), never from a new kind of native read. Measured 11..24/10/2026: 18 reads (p50) before an accepted delivery, most
// of them to learn which names exist and which basedOn goes where. Every name comes from the digest with its @key; a name
// that is not here is not in the module (or was left out by the room: then it is named in next with the call that reads it).
//   owner     the element the change edits or adds to: kind, name, @key, its signature, and from its reading the locals,
//             nodes, aggregates and widgets (with k), the text itself when it fits, and its basedOn
//   basedOn   every basedOn the delivery takes, each with the field it goes in and the value (or where the value comes from):
//             textSha of a flow (16 hex) for logic, {capture, html} for an html edit, the capture sourceSha256 for ddl,
//             nextBasedOn {job, sha256} only to correct a refused delivery
//   groups    entities (attributes and types), static entities (records), structures (fields), variables (site, client and
//             session variables, settings), exceptions, roles, timers, integrations, actions (inputs and outputs), screens
//             and the referenced producers' elements the intent names; by relevance (what the intent names and its
//             neighbours first), the rest by name only while it fits, and what is left in next, labelled
import { normalize } from './catalog.mjs';

export const SCOPE_SCHEMA = 'ssam-packet-scope/1';
export const SCOPE_USE = 'the names this change may use, each with its @key; a name neither here nor counted in next is not in the module: never invent one';
// The groups of the scope, in the order the packet writes them.
export const SCOPE_GROUPS = ['entities', 'staticEntities', 'structures', 'variables', 'exceptions', 'actions', 'screens', 'integrations', 'timers', 'roles', 'references'];
// A flow basedOn is the textSha of the read action: 16 hexadecimal characters. A capture sha256 is 64.
export const TEXT_SHA = /^[a-f0-9]{16}$/;
export const CAPTURE_SHA = /^[a-f0-9]{64}$/;
// Of the room a small cap leaves after the owner, the part whole items take before names only fill the rest.
export const WHOLE_SHARE = 0.65;

const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const lines = text => String(text ?? '').split('\n');
// "Name @key ..." of a header: the name and the key after it.
const keyOf = head => /@(\S+)/.exec(head)?.[1] ?? null;
// The type of an attribute line of the digest ("Cliente Identifier req ->Cliente delete=Protect" -> "Cliente Identifier").
const typeOf = rest => rest.split(/ (?:req|auto|->|=|")/)[0].trim();

// ---- the digest, parsed per block (ModuleDigest text, see module-digest.mjs and a real digest's blocks)
export function entityOf(b) {
  const attrs = {}; const records = []; const refs = [];
  for (const line of lines(b.text).slice(1)) {
    const record = /^ {2}record ([A-Za-z_]\w*):/.exec(line);
    if (record) { records.push(record[1]); continue; }
    const attr = /^ {2}([A-Za-z_]\w*): (.+)$/.exec(line);
    if (!attr) continue;
    attrs[attr[1]] = typeOf(attr[2]);
    const ref = /->([A-Za-z_]\w*)/.exec(attr[2]); if (ref) refs.push(ref[1]);
  }
  const out = { key: '@' + b.key, attrs };
  if (b.kind === 'StaticEntity') out.records = records;
  if (b.records != null && b.records > records.length) out.recordsTotal = b.records;
  return { value: out, refs };
}
export function structureOf(b) {
  const fields = {};
  for (const line of lines(b.text).slice(1)) for (const part of line.trim().split(/;\s*/)) {
    const m = /^([A-Za-z_]\w*): (.+)$/.exec(part.trim()); if (m) fields[m[1]] = typeOf(m[2]);
  }
  return { key: '@' + b.key, fields };
}
// "site property X @k: Text read-only ..." / "client variable X @k: Text" / "setting X @k: Text" / "session variable ...".
export function variableOf(b) {
  const head = lines(b.text)[0];
  const m = /^(.+?) \S+ @\S+: (.+)$/.exec(head);
  return { key: '@' + b.key, kind: m?.[1] ?? b.kind, type: m ? typeOf(m[2]) : null, ...(/ read-only\b/.test(head) ? { readOnly: true } : {}) };
}
// The REST and SOAP methods of an integration block: "POST /Path rest action Name @key".
function integrationOf(b) {
  const head = lines(b.text)[0];
  const methods = {};
  for (const line of lines(b.text).slice(1)) { const m = /(?:rest|soap)(?: service)? action ([A-Za-z_]\w*) @(\S+)/.exec(line); if (m) methods[m[1]] = '@' + m[2]; }
  return { key: '@' + b.key, kind: head.split(' @')[0].replace(/ \S+$/, ''), methods };
}
// The references of the module section ("reference Producer @key (Type)\n  ServerAction: A, B"): the producer's elements by kind.
function referencesOf(digest) {
  const S = sectionsOf(digest);
  const out = [];
  for (const b of S.module?.blocks ?? []) {
    if (b.kind !== 'Reference') continue;
    const kinds = {};
    for (const line of lines(b.text).slice(1)) { const m = /^ {2}([A-Za-z]\w*): (.+)$/.exec(line); if (m) kinds[m[1]] = m[2].split(/,\s*/).filter(Boolean); }
    out.push({ name: b.name, key: '@' + b.key, kinds });
  }
  return out;
}
const sectionsOf = digest => Object.fromEntries((digest?.sections ?? []).map(s => [s.id, s]));

// The screen or block of the digest (its ui block): inputs, locals, aggregates, screen actions, widgets and named containers.
export function screenOf(b) {
  const head = lines(b.text)[0];
  const out = { kind: b.kind, name: b.name, key: '@' + b.key, inputs: {}, locals: {}, aggregates: {}, actions: {}, widgets: {} };
  const typed = (target, list) => { for (const part of list.split(/;\s*/)) { const m = /^([A-Za-z_]\w*\??): (.+)$/.exec(part.trim()); if (m) target[m[1]] = typeOf(m[2]); } };
  let inWidgets = false;
  for (const line of lines(b.text).slice(1)) {
    let m;
    if ((m = /^ {2}in (.+)$/.exec(line))) { typed(out.inputs, m[1]); continue; }
    if ((m = /^ {2}local (.+)$/.exec(line))) { typed(out.locals, m[1]); continue; }
    if ((m = /^ {2}aggregate ([A-Za-z_]\w*) @(\S+)/.exec(line))) { out.aggregates[m[1]] = '@' + m[2]; continue; }
    if ((m = /^ {2}(?:data )?action ([A-Za-z_]\w*) @(\S+)/.exec(line))) { out.actions[m[1]] = '@' + m[2]; continue; }
    if (/^ {2}widgets:/.test(line)) { inWidgets = true; continue; }
    if (/^ {2}named containers:/.test(line)) { inWidgets = false; continue; }
    if (/^ {4}\S/.test(line) && !inWidgets) for (const c of line.trim().split(/,\s*/)) { const n = /^([A-Za-z_]\w*) @(\S+)$/.exec(c); if (n) out.widgets[n[1]] = { key: '@' + n[2] }; }
    if (inWidgets && (m = /^\s+(?:if .*?# )?([a-z][\w-]*) ([A-Za-z_]\w*) @(\S+)/.exec(line)) && m[1] !== 'block') out.widgets[m[2]] = { kind: m[1], key: '@' + m[3] };
    else if (inWidgets && (m = /# ([A-Za-z_]\w*) @(\S+)\s*$/.exec(line))) out.widgets[m[1]] = { kind: 'if', key: '@' + m[2] };
  }
  if (/ roles=(\S+)/.test(head)) out.roles = / roles=(\S+)/.exec(head)[1].split(',');
  for (const k of ['inputs', 'locals', 'aggregates', 'actions', 'widgets']) if (!Object.keys(out[k]).length) delete out[k];
  return out;
}

// ---- the readings of an owner (module-map.mjs ownerReadings): a flow {kind:'flow', name, key, textSha, text, fixedPoint}
// or an html {kind:'html', screen, key, basedOn:{capture, html}, html}.
// The names the flow text declares: in, out, local and the nodes that hold a value (Node = aggregate | sql | Action(...)).
export function flowNames(text) {
  const out = { inputs: {}, outputs: {}, locals: {}, nodes: {} };
  for (const line of lines(text)) {
    let m;
    if ((m = /^\s+(in|out|local) ([A-Za-z_]\w*\??): ([^=@]+?)(?: =.*?)?(?: @\S+)?\s*$/.exec(line))) out[m[1] === 'in' ? 'inputs' : m[1] === 'out' ? 'outputs' : 'locals'][m[2]] = m[3].trim();
    else if ((m = /^\s+([A-Za-z_]\w*) = (aggregate|sql)\b/.exec(line))) out.nodes[m[1]] = m[2];
    else if ((m = /^\s+([A-Za-z_]\w*) = ([A-Za-z_(][\w().]*)\(/.exec(line))) out.nodes[m[1]] = 'call ' + m[2];
  }
  for (const k of Object.keys(out)) if (!Object.keys(out[k]).length) delete out[k];
  return out;
}
// The elements of an ssam-html/1 reading by name, with their k: variables, inputs, aggregates and widgets (id or name).
export function htmlNames(html) {
  const out = { inputs: {}, locals: {}, aggregates: {}, widgets: {} };
  for (const m of String(html ?? '').matchAll(/<([A-Za-z][\w-]*)\b([^>]*)>/g)) {
    const tag = m[1]; const attrs = m[2];
    const at = name => new RegExp('\\s' + name + '="([^"]*)"').exec(attrs)?.[1] ?? null;
    const k = at('k'); const name = at('name'); const id = at('id');
    if (tag === 'var' && name) out.locals[name] = { k, type: at('type') };
    else if (tag === 'input' && name && !id && at('type') && !at('bind')) out.inputs[name] = { k, type: at('type') };
    else if (tag === 'aggregate' && name) out.aggregates[name] = { k, from: at('from') };
    else if (k && (id || (tag === 'Block' && name))) out.widgets[id ?? name] = { k, tag };
  }
  for (const key of Object.keys(out)) if (!Object.keys(out[key]).length) delete out[key];
  return out;
}

// ---- the owner and its basedOn
const FLOW_KINDS = new Set(['ServerAction', 'ServiceAction', 'ClientAction', 'ScreenAction', 'DataAction', 'Preparation']);
// The basedOn entries of the delivery, each with the field it goes in. `form`: the text forms of the change.
export function basedOnOf({ forms = [], owner = null, sourceSha256 = null, creating = false }) {
  const out = [];
  // An existing action the change edits (or, in a creation, names: it may raise or call there) has its textSha; a new one none.
  const flowEdit = owner && FLOW_KINDS.has(owner.kind) && (!creating || owner.flow);
  if (forms.includes('ssam-flow/1') && flowEdit) out.push({ for: owner.name, form: 'ssam-flow/1', field: 'ssam_code write basedOn (o11_deliver/studio_deliver: job.ops[logic].data.flow[i].basedOn)', value: owner.flow?.textSha ?? null,
    ...(owner.flow?.textSha ? {} : { from: 'action.textSha of ssam_map {view:"flow", element:"' + owner.name + '"}' }),
    rule: 'textSha of the read action (16 hex), one per text' + (creating ? ', only if this change edits it (null for each new text)' : '') + '; never the capture sourceSha256' });
  if (forms.includes('ssam-flow/1') && (creating || !flowEdit)) out.push({ for: 'a new action', form: 'ssam-flow/1', field: 'none', value: null });
  if (forms.includes('ssam-html/1')) {
    const html = owner?.html;
    out.push(html
      ? { for: owner.name, form: 'ssam-html/1', field: 'ssam_code write basedOn (job.ops[html].data.basedOn)', value: html.basedOn ?? { capture: sourceSha256, html: null },
        ...(html.basedOn?.html ? {} : { from: 'basedOn of ssam_map {view:"html", screen:"' + owner.name + '"}' }), rule: 'each changed element whole with its k (owner.widgets)' }
      : { for: 'a new screen or block', form: 'ssam-html/1', field: 'none', value: null });
  }
  if (forms.includes('ssam-ddl/1')) out.push(creating
    ? { for: 'new data statements', form: 'ssam-ddl/1', field: 'none', value: null }
    : { for: 'the data statements that change', form: 'ssam-ddl/1', field: 'ssam_code write basedOn (job.ops[spec].data.basedOn)', value: sourceSha256, rule: 'the capture sourceSha256' });
  out.push({ for: 'a refused delivery', field: 'basedOn beside patch', value: null, from: 'nextBasedOn {job, sha256} of the refusal', rule: 'only after a refusal' });
  return out;
}

// The owner: the action, screen or block the intent names exactly (score 100 in rank), else the best screen named by words
// for a screen edit, with its signature from the digest and the names of its reading.
function ownerOf(digest, rank, { readings = [], screenEdit = false } = {}) {
  const S = sectionsOf(digest);
  const exact = name => (rank.get(name) ?? 0) >= 100;
  const action = (digest.actions ?? []).filter(a => exact(a.name) && FLOW_KINDS.has(a.kind));
  const ui = (S.ui?.blocks ?? []).filter(b => exact(b.name) || (screenEdit && (rank.get(b.name) ?? 0) >= 10)).sort((a, b) => (rank.get(b.name) ?? 0) - (rank.get(a.name) ?? 0));
  const owners = [];
  for (const a of action) {
    const reading = readings.find(r => r.kind === 'flow' && (r.key === a.key || r.name === a.name || r.name?.endsWith('/' + a.name)));
    owners.push({ kind: a.kind, name: a.name, key: '@' + a.key, in: a.in, out: a.out,
      ...(reading ? { flow: { textSha: reading.textSha, fixedPoint: reading.fixedPoint !== false, ...flowNames(reading.text), text: reading.text } } : {}) });
  }
  for (const b of ui.slice(0, 1)) {
    const reading = readings.find(r => r.kind === 'html' && (r.key === b.key || r.screen === b.name));
    const s = screenOf(b);
    if (reading) {
      const names = htmlNames(reading.html);
      for (const g of ['inputs', 'locals', 'aggregates', 'widgets']) for (const [n, v] of Object.entries(names[g] ?? {})) s[g] = { ...(s[g] ?? {}), [n]: { ...(typeof s[g]?.[n] === 'object' ? s[g][n] : s[g]?.[n] ? { type: s[g][n] } : {}), ...v } };
      s.html = { basedOn: reading.basedOn, text: reading.html };
    }
    owners.push(s);
  }
  return owners;
}

// The elements whose reading the packet asks for (discovery.mjs, module-map.mjs ownerReadings): for an edit of a flow, the
// actions the intent names exactly (at most MAX_OWNER_READINGS); for an edit of a screen, the screen or block it names.
export const MAX_OWNER_READINGS = 3;
export function ownerTargets(found, rank, { forms = [], creating = false, screenEdit = false } = {}) {
  if (!found?.digest || found.ok === false) return [];
  const owners = ownerOf(found.digest, rank, { screenEdit: screenEdit && !creating });
  const out = [];
  // A creation reads the existing elements it names exactly: an action (a new exception raised there, a call added there),
  // a screen its html writes (a new attribute shown there).
  if (creating) return [...(forms.includes('ssam-flow/1') ? owners.filter(o => FLOW_KINDS.has(o.kind)).slice(0, MAX_OWNER_READINGS).map(o => ({ kind: 'flow', name: o.name, key: o.key.slice(1) })) : []),
    // A screen named exactly is read whatever forms the route found ("adicionar o atributo X e mostrar na tela Y" routes to
    // data alone: text-routes.mjs does not add the screen's edit).
    ...owners.filter(o => !FLOW_KINDS.has(o.kind) && (rank.get(o.name) ?? 0) >= 100).slice(0, 1).map(o => ({ kind: 'html', name: o.name, key: o.key.slice(1) }))];
  if (forms.includes('ssam-flow/1')) out.push(...owners.filter(o => FLOW_KINDS.has(o.kind)).slice(0, MAX_OWNER_READINGS).map(o => ({ kind: 'flow', name: o.name, key: o.key.slice(1) })));
  if (forms.includes('ssam-html/1')) out.push(...owners.filter(o => !FLOW_KINDS.has(o.kind)).slice(0, 1).map(o => ({ kind: 'html', name: o.name, key: o.key.slice(1) })));
  return out;
}

// ---- the scope within cap bytes
// rank: name -> relevance (work-packet.mjs moduleItems: 100 named exactly, +50 its neighbours, 10 per word of the intent).
// readings: the owner readings (flow and html). forms: the text forms of the change; creating: the change only creates.
export function packetScope(found, { lane, rank = new Map(), readings = [], forms = [], creating = false, screenEdit = false, intent = '' } = {}, cap = Infinity) {
  if (!found || found.ok === false || !found.digest) return null;
  const d = found.digest; const S = sectionsOf(d);
  const target = found.file ?? found.target ?? '<capture.oml or Module>';
  const pin = { lane, target, expectedSourceSha256: found.sourceSha256 };
  const owners = ownerOf(d, rank, { readings, screenEdit });
  const owner = owners[0] ?? null;
  const value = { schema: SCOPE_SCHEMA, use: SCOPE_USE, module: d.module?.name ?? null, sourceSha256: found.sourceSha256 ?? null,
    owner: null, basedOn: basedOnOf({ forms, owner, sourceSha256: found.sourceSha256, creating }) };
  // Every item of every group with its relevance and digest order: [group, name, value, score, order].
  const items = []; let order = 0;
  // A name the owner's reading uses (its flow text or screen) is a neighbour of the change: +40.
  const read = new Set(readings.flatMap(r => String(r.text ?? r.html ?? '').split(/[^A-Za-z0-9_]+/)));
  const used = name => (read.has(name) ? 40 : 0);
  // The relevance of a name the module section does not rank (variables, exceptions, timers, integrations, roles): 100
  // written whole in the intent, else 10 per word of the intent (4+ letters) that begins a word of the name.
  const said = new Set(normalize(intent).split(/[^a-z0-9_]+/).filter(w => w.length >= 3));
  const spoken = [...said].filter(w => w.length >= 4);
  const own = name => {
    if (said.has(normalize(name))) return 100;
    const parts = normalize(String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ')).split(/[^a-z0-9]+/).filter(Boolean);
    return 10 * spoken.filter(w => parts.some(p => p.startsWith(w) || w.startsWith(p) && p.length >= 4)).length;
  };
  const push = (group, name, item, extra = 0) => items.push({ group, name, value: item, score: Math.max(rank.get(name) ?? 0, own(name)) + extra + used(name), order: order++ });
  for (const b of S.entities?.blocks ?? []) push(b.kind === 'StaticEntity' ? 'staticEntities' : 'entities', b.name, entityOf(b).value);
  for (const b of S.structures?.blocks ?? []) push('structures', b.name, structureOf(b));
  for (const b of S.variables?.blocks ?? []) push('variables', b.name, variableOf(b));
  for (const b of S.exceptions?.blocks ?? []) push('exceptions', b.name, '@' + b.key);
  for (const a of d.actions ?? []) push('actions', a.name, { key: '@' + a.key, kind: a.kind, in: a.in, out: a.out });
  for (const b of S.ui?.blocks ?? []) push('screens', b.name, '@' + b.key + ' ' + b.kind);
  for (const b of S.integrations?.blocks ?? []) push('integrations', b.name, integrationOf(b));
  for (const b of S.timers?.blocks ?? []) push('timers', b.name, '@' + b.key + ' ' + (/action=(\S+)/.exec(b.text)?.[1] ?? ''));
  for (const b of S.roles?.blocks ?? []) push('roles', b.name, '@' + b.key);
  // A producer's elements the intent names (each word of 4+ letters that begins an element name), and its kinds counted.
  const words = new Set(normalize(intent).split(/[^a-z0-9_]+/).filter(w => w.length >= 4));
  for (const r of referencesOf(d)) {
    const named = Object.fromEntries(Object.entries(r.kinds).map(([k, names]) => [k, names.filter(n => [...words].some(w => normalize(n).startsWith(w) || normalize(n) === w))]).filter(([, v]) => v.length));
    const total = Object.values(r.kinds).reduce((n, v) => n + v.length, 0);
    const shown = Object.values(named).reduce((n, v) => n + v.length, 0);
    push('references', r.name, { key: r.key, ...named, ...(total > shown ? { more: total - shown } : {}) }, normalize(intent).includes(normalize(r.name)) ? 10 : shown ? 5 : 0);
  }
  // The owner: whole (its text), lean (its names and basedOn) or its head, the richest that leaves room for the floor.
  let whole = null, lean = null, head = null;
  if (owner) {
    const { flow, html, ...rest } = owner;
    head = { kind: rest.kind, name: rest.name, key: rest.key };
    lean = { ...rest, ...(flow ? { flow: { textSha: flow.textSha, fixedPoint: flow.fixedPoint, ...Object.fromEntries(Object.entries(flow).filter(([k]) => !['textSha', 'fixedPoint', 'text'].includes(k))) } } : {}),
      ...(html ? { html: { basedOn: html.basedOn } } : {}) };
    whole = { ...lean, ...(flow ? { flow: { ...lean.flow, text: flow.text } } : {}), ...(html ? { html: { basedOn: html.basedOn, text: html.text } } : {}) };
    if (owners.length > 1) value.alsoOwners = owners.slice(1).map(o => ({ kind: o.kind, name: o.name, key: o.key, ...(o.flow ? { textSha: o.flow.textSha } : {}) }));
  }
  const ranked = [...items].sort((a, b) => b.score - a.score || a.order - b.order);
  const keyOfItem = x => (typeof x.value === 'string' ? x.value.split(' ')[0] : x.value.key);
  // The scope with: the owner in a form, the first n items whole, the next m by name only; next counts the rest.
  const compose = (ownerForm, n, m) => {
    const out = { ...value, owner: ownerForm };
    for (const g of SCOPE_GROUPS) out[g] = {};
    for (const x of ranked.slice(0, n)) out[x.group][x.name] = x.value;
    const names = {};
    for (const x of ranked.slice(n, n + m)) (names[x.group] ??= {})[x.name] = keyOfItem(x);
    for (const g of SCOPE_GROUPS) if (!Object.keys(out[g]).length) delete out[g];
    if (Object.keys(names).length) out.namesOnly = names;
    out.shown = Object.fromEntries(SCOPE_GROUPS.filter(g => out[g] || names[g]).map(g => [g, Object.keys(out[g] ?? {}).length + Object.keys(names[g] ?? {}).length]));
    const next = nextOf(ranked.slice(n + m), owner, ownerForm, pin);
    if (next.length) { out.next = next; if (next.some(x => x.view)) out.map = { tool: 'ssam_map', arguments: { ...pin, view: '<the view of a next entry>' } }; }
    return out;
  };
  const fits = v => bytes(v) <= cap;
  // The richest owner form that fits beside nothing else, then as many whole items as fit, then names only.
  const ownerForm = [whole, lean, head].find(f => fits(compose(f, 0, 0))) ?? head;
  // The largest count that fits, by bisection (more items never take fewer bytes).
  const largest = (most, ok) => { let lo = 0, hi = most; while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (ok(mid)) lo = mid; else hi = mid - 1; } return lo; };
  if (cap === Infinity) return compose(ownerForm, ranked.length, 0);
  // Whole items take at most WHOLE_SHARE of the room the owner leaves; the rest goes to names only (that a name exists,
  // with its key, answers more than the attributes of one more element).
  const floor = bytes(compose(ownerForm, 0, 0));
  const wholeCap = floor + Math.floor((cap - floor) * WHOLE_SHARE);
  const n = largest(ranked.length, k => bytes(compose(ownerForm, k, 0)) <= wholeCap);
  const m = largest(ranked.length - n, k => fits(compose(ownerForm, n, k)));
  return compose(ownerForm, n, m);
}
// next: the calls that read what the room left, labelled per group (every name of the module is one of them away), and the
// read of the owner's text when it was left out.
function nextOf(left, owner, ownerForm, pin) {
  const next = [];
  const count = group => left.filter(x => x.group === group).length;
  const data = ['entities', 'staticEntities', 'structures', 'variables', 'exceptions', 'timers'].filter(count);
  if (owner && !ownerForm?.flow?.text && !ownerForm?.html?.text) {
    const flow = FLOW_KINDS.has(owner.kind);
    next.push({ label: 'the text of ' + owner.name + ' (to edit it whole, with its ' + (flow ? '@ids and textSha' : 'k and basedOn') + ')',
      call: { tool: 'ssam_map', arguments: { ...pin, view: flow ? 'flow' : 'html', ...(flow ? { element: owner.name } : { screen: owner.name }) } } });
  }
  // The other reads share the target and hash of scope.map: each says only its view.
  if (data.length) next.push({ label: data.map(g => count(g) + ' ' + g).join(', ') + ' not shown', view: 'ddl' });
  if (count('actions')) next.push({ label: count('actions') + ' actions not shown (signatures)', view: 'flow' });
  if (count('screens')) next.push({ label: count('screens') + ' screens or blocks not shown', view: 'html' });
  const other = ['integrations', 'roles', 'references'].filter(count);
  if (other.length) next.push({ label: other.map(g => count(g) + ' ' + g).join(', ') + ' not shown', view: 'digest' });
  return next;
}

// Whether the packet must be followed by one read before the delivery, and why: the change edits an element whose text is
// not in the scope (or whose basedOn is unknown), or the scope left out names. `needsReading:false` when the scope and every
// basedOn are already in the packet.
export function readingNeed(scope, { forms = [], creating = false } = {}) {
  if (!scope) return { needsReading: false, why: 'no module: the change is written from scratch (a creation needs no read)' };
  const edit = !creating && forms.some(f => f === 'ssam-flow/1' || f === 'ssam-html/1');
  const own = scope.owner;
  // An existing screen a creation writes into (a new attribute shown there) is edited by k: its reading must be there.
  const touched = own && !own.html?.text && /Screen|Block/.test(own.kind ?? '') && forms.includes('ssam-html/1');
  if (creating && touched) return { needsReading: true, why: 'the change writes into the existing ' + own.name + ': its ssam-html/1 (k and basedOn) did not come with the packet: read it once', read: scope.next?.[0]?.call ?? null };
  if (edit && !own) return { needsReading: true, why: 'the change edits an element the intent does not name exactly: read it once', read: scope.next?.[0]?.call ?? null };
  if (edit && own && !own.flow?.text && !own.html?.text) return { needsReading: true, why: 'the text of ' + own.name + ' did not fit the packet: read it once (or ask the packet with a larger budgetBytes)', read: scope.next?.[0]?.call ?? null };
  const unknown = (scope.basedOn ?? []).find(b => b.field !== 'none' && b.value == null && b.from && !/nextBasedOn/.test(b.from));
  if (unknown) return { needsReading: true, why: 'the basedOn of ' + unknown.for + ' comes from its read', read: scope.next?.[0]?.call ?? null };
  return { needsReading: false, why: creating ? 'a creation: the scope names what the texts can reference, no read' : 'the scope, the text to edit and every basedOn are in this packet' };
}
