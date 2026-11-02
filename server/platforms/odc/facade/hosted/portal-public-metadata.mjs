import { createPublicFetch } from './public-fetch.mjs';
import { readOptions } from '../read-budget.mjs';
import { fail } from '../../portal/runtime/errors.mjs';

export const PUBLIC_METADATA_NOTE = 'Portal version metadata was read from public assets without credentials; authenticated response redaction remains enabled.';
const LIMIT = 4 * 1024 * 1024;
const publicFetch = createPublicFetch({ maxBytes: LIMIT });

// A separate, credential-free provenance for public application code. The
// authenticated transport still redacts every private value. In particular,
// a short cookie must not corrupt an API version read from public JavaScript.
export function publicPortalMetadata(origin, { fetch = publicFetch, note = () => {} } = {}) {
  return async (value, { signal, method = 'GET', body } = {}) => {
    let url;
    try { url = new URL(value); } catch { fail('PORTAL_ORIGIN_DENIED', 'Public Portal metadata URL is invalid.'); }
    const allowed = /^\/[A-Za-z][A-Za-z0-9_-]{0,63}\/(?:|moduleservices\/moduleversioninfo|scripts\/[A-Za-z0-9_./~-]+\.js)$/.test(url.pathname);
    if (url.origin !== origin || url.protocol !== 'https:' || url.port || url.username || url.password || url.hash ||
        !allowed || /(?:%|\\|\/\.\.?\/)/.test(String(value).split('?')[0]) || method !== 'GET' || body !== undefined) {
      fail('PORTAL_ORIGIN_DENIED', 'Only public Portal module metadata and static JavaScript on the selected origin are allowed.');
    }
    const budget = readOptions('metadata');
    const signals = [signal, budget.signal, AbortSignal.timeout(Math.min(15000, budget.timeoutMs ?? 15000))].filter(Boolean);
    let response, bytes;
    try {
      // No caller headers, Authorization, Cookie, cookie jar, or redirect replay.
      response = await fetch(url.href, { method: 'GET', signal: AbortSignal.any(signals) });
      if (response.status !== 200) { await response.body?.cancel?.(); fail('PORTAL_CONTRACT_CHANGED', 'Public Portal metadata is unavailable without authentication.'); }
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (error?.code === 'PORTAL_CONTRACT_CHANGED') throw error;
      fail('PORTAL_CONTRACT_CHANGED', 'Public Portal metadata could not be read safely.');
    }
    if (bytes.length > LIMIT) fail('PORTAL_CONTRACT_CHANGED', 'Public Portal metadata exceeds its size limit.');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { fail('PORTAL_CONTRACT_CHANGED', 'Public Portal metadata is not valid UTF-8.'); }
    note(PUBLIC_METADATA_NOTE);
    return { status: 200, location: null, text };
  };
}
