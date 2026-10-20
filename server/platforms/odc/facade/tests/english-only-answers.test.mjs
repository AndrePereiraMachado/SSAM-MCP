import './fixtures/isolated-profile.mjs';
// English-only guard, lane B (owner rule 15/10/2026, "tudo deveria ser em inglês.. todos os textos"): every text SSAM
// emits is English. Static half: every string literal of the modules that build answers (the facade, the Portal runtime,
// the root launcher and the kernel C#) and every served document is scanned for Portuguese (Portuguese accents and
// common Portuguese words, tests/fixtures/portuguese-text.mjs). The dynamic half (the tool listing and the server
// instructions of every profile) is english-only-listing.test.mjs.
// What is not emitted stays as it is, declared below with its reason: input vocabulary (the Portuguese words of the
// user's request, of a Studio dialog or of a Service Center page, matched and never answered), the owner's internal
// reports, and the module texts a user asks for in Portuguese (language:"pt"). Error codes are the contract and file
// names are names: neither counts as prose.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { portugueseLiterals, portugueseIn } from './fixtures/portuguese-text.mjs';
import { LIMIT_TYPES, LIMIT_VERDICTS } from '../limit-values.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const rel = file => path.relative(root, file).replace(/\\/g, '/');
const SCANNED = ['platforms/odc/facade', 'platforms/odc/portal/runtime', 'facade', 'kernel/src', 'platforms/odc/studio'];
const SKIP_DIRS = new Set(['tests', 'node_modules', 'bin', 'obj']);

// Files whose Portuguese never reaches a licensee, each with its reason.
const NOT_EMITTED = Object.freeze({
  'platforms/odc/facade/coverage-inventory.mjs': 'generator of the owner\'s internal coverage report (internal reports stay pt-BR)',
  'platforms/odc/facade/debug-final-matrix.mjs': 'generator of the owner\'s internal debugger matrix report under .local/debugger (internal reports stay pt-BR)',
  'kernel/src/Anvil.Core/Kernel/EntityActionsExpander.cs': 'module descriptions in Portuguese only behind language:"pt", the user\'s choice of the language of his own module (L(en, pt) pairs; en by default)',
  'kernel/src/Anvil.Core/Kernel/ScreenGenerator.cs': 'screen labels in Portuguese only behind texts:"pt", the user\'s choice (en by default), plus Portuguese name matching of the user\'s entities',
  'kernel/src/Anvil.Core/Recipes/TemporadaRecipe.cs': 'internal demonstration recipe (the owner\'s Portuguese demo app), never run by a tool',
  'kernel/src/Anvil.Core/Recipes/VacationRentalRecipe.cs': 'internal demonstration recipe, never run by a tool',
  'kernel/src/Anvil.Core/Kernel/EntityActionsBattery.cs': 'internal proof battery (fixture names of the owner\'s proofs)',
  'kernel/src/Anvil.Core/Kernel/DataDdlBattery.cs': 'internal proof battery (fixture names of the owner\'s proofs)',
  'kernel/src/Anvil.Core/Kernel/ProofGenerator.cs': 'generator of the owner\'s internal proof document',
  'kernel/src/Anvil.Core/Kernel/UiGallery.cs': 'generator of the owner\'s internal widget gallery document',
  'platforms/odc/studio/builder/features/RotaSegura.cs': 'a demonstration C# feature of the builder (the owner\'s sample route, its own Portuguese module texts), never run by a tool',
  'kernel/src/Anvil.Core/Kernel/UiCatalogDocs.cs': 'generator of the developer documents under kernel/docs/ui (400 files no tool serves; ui-block answers come from the catalog JSON), regenerated only from the Studio libraries',
  'kernel/src/Anvil.Core/Kernel/Prototype/PrototypeLogic.cs': 'the Portuguese labels it writes only for a prototype written in Portuguese (_p.Pt: the language of the user\'s own prototype; English otherwise), and the Portuguese labels of the prototype it recognizes',
  'platforms/odc/facade/cli-flags.mjs': 'the closed list of the flag names SSAM\'s own command lines accept, generated from their sources (some owner scripts name theirs in Portuguese): identifiers the licensee rule matches, never emitted',
});

