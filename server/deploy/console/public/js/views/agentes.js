// Agentes e sessões (DESIGN.md 6.5, SPEC painel v2 4.5): four KPI cards (agents, open sessions, agent calls in the
// last hour, sessions closed today), then agents, open MCP sessions, server processes and sessions closed today, all
// from /api/live. Polls every 3 s.

import * as F from '../format.js';
import { h, status, chip, pageHead, panel } from '../dom.js';
import { createTable } from '../table.js';
import { createCards } from '../cards.js';
import { meterLevel } from '../charts.js';
import { PROCESS_KIND, agentCloseWord, sessionCloseWord } from '../labels.js';
import { relTime, relSort, sinceCell, errorMessage, staleText } from './common.js';

/** `11.55.91 (porta 50123)` */
export function studioText(s) {
  if (!s || !s.version) return F.DASH;
  return s.port != null ? `${s.version} (porta ${s.port})` : String(s.version);
}

/** Agent pack: `pack-id · bridge v48 · O11 11.55.91`. */
export function packText(p) {
  if (!p) return F.DASH;
  return [p.id, p.odcBridge ? `bridge ${p.odcBridge}` : null, p.o11BuiltFor ? `O11 ${p.o11BuiltFor}` : null].filter(Boolean).join(' · ') || F.DASH;
}

const STATE_LEVEL = { ok: 'ok', warning: 'warn', critical: 'bad', unknown: 'unknown' };

/** `3 agentes conectados · 11 sessões MCP abertas · limite de 120 chamadas/min · até 8 sessões por licença`. */
export function liveSubtitle(d) {
  const agents = (d?.agents || []).filter((a) => a.state === 'connected').length;
  const parts = [F.plural(agents, 'agente conectado', 'agentes conectados'), F.plural((d?.sessions || []).length, 'sessão MCP aberta', 'sessões MCP abertas')];
  if (d?.server?.ratePerMinute != null) parts.push(`limite de ${F.fmtInt(d.server.ratePerMinute)} chamadas/min`);
  if (d?.server?.maxSessionsPerToken != null) parts.push(`até ${F.plural(d.server.maxSessionsPerToken, 'sessão', 'sessões')} por licença`);
  return parts.join(' · ');
}

/** The four KPI cards of Agentes e sessões (pure): /api/live, plus the summary states of the overview for two levels. */
export function kpis(d, ov, now) {
  const agents = Array.isArray(d?.agents) ? d.agents : [];
  const sessions = Array.isArray(d?.sessions) ? d.sessions : [];
  const closed = Array.isArray(d?.closedToday) ? d.closedToday : [];
  const summary = (area) => STATE_LEVEL[(ov?.summary || []).find((r) => r.area === area)?.state] || 'ok';
  const connected = agents.filter((a) => a.state === 'connected').length;
  const lastSignal = agents.map((a) => F.toMs(a.lastSignalAt)).filter(Number.isFinite).sort((a, b) => b - a)[0];
  const perToken = new Map();
  for (const s of sessions) perToken.set(s.token, { customer: s.customer || s.token, n: (perToken.get(s.token)?.n || 0) + 1 });
  const fullest = [...perToken.values()].sort((a, b) => b.n - a.n)[0];
  const max = d?.server?.maxSessionsPerToken ?? null;
  const calls = agents.reduce((s, a) => s + (Number(a.calls1h) || 0), 0);
  const fails = agents.reduce((s, a) => s + (Number(a.failures1h) || 0), 0);
  const closedN = closed.reduce((s, c) => s + (Number(c.count) || 0), 0);
  const topClosed = closed.slice().sort((a, b) => (b.count ?? 0) - (a.count ?? 0))[0];
  return [
    {
      id: 'agentes', label: 'Agentes conectados', icon: 'agentes', level: summary('agentes'), value: F.fmtInt(connected), unit: `de ${F.fmtInt(agents.length)}`,
      context: Number.isFinite(lastSignal) ? `último sinal ${F.fmtRelative(lastSignal, now)}` : 'nenhum sinal registrado',
      visual: agents.length ? {
        kind: 'meter', label: 'Agentes conectados', caption: 'conectados dos registrados', fraction: connected / agents.length, level: 'accent',
        valueText: F.fmtPct((connected / agents.length) * 100),
      } : null,
    },
    {
      id: 'sessoes', label: 'Sessões MCP abertas', icon: 'session', level: summary('sessoes'), value: F.fmtInt(sessions.length),
      context: fullest ? `mais cheia: ${fullest.customer} ${F.fmtInt(fullest.n)}${max ? ` de ${F.fmtInt(max)}` : ''}` : 'nenhuma aberta',
      visual: fullest && max ? {
        kind: 'meter', label: 'Licença com mais sessões', caption: 'licença mais cheia', fraction: fullest.n / max, level: meterLevel('seats', fullest.n / max),
        valueText: `${F.fmtInt(fullest.n)} de ${F.fmtInt(max)}`,
      } : null,
    },
    {
      id: 'chamadas', label: 'Chamadas ao agente em 1 h', icon: 'uso', level: agents.some((a) => (a.failures1h ?? 0) >= 10) ? 'bad' : 'ok',
      value: F.fmtInt(calls), context: calls ? `${F.plural(fails, 'falha', 'falhas')} (${F.fmtShare(fails, calls)})` : 'sem chamadas',
    },
    {
      id: 'encerradas', label: 'Sessões encerradas hoje', icon: 'x-circle', level: 'ok', value: F.fmtInt(closedN),
      context: topClosed ? `mais comum: ${sessionCloseWord(topClosed.reason)} (${F.fmtInt(topClosed.count)})` : 'nenhuma',
    },
  ];
}

