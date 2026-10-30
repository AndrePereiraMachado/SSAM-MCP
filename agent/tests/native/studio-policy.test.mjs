import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createKinds, ODC_COMMANDS, O11_METHODS } from '../../agent/lib/kinds.mjs';
import { createWorkspace, LAYOUT } from '../../agent/lib/workspace.mjs';

test('native Studio policy preserves the existing command allowlists and path refusals', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-policy-'));
  try {
    for (const dir of LAYOUT) fs.mkdirSync(path.join(root, dir), { recursive: true });
    const kinds = createKinds({ root, ws: createWorkspace(root), pack: { lanes: ['odc', 'o11'], odcBridge: 'v98' }, deps: { processes: async () => [] } });
    const requests = ODC_COMMANDS.map(command => ({ kind: 'odc.pipe', args: [command] }));
    requests.push(...O11_METHODS.map(method => ({ kind: 'o11.bridge', method, params: {} })));
    for (const value of ['agent:odc/lab/x.json', 'agent:o11/x.json', 'agent:inbox/x.json', 'agent:private/credential', 'agent:o11/../private/x', 'C:\\outside\\x', 'agent:o11/with space', 'agent:o11/nul']) {
      requests.push({ kind: 'odc.pipe', args: ['merge', value] }, { kind: 'odc.pipe', args: ['data', 'Module', 'Entity', '--out', value] },
        { kind: 'odc.pipe', args: ['reference-snapshot', JSON.stringify({ output: value })] },
        { kind: 'o11.bridge', method: 'snapshot_module', params: { path: value } }, { kind: 'o11.bridge', method: 'merge_from_oml', params: { foreign_path: value } });
    }
    requests.push({ kind: 'odc.pipe', args: ['agent-root', '{}'] }, { kind: 'odc.pipe', args: ['status\nstop'] },
      { kind: 'odc.pipe', args: ['status', '--out C:\\outside\\x'] }, { kind: 'o11.bridge', method: 'sc_private_http', params: {} },
      { kind: 'o11.bridge', method: 'sc_http', params: { args: { outFile: 'agent:o11/x' } } });
    const expected = [];
    for (const request of requests) {
      try { await kinds.execute(request.kind, { ...request, pid: 999999, version: 'v98' }); expected.push(null); }
      catch (e) { expected.push(['STUDIO_NOT_SELECTED', 'O11_NOT_CONNECTED'].includes(e.code) ? null : e.code); }
    }
    const app = fileURLToPath(new URL('../../', import.meta.url));
    const executable = process.env.SSAM_NATIVE_EXE;
    const args = ['check-policy', '--root', root];
    const run = spawnSync(executable ?? 'dotnet', executable ? args : [path.join(app, 'native/Ssam.Agent/bin/Release/net10.0/ssam-agent.dll'), ...args], { input: JSON.stringify(requests), encoding: 'utf8', windowsHide: true });
    assert.equal(run.status, 0, run.stderr);
    const results = JSON.parse(run.stdout);
    requests.forEach((request, i) => assert.equal(results[i].error ?? null, expected[i], JSON.stringify(request)));
    assert.equal(results.find((r, i) => requests[i].args?.[0] === 'merge' && requests[i].args?.[1] === 'agent:odc/lab/x.json').value[1], path.join(root, 'odc/lab/x.json'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
