// The workspace quota of an account on the hosted server (docs/FASE2-AGENTE.md 6.1), in whole GiB, from three sources in
// this order (r41, owner 02/11: a 5 GiB constant refused the owner himself with WORKSPACE_FULL):
//   1. the account's own value, kept with its license record (`quotaGiB`, set with `ssam server-token quota` or in the
//      console's Licenses page; null or absent = no override);
//   2. SSAM_WORKSPACE_QUOTA_GIB of the server (the same value on every backend: the Coolify compose sets it for all);
//   3. DEFAULT_QUOTA_GIB.
// A value that is not a whole number of GiB from MIN_QUOTA_GIB to MAX_QUOTA_GIB is refused: in the environment, the hosted
// server does not start (WORKSPACE_QUOTA_INVALID, one log line naming the variable), because a typo would otherwise give
// every account a quota nobody chose; on a license record, the writer refuses it (INVALID_QUOTA). An empty variable counts
// as unset (Coolify writes "" for a variable the owner left blank).
export const QUOTA_ENV = 'SSAM_WORKSPACE_QUOTA_GIB';
export const DEFAULT_QUOTA_GIB = 10;
export const MIN_QUOTA_GIB = 1;
export const MAX_QUOTA_GIB = 1024;
export const GIB = 1024 ** 3;
export const QUOTA_RULE = 'quota: a whole number of GiB from ' + MIN_QUOTA_GIB + ' to ' + MAX_QUOTA_GIB + ', or "default" for the server value';
const coded = (code, message) => Object.assign(new Error(message), { code });

// A whole number of GiB within the range, or null when the value is not one.
export function validQuotaGiB(value) {
  const n = typeof value === 'string' && /^\s*\d{1,5}\s*$/.test(value) ? Number(value) : value;
  return Number.isInteger(n) && n >= MIN_QUOTA_GIB && n <= MAX_QUOTA_GIB ? n : null;
}

// The server value: SSAM_WORKSPACE_QUOTA_GIB, else the default. Throws WORKSPACE_QUOTA_INVALID for any other value.
export function serverQuotaGiB(env = process.env) {
  const raw = env?.[QUOTA_ENV];
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_QUOTA_GIB;
  const gib = validQuotaGiB(String(raw));
  if (gib === null) throw coded('WORKSPACE_QUOTA_INVALID', QUOTA_ENV + ' must be a whole number of GiB from ' + MIN_QUOTA_GIB + ' to ' + MAX_QUOTA_GIB
    + ' (got ' + JSON.stringify(String(raw).slice(0, 40)) + '); the hosted server does not start with it. Unset it for the default of ' + DEFAULT_QUOTA_GIB + ' GiB.');
  return gib;
}

// The start check of the hosted server (http-server.mjs): one log line and the throw for an invalid server value.
export function assertServerQuota(env = process.env, log = () => {}) {
  try { return serverQuotaGiB(env); } catch (error) { log({ event: 'workspace-quota-invalid', code: error.code, message: error.message }); throw error; }
}

// The quota of an account: its record's quotaGiB when valid, else the server value. {gib, bytes, source: account|env|default}.
export function effectiveQuota(record, env = process.env) {
  const own = record && record.quotaGiB != null ? validQuotaGiB(record.quotaGiB) : null;
  if (own !== null) return { gib: own, bytes: own * GIB, source: 'account' };
  const raw = env?.[QUOTA_ENV];
  const gib = serverQuotaGiB(env);
  return { gib, bytes: gib * GIB, source: raw === undefined || raw === null || String(raw).trim() === '' ? 'default' : 'env' };
}

// The value a writer stores: null for "default" / null / '' (the override is removed), else a valid whole GiB, else
// INVALID_QUOTA.
export function quotaInput(value) {
  if (value === null || value === undefined || (typeof value === 'string' && ['', 'default', 'none'].includes(value.trim().toLowerCase()))) return null;
  const gib = validQuotaGiB(value);
  if (gib === null) throw coded('INVALID_QUOTA', QUOTA_RULE);
  return gib;
}
