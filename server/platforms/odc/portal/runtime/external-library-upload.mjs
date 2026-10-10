// The two uploaders of an External Library package (odc_external_library deploy, external-library.mjs). Each does the
// same three steps of the public contract, external-library-generation-api-v1, as one write:
//   GET /uploads (the presigned uploadUrl and downloadUrl), PUT of the zip to uploadUrl WITHOUT any Authorization
//   (the URL carries its own signature), POST /generation-operations {fileName, highCodeBinaryUri: downloadUrl}.
// Both answer {ok:true, operationKey, bytes, sha256, fileName} or a refusal with its state, never a URL: the URLs live
// only inside the step that uses them (the bridge, or this process for the vault path) and are never logged.
//   bridgeUploader: the ODC Studio session, bridge verb portal-upload (capability portal-upload, PortalUpload.cs).
//   vaultUploader: the API Client stored in the Windows vault (an OdcBridge of the tenant: its OAuth client and fetch).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const GENERATION_BASE = '/api/external-libraries/v1';
export const UPLOAD_TIMEOUT_MS = 600000;
const sha256Of = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const refusal = (state, code, message, extra = {}) => ({ ok: false, state, code, error: { code, message }, ...extra });

// A presigned target: absolute https on the default port, no user info, no fragment. The URL itself is never echoed.
export function checkTarget(value, field) {
  let url;
  try { url = new URL(value); } catch { return refusal('not-sent', 'PORTAL_CONTRACT_CHANGED', 'The upload schema has no absolute ' + field + '; nothing was sent.'); }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password || url.hash)
    return refusal('not-sent', 'UPLOAD_TARGET_REFUSED', 'The ' + field + ' of the upload schema is not a plain https URL (port, user info or fragment); nothing was sent.');
  return { ok: true, url };
}

// The bridge's answer to portal-upload, as an uploader answer. A refusal the bridge gave before the generation POST
// leaves the tenant unchanged (not-sent); UNCERTAIN, a lost pipe and a repeated UUID (retry_refused) may have created
// the generation job and are reconciled by reading the jobs by file name.
export function bridgeAnswer(answer) {
  if (answer?.ok === true && typeof answer.operationKey === 'string' && answer.operationKey)
    return { ok: true, operationKey: answer.operationKey, bytes: answer.bytes ?? null, sha256: answer.sha256 ?? null, fileName: answer.fileName ?? null, auth: 'studio' };
  if (answer?.outcome === 'gate_refused') return refusal('not-sent', 'STUDIO_BUSY', 'The Studio was busy; nothing was sent.');
  if (answer?.code === 'UNCERTAIN' || answer?.gate === 'retry_refused')
    return refusal('uncertain', 'UNCERTAIN', 'The upload may have created its generation job; it is never resent. The same call reconciles it by reading the jobs by file name.');
  if (answer?.code === 'REMOTE_ERROR' && typeof answer.status === 'number')
    return refusal('rejected', 'GENERATION_REFUSED', 'The server refused the generation request (' + answer.status + '); nothing was generated.', { status: answer.status });
  const code = typeof answer?.code === 'string' ? answer.code : 'UPLOAD_FAILED';
  return refusal('not-sent', code, (typeof answer?.message === 'string' ? answer.message : 'The bridge refused the upload.') + ' Nothing was generated.', answer?.gate ? { gate: answer.gate } : {});
}

// stage(file, fileName) copies the package into journal\portal\uploads (the only place the bridge reads it from) and
// returns its path; requestFile(json) writes the request under journal\portal\requests.
export function bridgeUploader({ studio, requestFile, stage }) {
  return {
    kind: 'studio',
    async upload({ host, file, sha256, fileName, operationUuid, authorizeSha256, confirmTenant }) {
      const staged = stage(file, fileName);
      const request = requestFile({ file: staged, sha256, fileName, operationUuid, authorizeSha256, confirmTenant: confirmTenant ?? host });
      let answer;
      try { answer = await studio.call(['portal-upload', request, '--tenant', host]); }
      catch { return refusal('uncertain', 'UNCERTAIN', 'The bridge did not answer portal-upload; the job may exist. It is never resent: the same call reconciles it by reading the jobs by file name.'); }
      return bridgeAnswer(answer);
    },
  };
}

