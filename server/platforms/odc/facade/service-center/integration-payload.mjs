// Historical payloads are read only through the detail control of an exact
// native log row. Never replay the integration or manufacture its parameters.
import { ProtocolError } from './errors.mjs';
import { redact, redactText } from './bridge.mjs';

const flat = n => n.text.trim().replace(/\s+/g, ' ');
export const payloadFailure = (code, payloadStatus, event, reason, extra = {}) => ({
  ok: false, code, payloadStatus, event, request: null, response: null,
  reason, replayed: false, ...extra,
});

export function selectIntegrationRecord(records, { requestKey, action, moduleId, instant }) {
  const found = records.filter(r => r.Request_Key === requestKey && r.ACTION === action
    && (moduleId == null || String(r.Espace_Id) === String(moduleId)) && (!instant || r.INSTANT === instant));
  if (!found.length) return payloadFailure('SC_INTEGRATION_EVENT_NOT_FOUND', 'event-not-found', null,
    'No exported integration event matches the requested identity.');
  const newest = found.map(r => r.INSTANT).sort().at(-1);
  const latest = found.filter(r => r.INSTANT === newest);
  if (latest.length !== 1) return payloadFailure('SC_INTEGRATION_EVENT_AMBIGUOUS', 'ambiguous-event', null,
    'More than one integration event has this identity and timestamp; no payload was selected.', { matches: latest.length });
  const r = latest[0];
  return { requestKey: r.Request_Key, action: r.ACTION, instant: r.INSTANT, moduleId: String(r.Espace_Id),
    module: r.Espace_Name, application: r.Application_Name, type: r.TYPE, endpoint: redactPayload(r.ENDPOINT ?? ''),
    durationMs: /^\d+$/.test(String(r.DURATION)) ? Number(r.DURATION) : null,
    errorId: r.Error_Id || null };
}

export function exactIntegrationRow(page, event) {
  const root = page.doc.content(), matching = [];
  for (const table of root.all('table')) {
    const rows = table.all('tr').filter(n => n.ancestor('table') === table);
    const header = rows.find(r => r.children.some(c => c?.tag === 'th'));
    if (!header) continue;
    const names = header.children.filter(c => c?.tag === 'th').map(flat);
    if (!['Time of Log', 'Module', 'Type', 'Action'].every(h => names.includes(h))) continue;
    for (const row of rows) {
      const cells = row.children.filter(c => c?.tag === 'td');
      if (cells.length !== names.length) continue;
      const values = Object.fromEntries(cells.map((c, i) => [names[i], flat(c)]));
      if (values['Time of Log'] !== event.instant || values.Action !== event.action || values.Type !== event.type) continue;
      const moduleLinks = cells[names.indexOf('Module')].all('a').filter(a => {
        try { const u = new URL(a.attr('href', ''), page.url); return u.origin === new URL(page.url).origin
          && /\/ServiceCenter\/eSpace_Edit\.aspx$/i.test(u.pathname) && u.searchParams.get('EspaceId') === event.moduleId; }
        catch { return false; }
      });
      if (moduleLinks.length === 1) matching.push(row);
    }
  }
  return matching.length === 1 ? { row: matching[0] } : payloadFailure(
    matching.length ? 'SC_INTEGRATION_EVENT_AMBIGUOUS' : 'SC_INTEGRATION_EVENT_NOT_FOUND',
    matching.length ? 'ambiguous-event' : 'event-not-found', event,
    'The native listing did not identify exactly one row matching the exported event.', { matches: matching.length });
}

