// Selection of an explicitly verified, signed copy of the existing ODC runtime.
// Windows still enforces its own signature and application-control policy at load time.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function inside(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw new Error('signed_runtime_invalid_path');
  const file = path.resolve(root, relative), rel = path.relative(root, file);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('signed_runtime_invalid_path');
  return file;
}

// U1 (v106/v107): one bridge source is one name per ODC Studio runtime, as client/Program.cs declares them: Version for the
// net10 ODC Studios (1.7.30 on), EarlierVersion for the net8 ones (up to 1.7.29). A source without EarlierVersion names one.
export function declaredBridgeVersions(source) {
  const version = /const string Version = "(v\d+)"/.exec(source ?? '')?.[1] ?? null;
  const earlier = /const string EarlierVersion = "(v\d+)"/.exec(source ?? '')?.[1] ?? null;
  return { 'net10.0': version, 'net8.0': earlier ?? version };
}
// The runtime of the installed ODC Studio, the only one the client attaches to (client/Program.cs: the official install), read
// from its own ODCStudio.runtimeconfig.json; null when it cannot be read (then the bridge of the net10 name, as before).
export function installedOdcStudioRuntime(programFiles = process.env.ProgramFiles ?? 'C:\\Program Files') {
  try {
    const config = fs.readFileSync(path.join(programFiles, 'OutSystems', 'ODC Studio', 'ODC Studio', 'ODCStudio.runtimeconfig.json'), 'utf8');
    return /"tfm"\s*:\s*"(net\d+\.\d+)"/.exec(config)?.[1] ?? null;
  } catch { return null; }
}
// The bridge a local Studio of that runtime loads: its name and the build folder of that runtime (bin/Release/<tfm>).
export function bridgeFor(root, runtime) {
  const versions = declaredBridgeVersions(fs.readFileSync(path.join(root, 'studio', 'bridge', 'client', 'Program.cs'), 'utf8'));
  const tfm = runtime === 'net8.0' ? 'net8.0' : 'net10.0';
  const version = versions[tfm];
  return version ? { version, runtime: tfm, path: path.join(root, 'studio', 'bridge', 'bin', 'Release', tfm, 'ODC3.Bridge.' + version + '.dll') } : null;
}

// runtime (optional): the runtime of the Studio the selection serves; the signed bridge must be the name declared for it.
// Without it, either declared name is accepted (a selection signs one bridge, for one runtime).
export function signedRuntime(root, { runtime } = {}) {
  const pointer = path.join(root, '.local', 'signed-runtime', 'selected.json');
  if (!fs.existsSync(pointer)) return null;
  const selection = read(pointer);
  if (selection.schema !== 1 || !/^[a-f0-9]{32}$/.test(selection.id)) throw new Error('signed_runtime_invalid_selection');
  const dir = path.join(path.dirname(pointer), selection.id), manifestPath = path.join(dir, 'verified.json');
  if (hash(manifestPath) !== selection.sha256) throw new Error('signed_runtime_manifest_changed');
  const manifest = read(manifestPath);
  if (manifest.schema !== 1 || !/^v\d+$/.test(manifest.version) || !Array.isArray(manifest.files)) throw new Error('signed_runtime_invalid_manifest');
  const source = fs.readFileSync(path.join(root, 'studio', 'bridge', 'client', 'Program.cs'), 'utf8');
  const declared = declaredBridgeVersions(source);
  const accepted = runtime ? [declared[runtime === 'net8.0' ? 'net8.0' : 'net10.0']] : [declared['net10.0'], declared['net8.0']];
  if (!accepted.includes(manifest.version)) throw new Error('signed_runtime_protocol_changed: prepare and sign the current runtime');
  const required = ['client/ODC3.Bridge.Client.dll', 'client/ODC3.Bridge.Client.deps.json',
    'client/ODC3.Bridge.Client.runtimeconfig.json', 'client/Microsoft.Diagnostics.NETCore.Client.dll',
    'bridge/ODC3.Bridge.' + manifest.version + '.dll'];
  const seen = new Set();
  for (const entry of manifest.files) {
    if (seen.has(entry.path)) throw new Error('signed_runtime_duplicate_file');
    seen.add(entry.path);
    if (entry.path.endsWith('.dll') && entry.signature !== 'Valid') throw new Error('signed_runtime_signature_not_verified');
    if (hash(inside(dir, entry.path)) !== entry.sha256) throw new Error('signed_runtime_file_changed: ' + entry.path);
  }
  if (required.some(file => !seen.has(file))) throw new Error('signed_runtime_incomplete');
  // Reject extra executable/config files too: the loader must use precisely the verified bundle.
  for (const folder of ['client', 'bridge']) for (const file of fs.readdirSync(path.join(dir, folder))) {
    if (!seen.has(folder + '/' + file)) throw new Error('signed_runtime_unverified_file: ' + file);
  }
  return { client: path.join(dir, 'client', 'ODC3.Bridge.Client.dll'),
    bridge: path.join(dir, 'bridge', 'ODC3.Bridge.' + manifest.version + '.dll'), version: manifest.version };
}

export function bridgeClientError(error) {
  const message = [error.stderr, error.stdout, error.message].filter(Boolean).join('\n');
  if (/0x800711c7|0xc0e90002/i.test(message)) {
    return new Error('odc_application_control_blocked: Windows blocked the ODC runtime. Use a trusted, signed client and bridge; see docs/CONEXAO-ODC-ASSINADA.md. The attach is not confirmed.');
  }
  return new Error(message.trim().split(/\r?\n/).find(Boolean) ?? 'bridge client failed');
}
