// CX16 (7.1, 7.4): edits of screens, blocks and the texts of a job, so a change never resends the document.
//   - Edits of a READING (ssam_map view html: element + basedOn {capture, html}): readingEditsShape checks only their shape
//     (the facade never addresses a reading: the kernel does, HtmlElementEdits, against the text the store kept); every
//     problem at once, as the kernel's HTML_EDIT_INVALID.
//   - Edits of the TEXTS of a refused or checked job (basedOn {job, sha256}, its nextBasedOn): jobTextEdits. Each item names
//     an element of that job, a <screen>/<block> document (data.html), the screen of an edit op (its data.edit texts), an action
//     ("Screen.Action" or "Action", by the header of a logic text) or "ddl" (the data.ddl of the spec op); part breaks a tie.
//     Every edit is {find: "exact text", with: "text"} over the BASE text (R1): each find occurs once in its element (R4), no
//     two overlap. The result is one JSON Patch replace per changed text, placed BEFORE the model's own patch (replace keeps
//     every index, so the model's paths stay those of the base), and handed to the patch route of today (job-patch.mjs:
//     sha256 checked again, the new job written to a new file). Nothing here reads a Studio, the kernel or a capture.
// Imports from the facade are used inside functions only (ssam-code.mjs and job-patch.mjs import this module back).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { headerOf, canonicalPart, normalizeEvents } from './ssam-code.mjs';
import { PATCH_MAX_OPS, patchJob, PatchError } from './job-patch.mjs';

const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const READING_EDITS_MAX = 500;

// ---- 7.1: the shape of the edits of a reading (the address is the kernel's to resolve)
const ADDRESSES = ['find', 'set', 'replace', 'delete', 'after', 'before', 'into', 'move'];
const DESTINATIONS = ['after', 'before', 'into'];
const COMPANIONS = { find: ['with'], set: ['attributes'], replace: ['with'], delete: [], after: ['insert'], before: ['insert'], into: ['insert', 'at'], move: ['at'] };
const KNOWN = new Set([...ADDRESSES, 'with', 'attributes', 'insert', 'at']);
const isReadingBase = b => plain(b) && typeof b.capture === 'string' && !!b.capture && typeof b.html === 'string' && !!b.html;
export const isJobTextBase = b => plain(b) && typeof b.job === 'string' && typeof b.sha256 === 'string';
export { isReadingBase };

/** The problems of the shape of the edits of a reading, [{at: "edits/<j>", code, error}] (empty when the shape is right). */
export function readingEditsShape(edits) {
  const problems = [];
  const add = (at, error) => problems.push({ at, code: 'HTML_EDIT_INVALID', error });
  if (!Array.isArray(edits) || !edits.length || edits.length > READING_EDITS_MAX) {
    add('edits', `edits is a list of 1 to ${READING_EDITS_MAX} edits of the read`);
    return problems;
  }
  edits.forEach((edit, j) => {
    const at = `edits/${j}`;
    if (!plain(edit)) { add(at, 'an edit is an object such as {set:"w7", attributes:{...}} or {find:"exact text", with:"..."}'); return; }
    const keys = Object.keys(edit);
    const unknown = keys.filter(k => !KNOWN.has(k));
    if (unknown.length) add(at, `unknown edit key: ${unknown.join(', ')} (find, with, set, attributes, replace, delete, after, before, into, insert, at, move)`);
    // move carries its destination (after, before or into) as a second key; any other edit has one address.
    const kind = Object.hasOwn(edit, 'move') ? 'move' : null;
    const addresses = keys.filter(k => ADDRESSES.includes(k) && !(kind && DESTINATIONS.includes(k)));
    if (addresses.length !== 1) { add(at, `exactly one address: find, set, replace, delete, after, before, into or move${addresses.length ? ` (here ${addresses.join(', ')})` : ''}`); return; }
    const key = addresses[0];
    const value = edit[key];
    if (typeof value !== 'string' || !value) add(at, key === 'find' ? 'find is the exact, nonempty text of the read to change' : `${key} is the address of an element of the read: its k ("w7"), k/Slot, k.true|k.false, "/" or @ObjectKey`);
    const allowed = new Set([key, ...COMPANIONS[key], ...(kind ? DESTINATIONS : [])]);
    const extra = keys.filter(k => KNOWN.has(k) && !allowed.has(k));
    if (extra.length) add(at, `${extra.join(', ')} does not go with ${key}`);
    if ((key === 'find' || key === 'replace') && typeof edit.with !== 'string') add(at, `${key} needs with (a string; with "" removes the ${key === 'find' ? 'text' : 'element: prefer delete'})`);
    if (['after', 'before', 'into'].includes(key) && typeof edit.insert !== 'string') add(at, `${key} needs insert (the new elements, without k)`);
    if (key === 'set') {
      if (!plain(edit.attributes)) add(at, 'set needs attributes: an object of attribute -> value (a string, or null to remove it)');
      else {
        if (Object.hasOwn(edit.attributes, 'k')) add(at, 'set never changes k (the key of the element)');
        const bad = Object.entries(edit.attributes).filter(([, v]) => v !== null && typeof v !== 'string').map(([k]) => k);
        if (bad.length) add(at, `attributes take a string or null: ${bad.join(', ')}`);
      }
    }
    if (kind) {
      const destinations = keys.filter(k => DESTINATIONS.includes(k));
      if (destinations.length !== 1) add(at, 'move takes exactly one destination: after, before or into (the same element keeps its k)');
      else if (typeof edit[destinations[0]] !== 'string' || !edit[destinations[0]]) add(at, `move ${destinations[0]} is the address of an element of the read`);
      if (Object.hasOwn(edit, 'at') && destinations[0] !== 'into') add(at, 'at goes with into');
    }
    if (Object.hasOwn(edit, 'at') && !['first', 'last'].includes(edit.at)) add(at, 'at is "first" or "last" (default "last")');
  });
  return problems;
}

