// Qualidade (DESIGN-QUALIDADE 4.5): what the hosted server recorded of every tool call, only codes, counts and times.
// A Resumo key-value table and nine tables: the most common error codes, the problems of the refusals by code, the
// engine's automatic corrections by rule, the delivery phases per tool (p50 / p90) and their share of the time, the
// rounds until "entregue" per customer and what causes them, per customer and per MCP client. Range Hoje / 7 dias /
// 30 dias / one day; one customer or all; a CSV per table, the whole payload as JSON and the lines as JSONL.
// Polls every 60 s (today) or 300 s (other ranges). Tables only, textContent only.

import * as F from '../format.js';
import { h, dot, sectionHead, select, setOptions, joinDots, textButton } from '../dom.js';
import { createTable, fillKv } from '../table.js';
import { PHASE_KEYS, PHASE_WORD, PROBLEM_PHASE_KEYS, PROBLEM_PHASE_WORD, CLIENT_WORD, RULE_TEXT, wordOf } from '../labels.js';
import { relTime, relSort, errorMessage, staleText, muted } from './common.js';
import { rangeText } from './uso.js';

const RANGES = [
  { id: 'today', label: 'Hoje' },
  { id: '7d', label: '7 dias' },
  { id: '30d', label: '30 dias' },
];

export const PRIVACY = 'Só códigos, contagens e tempos. Nenhum nome, expressão, caminho, job ou texto dos clientes é gravado.';
export const UNAVAILABLE = 'O servidor ainda não grava os registros de qualidade (imagem anterior ao registro, ou SSAM_QUALITY=0).';
export const LINES_ONLY_7D = 'Só para períodos de até 7 dias.';

/** `Indexando os registros de qualidade: 42%.` while the console replays the quality files (else ''). */
export function indexingText(idx) {
  if (!idx || idx.state !== 'running') return '';
  return `Indexando os registros de qualidade: ${Math.round((Number(idx.progress) || 0) * 100)}%.`;
}

/** `p50 2 · p90 8` (or `p50 0 · máximo 1`); a dash when neither value exists. */
const pq = (label, a, b, fmt) => (a == null && b == null ? F.DASH : `p50 ${fmt(a)} · ${label} ${fmt(b)}`);

/** The rows of the Resumo key-value table (Item / Valor) from the payload's totals. */
export function resumoRows(t) {
  const x = t || {};
  const calls = x.calls ?? 0;
  const failures = x.failures ?? 0;
  const phases = PROBLEM_PHASE_KEYS.filter((k) => (x.problemPhases?.[k] ?? 0) > 0)
    .map((k) => `${PROBLEM_PHASE_WORD[k]} ${F.fmtInt(x.problemPhases[k])}`);
  const gaps = x.gapP50Ms == null && x.gapP90Ms == null ? [] : [`p50 ${F.fmtDuration(x.gapP50Ms)}`, `p90 ${F.fmtDuration(x.gapP90Ms)}`];
  return [
    { label: 'Chamadas', value: `${F.fmtInt(calls)} · ${F.fmtInt(failures)} com falha${calls ? ` (${F.fmtShare(failures, calls)})` : ''}` },
    {
      label: 'Entregas',
      value: [F.plural(x.delivered ?? 0, 'entregue ou criada', 'entregues ou criadas'), F.plural(x.refusals ?? 0, 'recusa', 'recusas'),
        F.plural(x.uncertain ?? 0, 'incerta', 'incertas')].join(' · '),
    },
    { label: 'Cadeias até entregar', value: `${F.plural(x.chains ?? 0, 'entregue', 'entregues')} · ${F.fmtInt(x.chainsOpen ?? 0)} sem entrega` },
    { label: 'Voltas do modelo por cadeia', value: pq('p90', x.turnsPerChainP50, x.turnsPerChainP90, F.fmtInt) },
    { label: 'Chamadas por cadeia', value: pq('p90', x.callsPerChainP50, x.callsPerChainP90, F.fmtInt) },
    { label: 'Recusas antes de entregar', value: pq('máximo', x.refusalsBeforeP50, x.refusalsBeforeMax, F.fmtInt) },
    { label: 'Tempo até entregar', value: pq('p90', x.wallP50Ms, x.wallP90Ms, F.fmtDuration) },
    {
      label: 'Parado entre chamadas',
      value: [...gaps, F.plural(x.longGaps ?? 0, 'pausa acima de 10 min', 'pausas acima de 10 min')].join(' · '),
    },
    { label: 'Parte parada das cadeias', value: F.fmtPct(x.idlePct) },
    {
      label: 'Problemas nas recusas',
      value: [F.fmtInt(x.problems ?? 0), `${F.fmtInt(x.withPatch ?? 0)} com correção pronta`, ...phases].join(' · '),
    },
    { label: 'Correções automáticas', value: `${F.fmtInt(x.normalizations ?? 0)} em ${F.plural(x.normalizedCalls ?? 0, 'chamada', 'chamadas')}` },
    { label: 'Chamadas em paralelo', value: `${F.fmtInt(x.sharedCalls ?? 0)} (fora das tabelas de fases)` },
  ];
}

