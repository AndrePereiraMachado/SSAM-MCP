// Confinement of the agent's folders (docs/FASE2-AGENTE.md 6.2), json:"agent-paths" and reply relativization.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkspace } from '../lib/workspace.mjs';
import { makeRoot, removeRoot } from './fixtures/agent-root.mjs';

const code = (fn, expected) => assert.throws(fn, error => { assert.equal(error.code, expected, error.message); assert.equal(error.executed, false); return true; });

test('agent: paths resolve by role inside the allowed prefixes only', () => {
  const root = makeRoot();
  try {
    const ws = createWorkspace(root);
    assert.equal(ws.resolve('agent:odc/lab/job/manifest.json', 'write'), path.join(root, 'odc', 'lab', 'job', 'manifest.json'));
    assert.equal(ws.resolve('agent:o11\\snapshots\\M.oml', 'write'), path.join(root, 'o11', 'snapshots', 'M.oml'));
    assert.equal(ws.resolve('agent:odc/journal/staging/x.oml', 'read'), path.join(root, 'odc', 'journal', 'staging', 'x.oml'));
    assert.equal(ws.resolve('agent:inbox/cliente.oml', 'read'), path.join(root, 'inbox', 'cliente.oml'));
    assert.equal(ws.resolve('agent:o11', 'read'), path.join(root, 'o11'));
    assert.equal(ws.resolve('agent:ODC/Snapshots/x.oml', 'write'), path.join(root, 'ODC', 'Snapshots', 'x.oml'));
    // An output outside a writable prefix.
    code(() => ws.resolve('agent:inbox/cliente.oml', 'write'), 'PATH_FORBIDDEN');
    code(() => ws.resolve('agent:o11', 'write'), 'PATH_FORBIDDEN');
    // Not agent: at all.
    code(() => ws.resolve('C:\\Windows\\x.oml', 'read'), 'PATH_NOT_AGENT');
    code(() => ws.resolve('odc/lab/x.json', 'read'), 'PATH_NOT_AGENT');
    code(() => ws.resolve(null, 'read'), 'PATH_NOT_AGENT');
  } finally { removeRoot(root); }
});

test('traversal, absolute, UNC, streams, NUL, devices and trailing dots or spaces are refused', () => {
  const root = makeRoot();
  try {
    const ws = createWorkspace(root);
    for (const value of ['agent:odc/lab/../../private/credential', 'agent:../outside.txt', 'agent:odc/lab/./x.json', 'agent:odc/lab/..',
      'agent:C:/Windows/win.ini', 'agent:C:\\Windows\\win.ini', 'agent:/odc/lab/x', 'agent:\\\\server\\share\\x.oml', 'agent:\\\\?\\C:\\x',
      'agent:odc/lab/x.json:secret', 'agent:odc/lab/x.json::$DATA', 'agent:odc/lab/x\0.json', 'agent:odc/lab/a\u0001b',
      'agent:odc/lab/NUL', 'agent:odc/lab/nul.txt', 'agent:odc/lab/COM1.json', 'agent:odc/lab/lpt9.oml', 'agent:odc/lab/con .txt', 'agent:odc/lab/AUX/x',
      'agent:odc/lab/x.', 'agent:odc/lab/x ', 'agent:odc/lab/dir./x.json', 'agent:odc/lab//x.json', 'agent:odc/lab/x*.json', 'agent:'])
      for (const role of ['read', 'write']) code(() => ws.resolve(value, role), 'PATH_FORBIDDEN');
  } finally { removeRoot(root); }
});

