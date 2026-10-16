// CX15 r2 (I): the OTHER process of the concurrency tests (spawned by destructive-r2-records.test.mjs).
//   run <dir> <serverFile> <token> <words> <out>: the same execution of a token through serviceCenterTool (the CLI path:
//     no write lock of the MCP server), its answer written to <out>.
//   hold <leaseFile> <ready>: holds the lease file of an operation with its own pid (a process between taking the lease
//     and writing its record), writes <ready>, and stays alive until it is killed (60 s at most).
import './isolated-profile.mjs';
import fs from 'node:fs';
import { serviceCenterTool } from '../../service-center/index.mjs';
import { HOST, deps } from './destructive-r2-world.mjs';

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'run') {
  const [dir, serverFile, token, words, out] = rest;
  const clock = () => Date.parse('2026-10-15T12:00:30Z');
  const result = await serviceCenterTool(['delete', '--confirmation-token=' + token, '--words=' + words, '--host=' + HOST], deps({ dir, serverFile, who: 'B', clock }));
  const r = result.result ?? {};
  fs.writeFileSync(out, JSON.stringify({ pid: process.pid, ok: result.ok, code: r.code ?? result.code ?? null, problems: (r.problems ?? []).map(p => p.code), state: r.state ?? null,
    deleted: (r.deleted ?? []).map(d => d.name) }));
} else if (mode === 'hold') {
  const [leaseFile, ready] = rest;
  fs.writeFileSync(leaseFile, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' });
  fs.writeFileSync(ready, String(process.pid));
  setTimeout(() => process.exit(0), 60000);
} else {
  process.stderr.write('unknown mode ' + mode);
  process.exit(2);
}
