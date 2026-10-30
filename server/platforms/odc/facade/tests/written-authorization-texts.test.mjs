// R2-I (owner's rule, 28/10): no emitted text presents an approval file as a condition of a path that takes the user's
// written words. Structural, not a list of phrases:
//   (a) no example call (any "args" object) of the discovery catalog carries authorizationContext;
//   (b) no sentence of a catalog condition (preconditions, when, next, notes) nor of a tool listing text (description and
//       parameters, as the source declares them and as they are served, profiles app and all) names the approval record,
//       by any of its names, without saying in the same sentence that it is optional;
//   (c) the text of an authorizationContext parameter (that text is the record's own meaning, so it names it freely)
//       states no requirement (required, requires, only with) without saying in the same sentence that it is optional,
//       and no schema requires that parameter.
// The approval record has several names in the texts: authorizationContext, a contextual approval, an approval context, a
// context that binds or constrains, a fixture/owned/approval context, "... and context", a context file, and the proposal a
// call binds (proposal-bound, grant/proposal, proposal/authorization, the same/bound/original proposal, a proposal file).
// The exceptions are explicit, per verb or per sentence, with the reason: modes that stay file-only, the O11 optional
// coverage and an optional alternative.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createSsamServer } from '../ssam.mjs';
import { toolTexts } from '../tool-listing.mjs';

const MENTIONS_FILE = new RegExp([
  /\bauthorization_?context\b/, /\bcontextual(?: [a-z]+)? approvals?\b/, /\bapproval contexts?\b/,
  /\bcontexts? (?:binds?|bound|constraints?|constrains?)\b/, /\b(?:fixture|owned|own-fixture|approval|authorization) contexts?\b/, /\band context\b/,
  /\bcontext files?\b/, /\bproposal-bound\b/, /\bgrant\/proposal\b/, /\bproposal\/(?:authorization|approval)\b/,
  /\b(?:same|bound|original|approved) proposals?\b/, /\bproposal files?\b/,
].map(r => r.source).join('|'), 'i');
const SAYS_OPTIONAL = /\boptional(?:ly)?\b|\balternatively\b|\bstays? accepted\b|\bstill accepted\b|\bnever required\b|\bnot required\b|\bno file\b|\bremains? supported\b|\bwithout (?:an? )?(?:authorizationContext|approval file|context file|file)\b/i;
const STATES_REQUIREMENT = /\brequired?\b|\brequires\b|(?<![\w-])only with\b/i;
const sentences = text => String(text ?? '').split(/(?<=[.;!?])\s+/).filter(Boolean);
const FILE_PARAMETER = /^authorization_?context$/i;
// Where (a catalog "tool verb" or a tool) and, for a sentence exception, which sentence -> why it may name the file.
const EXCEPTIONS = [
  { where: 'o11_service_center_write solution-delete',
    reason: 'O11 optional coverage: the owner\'s reply already confirms; an exact authorizationContext only covers the names, never the count.' },
  { where: 'o11_service_center_write db-connection-delete',
    reason: 'O11 optional coverage: the owner\'s reply already confirms; an exact authorizationContext only covers the names, never the count.' },
  { where: 'o11_extension', sentence: /^consumers:true authorizationContext binds verbatim human approval to an exact proposal: a new standalone fixture publication, or an exact-target deletion\.$/,
    reason: 'O11 extension test-fixture mode: a new standalone fixture publication or exact-target delete stays bound to a proposal file; the normal publication takes the words.' },
  { where: 'odc_asset_delete', sentence: /^ordinary contextual approval (?:never waives|does not waive) consumers\.$/i,
    reason: 'Optional alternative: the words naming the asset and every consumer reach the same delete.' },
];
const excepted = (where, sentence) => EXCEPTIONS.some(e => (where === e.where || where.startsWith(e.where + ' ')) && (!e.sentence || e.sentence.test(sentence)));
// where: the catalog "tool verb" or the tool (for the exceptions); label: what a finding names.
// A sentence of the file parameter's own text is a condition when it states a requirement; any other sentence, when it
// names the record.
const conditionsOf = (where, label, text, out, { parameter = false } = {}) => {
  for (const s of sentences(text))
    if ((parameter ? STATES_REQUIREMENT : MENTIONS_FILE).test(s) && !SAYS_OPTIONAL.test(s) && !excepted(where, s)) out.push(label + ' :: ' + s.slice(0, 160));
};
// Every text of one listed tool: its description and each parameter text.
function listingConditions(tool) {
  const texts = toolTexts(tool), found = [];
  conditionsOf(tool.name, tool.name + ' description', texts.description, found);
  for (const [pointer, text] of Object.entries(texts.params))
    conditionsOf(tool.name, tool.name + pointer, text, found, { parameter: FILE_PARAMETER.test(pointer.split('/').at(-1)) });
  for (const name of tool.inputSchema?.required ?? []) if (FILE_PARAMETER.test(name) && !excepted(tool.name, ''))
    found.push(tool.name + '/properties/' + name + ' :: required by the schema');
  return found;
}

