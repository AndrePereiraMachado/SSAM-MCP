import { invocationWorker } from './debug-invoke-runtime.mjs';
let data = '';
for await (const chunk of process.stdin) {
  data += chunk;
  if (data.length > 1048576) process.exit(1);
}
try { await invocationWorker(JSON.parse(data)); }
catch { process.exitCode = 1; }
