// Uso (DESIGN.md 6.5): calls per customer, tool, failure code and day, and the denials Caddy saw. Range Hoje /
// 7 dias / 30 dias / one day; one customer or all. Polls every 30 s (today) or 120 s (other ranges).

import * as F from '../format.js';
import { h, clear, sectionHead, select, setOptions, filterInput, joinDots } from '../dom.js';
import { createTable, filterRows } from '../table.js';
import { sparkline, sparkLabel } from '../sparkline.js';
import { relTime, relSort, errorMessage, staleText, muted } from './common.js';

const RANGES = [
  { id: 'today', label: 'Hoje' },
  { id: '7d', label: '7 dias' },
  { id: '30d', label: '30 dias' },
];

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

export default function createUso(ctx, section) {
  const { clock } = ctx;
  let range = '7d';
  let day = '';
  let token = '';
  let toolText = '';
  let data = null;
  let lastOk = null;

  const rangeBtns = RANGES.map((r) => {
    const b = h('button', { type: 'button', class: 'seg', 'aria-pressed': 'false', dataset: { range: r.id } }, r.label);
    b.addEventListener('click', () => setRange(r.id, ''));
    return b;
  });
  const dayInput = h('input', { type: 'date', class: 'ctl day', 'aria-label': 'Dia' });
  dayInput.addEventListener('change', () => {
    if (dayInput.value) setRange('day', dayInput.value);
  });
  const dayLabel = h('label', { class: 'seglabel' }, 'Dia: ', dayInput);
  const segs = h('div', { class: 'segs', role: 'group', 'aria-label': 'Período' }, ...joinDots([...rangeBtns, dayLabel]));
  const custSel = select('Cliente', [{ value: '', label: 'Todos os clientes' }], {
    onChange: (v) => {
      token = v;
      syncHash();
      paintControls();
      ctx.refreshNow();
    },
  });
  const head = sectionHead('Uso', { id: 'h-uso', controls: [segs, custSel] });
  const echo = muted('', 'echo');

  // 1. Por cliente
  const custHead = sectionHead('Por cliente', { id: 'h-uso-cliente' });
  const custTable = createTable({
    label: 'Uso por cliente',
    columns: [
      { key: 'customer', label: 'Cliente', ell: 'name', sort: (r) => r.customer, text: (r) => r.customer || r.token },
      numCol('calls', 'Chamadas', (r) => r.calls),
      numCol('failures', 'Falhas', (r) => r.failures),
      shareCol('pct', '% falhas', (r) => r.failures, (r) => r.calls),
      durCol('p50', 'p50', (r) => r.p50Ms),
      durCol('p90', 'p90', (r) => r.p90Ms),
      { key: 'topTool', label: 'Ferramenta mais usada', mono: true, ell: 'code', sort: (r) => r.topTool, text: (r) => r.topTool || F.DASH },
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
  const custBlock = h('div', { class: 'block', role: 'region', 'aria-labelledby': 'h-uso-cliente' }, custHead.el, custTable.el);

  // 2. Por ferramenta
  const toolFilter = filterInput('filtrar ferramenta', (v) => {
    toolText = v;
    toolTable.setFilter(toolText.trim() ? (r) => filterRows([r], toolText, ['tool']).length > 0 : null);
    toolHead.setCount(toolTable.countText());
  });
  const toolHead = sectionHead('Por ferramenta', { id: 'h-uso-ferramenta', controls: [toolFilter] });
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
      { key: 'topCode', label: 'Código mais comum', mono: true, ell: 'code', sort: (r) => r.topCode, text: (r) => r.topCode || F.DASH },
    ],
    rowKey: (r) => r.tool,
    defaultSort: { key: 'calls', dir: 'desc' },
    empty: 'Nenhuma chamada neste período.',
    filteredEmpty: 'Nenhuma ferramenta com esse filtro.',
  });

  // 3. Falhas por código
  const codeHead = sectionHead('Falhas por código', { id: 'h-uso-codigo' });
  const codeTable = createTable({
    label: 'Falhas por código',
    columns: [
      { key: 'code', label: 'Código', mono: true, ell: 'code', sort: (r) => r.code, text: (r) => r.code },
      numCol('count', 'Ocorrências', (r) => r.count),
      {
        key: 'tools', label: 'Ferramentas', ell: 'text', sort: (r) => (r.tools || [])[0]?.tool ?? null,
        text: (r) => (r.tools || []).map((t) => `${t.tool} (${F.fmtInt(t.count)})`).join(', ') || F.DASH,
      },
      numCol('customers', 'Clientes', (r) => r.customers),
      { key: 'lastAt', label: 'Última vez', sort: relSort('lastAt'), firstDir: 'desc', cell: (r, td) => relTime(td, r.lastAt, clock.now()) },
    ],
    rowKey: (r) => r.code,
    defaultSort: { key: 'count', dir: 'desc' },
    empty: 'Nenhuma falha neste período.',
  });

  // 4. Por dia
  const dayHead = sectionHead('Por dia', { id: 'h-uso-dia' });
  const dayTable = createTable({
    label: 'Uso por dia',
    columns: [
      { key: 'day', label: 'Dia', sort: (r) => r.day, firstDir: 'desc', text: (r) => F.fmtDayShort(r.day), title: (r) => F.fmtCalendarDay(r.day) },
      numCol('calls', 'Chamadas', (r) => r.calls),
      numCol('failures', 'Falhas', (r) => r.failures),
      durCol('p50', 'p50', (r) => r.p50Ms),
      durCol('p90', 'p90', (r) => r.p90Ms),
      numCol('customers', 'Clientes ativos', (r) => r.customers),
    ],
    rowKey: (r) => r.day,
    defaultSort: { key: 'day', dir: 'desc' },
    empty: 'Nenhuma chamada neste período.',
  });

  // 5. Acessos recusados (Caddy)
  const deniedHead = sectionHead('Acessos recusados (Caddy)', { id: 'h-uso-recusas' });
  const deniedNote = muted('O servidor não registra 401, 403 e 429; estes vêm do log do Caddy e só têm o IP.', 'note');
  let deniedEmpty = 'Nenhum acesso recusado registrado.';
  const deniedTable = createTable({
    label: 'Acessos recusados pelo Caddy',
    columns: [
      { key: 'ip', label: 'IP', mono: true, ell: 'code', sort: (r) => r.ip, text: (r) => r.ip },
      { key: 'status', label: 'Status', num: true, sort: (r) => r.status, text: (r) => String(r.status ?? F.DASH) },
      { key: 'path', label: 'Caminho', mono: true, ell: 'path', sort: (r) => r.path, text: (r) => r.path || F.DASH },
      numCol('count', 'Ocorrências', (r) => r.count),
      { key: 'lastAt', label: 'Última vez', sort: relSort('lastAt'), firstDir: 'desc', cell: (r, td) => relTime(td, r.lastAt, clock.now()) },
    ],
    rowKey: (r) => `${r.ip}|${r.status}|${r.path}`,
    defaultSort: { key: 'count', dir: 'desc' },
    empty: (mk) => mk(deniedEmpty, 'empty'),
  });

  section.append(
    h('div', { class: 'block', role: 'region', 'aria-labelledby': 'h-uso' }, head.el, echo),
    custBlock,
    h('div', { class: 'block', role: 'region', 'aria-labelledby': 'h-uso-ferramenta' }, toolHead.el, toolTable.el),
    h('div', { class: 'block', role: 'region', 'aria-labelledby': 'h-uso-codigo' }, codeHead.el, codeTable.el),
    h('div', { class: 'block', role: 'region', 'aria-labelledby': 'h-uso-dia' }, dayHead.el, dayTable.el),
    h('div', { class: 'block', role: 'region', 'aria-labelledby': 'h-uso-recusas' }, deniedHead.el, deniedNote, deniedTable.el),
  );

  const tables = [
    [custTable, custHead], [toolTable, toolHead], [codeTable, codeHead], [dayTable, dayHead], [deniedTable, deniedHead],
  ];

  function paintControls() {
    for (const b of rangeBtns) b.setAttribute('aria-pressed', b.dataset.range === range ? 'true' : 'false');
    dayLabel.classList.toggle('on', range === 'day');
    if (range === 'day') dayInput.value = day;
    else dayInput.value = '';
    dayInput.max = F.localDay(clock.now());
    custBlock.hidden = !!token;
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

  function render() {
    if (!data) return;
    echo.textContent = rangeText(data.range);
    custTable.setRows(data.byCustomer || []);
    toolTable.setRows(data.byTool || []);
    codeTable.setRows(data.byCode || []);
    dayTable.setRows(data.byDay || []);
    const dn = data.denied || {};
    if (dn.available === false) {
      deniedEmpty = 'Sem dados do Caddy (coletor parado).';
      deniedTable.setRows([]);
    } else {
      deniedEmpty = `Nenhum acesso recusado registrado desde ${dn.since ? F.fmtDate(dn.since) : 'o início do painel'}.`;
      deniedTable.setRows(dn.rows || []);
    }
    for (const [t, hd] of tables) {
      hd.setCount(t.countText());
      hd.setStale('');
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
        for (const [t, hd] of tables) {
          t.setError(msg);
          if (t.hasRows()) hd.setStale(staleText(lastOk));
        }
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
