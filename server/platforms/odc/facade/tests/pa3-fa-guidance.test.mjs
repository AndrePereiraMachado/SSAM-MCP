// Atritos 3, lane fa, guidance served by the MCP (never in the fixed context): the seven rules of the package are lessons
// of docs/CONHECIMENTO-DO-TIME.md, each found by the words of its intent through ssam_reference {kind:"rules"}; the lane
// guides carry the one line about jobs in a file. The fixed context (AGENTS.md, the server instructions) did not grow.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rulesAnswer } from '../ssam-reference.mjs';
import { guideText } from '../runtime-guides.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const RULES = [
  ['approved prototype', /ported 1:1: the op `html` with the markup of the prototype and\s+its `<style>` in the theme/, /ssam_app_url/],
  ['reset scoped', /:where\(/, /Never write an element\s+selector/],
  ['partial refresh', /`Assign` on `<List>\[<index>\]`/, /summary from the outputs/],
  ['jobs in a file', /the Write tool, in UTF-8/, /agent:inbox\/<name>\.json/, /Never generate the JSON with a heredoc/],
  ['subagents', /ToolSearch/, /before the first use/],
  ['reconnect the MCP', /reloads by itself/, /`facade\/launch\.mjs` or `facade\/friction-\*\.mjs` needs the MCP\s+reconnected/],
  ['expectedMessages', /only the messages a refusal asked for/],
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

// F2 (review english-junction): the Portuguese intents of the package (as they were before the translation) find the
// same lesson as the English ones; the answer is the English lesson.
const RULES_PT = [['protótipo aprovado', 'approved prototype'], ['reset escopado', 'reset scoped'], ['refresh parcial da lista', 'partial refresh'],
  ['jobs em arquivo', 'jobs in a file'], ['subagentes', 'subagents'], ['reconectar o MCP', 'reconnect the MCP'], ['expectedMessages', 'expectedMessages']];
test('guidance: each Portuguese intent of the seven rules finds the lesson its English intent finds, on both lanes', () => {
  for (const [pt, en] of RULES_PT)
    for (const lane of ['o11', 'odc']) {
      const a = rulesAnswer(lane, pt), b = rulesAnswer(lane, en);
      assert.equal(a.ok, true, pt + ': ' + JSON.stringify(a.code));
      assert.deepEqual(a.section, b.section, pt + ' finds the lesson of ' + en);
      assert.equal(a.text, b.text, pt);
    }
});

test('guidance: the lane guides say how a job reaches a call; the fixed context did not grow', () => {
  for (const topic of ['o11', 'odc']) assert.match(guideText(topic), /Jobs: write them with Write \(UTF-8\) to a file and pass the path; never a heredoc\./, topic);
  const agents = fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8');
  assert.doesNotMatch(agents, /ToolSearch antes|ToolSearch (?:first|before)|reloadedAt|:where\(/, 'AGENTS.md stays as it was (I15)');
});
