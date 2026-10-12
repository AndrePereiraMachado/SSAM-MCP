import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { OdcError } from '../portal/runtime/errors.mjs';

// Root belongs to the loaded bridge, not to the checkout that happens to host
// this MCP client. Keep the bridge's existing file allowlist unchanged.
export async function portalTransportDirectory(call, kind = 'requests') {
  if (!['requests', 'uploads'].includes(kind)) throw new OdcError('INPUT_INVALID', 'Unknown Portal transport directory.');
  let status;
  try { status = await call(['status', 'root']); }
  catch { throw new OdcError('BRIDGE_ROOT_UNAVAILABLE', 'The selected bridge root could not be read; no Portal request was sent.'); }
  if (status?.ok !== true || status.field !== 'root' || typeof status.value !== 'string' || !path.isAbsolute(status.value))
    throw new OdcError('BRIDGE_ROOT_UNAVAILABLE', 'The selected bridge did not identify its absolute root; no Portal request was sent.');
  try {
    const root = fs.realpathSync(status.value);
    if (!fs.statSync(path.join(root, 'studio')).isDirectory() || !fs.statSync(path.join(root, 'README.md')).isFile()) throw new Error('Invalid root');
    let current = root;
    for (const name of ['journal', 'portal', kind]) {
      current = path.join(current, name);
      if (!fs.existsSync(current)) fs.mkdirSync(current);
      const real = fs.realpathSync(current), relative = path.relative(root, real);
      if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.statSync(real).isDirectory()) throw new Error('Escaping directory');
      current = real;
    }
    return current;
  } catch { throw new OdcError('BRIDGE_ROOT_UNAVAILABLE', 'The selected bridge transport directory is unavailable or escapes its root; no Portal request was sent.'); }
}

export async function writePortalRequest(json, call) {
  const dir = await portalTransportDirectory(call);
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${randomUUID()}.json`);
  try { fs.writeFileSync(file, JSON.stringify(json), { flag: 'wx', mode: 0o600 }); }
  catch { throw new OdcError('REQUEST_FILE_UNAVAILABLE', 'The Portal request file could not be created; no Portal request was sent.'); }
  return file;
}
