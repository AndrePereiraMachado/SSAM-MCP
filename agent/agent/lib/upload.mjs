// file.upload (docs/FASE2-AGENTE.md 4.4): one file of this machine, inside a folder the person approved, sent to the server
// with the blob transport. params {path, maxBytes}; the limit is min(maxBytes, 64 MiB, welcome.maxFileBytes). Every check
// runs before a byte is read, in this order:
//   1. parameters (PARAMS_INVALID), and the call's deadline (AGENT_TIMEOUT);
//   2. the path grammar of local-paths.mjs and an extension ^\.[a-z0-9]{1,12}$ (PATH_FORBIDDEN);
//   3. credential and key files, and the agent's own data and runtime folders (PATH_FORBIDDEN);
//   4. inside an approved folder, compared as text (UPLOAD_ROOT_NOT_APPROVED);
//   5. the file opened once; the handle must be a regular file with one link (a folder or a hard link: PATH_FORBIDDEN),
//      the real path inside the approved folder's real path of now (a link, a junction or a network share: PATH_LEAVES_ROOT),
//      the real path the same file as the handle (PATH_CHANGED) and the size within the limit (FILE_TOO_LARGE);
//   6. read once through that handle into memory, to its end (another size: FILE_CHANGED), and hashed.
// The bytes sent are exactly the bytes hashed. The answer is exactly {blob: {transfer, sha256, size, parts, partBytes}},
// after the last part was taken by the server. Errors never name a link target nor the approved folders. Nothing on this
// machine changes (executed: false); sent says whether a part may have reached the server. Each upload is recorded in
// private/uploads.jsonl {at, root (its index), relative, size, sha256} (the last 1000 lines), for the person only; the
// agent log has no paths. At most 2 uploads at a time. The same rules are native/Ssam.Agent/UploadKinds.cs.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AgentError, refuse } from './errors.mjs';
import { parseLocalPath, insidePath, insideExact, samePath, networkPath, flavor, EXTENSION } from './local-paths.mjs';
import { readRoots, fileIdentity } from './upload-roots.mjs';

export const UPLOAD_KIND = 'file.upload';
export const UPLOAD_MAX_BYTES = 64 * 1024 * 1024;
export const UPLOAD_PARALLEL = 2;
export const AUDIT_LINES = 1000;
export const CREDENTIAL_SEGMENTS = Object.freeze(['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.git']);
export const CREDENTIAL_NAME = /^(?:id_rsa.*|id_ed25519.*|.*\.(?:pem|key|pfx|p12|ppk|kdbx)|\.env|\.env\..*|\.npmrc|\.netrc|credential.*)$/i;
export const auditFile = dataRoot => path.join(dataRoot, 'private', 'uploads.jsonl');

const notSent = (code, message) => new AgentError(code, message, { executed: false, sent: false });
const defaultFiles = {
  open: file => fs.promises.open(file, 'r'),
  realpath: file => fs.realpathSync.native(file),
  stat: file => fs.statSync(file, { bigint: true }),
};

// {file, limit} of valid parameters, or PARAMS_INVALID.
export function uploadParams(params, maxFileBytes) {
  if (typeof params?.path !== 'string') throw notSent('PARAMS_INVALID', 'path must be a string');
  const max = params.maxBytes;
  if (!Number.isSafeInteger(max) || max < 1 || max > UPLOAD_MAX_BYTES) throw notSent('PARAMS_INVALID', `maxBytes must be an integer from 1 to ${UPLOAD_MAX_BYTES}`);
  const welcome = Number.isSafeInteger(maxFileBytes) && maxFileBytes > 0 ? maxFileBytes : UPLOAD_MAX_BYTES;
  return { file: params.path, limit: Math.min(max, UPLOAD_MAX_BYTES, welcome) };
}

// The lexical checks of steps 2 and 3: {segments, normalized} or PATH_FORBIDDEN.
export function uploadPath(file, { platform, dataRoot, runtimeRoot }) {
  let parsed;
  try { parsed = parseLocalPath(file, { platform }); } catch (error) { throw notSent(error.code, error.message); }
  const shown = JSON.stringify(parsed.normalized);
  nameRefusal(parsed.segments, shown, platform);
  const p = flavor(platform);
  for (const folder of [dataRoot, runtimeRoot].filter(Boolean))
    if (insidePath(parsed.normalized, p.resolve(folder), platform)) throw notSent('PATH_FORBIDDEN', `${shown} is inside the SSAM agent folder; the agent never uploads its own files`);
  return parsed;
}

