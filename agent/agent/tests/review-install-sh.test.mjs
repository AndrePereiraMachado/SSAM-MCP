// The independent review's own tests (kept in the box, round 2): install.sh run by the MSYS bash of Git for Windows with
// the macOS tools faked on the PATH (as mac-install.test.mjs), plus a node wrapper that logs every argument it gets.
// On Windows the setup that runs is the Windows one (process.platform); the shell part is the macOS one. Round 2 (review
// B4): the credential file is still never changed by the agent, and install.sh now ends by telling to delete it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fakeHub } from './fixtures/fake-hub.mjs';
import { createLauncher } from '../lib/launcher.mjs';

const AGENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASH = 'C:\\Program Files\\Git\\usr\\bin\\bash.exe';
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-review-install-'));
after(() => fs.rmSync(WORK, { recursive: true, force: true }));
const CREDENTIAL = 'ssam_agent_' + 'b'.repeat(43);
const msys = file => file.replace(/^([A-Za-z]):/, (m, d) => '/' + d.toLowerCase()).replace(/\\/g, '/');

function makeCase(name, { rootIn = '' } = {}) {
  const top = path.join(WORK, name);
  fs.rmSync(top, { recursive: true, force: true });
  const home = path.join(top, 'home');
  const root = rootIn ? path.join(home, rootIn, 'SSAM-Agent') : path.join(home, 'SSAM-Agent');
  fs.mkdirSync(path.join(root, 'agent', 'lib'), { recursive: true });
  fs.copyFileSync(path.join(AGENT, 'install.sh'), path.join(root, 'install.sh'));
  for (const f of ['ssam-agent.mjs', 'ssam-agent.sh']) fs.copyFileSync(path.join(AGENT, f), path.join(root, 'agent', f));
  for (const f of fs.readdirSync(path.join(AGENT, 'lib'))) fs.copyFileSync(path.join(AGENT, 'lib', f), path.join(root, 'agent', 'lib', f));
  const pin = JSON.parse(fs.readFileSync(path.join(AGENT, '..', 'scripts', 'node-darwin.json'), 'utf8'));
  fs.writeFileSync(path.join(root, 'pack.json'), JSON.stringify({ id: 'pack-review', platform: 'darwin', lanes: ['odc'], odcBridge: 'v97', node: { version: pin.version, arm64: pin.arm64, x64: pin.x64 }, files: [] }));
  const stubs = path.join(top, 'stubs'); fs.mkdirSync(stubs, { recursive: true });
  const log = path.join(top, 'tools.log'); const argv = path.join(top, 'node-argv.log');
  const stub = (n, body) => fs.writeFileSync(path.join(stubs, n), '#!/bin/bash\n' + body + '\n', { mode: 0o755 });
  stub('uname', 'case "$1" in -s) echo Darwin ;; -m) echo arm64 ;; *) echo Darwin ;; esac');
  stub('sw_vers', 'echo 14.6');
  stub('sysctl', 'echo 1');
  stub('xattr', `echo "xattr $*" >> "${msys(log)}"`);
  stub('curl', `echo "curl $*" >> "${msys(log)}"; exit 22`);
  stub('plutil', `exit 1`);
  stub('osascript', `exit 1`);
  // The node wrapper: logs its arguments, then runs the real Node 24.
  const wrapper = path.join(stubs, 'node24');
  fs.writeFileSync(wrapper, `#!/bin/bash\nprintf '%s\\n' "ARGV: $*" >> "${msys(argv)}"\nexec "${msys(process.execPath)}" "$@"\n`, { mode: 0o755 });
  const credentialFile = path.join(top, 'cred.txt'); fs.writeFileSync(credentialFile, CREDENTIAL + '\n');
  return { top, home, root, stubs, log, argv, wrapper, credentialFile };
}
const run = (c, args, env = {}) => new Promise(resolve => {
  const runEnv = { ...process.env, PATH: [c.stubs, 'C:\\Program Files\\Git\\usr\\bin', 'C:\\Windows\\System32', 'C:\\Windows'].join(';'), HOME: msys(c.home), SSAM_NODE: msys(c.wrapper),
    LOCALAPPDATA: path.join(c.top, 'not-here'), ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', SSAM_ODC_OFFLINE: '1', ...env };
  execFile(BASH, [msys(path.join(c.root, 'install.sh')), ...args], { encoding: 'utf8', env: runEnv, timeout: 120000, windowsHide: true }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, out: stdout + stderr }));
});

