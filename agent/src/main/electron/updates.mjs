// The app's own updates, from the owner's update server (electron-updater, generic provider: a folder served over
// HTTPS with latest.yml / latest-mac.yml and the installers, the files `npm run dist:win` and `npm run dist:mac`
// produce). The server is the one the build fixed in resources/app-update.yml, unless the setting or SSAM_UPDATE_URL
// says another (settings.mjs resolveUpdateUrl). An update is downloaded as soon as it is seen and, by default,
// installed by itself a few seconds later (the agent is stopped cleanly first, the app restarts and the agent comes
// back): no click is needed. With updateAutoInstall off it waits for the tray or the panel, or for the app to quit.
// Without a server, updates are off and the panel says so. On macOS an update only installs when the app is signed.
// Windows (app 0.2.8): the app is never Authenticode-signed; a downloaded installer is installed only after the owner's
// Ed25519-signed statement next to it in the feed (<installer>.ed25519.json) verifies against the key pinned at build time
// and names exactly its version, size and sha512, newer than this app (update-signature.mjs). Otherwise it is refused with
// a code (UPDATE_SIGNATURE_MISSING, UPDATE_SIGNATURE_INVALID, UPDATE_STATEMENT_MISMATCH, UPDATE_DOWNGRADE, ...).
import fs from 'node:fs';
import path from 'node:path';
import updater from 'electron-updater';
import { execFileSync } from 'node:child_process';
import { INITIAL, reduce, canCheck, describeUpdateError, updateTrustProblem } from '../core/update-model.mjs';
import { UPDATE_CODES } from '../core/update-signature.mjs';
import { verifyWindowsUpdate } from '../core/update-verify.mjs';
import { UPDATE_PUBLIC_KEY } from '../core/update-trust.mjs';

const { autoUpdater } = updater;
const FIRST_CHECK_MS = 20000;
// The pause between the download and the automatic install: time for a call in flight on the agent to finish.
const AUTO_INSTALL_DELAY_MS = 15000;

// The text of resources/app-update.yml, or null.
export function buildUpdateConfig(resourcesPath) {
  try { return fs.readFileSync(path.join(resourcesPath, 'app-update.yml'), 'utf8'); } catch { return null; }
}

// The url of resources/app-update.yml (what electron-builder wrote at build time), or null.
export function buildUpdateUrl(resourcesPath) {
  try {
    const text = fs.readFileSync(path.join(resourcesPath, 'app-update.yml'), 'utf8');
    const match = /^url:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(text);
    return match ? match[1] : null;
  } catch { return null; }
}

// The version resource of a downloaded installer: {productVersion, productName}, or {} when it cannot be read.
export function readInstallerVersion(file) {
  if (!file) return {};
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', '$v = (Get-Item -LiteralPath $env:SSAM_INSTALLER).VersionInfo; @{ productVersion = $v.ProductVersion; productName = $v.ProductName } | ConvertTo-Json -Compress'],
      { encoding: 'utf8', windowsHide: true, timeout: 20000, env: { ...process.env, SSAM_INSTALLER: file } });
    const value = JSON.parse(out);
    return { productVersion: value.productVersion ?? null, productName: value.productName ?? null };
  } catch { return {}; }
}

export function createUpdates({ url: wanted, hours = 6, autoInstall = true, log, onChange = () => {}, isPackaged = true, devConfig = null, stopAgent = async () => {},
  platform = process.platform, appUpdateYml = null, currentVersion = null, readInstaller = readInstallerVersion, updatePublicKey = UPDATE_PUBLIC_KEY,
  verifyUpdate = verifyWindowsUpdate }) {
  // A Windows build that cannot verify who made an update never installs one (update-model.mjs updateTrustProblem): it needs
  // the pinned Ed25519 update key. appUpdateYml (still passed by index.mjs) is read by electron-updater itself: a publisherName
  // a legacy signed build carries is checked there, on top of the statement.
  const untrusted = wanted ? updateTrustProblem({ platform, isPackaged, updatePublicKey }) : null;
  const url = untrusted ? null : wanted;
  if (untrusted) log.write('updates-off', { reason: untrusted });
  let state = url ? reduce(INITIAL, { type: 'configured', url }) : reduce(INITIAL, { type: 'off', reason: untrusted });
  let timer = null; let installTimer = null; let verified = false;
  const emit = event => { state = reduce(state, event); onChange(state); };

  if (url) {
    autoUpdater.logger = log.updaterLogger;
    autoUpdater.autoDownload = true;
    // Never installed on quit before the downloaded installer's own version was checked (installerVersionProblem).
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    // A checkout run (not packaged) checks only with a dev-app-update.yml.
    if (!isPackaged) { autoUpdater.forceDevUpdateConfig = Boolean(devConfig && fs.existsSync(devConfig)); if (devConfig) autoUpdater.updateConfigPath = devConfig; }
    autoUpdater.setFeedURL({ provider: 'generic', url, channel: 'latest' });
    autoUpdater.on('checking-for-update', () => emit({ type: 'checking-for-update' }));
    autoUpdater.on('update-available', info => emit({ type: 'update-available', version: info?.version ?? null }));
    autoUpdater.on('update-not-available', () => emit({ type: 'update-not-available', at: new Date().toISOString() }));
    autoUpdater.on('download-progress', progress => emit({ type: 'download-progress', percent: progress?.percent ?? 0 }));
    autoUpdater.on('update-downloaded', info => { accept(info).catch(error => log.write('update-refused', { version: info?.version ?? null, code: UPDATE_CODES.SIGNATURE_INVALID, reason: String(error?.message ?? error).slice(0, 300) })); });
    autoUpdater.on('error', error => { emit({ type: 'error', message: describeUpdateError(error?.message ?? String(error)) }); log.write('update-error', { message: String(error?.message ?? error).slice(0, 500) }); });
  }

  // A downloaded update becomes ready only once verified: on Windows the owner's signed statement and the installer's own
  // version (core/update-verify.mjs verifyWindowsUpdate); a refusal leaves it uninstalled, never installed on quit.
  async function accept(info) {
    verified = false; autoUpdater.autoInstallOnAppQuit = false;
    const problem = platform === 'win32' ? await verifyUpdate({ info, feed: url, currentVersion, publicKey: updatePublicKey, readInstaller: readInstaller ?? readInstallerVersion }) : null;
    if (problem) {
      verified = false; autoUpdater.autoInstallOnAppQuit = false;
      log.write('update-refused', { version: info?.version ?? null, code: problem.code, reason: problem.message });
      emit({ type: 'error', message: problem.message });
      return;
    }
    verified = true; autoUpdater.autoInstallOnAppQuit = true;
    emit({ type: 'update-downloaded', version: info?.version ?? null });
    log.write('update-ready', { version: info?.version ?? null, autoInstall });
    if (autoInstall) {
      installTimer = setTimeout(() => { installTimer = null; installNow().catch(error => log.write('update-install-failed', { error: error.message })); }, AUTO_INSTALL_DELAY_MS);
    }
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
    if (state.status !== 'ready' || !verified) return false;
    if (installTimer) { clearTimeout(installTimer); installTimer = null; }
    log.write('update-install', { version: state.version });
    await stopAgent();
    autoUpdater.quitAndInstall(true, true);
    return true;
  }

  function dispose() { if (timer) clearTimeout(timer); timer = null; if (installTimer) clearTimeout(installTimer); installTimer = null; }

  return { get state() { return state; }, url, check, schedule, installNow, dispose };
}
