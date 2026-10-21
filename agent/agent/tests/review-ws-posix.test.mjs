// The independent review's own tests of the darwin workspace rules (lib/workspace.mjs) with an APFS-like model in memory,
// kept in the box (round 2). Two expectations changed with review B3 (mac-case.test.mjs): another case of the root is
// refused, and the case-sensitive finding is now a refusal.
// The model: lookups without case and without normalization (APFS default), symlinks absolute or relative, ELOOP; an
// option caseSensitive models a case-sensitive APFS volume (normalization-insensitive still).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createWorkspace } from '../lib/workspace.mjs';

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
  // lstat: every component but the last is followed (as the kernel does).
  const lstat = p => {
    const n = posix.normalize(p);
    const parent = posix.dirname(n);
    const base = real(parent);
    const entry = entries.get(key(posix.join(base, posix.basename(n))));
    if (!entry) throw failure('ENOENT');
    return { isDirectory: () => entry.kind === 'dir', isSymbolicLink: () => entry.kind === 'link' };
  };
  return { entries, lstatSync: lstat, realpathSync: Object.assign(p => real(p), { native: p => real(p) }),
    add: (p, value) => { entries.set(key(p), value.startsWith('->') ? { path: p, kind: 'link', target: value.slice(2) } : { path: p, kind: value }); } };
}

const ROOT = '/Users/ana/SSAM-Agent';
const base = {
  [ROOT + '/odc/snapshots']: 'dir', [ROOT + '/odc/journal/staging']: 'dir', [ROOT + '/odc/lab']: 'dir', [ROOT + '/o11/journal/staging']: 'dir',
  [ROOT + '/inbox/a.oml']: 'file', [ROOT + '/private/credential']: 'file', [ROOT + '/private/authority/bridge.key']: 'file',
  '/Users/ana/Documents/secret.txt': 'file', '/etc/hosts': 'file', '/var': '->/private/var', '/private/var/folders/x/T': 'dir',
};
const ws = (extra = {}, options = {}) => { const files = apfs({ ...base, ...extra }, options); return { ws: createWorkspace(ROOT, { platform: 'darwin', files }), files }; };
const refused = (fn, label) => assert.throws(fn, error => { assert.equal(error.code, 'PATH_FORBIDDEN', label + ': ' + error.message); assert.equal(error.executed, false, label); return true; }, label);

test('dot-dot, absolute, NUL, control, reserved, empty segments, wildcards: refused for both roles', () => {
  const { ws: w } = ws();
  const bad = ['agent:odc/lab/../../private/credential', 'agent:odc/lab/..', 'agent:odc\\lab\\..\\..\\private\\credential', 'agent:odc/lab/./x',
    'agent:/Users/ana/SSAM-Agent/private/credential', 'agent:odc/lab/x\u0000y', 'agent:odc/lab/x\ny', 'agent:odc/lab/x\u001fy', 'agent:odc/lab//x',
    'agent:odc/lab/x?', 'agent:odc/lab/x*', 'agent:odc/lab/a:b', 'agent:odc/lab/CON', 'agent:odc/lab/x.', 'agent:odc/lab/x ', 'agent:private/credential',
    'agent:PRIVATE/credential', 'agent:Private/authority/bridge.key', 'agent:odc/studio/x', 'agent:ODC/Studio/x', 'agent:pack.json', 'agent:agent/lib/x.mjs',
    'agent:', 'agent:inbox/../private/credential'];
  for (const value of bad) for (const role of ['read', 'write']) refused(() => w.resolve(value, role), value + ' ' + role);
});

