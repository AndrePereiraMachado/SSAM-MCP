// CX15 r5 (N-2): a fake ODC bridge behind the REAL lib.mjs client() (its pipe call injected, no named pipe, no DLL), doing
// what the C# does with the owner's words: authorize <manifest> publish|create <text...> (StartupHook.cs Authorize:
// Split(' ', 3), node[field] = text + " [recorded ...]", the answer {ok, manifest, field, text}); publish writes
// publish-started.json {authorization = manifest.publishAuthorization} (:1448); create-app writes create-started.json
// {authorization = manifest.createAuthorization} (:418); both require only a nonempty value (:402, :1410,
// AppCreationCommands.cs:121). Synthetic values; every line that crossed the "pipe" is kept.
import fs from 'node:fs';
import path from 'node:path';
import { client } from '../../lib.mjs';

export const BRIDGE_PID = 3999017, BRIDGE_HOST = 'zz-synth.outsystems.dev';
export function fakeBridge() {
  const lines = [];
  const dispatch = line => {
    const space = line.indexOf(' ');
    const command = space < 0 ? line : line.slice(0, space), argument = space < 0 ? '' : line.slice(space + 1).trim();
    if (command === 'authorize') {
      const parts = argument.split(' ').filter(Boolean), p3 = [parts[0], parts[1], parts.slice(2).join(' ')];
      if (!(parts.length >= 3 && (p3[1] === 'publish' || p3[1] === 'create'))) return { ok: false, error: 'authorize requires: <manifest> publish|create <text>' };
      const file = path.resolve(p3[0]), node = JSON.parse(fs.readFileSync(file, 'utf8'));
      const field = p3[1] === 'publish' ? 'publishAuthorization' : 'createAuthorization';
      const text = p3[2].trim() + ' [recorded ' + new Date().toISOString() + ' by bridge v99]';
      node[field] = text; fs.writeFileSync(file, JSON.stringify(node));
      return { ok: true, manifest: file, field, text };
    }
    if (command === 'publish') {
      const file = path.resolve(argument.split(' ')[0]), m = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!String(m.publishAuthorization ?? '').trim()) return { ok: false, error: 'publish requires manifest.publishAuthorization with the user\'s explicit authorization text.' };
      fs.mkdirSync(m.evidenceDir, { recursive: true });
      fs.writeFileSync(path.join(m.evidenceDir, 'publish-started.json'), JSON.stringify({ at: new Date().toISOString(), pid: BRIDGE_PID, module: m.module, authorization: m.publishAuthorization }));
      const receipt = { ok: true, module: m.module, published: { revision: 2 }, completedAt: new Date().toISOString() };
      fs.writeFileSync(path.join(m.evidenceDir, 'publish-receipt.json'), JSON.stringify(receipt));
      return receipt;
    }
    if (command === 'create-app') {
      const file = path.resolve(argument.split(' ')[0]), m = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!String(m.createAuthorization ?? '').trim()) return { ok: false, error: 'create-app requires manifest.createAuthorization with the user\'s explicit authorization text.' };
      fs.mkdirSync(m.evidenceDir, { recursive: true });
      fs.writeFileSync(path.join(m.evidenceDir, 'create-started.json'), JSON.stringify({ at: new Date().toISOString(), pid: BRIDGE_PID, module: m.module, tenant: BRIDGE_HOST, authorization: m.createAuthorization }));
      return { ok: true, created: true, merged: false, module: m.module, moduleKey: m.moduleKey, tenant: BRIDGE_HOST, assetKey: 'zz-asset', assetName: m.module, assetType: 'Library', revision: 1 };
    }
    if (command === 'open') return { ok: true, module: 'ZZLibN2', developerId: 'zz-dev' };
    if (command === 'auth-status') return { ok: true, sessions: [{ host: BRIDGE_HOST, user: 'zz-dev', loggedIn: true }] };
    if (command === 'status') return { ok: true, pid: BRIDGE_PID, modules: [] };
    return { ok: false, error: 'fake: unexpected ' + command };
  };
  // The pipe call of odc-pipe.mjs: the line is args.map(String).join(' ') (pipeAttempt), the answer a JSON line.
  const call = async (pid, version, args) => { const line = args.map(String).join(' '); lines.push(line); let answer;
    try { answer = dispatch(line.trim()); } catch (error) { answer = { ok: false, error: error.message }; } return JSON.stringify(answer); };
  // A studio() whose commands go through the real client() (the hashing point every bridge command crosses). A tree whose
  // client() has no version option (before r5) answers "The bridge client is not built": there the line goes to the fake
  // pipe as it came, so the test fails on the words, not on the seam.
  let direct = 0;
  const studio = async (args, pid) => {
    try { return await client(pid ?? BRIDGE_PID, args, { call, version: 'v99' }); }
    catch (error) { if (!/not built/i.test(String(error?.message))) throw error; direct++; return JSON.parse(await call(pid ?? BRIDGE_PID, 'v99', args)); }
  };
  return { lines, call, studio, direct: () => direct };
}
// A merged delivery in a lab: manifest + evidence/receipt.json (the shape of atritos-a-publish.test.mjs).
export function delivery(root, name, module) {
  const dir = path.join(root, 'lab', name, 'delivery'), evidence = path.join(dir, 'evidence');
  fs.mkdirSync(evidence, { recursive: true });
  const manifest = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ schema: 'odc3-manifest/1', feature: 'ZZFeat', module, moduleKey: 'zz-key', tenant: BRIDGE_HOST, author: 'zz-dev', owners: ['ZZ'], changes: ['zz'], evidenceDir: evidence }));
  fs.writeFileSync(path.join(evidence, 'merge-started.json'), JSON.stringify({ at: '2026-10-15T00:00:00Z', pid: BRIDGE_PID, module }));
  fs.writeFileSync(path.join(evidence, 'receipt.json'), JSON.stringify({ ok: true, merged: true, module, outcome: 'merged', sha256: 'zz', strictlyEqual: true }));
  return { manifest, evidence };
}
