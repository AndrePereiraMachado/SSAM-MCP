// install.sh and agent/ssam-agent.sh: bash -n, no construct newer than the bash 3.2 of macOS, and the installer RUN under
// the bash of Git for Windows with the macOS tools faked on the PATH (uname, sw_vers, sysctl, xattr, curl, shasum,
// plutil): a Node 24 found, the official Node downloaded and its sha256 checked against pack.json, the refusals (another
// system, an old macOS, a wrong sha256, a folder with a space, an unknown option), setup with a credential file, start
// against the fake hub, a second run that keeps the setup. Bash 3.2 itself is not available here: the static check is
// the list of constructs it lacks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fakeHub } from './fixtures/fake-hub.mjs';
import { CREDENTIAL } from './fixtures/agent-root.mjs';
import { portugueseIn, describe } from './fixtures/portuguese.mjs';
import { createLauncher } from '../lib/launcher.mjs';

const agentDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const box = path.dirname(agentDir);
// scripts/tar-gz.mjs (the pack's own tar writer) runs as a process: nothing of agent/ imports from outside it.
const writeTarGz = (folder, out) => { const run = spawnSync(process.execPath, [path.join(box, 'scripts', 'tar-gz.mjs'), 'write', folder, out], { encoding: 'utf8' }); assert.equal(run.status, 0, run.stdout + run.stderr); };
// The plain MSYS bash of Git for Windows (its bin\bash.exe launcher puts /usr/bin before the fake tools of the PATH).
const BASH = ['C:\\Program Files\\Git\\usr\\bin\\bash.exe', '/bin/bash'].find(file => fs.existsSync(file));
const msys = file => (process.platform === 'win32' ? file.replace(/^([A-Za-z]):/, (m, d) => '/' + d.toLowerCase()).replace(/\\/g, '/') : file);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const texts = [];

