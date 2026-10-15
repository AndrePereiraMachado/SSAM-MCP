// Visão geral (DESIGN.md 6.5, SPEC painel v2 4.1): the alerts that need attention first (grouped by severity, the
// first 3 rows on one line each until `Mostrar todos`), then one card per area of the Resumo (value, context, meter or
// gauges, the Detalhe line, `Ver`), then the last events. Polls the overview every 5 s (the same request feeds the top bar and the sidebar).

import * as F from '../format.js';
import { h, clear, status, textButton, button, chip, iconChip, pageHead, panel } from '../dom.js';
import { createTable } from '../table.js';
import { createCards } from '../cards.js';
import { icon } from '../icons.js';
import { meterLevel, meterTicks } from '../charts.js';
import { SEVERITY, AREA, SUMMARY_AREA, SUMMARY_STATE, WARM_WORD, HEALTH_WORD, SERVER_WORD } from '../labels.js';
import { relTime, relSort, eventColumns, errorMessage, staleText } from './common.js';

const isCron = (c) => (c && typeof c === 'object' ? !!c.backup : !!c);

/** Agora / Detalhe texts of a Resumo row (DESIGN.md 6.5). */
export function summaryTexts(row, ov, now) {
  const f = row.facts || {};
  const st = ov?.status || {};
  switch (row.area) {
    case 'servidor': {
      const state = st.server?.state || 'unknown';
      const pid = f.pid != null ? ` (pid ${f.pid})` : '';
      let agora;
      if (state === 'up' && f.since) agora = `no ar há ${F.fmtDuration(now - F.toMs(f.since))}${pid}`;
      else agora = `${(SERVER_WORD[state] || SERVER_WORD.unknown).word}${pid}`;
      const det = [f.imageTag, WARM_WORD[f.warm] || null, f.probeMs != null ? `/health ${F.fmtDuration(f.probeMs)}` : null];
      return { agora, detalhe: det.filter(Boolean).join(' · ') || F.DASH };
    }
    case 'licencas': {
      const agora = [
        F.plural(f.active ?? 0, 'ativa', 'ativas'),
        F.plural(f.expired ?? 0, 'vencida', 'vencidas'),
        F.plural(f.revoked ?? 0, 'revogada', 'revogadas'),
      ].join(' · ');
      const nx = f.nextExpiry;
      const soon = nx && F.toMs(nx.expiresAt) - now <= 30 * F.DAY;
      const detalhe = soon
        ? `próxima a vencer: ${nx.customer} ${F.fmtExpiresIn(nx.expiresAt, now)}`
        : 'nenhuma vence em 30 dias';
      return { agora, detalhe };
    }
    case 'uso': {
      const calls = f.calls ?? 0;
      const agora = calls
        ? `${F.plural(calls, 'chamada', 'chamadas')} · ${F.plural(f.failures ?? 0, 'falha', 'falhas')} (${F.fmtShare(f.failures ?? 0, calls)})`
        : '0 chamadas';
      const active = F.plural(f.customersActive ?? 0, 'cliente ativo', 'clientes ativos');
      const detalhe = f.p90Ms != null ? `p90 ${F.fmtDuration(f.p90Ms)} · ${active}` : active;
      return { agora, detalhe };
    }
    case 'agentes': {
      const c = f.connected ?? 0;
      const agora = `${F.fmtInt(c)} ${c === 1 ? 'conectado' : 'conectados'} de ${F.plural(f.activeLicenses ?? 0, 'licença ativa', 'licenças ativas')}`;
      const detalhe = f.lastSignalAt ? `último sinal ${F.fmtRelative(f.lastSignalAt, now)}` : 'nenhum sinal registrado';
      return { agora, detalhe };
    }
    case 'sessoes': {
      const top = Array.isArray(f.top) ? f.top : [];
      return {
        agora: F.plural(f.open ?? 0, 'aberta', 'abertas'),
        detalhe: top.length ? top.map((t) => `${t.customer} (${t.client || 'cliente sem nome'})`).join(', ') : 'nenhuma',
      };
    }
    case 'vps': {
      if (f.cpuPct == null && f.memUsedPct == null && f.diskUsedPct == null) return { agora: 'sem dados do coletor', detalhe: F.DASH };
      let detalhe = 'sem reinício pendente';
      if (f.rebootRequired == null) detalhe = 'reinício pendente: sem dados';
      else if (f.rebootRequired) detalhe = f.rebootSince ? `reinício pendente desde ${F.fmtDate(f.rebootSince)}` : 'reinício pendente';
      return {
        agora: `CPU ${F.fmtPct(f.cpuPct)} · memória ${F.fmtPct(f.memUsedPct)} · disco ${F.fmtPct(f.diskUsedPct)}`,
        detalhe,
      };
    }
    case 'containers': {
      if (f.total == null) return { agora: 'sem dados do coletor', detalhe: F.DASH };
      const unhealthy = Array.isArray(f.unhealthy) ? f.unhealthy : [];
      const health = unhealthy.length
        ? `com falha: ${unhealthy.join(', ')}`
        : `ssam-server ${HEALTH_WORD[st.server?.health] || 'sem verificação de saúde'}`;
      return {
        agora: `${F.fmtInt(f.running ?? 0)} de ${F.fmtInt(f.total)} rodando`,
        detalhe: `${health} · ${F.plural(f.restarts24h ?? 0, 'reinício', 'reinícios')} em 24 h`,
      };
    }
    case 'backup': {
      const agora = f.newestAt ? `último ${F.fmtRelative(f.newestAt, now)} (${F.fmtDateTime(f.newestAt)})` : 'nenhum backup';
      return { agora, detalhe: isCron(f.cron) ? 'cron diário ativo' : 'cron diário ausente' };
    }
    case 'tls': {
      if (!f.notAfter) return { agora: 'nenhum certificado', detalhe: F.DASH };
      const ms = F.toMs(f.notAfter);
      const d = f.daysLeft != null ? Math.floor(f.daysLeft) : Math.floor((ms - now) / F.DAY);
      const agora = ms <= now ? `venceu em ${F.fmtDate(ms)}` : `vence em ${F.plural(Math.max(0, d), 'dia', 'dias')} (${F.fmtDate(ms)})`;
      return { agora, detalhe: [f.name, f.issuer].filter(Boolean).join(' · ') || F.DASH };
    }
    case 'coletor': {
      const errs = Array.isArray(f.sectionErrors) ? f.sectionErrors.length : (f.sectionErrors ?? 0);
      const agora = f.collectedAt ? `coletado ${F.fmtRelative(f.collectedAt, now)}` : 'sem dados do coletor';
      return { agora, detalhe: F.plural(errs, 'seção com erro', 'seções com erro') };
    }
    default:
      return { agora: F.DASH, detalhe: F.DASH };
  }
}

