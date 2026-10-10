// Frictions of 2026-10-06, lane a, A1: the team rules through the MCP. AGENTS.md told app sessions to read
// docs/CONHECIMENTO-DO-TIME.md while forbidding file reads, and no tool served it: a session had to ask the user for an
// exception. ssam_reference {kind:"rules"} serves the document (whole, by section, or the 35 rules of OutSystems padrões),
// on both lanes, without the CLI; ssam://guide/rules carries the same text; tools.json routes the kind; AGENTS.md names
// the call, never the file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerSsamReference, REFERENCE_KINDS, rulesAnswer } from '../ssam-reference.mjs';
import { GUIDES, GUIDE_FILES, guideText, readGuide } from '../runtime-guides.mjs';
import { routeTools } from '../tool-routing.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';
import { linked } from './fixtures/o11env-kernel.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const kernel = path.join(repo, 'kernel');
const team = fs.readFileSync(path.join(repo, 'docs', 'CONHECIMENTO-DO-TIME.md'), 'utf8').replace(/^\uFEFF/, '');
const padroes = fs.readFileSync(path.join(repo, 'kernel', 'scripts', 'outsystems_padroes', 'RULES.md'), 'utf8').replace(/^\uFEFF/, '');
const tools = JSON.parse(fs.readFileSync(path.join(repo, 'platforms', 'odc', 'facade', 'catalog', 'tools.json'), 'utf8'));

