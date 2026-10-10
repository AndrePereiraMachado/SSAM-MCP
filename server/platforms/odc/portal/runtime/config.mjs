import fs from 'node:fs';
import { fail } from './errors.mjs';

export function httpsOrigin(value, label = 'portal origin') {
  let url;
  try { url = new URL(value); } catch { fail('CONFIGURATION_INVALID', `Invalid ${label}.`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    fail('CONFIGURATION_INVALID', `${label} must be an HTTPS origin, with no credentials, path, query or fragment.`);
  }
  return url.origin;
}

export function readConfig(env = process.env) {
  let policy = {};
  if (env.ODC_POLICY_FILE) {
    try { policy = JSON.parse(fs.readFileSync(env.ODC_POLICY_FILE, 'utf8')); }
    catch { fail('CONFIGURATION_INVALID', 'Cannot read the explicitly configured policy file.'); }
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) fail('CONFIGURATION_INVALID', 'Policy must be an object.');
  }
  const allowedPolicyKeys = ['allowedWriteOperations', 'trustedTokenOrigins'];
  if (Object.keys(policy).some(key => !allowedPolicyKeys.includes(key))) fail('CONFIGURATION_INVALID', 'Policy contains unknown properties.');
  const writes = policy.allowedWriteOperations ?? [];
  const tokenOrigins = policy.trustedTokenOrigins ?? [];
  if (!Array.isArray(writes) || writes.some(id => typeof id !== 'string' || id.includes('*'))) {
    fail('CONFIGURATION_INVALID', 'Write permissions require an explicit list of exact catalog operation IDs; wildcards are not supported.');
  }
  if (!Array.isArray(tokenOrigins) || tokenOrigins.some(origin => typeof origin !== 'string')) {
    fail('CONFIGURATION_INVALID', 'Trusted token origins must be an explicit list of HTTPS origins.');
  }
  const origin = env.ODC_PORTAL_ORIGIN ? httpsOrigin(env.ODC_PORTAL_ORIGIN) : null;
  return Object.freeze({
    origin,
    clientId: env.ODC_CLIENT_ID || null,
    clientSecret: env.ODC_CLIENT_SECRET || null,
    allowedWriteOperations: new Set(writes),
    trustedTokenOrigins: new Set([...(origin ? [origin] : []), ...tokenOrigins.map(o => httpsOrigin(o, 'trusted token origin'))]),
    timeoutMs: 30_000,
    maxResponseBytes: 2 * 1024 * 1024,
    maxRequestBytes: 8 * 1024 * 1024,
  });
}
