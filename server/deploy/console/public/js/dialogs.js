// License dialogs (DESIGN.md 6.10) in the single <dialog id="dlg">: form step, then a confirmation step whose action
// button stays disabled until the typed customer name matches exactly. Also the shortcuts dialog (`?`).
// Esc = Cancelar, except while sending and while the one-time secret panel (secret.js) is open.

import * as F from './format.js';
import { h, clear, dot, button } from './dom.js';
import { kvTable } from './table.js';
import { openSecretPanel } from './secret.js';

const NAME_RE = /^[\p{L}\p{N} ._-]{1,64}$/u;
const NAME_HINT = '1 a 64 caracteres: letras, números, espaço, ponto, hífen ou sublinhado.';
let uid = 0;
const nextId = (p) => `${p}-${++uid}`;

/** Valid customer name (the API checks it again). */
export function validCustomer(name) {
  const s = String(name ?? '').trim();
  return s.length > 0 && NAME_RE.test(s);
}

/** Integer 1..3650 from a field value, or null. */
export function parseDays(v) {
  const s = String(v ?? '').trim();
  if (!/^\d{1,4}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 3650 ? n : null;
}

/** New expiry of a renewal: max(now, expiresAt) + days. */
export function renewedExpiry(expiresAt, days, now) {
  const base = Math.max(now, F.toMs(expiresAt) || 0);
  return base + days * F.DAY;
}

/** Live line of Renovar: `Nova validade: até 13/11/2026 (conta a partir da validade atual).` / `... de hoje).` */
export function renewLine(expiresAt, days, now) {
  const base = F.toMs(expiresAt) > now ? 'da validade atual' : 'de hoje';
  return `Nova validade: até ${F.fmtDate(renewedExpiry(expiresAt, days, now))} (conta a partir ${base}).`;
}

/** Typed confirmation matches the customer name (trimmed, case-sensitive). */
export function confirmMatches(typed, customer) {
  return String(typed ?? '').trim() === String(customer ?? '').trim() && String(customer ?? '').trim() !== '';
}

export function createDialogs(ctx) {
  const dlg = document.getElementById('dlg');
  const st = { opener: null, sending: false, secret: null, restoreFocus: true };

  dlg.addEventListener('cancel', (e) => {
    if (st.sending || st.secret) e.preventDefault();
  });
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (st.sending || st.secret)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
  // Cleanup after the dialog closed, whatever closed it: our buttons call it at once; Esc and the browser's close
  // watcher reach it through the `close` or `toggle` event (some engines fire only `toggle`). Idempotent.
  function afterClose() {
    if (dlg.open) return;
    if (st.secret && !st.secret.mayClose()) {
      // A forced close never drops the secrets unseen: reopen as it was.
      dlg.showModal();
      return;
    }
    if (st.secret) {
      st.secret.wipe();
      st.secret = null;
    }
    if (!dlg.firstChild && !st.opener) return;
    clear(dlg);
    dlg.className = '';
    const el = st.opener ? findOpener(st.opener) : null;
    st.opener = null;
    if (st.restoreFocus && el) el.focus();
    st.restoreFocus = true;
  }

  /** The opener itself, or the same button in its row after a polling re-render replaced the row. */
  function findOpener(op) {
    if (op.el && op.el.isConnected) return op.el;
    if (op.id) return document.getElementById(op.id);
    if (op.key && op.fk) {
      for (const tr of document.querySelectorAll('tr[data-key]')) {
        if (tr.dataset.key !== op.key) continue;
        const b = [...tr.querySelectorAll('[data-fk]')].find((x) => x.dataset.fk === op.fk);
        if (b) return b;
      }
    }
    return null;
  }

  function describeOpener(el) {
    if (!el || !el.focus) return null;
    const tr = el.closest ? el.closest('tr[data-key]') : null;
    return { el, id: el.id || null, key: tr ? tr.dataset.key : null, fk: el.dataset ? el.dataset.fk || null : null };
  }
  dlg.addEventListener('close', afterClose);
  dlg.addEventListener('toggle', (e) => {
    if (e.newState === 'closed') afterClose();
  });

  function closeDlg() {
    if (dlg.open) dlg.close();
    afterClose();
  }

  function show(opener) {
    if (opener !== undefined) st.opener = describeOpener(opener);
    if (!dlg.open) dlg.showModal();
  }

  function closeQuiet() {
    st.restoreFocus = false;
    closeDlg();
  }

  /** Builds one dialog screen: title, body nodes, error line, buttons. Returns parts. */
  function screen({ title, body, actionLabel, actionKind = 'primary', cancelLabel = 'Cancelar', onSubmit, wide }) {
    clear(dlg);
    dlg.className = wide ? 'wide' : '';
    const titleEl = h('h2', { id: 'dlg-title' }, title);
    const err = h('p', { class: 'dlg-error', role: 'alert', hidden: true });
    const cancel = button(cancelLabel, () => closeDlg(), '', { class: 'dlg-cancel' });
    const action = actionLabel ? h('button', { type: 'submit', class: ['btn', `btn-${actionKind}`] }, actionLabel) : null;
    const form = h('form', { class: 'dlg-form', novalidate: true },
      titleEl, h('div', { class: 'dlg-body' }, body), err, h('div', { class: 'dlg-buttons' }, cancel, action));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (action && !action.disabled && onSubmit) onSubmit();
    });
    dlg.append(form);
    return {
      form, err, cancel, action,
      showError(text) {
        clear(err);
        err.append(dot('bad'), text);
        err.hidden = false;
      },
      clearError() {
        clear(err);
        err.hidden = true;
      },
    };
  }

  function radioGroup(name, legend, options, checkedValue, extra) {
    const fs = h('fieldset', { class: 'field' }, h('legend', null, legend));
    const inputs = [];
    for (const o of options) {
      const id = nextId(name);
      const inp = h('input', { type: 'radio', name, id, value: o.value });
      if (o.value === checkedValue) inp.checked = true;
      inputs.push(inp);
      const lab = h('label', { for: id, class: 'opt' }, inp, ` ${o.label}`);
      if (o.value === 'outro' && extra) lab.append(' ', extra.input, ` ${extra.suffix}`);
      fs.append(lab);
    }
    return { el: fs, value: () => (inputs.find((i) => i.checked) || {}).value, inputs };
  }

  function lanesGroup(current) {
    const fs = h('fieldset', { class: 'field' }, h('legend', null, 'Faixas'));
    const boxes = {};
    for (const [v, label] of [['odc', 'ODC'], ['o11', 'O11']]) {
      const id = nextId(`lane-${v}`);
      const cb = h('input', { type: 'checkbox', id, value: v });
      cb.checked = current.includes(v);
      boxes[v] = cb;
      fs.append(h('label', { for: id, class: 'opt' }, cb, ` ${label}`));
    }
    return { el: fs, value: () => ['odc', 'o11'].filter((v) => boxes[v].checked), boxes };
  }

  /** The confirmation step shared by every license action. */
  function confirmScreen({ title, rows, texts = [], customer, actionLabel, actionKind = 'primary', send, back }) {
    const inputId = nextId('confirm');
    const input = h('input', { type: 'text', id: inputId, class: 'ctl wide', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off' });
    const body = [];
    if (rows && rows.length) body.push(kvTable(rows, { label: 'Resumo da ação', cls: 'dlg-kv' }));
    for (const t of texts) {
      if (!t) continue;
      body.push(h('p', { class: ['dlg-text', t.level && `lv-${t.level}`] }, t.level ? dot(t.level) : null, t.text));
    }
    body.push(h('label', { for: inputId, class: 'field-label' },
      'Para confirmar, digite o nome do cliente: ', h('span', { class: 'strong' }, customer)));
    body.push(input);
    const sc = screen({
      title, body, actionLabel, actionKind,
      cancelLabel: 'Cancelar',
      onSubmit: async () => {
        if (!confirmMatches(input.value, customer)) return;
        const label = sc.action.textContent;
        st.sending = true;
        sc.action.disabled = true;
        sc.cancel.disabled = true;
        input.disabled = true;
        sc.action.textContent = 'Enviando…';
        sc.clearError();
        try {
          await send(input.value.trim());
        } catch (e) {
          if (e?.kind === 'auth') return;
          st.sending = false;
          sc.action.textContent = label;
          sc.cancel.disabled = false;
          input.disabled = false;
          sc.action.disabled = !confirmMatches(input.value, customer);
          sc.showError(e?.message || 'Falha ao enviar.');
          input.focus();
          return;
        }
        st.sending = false;
      },
    });
    if (back) {
      const b = button('Voltar', back, '', { class: 'dlg-back' });
      sc.cancel.before(b);
    }
    sc.action.disabled = true;
    input.addEventListener('input', () => {
      sc.action.disabled = !confirmMatches(input.value, customer);
    });
    input.focus();
    return sc;
  }

  // ---------------------------------------------------------------- Emitir licença

  function issue(opener, licenses) {
    show(opener);
    issueForm({ customer: '', validity: '30', other: '', lanes: ['odc', 'o11'] }, licenses);
  }

  function issueForm(values, licenses) {
    const nameId = nextId('cliente');
    const hintId = nextId('hint');
    const name = h('input', {
      type: 'text', id: nameId, class: 'ctl wide', maxlength: '64', autocomplete: 'off', spellcheck: 'false',
      'aria-describedby': hintId, required: true,
    });
    name.value = values.customer;
    const other = h('input', { type: 'number', class: 'ctl days', min: '1', max: '3650', step: '1', inputmode: 'numeric', 'aria-label': 'Outro: dias' });
    other.value = values.other;
    const validity = radioGroup('validade', 'Validade', [
      { value: '30', label: '30 dias' }, { value: '90', label: '90 dias' }, { value: '365', label: '365 dias' },
      { value: 'outro', label: 'Outro:' }, { value: 'sem', label: 'Sem validade' },
    ], values.validity, { input: other, suffix: 'dias' });
    other.addEventListener('focus', () => {
      const r = validity.inputs.find((i) => i.value === 'outro');
      if (r) r.checked = true;
    });
    const lanes = lanesGroup(values.lanes);
    const dupLine = h('p', { class: 'dlg-text lv-warn', hidden: true });
    const nameErr = h('p', { class: 'field-error', hidden: true });
    const body = [
      h('div', { class: 'field' },
        h('label', { for: nameId, class: 'field-label' }, 'Cliente'),
        name,
        h('p', { class: 'hint', id: hintId }, NAME_HINT),
        nameErr),
      dupLine,
      validity.el,
      lanes.el,
    ];
    const checkDup = () => {
      const n = name.value.trim().toLocaleLowerCase('pt-BR');
      const dups = n ? (licenses || []).filter((l) => l.state === 'active' && String(l.customer).trim().toLocaleLowerCase('pt-BR') === n) : [];
      clear(dupLine);
      if (dups.length) {
        dupLine.append(dot('warn'), `Já existe licença ativa para este cliente (${dups.map((d) => d.id).join(', ')}). Uma nova licença não revoga a antiga.`);
        dupLine.hidden = false;
      } else dupLine.hidden = true;
    };
    name.addEventListener('input', () => {
      checkDup();
      nameErr.hidden = true;
    });
    const sc = screen({
      title: 'Emitir licença', body, actionLabel: 'Continuar',
      onSubmit: () => {
        sc.clearError();
        const customer = name.value.trim();
        if (!validCustomer(customer)) {
          clear(nameErr);
          nameErr.append(dot('bad'), `Nome inválido: use ${NAME_HINT}`);
          nameErr.hidden = false;
          name.focus();
          return;
        }
        const v = validity.value();
        let days = null;
        if (v === 'outro') {
          days = parseDays(other.value);
          if (days == null) {
            sc.showError('Validade: digite um número inteiro de 1 a 3650 dias.');
            other.focus();
            return;
          }
        } else if (v !== 'sem') days = Number(v);
        const ln = lanes.value();
        if (!ln.length) {
          sc.showError('Escolha ao menos uma faixa.');
          lanes.boxes.odc.focus();
          return;
        }
        issueConfirm({ customer, days, lanes: ln, values: { customer, validity: v, other: other.value, lanes: ln } }, licenses);
      },
    });
    checkDup();
    name.focus();
  }

  function issueConfirm(req, licenses) {
    const now = ctx.clock.now();
    const exp = req.days == null ? 'sem validade' : `até ${F.fmtDate(now + req.days * F.DAY)}, ${F.fmtTime(now + req.days * F.DAY)}`;
    confirmScreen({
      title: 'Emitir licença',
      rows: [
        { label: 'Cliente', value: req.customer },
        { label: 'Validade', value: exp },
        { label: 'Faixas', value: F.fmtLanes(req.lanes) },
      ],
      texts: [{ text: 'O token e a credencial do agente aparecem uma vez só, na próxima tela.' }],
      customer: req.customer,
      actionLabel: 'Emitir licença',
      back: () => issueForm(req.values, licenses),
      send: async (confirm) => {
        const res = await ctx.api.issue({ customer: req.customer, days: req.days, lanes: req.lanes, confirm });
        const lic = res.license || {};
        st.secret = openSecretPanel(dlg, {
          kind: 'issue',
          customer: lic.customer || req.customer,
          tokenId: lic.id,
          token: res.secret?.token,
          agentCredential: res.secret?.agentCredential,
          publicUrl: res.publicUrl,
          serverUrl: res.serverUrl,
          onClose: () => {
            const days = lic.expiresAt ? `até ${F.fmtDate(lic.expiresAt)}` : 'sem validade';
            closeQuiet();
            ctx.notify(`Licença emitida para ${lic.customer || req.customer} (${F.fmtLanes(lic.lanes || req.lanes)}, ${days}).`, 'ok');
          },
        });
        ctx.afterMutation();
      },
    });
  }

  // ---------------------------------------------------------------- Renovar

  function renew(opener, lic) {
    show(opener);
    renewForm(lic, { choice: '30', other: '' });
  }

  function renewForm(lic, values) {
    const now = ctx.clock.now();
    const current = F.fmtValidity(lic, now).text;
    const other = h('input', { type: 'number', class: 'ctl days', min: '1', max: '3650', step: '1', inputmode: 'numeric', 'aria-label': 'Outro: dias' });
    other.value = values.other;
    const group = radioGroup('renovar', 'Estender por', [
      { value: '30', label: '+30 dias' }, { value: '90', label: '+90 dias' }, { value: '365', label: '+365 dias' },
      { value: 'outro', label: 'Outro:' },
    ], values.choice, { input: other, suffix: 'dias' });
    const live = h('p', { class: 'dlg-text', 'aria-live': 'polite' });
    const days = () => (group.value() === 'outro' ? parseDays(other.value) : Number(group.value()));
    const paint = () => {
      const d = days();
      if (d == null) {
        live.textContent = 'Nova validade: digite de 1 a 3650 dias.';
        return;
      }
      live.textContent = renewLine(lic.expiresAt, d, ctx.clock.now());
    };
    for (const i of group.inputs) i.addEventListener('change', paint);
    other.addEventListener('input', () => {
      const r = group.inputs.find((i) => i.value === 'outro');
      if (r) r.checked = true;
      paint();
    });
    paint();
    const sc = screen({
      title: `Renovar a licença de ${lic.customer}`,
      body: [h('p', { class: 'dlg-text' }, `Validade atual: ${current}`), group.el, live],
      actionLabel: 'Continuar',
      onSubmit: () => {
        const d = days();
        if (d == null) {
          sc.showError('Validade: digite um número inteiro de 1 a 3650 dias.');
          other.focus();
          return;
        }
        renewConfirm(lic, d, { choice: group.value(), other: other.value });
      },
    });
    (group.inputs.find((i) => i.checked) || group.inputs[0]).focus();
  }

  function renewConfirm(lic, days, values) {
    const now = ctx.clock.now();
    const expired = lic.state === 'expired' || F.toMs(lic.expiresAt) <= now;
    const next = renewedExpiry(lic.expiresAt, days, now);
    confirmScreen({
      title: `Renovar a licença de ${lic.customer}`,
      rows: [
        { label: 'Cliente', value: lic.customer },
        { label: 'Validade atual', value: F.fmtValidity(lic, now).text },
        { label: 'Nova validade', value: `até ${F.fmtDate(next)}, ${F.fmtTime(next)} (+${F.plural(days, 'dia', 'dias')})` },
      ],
      texts: [{
        text: expired
          ? 'A licença volta a valer na hora; o agente reconecta sozinho e o cliente abre sessões novas.'
          : 'As sessões e o agente continuam como estão; a nova data vale na hora.',
      }],
      customer: lic.customer,
      actionLabel: 'Renovar',
      back: () => renewForm(lic, values),
      send: async (confirm) => {
        const res = await ctx.api.renew(lic.id, { days, confirm, expectExpiresAt: lic.expiresAt ?? null });
        closeQuiet();
        ctx.notify(`Validade de ${lic.customer} estendida até ${F.fmtDate(res.expiresAt || res.license?.expiresAt)}.`, 'ok');
        ctx.afterMutation();
      },
    });
  }

  // ---------------------------------------------------------------- Faixas

  function lanes(opener, lic, sessions) {
    show(opener);
    lanesForm(lic, lic.lanes || [], sessions);
  }

  function lanesForm(lic, chosen, sessions) {
    const group = lanesGroup(chosen);
    const same = h('p', { class: 'muted dlg-text', 'aria-live': 'polite' });
    const sc = screen({
      title: `Faixas de ${lic.customer}`,
      body: [h('p', { class: 'dlg-text' }, `Faixas atuais: ${F.fmtLanes(lic.lanes)}`), group.el, same],
      actionLabel: 'Continuar',
      onSubmit: () => {
        const v = group.value();
        if (!v.length) {
          sc.showError('Escolha ao menos uma faixa.');
          return;
        }
        lanesConfirm(lic, v, sessions);
      },
    });
    const paint = () => {
      const v = group.value();
      const unchanged = F.fmtLanes(v) === F.fmtLanes(lic.lanes);
      same.textContent = unchanged ? 'Nada mudou' : '';
      sc.action.disabled = unchanged || !v.length;
      if (v.length) sc.clearError();
    };
    for (const cb of Object.values(group.boxes)) cb.addEventListener('change', paint);
    paint();
    group.boxes.odc.focus();
  }

  function lanesConfirm(lic, next, sessions) {
    const removed = (lic.lanes || []).some((l) => !next.includes(l));
    const n = Array.isArray(sessions) ? sessions.length : (lic.sessionsOpen ?? 0);
    const texts = [];
    if (removed && n > 0) {
      texts.push({
        level: 'warn',
        text: n === 1
          ? '1 sessão aberta mantém as faixas antigas até fechar (inatividade de 60 min ou reconexão do cliente). O ssam_doctor dela também mostra as antigas.'
          : `${F.fmtInt(n)} sessões abertas mantêm as faixas antigas até fecharem (inatividade de 60 min ou reconexão do cliente). O ssam_doctor delas também mostra as antigas.`,
      });
    }
    confirmScreen({
      title: `Faixas de ${lic.customer}`,
      rows: [
        { label: 'Cliente', value: lic.customer },
        { label: 'Faixas', value: `${F.fmtLanes(lic.lanes)} → ${F.fmtLanes(next)}` },
      ],
      texts,
      customer: lic.customer,
      actionLabel: 'Salvar faixas',
      back: () => lanesForm(lic, next, sessions),
      send: async (confirm) => {
        const res = await ctx.api.lanes(lic.id, { lanes: next, confirm, expectLanes: lic.lanes || [] });
        closeQuiet();
        const open = res.openSessions ?? 0;
        let msg = `Faixas de ${lic.customer}: ${F.fmtLanes(res.previousLanes || lic.lanes)} → ${F.fmtLanes(res.license?.lanes || next)}.`;
        if (open > 0 && removed) {
          msg += open === 1
            ? ' 1 sessão aberta mantém as faixas antigas até fechar.'
            : ` ${F.fmtInt(open)} sessões abertas mantêm as faixas antigas até fecharem.`;
        }
        ctx.notify(msg, 'ok');
        ctx.afterMutation();
      },
    });
  }

  // ---------------------------------------------------------------- Credencial do agente

  function agentRotate(opener, lic) {
    show(opener);
    confirmScreen({
      title: `Trocar a credencial do agente de ${lic.customer}`,
      texts: [{ text: 'A credencial atual deixa de valer agora e o canal do agente fecha em até 1 s. O cliente precisa rodar o setup do agente com a nova.' }],
      customer: lic.customer,
      actionLabel: 'Trocar credencial',
      send: async (confirm) => {
        const res = await ctx.api.agentRotate(lic.id, { confirm });
        st.secret = openSecretPanel(dlg, {
          kind: 'rotate',
          customer: res.license?.customer || lic.customer,
          tokenId: res.license?.id || lic.id,
          agentCredential: res.secret?.agentCredential,
          serverUrl: res.serverUrl,
          onClose: () => {
            closeQuiet();
            ctx.notify(`Credencial do agente de ${lic.customer} trocada.`, 'ok');
          },
        });
        ctx.afterMutation();
      },
    });
  }

  // ---------------------------------------------------------------- Revogar

  function revoke(opener, lic, sessions) {
    show(opener);
    const n = Array.isArray(sessions) ? sessions.length : (lic.sessionsOpen ?? 0);
    const sess = n === 1 ? '1 sessão aberta' : `${F.fmtInt(n)} sessões abertas`;
    confirmScreen({
      title: `Revogar a licença de ${lic.customer}`,
      texts: [{
        level: 'bad',
        text: `Revogar é definitivo. O token e a credencial do agente param na hora (403); ${sess} e o canal do agente fecham em até 1 s. O espaço de trabalho fica no disco (DEPLOY.md seção 11 explica o desligamento).`,
      }],
      customer: lic.customer,
      actionLabel: 'Revogar licença',
      actionKind: 'danger-fill',
      send: async (confirm) => {
        const res = await ctx.api.revoke(lic.id, { confirm });
        closeQuiet();
        const open = res.openSessions ?? 0;
        const parts = [];
        if (open > 0) parts.push(open === 1 ? 'A sessão aberta' : `As ${F.fmtInt(open)} sessões abertas`);
        if (res.agentConnected) parts.push('o agente');
        let msg = `Licença de ${lic.customer} revogada.`;
        if (parts.length) {
          const who = parts.join(' e ');
          msg += ` ${who.charAt(0).toUpperCase()}${who.slice(1)} ${parts.length > 1 || open > 1 ? 'fecham' : 'fecha'} em até 1 s.`;
        }
        ctx.notify(msg, 'ok');
        ctx.afterMutation();
      },
    });
  }

  // ---------------------------------------------------------------- shortcuts (?)

  function shortcuts(opener) {
    show(opener);
    const rows = [
      { label: '1 a 7', value: 'troca de aba (Visão geral … Histórico)' },
      { label: '/', value: 'vai para o filtro da aba' },
      { label: 'r', value: 'atualiza agora' },
      { label: '?', value: 'mostra estes atalhos' },
      { label: '← → Home End', value: 'movem entre as abas quando uma aba tem o foco' },
      { label: 'Esc', value: 'fecha a janela aberta (menos a dos segredos)' },
    ];
    const sc = screen({ title: 'Atalhos do teclado', body: [kvTable(rows, { label: 'Atalhos', cls: 'dlg-kv' })], cancelLabel: 'Fechar' });
    sc.cancel.focus();
  }

  return {
    issue, renew, lanes, agentRotate, revoke, shortcuts,
    isSecretOpen: () => !!st.secret,
  };
}
