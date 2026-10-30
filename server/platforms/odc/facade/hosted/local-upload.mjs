// The agent alone opens local paths and enforces user-approved roots. The server
// only receives a bounded, content-addressed blob through the existing transport.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256File, insideVisible } from './mirror.mjs';

export const LOCAL_UPLOAD_KIND = 'file.upload';
export const LOCAL_UPLOAD_MAX_BYTES = 64 * 1024 * 1024;
const fail = (code, message) => Object.assign(new Error(message), { code });
export const localUploadEnabled = (context, env = process.env) => env.SSAM_LOCAL_UPLOAD === '1'
  && context.agent?.supports?.(LOCAL_UPLOAD_KIND) === true;
export function localFilePath(value) {
  const file = String(value).replace(/^local:/, '');
  if (!(path.posix.isAbsolute(file) || path.win32.isAbsolute(file)) || /[\x00-\x1f]/.test(file)
    || file.split(/[\\/]/).some(p => p === '..' || p === '.') || /^(?:\\\\|\/\/)/.test(file))
    throw fail('INPUT_INVALID', 'Local upload requires an absolute file path without traversal or network shares.');
  return file;
}
export async function uploadLocalFile(context, value) {
  if (!localUploadEnabled(context)) throw fail('HOSTED_UNAVAILABLE', 'Local upload requires the server flag and an agent advertising file.upload; use agent:inbox instead.');
  const file = localFilePath(value);
  // R2-H (f): the extension rule before the agent is asked, so a path refused here never sends a byte.
  const ext = path.win32.extname(file).toLowerCase();
  if (!/^\.[a-z0-9]{1,12}$/.test(ext)) throw fail('INPUT_INVALID', 'Local upload requires a file extension.');
  const mirror = context.executor?.mirror;
  if (!mirror) throw fail('HOSTED_UNAVAILABLE', 'The agent mirror is unavailable.');
  let reply;
  try { reply = await context.agent.call(LOCAL_UPLOAD_KIND, { path: file, maxBytes: LOCAL_UPLOAD_MAX_BYTES }, { timeoutMs: 120000 }); }
  catch (error) {
    // The agent's own word that nothing was sent (sent:false) reaches the refusal as outcome "not-sent".
    if (error && typeof error === 'object' && error.sent === false) error.outcome = 'not-sent';
    throw error;
  }
  const blob = reply?.blob;
  if (!blob || !/^[a-f0-9]{64}$/.test(blob.sha256 ?? '') || !Number.isSafeInteger(blob.size) || blob.size < 0 || blob.size > LOCAL_UPLOAD_MAX_BYTES)
    throw fail('AGENT_PROTOCOL_VIOLATION', 'Local upload returned invalid blob metadata.');
  const dest = path.join(context.workspace, 'inbox', 'uploads', blob.sha256 + ext);
  if (!insideVisible(context.workspace, dest)) throw fail('PATH_OUTSIDE_WORKSPACE', 'The upload destination is outside the workspace.');
  const temp = dest + '.upload-' + randomUUID();
  try {
    await mirror.receive(blob, temp);
    if (await sha256File(temp) !== blob.sha256 || fs.statSync(temp).size !== blob.size)
      throw fail('AGENT_PROTOCOL_VIOLATION', 'Local upload bytes do not match the blob hash or size.');
    fs.renameSync(temp, dest);
    return dest;
  } finally { try { fs.unlinkSync(temp); } catch { /* already renamed */ } }
}
