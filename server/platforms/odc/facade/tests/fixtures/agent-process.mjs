// The real SSAM agent of an extracted agent pack, in its own process, for the process end to end of phase 2
// (hosted-e2e-processes.mjs). Only the Studio touch points of the machine (process list, installed Studios, file
// versions, describe and attach) are replaced by the fake Studios of fake-studios-process.mjs; everything else is the
// pack's own code: channel, outbox, the 9 kinds, the folder rules, blobs, the ODC pipe and the O11 wire.
//   node agent-process.mjs <agentRoot> <studiosFile>
// Reads private\config.json and private\credential like `ssam-agent.mjs run`; a clean stop is private\agent.stop.
// The exit code is the agent's (0 stopped, 2 credential refused/revoked/rotated, 3 replaced, 4 protocol).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, studiosFile] = process.argv.slice(2);
const { createAgent } = await import(pathToFileURL(path.join(root, 'agent', 'lib', 'agent.mjs')).href);
const studios = JSON.parse(fs.readFileSync(studiosFile, 'utf8'));
const config = JSON.parse(fs.readFileSync(path.join(root, 'private', 'config.json'), 'utf8'));
const logFile = path.join(root, 'private', 'agent.log');
const log = (event, fields = {}) => fs.appendFileSync(logFile, JSON.stringify({ time: new Date().toISOString(), event, ...fields }) + '\n');
const fake = { 'ODCStudio.exe': { pid: studios.odcPid, path: 'C:\\Fake\\ODC Studio\\ODCStudio.exe', version: studios.odcVersion },
  'ServiceStudio.exe': { pid: studios.o11Pid, path: 'C:\\Fake\\Service Studio\\ServiceStudio.exe', version: studios.o11Version } };

const agent = createAgent({ root, config: { server: config.server, o11Port: config.o11Port }, log, deps: {
  processes: async image => (fake[image] ? [fake[image]] : []),
  locate: async kind => (kind === 'odc' ? 'C:\\Fake\\ODC Studio' : 'C:\\Fake\\Service Studio'),
  fileVersion: async exe => fake[path.basename(exe)]?.version ?? null,
  describe: async pid => ({ pid: Number(pid), startedUtc: '2026-10-04T10:00:00Z', version: studios.o11Version, diagnosticsAvailable: true, bridgePath: null, corePath: null }),
  attachOdc: async ({ pid }) => ({ ok: true, attached: true, pid, note: 'fake attach' }),
  attachO11: async () => { throw new Error('the fake O11 bridge already serves this Studio; no attach expected'); },
} });
log('start', { instance: agent.instance, server: config.server });
const stopFile = path.join(root, 'private', 'agent.stop');
const poll = setInterval(() => { if (fs.existsSync(stopFile)) { fs.rmSync(stopFile, { force: true }); agent.stop(); } }, 200);
const code = await agent.run();
clearInterval(poll);
log('exit', { code });
process.exit(code);
