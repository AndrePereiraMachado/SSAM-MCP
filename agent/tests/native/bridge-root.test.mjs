import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pipeCall } from '../../agent/lib/odc-pipe.mjs';
import { LAYOUT } from '../../agent/lib/workspace.mjs';

const app = fileURLToPath(new URL('../../', import.meta.url));
const bridge = process.env.SSAM_TEST_ODC_BRIDGE;
const studio = process.env.SSAM_TEST_STUDIO_DIR;
test('compiled ODC bridge binds data before writing, rejects relocation, and leaves installation unchanged',
  { skip: process.platform !== 'win32' || !bridge || !studio, timeout: 20000 }, async t => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-bridge-root-'));
    const installed = path.join(parent, 'pack'); const data = path.join(parent, 'data');
    fs.mkdirSync(installed);
    fs.writeFileSync(path.join(installed, 'pack.json'), '{}');
    const copy = path.join(installed, path.basename(bridge));
    fs.copyFileSync(bridge, copy);
    for (const folder of LAYOUT) fs.mkdirSync(path.join(data, folder), { recursive: true });
    const proc = spawn('dotnet', [path.join(app, 'tests/bridge-host/bin/Release/net10.0/BridgeHost.dll'), copy, studio], { windowsHide: true });
    let stderr = ''; proc.stderr.on('data', c => { stderr += c; });
    const exit = new Promise((resolve, reject) => { proc.once('exit', resolve); proc.once('error', reject); });
    t.after(async () => { proc.kill(); await exit; fs.rmSync(parent, { recursive: true, force: true }); });
    await Promise.race([
      new Promise(resolve => proc.stdout.once('data', resolve)),
      exit.then(code => { throw new Error('bridge host exited: ' + code + '\n' + stderr); })
    ]);
    const version = /ODC3\.Bridge\.(v\d+)\.dll$/.exec(copy)[1];
    const call = async args => JSON.parse(await pipeCall(proc.pid, version, args, { timeoutMs: 5000 }));
    const before = await call(['status']);
    assert.equal(before.ok, false);
    assert.match(before.error, /AGENT_ROOT_REQUIRED/);
    assert.deepEqual(fs.readdirSync(installed).sort(), [path.basename(copy), 'pack.json'].sort());
    const request = ['agent-root', JSON.stringify({ root: path.join(data, 'odc') })];
    assert.deepEqual(await call(request), { ok: true, protocol: 1, root: path.join(data, 'odc') });
    assert.equal((await call(request)).ok, true);
    const another = path.join(parent, 'another');
    for (const folder of LAYOUT) fs.mkdirSync(path.join(another, folder), { recursive: true });
    assert.match((await call(['agent-root', JSON.stringify({ root: path.join(another, 'odc') })])).error, /AGENT_ROOT_LOCKED/);
    assert.equal((await call(['stop'])).stopped, true);
    assert.ok(fs.existsSync(path.join(data, 'odc/journal/operations.jsonl')));
    assert.deepEqual(fs.readdirSync(installed).sort(), [path.basename(copy), 'pack.json'].sort());
    proc.stdin.end('\n');
    assert.equal(await exit, 0, stderr);
  });