test('the shell scripts parse with bash -n and use nothing newer than bash 3.2', { skip: !BASH }, () => {
  for (const file of ['install.sh', 'ssam-agent.sh']) {
    const full = path.join(agentDir, file);
    const check = spawnSync(BASH, ['-n', msys(full)], { encoding: 'utf8' });
    assert.equal(check.status, 0, file + ': ' + check.stderr);
    const text = fs.readFileSync(full, 'utf8');
    assert.equal(text.includes('\r'), false, file + ' has CR line ends');
    assert.match(text, /^#!\/bin\/bash\n/);
    // bash 4+: associative arrays, namerefs, mapfile/readarray, case changes, ;;& and ;&, |&, &>>, coproc, negative
    // substring offsets, printf -v with arrays, ${!prefix@} is fine in 3.2 but not used.
    for (const pattern of [/declare\s+-[aA]*A/, /local\s+-n/, /\bmapfile\b|\breadarray\b/, /\$\{[A-Za-z_][A-Za-z0-9_]*(,,|\^\^|,|\^)\}/, /;;&|;&/, /\|&/, /&>>/, /\bcoproc\b/, /\$\{[A-Za-z_]+:\s*-\d/])
      assert.equal(pattern.test(text), false, `${file} uses ${pattern}`);
  }
});

// A pack folder with install.sh at its root, the agent and a pack.json with the Node pin; the fake tools in stubs/.
function installCase({ space = false, tarball = null, pinSha = null } = {}) {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-install-'));
  const root = path.join(top, space ? 'SSAM Agent' : 'SSAM-Agent');
  fs.mkdirSync(path.join(root, 'agent', 'lib'), { recursive: true });
  fs.copyFileSync(path.join(agentDir, 'install.sh'), path.join(root, 'install.sh'));
  for (const name of ['ssam-agent.mjs', 'ssam-agent.sh']) fs.copyFileSync(path.join(agentDir, name), path.join(root, 'agent', name));
  for (const name of fs.readdirSync(path.join(agentDir, 'lib'))) fs.copyFileSync(path.join(agentDir, 'lib', name), path.join(root, 'agent', 'lib', name));
  const pin = JSON.parse(fs.readFileSync(path.join(box, 'scripts', 'node-darwin.json'), 'utf8'));
  const node = { version: pin.version, arm64: { ...pin.arm64 }, x64: { ...pin.x64 } };
  if (pinSha) { node.arm64.sha256 = pinSha; node.x64.sha256 = pinSha; }
  fs.writeFileSync(path.join(root, 'pack.json'), JSON.stringify({ id: 'pack-mac-test', platform: 'darwin', lanes: ['odc'], odcBridge: 'v35', node, files: [] }, null, 2));
  const stubs = path.join(top, 'stubs'); fs.mkdirSync(stubs);
  const log = path.join(top, 'tools.log');
  const node24 = msys(process.execPath);
  const stub = (name, body) => fs.writeFileSync(path.join(stubs, name), '#!/bin/bash\n' + body + '\n', { mode: 0o755 });
  stub('uname', 'case "$1" in -s) echo "${FAKE_UNAME_S:-Darwin}" ;; -m) echo "${FAKE_UNAME_M:-arm64}" ;; *) echo Darwin ;; esac');
  stub('sw_vers', 'echo "${FAKE_SW_VERS:-14.5}"');
  stub('sysctl', 'if [ "$2" = "hw.optional.arm64" ]; then echo "${FAKE_ARM64:-1}"; else echo 0; fi');
  stub('xattr', `echo "xattr $*" >> "${msys(log)}"`);
  stub('curl', `out=""; url=""; while [ "$#" -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; http*) url="$1"; shift ;; *) shift ;; esac; done; echo "curl $url" >> "${msys(log)}"; cp "$FAKE_TARBALL" "$out"`);
  stub('shasum', `"${node24}" -e "process.stdout.write(require('crypto').createHash('sha256').update(require('fs').readFileSync(process.argv[1])).digest('hex') + '  x\\n')" "$3"`);
  stub('plutil', `"${node24}" -e "const v = process.argv[1].split('.').reduce((o, k) => (o == null ? undefined : o[k]), JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'))); if (v == null) process.exit(1); process.stdout.write(String(v))" "$2" "$6"`);
  const credentialFile = path.join(top, 'credential.txt'); fs.writeFileSync(credentialFile, CREDENTIAL + '\n');
  return { top, root, stubs, log, credentialFile, tarball, remove: () => fs.rmSync(top, { recursive: true, force: true }) };
}
const install = (c, args, { env = {}, withNode = true } = {}) => new Promise(resolve => {
  const system = process.platform === 'win32' ? ['C:\\Program Files\\Git\\usr\\bin', 'C:\\Program Files\\Git\\mingw64\\bin', 'C:\\Windows\\System32', 'C:\\Windows'] : ['/usr/bin', '/bin'];
  // On Windows the setup that runs here is the Windows one: its folder rule refuses %LOCALAPPDATA%, which holds the
  // test's temporary folder.
  const runEnv = { ...process.env, PATH: [c.stubs, ...system].join(path.delimiter), ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', SSAM_ODC_OFFLINE: '1', HOME: msys(path.join(c.top, 'home')),
    LOCALAPPDATA: path.join(c.top, 'not-here'), ...env };
  if (withNode) runEnv.SSAM_NODE = process.execPath; else delete runEnv.SSAM_NODE;
  if (c.tarball) runEnv.FAKE_TARBALL = msys(c.tarball);
  execFile(BASH, [msys(path.join(c.root, 'install.sh')), ...args], { encoding: 'utf8', env: runEnv, timeout: 120000, windowsHide: true },
    (error, stdout, stderr) => resolve({ code: error ? error.code : 0, out: stdout + stderr }));
});
const stopAgent = async root => createLauncher({ root, out: { write: () => true } }).stop();

test('install.sh: a Node 24 found, setup with a credential file (never shown), the agent started and connected, the next step; a second run keeps the setup', { skip: !BASH }, async () => {
  const c = installCase();
  const hub = await fakeHub({ credential: CREDENTIAL });
  try {
    const first = await install(c, ['--server', hub.url, '--credential-file', c.credentialFile]);
    texts.push(['install', first.out]);
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, /macOS 14\.5 on Apple silicon; agent folder /);
    assert.match(first.out, /Node: .*\(v24\./);
    assert.match(first.out, /Agent set up in /);
    assert.match(first.out, /Agent connected: pid \d+/);
    assert.match(first.out, /Next step: connect your MCP client to http:\/\/127\.0\.0\.1:\d+\/mcp/);
    assert.match(first.out, /claude mcp add --transport http ssam /);
    assert.equal(first.out.includes(CREDENTIAL) || first.out.includes(CREDENTIAL.slice(11)), false, 'the credential is never shown');
    assert.equal(fs.readFileSync(path.join(c.root, 'private', 'credential'), 'utf8'), CREDENTIAL);
    assert.match(fs.readFileSync(c.log, 'utf8'), /xattr -dr com\.apple\.quarantine /);
    assert.equal(fs.existsSync(path.join(c.root, 'agent', 'node')), false, 'nothing downloaded');
    // The Node it chose is recorded for agent/ssam-agent.sh (review B6, mac-node.test.mjs).
    assert.equal(fs.readFileSync(path.join(c.root, 'private', 'node'), 'utf8').trim(), process.execPath);
    const again = await install(c, []);
    texts.push(['install again', again.out]);
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /Already set up \(private\/config\.json and private\/credential stay as they are\)/);
    assert.match(again.out, /Agent connected: pid \d+/);
    assert.equal(hub.hellos.length, 2);
  } finally { await stopAgent(c.root); await hub.close(); c.remove(); }
});

test('install.sh: without Node 24 it downloads the official file named by pack.json and checks its sha256 before keeping only bin/node and LICENSE', { skip: !BASH }, async () => {
  const build = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-node-tar-'));
  const pin = JSON.parse(fs.readFileSync(path.join(box, 'scripts', 'node-darwin.json'), 'utf8'));
  const dir = path.join(build, 'tree', `node-v${pin.version}-darwin-arm64`);
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true }); fs.mkdirSync(path.join(dir, 'include'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', 'node'), `#!/bin/bash\nexec "${msys(process.execPath)}" "$@"\n`);
  fs.writeFileSync(path.join(dir, 'LICENSE'), 'Node.js is licensed for use as follows: MIT');
  fs.writeFileSync(path.join(dir, 'include', 'node.h'), 'header');
  const tarball = path.join(build, `node-v${pin.version}-darwin-arm64.tar.gz`);
  writeTarGz(path.join(build, 'tree'), tarball);
  const c = installCase({ tarball, pinSha: sha(fs.readFileSync(tarball)) });
  const hub = await fakeHub({ credential: CREDENTIAL });
  try {
    // A Terminal under Rosetta (x86_64 on Apple silicon) still gets the arm64 Node.
    const result = await install(c, ['--server', hub.url, '--credential-file', c.credentialFile], { withNode: false, env: { FAKE_UNAME_M: 'x86_64', FAKE_ARM64: '1' } });
    texts.push(['install download', result.out]);
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, new RegExp(`No Node 24 found: downloading https://nodejs\\.org/dist/v${pin.version}/node-v${pin.version}-darwin-arm64\\.tar\\.gz`));
    assert.match(result.out, /sha256 checked: [0-9a-f]{64}/);
    assert.deepEqual(fs.readdirSync(path.join(c.root, 'agent', 'node')).sort(), ['LICENSE', 'node']);
    assert.equal(fs.existsSync(path.join(c.root, '.install-node')), false);
    assert.match(fs.readFileSync(c.log, 'utf8'), new RegExp(`curl https://nodejs\\.org/dist/v${pin.version}/node-v${pin.version}-darwin-arm64\\.tar\\.gz`));
    assert.match(result.out, /Agent connected: pid \d+/);
  } finally { await stopAgent(c.root); await hub.close(); c.remove(); fs.rmSync(build, { recursive: true, force: true }); }
});

