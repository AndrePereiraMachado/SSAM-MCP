import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createSupervisor } from '../../src/main/core/supervisor.mjs';
import { fakeHub } from '../../agent/tests/fixtures/fake-hub.mjs';

// The real bridge in an isolated .NET host, not an injected developer session.
// Renaming only the test apphost supplies the Studio process identity for this fixture.
test('native channel relays over a Windows pipe to the compiled ODC bridge with data-root binding',
  { skip: !process.env.SSAM_NATIVE_EXE || !process.env.SSAM_TEST_ODC_BRIDGE || !process.env.SSAM_TEST_STUDIO_DIR, timeout: 30000 }, async t => {
    const app = fileURLToPath(new URL('../../', import.meta.url));
    const folder = fs.mkdtempSync(path.join(app, '.local/native/odc-wire-'));
    const runtime = path.join(folder, 'runtime'), root = path.join(folder, 'data'), hostDir = path.join(folder, 'host');
    fs.mkdirSync(runtime); fs.mkdirSync(hostDir);
    const files = [];
    for (const [from, relative] of [[process.env.SSAM_NATIVE_EXE, 'native/ssam-agent.exe'], [process.env.SSAM_TEST_ODC_BRIDGE, 'ODC3.Bridge.v98.dll']]) {
      const data = fs.readFileSync(from), to = path.join(runtime, relative); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, data);
      files.push({ path: relative, size: data.length, sha256: createHash('sha256').update(data).digest('hex') });
    }
    fs.writeFileSync(path.join(runtime, 'pack.json'), JSON.stringify({ id: 'isolated-odc-test', lanes: ['odc'], odcBridge: 'v98', nativeCore: { runtime: 'native-aot', path: 'native/ssam-agent.exe' }, files }));
    const built = path.join(app, 'tests/bridge-host/bin/Release/net10.0');
    for (const name of ['BridgeHost.dll', 'BridgeHost.deps.json', 'BridgeHost.runtimeconfig.json', 'BridgeHost.exe']) fs.copyFileSync(path.join(built, name), path.join(hostDir, name === 'BridgeHost.exe' ? 'ODCStudio.exe' : name));
    const proc = spawn(path.join(hostDir, 'ODCStudio.exe'), [path.join(runtime, 'ODC3.Bridge.v98.dll'), process.env.SSAM_TEST_STUDIO_DIR], { windowsHide: true });
    let error = ''; proc.stderr.on('data', c => { error += c; });
    const exit = new Promise((resolve, reject) => { proc.once('exit', resolve); proc.once('error', reject); });
    const credential = 'ssam_agent_' + 'c'.repeat(43);
    const hub = await fakeHub({ credential, kernel: { odc: '1.0.0', odcBridge: 'v98' } });
    const supervisor = createSupervisor({ root, packDir: runtime, installedPack: true });
    t.after(async () => { await supervisor.shutdown(); proc.kill(); await exit; await hub.close(); fs.rmSync(folder, { recursive: true, force: true }); });
    await Promise.race([new Promise(resolve => proc.stdout.once('data', resolve)), exit.then(() => { throw new Error(error); })]);
    supervisor.syncPack();
    const setup = await supervisor.setup({ server: hub.url, credential }); assert.equal(setup.ok, true, setup.error);
    assert.equal((await supervisor.start()).connected, true);
    hub.stream.write(JSON.stringify({ t: 'call', id: 'stop-bridge', kind: 'odc.pipe', params: { pid: proc.pid, version: 'v98', args: ['stop'] } }) + '\n');
    await hub.until(() => hub.results('stop-bridge').length > 0);
    const reply = hub.results('stop-bridge')[0]; assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.equal(JSON.parse(reply.value.line).stopped, true);
    assert.ok(fs.existsSync(path.join(root, 'odc/journal/operations.jsonl')));
    assert.deepEqual(fs.readdirSync(runtime).sort(), ['ODC3.Bridge.v98.dll', 'native', 'pack.json']);
    proc.stdin.end('\n'); assert.equal(await exit, 0, error);
  });
