// View discovery (docs/PROTOTIPO-NATIVO.md 2.3): a fixpoint over states x routes. Route sources, in every explored
// state: hrefs of the renders, navigations observed as effects, the README route table, script literals (Acorn) and
// mapping.routes. States: S0 and, for each global dimension and each of its values, S0 with only that dimension
// changed, plus mapping.states. Then templates, fallback, canonical states, the default view and the names.
import { alignTrees, renderKey, alignSequences } from './align.mjs';
import { attr, classes, elementsWithPath, isElement, isModalNode, matchIndex, textOf, walk, sha256, canonical } from './ir.mjs';
import { pascal, slug, readmeRoutes } from './names.mjs';

export const LIMITS = Object.freeze({ routes: 64, states: 32, depth: 4, probes: 1500 });

// ---- session --------------------------------------------------------------------------------------------------------

export class Session {
  constructor(options) {
    Object.assign(this, options);
    this.warnings = this.warnings ?? [];
    this.problems = this.problems ?? [];
    this.dims = [];
    this.probeCount = 0;
    this.iconSvg = new Map();
    this.runtimeStyles = [];
    this.read = new Set();
  }

  warn(warning) {
    const key = canonical(warning);
    if (!this.warnings.some(item => canonical(item) === key)) this.warnings.push(warning);
  }

  // probes: [{key, page?, storage?, prefix?, steps, shared?}] -> Map(key -> {snaps, failure})
  async run(probes) {
    const groups = new Map();
    for (const probe of probes) {
      const page = probe.page ?? this.entry;
      const group = canonical([page, probe.storage ?? null, probe.prefix ?? [], Boolean(probe.shared)]);
      if (!groups.has(group)) groups.set(group, { key: 'b' + sha256(group).slice(0, 16), page, kind: this.kind, storage: probe.storage ?? null, prefix: probe.prefix ?? [], shared: Boolean(probe.shared), live: this.s0?.inspect?.store?.live ?? null, probes: [] });
      groups.get(group).probes.push({ key: probe.key, steps: probe.steps });
    }
    // Batches are cut in small chunks (the unit of distribution), so that every child works in each round; the chunk
    // composition depends only on the probe keys, never on the pool size.
    const batches = [];
    for (const group of groups.values()) {
      group.probes.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
      const size = group.shared ? 3 : 3;
      for (let start = 0, index = 0; start < group.probes.length; start += size, index++) batches.push({ ...group, key: group.key + '#' + String(index).padStart(3, '0'), probes: group.probes.slice(start, start + size) });
    }
    if (this.probeCount + probes.length > LIMITS.probes) {
      this.warn({ code: 'PrototypeProbeLimit', limit: LIMITS.probes });
    }
    this.probeCount += probes.length;
    const started = performance.now();
    const answers = await this.pool.run(batches, { warmIdle: this.warmIdle ? (this.warmIdle = null, this.entry) : null });
    (this.rounds = this.rounds ?? []).push({ probes: probes.length, batches: batches.length, ms: Math.round(performance.now() - started) });
    const out = new Map();
    for (const answer of answers) {
      if (!answer.ok) {
        for (const probe of batches.find(batch => batch.key === answer.key).probes) out.set(probe.key, { snaps: [], failure: { error: answer.error } });
        this.problems.push({ code: 'PROTOTYPE_RENDER_FAILED', message: 'capture child failed: ' + String(answer.error).split('\n')[0], internal: true });
        continue;
      }
      for (const name of answer.result.read ?? []) this.read.add(name);
      for (const result of answer.result.results) {
        for (const [name, svg] of Object.entries(result.icons ?? {})) if (!this.iconSvg.has(name)) this.iconSvg.set(name, svg);
        for (const warning of result.warnings ?? []) this.warn(warning);
        for (const snap of result.snaps) for (const text of snap.runtimeStyles ?? []) if (!this.runtimeStyles.includes(text)) this.runtimeStyles.push(text);
        out.set(result.key, result);
      }
    }
    return out;
  }

  // Steps that apply a state: global dimensions through their controls, in document order.
  stateSteps(state) {
    const steps = [];
    for (const dim of this.dims) {
      if (!(dim.key in (state.assign ?? {}))) continue;
      steps.push(...dimensionSteps(dim, state.assign[dim.key]));
    }
    return steps;
  }
}

export function dimensionSteps(dim, value) {
  if (dim.kind === 'control') return [{ do: 'set', target: dim.target, value }];
  if (dim.kind === 'text') return [{ do: 'type', target: dim.target, value }];
  if (dim.kind === 'trigger') return [{ do: 'click', target: { m: { t: dim.match.t, a: dim.match.a.concat([[dim.param, String(value)]]) }, i: 0 } }];
  if (dim.kind === 'toggle') return String(value) === String(dim.initial) ? [] : [{ do: 'click', target: dim.target }];
  // a session chosen in a dialog (an account to enter with): open it, choose, confirm
  if (dim.kind === 'dialog') return String(value) === String(dim.initial) ? [] : [{ do: 'open', target: dim.dialog }, { do: 'set', target: dim.target, value }, { do: 'click', target: dim.confirm }];
  return [];
}

export function stateKey(assign) {
  const entries = Object.entries(assign ?? {});
  return entries.length ? entries.map(([key, value]) => key + '=' + value).join('&') : 'S0';
}

// ---- helpers on serialized trees -----------------------------------------------------------------------------------

export function idsOf(body) {
  const ids = new Set();
  walk(body, node => { const id = isElement(node) ? attr(node, 'id') : null; if (id) ids.add(id); });
  return ids;
}

