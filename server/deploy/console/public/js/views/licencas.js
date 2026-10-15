// Licenças (DESIGN.md 6.5, SPEC painel v2 4.2): four KPI cards (active licenses, next expiry, calls today, workspace),
// then the license table with merged two-line cells, mini meters, its detail rows and the icon row actions that open the
// dialogs of 6.10. Polls every 10 s and right after any mutation.

import * as F from '../format.js';
import { h, statusInline, status, chip, textButton, button, iconButton, pageHead, panel, inlineNotice, select, filterInput } from '../dom.js';
import { createTable, kvTable, filterRows, compareValues } from '../table.js';
import { createCards } from '../cards.js';
import { meter, meterLevel, meterTicks } from '../charts.js';
import { icon } from '../icons.js';
import { sparkline, sparkLabel } from '../sparkline.js';
import { LICENSE_STATE, HISTORY_ACTION, wordOf } from '../labels.js';
import { errorMessage, staleText } from './common.js';
import { historyDetail } from './historico.js';

const FILTERS = [
  { value: 'ativas-vencidas', label: 'Ativas e vencidas', match: (l) => l.state === 'active' || l.state === 'expired' },
  { value: 'ativas', label: 'Ativas', match: (l) => l.state === 'active' },
  { value: 'vencidas', label: 'Vencidas', match: (l) => l.state === 'expired' },
  { value: 'revogadas', label: 'Revogadas', match: (l) => l.state === 'revoked' },
  { value: 'todas', label: 'Todas', match: () => true },
];

const ACTION_LABEL = { renew: 'Renovar', lanes: 'Faixas', agentRotate: 'Credencial do agente', revoke: 'Revogar' };
const ACTION_ICON = { renew: 'calendar-plus', lanes: 'layers', agentRotate: 'key-rotate', revoke: 'ban' };

const sum = (a) => (Array.isArray(a) ? a.reduce((s, v) => s + (Number(v) || 0), 0) : 0);

/** Default order: Estado (ativa, vencida, revogada), Validade ascending (sem validade last), Cliente. */
export function licenseCompare(a, b) {
  const sa = LICENSE_STATE[a.state]?.order ?? 9;
  const sb = LICENSE_STATE[b.state]?.order ?? 9;
  if (sa !== sb) return sa - sb;
  const ea = a.expiresAt == null ? Infinity : F.toMs(a.expiresAt);
  const eb = b.expiresAt == null ? Infinity : F.toMs(b.expiresAt);
  if (ea !== eb) return ea === Infinity ? 1 : eb === Infinity ? -1 : ea - eb;
  return compareValues(a.customer || '', b.customer || '');
}

export function workspacePct(ws) {
  if (!ws || !ws.quotaBytes) return null;
  return (Number(ws.bytes) / Number(ws.quotaBytes)) * 100;
}

export function failuresLevel(today) {
  const c = today?.calls ?? 0;
  const f = today?.failures ?? 0;
  return f >= 3 && c > 0 && f / c >= 0.25 ? 'bad' : '';
}

/**
 * The one line under the head about what this console can do with licenses (DESIGN.md 6.5), or null. capabilities.readOnly
 * (CONSOLE_LICENSE_WRITES): 'sem-trava' when the image's token module does not lock tokens.json between the console and
 * ssam-admin, 'desligado' when the owner turned the actions off.
 */
export function capabilityLine(caps) {
  if (!caps) return null;
  if (caps.readOnly === 'sem-trava') {
    return 'Ações de licença desligadas: esta imagem não trava o tokens.json entre o painel e o ssam-admin. Até a imagem do 24º envio, emita, renove e revogue pelo ssam-admin (DEPLOY.md 15.4).';
  }
  if (caps.readOnly === 'desligado') return 'Ações de licença desligadas neste painel (CONSOLE_LICENSE_WRITES=off).';
  if (caps.renew === false || caps.lanes === false) {
    return 'Renovar e mudar faixas chegam com a imagem do 24º envio; hoje dá para emitir, trocar a credencial do agente e revogar.';
  }
  return null;
}

/** `5 ativas · 1 vencida · 1 revogada` from the list. */
export function licensesSubtitle(list) {
  const n = (st) => (list || []).filter((l) => l.state === st).length;
  return [F.plural(n('active'), 'ativa', 'ativas'), F.plural(n('expired'), 'vencida', 'vencidas'), F.plural(n('revoked'), 'revogada', 'revogadas')].join(' · ');
}

