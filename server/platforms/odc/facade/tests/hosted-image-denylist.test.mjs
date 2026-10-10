// The hosted image (docker/ssam-server/Dockerfile) ships no client name (owner rule of 2026-10-07: client content may
// ship, client NAMES may not). The image is `COPY . /app` of the build context plus what its stages compile from that same
// context, so the shipped content is exactly the context .dockerignore keeps: this test computes that set the way Docker
// does (moby patternmatcher: patterns relative to the context root, `*` and `?` inside one segment, `**` across segments,
// a match on a parent directory excludes everything under it, `!` re-includes, the last matching pattern wins) and reads
// every file of it, as Latin-1 (UTF-8 text and the names inside binaries both match), against the terms of
// docker/ssam-server/client-denylist.json. It also proves that the list itself, the client captures and the publisher's
// client list stay out.
//
//   node --test tests/hosted-image-denylist.test.mjs            (in platforms/odc/facade)
//   node tests/hosted-image-denylist.test.mjs --list            prints the shipped files that name a client
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..', '..', '..');
const DENYLIST = 'docker/ssam-server/client-denylist.json';

// ---- .dockerignore, as Docker reads it
export function readIgnore(root = ROOT) {
  const text = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8');
  return text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')).map(line => {
    const exclusion = line.startsWith('!');
    let pattern = (exclusion ? line.slice(1).trim() : line).replaceAll('\\', '/');
    pattern = path.posix.normalize(pattern).replace(/^\/+/, '').replace(/\/+$/, '');
    if (pattern === '.') pattern = '';
    return { exclusion, pattern, regex: toRegex(pattern), prefix: pattern.split(/[*?[\\]/)[0].replace(/[^/]*$/, '').replace(/\/$/, '') };
  });
}
function toRegex(pattern) {
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') { i++; out += '(?:.*/)?'; } else out += '.*';
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '[') { const end = pattern.indexOf(']', i); if (end < 0) out += '\\['; else { out += '[' + pattern.slice(i + 1, end).replace(/^!/, '^') + ']'; i = end; } }
    else if (c === '\\') { out += '\\' + (pattern[++i] ?? '\\'); }
    else out += /[.+^${}()|]/.test(c) ? '\\' + c : c;
  }
  return new RegExp(out + '$');
}
// Excluded: the last pattern that matches the path or one of its parent directories decides.
export function excluded(rel, rules) {
  const parents = []; const parts = rel.split('/');
  for (let i = 1; i <= parts.length; i++) parents.push(parts.slice(0, i).join('/'));
  let out = false;
  for (const rule of rules) if (parents.some(p => rule.regex.test(p))) out = !rule.exclusion;
  return out;
}
// A directory can be skipped when it is excluded and no `!` pattern could reach inside it.
const reachable = (dir, rules) => rules.some(r => r.exclusion && (r.prefix === '' || r.prefix.startsWith(dir + '/') || (dir + '/').startsWith(r.prefix + '/') || r.prefix === dir));

// ---- the build context, as Docker sends it
export function contextFiles(root = ROOT, rules = readIgnore(root)) {
  const files = [];
  const walk = rel => {
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const child = rel ? rel + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink()) { if (!excluded(child, rules)) files.push(child); continue; }
      if (entry.isDirectory()) { if (!excluded(child, rules) || reachable(child, rules)) walk(child); continue; }
      if (!excluded(child, rules)) files.push(child);
    }
  };
  walk('');
  return files.sort();
}

export function denylist(root = ROOT) {
  const data = JSON.parse(fs.readFileSync(path.join(root, DENYLIST), 'utf8'));
  return data.terms.map(t => ({ ...t, regex: new RegExp(t.pattern, 'i') }));
}

// Every shipped file that names a client: [{file, term, at}].
export function clientNames(root = ROOT) {
  const terms = denylist(root); const hits = [];
  for (const file of contextFiles(root)) {
    const full = path.join(root, file);
    let text; try { text = fs.readFileSync(full).toString('latin1'); } catch { continue; }
    const name = file;
    for (const t of terms) {
      const inName = t.regex.exec(name); if (inName) { hits.push({ file, term: t.pattern, at: 'path' }); continue; }
      const m = t.regex.exec(text);
      if (m) { const line = text.slice(0, m.index).split('\n').length; hits.push({ file, term: t.pattern, at: `line ${line}: ${text.slice(Math.max(0, m.index - 30), m.index + 40).replace(/\s+/g, ' ')}` }); }
    }
  }
  return hits;
}