test('the discovery catalog never presents an approval file as a condition: no example call carries it, no condition requires it', () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'catalog', 'tools.json'), 'utf8'));
  const args = [], conditions = [];
  for (const [tool, entry] of Object.entries(catalog.tools ?? {})) {
    const owners = [[tool, entry], ...Object.entries(entry.verbs ?? {}).map(([verb, v]) => [tool + ' ' + verb, v])];
    for (const [key, node] of owners) {
      const visit = (value, at) => {
        if (Array.isArray(value)) return value.forEach((v, i) => visit(v, at + '/' + i));
        if (!value || typeof value !== 'object') return;
        if (at.endsWith('/args') && Object.hasOwn(value, 'authorizationContext')) args.push(key + at);
        for (const [k, v] of Object.entries(value)) if (k !== 'verbs') visit(v, at + '/' + k);
      };
      visit(node, '');
      for (const field of ['preconditions', 'when', 'next', 'notes'])
        for (const text of [node[field]].flat().filter(v => typeof v === 'string')) conditionsOf(key, key + ' ' + field, text, conditions);
    }
  }
  assert.deepEqual(args, [], 'example calls carrying authorizationContext');
  assert.deepEqual(conditions, [], 'conditions naming the file without saying it is optional');
});

test('the rule sees every name of the approval record and the requirement an optional file parameter states', () => {
  const tool = (description, text, required = []) => ({ name: 'fixture_tool', description,
    inputSchema: { type: 'object', required, properties: { authorizationContext: { type: 'string', description: text }, tenant: { type: 'string', description: 'Tenant host.' } } } });
  // An optional file parameter whose text makes it a condition of one path.
  assert.deepEqual(listingConditions(tool('Delete one own fixture.', 'Exact temporary connection/endpoint/stage approval; required for delete.')),
    ['fixture_tool/properties/authorizationContext :: required for delete.']);
  assert.equal(listingConditions(tool('Delete one own fixture.', 'Approval record; only with a delete.')).length, 1);
  assert.equal(listingConditions(tool('Delete one own fixture.', 'Approval record; requires explicit tenant.')).length, 1);
  // The approval record named otherwise than authorizationContext.
  for (const description of ['Context binds originOperationUuid and bodySha256.', 'Context constraints: mode and inputSha256;', 'The owned fixture context binds a dataset.',
    'Restore with a fresh baseline and context;', 'Bind every key to the original own-fixture grant/proposal.', 'restore also needs the same proposal/authorization.',
    'Exact contextual human approval for the baseline.', 'Pass the proposal file.'])
    assert.equal(listingConditions(tool(description, 'Optional approval record.')).length, 1, description);
  // Saying it is optional, in the same sentence, is what makes it no condition.
  for (const text of ['Optional file, never required (words suffice); delete binds origin receipt and expected hash.', 'Optional record, with an explicit tenant; authorize remains exact human words.',
    'Verified approval: timer-only, or settings-only with originOperationUuid, in exact app/environment.'])
    assert.deepEqual(listingConditions(tool('Write one own fixture (a context file stays accepted).', text)), [], text);
  // Other meanings of context stay out.
  for (const description of ['Read it from the native trace page context.', 'raw context only.', 'Bind the frame to its scope: metadata, context and categories;', 'work in context, inspect only an @key.'])
    assert.deepEqual(listingConditions(tool(description, 'Optional approval record.')), [], description);
});

test('no tool listing text presents an approval file as a condition (source and served, profiles app and all)', async () => {
  const out = new Set();
  for (const profile of ['app', 'all']) for (const deps of [{ listing: 'full' }, {}]) {
    const server = await createSsamServer({ profile, deps });
    const [a, b] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: 'texts', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      for (const tool of (await client.listTools()).tools) for (const line of listingConditions(tool)) out.add((deps.listing ? 'source ' : 'served ') + line);
    } finally { await client.close(); await server.close(); }
  }
  assert.deepEqual([...out], []);
});
