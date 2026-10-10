// Files between the server and the agent (docs/FASE2-AGENTE.md 2.6): parts of at most 4 MiB, each with its sha256, and
// the sha256 and size of the whole file. Parts are sequential; a failed part is asked again up to 3 times. A download
// is written to a temporary file next to the destination and renamed only after the whole file matched.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { AgentError, refuse } from './errors.mjs';

export const PART_BYTES = 4 * 1024 * 1024;
export const MAX_FILE_BYTES = 512 * 1024 * 1024;
export const RETRIES = 3;
export const TEMP_SUFFIX = '.ssam-tmp';

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export const newTransfer = () => randomBytes(16).toString('hex');

export async function fileSha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

// BlobRef = {transfer, sha256, size, parts, partBytes}.
export function validateRef(ref, { partBytes = PART_BYTES, maxFileBytes = MAX_FILE_BYTES } = {}) {
  const valid = ref && typeof ref === 'object' && /^[0-9a-f]{32}$/.test(ref.transfer ?? '') && /^[0-9a-f]{64}$/.test(ref.sha256 ?? '')
    && Number.isSafeInteger(ref.size) && ref.size >= 0 && Number.isSafeInteger(ref.partBytes) && ref.partBytes > 0 && ref.partBytes <= partBytes
    && (ref.parts === Math.ceil(ref.size / ref.partBytes) || (ref.size === 0 && ref.parts === 1));
  if (!valid) throw refuse('TRANSFER_INVALID', 'Malformed file reference from the server');
  if (ref.size > maxFileBytes) throw refuse('FILE_TOO_LARGE', `The file has ${ref.size} bytes, above ${maxFileBytes}`);
  return ref;
}

// Uploads a file (path) or a Buffer. put(transfer, index, body, headers) -> HTTP status. Returns the BlobRef the
// result carries; the server checks each part on arrival and the whole file when it assembles it.
export async function uploadBlob(source, { put, partBytes = PART_BYTES, retries = RETRIES, sleep = delay } = {}) {
  const isBuffer = Buffer.isBuffer(source);
  const size = isBuffer ? source.length : fs.statSync(source).size;
  const total = isBuffer ? sha256(source) : await fileSha256(source);
  const parts = Math.max(1, Math.ceil(size / partBytes));
  const transfer = newTransfer();
  const fd = isBuffer ? null : fs.openSync(source, 'r');
  try {
    for (let index = 0; index < parts; index++) {
      const length = Math.min(partBytes, size - index * partBytes);
      let body;
      if (isBuffer) body = source.subarray(index * partBytes, index * partBytes + length);
      else { body = Buffer.alloc(length); fs.readSync(fd, body, 0, length, index * partBytes); }
      const headers = { 'content-type': 'application/octet-stream', 'x-ssam-part-sha256': sha256(body),
        'x-ssam-total-sha256': total, 'x-ssam-total-size': String(size), 'x-ssam-parts': String(parts) };
      for (let attempt = 0; ; attempt++) {
        let status = 0; let failure = null;
        try { status = await put(transfer, index, body, headers); } catch (error) { failure = error; }
        if (status === 204 || status === 200) break;
        // A credential, conflict or size refusal does not get better by asking again.
        if ([401, 403, 409, 413].includes(status) || attempt >= retries)
          throw new AgentError('BLOB_TRANSFER_FAILED', `Part ${index} of a file for the server failed (${status || failure?.message || 'no answer'})`, { executed: null });
        await sleep(250 * (attempt + 1));
      }
    }
  } finally { if (fd !== null) fs.closeSync(fd); }
  return { transfer, sha256: total, size, parts, partBytes };
}

// Downloads a BlobRef to dest. get(transfer, index) -> {status, body: Buffer, partSha}. Each part is checked against
// its own sha256 (asked again up to `retries` times); the whole file against ref.sha256 and ref.size before the rename.
export async function downloadBlob(ref, dest, { get, limits = {}, retries = RETRIES, sleep = delay } = {}) {
  validateRef(ref, limits);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const temp = path.join(path.dirname(dest), '.' + path.basename(dest) + '.' + randomBytes(6).toString('hex') + TEMP_SUFFIX);
  const total = createHash('sha256');
  let size = 0; let fd = fs.openSync(temp, 'wx');
  try {
    for (let index = 0; index < ref.parts; index++) {
      let body = null; let last = '';
      for (let attempt = 0; ; attempt++) {
        let reply = null;
        try { reply = await get(ref.transfer, index); } catch (error) { last = error.message; }
        if (reply?.status === 200 && reply.body.length <= ref.partBytes && sha256(reply.body) === String(reply.partSha ?? '').toLowerCase()) { body = reply.body; break; }
        if (reply) last = reply.status === 200 ? 'part sha256 mismatch' : 'HTTP ' + reply.status;
        if ([401, 403, 404].includes(reply?.status) || attempt >= retries)
          throw new AgentError(last === 'part sha256 mismatch' ? 'BLOB_HASH_MISMATCH' : 'BLOB_TRANSFER_FAILED',
            `Part ${index} of a file from the server failed (${last}); nothing was written`, { executed: false });
        await sleep(250 * (attempt + 1));
      }
      fs.writeSync(fd, body); total.update(body); size += body.length;
    }
    fs.closeSync(fd); fd = null;
    if (size !== ref.size || total.digest('hex') !== ref.sha256)
      throw new AgentError('BLOB_HASH_MISMATCH', 'The file assembled from the server does not match its sha256; nothing was written', { executed: false });
    fs.renameSync(temp, dest);
    return { sha256: ref.sha256, size };
  } catch (error) {
    if (fd !== null) fs.closeSync(fd);
    fs.rmSync(temp, { force: true });
    throw error;
  }
}
