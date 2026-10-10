// A temporary agent root under %TEMP% (no spaces) with the 6.2 data layout and a pack.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LAYOUT } from '../../lib/workspace.mjs';

export const CREDENTIAL = 'ssam_agent_' + 'A'.repeat(20) + 'b'.repeat(20) + '_-9';

export function makeRoot({ lanes = ['odc', 'o11'], odcBridge = 'v35', o11BuiltFor = '11.55.91' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-agent-test-'));
  if (/\s/.test(root)) throw new Error('The test temp folder has a space: ' + root);
  for (const folder of LAYOUT) fs.mkdirSync(path.join(root, ...folder.split('/')), { recursive: true });
  fs.writeFileSync(path.join(root, 'pack.json'), JSON.stringify({ id: 'pack-test', lanes, odcBridge, o11BuiltFor, files: [] }));
  return root;
}

export const removeRoot = root => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
