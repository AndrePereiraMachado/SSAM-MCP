import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createSsamServer } from '../ssam.mjs';
import { createFacadeServer } from '../mcp.mjs';
import { DESTRUCTIVE_TOOLS, DESTRUCTIVE_SUFFIX, WORDS_RULE, AFTER_INTERRUPTION, ODC_EXECUTION_UUID } from '../destructive-operations.mjs';
import { TOOL_LISTING, PROTECTED_TOOL_CLAUSES, projectTool, toolTexts, toolSourceSha256 } from '../tool-listing.mjs';
import { sentencesOf } from '../tool-listing-guard.mjs';
import { ODC_CLAUSES_IN_TOOLS } from '../server-instructions.mjs';

// CX11 integrated onto CX15 (integracao/marco-a5): the CX15 delete rules reach the session that the compact listing and
// the standalone ODC instruction serve, not only the registered descriptions (destructive-texts* read those).
async function listed(make) {
  const server = await make(); const [a, b] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: 'cx15-served', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  try { return { tools: (await client.listTools()).tools, instructions: client.getInstructions() ?? '' }; } finally { await client.close(); await server.close(); }
}
const servedText = tool => { const t = toolTexts(tool); return [t.description ?? '', ...Object.values(t.params)].join('\n'); };
const CX15_SENTENCES = [...new Set([...sentencesOf(DESTRUCTIVE_SUFFIX), ...sentencesOf(WORDS_RULE), ...sentencesOf(AFTER_INTERRUPTION), ODC_EXECUTION_UUID])];

test('CX15 delete clause is in the standalone ODC instruction; the rest is in every destructive ODC tool it declares', async () => {
  const { tools, instructions } = await listed(() => createFacadeServer());
  assert.ok(instructions.length <= 2000, String(instructions.length));
  for (const clause of ['deletes/undeploys: two calls', 'words naming the target, with the count', 'interrupted/CANCELLED: ssam_task {id} first', 'uncertain: odc_receipt'])
    assert.ok(instructions.includes(clause), 'instruction lacks ' + clause);
  assert.ok(tools.some(t => t.name === 'ssam_task'), 'the instruction names ssam_task: the standalone server serves it');
  const { clauses, tools: names } = ODC_CLAUSES_IN_TOOLS['odc-writes'];
  for (const name of names) {
    const tool = tools.find(t => t.name === name); assert.ok(tool, name + ' served');
    for (const clause of clauses) assert.ok(tool.description.includes(clause), name + ' lacks ' + clause);
  }
});

for (const profile of ['app', 'all']) test('CX15 delete sentences, or their bound clauses, are in the SERVED listing of every destructive tool (' + profile + ')', async () => {
  const short = await listed(() => createSsamServer({ profile })), full = await listed(() => createSsamServer({ profile, deps: { listing: 'full' } }));
  const originals = new Map(full.tools.map(t => [t.name, t]));
  const checked = [];
  for (const { tool: name } of DESTRUCTIVE_TOOLS) {
    const served = short.tools.find(t => t.name === name); if (!served) continue;
    const source = originals.get(name), sourceText = servedText(source), text = servedText(served);
    // A tool of the compact listing is served projected: its review is current and the guard finds nothing.
    if (TOOL_LISTING[name]) {
      assert.equal(toolSourceSha256(source), TOOL_LISTING[name].sourceSha256, name + ': projection reviewed against the CX15 original');
      assert.deepEqual(projectTool(source).problems, [], name + ': guard problems');
      assert.notEqual(served.description, source.description, name + ': projected description served');
    }
    const present = CX15_SENTENCES.filter(s => sourceText.includes(s));
    if (!present.length) continue; // studio_command refuses destructive commands: no delete sentences to keep
    assert.ok(present.length >= 3, name + ': CX15 sentences in the original ' + present.length);
    for (const sentence of present) {
      if (text.includes(sentence)) continue;
      const bound = (PROTECTED_TOOL_CLAUSES[name] ?? []).find(e => e.sentence === sentence);
      assert.ok(bound, name + ': served listing drops, with no bound clause: ' + sentence.slice(0, 80));
      for (const clause of [bound.clauses].flat()) assert.ok(text.includes(clause), name + ': bound clause not served: ' + clause);
    }
    // What the CX15 sentences say, whatever the words: two calls, the count, the words copied whole, ssam_task after an
    // interruption, never a nothing-happened claim.
    for (const re of [/\b(?:two|2) calls\b/, /\bcount\b/, /copied whole/, /ssam_task \{id/, /never say nothing happened/, /confirmationToken/])
      assert.match(text, re, name + ' served listing');
    if (present.includes(ODC_EXECUTION_UUID)) assert.match(text, /preview(?:'s)? operationId/, name);
    checked.push(name);
  }
  assert.ok(checked.length >= 10, checked.join(' '));
});
