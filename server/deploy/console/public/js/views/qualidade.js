// Qualidade (DESIGN-QUALIDADE 4.5, SPEC painel v2 4.4): what the hosted server recorded of every tool call, only codes,
// counts and times. Seven KPI cards (calls, success and refusal gauges, deliveries, time to deliver, model turns,
// problems of the refusals, idle time), two charts (the most common error codes, where the time goes), then a two-column
// Resumo key-value table and nine tables: the most common error codes, the problems of the refusals by code, the
// engine's automatic corrections by rule, the delivery phases per tool (p50 / p90) and their share of the time, the
// rounds until "entregue" per customer and what causes them, per customer and per MCP client. Range Hoje / 7 dias /
// 30 dias / one day; one customer or all; a CSV per table, the whole payload as JSON and the lines as JSONL.
// Polls every 60 s (today) or 300 s (other ranges). Every value goes in as text.

import * as F from '../format.js';
import { h, button, pageHead, panel, inlineNotice, iconChip, select, setOptions } from '../dom.js';
import { createTable, fillKv } from '../table.js';
import { createCards } from '../cards.js';
import { meter, meterLevel, meterTicks, barlist, stack100 } from '../charts.js';
import { PHASE_KEYS, PHASE_WORD, PROBLEM_PHASE_KEYS, PROBLEM_PHASE_WORD, CLIENT_WORD, RULE_TEXT, wordOf } from '../labels.js';
import { relTime, relSort, errorMessage, staleText, periodControls } from './common.js';
import { rangeText } from './uso.js';

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
const codeCol = (key, label, get, extra = {}) => ({ key, label, mono: true, ell: 'code', sort: (r) => get(r) ?? null, text: (r) => get(r) || F.DASH, ...extra });
/** A p50 / p90 cell: p50 on top, p90 under it (an .sr-only ' / ' between them); text keeps the one-line form. */
const pairCol = (key, label, a, b, fmt, { strongIf } = {}) => ({
  key, label, num: true, sort: (r) => a(r) ?? null, text: (r) => F.fmtPair(a(r), b(r), fmt),
  cell: (r, td) => {
    const p = F.pairParts(a(r), b(r), fmt);
    td.title = p.title;
    if (p.dash) {
      td.textContent = F.DASH;
      return;
    }
    td.append(h('span', { class: ['t1', strongIf && strongIf(r) && 'strong'] }, p.a), h('span', { class: 'sr-only' }, ' / '), h('span', { class: 't2' }, p.b));
  },
});
const toolsCol = { key: 'tools', label: 'Ferramentas', ell: 'text', flex: true, sort: (r) => (r.tools || [])[0]?.tool ?? null, text: (r) => toolsText(r.tools) };

const PROBLEM_SERIES = { preflight: 's1', base: 's2', apply: 's3', verify: 's4', other: 's5' };

