// R1: Addresses select owned trailing ids (ambiguous ids need #occurrence), or one exact trimmed line.
// R2: Column-zero replacement/insertion text inherits the addressed line's indentation on its first line; the lines after it are relative
// to it, or kept as given when their least indentation is one level (2 spaces) under the addressed line (written as the action has them).
// {find, with}: the exact text of the read, once there (C-18); an item edits by finds or by lines, not both.
// R3: Replace keeps the addressed id; deeper replacement lines replace its block, otherwise children remain.
// R4: Delete removes the line, its block and adjacent same-indent /// descriptions; never the action header.
// R5: After inserts after the block, or first inside it when deeper; before precedes descriptions. Inserts preserve order.
// R6: Every address refers to the original read. All invalid forms, overlaps, new duplicate ids and dangling jumps are reported.
import fs from 'node:fs';
import path from 'node:path';
import { workspaceRoot } from './workspace.mjs';
import { STORE_GENERATION } from './store-generation.mjs';
import { FLOW_READING_SCHEMA, FLOW_EXTRACTOR, textSha } from './module-flow.mjs';
import { headerOf, canonicalPart } from './ssam-code.mjs';
import { readingEditsShape, isReadingBase, isJobTextBase } from './html-edits.mjs';

export function loadFlowReading(lane, sha, { env = process.env } = {}) {
  if (typeof sha !== 'string' || !/^[a-f\d]{16}$/i.test(sha)) return null;
  sha = sha.toLowerCase();
  const root = env.SSAM_MODULE_INDEX_ROOT ? path.resolve(env.SSAM_MODULE_INDEX_ROOT) : path.join(workspaceRoot, '.local', 'module-index');
  try {
    const dir = path.join(root, STORE_GENERATION, lane);
    const files = fs.readdirSync(dir).filter(n => n.endsWith(`.kernel.flow-${sha}.json`))
      .map(n => { const file = path.join(dir, n); return { file, time: fs.statSync(file).mtimeMs }; }).sort((a, b) => b.time - a.time);
    for (const { file } of files) {
      try {
        const r = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (r.schema === FLOW_READING_SCHEMA && r.extractor === FLOW_EXTRACTOR && r.lane === lane && r.adapter === 'kernel'
          && typeof r.text === 'string' && r.textSha === sha && textSha(r.text) === sha) return r;
      } catch { /* A damaged reading does not hide an older valid reading. */ }
    }
  } catch { /* A missing/unreadable index is a cache miss. */ }
  return null;
}

const indent = s => s.match(/^[ \t]*/)[0].length;
const ownId = s => {
  if (/^(?:->|\||\/\/\/)/.test(s.trimStart())) return null;
  const token = s.trimEnd().match(/(?:^|\s)(@[^\s]+)$/)?.[1];
  return token && (/^@[npl]\d+$/.test(token) || /^\s*(?:server action|service action|client action|data action|action|preparation)\s/.test(s)) ? token : null;
};
const lineText = v => typeof v === 'string' ? v.replace(/\r\n/g, '\n') : Array.isArray(v) && v.every(s => typeof s === 'string') ? v.join('\n').replace(/\r\n/g, '\n') : null;

