// The agent folder on macOS (review M2): install.sh and setup refuse as the root the disk root, the home folder itself (or
// a folder that holds it), the folders of macOS and of the applications (/System, /Library, /Applications, /usr, /bin,
// /sbin, /etc, /opt, /private, /var, /tmp, /cores, /dev, /Volumes, /Network), ~/Library, and any folder that already
// holds something that is not an extracted SSAM agent pack. A new ~/SSAM-Agent with the pack just extracted passes, and so
// does a new pack extracted over a folder set up before. setup runs here with platform 'darwin' over real folders of the
// test's temporary folder (POSIX spellings of them); install.sh runs under the bash of Git for Windows with fake tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';
import * as agentCli from '../ssam-agent.mjs';
import { CREDENTIAL } from './fixtures/agent-root.mjs';
import { portugueseIn, describe } from './fixtures/portuguese.mjs';

const { setup, posixRootProblem } = agentCli;
const agentDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const texts = [];
const sink = () => { const chunks = []; const stream = new Writable({ write(chunk, encoding, done) { chunks.push(String(chunk)); done(); } }); stream.text = () => chunks.join(''); return stream; };
const input = text => Object.assign(Readable.from([text]), { isTTY: false });
const posixOf = dir => dir.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/');
const write = (file, text = path.basename(file)) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const PACK_FILES = ['install.sh', 'agent/ssam-agent.mjs', 'agent/ssam-agent.sh', 'agent/lib/agent.mjs', 'docs/AGENTE-MAC.md', 'docs/AGENTE-CLIENTE.md', 'odc/README.md',
  'odc/studio/bridge/bin/Release/net8.0/ODC3.Bridge.v97.dll', 'bin/o11/bridge/Anvil.Bridge.dll', 'bin/o11/hook/Anvil.RuntimeHook.Agent.dll'];
// A pack just extracted into <top>/<name>.
function extracted(top, name = 'SSAM-Agent') {
  const root = path.join(top, name);
  for (const rel of PACK_FILES) write(path.join(root, ...rel.split('/')));
  write(path.join(root, 'pack.json'), JSON.stringify({ id: 'pack-mac', platform: 'darwin', lanes: ['odc', 'o11'], files: PACK_FILES.map(p => ({ path: p })) }));
  return root;
}
const runSetup = async (root, env) => {
  const err = sink();
  const code = await setup({ root: posixOf(root), server: 'https://mcp.ssam.pro', stdin: input(CREDENTIAL + '\n'), stdout: sink(), stderr: err, env, platform: 'darwin', restrict: async () => {} });
  texts.push(['setup ' + root, err.text()]);
  return { code, err: err.text() };
};

test('the macOS root: the disk root, the home folder, a folder above it, the system and application folders and ~/Library are refused', () => {
  const env = { HOME: '/Users/ana', TMPDIR: '/var/folders/x1/abc/T/' };
  for (const [root, pattern] of [['/', /root of the disk/], ['/Users/ana', /your home folder itself/], ['/Users/ana/', /your home folder itself/], ['/users/ANA', /your home folder itself/],
    ['/Users', /holds your home folder/], ['/System/Volumes/Data/x', /inside \/System/], ['/Library/SSAM', /inside \/Library/], ['/Applications/SSAM-Agent', /inside \/Applications/],
    ['/applications/x', /inside \/Applications/], ['/usr/local/ssam', /inside \/usr/], ['/bin/x', /inside \/bin/], ['/sbin', /inside \/sbin/], ['/etc/ssam', /inside \/etc/],
    ['/opt/ssam', /inside \/opt/], ['/opt/homebrew/ssam', /inside \/opt/], ['/private/etc/x', /inside \/private/], ['/var/db/ssam', /inside \/var/], ['/cores/x', /inside \/cores/],
    ['/dev/x', /inside \/dev/], ['/Network/Servers/x', /inside \/Network/], ['/Users/ana/Library', /inside \/Users\/ana\/Library/], ['/Users/ana/Library/SSAM-Agent', /inside \/Users\/ana\/Library/],
    ['/Users/ana/library/x', /inside \/Users\/ana\/Library/]]) {
    const problem = posixRootProblem(root, env);
    assert.match(problem ?? '(accepted)', pattern, root);
    texts.push(['root ' + root, problem]);
  }
  for (const root of ['/Users/ana/SSAM-Agent', '/Users/ana/work/SSAM-Agent', '/Users/ana/Applications-old/x', '/Users/Shared/SSAM-Agent'])
    assert.equal(posixRootProblem(root, env), null, root);
});

test('setup on macOS: a new folder with the pack just extracted passes, and so does a new pack over a folder set up before', async () => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-root-ok-'));
  const env = { HOME: posixOf(top) + '/home' };
  try {
    const root = extracted(top);
    const first = await runSetup(root, env);
    assert.equal(first.code, 0, first.err);
    // The agent ran (state, log, a snapshot, a file of the person in inbox/), Finder left its .DS_Store, the installer its Node.
    for (const rel of ['private/agent.log', 'private/agent.json', 'private/runtime-connect/abc.json', 'odc/snapshots/App.oml', 'odc/lab/run/e.json', 'inbox/mine.oml', 'o11/x.oml',
      'agent/node/node', 'agent/node/LICENSE', '.DS_Store', 'docs/.DS_Store', 'agent/lib/old-module.mjs']) write(path.join(root, ...rel.split('/')));
    const again = await runSetup(root, env);
    assert.equal(again.code, 0, again.err);
  } finally { fs.rmSync(top, { recursive: true, force: true }); }
});

