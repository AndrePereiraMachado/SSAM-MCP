export class OdcError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'OdcError';
    this.code = code;
    this.details = details;
  }
}

export function publicError(error) {
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
  function visit(item) {
    if (typeof item === 'string') {
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
      .map(([key, entry]) => [key, isSensitiveKey(key)
        || (item.isSecret === true && /^(?:value|defaultValue|deployedValue)$/i.test(key))
        ? '[REDACTED]' : visit(entry)]));
    return item;
  }
  return visit(value);
}
