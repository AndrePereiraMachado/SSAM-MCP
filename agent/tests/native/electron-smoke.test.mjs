import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fakeHub } from '../../agent/tests/fixtures/fake-hub.mjs';
import { defaultRoot } from '../../src/main/core/paths.mjs';

// Optional full UI check, after `npm run build` and preparing the native pack.
// PLAYWRIGHT_MODULE points to the test host's Playwright installation.
test('built Electron panel configures and supervises the native core through its sandboxed preload',
  { skip: !process.env.PLAYWRIGHT_MODULE, timeout: 60000 }, async t => {
    const { _electron } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE);
    const app = fileURLToPath(new URL('../../', import.meta.url));
    const folder = fs.mkdtempSync(path.join(app, '.local/native/electron-smoke-'));
    const userData = path.join(folder, 'ui');
    const root = process.env.SSAM_PACKAGED_APP ? path.join(defaultRoot(), path.basename(folder)) : path.join(folder, 'data');
    fs.mkdirSync(userData);
    fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ root, autostart: false, updateAutoInstall: false }));
    const bootstrap = path.join(folder, 'bootstrap.cjs');
    fs.writeFileSync(bootstrap, `const {app}=require('electron'); app.setPath('userData',${JSON.stringify(userData)}); import(${JSON.stringify(pathToFileURL(path.join(app, 'out/main/index.js')).href)});`);
    const credential = 'ssam_agent_' + 'b'.repeat(43);
    const hub = await fakeHub({ credential });
    let electron;
    t.after(async () => { if (electron) await electron.close(); await hub.close(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(folder, { recursive: true, force: true }); });
    const env = { ...process.env, SSAM_TEST_SERVER: hub.url }; delete env.ELECTRON_RUN_AS_NODE;
    const executable = process.platform === 'darwin' ? 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron' : 'node_modules/electron/dist/electron.exe';
    const packaged = process.env.SSAM_PACKAGED_APP;
    electron = await _electron.launch({ executablePath: packaged || path.join(app, executable),
      args: packaged ? ['--user-data-dir=' + userData] : [bootstrap], env, timeout: 20000 });
    if (packaged) {
      assert.equal(await electron.evaluate(({ app }) => app.isPackaged), true);
      assert.equal(await electron.evaluate(({ app }) => app.getPath('userData')), userData);
    }
    const page = await electron.firstWindow();
    assert.equal(await page.getByLabel('Agent folder', { exact: true }).count(), 0);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    assert.equal(await page.getByLabel('Server address').count(), 0);
    await page.getByLabel('Activation token').fill(credential);
    await page.getByRole('button', { name: 'Activate and connect' }).click();
    await hub.until(() => hub.streams === 1);
    await page.waitForFunction(async () => (await window.ssam.getState()).agent.view.status === 'connected');
    assert.equal(hub.hellos[0].agent.runtime, 'native-aot');
    assert.equal(await page.getByRole('button', { name: 'Open folder', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Check connection', exact: true }).click();
    await page.getByText('Connection OK.', { exact: true }).waitFor();
    hub.unhealthy = true;
    await page.getByRole('button', { name: 'Check connection', exact: true }).click();
    await page.getByText('The service is temporarily unavailable. Try again shortly.', { exact: true }).waitFor();
    hub.unhealthy = false;
    await page.getByRole('button', { name: 'Check connection', exact: true }).click();
    await page.getByText('Connection OK.', { exact: true }).waitFor();
    assert.equal(await page.getByText('Update server', { exact: true }).count(), 0);
    assert.equal(await page.getByText('Agent log', { exact: true }).count(), 0);
    await page.screenshot({ path: path.join(app, '.local/native/electron-connected.png'), fullPage: true });
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await page.waitForFunction(async () => (await window.ssam.getState()).agent.view.status === 'stopped');
    assert.equal(hub.deletes, 1);
    await page.getByRole('button', { name: 'Check connection', exact: true }).click();
    await page.getByText('Service reachable. This computer is disconnected.', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    assert.deepEqual(fs.readdirSync(root).sort(), ['inbox', 'o11', 'odc', 'private']);
  });