test('install.sh refuses the folders macOS guards (Documents, Desktop, Downloads, CloudStorage), before anything is written', { skip: !fs.existsSync(BASH) }, async () => {
  for (const where of ['Documents', 'Desktop', 'Downloads', 'Library/CloudStorage/OneDrive', 'documents']) {
    const c = makeCase('tcc-' + where.replace(/\W/g, '-'), { rootIn: where });
    const result = await run(c, ['--credential-file', c.credentialFile]);
    assert.equal(result.code, 1, where + ': ' + result.out);
    assert.match(result.out, /which macOS guards for privacy/, where);
    assert.equal(fs.existsSync(path.join(c.root, 'private')), false, where);
    assert.equal(fs.existsSync(c.log) ? fs.readFileSync(c.log, 'utf8') : '', '', where + ': no tool ran (no xattr, no curl)');
  }
});

test('install.sh: the credential never reaches a command line or the output; the --credential-file stays where it was; quarantine only on its folder', { skip: !fs.existsSync(BASH) }, async () => {
  const c = makeCase('cred');
  const hub = await fakeHub({ credential: CREDENTIAL });
  try {
    const result = await run(c, ['--server', hub.url, '--credential-file', c.credentialFile]);
    assert.equal(result.code, 0, result.out);
    const argv = fs.readFileSync(c.argv, 'utf8');
    assert.equal(argv.includes(CREDENTIAL) || argv.includes(CREDENTIAL.slice(11)), false, 'credential in a node command line');
    assert.equal(result.out.includes(CREDENTIAL.slice(11)), false, 'credential printed');
    assert.match(argv, /ARGV: .*ssam-agent\.mjs setup --server http:\/\/127\.0\.0\.1:\d+ --root \/.*SSAM-Agent --credential-file /);
    assert.equal(fs.readFileSync(c.credentialFile, 'utf8'), CREDENTIAL + '\n', 'the file is neither deleted nor changed');
    assert.match(result.out, /Delete .*cred\.txt now: the credential is saved in private\/credential/, 'review B4: the person is told to delete it');
    const tools = fs.readFileSync(c.log, 'utf8').trim().split('\n');
    assert.deepEqual(tools, ['xattr -dr com.apple.quarantine ' + msys(c.root)]);
    // A second run without options keeps the setup; with --server and a bad credential file it fails and keeps it too.
    const bad = path.join(c.top, 'bad.txt'); fs.writeFileSync(bad, 'nope');
    const again = await run(c, ['--server', hub.url, '--credential-file', bad]);
    assert.equal(again.code, 1, again.out);
    assert.match(again.out, /setup did not finish/);
    assert.equal(fs.readFileSync(path.join(c.root, 'private', 'credential'), 'utf8'), CREDENTIAL);
  } finally { await createLauncher({ root: c.root, out: { write: () => true } }).stop(); await hub.close(); }
});

test('install.sh: no Node 24 and a failed download: nothing kept, the message names the next step', { skip: !fs.existsSync(BASH) }, async () => {
  const c = makeCase('nonode');
  const result = await run(c, ['--credential-file', c.credentialFile], { SSAM_NODE: '' , PATH: [c.stubs, 'C:\\Program Files\\Git\\usr\\bin', 'C:\\Windows\\System32'].join(';') });
  assert.equal(result.code, 1, result.out);
  // pack.json read by plutil, else osascript: both fail here, so the pin is missing and nothing is downloaded.
  assert.match(result.out, /pack\.json has no Node version|download of .* failed/);
  assert.equal(fs.existsSync(path.join(c.root, '.install-node')), false);
  assert.equal(fs.existsSync(path.join(c.root, 'agent', 'node')), false);
});
