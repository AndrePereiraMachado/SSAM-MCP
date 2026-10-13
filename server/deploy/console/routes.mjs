// Routes of the API (DESIGN 4.3, DESIGN-QUALIDADE 4.4). Read routes hand over to the views (a download answers
// {file: {type, name, text}}); mutations check their body here (2.2 step 6: types,
// ranges, no unknown field), then go to licenses.mjs (confirmation, STALE, gate, token module) or to the alert engine and
// the access key, each recorded in console-audit.jsonl. New secrets exist only in the response of issue and agent-rotate.
import { onlyFields } from './http.mjs';
import { CUSTOMER_PATTERN, CUSTOMER_RULE, DAYS_RULE, LANES_RULE } from './licenses.mjs';
import { invalidField } from './texts.mjs';

const LANES = ['odc', 'o11'];
const isIso = v => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));

function lanesField(value, name) {
  if (!Array.isArray(value) || !value.length || value.length > 2 || value.some(l => !LANES.includes(l)) || new Set(value).size !== value.length) {
    throw invalidField(name, LANES_RULE);
  }
  return LANES.filter(l => value.includes(l));
}
function daysField(value, { nullable }) {
  if (value === null && nullable) return null;
  if (!Number.isInteger(value) || value < 1 || value > 3650) throw invalidField('days', DAYS_RULE);
  return value;
}
function confirmField(body) {
  if (typeof body.confirm !== 'string' || body.confirm.length > 200) throw invalidField('confirm', 'o nome do cliente, como texto');
  return body.confirm;
}
const required = (body, names) => { for (const n of names) if (!Object.hasOwn(body, n)) throw invalidField(n, 'obrigatório'); };

