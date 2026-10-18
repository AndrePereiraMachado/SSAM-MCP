// node platforms/odc/scripts/job-search-aliases.mjs [rev] [examplesRev]
// Writes kernel/tests/jobs-search-aliases.json: the words of the Portuguese prose (description, op _why, expected-message
// why) of every suite job as the release <rev> had them, before they were translated (review english-junction round 1,
// F1/F2: the words of a request are input; a Portuguese request keeps finding the jobs it found), and the words of the
// rows of the O11 recipe table that cite each job. Search only, never
// served: discovery.mjs (scoreJob, relatedNotes), ssam-reference.mjs (ODC recipe) and CommandSurface.cs (O11 recipe) add
// these words to what they match. Folded (no accents, lower case), each word once.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const git = (...a) => execFileSync(process.env.GIT ?? 'git', ['-C', root, ...a], { encoding: 'utf8', maxBuffer: 256 << 20 });
const rev = process.argv[2] ?? 'HEAD';
// The proven examples (jobs*/examples) were translated earlier (lane B, 8db28816..01d860aa): their Portuguese text is the
// one of examplesRev (8689de53, the candidate before lane B).
const examplesRev = process.argv[3] ?? '8689de53';
const fold = t => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const words = t => [...new Set(fold(t).split(/[^a-z0-9_]+/).filter(w => w.length > 1))].join(' ');
const out = { _doc: 'Search-only aliases (review english-junction F1/F2): the folded words of the Portuguese prose of each suite job (description, op _why, expected-message why) as the release ' + rev + ' had it, before the translation. Matched against the words of a request together with the English prose, never served. jobs/<name> (O11 suite), jobs-odc/<name> (ODC suite), jobs*/examples/<name> (proven examples, from the examples rev); notes: the words of each op _why by op index.', source: '', jobs: {} };
out.source = git('rev-parse', '--short=8', rev).trim() + ' (suite jobs, recipe table); ' + git('rev-parse', '--short=8', examplesRev).trim() + ' (proven examples)';
for (const [dir, at] of [['jobs', rev], ['jobs-odc', rev], ['jobs/examples', examplesRev], ['jobs-odc/examples', examplesRev]]) {
  const names = git('ls-tree', '--name-only', at, 'kernel/tests/' + dir + '/').split(/\r?\n/).filter(f => f.endsWith('.json'));
  for (const file of names) {
    let job; try { job = JSON.parse(git('show', at + ':' + file).replace(/^﻿/, '')); } catch { continue; }
    if (!job || typeof job !== 'object' || Array.isArray(job)) continue;
    const notes = {};
    // A composite example ({jobs: ["job:<part>", ...]}) carries the ops of its parts, as discovery.mjs compositeOps reads them.
    const parts = spec => { const s = String(spec ?? ''); if (!s.startsWith('job:')) return [];
      for (const c of ['kernel/tests/' + dir + '/' + s.slice(4) + '.json', 'kernel/tests/' + dir.replace(/\/examples$/, '') + '/' + s.slice(4) + '.json']) {
        try { const p = JSON.parse(git('show', at + ':' + c).replace(/^﻿/, '')); return Array.isArray(p) ? p : (p.ops ?? []); } catch { /* next */ } }
      return []; };
    const ops = Array.isArray(job.ops) ? job.ops : dir.endsWith('/examples') && Array.isArray(job.jobs) ? job.jobs.flatMap(parts) : [];
    ops.forEach((op, i) => { if (op && typeof op._why === 'string' && op._why.trim()) notes[i] = words(op._why); });
    // words: everything a recipe matches (the whole prose); description: what ssam_discover's proven example matches;
    // notes: each op's _why (relatedNotes; scoreJob reads description + notes, as it read the Portuguese text).
    const all = words([job.description ?? '', ...Object.values(notes), ...(job.expectedMessages ?? []).map(m => m?.why ?? '')].join(' '));
    if (!all) continue;
    const description = words(job.description ?? '');
    out.jobs[dir + '/' + path.basename(file, '.json')] = { words: all, ...(description ? { description } : {}), ...(Object.keys(notes).length ? { notes } : {}) };
  }
}
// The O11 recipe also matches the rows of the "| Tarefa |" table of kernel/AGENTS.md that cite a job: their words go
// with the job they cite (the table is English since 16/10 too).
const guide = git('show', rev + ':kernel/AGENTS.md').split(/\r\n|\n|\r/);
const start = guide.findIndex(l => l.startsWith('| Tarefa |'));
for (let i = start < 0 ? guide.length : start + 2; i < guide.length && guide[i].startsWith('|'); i++)
  for (const m of guide[i].matchAll(/(?<![\w.-])([a-z][a-z0-9-]*)\.json\b/g)) {
    const key = 'jobs/' + m[1]; const entry = out.jobs[key] ?? (out.jobs[key] = { words: '' });
    entry.words = words(entry.words + ' ' + guide[i]);
  }
fs.writeFileSync(path.join(root, 'kernel', 'tests', 'jobs-search-aliases.json'), JSON.stringify(out, null, 1) + '\n');
console.log('jobs', Object.keys(out.jobs).length, 'bytes', fs.statSync(path.join(root, 'kernel', 'tests', 'jobs-search-aliases.json')).size);
