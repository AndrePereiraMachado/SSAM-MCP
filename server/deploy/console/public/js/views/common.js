// Pieces shared by the views: time cells, event columns, error handling of a refresh.

import * as F from '../format.js';
import { h, status, chip } from '../dom.js';
import { icon } from '../icons.js';
import { EVENT_LEVEL, EVENT_GROUP, VIEWS } from '../labels.js';

/** Fills a cell with `há 3 min` and the absolute local time in the title. */
export function relTime(td, t, now) {
  if (t == null) {
    td.textContent = F.DASH;
    return;
  }
  td.textContent = F.fmtRelative(t, now);
  td.title = F.fmtTitle(t);
}

/** Duration since t (`1 h 02 min`), absolute time in the title. */
export function sinceCell(td, t, now) {
  if (t == null) {
    td.textContent = F.DASH;
    return;
  }
  td.textContent = F.fmtDuration(now - F.toMs(t));
  td.title = F.fmtTitle(t);
}

export function relSort(field) {
  return (r) => {
    const v = typeof field === 'function' ? field(r) : r[field];
    const ms = F.toMs(v);
    return Number.isFinite(ms) ? ms : null;
  };
}

/** `23:51:08` today, `11/10 22:49` older; title absolute. */
export function eventWhen(td, t, now) {
  td.textContent = F.sameLocalDay(t, now) ? F.fmtTimeSec(t) : F.fmtDayMonthTime(t);
  td.title = F.fmtTitle(t);
}

/** Columns of Eventos (also the Últimos eventos table of Visão geral). */
export function eventColumns(ctx, { sortable = true } = {}) {
  const s = (fn) => (sortable ? fn : false);
  return [
    {
      key: 'time', label: 'Quando', sort: s((r) => r.seq ?? F.toMs(r.time)), firstDir: 'desc',
      cell: (r, td) => eventWhen(td, r.time, ctx.clock.now()),
    },
    {
      key: 'level', label: 'Nível', sort: s((r) => ({ error: 0, warning: 1, info: 2 }[r.level] ?? 3)),
      cell: (r, td) => {
        const l = EVENT_LEVEL[r.level] || EVENT_LEVEL.info;
        td.append(status(l.level, l.word));
      },
    },
    {
      key: 'group', label: 'Tipo', sort: s((r) => EVENT_GROUP[r.group] || r.group),
      cell: (r, td) => td.append(chip(EVENT_GROUP[r.group] || r.group || F.DASH)),
    },
    { key: 'customer', label: 'Cliente', ell: 'name', sort: s((r) => r.customer), text: (r) => r.customer || F.DASH },
    { key: 'text', label: 'Descrição', ell: 'text', flex: true, sort: s((r) => r.text), text: (r) => r.text || '' },
  ];
}

/** Message for a table error row from an ApiError (`sem conexão com o painel`, API pt-BR message). */
export function errorMessage(e) {
  const m = String(e?.message || 'erro desconhecido');
  return m.replace(/[.\s]+$/, '');
}

/** `(dados de 23:51:08)` heading suffix while a table shows the last good data under an error. */
export function staleText(at) {
  return at ? `(dados de ${F.fmtTimeSec(at)})` : '';
}

/** Small muted paragraph. */
export function muted(text, cls) {
  return h('p', { class: ['muted', cls] }, text);
}

/**
 * Highest severity of the open (unsilenced) alerts per view the alert points to (SPEC painel v2 2.2):
 * { [viewId]: { level: 'bad' | 'warn' | 'info', count, critical } }.
 */
export function viewAlertLevels(alerts) {
  const out = {};
  const known = new Set(VIEWS.map((v) => v.id));
  for (const a of Array.isArray(alerts) ? alerts : []) {
    if (!a || a.acked || !known.has(a.view)) continue;
    const v = out[a.view] || (out[a.view] = { level: 'info', count: 0, critical: 0 });
    v.count += 1;
    if (a.severity === 'critical') {
      v.critical += 1;
      v.level = 'bad';
    } else if (a.severity === 'warning' && v.level !== 'bad') v.level = 'warn';
  }
  return out;
}

export const RANGES = [
  { id: 'today', label: 'Hoje' },
  { id: '7d', label: '7 dias' },
  { id: '30d', label: '30 dias' },
];

/**
 * Período segmented control + Dia (Uso, Qualidade; SPEC 3.11): the same buttons (.seg, aria-pressed, data-range) and the
 * same date input (aria-label Dia) as before, without the ' · ' separators. Returns {segs, day, paint(range, day, max)}.
 */
export function periodControls(onRange) {
  const btns = RANGES.map((r) => {
    const b = h('button', { type: 'button', class: 'seg', 'aria-pressed': 'false', dataset: { range: r.id } }, r.label);
    b.addEventListener('click', () => onRange(r.id, ''));
    return b;
  });
  const dayInput = h('input', { type: 'date', class: 'ctl day', 'aria-label': 'Dia' });
  dayInput.addEventListener('change', () => {
    if (dayInput.value) onRange('day', dayInput.value);
  });
  const dayLabel = h('label', { class: 'seglabel' }, icon('calendar', 16), h('span', null, 'Dia'), dayInput);
  const segs = h('div', { class: 'segs', role: 'group', 'aria-label': 'Período' }, btns);
  return {
    segs,
    day: dayLabel,
    paint(range, day, max) {
      for (const b of btns) b.setAttribute('aria-pressed', b.dataset.range === range ? 'true' : 'false');
      dayLabel.classList.toggle('on', range === 'day');
      dayInput.value = range === 'day' ? day : '';
      dayInput.max = max;
    },
  };
}