export function alertCompare(a, b) {
  const sa = SEVERITY[a.severity]?.order ?? 9;
  const sb = SEVERITY[b.severity]?.order ?? 9;
  if (sa !== sb) return sa - sb;
  return (F.toMs(a.since) || 0) - (F.toMs(b.since) || 0);
}

// ---------------------------------------------------------------- area cards (pure)

const STATE_LEVEL = { ok: 'ok', warning: 'warn', critical: 'bad', unknown: 'unknown' };
const AREA_ICON = {
  servidor: 'server', licencas: 'licencas', uso: 'uso', agentes: 'agentes', sessoes: 'session', vps: 'vps', containers: 'container',
  backup: 'backup', tls: 'lock', coletor: 'radar',
};
/** Placement of SPEC 4.1 (fills 12 slots at 4 tracks): the four quick areas, Uso hoje and VPS (w2), then the four host areas. */
export const AREA_ORDER = ['servidor', 'licencas', 'agentes', 'sessoes', 'uso', 'vps', 'containers', 'backup', 'tls', 'coletor'];
const AREA_SPAN = { uso: 'w2', vps: 'w2' };
const cap1 = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const pctGauge = (label, id, v, caption) => ({
  label, value: v, max: 100, level: meterLevel(id, v), display: F.fmtPct(v), ticks: meterTicks(id), caption,
});
/** Alert rules of Uso that speak of the last 15 min, not of the day. */
const USO_NOW_RULES = ['pico-falhas', 'limite-taxa'];

