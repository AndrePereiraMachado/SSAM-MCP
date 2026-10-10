// Atritos 3, lane fa, guidance served by the MCP (never in the fixed context): the seven rules of the package are lessons
// of docs/CONHECIMENTO-DO-TIME.md, each found by the words of its intent through ssam_reference {kind:"rules"}; the lane
// guides carry the one line about jobs in a file. The fixed context (AGENTS.md, the server instructions) did not grow.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rulesAnswer } from '../ssam-reference.mjs';
import { guideText } from '../runtime-guides.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const RULES = [
  ['protótipo aprovado', /portado 1:1: a op `html` com a marcação do protótipo e o\s+`<style>` dele no tema/, /ssam_app_url/],
  ['reset escopado', /:where\(/, /Nunca escreva\s+seletor de elemento/],
  ['refresh parcial da lista', /`Assign` em `<Lista>\[<índice>\]`/, /resumo das saídas/],
  ['jobs em arquivo', /ferramenta Write, em UTF-8/, /agent:inbox\/<nome>\.json/, /Nunca gere o JSON com heredoc/],
  ['subagentes', /ToolSearch/, /antes do primeiro uso/],
  ['reconectar o MCP', /recarrega sozinho/, /`facade\/launch\.mjs` ou `facade\/friction-\*\.mjs` pede reconectar/],
  ['expectedMessages', /só as mensagens que uma recusa pediu/],
];

test('guidance: each of the seven rules is a lesson found by its intent, on both lanes', () => {
  for (const [query, ...patterns] of RULES)
    for (const lane of ['o11', 'odc']) {
      const answer = rulesAnswer(lane, query);
      assert.equal(answer.ok, true, query + ': ' + JSON.stringify(answer.code));
      assert.equal(answer.section.length, 1, query + ' finds one lesson');
      for (const pattern of patterns) assert.match(answer.text, pattern, query);
    }
  // The document keeps its three sections (the rules are lessons inside them).
  assert.deepEqual(rulesAnswer('o11', 'all').sections.map(s => s.id), ['1', '2', '3']);
});

test('guidance: the lane guides say how a job reaches a call; the fixed context did not grow', () => {
  for (const topic of ['o11', 'odc']) assert.match(guideText(topic), /Jobs: grave com Write \(UTF-8\) num arquivo e passe o caminho; nunca heredoc\./, topic);
  const agents = fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8');
  assert.doesNotMatch(agents, /ToolSearch antes|reloadedAt|:where\(/, 'AGENTS.md stays as it was (I15)');
});