// ---- 7.4: the texts of a job a text edit may change
// {path, part, text, name (html), segments (logic: one per action, offsets in text)} for every text of the job's ops.
const ACTION_HEAD = /^(?:server action|service action|client action|data action|action|preparation)[ \t]+\S/;
const ROOT_NAME = /^\s*(?:<!--[\s\S]*?-->\s*)*<(?:screen|block)\b[^>]*?\bname\s*=\s*"([^"]+)"/;
function segmentsOf(text) {
  const ls = text.split('\n');
  const offsets = []; let at = 0;
  for (const line of ls) { offsets.push(at); at += line.length + 1; }
  const heads = ls.flatMap((line, i) => (ACTION_HEAD.test(line) ? [i] : []));
  if (!heads.length) { const h = headerOf(text); return [{ from: 0, to: text.length, owner: h?.owner ?? null, name: h?.name ?? null }]; }
  // As splitActions: the description and blank lines above a header belong to its action; the first one starts the text.
  const starts = heads.map((i, k) => {
    if (k === 0) return 0;
    let s = i;
    while (s > 0 && (/^\/\/\/( |$)/.test(ls[s - 1]) || !ls[s - 1].trim())) s--;
    while (!ls[s].trim()) s++;
    return s;
  });
  return heads.map((i, k) => {
    const h = headerOf(ls[i]);
    return { from: offsets[starts[k]], to: k + 1 < starts.length ? offsets[starts[k + 1]] : text.length, owner: h?.owner ?? null, name: h?.name ?? null };
  });
}
function textsOf(job) {
  const array = Array.isArray(job);
  const ops = array ? job : job.ops;
  const out = [];
  const add = (pointer, part, text, extra = {}) => out.push({ path: pointer, part, text, ...extra });
  ops.forEach((op, i) => {
    if (!plain(op) || !plain(op.data)) return;
    const d = op.data, at = `${array ? '' : '/ops'}/${i}/data`;
    if (op.op === 'spec' || op.op === 'ddl') for (const k of ['ddl', 'text']) if (typeof d[k] === 'string') add(`${at}/${k}`, 'ddl', d[k]);
    if (op.op === 'logic') for (const k of ['flow', 'text']) {
      const v = d[k];
      const one = (pointer, text) => add(pointer, 'logic', text, { segments: segmentsOf(text) });
      if (typeof v === 'string') one(`${at}/${k}`, v);
      else if (Array.isArray(v)) v.forEach((f, j) => {
        if (typeof f === 'string') one(`${at}/${k}/${j}`, f);
        else if (plain(f) && typeof f.text === 'string') one(`${at}/${k}/${j}/text`, f.text);
      });
    }
    if (op.op === 'html' && op.parent == null) {
      if (typeof d.html === 'string') { const name = ROOT_NAME.exec(d.html)?.[1]; if (name) add(`${at}/html`, 'html', d.html, { name }); }
      if (typeof d.screen === 'string' && d.edit != null) {
        if (typeof d.edit === 'string') add(`${at}/edit`, 'html', d.edit, { name: d.screen, edit: true });
        else if (Array.isArray(d.edit)) d.edit.forEach((t, j) => { if (typeof t === 'string') add(`${at}/edit/${j}`, 'html', t, { name: d.screen, edit: true }); });
      }
    }
  });
  return out;
}
const lastOf = name => String(name).split(/[/:]/).pop();
// The names a text edit can give as element, in the job's order (EDIT_ELEMENT_UNKNOWN lists them).
function namesOfTexts(texts) {
  const names = [];
  for (const t of texts) {
    if (t.part === 'ddl') names.push('ddl');
    else if (t.part === 'html') names.push(lastOf(t.name));
    else for (const s of t.segments) if (s.name) names.push(s.owner ? `${s.owner}.${s.name}` : s.name);
  }
  return [...new Set(names)];
}
// The stretches of the job one element names: [{text, from, to}] (an action is its stretch of a logic text).
function scopesOf(texts, element, part) {
  const e = lastOf(String(element).trim()).toLowerCase();
  const dot = e.lastIndexOf('.');
  const owner = dot > 0 ? e.slice(0, dot) : null, name = dot > 0 ? e.slice(dot + 1) : e;
  const out = [];
  for (const t of texts) {
    if (part && t.part !== part) continue;
    if (t.part === 'ddl') { if (e === 'ddl') out.push({ text: t, from: 0, to: t.text.length }); }
    else if (t.part === 'html') { if (lastOf(t.name).toLowerCase() === e) out.push({ text: t, from: 0, to: t.text.length }); }
    else for (const s of t.segments) if (s.name && s.name.toLowerCase() === name && (owner == null || (s.owner ?? '').toLowerCase() === owner)) out.push({ text: t, from: s.from, to: s.to });
  }
  return out;
}
// The value at a JSON pointer of the job (the pointers built here: no escaping needed).
const valueAt = (job, pointer) => pointer.split('/').slice(1).reduce((node, token) => node?.[Array.isArray(node) ? Number(token) : token], job);
const lineAt = (text, offset) => text.slice(0, offset).split('\n').length;
const lineText = (text, line) => { const s = text.split('\n')[line - 1] ?? ''; const t = s.replace(/\r$/, ''); return t.length > 200 ? t.slice(0, 199) + '…' : t; };
// Every start of `find` inside the scopes (overlapping starts count: "aa" occurs twice in "aaa").
function occurrences(scopes, find) {
  const hits = [];
  for (const scope of scopes) {
    let at = scope.text.text.indexOf(find, scope.from);
    while (at >= 0 && at + find.length <= scope.to) { hits.push({ scope, start: at, end: at + find.length }); at = scope.text.text.indexOf(find, at + 1); }
  }
  return hits;
}
// The lines nearest to a find that occurs nowhere: those holding its first line, else the longest prefix of it found.
function nearLines(scopes, find) {
  const first = find.split('\n').map(s => s.trim()).find(Boolean) ?? '';
  for (let probe = first; probe.length >= 8; probe = probe.slice(0, Math.floor(probe.length / 2))) {
    const lines = [];
    for (const scope of scopes) {
      const body = scope.text.text.slice(scope.from, scope.to);
      const base = lineAt(scope.text.text, scope.from);
      body.split('\n').forEach((s, k) => { if (s.includes(probe)) lines.push({ line: base + k, text: lineText(scope.text.text, base + k), ...(scopes.length > 1 ? { path: scope.text.path } : {}) }); });
    }
    if (lines.length) return lines.slice(0, 5);
  }
  return [];
}