/** The most severe open (not silenced) alert of an area, optionally of some rules only; null when there is none. */
export function areaAlert(ov, area, rules) {
  const list = (Array.isArray(ov?.alerts) ? ov.alerts : []).filter((a) => a && a.area === area && (!rules || rules.includes(a.rule)));
  return list.sort(alertCompare)[0] || null;
}

/**
 * One area card of the Resumo (SPEC 4.1): {id, label, icon, span, level, pill, value, unit, word, muted, context, detail,
 * visual, layout}. Every number comes from the row's facts; a missing datum is a word, never 0.
 */
export function areaCard(row, ov, now) {
  const f = row.facts || {};
  const st = ov?.status || {};
  const t = summaryTexts(row, ov, now);
  const s = SUMMARY_STATE[row.state] || SUMMARY_STATE.unknown;
  const base = {
    id: row.area, label: SUMMARY_AREA[row.area] || row.area, icon: AREA_ICON[row.area] || 'info', span: AREA_SPAN[row.area],
    level: STATE_LEVEL[row.state] || 'unknown', pill: { level: s.level, word: s.word },
    detail: t.detalhe && t.detalhe !== F.DASH ? t.detalhe : null,
    value: null, unit: null, context: null, visual: null,
  };
  const unknown = row.state === 'unknown';
  switch (row.area) {
    case 'servidor': {
      const state = st.server?.state || 'unknown';
      const ctx = [];
      if (state === 'up' && f.since) ctx.push(`há ${F.fmtDuration(now - F.toMs(f.since))}`);
      if (f.pid != null) ctx.push(`pid ${f.pid}`);
      return { ...base, value: cap1((SERVER_WORD[state] || SERVER_WORD.unknown).word), word: true, context: ctx.join(' · ') || null };
    }
    case 'licencas': {
      const a = f.active ?? 0;
      const e = f.expired ?? 0;
      const r = f.revoked ?? 0;
      const parts = [
        { count: a, c: 'ok', word: F.plural(a, 'ativa', 'ativas') },
        { count: e, c: 'warn', word: F.plural(e, 'vencida', 'vencidas') },
        { count: r, c: 'muted', word: F.plural(r, 'revogada', 'revogadas') },
      ];
      return {
        ...base, value: F.fmtInt(a), unit: a === 1 ? 'ativa' : 'ativas',
        context: `${F.plural(e, 'vencida', 'vencidas')} · ${F.plural(r, 'revogada', 'revogadas')}`,
        visual: a + e + r > 0 ? { kind: 'segbar', parts, label: 'Licenças' } : null,
      };
    }
    case 'agentes': {
      const c = f.connected ?? 0;
      const lic = f.activeLicenses ?? 0;
      return {
        ...base, value: F.fmtInt(c), unit: `de ${F.fmtInt(lic)} conectados`,
        visual: lic > 0 ? {
          kind: 'meter', label: 'Agentes conectados', caption: 'licenças ativas com agente', fraction: c / lic, level: 'accent',
          valueText: F.fmtPct((c / lic) * 100),
        } : null,
      };
    }
    case 'sessoes': {
      const n = f.open ?? 0;
      return { ...base, value: F.fmtInt(n), unit: n === 1 ? 'aberta' : 'abertas' };
    }
    case 'uso': {
      const calls = f.calls ?? 0;
      const fails = f.failures ?? 0;
      const pct = calls ? ((calls - fails) / calls) * 100 : null;
      const share = calls ? `${F.plural(fails, 'falha', 'falhas')} (${F.fmtShare(fails, calls)})` : 'sem chamadas';
      // The gauge is the whole day; a spike of the last 15 min (pico-falhas, limite-taxa) is what makes the card red, so
      // its sentence takes the context line with the severity dot and the day's failures move under the gauge.
      const now15 = areaAlert(ov, 'uso', USO_NOW_RULES);
      return {
        ...base, value: F.fmtInt(calls), unit: calls === 1 ? 'chamada' : 'chamadas', layout: 'split',
        context: now15 ? now15.title : share,
        contextLevel: now15 ? (SEVERITY[now15.severity] || SEVERITY.info).level : null,
        visual: {
          kind: 'gauges',
          items: [{ ...pctGauge('Sucesso no dia', 'success', pct, now15 && calls ? share : undefined), missingText: 'sem chamadas' }],
        },
      };
    }
    case 'vps': {
      const none = f.cpuPct == null && f.memUsedPct == null && f.diskUsedPct == null;
      return {
        ...base,
        visual: none ? { kind: 'gauges', empty: 'sem dados do coletor', items: [] } : {
          kind: 'gauges',
          items: [
            pctGauge('CPU', 'cpu', f.cpuPct),
            pctGauge('Memória', 'mem', f.memUsedPct),
            pctGauge('Disco', 'disk', f.diskUsedPct, 'disco mais cheio'),
          ],
        },
      };
    }
    case 'containers': {
      if (f.total == null) return { ...base, value: 'sem coleta', word: true, muted: true };
      const run = f.running ?? 0;
      return {
        ...base, value: F.fmtInt(run), unit: `de ${F.fmtInt(f.total)} rodando`,
        visual: f.total > 0 ? {
          kind: 'segbar', label: 'Containers',
          parts: [{ count: run, c: 'ok', word: `${F.fmtInt(run)} rodando` }, { count: f.total - run, c: 'bad', word: `${F.fmtInt(f.total - run)} parados` }],
        } : null,
      };
    }
    case 'backup': {
      if (!f.newestAt) {
        if (unknown) return { ...base, value: 'sem coleta', word: true, muted: true };
        return { ...base, value: 'nenhum', word: true };
      }
      const ageH = f.ageH != null ? Number(f.ageH) : (now - F.toMs(f.newestAt)) / F.HOUR;
      return {
        ...base, value: F.fmtDuration(ageH * F.HOUR), unit: 'desde o último', context: F.fmtDateTime(f.newestAt),
        visual: {
          kind: 'meter', label: 'Idade do último backup', caption: 'idade (limite 26 h)', fraction: Math.min(ageH, 48) / 48,
          level: meterLevel('backup', ageH), ticks: meterTicks('backup'), valueText: F.fmtDuration(ageH * F.HOUR),
        },
      };
    }
    case 'tls': {
      if (!f.notAfter) {
        if (unknown) return { ...base, value: 'sem coleta', word: true, muted: true };
        return { ...base, value: 'nenhum', word: true };
      }
      const ms = F.toMs(f.notAfter);
      if (ms <= now) return { ...base, value: 'venceu', word: true, context: `venceu em ${F.fmtDate(ms)}` };
      const days = f.daysLeft != null ? Number(f.daysLeft) : (ms - now) / F.DAY;
      const d = Math.floor(days);
      return {
        ...base, value: F.fmtInt(d), unit: d === 1 ? 'dia' : 'dias', context: `vence em ${F.fmtDate(ms)}`,
        visual: {
          kind: 'meter', label: 'Dias restantes do certificado', caption: 'dias restantes', fraction: Math.min(days, 90) / 90,
          level: meterLevel('tls', days), ticks: meterTicks('tls'), valueText: F.plural(d, 'dia', 'dias'),
        },
      };
    }
    case 'coletor': {
      if (f.ageS == null) return { ...base, value: 'sem coleta', word: true, muted: true };
      return {
        ...base, value: F.fmtAgeS(f.ageS), unit: 'desde a coleta',
        visual: {
          kind: 'meter', label: 'Frescor da coleta', caption: 'frescor', fraction: Math.min(Number(f.ageS), 300) / 300,
          level: meterLevel('collector', f.ageS), ticks: meterTicks('collector'), valueText: F.fmtAgeS(f.ageS),
        },
      };
    }
    default:
      return { ...base, value: t.agora, word: true };
  }
}

