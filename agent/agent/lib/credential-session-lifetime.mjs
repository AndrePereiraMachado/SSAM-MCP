export const PORTAL_LIFETIME_NOTE = 'The private Portal session lifetime is limited to its access-token expiry.';

// JWT data only shortens local cache lifetime; it never authenticates a token.
export function limitPortalSessionLifetime(state) {
  if (!state || !Number.isSafeInteger(state.expiresAt)) return false;
  let until = state.expiresAt;
  for (const cookie of state.cookies ?? []) {
    if (!['TenantAccess', 'TenantAccessId'].includes(cookie?.name) || typeof cookie.value !== 'string' || cookie.value.length > 65536) continue;
    try {
      const parts = cookie.value.split('.');
      if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1])) continue;
      const exp = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).exp;
      if (Number.isSafeInteger(exp) && exp > 0 && Number.isSafeInteger(exp * 1000)) until = Math.min(until, exp * 1000);
    } catch { /* Opaque cookies are not interpreted as JWTs. */ }
  }
  const limited = until < state.expiresAt;
  state.expiresAt = until;
  return limited;
}