// The vault path: the tenant's OdcBridge (its OAuth client from the API Client in the vault, its fetch). The PUT is a
// plain fetch with no Authorization header and no redirect followed.
export function vaultUploader({ bridge, fetchImpl, readFile = fs.readFileSync, timeoutMs = UPLOAD_TIMEOUT_MS }) {
  const send = fetchImpl ?? bridge?.fetch ?? globalThis.fetch;
  return {
    kind: 'vault',
    async upload({ host, file, sha256, fileName }) {
      const origin = 'https://' + host;
      if (bridge?.config?.origin !== origin) return refusal('not-sent', 'HOST_MISMATCH', 'The vault API Client belongs to another tenant; nothing was sent.');
      const bytes = readFile(file);
      if (sha256Of(bytes) !== String(sha256).toLowerCase()) return refusal('not-sent', 'PACKAGE_CHANGED', 'The package changed after it was built; build it again. Nothing was sent.');
      let token;
      try { token = await bridge.auth.getToken(); }
      catch (error) { return refusal('not-sent', error.code ?? 'AUTH_FAILED', 'The vault API Client could not sign in; nothing was sent.'); }
      // 1. The upload schema.
      let schema;
      try {
        const response = await send(origin + GENERATION_BASE + '/uploads', { method: 'GET', redirect: 'manual', headers: { accept: 'application/json', authorization: 'Bearer ' + token },
          signal: AbortSignal.timeout(60000) });
        if (response.status !== 200) return refusal('not-sent', 'REMOTE_ERROR', 'GET /uploads answered ' + response.status + '; nothing was sent.', { status: response.status });
        schema = await response.json();
      } catch { return refusal('not-sent', 'REMOTE_ERROR', 'GET /uploads did not answer; nothing was sent.'); }
      const put = checkTarget(schema?.uploadUrl, 'uploadUrl');
      if (!put.ok) return put;
      const download = checkTarget(schema?.downloadUrl, 'downloadUrl');
      if (!download.ok) return download;
      // 2. The package, outside any authenticated client.
      try {
        const response = await send(put.url.href, { method: 'PUT', redirect: 'manual', headers: { 'content-type': 'application/zip' }, body: bytes, signal: AbortSignal.timeout(timeoutMs) });
        if (response.status < 200 || response.status >= 300)
          return refusal('not-sent', 'UPLOAD_REJECTED', 'The upload target answered ' + response.status + (response.status >= 300 && response.status < 400 ? ' (a redirect is never followed)' : '') + '; the generation was not requested.', { status: response.status });
      } catch (error) { return refusal('not-sent', 'UPLOAD_FAILED', 'The upload of the package did not complete (' + (error?.name ?? 'error') + '); the generation was not requested.'); }
      // 3. The generation operation, the one write to the tenant.
      let response;
      try {
        response = await send(origin + GENERATION_BASE + '/generation-operations', { method: 'POST', redirect: 'manual',
          headers: { accept: 'application/json', 'content-type': 'application/json', authorization: 'Bearer ' + token },
          body: JSON.stringify({ fileName, highCodeBinaryUri: download.url.href }), signal: AbortSignal.timeout(60000) });
      } catch { return refusal('uncertain', 'UNCERTAIN', 'The generation request got no answer; the job may exist. It is never resent: the same call reconciles it by reading the jobs by file name.'); }
      if (response.status >= 500 || (response.status >= 300 && response.status < 400))
        return refusal('uncertain', 'UNCERTAIN', 'The server answered ' + response.status + ' to the generation request; the job may exist and is reconciled by file name.', { status: response.status });
      if (response.status >= 400) return refusal('rejected', 'GENERATION_REFUSED', 'The server refused the generation request (' + response.status + '); nothing was generated.', { status: response.status });
      let key = null;
      try { key = (await response.json())?.operationKey ?? null; } catch { key = null; }
      if (typeof key !== 'string' || !key) return refusal('uncertain', 'UNCERTAIN', 'The server accepted the generation request without an operationKey; reconciled by file name.');
      return { ok: true, operationKey: key, bytes: bytes.length, sha256: String(sha256).toLowerCase(), fileName, auth: 'vault' };
    },
  };
}

// Copies a package into <root>/journal/portal/uploads under its remote name (the bridge reads only from there) and
// returns the path. An existing file with the same name and bytes is reused (the name carries the sha256).
export function stageUpload(uploadsDir) {
  return (file, fileName) => {
    fs.mkdirSync(uploadsDir, { recursive: true });
    const target = path.join(uploadsDir, path.basename(fileName));
    const bytes = fs.readFileSync(file);
    if (fs.existsSync(target) && sha256Of(fs.readFileSync(target)) === sha256Of(bytes)) return target;
    fs.writeFileSync(target, bytes);
    return target;
  };
}