test('the denylist, the client captures and the publisher\'s client list never enter the image', () => {
  const rules = readIgnore();
  for (const file of [DENYLIST, '.dockerignore', 'scripts/release/client-content.json', '.env', '.ssam-local.json'])
    assert.equal(excluded(file, rules), true, file + ' must be excluded by .dockerignore');
  const terms = denylist();
  const fixtures = fs.readdirSync(path.join(ROOT, 'kernel', 'tests', 'fixtures'), { recursive: true }).map(f => 'kernel/tests/fixtures/' + String(f).replaceAll('\\', '/'));
  for (const f of fixtures.filter(f => terms.some(t => t.regex.test(path.posix.basename(f))))) assert.equal(excluded(f, rules), true, f + ' names a client and must stay out');
  // what the image needs from the examples: the neutral lane fixture, the examples and their coverage matrices
  for (const file of ['kernel/tests/fixtures/odc/insurance-reactive-r8.oml', 'kernel/tests/fixtures/odc/insurance-reactive-r8.oml.json',
    'kernel/tests/jobs-odc/examples/matriz.json', 'kernel/tests/jobs/examples/matriz.json', 'docs/COBERTURA-EXEMPLOS-ODC.md', 'docs/COBERTURA-EXEMPLOS-O11.md',
    'platforms/odc/facade/ssam.mjs', 'facade/ssam.mjs', 'kernel/src/Anvil.Cli/Anvil.Cli.csproj', 'kernel/tests/fixtures/reactive-ui.oml'])
    assert.equal(excluded(file, rules), false, file + ' must ship');
});

test('the matcher follows Docker: parent directories, ** and the last matching pattern', () => {
  const rules = [{ exclusion: false, pattern: 'a' }, { exclusion: true, pattern: 'a/keep.txt' }, { exclusion: false, pattern: '**/*.oml' }, { exclusion: true, pattern: 'x/**/ok.oml' }]
    .map(r => ({ ...r, regex: toRegex(r.pattern), prefix: r.pattern.split(/[*?[\\]/)[0].replace(/[^/]*$/, '').replace(/\/$/, '') }));
  assert.equal(excluded('a/b/c.txt', rules), true);
  assert.equal(excluded('a/keep.txt', rules), false);
  assert.equal(excluded('b/m.oml', rules), true);
  assert.equal(excluded('m.oml', rules), true);
  assert.equal(excluded('x/y/z/ok.oml', rules), false);
  assert.equal(excluded('x/ok.oml', rules), false);
  assert.equal(excluded('ab/c.txt', rules), false);
});

test('every job the image ships finds its base and producers in the image (a proven example never points at a file left out)', () => {
  const rules = readIgnore(); const shipped = new Set(contextFiles(ROOT, rules)); const missing = [];
  for (const file of [...shipped].filter(f => /^kernel\/tests\/jobs[^/]*\/(?:examples\/)?[^/]+\.json$/.test(f))) {
    let job; try { job = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/^﻿/, '')); } catch { continue; }
    const refs = [];
    const walk = node => { if (Array.isArray(node)) node.forEach(walk); else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) { if ((k === 'base' || k === 'producer') && typeof v === 'string' && /\.(oml|avsig|xif|json)$/i.test(v) && !v.startsWith('job:')) refs.push(v); else walk(v); } };
    walk(job);
    for (const ref of refs) {
      const rel = ref.replaceAll('\\', '/').replace(/^\.\//, '');
      const candidates = [path.posix.join('kernel', rel), path.posix.join(path.posix.dirname(file), rel), path.posix.join('kernel/tests/fixtures', rel)].map(p => path.posix.normalize(p));
      if (!candidates.some(c => shipped.has(c)) && candidates.some(c => fs.existsSync(path.join(ROOT, c)))) missing.push(`${file} -> ${ref}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('no file the image ships names a client', () => {
  const hits = clientNames();
  assert.deepEqual(hits.map(h => `${h.file} [${h.term}] ${h.at}`).slice(0, 60), [], `${hits.length} shipped files name a client`);
});

if (process.argv.includes('--list')) {
  const hits = clientNames();
  for (const h of hits) console.log(`${h.file}\t${h.at}`);
  console.log(`${hits.length} hits in ${new Set(hits.map(h => h.file)).size} files; ${contextFiles().length} files in the context`);
}
