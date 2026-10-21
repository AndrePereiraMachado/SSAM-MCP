// The app's own updates, from the owner's update server (electron-updater, generic provider: a folder served over
// HTTPS with latest.yml / latest-mac.yml and the installers, the files `npm run dist:win` and `npm run dist:mac`
// produce). The server is the one the build fixed in resources/app-update.yml, unless the setting or SSAM_UPDATE_URL
// says another (settings.mjs resolveUpdateUrl). An update is downloaded as soon as it is seen and, by default,
// installed by itself a few seconds later (the agent is stopped cleanly first, the app restarts and the agent comes
// back): no click is needed. With updateAutoInstall off it waits for the tray or the panel, or for the app to quit.
// Without a server, updates are off and the panel says so. On macOS an update only installs when the app is signed.
import fs from 'node:fs';
import path from 'node:path';
import updater from 'electron-updater';
import { INITIAL, reduce, canCheck, describeUpdateError } from '../core/update-model.mjs';

const { autoUpdater } = updater;
const FIRST_CHECK_MS = 20000;
// The pause between the download and the automatic install: time for a call in flight on the agent to finish.
const AUTO_INSTALL_DELAY_MS = 15000;

// The url of resources/app-update.yml (what electron-builder wrote at build time), or null.
export function buildUpdateUrl(resourcesPath) {
  try {
    const text = fs.readFileSync(path.join(resourcesPath, 'app-update.yml'), 'utf8');
    const match = /^url:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(text);
    return match ? match[1] : null;
  } catch { return null; }
}

export function createUpdates({ url, hours = 6, autoInstall = true, log, onChange = () => {}, isPackaged = true, devConfig = null, stopAgent = async () => {} }) {
  let state = url ? reduce(INITIAL, { type: 'configured', url }) : reduce(INITIAL, { type: 'off' });
  let timer = null; let installTimer = null;
  const emit = event => { state = reduce(state, event); onChange(state); };

  if (url) {
    autoUpdater.logger = log.updaterLogger;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    // A checkout run (not packaged) checks only with a dev-app-update.yml.
    if (!isPackaged) { autoUpdater.forceDevUpdateConfig = Boolean(devConfig && fs.existsSync(devConfig)); if (devConfig) autoUpdater.updateConfigPath = devConfig; }
    autoUpdater.setFeedURL({ provider: 'generic', url, channel: 'latest' });
    autoUpdater.on('checking-for-update', () => emit({ type: 'checking-for-update' }));
    autoUpdater.on('update-available', info => emit({ type: 'update-available', version: info?.version ?? null }));
    autoUpdater.on('update-not-available', () => emit({ type: 'update-not-available', at: new Date().toISOString() }));
    autoUpdater.on('download-progress', progress => emit({ type: 'download-progress', percent: progress?.percent ?? 0 }));
    autoUpdater.on('update-downloaded', info => {
      emit({ type: 'update-downloaded', version: info?.version ?? null });
      log.write('update-ready', { version: info?.version ?? null, autoInstall });
      if (autoInstall) {
        installTimer = setTimeout(() => { installTimer = null; installNow().catch(error => log.write('update-install-failed', { error: error.message })); }, AUTO_INSTALL_DELAY_MS);
      }
    });
    autoUpdater.on('error', error => { emit({ type: 'error', message: describeUpdateError(error?.message ?? String(error)) }); log.write('update-error', { message: String(error?.message ?? error).slice(0, 500) }); });
  }

  async function check({ force = false } = {}) {
    if (!url) return state;
    if (!force && !canCheck(state)) return state;
    if (!canCheck(state)) return state;
    try { await autoUpdater.checkForUpdates(); }
    catch (error) { emit({ type: 'error', message: describeUpdateError(error?.message ?? String(error)) }); }
    return state;
  }

  function schedule() {
    if (!url) return;
    const every = Math.max(1, hours) * 3600000;
    const tick = async () => { await check(); emit({ type: 'scheduled', at: new Date(Date.now() + every).toISOString() }); timer = setTimeout(tick, every); if (timer.unref) timer.unref(); };
    emit({ type: 'scheduled', at: new Date(Date.now() + FIRST_CHECK_MS).toISOString() });
    timer = setTimeout(tick, FIRST_CHECK_MS);
    if (timer.unref) timer.unref();
  }

  // The agent stopped cleanly, then the app replaced by the downloaded update and started again (silent install).
  async function installNow() {
    if (state.status !== 'ready') return false;
    if (installTimer) { clearTimeout(installTimer); installTimer = null; }
    log.write('update-install', { version: state.version });
    await stopAgent();
    autoUpdater.quitAndInstall(true, true);
    return true;
  }

  function dispose() { if (timer) clearTimeout(timer); timer = null; if (installTimer) clearTimeout(installTimer); installTimer = null; }

  return { get state() { return state; }, url, check, schedule, installNow, dispose };
}