/** The seven KPI cards of Qualidade (pure, from the payload totals). */
export function kpis(totals) {
  const x = totals || {};
  const calls = x.calls ?? 0;
  const fails = x.failures ?? 0;
  const refusals = x.refusals ?? 0;
  const succ = calls ? ((calls - fails) / calls) * 100 : null;
  const refu = calls ? (refusals / calls) * 100 : null;
  const sLv = meterLevel('success', succ);
  const rLv = meterLevel('refusal', refu);
  const worst = [sLv, rLv].includes('bad') ? 'bad' : [sLv, rLv].includes('warn') ? 'warn' : 'ok';
  const chains = x.chains ?? 0;
  const allChains = chains + (x.chainsOpen ?? 0);
  const phases = PROBLEM_PHASE_KEYS.filter((k) => (x.problemPhases?.[k] ?? 0) > 0);
  const dash = (v, fmt) => (v == null ? { value: F.DASH, muted: true } : { value: fmt(v) });
  return [
    {
      id: 'chamadas', label: 'Chamadas', icon: 'uso', level: 'ok', value: F.fmtInt(calls),
      context: calls ? `${F.fmtInt(fails)} com falha (${F.fmtShare(fails, calls)})` : 'sem chamadas',
    },
    {
      id: 'sucesso', label: 'Sucesso e recusas', icon: 'qualidade', span: 'w2', level: calls ? worst : 'ok',
      visual: {
        kind: 'gauges',
        items: [
          { label: 'Sucesso', value: succ, max: 100, level: sLv, display: F.fmtPct(succ), ticks: meterTicks('success'), missingText: 'sem chamadas', caption: calls ? `${F.fmtInt(calls - fails)} de ${F.fmtInt(calls)} chamadas` : '' },
          { label: 'Recusas', value: refu, max: 100, level: rLv, display: F.fmtPct(refu), ticks: meterTicks('refusal'), missingText: 'sem chamadas', caption: calls ? `${F.plural(refusals, 'recusa', 'recusas')}` : '' },
        ],
      },
    },
    {
      id: 'entregas', label: 'Entregas', icon: 'check-circle', level: 'ok', value: F.fmtInt(x.delivered ?? 0), unit: 'entregues ou criadas',
      context: `${F.plural(refusals, 'recusa', 'recusas')} · ${F.plural(x.uncertain ?? 0, 'incerta', 'incertas')}`,
      visual: allChains ? {
        kind: 'meter', label: 'Cadeias entregues', caption: 'Cadeias entregues', fraction: chains / allChains, level: 'accent',
        valueText: `${F.fmtInt(chains)} de ${F.fmtInt(allChains)}`,
      } : null,
    },
    {
      id: 'tempo', label: 'Tempo até entregar', icon: 'timer', level: 'ok', ...dash(x.wallP50Ms, F.fmtDuration), unit: x.wallP50Ms == null ? null : 'p50',
      context: x.wallP90Ms == null ? 'sem entregas' : `p90 ${F.fmtDuration(x.wallP90Ms)}`,
    },
    {
      id: 'voltas', label: 'Voltas do modelo', icon: 'loop', level: 'ok', ...dash(x.turnsPerChainP50, F.fmtInt), unit: x.turnsPerChainP50 == null ? null : 'p50 por cadeia',
      context: x.turnsPerChainP50 == null && x.turnsPerChainP90 == null ? 'sem cadeias'
        : `p90 ${F.fmtInt(x.turnsPerChainP90)} · chamadas por cadeia p50 ${F.fmtInt(x.callsPerChainP50)} / p90 ${F.fmtInt(x.callsPerChainP90)}`,
    },
    {
      id: 'problemas', label: 'Problemas nas recusas', icon: 'wrench', level: 'ok', value: F.fmtInt(x.problems ?? 0),
      context: `${F.fmtInt(x.withPatch ?? 0)} com correção pronta${x.problems ? ` (${F.fmtShare(x.withPatch ?? 0, x.problems)})` : ''} · ${F.plural(x.normalizations ?? 0, 'correção automática', 'correções automáticas')}`,
      visual: phases.length ? {
        kind: 'segbar', label: 'Problemas por fase', legend: true,
        parts: phases.map((k) => ({ count: x.problemPhases[k], c: PROBLEM_SERIES[k], word: `${PROBLEM_PHASE_WORD[k]} ${F.fmtInt(x.problemPhases[k])}` })),
      } : null,
    },
    {
      id: 'parado', label: 'Parado entre chamadas', icon: 'pause', level: 'ok', ...dash(x.gapP50Ms, F.fmtDuration), unit: x.gapP50Ms == null ? null : 'p50',
      context: [x.gapP90Ms == null ? null : `p90 ${F.fmtDuration(x.gapP90Ms)}`, F.plural(x.longGaps ?? 0, 'pausa acima de 10 min', 'pausas acima de 10 min')].filter(Boolean).join(' · '),
      visual: x.idlePct != null ? {
        kind: 'meter', label: 'Parte parada das cadeias', caption: 'Parte parada', fraction: Number(x.idlePct) / 100, level: 'accent', valueText: F.fmtPct(x.idlePct),
      } : null,
    },
  ];
}

/** Slots of the time-share chart: fixed per phase; queue and the server's own time fold into `Fila e servidor`. */
export const TIME_SEGMENTS = [
  { key: 'capture', label: 'Captura', c: 's1' }, { key: 'compile', label: 'Compilação', c: 's2' }, { key: 'studio', label: 'Studio', c: 's3' },
  { key: 'verify', label: 'Verificação', c: 's4' }, { key: 'publish', label: 'Publicação', c: 's5' }, { key: 'environment', label: 'Ambiente', c: 's6' },
  { key: 'transfer', label: 'Transferência', c: 's7' }, { key: 'queueRest', label: 'Fila e servidor', c: 'other' },
];