test('lookalike prefixes (Unicode case and compatibility forms) never match a prefix', () => {
  const { ws: w } = ws();
  for (const value of ['agent:\u0130nbox/a.oml', 'agent:\u0456nbox/a.oml', 'agent:\uff4fdc/lab/x', 'agent:odc/\u2025/x', 'agent:o\u0031\u0031x/y', 'agent:inbox\u0301/a.oml'])
    for (const role of ['read', 'write']) {
      let out = null;
      try { out = w.resolve(value, role); } catch (error) { assert.equal(error.code, 'PATH_FORBIDDEN'); continue; }
      // a name that only looks like something else is fine as long as it stays inside a prefix
      assert.ok(out.startsWith(ROOT + '/'), value + ' -> ' + out);
      assert.ok(!/\/private\//i.test(out), value + ' -> ' + out);
    }
  // A Unicode ellipsis-like segment is a plain name, inside the prefix.
  assert.equal(w.resolve('agent:odc/lab/\u2025', 'write'), ROOT + '/odc/lab/\u2025');
});

test('links: final, middle, chained, relative, to the root, to another prefix, broken, loop: refused when the real path leaves the prefix', () => {
  const { ws: w } = ws({
    [ROOT + '/odc/lab/home']: '->/Users/ana', [ROOT + '/odc/lab/up']: '->../..', [ROOT + '/odc/lab/chain1']: '->chain2', [ROOT + '/odc/lab/chain2']: '->/etc',
    [ROOT + '/odc/lab/root']: '->' + ROOT, [ROOT + '/odc/lab/snap']: '->../snapshots', [ROOT + '/odc/lab/broken']: '->/nowhere',
    [ROOT + '/odc/lab/loop']: '->loop', [ROOT + '/odc/lab/inner']: '->sub', [ROOT + '/odc/lab/sub/f.json']: 'file', [ROOT + '/odc/lab/var']: '->/var/folders/x/T',
    [ROOT + '/odc/lab/file-out']: '->/Users/ana/Documents/secret.txt' });
  for (const [value, role] of [['agent:odc/lab/home/Documents/secret.txt', 'read'], ['agent:odc/lab/home/new.txt', 'write'], ['agent:odc/lab/up/private/credential', 'read'],
    ['agent:odc/lab/chain1/hosts', 'read'], ['agent:odc/lab/root/private/credential', 'read'],
    ['agent:odc/lab/snap/x.oml', 'write'], ['agent:odc/lab/broken/x', 'write'], ['agent:odc/lab/loop/x', 'write'], ['agent:odc/lab/var/x', 'write'],
    ['agent:odc/lab/file-out', 'read'], ['agent:odc/lab/file-out', 'write']])
    refused(() => w.resolve(value, role), value + ' ' + role);
  // A link that stays in its prefix is followed.
  assert.equal(w.resolve('agent:odc/lab/inner/f.json', 'read'), ROOT + '/odc/lab/inner/f.json');
});

test('a link made AFTER the check is not seen (time of check / time of use): the same as Windows, a limit of any path check', () => {
  const { ws: w, files } = ws();
  const target = w.resolve('agent:odc/lab/job/out.json', 'write');
  assert.equal(target, ROOT + '/odc/lab/job/out.json');
  files.add(ROOT + '/odc/lab/job', '->/Users/ana/Documents');
  // The path handed out already: whoever writes it now writes into ~/Documents. A new check refuses it.
  assert.equal(files.realpathSync(posix.dirname(target)), '/Users/ana/Documents');
  refused(() => w.resolve('agent:odc/lab/job/out.json', 'write'), 'after the link');
});

test('absolute paths of a bridge line: /var and /private/var, NFD, case (APFS default), outside, sibling folder', () => {
  const files = apfs({ ...base, '/private/var/agent/odc/lab': 'dir', '/private/var/agent/private/credential': 'file' });
  const w = createWorkspace('/var/agent', { platform: 'darwin', files });
  assert.equal(w.checkAbsolute('/private/var/agent/odc/lab/x', 'write'), '/var/agent/odc/lab/x');
  refused(() => w.checkAbsolute('/VAR/Agent/ODC/lab/x', 'write'), 'another case of the root (review B3)');
  refused(() => w.checkAbsolute('/private/var/agent/private/credential', 'read'), 'private via real root');
  refused(() => w.checkAbsolute('/var/agent2/odc/lab/x', 'write'), 'sibling with a longer name');
  refused(() => w.checkAbsolute('/var/agent/odc/lab/../../private/credential', 'read'), 'dot-dot');
  refused(() => w.checkAbsolute('/var/agent/odc/lab/x\u0000', 'write'), 'NUL');
  refused(() => w.checkAbsolute('//var/agent/odc/lab/x', 'write'), 'double slash start');
  const nfc = '/Users/jo\u00e3o/SSAM-Agent'; const nfd = '/Users/joa\u0303o/SSAM-Agent';
  const w2 = createWorkspace(nfc, { platform: 'darwin', files: apfs({ [nfc + '/odc/lab']: 'dir', [nfc + '/private/credential']: 'file' }) });
  refused(() => w2.checkAbsolute(nfd + '/private/credential', 'read'), 'NFD root, private');
  assert.equal(w2.checkAbsolute(nfd + '/odc/lab/r.json', 'write'), nfc + '/odc/lab/r.json');
  // A root spelled in NFD by the person (HOME as given) and the real path in NFC.
  const w3 = createWorkspace(nfd, { platform: 'darwin', files: apfs({ [nfc + '/odc/lab']: 'dir' }) });
  assert.equal(w3.toAgent(nfc + '/odc/lab/r.json'), 'agent:odc/lab/r.json');
});

test('was FINDING B3 (case-sensitive APFS): a case variant of the root and a link into a case variant sibling are refused now', () => {
  // On a case-sensitive volume /Users/ana/ssam-agent is ANOTHER folder. kinds.mjs checkFinalLine only calls checkAbsolute;
  // the word the bridge receives is the one the server sent.
  const files = apfs({ ...base, '/Users/ana/ssam-agent/odc/lab/x.json': 'file' }, { caseSensitive: true });
  const w = createWorkspace(ROOT, { platform: 'darwin', files });
  refused(() => w.checkAbsolute('/Users/ana/ssam-agent/odc/lab/x.json', 'read'), 'case variant of the root');
  assert.notEqual(files.realpathSync('/Users/ana/ssam-agent/odc/lab/x.json'), files.realpathSync(ROOT + '/odc/lab'));
  // And a link into a case variant sibling leaves the prefix (confine compares with case).
  const files2 = apfs({ ...base, [ROOT + '/odc/lab/side']: '->/Users/ana/ssam-agent/odc/lab', '/Users/ana/ssam-agent/odc/lab/y': 'file' }, { caseSensitive: true });
  const w2 = createWorkspace(ROOT, { platform: 'darwin', files: files2 });
  refused(() => w2.resolve('agent:odc/lab/side/y', 'read'), 'link into a case variant sibling');
});

test('replies: only readable prefixes spelled exactly become agent: paths; private, studio, the pack and another case stay absolute', () => {
  const { ws: w } = ws();
  const out = w.relativize({ a: ROOT + '/private/credential', b: ROOT + '/odc/studio/bridge/x.dll', c: ROOT + '/ODC/LAB/e.json', f: ROOT + '/odc/lab/e.json', d: '/etc/hosts', e: ROOT + '/inbox/../private/x' });
  assert.deepEqual(out, { a: ROOT + '/private/credential', b: ROOT + '/odc/studio/bridge/x.dll', c: ROOT + '/ODC/LAB/e.json', f: 'agent:odc/lab/e.json', d: '/etc/hosts', e: ROOT + '/inbox/../private/x' });
});
