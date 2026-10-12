import { AuthenticationDetails, CognitoUser, CognitoUserPool } from 'amazon-cognito-identity-js';
import { OdcError, fail } from './errors.mjs';
/* global SSAM_RELEASE */

const diagnosticOperations = new Set(['InitiateAuth', 'RespondToAuthChallenge', 'ConfirmDevice', 'UpdateDeviceStatus', 'ForgetDevice', 'GetDevice']);
const diagnosticErrors = new Set(['NotAuthorizedException', 'InvalidParameterException', 'TooManyRequestsException', 'PasswordResetRequiredException',
  'UserNotConfirmedException', 'ForbiddenException', 'ResourceNotFoundException', 'InvalidUserPoolConfigurationException', 'UnexpectedLambdaException',
  'InvalidLambdaResponseException', 'UserLambdaValidationException', 'InternalErrorException', 'InvalidSmsRoleAccessPolicyException',
  'InvalidSmsRoleTrustRelationshipException', 'InvalidEmailRoleAccessPolicyException', 'LimitExceededException']);

// Exact categories from the published runtime's getAuthErrorDetails. Inspect
// provider text only in memory; neither that text nor a fragment is observed.
function providerErrorReason(code, message) {
  if (code === 'LimitExceededException') return 'too-many-failed-attempts';
  if (code === 'NotAuthorizedException' && typeof message === 'string') {
    if (message.includes('Incorrect username or password')) return 'invalid-credentials';
    if (message.includes('Password attempts exceeded')) return 'too-many-failed-attempts';
  }
  return 'unknown';
}

function observeProviderError(text, observer) {
  if (typeof observer !== 'function') return;
  try {
    const body = JSON.parse(text);
    const code = [body?.__type, body?.code, body?.name].filter(value => typeof value === 'string')
      .map(value => value.split('#').at(-1)).find(value => diagnosticErrors.has(value));
    if (!code) return;
    const pending = observer(Object.freeze({ event: 'provider-error', stage: 'srp-signin', code,
      reason: providerErrorReason(code, body.message) }));
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  } catch {} // No provider text or observer failure can alter authentication.
}
// Regions observed in the supported tenants. Keep endpoints closed over this
// allowlist; app metadata may select a region, never an arbitrary origin.
export const cognitoRegionSupported = region => region === 'us-east-1' || region === 'us-east-2';

// The SRP exchange is two requests. Device enrollment is not part of this
// integration's authority; never send ConfirmDevice or account mutations.
export function createCognitoTransport({ request, signal, region = 'us-east-1', observer }) {
  if (!cognitoRegionSupported(region)) fail('PORTAL_LOGIN_PROVIDER_UNSUPPORTED', 'Cognito region is not supported.');
  const endpoint = `https://cognito-idp.${region}.amazonaws.com/`;
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
    request(endpoint, { method: 'POST', signal,
      headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': `AWSCognitoIdentityProviderService.${operation}` }, body: params })
      .then(response => {
        if (signal?.aborted) { callback(new OdcError('PORTAL_TIMEOUT', 'Authentication request was cancelled.', { ...diagnostic, reason: 'AUTH_ABORTED' })); return; }
        if (response.status !== 200) { observeProviderError(response.text, observer); callback(new OdcError('PORTAL_LOGIN_REJECTED', 'Cognito sign-in was rejected; no retry performed.')); return; }
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
export async function cognitoLogin({ config, username, password, request, signal, observer }) {
  if (signal?.aborted) fail('PORTAL_TIMEOUT', 'Authentication was already cancelled.', { reason: 'AUTH_ABORTED' });
  if (!cognitoRegionSupported(config.Region) || !/^(us-east-[12])_[A-Za-z0-9]+$/.test(config.PoolKey ?? '')
    || config.PoolKey.split('_')[0] !== config.Region
    || !/^[a-z0-9]+$/i.test(config.AmplifyClientKey ?? '') || config.AuthFlow !== 'USER_SRP_AUTH') {
    fail('PORTAL_LOGIN_PROVIDER_UNSUPPORTED', 'Cognito region, pool or authentication flow does not match the supported SRP contract.');
  }
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key), clear: () => values.clear() };
  const pool = new CognitoUserPool({ UserPoolId: config.PoolKey, ClientId: config.AmplifyClientKey, Storage: storage });
  const user = new CognitoUser({ Username: username, Pool: pool, Storage: storage });
  user.client.request = createCognitoTransport({ request, signal, region: config.Region, observer });
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