test('the agent code, binaries, private folder, bridge root and pack.json are never readable nor writable', () => {
  const root = makeRoot();
  try {
    const ws = createWorkspace(root);
    for (const value of ['agent:odc/studio/bridge/bin/Release/net8.0/ODC3.Bridge.v35.dll', 'agent:odc/README.md', 'agent:odc', 'agent:private/credential',
      'agent:private/authority/bridge.key', 'agent:bin/o11/bridge/Anvil.Bridge.dll', 'agent:pack.json', 'agent:agent/ssam-agent.mjs', 'agent:odc/tmp/x',
      // The release layout of a pack with the hook h1: the hook, the bridge b1, the manifest and its signature.
      'agent:studio/o11/hook/Anvil.Hook.h1.dll', 'agent:studio/o11/bridge/b1/Anvil.Bridge.dll', 'agent:release.json', 'agent:release.sig.jws',
      'agent:private/o11-bridge/bridge-4566.log'])
      for (const role of ['read', 'write']) code(() => ws.resolve(value, role), 'PATH_FORBIDDEN');
  } finally { removeRoot(root); }
});

test('a junction that leaves its prefix is refused (realpath), also for an absolute path of a bridge line', () => {
  const root = makeRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-agent-outside-'));
  try {
    fs.symlinkSync(outside, path.join(root, 'odc', 'lab', 'escape'), 'junction');
    fs.symlinkSync(path.join(root, 'private'), path.join(root, 'o11', 'private-link'), 'junction');
    const ws = createWorkspace(root);
    code(() => ws.resolve('agent:odc/lab/escape/x.txt', 'write'), 'PATH_FORBIDDEN');
    code(() => ws.resolve('agent:odc/lab/escape', 'read'), 'PATH_FORBIDDEN');
    code(() => ws.resolve('agent:o11/private-link/credential', 'read'), 'PATH_FORBIDDEN');
    code(() => ws.checkAbsolute(path.join(root, 'odc', 'lab', 'escape', 'x.txt'), 'read'), 'PATH_FORBIDDEN');
    assert.equal(fs.readdirSync(outside).length, 0);
  } finally { removeRoot(root); removeRoot(outside); }
});

test('absolute paths of a bridge line: only under the root, in a prefix for the role', () => {
  const root = makeRoot();
  try {
    const ws = createWorkspace(root);
    assert.equal(ws.checkAbsolute(path.join(root, 'odc', 'lab', 'm.json'), 'write'), path.join(root, 'odc', 'lab', 'm.json'));
    assert.equal(ws.checkAbsolute(root.replaceAll('\\', '/') + '/inbox/a.oml', 'read'), path.join(root, 'inbox', 'a.oml'));
    code(() => ws.checkAbsolute(path.join(root, 'inbox', 'a.oml'), 'write'), 'PATH_FORBIDDEN');
    code(() => ws.checkAbsolute(path.join(root, 'private', 'credential'), 'read'), 'PATH_FORBIDDEN');
    code(() => ws.checkAbsolute(path.join(root, 'odc', 'lab', '..', '..', 'private', 'credential'), 'read'), 'PATH_FORBIDDEN');
    code(() => ws.checkAbsolute('C:\\Windows\\win.ini', 'read'), 'PATH_FORBIDDEN');
    code(() => ws.checkAbsolute('\\\\server\\share\\x', 'read'), 'PATH_FORBIDDEN');
    code(() => ws.checkAbsolute('C:secret.json', 'read'), 'PATH_FORBIDDEN');
  } finally { removeRoot(root); }
});

