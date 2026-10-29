import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { completeInstances } from './studio-instance.mjs';

// One native enumeration for both Studios. Unavailable or partial is never an empty list.
export function createStudioSnapshot({ runtimeRoot, run = promisify(execFile), now = Date.now, cacheMs = 1000 } = {}) {
  let pending = null, value = null, checkedAt = -Infinity;
  return async () => {
    if (now() - checkedAt < cacheMs) return value;
    if (pending) return pending;
    pending = (async () => {
      try {
        const { stdout } = await run(path.join(runtimeRoot, 'native/ssam-agent.exe'), ['studio-instances'], { windowsHide: true, timeout: 10000 });
        const snapshot = JSON.parse(stdout);
        value = snapshot.complete === true && completeInstances(snapshot.processes) ? snapshot.processes : null;
      } catch { value = null; }
      checkedAt = now(); return value;
    })();
    try { return await pending; } finally { pending = null; }
  };
}
