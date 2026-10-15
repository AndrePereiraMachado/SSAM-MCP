// Uso (DESIGN.md 6.5, SPEC painel v2 4.3): four KPI cards with day sparklines (calls, failures, response time, denials),
// the calls-per-day columns and the top tools, then the tables per customer, tool, failure code and day, and the
// denials Caddy saw. Range Hoje / 7 dias / 30 dias / one day; one customer or all. Polls every 30 s (today) or 120 s.

import * as F from '../format.js';
import { h, pageHead, panel, select, setOptions, filterInput } from '../dom.js';
import { createTable, filterRows } from '../table.js';
import { createCards } from '../cards.js';
import { columns, barlist, meterLevel } from '../charts.js';
import { sparkline, sparkLabel } from '../sparkline.js';
import { relTime, relSort, errorMessage, staleText, periodControls } from './common.js';

/** Range echo: `De 06/10/2026 a 12/10/2026 (America/Sao_Paulo)`. */
export function rangeText(range) {
  if (!range || !range.from) return '';
  const tz = range.timeZone || F.TZ;
  if (range.from === range.to) return `Em ${F.fmtCalendarDay(range.from)} (${tz})`;
  return `De ${F.fmtCalendarDay(range.from)} a ${F.fmtCalendarDay(range.to)} (${tz})`;
}

const numCol = (key, label, get, extra = {}) => ({
  key, label, num: true, sort: (r) => get(r) ?? null, text: (r) => F.fmtInt(get(r)), ...extra,
});
const durCol = (key, label, get) => ({
  key, label, num: true, sort: (r) => get(r) ?? null, text: (r) => F.fmtDuration(get(r)),
});
const shareCol = (key, label, part, total) => ({
  key, label, num: true, sort: (r) => (total(r) ? part(r) / total(r) : null), text: (r) => F.fmtShare(part(r), total(r)),
});

const STATUS_SERIES = ['s1', 's2', 's3', 's4', 's5'];

/** The days of the payload, oldest first (the chart and the card sparklines). */
export function daysAscending(data) {
  return (Array.isArray(data?.byDay) ? data.byDay.slice() : []).sort((a, b) => String(a.day).localeCompare(String(b.day)));
}

/** Denials by status in status order: [{status, count}]. */
export function deniedParts(denied) {
  const by = denied && typeof denied.byStatus === 'object' && denied.byStatus ? denied.byStatus : {};
  return Object.keys(by).filter((k) => Number.isFinite(Number(by[k]))).sort((a, b) => Number(a) - Number(b))
    .map((k) => ({ status: k, count: Number(by[k]) }));
}

