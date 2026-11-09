// The app's own updates, from the owner's update server (electron-updater, generic provider: a folder served over
// HTTPS with latest.yml / latest-mac.yml and the installers, the files `npm run dist:win` and `npm run dist:mac`
// produce). The server is the one the build fixed in resources/app-update.yml, unless the setting or SSAM_UPDATE_URL
// says another (settings.mjs resolveUpdateUrl). An update is downloaded as soon as it is seen and, by default,
// installed by itself a few seconds later (the agent is stopped cleanly first, the app restarts and the agent comes
// back): no click is needed. With updateAutoInstall off it waits for the tray or the panel, or for the app to quit.
// Without a server, updates are off and the panel says so. On macOS an update only installs when the app is signed (Squirrel.Mac).
// Windows (app 0.2.8): the app is never Authenticode-signed; a downloaded installer is installed only after the owner's
// Ed25519-signed statement next to it in the feed (<installer>.ed25519.json) verifies against the key pinned at build time
// and names exactly its version, size and sha512, newer than this app (update-signature.mjs). Otherwise it is refused with
// a code (UPDATE_SIGNATURE_MISSING, UPDATE_SIGNATURE_INVALID, UPDATE_STATEMENT_MISMATCH, UPDATE_DOWNGRADE, ...).
// Windows, order and quit (review M1/M2 of 0.2.8): each download is one generation; only the verification of the newest
// download may make an update ready (an older one that finishes last is dropped), a check cannot start while a download is
// being verified, and the exact file electron-updater will run is hashed again right before it runs (refused if it is not
// the sha512/size that was verified). electron-updater's own install-on-quit stays off on Windows (it would run whatever
// file is downloaded when the app quits); this module registers its own quit handler once a download is verified.
// macOS (app 0.2.8, review M1 of agent/mac-028): electron-updater's install-on-quit stays off on macOS too, so MacUpdater never
// hands the downloaded ZIP to Squirrel.Mac by itself. The ZIP is checked first (core/update-verify.mjs checkMacUpdate: listed by
// latest-mac.yml, and the Info.plist of the app inside it is com.ssam.agent "SSAM Agent", exactly the announced version, newer
// than this app), hashed again, and only then handed to Squirrel.Mac (its own checkForUpdates on MacUpdater's local proxy), which
// checks the code signature and installs it on quit or at quitAndInstall. A refusal leaves nothing with Squirrel.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import electronUpdater from 'electron-updater';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { INITIAL, reduce, canCheck, describeUpdateError, updateTrustProblem } from '../core/update-model.mjs';
import { UPDATE_CODES } from '../core/update-signature.mjs';
import { checkWindowsUpdate, checkMacUpdate, plistStrings } from '../core/update-verify.mjs';
import { UPDATE_PUBLIC_KEY } from '../core/update-trust.mjs';

const FIRST_CHECK_MS = 20000;
// The pause between the download and the automatic install: time for a call in flight on the agent to finish.
const AUTO_INSTALL_DELAY_MS = 15000;
// How long Squirrel.Mac may take to fetch the checked ZIP from MacUpdater's local proxy and check its signature.
const SQUIRREL_HANDOFF_MS = 10 * 60000;

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

// The app bundle inside a downloaded Mac update ZIP (macOS only: /usr/bin/unzip and /usr/bin/plutil): {identifier, name,
// shortVersion, bundleVersion} from its Info.plist, or {error}. Exactly one <name>.app/Contents/Info.plist at the top of the ZIP.
export function readMacBundle(file, { exec = execFileSync } = {}) {
  if (!file) return { error: 'no file' };
  let temp = null;
  try {
    const entries = String(exec('/usr/bin/unzip', ['-Z1', file], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 << 20 })).split(/\r?\n/);
    const plists = entries.map(e => /^([^/]+)\.app\/Contents\/Info\.plist$/.exec(e)).filter(Boolean);
    if (plists.length !== 1) return { error: `the ZIP has ${plists.length} app bundles at its top` };
    const raw = Buffer.from(exec('/usr/bin/unzip', ['-p', file, plists[0][0]], { timeout: 60000, maxBuffer: 4 << 20 }));
    let values = plistStrings(raw.toString('utf8'));
    if (!values) {
      // A binary plist: plutil converts a copy to XML.
      temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-update-plist-'));
      const copy = path.join(temp, 'Info.plist'); fs.writeFileSync(copy, raw);
      values = plistStrings(String(exec('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', copy], { encoding: 'utf8', timeout: 30000, maxBuffer: 4 << 20 })));
    }
    if (!values) return { error: 'Info.plist is not a property list' };
    return { name: plists[0][1], identifier: values.CFBundleIdentifier ?? null, shortVersion: values.CFBundleShortVersionString ?? null, bundleVersion: values.CFBundleVersion ?? null };
  } catch (error) { return { error: String(error?.message ?? error).split('\n')[0].slice(0, 200) }; }
  finally { if (temp) fs.rmSync(temp, { recursive: true, force: true }); }
}

