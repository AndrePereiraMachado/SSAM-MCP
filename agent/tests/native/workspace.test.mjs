import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createWorkspace, LAYOUT } from '../../agent/lib/workspace.mjs';

const app = fileURLToPath(new URL('../../', import.meta.url));
test('native workspace matches the existing wire grammar and refuses junction escapes', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-native-paths-'));
  const root = path.join(parent, 'data'); const outside = path.join(parent, 'installation');
  fs.mkdirSync(outside);
  for (const folder of LAYOUT) fs.mkdirSync(path.join(root, folder), { recursive: true });
  fs.symlinkSync(outside, path.join(root, 'o11/escape'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.symlinkSync(path.join(root, 'o11/downloads'), path.join(root, 'o11/inside'), process.platform === 'win32' ? 'junction' : 'dir');
  // A link target can reintroduce a linked ancestor, as /var -> /private/var
  // does on macOS. Both sides of the confinement check must be canonical.
  const alias = path.join(parent, 'data-alias');
  fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  fs.symlinkSync(path.join(alias, 'o11/downloads'), path.join(root, 'o11/inside-alias'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.symlinkSync(path.join(alias, 'private'), path.join(root, 'o11/private-alias'), process.platform === 'win32' ? 'junction' : 'dir');
  try {
    const relative = ['o11/a.json', 'inbox/base.oml', 'o11', 'odc/lab/job/x', 'odc/snapshots/A.oml', 'ODC/LAB/x',
      'private/credential', 'agent/lib/x.mjs', 'bin/bridge.dll', 'pack.json', 'odc/studio/x.dll',
      'o11/../private/x', 'o11/./x', 'o11//x', '/o11/x', 'C:\\x', '\\\\server\\x',
      'o11/nul.json', 'o11/com¹.txt', 'o11/x:stream', 'o11/x.', 'o11/x ', 'o11/a\0b', 'o11/a\nb',
      'o11/escape/new/file', 'o11/inside/new/file', 'o11/inside-alias/new/file', 'o11/private-alias/new/file', 'odc/lab', 'inbox', 'o11/trailing/'];
    const requests = relative.flatMap(value => [false, true].map(write => ({ value: 'agent:' + value, write })));
    requests.push({ value: 'no-agent-prefix' });
    for (const value of [path.join(root, 'o11/x'), path.join(outside, 'o11/x'), path.join(root, 'private/credential')])
      for (const op of ['absolute', 'toAgent']) requests.push({ op, value });
    const workspace = createWorkspace(root);
    const expected = requests.map(({ op, value, write }) => {
      try {
        return { value: workspace[op === 'absolute' ? 'checkAbsolute' : op === 'toAgent' ? 'toAgent' : 'resolve'](value, write ? 'write' : 'read') };
      } catch (error) { return { error: error.code }; }
    });
    const exe = process.env.SSAM_NATIVE_EXE;
    const args = ['check-paths', '--root', root];
    const result = spawnSync(exe || 'dotnet', exe ? args : [path.join(app, 'native/Ssam.Agent/bin/Release/net10.0/ssam-agent.dll'), ...args],
      { input: JSON.stringify(requests), encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const actual = JSON.parse(result.stdout);
    requests.forEach((request, i) => assert.deepEqual(actual[i], expected[i], JSON.stringify(request)));
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});
