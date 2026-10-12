// The broker's own cookies only. Portal may store CSRF directly or within its
// URL-encoded nr2 application cookie; neither value is returned to a tool.
export function portalCsrf(cookies) {
  const valid = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x20\x7f;]/.test(value);
  const direct = cookies.find(cookie => cookie.key === 'crf')?.value;
  if (valid(direct)) return direct;
  for (const cookie of cookies) {
    if (!/^nr2[^=]*$/.test(cookie.key)) continue;
    let decoded;
    try { decoded = decodeURIComponent(cookie.value); } catch { continue; }
    const token = /(?:^|;)crf=([^;]*)/.exec(decoded)?.[1];
    if (valid(token)) return token;
  }
  return '';
}