test('json:"agent-paths" maps only the 5 manifest fields, in both directions', () => {
  const root = makeRoot();
  try {
    const ws = createWorkspace(root);
    const manifest = { schema: 'odc3-manifest/1', module: 'Quotes', basePath: 'agent:odc/snapshots/Quotes.oml', CandidatePath: 'agent:odc/lab/j/candidate.oml',
      producerPath: 'agent:odc/snapshots/Lib.oml', builderReceipt: 'agent:odc/lab/j/receipt.json', evidenceDir: 'agent:odc/lab/j/evidence',
      tenant: 'C:\\not-a-path-field', changes: ['agent:odc/lab/x'], publishAuthorization: null };
    const mapped = ws.agentPathsIn(structuredClone(manifest));
    assert.equal(mapped.basePath, path.join(root, 'odc', 'snapshots', 'Quotes.oml'));
    assert.equal(mapped.CandidatePath, path.join(root, 'odc', 'lab', 'j', 'candidate.oml'));
    assert.equal(mapped.producerPath, path.join(root, 'odc', 'snapshots', 'Lib.oml'));
    assert.equal(mapped.builderReceipt, path.join(root, 'odc', 'lab', 'j', 'receipt.json'));
    assert.equal(mapped.evidenceDir, path.join(root, 'odc', 'lab', 'j', 'evidence'));
    assert.equal(mapped.tenant, manifest.tenant);
    assert.deepEqual(mapped.changes, manifest.changes);
    assert.equal(mapped.publishAuthorization, null);
    // Empty base (creation manifest) stays empty.
    assert.equal(ws.agentPathsIn({ basePath: '', candidatePath: 'agent:odc/lab/c.oml' }).basePath, '');
    // An absolute value in one of the 5 fields, a relative one, or an evidence folder that is not writable.
    code(() => ws.agentPathsIn({ basePath: 'C:\\Users\\cliente\\segredo.oml' }), 'PATH_FORBIDDEN');
    code(() => ws.agentPathsIn({ candidatePath: 'snapshots\\x.oml' }), 'PATH_FORBIDDEN');
    code(() => ws.agentPathsIn({ BUILDERRECEIPT: 'C:\\x.json' }), 'PATH_FORBIDDEN');
    code(() => ws.agentPathsIn({ evidenceDir: 'agent:inbox/evidence' }), 'PATH_FORBIDDEN');
    // file.get: the inverse.
    const back = ws.agentPathsOut(structuredClone(mapped));
    assert.deepEqual(back, manifest);
    code(() => ws.agentPathsOut({ basePath: 'C:\\Windows\\x.oml' }), 'PATH_FORBIDDEN');
    code(() => ws.agentPathsOut({ evidenceDir: path.join(root, 'inbox', 'x') }), 'PATH_FORBIDDEN');
  } finally { removeRoot(root); }
});

test('replies: absolute paths under the root in readable prefixes become agent:, at any depth', () => {
  const root = makeRoot();
  try {
    const ws = createWorkspace(root);
    const reply = { ok: true, path: path.join(root, 'odc', 'snapshots', 'Quotes.oml'),
      nested: { list: [path.join(root, 'o11', 'downloads', 'x', 'M.oml'), root.toUpperCase() + '\\INBOX\\A.OML', 'C:\\elsewhere\\x.oml',
        path.join(root, 'bin', 'o11', 'bridge', 'Anvil.Bridge.dll'), path.join(root, 'private', 'credential'),
        path.join(root, 'odc', 'lab', '..', '..', 'private', 'credential')] },
      text: 'saved ' + path.join(root, 'odc', 'lab', 'x'), count: 3, flag: true, none: null };
    const paths = [];
    const out = ws.relativize(reply, paths);
    assert.equal(out.path, 'agent:odc/snapshots/Quotes.oml');
    assert.equal(out.nested.list[0], 'agent:o11/downloads/x/M.oml');
    assert.equal(out.nested.list[1], 'agent:INBOX/A.OML');
    assert.deepEqual(out.nested.list.slice(2), reply.nested.list.slice(2));
    assert.equal(out.text, reply.text);
    assert.equal(out.count, 3); assert.equal(out.flag, true); assert.equal(out.none, null);
    // The key paths of exactly the strings rewritten: the server maps those and nothing else.
    assert.deepEqual(paths, [['path'], ['nested', 'list', 0], ['nested', 'list', 1]]);
    assert.deepEqual(ws.relativize(reply), out, 'without a collector the value is the same');
  } finally { removeRoot(root); }
});

test('replies: text that already starts with agent: is data, never reported as a path', () => {
  const root = makeRoot();
  try {
    const ws = createWorkspace(root);
    const paths = [];
    const reply = { ok: true, rows: [['1', 'agent:smith'], ['2', 'agent:odc/snapshots/x.oml']], path: path.join(root, 'odc', 'lab', 'r.json') };
    const out = ws.relativize(reply, paths);
    assert.deepEqual(out.rows, reply.rows);
    assert.deepEqual(paths, [['path']]);
  } finally { removeRoot(root); }
});