export function applyFlowEdits(readText, edits) {
  const newline = readText.includes('\r\n') ? '\r\n' : '\n';
  const ls = readText.replace(/\r\n/g, '\n').split('\n');
  const ids = new Map();
  ls.forEach((s, i) => { const id = ownId(s); if (id) ids.set(id, [...(ids.get(id) ?? []), i]); });
  const problems = [], plans = [];
  const evidence = indices => [...new Set(indices)].sort((a,b) => a-b).filter(i => i >= 0 && i < ls.length).map(i => ({ line: i + 1, text: ls[i] }));
  const context = (start, end = start + 1) => evidence(Array.from({ length: end - start + 4 }, (_, j) => start - 2 + j));
  const problem = (j, error, lines = []) => problems.push({ at: `edits/${j}`, error, lines });
  const blockEnd = i => { let end = i + 1; while (end < ls.length && !(end === ls.length - 1 && ls[end] === '') && (ls[end].trim() === '' || indent(ls[end]) > indent(ls[i]))) end++; return end; };
  const descStart = i => { let start = i; while (start > 0 && indent(ls[start - 1]) === indent(ls[i]) && ls[start - 1].trimStart().startsWith('///')) start--; return start; };
  if (!Array.isArray(edits) || !edits.length) problem(0, 'edits must be a nonempty list', context(0));
  // C-18 (F-FitBody-42): {find, with} over a read action, as over the text of a job: the exact text, once in the read.
  const finds = Array.isArray(edits) ? edits.filter(e => e && typeof e === 'object' && !Array.isArray(e) && Object.hasOwn(e, 'find')) : [];
  if (finds.length) return findEdits(readText, edits, finds.length === edits.length);
  const notes = [];
  for (const [j, edit] of (Array.isArray(edits) ? edits : []).entries()) {
    if (!edit || typeof edit !== 'object' || Array.isArray(edit)) { problem(j, 'an edit is an object', context(0)); continue; }
    const keys = Object.keys(edit), addresses = keys.filter(k => ['replace', 'delete', 'after', 'before'].includes(k));
    const unknown = keys.filter(k => !['replace', 'delete', 'after', 'before', 'with', 'insert'].includes(k));
    let invalid = false;
    if (addresses.length !== 1) { problem(j, 'exactly one address: replace, delete, after or before', context(0)); invalid = true; }
    if (unknown.length) { problem(j, `unknown edit key: ${unknown.join(', ')}`, context(0)); invalid = true; }
    // Resolve every supplied address even when its shape is invalid, to give the whole refusal at once.
    let index;
    for (const key of addresses) {
      const address = edit[key]; let candidates = [];
      if (typeof address !== 'string') { problem(j, `${key} address must be a string`, context(0)); invalid = true; continue; }
      if (address.startsWith('@')) {
        const m = /^(.*?)(?:#([1-9]\d*))?$/.exec(address), all = ids.get(m[1]) ?? [];
        candidates = m[2] ? all.slice(Number(m[2]) - 1, Number(m[2])) : all;
        if (!candidates.length) {
          const prefix = address.match(/^@([npl])\d+/)?.[1];
          const near = [...ids.keys()].filter(id => prefix && id.startsWith('@' + prefix)).sort((a,b) => Math.abs(Number(a.slice(2)) - Number(address.match(/\d+/)?.[0])) - Math.abs(Number(b.slice(2)) - Number(address.match(/\d+/)?.[0]))).slice(0, 4).flatMap(id => ids.get(id));
          problem(j, `unknown id ${address}`, near.length ? evidence(near) : context(0)); invalid = true; continue;
        }
      } else candidates = ls.flatMap((s, i) => s.trim() === address.trim() ? [i] : []);
      if (candidates.length !== 1) { problem(j, `${address}: ${candidates.length ? 'ambiguous address; select an occurrence with #1, #2' : 'exact text not found'}`, candidates.length ? evidence(candidates) : context(0)); invalid = true; continue; }
      index = candidates[0];
    }
    const kind = addresses[0], lines = index == null ? context(0) : context(index, blockEnd(index));
    if (kind === 'replace' && !Object.hasOwn(edit, 'with')) { problem(j, 'replace needs with', lines); invalid = true; }
    if (['after', 'before'].includes(kind) && !Object.hasOwn(edit, 'insert')) { problem(j, `${kind} needs insert`, lines); invalid = true; }
    if (kind === 'delete' && ('with' in edit || 'insert' in edit)) { problem(j, 'delete cannot have with or insert', lines); invalid = true; }
    if (kind === 'replace' && 'insert' in edit || ['after', 'before'].includes(kind) && 'with' in edit) { problem(j, 'replace uses with; after/before use insert', lines); invalid = true; }
    let content = kind === 'delete' ? [] : lineText(edit[kind === 'replace' ? 'with' : 'insert']);
    if (kind !== 'delete' && (content == null || !content.trim())) { problem(j, `${kind === 'replace' ? 'with' : 'insert'} is empty or invalid; use delete to remove a line`, lines); invalid = true; }
    if (index == null || invalid) continue;
    if (kind === 'delete' && ownId(ls[index]) === '@' + headerOf(readText)?.key) { problem(j, 'cannot delete the action header; deleting an action is another op', lines); continue; }
    if (kind !== 'delete') {
      content = content.split('\n');
      if (indent(content[0]) === 0) {
        // R2 (C-18, F-FitBody-28): the first line takes the addressed line's indentation and the lines after it are relative
        // to the first; lines written where the action has them (their least indentation one level, 2 spaces, under the
        // addressed line) stay as given, and the note says so.
        const prefix = ls[index].slice(0, indent(ls[index]));
        const rest = content.slice(1).filter(s => s.trim());
        const absolute = prefix.length > 0 && rest.length > 0 && Math.min(...rest.map(indent)) === prefix.length + 2;
        if (absolute) notes.push({ rule: 'flow-edit-indent', at: `/edits/${j}`, note: `the lines after the first are written at the action's indentation (${prefix.length + 2} spaces): kept as given` });
        content = content.map((s, k) => (k > 0 && absolute ? s : prefix + s));
      }
      if (kind === 'replace' && ownId(ls[index]) && !ownId(content[0])) content[0] += ' ' + ownId(ls[index]);
    }
    const deep = content.some((s, k) => k > 0 && indent(s) > indent(content[0]));
    const start = kind === 'delete' || kind === 'before' ? descStart(index) : kind === 'after' ? (indent(content[0]) > indent(ls[index]) ? index + 1 : blockEnd(index)) : index;
    const end = kind === 'delete' || kind === 'replace' && deep ? blockEnd(index) : kind === 'replace' ? index + 1 : start;
    plans.push({ j, index, start, end, content, kind });
  }
  for (let a = 0; a < plans.length; a++) for (let b = a + 1; b < plans.length; b++) {
    const x = plans[a], y = plans[b];
    const sameInsertPoint = x.start === x.end && y.start === y.end && x.start === y.start;
    if (!sameInsertPoint && (x.index === y.index || x.start < y.end && y.start < x.end || x.index >= y.start && x.index < y.end || y.index >= x.start && y.index < x.end || x.start === x.end && x.start > y.start && x.start < y.end || y.start === y.end && y.start > x.start && y.start < x.end)) {
      problem(x.j, `overlapping edit with edits/${y.j}`, context(Math.min(x.index, y.index), Math.max(x.end, y.end)));
      problem(y.j, `overlapping edit with edits/${x.j}`, context(Math.min(x.index, y.index), Math.max(x.end, y.end)));
    }
  }
  const out = [];
  for (let i = 0; i < ls.length;) {
    for (const p of plans.filter(p => p.start === i && p.end === i)) out.push(...p.content);
    const p = plans.find(p => p.start === i && p.end > i);
    if (p) { out.push(...p.content); i = p.end; } else { out.push(ls[i]); i++; }
  }
  for (const p of plans.filter(p => p.start === ls.length && p.end === p.start)) out.push(...p.content);
  const resultIds = new Map();
  out.forEach((s, i) => { const id = ownId(s); if (id) resultIds.set(id, [...(resultIds.get(id) ?? []), i]); });
  for (const [id, positions] of resultIds) if (positions.length > 1 && positions.length > (ids.get(id)?.length ?? 1)) {
    for (const p of plans.filter(p => p.content.some(s => ownId(s) === id))) problem(p.j, `result has duplicate owned id ${id}`, context(p.index));
  }
  for (const s of out) {
    const ref = s.trimStart().match(/^(?:->|\/\/->)\s+(@\S+)/)?.[1];
    if (ref && !resultIds.has(ref)) {
      const causes = plans.filter(p => ls.slice(p.start, p.end).some(l => ownId(l) === ref) || p.content.includes(s));
      for (const p of causes) problem(p.j, `jump/comment points to removed id ${ref}`, context(p.index, p.end));
    }
  }
  const ending = readText.match(/(?:\r?\n[ \t]*)*$/)[0];
  const text = out.join(newline).replace(/(?:\r?\n[ \t]*)*$/, '') + ending;
  return { text, removes: [...ids.keys()].filter(id => !resultIds.has(id)), problems, ...(notes.length ? { notes } : {}) };
}

// C-18 (F-FitBody-42): the {find, with} edits of a read action: each find the exact text of the read (its @ids included,
// as the read prints them), once there; two finds never overlap; the result is the whole action text.
function findEdits(readText, edits, alone) {
  const text = readText.replace(/\r\n/g, '\n');
  const problems = [];
  const lineOf = offset => text.slice(0, offset).split('\n').length;
  const near = find => {
    const first = String(find).split('\n').map(s => s.trim()).find(Boolean) ?? '';
    for (let probe = first; probe.length >= 6; probe = probe.slice(0, Math.floor(probe.length / 2))) {
      const hits = text.split('\n').flatMap((s, i) => (s.includes(probe) ? [{ line: i + 1, text: s }] : []));
      if (hits.length) return hits.slice(0, 5);
    }
    return [];
  };
  if (!alone) problems.push({ at: 'edits', error: 'an item edits a read action by {find, with} or by its lines (replace, delete, after, before), not both: send them as two items, or all as {find, with}', lines: [] });
  const plans = [];
  edits.forEach((e, j) => {
    if (!e || typeof e !== 'object' || Array.isArray(e) || !Object.hasOwn(e, 'find')) return;
    const other = Object.keys(e).filter(k => k !== 'find' && k !== 'with');
    if (other.length) problems.push({ at: `edits/${j}`, error: `a {find, with} edit takes find and with only (${other.join(', ')})`, lines: [] });
    if (typeof e.find !== 'string' || !e.find) { problems.push({ at: `edits/${j}`, error: 'find is the exact, nonempty text of the read action to change', lines: [] }); return; }
    if (typeof e.with !== 'string') { problems.push({ at: `edits/${j}`, error: 'with is the new text (a string; "" removes the text found)', lines: [] }); return; }
    const find = e.find.replace(/\r\n/g, '\n');
    const hits = [];
    for (let at = text.indexOf(find); at >= 0; at = text.indexOf(find, at + 1)) hits.push(at);
    if (hits.length !== 1) {
      problems.push({ at: `edits/${j}`, code: hits.length ? 'EDIT_TEXT_NOT_UNIQUE' : 'EDIT_TEXT_NOT_FOUND',
        error: hits.length ? `find occurs ${hits.length} times in the read action: give a longer exact text that occurs once` : 'find occurs nowhere in the read action: copy the exact text of the read (the nearest lines are in lines)',
        lines: hits.length ? hits.slice(0, 10).map(h => ({ line: lineOf(h), text: text.split('\n')[lineOf(h) - 1] })) : near(find) });
      return;
    }
    plans.push({ j, start: hits[0], end: hits[0] + find.length, with: e.with.replace(/\r\n/g, '\n') });
  });
  for (let a = 0; a < plans.length; a++) for (let b = a + 1; b < plans.length; b++)
    if (plans[a].start < plans[b].end && plans[b].start < plans[a].end) {
      problems.push({ at: `edits/${plans[a].j}`, error: `overlaps edits/${plans[b].j}: join them in one find`, lines: [] });
      problems.push({ at: `edits/${plans[b].j}`, error: `overlaps edits/${plans[a].j}: join them in one find`, lines: [] });
    }
  let out = text;
  for (const p of [...plans].sort((x, y) => y.start - x.start)) out = out.slice(0, p.start) + p.with + out.slice(p.end);
  const idsOf = t => new Set(t.split('\n').map(ownId).filter(Boolean));
  const after = idsOf(out);
  const result = readText.includes('\r\n') ? out.replace(/\n/g, '\r\n') : out;
  return { text: result, removes: [...idsOf(text)].filter(id => !after.has(id)), problems };
}

// C-22 (F-FitBody-12): an element names the read action in any form the read takes (findActions): its path
// (MainFlow/FB_LogIn/LogIn), the header's Owner.Action (FB_LogIn.LogIn), its last segments, or a longer path that ends in
// its name (Folder/Action). The names, split at / and ., one ending the other (case folded, as the read does).
function sameAction(element, name) {
  const segments = s => s.split(/[./]/).filter(Boolean).map(x => x.toLowerCase());
  const ends = (long, tail) => tail.length > 0 && tail.length <= long.length && tail.every((x, i) => long[long.length - tail.length + i] === x);
  const e = segments(element), n = segments(name);
  return ends(n, e) || ends(e, n);
}

export function expandEditPart(p, lane, { readReading = loadFlowReading } = {}) {
  const problems = [], notes = [], baseAt = p.at === 'text' || !p.at ? '' : p.at + '/';
  const add = (error, extra = {}) => problems.push({ at: baseAt + 'edits', error, lines: [], ...extra });
  // CX16 (html-edits.mjs): over basedOn {job, sha256} the edits change texts of that job (jobTextEdits takes them first);
  // edits of a screen or block read go whole to the kernel's html op, their shape checked here (the kernel addresses them).
  if (isJobTextBase(p.basedOn)) return { part: { ...p, jobText: true }, problems, notes };
  if (canonicalPart(p.part) === 'html' || (p.part == null && isReadingBase(p.basedOn))) {
    if (p.part == null) notes.push({ rule: 'part-from-edits', at: '/' + baseAt + 'part', note: 'edits with basedOn {capture, html} change part html' });
    if (p.text != null) add('text or edits, not both');
    if (!isReadingBase(p.basedOn)) add('basedOn of html edits is {capture, html} as the read returned them');
    if (typeof p.element !== 'string' || !p.element) add('element: the screen or block read (part html)');
    problems.push(...readingEditsShape(p.edits).map(q => ({ ...q, at: baseAt + q.at })));
    return { part: problems.length ? null : { part: 'html', element: p.element, basedOn: p.basedOn, edits: p.edits, at: p.at }, problems, notes };
  }
  if (p.part == null) notes.push({ rule: 'part-from-edits', at: '/' + baseAt + 'part', note: 'edits change part logic' });
  else if (p.part !== 'logic') add('edits change lines of an action (part logic) or elements of a screen or block (part html); ddl is sent as its statements');
  if (p.text != null) add('text or edits, not both');
  const sha = typeof p.basedOn === 'string' && /^[a-f\d]{16}$/i.test(p.basedOn) ? p.basedOn.toLowerCase() : null;
  if (!sha) add('basedOn must be the 16 hex textSha of one read action');
  const reading = sha ? readReading(lane, sha) : null;
  if (sha && !reading) add(`basedOn ${sha}: no read of this textSha is kept on lane ${lane}; read the action (ssam_code read part logic element ${p.element ?? 'X'}) and edit that read; an action whose read is not a fixed point is changed by its whole text`,
    { continuation: { tool: 'ssam_code', arguments: { lane, action: 'read', part: 'logic', ...(p.module ? { target: p.module } : {}), element: p.element ?? 'X' }, why: 'read the action before editing its lines' } });
  if (!reading) return { part: null, problems, notes };
  const a = reading.action, e = p.element;
  const exact = typeof e === 'string' && [a.key, '@' + a.key, a.name].includes(e);
  // C-22 (F-FitBody-12): any form of the action's name the read takes (sameAction); a form other than the read's own says so.
  const named = typeof e === 'string' && !exact && sameAction(e, a.name);
  if (named) notes.push({ rule: 'action-path', at: '/' + baseAt + 'element', note: 'The action suffix was resolved against the pinned reading: ' + a.name });
  if (e != null && !exact && !named) add(`element does not match read action ${a.name} (@${a.key})`);
  const result = applyFlowEdits(reading.text, p.edits);
  problems.push(...result.problems.map(q => ({ ...q, at: baseAt + q.at })));
  notes.push(...(result.notes ?? []).map(n => ({ ...n, at: '/' + baseAt + n.at.slice(1) })));
  if (problems.length) return { part: null, problems, notes };
  notes.push({ rule: 'logic-edits', at: '/' + baseAt + 'edits', note: `${a.name}: ${p.edits.length} edit(s) on read ${sha}: ${reading.text.split('\n').length} -> ${result.text.split('\n').length} lines` });
  return { part: { part: 'logic', text: result.text, basedOn: sha, removes: result.removes, element: e ?? a.name, at: p.at }, problems, notes };
}
