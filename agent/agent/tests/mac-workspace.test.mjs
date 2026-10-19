// The folder rules on macOS (lib/workspace.mjs, platform 'darwin'): the same roles, prefixes and segment grammar as
// Windows, with POSIX absolute paths, links resolved (a link that leaves its prefix is refused), names in NFC; an agent:
// path takes any case of a prefix, an absolute path only the exact spelling of the root and the prefix (mac-case.test.mjs).
// The file system is a model in memory (lstat and realpath only), so the rules are tested on any system.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createWorkspace } from '../lib/workspace.mjs';

const posix = path.posix;
const fold = text => text.normalize('NFC').toLowerCase();
const failure = code => Object.assign(new Error(code), { code });

// tree: {path: 'dir' | 'file' | '->target'}; parents are folders. Lookups ignore case, as APFS.
function memoryFs(tree) {
  const entries = new Map();
  const put = (p, kind, target = null) => { if (!entries.has(fold(p))) entries.set(fold(p), { path: p, kind, target }); };
  for (const [p, value] of Object.entries(tree)) {
    for (let up = posix.dirname(p); up !== '/'; up = posix.dirname(up)) put(up, 'dir');
    entries.set(fold(p), value.startsWith('->') ? { path: p, kind: 'link', target: value.slice(2) } : { path: p, kind: value });
  }
  put('/', 'dir');
  const real = (p, depth = 0) => {
    if (depth > 40) throw failure('ELOOP');
    let current = '/';
    for (const part of posix.normalize(p).split('/').filter(Boolean)) {
      const entry = entries.get(fold(posix.join(current, part)));
      if (!entry) throw failure('ENOENT');
      current = entry.kind === 'link' ? real(entry.target.startsWith('/') ? entry.target : posix.join(current, entry.target), depth + 1) : entry.path;
    }
    return current;
  };
  return {
    lstatSync(p) { const entry = entries.get(fold(posix.normalize(p))); if (!entry) throw failure('ENOENT'); return { isDirectory: () => entry.kind === 'dir', isSymbolicLink: () => entry.kind === 'link' }; },
    realpathSync: Object.assign(p => real(p), { native: p => real(p) }),
  };
}

const ROOT = '/Users/ana/SSAM-Agent';
const layout = {
  [ROOT + '/odc/snapshots']: 'dir', [ROOT + '/odc/journal/staging']: 'dir', [ROOT + '/odc/lab']: 'dir', [ROOT + '/o11/journal/staging']: 'dir',
  [ROOT + '/inbox/cliente.oml']: 'file', [ROOT + '/private/credential']: 'file', [ROOT + '/odc/studio/bridge/bin/Release/net8.0/ODC3.Bridge.v97.dll']: 'file',
  '/etc/hosts': 'file',
};
const workspace = (extra = {}, root = ROOT) => createWorkspace(root, { platform: 'darwin', files: memoryFs({ ...layout, ...extra }) });
const code = (fn, expected) => assert.throws(fn, error => { assert.equal(error.code, expected, error.message); assert.equal(error.executed, false); return true; });

test('darwin: agent: paths resolve by role to POSIX paths, the prefix spelled as the prefix (one folder whatever the case)', () => {
  const ws = workspace();
  assert.equal(ws.root, ROOT);
  assert.equal(ws.resolve('agent:odc/lab/job/manifest.json', 'write'), ROOT + '/odc/lab/job/manifest.json');
  assert.equal(ws.resolve('agent:o11\\snapshots\\M.oml', 'write'), ROOT + '/o11/snapshots/M.oml');
  assert.equal(ws.resolve('agent:inbox/cliente.oml', 'read'), ROOT + '/inbox/cliente.oml');
  assert.equal(ws.resolve('agent:o11', 'read'), ROOT + '/o11');
  assert.equal(ws.resolve('agent:ODC/Snapshots/X.oml', 'write'), ROOT + '/odc/snapshots/X.oml');
  code(() => ws.resolve('agent:inbox/cliente.oml', 'write'), 'PATH_FORBIDDEN');
  code(() => ws.resolve('/Users/ana/SSAM-Agent/odc/lab/x', 'read'), 'PATH_NOT_AGENT');
  code(() => ws.resolve(null, 'read'), 'PATH_NOT_AGENT');
});

test('darwin: the segment grammar is the wire one (the server mirror refuses the same names), so it is the Windows one', () => {
  const ws = workspace();
  for (const value of ['agent:odc/lab/../../private/credential', 'agent:../outside.txt', 'agent:odc/lab/./x.json', 'agent:odc/lab/..',
    'agent:/odc/lab/x', 'agent:/etc/hosts', 'agent:odc/lab/x.json:secret', 'agent:odc/lab/x\0.json', 'agent:odc/lab/a\u0001b', 'agent:odc/lab/NUL',
    'agent:odc/lab/COM1.json', 'agent:odc/lab/x.', 'agent:odc/lab/x ', 'agent:odc/lab//x.json', 'agent:odc/lab/x*.json', 'agent:',
    'agent:odc/studio/bridge/bin/Release/net8.0/ODC3.Bridge.v97.dll', 'agent:odc/README.md', 'agent:private/credential', 'agent:pack.json',
    'agent:agent/ssam-agent.sh', 'agent:bin/o11/bridge/Anvil.Bridge.dll', 'agent:install.sh'])
    for (const role of ['read', 'write']) code(() => ws.resolve(value, role), 'PATH_FORBIDDEN');
});

