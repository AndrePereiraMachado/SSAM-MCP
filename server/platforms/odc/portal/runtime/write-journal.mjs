// Durable receipts for ODC writes, the same protocol as the O11 Service Center journal
// (kernel/scripts/service_center/client.py, Journal): the receipt exists in state 'sending' BEFORE the request, one
// operationUuid is one send forever, an uncertain write keeps its target lock until a read reconciles it, and nothing
// here ever resends. Only the sha256 of the user's words is stored.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fail } from './errors.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const sha256 = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const fingerprint = value => sha256(stable(value));
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  return JSON.stringify(value ?? null);
}
// Settled states release the target; 'uncertain' keeps it until reconcile().
const SETTLED = new Set(['accepted', 'confirmed', 'rejected', 'not-sent']);

export class WriteJournal {
  constructor(dir, now = () => new Date().toISOString()) { this.dir = dir; this.now = now; }

  file(operationUuid) {
    if (typeof operationUuid !== 'string' || !UUID.test(operationUuid)) fail('INPUT_INVALID', 'operationUuid must be a UUID.');
    return path.join(this.dir, operationUuid.toLowerCase() + '.json');
  }
  lockFile(identity) { const { kind, ...target } = identity; return path.join(this.dir, fingerprint(target) + '.lock'); }

  // An existing receipt is the answer to a repeated operationUuid; the same UUID for another target is refused.
  lookup(operationUuid, identity) {
    const file = this.file(operationUuid);
    if (!fs.existsSync(file)) return null;
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (identity && fingerprint(receipt.identity) !== fingerprint(identity)) fail('OPERATION_UUID_REUSED', 'This operationUuid already belongs to another target or operation; use a new UUID.');
    if (receipt.state === 'sending') receipt.state = 'uncertain';
    return receipt;
  }

  reserve({ operationUuid, identity, wordsSha256, plan }) {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.file(operationUuid), lock = this.lockFile(identity);
    let fd;
    try { fd = fs.openSync(lock, 'wx'); }
    catch { fail('TARGET_PENDING', 'This target has a pending or uncertain write; read its receipt and reconcile by a read before any new write.', { pendingOperationUuid: readLock(lock) }); }
    const receipt = { schema: 'ssam-odc-write/1', operationUuid: operationUuid.toLowerCase(), identity,
      authorization: { wordsSha256, planSha256: fingerprint(plan) }, state: 'sending', ok: false, createdAt: this.now(), receipt: file };
    try {
      fs.writeSync(fd, receipt.operationUuid); fs.fsyncSync(fd); fs.closeSync(fd); fd = null;
      // 'wx': not even a concurrent caller with the same UUID can send twice.
      const out = fs.openSync(file, 'wx'); fs.writeSync(out, JSON.stringify(receipt, null, 2)); fs.fsyncSync(out); fs.closeSync(out);
    } catch (error) {
      if (fd != null) fs.closeSync(fd);
      fs.rmSync(lock, { force: true });
      if (error.code === 'EEXIST') fail('OPERATION_UUID_REUSED', 'This operationUuid was already used; read its receipt instead of sending again.');
      throw error;
    }
    return receipt;
  }

  settle(receipt, update) {
    Object.assign(receipt, update, { updatedAt: this.now() });
    receipt.ok = ['accepted', 'confirmed'].includes(receipt.state);
    this.write(receipt);
    if (SETTLED.has(receipt.state)) fs.rmSync(this.lockFile(receipt.identity), { force: true });
    return receipt;
  }

  // A read that observed the outcome settles an uncertain receipt; it never repeats the write.
  reconcile(receipt, { state, observation }) {
    if (!['uncertain', 'accepted'].includes(receipt.state)) fail('RECEIPT_NOT_RECONCILABLE', 'Only an uncertain or accepted receipt is reconciled by a read.');
    if (!['confirmed', 'not-applied'].includes(state)) fail('INPUT_INVALID', 'Reconciliation state must be confirmed or not-applied.');
    const lock = this.lockFile(receipt.identity);
    if (receipt.state === 'uncertain' && readLock(lock) !== receipt.operationUuid) fail('RECEIPT_LOCK_MISMATCH', 'The target lock no longer belongs to this receipt.');
    receipt.reconciliations = [...(receipt.reconciliations ?? []), { at: this.now(), state, observation }];
    receipt.state = state === 'confirmed' ? 'confirmed' : 'rejected';
    receipt.ok = state === 'confirmed';
    receipt.updatedAt = this.now();
    this.write(receipt);
    fs.rmSync(lock, { force: true });
    return receipt;
  }

  write(receipt) {
    const file = this.file(receipt.operationUuid), temporary = file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(receipt, null, 2)); fs.renameSync(temporary, file);
  }
}
function readLock(lock) { try { return fs.readFileSync(lock, 'utf8'); } catch { return null; } }
export const isUuid = value => typeof value === 'string' && UUID.test(value);
