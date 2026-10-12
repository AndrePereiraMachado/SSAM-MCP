// Authentication phase evidence only. Never accept a descriptor, credentials or native error here.
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = fileURLToPath(new URL('../../../.local/debugger/app-user-diagnostics/', import.meta.url));
const STAGES = new Set(['runtime-config', 'identity-discovery', 'builtin-broker', 'srp-signin', 'broker-store-token', 'broker-resume',
  'platform-token', 'platform-jwks', 'token-validation', 'user-profile', 'user-roles', 'session-complete']);
const DETAILS = new Set(['stage-contract', 'http-status', 'json-response', 'configuration-shape', 'builtin-provider-count',
  'builtin-provider-contract', 'discovery-capabilities', 'discovery-endpoints', 'broker-parameters', 'callback-binding']);
const ENDPOINTS = new Set(['runtime_client_settings', 'runtime_auth_configs', 'identity_discovery', 'broker_redirect', 'broker_authorize', 'cognito_srp',
  'token_store', 'broker_resume', 'platform_token', 'platform_jwks', 'user_profile', 'user_roles']);
const CODES = new Set(['debug_app_auth_scope_mismatch', 'debug_app_auth_provider_unsupported', 'debug_app_auth_rejected',
  'debug_app_auth_challenge_required', 'debug_app_auth_unavailable', 'debug_app_auth_expired']);
const PROVIDER_CODES = new Set(['NotAuthorizedException', 'InvalidParameterException', 'TooManyRequestsException', 'PasswordResetRequiredException',
  'UserNotConfirmedException', 'ForbiddenException', 'ResourceNotFoundException', 'InvalidUserPoolConfigurationException', 'UnexpectedLambdaException',
  'InvalidLambdaResponseException', 'UserLambdaValidationException', 'InternalErrorException', 'InvalidSmsRoleAccessPolicyException',
  'InvalidSmsRoleTrustRelationshipException', 'InvalidEmailRoleAccessPolicyException', 'LimitExceededException']);
const PROVIDER_REASONS = new Set(['invalid-credentials', 'too-many-failed-attempts', 'unknown']);
const MAX_EVENTS = 64;

function project(event) {
  if (!event || !STAGES.has(event.stage)) return null;
  const base = { event: event.event, stage: event.stage };
  if (event.event === 'stage') return base;
  if (event.event === 'http' && ENDPOINTS.has(event.endpoint) && ['GET', 'POST'].includes(event.method)
    && Number.isInteger(event.status) && (event.status === 0 || event.status >= 100 && event.status <= 599)) {
    return { ...base, endpoint: event.endpoint, method: event.method, status: event.status };
  }
  if (event.event === 'failure' && DETAILS.has(event.detail) && CODES.has(event.code)) return { ...base, detail: event.detail, code: event.code };
  if (event.event === 'provider-error' && event.stage === 'srp-signin' && PROVIDER_CODES.has(event.code)) {
    if (event.reason === undefined) return { ...base, code: event.code };
    if (!PROVIDER_REASONS.has(event.reason) || event.reason === 'invalid-credentials' && event.code !== 'NotAuthorizedException'
      || event.reason === 'too-many-failed-attempts' && !['NotAuthorizedException', 'LimitExceededException'].includes(event.code)) return null;
    return { ...base, code: event.code, reason: event.reason };
  }
  return null;
}

export function createAppUserAuthDiagnostic(sessionId, { root = ROOT } = {}) {
  // This is the public debugger session ID, never the private vault reference.
  if (!/^[a-f0-9]{32}$/.test(sessionId ?? '')) throw new Error('debug_app_user_invalid_diagnostic_session');
  const directory = join(root, sessionId), path = join(directory, 'authentication-' + randomUUID() + '.json');
  const receipt = { schema: 'ssam-app-user-auth-diagnostic/1', sessionId, lane: 'odc',
    startedAtUtc: new Date().toISOString(), completed: false, truncated: false, events: [] };
  let ended = false;
  const persist = () => {
    try {
      mkdirSync(directory, { recursive: true });
      const temporary = path + '.tmp';
      writeFileSync(temporary, JSON.stringify(receipt) + '\n', { mode: 0o600 });
      renameSync(temporary, path);
    } catch {} // Diagnostic storage cannot change authentication or cause a retry.
  };
  persist();
  return {
    observe(event) {
      if (ended) return;
      let safe;
      try { safe = project(event); } catch { return; }
      if (!safe) return;
      if (receipt.events.length < MAX_EVENTS) receipt.events.push(safe);
      else {
        const alreadyTruncated = receipt.truncated;
        receipt.truncated = true;
        // Keep the terminal phase even when an invalid provider floods earlier observations.
        if (safe.event === 'failure' || safe.stage === 'session-complete') receipt.events[MAX_EVENTS - 1] = safe;
        else if (alreadyTruncated) return;
      }
      persist();
    },
    finish() {
      if (ended) return;
      ended = true; receipt.completed = true; receipt.completedAtUtc = new Date().toISOString(); persist();
    },
  };
}
