import { observeCredentials } from './projection-context.mjs';
import { processCredentials, credentialStateVersion } from './credential-registry.mjs';
import { createCredentialMatcher } from './credential-matcher.mjs';

let processMatcher, matcherVersion = -1;
const explicitMatchers = new WeakMap();
const truncatedFields = new WeakMap();
export function markTruncatedField(target, field) {
  let fields = truncatedFields.get(target);
  if (!fields) { fields = new Set(); truncatedFields.set(target, fields); }
  fields.add(field);
}
function copyTruncation(source, target) {
  const fields = truncatedFields.get(source);
  if (fields) truncatedFields.set(target, fields);
  return target;
}
function matcherFor(secrets) {
  if (secrets === undefined || secrets === processCredentials()) {
    const version = credentialStateVersion();
    if (version !== matcherVersion) {
      processMatcher = createCredentialMatcher(processCredentials()); matcherVersion = version;
    }
    return processMatcher;
  }
  if (Number.isSafeInteger(secrets?.version) && typeof secrets.values === 'function') {
    let cached = explicitMatchers.get(secrets);
    if (!cached || cached.version !== secrets.version) {
      cached = { version: secrets.version, matcher: createCredentialMatcher([...secrets.values()]) };
      explicitMatchers.set(secrets, cached);
    }
    return cached.matcher;
  }
  const values = typeof secrets?.values === 'function' ? [...secrets.values()] : Array.isArray(secrets) ? secrets : [];
  if (Array.isArray(secrets) && Object.isFrozen(secrets)) {
    let matcher = explicitMatchers.get(secrets);
    if (!matcher) { matcher = createCredentialMatcher(values); explicitMatchers.set(secrets, matcher); }
    return matcher;
  }
  return createCredentialMatcher(values);
}
export function boundedText(value, limit, target, field) {
  const clean = redactValues(value, undefined, { trimPrefixes: false, patterns: false });
  return limitedText(clean, limit, target, field);
}
export function limitedText(value, limit, target, field) {
  if (value.length > limit && target) markTruncatedField(target, field);
  return value.slice(0, limit);
}

export class OdcError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'OdcError';
    this.code = code;
    this.details = details;
  }
}

export function publicError(error) {
  if (error?.code === 'AUTHORIZATION_CONTEXT_INVALID')
    return { code: 'AUTHORIZATION_CONTEXT_INVALID', message: 'The approval record does not cover this exact proposal, environment, operation and target. Nothing was sent.' };
  if (['AbortError', 'TimeoutError'].includes(error?.name) || error?.code === 'READ_DEADLINE_EXCEEDED')
    return { code: 'PORTAL_TIMEOUT', message: 'Portal request timed out or was cancelled. No replay performed.' };
  return error instanceof OdcError
    ? { code: error.code, message: error.message, ...error.details }
    : { code: 'INTERNAL_ERROR', message: 'The operation failed locally. No remote error or credentials were logged.' };
}

export function fail(code, message, details) { throw new OdcError(code, message, details); }

// Keys whose value is a secret wherever they appear. A superset of the bridge v32 list (PortalCore.cs SensitiveKey,
// checked by tests/bridge-agreement.test.mjs): camelCase *Token keys (authToken of the private gateway activation and
// key rotation), activationCode of the organization entitlements, OAuth/Portal authorization codes, CSRF values,
// license keys and serials, and key material named as such.
export const SENSITIVE_KEY = /(?:authorization|cookie|password|passwd|secret|(?:^|_)token(?:$|_)|token$|accessToken|refreshToken|idToken|auth.?token|private.?key|credential|api.?key|subscription.?key|connection.?string|activation.?code|auth.?code|csrf|license.?key|^serial(?:.?(?:number|key))?$|pass.?phrase|(?:signing|encryption|shared|master).?key|recovery.?codes?|verification.?code)/i;
// versionToken of /<module>/moduleservices/moduleversioninfo is the module version hash the Portal page itself sends
// back in every screenservice call (portal-metadata.mjs); it is no secret, and the bridge exempts it the same way.
export const PUBLIC_KEYS = Object.freeze(new Set(['versionToken']));
export const isSensitiveKey = key => key !== 'isSecret' && !PUBLIC_KEYS.has(key) && SENSITIVE_KEY.test(key);

