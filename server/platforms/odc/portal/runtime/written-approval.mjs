// R2-I (owner's rule, 2026-10-28): the ODC lane's side of approvalOf (facade/authorization-context.mjs). The user's written
// words name every target and are the approval; a context file is still accepted, never required. Without one, the values
// the file carried come from the MCP itself: the call's scope (keys the input lacks) and this tenant's own journal (the
// creation, test or upload a target came from), never from a file the user prepares. The refusals are OdcErrors, so
// publicError keeps their message and details (WORDS_MUST_NAME names the missing targets).
import { approvalOf as approvalOfFacade, contextValues as contextValuesOf, isWritten, sameGrant, WrittenAuthorizationError } from '../../facade/authorization-context.mjs';
import { fail } from './errors.mjs';
import { isUuid } from './write-journal.mjs';

export { isWritten, sameGrant };
const odc = fn => {
  try { return fn(); } catch (error) {
    if (error instanceof WrittenAuthorizationError) fail(error.code, error.message, error.details);
    throw error;
  }
};
export const approvalOf = (file, words, scope) => odc(() => approvalOfFacade(file, words, scope));
export const contextValues = (file, scope) => contextValuesOf(file, scope);
// The one own receipt a written approval binds, found by what it created (never by an argument): none or several is a
// refusal and nothing is sent.
export function ownReceipt(find, predicate, what) {
  const found = typeof find === 'function' ? find(predicate) : [];
  if (found.length !== 1) fail('OPERATION_RECEIPT_MISMATCH', what + ': ' + (found.length ? 'several receipts' : 'no receipt')
    + ' of this tenant\'s journal match the target; the written authorization binds exactly one own record'
    + (found.length ? ' (the call\'s scope names one)' : '') + '. Nothing was sent.', { matches: found.length, ...(found.length ? { candidates: found.map(r => r.operationUuid) } : {}) });
  return found[0];
}
// The origin receipt id of a step: the one the file (or the call's scope) names, else, with written words, the one own
// receipt that matches. -> the operationUuid (the caller still checks the receipt's identity as before).
export function originId(values, key, { written, find, predicate, what }) {
  if (values?.[key] !== undefined) return values[key];
  if (!written) return undefined;
  return ownReceipt(find, predicate, what).operationUuid;
}
export const ownedBy = (host, operationId) => receipt => receipt?.identity?.tenant === host && receipt.identity.operationId === operationId
  && ['accepted', 'confirmed'].includes(receipt.state);
export { isUuid };
// An origin receipt an approval can bind: one SSAM reserved with an approval record (a file's conversation, as before) or
// with the sha256 of the words it was sent with. A file approval still compares that receipt's conversation (sameGrant).
export const recorded = receipt => Boolean(receipt?.authorization?.source) || /^[a-f0-9]{64}$/.test(receipt?.authorization?.wordsSha256 ?? '');
// R2-I round 3: the grant of a verification read of an own fixture (a credential status, a file download). anchor: the
// receipt read (a creation, an upload, a save); related: the receipts it must share that grant with. An anchor a context
// file approved keeps today's rule: a conversation of UUIDs, the same words (and, when asked, the same proposal) on every
// related receipt. An anchor the written words approved binds SSAM's own records: its words' sha256 and every related
// receipt recorded(). A receipt with no approval record at all is refused.
export function readGrant(anchor, related = [], { proposal = false } = {}) {
  const a = anchor?.authorization;
  if (!/^[a-f0-9]{64}$/.test(a?.wordsSha256 ?? '')) return false;
  if (a?.source?.kind === 'human-words') return related.every(r => recorded(r));
  if (!isUuid(a?.source?.threadId) || !isUuid(a?.source?.messageId) || (proposal && !/^[a-f0-9]{64}$/.test(a.proposalSha256 ?? ''))) return false;
  return related.every(r => r?.authorization?.source?.threadId === a.source.threadId && r.authorization.source.messageId === a.source.messageId
    && r.authorization.wordsSha256 === a.wordsSha256 && (!proposal || r.authorization.proposalSha256 === a.proposalSha256));
}