/** Every area card of an overview, in the placement order (unknown areas last). */
export function kpis(ov, now) {
  const rows = Array.isArray(ov?.summary) ? ov.summary.slice() : [];
  const rank = (a) => {
    const i = AREA_ORDER.indexOf(a);
    return i < 0 ? 99 : i;
  };
  rows.sort((a, b) => rank(a.area) - rank(b.area));
  return rows.map((r) => areaCard(r, ov, now));
}

/** Subtitle: `46 alertas abertos · 19 críticos · 2 silenciados` (zero parts omitted). */
export function alertsSubtitle(a) {
  const x = a || {};
  const open = (x.critical || 0) + (x.warning || 0) + (x.info || 0);
  const parts = [];
  if (open) {
    parts.push(F.plural(open, 'alerta aberto', 'alertas abertos'));
    if (x.critical) parts.push(F.plural(x.critical, 'crítico', 'críticos'));
  } else parts.push('Nenhum alerta aberto');
  if (x.acked) parts.push(F.plural(x.acked, 'silenciado', 'silenciados'));
  return parts.join(' · ');
}

const SEV_ICON = { critical: ['alert-octagon', 'bad'], warning: ['alert-triangle', 'warn'], info: ['info', 'info'] };
/** Collapsed Alertas: the first 3 rows, one line each (title, then the detail, cut with `…`; the whole text in the title),
 * so the first row of area cards stays on the first screen of the owner's 1400 x 900 window. */