// Typed proof metadata names contain "secret" but never carry secret values.
function publicMetadata(key, value) {
  if (['hasCredentialValues', 'credentialConfigured', 'bootstrapRequired', 'authenticated', 'secretValuesVerified'].includes(key))
    return typeof value === 'boolean';
  return key === 'secretRefs' && value && !Array.isArray(value)
    && Object.keys(value).every(k => ['count', 'entries', 'resolvedBy', 'resolutionConfirmed'].includes(k))
    && Number.isSafeInteger(value.count) && value.count >= 0 && Array.isArray(value.entries)
    && value.entries.every(entry => typeof entry === 'string' && /^SSAM\/ODC3\/[^/]+\/(DB|Setting)\/[^\r\n]+$/.test(entry))
    && value.resolvedBy === 'bridge, inside the ODC Studio'
    && (value.resolutionConfirmed === undefined || typeof value.resolutionConfirmed === 'boolean');
}

export function redactValues(value, secrets, { trimPrefixes = true, patterns = true, remote = false } = {}) {
  const matcher = matcherFor(secrets);
  function visit(item, truncated = false) {
    if (typeof item === 'string') {
      let result = patterns ? item.replace(remote ? /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi : /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]') : item;
      result = matcher.replace(result);
      if (trimPrefixes && truncated) result = matcher.trimPrefix(result);
      // Download links may carry capability credentials, even when their field
      // is only named "url". Preserve link context but remove signed query data.
      if (patterns) result = result.replace(/https?:\/\/[^\s<>"']+/gi, link => {
        try {
          const url = new URL(link);
          let changed = false;
          if (url.username || url.password) { url.username = '[REDACTED]'; url.password = ''; changed = true; }
          for (const key of [...url.searchParams.keys()]) if (/(?:signature|^sig$|token|secret|api.?key|credential|^x-amz-|^x-goog-)/i.test(key)) {
            url.searchParams.set(key, '[REDACTED]');
            changed = true;
          }
          return changed ? url.href : link;
        } catch { return '[INVALID URL]'; }
      });
      return result;
    }
    if (Array.isArray(item)) return copyTruncation(item, item.map((entry, index) => visit(entry, truncatedFields.get(item)?.has(index))));
    if (item && typeof item === 'object') return copyTruncation(item, Object.fromEntries(Object.entries(item)
      .map(([key, entry]) => [key, visit(entry, truncatedFields.get(item)?.has(key))])));
    return item;
  }
  return visit(value);
}

export function redact(value, secrets) {
  observeCredentials(secrets);
  // Share one compiled matcher and traversal for all strings in this projection.
  const clean = redactValues(value, secrets, { trimPrefixes: false, remote: true });
  function visit(item, field = '') {
    if (Array.isArray(item)) return copyTruncation(item, item.map(entry => visit(entry)));
    if (item && typeof item === 'object') return copyTruncation(item, Object.fromEntries(Object.entries(item)
      .map(([key, entry]) => [key, (isSensitiveKey(key) && !publicMetadata(key, entry)
          && !(/^isSecret$/i.test(key)&&typeof entry==='boolean')
          && !(key==='BinarySetting_Secret_MaxFileSize'&&(typeof entry==='number'||typeof entry==='string'&&/^(?:0|[1-9]\d{0,6})(?:\.\d{1,8})?$/.test(entry))&&Number.isFinite(Number(entry))&&Number(entry)>=0&&Number(entry)<=1048576))
        || (/^isSecret$/i.test(key)&&typeof entry!=='boolean')
        || ((item.isSecret === true||item.IsSecret===true) && /^(?:value|defaultValue|deployedValue)$/i.test(key))
        ? '[REDACTED]' : visit(entry, key)])));
    return item;
  }
  return visit(clean);
}
