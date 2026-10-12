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

export function redact(value, secrets = []) {
  const replacements = secrets.filter(s => typeof s === 'string' && s.length > 0)
    .flatMap(s => [s, encodeURIComponent(s)]).sort((a, b) => b.length - a.length);
  function visit(item, field = '') {
    if (typeof item === 'string') {
      // Public UUID identifiers must round-trip. A short password fragment can occur in a UUID by chance;
      // replacing that fragment destroys environment/application keys. Never exempt secret-named fields (below),
      // an exact secret value, free text, URLs, or arbitrary non-UUID identifiers.
      const publicUuid = /(?:key|id)$/i.test(field) && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(item);
      const publicTraceId = /^(?:id|traceId|spanId|parentSpanId)$/i.test(field) && /^(?:[0-9a-f]{16}|[0-9a-f]{32})$/i.test(item);
      const publicLogId = /^logId$/i.test(field) && /^[A-Za-z0-9_-]{20,64}$/.test(item);
      const publicTimestamp = /^(?:time|instant|timestamp|startTime|endTime)$/i.test(field) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(item) && Number.isFinite(Date.parse(item));
      // TimerRunInformation uses these typed dates, including the no-run sentinel
      // 1900-01-01T00:00:00 without an offset. Cookie flags must not corrupt them.
      const publicTimerTimestamp = /^(?:currentStartedOn|lastRunStartedOn|lastRunFinishedOn|nextRunStartsOn)$/i.test(field)
        && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?$/.test(item) && Number.isFinite(Date.parse(item));
      // Numeric telemetry is a typed public field, including 64-bit values that
      // must remain strings. Cookie flags such as "0" must not destroy it.
      const publicInteger = /^(?:limit|offset|nextPageOffset|totalPages|totalResults|duration|numberOfSpans|numberOfErrors|maxSupportedSpans|(?:origin)?(?:application|asset|library)Version|startTimeUnixNano|endTimeUnixNano)$/i.test(field) && /^-?\d{1,30}$/.test(item);
      if (publicInteger) return item;
      if (publicUuid || publicTraceId || publicLogId || publicTimestamp || publicTimerTimestamp) return replacements.includes(item) ? '[REDACTED]' : item;
      let result = item.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
      for (const secret of replacements) result = result.split(secret).join('[REDACTED]');
      // Download links may carry capability credentials, even when their field
      // is only named "url". Preserve link context but remove signed query data.
      result = result.replace(/https?:\/\/[^\s<>"']+/gi, link => {
        try {
          const url = new URL(link);
          let changed = false;
          if (url.username || url.password) { url.username = ''; url.password = ''; changed = true; }
          for (const key of [...url.searchParams.keys()]) if (/(?:signature|^sig$|token|secret|api.?key|credential|^x-amz-|^x-goog-)/i.test(key)) {
            url.searchParams.set(key, '[REDACTED]');
            changed = true;
          }
          return changed ? url.href : link;
        } catch { return '[INVALID URL]'; }
      });
      return result;
    }
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item)
      .map(([key, entry]) => [key, (isSensitiveKey(key) && !(key === 'hasCredentialValues' && typeof entry === 'boolean')
          && !(/^isSecret$/i.test(key)&&typeof entry==='boolean')
          && !(key==='BinarySetting_Secret_MaxFileSize'&&(typeof entry==='number'||typeof entry==='string'&&/^(?:0|[1-9]\d{0,6})(?:\.\d{1,8})?$/.test(entry))&&Number.isFinite(Number(entry))&&Number(entry)>=0&&Number(entry)<=1048576))
        || (/^isSecret$/i.test(key)&&typeof entry!=='boolean')
        || ((item.isSecret === true||item.IsSecret===true) && /^(?:value|defaultValue|deployedValue)$/i.test(key))
        ? '[REDACTED]' : visit(entry, key)]));
    return item;
  }
  return visit(value);
}
