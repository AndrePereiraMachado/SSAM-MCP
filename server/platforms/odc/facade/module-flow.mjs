// The flow reading (ssam-flow/1): every action of a module as text that is also its source form, one action per answer:
// ssam_map {view:"flow", element} and ssam map --flow [--element X] (module-map.mjs resolves the target and the store and
// calls flowAnswer there). The text is written by the lane's kernel reader (C# ModuleFlow, request {"flow":"ensure"}) beside
// the module index and the digest:
//   <SSAM_MODULE_INDEX_ROOT | <workspace>\.local\module-index>\v1\<lane>\<sha256>.kernel.flow.json
// and read here without .NET: served only when schema, extractor, lane, adapter and the sha256 of the bytes read now match.
// Each action carries its fixed point (read -> print -> parse gives the same model and the same text, proven when the file
// was built) and its id table (the text's @n/@p/@l ids -> model keys), kept in the store and returned on request.
// The reading is by element (one action, or a list of them in one answer), never the whole module; without element the
// answer lists the actions. Each action carries its textSha: the basedOn of the edited text sent back in a job as
// {"op":"logic","data":{"flow": text, "basedOn": textSha}} (kernel Verbs.Flow.cs, stage LG2).
import crypto from 'node:crypto';
import fs from 'node:fs';

export const FLOW_SCHEMA = 'ssam-flow/1';
// ModuleFlow.Extractor (C#): a stored flow of another version is a miss.
export const FLOW_EXTRACTOR = 9;
export const FLOW_ADAPTER = 'kernel';
export const FLOW_PAGE_SCHEMA = 'ssam-flow-page/1';
export const FLOW_INDEX_SCHEMA = 'ssam-flow-index/1';

const str = v => typeof v === 'string';
// ModuleFlow.TextSha (C#): 16 hex of the sha256 of the text.
export const textSha = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
// The most actions one flow answer reads by a list of elements.
export const MAX_FLOW_ELEMENTS = 50;
// The read of one action, kept beside the flow reading when an answer serves it (C# FlowReading, the file
// <sha256>.kernel.flow-<textSha>.json that ModuleIndexStore.LoadFlowReading finds by textSha): an edit of that read
// (basedOn = its textSha) that arrives after the action changed is merged three ways with it (kernel FlowMerge).
export const FLOW_READING_SCHEMA = 'ssam-flow-reading/1';
export const flowReadingOf = (action, lane, sha256) => ({ schema: FLOW_READING_SCHEMA, extractor: FLOW_EXTRACTOR, lane, adapter: FLOW_ADAPTER,
  sourceSha256: sha256.toLowerCase(), action: { key: action.key, kind: action.kind, name: action.name }, textSha: textSha(action.text), text: action.text, ids: action.ids });
// The checks of ModuleFlow.Parse.
export function wellFormedFlow(f, lane) {
  if (!f || f.schema !== FLOW_SCHEMA || f.extractor !== FLOW_EXTRACTOR || f.lane !== lane || f.adapter !== FLOW_ADAPTER || !str(f.sourceSha256)
    || !f.module || !str(f.module.name) || !str(f.module.key) || !f.notWritten || typeof f.notWritten !== 'object' || !Array.isArray(f.actions)) return false;
  return f.actions.every(a => a && str(a.key) && str(a.kind) && str(a.name) && str(a.text) && typeof a.fixedPoint === 'boolean'
    && Number.isInteger(a.nodes) && Number.isInteger(a.digestBytes) && a.ids && typeof a.ids === 'object' && Array.isArray(a.problems) && a.problems.every(str));
}

// S10 (24/10/2026): the reading of some actions only (C# ModuleFlow.BuildSelected, request {"flowElements":[...]}), served
// while the capture has no stored flow: the requested actions built as Build builds them (same text, ids and textSha), the
// others not built, every action named in catalog (key, kind, name). Never written as the module's flow file; answers that
// serve it say partial:true and what was not built.
export const FLOW_SELECTION_SCHEMA = 'ssam-flow-selection/1';
export function validFlowSelection(f, lane, sha256, elements) {
  if (f?.schema !== FLOW_SELECTION_SCHEMA || f.partial !== true || !wellFormedFlow({ ...f, schema: FLOW_SCHEMA }, lane)) return false;
  const s = f.scope, catalog = f.catalog;
  if (f.sourceSha256.toLowerCase() !== sha256.toLowerCase() || s?.completeModule !== false || !Array.isArray(catalog)
    || s.availableActions !== catalog.length || s.builtActions !== f.actions.length || JSON.stringify(s.requested) !== JSON.stringify(elements)) return false;
  const keys = new Map(catalog.map(a => [a?.key, a]));
  return catalog.every(a => str(a?.key) && str(a.kind) && str(a.name)) && keys.size === catalog.length
    && new Set(f.actions.map(a => a.key)).size === f.actions.length
    && f.actions.every(a => keys.get(a.key)?.kind === a.kind && keys.get(a.key)?.name === a.name);
}
// The flow a selection serves when every element names, among ALL the actions of the capture (its catalog, by the same
// findActions), one action that was built; else null (the caller builds the whole flow, and a miss or an ambiguity is
// answered from it exactly as before).
export function selectionFlow(selection, elements) {
  const built = new Set(selection.actions.map(a => a.key));
  for (const element of elements) {
    const { matches } = findActions({ actions: selection.catalog }, element);
    if (matches.length !== 1 || !built.has(matches[0].key)) return null;
  }
  return selection;
}