export function createRoutes({ views, data, quality, licenses, live, alerts, auth, history, gate, log, now = Date.now }) {
  const audit = entry => history.append({ time: new Date(now()).toISOString(), actor: 'painel', result: 'ok', ...entry });
  const urls = () => { const u = views.urls(); return { publicUrl: u.publicUrl, serverUrl: u.serverUrl }; };

  async function issue({ body }) {
    onlyFields(body, ['customer', 'days', 'lanes', 'confirm']);
    required(body, ['customer', 'days', 'lanes', 'confirm']);
    if (typeof body.customer !== 'string' || !CUSTOMER_PATTERN.test(body.customer.trim())) throw invalidField('customer', CUSTOMER_RULE);
    const days = daysField(body.days, { nullable: true });
    const lanes = lanesField(body.lanes, 'lanes');
    const r = await licenses.issue({ customer: body.customer, days: days ?? undefined, lanes, confirm: confirmField(body) });
    return { status: 201, body: { ok: true, license: views.license(r.view), secret: r.secret, ...urls(), duplicates: r.duplicates, audit: r.audit } };
  }
  async function renew({ params, body }) {
    onlyFields(body, ['days', 'confirm', 'expectExpiresAt']);
    required(body, ['days', 'confirm', 'expectExpiresAt']);
    const days = daysField(body.days, { nullable: false });
    if (body.expectExpiresAt !== null && !isIso(body.expectExpiresAt)) throw invalidField('expectExpiresAt', 'data ISO 8601 ou null');
    const r = await licenses.renew(params.id, { days, confirm: confirmField(body), expectExpiresAt: body.expectExpiresAt });
    return { body: { ok: true, license: views.license(r.view), previousExpiresAt: r.previousExpiresAt, expiresAt: r.expiresAt, audit: r.audit } };
  }
  async function lanes({ params, body }) {
    onlyFields(body, ['lanes', 'confirm', 'expectLanes']);
    required(body, ['lanes', 'confirm', 'expectLanes']);
    const next = lanesField(body.lanes, 'lanes');
    if (!Array.isArray(body.expectLanes) || body.expectLanes.length > 2 || body.expectLanes.some(l => !LANES.includes(l))) throw invalidField('expectLanes', LANES_RULE);
    const r = await licenses.setLanes(params.id, { lanes: next, confirm: confirmField(body), expectLanes: body.expectLanes });
    return { body: { ok: true, license: views.license(r.view), previousLanes: r.previousLanes, openSessions: live.sessionsOf(params.id), audit: r.audit } };
  }
  async function agentRotate({ params, body }) {
    onlyFields(body, ['confirm']);
    required(body, ['confirm']);
    const r = await licenses.agentRotate(params.id, { confirm: confirmField(body) });
    return { body: { ok: true, license: views.license(r.view), secret: r.secret, serverUrl: urls().serverUrl, audit: r.audit } };
  }
  async function revoke({ params, body }) {
    onlyFields(body, ['confirm']);
    required(body, ['confirm']);
    const r = await licenses.revoke(params.id, { confirm: confirmField(body) });
    return { body: { ok: true, license: views.license(r.view), openSessions: live.sessionsOf(params.id),
      agentConnected: live.agents.get(params.id)?.state === 'connected', audit: r.audit } };
  }
  async function ack({ body }) {
    onlyFields(body, ['id', 'hours']);
    required(body, ['id', 'hours']);
    if (typeof body.id !== 'string' || !body.id || body.id.length > 200) throw invalidField('id', 'id de um alerta');
    if (body.hours !== null && body.hours !== 24 && body.hours !== 168) throw invalidField('hours', '24, 168 ou null');
    const r = await gate.run(() => alerts.ack(body.id, body.hours));
    const subject = r.alert.subject ?? {};
    audit({ action: 'alert-ack', token: subject.token ?? null, customer: subject.customer ?? null, detail: { alert: body.id, hours: body.hours } });
    log({ console: 'action', action: 'alert-ack', token: subject.token ?? null, ok: true });
    return { body: { ok: true, id: r.id, until: r.until } };
  }
  async function unack({ body }) {
    onlyFields(body, ['id']);
    required(body, ['id']);
    if (typeof body.id !== 'string' || !body.id || body.id.length > 200) throw invalidField('id', 'id de um alerta');
    const r = await gate.run(() => alerts.unack(body.id));
    const subject = r.alert?.subject ?? {};
    audit({ action: 'alert-unack', token: subject.token ?? null, customer: subject.customer ?? null, detail: { alert: body.id } });
    log({ console: 'action', action: 'alert-unack', token: subject.token ?? null, ok: true });
    return { body: { ok: true, id: r.id } };
  }
  async function rotateKey({ body }) {
    onlyFields(body, []);
    const key = await gate.run(() => auth.rotate());
    audit({ action: 'key-rotate' });
    log({ console: 'action', action: 'key-rotate', ok: true });
    return { body: { ok: true, key } };
  }

  return {
    'GET /api/meta': () => ({ body: views.meta() }),
    'GET /api/overview': () => ({ body: views.overview() }),
    'GET /api/licenses': () => ({ body: views.licensesPayload() }),
    'GET /api/usage': ({ query }) => ({ body: data.usagePayload(query) }),
    // DESIGN-QUALIDADE 4.4: the quality tables, and their downloads as a file answer (http.mjs sendFile)
    'GET /api/quality': ({ query }) => ({ body: quality.payload(query) }),
    'GET /api/quality/export': ({ query }) => quality.exportFile(query),
    'GET /api/live': () => ({ body: views.livePayload() }),
    'GET /api/vps': () => ({ body: data.vpsPayload() }),
    'GET /api/events': ({ query }) => ({ body: views.eventsPayload(query) }),
    'GET /api/history': ({ query }) => ({ body: views.historyPayload(query) }),
    'POST /api/licenses': issue,
    'POST /api/licenses/:id/renew': renew,
    'POST /api/licenses/:id/lanes': lanes,
    'POST /api/licenses/:id/agent-rotate': agentRotate,
    'POST /api/licenses/:id/revoke': revoke,
    'POST /api/alerts/ack': ack,
    'POST /api/alerts/unack': unack,
    'POST /api/key/rotate': rotateKey,
  };
}