// The name rules of step 3 over path segments: the extension of the last one, credential folders in any of them,
// credential and key names in the last one. Run on the path as asked AND on the real path of the opened file below the
// approved folder's real path (long names: an 8.3 short name or a link inside the folder cannot hide .env, .git ...).
export function nameRefusal(segments, shown, platform) {
  const name = segments.at(-1) ?? '';
  if (!EXTENSION.test(flavor(platform).extname(name).toLowerCase()))
    throw notSent('PATH_FORBIDDEN', `${shown} has no file extension of 1 to 12 letters or digits; only such files are uploaded`);
  if (segments.some(segment => CREDENTIAL_SEGMENTS.includes(segment.toLowerCase())) || CREDENTIAL_NAME.test(name))
    throw notSent('PATH_FORBIDDEN', `${shown} is a credential or key file; the agent never uploads those`);
}

// The approved root that holds the path (as text, by its approved or its real path): {index, root, relative}.
export function approvedRoot(normalized, roots, platform) {
  const advice = 'Approve the folder on this computer first: SSAM Agent > Folders SSAM may read, or `ssam-agent roots add --folder <folder>`.';
  if (roots.length === 0) throw notSent('UPLOAD_ROOT_NOT_APPROVED', `No folder is approved for uploads on this computer. ${advice}`);
  const p = flavor(platform);
  for (const [index, root] of roots.entries()) {
    for (const base of [root.path, root.real]) {
      if (insidePath(normalized, base, platform) && !samePath(normalized, base, platform))
        return { index, root, relative: p.relative(base, normalized).split(p.sep).join('/') };
    }
  }
  throw notSent('UPLOAD_ROOT_NOT_APPROVED', `${JSON.stringify(normalized)} is not inside a folder approved for uploads. ${advice}`);
}

const openError = (error, shown) => {
  if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return notSent('FILE_NOT_FOUND', `${shown} does not exist`);
  if (error?.code === 'EISDIR') return notSent('PATH_FORBIDDEN', `${shown} is a folder; only files are uploaded`);
  if (error?.code === 'EBUSY') return notSent('FILE_LOCKED', `${shown} is locked by another program; close it in the other program and try again`);
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return notSent('PATH_FORBIDDEN', `${shown} cannot be opened by this user`);
  return notSent('FILE_LOCKED', `${shown} could not be opened (${error?.code ?? 'error'})`);
};

// Steps 1 to 6 without the transport: {bytes, sha256, size, index, relative}. deadline: local epoch ms or null.
// hooks (tests): beforeOpen(), afterOpen() between the checks.
export async function prepareUpload(params, { dataRoot, runtimeRoot = dataRoot, platform = process.platform, maxFileBytes, deadline = null, now = Date.now,
  files = defaultFiles, hooks = {} } = {}) {
  const { file, limit } = uploadParams(params, maxFileBytes);
  const late = () => deadline !== null && now() >= deadline;
  if (late()) throw notSent('AGENT_TIMEOUT', 'The deadline of the call passed before the file was read; nothing was sent');
  const parsed = uploadPath(file, { platform, dataRoot, runtimeRoot });
  const shown = JSON.stringify(parsed.normalized);
  const { index, root, relative } = approvedRoot(parsed.normalized, readRoots(dataRoot), platform);
  let rootReal;
  try { rootReal = files.realpath(root.path); } catch { throw notSent('UPLOAD_ROOT_NOT_APPROVED', 'The approved folder that holds this path no longer exists; approve it again'); }
  // The approved folder must still be the same folder: its current real path is the recorded one exactly (no link or
  // junction now on the way), that folder is not itself a link or junction, and it has the file identity (volume and file
  // id) recorded when it was approved (a root recorded before 0.3.4's identity keeps the exact path rule).
  let sameRoot = false;
  try {
    const lstat = (files.lstat ?? (file => fs.lstatSync(file)))(root.real);
    sameRoot = rootReal === root.real && !lstat.isSymbolicLink() && (root.id === null || root.id === undefined || fileIdentity(files.stat(root.real)) === root.id);
  } catch { sameRoot = false; }
  if (!sameRoot || networkPath(rootReal, platform))
    throw notSent('PATH_LEAVES_ROOT', 'The approved folder that holds this path now leads to another place through a link or junction; approve it again');
  await hooks.beforeOpen?.();
  let handle;
  try { handle = await files.open(parsed.normalized); } catch (error) { throw openError(error, shown); }
  try {
    const stat = await handle.stat({ bigint: true });
    await hooks.afterOpen?.();
    if (stat.isDirectory()) throw notSent('PATH_FORBIDDEN', `${shown} is a folder; only files are uploaded`);
    if (!stat.isFile()) throw notSent('PATH_FORBIDDEN', `${shown} is not a regular file`);
    if (stat.nlink > 1n) throw notSent('PATH_FORBIDDEN', `${shown} is a hard link (the same file has other names); the agent does not upload hard links`);
    let real;
    try { real = files.realpath(parsed.normalized); } catch { throw notSent('PATH_CHANGED', `${shown} changed while it was being checked; nothing was sent`); }
    // Containment of the real path in the approved folder's real path is EXACT (ordinal, with case): both come from the
    // system's final path, spelled as on the disk, and no case table may decide (NTFS keeps folders apart that any table
    // folds together).
    if (networkPath(real, platform) || !insideExact(real, rootReal, platform) || real.length <= rootReal.replace(/[\\/]+$/, '').length + 1)
      throw notSent('PATH_LEAVES_ROOT', `${shown} leaves the approved folder through a link or junction`);
    // The same name rules on the real path, component by component below the approved folder, and the agent's folders by
    // their real paths.
    const p = flavor(platform);
    nameRefusal(real.slice(rootReal.replace(/[\\/]+$/, '').length).split(/[\\/]/).filter(Boolean), shown, platform);
    for (const folder of [dataRoot, runtimeRoot].filter(Boolean)) {
      let agentReal = null;
      try { agentReal = files.realpath(p.resolve(folder)); } catch { agentReal = null; }
      if (agentReal && insidePath(real, agentReal, platform)) throw notSent('PATH_FORBIDDEN', `${shown} is inside the SSAM agent folder; the agent never uploads its own files`);
    }
    let named;
    try { named = files.stat(real); } catch { throw notSent('PATH_CHANGED', `${shown} changed while it was being checked; nothing was sent`); }
    if (named.dev !== stat.dev || named.ino !== stat.ino) throw notSent('PATH_CHANGED', `${shown} changed while it was being checked; nothing was sent`);
    if (stat.size > BigInt(limit)) throw notSent('FILE_TOO_LARGE', `${shown} has ${stat.size} bytes, above the limit of ${limit}; nothing was read`);
    if (late()) throw notSent('AGENT_TIMEOUT', 'The deadline of the call passed before the file was read; nothing was sent');
    const size = Number(stat.size);
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(bytes, offset, size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, size);
    if (offset !== size || extra.bytesRead !== 0) throw notSent('FILE_CHANGED', `${shown} changed size while it was being read; nothing was sent`);
    return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), size, index, relative };
  } finally { await handle.close().catch(() => {}); }
}