/** The four KPI cards of Uso (pure): the payload totals and day series; `alerts` decides the level of the denials card. */
export function kpis(data, alerts) {
  const t = data?.totals || {};
  const calls = t.calls ?? 0;
  const fails = t.failures ?? 0;
  const days = daysAscending(data);
  const spark = (key, label, fmt) => (days.length >= 2
    ? { kind: 'spark', values: days.map((d) => d[key] ?? null), label: sparkLabel(label, days.map((d) => d[key] ?? null), { lastLabel: 'último dia', fmt }) }
    : null);
  const success = calls ? ((calls - fails) / calls) * 100 : null;
  const cards = [
    {
      id: 'chamadas', label: 'Chamadas', icon: 'uso', level: 'ok', value: F.fmtInt(calls),
      context: `${F.plural(t.customersActive ?? 0, 'cliente ativo', 'clientes ativos')} · ${F.plural(t.sessionsOpened ?? 0, 'sessão aberta', 'sessões abertas')}`,
      visual: spark('calls', 'Chamadas por dia'),
    },
    {
      id: 'falhas', label: 'Falhas', icon: 'x-circle', level: success == null ? 'ok' : meterLevel('success', success), value: F.fmtInt(fails),
      context: calls
        ? `${F.fmtShare(fails, calls)} das chamadas · agente: ${F.fmtInt(t.agentFailures ?? 0)} de ${F.fmtInt(t.agentCalls ?? 0)}`
        : 'sem chamadas',
      visual: spark('failures', 'Falhas por dia'),
    },
    calls && t.p90Ms != null ? {
      id: 'tempo', label: 'Tempo de resposta', icon: 'timer', level: 'ok', value: F.fmtDuration(t.p90Ms), unit: 'p90',
      context: `p50 ${F.fmtDuration(t.p50Ms)} · máximo ${F.fmtDuration(t.maxMs)}`,
      visual: spark('p90Ms', 'Tempo de resposta p90 por dia', F.fmtDuration),
    } : { id: 'tempo', label: 'Tempo de resposta', icon: 'timer', level: 'ok', value: F.DASH, muted: true, context: 'sem chamadas' },
  ];
  const dn = data?.denied || {};
  if (dn.available === false) {
    cards.push({ id: 'recusas', label: 'Acessos recusados', icon: 'ban', level: 'ok', value: 'sem coleta', word: true, muted: true, context: 'Sem dados do Caddy (coletor parado).' });
  } else {
    const parts = deniedParts(dn);
    const total = parts.reduce((s, p) => s + p.count, 0);
    const open = (alerts || []).some((a) => a && a.rule === 'recusas-acesso');
    cards.push({
      id: 'recusas', label: 'Acessos recusados', icon: 'ban', level: open ? 'warn' : 'ok', value: F.fmtInt(total),
      context: parts.length ? null : 'nenhum registrado',
      visual: parts.length ? {
        kind: 'segbar', label: 'Acessos recusados por status', legend: true,
        parts: parts.map((p, i) => ({ count: p.count, c: STATUS_SERIES[i] || 'other', word: `${p.status} · ${F.fmtInt(p.count)}` })),
      } : null,
    });
  }
  return cards;
}

const CARD_DEFS = [
  { id: 'chamadas', label: 'Chamadas', icon: 'uso' }, { id: 'falhas', label: 'Falhas', icon: 'x-circle' },
  { id: 'tempo', label: 'Tempo de resposta', icon: 'timer' }, { id: 'recusas', label: 'Acessos recusados', icon: 'ban' },
];

