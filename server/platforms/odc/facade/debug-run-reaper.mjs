// Detached companion of debug-run.mjs: removes the SSAM Debug REST wrapper of <tenant> <module> once no scenario
// has run for the lease's idleMinutes ("SSAM Debug REST Remove"). A newer reaper or a lease that is no longer active
// ends it; a debug operation holding the lock only postpones the removal.
import fs from 'node:fs';
import path from 'node:path';
import { workspaceRoot } from './workspace.mjs';

const [host, module] = process.argv.slice(2);
const file = path.join(workspaceRoot, '.local', 'debugger', 'wrappers', 'odc', host, module + '.json');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
await sleep(5000); // the parent records this pid in the lease right after spawning
while (true) {
  let lease; try { lease = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { process.exit(0); }
  if (lease.state !== 'active' || lease.reaperPid !== process.pid) process.exit(0);
  const due = Date.parse(lease.lastCallAt) + lease.idleMinutes * 60_000;
  if (Date.now() < due) { await sleep(Math.min(due - Date.now(), 5 * 60_000)); continue; }
  const { debugRun } = await import('./debug-run.mjs');
  const result = await debugRun({ op: 'release', tenant: host, module });
  if (result.ok || !/debug_wrapper_busy/.test(result.error ?? '')) process.exit(result.ok ? 0 : 1);
  await sleep(60_000);
}
