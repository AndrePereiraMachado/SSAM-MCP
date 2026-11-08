// The verification of a downloaded Windows update (app 0.2.8), without Electron: the signed statement of its installer from the
// feed (update-signature.mjs), the bytes on disk, then the installer's own version resource (readInstaller, given by
// electron/updates.mjs). Returns null (it may be installed) or {code, message}.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { installerVersionProblem } from './update-model.mjs';
import { UPDATE_CODES, STATEMENT_MAX_BYTES, installerName, statementUrl, updateStatementProblem } from './update-signature.mjs';
import { UPDATE_PUBLIC_KEY } from './update-trust.mjs';

// The sha512 (base64, as latest.yml writes it) and the size of a downloaded file, read from the file itself.
export async function measureFile(file) {
  const hash = createHash('sha512'); let size = 0;
  for await (const chunk of fs.createReadStream(file)) { hash.update(chunk); size += chunk.length; }
  return { sha512: hash.digest('base64'), size };
}

// The text of a signed statement from the feed, or null when there is none (any status but 200, an empty or oversized body,
// a network failure). The signature, not the transport, decides; the size cap keeps a hostile server from filling memory.
export async function fetchStatementText(url, { fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
  let response;
  try { response = await fetchImpl(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) }); } catch { return null; }
  if (response.status !== 200 || !response.body) { await response.body?.cancel?.().catch(() => {}); return null; }
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > STATEMENT_MAX_BYTES) { await response.body.cancel?.().catch(() => {}); return null; }
  const chunks = []; let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > STATEMENT_MAX_BYTES) { await response.body.cancel?.().catch(() => {}); return null; }
      chunks.push(Buffer.from(chunk));
    }
  } catch { return null; }
  return size ? Buffer.concat(chunks).toString('utf8') : null;
}

// Whether a downloaded Windows update may be installed (null) or why not ({code, message}): the signed statement of its
// installer, fetched from the feed, checked against the pinned key and the bytes on disk; then the installer's own version.
export async function verifyWindowsUpdate({ info, feed, currentVersion, publicKey = UPDATE_PUBLIC_KEY, fetchText = fetchStatementText, measure = measureFile, readInstaller = () => ({}) }) {
  const installer = (info?.files ?? []).map(f => installerName(f?.url)).find(Boolean);
  const text = installer && String(publicKey ?? '').trim() ? await fetchText(statementUrl(feed, installer)) : null;
  let downloaded = null;
  try { downloaded = info?.downloadedFile ? await measure(info.downloadedFile) : null; } catch { downloaded = null; }
  const signed = updateStatementProblem({ text, publicKey, info, downloaded, current: currentVersion });
  if (signed) return signed;
  const problem = installerVersionProblem({ ...readInstaller(info?.downloadedFile), label: info?.version, current: currentVersion });
  return problem ? { code: UPDATE_CODES.INSTALLER_MISMATCH, message: UPDATE_CODES.INSTALLER_MISMATCH + ': ' + problem } : null;
}
