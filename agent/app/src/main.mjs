// SSAM Agent, the desktop app: the agent of docs/AGENTE-CLIENTE.md and docs/AGENTE-MAC.md kept running in the
// background, with an icon in the tray (Windows) or the menu bar (macOS), no window until the person opens the panel,
// and the app itself updated from the owner's update server. What the agent does and what it never does is unchanged:
// this app only puts the pack in the agent root, starts `ssam-agent.mjs run` as a child process, shows its state and
// stops it cleanly. One instance per user; a second launch opens the panel of the first.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, ipcMain, dialog, shell, Notification } from 'electron';
import { createSupervisor } from './supervisor.mjs';
import { forkWithUtilityProcess } from './electron/runtime.mjs';
import { createAppLog } from './electron/app-log.mjs';
import { createTray } from './electron/tray.mjs';
import { createPanel } from './electron/window.mjs';
import { createUpdates, buildUpdateUrl } from './electron/updates.mjs';
import { loadSettings, saveSettings, resolveUpdateUrl, updateUrlProblem } from './settings.mjs';
import { defaultRoot, bundledPackDir } from './paths.mjs';
import { verifyPack } from './pack-sync.mjs';
import { INITIAL } from './update-model.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const APP_ID = 'com.ssam.agent';

if (!app.requestSingleInstanceLock()) app.quit();
else void run();