export default function createUso(ctx, section) {
  const { clock } = ctx;
  let range = '7d';
  let day = '';
  let token = '';
  let toolText = '';
  let data = null;
  let lastOk = null;

  const head = pageHead('t-uso', 'Uso');
  const period = periodControls((r, d) => setRange(r, d));
  const custSel = select('Cliente', [{ value: '', label: 'Todos os clientes' }], {
    onChange: (v) => {
      token = v;
      syncHash();
      paintControls();
      ctx.refreshNow();
    },
  });
  head.actions.append(period.segs, period.day, custSel);
  const cards = createCards('uso', CARD_DEFS);

  // 1. Por cliente
  const custP = panel('h-uso-cliente', 'Por cliente', { icon: 'agentes' });
  const custTable = createTable({
    label: 'Uso por cliente',
    dense: true,
    columns: [
      { key: 'customer', label: 'Cliente', ell: 'name', flex: true, sort: (r) => r.customer, text: (r) => r.customer || r.token },
      numCol('calls', 'Chamadas', (r) => r.calls),
      numCol('failures', 'Falhas', (r) => r.failures),
      shareCol('pct', '% falhas', (r) => r.failures, (r) => r.calls),
      durCol('p50', 'p50', (r) => r.p50Ms),
      durCol('p90', 'p90', (r) => r.p90Ms),
      { key: 'topTool', label: 'Ferramenta mais usada', mono: true, ell: 'code16', sort: (r) => r.topTool, text: (r) => r.topTool || F.DASH },
      numCol('sessionsOpened', 'Sessões abertas', (r) => r.sessionsOpened),
      numCol('agentCalls', 'Chamadas ao agente', (r) => r.agentCalls),
      numCol('agentFailures', 'Falhas do agente', (r) => r.agentFailures),
      { key: 'workspaceBytes', label: 'Espaço', num: true, sort: (r) => r.workspaceBytes ?? null, text: (r) => F.fmtBytes(r.workspaceBytes) },
      { key: 'lastAt', label: 'Última atividade', sort: relSort('lastAt'), firstDir: 'desc', cell: (r, td) => relTime(td, r.lastAt, clock.now()) },
      {
        key: 'daily', label: 'Por dia', cls: 'sparkcell', sort: (r) => (r.daily || []).reduce((s, v) => s + (v || 0), 0), firstDir: 'desc',
        cell: (r, td) => {
          const days = (r.daily || []).length;
          td.append(sparkline(r.daily || [], sparkLabel('Chamadas por dia', r.daily || [], { span: F.plural(days, 'dia', 'dias'), lastLabel: 'último dia' })));
        },
      },
    ],
    rowKey: (r) => r.token,
    defaultSort: { key: 'calls', dir: 'desc' },
    empty: 'Nenhuma chamada neste período.',
  });
  custP.el.append(custTable.el);

  // 2. Por ferramenta
  const toolFilter = filterInput('filtrar ferramenta', (v) => {
    toolText = v;
    toolTable.setFilter(toolText.trim() ? (r) => filterRows([r], toolText, ['tool']).length > 0 : null);
    toolP.setCount(toolTable.countText());
  });
  const toolP = panel('h-uso-ferramenta', 'Por ferramenta', { icon: 'wrench', controls: [toolFilter.wrapEl] });
  const toolTable = createTable({
    label: 'Uso por ferramenta',
    columns: [
      { key: 'tool', label: 'Ferramenta', mono: true, ell: 'code', sort: (r) => r.tool, text: (r) => r.tool },
      numCol('calls', 'Chamadas', (r) => r.calls),
      numCol('failures', 'Falhas', (r) => r.failures),
      shareCol('pct', '% falhas', (r) => r.failures, (r) => r.calls),
      durCol('p50', 'p50', (r) => r.p50Ms),
      durCol('p90', 'p90', (r) => r.p90Ms),
      durCol('max', 'Máximo', (r) => r.maxMs),
      numCol('customers', 'Clientes', (r) => r.customers),
      { key: 'topCode', label: 'Código mais comum', mono: true, ell: 'code', flex: true, sort: (r) => r.topCode, text: (r) => r.topCode || F.DASH },
    ],
    rowKey: (r) => r.tool,
    defaultSort: { key: 'calls', dir: 'desc' },
    empty: 'Nenhuma chamada neste período.',
    filteredEmpty: 'Nenhuma ferramenta com esse filtro.',
  });
  toolP.el.append(toolTable.el);

  // 3. Falhas por código
  const codeP = panel('h-uso-codigo', 'Falhas por código', { icon: 'x-circle' });
  const codeTable = createTable({
    label: 'Falhas por código',
    columns: [
      { key: 'code', label: 'Código', mono: true, ell: 'code', sort: (r) => r.code, text: (r) => r.code },
      numCol('count', 'Ocorrências', (r) => r.count),
      {
        key: 'tools', label: 'Ferramentas', ell: 'text', flex: true, sort: (r) => (r.tools || [])[0]?.tool ?? null,
        text: (r) => (r.tools || []).map((t) => `${t.tool} (${F.fmtInt(t.count)})`).join(', ') || F.DASH,
      },
      numCol('customers', 'Clientes', (r) => r.customers),
      { key: 'lastAt', label: 'Última vez', sort: relSort('lastAt'), firstDir: 'desc', cell: (r, td) => relTime(td, r.lastAt, clock.now()) },
    ],
    rowKey: (r) => r.code,
    defaultSort: { key: 'count', dir: 'desc' },
    empty: 'Nenhuma falha neste período.',
  });
  codeP.el.append(codeTable.el);

  // 4. Por dia
  const dayP = panel('h-uso-dia', 'Por dia', { icon: 'calendar' });
  const dayTable = createTable({
    label: 'Uso por dia',
    columns: [
      { key: 'day', label: 'Dia', sort: (r) => r.day, firstDir: 'desc', text: (r) => F.fmtDayShort(r.day), title: (r) => F.fmtCalendarDay(r.day) },
      numCol('calls', 'Chamadas', (r) => r.calls),
      numCol('failures', 'Falhas', (r) => r.failures),
      durCol('p50', 'p50', (r) => r.p50Ms),
      durCol('p90', 'p90', (r) => r.p90Ms),
      numCol('customers', 'Clientes ativos', (r) => r.customers, { flex: true }),
    ],
    rowKey: (r) => r.day,
    defaultSort: { key: 'day', dir: 'desc' },
    empty: 'Nenhuma chamada neste período.',
  });
  dayP.el.append(dayTable.el);

  // 5. Acessos recusados (Caddy)
  const NOTE = 'O servidor não registra 401, 403 e 429; estes vêm do log do Caddy e só têm o IP.';
  const deniedP = panel('h-uso-recusas', 'Acessos recusados (Caddy)', { icon: 'ban', note: NOTE });
  let deniedEmpty = 'Nenhum acesso recusado registrado.';
  const deniedTable = createTable({
    label: 'Acessos recusados pelo Caddy',
    columns: [
      { key: 'ip', label: 'IP', mono: true, ell: 'code', sort: (r) => r.ip, text: (r) => r.ip },
      { key: 'status', label: 'Status', num: true, sort: (r) => r.status, text: (r) => String(r.status ?? F.DASH) },
      { key: 'path', label: 'Caminho', mono: true, ell: 'path', flex: true, sort: (r) => r.path, text: (r) => r.path || F.DASH },
      numCol('count', 'Ocorrências', (r) => r.count),
      { key: 'lastAt', label: 'Última vez', sort: relSort('lastAt'), firstDir: 'desc', cell: (r, td) => relTime(td, r.lastAt, clock.now()) },
    ],
    rowKey: (r) => `${r.ip}|${r.status}|${r.path}`,
    defaultSort: { key: 'count', dir: 'desc' },
    empty: (mk) => mk(deniedEmpty, 'empty'),
  });
  deniedP.el.append(deniedTable.el);

  // charts row: calls per day (or per customer) and the top tools
  const fmtAxis = (v) => F.fmtInt(v);
  const perDay = columns({
    title: 'Chamadas por dia', cls: 'w3',
    series: [{ key: 'ok', label: 'Sem falha', c: 's1' }, { key: 'fail', label: 'Com falha', c: 's2' }],
    fmt: fmtAxis,
    twin: () => dayTable.table,
    aria: (rows) => sparkLabel('Chamadas por dia', rows.map((r) => r.total), { lastLabel: 'último dia' }),
  });
  const perCustomer = barlist({ title: 'Chamadas por cliente', cls: 'w3', n: 6, fmt: F.fmtInt, twin: () => custTable.table });
  const topTools = barlist({ title: 'Ferramentas mais usadas', mono: true, n: 6, fmt: F.fmtInt, twin: () => toolTable.table });
  const chartsRow = h('section', { class: 'kgrid charts', 'aria-label': 'Gráficos de uso' }, perDay.el, perCustomer.el, topTools.el);

  const pair = h('div', { class: 'cols-2' }, codeP.el, dayP.el);
  section.append(head.el, cards.el, chartsRow, custP.el, toolP.el, pair, deniedP.el);

  const tables = [
    [custTable, custP], [toolTable, toolP], [codeTable, codeP], [dayTable, dayP], [deniedTable, deniedP],
  ];

  function paintControls() {
    period.paint(range, day, F.localDay(clock.now()));
    custP.el.hidden = !!token;
  }

  function syncHash() {
    const p = new URLSearchParams();
    if (token) p.set('token', token);
    if (range !== '7d') p.set('range', range);
    if (range === 'day' && day) p.set('day', day);
    const s = p.toString();
    try {
      history.replaceState(null, '', `${location.pathname}${location.search}#/uso${s ? `?${s}` : ''}`);
    } catch {
      /* ignore */
    }
  }

  function setRange(r, d) {
    range = r;
    day = d || '';
    syncHash();
    paintControls();
    ctx.refreshNow();
  }

  async function fillCustomers() {
    let lic = ctx.store.licenses;
    if (!lic) {
      try {
        const d = await ctx.api.licenses();
        lic = d.licenses || [];
        ctx.store.licenses = lic;
      } catch {
        lic = [];
      }
    }
    const opts = [{ value: '', label: 'Todos os clientes' }];
    const sorted = lic.slice().sort((a, b) => String(a.customer).localeCompare(String(b.customer), 'pt-BR'));
    for (const l of sorted) opts.push({ value: l.id, label: F.fmtCustomerToken(l.customer, l.id) });
    if (token && !opts.some((o) => o.value === token)) opts.push({ value: token, label: F.fmtCustomerToken(token, token) });
    setOptions(custSel, opts);
    custSel.value = token;
  }

  function paintCharts() {
    const calls = data.totals?.calls ?? (data.byDay || []).reduce((s, d) => s + (d.calls || 0), 0);
    const days = daysAscending(data);
    chartsRow.hidden = !calls;
    if (!calls) return;
    const many = days.length >= 2;
    perDay.el.hidden = !many;
    perCustomer.el.hidden = many || !!token;
    topTools.el.classList.toggle('w3', !many && !!token);
    if (many) {
      perDay.update(days.map((d) => {
        const c = d.calls || 0;
        const f = d.failures || 0;
        return {
          x: F.fmtDayShort(d.day), heading: `${F.fmtDayShort(d.day).split(' ')[0]} ${F.fmtCalendarDay(d.day)}`, total: c,
          values: { ok: Math.max(0, c - f), fail: f },
          tip: [
            { c: 's1', value: F.fmtInt(c), label: c === 1 ? 'chamada' : 'chamadas' },
            { c: 's2', value: `${F.fmtInt(f)} (${F.fmtShare(f, c)})`, label: f === 1 ? 'falha' : 'falhas' },
            { value: F.fmtDuration(d.p50Ms), label: 'p50' },
            { value: F.fmtDuration(d.p90Ms), label: 'p90' },
            { value: F.fmtInt(d.customers), label: 'clientes ativos' },
          ],
        };
      }));
    } else if (!token) {
      perCustomer.update((data.byCustomer || []).map((r) => ({ label: r.customer || r.token, value: r.calls })));
    }
    topTools.update((data.byTool || []).map((r) => ({ label: r.tool, value: r.calls })));
  }

  function render() {
    if (!data) return;
    head.setSub(rangeText(data.range));
    cards.render(kpis(data, ctx.store.overview?.alerts));
    paintCharts();
    custTable.setRows(data.byCustomer || []);
    toolTable.setRows(data.byTool || []);
    codeTable.setRows(data.byCode || []);
    dayTable.setRows(data.byDay || []);
    const dn = data.denied || {};
    if (dn.available === false) {
      deniedEmpty = 'Sem dados do Caddy (coletor parado).';
      deniedP.setNote(NOTE);
      deniedTable.setRows([]);
    } else {
      deniedEmpty = `Nenhum acesso recusado registrado desde ${dn.since ? F.fmtDate(dn.since) : 'o início do painel'}.`;
      const parts = deniedParts(dn);
      deniedP.setNote(parts.length ? `${NOTE} Por status: ${parts.map((p) => `${p.status} · ${F.fmtInt(p.count)}`).join(', ')}.` : NOTE);
      deniedTable.setRows(dn.rows || []);
    }
    for (const [t, p] of tables) {
      p.setCount(t.countText());
      p.setStale('');
    }
  }

  return {
    interval: () => (range === 'today' ? 30000 : 120000),
    async refresh() {
      const current = () => {
        const p = { range };
        if (range === 'day') p.day = day;
        if (token) p.token = token;
        return p;
      };
      const params = current();
      try {
        const d = await ctx.api.usage(params);
        // The range or the customer changed while this answer was on its way: the rerun (main.js) paints the new one.
        if (JSON.stringify(params) !== JSON.stringify(current())) return;
        data = d;
        lastOk = clock.now();
        render();
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
    show(params) {
      token = params.get('token') || '';
      const r = params.get('range');
      range = r === 'today' || r === '7d' || r === '30d' || r === 'day' ? r : '7d';
      day = range === 'day' ? (params.get('day') || '') : '';
      if (range === 'day' && !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        range = '7d';
        day = '';
      }
      paintControls();
      fillCustomers();
    },
    focusFilter() {
      toolFilter.focus();
      return true;
    },
  };
}
