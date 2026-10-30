// Only explicit reference positions participate. Shells and mutual declarations
// belong to the kernel planner; an uncertain order is never a facade refusal.
const list = value => Array.isArray(value) ? value : value == null ? [] : [value];
const textOf = value => list(value).map(v => typeof v === 'object' ? v?.text ?? '' : v).join('\n');
export const dependencyName = value => {
  const s = String(value ?? '').trim();
  if (s.startsWith('@')) return s.toLowerCase();
  return s.split('/').at(-1).replace(/^[^:]+:/, '').toLowerCase();
};
const clean = source => String(source ?? '').replace(/"(?:""|\\.|[^"\\])*"|'(?:''|\\.|[^'\\])*'|\/\*[^]*?\*\/|\/\/[^\n]*|--[^\n]*/g, v => v.replace(/[^\n]/g, ' '));
const moduleTypes = /^I?(?:ServerAction|ServiceAction|ClientAction|ServerEntity|StaticEntity|Entity|Structure|Timer|MobileScreen|WebScreen|MobileBlock|WebBlock|Role|UserException|SiteProperty|ClientVariable|SessionVariable)$/i;

export function dependencyFacts(part, actionFacts = { creates: { actions: [] }, consumes: { actions: [] } }) {
  const creates = new Set(), consumes = new Set(), removes = new Set(), writes = new Set(), renames = new Set(), labels = new Map();
  const add = (set, value) => { const key = dependencyName(value); if (key) { set.add(key); if (!labels.has(key)) labels.set(key, String(value)); } };
  const declaration = value => { add(creates, value); add(writes, value); };
  const reference = value => add(consumes, value);
  const expression = value => {
    for (const m of clean(value).matchAll(/\b([A-Za-z_]\w*(?:[.:/][A-Za-z_]\w*)*)(?=\s*\()/g)) reference(m[1]);
    for (const m of clean(value).matchAll(/\b([A-Za-z_]\w*)\.[A-Za-z_]\w*/g)) reference(m[1]);
  };
  const type = value => { const m = /(?:List\s+of\s+)?([A-Za-z_]\w*(?::[A-Za-z_]\w*)?)/i.exec(String(value ?? '')); if (m) reference(m[1]); };
  const flow = value => {
    const source = clean(value);
    for (const m of source.matchAll(/^(?:server action|service action|client action|data action|action|preparation)\s+([\w/.]+)([^\n]*)/gm)) {
      if (m[1].includes('.') || /^(?:action|data action)\b/.test(m[0])) reference(m[1].split('.')[0]);
      else if (!m[2].includes('@')) declaration(m[1]);
      add(writes, m[1]);
    }
    for (const m of source.matchAll(/^\s*(?:in|out|local|var)\s+\w+\s*:\s*([^\n]+)/gm)) type(m[1]);
    for (const m of source.matchAll(/\b(?:from|navigate|call|raise|create|update|delete|get)\s+([\w.:/]+)/g)) reference(m[1]);
    expression(source);
  };
  const ddl = value => {
    const source = clean(value);
    for (const m of source.matchAll(/(?:^|[;\n])\s*(?:create\s+(?:static\s+)?(?:entity|table|structure)|type|entity|structure|timer)\s+([A-Za-z_]\w*)/gmi)) declaration(m[1]);
    for (const m of source.matchAll(/(?:^|[;\n])\s*drop\s+(?:static\s+)?(?:entity|table|structure|type|timer|action|screen|block)\s+(@?[\w.:/]+)/gmi)) { add(removes, m[1]); add(writes, m[1]); }
    for (const m of source.matchAll(/\b(?:references|action|on)\s+([\w.:/]+)/gi)) reference(m[1]);
    for (const m of source.matchAll(/(?:^|[\n{;,])\s*\w+\s*:\s*([^;\n}]+)/g)) type(m[1]);
    for (const m of source.matchAll(/^\s+\w+\s+([A-Za-z_]\w*(?::[A-Za-z_]\w*)?)(?:\s+Identifier)?/gm)) type(m[1]);
  };
  const html = (value, editing = false, owner) => {
    const source = String(value ?? '').replace(/<!--[^]*?-->/g, '');
    const root = /^\s*<(screen|block)\b[^>]*\bname\s*=\s*["']([^"']+)["']/i.exec(source);
    if (root && !editing) declaration(root[2]);
    if (owner) { reference(owner); add(writes, owner); }
    for (const tag of source.matchAll(/<([\w-]+)\b([^>]*?)>/g)) for (const m of tag[2].matchAll(/([:@\w.-]+)\s*=\s*(["'])([^]*?)\2/g)) {
      const key = m[1], value = m[3];
      if (key === 'type') type(value);
      else if (key === 'name' && tag[1] === 'Block') reference(value);
      else if (['from', 'source', 'destination', 'action'].includes(key)) reference(value);
      else if (/^(?:on|@)/.test(key)) { expression(value); if (/^[\w.:/]+$/.test(value)) reference(value); }
      else if (['where', 'sort', 'bind', 'if', 'list'].includes(key) || key.startsWith(':')) expression(value);
    }
    for (const m of source.matchAll(/\{\{([^]*?)\}\}/g)) expression(m[1]);
  };
  const jsonReferences = value => {
    if (Array.isArray(value)) { value.forEach(jsonReferences); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string') {
        if (['type', 'dataType'].includes(key)) type(item);
        else if (['owner', 'call', 'get', 'create', 'update', 'delete', 'createOrUpdate', 'raise', 'entity', 'action', 'destination', 'source', 'from'].includes(key)) reference(item);
        else if (['condition', 'expression', 'value', 'where', 'sort'].includes(key)) expression(item);
      } else jsonReferences(item);
    }
  };
  if (part.part === 'ddl') ddl(textOf(part.text));
  if (part.part === 'logic') list(part.text).forEach(value => flow(textOf(value)));
  if (part.part === 'html') html(textOf(part.text), !!part.element || !!part.basedOn, part.element);
  for (const value of actionFacts.creates.actions) declaration(value);
  for (const value of actionFacts.consumes.actions) reference(value);
  let barrier = false;
  for (const op of part.ops ?? []) {
    if (op.op === 'spec') {
      ddl(op.data?.ddl);
      for (const key of ['structures', 'entities', 'timers']) for (const item of op.data?.[key] ?? []) declaration(item.name);
      jsonReferences(op.data);
    } else if (op.op === 'logic') {
      list(op.data?.flow).forEach(value => flow(textOf(value)));
      for (const action of op.data?.actions ?? []) if (action.owner == null || action.owner === '@espace') declaration(action.name);
      jsonReferences(op.data);
    } else if (op.op === 'html') html(op.data?.html, !!op.data?.screen || !!op.data?.basedOn, op.data?.screen);
    else if (op.op === 'create') {
      if ((op.parent == null || op.parent === '@espace') && moduleTypes.test(String(op.type).split(/[.:]/).at(-1))) declaration(op.name);
      else if (op.parent && op.parent !== '@espace') reference(op.parent);
      jsonReferences({ dataType: op.dataType });
    } else if (op.op === 'delete') { add(removes, op.target ?? op.path); add(writes, op.target ?? op.path); }
    else if ((op.op === 'set' && /^name$/i.test(op.property ?? op.prop)) || op.op === 'rename') { add(writes, op.target ?? op.path); add(writes, op.value ?? op.name); add(renames, op.target ?? op.path); add(renames, op.value ?? op.name); barrier = true; }
    else if (op.op === 'reference') { for (const value of op.elements ?? []) declaration(value); }
    else { barrier = true; for (const value of [op.target, op.path, ...(Array.isArray(op.data?.entities) ? op.data.entities : [op.data?.entities])]) if (value && value !== 'all') { reference(value); add(writes, value); } }
  }
  return { creates, consumes, removes, writes, renames, labels, barrier };
}

// A static record named Create or Timer is not a statement boundary.
export function splitDdl(text) {
  const source = String(text ?? ''); let quote = null, comment = null, depth = 0, start = 0;
  const pieces = [];
  const emit = end => {
    const fragment = source.slice(start, end);
    if (clean(fragment).trim()) pieces.push(fragment);
    else if (pieces.length) pieces[pieces.length - 1] += fragment;
    start = end;
  };
  // A same-line key belongs to the statement before its semicolon, including
  // the last record of a static entity. Keep the newline with that statement.
  const lineCommentEnd = after => {
    let at = after; while (at < source.length && /[^\S\r\n]/.test(source[at])) at++;
    if (source.slice(at, at + 2) !== '--') return after;
    while (at < source.length && source[at] !== '\r' && source[at] !== '\n') at++;
    if (source[at] === '\r') at++;
    if (source[at] === '\n') at++;
    return at;
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i], next = source[i + 1];
    if (comment === 'line') { if (c === '\n') comment = null; else continue; }
    if (comment === 'block') { if (c === '*' && next === '/') { comment = null; i++; } continue; }
    if (quote) { if (c === '\\') i++; else if (c === quote) { if (next === quote) i++; else quote = null; } continue; }
    if ((c === '/' && next === '/') || (c === '-' && next === '-')) { comment = 'line'; continue; }
    if (c === '/' && next === '*') { comment = 'block'; i++; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if ('({['.includes(c)) depth++;
    else if (')}]'.includes(c)) { depth--; if (!depth && c === '}' && /^type\b/i.test(clean(source.slice(start, i + 1)).trim())) { const end = lineCommentEnd(i + 1); emit(end); i = end - 1; } }
    if (!depth && c === ';') { const end = lineCommentEnd(i + 1); emit(end); i = end - 1; }
    if (!depth && c === '\n' && /^(?:timer|setting|site property|client variable|session variable)\b/i.test(clean(source.slice(start, i + 1)).trim())) emit(i + 1);
  }
  emit(source.length);
  return pieces;
}

export const isDropDdl = text => /^drop\b/i.test(clean(text).trim());

// SCC condensation followed by Kahn. Ranks are read once, and the ready queue is
// ranked bitmaps so choosing the stable minimum never rescans the pending graph.
export function orderDependencyGraph(parts, dependencies, rank = () => 0) {
  const ranks = parts.map(rank);
  let serial = 0; const ids = new Int32Array(parts.length).fill(-1), low = new Int32Array(parts.length), stack = [], active = new Set(), components = [];
  const visit = root => {
    const enter = i => { ids[i] = low[i] = serial++; stack.push(i); active.add(i); return { node: i, edges: dependencies[i].values() }; };
    const frames = [enter(root)];
    while (frames.length) {
      const frame = frames.at(-1), i = frame.node, edge = frame.edges.next();
      if (!edge.done) {
        const j = edge.value;
        if (ids[j] < 0) frames.push(enter(j));
        else if (active.has(j)) low[i] = Math.min(low[i], ids[j]);
        continue;
      }
      frames.pop();
      if (frames.length) { const parent = frames.at(-1).node; low[parent] = Math.min(low[parent], low[i]); }
      if (low[i] === ids[i]) {
        const members = []; let j; do { j = stack.pop(); active.delete(j); members.push(j); } while (j !== i);
        components.push(members);
      }
    }
  };
  parts.forEach((_, i) => { if (ids[i] < 0) visit(i); });
  const componentOf = new Int32Array(parts.length);
  components.forEach((members, c) => members.forEach(i => { componentOf[i] = c; }));
  components.forEach(members => { members.length = 0; });
  for (let i = 0; i < parts.length; i++) components[componentOf[i]].push(i);
  const outgoing = components.map(() => new Set()), degree = new Int32Array(components.length);
  dependencies.forEach((deps, i) => { for (const j of deps) {
    const from = componentOf[j], to = componentOf[i];
    if (from !== to && !outgoing[from].has(to)) { outgoing[from].add(to); degree[to]++; }
  } });
  const componentRanks = components.map(c => Math.min(...c.map(i => ranks[i])));
  // Ranks have a fixed small domain (the six part phases, or zero for deletes).
  // Slots are rank-first, then original position. Hierarchical 32-bit maps find
  // the first ready slot in a bounded number of word operations (at most seven
  // levels for array indices), without sorting the ready set on every removal.
  const buckets = new Map(), byFirst = new Int32Array(parts.length).fill(-1);
  components.forEach((c, i) => { byFirst[c[0]] = i; if (!buckets.has(componentRanks[i])) buckets.set(componentRanks[i], []); });
  byFirst.forEach(c => { if (c >= 0) buckets.get(componentRanks[c]).push(c); });
  const slots = [...buckets.keys()].sort((a, b) => a - b).flatMap(rank => buckets.get(rank));
  const slotOf = new Int32Array(components.length); slots.forEach((c, i) => { slotOf[c] = i; });
  const levels = [new Uint32Array(Math.ceil(slots.length / 32))];
  while (levels.at(-1).length > 1) levels.push(new Uint32Array(Math.ceil(levels.at(-1).length / 32)));
  let ready = 0;
  const push = c => {
    ready++; let slot = slotOf[c];
    for (const words of levels) { const i = slot >>> 5, previous = words[i]; words[i] |= 1 << (slot & 31); if (previous) break; slot = i; }
  };
  const pop = () => {
    let slot = 0;
    for (let level = levels.length - 1; level >= 0; level--) { const word = levels[level][slot]; slot = slot * 32 + 31 - Math.clz32(word & -word); }
    const component = slots[slot]; ready--;
    for (const words of levels) { const i = slot >>> 5; words[i] &= ~(1 << (slot & 31)); if (words[i]) break; slot = i; }
    return component;
  };
  degree.forEach((n, i) => { if (!n) push(i); });
  const ordered = [];
  while (ready) { const c = pop(); ordered.push(...components[c].map(i => parts[i])); for (const next of outgoing[c]) if (--degree[next] === 0) push(next); }
  return { parts: ordered, cycles: components.filter(c => c.length > 1) };
}

export function sortDependencies(parts, factsOf, rank = () => 0, extraEdges = [], { creationDependencies = true } = {}) {
  const facts = parts.map(factsOf), dependencies = parts.map(() => new Set()), names = new Map();
  const edge = (after, before) => { if (after !== before) dependencies[after].add(before); };
  facts.forEach((f, i) => {
    for (const name of new Set([...f.creates, ...f.consumes, ...f.writes])) {
      let entry = names.get(name); if (!entry) names.set(name, entry = { creators: [], consumers: [], writers: [], participants: [] });
      if (f.creates.has(name)) entry.creators.push(i);
      if (f.consumes.has(name)) entry.consumers.push(i);
      if (f.writes.has(name)) entry.writers.push(i);
      entry.participants.push(i);
    }
  });
  // Preserve input order through named barriers without a quadratic clique.
  const barriers = (participants, isBarrier) => {
    let last = null, pending = [];
    for (const i of participants) {
      if (last !== null) edge(i, last);
      if (isBarrier(i)) { for (const j of pending) edge(i, j); pending = []; last = i; }
      else pending.push(i);
    }
  };
  for (const [name, entry] of names) {
    const { creators, consumers, writers, participants } = entry, created = creators.length > 0;
    if (creationDependencies) for (const i of consumers) for (const j of creators) edge(i, j);
    for (const i of writers) {
      if (facts[i].removes.has(name)) for (const j of consumers) edge(i, j);
      if (creationDependencies && created && !facts[i].creates.has(name) && !facts[i].removes.has(name) && !facts[i].renames?.has(name)) for (const j of creators) edge(i, j);
    }
    if (created) {
      // Two creators, drops/recreates, and renames/recreates are real conflicts.
      for (let i = 1; i < creators.length; i++) edge(creators[i], creators[i - 1]);
      barriers(writers, i => facts[i].removes.has(name) || facts[i].renames?.has(name));
      barriers(participants, i => facts[i].renames?.has(name));
    } else {
      for (let i = 1; i < writers.length; i++) edge(writers[i], writers[i - 1]);
      barriers(participants, i => facts[i].barrier);
    }
  }
  // Owner deletions follow their explicitly deleted descendants.
  const deletedPaths = new Map();
  parts.forEach((p, i) => { const op = p.ops?.[0], target = op?.target ?? op?.path; if (op?.op === 'delete' && target) deletedPaths.set(target, i); });
  for (const [target, i] of deletedPaths) { let end = target.lastIndexOf('/'); while (end > 0) { const owner = deletedPaths.get(target.slice(0, end)); if (owner !== undefined) edge(owner, i); end = target.lastIndexOf('/', end - 1); } }
  for (const [before, after] of extraEdges) if (dependencies[after]) edge(after, before);
  const ordered = orderDependencyGraph(parts, dependencies, rank);
  return { parts: ordered.parts, ...(ordered.cycles.length ? { cycle: ordered.cycles.flat().map(i => ({ at: parts[i].at ?? String(i), names: [...new Set([...facts[i].creates, ...facts[i].removes])].map(n => facts[i].labels.get(n) ?? n) })) } : {}) };
}