async function run() {
  app.setAppUserModelId(APP_ID);
  await app.whenReady();
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  const userData = app.getPath('userData');
  const log = createAppLog(path.join(userData, 'app.log'));
  const settingsFile = path.join(userData, 'settings.json');
  let settings = loadSettings(settingsFile);
  const packDir = bundledPackDir({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: appDir });
  const appVersion = app.getVersion();
  log.write('app-start', { version: appVersion, electron: process.versions.electron, node: process.version, platform: process.platform, packaged: app.isPackaged, packDir });

  const packCheck = verifyPack(packDir);
  if (!packCheck.ok) log.write('pack-problem', { detail: packCheck.detail });

  // The agent root: the setting, else the folder the guides give.
  let root = settings.root ?? defaultRoot();
  let supervisor = null;
  let updateState = INITIAL;
  let quitting = false;
  let busy = false;
  let notified = null;

  const panel = createPanel({ uiDir: path.join(appDir, 'ui'), preload: path.join(here, 'preload.cjs'),
    iconPath: process.platform === 'win32' ? path.join(appDir, 'build', 'icon.png') : null, onReady: () => push() });
  const tray = createTray({ iconsDir: path.join(appDir, 'assets', 'tray'), onAction: action => act(action).catch(error => log.write('action-failed', { action, error: error.message })) });

  const updateUrl = resolveUpdateUrl({ env: process.env, settings, build: buildUpdateUrl(process.resourcesPath) });
  const updates = createUpdates({ url: updateUrl.url, hours: settings.updateCheckHours, log, isPackaged: app.isPackaged,
    onChange: state => { updateState = state; push(); }, stopAgent: async () => { if (supervisor) await supervisor.stop(); } });
  updateState = updates.state;
  log.write('updates', { url: updateUrl.url, source: updateUrl.source });

  function makeSupervisor(target) {
    return createSupervisor({ root: target, packDir, fork: forkWithUtilityProcess(), env: process.env, log: log.write, onChange: () => push() });
  }
  supervisor = makeSupervisor(root);

  function fullState() {
    const agent = supervisor.snapshot();
    if (!packCheck.ok) agent.view = { status: 'attention', text: 'App needs attention', detail: `The pack bundled with this app is damaged (${packCheck.detail}); install the app again.`, attention: true };
    return { app: { version: appVersion, platform: process.platform, packaged: app.isPackaged, electron: process.versions.electron, node: process.version,
      updateUrl: updateUrl.url, updateSource: updateUrl.source, logFile: log.file, settingsFile, defaultRoot: defaultRoot(), bundledPack: packCheck.pack?.id ?? null },
      settings, agent, update: updateState, busy };
  }

  function push() {
    const state = fullState();
    tray.update({ view: state.agent.view, update: state.update, appVersion, settings, busy });
    panel.send('state', state);
    notice(state.agent.view);
  }

  // One notification per entry into a state that needs the person.
  function notice(view) {
    if (!view.attention || view.status === 'not-set-up') { if (!view.attention) notified = null; return; }
    if (notified === view.detail) return;
    notified = view.detail;
    if (Notification.isSupported()) new Notification({ title: 'SSAM Agent: ' + view.text, body: view.detail }).show();
  }

  async function withBusy(work) {
    busy = true; push();
    try { return await work(); } finally { busy = false; push(); }
  }

  async function act(action) {
    log.write('action', { action });
    switch (action) {
      case 'panel': panel.open(); return;
      case 'start': if (fullState().agent.view.status === 'not-set-up') { panel.open(); return; } await withBusy(() => supervisor.start()); return;
      case 'stop': await withBusy(() => supervisor.stop()); return;
      case 'folder': fs.mkdirSync(root, { recursive: true }); await shell.openPath(root); return;
      case 'log': await openFile(supervisor.files.log); return;
      case 'check-updates': await updates.check({ force: true }); return;
      case 'install-update': await updates.installNow(); return;
      case 'autostart': setSettings({ autostart: !settings.autostart }); return;
      case 'quit': app.quit(); return;
      default: return;
    }
  }

  async function openFile(file) {
    if (!fs.existsSync(file)) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, ''); }
    await shell.openPath(file);
  }

  function applyLoginItem() {
    try { app.setLoginItemSettings({ openAtLogin: settings.autostart === true, openAsHidden: true }); }
    catch (error) { log.write('login-item-failed', { error: error.message }); }
  }

  function setSettings(changes) {
    const next = { ...settings, ...changes };
    const problem = changes.updateUrl !== undefined ? updateUrlProblem(changes.updateUrl) : null;
    if (problem) throw new Error(problem);
    settings = saveSettings(settingsFile, next);
    applyLoginItem();
    push();
    return settings;
  }

  // The root changed: the running agent stopped, a supervisor for the new folder (the pack is synced by setup).
  async function changeRoot(target) {
    if (target === root) return;
    await supervisor.stop();
    supervisor = makeSupervisor(target);
    root = target;
    setSettings({ root: target });
  }

  ipcMain.handle('state:get', () => fullState());
  ipcMain.handle('agent:setup', async (_event, payload = {}) => withBusy(async () => {
    const target = typeof payload.root === 'string' && payload.root.trim() ? payload.root.trim() : root;
    await changeRoot(target);
    const result = await supervisor.setup({ server: String(payload.server ?? '').trim(), credential: String(payload.credential ?? ''), o11Port: payload.o11Port ? String(payload.o11Port).trim() : null });
    if (result.ok) {
      if (typeof payload.autostart === 'boolean') setSettings({ autostart: payload.autostart });
      const started = await supervisor.start();
      return { ...result, started };
    }
    return result;
  }));
  ipcMain.handle('agent:start', () => withBusy(() => supervisor.start()));
  ipcMain.handle('agent:stop', () => withBusy(() => supervisor.stop()));
  ipcMain.handle('agent:doctor', () => withBusy(() => supervisor.doctor()));
  ipcMain.handle('agent:log', () => { try { const lines = fs.readFileSync(supervisor.files.log, 'utf8').split(/\r?\n/).filter(Boolean); return lines.slice(-80); } catch { return []; } });
  ipcMain.handle('updates:check', () => updates.check({ force: true }));
  ipcMain.handle('updates:install', () => updates.installNow());
  ipcMain.handle('settings:set', (_event, payload = {}) => setSettings(payload));
  ipcMain.handle('root:pick', async () => {
    const result = await dialog.showOpenDialog(panel.window ?? undefined, { title: 'Choose the agent folder', defaultPath: root, properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('open:folder', () => act('folder'));
  ipcMain.handle('open:log', () => act('log'));
  ipcMain.handle('open:app-log', () => openFile(log.file));
  ipcMain.handle('app:quit', () => app.quit());

  app.on('second-instance', () => panel.open());
  app.on('window-all-closed', () => { /* the app lives in the tray */ });
  app.on('activate', () => panel.open());
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    log.write('app-quit');
    Promise.resolve(supervisor.shutdown()).catch(() => {}).then(() => { updates.dispose(); tray.destroy(); app.quit(); });
  });

  applyLoginItem();
  push();
  updates.schedule();

  // Set up: the agent starts with the app (that is what a background app is for). Not set up: the panel opens.
  const state = fullState();
  if (packCheck.ok && state.agent.setUp && state.agent.view.status !== 'external') {
    supervisor.start().then(result => log.write('autostart', result)).catch(error => log.write('autostart-failed', { error: error.message }));
  } else panel.open();
}