// The item fields a correction of a job takes; the rest of a write is new content (another write).
const NEW_CONTENT = ['text', 'files', 'ops'];
const MIXED = 'a correction of a job is patch + edits over basedOn {job, sha256}; new parts (text, files, ops) and edits of a read (basedOn its textSha or {capture, html}) go in a new write';

/**
 * Edits of the texts of the job of basedOn {job, sha256} (the nextBasedOn of a refused delivery or check), as a JSON Patch.
 * -> null when the write has none (every other write as before); {problems, error} for one refusal with every problem;
 * {input, notes}: the write with the patch generated (before the model's own patch) and the edit items taken out.
 * deps.readJob(file) -> the bytes of the job file (default fs).
 */
export function jobTextEdits(input, { readJob = file => fs.readFileSync(file) } = {}) {
  if (!plain(input)) return null;
  const also = Array.isArray(input.also) ? input.also : [];
  const topBase = isJobTextBase(input.basedOn) || plain(input.basedOn) && typeof input.basedOn.taskId === 'string' ? input.basedOn : null;
  // The edit items over a job: the top one (its basedOn is the write's) and every also item without a basedOn of its own
  // (or with the job's). An also item with its own job base names the base when the top has none.
  const items = [];
  if (input.edits != null && topBase) items.push({ at: '', part: input.part, element: input.element, edits: input.edits });
  also.forEach((p, i) => {
    if (!plain(p) || p.edits == null) return;
    if (isJobTextBase(p.basedOn) || (p.basedOn == null && topBase)) items.push({ at: `also/${i}/`, part: p.part, element: p.element, edits: p.edits, basedOn: p.basedOn ?? null });
  });
  if (!items.length) return null;
  const problems = [];
  const keyOf = b => (typeof b.job === 'string' ? path.resolve(b.job).toLowerCase() : '') + '|' + String(b.sha256 ?? b.taskId ?? '').toLowerCase();
  const bases = [...new Map([topBase, ...items.map(x => x.basedOn)].filter(Boolean).map(b => [keyOf(b), b])).values()];
  const base = bases[0];
  if (bases.length > 1) problems.push({ at: 'basedOn', error: 'edits of a job correct ONE job: every item has the basedOn {job, sha256} of the write (' + bases.map(b => b.job ?? b.taskId).join(', ') + ')' });
  // New content and edits of a read beside a correction: one sentence each, nothing delivered.
  const given = v => (Array.isArray(v) ? v.length > 0 : typeof v === 'string' ? v.trim() !== '' : v != null);
  for (const k of NEW_CONTENT) if (given(input[k])) problems.push({ at: k, error: MIXED });
  if (input.edits != null && !topBase) problems.push({ at: 'edits', error: MIXED });
  also.forEach((p, i) => { if (plain(p) && !items.some(x => x.at === `also/${i}/`)) problems.push({ at: `also/${i}`, error: MIXED }); });
  if (input.patch != null && !Array.isArray(input.patch)) problems.push({ at: 'patch', error: 'patch "verified" goes alone; with edits, patch is a list of JSON Patch operations (or none)' });
  // The shape of every edit: {find, with} over the text of a job (it has no k: the other forms address a read).
  for (const item of items) {
    const where = item.at + 'edits';
    if (!Array.isArray(item.edits) || !item.edits.length || item.edits.length > READING_EDITS_MAX) { problems.push({ at: where, error: `edits is a list of 1 to ${READING_EDITS_MAX} {find, with}` }); item.bad = true; continue; }
    item.edits.forEach((e, j) => {
      const at = `${where}/${j}`;
      if (!plain(e)) { problems.push({ at, error: 'an edit of a job is {find: "exact text", with: "new text"}' }); return; }
      const other = Object.keys(e).filter(k => k !== 'find' && k !== 'with');
      if (other.length) problems.push({ at, error: `over basedOn {job, sha256} an edit is {find, with}: the exact text of the job and its replacement (${other.join(', ')} address a read: basedOn its textSha or {capture, html})` });
      if (typeof e.find !== 'string' || !e.find) problems.push({ at, error: 'find is the exact, nonempty text of the job to change' });
      if (typeof e.with !== 'string') problems.push({ at, error: 'with is the new text (a string; "" removes the text found)' });
    });
    if (item.part != null && !canonicalPart(item.part)) problems.push({ at: item.at + 'part', error: `part "${item.part}" is none of ddl, logic, html` });
    if (typeof item.element !== 'string' || !item.element.trim()) problems.push({ at: item.at + 'element', code: 'EDIT_ELEMENT_UNKNOWN', error: 'element names what the edits change in the job: a <screen>/<block> document, the screen of an edit, an action (Screen.Action or Action) or ddl' });
  }
  // The base: the bytes that were hashed (a changed job is never corrected: its new nextBasedOn is).
  let job = null, sha = null;
  if (base && typeof base.taskId === 'string' && !isJobTextBase(base)) problems.push({ at: 'basedOn', error: 'edits of a job need basedOn {job, sha256} (the nextBasedOn of the answer), not {taskId}' });
  else if (base) {
    const file = base.job;
    if (!path.isAbsolute(file)) problems.push({ at: 'basedOn', code: 'JOB_PATH_NOT_ABSOLUTE', error: 'basedOn.job must be the absolute path an answer returned: ' + file });
    else {
      let bytes = null;
      try { bytes = readJob(path.resolve(file)); } catch { problems.push({ at: 'basedOn', code: 'BASE_NOT_FOUND', error: `no job file at ${file}; nothing was patched` }); }
      if (bytes != null) {
        sha = sha256(bytes);
        if (sha !== String(base.sha256).toLowerCase()) problems.push({ at: 'basedOn', code: 'BASE_CHANGED', error: 'the job of basedOn changed after that answer (sha256 differs); nothing was patched: edit the job of its newest nextBasedOn' });
        else {
          try { job = JSON.parse(Buffer.from(bytes).toString('utf8').replace(/^﻿/, '')); } catch (error) { problems.push({ at: 'basedOn', code: 'PATCH_INVALID', error: 'the job of basedOn is not valid JSON: ' + error.message }); }
          if (plain(job) && Array.isArray(job.jobs)) { problems.push({ at: 'basedOn', code: 'PATCH_PATH_FORBIDDEN', error: 'a composite job ({jobs:[...]}) is corrected in its part: give basedOn {job, sha256} of the part file' }); job = null; }
          else if (job != null && !Array.isArray(job) && !(plain(job) && Array.isArray(job.ops))) { problems.push({ at: 'basedOn', code: 'PATCH_INVALID', error: 'the job of basedOn has no ops' }); job = null; }
        }
      }
    }
  }
  // Each find over the base text of its element (R1), unique there (R4); no two edits overlap.
  const plans = [];
  if (job != null) {
    const texts = textsOf(job);
    for (const item of items) {
      if (item.bad || typeof item.element !== 'string' || !item.element.trim()) continue;
      const part = item.part != null ? canonicalPart(item.part) : null;
      const scopes = scopesOf(texts, item.element, part);
      item.scopes = scopes;
      if (!scopes.length) {
        problems.push({ at: item.at + 'element', code: 'EDIT_ELEMENT_UNKNOWN', error: `${item.element}${part ? ` (part ${part})` : ''} names no text of the job: its screens and blocks, actions and ddl are in names`, names: namesOfTexts(texts).slice(0, 80) });
        continue;
      }
      item.edits.forEach((e, j) => {
        if (!plain(e) || typeof e.find !== 'string' || !e.find || typeof e.with !== 'string') return;
        const at = `${item.at}edits/${j}`;
        const hits = occurrences(scopes, e.find);
        const where = hit => ({ line: lineAt(hit.scope.text.text, hit.start), text: lineText(hit.scope.text.text, lineAt(hit.scope.text.text, hit.start)), ...(scopes.length > 1 ? { path: hit.scope.text.path } : {}) });
        if (hits.length !== 1) {
          problems.push({ at, code: 'EDIT_TEXT_NOT_UNIQUE', error: hits.length ? `find occurs ${hits.length} times in ${item.element}: give a longer exact text that occurs once` : `find occurs nowhere in ${item.element}: copy the exact text of the job (the nearest lines are in lines)`,
            lines: hits.length ? hits.slice(0, 10).map(where) : nearLines(scopes, e.find) });
          return;
        }
        const hit = hits[0];
        // The text of an edit op (data.edit) takes an event of an action without arguments as the reader writes it, X not X()
        // (the kernel refuses the parentheses there, HTML_SCRIPT; ssam_code writes edit texts so: opsOfPart). The new text
        // only; a document keeps what the model wrote (it takes both forms).
        plans.push({ at, item, text: hit.scope.text, start: hit.start, end: hit.end, with: hit.scope.text.edit ? normalizeEvents(' ' + e.with).slice(1) : e.with, line: where(hit) });
      });
    }
    for (let a = 0; a < plans.length; a++) for (let b = a + 1; b < plans.length; b++) {
      const x = plans[a], y = plans[b];
      if (x.text !== y.text) continue;
      // Two stretches that share a character overlap (R1: each one addresses the base; a find is never empty).
      if (x.start < y.end && y.start < x.end) {
        problems.push({ at: x.at, code: 'EDIT_OVERLAP', error: `overlaps ${y.at}: two edits of the same text of the job; join them in one find`, lines: [x.line] });
        problems.push({ at: y.at, code: 'EDIT_OVERLAP', error: `overlaps ${x.at}: two edits of the same text of the job; join them in one find`, lines: [y.line] });
      }
    }
  }
  // The patch: one replace per changed text, then the model's own patch (checked over the base; never the same path).
  const changed = new Map();
  for (const p of plans) changed.set(p.text, [...(changed.get(p.text) ?? []), p]);
  const generated = [];
  for (const [t, list] of changed) {
    let out = t.text;
    for (const p of [...list].sort((a, b) => b.start - a.start)) out = out.slice(0, p.start) + p.with + out.slice(p.end);
    if (out !== t.text) generated.push({ op: 'replace', path: t.path, value: out });
  }
  // Edits without effect (with = find) are accepted (R5): the job is checked unchanged, by a test of one text.
  if (!generated.length && changed.size) { const [t] = changed.keys(); generated.push({ op: 'test', path: t.path, value: t.text }); }
  const model = Array.isArray(input.patch) ? input.patch : [];
  if (job != null && model.length) {
    try {
      const { resolved } = patchJob(job, model, { max: Infinity });
      resolved.forEach((r, i) => {
        for (const g of generated) {
          if (r.path === g.path || g.path.startsWith(r.path + '/') || r.path.startsWith(g.path + '/')) {
            const edits = plans.filter(p => p.text.path === g.path).map(p => p.at);
            problems.push({ at: `patch/${i}`, code: 'EDIT_OVERLAP', error: `${r.op} ${r.path} touches the text the edits change (${edits.join(', ')}): put that change in the edits, or the whole change in the patch` });
            for (const at of edits) problems.push({ at, code: 'EDIT_OVERLAP', error: `the text it changes is also at patch/${i} (${r.op} ${r.path})` });
          }
        }
      });
    } catch (error) {
      if (!(error instanceof PatchError)) throw error;
      problems.push({ at: `patch${error.at != null ? '/' + error.at : ''}`, code: error.code, error: error.message, ...(error.candidates ? { candidates: error.candidates } : {}) });
    }
  }
  // Within the limit of a patch (PATCH_MAX_OPS): one replace per changed text; past it, the changed texts of one list
  // (data.flow, data.text, data.edit of an op) are one replace of that list, the base list with those texts changed.
  let joined = null;
  if (problems.length === 0 && generated.length + model.length > PATCH_MAX_OPS) {
    const lists = new Map(), out = [];
    for (const g of generated) {
      const m = g.op === 'replace' ? /^(.*\/data\/(?:flow|text|edit))\/(\d+)(\/text)?$/.exec(g.path) : null;
      if (!m) { out.push(g); continue; }
      if (!lists.has(m[1])) { const entry = { op: 'replace', path: m[1], value: structuredClone(valueAt(job, m[1])) }; lists.set(m[1], entry); out.push(entry); }
      const list = lists.get(m[1]).value, k = Number(m[2]);
      list[k] = m[3] ? { ...list[k], text: g.value } : g.value;
    }
    if (out.length < generated.length) { joined = out.length; generated.splice(0, generated.length, ...out); }
  }
  if (problems.length === 0 && generated.length + model.length > PATCH_MAX_OPS)
    problems.push({ at: 'edits', code: 'PATCH_INVALID', error: `the correction needs ${joined != null ? joined + ' replace(s), the texts of each list joined' : generated.length + ' replace(s), one per text the edits change'}, + ${model.length} operation(s) of patch = ${generated.length + model.length}; at most ${PATCH_MAX_OPS} (PATCH_MAX_OPS): send it in two corrections, the second over the nextBasedOn of the first` });
  if (problems.length) return { problems, error: problems.map(p => `${p.at}: ${p.error}`).join(' | ') };
  // The note of each item: what it changed, in bytes of its element.
  const notes = items.map(item => {
    const before = item.scopes.reduce((n, s) => n + Buffer.byteLength(s.text.text.slice(s.from, s.to), 'utf8'), 0);
    const delta = plans.filter(p => p.item === item).reduce((n, p) => n + Buffer.byteLength(p.with, 'utf8') - Buffer.byteLength(p.text.text.slice(p.start, p.end), 'utf8'), 0);
    return { rule: 'job-text-edits', at: '/' + item.at + 'edits', note: `${item.element}: ${item.edits.length} edit(s) on job ${sha.slice(0, 12)}: ${before} -> ${before + delta} bytes` };
  });
  const { edits: _e, element: _el, also: _a, removes: _r, ...rest } = input;
  return { input: { ...rest, basedOn: base, patch: [...generated, ...model] }, notes };
}