/** `o11_deliver (2), studio_deliver (1)` */
export function toolsText(list) {
  return (list || []).map((t) => `${t.tool} (${F.fmtInt(t.count)})`).join(', ') || F.DASH;
}

/** A share of the time: one decimal (`48,9%`), a dash for 0 or null. */
export function pctCell(v) {
  return v == null || !Number(v) ? F.DASH : F.fmtPctFine(v);
}

/** Kernel frio: `8 de 10` cold runs of the kernel runs, a dash without runs. */
export function coldText(r) {
  return r.kernelRuns ? `${F.fmtInt(r.kernelCold ?? 0)} de ${F.fmtInt(r.kernelRuns)}` : F.DASH;
}

/** The `Todos` row of Voltas até entregar, from the totals (shown when more than one customer has chains). */
export function totalRound(t) {
  return {
    token: '', customer: 'Todos', chains: t.chains, open: t.chainsOpen, turnsP50: t.turnsPerChainP50, turnsP90: t.turnsPerChainP90,
    callsP50: t.callsPerChainP50, callsP90: t.callsPerChainP90, refusalsBeforeP50: t.refusalsBeforeP50, refusalsBeforeMax: t.refusalsBeforeMax,
    wallP50Ms: t.wallP50Ms, wallP90Ms: t.wallP90Ms, gapP50Ms: t.gapP50Ms, gapP90Ms: t.gapP90Ms, idlePct: t.idlePct,
  };
}

const numCol = (key, label, get, extra = {}) => ({
  key, label, num: true, sort: (r) => get(r) ?? null, text: (r) => F.fmtInt(get(r)), ...extra,
});
const codeCol = (key, label, get) => ({ key, label, mono: true, ell: 'code', sort: (r) => get(r) ?? null, text: (r) => get(r) || F.DASH });
const pairCol = (key, label, a, b, fmt) => ({
  key, label, num: true, sort: (r) => a(r) ?? null, text: (r) => F.fmtPair(a(r), b(r), fmt),
});
const toolsCol = { key: 'tools', label: 'Ferramentas', ell: 'text', sort: (r) => (r.tools || [])[0]?.tool ?? null, text: (r) => toolsText(r.tools) };

