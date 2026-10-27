// Imported FIRST by every node test file of the checkout (fix/a5-lows R4-3: profile-isolation-guard.test.mjs fails on one
// that does not): the code under test may write under the user's profile (Service Center receipts and state in
// %USERPROFILE%\.ssam-hybrid, the legacy journal under %LOCALAPPDATA%, the controller key folder). node --test runs
// each test file in its own process, so pointing this process's profile at a temporary folder keeps every write out
// of the real profile whatever the calling shell exports. The folder is removed when the process exits.
//
// READS are a different matter (M1): a test that looks for a tool or recorded data installed in the real profile (the
// Codex runtime, recorded transcripts, the ODC Studio feature and plugin caches) must keep finding it, or it skips with
// a false reason. One rule for all of them:
//   - test code builds such a read path with profileReadPath / localAppDataReadPath (the profile the process started
//     with), never with os.homedir(), USERPROFILE or LOCALAPPDATA, which now name the temporary profile;
//   - the kernel CLI children read the ODC Studio caches through ANVIL_ODC_FEATURES_DIR / ANVIL_ODC_PLUGINS_DIR, so a
//     variable the shell did not set is pinned to the folder the kernel would read under the original profile, when it
//     exists (read only: the kernel never writes there). ANVIL_STUDIO_DIR is NOT pinned: the facade ranks it above the
//     installed Studio (discovery.mjs o11StudioDir), so pinning it would change which Studio the tests select;
//   - the temporary home keeps the original folder name, so the user segment the code derives from the home folder
//     (path.basename(os.homedir()): privacy markers, Claude project folders) is the same as before the isolation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The profile the process started with, only to READ a tool or recorded data installed there (never a write target).
const startHome = process.env.USERPROFILE || process.env.HOME || os.userInfo().homedir;
export const originalUserProfile = process.env.USERPROFILE;
export const originalLocalAppData = process.env.LOCALAPPDATA;
export const originalProfile = Object.freeze({
  home: startHome,
  localAppData: process.env.LOCALAPPDATA || path.join(startHome, 'AppData', 'Local'),
  appData: process.env.APPDATA || path.join(startHome, 'AppData', 'Roaming'),
});
export const profileReadPath = (...segments) => path.join(originalProfile.home, ...segments);
export const localAppDataReadPath = (...segments) => path.join(originalProfile.localAppData, ...segments);

export const isolatedProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-test-profile-'));
const home = path.join(isolatedProfile, path.basename(startHome) || 'home');
for (const dir of [home, path.join(home, 'AppData', 'Local'), path.join(home, 'AppData', 'Roaming'), path.join(isolatedProfile, 'authority')])
  fs.mkdirSync(dir, { recursive: true });
// The bridge key of the start profile (read-only, like the installed tools): the reader of a capture presents it to the
// local reader process, and without it every read under isolation fails with ENOENT instead of reading the fixture.
const startKey = localAppDataReadPath('Anvil', 'authority', 'bridge.key');
if (fs.existsSync(startKey)) fs.copyFileSync(startKey, path.join(isolatedProfile, 'authority', 'bridge.key'));
// The read-only ODC Studio caches the kernel CLI would read under the original profile (OdcFeatures, OdcModelPlugins).
export const pinnedReadFolders = Object.freeze(Object.fromEntries([
  ['ANVIL_ODC_FEATURES_DIR', localAppDataReadPath('OutSystems', 'ODC Studio')],
  ['ANVIL_ODC_PLUGINS_DIR', localAppDataReadPath('OutSystems', 'ODC Studio', 'Plugins')],
].filter(([name, dir]) => !process.env[name] && fs.existsSync(dir))));
Object.assign(process.env, pinnedReadFolders, {
  USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  ANVIL_AUTHORITY_DIR: path.join(isolatedProfile, 'authority'), ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1',
});
delete process.env.SSAM_SC_RECEIPTS;
delete process.env.SSAM_DESTRUCTIVE_ROOT;
process.on('exit', () => { try { fs.rmSync(isolatedProfile, { recursive: true, force: true }); } catch { /* best effort */ } });
