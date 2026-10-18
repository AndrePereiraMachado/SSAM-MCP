import './fixtures/isolated-profile.mjs';
// English-only, the search half (review english-junction round 1, F2): the team rules and the standards are English
// since 15/10/2026, but the words of a request are input, never emitted text. A Portuguese request finds the same rule it
// found on 8689de53 (the candidate before the translation): ssam_reference {kind:"rules"} searches the English headings
// and text and, as a search-only alias, the Portuguese ones of 8689de53 at the same place (rules-search-aliases.json);
// the work packet reads the Portuguese technique words of an intent in English (search-aliases.mjs). Answers stay English.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rulesAnswer } from '../ssam-reference.mjs';
import { rulesSection } from '../work-packet.mjs';
import { portugueseIn } from './fixtures/portuguese-text.mjs';

// What each query found on 8689de53 (its own search over its Portuguese documents), named by the English unit at the
// same place: section id and title.
const ON_8689DE53 = {
  'tela': { matchedIn: 'heading', section: [['3', 'List: partial refresh without reloading the screen']] },
  'subagentes': { matchedIn: 'heading', section: [['1', 'Subagents: discovery before the task']] },
  'acesso a dados': { matchedIn: 'heading', section: [['3', 'Data access: one query with a join, never a query inside a loop']] },
  'merge direto': { matchedIn: 'heading', section: [['3', 'Direct OML merge through the bridge']] },
  'regra de escopo': { matchedIn: 'text', section: [['2', 'OutSystems implementation standards']] },
  'Como trabalhar': { matchedIn: 'heading', section: [['1', 'How to work']] },
  'varios agentes': { matchedIn: 'heading', section: [['1', 'Several agents in the same Studio: one module per agent']] },
  'licoes da plataforma': { matchedIn: 'heading', section: [['3', 'Platform lessons']] },
  'prototipo aprovado': { matchedIn: 'heading', section: [['3', 'Approved prototype: port it 1:1']] },
  'republicar consumidores': { matchedIn: 'heading', section: [['3', 'O11: republish the consumers after the producer']] },
  'lambda': { matchedIn: 'heading', section: [['3', 'ODC (client) and O11 (server): list action lambda only with a direct attribute']] },
  'agenda de timer': { matchedIn: 'heading', section: [['3', 'O11: timer schedule as text']] },
  // servidor/fase4-26 a7: the server line's team rules say how a hosted job travels (inline), so the section at that place
  // has the line's own heading.
  'jobs em arquivo': { matchedIn: 'heading', section: [['1', 'Jobs in a file (local) and inline (hosted)']] },
  'mudanca de fachada': { matchedIn: 'heading', section: [['1', 'Facade change: when to reconnect the MCP']] },
  'padroes de implementacao': { matchedIn: 'heading', section: [['2', 'OutSystems implementation standards']] },
  'HTML': { matchedIn: 'text', section: [['1', 'Subagents: discovery before the task'], ['3', 'Approved prototype: port it 1:1']] },
  'consulta dentro de laco': { matchedIn: 'heading', section: [['3', 'Data access: one query with a join, never a query inside a loop']] },
  'descricao': { matchedIn: 'text', section: [['1', 'Subagents: discovery before the task']] },
};

test('rules search: each of the 18 Portuguese queries finds the rule it found on 8689de53, and the answer is English', () => {
  const wrong = [];
  for (const [query, want] of Object.entries(ON_8689DE53)) for (const lane of ['o11', 'odc']) {
    const a = rulesAnswer(lane, query);
    const got = a.ok ? { matchedIn: a.matchedIn ?? 'heading', section: a.section.map(s => [s.id, s.title]) } : { refused: a.code ?? a.refusal?.code ?? 'refused' };
    // The rule it found on 8689de53 is found (a heading hit now may also be the English heading of another unit: never fewer).
    const found = want.section.every(([id, title]) => (got.section ?? []).some(([i, t]) => i === id && t === title));
    if (!found) wrong.push(lane + ' ' + JSON.stringify(query) + ' -> ' + JSON.stringify(got) + ', on 8689de53 ' + JSON.stringify(want));
    else if (a.text && portugueseIn(a.section.map(s => s.title).join(' '))) wrong.push(lane + ' ' + query + ': a Portuguese title was served');
  }
  assert.deepEqual(wrong, [], wrong.length + ' queries:\n' + wrong.join('\n'));
});

test('rules search: the English query of each rule still finds it, and the alias never reaches an answer', () => {
  for (const [query, title] of [['screen', 'List: partial refresh without reloading the screen'], ['subagents', 'Subagents: discovery before the task'],
    ['data access', 'Data access: one query with a join, never a query inside a loop'], ['How to work', 'How to work'], ['timer schedule', 'O11: timer schedule as text']]) {
    const a = rulesAnswer('odc', query);
    assert.equal(a.ok, true, query);
    assert.ok(a.section.some(s => s.title === title), query + ' -> ' + JSON.stringify(a.section));
  }
  for (const query of Object.keys(ON_8689DE53)) {
    const a = rulesAnswer('odc', query);
    assert.equal(portugueseIn(a.text ?? ''), null, query + ': the text served is the English one');
  }
});

test('work packet: a Portuguese intent chooses the same rules as the English one, N1 among them', () => {
  for (const lane of ['o11', 'odc']) {
    const ids = intent => rulesSection({ intent }, 1e9, { lane }).value.items.map(i => (i.from === 'standards' ? i.id : i.section + ':' + i.title));
    const pt = ids('comentario e descricao das actions'), en = ids('comment and description of the actions');
    assert.deepEqual(pt, en, lane);
    assert.ok(pt.includes('N1'), lane + ': N1 (names and descriptions on everything) is chosen: ' + pt.join(', '));
    // The words read in English, as the answer says them.
    assert.deepEqual(rulesSection({ intent: 'comentario e descricao das actions' }, 1e9, { lane }).value.words, ['comment', 'description']);
  }
});
