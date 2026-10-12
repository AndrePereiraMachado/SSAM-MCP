// Agentes e sessões (DESIGN.md 6.5): agents, open MCP sessions, server processes and sessions closed today, all from
// /api/live. Polls every 3 s.

import * as F from '../format.js';
import { h, status, sectionHead } from '../dom.js';
import { createTable } from '../table.js';
import { PROCESS_KIND, agentCloseWord, sessionCloseWord } from '../labels.js';
import { relTime, relSort, sinceCell, errorMessage, staleText, muted } from './common.js';

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

export default function createAgentes(ctx, section) {
  const { clock } = ctx;
  let lastOk = null;

  const agentsHead = sectionHead('Agentes', { id: 'h-agentes' });
  const agentsTable = createTable({
    label: 'Agentes',
    columns: [
      { key: 'customer', label: 'Cliente', ell: 'name', sort: (r) => r.customer, text: (r) => r.customer || r.token },
      {
        key: 'state', label: 'Estado', sort: (r) => (r.state === 'connected' ? 0 : 1), firstDir: 'asc',
        cell: (r, td) => td.append(r.state === 'connected' ? status('ok', 'conectado') : status('muted', 'desconectado')),
      },
      {
        key: 'since', label: 'Desde', sort: (r) => F.toMs(r.state === 'connected' ? r.since : (r.closedAt || r.since)) || null,
        cell: (r, td) => relTime(td, r.state === 'connected' ? r.since : (r.closedAt || r.since), clock.now()),
      },
      { key: 'lastSignalAt', label: 'Último sinal', sort: relSort('lastSignalAt'), firstDir: 'desc', cell: (r, td) => relTime(td, r.lastSignalAt, clock.now()) },
      { key: 'version', label: 'Versão do agente', mono: true, sort: (r) => r.version, text: (r) => r.version || F.DASH },
      {
        key: 'pack', label: 'Pacote', mono: true, ell: 'code', sort: (r) => (r.pack ? packText(r.pack) : null),
        cell: (r, td) => {
          td.textContent = packText(r.pack);
          td.title = r.pack ? packText(r.pack) : 'O servidor ainda não registra o pacote do agente.';
        },
      },
      { key: 'studio', label: 'Studio O11', sort: (r) => r.studioO11?.version ?? null, text: (r) => studioText(r.studioO11) },
      { key: 'machine', label: 'Máquina', ell: 'machine', sort: (r) => (r.machine ? F.fmtMachine(r.machine) : null), text: (r) => F.fmtMachine(r.machine) },
      { key: 'ip', label: 'IP', mono: true, ell: 'code', sort: (r) => r.ip, text: (r) => r.ip || F.DASH },
      { key: 'calls1h', label: 'Chamadas 1 h', num: true, sort: (r) => r.calls1h ?? 0, text: (r) => F.fmtInt(r.calls1h ?? 0) },
      {
        key: 'failures1h', label: 'Falhas 1 h', num: true, sort: (r) => r.failures1h ?? 0, text: (r) => F.fmtInt(r.failures1h ?? 0),
        level: (r) => ((r.failures1h ?? 0) >= 10 ? 'bad' : ''),
      },
      { key: 'lastCode', label: 'Último código', mono: true, ell: 'code', sort: (r) => r.lastCode, text: (r) => r.lastCode || F.DASH },
      {
        key: 'closedReason', label: 'Motivo do fechamento', sort: (r) => (r.state === 'connected' ? null : agentCloseWord(r.closedReason)),
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

  const sessHead = sectionHead('Sessões MCP abertas', { id: 'h-sessoes' });
  const sessTable = createTable({
    label: 'Sessões MCP abertas',
    columns: [
      { key: 'customer', label: 'Cliente', ell: 'name', sort: (r) => r.customer, text: (r) => r.customer || r.token },
      { key: 'client', label: 'Cliente MCP', ell: 'client', sort: (r) => r.client, text: (r) => r.client || F.DASH, title: (r) => [r.client, r.ua].filter(Boolean).join(' · ') },
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

  const procHead = sectionHead('Processos do servidor', { id: 'h-processos' });
  let procEmpty = 'Sem dados de processos (coletor parado).';
  const procTable = createTable({
    label: 'Processos do servidor',
    columns: [
      { key: 'kind', label: 'Tipo', sort: (r) => PROCESS_KIND[r.kind]?.order ?? 9, firstDir: 'asc', text: (r) => PROCESS_KIND[r.kind]?.word || r.kind },
      { key: 'customer', label: 'Cliente', ell: 'name', sort: (r) => r.customer, text: (r) => r.customer || F.DASH },
      { key: 'port', label: 'Porta', num: true, sort: (r) => r.port ?? null, text: (r) => (r.port != null ? String(r.port) : F.DASH) },
      { key: 'rssB', label: 'Memória', num: true, sort: (r) => r.rssB ?? null, text: (r) => F.fmtBytes(r.rssB) },
      { key: 'cpuPct', label: 'CPU', num: true, sort: (r) => r.cpuPct ?? null, text: (r) => F.fmtPctFine(r.cpuPct) },
      { key: 'elapsedS', label: 'Ativo há', num: true, sort: (r) => r.elapsedS ?? null, text: (r) => (r.elapsedS != null ? F.fmtDuration(r.elapsedS * 1000) : F.DASH) },
    ],
    rowKey: (r) => `${r.kind}|${r.port ?? ''}|${r.token ?? ''}|${r.elapsedS ?? ''}`,
    defaultSort: { key: 'kind', dir: 'asc' },
    empty: (mk) => mk(procEmpty, 'empty'),
  });
  const procNote = muted('Workers O11 por cliente só existem nas imagens com o pool hospedado.', 'note');

  const closedHead = sectionHead('Sessões encerradas hoje', { id: 'h-encerradas' });
  const closedTable = createTable({
    label: 'Sessões encerradas hoje',
    columns: [
      { key: 'reason', label: 'Motivo', sort: (r) => sessionCloseWord(r.reason), text: (r) => sessionCloseWord(r.reason) },
      { key: 'count', label: 'Quantidade', num: true, sort: (r) => r.count ?? 0, text: (r) => F.fmtInt(r.count ?? 0) },
    ],
    rowKey: (r) => r.reason,
    defaultSort: { key: 'count', dir: 'desc' },
    empty: 'Nenhuma sessão encerrada hoje.',
  });

  section.append(
    h('div', { class: 'block', role: 'region', 'aria-labelledby': 'h-agentes' }, agentsHead.el, agentsTable.el),
    h('div', { class: 'block', role: 'region', 'aria-labelledby': 'h-sessoes' }, sessHead.el, sessTable.el),
    h('div', { class: 'block', role: 'region', 'aria-labelledby': 'h-processos' }, procHead.el, procTable.el, procNote),
    h('div', { class: 'block', role: 'region', 'aria-labelledby': 'h-encerradas' }, closedHead.el, closedTable.el),
  );

  const tables = [[agentsTable, agentsHead], [sessTable, sessHead], [procTable, procHead], [closedTable, closedHead]];

  function render(d) {
    agentsTable.setRows(d.agents || []);
    sessTable.setRows(d.sessions || []);
    const w = d.workers || {};
    procEmpty = w.available === false ? 'Sem dados de processos (coletor parado).' : 'Nenhum processo listado.';
    procTable.setRows(w.available === false ? [] : (w.rows || []));
    closedTable.setRows(d.closedToday || []);
    for (const [t, hd] of tables) {
      hd.setCount(t.countText());
      hd.setStale('');
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
        for (const [t, hd] of tables) {
          t.setError(msg);
          if (t.hasRows()) hd.setStale(staleText(lastOk));
        }
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
