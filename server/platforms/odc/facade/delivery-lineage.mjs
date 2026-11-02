import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fileHash = file => { try { return hash(fs.readFileSync(file)); } catch { return null; } };
const checkpoint = file => {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (typeof doc.payload !== 'string') return doc;
  if (doc.format !== 1 || doc.sha256 !== hash(doc.payload)) throw new Error('Invalid delivery checkpoint checksum.');
  return JSON.parse(doc.payload);
};
const sameFile = (a, b) => typeof a === 'string' && typeof b === 'string'
  && (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
export function readDeliveryTask(work, id) {
  if (!/^[0-9a-f]{32}$/i.test(String(id))) return null;
  try {
    return checkpoint(path.join(work, 'deliver', id, 'task.json'));
  } catch { return null; }
}

// F1 (owner 2026-11-02, "o ssam deve permitir que o usuario programe junto com ele"): a holder task that already ended, so
// it never frees the module by itself: a known failure (a recorded error, writeState not-sent or not-applied, or an applied
// merge whose verification ran or whose content proof refused), or one closed or delivered that left its reservation. The
// kernel closes it with its known content when the next delivery reserves the module (Delivery.Reserve, the rule of
// Delivery.EndedHolder); a running, uncertain or unsettled holder is never one.
export function holderEnded(task) {
  if (!task || task.pendingBridgeOperation || task.pendingOperationRecovery) return false;
  if (task.closed === true || task.delivered === true) return true;
  // 2a: a write never sent, error recorded or not, once no process runs it (its run lease is free).
  if (task.writeState === 'not-sent' && task.error == null) return runLeaseFree(task);
  if (task.error == null) return false;
  if (['not-sent', 'not-applied'].includes(task.writeState)) return true;
  // after the merge: every checker ran (failures recorded once all ran: Verify, checks, data and content proofs)
  return ['applied', 'unchanged'].includes(task.writeState) && ((Array.isArray(task.failures) && task.failures.length > 0) || task.validation?.newErrors != null || task.code === 'MERGE_CONTENT_MISMATCH');
}

// The kernel's run lease of a task (<work>/deliver/<id>/run.lock, FileShare.None while a process runs it): free when this
// process can open it exclusively. Without a task folder, never free.
const EXCLUSIVE = process.platform === 'win32' ? 0x10000000 : 0;
export function runLeaseFree(task) {
  if (typeof task?.work !== 'string' || !fs.existsSync(task.work)) return false;
  let fd;
  try { fd = fs.openSync(path.join(task.work, 'run.lock'), fs.constants.O_RDWR | fs.constants.O_CREAT | EXCLUSIVE); return true; }
  catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

// A shared MCP session is not an owner. Only a reference to this task/job or identical job bytes proves lineage.
export function sameDeliveryLineage(input, job, holder) {
  if (!holder) return false;
  const own = holder.request?.JobPath ?? holder.request?.jobPath;
  const ownHash = holder.jobSha256 ?? fileHash(own);
  if (input?.basedOn?.taskId === holder.taskId) return true;
  if (sameFile(input?.basedOn?.job, own)) return !input.basedOn.sha256 || input.basedOn.sha256.toLowerCase() === ownHash;
  let incoming = typeof job === 'string' ? fileHash(job) : null;
  if (!incoming && input?.job && typeof input.job === 'object') incoming = hash(JSON.stringify(input.job));
  return Boolean(ownHash && incoming === ownHash);
}

export const reservationContinuation = id => ({ tool: 'ssam_task', arguments: { id },
  why: 'Another job holds this module. Read its owner and wait for that delivery to be resolved; do not close or replace it. '
    + 'If that task is yours, deliver again with basedOn {taskId: ' + id + '} (or a patch over it): only then is it the same job.' });

// Read the durable reservation, never infer release from process death or a task's age.
export function moduleReservation({ directory, work, module, environment }) {
  if (!directory || !module) return null;
  let names; try { names = fs.readdirSync(directory); } catch { return null; }
  for (const name of names.filter(n => n.endsWith('.json')).sort()) {
    let held; try { held = checkpoint(path.join(directory, name)); } catch { continue; }
    if (!held.owner || (environment && String(held.environment).toLowerCase() !== String(environment).toLowerCase())) continue;
    const task = readDeliveryTask(work, held.owner);
    const nameOfTask = task?.module ?? task?.request?.Module ?? task?.request?.module;
    if (String(nameOfTask ?? held.moduleKey).toLowerCase() !== String(module).toLowerCase()) continue;
    return { taskId: held.owner, since: held.since ?? null, task };
  }
  return null;
}