test('install.sh refuses another system, an old macOS, a wrong sha256 (nothing kept), a folder with a space and an unknown option', { skip: !BASH }, async () => {
  const build = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-node-bad-'));
  const tarball = path.join(build, 'node.tar.gz'); fs.writeFileSync(tarball, 'not the official file');
  const cases = [
    ['another system', installCase(), [], { env: { FAKE_UNAME_S: 'Linux' } }, /this installer is for macOS/],
    ['an old macOS', installCase(), [], { env: { FAKE_SW_VERS: '12.7.4' } }, /macOS 12\.7\.4 is too old: Node 24 needs macOS 13\.5/],
    ['a wrong sha256', installCase({ tarball }), [], { withNode: false }, /has the sha256 [0-9a-f]{64}, not the [0-9a-f]{64} fixed in pack\.json: nothing was installed/],
    ['a folder with a space', installCase({ space: true }), [], {}, /has a space; extract the pack to a folder without spaces/],
    ['an unknown option', installCase(), ['--force'], {}, /unknown option: --force/],
    ['a --node that is not Node 24', installCase(), ['--node', '/usr/bin/true'], {}, /is not a Node 24/],
  ];
  try {
    for (const [name, c, args, options, pattern] of cases) {
      try {
        const result = await install(c, args, options);
        texts.push(['install ' + name, result.out]);
        assert.equal(result.code, 1, name + ': ' + result.out);
        assert.match(result.out, pattern, name);
        assert.equal(fs.existsSync(path.join(c.root, 'private', 'credential')), false, name + ': no setup');
        assert.equal(fs.existsSync(path.join(c.root, 'agent', 'node')), false, name + ': no Node kept');
        assert.equal(fs.existsSync(path.join(c.root, '.install-node')), false, name);
      } finally { c.remove(); }
    }
  } finally { fs.rmSync(build, { recursive: true, force: true }); }
  const found = texts.flatMap(([where, text]) => { const f = portugueseIn(text); return f.length ? [describe(where, f)] : []; });
  assert.equal(found.join('\n'), '', 'Portuguese the customer would see');
});
