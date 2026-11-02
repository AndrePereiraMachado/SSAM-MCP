// The O11 thin bridges of one agent pack, one per Service Studio version (pack.json o11Builds, agent 0.3.7 / 0.4.4-native).
// A Service Studio bridge binds to the exact ServiceStudio.* assembly versions it was compiled against (11.55.94.65328
// is not 11.55.93.65289), so one pack carries a bridge per served Studio and the agent picks the one of the Studio the
// customer actually has: in the hello (pack.o11BuiltFor, what the server's AGENT_PACK_MISMATCH rule compares) and when it
// connects (the bridge file the hook loads and the sha256 of the version handshake).
//   o11Builds: [{ version: '11.55.94', runtime: 'net10.0', path: 'bin/o11/bridge/Anvil.Bridge.dll', sha256 }, ...]
// The first entry is the pack's default (o11BuiltFor and o11Bridge name it too), so an older agent reading only those
// fields keeps working with the default bridge. A pack without o11Builds is the one-bridge pack of before.
import path from 'node:path';

const VERSION = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;
// The bundled O11 bridges live under bin/o11/ (the dev hook layout); nothing else is ever loaded from a pack build.
const BRIDGE_PATH = /^bin\/o11\/(?:bridge|bridges\/\d+\.\d+\.\d+)\/Anvil\.Bridge\.dll$/;
export const DEFAULT_O11_BRIDGE = 'bin/o11/bridge/Anvil.Bridge.dll';
export const three = value => /^(\d+\.\d+\.\d+)(?:\.|$)/.exec(String(value ?? ''))?.[1] ?? null;

// The valid builds of the pack, in pack order. An entry whose file is not in the integrity list with the same sha256, whose
// path is outside bin/o11/, or that repeats a version is dropped: the agent never loads a bridge the pack does not list.
export function o11Builds(pack) {
  const listed = new Map((Array.isArray(pack?.files) ? pack.files : []).map(f => [String(f?.path ?? '').replaceAll('\\', '/'), f?.sha256]));
  const seen = new Set();
  const out = [];
  for (const build of Array.isArray(pack?.o11Builds) ? pack.o11Builds : []) {
    const version = String(build?.version ?? ''), file = String(build?.path ?? ''), sha256 = String(build?.sha256 ?? '');
    if (!VERSION.test(version) || !BRIDGE_PATH.test(file) || !SHA256.test(sha256) || seen.has(version)) continue;
    if (listed.size && listed.get(file) !== sha256) continue;
    seen.add(version);
    out.push({ version, path: file, sha256, ...(typeof build.runtime === 'string' ? { runtime: build.runtime } : {}) });
  }
  return out;
}

// The build for this Service Studio (three-part version), or null.
export function o11BuildFor(pack, studioVersion) {
  const wanted = three(studioVersion);
  return wanted ? o11Builds(pack).find(b => b.version === wanted) ?? null : null;
}

// The pack as this Service Studio sees it: o11BuiltFor, o11Runtime and o11Bridge {path, sha256} of its build. The pack is
// returned unchanged when it has no build for that version (the one-bridge rule of before decides then).
export function o11PackFor(pack, studioVersion) {
  const build = o11BuildFor(pack, studioVersion);
  if (!build || pack?.o11Hook === 'h1') return pack;
  return { ...pack, o11BuiltFor: build.version, ...(build.runtime ? { o11Runtime: build.runtime } : {}),
    o11Bridge: { ...(pack.o11Bridge ?? {}), path: build.path, sha256: build.sha256 } };
}

// The Service Studio versions the pack has a bridge for (the hello lists them as pack.o11Builds).
export const o11BuildVersions = pack => o11Builds(pack).map(b => b.version);

// The bridge file of the dev hook under the runtime root: the build's path, or the default one.
export function o11BridgeFile(runtimeRoot, pack) {
  const relative = BRIDGE_PATH.test(String(pack?.o11Bridge?.path ?? '')) ? pack.o11Bridge.path : DEFAULT_O11_BRIDGE;
  return path.join(runtimeRoot, ...relative.split('/'));
}