// Input vocabulary: in these files the word lists (letters, spaces, commas, bars, parentheses) are the Portuguese words
// of a request, a Studio dialog, a Service Center page or a prototype, matched and never emitted. Any other Portuguese
// literal in them is still refused.
const VOCABULARY = Object.freeze({
  'platforms/odc/facade/text-routes.mjs': 'synonyms of the user\'s Portuguese requests (text routes)',
  'platforms/odc/facade/tool-routing.mjs': 'Portuguese stopwords and verbs of the user\'s requests (tool routing)',
  'platforms/odc/facade/catalog.mjs': 'Portuguese stopwords and verbs of the user\'s requests (catalog search)',
  'platforms/odc/facade/discovery.mjs': 'Portuguese stopwords and synonyms of the user\'s requests (discovery)',
  'platforms/odc/facade/work-packet.mjs': 'Portuguese words of the user\'s requests (work packet topics)',
  'platforms/odc/facade/osui-catalog.mjs': 'Portuguese words of the user\'s requests (OutSystems UI catalog search)',
  'platforms/odc/facade/environment-components.mjs': 'Portuguese words of the user\'s requests (installed components)',
  'platforms/odc/facade/ssam-reference.mjs': 'Portuguese stopwords and query words of the user\'s requests',
  'platforms/odc/portal/runtime/portal-capabilities.mjs': 'Portuguese stopwords of the user\'s requests (Portal capability search)',
  'platforms/odc/facade/responses.mjs': 'Portuguese stopwords of the shell hints of older texts it rewrites into MCP calls',
  'platforms/odc/facade/service-center/client.mjs': 'labels of the Portuguese Service Center pages it reads ("próxima")',
  'platforms/odc/facade/service-center/html.mjs': 'the HTML entity names it decodes (&para;)',
  'platforms/odc/facade/bridge-stall.mjs': 'the caption of the Portuguese Studio error dialog it recognizes ("Erro inesperado")',
  'platforms/odc/facade/prototype/names.mjs': 'Portuguese labels of the user\'s prototype it recognizes',
  'kernel/src/Anvil.Core/Kernel/OperationDialogs.cs': 'captions of the Portuguese Studio dialogs it recognizes ("Erro inesperado", "Fechar")',
  'kernel/src/Anvil.Core/Kernel/CommandSurface.cs': 'Portuguese stopwords of the user\'s requests',
  'kernel/src/Anvil.Core/Kernel/Prototype/PrototypeBind.cs': 'Portuguese labels of the user\'s prototype it recognizes',
  'kernel/src/Anvil.Core/Kernel/Prototype/PrototypeBindDiscovery.cs': 'Portuguese labels of the user\'s prototype it recognizes',
  'kernel/src/Anvil.Core/Kernel/Prototype/PrototypeData.cs': 'Portuguese labels of the user\'s prototype it recognizes',
  'kernel/src/Anvil.Core/Kernel/Prototype/PrototypeDialect.cs': 'Portuguese labels of the user\'s prototype it recognizes',
  'kernel/src/Anvil.Core/Kernel/Prototype/PrototypeExpander.cs': 'Portuguese labels of the user\'s prototype it recognizes',
  'kernel/src/Anvil.Core/Kernel/Prototype/PrototypeNames.cs': 'Portuguese labels of the user\'s prototype it recognizes',
  'kernel/src/Anvil.Core/Kernel/Prototype/PrototypeSql.cs': 'Portuguese labels of the user\'s prototype it recognizes',
  'kernel/src/Anvil.Core/Kernel/Prototype/PrototypeWidgets.cs': 'Portuguese labels of the user\'s prototype it recognizes',
  // servidor/fase4-26 (a7): the server line's own modules.
  'kernel/src/Anvil.Core/Kernel/EnvironmentCut.cs': 'the Portuguese .NET network errors (a Windows in Portuguese) it recognizes in a Studio call the environment cut (prazos B); never emitted',
  // fase4-26/a8-agent round 3: the thin bridge's copy of the product's family-D rule (OperationDialogs.cs).
  'kernel/src/Anvil.Bridge.Thin/ManageDependencies.cs': 'captions of the Portuguese Studio dialogs it recognizes ("Erro inesperado", "Fechar"), the same as OperationDialogs.cs',
});
const vocabularyShaped = text => /^[\p{L}\s,|()'-]+$/u.test(text);

// Literals that are no Portuguese prose (the exact text, or its start), each with its reason.
const ALLOWED = Object.freeze([
  { file: 'platforms/odc/facade/prototype/archive.mjs', prefix: 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ', why: 'the CP850 and CP437 decoding tables of zip file names (characters, not text)' },
  { file: 'platforms/odc/facade/prototype/archive.mjs', prefix: '└┴┬├─┼ãÃ', why: 'the CP850 decoding table of zip file names (characters, not text)' },
  { file: 'platforms/odc/facade/prototype/effects.mjs', text: 'aviso', why: 'internal key of the notice state the prototype importer derives (an identifier, never shown)' },
  { file: 'platforms/odc/facade/prototype/shell.mjs', text: 'aviso', why: 'internal key of the notice state the prototype importer derives (an identifier, never shown)' },
  { file: 'platforms/odc/facade/prototype/store.mjs', text: 'ao', why: 'the singular of a Portuguese plural (-oes/-aes) of the user\'s prototype names (input stemming)' },
  { file: 'platforms/odc/facade/service-center/html.mjs', prefix: 'nbsp iexcl cent pound', why: 'the HTML entity names it decodes (&para; is not the Portuguese "para")' },
  { file: 'platforms/odc/facade/destructive-operations.mjs', text: '<palavras do usuário>', why: 'input alias: the words marker of the releases before 16/10 (WORDS_ECHO_ALIASES), recognized in a replayed continuation and refused as words, never written by an answer' },
  // servidor/fase4-26 (a7): the server line's own modules. The deliv codes of the quality record (ssam-quality/1, the
  // contract the owner's console reads) are codes on the server's disk, never in an answer; the record maps both the
  // English and the older Portuguese delivery results to them.
  { file: 'platforms/odc/facade/quality-line.mjs', text: 'entregue', why: 'deliv code of the quality record contract (quality-line.mjs DELIV, read by the owner\'s console), never in an answer' },
  { file: 'platforms/odc/facade/quality-line.mjs', text: 'entregue-publicado', why: 'deliv code of the quality record contract (quality-line.mjs DELIV, read by the owner\'s console), never in an answer' },
  { file: 'platforms/odc/facade/quality-record.mjs', text: 'entregue', why: 'the older Portuguese delivery result read back (input alias) and the deliv code of the record, never in an answer' },
  { file: 'platforms/odc/facade/quality-record.mjs', text: 'entregue-publicado', why: 'deliv code of the quality record (quality-line.mjs DELIV), never in an answer' },
  // The four values of the hosted network check are English since the owner's decision of 2026-10-19 (paths[].status good |
  // slow | losing, the exit key unknown; they were boa | lenta | perde | desconhecida): no entry is left for them here. The
  // input alias of an older answer's exit (hosted/network-check.mjs LEGACY_UNKNOWN_EXIT) is declared by
  // hosted-answers-english.test.mjs. The markers of withheld data are English since phase 3 of the a7 line (<server>,
  // <customer omitted>, <fixture omitted>).
]);
const allowed = (name, text) => ALLOWED.some(a => a.file === name && (a.text !== undefined ? a.text === text : text.startsWith(a.prefix)));

// Served documents (ssam_reference kind rules, padroes and the guides resources).
const SERVED_DOCS = Object.freeze(['docs/CONHECIMENTO-DO-TIME.md', 'kernel/scripts/outsystems_padroes/RULES.md',
  'platforms/odc/facade/guides/lifecycle.md', 'platforms/odc/facade/guides/o11.md', 'platforms/odc/facade/guides/odc.md']);

// Areas still to translate (declared, each with its reason): each must still hold Portuguese, so a translated one leaves
// the list. A text entry skips every literal that contains it.
const PENDING = Object.freeze([
  { file: 'platforms/odc/studio/bridge/StartupHook.cs', why: 'the ODC bridge DLL: a loaded DLL is never replaced, so its three texts change only with a new bridge version (its "Fechar" is the caption of a Portuguese Studio dialog it recognizes)' },
]);
const PENDING_TEXTS = Object.freeze([
]);

function sources() {
  const out = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p); }
      else if (/\.(mjs|js|cs)$/.test(e.name) && !/\.test\.mjs$/.test(e.name)) out.push(p);
    }
  };
  for (const d of SCANNED) walk(path.join(root, d));
  return out;
}

