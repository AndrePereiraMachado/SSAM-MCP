// Pieces shared by the views: time cells, event columns, error handling of a refresh.

import * as F from '../format.js';
import { h, status } from '../dom.js';
import { EVENT_LEVEL, EVENT_GROUP } from '../labels.js';

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
    { key: 'group', label: 'Tipo', sort: s((r) => EVENT_GROUP[r.group] || r.group), text: (r) => EVENT_GROUP[r.group] || r.group || F.DASH },
    { key: 'customer', label: 'Cliente', ell: 'name', sort: s((r) => r.customer), text: (r) => r.customer || F.DASH },
    { key: 'text', label: 'Descrição', ell: 'text', sort: s((r) => r.text), text: (r) => r.text || '' },
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