export function hrefRoutes(body, kind) {
  const out = [];
  walk(body, node => {
    if (!isElement(node) || node.t !== 'a') return;
    const href = attr(node, 'href');
    if (href == null) return;
    if (kind === 'spa-path') {
      if (/^\//.test(href) && !/\.[a-z0-9]+$/i.test(href)) out.push(href);
      return;
    }
    if (href.startsWith('#') && href.length > 1) out.push(decodeURIComponent(href.slice(1)));
  });
  return out;
}

// The body as the user sees it: the subtrees the capture marks hidden (a closed dialog, a hidden section) left out.
export function visibleBody(node) {
  if (!isElement(node)) return node;
  return { ...node, c: (node.c ?? []).filter(child => !(isElement(child) && child.h)).map(visibleBody) };
}
const visibleKey = body => renderKey(visibleBody(body));

// Whether the element at path is hidden or inside a hidden element (a control nobody can set there).
export function hiddenAt(body, path) {
  let node = body;
  for (const index of path ?? []) { node = node?.c?.[index]; if (!node) return true; if (node.h) return true; }
  return false;
}

// The button that confirms a dialog's form: a submit button that is not the cancel one (value cancel, formnovalidate).
function confirmButton(dialog) {
  const buttons = [];
  walk(dialog, node => { if (isElement(node) && (node.t === 'button' || (node.t === 'input' && attr(node, 'type') === 'submit'))) buttons.push(node); });
  const submits = buttons.filter(node => !['button', 'reset'].includes(String(attr(node, 'type') ?? 'submit').toLowerCase()));
  return submits.filter(node => attr(node, 'formnovalidate') == null && !/^(cancel|cancelar|close|fechar|voltar)$/i.test(String(attr(node, 'value') ?? ''))).pop() ?? null;
}

// A control usable as a dimension: select, checkbox, radio (enumerable), or a text field.
export function controlsOf(body) {
  const out = [];
  for (const { node, path } of elementsWithPath(body)) {
    if (!['select', 'input', 'textarea'].includes(node.t)) continue;
    const type = String(attr(node, 'type') ?? 'text').toLowerCase();
    if (node.t === 'input' && ['hidden', 'submit', 'button', 'reset', 'image', 'file'].includes(type)) continue;
    const enumerable = node.t === 'select' || (node.t === 'input' && ['checkbox', 'radio'].includes(type));
    const id = attr(node, 'id'), name = attr(node, 'name');
    let values = null;
    if (node.t === 'select') values = (node.c ?? []).flatMap(child => child.t === 'optgroup' ? child.c ?? [] : [child]).filter(child => child.t === 'option').map(option => attr(option, 'value') ?? textOf(option));
    else if (type === 'checkbox') values = ['true', 'false'];
    const current = node.p ? (type === 'checkbox' ? String(Boolean(node.p.ck)) : node.p.v) : attr(node, 'value') ?? '';
    out.push({ node, path, id, name, type: node.t === 'input' ? type : node.t, enumerable, values, current, inForm: false });
  }
  return out;
}

export function targetFor(body, node) {
  const id = attr(node, 'id');
  if (id) return { id };
  const keyAttrs = (node.a ?? []).filter(([name]) => name === 'name' || name.startsWith('data-') || name === 'type' || name === 'role' || name === 'aria-label');
  const m = { t: node.t, a: keyAttrs };
  const i = matchIndex(body, node, m);
  return i >= 0 ? { m, i } : null;
}

export function routeTemplate(route, dataIds = new Set()) {
  if (route.startsWith('/')) {
    return '/' + route.slice(1).split('/').map(segment => /^\d+$/.test(segment) || dataIds.has(segment) ? '{id}' : segment).join('/');
  }
  return route.split('/').map((segment, index) => index > 0 && (/^\d+$/.test(segment) || dataIds.has(segment)) ? '{id}' : segment).join('/');
}

// Structural difference between two subtrees: unmatched nodes or differing texts (attribute-only changes such as an
// "active" class or aria-current do not count).
export function structurallyDifferent(a, b) {
  if (!a || !b) return Boolean(a) !== Boolean(b);
  const { pairs, onlyA, onlyB } = alignTrees(a, b);
  const meaningful = node => isElement(node) || String(node.x ?? '').trim();
  if (onlyA.some(meaningful) || onlyB.some(meaningful)) return true;
  for (const [x, y] of pairs) if (!isElement(x) && String(x.x).replace(/\s+/g, ' ').trim() !== String(y.x).replace(/\s+/g, ' ').trim()) return true;
  return false;
}

// The deepest element under a mount whose content still differs between the bodies while everything around it is the
// same: a React app re-renders its screen inside a frame of plain divs (stage > scale > phone > screen), and the frame is
// shell, never screen. Descends while the node has the same number of element children in every body and exactly one of
// them differs.
export function deepenMount(bodies, path) {
  let current = path;
  for (let depth = 0; depth < 12; depth++) {
    const nodes = bodies.map(body => nodeAtPath(body, current));
    if (nodes.some(node => !isElement(node))) break;
    const kids = nodes.map(node => (node.c ?? []).map((child, index) => ({ child, index })).filter(({ child }) => isElement(child) && !isModalNode(child)));
    if (kids.some(list => list.length !== kids[0].length) || !kids[0].length) break;
    const differing = kids[0].filter(({ child, index }, position) => kids.some(list => list[position].index !== index || list[position].child.t !== child.t || structurallyDifferent(child, list[position].child)));
    if (differing.length !== 1) break;
    current = current.concat(differing[0].index);
  }
  return current;
}

// The element of a body whose content is rewritten per route (app root) and, inside it, the mount point.
export function findMount(bodies, { modalContainer = () => false } = {}) {
  const first = bodies[0];
  if (!first) return null;
  const top = (first.c ?? []).map((node, index) => ({ node, index })).filter(({ node }) => isElement(node) && !modalContainer(node));
  const differing = [];
  for (const { node, index } of top) {
    const others = bodies.map(body => (body.c ?? [])[index]);
    if (others.some(other => !other || renderKey(other) !== renderKey(node))) differing.push(index);
  }
  if (!differing.length) return { appRoot: null, mount: null, candidates: [] };
  // A shell element that changes only its attributes per route (the active link of a side menu) is not the app root:
  // among several differing elements, the one whose structure or text changes is.
  const rewritten = differing.length > 1 ? differing.filter(index => bodies.some(body => structurallyDifferent(first.c[index], (body.c ?? [])[index]))) : differing;
  const appIndex = differing.length === 1 ? differing[0] : rewritten.length === 1 ? rewritten[0] : null;
  if (appIndex === null) return { appRoot: null, mount: null, candidates: differing.map(index => [index]), ambiguousRoot: true };
  const roots = bodies.map(body => body.c[appIndex]);
  const kids = (roots[0].c ?? []).map((node, index) => ({ node, index })).filter(({ node }) => isElement(node));
  const candidates = [];
  for (const { node, index } of kids) {
    const aligned = roots.map(root => (root.c ?? [])[index]);
    if (aligned.some(other => !other || !isElement(other) || other.t !== node.t)) { candidates.push(index); continue; }
    if (aligned.some(other => structurallyDifferent(node, other))) candidates.push(index);
  }
  const sameShape = roots.every(root => (root.c ?? []).length === (roots[0].c ?? []).length);
  if (!sameShape || candidates.length === 0) return { appRoot: [appIndex], mount: [appIndex], candidates: [[appIndex]], rootIsMount: true };
  if (candidates.length > 1) return { appRoot: [appIndex], mount: null, candidates: candidates.map(index => [appIndex, index]), ambiguous: true };
  return { appRoot: [appIndex], mount: [appIndex, candidates[0]], candidates: [[appIndex, candidates[0]]] };
}

// Screens that are fixed sections of the page switched by the router (section.view[data-view] shown and hidden by the hash,
// tab panels, ...): a parent whose element children (modal containers aside) are all sections, exactly one of them visible
// in every route render and at least two different ones visible across the routes. The parent is the mount (it stays in
// the shell); each screen is its own section. -> {parent: path, sections: [child index], visible(body) -> child index} | null
export function toggledSections(bodies, { modalContainer = () => false, maxDepth = 6 } = {}) {
  const first = bodies[0];
  if (!first || bodies.length < 2) return null;
  const kidsOf = node => (node?.c ?? []).map((child, index) => ({ child, index })).filter(({ child }) => isElement(child) && !modalContainer(child));
  const visibleOf = node => { const shown = kidsOf(node).filter(({ child }) => !child.h); return shown.length === 1 ? shown[0].index : null; };
  const fits = path => {
    const base = nodeAtPath(first, path);
    const kids = kidsOf(base);
    if (kids.length < 2) return null;
    const signature = kids.map(({ child, index }) => index + ':' + child.t).join(',');
    const visible = new Set();
    for (const body of bodies) {
      const node = nodeAtPath(body, path);
      if (!node || node.t !== base.t || kidsOf(node).map(({ child, index }) => index + ':' + child.t).join(',') !== signature) return null;
      const shown = visibleOf(node);
      if (shown == null) return null;
      visible.add(shown);
    }
    return visible.size >= 2 ? { parent: path, sections: kids.map(({ index }) => index), visible: body => visibleOf(nodeAtPath(body, path)) } : null;
  };
  const queue = [[]];
  while (queue.length) {
    const path = queue.shift();
    const found = fits(path);
    if (found) return found;
    if (path.length >= maxDepth) continue;
    for (const { index } of kidsOf(nodeAtPath(first, path))) queue.push(path.concat(index));
  }
  return null;
}

// A compound selector over the serialized tree: tag, #id, .class, [attr] / [attr="value"] and :nth-of-type(n), the forms
// uniqueSelector writes (and mapping.shell.mount accepts).
export function matchesSelector(node, selector, parent = null) {
  if (!isElement(node)) return false;
  const text = String(selector ?? '').trim();
  const pattern = /^([a-z][a-z0-9-]*)?((?:#[\w-]+|\.[\w-]+|\[[\w-]+(?:="[^"]*")?\]|:nth-of-type\(\d+\))*)$/i;
  const match = text.match(pattern);
  if (!match) return false;
  if (match[1] && match[1].toLowerCase() !== node.t) return false;
  for (const part of match[2].match(/#[\w-]+|\.[\w-]+|\[[\w-]+(?:="[^"]*")?\]|:nth-of-type\(\d+\)/gi) ?? []) {
    if (part[0] === '#' && attr(node, 'id') !== part.slice(1)) return false;
    if (part[0] === '.' && !classes(node).includes(part.slice(1))) return false;
    if (part[0] === '[') { const [, name, value] = part.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/); if (attr(node, name) == null || (value !== undefined && attr(node, name) !== value)) return false; }
    if (part[0] === ':') {
      if (!parent) return false;
      const same = (parent.c ?? []).filter(child => isElement(child) && child.t === node.t);
      if (same.indexOf(node) + 1 !== Number(part.match(/\d+/)[0])) return false;
    }
  }
  return true;
}

// The selector of an element that matches it alone in the body: tag, id, classes, then its distinguishing attributes
// (data-*, name, role, aria-label), then :nth-of-type among its siblings. Never a selector that matches several elements.
export function uniqueSelector(body, path) {
  const node = nodeAtPath(body, path);
  if (!isElement(node)) return null;
  const parent = path.length ? nodeAtPath(body, path.slice(0, -1)) : null;
  const all = elementsWithPath(body).map(item => ({ ...item, parent: item.path.length ? nodeAtPath(body, item.path.slice(0, -1)) : null }));
  const unique = selector => all.filter(item => matchesSelector(item.node, selector, item.parent)).length === 1;
  let selector = node.t + (attr(node, 'id') ? '#' + attr(node, 'id') : '') + classes(node).filter(token => /^[\w-]+$/.test(token)).map(token => '.' + token).join('');
  if (unique(selector)) return selector;
  for (const [name, value] of (node.a ?? []).filter(([name]) => name.startsWith('data-') || ['name', 'role', 'aria-label', 'href', 'type'].includes(name))) {
    if (!/^[\w-]+$/.test(name) || String(value).includes('"')) continue;
    selector += '[' + name + '="' + value + '"]';
    if (unique(selector)) return selector;
  }
  const same = (parent?.c ?? []).filter(child => isElement(child) && child.t === node.t);
  selector += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
  return unique(selector) ? selector : null;
}

export function nodeAtPath(body, path) {
  let node = body;
  for (const index of path ?? []) { node = node?.c?.[index]; if (!node) return null; }
  return node;
}

// ---- crawl ---------------------------------------------------------------------------------------------------------

function routeList() {
  const map = new Map();
  return {
    map,
    add(route, source, extra = {}) {
      if (route == null) return false;
      const key = String(route);
      if (map.has(key)) { map.get(key).sources.add(source); return false; }
      if (map.size >= LIMITS.routes) return false;
      map.set(key, { route: key, sources: new Set([source]), order: map.size, ...extra });
      return true;
    },
    list() { return [...map.values()].sort((a, b) => a.order - b.order); }
  };
}

function renderKeyOfBody(body) { return renderKey(body); }

// spa-hash / spa-path: the fixpoint over states x routes.
export async function crawlRoutes(session, s0) {
  const { analysis, mapping, kind } = session;
  const routes = routeList();
  const ids = idsOf(s0.body);
  const isRoute = route => route !== '' && !(kind !== 'spa-path' && ids.has(route));
  routes.add('', 'initial');
  for (const route of hrefRoutes(s0.body, kind)) if (isRoute(route)) routes.add(route, 'href');
  const readme = session.readme ? readmeRoutes(session.readme, session.entry) : [];
  for (const item of readme) if (kind === 'spa-path' ? item.route.startsWith('/') : !item.route.startsWith('/')) routes.add(item.route, 'readme');
  const literalRoutes = kind === 'spa-path' ? analysis.paths : analysis.strong;
  const weak = new Set();
  for (const item of literalRoutes) if (!item.route.includes('{id}')) routes.add(item.route, 'literal');
  for (const item of analysis.weak) if (!item.route.includes('{id}') && (kind !== 'spa-path' || item.route.startsWith('/'))) { if (routes.add(item.route, 'literal-segment')) weak.add(item.route); }
  for (const item of analysis.hashLiterals) if (kind === 'spa-hash' && !ids.has(item.route)) routes.add(item.route, 'literal');
  for (const route of mapping.routes ?? []) routes.add(String(route).replace(/^#/, ''), 'mapping');
  const literalTemplates = literalRoutes.filter(item => item.route.includes('{id}')).map(item => item.route);

  const states = [{ key: 'S0', assign: {} }];
  for (const [viewKey, assign] of Object.entries(mapping.states ?? {})) {
    if (!assign || typeof assign !== 'object' || typeof assign.click === 'string') continue;
    for (const dimKey of Object.keys(assign)) if (!session.dims.some(dim => dim.key === dimKey)) { const dim = mappingDimension(s0.body, dimKey); if (dim) session.dims.push(dim); }
    const key = stateKey(assign);
    if (!states.some(state => state.key === key)) states.push({ key, assign: { ...assign }, mapping: viewKey });
  }
  const renders = new Map();                       // stateKey|route -> snap
  const checked = new Map();                        // control key -> {global}
  const observedNav = [];
  let dialogsChecked = false;
  const dialogChecks = [];
  let round = 0;
  while (round++ < 32) {
    const probes = [];
    for (const state of states) {
      for (const item of routes.list()) {
        const id = state.key + '|' + item.route;
        if (renders.has(id)) continue;
        probes.push({ key: 'r|' + id, prefix: session.stateSteps(state), steps: [{ do: 'nav', route: item.route }, { do: 'snap', tag: id }], shared: true });
      }
    }
    // Global dimension checks for enumerable controls first seen in the previous round.
    const checks = [];
    // With screens as fixed sections, the other route of a check shows another section (two routes of one screen, the empty
    // hash and its default route, say nothing about a global dimension).
    const sectionsNow = toggledSections(routes.list().map(item => renders.get('S0|' + item.route)?.body).filter(Boolean), { modalContainer: isModalNode });
    const otherScreen = (a, b) => sectionsNow ? sectionsNow.visible(a) !== sectionsNow.visible(b) : visibleKey(a) !== visibleKey(b);
    const screenKey = body => { if (!sectionsNow) return visibleKey(body); const index = sectionsNow.visible(body); const parent = nodeAtPath(body, sectionsNow.parent); return renderKey(index == null ? parent : parent?.c?.[index]); };
    for (const [id, snap] of renders) {
      const [sKey, route] = splitId(id);
      const state = states.find(item => item.key === sKey);
      for (const control of controlsOf(snap.body)) {
        if (!control.enumerable) continue;
        // a control the user cannot see here (in a closed dialog, in a hidden section) is set where it shows
        if (hiddenAt(snap.body, control.path)) continue;
        const key = controlKey(control);
        if (checked.has(key)) continue;
        const values = (control.values ?? []).filter(value => String(value) !== String(control.current));
        if (!values.length) { checked.set(key, { global: false }); continue; }
        // Another route whose render differs from this one in the same state.
        const other = routes.list().find(item => item.route !== route && renders.has(sKey + '|' + item.route) && otherScreen(renders.get(sKey + '|' + item.route).body, snap.body));
        if (!other) continue;
        checked.set(key, { global: false, control, route, state, other: other.route, values, pending: values.length });
        for (const value of values.slice(0, 8)) {
          checks.push({ key: 'g|' + key + '|' + value, prefix: session.stateSteps(state), steps: [{ do: 'nav', route }, { do: 'set', target: targetFor(snap.body, control.node), value }, { do: 'snap', tag: 'after' }, { do: 'nav', route: other.route }, { do: 'snap', tag: 'other' }] });
        }
        // the same two navigations without touching the control: what the route itself leaves behind (a dialog it opens)
        // is no effect of the control
        checks.push({ key: 'gb|' + key, prefix: session.stateSteps(state), steps: [{ do: 'nav', route }, { do: 'snap', tag: 'after' }, { do: 'nav', route: other.route }, { do: 'snap', tag: 'other' }] });
      }
    }
    if (!probes.length && !checks.length) break;
    const results = await session.run(probes.concat(checks));
    let changed = false;
    for (const probe of probes) {
      const result = results.get(probe.key);
      const snap = result?.snaps?.[0];
      if (!snap) continue;
      const id = probe.key.slice(2);
      renders.set(id, snap);
      const [sKey, requested] = splitId(id);
      const landed = currentRoute(snap, kind);
      if (landed !== requested && landed !== '' && isRoute(landed)) { if (routes.add(landed, 'navigation')) changed = true; observedNav.push({ from: requested, to: landed, state: sKey }); }
      const bodyIds = idsOf(snap.body);
      for (const route of hrefRoutes(snap.body, kind)) if (!bodyIds.has(route) && isRoute(route) && routes.add(route, 'href')) changed = true;
    }
    for (const check of checks) {
      const result = results.get(check.key);
      if (!result?.snaps?.length || check.key.startsWith('gb|')) continue;
      const [, key, value] = check.key.split('|');
      const entry = checked.get(key);
      const [after, other] = result.snaps;
      const landed = currentRoute(after, kind);
      if (landed !== entry.route && isRoute(landed) && routes.add(landed, 'navigation')) { changed = true; observedNav.push({ from: entry.route, to: landed, control: key, value }); }
      const base = results.get('gb|' + key)?.snaps?.[1] ?? renders.get(entry.state.key + '|' + entry.other);
      // what the user sees on the other route changed (a value left in a hidden section or a closed dialog is no change)
      // with screens as sections, what changed is the other screen's own section (a counter of the top bar is the shell's)
      if (other && base && screenKey(other.body) !== screenKey(base.body)) entry.global = true;
      entry.values = entry.values ?? [];
    }
    // Sessions chosen in a dialog (an account to enter with): a closed dialog whose form has a choice and a confirm button;
    // confirming each choice and visiting the other routes shows whether the screens changed. A changed screen makes the
    // choice a global dimension (kind dialog) whose states are explored like any other.
    if (!dialogsChecked && renders.has('S0|') && routes.list().filter(item => renders.has('S0|' + item.route)).length >= 2) {
      dialogsChecked = true;
      const base = renders.get('S0|').body;
      const others = routes.list().filter(item => item.route !== '' && renders.has('S0|' + item.route)).slice(0, 8);
      for (const { node: dialog } of elementsWithPath(base)) {
        if (!(isElement(dialog) && dialog.t === 'dialog' && dialog.h && attr(dialog, 'id'))) continue;
        const confirm = confirmButton(dialog);
        const control = controlsOf(dialog).find(item => item.enumerable && item.id && item.values?.length);
        if (!confirm || !control || session.dims.some(dim => dim.key === control.id)) continue;
        const confirmTarget = targetFor(base, confirm);
        if (!confirmTarget) continue;
        // nothing confirmed yet is the zero of the values' type (0 for an account id), a value no choice has
        const values = control.values.map(String);
        const initial = values.every(value => /^-?\d+$/.test(value)) && !values.includes('0') ? '0' : '';
        const dim = { key: control.id, name: pascal(control.id), kind: 'dialog', control: control.type, dialog: { id: attr(dialog, 'id') }, target: { id: control.id }, confirm: confirmTarget, values, initial, global: true, scope: 'global' };
        for (const value of dim.values.slice(0, 8)) {
          dialogChecks.push({ dim, value, probe: { key: 'dlg|' + dim.key + '|' + value, prefix: [], steps: [...dimensionSteps(dim, value), ...others.flatMap(item => [{ do: 'nav', route: item.route }, { do: 'snap', tag: item.route }])] }, others });
        }
      }
      if (dialogChecks.length) {
        const results = await session.run(dialogChecks.map(item => item.probe));
        const sectionsNow = toggledSections(routes.list().map(item => renders.get('S0|' + item.route)?.body).filter(Boolean), { modalContainer: node => node.t === 'dialog' || attr(node, 'role') === 'dialog' });
        const shown = body => { if (!sectionsNow) return visibleKey(body); const index = sectionsNow.visible(body); return renderKey(index == null ? nodeAtPath(body, sectionsNow.parent) : nodeAtPath(body, sectionsNow.parent)?.c?.[index]); };
        const global = new Set();
        for (const item of dialogChecks) {
          const snaps = results.get(item.probe.key)?.snaps ?? [];
          if (snaps.some(snap => { const base = renders.get('S0|' + snap.tag)?.body; return base && shown(snap.body) !== shown(base); })) global.add(item.dim);
        }
        for (const dim of global) {
          session.dims.push(dim);
          for (const value of dim.values) {
            const assign = { [dim.key]: String(value) };
            const sk = stateKey(assign);
            if (states.length >= LIMITS.states) { session.warn({ code: 'PrototypeStateLimit', limit: LIMITS.states }); break; }
            if (!states.some(state => state.key === sk)) { states.push({ key: sk, assign }); changed = true; }
          }
        }
      }
    }
    // New global dimensions -> new states (S0 with only that dimension changed).
    for (const [key, entry] of checked) {
      if (!entry.global || entry.addedStates) continue;
      entry.addedStates = true;
      const control = entry.control;
      const dim = { key: control.id ?? control.name ?? key, name: pascal(control.id ?? control.name ?? key), kind: 'control', control: control.type, target: control.id ? { id: control.id } : targetFor(renders.get(entry.state.key + '|' + entry.route).body, control.node), values: control.values, initial: control.current, global: true, scope: 'global', route: entry.route };
      if (!session.dims.some(item => item.key === dim.key)) session.dims.push(dim);
      for (const value of control.values) {
        if (String(value) === String(control.current)) continue;
        const assign = { [dim.key]: String(value) };
        const sk = stateKey(assign);
        if (states.length >= LIMITS.states) { session.warn({ code: 'PrototypeStateLimit', limit: LIMITS.states }); break; }
        if (!states.some(state => state.key === sk)) { states.push({ key: sk, assign }); changed = true; }
      }
    }
    if (!changed && !probes.length) break;
  }
  return { routes: routes.list(), states, renders, weak, readme, literalTemplates, observedNav, checked };
}

// A dimension named by mapping.states: a control with that id, else the trigger group with that data-action.
export function mappingDimension(body, key) {
  let control = null;
  const triggers = [];
  walk(body, node => {
    if (!isElement(node)) return;
    if (attr(node, 'id') === key && ['select', 'input', 'textarea'].includes(node.t)) control = node;
    if (attr(node, 'data-action') === key) triggers.push(node);
  });
  if (control) return { key, name: pascal(key), kind: 'control', control: control.t, target: { id: key }, values: [], initial: control.p?.v ?? attr(control, 'value') ?? '', global: true, scope: 'global', fromMapping: true };
  if (triggers.length) {
    const param = (triggers[0].a ?? []).map(([name]) => name).find(name => name.startsWith('data-') && name !== 'data-action') ?? 'data-id';
    return { key, name: pascal(key), kind: 'trigger', param, match: { t: triggers[0].t, a: [['data-action', key]] }, values: triggers.map(node => attr(node, param)), initial: attr(triggers[0], param), global: true, scope: 'global', fromMapping: true };
  }
  return null;
}

// A view named by the README (or mapping.routes) that is fallback in every explored state: the first single
// assignment (enumerable control value or parameterized trigger of S0) that renders it is the mapping.states patch.
export async function searchStates(session, crawl, found) {
  const pending = found.problems.filter(problem => problem.key === 'states');
  if (!pending.length) return;
  const s0 = session.s0;
  const candidates = [];
  for (const control of controlsOf(s0.body)) {
    if (!control.enumerable || !control.id) continue;
    for (const value of (control.values ?? []).filter(item => String(item) !== String(control.current))) candidates.push({ key: control.id, value: String(value), steps: [{ do: 'set', target: { id: control.id }, value }] });
  }
  const groups = new Map();
  walk(s0.body, node => { const action = isElement(node) ? attr(node, 'data-action') : null; if (action) { if (!groups.has(action)) groups.set(action, []); groups.get(action).push(node); } });
  for (const [action, nodes] of groups) {
    const param = (nodes[0].a ?? []).map(([name]) => name).find(name => name.startsWith('data-') && name !== 'data-action');
    if (!param) continue;
    for (const node of nodes) candidates.push({ key: action, value: attr(node, param), steps: [{ do: 'click', target: { m: { t: node.t, a: [['data-action', action], [param, attr(node, param)]] }, i: 0 } }] });
  }
  for (const problem of pending) {
    const info = found.templates.get(problem.view);
    if (!info) continue;
    const route = info.routes[0];
    const base = crawl.renders.get('S0|' + route);
    const probes = candidates.slice(0, 40).map((candidate, index) => ({ key: 'ss|' + problem.view + '|' + String(index).padStart(3, '0'), steps: [...candidate.steps, { do: 'nav', route }, { do: 'snap', tag: 'after' }] }));
    const results = await session.run(probes);
    for (const [index, probe] of probes.entries()) {
      const snap = results.get(probe.key)?.snaps?.[0];
      if (!snap || !base) continue;
      const mountA = found.mountOf(snap.body), mountB = found.mountOf(base.body);
      if (renderKey(mountA) !== renderKey(mountB) && !found.fallback.get('S0')?.has(renderKey(mountA).replace(/\s+/g, ' '))) {
        problem.state = { [candidates[index].key]: candidates[index].value };
        break;
      }
    }
  }
}

// Text of a subtree with the text of each element apart (headings and paragraphs do not run together).
function visibleText(node) {
  const parts = [];
  walk(node, current => { if (!isElement(current) && String(current.x ?? '').trim()) parts.push(String(current.x).trim()); });
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function splitId(id) { const index = id.indexOf('|'); return [id.slice(0, index), id.slice(index + 1)]; }

export function controlKey(control) { return control.id ? '#' + control.id : control.name ? '[name=' + control.name + ']' : control.node.t + '@' + control.path.join('.'); }

export function currentRoute(snap, kind) {
  if (!snap) return '';
  if (kind === 'spa-path') return snap.path ?? '/';
  return decodeURIComponent(String(snap.hash ?? '').replace(/^#/, ''));
}

// ---- views from the crawl ------------------------------------------------------------------------------------------

export function viewsFromCrawl(session, crawl) {
  const { routes, states, renders, weak, readme } = crawl;
  const kind = session.kind;
  const modalContainer = isModalNode;
  // Mount per state from the renders of all routes in that state; the mount path must agree across states.
  const mountVotes = new Map();
  for (const state of states) {
    const bodies = routes.map(item => renders.get(state.key + '|' + item.route)?.body).filter(Boolean);
    const found = findMount(bodies, { modalContainer });
    if (found?.mount) { const key = JSON.stringify(found.mount); mountVotes.set(key, (mountVotes.get(key) ?? 0) + 1); }
    if (found?.ambiguous && state.key === 'S0') session.mountCandidates = found.candidates;
  }
  const mountPath = [...mountVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  let mount = mountPath ? JSON.parse(mountPath) : null;
  // Screens as fixed sections the router shows and hides (2.2): the parent of the sections is the mount, whatever the votes
  // above say (every section that changes its content is a "candidate" there); each screen is its visible section.
  const s0Bodies = routes.map(item => renders.get('S0|' + item.route)?.body).filter(Boolean);
  const sections = toggledSections(s0Bodies, { modalContainer });
  if (sections) { mount = sections.parent; session.mountCandidates = null; }
  // mapping.shell.mount: the element the caller names (a section of the switched ones means their parent)
  const asked = session.mapping.shell?.mount;
  if (asked && s0Bodies.length) {
    const body = renders.get('S0|')?.body ?? s0Bodies[0];
    const hit = elementsWithPath(body).find(item => matchesSelector(item.node, asked, item.path.length ? nodeAtPath(body, item.path.slice(0, -1)) : null));
    if (hit) {
      const inSections = sections && hit.path.length === sections.parent.length + 1 && hit.path.slice(0, -1).join('.') === sections.parent.join('.');
      if (!inSections && !sections) mount = hit.path;
      session.mountCandidates = null;
    }
  }
  session.mountPath = mount;
  const sectionOf = body => sections ? sections.visible(body) : null;
  const mountOf = body => {
    if (!mount) return body;
    const parent = nodeAtPath(body, mount);
    const index = sections ? sectionOf(body) : null;
    return index != null ? parent?.c?.[index] ?? parent : parent;
  };
  const dataIds = new Set();
  for (const snap of renders.values()) walk(snap.body, node => { const id = isElement(node) ? attr(node, 'data-id') : null; if (id) dataIds.add(id); });
  const templates = new Map();   // template -> {template, routes: [route], order}
  for (const item of routes) {
    if (item.route === '') continue;
    const template = routeTemplate(item.route, dataIds);
    if (!templates.has(template)) templates.set(template, { template, routes: [], order: templates.size, sources: new Set() });
    templates.get(template).routes.push(item.route);
    for (const source of item.sources) templates.get(template).sources.add(source);
  }
  // With sections, a template the router sends elsewhere (an unknown route falls back to the default section, the hash is
  // rewritten) is no screen of its own, and two templates on the same section are one screen (the first one found).
  if (sections) {
    const bySection = new Map();
    for (const [template, info] of [...templates]) {
      const snaps = info.routes.map(route => ({ route, snap: renders.get('S0|' + route) })).filter(item => item.snap);
      const own = snaps.filter(({ route, snap }) => { const landed = currentRoute(snap, kind); return landed === route || landed === ''; });
      const index = own.length ? sectionOf(own[0].snap.body) : null;
      if (index == null) { templates.delete(template); continue; }
      info.routes = own.map(item => item.route).concat(info.routes.filter(route => !own.some(item => item.route === route)));
      info.section = index;
      if (!bySection.has(index)) bySection.set(index, []);
      bySection.get(index).push(template);
    }
    // the template a link, the README or the mapping names wins; else the first one found
    const named = template => ['href', 'readme', 'mapping'].some(source => templates.get(template).sources.has(source));
    for (const list of bySection.values()) {
      const keep = list.find(named) ?? list[0];
      for (const template of list) if (template !== keep) templates.delete(template);
    }
  }
  // Weak literals (route segments compared in code) that are the first segment of a longer template are not views.
  for (const route of weak) {
    const longer = [...templates.keys()].some(template => template !== route && template.startsWith(route + '/'));
    if (longer && templates.has(route) && [...templates.get(route).sources].every(source => source === 'literal-segment')) templates.delete(route);
  }
  // Fallback: a mount render identical for >= 2 templates in the same state.
  const fallback = new Map();   // stateKey -> Set(mountKey)
  for (const state of states) {
    const byKey = new Map();
    for (const [template, info] of templates) {
      for (const route of info.routes) {
        const snap = renders.get(state.key + '|' + route);
        if (!snap) continue;
        const key = renderKey(mountOf(snap.body)).replace(/\s+/g, ' ');
        if (!byKey.has(key)) byKey.set(key, new Set());
        byKey.get(key).add(template);
      }
    }
    fallback.set(state.key, new Set([...byKey.entries()].filter(([, set]) => set.size >= 2).map(([key]) => key)));
  }
  // A fallback render in one state is a fallback in every state (the same "not available" content).
  const fallbackAll = new Set([...fallback.values()].flatMap(set => [...set]));
  const isFallback = (state, route) => {
    const snap = renders.get(state.key + '|' + route);
    if (!snap) return true;
    return fallbackAll.has(renderKey(mountOf(snap.body)).replace(/\s+/g, ' '));
  };
  // Canonical state: S0 when the view is not fallback there; else the first state (dimension order, values in option
  // order) where it is not. mapping.states overrides.
  const orderedStates = [states[0], ...session.dims.flatMap(dim => (dim.values ?? []).map(value => states.find(state => state.key === stateKey({ [dim.key]: String(value) }))).filter(Boolean)), ...states.filter(state => state.mapping)];
  const uniqueStates = [...new Set(orderedStates)];
  const readmeByTemplate = new Map(readme.map(item => [routeTemplate(item.route, dataIds), item]));
  const views = [], problems = [];
  for (const [template, info] of templates) {
    const forced = Object.entries(session.mapping.states ?? {}).find(([key]) => key === template || key === slug(template));
    let canonicalState = null;
    if (forced) canonicalState = states.find(state => state.key === stateKey(forced[1]));
    else canonicalState = uniqueStates.find(state => info.routes.some(route => !isFallback(state, route)));
    if (!canonicalState) {
      // A template rendered only as fallback in every state: not a view (an error page), unless it was named.
      const named = readmeByTemplate.has(template) || (session.mapping.routes ?? []).some(route => routeTemplate(String(route).replace(/^#/, ''), dataIds) === template);
      if (named) problems.push({ code: 'PROTOTYPE_AMBIGUOUS', key: 'states', view: template, message: 'the view ' + template + ' renders only the fallback in every explored state', fallbackText: visibleText(mountOf(renders.get('S0|' + info.routes[0])?.body ?? {})).slice(0, 120) });
      continue;
    }
    views.push({ template, info, state: canonicalState });
  }
  // README order first, then discovery order.
  const readmeOrder = new Map(readme.map((item, index) => [routeTemplate(item.route, dataIds), index]));
  views.sort((a, b) => (readmeOrder.get(a.template) ?? 1e6) - (readmeOrder.get(b.template) ?? 1e6) || a.info.order - b.info.order);
  // Concrete canonical route of a template with {id}: the first link, in document order, in the first view that links
  // it in its canonical state.
  for (const view of views) {
    if (!view.template.includes('{id}')) { view.route = view.info.routes[0]; continue; }
    let concrete = null;
    for (const other of views) {
      if (other === view || other.template.includes('{id}')) continue;
      const snap = renders.get(other.state.key + '|' + other.info.routes[0]);
      const hrefs = snap ? hrefRoutes(snap.body, kind) : [];
      concrete = hrefs.find(route => routeTemplate(route, dataIds) === view.template && !isFallback(view.state, route) && renders.has(view.state.key + '|' + route));
      if (concrete) break;
    }
    view.route = concrete ?? view.info.routes.find(route => !isFallback(view.state, route)) ?? view.info.routes[0];
  }
  // Default view: the initial route's render, or the route whose render equals the initial one; mapping.default wins.
  const initial = renders.get('S0|');
  let defaultView = null;
  if (session.mapping.default) defaultView = views.find(view => view.template === session.mapping.default || slug(view.template) === slug(session.mapping.default));
  if (!defaultView && initial) defaultView = views.find(view => view.state.key === 'S0' && renders.get('S0|' + view.route) && renderKey(mountOf(renders.get('S0|' + view.route).body)) === renderKey(mountOf(initial.body)));
  // The empty hash falls to the router's default route: the section the initial render shows is that screen's, or the router
  // rewrote the hash to the default route.
  if (!defaultView && initial && sections) { const shown = sectionOf(initial.body); defaultView = views.find(view => view.info.section === shown) ?? null; }
  if (!defaultView && initial) { const landed = currentRoute(initial, kind); if (landed) defaultView = views.find(view => view.info.routes.includes(landed)) ?? null; }
  if (!defaultView && views.length && initial) {
    problems.push({ code: 'PROTOTYPE_AMBIGUOUS', key: 'default', message: 'no route renders the same as the start page (empty hash)', value: views[0].template });
  }
  // Names: mapping.screens > README table > PascalCase of the route without parameters.
  const taken = new Set();
  for (const view of views) {
    const key = view.template.replace(/^\//, '').replace(/\/\{id\}/g, '').replace(/\{id\}/g, '') || 'home';
    view.key = slug(key) || 'home';
    const fromMapping = session.mapping.screens?.[view.key] ?? session.mapping.screens?.[view.template];
    const fromReadme = readmeByTemplate.get(view.template)?.name;
    view.name = fromMapping ?? fromReadme ?? pascal(key);
    view.nameSource = fromMapping ? 'mapping' : fromReadme ? 'readme' : 'route';
    if (taken.has(view.name)) view.name = view.name + (views.indexOf(view) + 1);
    taken.add(view.name);
    view.params = view.template.includes('{id}') ? [{ name: 'Id', from: 'route', type: view.info.routes.every(route => /\/\d+$/.test(route)) ? 'Integer' : 'Text' }] : [];
    view.default = view === defaultView;
    view.render = renders.get(view.state.key + '|' + view.route);
    // a screen of fixed sections is its own section (the parent stays in the shell as the mount)
    if (sections) { const index = sectionOf(view.render?.body) ?? view.info.section; if (index != null) { view.sectionMount = mount.concat(index); view.sectionIndex = index; } }
  }
  return { views, problems, mount, mountOf, isFallback, fallback, templates, dataIds, sectionParent: sections ? mount : null };
}

// ---- multi-page, sections, state machine, static ------------------------------------------------------------------

export async function crawlPages(session, s0) {
  const pages = [session.entry];
  const queue = [session.entry];
  const renders = new Map([[session.entry, s0]]);
  const links = [];
  while (queue.length) {
    const page = queue.shift();
    const snap = renders.get(page);
    walk(snap.body, node => {
      if (!isElement(node) || node.t !== 'a') return;
      const href = attr(node, 'href');
      if (!href || /^(https?:|mailto:|tel:|#|javascript:)/i.test(href)) return;
      const target = new URL(href, 'http://prototype.ssam/' + page).pathname.replace(/^\//, '');
      if (!/\.html?$/i.test(target) || !session.htmlFiles.includes(target)) return;
      links.push({ from: page, to: target });
      if (!pages.includes(target) && pages.length < LIMITS.routes) { pages.push(target); queue.push(target); }
    });
    const missing = queue.filter(item => !renders.has(item));
    if (missing.length) {
      const results = await session.run(missing.map(item => ({ key: 'p|' + item, page: item, steps: [{ do: 'inspect', tag: item }] })));
      for (const item of missing) { const snap = results.get('p|' + item)?.snaps?.[0]; if (snap) renders.set(item, snap); else queue.splice(queue.indexOf(item), 1); }
    }
  }
  return { pages, renders, links };
}

export function sectionTargets(body) {
  // Targets of in-page anchors or tab controls that are siblings of one parent with one visible at a time.
  const ids = new Map();
  for (const { node } of elementsWithPath(body)) { const id = attr(node, 'id'); if (id) ids.set(id, node); }
  const parents = new Map();
  const consider = (target, via) => {
    let parent = null;
    walk(body, node => { if (parent) return false; if ((node.c ?? []).includes(target)) parent = node; });
    if (!parent) return;
    if (!parents.has(parent)) parents.set(parent, []);
    if (!parents.get(parent).some(item => item.node === target)) parents.get(parent).push({ node: target, via });
  };
  walk(body, node => {
    if (!isElement(node)) return;
    const href = node.t === 'a' ? attr(node, 'href') : null;
    if (href && href.startsWith('#') && ids.has(decodeURIComponent(href.slice(1)))) consider(ids.get(decodeURIComponent(href.slice(1))), { kind: 'href', value: href.slice(1) });
    const controls = attr(node, 'aria-controls');
    if (controls && attr(node, 'role') === 'tab' && ids.has(controls)) consider(ids.get(controls), { kind: 'tab', value: controls });
    for (const name of ['data-view', 'data-page', 'data-screen']) {
      const value = attr(node, name);
      if (value && ids.has(value)) consider(ids.get(value), { kind: name, value });
    }
  });
  // data-view on the sections themselves (controls carry the same value).
  for (const [parent, items] of parents) {
    const visible = items.filter(item => !item.node.h);
    if (items.length >= 2 && visible.length === 1) return { parent, items };
  }
  return null;
}

export function skeleton(node, depth = 2) {
  if (!isElement(node)) return '';
  const kids = (node.c ?? []).filter(isElement);
  const parts = [];
  let previous = null;
  for (const child of kids) {
    const own = child.t + '.' + classes(child).join('.');
    const key = depth > 1 ? own + '(' + skeleton(child, depth - 1) + ')' : own;
    if (key !== previous) parts.push(key);
    previous = key;
  }
  return parts.join(',');
}

// The skeleton of a page without its modal containers: opening a dialog is a modal (2.4), never a view (2.2 spa-state). A
// transient notice is out too (a toast a click shows, never hidden again because its timer does not run here: VisitaCerta
// 2026-10-12 got a second "Locais salvos" for the toast "Local removido"): a toast/snackbar by name, or a live region.
const isModalContainer = isModalNode;
export function isTransientNotice(node) {
  if (!isElement(node)) return false;
  if (attr(node, 'aria-live') != null && attr(node, 'aria-live') !== 'off') return true;
  return /(^|[\s_-])(toast|toaster|snackbar)([\s_-]|$)/i.test(String(attr(node, 'class') ?? '') + ' ' + String(attr(node, 'id') ?? ''));
}
function withoutModals(node) {
  if (!isElement(node)) return node;
  return { ...node, c: (node.c ?? []).filter(child => !isModalContainer(child) && !isTransientNotice(child)).map(withoutModals) };
}
export function pageSkeleton(body, depth = 4) { return skeleton(withoutModals(body), depth); }

// ---- every kind -> views with how to reach them ---------------------------------------------------------------------

function viewBase(view) {
  return { params: [], default: false, nameSource: 'route', ...view };
}

// Clickable elements of S0 for the spa-state test (no URL change, skeleton of the app root changes).
function stateTriggers(body) {
  const out = [];
  for (const { node, path } of elementsWithPath(body)) {
    if (node.h || ['input', 'select', 'textarea', 'option', 'label', 'form'].includes(node.t)) continue;
    const href = node.t === 'a' ? attr(node, 'href') : null;
    const clickable = node.t === 'button' || (node.t === 'a' && (!href || href === '#' || href.startsWith('javascript:'))) || attr(node, 'data-action') != null || attr(node, 'onclick') != null || attr(node, 'role') === 'button' || (node.L ?? []).includes('click');
    if (clickable) out.push({ node, path });
  }
  return out;
}

// ---- screen switches (2.2 spa-state without classes) ------------------------------------------------------------------
// A React prototype styled inline has no classes, so the skeleton of four levels never sees its screen change: the screen
// is five levels down (stage > scale > phone > screen). A switch is a parameterless trigger whose click changes the deep
// skeleton of the page (every level, modal containers and overlays out) and in whose result a trigger of the same tag under
// a parent of the same shape (the other tab of the same tab bar) brings the page back to where it was. A click that only adds
// a toast or writes data has no way back and is no switch.

export function deepSkeleton(body) { return skeleton(withoutModals(body), 64); }

function parentSignature(body, path) {
  const parent = nodeAtPath(body, path.slice(0, -1));
  return isElement(parent) ? parent.t + '|' + skeleton(parent, 1) + '|' + (parent.c ?? []).filter(isElement).length : '';
}

// The words of an element, its text nodes joined by a space ("Bater ponto Saída almoço"), never glued together.
export function ownText(node) {
  const parts = [];
  walk(node, current => { if (!isElement(current) && String(current.x ?? '').trim()) parts.push(String(current.x).trim()); });
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

async function screenSwitches(session, s0, candidates, probes, results) {
  const base = deepSkeleton(s0.body);
  const moved = [];
  probes.forEach((probe, index) => {
    const snap = results.get(probe.key)?.snaps?.[0];
    if (!snap || snap.url !== s0.url || deepSkeleton(snap.body) === base) return;
    moved.push({ item: candidates[index], snap, steps: probe.steps.filter(step => step.do !== 'snap'), parent: parentSignature(s0.body, candidates[index].path) });
  });
  if (!moved.length) return null;
  const back = [];
  moved.forEach((entry, m) => {
    stateTriggers(entry.snap.body).forEach((other, r) => {
      if (other.node.t !== entry.item.node.t || parentSignature(entry.snap.body, other.path) !== entry.parent) return;
      back.push({ key: 'sw|' + String(m).padStart(3, '0') + '|' + String(r).padStart(3, '0'), prefix: entry.steps, steps: [{ do: 'click', target: targetFor(entry.snap.body, other.node) ?? { path: other.path } }, { do: 'snap', tag: 'back' }], m, other });
    });
  });
  const answers = back.length ? await session.run(back.map(({ key, prefix, steps }) => ({ key, prefix, steps }))) : new Map();
  const switches = [];
  for (const probe of back) {
    const snap = answers.get(probe.key)?.snaps?.[0];
    if (!snap || snap.url !== s0.url || deepSkeleton(snap.body) !== base) continue;
    const entry = moved[probe.m];
    if (!switches.some(item => item.entry === entry)) switches.push({ entry, back: probe.other.node, parent: entry.parent });
  }
  return switches.length ? switches : null;
}

// The views of a prototype of screen switches: breadth-first over the switch-like triggers only (same tag, parent of the
// shape of a known switch), every new deep skeleton a view named by the text of the trigger that shows it; the first view by
// the trigger that brings it back. The mount is the element whose content differs between the views (deepenMount).
async function switchViews(session, s0) {
  const switches = session.switches;
  const parents = new Set(switches.map(item => item.parent));
  const tags = new Set(switches.map(item => item.entry.item.node.t));
  const base = deepSkeleton(s0.body);
  const seen = new Map([[base, { steps: [], snap: s0, label: ownText(switches[0].back) }]]);
  let frontier = [...seen.values()];
  for (let depth = 0; depth < LIMITS.depth && frontier.length; depth++) {
    const probes = [];
    for (const [index, state] of frontier.entries()) {
      for (const [triggerIndex, item] of stateTriggers(state.snap.body).entries()) {
        if (!tags.has(item.node.t) || !parents.has(parentSignature(state.snap.body, item.path))) continue;
        probes.push({ key: 'sv|' + depth + '|' + String(index).padStart(3, '0') + '|' + String(triggerIndex).padStart(3, '0'), prefix: state.steps,
          steps: [{ do: 'click', target: targetFor(state.snap.body, item.node) ?? { path: item.path } }, { do: 'snap', tag: 'after' }], via: item });
      }
    }
    const results = probes.length ? await session.run(probes.map(({ key, prefix, steps }) => ({ key, prefix, steps }))) : new Map();
    const next = [];
    for (const probe of probes) {
      const snap = results.get(probe.key)?.snaps?.[0];
      if (!snap || snap.url !== s0.url) continue;
      const key = deepSkeleton(snap.body);
      if (seen.has(key) || seen.size >= LIMITS.routes) continue;
      const entry = { steps: probe.prefix.concat(probe.steps.filter(step => step.do !== 'snap')), snap, label: ownText(probe.via.node), trigger: probe.via.node };
      seen.set(key, entry);
      next.push(entry);
    }
    frontier = next;
  }
  return viewsOfStates([...seen.values()]);
}

// mapping.states of a prototype without routes: {"<view>": {"click": "<words of the trigger or a CSS selector>"}} names a
// view reached from the first page by one click (what a refusal asks for when a click rewrites the screen with no way back).
export function mappedClicks(mapping) {
  return Object.entries(mapping?.states ?? {}).filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value) && typeof value.click === 'string' && value.click.trim());
}
const fold = text => String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
// The target of a click named by words or by a selector: the clickable element whose own words (or title, aria-label) are
// exactly those words, else the selector as written.
export function clickTarget(body, wanted) {
  const words = fold(wanted);
  const hit = stateTriggers(body).find(({ node }) => fold(ownText(node)) === words || fold(attr(node, 'title')) === words || fold(attr(node, 'aria-label')) === words);
  if (hit) return targetFor(body, hit.node) ?? { path: hit.path };
  return { sel: wanted };
}
async function mappedViews(session, s0, clicks) {
  const probes = clicks.map(([viewKey, value], index) => ({ key: 'mv|' + String(index).padStart(3, '0'), steps: [{ do: 'click', target: clickTarget(s0.body, value.click) }, { do: 'snap', tag: 'after' }], viewKey }));
  const results = await session.run(probes.map(({ key, steps }) => ({ key, steps })));
  const entries = [{ steps: [], snap: s0, label: firstHeading(s0.body) || 'inicio' }];
  const problems = [];
  const base = deepSkeleton(s0.body);
  for (const probe of probes) {
    const snap = results.get(probe.key)?.snaps?.[0];
    if (!snap || snap.url !== s0.url || deepSkeleton(snap.body) === base) { problems.push({ key: 'mappedClick', view: probe.viewKey, message: 'mapping.states.' + probe.viewKey + ': the click on ' + JSON.stringify(clicks.find(([key]) => key === probe.viewKey)[1].click) + ' did not change the screen (no such element, or nothing changed)' }); continue; }
    entries.push({ steps: probe.steps.filter(step => step.do !== 'snap'), snap, label: probe.viewKey, key: probe.viewKey });
  }
  return { ...viewsOfStates(entries), problems };
}

// The views of a set of rendered states (screen switches or mapped clicks): names, keys, the mount and how a page is told
// apart (the deep skeleton of what is at the mount).
function viewsOfStates(states) {
  const taken = new Set();
  const views = states.map((entry, index) => {
    const label = entry.label || firstHeading(entry.snap.body) || (index === 0 ? 'start' : 'screen ' + (index + 1));
    let name = pascal(label) || 'View' + (index + 1);
    while (taken.has(name)) name += String(index + 1);
    taken.add(name);
    return viewBase({ key: entry.key ?? (slug(label) || 'view-' + (index + 1)), template: entry.key ?? slug(label), route: null, name, nameSource: entry.key ? 'mapping' : 'trigger', state: { key: 'S0', assign: {} }, render: entry.snap, reach: { prefix: entry.steps }, default: index === 0, steps: entry.steps });
  });
  const keys = new Set();
  for (const view of views) { let key = view.key; let n = 2; while (keys.has(key)) key = view.key + '-' + n++; view.key = key; keys.add(key); }
  const found = findMount(views.map(view => view.render.body), { modalContainer: isModalNode });
  const mount = found?.mount ? deepenMount(views.map(view => view.render.body), found.mount) : found?.mount ?? null;
  for (const view of views) view.mountPath = mount ?? [];
  // the view of a page: the deep skeleton of what is at the mount (a toast or an overlay outside or inside it is no view)
  const signatureAt = body => deepSkeleton(nodeAtPath(body, mount ?? []) ?? body);
  const signatures = new Map(views.map(view => [signatureAt(view.render.body), view]));
  return { kind: 'spa-state', views, problems: [], states: [{ key: 'S0', assign: {} }], mount, renderOf: () => null, switches: true,
    viewOf: snap => signatures.get(signatureAt(snap.body)) ?? null };
}

function firstHeading(node) {
  let found = null;
  walk(node, current => { if (found) return false; if (isElement(current) && /^h[12]$/.test(current.t)) found = textOf(current).trim(); });
  return found;
}

export async function discoverViews(session, decided) {
  const s0 = session.s0;
  let kind = decided?.kind ?? null;
  // views named by mapping.states clicks (a prototype without routes whose screens a refusal had to name)
  if (!kind && mappedClicks(session.mapping).length) { session.kind = 'spa-state'; session.switches = 'mapping'; return mappedViews(session, s0, mappedClicks(session.mapping)); }
  if (!kind) {
    // spa-state: some click changes the skeleton of the page without changing the URL.
    const candidates = stateTriggers(s0.body).slice(0, 40);
    const probes = candidates.map((item, index) => ({ key: 'st|' + String(index).padStart(3, '0'), steps: [{ do: 'click', target: { path: item.path } }, { do: 'snap', tag: 'after' }] }));
    const results = probes.length ? await session.run(probes) : new Map();
    const base = pageSkeleton(s0.body);
    const changed = probes.some(probe => { const snap = results.get(probe.key)?.snaps?.[0]; return snap && snap.url === s0.url && pageSkeleton(snap.body) !== base; });
    kind = changed ? 'spa-state' : 'static';
    // the skeleton of four levels saw nothing: a screen switched deeper (a React frame of classless divs)
    if (!changed) {
      session.switches = await screenSwitches(session, s0, candidates, probes, results);
      if (session.switches) kind = 'spa-state';
    }
  }
  session.kind = kind;
  if (kind === 'spa-state' && session.switches) return switchViews(session, s0);
  if (kind === 'spa-hash' || kind === 'spa-path') {
    const crawl = await crawlRoutes(session, s0);
    const found = viewsFromCrawl(session, crawl);
    for (const view of found.views) {
      view.reach = { prefix: [...session.stateSteps(view.state), { do: 'nav', route: view.route }] };
      view.mountPath = view.sectionMount ?? found.mount;
    }
    return { kind, views: found.views, problems: found.problems, crawl, mount: found.mount, mountOf: found.mountOf, isFallback: found.isFallback, fallback: found.fallback, templates: found.templates, dataIds: found.dataIds, renderOf: (state, route) => crawl.renders.get(state.key + '|' + route), states: crawl.states,
      ...(found.sectionParent ? { sectionParent: found.sectionParent } : {}) };
  }
  if (kind === 'multi-page') {
    const pages = await crawlPages(session, s0);
    const readme = session.readme ? readmeRoutes(session.readme, session.entry) : [];
    const views = pages.pages.map((page, index) => viewBase({
      key: slug(page.replace(/\.html?$/i, '').split('/').pop()) || 'index', template: page, route: page,
      name: pascal(page.replace(/\.html?$/i, '').split('/').pop()), state: { key: 'S0', assign: {} },
      render: pages.renders.get(page), reach: { page, prefix: [] }, default: index === 0, page
    }));
    for (const view of views) { const named = readme.find(item => item.route === view.page); if (named) { view.name = named.name; view.nameSource = 'readme'; } }
    return { kind, views, problems: [], pages, states: [{ key: 'S0', assign: {} }], renderOf: (state, route) => pages.renders.get(route) };
  }
  if (kind === 'spa-sections') {
    const sections = decided.sections ?? sectionTargets(s0.body);
    const parentPath = elementsWithPath(s0.body).find(item => item.node === sections.parent)?.path ?? [];
    const views = [];
    const probes = [];
    for (const item of sections.items) {
      const id = attr(item.node, 'id');
      const key = slug(item.via.value || id || '') || 'section';
      const control = elementsWithPath(s0.body).find(({ node }) => (node.t === 'a' && attr(node, 'href') === '#' + id) || attr(node, 'aria-controls') === id || (item.via.kind.startsWith('data-') && attr(node, item.via.kind) === item.via.value && node !== item.node));
      const reach = !item.node.h ? [] : control ? [{ do: 'click', target: targetFor(s0.body, control.node) ?? { path: control.path } }] : [{ do: 'nav', route: id }];
      views.push(viewBase({ key, template: key, route: id, name: pascal(key), state: { key: 'S0', assign: {} }, reach: { prefix: reach }, sectionId: id, default: !item.node.h }));
      probes.push({ key: 'sec|' + key, prefix: reach, steps: [{ do: 'snap', tag: key }] });
    }
    const results = await session.run(probes);
    for (const view of views) {
      view.render = results.get('sec|' + view.key)?.snaps?.[0] ?? s0;
      const sectionPath = elementsWithPath(view.render.body).find(({ node }) => attr(node, 'id') === view.sectionId)?.path;
      view.mountPath = sectionPath ?? parentPath;
    }
    if (!views.some(view => view.default) && views.length) views[0].default = true;
    return { kind, views, problems: [], states: [{ key: 'S0', assign: {} }], sections, sectionParent: parentPath, mount: parentPath.length >= 1 ? parentPath : null, renderOf: (state, route) => views.find(view => view.route === route)?.render };
  }
  if (kind === 'spa-state') {
    // Breadth-first over click sequences from S0 (depth <= 4): every distinct skeleton of the page is a view.
    const seen = new Map([[pageSkeleton(s0.body), { steps: [], snap: s0 }]]);
    let frontier = [{ steps: [], snap: s0 }];
    for (let depth = 0; depth < LIMITS.depth && frontier.length; depth++) {
      const probes = [];
      for (const [index, state] of frontier.entries()) {
        for (const [triggerIndex, item] of stateTriggers(state.snap.body).slice(0, 40).entries()) {
          probes.push({ key: 'ss|' + depth + '|' + String(index).padStart(3, '0') + '|' + String(triggerIndex).padStart(3, '0'), prefix: state.steps, steps: [{ do: 'click', target: targetFor(state.snap.body, item.node) ?? { path: item.path } }, { do: 'snap', tag: 'after' }], via: { state, item } });
        }
      }
      const results = probes.length ? await session.run(probes) : new Map();
      const next = [];
      for (const probe of probes) {
        const snap = results.get(probe.key)?.snaps?.[0];
        if (!snap || snap.url !== s0.url) continue;
        const key = pageSkeleton(snap.body);
        if (seen.has(key) || seen.size >= LIMITS.routes) continue;
        const entry = { steps: probe.prefix.concat(probe.steps.filter(step => step.do !== 'snap')), snap, trigger: probe.via.item.node };
        seen.set(key, entry);
        next.push(entry);
      }
      frontier = next;
    }
    const taken = new Set();
    const views = [...seen.values()].map((entry, index) => {
      const heading = firstHeading(entry.snap.body);
      const label = heading || (entry.trigger ? textOf(entry.trigger).trim() : '') || 'inicio';
      let name = pascal(label) || 'View' + (index + 1);
      while (taken.has(name)) name += String(index + 1);
      taken.add(name);
      return viewBase({ key: slug(label) || 'view-' + (index + 1), template: slug(label), route: null, name, nameSource: heading ? 'heading' : 'trigger', state: { key: 'S0', assign: {} }, render: entry.snap, reach: { prefix: entry.steps }, default: index === 0, steps: entry.steps });
    });
    const keys = new Set();
    for (const view of views) { let key = view.key; let n = 2; while (keys.has(key)) key = view.key + '-' + n++; view.key = key; keys.add(key); }
    const bodies = views.map(view => view.render.body);
    const mount = findMount(bodies, { modalContainer: node => node.t === 'dialog' || attr(node, 'role') === 'dialog' });
    // the screen is what still differs under the mount while the frame around it is the same (VisitaCerta 2026-10-12: the app
    // root holds a sidebar that only moves its active item and the <main> whose page changes): the sidebar is shell
    const mountPath = mount?.mount && views.length > 1 ? deepenMount(bodies, mount.mount) : mount?.mount;
    for (const view of views) view.mountPath = mountPath ?? [];
    return { kind, views, problems: [], states: [{ key: 'S0', assign: {} }], mount: mountPath, renderOf: () => null };
  }
  // static: one view, the whole page.
  const key = slug(session.entry.replace(/\.html?$/i, '').split('/').pop()) || 'index';
  return { kind: 'static', views: [viewBase({ key, template: key, route: null, name: pascal(key), state: { key: 'S0', assign: {} }, render: s0, reach: { prefix: [] }, default: true, mountPath: [] })], problems: [], states: [{ key: 'S0', assign: {} }], renderOf: () => s0 };
}

export { alignSequences, sha256 };