function findings() {
  const out = [];
  for (const file of sources()) {
    const name = rel(file);
    if (Object.hasOwn(NOT_EMITTED, name) || PENDING.some(p => p.file === name)) continue;
    for (const hit of portugueseLiterals(file)) {
      if (Object.hasOwn(VOCABULARY, name) && vocabularyShaped(hit.text)) continue;
      if (allowed(name, hit.text) || PENDING_TEXTS.some(p => hit.text.includes(p.text))) continue;
      out.push(name + ':' + hit.line + ' [' + hit.words.slice(0, 4).join(' ') + '] ' + hit.text.slice(0, 120).replace(/\s+/g, ' '));
    }
  }
  return out;
}

// Served data: the discovery capabilities, the tool catalog and its fragments, the packet examples and the proven examples
// ssam_reference {kind:"example"} serves whole (kernel/tests/jobs*/examples; the jobs of the suites it also serves,
// kernel/tests/jobs and jobs-odc, are not covered yet). The fields that hold
// the words of the user's request (keywords, synonyms, intents, triggers, fillers, compounds, slot words, the words that
// exclude a route) are input vocabulary; origin names the source file of a fact.
const SERVED_JSON_DIRS = ['platforms/odc/facade', 'platforms/odc/facade/catalog', 'platforms/odc/portal/catalog', 'kernel/tests/jobs/examples', 'kernel/tests/jobs-odc/examples'];
const JSON_INPUT_FIELD = /\/(keywords|synonyms|intents|triggers|fillers|compounds|slotSkip|modelGuard|without|origin|_doc)(\/|$)/;
const JSON_NOT_EMITTED = Object.freeze({
  'platforms/odc/facade/outsystems-ui/odc-outsystemsui-signatures.json': 'the OutSystems UI library\'s own input descriptions (third-party text, read from the library)',
  'platforms/odc/facade/rules-search-aliases.json': 'search-only aliases (review F2): the Portuguese team rules and standards of 8689de53, matched against the words of a request (search-aliases.mjs) and never served (english-only-rules-search.test.mjs)',
});
// Served values still to translate (declared, each with its reason): none.
const JSON_PENDING = Object.freeze([
]);
function servedJson() {
  const out = [];
  const walk = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p); } else if (e.name.endsWith('.json')) out.push(p); } };
  for (const d of SERVED_JSON_DIRS) { const dir = path.join(root, d); if (d.endsWith('facade')) { for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) out.push(path.join(dir, f)); } else walk(dir); }
  out.push(...fs.readdirSync(path.join(root, 'platforms/odc/facade/outsystems-ui')).filter(f => f.endsWith('.json')).map(f => path.join(root, 'platforms/odc/facade/outsystems-ui', f)));
  return [...new Set(out)];
}
function jsonFindings() {
  const out = [];
  for (const file of servedJson()) {
    const name = rel(file);
    if (Object.hasOwn(JSON_NOT_EMITTED, name)) continue;
    let value; try { value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { continue; }
    const visit = (v, at) => {
      if (typeof v === 'string') {
        if (JSON_INPUT_FIELD.test(at) || JSON_PENDING.some(p => p.pointer.test(at)) || PENDING_TEXTS.some(p => v.includes(p.text))) return;
        const pt = portugueseIn(v); if (pt) out.push(name + '#' + at + ' [' + pt.words.slice(0, 4).join(' ') + '] ' + v.slice(0, 100).replace(/\s+/g, ' '));
      } else if (Array.isArray(v)) v.forEach((x, i) => visit(x, at + '/' + i));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) visit(x, at + '/' + k);
    };
    visit(value, '');
  }
  return out;
}