// The person's own record of what was sent, the last AUDIT_LINES lines; never a reason to fail an upload.
export function recordUpload(dataRoot, entry, { now = Date.now } = {}) {
  const file = auditFile(dataRoot);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ at: new Date(now()).toISOString(), ...entry }) + '\n');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    if (lines.length > AUDIT_LINES) {
      const temporary = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(temporary, lines.slice(-AUDIT_LINES).join('\n') + '\n');
      fs.renameSync(temporary, file);
    }
  } catch { /* the record is the person's convenience */ }
}

// The kind: at most UPLOAD_PARALLEL at a time (a waiting call keeps its deadline), then prepare, send and record.
// blobs.upload(buffer, {beforePart}) is the agent's transport (blobs.mjs uploadBlob).
export function createUploads({ dataRoot, runtimeRoot = dataRoot, platform = process.platform, blobs, limits = () => ({}), now = Date.now, files, hooks } = {}) {
  let active = 0;
  const waiting = [];
  const release = () => { active--; const next = waiting.shift(); if (next) next(); };
  function acquire(deadline) {
    if (active < UPLOAD_PARALLEL) { active++; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      let timer = null;
      const start = () => { if (timer) clearTimeout(timer); active++; resolve(); };
      waiting.push(start);
      if (deadline !== null) timer = setTimeout(() => {
        const at = waiting.indexOf(start);
        if (at >= 0) waiting.splice(at, 1);
        reject(notSent('AGENT_TIMEOUT', 'The deadline of the call passed while two other uploads were running; nothing was sent'));
      }, Math.max(0, deadline - now()));
    });
  }
  async function upload(params, { deadline = null } = {}) {
    if (!blobs) throw notSent('BLOB_TRANSFER_FAILED', 'No channel for files');
    await acquire(deadline);
    try {
      const prepared = await prepareUpload(params, { dataRoot, runtimeRoot, platform, maxFileBytes: limits().maxFileBytes, deadline, now, files, hooks });
      let blob;
      try {
        blob = await blobs.upload(prepared.bytes, { beforePart: index => {
          if (deadline !== null && now() >= deadline)
            throw new AgentError('AGENT_TIMEOUT', `The deadline of the call passed after ${index} of the file's parts; the server keeps nothing of it`, { executed: false, sent: index === 0 ? false : null });
        } });
      } catch (error) {
        if (error instanceof AgentError && error.code === 'AGENT_TIMEOUT') throw error;
        throw new AgentError('BLOB_TRANSFER_FAILED', 'The file could not be sent to the server: ' + String(error?.message ?? error).slice(0, 300), { executed: false, sent: null });
      }
      recordUpload(dataRoot, { root: prepared.index, relative: prepared.relative, size: prepared.size, sha256: prepared.sha256 }, { now });
      return { blob: { transfer: blob.transfer, sha256: blob.sha256, size: blob.size, parts: blob.parts, partBytes: blob.partBytes } };
    } finally { release(); }
  }
  return { upload };
}
