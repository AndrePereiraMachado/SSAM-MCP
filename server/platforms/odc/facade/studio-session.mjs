// Only node:fs and node:path: the root launcher (facade/launch.mjs) loads this module at every start.
import fs from 'node:fs';
import path from 'node:path';

export function connectionFile(root, lane) { return path.join(root, '.local', 'connections', lane + '.json'); }
// The selected Studio of an O11 lane. Hosted (and in a served process without a context) the record is the executor's:
// the customer's connection with the relay port, or null; the connection files of this machine are never read there.
// executor.mjs publishes currentExecutor under this key when it is loaded; when it is not, nothing can be hosted.
export function readConnection(root, lane) {
  const own = globalThis[Symbol.for('ssam.facade.currentExecutor')]?.().o11Connection();
  if (own !== undefined) return own;
  const file = connectionFile(root, lane);
  if (!fs.existsSync(file)) return null;
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (record.ok !== true || record.lane !== 'o11' || record.anvilLane !== lane || !Number.isSafeInteger(record.pid) ||
      typeof record.startedUtc !== 'string' || !path.isAbsolute(record.studioDir) || !path.isAbsolute(record.authorityDir))
    throw new Error('Invalid Studio connection record: ' + file);
  return record;
}
export function connectionEnvironment(root, lane) {
  const record = readConnection(root, lane);
  return record ? { ANVIL_STUDIO_DIR: record.studioDir, ANVIL_AUTHORITY_DIR: record.authorityDir } : {};
}
// D5 (atritos 3): a connection record whose Studio is gone, or has no main window any more (lanes.studioProcesses window:
// false), is stale: the O11 lane is connected again to the Studio with a window. null when the record still holds.
export function staleConnection(record, processes) {
  if (!record || !Array.isArray(processes)) return null;
  const process = processes.find(p => p.pid === record.pid);
  if (!process) return { pid: record.pid, reason: 'gone' };
  if (process.window === false) return { pid: record.pid, reason: 'windowless', code: 'STUDIO_WINDOWLESS' };
  return null;
}
