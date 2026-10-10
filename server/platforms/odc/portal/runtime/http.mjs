import { fail, OdcError } from './errors.mjs';

export async function requestBytes(fetchImpl, url, options, config, maxBytes = config.maxResponseBytes) {
  let response;
  try {
    response = await fetchImpl(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(config.timeoutMs) });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      fail('REDIRECT_BLOCKED', 'Redirects are not followed; the configured authority must be used directly.');
    }
    if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
      await response.body?.cancel();
      fail('RESPONSE_TOO_LARGE', 'Response exceeds the configured safe size. Narrow the query or request a smaller page.');
    }
    const chunks = [];
    let size = 0;
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          fail('RESPONSE_TOO_LARGE', 'Response exceeds the configured safe size. Narrow the query or request a smaller page.');
        }
        chunks.push(Buffer.from(value));
      }
    }
    return { status: response.status, ok: response.ok, headers: response.headers, bytes: Buffer.concat(chunks) };
  } catch (error) {
    if (error instanceof OdcError) throw error;
    fail('NETWORK_ERROR', 'HTTPS request failed or timed out. No credentials or raw transport details were logged.');
  }
}

export function readJson(bytes, code = 'RESPONSE_INVALID') {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { fail(code, 'The service did not return valid JSON.'); }
}
