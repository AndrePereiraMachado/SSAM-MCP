// R2-I (owner's rule, 28/10: "A aprovação deve ser expressa por escrito no chat. Qualquer registro técnico deve ser gerado
// internamente pelo MCP, sem exigir arquivo do usuário."): the one helper every path uses (approvalOf).
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { approvalOf, authorizationContext, contextValues, isWritten, sameGrant, writtenApproval } from '../authorization-context.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');

test('approvalOf builds the record from the written words naming every target, keeps only hashes, and still accepts a context file', t => {
  const scope = { lane: 'odc', host: 'example.test', operation: 'connections.delete', targets: ['Owned Fixture', 'Consumer'], environmentKey: 'stage', constraints: { connectionId: 'c1' } };
  const words = 'Pode apagar o owned   fixture e o Consumer em example';
  const approval = approvalOf(undefined, words, scope);
  assert.equal(isWritten(approval), true); assert.equal(approval.file, null); assert.equal(approval.wordsSha256, sha(words));
  assert.deepEqual(approval.targets, scope.targets); assert.deepEqual(approval.constraints, scope.constraints); assert.equal(approval.environmentKey, 'stage');
  assert.equal(JSON.stringify(approval).includes('Pode apagar'), false);
  // The same scope gives the same record; another plan, another record. A step that shares a plan names it.
  assert.equal(approvalOf(null, words, scope).sha256, approval.sha256);
  assert.notEqual(approvalOf(null, words, { ...scope, constraints: { connectionId: 'c2' } }).sha256, approval.sha256);
  assert.equal(approvalOf(null, words, { ...scope, proposalSha256: 'a'.repeat(64) }).proposalSha256, 'a'.repeat(64));
  // Every target as a whole word: a longer name, a missing one, a server text or no words refuse.
  assert.throws(() => approvalOf(null, 'apagar o Owned Fixture2 e o Consumer', scope), e => e.code === 'WORDS_MUST_NAME' && e.details.missing.includes('Owned Fixture'));
  assert.throws(() => approvalOf(null, 'apagar o Owned Fixture', scope), e => e.code === 'WORDS_MUST_NAME' && e.details.missing.join() === 'Consumer');
  for (const marker of ['<owner reply>', 'sha256:' + 'b'.repeat(64), '', undefined]) assert.throws(() => approvalOf(null, marker, scope), e => e.code === 'WORDS_REQUIRED');
  assert.throws(() => writtenApproval(words, { ...scope, targets: [] }), e => e.code === 'AUTHORIZATION_CONTEXT_INVALID');
  assert.throws(() => writtenApproval(words, { ...scope, targets: ['Owned*'] }), e => e.code === 'AUTHORIZATION_CONTEXT_INVALID');
  // A context file stays accepted exactly as before.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'written-approval-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const proposal = path.join(dir, 'proposal.md'), file = path.join(dir, 'approval.json'); fs.writeFileSync(proposal, 'Delete the own fixture');
  const source = { kind: 'human-conversation', threadId: randomUUID(), messageId: randomUUID(), question: 'Delete it?' };
  fs.writeFileSync(file, JSON.stringify({ schema: 'ssam-authorization-context/1', decision: 'approved', words, source, proposal: { file: proposal, sha256: sha(fs.readFileSync(proposal)) },
    scope: [{ ...scope, constraints: undefined }], constraints: scope.constraints }));
  const filed = approvalOf(file, words, scope);
  assert.deepEqual(filed, authorizationContext(file, words, scope)); assert.equal(isWritten(filed), false);
  assert.deepEqual(contextValues(file, { other: 1 }), scope.constraints); assert.deepEqual(contextValues(undefined, { portfolioKey: 'p' }), { portfolioKey: 'p' });
  // The same grant: a file binds its conversation (and, when asked, its words and proposal); written words bind the receipt.
  assert.equal(sameGrant({ source, wordsSha256: sha(words), proposalSha256: filed.proposalSha256 }, filed, { words: true, proposal: true }), true);
  assert.equal(sameGrant({ source: { ...source, messageId: randomUUID() } }, filed), false);
  assert.equal(sameGrant({ wordsSha256: sha('creation') }, approval, { words: true, proposal: true }), true);
  assert.equal(sameGrant(null, approval), false);
});

