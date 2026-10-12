// Licenças (DESIGN.md 6.5): the license table with its detail rows and the row actions that open the dialogs of
// 6.10. Polls every 10 s and right after any mutation.

import * as F from '../format.js';
import { h, clear, dot, status, textButton, button, sectionHead, joinDots, select, filterInput } from '../dom.js';
import { createTable, kvTable, filterRows, compareValues } from '../table.js';
import { sparkline, sparkLabel } from '../sparkline.js';
import { LICENSE_STATE, HISTORY_ACTION, wordOf } from '../labels.js';
import { errorMessage, staleText, muted } from './common.js';
import { historyDetail } from './historico.js';

const FILTERS = [
  { value: 'ativas-vencidas', label: 'Ativas e vencidas', match: (l) => l.state === 'active' || l.state === 'expired' },
  { value: 'ativas', label: 'Ativas', match: (l) => l.state === 'active' },
  { value: 'vencidas', label: 'Vencidas', match: (l) => l.state === 'expired' },
  { value: 'revogadas', label: 'Revogadas', match: (l) => l.state === 'revoked' },
  { value: 'todas', label: 'Todas', match: () => true },
];

const ACTION_LABEL = { renew: 'Renovar', lanes: 'Faixas', agentRotate: 'Credencial do agente', revoke: 'Revogar' };

const sum = (a) => (Array.isArray(a) ? a.reduce((s, v) => s + (Number(v) || 0), 0) : 0);

/** Default order: Estado (ativa, vencida, revogada), Validade ascending (sem validade last), Cliente. */
export function licenseCompare(a, b) {
  const sa = LICENSE_STATE[a.state]?.order ?? 9;
  const sb = LICENSE_STATE[b.state]?.order ?? 9;
  if (sa !== sb) return sa - sb;
  const ea = a.expiresAt == null ? Infinity : F.toMs(a.expiresAt);
  const eb = b.expiresAt == null ? Infinity : F.toMs(b.expiresAt);
  if (ea !== eb) return ea === Infinity ? 1 : eb === Infinity ? -1 : ea - eb;
  return compareValues(a.customer || '', b.customer || '');
}

export function workspacePct(ws) {
  if (!ws || !ws.quotaBytes) return null;
  return (Number(ws.bytes) / Number(ws.quotaBytes)) * 100;
}

export function failuresLevel(today) {
  const c = today?.calls ?? 0;
  const f = today?.failures ?? 0;
  return f >= 3 && c > 0 && f / c >= 0.25 ? 'bad' : '';
}

/**
 * The one line under the head about what this console can do with licenses (DESIGN.md 6.5), or null. capabilities.readOnly
 * (CONSOLE_LICENSE_WRITES): 'sem-trava' when the image's token module does not lock tokens.json between the console and
 * ssam-admin, 'desligado' when the owner turned the actions off.
 */
export function capabilityLine(caps) {
  if (!caps) return null;
  if (caps.readOnly === 'sem-trava') {
    return 'Ações de licença desligadas: esta imagem não trava o tokens.json entre o painel e o ssam-admin. Até a imagem do 24º envio, emita, renove e revogue pelo ssam-admin (DEPLOY.md 15.4).';
  }
  if (caps.readOnly === 'desligado') return 'Ações de licença desligadas neste painel (CONSOLE_LICENSE_WRITES=off).';
  if (caps.renew === false || caps.lanes === false) {
    return 'Renovar e mudar faixas chegam com a imagem do 24º envio; hoje dá para emitir, trocar a credencial do agente e revogar.';
  }
  return null;
}