function documentFindings() {
  const out = [];
  for (const doc of SERVED_DOCS) {
    if (PENDING.some(p => p.file === doc)) continue;
    let fenced = false;
    fs.readFileSync(path.join(root, doc), 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (/^\s*```/.test(line)) { fenced = !fenced; return; }
      if (fenced) return;
      const pt = portugueseIn(line);
      if (pt) out.push(doc + ':' + (i + 1) + ' [' + pt.words.slice(0, 4).join(' ') + '] ' + line.slice(0, 120));
    });
  }
  return out;
}

// ---- The other served sources (review english-junction round 1, F1): every source an answer can carry.
// 1. The suite jobs. ssam_discover (relatedJobs, matches[].notes, the :evidence expansion), the job guidance (declaredIn),
//    ssam_reference {kind:"recipe"|"example"} and the package's runtime data carry their prose fields: the description, the
//    _why of an op, the why of an expected message or of a lab flag. Every other value is the test app's own data (names,
//    labels, messages, html) and stays as data; so does a quoted citation of the app's own text ('Abrir o Contact') or a
//    [Name] of it inside the prose. The examples folders are the served data above (every value).
const SUITE_JOB_DIRS = ['kernel/tests/jobs', 'kernel/tests/jobs-odc', 'kernel/tests/jobs-negative', 'kernel/tests/jobs-odc-negative'];
export const JOB_PROSE = Object.freeze([/^\/description$/, /\/_why$/, /^\/expectedMessages\/\d+\/why$/, /\/allowSoapWithoutImport\/why$/]);
const withoutCitations = text => text.replace(/(^|[\s(:,=])'[^'\n]+'(?=[\s.,;:)!?]|$)|(^|[\s(:,=])"[^"\n]+"(?=[\s.,;:)!?]|$)|\[[^\]\n]+\]/g, ' ');
function suiteJobFiles() {
  const out = [];
  const walk = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { if (e.name !== 'examples' && !SKIP_DIRS.has(e.name)) walk(p); } else if (e.name.endsWith('.json')) out.push(p); } };
  for (const d of SUITE_JOB_DIRS) walk(path.join(root, d));
  return out;
}
export function jobProseFindings(files = suiteJobFiles()) {
  const out = [];
  for (const file of files) {
    let value; try { value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { continue; }
    const visit = (v, at) => {
      if (typeof v === 'string') { if (JOB_PROSE.some(r => r.test(at))) { const pt = portugueseIn(withoutCitations(v)); if (pt) out.push(rel(file) + '#' + at + ' [' + pt.words.slice(0, 4).join(' ') + '] ' + v.slice(0, 100).replace(/\s+/g, ' ')); } }
      else if (Array.isArray(v)) v.forEach((x, i) => visit(x, at + '/' + i));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) visit(x, at + '/' + k);
    };
    visit(value, '');
  }
  return out;
}
// 2. The limits of kernel/docs/NAO-DA.md, as discovery.mjs loadLimits serves them (the job guidance, the package's
//    runtime data): title, section, type, verdict and where it was seen. The body of the document is not served.
//    The type tag and the verdict are values: each one of the English set (limit-values.mjs), the label "Seen in:".
export function limitFindings(text = fs.readFileSync(path.join(root, 'kernel/docs/NAO-DA.md'), 'utf8')) {
  const out = []; let inLimit = false;
  const say = (i, why, line) => out.push('kernel/docs/NAO-DA.md:' + (i + 1) + ' [' + why + '] ' + line.slice(0, 110));
  text.split(/\r?\n/).forEach((line, i) => {
    const prose = line.startsWith('## ') ? line.slice(3) : line.startsWith('### ') ? line.slice(4) : /^\s*(Visto em|Seen in):/i.test(line) ? line.replace(/^\s*(Visto em|Seen in):\s*/i, '') : null;
    if (line.startsWith('### ')) inLimit = true; else if (line.startsWith('## ')) inLimit = false;
    // A quoted citation of a source's own words ('Tipos que NAO existem no ODC') is data, as in the jobs.
    if (prose !== null) { const pt = portugueseIn(withoutCitations(prose)); if (pt) say(i, pt.words.slice(0, 4).join(' '), line); }
    if (/^\s*Visto em:/i.test(line)) say(i, 'label Visto em', line);
    const tag = /^`([a-z-]+)`\s*$/.exec(line.trim()); if (tag && inLimit && !LIMIT_TYPES.has(tag[1])) say(i, 'type ' + tag[1], line);
    const verdict = /^>\s*\*\*?([A-Z][A-Z ]+[A-Z])\*\*/.exec(line.trim()); if (verdict && inLimit && !LIMIT_VERDICTS.has(verdict[1])) say(i, 'verdict ' + verdict[1], line);
  });
  return out;
}
// 3. The recipe table of kernel/AGENTS.md (ssam_reference {kind:"recipe"} on O11, CommandSurface.Recipes, and the package's
//    runtime data): its header and every row.
export const RECIPE_HEADERS = Object.freeze(['| Task |', '| Tarefa |']);
export function recipeTableFindings(text = fs.readFileSync(path.join(root, 'kernel/AGENTS.md'), 'utf8')) {
  const lines = text.split(/\r?\n/); const start = lines.findIndex(l => RECIPE_HEADERS.some(h => l.startsWith(h)));
  if (start < 0) return ['kernel/AGENTS.md: no recipe table'];
  const out = [];
  for (let i = start; i < lines.length && lines[i].startsWith('|'); i++) { const pt = portugueseIn(lines[i]); if (pt) out.push('kernel/AGENTS.md:' + (i + 1) + ' [' + pt.words.slice(0, 4).join(' ') + '] ' + lines[i].slice(0, 110)); }
  return out;
}
// 4. The scripts the facade runs and whose texts reach the person: the credential windows and helpers (.ps1) and the app
//    session's Python hook. Their string literals (comment lines aside).
export const EXECUTED_SCRIPTS = Object.freeze(['scripts/credential-profiles.ps1', 'platforms/odc/facade/debug-app-user-vault.ps1', 'platforms/odc/facade/debug-invoke-vault.ps1',
  'kernel/scripts/service_center/windows-o11-credential.ps1', 'platforms/odc/portal/runtime/windows-api-client-credential.ps1',
  'platforms/odc/portal/runtime/windows-credential-prompt.ps1', 'platforms/odc/portal/runtime/windows-portal-credential.ps1', 'kernel/scripts/ssam_app.py']);
export function scriptFindings(files = EXECUTED_SCRIPTS) {
  const out = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(root, f), 'utf8').split(/\r?\n/);
    lines.forEach((l, i) => {
      if (/^\s*#/.test(l)) return;
      for (const m of l.matchAll(/'((?:[^']|'')*)'|"((?:[^"`\\]|`.|\\.)*)"/g)) { const t = m[1] ?? m[2] ?? ''; const pt = portugueseIn(t.replace(/`[rnt]/g, ' ')); if (pt) out.push(f + ':' + (i + 1) + ' [' + pt.words.slice(0, 4).join(' ') + '] ' + t.slice(0, 100)); }
    });
  }
  return out;
}

