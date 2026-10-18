// English-only guard, lane B, dynamic half (owner rule 15/10/2026): the served tool listing of every profile (the short
// projected listing and its full source), the friction tool, the standalone ODC server, and the server instructions of
// every profile are read from the real in-process servers (no Studio, no worker, no network, no tool call) and every
// text of them is checked for Portuguese (tests/fixtures/portuguese-text.mjs). Values of the protocol quoted in a
// description ("entregue", "padroes", doc "time") are Portuguese too: the English value is served, the old one is only
// an accepted alias (declared where it is read).
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createSsamServer } from '../ssam.mjs';
import { createFacadeServer } from '../mcp.mjs';
import { serverInstructions, sessionGuide } from '../server-instructions.mjs';
import { frictionTool } from '../../../../facade/friction-boundary.mjs';
import { portugueseIn, toolStrings } from './fixtures/portuguese-text.mjs';

// The Portuguese protocol values of the releases before 15/10/2026: never served again, only accepted as input aliases.
const LEGACY_VALUES = ['entregue', 'entregue e publicado', 'publicado', 'fechada', 'feito', 'nada a atualizar', 'padroes', 'padrões'];
const quotedLegacy = text => LEGACY_VALUES.filter(v => text.includes('"' + v + '"') || text.includes("'" + v + "'"))
  .concat(/doc[^.;]{0,40}"time"/.test(text) || /"time"\s*\|/.test(text) || /\|\s*"time"/.test(text) ? ['"time" (team)'] : []);

async function listing(t, { profile = 'app', deps = {}, hooks = false } = {}) {
  const saved = process.env.SSAM_APP_HOOK_TOOLS; process.env.SSAM_APP_HOOK_TOOLS = hooks ? '1' : '0';
  let server; try { server = await createSsamServer({ profile, deps }); } finally { if (saved === undefined) delete process.env.SSAM_APP_HOOK_TOOLS; else process.env.SSAM_APP_HOOK_TOOLS = saved; }
  const [a, b] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: 'english-only-listing', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await server.close(); });
  return { tools: (await client.listTools()).tools, instructions: client.getInstructions() ?? '' };
}
// Tools still to translate (declared, each with its reason): none.
const PENDING_TOOLS = new Set([]);
function problemsOf(label, tools, instructions) {
  const out = [];
  for (const tool of tools.filter(t => !PENDING_TOOLS.has(t.name))) for (const { field, value } of toolStrings(tool)) {
    const pt = portugueseIn(value); if (pt) out.push(label + ' ' + tool.name + ' ' + field + ' [' + pt.words.slice(0, 4).join(' ') + '] ' + pt.sample);
    for (const v of quotedLegacy(value)) out.push(label + ' ' + tool.name + ' ' + field + ' quotes the Portuguese value ' + v);
    if (field.includes('.enum[') && LEGACY_VALUES.includes(value)) out.push(label + ' ' + tool.name + ' ' + field + ' serves the Portuguese enum value ' + value);
  }
  for (const sentence of String(instructions).split(/(?<=[.;])\s+/)) {
    const pt = portugueseIn(sentence); if (pt) out.push(label + ' (instructions) [' + pt.words.slice(0, 4).join(' ') + '] ' + sentence.slice(0, 120));
    for (const v of quotedLegacy(sentence)) out.push(label + ' (instructions) quotes the Portuguese value ' + v);
  }
  return out;
}

for (const profile of ['app', 'debug', 'all']) for (const hooks of profile === 'debug' ? [false] : [false, true])
  test(`english-only: profile ${profile} (hooks=${hooks}) lists tools and instructions in English, short and full listing`, async t => {
    const short = await listing(t, { profile, hooks }), full = await listing(t, { profile, hooks, deps: { listing: 'full' } });
    const found = [...problemsOf(profile + '/short', short.tools, short.instructions), ...problemsOf(profile + '/full', full.tools, '')];
    assert.deepEqual(found, [], found.length + ' Portuguese texts:\n' + found.join('\n'));
  });

test('english-only: the standalone ODC server and the friction tool are English', async t => {
  const server = await createFacadeServer({ env: { ...process.env } });
  const [a, b] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: 'english-only-odc', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await server.close(); });
  const found = [...problemsOf('odc-facade', (await client.listTools()).tools, client.getInstructions() ?? ''), ...problemsOf('friction', [frictionTool], '')];
  assert.deepEqual(found, [], found.length + ' Portuguese texts:\n' + found.join('\n'));
});

test('english-only: every profile\'s instructions and the session guide are English', () => {
  const found = [];
  for (const profile of ['app', 'debug', 'all', 'odc-facade']) found.push(...problemsOf('instructions/' + profile, [], serverInstructions({ profile })));
  found.push(...problemsOf('session-guide', [], sessionGuide()));
  assert.deepEqual(found, [], found.length + ' Portuguese texts:\n' + found.join('\n'));
});
