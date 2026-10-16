// CX15 r3 (N3, provisional decision "strict" kept): ONE rule for the cleanup of an own fixture after the odc_* guard has
// validated the owner's reply to its preview (count, names, words never seen before the list). The six approvals that
// bound their cleanup to the WORDS and MESSAGE of the creation (a2a, custom search, external-library discard, owned
// consumers, API Client fixture and pending header) could never pass the strict guard: those words were said before any
// list and carry no count. Inside the guard's execution (withValidatedReply, set only by destructive-preview.mjs right
// before it calls the unguarded access, never from the call's arguments) they accept instead:
//   - the creation receipt of THIS target (each approval keeps its own identity checks: tenant, key, state; for API
//     Client, creationOperationUuid), on the same tenant;
//   - a NEW approval (authorizationContext) whose words are the owner's reply the guard validated and whose proposal is
//     the file of the preview the owner was shown (previews\<previewId>.json), with the approval's own scope and
//     constraints; CX15 r4 (W-3): the file binds that reply by wordsSha256 and never keeps it (authorization-context.mjs;
//     the literal words are still accepted, provisionally);
// and they no longer require the creation's words or message. Outside the guard (internal flows, the CLI without it)
// nothing changes: ownedCleanupApproval answers null and each approval applies its creation-bound rule as before.
import fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { authorizationContext } from '../../facade/authorization-context.mjs';
import { fail } from './errors.mjs';

const replies = new AsyncLocalStorage();
const sha = value => createHash('sha256').update(value).digest('hex');
const text = value => (value === null || value === undefined ? '' : String(value));
// reply: {host, tool, previewId, operationId, previewFile, wordsSha256, keys: [item keys of the preview]}.
export const withValidatedReply = (reply, fn) => replies.run(reply && typeof reply === 'object' ? Object.freeze({ ...reply, keys: Object.freeze([...(reply.keys ?? [])]) }) : null, fn);
export const validatedReply = () => replies.getStore() ?? null;
// The text of the tools whose cleanups go through this rule (a2a, asset delete with own consumers, Portal deletes, discard).
export const OWNED_CLEANUP = "An own fixture is cleaned up in the same two calls: after the preview, authorizationContext is a NEW approval whose wordsSha256 is the sha256 (64 hex of the UTF-8 bytes) of the owner's reply to that list exactly as it goes in authorize (the file never keeps the words) and whose proposal is the preview file (previews\\<previewId>.json under the destructive root), bound to the creation receipt of this target; the creation's words and message are not needed.";

// file/words/host/operation/targets/environmentKey/constraints: the approval's own scope (as authorizationContext takes
// it). origin: the creation receipt the caller matched to this target; key: the target's key (an item of the preview).
export function ownedCleanupApproval({ file, words, host, operation, targets, environmentKey, constraints, origin, key, what = 'The cleanup of this own fixture' }) {
  const reply = validatedReply();
  if (!reply) return null;
  const bad = why => fail('AUTHORIZATION_CONTEXT_INVALID', `${what} after its preview needs ${why}. Nothing was sent.`);
  if (text(reply.host).toLowerCase() !== text(host).toLowerCase()) bad('the tenant of the preview');
  if (typeof words !== 'string' || sha(words) !== reply.wordsSha256) bad('the owner\'s reply the guard validated, as its words');
  const k = text(key).toLowerCase();
  if (!k || !reply.keys.some(item => { const i = text(item).toLowerCase(); return i === k || i.startsWith(k + '/') || i.endsWith('/' + k); })) bad('a target listed in the preview');
  if (!origin || text(origin.identity?.tenant).toLowerCase() !== text(host).toLowerCase()) bad('the creation receipt of this target on this tenant');
  let preview;
  try { preview = fs.readFileSync(reply.previewFile); } catch { bad('the preview file the owner was shown'); }
  const approval = authorizationContext(file, words, { lane: 'odc', host, operation, targets, ...(environmentKey === undefined ? {} : { environmentKey }), ...(constraints ? { constraints } : {}) });
  if (!approval) bad('a new approval (authorizationContext)');
  if (approval.proposalSha256 !== sha(preview)) bad('a new approval whose proposal is the preview file the owner was shown (' + reply.previewFile + ')');
  return { ...approval, afterPreview: { previewId: reply.previewId, operationId: reply.operationId } };
}