const CARD_DEFS = [
  { id: 'agentes', label: 'Agentes conectados', icon: 'agentes' }, { id: 'sessoes', label: 'Sessões MCP abertas', icon: 'session' },
  { id: 'chamadas', label: 'Chamadas ao agente em 1 h', icon: 'uso' }, { id: 'encerradas', label: 'Sessões encerradas hoje', icon: 'x-circle' },
];

export default function createAgentes(ctx, section) {
  const { clock } = ctx;
  let lastOk = null;
  let closedMax = 1;

  const head = pageHead('t-agentes', 'Agentes e sessões');
  const cards = createCards('agentes', CARD_DEFS);

  const agentsP = panel('h-agentes', 'Agentes', { icon: 'agentes' });
  const agentsTable = createTable({
    label: 'Agentes',
    dense: true,
    columns: [
      { key: 'customer', label: 'Cliente', ell: 'name', sort: (r) => r.customer, text: (r) => r.customer || r.token },
      {
        key: 'state', label: 'Estado', subLabel: 'desde', sort: (r) => (r.state === 'connected' ? 0 : 1), firstDir: 'asc',
        cell: (r, td) => td.append(r.state === 'connected' ? status('ok', 'conectado') : status('muted', 'desconectado')),
        sub: (r) => {
          const t = r.state === 'connected' ? r.since : (r.closedAt || r.since);
          return t == null ? F.DASH : h('span', { title: F.fmtTitle(t) }, F.fmtRelative(t, clock.now()));
        },
      },
      { key: 'lastSignalAt', label: 'Último sinal', sort: relSort('lastSignalAt'), firstDir: 'desc', cell: (r, td) => relTime(td, r.lastSignalAt, clock.now()) },
      {
        key: 'version', label: 'Versão', subLabel: 'pacote', mono: true, sort: (r) => r.version, text: (r) => r.version || F.DASH,
        sub: (r) => h('span', { class: 'ell-line ell-code16', title: r.pack ? packText(r.pack) : 'O servidor ainda não registra o pacote do agente.' }, packText(r.pack)),
      },
      {
        key: 'studio', label: 'Studio O11', sort: (r) => r.studioO11?.version ?? null, text: (r) => r.studioO11?.version || F.DASH,
        title: (r) => (r.studioO11 ? studioText(r.studioO11) : ''),
        sub: (r) => (r.studioO11?.port != null ? `porta ${r.studioO11.port}` : null),
      },
      {
        key: 'machine', label: 'Máquina', subLabel: 'IP', sort: (r) => (r.machine ? F.fmtMachine(r.machine) : null),
        cell: (r, td) => {
          const t = F.fmtMachine(r.machine);
          td.append(h('span', { class: 'ell-line ell-name18', title: t }, t));
        },
        sub: (r) => h('span', { class: 'mono' }, r.ip || F.DASH),
      },
      { key: 'calls1h', label: 'Chamadas 1 h', num: true, sort: (r) => r.calls1h ?? 0, text: (r) => F.fmtInt(r.calls1h ?? 0) },
      {
        key: 'failures1h', label: 'Falhas 1 h', num: true, cls: 'lvstrong', sort: (r) => r.failures1h ?? 0, text: (r) => F.fmtInt(r.failures1h ?? 0),
        level: (r) => ((r.failures1h ?? 0) >= 10 ? 'bad' : ''),
      },
      { key: 'lastCode', label: 'Último código', mono: true, ell: 'code16', sort: (r) => r.lastCode, text: (r) => r.lastCode || F.DASH },
      {
        key: 'closedReason', label: 'Motivo do fechamento', flex: true, sort: (r) => (r.state === 'connected' ? null : agentCloseWord(r.closedReason)),
        text: (r) => (r.state === 'connected' ? F.DASH : agentCloseWord(r.closedReason)),
      },
    ],
    rowKey: (r) => r.token,
    defaultSort: {
      key: 'state', dir: 'asc',
      compare: (a, b) => (a.state === 'connected' ? 0 : 1) - (b.state === 'connected' ? 0 : 1)
        || (F.toMs(b.lastSignalAt) || 0) - (F.toMs(a.lastSignalAt) || 0),
    },
    empty: 'Nenhum agente conectou desde o início do log.',
  });
  agentsP.el.append(agentsTable.el);

  const sessP = panel('h-sessoes', 'Sessões MCP abertas', { icon: 'session' });
  const sessTable = createTable({
    label: 'Sessões MCP abertas',
    columns: [
      { key: 'customer', label: 'Cliente', ell: 'name', sort: (r) => r.customer, text: (r) => r.customer || r.token },
      { key: 'client', label: 'Cliente MCP', ell: 'client', flex: true, sort: (r) => r.client, text: (r) => r.client || F.DASH, title: (r) => [r.client, r.ua].filter(Boolean).join(' · ') },
      { key: 'ip', label: 'IP', mono: true, ell: 'code', sort: (r) => r.ip, text: (r) => r.ip || F.DASH },
      { key: 'openedAt', label: 'Aberta há', sort: relSort('openedAt'), cell: (r, td) => sinceCell(td, r.openedAt, clock.now()) },
      {
        key: 'lastAt', label: 'Ociosa há', sort: relSort('lastAt'), firstDir: 'desc',
        cell: (r, td) => {
          sinceCell(td, r.lastAt, clock.now());
          if (r.lastAt) td.title = `fecha por inatividade às ${F.fmtTime(F.toMs(r.lastAt) + 60 * F.MIN)}`;
        },
      },
      { key: 'calls', label: 'Chamadas', num: true, sort: (r) => r.calls ?? 0, text: (r) => F.fmtInt(r.calls ?? 0) },
      { key: 'lastTool', label: 'Última ferramenta', mono: true, ell: 'code', sort: (r) => r.lastTool, text: (r) => r.lastTool || F.DASH },
      { key: 'session', label: 'Sessão', mono: true, sort: (r) => r.session, text: (r) => String(r.session || '').slice(0, 8) },
    ],
    rowKey: (r) => r.session,
    defaultSort: { key: 'lastAt', dir: 'desc' },
    empty: 'Nenhuma sessão MCP aberta agora.',
  });
  sessP.el.append(sessTable.el);

  const procP = panel('h-processos', 'Processos do servidor', { icon: 'cpu' });
  let procEmpty = 'Sem dados de processos (coletor parado).';
  const procTable = createTable({
    label: 'Processos do servidor',
    columns: [
      {
        key: 'kind', label: 'Tipo', sort: (r) => PROCESS_KIND[r.kind]?.order ?? 9, firstDir: 'asc',
        cell: (r, td) => td.append(chip(PROCESS_KIND[r.kind]?.word || r.kind || F.DASH)),
      },
      { key: 'customer', label: 'Cliente', ell: 'name', flex: true, sort: (r) => r.customer, text: (r) => r.customer || F.DASH },
      { key: 'port', label: 'Porta', num: true, sort: (r) => r.port ?? null, text: (r) => (r.port != null ? String(r.port) : F.DASH) },
      { key: 'rssB', label: 'Memória', num: true, sort: (r) => r.rssB ?? null, text: (r) => F.fmtBytes(r.rssB) },
      { key: 'cpuPct', label: 'CPU', num: true, sort: (r) => r.cpuPct ?? null, text: (r) => F.fmtPctFine(r.cpuPct) },
      { key: 'elapsedS', label: 'Ativo há', num: true, sort: (r) => r.elapsedS ?? null, text: (r) => (r.elapsedS != null ? F.fmtDuration(r.elapsedS * 1000) : F.DASH) },
    ],
    rowKey: (r) => `${r.kind}|${r.port ?? ''}|${r.token ?? ''}|${r.elapsedS ?? ''}`,
    defaultSort: { key: 'kind', dir: 'asc' },
    empty: (mk) => mk(procEmpty, 'empty'),
  });
  procP.el.append(procTable.el, h('div', { class: 'panel-foot' }, 'Workers O11 por cliente só existem nas imagens com o pool hospedado.'));

  const closedP = panel('h-encerradas', 'Sessões encerradas hoje', { icon: 'x-circle' });
  const closedTable = createTable({
    label: 'Sessões encerradas hoje',
    columns: [
      { key: 'reason', label: 'Motivo', flex: true, sort: (r) => sessionCloseWord(r.reason), text: (r) => sessionCloseWord(r.reason) },
      {
        key: 'count', label: 'Quantidade', num: true, sort: (r) => r.count ?? 0, text: (r) => F.fmtInt(r.count ?? 0),
        cell: (r, td) => {
          const bar = h('span', { class: 'ib-bar' });
          bar.style.inlineSize = `${Math.round(((r.count ?? 0) / closedMax) * 100)}%`;
          td.append(h('span', { class: 'inline-bar' }, h('span', { class: 'ib-track', 'aria-hidden': 'true' }, bar), h('span', null, F.fmtInt(r.count ?? 0))));
        },
      },
    ],
    rowKey: (r) => r.reason,
    defaultSort: { key: 'count', dir: 'desc' },
    empty: 'Nenhuma sessão encerrada hoje.',
  });
  closedP.el.append(closedTable.el);

  section.append(head.el, cards.el, agentsP.el, sessP.el, h('div', { class: 'cols-2' }, procP.el, closedP.el));

  const tables = [[agentsTable, agentsP], [sessTable, sessP], [procTable, procP], [closedTable, closedP]];

  function render(d) {
    head.setSub(liveSubtitle(d));
    cards.render(kpis(d, ctx.store.overview, clock.now()));
    agentsTable.setRows(d.agents || []);
    sessTable.setRows(d.sessions || []);
    const w = d.workers || {};
    procEmpty = w.available === false ? 'Sem dados de processos (coletor parado).' : 'Nenhum processo listado.';
    procTable.setRows(w.available === false ? [] : (w.rows || []));
    closedMax = Math.max(1, ...(d.closedToday || []).map((c) => Number(c.count) || 0));
    closedTable.setRows(d.closedToday || []);
    for (const [t, p] of tables) {
      p.setCount(t.countText());
      p.setStale('');
    }
  }

  return {
    interval: () => 3000,
    async refresh() {
      try {
        const d = await ctx.api.live();
        ctx.store.live = d;
        lastOk = clock.now();
        render(d);
      } catch (e) {
        if (e.kind === 'auth') throw e;
        const msg = errorMessage(e);
        for (const [t, p] of tables) {
          t.setError(msg);
          if (t.hasRows()) p.setStale(staleText(lastOk));
        }
        cards.error(msg, lastOk ? `dados de ${F.fmtTimeSec(lastOk)}` : '');
        throw e;
      }
    },
    focusSubject(subject) {
      const tr = subject?.token ? agentsTable.rowElement(subject.token) : null;
      if (tr) {
        tr.tabIndex = -1;
        tr.focus();
        tr.scrollIntoView({ block: 'center' });
      }
    },
  };
}