// The own-fixture contextual modes of odc_write (named by their origin receipt) are taken with the written words alone: the
// handler passes SSAM's internal marker instead of a file, never an argument the caller can send.
test('odc_write selects an own-fixture contextual mode from its origin receipt without an approval file', async () => {
  const { McpServer, InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { Client } = await import('@modelcontextprotocol/client');
  const { registerAccessTools } = await import('../odc-access.mjs');
  const seen = [];
  const server = new McpServer({ name: 't', version: '0' });
  registerAccessTools(server, { write: async (input, options) => { seen.push({ input, options }); return { ok: true }; } },
    fn => async args => { const value = await fn(args); return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }; });
  const [a, b] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: 'c', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const base = { tenant: 'corp.outsystems.dev', authorize: 'Change the group Fixture on corp', operationUuid: randomUUID() };
    await client.callTool({ name: 'odc_write', arguments: { ...base, operationId: 'user-access-management-api-v1:patch:/groups/{key}', path: { key: randomUUID() }, body: { description: 'x' }, originOperationUuid: randomUUID() } });
    const marker = Symbol.for('ssam.written-authorization');
    assert.equal(seen.at(-1).options.groupContext, marker);
    await client.callTool({ name: 'odc_write', arguments: { ...base, operationId: 'native-application-orchestration-service-api-v1:post:/build-operations', body: { applicationKey: randomUUID() }, originOperationUuid: randomUUID() } });
    assert.equal(seen.at(-1).options.assetBuildContext, marker);
    // A file stays as given; no origin keeps the normal path.
    await client.callTool({ name: 'odc_write', arguments: { ...base, operationId: 'user-access-management-api-v1:patch:/groups/{key}', path: { key: randomUUID() }, body: { description: 'x' }, originOperationUuid: randomUUID(), authorizationContext: 'C:/private/approval.json' } });
    assert.equal(seen.at(-1).options.groupContext, 'C:/private/approval.json');
    await client.callTool({ name: 'odc_write', arguments: { ...base, operationId: 'user-access-management-api-v1:patch:/groups/{key}', path: { key: randomUUID() }, body: { description: 'x' } } });
    assert.equal(seen.at(-1).options.groupContext, undefined);
  } finally { await client.close(); await server.close(); }
});

// R2-I round 3: one name predicate for the tool and the guard. A listed name counts as named only by an occurrence that is not
// inside a longer listed name (the longest first); a name given twice in the list counts once.
test('the written words name a listed name only outside a longer listed name, the longest first', () => {
  const scope = { lane: 'odc', host: 'example.test', operation: 'connections.removeEntities', targets: ['dbo.Order', 'dbo.Order Lines', 'dbo.Orders'], environmentKey: 'stage' };
  assert.throws(() => approvalOf(null, 'remove dbo.Order Lines and dbo.Orders', scope), e => e.code === 'WORDS_MUST_NAME' && e.details.missing.join() === 'dbo.Order');
  assert.throws(() => approvalOf(null, 'remove dbo.Order Lines', { ...scope, targets: ['dbo.Order Lines', 'dbo.Order'] }),
    e => e.code === 'WORDS_MUST_NAME' && e.details.missing.join() === 'dbo.Order');
  assert.equal(isWritten(approvalOf(null, 'remove dbo.Order Lines, dbo.Orders and dbo.Order', scope)), true);
  assert.equal(isWritten(approvalOf(null, 'remove dbo.Order, then dbo.Order Lines and dbo.Orders', scope)), true);
  assert.equal(isWritten(approvalOf(null, 'remove dbo.Order', { ...scope, targets: ['dbo.Order', 'dbo.Order'] })), true);
});
