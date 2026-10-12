import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { withPrivateSessionHandoff } from './private-session-pipe.mjs';
import { checkSecretRefs, pointerValue, wirePointer } from './portal-routes.mjs';
import { fail } from './errors.mjs';
import {API_CLIENT_CREATE,apiClientPrivateProof} from './api-client-fixture.mjs';

// Internal collaborator; cookie/CSRF never become tool or bridge arguments.
export function privatePortalSender({ host, principal, bridge, requestFile, optionalCsrf = false, mobileUpload = false, mobileVaultUpload = false, mobileBase64 = false, apiClientVault = false, handoff = withPrivateSessionHandoff }) {
  const sender = async (value, options, context) => {
    const url = new URL(value);
    if (url.origin !== 'https://' + host || url.username || url.password || url.hash || options.method !== 'POST' || options.write !== true)
      fail('PORTAL_ORIGIN_DENIED', 'Private session handoff requires an authorized write to its exact tenant.');
    if(options.operationId===API_CLIENT_CREATE&&!apiClientVault)fail('HEADLESS_AUTH_UNAVAILABLE','API Client creation requires native private vault capture. Nothing was sent.');
    if((options.operationId==='mobileExtensibility.convertFile'||String(options.mobileObjectUri??'').startsWith('urn:ssam:mobile-base64:'))&&!mobileBase64)fail('HEADLESS_AUTH_UNAVAILABLE','Native Base64 conversion/save requires a capable bridge. Nothing was sent.');
    const vaultBinary=['mobileExtensibility.uploadFile','mobileExtensibility.convertFile'].includes(options.operationId)&&options.mobileExpectedContent!==undefined;
    if(vaultBinary&&!mobileVaultUpload)fail('HEADLESS_AUTH_UNAVAILABLE','Vault binary upload requires a content-verifying native bridge. Nothing was sent.');
    const refs = checkSecretRefs(host, options.secretRefs ?? [],undefined,{kind:vaultBinary?'SettingFile':'DB'}).map(ref => ({ pointer: wirePointer(ref.pointer), target: ref.target, field: ref.field }));
    for (const ref of refs) if (pointerValue(options.body, ref.pointer) !== '')
      fail('INPUT_INVALID', 'Native credential references require an existing empty placeholder.');
    const file = await requestFile({ operationId: options.operationId, method: 'POST', path: url.pathname + url.search,
      body: options.body, write: true, operationUuid: options.operationUuid, authorizeSha256: options.authorizeSha256,
      confirmTenant: options.confirmTenant, ...(refs.length?{secretRefs:refs}:{}),
      ...(options.mobileExpectedContent?{mobileExpectedContent:options.mobileExpectedContent}:{}),
      ...(options.mobileUploadOperationUuid?{mobileUploadOperationUuid:options.mobileUploadOperationUuid,mobileObjectUri:options.mobileObjectUri}:{}) });
    const requestSha256 = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    let answer;
    try {
      answer = await handoff({ host, principal, requestSha256, cookie: context.cookie, csrf: context.csrf },
        pipeId => bridge(['portal-private-call', file, pipeId, '--tenant', host]));
    } catch {
      // Native invocation may have sent HTTP even if the local command lost its
      // answer. Never expose the underlying transport's private exception text.
      fail('UNCERTAIN', 'Private native transport did not return a conclusive result. Reconcile by a read; never resend.', { sent: true });
    }
    if (answer?.ok !== true) {
      const known = new Set(['HEADLESS_AUTH_UNAVAILABLE', 'STUDIO_NOT_SIGNED_IN', 'NOT_ALLOWED', 'BAD_REQUEST', 'HOST_MISMATCH', 'REMOTE_ERROR', 'UNCERTAIN']);
      const code = known.has(answer?.code) ? answer.code : 'UNCERTAIN';
      fail(code, 'The native private HTTP transport refused or could not confirm the request.', {
        sent: answer?.sent === true || code === 'UNCERTAIN' || typeof answer?.status === 'number',
        ...(typeof answer?.status === 'number' ? { status: answer.status } : {}), ...(answer?.gate ? { gate: answer.gate } : {})
      });
    }
    if (answer.host !== host || String(answer.user ?? '').toLowerCase() !== principal.toLowerCase())
      fail('UNCERTAIN', 'Native response identity did not match its private session scope.', { sent: true });
    // Database answers are small JSON DTOs; file/binary/omitted bodies cannot
    // establish success and are never read through an arbitrary returned path.
    if (!answer.body || answer.bodyFile || answer.bodyOmitted || answer.bodyError)
      fail('UNCERTAIN', 'Native response did not include a complete JSON result.', { sent: true });
    const body=options.operationId===API_CLIENT_CREATE?{data:{ApiClientProof:apiClientPrivateProof(answer.body.data?.ApiClientProof,
      {operationUuid:options.operationUuid,name:options.body.inputParameters?.OIDCClientCreate?.Name})}}:answer.body;
    return { status: answer.status, location: null, text: JSON.stringify(body) };
  };
  sender.optionalCsrf = optionalCsrf;
  sender.mobileUpload = mobileUpload;
  sender.mobileVaultUpload = mobileVaultUpload;
  sender.mobileBase64 = mobileBase64;
  sender.apiClientVault = apiClientVault;
  return sender;
}
