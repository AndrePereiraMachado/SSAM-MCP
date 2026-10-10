// The ODC bridge version this checkout builds: the constant of studio/bridge/client/Program.cs, which newestBridgeDll
// (lib.mjs) and scripts/agent-pack.ps1 read. A hosted server asks the agent's pipe for this version, so the fake
// bridges, the pinned kernel.json and the fake packs of the end to end follow it; a bridge bump (v35 -> v37) never leaves
// them on a version the server does not send.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'studio', 'bridge', 'client', 'Program.cs');
const found = /const string Version = "(v\d+)"/.exec(fs.readFileSync(source, 'utf8'))?.[1];
if (!found) throw new Error('No ODC bridge version (const string Version) in ' + source);
export const ODC_BRIDGE = found;