/** Rows of the time-share chart: top n tools by total time, the phase shares (queue + rest folded). */
export function timeShareRows(list, n = 6) {
  return (Array.isArray(list) ? list.slice() : []).sort((a, b) => (b.sumMs ?? 0) - (a.sumMs ?? 0)).slice(0, n).map((r) => {
    const parts = {};
    for (const k of PHASE_KEYS) parts[k] = Number(r[`${k}Pct`]) || 0;
    parts.queueRest = parts.queue + parts.rest;
    return { label: r.tool, parts };
  });
}

const CARD_DEFS = [
  { id: 'chamadas', label: 'Chamadas', icon: 'uso' }, { id: 'sucesso', label: 'Sucesso e recusas', icon: 'qualidade', span: 'w2' },
  { id: 'entregas', label: 'Entregas', icon: 'check-circle' }, { id: 'tempo', label: 'Tempo até entregar', icon: 'timer' },
  { id: 'voltas', label: 'Voltas do modelo', icon: 'loop' }, { id: 'problemas', label: 'Problemas nas recusas', icon: 'wrench' },
  { id: 'parado', label: 'Parado entre chamadas', icon: 'pause' },
];

export default function createQualidade(ctx, section) {
  const { clock } = ctx;
  let range = '7d';
  let day = '';
  let token = '';
  let data = null;
  let lastOk = null;

  // ---- heading: range, customer, the two whole exports
  const head = pageHead('t-qualidade', 'Qualidade');
  const period = periodControls((r, d) => setRange(r, d));
  const custSel = select('Cliente', [{ value: '', label: 'Todos os clientes' }], {
    onChange: (v) => {
      token = v;
      syncHash();
      paintControls();
      ctx.refreshNow();
    },
  });
  const allBtn = button('Exportar tudo (JSON)', () => exportTable('tudo', 'json', allBtn), '', { class: 'btn-sm', icon: 'download' });
  const linesBtn = button('Exportar linhas (JSONL)', () => exportTable('linhas', 'jsonl', linesBtn), '', { class: 'btn-sm', icon: 'download' });
  const exportsGroup = h('div', { class: 'btn-group', role: 'group', 'aria-label': 'Exportar' }, allBtn, linesBtn);
  head.actions.append(period.segs, period.day, custSel, h('span', { class: 'vsep', 'aria-hidden': 'true' }), exportsGroup);
  const privacy = inlineNotice('plain', PRIVACY, { icon: 'shield' });
  const indexLine = inlineNotice('info', '');
  const indexMeter = meter({ label: 'Indexação dos registros de qualidade', fraction: 0, level: 'accent', valueText: '0%', mini: true });
  indexLine.extra.append(indexMeter.el);
  indexLine.el.hidden = true;

  // ---- the notice when the server does not record yet
  const notice = h('section', { class: 'panel', 'aria-label': 'Registros de qualidade', hidden: true },
    h('div', { class: 'empty-state' }, iconChip('alert-triangle', 'warn', 24), h('p', null, UNAVAILABLE)));

  const cards = createCards('qualidade', CARD_DEFS);

  /** A panel: heading with its count and the CSV button, an optional note, the table. */
  function block(id, title, table, exportName, note, icon) {
    const csv = button('CSV', () => exportTable(exportName, 'csv', csv), 'ghost', { class: 'btn-sm', icon: 'download', 'aria-label': `${title}: exportar CSV` });
    const p = panel(id, title, { icon, controls: [csv], note });
    p.el.append(table.el || table);
    return { head: p, el: p.el };
  }

  // 1. Resumo (two key-value tables side by side, rows 1-6 | 7-12; they keep their two columns at phone width)
  const resumoBodyA = h('tbody');
  const resumoBodyB = h('tbody');
  const resumoA = h('table', { class: 'kv kv-keep', 'aria-label': 'Resumo da qualidade (1 de 2)' }, resumoBodyA);
  const resumoB = h('table', { class: 'kv kv-keep', 'aria-label': 'Resumo da qualidade (2 de 2)' }, resumoBodyB);
  const resumo = block('h-q-resumo', 'Resumo', { el: h('div', { class: 'kv-cols' }, h('div', { class: 'table-wrap' }, resumoA), h('div', { class: 'table-wrap' }, resumoB)) }, 'resumo', null, 'qualidade');

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
  const errors = block('h-q-erros', 'Códigos de erro mais comuns', errTable, 'erros', null, 'x-circle');

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
    'Com correção pronta: o problema veio com o patch certo na recusa (o motor já sabia corrigir).', 'wrench');

  // 4. Correções automáticas por regra
  const ruleTable = createTable({
    label: 'Correções automáticas por regra',
    columns: [
      codeCol('rule', 'Regra', (r) => r.rule),
      { key: 'what', label: 'O que o motor fez', ell: 'text', flex: true, sort: (r) => wordOf(RULE_TEXT, r.rule) ?? null, text: (r) => wordOf(RULE_TEXT, r.rule) || F.DASH },
      numCol('count', 'Correções', (r) => r.count),
      numCol('calls', 'Chamadas', (r) => r.calls),
      { ...toolsCol, flex: false },
      numCol('customers', 'Clientes', (r) => r.customers),
    ],
    rowKey: (r) => r.rule,
    defaultSort: { key: 'count', dir: 'desc' },
    empty: 'Nenhuma correção automática neste período.',
  });
  const rules = block('h-q-regras', 'Correções automáticas por regra', ruleTable, 'correcoes', null, 'check-circle');

  // 5. Fases da entrega por ferramenta (p50 / p90): the one table allowed to scroll sideways
  const maxP50 = (r) => Math.max(0, ...PHASE_KEYS.map((k) => Number(r[k]?.p50) || 0));
  const phaseTable = createTable({
    label: 'Fases da entrega por ferramenta',
    dense: true,
    columns: [
      { key: 'tool', label: 'Ferramenta', mono: true, ell: 'code', sort: (r) => r.tool, text: (r) => r.tool },
      numCol('calls', 'Chamadas', (r) => r.calls),
      pairCol('total', 'Total', (r) => r.total?.p50, (r) => r.total?.p90, F.fmtDuration),
      ...PHASE_KEYS.map((k) => pairCol(k, PHASE_WORD[k], (r) => r[k]?.p50, (r) => r[k]?.p90, F.fmtDuration,
        { strongIf: (r) => maxP50(r) > 0 && (Number(r[k]?.p50) || 0) === maxP50(r) })),
      { key: 'cold', label: 'Kernel frio', num: true, flex: true, sort: (r) => r.kernelCold ?? null, text: coldText },
    ],
    rowKey: (r) => r.tool,
    defaultSort: { key: 'calls', dir: 'desc' },
    empty: 'Nenhuma chamada com tempo de fase neste período.',
  });
  const phases = block('h-q-fases', 'Fases da entrega por ferramenta (p50 / p90)', phaseTable, 'fases', ' ', 'timer');

  // 6. Para onde vai o tempo
  const maxShare = (r) => Math.max(0, ...PHASE_KEYS.map((k) => Number(r[`${k}Pct`]) || 0));
  const shareTable = createTable({
    label: 'Para onde vai o tempo',
    dense: true,
    columns: [
      { key: 'tool', label: 'Ferramenta', mono: true, ell: 'code', sort: (r) => r.tool, text: (r) => r.tool },
      { key: 'sumMs', label: 'Tempo total', num: true, sort: (r) => r.sumMs ?? null, text: (r) => F.fmtDuration(r.sumMs) },
      ...PHASE_KEYS.map((k, i) => ({
        key: k, label: PHASE_WORD[k], num: true, flex: i === PHASE_KEYS.length - 1, sort: (r) => r[`${k}Pct`] ?? null, text: (r) => pctCell(r[`${k}Pct`]),
        cell: (r, td) => {
          const v = Number(r[`${k}Pct`]) || 0;
          td.textContent = pctCell(r[`${k}Pct`]);
          if (v > 0 && v === maxShare(r)) td.classList.add('strong');
        },
      })),
    ],
    rowKey: (r) => r.tool,
    defaultSort: { key: 'sumMs', dir: 'desc' },
    empty: 'Nenhuma chamada com tempo de fase neste período.',
  });
  const share = block('h-q-tempo', 'Para onde vai o tempo', shareTable, 'tempo', 'Soma do período, em % do tempo total de cada ferramenta.', 'clock');

  // 7. Voltas até entregar (a last row Todos from the totals when more than one customer has chains)
  const roundColumns = [
    { key: 'customer', label: 'Cliente', ell: 'name', flex: true, sort: (r) => r.customer, text: (r) => r.customer || r.token },
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
    'Cadeia: as chamadas de uma sessão MCP até "entregue". Volta do modelo: chamada sem outra em andamento, 1 s ou mais depois da última resposta.', 'loop');

  // 8. O que mais gera voltas
  const causeTable = createTable({
    label: 'O que mais gera voltas',
    columns: [
      codeCol('code', 'Código', (r) => r.code, { flex: true }),
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
    'Uma recusa com vários códigos conta para cada um deles. Chamadas a mais: da recusa até "entregue".', 'alert-triangle');

  // 9. Por cliente (hidden when one customer is selected)
  const custTable = createTable({
    label: 'Qualidade por cliente',
    columns: [
      { key: 'customer', label: 'Cliente', ell: 'name', flex: true, sort: (r) => r.customer, text: (r) => r.customer || r.token },
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
  const byCustomer = block('h-q-clientes', 'Por cliente', custTable, 'clientes', null, 'agentes');

  // 10. Por cliente MCP
  const clientTable = createTable({
    label: 'Qualidade por cliente MCP',
    columns: [
      { key: 'client', label: 'Cliente MCP', flex: true, sort: (r) => wordOf(CLIENT_WORD, r.client) || r.client, text: (r) => wordOf(CLIENT_WORD, r.client) || r.client || F.DASH },
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
  const byClient = block('h-q-mcp', 'Por cliente MCP', clientTable, 'clientes-mcp', null, 'session');

  // ---- charts: the most common error codes and where the time goes (each with its table twin)
  const errChart = barlist({ title: 'Códigos de erro mais comuns', mono: true, n: 8, fmt: F.fmtInt, cls: 'w2', twin: () => errTable.table, empty: 'Nenhuma falha neste período.' });
  const timeChart = stack100({
    title: 'Para onde vai o tempo', subtitle: 'as 6 ferramentas com mais tempo, em % do tempo de cada uma', cls: 'w2',
    segments: TIME_SEGMENTS, fmtPct: (v) => pctCell(v), twin: () => shareTable.table, empty: 'Nenhuma chamada com tempo de fase neste período.',
  });
  const chartsRow = h('section', { class: 'kgrid charts', 'aria-label': 'Gráficos de qualidade' }, errChart.el, timeChart.el);

  const blocks = [resumo, errors, problems, rules, phases, share, rounds, causes, byCustomer, byClient];
  const tables = [
    [errTable, errors.head, 'errors'], [probTable, problems.head, 'problems'], [ruleTable, rules.head, 'rules'], [phaseTable, phases.head, 'phases'],
    [shareTable, share.head, 'timeShare'], [roundTable, rounds.head, 'rounds'], [causeTable, causes.head, 'causes'],
    [custTable, byCustomer.head, 'byCustomer'], [clientTable, byClient.head, 'byClient'],
  ];

  section.append(head.el, privacy.el, indexLine.el, notice, cards.el, chartsRow, ...blocks.map((b) => b.el));

  function paintControls() {
    period.paint(range, day, F.localDay(clock.now()));
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
    head.setSub(rangeText(data.range));
    const idx = indexingText(data.indexing);
    indexLine.set(idx);
    indexMeter.update({ label: 'Indexação dos registros de qualidade', fraction: Number(data.indexing?.progress) || 0, level: 'accent', valueText: `${Math.round((Number(data.indexing?.progress) || 0) * 100)}%`, mini: true });
    indexLine.el.hidden = !idx;
    const on = data.available !== false;
    notice.hidden = on;
    cards.el.hidden = !on;
    chartsRow.hidden = !on;
    for (const b of blocks) b.el.hidden = !on;
    paintControls();
    if (!on) return;
    cards.render(kpis(data.totals));
    errChart.update((data.errors || []).map((r) => ({ label: r.code, value: r.count })));
    timeChart.update(timeShareRows(data.timeShare));
    const rows = resumoRows(data.totals);
    fillKv(resumoBodyA, rows.slice(0, 6), false);
    fillKv(resumoBodyB, rows.slice(6), false);
    phases.head.setNote(`Cada célula: p50 em cima, p90 embaixo, por chamada. Chamadas em paralelo do mesmo cliente ficam fora: ${F.fmtInt(data.totals?.sharedCalls ?? 0)}.`);
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
        cards.error(msg, lastOk ? `dados de ${F.fmtTimeSec(lastOk)}` : '');
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