test('darwin: a link that leaves its prefix is refused, at any depth; a link that stays inside is followed', () => {
  const ws = workspace({ [ROOT + '/odc/lab/out']: '->/etc', [ROOT + '/odc/lab/keys']: '->../../private', [ROOT + '/odc/lab/same']: '->sub', [ROOT + '/odc/lab/sub']: 'dir',
    [ROOT + '/odc/lab/broken']: '->/nowhere/x' });
  code(() => ws.resolve('agent:odc/lab/out/hosts', 'read'), 'PATH_FORBIDDEN');
  code(() => ws.resolve('agent:odc/lab/out/new.json', 'write'), 'PATH_FORBIDDEN');
  code(() => ws.resolve('agent:odc/lab/keys/credential', 'read'), 'PATH_FORBIDDEN');
  code(() => ws.resolve('agent:odc/lab/broken/x', 'write'), 'PATH_FORBIDDEN');
  assert.equal(ws.resolve('agent:odc/lab/same/a.json', 'write'), ROOT + '/odc/lab/same/a.json');
  // The prefix folder itself replaced by a link out of the root.
  const moved = workspace({ [ROOT + '/o11']: '->/tmp/o11', '/tmp/o11/x': 'file' });
  code(() => moved.resolve('agent:o11/x', 'read'), 'PATH_FORBIDDEN');
});

test('darwin: absolute paths of a bridge line: only under the root (as given or real), in a prefix for the role, without .., NUL or another form', () => {
  const ws = workspace();
  assert.equal(ws.checkAbsolute(ROOT + '/odc/lab/m.json', 'write'), ROOT + '/odc/lab/m.json');
  // The root and the prefix in another case are refused: on a case-sensitive volume that is another folder (review B3,
  // mac-case.test.mjs).
  for (const text of ['/users/ANA/ssam-agent/odc/lab/m.json', ROOT + '/ODC/lab/m.json', ROOT + '/odc/lab/../../private/credential', ROOT + '/private/credential', ROOT, ROOT + '/', '/Users/ana/SSAM-Agent2/odc/lab/x',
    '/etc/hosts', 'odc/lab/x', 'C:\\SSAM-Agent\\odc\\lab\\x', '//server/share/x', ROOT + '/odc/lab/a\u0000b', ROOT + '/inbox/x'])
    code(() => ws.checkAbsolute(text, 'write'), 'PATH_FORBIDDEN');
  // A root reached through a link (/var -> /private/var): both spellings are the root.
  const linked = createWorkspace('/var/agent', { platform: 'darwin', files: memoryFs({ '/var': '->/private/var', '/private/var/agent/odc/lab': 'dir' }) });
  assert.equal(linked.checkAbsolute('/private/var/agent/odc/lab/x', 'write'), '/var/agent/odc/lab/x');
  assert.equal(linked.toAgent('/private/var/agent/odc/lab/x'), 'agent:odc/lab/x');
});

test('darwin: NFC and NFD spellings of a name are the same name (APFS)', () => {
  const nfc = '/Users/jo\u00e3o/SSAM-Agent';
  const nfd = '/Users/joa\u0303o/SSAM-Agent';
  const ws = createWorkspace(nfc, { platform: 'darwin', files: memoryFs({ [nfc + '/odc/lab']: 'dir' }) });
  assert.equal(ws.toAgent(nfd + '/odc/lab/r.json'), 'agent:odc/lab/r.json');
  assert.equal(ws.checkAbsolute(nfd + '/odc/lab/r.json', 'write').normalize('NFC'), nfc + '/odc/lab/r.json');
});

test('darwin: replies are relativized (only readable prefixes, prefix spelled canonically), json:"agent-paths" both ways', () => {
  const ws = workspace();
  const paths = [];
  // A prefix in another case is not the prefix (review B3): it stays as it is.
  const reply = ws.relativize({ ok: true, evidence: ROOT + '/odc/lab/Run/e.json', other: ROOT + '/ODC/Lab/run/e.json', key: ROOT + '/private/credential', list: [ROOT + '/inbox/a.oml', 'agent:odc/lab/x', 'plain'], n: 3 }, paths);
  assert.deepEqual(reply, { ok: true, evidence: 'agent:odc/lab/Run/e.json', other: ROOT + '/ODC/Lab/run/e.json', key: ROOT + '/private/credential', list: ['agent:inbox/a.oml', 'agent:odc/lab/x', 'plain'], n: 3 });
  assert.deepEqual(paths, [['evidence'], ['list', 0]]);
  const manifest = ws.agentPathsIn({ BasePath: 'agent:odc/snapshots/b.oml', evidenceDir: 'agent:odc/lab/ev', module: 'M' });
  assert.deepEqual(manifest, { BasePath: ROOT + '/odc/snapshots/b.oml', evidenceDir: ROOT + '/odc/lab/ev', module: 'M' });
  assert.deepEqual(ws.agentPathsOut({ ...manifest }), { BasePath: 'agent:odc/snapshots/b.oml', evidenceDir: 'agent:odc/lab/ev', module: 'M' });
  assert.throws(() => ws.agentPathsIn({ basePath: ROOT + '/odc/snapshots/b.oml' }), /must be agent:/);
  assert.throws(() => ws.agentPathsOut({ basePath: '/etc/hosts' }), /not a path the server may see/);
});

test('Windows keeps its own rules when the platform is not darwin (the prefix keeps the case it was given)', () => {
  const ws = createWorkspace('C:\\SSAM-Agent-x', { platform: 'win32' });
  assert.equal(ws.toAgent('C:\\SSAM-Agent-x\\ODC\\Lab\\x.json'), 'agent:ODC/Lab/x.json');
  assert.equal(ws.toAgent(ROOT + '/odc/lab/x'), null);
});
