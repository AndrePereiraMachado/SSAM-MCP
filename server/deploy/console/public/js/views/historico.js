// Histórico (DESIGN.md 6.5): every license action of the console and every change made outside it. Loads on open
// and after mutations (no polling).

import * as F from '../format.js';
import { h, status, sectionHead, select, setOptions } from '../dom.js';
import { createTable } from '../table.js';
import { HISTORY_ACTION, LICENSE_STATE, wordOf } from '../labels.js';
import { relSort, errorMessage, staleText } from './common.js';

const ACTION_FILTERS = [
  { value: '', label: 'Todas', match: () => true },
  { value: 'issue', label: 'Emissão', match: (a) => a === 'issue' },
  { value: 'renew', label: 'Renovação', match: (a) => a === 'renew' },
  { value: 'lanes', label: 'Faixas', match: (a) => a === 'lanes' },
  { value: 'agent-rotate', label: 'Credencial do agente', match: (a) => a === 'agent-rotate' },
  { value: 'revoke', label: 'Revogação', match: (a) => a === 'revoke' },
  { value: 'key-rotate', label: 'Chave do painel', match: (a) => a === 'key-rotate' },
  { value: 'alerts', label: 'Alertas', match: (a) => a === 'alert-ack' || a === 'alert-unack' },
  { value: 'unrevoke', label: 'Revogação desfeita', match: (a) => a === 'unrevoke' },
  { value: 'removed', label: 'Licença removida', match: (a) => a === 'removed' },
  { value: 'expiry-shortened', label: 'Validade encurtada', match: (a) => a === 'expiry-shortened' },
  { value: 'rename', label: 'Nome do cliente', match: (a) => a === 'rename' },
];

const actionWord = (a) => wordOf(HISTORY_ACTION, a) || a;

function hoursText(hours) {
  if (hours == null) return 'visto';
  if (Number(hours) === 168) return '7 dias';
  return `${F.fmtInt(hours)} h`;
}

/** Detalhe column: `30 dias, ODC e O11` · `11/11/2026 → 11/12/2026` · `ODC, O11 → ODC` · `24 h` · `revogada em 01/10/2026`. */
export function historyDetail(e) {
  const d = e?.detail || {};
  switch (e?.action) {
    case 'issue': {
      // Console issues carry days (null = sem validade); changes seen outside the console carry only expiresAt.
      const days = 'days' in d ? (d.days == null ? 'sem validade' : F.plural(d.days, 'dia', 'dias'))
        : 'expiresAt' in d ? (d.expiresAt ? `até ${F.fmtDate(d.expiresAt)}` : 'sem validade') : null;
      const lanes = Array.isArray(d.lanes) ? F.fmtLanesAnd(d.lanes) : null;
      return [days, lanes].filter(Boolean).join(', ') || F.DASH;
    }
    case 'renew':
      // A refused renewal has no new expiry: it shows what was asked (+30 dias), not "11/11/2026 → —".
      if (d.expiresAt) return `${F.fmtDate(d.previousExpiresAt)} → ${F.fmtDate(d.expiresAt)}`;
      if ('days' in d) return `+${F.plural(d.days, 'dia', 'dias')}`;
      // seen outside the console: the expiry was taken away
      return d.previousExpiresAt ? `${F.fmtDate(d.previousExpiresAt)} → sem validade` : F.DASH;
    case 'lanes':
      return `${F.fmtLanes(d.previousLanes)} → ${F.fmtLanes(d.lanes)}`;
    case 'expiry-shortened':
      return `${d.previousExpiresAt ? F.fmtDate(d.previousExpiresAt) : 'sem validade'} → ${F.fmtDate(d.expiresAt)}`;
    case 'unrevoke':
      return d.previousRevokedAt ? `revogada em ${F.fmtDate(d.previousRevokedAt)}, voltou a valer` : 'voltou a valer';
    case 'removed': {
      const st = wordOf(LICENSE_STATE, d.previousState);
      return st ? `estava ${st.word}` : F.DASH;
    }
    case 'rename':
      return d.previousCustomer ? `antes: ${d.previousCustomer}` : F.DASH;
    case 'alert-ack':
      return [hoursText(d.hours), d.alert].filter(Boolean).join(' · ');
    case 'alert-unack':
      return d.alert || F.DASH;
    default:
      return F.DASH;
  }
}

