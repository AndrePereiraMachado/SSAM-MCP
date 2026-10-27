import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifyPack } from '../src/main/core/pack-sync.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function validateNativeImage(binary, platform, arch = process.arch) {
  if (platform === 'darwin') {
    const cpu = { arm64: 0x0100000c, x64: 0x01000007 }[arch];
    if (!cpu || binary.length < 32 || binary.readUInt32LE(0) !== 0xfeedfacf || binary.readUInt32LE(4) !== cpu || binary.readUInt32LE(12) !== 2)
      throw new Error('Expected a 64-bit Mach-O executable for ' + arch + '.');
    return;
  }
  const pe = binary.length > 64 ? binary.readUInt32LE(0x3c) : -1;
  if (pe < 0 || pe + 264 > binary.length || binary.readUInt32LE(pe) !== 0x4550 || binary.readUInt16LE(pe + 4) !== 0x8664 || binary.readUInt16LE(pe + 24) !== 0x20b || binary.readUInt32LE(pe + 24 + 112 + 14 * 8) !== 0)
    throw new Error('Expected a Windows x64 native executable without a CLR header.');
}
export function stageNativePack(source, executable, destination) {
  const checked = verifyPack(source);
  if (!checked.ok) throw new Error('Source pack integrity failed: ' + checked.detail);
  if (fs.existsSync(destination)) throw new Error('Native staging destination must be a new directory.');
  const binary = fs.readFileSync(executable);
  const mac = checked.pack.platform === 'darwin';
  if (mac && process.platform !== 'darwin') throw new Error('Stage and qualify a macOS native pack on its target Mac.');
  if (mac && checked.pack.o11Hook === 'h1') throw new Error('The release h1 hook is not qualified on macOS.');
  validateNativeImage(binary, mac ? 'darwin' : 'win32');
  fs.mkdirSync(destination, { recursive: true });
  const files = [];
  const add = (relative, bytes) => {
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
    files.push({ path: relative, size: bytes.length, sha256: hash(bytes) });
  };
  for (const file of checked.pack.files) {
    const relative = String(file.path).replaceAll('\\', '/');
    // Explicit binary/runtime metadata roots. Source, launch scripts, symbols,
    // captured data and tool trees cannot enter the installed native pack.
    if (!/^(?:odc\/studio\/bridge\/|bin\/o11\/|studio\/o11\/)/.test(relative) || !/\.(?:dll|exe|json)$/i.test(relative)) continue;
    add(relative, fs.readFileSync(path.join(source, relative)));
  }
  for (const relative of ['release.json', 'release.sig.jws']) if (fs.existsSync(path.join(source, relative))) add(relative, fs.readFileSync(path.join(source, relative)));
  const nativePath = 'native/ssam-agent' + (mac ? '' : '.exe');
  add(nativePath, binary);
  if (mac) fs.chmodSync(path.join(destination, nativePath), 0o755);
  const pack = { ...checked.pack, id: checked.pack.id + '-native-' + hash(binary).slice(0, 12), nativeCore: { runtime: 'native-aot', path: nativePath, protocol: 'ssam-agent/1', ...(mac ? { arch: process.arch, macOSValidated: false } : {}) }, files };
  if (pack.lanes?.includes('odc')) {
    if (!/^v\d+$/.test(pack.odcBridge) || Number(pack.odcBridge.slice(1)) < 98) throw new Error('Native ODC packs require bridge v98 or newer.');
    for (const relative of [`odc/studio/bridge/bin/Release/net8.0/ODC3.Bridge.${pack.odcBridge}.dll`, ...(!mac ? ['odc/studio/bridge/client/bin/Release/net10.0/ODC3.Bridge.Client.dll'] : [])])
      if (!files.some(f => f.path === relative)) throw new Error('Missing ODC runtime binary: ' + relative);
  }
  if (pack.lanes?.includes('o11')) {
    const required = [...(!mac ? ['bin/o11/connect/Anvil.Connect.dll'] : []), ...(pack.o11Hook === 'h1'
      ? ['studio/o11/hook/Anvil.Hook.h1.dll', 'studio/o11/bridge/b1/Anvil.Bridge.dll', 'release.json', 'release.sig.jws']
      : ['bin/o11/hook/Anvil.RuntimeHook.Agent.dll', 'bin/o11/bridge/Anvil.Bridge.dll'])];
    for (const relative of required) if (!files.some(f => f.path === relative)) throw new Error('Missing O11 runtime binary: ' + relative);
  }
  fs.writeFileSync(path.join(destination, 'pack.json'), JSON.stringify(pack, null, 2) + '\n');
  return pack;
}