async function harness(t) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atritos-a-rules-'));
  const run = fakeAnvil({});
  const mcp = await linked(registerSsamReference, { root: kernel, lane: 'ss4', env: { ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1' }, runAnvil: run, outDir });
  t.after(async () => { await mcp.close(); fs.rmSync(outDir, { recursive: true, force: true }); });
  return { run, ask: (lane, kind, query) => mcp.call('ssam_reference', { lane, kind, query }) };
}

test('A1: ssam_reference kind rules returns the team rules document, on both lanes, without the CLI', async t => {
  assert.ok(REFERENCE_KINDS.includes('rules'));
  const h = await harness(t);
  for (const lane of ['o11', 'odc']) {
    const whole = await h.ask(lane, 'rules', 'all');
    assert.equal(whole.ok, true, JSON.stringify(whole));
    assert.equal(whole.text, team, 'the document as the team reads it');
    assert.equal(whole.source, 'docs/CONHECIMENTO-DO-TIME.md');
    assert.deepEqual(whole.sections.map(s => s.id), ['1', '2', '3']);
    assert.equal(whole.sections[0].title, 'Como trabalhar');
  }
  assert.equal(h.run.calls.length, 0, 'no CLI');
});

test('A1: a section by number or heading words, a lesson by its heading, and the 35 rules of OutSystems padrões', async t => {
  const h = await harness(t);
  const lessons = await h.ask('odc', 'rules', '3');
  assert.equal(lessons.ok, true);
  assert.deepEqual(lessons.section, [{ id: '3', title: 'Lições da plataforma' }]);
  assert.ok(lessons.text.startsWith('## 3. Lições da plataforma'));
  assert.ok(team.includes(lessons.text.trim()));
  const byWords = await h.ask('o11', 'rules', { section: 'como trabalhar' });
  assert.deepEqual(byWords.section.map(s => s.id), ['1']);
  const lesson = await h.ask('o11', 'rules', 'Changed Attributes');
  assert.equal(lesson.ok, true, JSON.stringify(lesson));
  assert.match(lesson.text, /^### O11: entidade com "Changed Attributes"/);
  const rules = await h.ask('odc', 'rules', 'padroes');
  assert.equal(rules.ok, true); assert.equal(rules.doc, 'padroes'); assert.equal(rules.text, padroes);
  assert.equal(rules.source, 'kernel/scripts/outsystems_padroes/RULES.md');
  const missing = await h.ask('odc', 'rules', 'nada disso existe');
  assert.equal(missing.ok, false); assert.equal(missing.code, 'RULES_SECTION_NOT_FOUND');
  assert.deepEqual(missing.continuation.arguments, { lane: 'odc', kind: 'rules', query: 'all' });
  assert.deepEqual(missing.sections.map(s => s.id), ['1', '2', '3']);
  assert.equal((await h.ask('odc', 'rules', { doc: 'outro' })).code, 'BAD_VALUE');
  assert.equal((await h.ask('odc', 'rules', { page: 1 })).code, 'UNKNOWN_FIELD');
  assert.equal(h.run.calls.length, 0, 'no CLI');
  // Pure form: the reader is injectable (a release reads the bundled text).
  assert.equal(rulesAnswer('o11', 'all', { read: topic => '# ' + topic + '\n\n## 1. Um\n\ntexto\n' }).sections[0].title, 'Um');
});

test('A1: the ssam://guide/rules and ssam://guide/padroes resources carry the same text', () => {
  assert.equal(GUIDE_FILES.rules, 'docs/CONHECIMENTO-DO-TIME.md');
  assert.equal(GUIDE_FILES.padroes, 'kernel/scripts/outsystems_padroes/RULES.md');
  for (const [topic, text] of [['rules', team], ['padroes', padroes]]) {
    const entry = GUIDES.find(g => g.topic === topic);
    assert.ok(entry, topic);
    assert.equal(entry.uri, 'ssam://guide/' + topic);
    assert.equal(readGuide(entry.uri).contents[0].text, text);
    assert.equal(guideText(topic), text);
  }
});

test('A1: tools.json routes kind rules, and the team rules intents reach it on both lanes', () => {
  const verb = tools.tools.ssam_reference.verbs.rules;
  assert.ok(verb, 'route ssam_reference.rules');
  assert.equal(verb.field, 'kind'); assert.equal(verb.value, 'rules'); assert.equal(verb.selector, 'enum');
  assert.equal(verb.args.kind, 'rules');
  for (const intent of ['quais são as regras do time', 'lições da plataforma aprendidas', 'what are the team rules', 'ler as regras do time antes de gerar o módulo'])
    for (const lane of ['odc', 'o11']) {
      const top = routeTools({ intent, lane }).tools[0];
      assert.equal(top?.tool + '.' + top?.verb, 'ssam_reference.rules', lane + ': ' + intent);
    }
  // The guardrails of the ODC agents keep their own route (they use the words regra/rules too).
  assert.equal(routeTools({ intent: 'regras de guardrail do agente', lane: 'odc' }).tools[0]?.verb, 'agents.guardrails');
});

test('A1: AGENTS.md names the MCP call for the team rules and no file an app session would have to read', () => {
  const agents = fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8');
  const appPart = agents.split(/\r?\n/).filter(line => !/^Sessão que desenvolve o SSAM/.test(line)).join('\n');
  assert.doesNotMatch(appPart, /CONHECIMENTO-DO-TIME/);
  assert.doesNotMatch(appPart, /`[^`\s]*\.md`/, 'no markdown file for app sessions');
  assert.match(appPart, /ssam_reference \{lane, kind:"rules", query:"all"\}/);
  assert.match(appPart, /query:"padroes"/);
});

test('A1: the served rules send an app session to MCP tools only, never to a CLI or script', () => {
  for (const [name, text] of [['team', team], ['padroes', padroes]]) {
    assert.doesNotMatch(text, /\banvil(?:\.dll)?\s+(?:inspect|refresh-refs|merge-probe|api|functions)\b/, name);
    assert.doesNotMatch(text, /\.ps1\b|\.py\b|\bpython\b/, name);
    assert.doesNotMatch(text, /`ssam (?:job|deliver|inspect|map)`/, name);
  }
  assert.match(team, /ssam_reference \{lane:"<lane>", kind:"rules", query:"padroes"\}/, 'the 35 rules by the MCP call');
});
