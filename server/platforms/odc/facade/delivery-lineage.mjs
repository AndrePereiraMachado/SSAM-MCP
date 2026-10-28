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