export const COLLAPSED = 3;

export default function createVisao(ctx, section) {
  const { clock } = ctx;
  let lastOk = null;
  let showAcked = false;
  let expanded = false;

  const head = pageHead('t-visao', 'Visão geral');

  // ---- Alertas
  const ackToggle = button('', () => {
    showAcked = !showAcked;
    render();
  }, '', { class: 'btn-sm', icon: 'bell-off', 'aria-expanded': 'false', dataset: { fk: 'acked' }, hidden: true });
  const ackLabel = h('span');
  ackToggle.append(ackLabel);
  const alertsP = panel('h-alertas', 'Alertas', { icon: 'bell', controls: [ackToggle] });
  const severityCol = {
    key: 'severity', label: 'Gravidade', sort: (r) => SEVERITY[r.severity]?.order ?? 9, firstDir: 'asc',
    cell: (r, td) => {
      const s = SEVERITY[r.severity] || SEVERITY.info;
      const [ic, lv] = SEV_ICON[r.severity] || SEV_ICON.info;
      td.append(h('span', { class: ['sevcell', `lv-${lv}`] }, iconChip(ic, lv, 16), s.word));
    },
  };
  const alertCol = {
    key: 'title', label: 'Alerta', wrap: true, flex: true, sort: (r) => r.title,
    cell: (r, td) => {
      td.append(h('span', { class: 'atitle' }, r.title));
      if (r.detail) td.append(h('span', { class: 'adetail' }, r.detail));
    },
  };
  // the open alerts: collapsed rows are one line (app.css .alerts.compact), the whole text stays in the tooltip
  const openAlertCol = {
    ...alertCol,
    cell: (r, td) => {
      alertCol.cell(r, td);
      if (!expanded) td.title = [r.title, r.detail].filter(Boolean).join(' — ');
    },
  };
  const areaCol = {
    key: 'area', label: 'Área', sort: (r) => AREA[r.area] || r.area,
    cell: (r, td) => td.append(chip(AREA[r.area] || r.area || F.DASH)),
  };
  const sinceCol = { key: 'since', label: 'Desde', sort: relSort('since'), cls: 'muted-cell', cell: (r, td) => relTime(td, r.since, clock.now()) };

  async function ack(alert, hours, opener) {
    try {
      await ctx.api.ack({ id: alert.id, hours });
      const what = hours == null ? 'Alerta marcado como visto.' : `Alerta silenciado por ${hours === 168 ? '7 dias' : '24 h'}.`;
      await ctx.refreshOverview().catch(() => {});
      render();
      ctx.notify(what, 'ok');
    } catch (e) {
      if (e.kind === 'auth') return;
      ctx.notify(`Não foi possível silenciar: ${errorMessage(e)}.`, 'bad');
      if (opener) opener.focus();
    }
  }

  async function unack(alert) {
    try {
      await ctx.api.unack({ id: alert.id });
      await ctx.refreshOverview().catch(() => {});
      render();
      ctx.notify('Alerta reativado.', 'ok');
    } catch (e) {
      if (e.kind === 'auth') return;
      ctx.notify(`Não foi possível reativar: ${errorMessage(e)}.`, 'bad');
    }
  }

  const ghost = (label, ic, fn, fk) => button(label, fn, 'ghost', { class: 'btn-sm', icon: ic, dataset: { fk } });

  const alertsTable = createTable({
    label: 'Alertas',
    cls: 'alerts',
    columns: [
      severityCol, openAlertCol, areaCol, sinceCol,
      {
        key: 'actions', label: 'Ações', sort: false, cls: 'actions',
        cell: (r, td) => {
          const group = h('span', { class: 'btn-group' },
            textButton('Ver', () => ctx.navigate(r.view || 'visao', null, r.subject || null), { dataset: { fk: 'ver' }, icon: 'arrow-right' }));
          if (r.event) {
            group.append(ghost('Marcar como visto', 'eye', (e) => ack(r, null, e.currentTarget), 'visto'));
          } else {
            group.append(ghost('Silenciar 24 h', 'bell-off', (e) => ack(r, 24, e.currentTarget), 'a24'));
            if (r.severity !== 'critical') group.append(ghost('Silenciar 7 dias', 'bell-off', (e) => ack(r, 168, e.currentTarget), 'a168'));
          }
          td.append(group);
        },
      },
    ],
    rowKey: (r) => r.id,
    rowClass: (r) => `sev-${SEVERITY[r.severity] ? r.severity : 'info'}`,
    defaultSort: { key: 'severity', dir: 'asc', compare: alertCompare },
    groups: { key: (r) => (SEVERITY[r.severity] ? r.severity : 'info'), label: (k, n) => `${(SEVERITY[k] || SEVERITY.info).word} · ${F.fmtInt(n)}` },
    maxRows: () => (expanded ? null : COLLAPSED),
    empty: 'Nenhum alerta. Tudo dentro dos limites.',
    emptyKind: 'good',
  });
  const okStrip = h('div', { class: 'okstrip', hidden: true }, iconChip('check-circle', 'ok', 16), h('span', null, 'Nenhum alerta. Tudo dentro dos limites.'));
  const moreLabel = h('span');
  const moreIcon = h('span', { class: 'more-ico', 'aria-hidden': 'true' }, icon('chevron-down', 16));
  const moreBtn = button('', () => {
    expanded = !expanded;
    render();
    moreBtn.focus();
  }, 'ghost', { class: 'btn-sm', 'aria-expanded': 'false', dataset: { fk: 'more' } });
  moreBtn.append(moreIcon, moreLabel);
  const alertsFoot = h('div', { class: 'panel-foot', hidden: true }, moreBtn);
  alertsP.el.append(alertsTable.el, okStrip, alertsFoot);

  const ackedP = panel('h-silenciados', 'Alertas silenciados', { icon: 'bell-off' });
  const ackedTable = createTable({
    label: 'Alertas silenciados',
    columns: [
      severityCol, alertCol, areaCol,
      {
        key: 'ackedUntil', label: 'Silenciado até', sort: relSort('ackedUntil'),
        cell: (r, td) => {
          if (r.ackedUntil) {
            td.textContent = F.fmtDateTime(r.ackedUntil);
            td.title = F.fmtTitle(r.ackedUntil);
          } else td.textContent = 'visto';
        },
      },
      {
        key: 'unack', label: 'Reativar', sort: false, cls: 'actions',
        cell: (r, td) => td.append(ghost('Reativar', 'bell', () => unack(r), 'unack')),
      },
    ],
    rowKey: (r) => r.id,
    rowClass: (r) => `sev-${SEVERITY[r.severity] ? r.severity : 'info'}`,
    defaultSort: { key: 'severity', dir: 'asc', compare: alertCompare },
    empty: 'Nenhum alerta silenciado.',
  });
  ackedP.el.append(ackedTable.el);
  ackedP.el.hidden = true;

  // ---- area cards (the Resumo)
  const cards = createCards('visao', AREA_ORDER.map((a) => ({ id: a, label: SUMMARY_AREA[a], icon: AREA_ICON[a], span: AREA_SPAN[a] })),
    { heading: 'Áreas', cls: 'areas' });

  // ---- Últimos eventos
  const evP = panel('h-ultimos', 'Últimos eventos', {
    icon: 'eventos',
    controls: [textButton('Ver todos', () => ctx.navigate('eventos'), { icon: 'arrow-right' })],
  });
  const evTable = createTable({
    label: 'Últimos eventos',
    columns: eventColumns(ctx, { sortable: false }),
    rowKey: (r) => `ev${r.seq}`,
    defaultSort: { key: 'time', dir: 'desc', compare: (a, b) => (b.seq ?? 0) - (a.seq ?? 0) },
    empty: 'Nenhum evento ainda.',
  });
  evP.el.append(evTable.el);

  section.append(head.el, alertsP.el, ackedP.el, cards.el, evP.el);

  function paintSeverityPills(a) {
    clear(alertsP.extra);
    for (const [k, lv, one, many] of [['critical', 'bad', 'crítico', 'críticos'], ['warning', 'warn', 'atenção', 'atenção'], ['info', 'info', 'info', 'info']]) {
      const n = a?.[k] || 0;
      if (n) alertsP.extra.append(status(lv, `${F.fmtInt(n)} ${n === 1 ? one : many}`));
    }
  }

  function render() {
    const ov = ctx.store.overview;
    if (!ov) return;
    const now = clock.now();
    const alerts = Array.isArray(ov.alerts) ? ov.alerts : [];
    const acked = Array.isArray(ov.acked) ? ov.acked : [];
    head.setSub(alertsSubtitle(ov.status?.alerts));
    alertsTable.table.classList.toggle('compact', !expanded && alerts.length > 0);
    alertsTable.setRows(alerts);
    alertsP.setCount(alertsTable.countText());
    paintSeverityPills(ov.status?.alerts);
    const none = alerts.length === 0;
    alertsTable.el.hidden = none;
    okStrip.hidden = !none;
    alertsFoot.hidden = alerts.length <= COLLAPSED;
    moreLabel.textContent = expanded ? 'Mostrar menos' : `Mostrar todos os ${F.fmtInt(alerts.length)} alertas`;
    moreIcon.className = expanded ? 'more-ico up' : 'more-ico';
    moreBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    if (acked.length) {
      ackLabel.textContent = `${showAcked ? 'Ocultar' : 'Mostrar'} silenciados (${F.fmtInt(acked.length)})`;
      ackToggle.setAttribute('aria-expanded', showAcked ? 'true' : 'false');
      ackToggle.hidden = false;
    } else {
      ackToggle.hidden = true;
      showAcked = false;
    }
    ackedP.el.hidden = !showAcked;
    if (showAcked) {
      ackedTable.setRows(acked);
      ackedP.setCount(ackedTable.countText());
    }
    cards.render(kpis(ov, now).map((d) => ({
      ...d,
      foot: { label: 'Ver', ariaLabel: `Ver ${SUMMARY_AREA[d.id] || d.id}`, onClick: () => ctx.navigate((ov.summary.find((r) => r.area === d.id) || {}).view || 'visao') },
    })));
    evTable.setRows(Array.isArray(ov.recentEvents) ? ov.recentEvents.slice(0, 10) : []);
    for (const p of [alertsP, evP]) p.setStale('');
  }

  return {
    interval: () => 5000,
    async refresh() {
      try {
        await ctx.refreshOverview();
        lastOk = clock.now();
        render();
      } catch (e) {
        if (e.kind === 'auth') throw e;
        const msg = errorMessage(e);
        for (const [t, p] of [[alertsTable, alertsP], [evTable, evP]]) {
          t.setError(msg);
          if (t.hasRows()) p.setStale(staleText(lastOk));
        }
        cards.error(msg, lastOk ? `dados de ${F.fmtTimeSec(lastOk)}` : '');
        throw e;
      }
    },
    show() {
      if (ctx.store.overview) render();
    },
    focusSubject(subject) {
      if (!subject) return;
      const id = subject.alertId;
      if (id && !expanded) {
        expanded = true;
        render();
      }
      const tr = id ? alertsTable.rowElement(id) : null;
      const btn = tr && tr.querySelector('button');
      if (btn) {
        btn.focus();
        tr.scrollIntoView({ block: 'center' });
      }
    },
  };
}
