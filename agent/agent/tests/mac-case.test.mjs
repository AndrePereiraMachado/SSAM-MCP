// Case on macOS (review B3). APFS compares names without case by default, but a volume can be case-sensitive, and there
// /Users/ana/ssam-agent is ANOTHER folder than /Users/ana/SSAM-Agent. A bridge line and a manifest go to the bridge as
// they are (the agent only checks them), so an absolute path names the agent folder only when it is spelled exactly as
// the root (as given or its real path; NFC and NFD are the same name on every APFS volume) and the prefix exactly as the
// prefix (odc/lab, inbox, ...); a link must stay inside its prefix spelled exactly too. agent: paths are unchanged (the
// agent writes the canonical path itself). The file system is a model in memory (from the review's ws-posix test), with
// a case-sensitive option.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkspace } from '../lib/workspace.mjs';
import { createKinds } from '../lib/kinds.mjs';

const posix = path.posix;
const failure = code => Object.assign(new Error(code), { code });
function apfs(tree, { caseSensitive = false } = {}) {
  const key = p => (caseSensitive ? p.normalize('NFC') : p.normalize('NFC').toLowerCase());
  const entries = new Map();
  const put = (p, kind, target = null) => { if (!entries.has(key(p))) entries.set(key(p), { path: p, kind, target }); };
  for (const [p, value] of Object.entries(tree)) {
    for (let up = posix.dirname(p); up !== '/'; up = posix.dirname(up)) put(up, 'dir');
    entries.set(key(p), value.startsWith('->') ? { path: p, kind: 'link', target: value.slice(2) } : { path: p, kind: value });
  }
  put('/', 'dir');
  const real = (p, depth = 0) => {
    if (depth > 32) throw failure('ELOOP');
    let current = '/';
    for (const part of posix.normalize(p).split('/').filter(Boolean)) {
      if (part === '..') { current = posix.dirname(current); continue; }
      const entry = entries.get(key(posix.join(current, part)));
      if (!entry) throw failure('ENOENT');
      current = entry.kind === 'link' ? real(entry.target.startsWith('/') ? entry.target : posix.join(current, entry.target), depth + 1) : entry.path;
    }
    return current;
  };
  const lstat = p => {
    const n = posix.normalize(p);
    const entry = entries.get(key(posix.join(real(posix.dirname(n)), posix.basename(n))));
    if (!entry) throw failure('ENOENT');
    return { isDirectory: () => entry.kind === 'dir', isSymbolicLink: () => entry.kind === 'link' };
  };
  return { lstatSync: lstat, realpathSync: Object.assign(p => real(p), { native: p => real(p) }) };
}
const ROOT = '/Users/ana/SSAM-Agent';
const base = { [ROOT + '/odc/snapshots']: 'dir', [ROOT + '/odc/lab']: 'dir', [ROOT + '/o11/journal/staging']: 'dir', [ROOT + '/inbox/a.oml']: 'file', [ROOT + '/private/credential']: 'file' };
const refused = (fn, label) => assert.throws(fn, error => { assert.equal(error.code, 'PATH_FORBIDDEN', label + ': ' + error.message); return true; }, label);

test('darwin: an absolute path is the agent folder only when the root and the prefix are spelled exactly (another case is another folder on a case-sensitive volume)', () => {
  for (const caseSensitive of [true, false]) {
    const files = apfs({ ...base, '/Users/ana/ssam-agent/odc/lab/x.json': 'file' }, { caseSensitive });
    const ws = createWorkspace(ROOT, { platform: 'darwin', files });
    assert.equal(ws.checkAbsolute(ROOT + '/odc/lab/x.json', 'read'), ROOT + '/odc/lab/x.json');
    assert.equal(ws.toAgent(ROOT + '/odc/lab/Run/x.json'), 'agent:odc/lab/Run/x.json', 'inside the prefix the case of a name is kept as it is');
    for (const text of ['/Users/ana/ssam-agent/odc/lab/x.json', '/users/ana/SSAM-Agent/odc/lab/x.json', ROOT + '/ODC/lab/x.json', ROOT + '/odc/LAB/x.json', ROOT + '/Inbox/a.oml']) {
      refused(() => ws.checkAbsolute(text, 'read'), `${text} (case-sensitive ${caseSensitive})`);
      assert.equal(ws.toAgent(text), null, text);
    }
    // agent: paths are the agent's own: the canonical spelling goes to the bridge.
    assert.equal(ws.resolve('agent:ODC/Lab/x.json', 'write'), ROOT + '/odc/lab/x.json');
  }
});

