// Alert engine (DESIGN section 5, 3.4 alert state): the rules of alert-rules.mjs run every 10 s; `since` is the first
// evaluation that found the alert (persisted), an alert clears after 2 consecutive false evaluations and then emits
// "Resolvido: <título>". Acks: a state alert can be silenced for 24 h or 7 days (a critical one for 24 h only); an event
// alert (acesso-outra-maquina) is marked "visto" for good. State in /state/alerts.json:
// {firstSeen, falseCount, acks, last} (`last` keeps the alerts being cleared, so hysteresis survives a restart).
import { evaluateRules } from './alert-rules.mjs';
import { ApiError, eventText } from './texts.mjs';

const FILE = 'alerts.json';
export const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };
const bySeverity = (a, b) => (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) || (a.since < b.since ? -1 : a.since > b.since ? 1 : a.id.localeCompare(b.id));

export function createAlerts({ state, now = Date.now, emit = () => {}, rules = evaluateRules }) {
  const saved = state.readJson(FILE) ?? {};
  const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const firstSeen = obj(saved.firstSeen);
  const falseCount = obj(saved.falseCount);
  const acks = obj(saved.acks);
  const current = new Map(Object.entries(obj(saved.last)));
  let written = null;

  function save() {
    const last = Object.fromEntries([...current].map(([id, a]) => [id, { ...a, lastSeen: undefined }]));
    const text = JSON.stringify({ firstSeen, falseCount, acks, last });
    if (text === written) return;
    try { state.writeText(FILE, text); written = text; } catch { /* retried at the next evaluation */ }
  }

  function evaluate(ctx) {
    const t = now();
    const at = new Date(t).toISOString();
    const seen = new Set();
    for (const c of rules({ ...ctx, now: t })) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      firstSeen[c.id] ??= at;
      delete falseCount[c.id];
      current.set(c.id, { ...c, since: firstSeen[c.id], lastSeen: at });
    }
    for (const [id, a] of [...current]) {
      if (seen.has(id)) continue;
      falseCount[id] = (falseCount[id] ?? 0) + 1;
      if (falseCount[id] >= 2) {
        current.delete(id);
        delete firstSeen[id];
        delete falseCount[id];
        delete acks[id];
        emit({ time: at, level: 'info', group: 'painel', text: eventText.resolved(a.title) });
      }
    }
    for (const id of Object.keys(firstSeen)) if (!current.has(id)) delete firstSeen[id];
    for (const [id, ack] of Object.entries(acks)) if (!current.has(id) || (ack.until && Date.parse(ack.until) <= t)) delete acks[id];
    save();
  }

  function view(a) {
    const ack = acks[a.id];
    const acked = !!ack && (ack.until === null || Date.parse(ack.until) > now());
    return { id: a.id, rule: a.rule, severity: a.severity, area: a.area, title: a.title, detail: a.detail ?? null, since: a.since,
      lastSeen: a.lastSeen ?? a.since, subject: a.subject ?? {}, view: a.view, event: !!a.event, acked, ackedUntil: acked ? ack.until ?? null : null };
  }
  function list() {
    const all = [...current.values()].map(view);
    return { alerts: all.filter(a => !a.acked).sort(bySeverity), acked: all.filter(a => a.acked).sort(bySeverity) };
  }

  // hours: 24 | 168 for state alerts (critical: 24 only), null ("visto") for event alerts only.
  function ack(id, hours) {
    const a = current.get(id);
    if (!a) throw new ApiError('NOT_FOUND');
    if (a.event) {
      if (hours !== null) throw new ApiError('INVALID_FIELD', { campo: 'hours', regra: 'alerta de evento: só "visto" (null)' }, { field: 'hours' });
    } else {
      if (hours !== 24 && hours !== 168) throw new ApiError('INVALID_FIELD', { campo: 'hours', regra: '24 ou 168' }, { field: 'hours' });
      if (a.severity === 'critical' && hours !== 24) throw new ApiError('INVALID_FIELD', { campo: 'hours', regra: 'alerta crítico: só 24 h' }, { field: 'hours' });
    }
    const t = now();
    const until = hours === null ? null : new Date(t + hours * 3600000).toISOString();
    acks[id] = { until, at: new Date(t).toISOString() };
    save();
    return { id, until, alert: view(a) };
  }
  function unack(id) {
    if (!acks[id]) throw new ApiError('NOT_FOUND');
    delete acks[id];
    save();
    const a = current.get(id);
    return { id, alert: a ? view(a) : null };
  }
  function counts() {
    const { alerts, acked } = list();
    const c = { critical: 0, warning: 0, info: 0, acked: acked.length };
    for (const a of alerts) c[a.severity]++;
    return c;
  }
  return { evaluate, list, ack, unack, counts, toJSON: () => ({ firstSeen, falseCount, acks }) };
}