const LEVEL_OF = { bad: 'bad', warn: 'warn' };

/** The four KPI cards of Licenças (pure): from the license list only. */
export function kpis(list, now) {
  const all = Array.isArray(list) ? list : [];
  const active = all.filter((l) => l.state === 'active');
  const expired = all.filter((l) => l.state === 'expired').length;
  const revoked = all.filter((l) => l.state === 'revoked').length;
  const levels = active.map((l) => F.fmtValidity(l, now).level);
  const worst = levels.includes('bad') ? 'bad' : levels.includes('warn') ? 'warn' : 'ok';
  const cards = [{
    id: 'ativas', label: 'Licenças ativas', icon: 'licencas', level: worst,
    value: F.fmtInt(active.length), unit: active.length === 1 ? 'ativa' : 'ativas',
    context: `de ${F.fmtInt(all.length)} · ${F.plural(expired, 'vencida', 'vencidas')} · ${F.plural(revoked, 'revogada', 'revogadas')}`,
    visual: all.length ? {
      kind: 'segbar', label: 'Licenças',
      parts: [
        { count: active.length, c: 'ok', word: F.plural(active.length, 'ativa', 'ativas') },
        { count: expired, c: 'warn', word: F.plural(expired, 'vencida', 'vencidas') },
        { count: revoked, c: 'muted', word: F.plural(revoked, 'revogada', 'revogadas') },
      ],
    } : null,
  }];

  const next = active.filter((l) => l.expiresAt != null && Number.isFinite(F.toMs(l.expiresAt)))
    .sort((a, b) => F.toMs(a.expiresAt) - F.toMs(b.expiresAt))[0];
  if (!next) {
    cards.push({ id: 'proxima', label: 'Próxima a vencer', icon: 'calendar', level: 'ok', value: 'nenhuma', word: true, context: 'nenhuma licença ativa com validade' });
  } else {
    const ms = F.toMs(next.expiresAt);
    const vp = F.validityParts(next, now);
    const today = F.sameLocalDay(ms, now);
    const days = F.localDayDiff(now, ms);
    const dLeft = (ms - now) / F.DAY;
    cards.push({
      id: 'proxima', label: 'Próxima a vencer', icon: 'calendar', level: LEVEL_OF[F.fmtValidity(next, now).level] || 'ok',
      value: today ? 'hoje' : F.fmtInt(Math.max(1, days)), word: today, unit: today ? `às ${F.fmtTime(ms)}` : (Math.max(1, days) === 1 ? 'dia' : 'dias'),
      context: `${next.customer} · até ${F.fmtDate(ms)}`,
      visual: vp.fraction != null ? {
        kind: 'meter', label: 'Parte restante da validade', caption: 'parte restante da validade', fraction: vp.fraction,
        level: meterLevel('validity', dLeft), valueText: F.fmtPct(vp.fraction * 100),
      } : null,
    });
  }

  const calls = sum(all.map((l) => l.today?.calls));
  const fails = sum(all.map((l) => l.today?.failures));
  const days14 = [];
  for (const l of all) (l.daily14 || []).forEach((v, i) => { days14[i] = (days14[i] || 0) + (Number(v) || 0); });
  cards.push({
    id: 'chamadas', label: 'Chamadas hoje', icon: 'uso', level: failuresLevel({ calls, failures: fails }) === 'bad' ? 'bad' : 'ok',
    value: F.fmtInt(calls), unit: calls === 1 ? 'chamada' : 'chamadas',
    context: calls ? `${F.plural(fails, 'falha', 'falhas')} (${F.fmtShare(fails, calls)})` : 'sem chamadas',
    visual: days14.length >= 2 ? { kind: 'spark', values: days14, label: sparkLabel('Chamadas por dia', days14) } : null,
  });

  let top = null;
  for (const l of all) {
    if (l.state === 'revoked') continue;
    const p = workspacePct(l.workspace);
    if (p != null && (!top || p > top.p)) top = { l, p };
  }
  if (!top) {
    cards.push({ id: 'espaco', label: 'Espaço', icon: 'disk', level: 'ok', value: 'sem coleta', word: true, muted: true });
  } else {
    const ws = top.l.workspace;
    cards.push({
      id: 'espaco', label: 'Espaço', icon: 'disk', level: meterLevel('workspace', top.p),
      value: F.fmtPct(top.p), unit: 'maior uso', context: `${top.l.customer} · ${F.fmtBytes(ws.bytes)} de ${F.fmtBytes(ws.quotaBytes)}`,
      visual: {
        kind: 'meter', label: 'Maior uso de espaço', caption: 'da cota', fraction: top.p / 100, level: meterLevel('workspace', top.p),
        ticks: meterTicks('workspace'), valueText: F.fmtPct(top.p),
      },
    });
  }
  return cards;
}

