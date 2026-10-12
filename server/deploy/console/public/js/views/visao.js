// Visão geral (DESIGN.md 6.5): Alertas, Resumo (key-value per area), Últimos eventos. Polls the overview every 5 s
// (the same request feeds the status line).

import * as F from '../format.js';
import { h, clear, status, textButton, sectionHead, joinDots } from '../dom.js';
import { createTable } from '../table.js';
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
        ? `próxima a vencer: ${nx.customer} ${F.fmtRelative(nx.expiresAt, now)}`
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

export default function createVisao(ctx, section) {
  const { clock } = ctx;
  let lastOk = null;
  let showAcked = false;

  // ---- Alertas
  const alertsHead = sectionHead('Alertas', { id: 'h-alertas' });
  const severityCol = {
    key: 'severity', label: 'Gravidade', sort: (r) => SEVERITY[r.severity]?.order ?? 9, firstDir: 'asc',
    cell: (r, td) => {
      const s = SEVERITY[r.severity] || SEVERITY.info;
      td.append(status(s.level, s.word));
    },
  };
  const alertCol = {
    key: 'title', label: 'Alerta', wrap: true, sort: (r) => r.title,
    cell: (r, td) => {
      td.append(h('span', { class: 'atitle' }, r.title));
      if (r.detail) td.append(h('span', { class: 'adetail' }, r.detail));
    },
  };
  const areaCol = { key: 'area', label: 'Área', sort: (r) => AREA[r.area] || r.area, text: (r) => AREA[r.area] || r.area };
  const sinceCol = { key: 'since', label: 'Desde', sort: relSort('since'), cell: (r, td) => relTime(td, r.since, clock.now()) };

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

  const alertsTable = createTable({
    label: 'Alertas',
    columns: [
      severityCol, alertCol, areaCol, sinceCol,
      {
        key: 'actions', label: 'Ações', sort: false, cls: 'actions',
        cell: (r, td) => {
          const items = [textButton('Ver', () => ctx.navigate(r.view || 'visao', null, r.subject || null), { dataset: { fk: 'ver' } })];
          if (r.event) {
            items.push(textButton('Marcar como visto', (e) => ack(r, null, e.currentTarget), { dataset: { fk: 'visto' } }));
          } else {
            items.push(textButton('Silenciar 24 h', (e) => ack(r, 24, e.currentTarget), { dataset: { fk: 'a24' } }));
            if (r.severity !== 'critical') items.push(textButton('Silenciar 7 dias', (e) => ack(r, 168, e.currentTarget), { dataset: { fk: 'a168' } }));
          }
          td.append(...joinDots(items));
        },
      },
    ],
    rowKey: (r) => r.id,
    defaultSort: { key: 'severity', dir: 'asc', compare: alertCompare },
    empty: 'Nenhum alerta. Tudo dentro dos limites.',
  });

  const ackedLine = h('p', { class: 'muted ackline', hidden: true });
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
        cell: (r, td) => td.append(textButton('Reativar', () => unack(r), { dataset: { fk: 'unack' } })),
      },
    ],
    rowKey: (r) => r.id,
    defaultSort: { key: 'severity', dir: 'asc', compare: alertCompare },
    empty: 'Nenhum alerta silenciado.',
  });
  const ackedWrap = h('div', { class: 'acked', hidden: true }, ackedTable.el);

  // ---- Resumo
  const resumoHead = sectionHead('Resumo', { id: 'h-resumo' });
  const resumoTable = createTable({
    label: 'Resumo por área',
    cls: 'resumo',
    columns: [
      { key: 'area', label: 'Área', sort: false, cell: (r, td) => { td.textContent = SUMMARY_AREA[r.area] || r.area; } },
      {
        key: 'state', label: 'Estado', sort: false,
        cell: (r, td) => {
          const s = SUMMARY_STATE[r.state] || SUMMARY_STATE.unknown;
          td.append(status(s.level, s.word));
        },
      },
      { key: 'agora', label: 'Agora', sort: false, cell: (r, td) => { td.textContent = summaryTexts(r, ctx.store.overview, clock.now()).agora; } },
      { key: 'detalhe', label: 'Detalhe', sort: false, ell: 'text', cell: (r, td) => { const t = summaryTexts(r, ctx.store.overview, clock.now()).detalhe; td.textContent = t; td.title = t; } },
      {
        key: 'ver', label: 'Ver', sort: false, cls: 'actions',
        cell: (r, td) => td.append(textButton('Ver', () => ctx.navigate(r.view || 'visao'), { dataset: { fk: 'ver' }, 'aria-label': `Ver ${SUMMARY_AREA[r.area] || r.area}` })),
      },
    ],
    rowKey: (r) => r.area,
    empty: 'Sem resumo ainda.',
  });

  // ---- Últimos eventos
  const evHead = sectionHead('Últimos eventos', {
    id: 'h-ultimos',
    controls: [textButton('Ver todos', () => ctx.navigate('eventos'))],
  });
  const evTable = createTable({
    label: 'Últimos eventos',
    columns: eventColumns(ctx, { sortable: false }),
    rowKey: (r) => `ev${r.seq}`,
    defaultSort: { key: 'time', dir: 'desc', compare: (a, b) => (b.seq ?? 0) - (a.seq ?? 0) },
    empty: 'Nenhum evento ainda.',
  });

  section.append(
    h('div', { class: 'block', 'aria-labelledby': 'h-alertas', role: 'region' }, alertsHead.el, alertsTable.el, ackedLine, ackedWrap),
    h('div', { class: 'block', 'aria-labelledby': 'h-resumo', role: 'region' }, resumoHead.el, resumoTable.el),
    h('div', { class: 'block', 'aria-labelledby': 'h-ultimos', role: 'region' }, evHead.el, evTable.el),
  );

  function render() {
    const ov = ctx.store.overview;
    if (!ov) return;
    const alerts = Array.isArray(ov.alerts) ? ov.alerts : [];
    const acked = Array.isArray(ov.acked) ? ov.acked : [];
    alertsTable.setRows(alerts);
    alertsHead.setCount(alertsTable.countText());
    clear(ackedLine);
    if (acked.length) {
      const toggle = textButton(showAcked ? 'ocultar' : 'mostrar', () => {
        showAcked = !showAcked;
        render();
      }, { 'aria-expanded': showAcked ? 'true' : 'false', dataset: { fk: 'acked' } });
      ackedLine.append(`Silenciados: ${acked.length} (`, toggle, ')');
      ackedLine.hidden = false;
    } else {
      ackedLine.hidden = true;
      showAcked = false;
    }
    ackedWrap.hidden = !showAcked;
    if (showAcked) ackedTable.setRows(acked);
    resumoTable.setRows(Array.isArray(ov.summary) ? ov.summary : []);
    evTable.setRows(Array.isArray(ov.recentEvents) ? ov.recentEvents.slice(0, 10) : []);
    for (const hd of [alertsHead, resumoHead, evHead]) hd.setStale('');
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
        for (const [t, hd] of [[alertsTable, alertsHead], [resumoTable, resumoHead], [evTable, evHead]]) {
          t.setError(msg);
          if (t.hasRows()) hd.setStale(staleText(lastOk));
        }
        throw e;
      }
    },
    show() {
      if (ctx.store.overview) render();
    },
    focusSubject(subject) {
      if (!subject) return;
      const id = subject.alertId;
      const tr = id ? alertsTable.rowElement(id) : null;
      const btn = tr && tr.querySelector('button');
      if (btn) {
        btn.focus();
        tr.scrollIntoView({ block: 'center' });
      }
    },
  };
}
