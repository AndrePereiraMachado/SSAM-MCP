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

export function signedRuntime(root) {
  const pointer = path.join(root, '.local', 'signed-runtime', 'selected.json');
  if (!fs.existsSync(pointer)) return null;
  const selection = read(pointer);
  if (selection.schema !== 1 || !/^[a-f0-9]{32}$/.test(selection.id)) throw new Error('signed_runtime_invalid_selection');
  const dir = path.join(path.dirname(pointer), selection.id), manifestPath = path.join(dir, 'verified.json');
  if (hash(manifestPath) !== selection.sha256) throw new Error('signed_runtime_manifest_changed');
  const manifest = read(manifestPath);
  if (manifest.schema !== 1 || !/^v\d+$/.test(manifest.version) || !Array.isArray(manifest.files)) throw new Error('signed_runtime_invalid_manifest');
  const source = fs.readFileSync(path.join(root, 'studio', 'bridge', 'client', 'Program.cs'), 'utf8');
  if (source.match(/const string Version = "(v\d+)"/)?.[1] !== manifest.version) throw new Error('signed_runtime_protocol_changed: prepare and sign the current runtime');
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