// The verification of a downloaded update for this platform: Windows (signed statement and installer version), macOS (the app
// bundle inside the ZIP); no other platform installs updates.
function defaultVerify(platform) {
  if (platform === 'win32') return checkWindowsUpdate;
  if (platform === 'darwin') return checkMacUpdate;
  return async () => ({ problem: { code: UPDATE_CODES.INSTALLER_MISMATCH, message: UPDATE_CODES.INSTALLER_MISMATCH + ': this platform has no update verification; nothing is installed' } });
}

// The sha512 (base64) and size of a file, read synchronously: the quit handler of Electron cannot wait.
export function fileDigest(file) {
  const hash = createHash('sha512'); const buffer = Buffer.allocUnsafe(1 << 20); let size = 0;
  const fd = fs.openSync(file, 'r');
  try { for (let n; (n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0;) { hash.update(buffer.subarray(0, n)); size += n; } }
  finally { fs.closeSync(fd); }
  return { sha512: hash.digest('base64'), size };
}

// updater, onQuit and digest are for tests: electron-updater's autoUpdater, the app's quit hook (its handler gets the exit
// code) and the hash of the installer before it runs. verifyUpdate answers {problem} or {approved: {file, sha512, size}}.
export function createUpdates({ url: wanted, hours = 6, autoInstall = true, log, onChange = () => {}, isPackaged = true, devConfig = null, stopAgent = async () => {},
  platform = process.platform, appUpdateYml = null, currentVersion = null, readInstaller = readInstallerVersion, readBundle = readMacBundle, updatePublicKey = UPDATE_PUBLIC_KEY,
  verifyUpdate = defaultVerify(platform), updater = null, onQuit = null, digest = fileDigest, handoffMs = SQUIRREL_HANDOFF_MS }) {
  // A Windows build that cannot verify who made an update never installs one (update-model.mjs updateTrustProblem): it needs
  // the pinned Ed25519 update key. appUpdateYml (still passed by index.mjs) is read by electron-updater itself: a publisherName
  // a legacy signed build carries is checked there, on top of the statement.
  const untrusted = wanted ? updateTrustProblem({ platform, isPackaged, updatePublicKey }) : null;
  const url = untrusted ? null : wanted;
  if (untrusted) log.write('updates-off', { reason: untrusted });
  const windows = platform === 'win32';
  const mac = platform === 'darwin';
  const autoUpdater = updater ?? (url ? electronUpdater.autoUpdater : null);
  let state = url ? reduce(INITIAL, { type: 'configured', url }) : reduce(INITIAL, { type: 'off', reason: untrusted });
  let timer = null; let installTimer = null;
  // generation: one per download; verified/approved belong to the newest one only (review M1).
  let generation = 0; let verified = false; let approved = null; let quitHooked = false; let handoff = null;
  const emit = event => { state = reduce(state, event); onChange(state); };
  const invalidate = () => { generation++; verified = false; approved = null; handoff?.cancel(); if (installTimer) { clearTimeout(installTimer); installTimer = null; } return generation; };

  if (url) {
    autoUpdater.logger = log.updaterLogger;
    autoUpdater.autoDownload = true;
    // Never electron-updater's own install-on-quit. Windows: it would run the file downloaded at quit time, verified or not; the
    // quit handler below installs only a verified, re-hashed installer. macOS: MacUpdater would hand the ZIP to Squirrel.Mac in the
    // tick of update-downloaded, before any check; this module hands it over after checkMacUpdate (handToSquirrel).
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    // A checkout run (not packaged) checks only with a dev-app-update.yml.
    if (!isPackaged) { autoUpdater.forceDevUpdateConfig = Boolean(devConfig && fs.existsSync(devConfig)); if (devConfig) autoUpdater.updateConfigPath = devConfig; }
    autoUpdater.setFeedURL({ provider: 'generic', url, channel: 'latest' });
    autoUpdater.on('checking-for-update', () => emit({ type: 'checking-for-update' }));
    autoUpdater.on('update-available', info => { invalidate(); emit({ type: 'update-available', version: info?.version ?? null }); });
    autoUpdater.on('update-not-available', () => emit({ type: 'update-not-available', at: new Date().toISOString() }));
    autoUpdater.on('download-progress', progress => { invalidate(); emit({ type: 'download-progress', percent: progress?.percent ?? 0 }); });
    // The flag is forced off again here, in the tick in which BaseUpdater's addQuitHandler (Windows) or MacUpdater's Squirrel
    // fetch (macOS, MacUpdater.js:220) reads it right after.
    autoUpdater.on('update-downloaded', info => { autoUpdater.autoInstallOnAppQuit = false; verifyDownload(info); });
    autoUpdater.on('error', error => { emit({ type: 'error', message: describeUpdateError(error?.message ?? String(error)) }); log.write('update-error', { message: String(error?.message ?? error).slice(0, 500) }); });
  }

  function refuse(version, problem) {
    verified = false; approved = null;
    if (installTimer) { clearTimeout(installTimer); installTimer = null; }
    log.write('update-refused', { version: version ?? null, code: problem.code, reason: problem.message });
    emit({ type: 'update-refused', message: problem.message });
  }

  function ready(info) {
    emit({ type: 'update-downloaded', version: info?.version ?? null });
    log.write('update-ready', { version: info?.version ?? null, autoInstall });
    if (autoInstall) installTimer = setTimeout(() => { installTimer = null; installNow().catch(error => log.write('update-install-failed', { error: error.message })); }, AUTO_INSTALL_DELAY_MS);
  }

  // macOS: the checked ZIP, hashed again, is handed to Squirrel.Mac (MacUpdater set its feed to the local proxy that serves this
  // file); Squirrel fetches it, checks the code signature and answers update-downloaded (it then installs on quit) or error.
  // Answers {ok}, {superseded} (a newer download began), {code, message} (refused), or null (the ZIP changed: already refused).
  function handToSquirrel(mine) {
    const native = autoUpdater.nativeUpdater;
    if (!native?.checkForUpdates) return Promise.resolve({ code: UPDATE_CODES.INSTALLER_MISMATCH, message: UPDATE_CODES.INSTALLER_MISMATCH + ': Squirrel.Mac is not available; the update is not installed' });
    if (!installerStillApproved()) return Promise.resolve(null);
    return new Promise(resolve => {
      let timer = null;
      const done = answer => { native.removeListener('update-downloaded', ok); native.removeListener('error', bad); if (timer) clearTimeout(timer); if (handoff?.mine === mine) handoff = null; resolve(answer); };
      const ok = () => done({ ok: true });
      const bad = error => done({ code: UPDATE_CODES.SIGNATURE_INVALID, message: UPDATE_CODES.SIGNATURE_INVALID + ': Squirrel.Mac refused the update: ' + String(error?.message ?? error).slice(0, 250) });
      timer = setTimeout(() => done({ code: UPDATE_CODES.SIGNATURE_INVALID, message: UPDATE_CODES.SIGNATURE_INVALID + ': Squirrel.Mac did not take the update in time; it is not installed' }), handoffMs);
      if (timer.unref) timer.unref();
      handoff = { mine, cancel: () => done({ superseded: true }) };
      native.once('update-downloaded', ok); native.once('error', bad);
      log.write('update-handoff', { version: approved?.version ?? null });
      try { native.checkForUpdates(); } catch (error) { bad(error); }
    });
  }

  // The verification of a download (core/update-verify.mjs): Windows checkWindowsUpdate (the owner's signed statement and the
  // installer's own version), macOS checkMacUpdate (the app bundle inside the ZIP), then on macOS the hand-off to Squirrel.Mac.
  // A refusal leaves it uninstalled. Only the verification of the newest download counts.
  async function verifyDownload(info) {
    const mine = invalidate();
    emit({ type: 'verifying', version: info?.version ?? null });
    let answer;
    try { answer = await verifyUpdate({ info, feed: url, currentVersion, publicKey: updatePublicKey, readInstaller: readInstaller ?? readInstallerVersion, readBundle }); }
    catch (error) { answer = { problem: { code: UPDATE_CODES.SIGNATURE_INVALID, message: String(error?.message ?? error).slice(0, 300) } }; }
    if (mine !== generation) { log.write('update-verification-superseded', { version: info?.version ?? null }); return; }
    if (answer?.problem || !answer?.approved) { refuse(info?.version, answer?.problem ?? { code: UPDATE_CODES.SIGNATURE_INVALID, message: 'the update was not verified' }); return; }
    verified = true; approved = { ...answer.approved, version: info?.version ?? null };
    if (mac) {
      const handed = await handToSquirrel(mine);
      if (handed?.superseded || mine !== generation) { log.write('update-verification-superseded', { version: info?.version ?? null }); return; }
      if (!handed) return; // refused by installerStillApproved (the ZIP changed after the check)
      if (!handed.ok) { refuse(info?.version, handed); return; }
      approved.staged = true;
    } else hookQuit();
    ready(info);
  }

  // The installer electron-updater runs is the verified file with the verified bytes, read again now (review M1).
  function installerStillApproved() {
    if (!windows && !mac) return false;
    if (!verified || !approved) return false;
    // macOS, once Squirrel.Mac took the checked ZIP: it installs its own copy, whose signature it checked.
    if (mac && approved.staged) return true;
    const file = autoUpdater.installerPath ?? approved.file;
    let now = null;
    if (file && approved.file && path.resolve(file) === path.resolve(approved.file)) { try { now = digest(file); } catch { now = null; } }
    if (now && now.sha512 === approved.sha512 && now.size === approved.size) return true;
    refuse(approved.version, { code: UPDATE_CODES.STATEMENT_MISMATCH, message: UPDATE_CODES.STATEMENT_MISMATCH + (mac ? ': the update ZIP to hand to Squirrel.Mac' : ': the installer to run') + ' is not the one that was verified (it changed on disk); it is not installed' });
    return false;
  }

  // Windows install on quit (review M2): registered once, after the first verified download; it installs only what is verified
  // at quit time, never electron-updater's own handler.
  function hookQuit() {
    if (quitHooked) return;
    const register = onQuit ?? (handler => autoUpdater.app?.onQuit?.(handler));
    try { register(quitInstall); quitHooked = true; } catch (error) { log.write('update-quit-hook-failed', { error: String(error?.message ?? error).slice(0, 300) }); }
  }
  function quitInstall(exitCode) {
    if (exitCode !== 0) { log.write('update-not-installed-on-quit', { reason: 'exit code ' + exitCode }); return; }
    if (state.status !== 'ready' || !verified) { log.write('update-not-installed-on-quit', { reason: 'no verified update' }); return; }
    if (!installerStillApproved()) return;
    log.write('update-install-on-quit', { version: approved.version });
    autoUpdater.install(true, false);
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

  // The agent stopped cleanly, then the app replaced by the downloaded update and started again (silent install). The
  // installer is hashed before the agent is stopped and again right before it runs.
  async function installNow() {
    if (state.status !== 'ready' || !verified) return false;
    if (installTimer) { clearTimeout(installTimer); installTimer = null; }
    const mine = generation;
    if (!installerStillApproved()) return false;
    log.write('update-install', { version: state.version });
    await stopAgent();
    if (mine !== generation || state.status !== 'ready' || !verified) { log.write('update-install-superseded', { version: state.version }); return false; }
    if (!installerStillApproved()) return false;
    autoUpdater.quitAndInstall(true, true);
    return true;
  }

  function dispose() { if (timer) clearTimeout(timer); timer = null; if (installTimer) clearTimeout(installTimer); installTimer = null; handoff?.cancel(); }

  return { get state() { return state; }, url, check, schedule, installNow, dispose };
}