test('darwin: a link into a sibling folder spelled in another case leaves the prefix (case-sensitive volume)', () => {
  const files = apfs({ ...base, [ROOT + '/odc/lab/side']: '->/Users/ana/ssam-agent/odc/lab', '/Users/ana/ssam-agent/odc/lab/y': 'file', [ROOT + '/odc/lab/inner']: '->sub', [ROOT + '/odc/lab/sub/f']: 'file' }, { caseSensitive: true });
  const ws = createWorkspace(ROOT, { platform: 'darwin', files });
  refused(() => ws.resolve('agent:odc/lab/side/y', 'read'), 'link to a sibling of another case');
  refused(() => ws.resolve('agent:odc/lab/side/new.json', 'write'), 'write through it');
  assert.equal(ws.resolve('agent:odc/lab/inner/f', 'read'), ROOT + '/odc/lab/inner/f', 'a link that stays inside is still followed');
});

test('darwin: NFC and NFD are still the same name, and /var is still /private/var', () => {
  const nfc = '/Users/joão/SSAM-Agent'; const nfd = '/Users/joão/SSAM-Agent';
  const ws = createWorkspace(nfc, { platform: 'darwin', files: apfs({ [nfc + '/odc/lab']: 'dir', [nfc + '/private/credential']: 'file' }, { caseSensitive: true }) });
  assert.equal(ws.checkAbsolute(nfd + '/odc/lab/r.json', 'write').normalize('NFC'), nfc + '/odc/lab/r.json');
  assert.equal(ws.toAgent(nfd + '/odc/lab/r.json'), 'agent:odc/lab/r.json');
  refused(() => ws.checkAbsolute(nfd + '/private/credential', 'read'), 'private in NFD');
  const linked = createWorkspace('/var/agent', { platform: 'darwin', files: apfs({ '/var': '->/private/var', '/private/var/agent/odc/lab': 'dir' }) });
  assert.equal(linked.checkAbsolute('/private/var/agent/odc/lab/x', 'write'), '/var/agent/odc/lab/x');
});

test('darwin odc.pipe: a manifest or a line word with the root in another case is refused before the bridge gets anything', async () => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-case-'));
  const root = top.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/') + '/SSAM-Agent';
  try {
    fs.mkdirSync(path.join(top, 'SSAM-Agent', 'odc', 'lab'), { recursive: true });
    fs.mkdirSync(path.join(top, 'SSAM-Agent', 'odc', 'snapshots'), { recursive: true });
    const files = { lstatSync: p => fs.lstatSync(p), realpathSync: Object.assign(p => posix.normalize(p), { native: p => posix.normalize(p) }) };
    const ws = createWorkspace(root, { platform: 'darwin', files });
    const sent = [];
    const kinds = createKinds({ root, ws, pack: { lanes: ['odc'], odcBridge: 'v97' }, kernel: () => ({ odc: '1.7.28' }), platform: 'darwin',
      deps: { processes: async () => [{ pid: 501, path: '/Applications/ODC Studio.app/Contents/MacOS/ODC Studio', version: '1.7.28.10873' }], fileVersion: async () => null,
        pipeCall: async (pid, version, args) => { sent.push(args); return '{"ok":true}'; } } });
    const variant = root.replace('SSAM-Agent', 'ssam-agent');
    const manifest = path.join(top, 'SSAM-Agent', 'odc', 'lab', 'm.json');
    fs.writeFileSync(manifest, JSON.stringify({ basePath: variant + '/odc/snapshots/b.oml', evidenceDir: root + '/odc/lab/ev' }));
    await assert.rejects(kinds.execute('odc.pipe', { pid: 501, version: 'v97', args: ['merge', 'agent:odc/lab/m.json'] }), e => e.code === 'PATH_FORBIDDEN');
    await assert.rejects(kinds.execute('odc.pipe', { pid: 501, version: 'v97', args: ['status', variant + '/odc/lab/x.json'] }), e => e.code === 'PATH_FORBIDDEN');
    assert.deepEqual(sent, [], 'nothing reached the bridge');
    fs.writeFileSync(manifest, JSON.stringify({ basePath: root + '/odc/snapshots/b.oml', evidenceDir: root + '/odc/lab/ev' }));
    await kinds.execute('odc.pipe', { pid: 501, version: 'v97', args: ['merge', 'agent:odc/lab/m.json'] });
    assert.deepEqual(sent, [['merge', root + '/odc/lab/m.json']]);
  } finally { fs.rmSync(top, { recursive: true, force: true }); }
});