export default function createQualidade(ctx, section) {
  const { clock } = ctx;
  let range = '7d';
  let day = '';
  let token = '';
  let data = null;
  let lastOk = null;

  // ---- heading: range, customer, the two whole exports
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
  const allBtn = textButton('Exportar tudo (JSON)', () => exportTable('tudo', 'json', allBtn));
  const linesBtn = textButton('Exportar linhas (JSONL)', () => exportTable('linhas', 'jsonl', linesBtn));
  const exportsGroup = h('div', { class: 'segs', role: 'group', 'aria-label': 'Exportar' }, ...joinDots([allBtn, linesBtn]));
  const head = sectionHead('Qualidade', { id: 'h-qualidade', controls: [segs, custSel, exportsGroup] });
  const echo = muted('', 'echo');
  const privacy = muted(PRIVACY, 'note');
  const indexLine = muted('', 'note');
  indexLine.hidden = true;

  // ---- the notice when the server does not record yet
  const notice = h('div', { class: 'block', hidden: true },
    h('div', { class: 'table-wrap' }, h('table', { class: 'grid notice-table', 'aria-label': 'Registros de qualidade' },
      h('tbody', null, h('tr', { class: 'state' }, h('td', null, dot('warn'), UNAVAILABLE))))));

  /** A section: heading with its count and a CSV text button, an optional note, the table. */
  function block(id, title, table, exportName, note) {
    const csv = textButton('CSV', () => exportTable(exportName, 'csv', csv), { 'aria-label': `${title}: exportar CSV` });
    const hd = sectionHead(title, { id, controls: [csv] });
    const el = h('div', { class: 'block', role: 'region', 'aria-labelledby': id }, hd.el, note ? muted(note, 'note') : null, table.el || table);
    return { head: hd, el };
  }

  // 1. Resumo (key-value table Item / Valor; keeps its two columns at phone width)
  const resumoBody = h('tbody');
  const resumoTable = h('table', { class: 'kv kv-keep', 'aria-label': 'Resumo da qualidade' },
    h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Item'), h('th', { scope: 'col' }, 'Valor'))), resumoBody);
  const resumo = block('h-q-resumo', 'Resumo', { el: h('div', { class: 'table-wrap' }, resumoTable) }, 'resumo');

  // 2. Códigos de erro mais comuns
  const errTable = createTable({
    label: 'Códigos de erro mais comuns',
    columns: [
      codeCol('code', 'Código', (r) => r.code),
      numCol('count', 'Ocorrências', (r) => r.count),
      { key: 'pct', label: '% das falhas', num: true, sort: (r) => r.pctOfFailures ?? null, text: (r) => F.fmtPctFine(r.pctOfFailures) },
      toolsCol,
      numCol('customers', 'Clientes', (r) => r.customers),
      { key: 'lastAt', label: 'Última vez', sort: relSort('lastAt'), firstDir: 'desc', cell: (r, td) => relTime(td, r.lastAt, clock.now()) },
    ],
    rowKey: (r) => r.code,
    defaultSort: { key: 'count', dir: 'desc' },
    empty: 'Nenhuma falha neste período.',
  });
  const errors = block('h-q-erros', 'Códigos de erro mais comuns', errTable, 'erros');

  // 3. Problemas das recusas por código
  const probTable = createTable({
    label: 'Problemas das recusas por código',
    columns: [
      codeCol('code', 'Código', (r) => r.code),
      numCol('count', 'Problemas', (r) => r.count),
      numCol('refusals', 'Recusas', (r) => r.refusals),
      numCol('withPatch', 'Com correção pronta', (r) => r.withPatch),
      toolsCol,
      numCol('customers', 'Clientes', (r) => r.customers),
    ],
    rowKey: (r) => r.code,
    defaultSort: { key: 'count', dir: 'desc' },
    empty: 'Nenhuma recusa com problemas neste período.',
  });
  const problems = block('h-q-problemas', 'Problemas das recusas por código', probTable, 'problemas',
    'Com correção pronta: o problema veio com o patch certo na recusa (o motor já sabia corrigir).');

  // 4. Correções automáticas por regra
  const ruleTable = createTable({
    label: 'Correções automáticas por regra',
    columns: [
      codeCol('rule', 'Regra', (r) => r.rule),
      { key: 'what', label: 'O que o motor fez', ell: 'text', sort: (r) => wordOf(RULE_TEXT, r.rule) ?? null, text: (r) => wordOf(RULE_TEXT, r.rule) || F.DASH },
      numCol('count', 'Correções', (r) => r.count),
      numCol('calls', 'Chamadas', (r) => r.calls),
      toolsCol,
      numCol('customers', 'Clientes', (r) => r.customers),
    ],
    rowKey: (r) => r.rule,
    defaultSort: { key: 'count', dir: 'desc' },
    empty: 'Nenhuma correção automática neste período.',
  });
  const rules = block('h-q-regras', 'Correções automáticas por regra', ruleTable, 'correcoes');

  // 5. Fases da entrega por ferramenta (p50 / p90)
  const phaseTable = createTable({
    label: 'Fases da entrega por ferramenta',
    columns: [
      { key: 'tool', label: 'Ferramenta', mono: true, ell: 'code', sort: (r) => r.tool, text: (r) => r.tool },
      numCol('calls', 'Chamadas', (r) => r.calls),
      pairCol('total', 'Total', (r) => r.total?.p50, (r) => r.total?.p90, F.fmtDuration),
      ...PHASE_KEYS.map((k) => pairCol(k, PHASE_WORD[k], (r) => r[k]?.p50, (r) => r[k]?.p90, F.fmtDuration)),
      { key: 'cold', label: 'Kernel frio', num: true, sort: (r) => r.kernelCold ?? null, text: coldText },
    ],
    rowKey: (r) => r.tool,
    defaultSort: { key: 'calls', dir: 'desc' },
    empty: 'Nenhuma chamada com tempo de fase neste período.',
  });
  const phaseNote = muted('', 'note');
  const phases = block('h-q-fases', 'Fases da entrega por ferramenta (p50 / p90)', { el: h('div', null, phaseNote, phaseTable.el) }, 'fases');

  // 6. Para onde vai o tempo
  const shareTable = createTable({
    label: 'Para onde vai o tempo',
    columns: [
      { key: 'tool', label: 'Ferramenta', mono: true, ell: 'code', sort: (r) => r.tool, text: (r) => r.tool },
      { key: 'sumMs', label: 'Tempo total', num: true, sort: (r) => r.sumMs ?? null, text: (r) => F.fmtDuration(r.sumMs) },
      ...PHASE_KEYS.map((k) => ({ key: k, label: PHASE_WORD[k], num: true, sort: (r) => r[`${k}Pct`] ?? null, text: (r) => pctCell(r[`${k}Pct`]) })),
    ],
    rowKey: (r) => r.tool,
    defaultSort: { key: 'sumMs', dir: 'desc' },
    empty: 'Nenhuma chamada com tempo de fase neste período.',
  });
  const share = block('h-q-tempo', 'Para onde vai o tempo', shareTable, 'tempo', 'Soma do período, em % do tempo total de cada ferramenta.');

  // 7. Voltas até entregar (a last row Todos from the totals when more than one customer has chains)
  const roundColumns = [
    { key: 'customer', label: 'Cliente', ell: 'name', sort: (r) => r.customer, text: (r) => r.customer || r.token },
    numCol('chains', 'Cadeias', (r) => r.chains),
    numCol('open', 'Sem entrega', (r) => r.open),
    pairCol('turns', 'Voltas do modelo (p50 / p90)', (r) => r.turnsP50, (r) => r.turnsP90, F.fmtInt),
    pairCol('calls', 'Chamadas (p50 / p90)', (r) => r.callsP50, (r) => r.callsP90, F.fmtInt),
    pairCol('refusals', 'Recusas antes de entregar (p50 / máx.)', (r) => r.refusalsBeforeP50, (r) => r.refusalsBeforeMax, F.fmtInt),
    pairCol('wall', 'Tempo até entregar (p50 / p90)', (r) => r.wallP50Ms, (r) => r.wallP90Ms, F.fmtDuration),
    pairCol('gap', 'Parado entre chamadas (p50 / p90)', (r) => r.gapP50Ms, (r) => r.gapP90Ms, F.fmtDuration),
    { key: 'idle', label: 'Parte parada', num: true, sort: (r) => r.idlePct ?? null, text: (r) => F.fmtPct(r.idlePct) },
  ];
  const roundTable = createTable({
    label: 'Voltas até entregar',
    columns: roundColumns,
    rowKey: (r) => r.token,
    defaultSort: { key: 'chains', dir: 'desc' },
    empty: 'Nenhuma entrega neste período.',
    footer: (tfoot, n, list) => {
      if (!data || list.length < 2) return;
      const all = totalRound(data.totals || {});
      const tr = h('tr', { class: 'total' });
      roundColumns.forEach((c, i) => {
        const td = h(i === 0 ? 'th' : 'td', { class: [c.num && 'num'], scope: i === 0 ? 'row' : null });
        td.textContent = c.text(all);
        tr.append(td);
      });
      tfoot.append(tr);
    },
  });
  const rounds = block('h-q-voltas', 'Voltas até entregar', roundTable, 'voltas',
    'Cadeia: as chamadas de uma sessão MCP até "entregue". Volta do modelo: chamada sem outra em andamento, 1 s ou mais depois da última resposta.');

  // 8. O que mais gera voltas
  const causeTable = createTable({
    label: 'O que mais gera voltas',
    columns: [
      codeCol('code', 'Código', (r) => r.code),
      numCol('refusals', 'Recusas', (r) => r.refusals),
      numCol('chains', 'Cadeias', (r) => r.chains),
      numCol('extraCallsSum', 'Chamadas a mais (soma)', (r) => r.extraCallsSum),
      numCol('extraCallsP50', 'Chamadas a mais (p50)', (r) => r.extraCallsP50),
      { key: 'extraMsP50', label: 'Tempo a mais (p50)', num: true, sort: (r) => r.extraMsP50 ?? null, text: (r) => F.fmtDuration(r.extraMsP50) },
    ],
    rowKey: (r) => r.code,
    defaultSort: { key: 'extraCallsSum', dir: 'desc' },
    empty: 'Nenhuma recusa antes de uma entrega neste período.',
  });
  const causes = block('h-q-causas', 'O que mais gera voltas', causeTable, 'causas',
    'Uma recusa com vários códigos conta para cada um deles. Chamadas a mais: da recusa até "entregue".');

  // 9. Por cliente (hidden when one customer is selected)
  const custTable = createTable({
    label: 'Qualidade por cliente',
    columns: [
      { key: 'customer', label: 'Cliente', ell: 'name', sort: (r) => r.customer, text: (r) => r.customer || r.token },
      numCol('calls', 'Chamadas', (r) => r.calls),
      numCol('failures', 'Falhas', (r) => r.failures),
      numCol('refusals', 'Recusas', (r) => r.refusals),
      numCol('delivered', 'Entregas', (r) => r.delivered),
      codeCol('topError', 'Erro mais comum', (r) => r.topError),
      codeCol('topProblem', 'Problema mais comum', (r) => r.topProblem),
      codeCol('topRule', 'Regra mais aplicada', (r) => r.topRule),
      { key: 'slowest', label: 'Fase mais lenta', sort: (r) => wordOf(PHASE_WORD, r.slowestPhase) ?? null, text: (r) => wordOf(PHASE_WORD, r.slowestPhase) || F.DASH },
    ],
    rowKey: (r) => r.token,
    defaultSort: { key: 'calls', dir: 'desc' },
    empty: 'Nenhuma chamada neste período.',
  });
  const byCustomer = block('h-q-clientes', 'Por cliente', custTable, 'clientes');

  // 10. Por cliente MCP
  const clientTable = createTable({
    label: 'Qualidade por cliente MCP',
    columns: [
      { key: 'client', label: 'Cliente MCP', sort: (r) => wordOf(CLIENT_WORD, r.client) || r.client, text: (r) => wordOf(CLIENT_WORD, r.client) || r.client || F.DASH },
      numCol('sessions', 'Sessões', (r) => r.sessions),
      numCol('chains', 'Cadeias', (r) => r.chains),
      numCol('turnsP50', 'Voltas do modelo (p50)', (r) => r.turnsP50),
      numCol('callsP50', 'Chamadas (p50)', (r) => r.callsP50),
      { key: 'refusalsAvg', label: 'Recusas antes de entregar (média)', num: true, sort: (r) => r.refusalsBeforeAvg ?? null, text: (r) => F.fmtNumMax1(r.refusalsBeforeAvg) },
      { key: 'gap', label: 'Parado entre chamadas (p50)', num: true, sort: (r) => r.gapP50Ms ?? null, text: (r) => F.fmtDuration(r.gapP50Ms) },
    ],
    rowKey: (r) => r.client,
    defaultSort: { key: 'sessions', dir: 'desc' },
    empty: 'Nenhuma sessão MCP neste período.',
  });
  const byClient = block('h-q-mcp', 'Por cliente MCP', clientTable, 'clientes-mcp');

  const blocks = [resumo, errors, problems, rules, phases, share, rounds, causes, byCustomer, byClient];
  const tables = [
    [errTable, errors.head, 'errors'], [probTable, problems.head, 'problems'], [ruleTable, rules.head, 'rules'], [phaseTable, phases.head, 'phases'],
    [shareTable, share.head, 'timeShare'], [roundTable, rounds.head, 'rounds'], [causeTable, causes.head, 'causes'],
    [custTable, byCustomer.head, 'byCustomer'], [clientTable, byClient.head, 'byClient'],
  ];

  section.append(
    h('div', { class: 'block', role: 'region', 'aria-labelledby': 'h-qualidade' }, head.el, echo, privacy, indexLine),
    notice,
    ...blocks.map((b) => b.el),
  );

  function paintControls() {
    for (const b of rangeBtns) b.setAttribute('aria-pressed', b.dataset.range === range ? 'true' : 'false');
    dayLabel.classList.toggle('on', range === 'day');
    dayInput.value = range === 'day' ? day : '';
    dayInput.max = F.localDay(clock.now());
    byCustomer.el.hidden = !!token || !available();
    const tooLong = range === '30d';
    linesBtn.disabled = tooLong;
    if (tooLong) linesBtn.title = LINES_ONLY_7D;
    else linesBtn.removeAttribute('title');
  }
  const available = () => !data || data.available !== false;

  function syncHash() {
    const p = new URLSearchParams();
    if (token) p.set('token', token);
    if (range !== '7d') p.set('range', range);
    if (range === 'day' && day) p.set('day', day);
    const s = p.toString();
    try {
      history.replaceState(null, '', `${location.pathname}${location.search}#/qualidade${s ? `?${s}` : ''}`);
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

  const params = () => {
    const p = { range };
    if (range === 'day') p.day = day;
    if (token) p.token = token;
    return p;
  };

  async function exportTable(table, format, btn) {
    if (btn) btn.disabled = true;
    try {
      await ctx.api.qualityExport({ ...params(), table, format });
    } catch (e) {
      if (e?.kind !== 'auth') ctx.notify(`Não foi possível exportar: ${errorMessage(e)}.`, 'bad');
    } finally {
      if (btn) btn.disabled = btn === linesBtn && range === '30d';
    }
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
    const idx = indexingText(data.indexing);
    indexLine.textContent = idx;
    indexLine.hidden = !idx;
    const on = data.available !== false;
    notice.hidden = on;
    for (const b of blocks) b.el.hidden = !on;
    paintControls();
    if (!on) return;
    fillKv(resumoBody, resumoRows(data.totals), false);
    phaseNote.textContent = `Cada célula: p50 / p90 por chamada. Chamadas em paralelo do mesmo cliente ficam fora: ${F.fmtInt(data.totals?.sharedCalls ?? 0)}.`;
    for (const [t, hd, key] of tables) {
      t.setRows(data[key] || []);
      hd.setCount(t.countText());
      hd.setStale('');
    }
  }

  return {
    interval: () => (range === 'today' ? 60000 : 300000),
    async refresh() {
      const asked = params();
      try {
        const d = await ctx.api.quality(asked);
        // The range or the customer changed while this answer was on its way: the rerun (main.js) paints the new one.
        if (JSON.stringify(asked) !== JSON.stringify(params())) return;
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
    show(p) {
      token = p.get('token') || '';
      const r = p.get('range');
      range = r === 'today' || r === '7d' || r === '30d' || r === 'day' ? r : '7d';
      day = range === 'day' ? (p.get('day') || '') : '';
      if (range === 'day' && !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        range = '7d';
        day = '';
      }
      paintControls();
      fillCustomers();
    },
  };
}