export default function createLicencas(ctx, section) {
  const { clock } = ctx;
  let lastOk = null;
  let licenses = null;
  let live = null;
  let capabilities = null;
  let text = '';
  let filterId = 'ativas-vencidas';
  const open = new Set();

  const issueBtn = button('Emitir licença', (e) => ctx.dialogs.issue(e.currentTarget, licenses || []), 'primary', { id: 'btn-issue' });
  const filter = filterInput('filtrar por cliente ou token', (v) => {
    text = v;
    applyFilter();
  });
  const sel = select('Estado das licenças', FILTERS, {
    value: filterId,
    onChange: (v) => {
      filterId = v;
      applyFilter();
    },
  });
  const head = sectionHead('Licenças', { id: 'h-licencas', controls: [issueBtn, filter, sel] });
  const capLine = muted('', 'capline');
  capLine.hidden = true;

  function accessAlertId(lic) {
    const alerts = ctx.store.overview?.alerts || [];
    const a = alerts.find((x) => x.rule === 'acesso-outra-maquina' && x.subject?.token === lic.id);
    return a ? a.id : null;
  }

  function toggle(lic) {
    if (open.has(lic.id)) open.delete(lic.id);
    else open.add(lic.id);
    table.rerender();
  }

  function rowActions(lic, td) {
    const a = lic.actions || {};
    const items = [];
    const add = (key, fn) => {
      if (a[key]?.allowed) items.push(textButton(ACTION_LABEL[key], (e) => fn(e.currentTarget), { dataset: { fk: key } }));
    };
    add('renew', (el) => ctx.dialogs.renew(el, lic));
    add('lanes', (el) => ctx.dialogs.lanes(el, lic, sessionsOf(lic)));
    add('agentRotate', (el) => ctx.dialogs.agentRotate(el, lic));
    add('revoke', (el) => ctx.dialogs.revoke(el, lic, sessionsOf(lic)));
    td.append(...joinDots(items));
  }

  function sessionsOf(lic) {
    const all = live?.sessions || [];
    return all.filter((s) => s.token === lic.id);
  }

  function detail(lic, td) {
    const now = clock.now();
    const m = lic.machine;
    const accessAlerts = (ctx.store.overview?.alerts || []).filter((x) => x.rule === 'acesso-outra-maquina' && x.subject?.token === lic.id);
    const sessions = sessionsOf(lic);
    const unavailable = Object.entries(lic.actions || {}).filter(([, v]) => v && !v.allowed);
    const hist = Array.isArray(lic.history) ? lic.history.slice(0, 5) : [];
    const lines = (arr) => (cell) => {
      if (!arr.length) {
        cell.textContent = 'nenhum';
        return;
      }
      for (const t of arr) cell.append(h('span', { class: 'line' }, t));
    };
    const left = [
      { label: 'Criada em', value: F.fmtDateTime(lic.createdAt), title: F.fmtTitle(lic.createdAt) },
      {
        label: 'Validade',
        value: lic.expiresAt ? `${F.fmtDateTime(lic.expiresAt)} (${F.fmtUtcDateTime(lic.expiresAt)})` : 'sem validade',
      },
      { label: 'Revogada em', value: lic.revokedAt ? F.fmtDateTime(lic.revokedAt) : F.DASH },
      { label: 'Credencial do agente emitida em', value: lic.agentCredentialIssuedAt ? F.fmtDateTime(lic.agentCredentialIssuedAt) : F.DASH },
      {
        label: 'Máquina registrada',
        value: m ? `${F.fmtMachine(m)}, id ${m.id ?? F.DASH}, desde ${F.fmtDateTime(m.at)}` : 'nenhuma',
      },
      {
        label: 'Alertas de acesso',
        value: lines(accessAlerts.length
          ? accessAlerts.map((x) => `${F.fmtDateTime(x.since)} · ${x.subject?.machine ?? F.DASH} · IP ${x.subject?.ip ?? F.DASH}`)
          : (lic.accessAlerts ? [F.plural(lic.accessAlerts, 'alerta', 'alertas')] : [])),
      },
    ];
    const right = [
      {
        label: 'Sessões abertas',
        value: lines(sessions.map((s) => `${s.client || 'cliente sem nome'} · IP ${s.ip ?? F.DASH} · aberta há ${F.fmtDuration(now - F.toMs(s.openedAt))}`)),
      },
      {
        label: 'Ações indisponíveis',
        value: lines(unavailable.map(([k, v]) => `${ACTION_LABEL[k] || k}: ${v.reason || 'indisponível'}`)),
      },
      {
        label: 'Histórico',
        value: lines(hist.map((e) => [
          F.fmtDateTime(e.time), wordOf(HISTORY_ACTION, e.action) || e.action, historyDetail(e), e.actor === 'externo' ? 'fora do painel' : 'painel',
          e.result === 'error' ? `erro ${e.code || ''}`.trim() : null,
        ].filter((x) => x && x !== F.DASH).join(' · '))),
      },
      {
        label: 'Uso',
        value: (cell) => cell.append(textButton('Ver uso desta licença', () => ctx.navigate('uso', { token: lic.id }), { dataset: { fk: 'uso' } })),
      },
    ];
    td.append(h('div', { class: 'detail-grid' },
      kvTable(left, { label: `Detalhes de ${lic.customer}` }),
      kvTable(right, { label: `Sessões, ações e histórico de ${lic.customer}` })));
  }

  const table = createTable({
    label: 'Licenças',
    columns: [
      {
        key: 'customer', label: 'Cliente', ell: 'name', sort: (r) => r.customer,
        cell: (r, td) => {
          const b = h('button', {
            type: 'button', class: 'rowtoggle', 'aria-expanded': open.has(r.id) ? 'true' : 'false',
            title: r.customer, dataset: { fk: 'toggle' },
          }, r.customer);
          b.addEventListener('click', () => toggle(r));
          td.append(b);
        },
      },
      {
        key: 'state', label: 'Estado', sort: (r) => LICENSE_STATE[r.state]?.order ?? 9, firstDir: 'asc',
        cell: (r, td) => {
          const s = LICENSE_STATE[r.state] || { word: r.state, level: 'muted' };
          td.append(status(s.level, s.word));
        },
      },
      { key: 'lanes', label: 'Faixas', sort: (r) => F.fmtLanes(r.lanes), text: (r) => F.fmtLanes(r.lanes) },
      {
        key: 'expiresAt', label: 'Validade', sort: (r) => (r.expiresAt == null ? null : F.toMs(r.expiresAt)), firstDir: 'asc',
        cell: (r, td) => {
          const v = F.fmtValidity(r, clock.now());
          td.textContent = v.text;
          if (v.level) td.classList.add(`lv-${v.level}`);
          const t = r.state === 'revoked' ? r.revokedAt : r.expiresAt;
          if (t) td.title = F.fmtTitle(t);
        },
      },
      {
        key: 'agent', label: 'Agente',
        sort: (r) => (r.state === 'revoked' ? 3 : { connected: 0, disconnected: 1, never: 2 }[r.agent?.state] ?? 2), firstDir: 'asc',
        cell: (r, td) => {
          const a = r.agent || { state: 'never' };
          if (r.state === 'revoked') td.textContent = F.DASH;
          else if (a.state === 'connected') {
            td.append(status('ok', 'conectado'));
            if (a.since) td.title = `desde ${F.fmtTitle(a.since)}`;
          } else if (a.state === 'disconnected') {
            const when = a.since ? ` ${F.fmtRelative(a.since, clock.now())}` : '';
            td.append(status('muted', `desconectado${when}`));
            if (a.since) td.title = F.fmtTitle(a.since);
          } else td.append(status('muted', 'sem registro'));
        },
      },
      {
        key: 'machine', label: 'Máquina', ell: 'machine', sort: (r) => (r.machine ? F.fmtMachine(r.machine) : null),
        cell: (r, td) => {
          const txt = F.fmtMachine(r.machine);
          td.append(txt);
          td.title = txt;
          if (r.accessAlerts > 0) {
            const link = textButton('trocou de máquina', () => {
              const id = accessAlertId(r);
              ctx.navigate('visao', null, id ? { alertId: id } : null);
            }, { class: 'lv-bad', dataset: { fk: 'machine-alert' } });
            td.append(h('span', { class: 'sep', 'aria-hidden': 'true' }, ' · '), dot('bad'), link);
          }
        },
      },
      { key: 'sessionsOpen', label: 'Sessões', num: true, sort: (r) => r.sessionsOpen ?? 0, text: (r) => F.fmtInt(r.sessionsOpen ?? 0) },
      { key: 'calls', label: 'Chamadas hoje', num: true, sort: (r) => r.today?.calls ?? 0, text: (r) => F.fmtInt(r.today?.calls ?? 0) },
      {
        key: 'failures', label: 'Falhas hoje', num: true, sort: (r) => r.today?.failures ?? 0,
        text: (r) => F.fmtInt(r.today?.failures ?? 0), level: (r) => failuresLevel(r.today),
      },
      {
        key: 'daily14', label: 'Uso 14 dias', sort: (r) => sum(r.daily14), firstDir: 'desc', cls: 'sparkcell',
        cell: (r, td) => td.append(sparkline(r.daily14 || [], sparkLabel('Chamadas por dia', r.daily14 || []))),
      },
      {
        key: 'workspace', label: 'Espaço', num: true, sort: (r) => r.workspace?.bytes ?? null,
        cell: (r, td) => {
          const ws = r.workspace;
          if (!ws) {
            td.textContent = F.DASH;
            return;
          }
          const p = workspacePct(ws);
          td.textContent = `${F.fmtBytes(ws.bytes)} (${F.fmtPct(p)})`;
          if (p >= 95) td.classList.add('lv-bad');
          else if (p >= 80) td.classList.add('lv-warn');
          td.title = `${F.fmtInt(ws.files)} arquivos de ${F.fmtBytes(ws.quotaBytes)} de cota${ws.truncated ? ' (contagem parcial)' : ''} · medido ${F.fmtTitle(ws.measuredAt)}`;
        },
      },
      {
        key: 'lastActivity', label: 'Última atividade', sort: (r) => (r.lastActivity ? F.toMs(r.lastActivity.at) : null), firstDir: 'desc',
        cell: (r, td) => {
          const la = r.lastActivity;
          if (!la) {
            td.textContent = F.DASH;
            return;
          }
          const rel = F.fmtRelative(la.at, clock.now());
          td.textContent = la.kind === 'call' && la.tool ? `${rel} · ${la.tool}` : rel;
          td.title = F.fmtTitle(la.at);
        },
      },
      { key: 'id', label: 'Token', mono: true, sort: (r) => r.id, text: (r) => r.id },
      { key: 'actions', label: 'Ações', sort: false, cls: 'actions', cell: (r, td) => rowActions(r, td) },
    ],
    rowKey: (r) => r.id,
    rowClass: (r) => (r.state === 'revoked' ? 'is-muted' : null),
    defaultSort: { key: 'state', dir: 'asc', compare: licenseCompare },
    empty: 'Nenhuma licença. Use Emitir licença para criar a primeira.',
    filteredEmpty: 'Nenhuma licença com esse filtro.',
    detail: { isOpen: (r) => open.has(r.id), render: detail },
  });

  section.append(h('div', { class: 'block', role: 'region', 'aria-labelledby': 'h-licencas' }, head.el, capLine, table.el));

  function applyFilter() {
    const f = FILTERS.find((x) => x.value === filterId) || FILTERS[0];
    const q = text;
    const isDefault = !q.trim() && filterId === 'todas';
    if (isDefault) table.setFilter(null);
    else {
      table.setFilter((r) => f.match(r) && (!q.trim() || filterRows([r], q, ['customer', 'id']).length > 0));
    }
    head.setCount(table.countText());
  }

  function render() {
    capabilities = ctx.store.licensesCaps || capabilities;
    const line = capabilityLine(capabilities);
    capLine.textContent = line || '';
    capLine.hidden = !line;
    issueBtn.hidden = capabilities?.issue === false;
    table.setRows(licenses || []);
    applyFilter();
    head.setStale('');
  }

  return {
    interval: () => 10000,
    async refresh() {
      const [lr, vr] = await Promise.allSettled([ctx.api.licenses(), ctx.api.live()]);
      if (vr.status === 'fulfilled') {
        live = vr.value;
        ctx.store.live = live;
      }
      if (lr.status === 'rejected') {
        const e = lr.reason;
        if (e?.kind === 'auth') throw e;
        table.setError(errorMessage(e));
        if (table.hasRows()) head.setStale(staleText(lastOk));
        throw e;
      }
      const d = lr.value;
      licenses = Array.isArray(d.licenses) ? d.licenses : [];
      capabilities = d.capabilities || null;
      ctx.store.licenses = licenses;
      ctx.store.licensesCaps = capabilities;
      ctx.store.licensesAt = clock.now();
      lastOk = clock.now();
      render();
    },
    show() {
      if (licenses) render();
    },
    focusFilter() {
      filter.focus();
      return true;
    },
    focusSubject(subject) {
      const id = subject?.token;
      if (!id) return;
      let tr = table.rowElement(id);
      if (!tr && licenses && licenses.some((l) => l.id === id)) {
        filterId = 'todas';
        sel.value = 'todas';
        text = '';
        filter.value = '';
        applyFilter();
        tr = table.rowElement(id);
      }
      if (tr) {
        const b = tr.querySelector('.rowtoggle');
        if (b) b.focus();
        tr.scrollIntoView({ block: 'center' });
      }
    },
  };
}
