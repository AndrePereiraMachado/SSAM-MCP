// Eventos (DESIGN.md 6.5, SPEC painel v2 4.7): four cards counting the loaded events (errors, warnings, info, the
// newest), then the event ring, newest first, at most 500 rows in the DOM. Polls every 3 s with after=lastSeq; Pausar
// keeps counting the new events without showing them.

import * as F from '../format.js';
import { h, clear, pageHead, panel, select, setOptions, filterInput, status, button } from '../dom.js';
import { icon } from '../icons.js';
import { createTable, filterRows } from '../table.js';
import { createCards } from '../cards.js';
import { eventColumns, errorMessage, staleText } from './common.js';

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

/** The four cards of Eventos (pure): counts of the events loaded on the page (at most 500), the newest, the pause. */
export function kpis(events, { lastSeq = null, paused = false, pending = 0, now } = {}) {
  const list = Array.isArray(events) ? events : [];
  const n = list.length;
  const count = (lv) => list.filter((e) => e.level === lv).length;
  const where = `nos ${F.plural(n, 'evento carregado', 'eventos carregados')}`;
  const err = count('error');
  const warn = count('warning');
  const newest = list.reduce((b, e) => (!b || (e.seq ?? 0) > (b.seq ?? 0) ? e : b), null);
  return [
    { id: 'erros', label: 'Erros', icon: 'alert-octagon', level: err ? 'bad' : 'ok', value: F.fmtInt(err), context: where },
    { id: 'avisos', label: 'Avisos', icon: 'alert-triangle', level: warn ? 'warn' : 'ok', value: F.fmtInt(warn), context: where },
    { id: 'info', label: 'Informativos', icon: 'info', level: 'ok', value: F.fmtInt(count('info')), context: where },
    {
      id: 'recente', label: 'Mais recente', icon: 'clock', level: paused ? 'warn' : 'ok',
      value: newest ? F.fmtRelative(newest.time, now) : 'nenhum', word: true, muted: !newest,
      context: paused ? `Pausado · ${F.plural(pending, 'novo', 'novos')}` : (newest && lastSeq != null ? `seq ${lastSeq}` : null),
      contextTitle: newest ? F.fmtTitle(newest.time) : null,
    },
  ];
}

const CARD_DEFS = [
  { id: 'erros', label: 'Erros', icon: 'alert-octagon' }, { id: 'avisos', label: 'Avisos', icon: 'alert-triangle' },
  { id: 'info', label: 'Informativos', icon: 'info' }, { id: 'recente', label: 'Mais recente', icon: 'clock' },
];

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
  const pauseIcon = h('span', { class: 'btn-ico', 'aria-hidden': 'true' });
  const pauseLabel = h('span', null, 'Pausar');
  const pauseBtn = button([pauseIcon, pauseLabel], () => setPaused(!paused), '', { 'aria-pressed': 'false' });
  const pausedLine = h('span', { class: 'pausedline', role: 'status', hidden: true });
  const pageH = pageHead('t-eventos', 'Eventos');
  pageH.setSub('Mais novos primeiro, até 500 na tela; atualiza a cada 3 s.');
  const cards = createCards('eventos', CARD_DEFS);
  const head = panel('h-eventos', 'Eventos', { controls: [typeSel, custSel, filter.wrapEl, pauseBtn, pausedLine], toolbar: true });

  const table = createTable({
    label: 'Eventos',
    columns: eventColumns(ctx),
    rowKey: (r) => `ev${r.seq}`,
    rowClass: (r) => (fresh.has(r.seq) ? 'new' : null),
    defaultSort: { key: 'time', dir: 'desc', compare: (a, b) => b.seq - a.seq },
    empty: 'Nenhum evento com esse filtro.',
    filteredEmpty: 'Nenhum evento com esse filtro.',
  });
  const moreBtn = h('button', { type: 'button', class: 'btn more' }, 'Carregar mais antigos');
  moreBtn.addEventListener('click', loadOlder);
  const moreFoot = h('div', { class: 'panel-foot', hidden: true }, moreBtn);
  head.el.append(table.el, moreFoot);

  section.append(pageH.el, cards.el, head.el);

  function paintCards() {
    cards.render(kpis(events || [], { lastSeq, paused, pending: pending.length, now: clock.now() }));
  }

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
    pauseLabel.textContent = paused ? 'Continuar' : 'Pausar';
    clear(pauseIcon);
    pauseIcon.append(icon(paused ? 'play' : 'pause', 16));
    pauseBtn.setAttribute('aria-pressed', paused ? 'true' : 'false');
    pausedLine.hidden = !paused;
    clear(pausedLine);
    if (paused) pausedLine.append(status('warn', `Pausado · ${F.plural(pending.length, 'novo', 'novos')}`));
    if (events) paintCards();
  }
  paintPaused();

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
    moreFoot.hidden = exhausted || (events || []).length >= MAX_ROWS;
    head.setStale('');
    paintCards();
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
        cards.error(errorMessage(e), lastOk ? `dados de ${F.fmtTimeSec(lastOk)}` : '');
        throw e;
      }
    },
    focusFilter() {
      filter.focus();
      return true;
    },
  };
}