export default function createHistorico(ctx, section) {
  const { clock } = ctx;
  let entries = null;
  let lastOk = null;
  let stale = true;
  let customer = '';
  let action = '';

  const custSel = select('Cliente', [{ value: '', label: 'Todos os clientes' }], {
    onChange: (v) => {
      customer = v;
      applyFilter();
    },
  });
  const actSel = select('Ação', ACTION_FILTERS, {
    onChange: (v) => {
      action = v;
      applyFilter();
    },
  });
  const head = sectionHead('Histórico', { id: 'h-historico', controls: [custSel, actSel] });

  const table = createTable({
    label: 'Histórico de licenças',
    columns: [
      {
        key: 'time', label: 'Quando', sort: relSort('time'), firstDir: 'desc',
        cell: (r, td) => {
          td.textContent = F.fmtDateTime(r.time);
          td.title = F.fmtTitle(r.time);
        },
      },
      { key: 'action', label: 'Ação', sort: (r) => actionWord(r.action), text: (r) => actionWord(r.action) },
      { key: 'actor', label: 'Origem', sort: (r) => r.actor, text: (r) => (r.actor === 'externo' ? 'fora do painel' : 'painel') },
      { key: 'customer', label: 'Cliente', ell: 'name', sort: (r) => r.customer, text: (r) => r.customer || F.DASH },
      { key: 'token', label: 'Token', mono: true, sort: (r) => r.token, text: (r) => r.token || F.DASH },
      { key: 'detail', label: 'Detalhe', ell: 'text', sort: (r) => historyDetail(r), text: (r) => historyDetail(r) },
      {
        key: 'result', label: 'Resultado', sort: (r) => (r.result === 'ok' ? 0 : 1),
        cell: (r, td) => td.append(r.result === 'ok' ? status('ok', 'ok') : status('bad', `erro ${r.code || ''}`.trim())),
      },
    ],
    rowKey: (r) => `${r.time}|${r.action}|${r.token || ''}`,
    defaultSort: { key: 'time', dir: 'desc' },
    empty: 'Nenhuma ação registrada ainda.',
    filteredEmpty: 'Nenhuma ação com esse filtro.',
  });

  section.append(h('div', { class: 'block', role: 'region', 'aria-labelledby': 'h-historico' }, head.el, table.el));

  function applyFilter() {
    const f = ACTION_FILTERS.find((x) => x.value === action) || ACTION_FILTERS[0];
    if (!customer && !action) table.setFilter(null);
    else table.setFilter((r) => (!customer || r.token === customer) && f.match(r.action));
    head.setCount(table.countText());
  }

  function fillCustomers() {
    const seen = new Map();
    for (const l of ctx.store.licenses || []) seen.set(l.id, l.customer);
    for (const e of entries || []) if (e.token && !seen.has(e.token)) seen.set(e.token, e.customer);
    const opts = [{ value: '', label: 'Todos os clientes' }];
    for (const [tok, name] of [...seen.entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1]), 'pt-BR'))) {
      opts.push({ value: tok, label: F.fmtCustomerToken(name, tok) });
    }
    setOptions(custSel, opts);
    customer = custSel.value;
  }

  return {
    interval: () => 0,
    invalidate() {
      stale = true;
    },
    async refresh() {
      try {
        const d = await ctx.api.history({ limit: 500 });
        entries = Array.isArray(d.entries) ? d.entries : [];
        lastOk = clock.now();
        stale = false;
        fillCustomers();
        table.setRows(entries);
        applyFilter();
        head.setStale('');
      } catch (e) {
        if (e.kind === 'auth') throw e;
        table.setError(errorMessage(e));
        if (table.hasRows()) head.setStale(staleText(lastOk));
        throw e;
      }
    },
    show() {
      stale = true;
    },
    focusFilter() {
      custSel.focus();
      return true;
    },
  };
}
