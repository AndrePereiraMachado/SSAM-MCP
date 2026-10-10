import { AuthenticationDetails, CognitoUser, CognitoUserPool } from 'amazon-cognito-identity-js';
import { OdcError, fail } from './errors.mjs';
/* global SSAM_RELEASE */

const diagnosticOperations = new Set(['InitiateAuth', 'RespondToAuthChallenge', 'ConfirmDevice', 'UpdateDeviceStatus', 'ForgetDevice', 'GetDevice']);

// The SRP exchange is two requests. Device enrollment is not part of this
// integration's authority; never send ConfirmDevice or account mutations.
export function createCognitoTransport({ request, signal }) {
  let calls = 0;
  return (operation, params, callback) => {
    const diagnostic = { operation: diagnosticOperations.has(operation) ? operation : 'unsupported' };
    if (signal?.aborted) { callback(new OdcError('PORTAL_TIMEOUT', 'Authentication request was cancelled.', { ...diagnostic, reason: 'AUTH_ABORTED' })); return; }
    if (!['InitiateAuth', 'RespondToAuthChallenge'].includes(operation)) {
      callback(new OdcError('PORTAL_LOGIN_OPERATION_BLOCKED', 'The SDK requested an operation outside the sign-in allowlist; nothing was sent.', { ...diagnostic, reason: 'OPERATION_NOT_ALLOWED' })); return;
    }
    if (calls >= 2) {
      callback(new OdcError('PORTAL_LOGIN_REQUEST_BUDGET', 'The bounded SRP exchange requested an additional call; nothing was sent.', { ...diagnostic, reason: 'REQUEST_BUDGET_EXCEEDED' })); return;
    }
    calls++;
    request('https://cognito-idp.us-east-1.amazonaws.com/', { method: 'POST', signal,
      headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': `AWSCognitoIdentityProviderService.${operation}` }, body: params })
      .then(response => {
        if (signal?.aborted) { callback(new OdcError('PORTAL_TIMEOUT', 'Authentication request was cancelled.', { ...diagnostic, reason: 'AUTH_ABORTED' })); return; }
        if (response.status !== 200) { callback(new OdcError('PORTAL_LOGIN_REJECTED', 'Cognito sign-in was rejected; no retry performed.')); return; }
        let body; try { body = JSON.parse(response.text); } catch { callback(new OdcError('PORTAL_LOGIN_REJECTED', 'Identity response was not valid JSON.')); return; }
        const result = body.AuthenticationResult;
        // Cognito has already completed authentication when it issues this
        // token set without a ChallengeName. NewDeviceMetadata only invites
        // registration. Suppress that optional SDK follow-up locally; do not
        // pretend ConfirmDevice succeeded or bypass any actual challenge.
        if (!body.ChallengeName && result && ['AccessToken', 'IdToken', 'RefreshToken'].every(key => typeof result[key] === 'string' && result[key].length > 0)
          && Object.hasOwn(result, 'NewDeviceMetadata')) {
          const { NewDeviceMetadata: ignored, ...sessionResult } = result;
          body = { ...body, AuthenticationResult: sessionResult };
        }
        callback(null, body);
      }).catch(() => callback(signal?.aborted
        ? new OdcError('PORTAL_TIMEOUT', 'Authentication request was cancelled.', { ...diagnostic, reason: 'AUTH_ABORTED' })
        : new OdcError('PORTAL_LOGIN_REJECTED', 'Identity request failed; no raw error returned.')));
  };
}

// Use the maintained AWS SDK's SRP implementation; do not implement or copy
// password cryptography. Storage is per-attempt memory only, never browser/FS.
export async function cognitoLogin({ config, username, password, request, signal }) {
  if (signal?.aborted) fail('PORTAL_TIMEOUT', 'Authentication was already cancelled.', { reason: 'AUTH_ABORTED' });
  if (config.Region !== 'us-east-1' || !/^us-east-1_[A-Za-z0-9]+$/.test(config.PoolKey ?? '')
    || !/^[a-z0-9]+$/i.test(config.AmplifyClientKey ?? '') || config.AuthFlow !== 'USER_SRP_AUTH') {
    // Release (lane V): the same refusal without the name of the tenant the configuration was verified on. The test is
    // RELEASE of release-layout.mjs written inline: esbuild folds the SSAM_RELEASE define only in the expression that
    // reads it, so an imported RELEASE (or a const) would keep the checkout text, which names a client, in the bytecode
    // (measured with the pinned esbuild-wasm).
    fail('PORTAL_LOGIN_PROVIDER_UNSUPPORTED', typeof SSAM_RELEASE !== 'undefined' && SSAM_RELEASE === true
      ? 'Tenant Cognito configuration differs from the verified SRP configuration (us-east-1 user pool, USER_SRP_AUTH).'
      : 'Tenant Cognito configuration differs from the verified SRP configuration of the corporate tenant (us-east-1 user pool, USER_SRP_AUTH).');
  }
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key), clear: () => values.clear() };
  const pool = new CognitoUserPool({ UserPoolId: config.PoolKey, ClientId: config.AmplifyClientKey, Storage: storage });
  const user = new CognitoUser({ Username: username, Pool: pool, Storage: storage });
  user.client.request = createCognitoTransport({ request, signal });
  user.client.requestWithRetry = user.client.request;
  try {
    return await new Promise((resolve, reject) => {
      const challenge = () => { signal?.removeEventListener('abort', abort); reject(new OdcError('PORTAL_LOGIN_CHALLENGE_REQUIRED', 'Cognito returned an authentication challenge. No bypass or account mutation was attempted.', { reason: 'AUTH_CHALLENGE_RETURNED' })); };
      const abort = () => reject(new OdcError('PORTAL_TIMEOUT', 'Authentication deadline elapsed.'));
      signal?.addEventListener('abort', abort, { once: true });
      user.authenticateUser(new AuthenticationDetails({ Username: username, Password: password }), {
        onSuccess: session => { signal?.removeEventListener('abort', abort); resolve({ AccessToken: session.getAccessToken().getJwtToken(), IdToken: session.getIdToken().getJwtToken(), RefreshToken: session.getRefreshToken().getToken() }); },
        onFailure: error => { signal?.removeEventListener('abort', abort); reject(error instanceof OdcError ? error : new OdcError('PORTAL_LOGIN_REJECTED', 'Cognito sign-in failed; raw errors are withheld.')); },
        mfaRequired: challenge, totpRequired: challenge, newPasswordRequired: challenge, customChallenge: challenge, selectMFAType: challenge, mfaSetup: challenge,
      });
    });
  } finally { values.clear(); }
}