export function integrationPayloadControl(page, row, event) {
  const controls = row.all('a', 'input', 'button').filter(n => {
    const label = [n.text, n.attr('title', ''), n.attr('aria-label', ''), n.attr('value', '')].join(' ');
    const href = n.attr('href', '');
    return /request.*response|response.*request|view (?:log )?details|integration.*detail/i.test(label)
      || /(?:Integration[^/?#]*(?:Detail)|(?:Show|View)_Integration)\.aspx(?:[?#]|$)/i.test(href);
  });
  if (!controls.length) return payloadFailure('SC_INTEGRATION_PAYLOAD_NOT_EXPOSED', 'not-exposed', event,
    'The matching native log row exposes no request/response detail control. This does not prove whether the payload was recorded.',
    { evidence: { source: page.url, matchedRows: 1, detailControls: 0 }, recordingStatus: 'unknown' });
  if (controls.length !== 1) return payloadFailure('SC_INTEGRATION_DETAIL_AMBIGUOUS', 'ambiguous-detail', event,
    'The matching native event has more than one payload detail control.');
  const control = controls[0], href = control.attr('href', '');
  if (/^(?:javascript:|#|$)/i.test(href) || control.attr('onclick')) return payloadFailure(
    'SC_INTEGRATION_DETAIL_UNSUPPORTED', 'unsupported-detail-control', event,
    'The native payload control is scripted; no unverified event was executed.');
  const url = new URL(href, page.url), base = new URL(page.url);
  if (url.origin !== base.origin || url.username || url.password || url.hash
      || !/^\/ServiceCenter\/[A-Za-z][A-Za-z0-9_]*\.aspx$/.test(url.pathname)
      || /%2f|%5c|%2e/i.test(url.pathname))
    throw new ProtocolError('The integration detail link leaves the bound Service Center origin.', 'SC_INTEGRATION_DETAIL_ORIGIN_REFUSED');
  if (!/^\/ServiceCenter\/(?:Integration(?:_?Logs?)?_?Details?|(?:Show|View)_Integration(?:_Log)?)\.aspx$/i.test(url.pathname))
    return payloadFailure('SC_INTEGRATION_DETAIL_UNSUPPORTED', 'unsupported-detail-route', event,
      'The observed link is not a supported read-only integration detail route; nothing was followed.');
  return { url: url.href };
}

// HTTP envelopes and JSON/form/XML bodies can contain credentials. Return only
// the redacted visible payload, never raw page markup or hidden form state.
export function redactPayload(value) {
  let text = String(value);
  text = text.replace(/^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)\s*:[^\r\n]*/gim, '$1: <redacted>');
  const secretName = '(?:password|passwd|pwd|secret|client[-_]?secret|(?:access|refresh|id)[-_]?token|token|(?:x[-_])?api[-_]?key)';
  text = text.replace(new RegExp('([?&;]?' + secretName + '=)[^&;\\s]*', 'gi'), '$1<redacted>');
  text = text.replace(new RegExp('("' + secretName + '"\\s*:\\s*)"(?:\\\\.|[^"\\\\])*"', 'gi'), '$1"<redacted>"');
  text = text.replace(new RegExp('(<(' + secretName + ')(?:\\s[^>]*)?>)[\\s\\S]*?(<\\/\\2>)', 'gi'), '$1<redacted>$3');
  // Pure JSON also redacts nested credentials and name/value header objects.
  const secret = name => /password|passwd|^pwd$|secret|token|cookie|authorization|credential|apikey/i.test(String(name).replace(/[-_\s]/g, ''));
  const mask = data => {
    if (Array.isArray(data)) return data.map(mask);
    if (data && typeof data === 'object') {
      const named = Object.entries(data).some(([k,v]) => /^(name|key|propertyName)$/i.test(k) && typeof v === 'string' && secret(v));
      return Object.fromEntries(Object.entries(data).map(([k,v]) => [k, secret(k) || named && /^(value|propertyValue)$/i.test(k) ? '<redacted>' : mask(v)]));
    }
    return data;
  };
  const split = /\r?\n\r?\n/.exec(text);
  const prefix = split ? text.slice(0, split.index + split[0].length) : '';
  const body = split ? text.slice(prefix.length) : text;
  try { text = prefix + JSON.stringify(redact(mask(JSON.parse(body))), null, 2); } catch {}
  return redactText(text);
}

export function integrationPayloadPage(page, event) {
  const root = page.doc.content();
  const labels = new Map();
  for (const row of root.all('tr')) {
    const cells = row.children.filter(c => c?.tag === 'td');
    if (cells.length === 2) labels.set(flat(cells[0]).replace(/:$/, '').toLowerCase(), flat(cells[1]));
  }
  const key = labels.get('request key') ?? labels.get('requestkey');
  const action = labels.get('action');
  const instant = labels.get('time of log') ?? labels.get('time of event');
  const module = labels.get('module id') ?? labels.get('module');
  if (key !== event.requestKey || action !== event.action || instant !== event.instant || ![event.moduleId, event.module].includes(module)) return payloadFailure(
    'SC_INTEGRATION_DETAIL_IDENTITY_MISMATCH', 'identity-unverified', event,
    'The detail page did not echo the exact request key, action, module and timestamp; no payload was returned.');
  const payload = name => {
    const candidates = root.all('pre', 'textarea').filter(n => {
      const label = page.doc.label(n).replace(/:$/, '').trim().toLowerCase();
      return label === name || [n.attr('id', ''), n.attr('name', '')].some(v => new RegExp('(?:^|[_$])(?:wt)?' + name + '(?:body|text)?$', 'i').test(v));
    });
    return candidates.length === 1 ? { text: candidates[0].children.map(c => typeof c === 'string' ? c : c.readable).join('') } : null;
  };
  const request = payload('request'), response = payload('response');
  if (!request || !response) {
    if (/request and response (?:data |content )?(?:was|were|is) not (?:logged|recorded)/i.test(root.text))
      return payloadFailure('SC_INTEGRATION_PAYLOAD_NOT_RECORDED', 'not-recorded', event,
        'The native detail page explicitly states that request and response were not recorded.', { recordingStatus: 'not-recorded', evidence: { source: page.url } });
    return payloadFailure('SC_INTEGRATION_PAYLOAD_LAYOUT_UNSUPPORTED', 'unsupported-detail-layout', event,
      'The exact detail page exposes no unique labeled request and response payload fields.');
  }
  return { ok: true, payloadStatus: 'available', event,
    request: { text: redactPayload(request.text), representation: 'redacted-native-text' },
    response: { text: redactPayload(response.text), representation: 'redacted-native-text' },
    evidence: { source: page.url, identityVerified: true }, replayed: false };
}