test('english-only (F1): the prose of every served suite job is English (description, _why, expected-message why)', () => {
  const found = jobProseFindings();
  assert.deepEqual(found, [], found.length + ' Portuguese job texts:\n' + found.slice(0, 60).join('\n'));
});

test('english-only (F1): the limits NAO-DA.md serves and the O11 recipe table are English', () => {
  const found = [...limitFindings(), ...recipeTableFindings()];
  assert.deepEqual(found, [], found.length + ' Portuguese lines:\n' + found.slice(0, 60).join('\n'));
});

test('english-only (F1): the scripts the facade runs (credential windows, helpers, the app hook) are English', () => {
  for (const f of EXECUTED_SCRIPTS) assert.ok(fs.existsSync(path.join(root, f)), 'declared script is gone: ' + f);
  const found = scriptFindings();
  assert.deepEqual(found, [], found.length + ' Portuguese literals:\n' + found.join('\n'));
});

test('english-only (F1): each new family check sees Portuguese (one planted text per family)', () => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'english-f1-'));
  try {
    const job = path.join(tmp, 'j.json');
    fs.writeFileSync(job, JSON.stringify({ description: 'Entidade com atributos; o job nao cria nada.', ops: [{ op: 'spec', _why: 'Ok.', data: { label: 'Nome do cliente' } }], expectedMessages: [{ id: 'X', why: 'The action is unused on purpose.' }] }));
    assert.equal(jobProseFindings([job]).length, 1, 'a Portuguese description is seen; the app label (data) is not');
    fs.writeFileSync(job, JSON.stringify({ description: "The button 'Abrir o Contact' opens the detail; [Nome] is refused." }));
    assert.equal(jobProseFindings([job]).length, 0, 'a quoted citation of the app and a [Name] are data');
    assert.equal(limitFindings('## Limites que a plataforma recusa\n### A tela nao abre\n`armadilha`\n> **CONFIRMADO** (2026)\nSeen in: tests/jobs/x.json (medido no proprio job)\n').length, 5);
    assert.equal(recipeTableFindings('| Task | When |\n|---|---|\n| Entidade | Quando o dado e persistido |\n').length, 1);
    const ps1 = path.join(tmp, 'w.ps1'); fs.writeFileSync(ps1, "$b.Text='Cancel'; $l.Text=\"Escolha um perfil ou adicione uma credencial.\"\n# comentario em portugues\n");
    assert.equal(scriptFindings([path.relative(root, ps1)]).length, 1, 'the Portuguese literal of a script is seen; a comment is not');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('english-only: no string literal of an answer module is Portuguese', () => {
  const found = findings();
  assert.deepEqual(found, [], found.length + ' Portuguese literals:\n' + found.join('\n'));
});

test('english-only: the served data (discovery capabilities, tool catalog, packet examples) is English', () => {
  const found = jsonFindings();
  assert.deepEqual(found, [], found.length + ' Portuguese values:\n' + found.join('\n'));
});

test('english-only: the documents ssam_reference serves are English', () => {
  const found = documentFindings();
  assert.deepEqual(found, [], found.length + ' Portuguese lines:\n' + found.join('\n'));
});

test('english-only: every declared exception still names a real file and every pending area still holds Portuguese', () => {
  const names = new Set(sources().map(rel));
  for (const file of [...Object.keys(NOT_EMITTED), ...Object.keys(VOCABULARY), ...ALLOWED.map(a => a.file), ...PENDING.map(p => p.file)]) assert.ok(names.has(file) || SERVED_DOCS.includes(file), 'declared file is gone: ' + file);
  for (const a of ALLOWED) assert.ok(portugueseLiterals(path.join(root, a.file)).some(h => allowed(a.file, h.text)), 'allowed literal is gone (remove it): ' + a.file + ' ' + (a.text ?? a.prefix));
  for (const { file: area } of PENDING) {
    const file = path.join(root, area);
    const left = area.endsWith('.md') ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => portugueseIn(l)).length : portugueseLiterals(file).length;
    assert.ok(left > 0, 'pending area is English now (remove it from PENDING): ' + area);
  }
  for (const { text } of PENDING_TEXTS) assert.ok(sources().some(f => portugueseLiterals(f).some(h => h.text.includes(text))), 'pending text is gone (remove it): ' + text);
});

test('english-only: the detector sees Portuguese and lets English, codes and file names pass', () => {
  for (const pt of ['entregue', 'entregue e publicado', 'fechada', 'feito', 'nada a atualizar', '<palavras do usuário>', '<servidor>',
    'o Service Studio estava ocupado; nada foi enviado', 'Cancelar a espera não para a obra.', 'job sem \'ops\' nem \'jobs\'',
    'Unexpected X @ Y: corrija ou declare em expectedMessages com why', 'Remova o elemento ou use-o.'])
    assert.ok(portugueseIn(pt), 'Portuguese not seen: ' + pt);
  for (const en of ['delivered', 'delivered and published', 'the Service Studio was busy; nothing was sent', 'STUDIO_NOT_OPEN',
    'docs/CONHECIMENTO-DO-TIME.md', 'see docs/O11-DADOS-HEADLESS.md', 'do no harm', 'as of today', 'the TODOs list', 'Pedido_CS.Id'])
    assert.equal(portugueseIn(en), null, 'English seen as Portuguese: ' + en);
});
