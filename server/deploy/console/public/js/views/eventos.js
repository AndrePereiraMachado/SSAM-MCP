// Eventos (DESIGN.md 6.5): the event ring, newest first, at most 500 rows in the DOM. Polls every 3 s with
// after=lastSeq; Pausar keeps counting the new events without showing them.

import * as F from '../format.js';
import { h, sectionHead, select, setOptions, filterInput } from '../dom.js';
import { createTable, filterRows } from '../table.js';
import { eventColumns, errorMessage, staleText, muted } from './common.js';

const MAX_ROWS = 500;
const PAGE = 200;

const TYPES = [
  { value: '', label: 'Tudo', match: () => true },
  { value: 'falhas', label: 'Falhas e avisos', match: (e) => e.level === 'warning' || e.level === 'error' },
  { value: 'sessao', label: 'Sessões', match: (e) => e.group === 'sessao' },
  { value: 'agente', label: 'Agentes', match: (e) => e.group === 'agente' },
  { value: 'chamada', label: 'Chamadas', match: (e) => e.group === 'chamada' },
  { value: 'licenca', label: 'Licenças', match: (e) => e.group === 'licenca' },
  { value: 'servidor', label: 'Servidor e VPS', match: (e) => e.group === 'servidor' || e.group === 'vps' || e.group === 'painel' },
];

/** Merges new events (ascending by seq) into the list, dedupes by seq, keeps the newest `max`. */
export function mergeEvents(list, incoming, max = MAX_ROWS) {
  const bySeq = new Map();
  for (const e of list) bySeq.set(e.seq, e);
  for (const e of incoming) bySeq.set(e.seq, e);
  const all = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  return all.length > max ? all.slice(all.length - max) : all;
}

export default function createEventos(ctx, section) {
  const { clock } = ctx;
  let events = null;
  let lastSeq = null;
  let pending = [];
  let paused = false;
  let type = '';
  let customer = '';
  let text = '';
  let limit = PAGE;
  let exhausted = false;
  let lastOk = null;
  const fresh = new Set();

  const typeSel = select('Tipo de evento', TYPES, { onChange: (v) => { type = v; applyFilter(); } });
  const custSel = select('Cliente', [{ value: '', label: 'Todos os clientes' }], { onChange: (v) => { customer = v; applyFilter(); } });
  const filter = filterInput('filtrar texto', (v) => { text = v; applyFilter(); });
  const pauseBtn = h('button', { type: 'button', class: 'btn', 'aria-pressed': 'false' }, 'Pausar');
  pauseBtn.addEventListener('click', () => setPaused(!paused));
  const head = sectionHead('Eventos', { id: 'h-eventos', controls: [typeSel, custSel, filter, pauseBtn] });
  const pausedLine = muted('', 'pausedline');
  pausedLine.hidden = true;
  pausedLine.setAttribute('role', 'status');

  const table = createTable({
    label: 'Eventos',
    columns: eventColumns(ctx),
    rowKey: (r) => `ev${r.seq}`,
    rowClass: (r) => (fresh.has(r.seq) ? 'new' : null),
    defaultSort: { key: 'time', dir: 'desc', compare: (a, b) => b.seq - a.seq },
    empty: 'Nenhum evento com esse filtro.',
    filteredEmpty: 'Nenhum evento com esse filtro.',
  });
  const moreBtn = h('button', { type: 'button', class: 'btn more', hidden: true }, 'Carregar mais antigos');
  moreBtn.addEventListener('click', loadOlder);

  section.append(h('div', { class: 'block', role: 'region', 'aria-labelledby': 'h-eventos' }, head.el, pausedLine, table.el, moreBtn));

  function applyFilter() {
    const t = TYPES.find((x) => x.value === type) || TYPES[0];
    if (!type && !customer && !text.trim()) table.setFilter(null);
    else {
      table.setFilter((e) => t.match(e) && (!customer || e.token === customer)
        && (!text.trim() || filterRows([e], text, ['text', 'customer', 'code']).length > 0));
    }
    head.setCount(table.countText());
  }

  function paintPaused() {
    pauseBtn.textContent = paused ? 'Continuar' : 'Pausar';
    pauseBtn.setAttribute('aria-pressed', paused ? 'true' : 'false');
    pausedLine.hidden = !paused;
    pausedLine.textContent = paused ? `Pausado · ${F.plural(pending.length, 'novo', 'novos')}` : '';
  }

  function setPaused(on) {
    paused = on;
    if (!paused && pending.length) {
      for (const e of pending) fresh.add(e.seq);
      events = mergeEvents(events || [], pending);
      pending = [];
      render();
    }
    paintPaused();
  }

  function fillCustomers() {
    const seen = new Map();
    for (const l of ctx.store.licenses || []) seen.set(l.id, l.customer);
    for (const e of events || []) if (e.token && !seen.has(e.token)) seen.set(e.token, e.customer || e.token);
    const opts = [{ value: '', label: 'Todos os clientes' }];
    for (const [tok, name] of [...seen.entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1]), 'pt-BR'))) {
      opts.push({ value: tok, label: F.fmtCustomerToken(name, tok) });
    }
    setOptions(custSel, opts);
    customer = custSel.value;
  }

  function render() {
    fillCustomers();
    table.setRows(events || []);
    fresh.clear();
    applyFilter();
    moreBtn.hidden = exhausted || (events || []).length >= MAX_ROWS;
    head.setStale('');
  }

  async function loadOlder() {
    limit = Math.min(MAX_ROWS, (events || []).length + PAGE);
    try {
      const d = await ctx.api.events({ limit });
      const got = Array.isArray(d.events) ? d.events : [];
      exhausted = got.length < limit;
      events = mergeEvents(events || [], got);
      render();
      moreBtn.focus();
    } catch (e) {
      if (e.kind !== 'auth') table.setError(errorMessage(e));
    }
  }

  return {
    interval: () => 3000,
    async refresh() {
      try {
        if (events == null || lastSeq == null) {
          const d = await ctx.api.events({ limit });
          const got = Array.isArray(d.events) ? d.events : [];
          exhausted = got.length < limit;
          events = mergeEvents([], got);
          lastSeq = d.lastSeq ?? (got.length ? got[got.length - 1].seq : 0);
          render();
        } else {
          const d = await ctx.api.events({ after: lastSeq, limit: MAX_ROWS });
          const got = (Array.isArray(d.events) ? d.events : []).filter((e) => e.seq > lastSeq);
          if (got.length) lastSeq = Math.max(lastSeq, ...got.map((e) => e.seq));
          else if (d.lastSeq != null && d.lastSeq > lastSeq) lastSeq = d.lastSeq;
          if (paused) {
            pending = mergeEvents(pending, got, MAX_ROWS);
            paintPaused();
            table.rerender();
          } else {
            for (const e of got) fresh.add(e.seq);
            events = mergeEvents(events, got);
            render();
          }
        }
        lastOk = clock.now();
      } catch (e) {
        if (e.kind === 'auth') throw e;
        table.setError(errorMessage(e));
        if (table.hasRows()) head.setStale(staleText(lastOk));
        throw e;
      }
    },
    focusFilter() {
      filter.focus();
      return true;
    },
  };
}
