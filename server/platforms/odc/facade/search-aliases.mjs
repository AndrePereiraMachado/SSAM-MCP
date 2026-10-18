// The words of a request are input, never emitted text (review english-junction round 1, F2). Since 15/10/2026 every
// text SSAM emits is English, the team rules and the standards included; a request may still be Portuguese. This module
// is the ONE place where a Portuguese request meets English served text:
// - the rules search (ssam-reference.mjs rulesAnswer) also matches the Portuguese headings and texts the release
//   8689de53 served (rules-search-aliases.json), unit by unit at the same place as the English ones, so a Portuguese
//   request finds the rule it found then; the answer always carries the English unit;
// - the work packet (work-packet.mjs rulesSection) reads the Portuguese technique words of an intent in English before it
//   compares them with the English rules, so a Portuguese intent chooses the rules the English one chooses.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ALIASES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'rules-search-aliases.json');
let aliases;
// The Portuguese text of a rules document ('rules' = the team rules, 'standards' = the 35 standards), or null.
export function rulesAliasText(topic) {
  if (aliases === undefined) { try { aliases = JSON.parse(fs.readFileSync(ALIASES, 'utf8').replace(/^﻿/, '')); } catch { aliases = null; } }
  if (!aliases) return null;
  return topic === 'rules' ? aliases.team ?? null : topic === 'standards' ? aliases.standards ?? null : null;
}

// The alias of each English section, at the same place: [{title, own, lessons}] where own is the text before the first
// lesson and lessons the [{title, text}] of its "### " lessons; null for a document whose sections differ (an alias never
// names another unit), and lessons null for a section whose lessons differ in number.
export function alignedAliases(sections, aliasText, guideSections) {
  if (!aliasText) return null;
  const alias = guideSections(aliasText);
  if (alias.length !== sections.length || alias.some((a, i) => a.id !== sections[i].id)) return null;
  return alias.map((a, i) => {
    const mine = guideSections(sections[i].text, 3), theirs = guideSections(a.text, 3);
    const first = a.text.search(/^### /m);
    return { title: a.title, own: first < 0 ? a.text : a.text.slice(0, first), lessons: mine.length === theirs.length ? theirs.map(l => ({ title: l.title, text: l.text })) : null };
  });
}

// The technique words of an intent (work-packet.mjs TECH) in English: the words of the rules they are compared with.
export const TECH_WORDS_PT_EN = Object.freeze({ comentario: 'comment', comentarios: 'comments', descricao: 'description', descricoes: 'descriptions',
  variavel: 'variable', variaveis: 'variables' });
export const techInEnglish = word => TECH_WORDS_PT_EN[word] ?? word;

// The suite jobs (review english-junction round 1, F1/F2): their prose (description, op _why, expected-message why) is
// English since 16/10; the folded words of the Portuguese prose they had (kernel/tests/jobs-search-aliases.json,
// platforms/odc/scripts/job-search-aliases.mjs) are added to what a search matches, never served: discovery.mjs
// (scoreJob, relatedNotes), ssam-reference.mjs (the ODC recipe) and CommandSurface.cs (the O11 recipe).
// dir: 'jobs' (O11 suite) or 'jobs-odc' (ODC suite). Returns {words, notes?: {<op index>: words}} or null.
const JOB_ALIASES = new Map();
export function jobSearchAlias(kernelRoot, dir, name) {
  if (!JOB_ALIASES.has(kernelRoot)) {
    let jobs = {};
    try { jobs = JSON.parse(fs.readFileSync(path.join(kernelRoot, 'tests', 'jobs-search-aliases.json'), 'utf8').replace(/^\uFEFF/, '')).jobs ?? {}; } catch { /* no aliases: English only */ }
    JOB_ALIASES.set(kernelRoot, jobs);
  }
  return JOB_ALIASES.get(kernelRoot)[dir + '/' + name] ?? null;
}
// A job without its prose (the description, every op _why, the why of an expected message or of a lab flag): what a
// search matches besides the alias words when the job has an alias, so the English prose never changes what a query
// finds (the same answer as before the translation). Returns a new object.
export function withoutProse(job) {
  const strip = (v, at) => {
    if (Array.isArray(v)) return v.map((x, i) => strip(x, at + '/' + i));
    if (!v || typeof v !== 'object') return v;
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if ((at === '' && k === 'description') || k === '_why' || (k === 'why' && (/^\/expectedMessages\/\d+$/.test(at) || /\/allowSoapWithoutImport$/.test(at)))) continue;
      out[k] = strip(x, at + '/' + k);
    }
    return out;
  };
  return strip(job, '');
}
// THE one search rule over translated job text (review english-junction round 2, F7: every reader of the words of a
// request against job prose goes through it): the text a search matches for one part of a suite job or proven example is
// the alias text it had before the translation when there is one, else its current text. key: the job's id under
// kernel/tests ("jobs/<name>", "jobs-odc/<name>", "jobs-odc/examples/<name>"); part: 'description' (ssam_discover's
// proven example, ssam_reference example find), 'words' (the recipes), 'notes' (all op notes, scoreJob) or a number (the
// note of that op, relatedNotes). Readers: discovery.mjs scoreJob, relatedNotes, provenExample; ssam-reference.mjs
// odcRecipe and exampleAnswer find; CommandSurface.cs Recipes (C#, the same rule over the same file).
export const JOB_SEARCH_READERS = Object.freeze(['scoreJob', 'relatedNotes', 'provenExample', 'odcRecipe', 'exampleAnswer find', 'CommandSurface.Recipes']);
export function jobSearchText(kernelRoot, key, part, current) {
  const slash = key.lastIndexOf('/');
  const alias = jobSearchAlias(kernelRoot, key.slice(0, slash), key.slice(slash + 1));
  if (!alias) return current;
  const value = part === 'notes' ? (alias.notes ? Object.values(alias.notes).join(' ') : null) : typeof part === 'number' ? alias.notes?.[part] : alias[part];
  return value ?? current;
}