test('setup on macOS refuses a folder that already holds something that is not an SSAM agent pack, before the credential is read', async () => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-root-foreign-'));
  const env = { HOME: posixOf(top) + '/home' };
  try {
    for (const [name, extra, pattern] of [
      ['notes', root => write(path.join(root, 'notes.txt')), /notes\.txt/],
      ['projects', root => write(path.join(root, 'Projects', 'app', 'main.c')), /Projects\//],
      ['a home', root => { write(path.join(root, 'Desktop', 'a.png')); write(path.join(root, 'Library', 'Preferences', 'x.plist')); }, /Desktop\/.*Library\//],
      ['in docs', root => write(path.join(root, 'docs', 'my-report.pdf')), /docs\/my-report\.pdf/],
      ['in odc', root => write(path.join(root, 'odc', 'mine', 'x.txt')), /odc\/mine\//],
      ['a link', root => fs.symlinkSync(path.join(top, 'elsewhere'), path.join(root, 'odc', 'lab'), 'junction'), /odc\/lab \(a link\)/],
    ]) {
      fs.mkdirSync(path.join(top, 'elsewhere'), { recursive: true });
      const root = extracted(top, 'case-' + name.replace(/\W/g, '-'));
      extra(root);
      const { code, err } = await runSetup(root, env);
      assert.equal(code, 1, name + ': ' + err);
      assert.match(err, /already holds files that are not of an SSAM agent pack/, name);
      assert.match(err, pattern, name);
      assert.equal(fs.existsSync(path.join(root, 'private', 'credential')), false, name + ': nothing was written');
      try { fs.unlinkSync(path.join(root, 'odc', 'lab')); } catch { /* not a link */ }
    }
  } finally { fs.rmSync(top, { recursive: true, force: true }); }
});

// install.sh: the home folder itself and a folder with other content are refused before any tool runs.
const BASH = ['C:\\Program Files\\Git\\usr\\bin\\bash.exe', '/bin/bash'].find(file => fs.existsSync(file));
const msys = file => (process.platform === 'win32' ? file.replace(/^([A-Za-z]):/, (m, d) => '/' + d.toLowerCase()).replace(/\\/g, '/') : file);
function shellCase(top, name) {
  const root = path.join(top, name);
  fs.mkdirSync(path.join(root, 'agent', 'lib'), { recursive: true });
  fs.copyFileSync(path.join(agentDir, 'install.sh'), path.join(root, 'install.sh'));
  for (const file of ['ssam-agent.mjs', 'ssam-agent.sh']) fs.copyFileSync(path.join(agentDir, file), path.join(root, 'agent', file));
  write(path.join(root, 'pack.json'), JSON.stringify({ id: 'pack-mac', platform: 'darwin', lanes: ['odc'], files: [] }));
  const stubs = path.join(top, name + '-stubs'); fs.mkdirSync(stubs);
  const log = path.join(top, name + '-tools.log');
  const stub = (file, body) => fs.writeFileSync(path.join(stubs, file), '#!/bin/bash\n' + body + '\n', { mode: 0o755 });
  stub('uname', 'case "$1" in -s) echo Darwin ;; -m) echo arm64 ;; *) echo Darwin ;; esac');
  stub('sw_vers', 'echo 14.6');
  stub('sysctl', 'echo 1');
  for (const tool of ['xattr', 'curl', 'plutil', 'osascript']) stub(tool, `echo "${tool} $*" >> "${msys(log)}"; exit 1`);
  return { root, stubs, log };
}
const install = (c, home) => new Promise(resolve => {
  const system = ['C:\\Program Files\\Git\\usr\\bin', 'C:\\Windows\\System32', 'C:\\Windows'];
  execFile(BASH, [msys(path.join(c.root, 'install.sh'))], { encoding: 'utf8', timeout: 60000, windowsHide: true,
    env: { ...process.env, PATH: [c.stubs, ...system].join(path.delimiter), HOME: msys(home), SSAM_NODE: process.execPath } },
  (error, stdout, stderr) => resolve({ code: error ? error.code : 0, out: stdout + stderr }));
});

test('install.sh refuses the home folder itself and a folder with other content, before any tool runs', { skip: !BASH }, async () => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-root-sh-'));
  try {
    const home = shellCase(top, 'home');
    const asHome = await install(home, home.root);
    texts.push(['install.sh home', asHome.out]);
    assert.equal(asHome.code, 1, asHome.out);
    assert.match(asHome.out, /is your home folder itself/);
    const busy = shellCase(top, 'busy');
    write(path.join(busy.root, 'Projects', 'main.c')); write(path.join(busy.root, 'notes.txt'));
    const result = await install(busy, path.join(top, 'someone'));
    texts.push(['install.sh busy', result.out]);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /already holds files that are not of an SSAM agent pack: .*(Projects.*notes\.txt|notes\.txt.*Projects)/);
    for (const c of [home, busy]) {
      assert.equal(fs.existsSync(c.log) ? fs.readFileSync(c.log, 'utf8') : '', '', 'no tool ran (no xattr, no download)');
      assert.equal(fs.existsSync(path.join(c.root, 'private')), false);
    }
  } finally { fs.rmSync(top, { recursive: true, force: true }); }
  const found = texts.flatMap(([where, text]) => { const f = portugueseIn(String(text ?? '')); return f.length ? [describe(where, f)] : []; });
  assert.equal(found.join('\n'), '', 'Portuguese the customer would see');
});