const CARD_DEFS = [
  { id: 'ativas', label: 'Licenças ativas', icon: 'licencas' }, { id: 'proxima', label: 'Próxima a vencer', icon: 'calendar' },
  { id: 'chamadas', label: 'Chamadas hoje', icon: 'uso' }, { id: 'espaco', label: 'Espaço', icon: 'disk' },
];

export default function createLicencas(ctx, section) {
  const { clock } = ctx;
  let lastOk = null;
  let licenses = null;
  let live = null;
  let capabilities = null;
  let text = '';
  let filterId = 'ativas-vencidas';
  const open = new Set();

  const head = pageHead('t-licencas', 'Licenças');
  const issueBtn = button('Emitir licença', (e) => ctx.dialogs.issue(e.currentTarget, licenses || []), 'primary', { id: 'btn-issue', icon: 'plus' });
  head.actions.append(issueBtn);
  const capLine = inlineNotice('info', '');
  capLine.el.hidden = true;
  const cards = createCards('licencas', CARD_DEFS);

  const filter = filterInput('filtrar por cliente ou token', (v) => {
    text = v;
    applyFilter();
  });
  const sel = select('Estado das licenças', FILTERS, {
    value: filterId,
    onChange: (v) => {
      filterId = v;
      applyFilter();
    },
  });
  const listP = panel('h-licencas', 'Licenças', { controls: [filter.wrapEl, sel], toolbar: true });

  function accessAlertId(lic) {
    const alerts = ctx.store.overview?.alerts || [];
    const a = alerts.find((x) => x.rule === 'acesso-outra-maquina' && x.subject?.token === lic.id);
    return a ? a.id : null;
  }

  function toggle(lic) {
    if (open.has(lic.id)) open.delete(lic.id);
    else open.add(lic.id);
    table.rerender();
  }

  function sessionsOf(lic) {
    const all = live?.sessions || [];
    return all.filter((s) => s.token === lic.id);
  }

  function rowActions(lic, td) {
    const a = lic.actions || {};
    const group = h('span', { class: 'btn-group' });
    const add = (key, fn) => {
      if (!a[key]?.allowed) return;
      group.append(iconButton(ACTION_ICON[key], ACTION_LABEL[key], (e) => fn(e.currentTarget),
        { class: ['btn-sm', key === 'revoke' && 'danger'].filter(Boolean).join(' '), dataset: { fk: key } }));
    };
    add('renew', (el) => ctx.dialogs.renew(el, lic));
    add('lanes', (el) => ctx.dialogs.lanes(el, lic, sessionsOf(lic)));
    add('agentRotate', (el) => ctx.dialogs.agentRotate(el, lic));
    add('revoke', (el) => ctx.dialogs.revoke(el, lic, sessionsOf(lic)));
    td.append(group.childNodes.length ? group : F.DASH);
  }

  function detail(lic, td) {
    const now = clock.now();
    const m = lic.machine;
    const accessAlerts = (ctx.store.overview?.alerts || []).filter((x) => x.rule === 'acesso-outra-maquina' && x.subject?.token === lic.id);
    const sessions = sessionsOf(lic);
    const unavailable = Object.entries(lic.actions || {}).filter(([, v]) => v && !v.allowed);
    const hist = Array.isArray(lic.history) ? lic.history.slice(0, 5) : [];
    const lines = (arr) => (cell) => {
      if (!arr.length) {
        cell.textContent = 'nenhum';
        return;
      }
      for (const t of arr) cell.append(h('span', { class: 'line' }, t));
    };
    const left = [
      { label: 'Criada em', value: F.fmtDateTime(lic.createdAt), title: F.fmtTitle(lic.createdAt) },
      {
        label: 'Validade',
        value: lic.expiresAt ? `${F.fmtDateTime(lic.expiresAt)} (${F.fmtUtcDateTime(lic.expiresAt)})` : 'sem validade',
      },
      { label: 'Revogada em', value: lic.revokedAt ? F.fmtDateTime(lic.revokedAt) : F.DASH },
      { label: 'Credencial do agente emitida em', value: lic.agentCredentialIssuedAt ? F.fmtDateTime(lic.agentCredentialIssuedAt) : F.DASH },
      {
        label: 'Máquina registrada',
        value: m ? `${F.fmtMachine(m)}, id ${m.id ?? F.DASH}, desde ${F.fmtDateTime(m.at)}` : 'nenhuma',
      },
      {
        label: 'Alertas de acesso',
        value: lines(accessAlerts.length
          ? accessAlerts.map((x) => `${F.fmtDateTime(x.since)} · ${x.subject?.machine ?? F.DASH} · IP ${x.subject?.ip ?? F.DASH}`)
          : (lic.accessAlerts ? [F.plural(lic.accessAlerts, 'alerta', 'alertas')] : [])),
      },
    ];
    const right = [
      {
        label: 'Sessões abertas',
        value: lines(sessions.map((s) => `${s.client || 'cliente sem nome'} · IP ${s.ip ?? F.DASH} · aberta há ${F.fmtDuration(now - F.toMs(s.openedAt))}`)),
      },
      {
        label: 'Ações indisponíveis',
        value: lines(unavailable.map(([k, v]) => `${ACTION_LABEL[k] || k}: ${v.reason || 'indisponível'}`)),
      },
      {
        label: 'Histórico',
        value: lines(hist.map((e) => [
          F.fmtDateTime(e.time), wordOf(HISTORY_ACTION, e.action) || e.action, historyDetail(e), e.actor === 'externo' ? 'fora do painel' : 'painel',
          e.result === 'error' ? `erro ${e.code || ''}`.trim() : null,
        ].filter((x) => x && x !== F.DASH).join(' · '))),
      },
      {
        label: 'Uso',
        value: (cell) => cell.append(textButton('Ver uso desta licença', () => ctx.navigate('uso', { token: lic.id }), { dataset: { fk: 'uso' }, icon: 'arrow-right' })),
      },
      {
        label: 'Qualidade',
        value: (cell) => cell.append(textButton('Ver qualidade desta licença', () => ctx.navigate('qualidade', { token: lic.id }), { dataset: { fk: 'qualidade' }, icon: 'arrow-right' })),
      },
    ];
    td.append(h('div', { class: 'detail-grid' },
      kvTable(left, { label: `Detalhes de ${lic.customer}` }),
      kvTable(right, { label: `Sessões, ações e histórico de ${lic.customer}` })));
  }

  const maxSessions = () => live?.server?.maxSessionsPerToken ?? null;

  const table = createTable({
    label: 'Licenças',
    dense: true,
    cls: 'licencas-grid',
    columns: [
      {
        key: 'customer', label: 'Cliente', subLabel: 'token', sort: (r) => r.customer,
        cell: (r, td) => {
          const isOpen = open.has(r.id);
          const b = h('button', {
            type: 'button', class: 'rowtoggle', 'aria-expanded': isOpen ? 'true' : 'false', title: r.customer, dataset: { fk: 'toggle' },
          }, icon(isOpen ? 'chevron-down' : 'chevron-right', 16), h('span', { class: 'rt-name' }, r.customer));
          b.addEventListener('click', () => toggle(r));
          td.append(b);
        },
        sub: (r) => h('span', { class: 'mono', title: r.id }, r.id),
      },
      {
        key: 'state', label: 'Estado', subLabel: 'faixas', sort: (r) => LICENSE_STATE[r.state]?.order ?? 9, firstDir: 'asc',
        cell: (r, td) => {
          const s = LICENSE_STATE[r.state] || { word: r.state, level: 'muted' };
          td.append(status(s.level, s.word));
        },
        sub: (r) => {
          const lanes = F.fmtLanes(r.lanes, '|');
          return lanes === F.DASH ? F.DASH : h('span', { class: 'chips' }, lanes.split('|').map((l) => chip(l)));
        },
      },
      {
        key: 'expiresAt', label: 'Validade', sort: (r) => (r.expiresAt == null ? null : F.toMs(r.expiresAt)), firstDir: 'asc',
        cell: (r, td) => {
          const v = F.validityParts(r, clock.now());
          td.append(h('span', { class: v.level ? `lv-${v.level} strong` : null }, v.main));
          const t = r.state === 'revoked' ? r.revokedAt : r.expiresAt;
          if (t) td.title = `${F.fmtValidity(r, clock.now()).text} · ${F.fmtTitle(t)}`;
        },
        sub: (r) => {
          const now = clock.now();
          const v = F.validityParts(r, now);
          const out = h('span', null, v.sub || F.DASH);
          if (v.fraction != null) {
            const left = (F.toMs(r.expiresAt) - now) / F.DAY;
            out.append(meter({ label: `Validade restante de ${r.customer}`, fraction: v.fraction, level: meterLevel('validity', left), mini: true, cls: 'mblock', valueText: F.fmtPct(v.fraction * 100) }).el);
          }
          return out;
        },
      },
      {
        key: 'agent', label: 'Agente', subLabel: 'máquina',
        sort: (r) => (r.state === 'revoked' ? 3 : { connected: 0, disconnected: 1, never: 2 }[r.agent?.state] ?? 2), firstDir: 'asc',
        cell: (r, td) => {
          const a = r.agent || { state: 'never' };
          if (r.state === 'revoked') td.append(F.DASH);
          else if (a.state === 'connected') {
            td.append(statusInline('ok', 'conectado'));
            if (a.since) td.title = `desde ${F.fmtTitle(a.since)}`;
          } else if (a.state === 'disconnected') {
            const when = a.since ? ` ${F.fmtRelative(a.since, clock.now())}` : '';
            td.append(statusInline('muted', `desconectado${when}`));
            if (a.since) td.title = F.fmtTitle(a.since);
          } else td.append(statusInline('muted', 'sem registro'));
        },
        sub: (r) => {
          const txt = F.fmtMachine(r.machine);
          const out = h('span', null, h('span', { class: 'ell-line ell-name18', title: txt }, txt));
          if (r.accessAlerts > 0) {
            const link = textButton('trocou de máquina', () => {
              const id = accessAlertId(r);
              ctx.navigate('visao', null, id ? { alertId: id } : null);
            }, { class: 'lv-bad', dataset: { fk: 'machine-alert' } });
            out.append(h('span', { class: 't3' }, icon('alert-triangle', 14), link));
          }
          return out;
        },
      },
      {
        key: 'sessionsOpen', label: 'Sessões', num: true, sort: (r) => r.sessionsOpen ?? 0,
        cell: (r, td) => {
          const n = r.sessionsOpen ?? 0;
          const max = maxSessions();
          td.append(F.fmtInt(n));
          if (max) td.append(h('span', { class: 'muted' }, ` de ${F.fmtInt(max)}`));
        },
        sub: (r) => {
          const max = maxSessions();
          if (!max || r.state === 'revoked') return null;
          const n = r.sessionsOpen ?? 0;
          return meter({ label: `Sessões abertas de ${r.customer}`, fraction: n / max, level: meterLevel('seats', n / max), mini: true, cls: 'w40', valueText: `${F.fmtInt(n)} de ${F.fmtInt(max)}` }).el;
        },
      },
      { key: 'calls', label: 'Chamadas hoje', num: true, sort: (r) => r.today?.calls ?? 0, text: (r) => F.fmtInt(r.today?.calls ?? 0) },
      {
        key: 'failures', label: 'Falhas hoje', num: true, sort: (r) => r.today?.failures ?? 0,
        text: (r) => F.fmtInt(r.today?.failures ?? 0), level: (r) => failuresLevel(r.today), cls: 'lvstrong',
      },
      {
        key: 'daily14', label: 'Uso 14 dias', sort: (r) => sum(r.daily14), firstDir: 'desc', cls: 'sparkcell',
        cell: (r, td) => td.append(sparkline(r.daily14 || [], sparkLabel('Chamadas por dia', r.daily14 || []), { w: 72, h: 20 })),
      },
      {
        key: 'workspace', label: 'Espaço', num: true, sort: (r) => r.workspace?.bytes ?? null,
        cell: (r, td) => {
          const ws = r.workspace;
          if (!ws) {
            td.textContent = F.DASH;
            return;
          }
          td.append(F.fmtBytes(ws.bytes));
          td.title = `${F.fmtInt(ws.files)} arquivos de ${F.fmtBytes(ws.quotaBytes)} de cota${ws.truncated ? ' (contagem parcial)' : ''} · medido ${F.fmtTitle(ws.measuredAt)}`;
        },
        sub: (r) => {
          const p = workspacePct(r.workspace);
          if (p == null) return null;
          const lv = meterLevel('workspace', p);
          return h('span', null, h('span', { class: lv === 'ok' ? null : `lv-${lv} strong` }, F.fmtPct(p)),
            meter({ label: `Espaço de ${r.customer}`, fraction: p / 100, level: lv, ticks: meterTicks('workspace'), mini: true, cls: 'w48 mblock', valueText: F.fmtPct(p) }).el);
        },
      },
      {
        key: 'lastActivity', label: 'Última atividade', flex: true, cls: 'flex-narrow', sort: (r) => (r.lastActivity ? F.toMs(r.lastActivity.at) : null), firstDir: 'desc',
        cell: (r, td) => {
          const la = r.lastActivity;
          if (!la) {
            td.textContent = F.DASH;
            return;
          }
          td.append(F.fmtRelative(la.at, clock.now()));
          td.title = F.fmtTitle(la.at);
        },
        sub: (r) => (r.lastActivity?.kind === 'call' && r.lastActivity.tool ? h('span', { class: 'mono', title: r.lastActivity.tool }, r.lastActivity.tool) : null),
      },
      { key: 'actions', label: 'Ações', sort: false, cls: 'actions', cell: (r, td) => rowActions(r, td) },
    ],
    rowKey: (r) => r.id,
    rowClass: (r) => (r.state === 'revoked' ? 'is-muted' : null),
    defaultSort: { key: 'state', dir: 'asc', compare: licenseCompare },
    empty: 'Nenhuma licença. Use Emitir licença para criar a primeira.',
    filteredEmpty: 'Nenhuma licença com esse filtro.',
    detail: { isOpen: (r) => open.has(r.id), render: detail },
  });
  listP.el.append(table.el);

  section.append(head.el, capLine.el, cards.el, listP.el);

  function applyFilter() {
    const f = FILTERS.find((x) => x.value === filterId) || FILTERS[0];
    const q = text;
    const isDefault = !q.trim() && filterId === 'todas';
    if (isDefault) table.setFilter(null);
    else {
      table.setFilter((r) => f.match(r) && (!q.trim() || filterRows([r], q, ['customer', 'id']).length > 0));
    }
    listP.setCount(table.countText());
  }

  function render() {
    capabilities = ctx.store.licensesCaps || capabilities;
    const line = capabilityLine(capabilities);
    capLine.set(line || '');
    capLine.el.hidden = !line;
    issueBtn.hidden = capabilities?.issue === false;
    head.setSub(licensesSubtitle(licenses));
    cards.render(kpis(licenses || [], clock.now()));
    table.setRows(licenses || []);
    applyFilter();
    listP.setStale('');
  }

  return {
    interval: () => 10000,
    async refresh() {
      const [lr, vr] = await Promise.allSettled([ctx.api.licenses(), ctx.api.live()]);
      if (vr.status === 'fulfilled') {
        live = vr.value;
        ctx.store.live = live;
      }
      if (lr.status === 'rejected') {
        const e = lr.reason;
        if (e?.kind === 'auth') throw e;
        table.setError(errorMessage(e));
        if (table.hasRows()) listP.setStale(staleText(lastOk));
        cards.error(errorMessage(e), lastOk ? `dados de ${F.fmtTimeSec(lastOk)}` : '');
        throw e;
      }
      const d = lr.value;
      licenses = Array.isArray(d.licenses) ? d.licenses : [];
      capabilities = d.capabilities || null;
      ctx.store.licenses = licenses;
      ctx.store.licensesCaps = capabilities;
      ctx.store.licensesAt = clock.now();
      lastOk = clock.now();
      render();
    },
    show() {
      if (licenses) render();
    },
    focusFilter() {
      filter.focus();
      return true;
    },
    focusSubject(subject) {
      const id = subject?.token;
      if (!id) return;
      let tr = table.rowElement(id);
      if (!tr && licenses && licenses.some((l) => l.id === id)) {
        filterId = 'todas';
        sel.value = 'todas';
        text = '';
        filter.value = '';
        applyFilter();
        tr = table.rowElement(id);
      }
      if (tr) {
        const b = tr.querySelector('.rowtoggle');
        if (b) b.focus();
        tr.scrollIntoView({ block: 'center' });
      }
    },
  };
}
