// The native pack of the app keeps the Integration Studio engine host of o11.xif (F4): stageNativePack copies only the binary
// roots, and xif-engine/Anvil.Xif.Engine.exe (+ .exe.config) is one of them on Windows; nothing else under xif-engine/ is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { stageNativePack } from '../../scripts/native-pack.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
// The smallest x64 PE with no CLR header (validateNativeImage).
function fakeNative() {
  const pe = 64, bytes = Buffer.alloc(pe + 264);
  bytes.writeUInt32LE(pe, 0x3c); bytes.writeUInt32LE(0x4550, pe); bytes.writeUInt16LE(0x8664, pe + 4); bytes.writeUInt16LE(0x20b, pe + 24);
  return bytes;
}
test('the native pack keeps xif-engine/Anvil.Xif.Engine.exe and its config, and drops anything else there', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-native-xif-'));
  try {
    const source = path.join(work, 'source');
    const entries = { 'xif-engine/Anvil.Xif.Engine.exe': 'engine', 'xif-engine/Anvil.Xif.Engine.exe.config': '<configuration/>', 'xif-engine/notes.txt': 'x', 'agent/lib/agent.mjs': 'code' };
    const files = [];
    for (const [rel, text] of Object.entries(entries)) {
      fs.mkdirSync(path.join(source, path.dirname(rel)), { recursive: true }); fs.writeFileSync(path.join(source, rel), text);
      files.push({ path: rel, size: Buffer.byteLength(text), sha256: sha(Buffer.from(text)) });
    }
    fs.writeFileSync(path.join(source, 'pack.json'), JSON.stringify({ id: 'p', lanes: [], xifEngine: { path: 'xif-engine/Anvil.Xif.Engine.exe', sha256: sha(Buffer.from('engine')) }, files }));
    const native = path.join(work, 'ssam-agent.exe'); fs.writeFileSync(native, fakeNative());
    const pack = stageNativePack(source, native, path.join(work, 'staged'));
    assert.deepEqual(pack.files.map(f => f.path).sort(), ['native/ssam-agent.exe', 'xif-engine/Anvil.Xif.Engine.exe', 'xif-engine/Anvil.Xif.Engine.exe.config']);
    assert.equal(pack.xifEngine.sha256, pack.files.find(f => f.path === 'xif-engine/Anvil.Xif.Engine.exe').sha256);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});
