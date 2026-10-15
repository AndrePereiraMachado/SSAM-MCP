// Imported FIRST by tests whose code under test writes under the user's profile (Service Center receipts and state in
// %USERPROFILE%\.ssam-hybrid, the legacy journal under %LOCALAPPDATA%, the controller key folder). node --test runs
// each test file in its own process, so pointing this process's profile at a temporary folder keeps every write out
// of the real profile whatever the calling shell exports. The folder is removed when the process exits.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const originalLocalAppData = process.env.LOCALAPPDATA;
export const isolatedProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-test-profile-'));
const home = path.join(isolatedProfile, 'home');
for (const dir of [home, path.join(home, 'AppData', 'Local'), path.join(home, 'AppData', 'Roaming'), path.join(isolatedProfile, 'authority')])
  fs.mkdirSync(dir, { recursive: true });
Object.assign(process.env, {
  USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  ANVIL_AUTHORITY_DIR: path.join(isolatedProfile, 'authority'), ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1',
});
delete process.env.SSAM_SC_RECEIPTS;
process.on('exit', () => { try { fs.rmSync(isolatedProfile, { recursive: true, force: true }); } catch { /* best effort */ } });