// The last two parsed flows; the file is content-addressed, the stamp only tells a rewritten file from the parsed one.
const parsed = new Map();
export function loadFlow(file, lane, sha256) {
  let stat; try { stat = fs.statSync(file); } catch { return null; }
  const stamp = stat.size + ':' + stat.mtimeMs + ':' + stat.ino;
  let flow = parsed.get(file)?.stamp === stamp ? parsed.get(file).flow : null;
  if (!flow) {
    try { flow = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; }
    if (!wellFormedFlow(flow, lane)) return null;
    parsed.delete(file); parsed.set(file, { stamp, flow });
    while (parsed.size > 2) parsed.delete(parsed.keys().next().value);
  }
  return flow.sourceSha256.toLowerCase() === sha256.toLowerCase() ? { flow, stamp } : null;
}

// The actions an element names: @key or key, the full name (Flow/Screen/Action or Action), the header's Owner.Action
// (Screen.Action, Flow/Screen.Action), else the last segment of the name; case-insensitive when nothing matches exactly.
// {matches, by}.
export function findActions(flow, element) {
  const text = element.trim();
  const key = text.startsWith('@') ? text.slice(1) : text;
  const byKey = flow.actions.filter(a => a.key === key);
  if (byKey.length || text.startsWith('@')) return { matches: byKey, by: 'key' };
  const fold = s => s.toLowerCase();
  // Owner.Action as the header writes it: the name ends in /Owner/Action (Owner may be a Flow/Screen path).
  const dot = text.lastIndexOf('.');
  const owned = dot > 0 && !text.startsWith('(') ? '/' + text.slice(0, dot) + '/' + text.slice(dot + 1) : null;
  const ends = (a, tail) => ('/' + a.name).endsWith(tail);
  for (const [by, test] of [['name', a => a.name === text], ['name', a => fold(a.name) === fold(text)],
    ...(owned ? [['owner', a => ends(a, owned)], ['owner', a => ('/' + fold(a.name)).endsWith(fold(owned))]] : []),
    ['last segment', a => a.name.slice(a.name.lastIndexOf('/') + 1) === text], ['last segment', a => fold(a.name.slice(a.name.lastIndexOf('/') + 1)) === fold(text)]]) {
    const matches = flow.actions.filter(test);
    if (matches.length) return { matches, by };
  }
  return { matches: [], by: null };
}

// Names that contain the element (the candidates of a miss), at most max.
export function similarActions(flow, element, max = 20) {
  const want = element.replace(/^@/, '').toLowerCase().replace(/^.*\//, '');
  return flow.actions.filter(a => a.name.toLowerCase().includes(want)).slice(0, max);
}

const jsonBytes = text => Buffer.byteLength(JSON.stringify(text), 'utf8') - 2;

// The text of one action in pages of at most room JSON bytes, cut between lines; a line longer than a page is cut at
// characters, each piece saying where it goes on. Nothing is dropped; the same text and room always give the same pages.
// The smallest room for the text of a page: a line longer than the room is cut with its continuation markers (about 90
// bytes), so a smaller room could not carry a part of it.
export const FLOW_PAGE_MIN = 256;
export function flowPages(text, room) {
  if (room < FLOW_PAGE_MIN) throw new Error('budgetBytes leaves no room for a page of the action text');
  if (jsonBytes(text) <= room) return [text];
  const pages = [[]]; let used = 0;
  const push = line => { pages.at(-1).push(line); used += jsonBytes(line + '\n'); };
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  for (const line of lines) {
    if (used > 0 && used + jsonBytes(line + '\n') > room) { pages.push([]); used = 0; }
    if (jsonBytes(line + '\n') <= room - used) { push(line); continue; }
    let rest = line, prefix = '';
    while (rest.length) {
      const marker = ' …(this line continues on page ' + (pages.length + 1) + ')';
      if (jsonBytes(prefix + rest + '\n') <= room - used) { push(prefix + rest); break; }
      let lo = 1, hi = rest.length;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (jsonBytes(prefix + rest.slice(0, mid) + marker + '\n') <= room - used) lo = mid; else hi = mid - 1; }
      let n = lo;
      if (n < rest.length && /[\uD800-\uDBFF]/.test(rest[n - 1])) n = n > 1 ? n - 1 : n + 1;
      push(prefix + rest.slice(0, n) + marker);
      rest = rest.slice(n);
      pages.push([]); used = 0;
      prefix = '…(line continued from page ' + (pages.length - 1) + ') ';
    }
  }
  return pages.map(p => p.join('\n') + '\n');
}

export const FLOW_NOTE = 'One action as ssam-flow/1, whole: every node, parameter and local ends in its id (@n nodes, @p parameters, @l locals; '
  + 'the header names the action\'s model key, and a screen, block or data action its owner: action Home.Save), descriptions are /// lines above their element, texts continue on "| " lines, properties '
  + 'without a word of their own go on @{...} lines, and every branch ends in end, raise, navigate, next, "-> @id" or "-> (no connector)". '
  + 'fixedPoint:true means the text parses back to this exact action. To change it, send the edited text in a job: '
  + '{"op":"logic","data":{"flow":<text>,"basedOn":<textSha>}} (several actions: "flow":[{"text","basedOn"},...]). A line keeps the element of its @id, '
  + 'a line without @id is new, a removed line is removed, a parameter or local renamed on its @id is renamed; only what changed is written and the '
  + 'action must read back as the text. A header without @key creates the action: server, service or client action Name; action Owner.Name and data action Owner.Name under that screen or block.';
