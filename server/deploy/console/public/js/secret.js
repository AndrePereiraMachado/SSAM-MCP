// One-time secret panel (DESIGN.md 6.11). Shown in the dialog after Emitir licença or Trocar credencial: masked
// values with Mostrar / Copiar, the ready-made configuration blocks (only the env var block carries the token),
// Copiar tudo, Baixar .txt, and Fechar enabled only after the "Guardei" checkbox. Esc, the backdrop and the browser's
// back do nothing while it is open; leaving the page asks first. On close every node is removed and every
// reference to the secret is dropped. The console never stores or re-sends these values.

import { h, clear, button, textButton } from './dom.js';
import { slug } from './format.js';

const MASK_TOKEN = 'ssam_\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
const MASK_AGENT = 'ssam_agent_\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';

/** Configuration blocks (pure: unit-tested). kind 'issue' gives 4 blocks, 'rotate' only the agent block. */
export function secretBlocks({ kind, token, publicUrl, serverUrl }) {
  const blocks = [];
  if (kind === 'issue') {
    blocks.push({
      id: 'env',
      label: 'Vari\u00e1vel de ambiente no Windows do cliente (PowerShell, uma vez)',
      text: `[Environment]::SetEnvironmentVariable('SSAM_TOKEN', '${token}', 'User')`,
      masked: `[Environment]::SetEnvironmentVariable('SSAM_TOKEN', '${MASK_TOKEN}', 'User')`,
      secret: true,
    });
    const mcp = { mcpServers: { ssam: { type: 'http', url: publicUrl, headers: { Authorization: 'Bearer ${SSAM_TOKEN}' } } } };
    blocks.push({ id: 'mcp', label: '.mcp.json do projeto (Claude Code)', text: JSON.stringify(mcp, null, 2) });
    blocks.push({
      id: 'codex',
      label: 'Codex (~/.codex/config.toml)',
      text: ['[mcp_servers.ssam]', `url = "${publicUrl}"`, 'bearer_token_env_var = "SSAM_TOKEN"'].join('\n'),
    });
  }
  blocks.push({
    id: 'agent',
    label: 'Agente (Windows do cliente)',
    text: [
      'Expand-Archive .\\ssam-agent.zip -DestinationPath C:\\SSAM-Agent',
      `C:\\SSAM-Agent\\agent\\node\\node.exe C:\\SSAM-Agent\\agent\\ssam-agent.mjs setup --server ${serverUrl} --root C:\\SSAM-Agent`,
      'powershell -ExecutionPolicy Bypass -File C:\\SSAM-Agent\\agent\\ssam-agent.ps1 start',
    ].join('\n'),
  });
  return blocks;
}

export const SECRET_WARNING = 'Eles aparecem s\u00f3 agora. O servidor guarda s\u00f3 o hash; se perder, troque a credencial ou emita outra licen\u00e7a.';
export const SECRET_NOTE = 'Mande o token e a credencial por canais separados. O hist\u00f3rico da \u00e1rea de transfer\u00eancia do Windows (Win+V) guarda o que voc\u00ea copiar.';

/** Text of Copiar tudo / Baixar .txt (pure: unit-tested). */
export function secretText(p) {
  const out = [`Segredos de ${p.customer} - guarde agora`, SECRET_WARNING, ''];
  if (p.tokenId) out.push(`Licen\u00e7a: ${p.tokenId}`);
  if (p.kind === 'issue' && p.token) out.push(`Token MCP: ${p.token}`);
  if (p.agentCredential) out.push(`Credencial do agente: ${p.agentCredential}`);
  for (const b of secretBlocks(p)) out.push('', b.label, b.text);
  out.push('', SECRET_NOTE, '');
  return out.join('\n');
}

export function secretFileName(customer, tokenId) {
  return `ssam-${slug(customer)}-${tokenId || 'licenca'}.txt`;
}

async function copyText(text, fallbackHost) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall back below */
  }
  const ta = h('textarea', { class: 'offscreen', readonly: true, 'aria-hidden': 'true', tabindex: '-1' });
  ta.value = text;
  fallbackHost.append(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.value = '';
  ta.remove();
  return ok;
}

function copyButton(label, getText, host) {
  const b = button(label, async () => {
    const ok = await copyText(getText(), host);
    const was = b.dataset.label || label;
    b.dataset.label = was;
    b.textContent = ok ? 'Copiado' : 'N\u00e3o copiou';
    clearTimeout(Number(b.dataset.t || 0));
    b.dataset.t = String(setTimeout(() => {
      if (b.isConnected) b.textContent = was;
    }, 2000));
  }, '', { class: 'btn-copy' });
  return b;
}

/**
 * Renders the panel into the open dialog. Returns {mayClose(), wipe()}.
 * p: {kind: 'issue'|'rotate', customer, tokenId, token, agentCredential, publicUrl, serverUrl, onClose}
 */
export function openSecretPanel(dlg, p) {
  let data = { ...p };
  let allowed = false;
  let masked = true;
  const onUnload = (e) => {
    e.preventDefault();
    e.returnValue = '';
    return '';
  };
  window.addEventListener('beforeunload', onUnload);
  // The browser's back button: keep one extra history entry while the panel is open (main.js also ignores routes).
  try {
    history.pushState({ secretPanel: true }, '', location.href);
  } catch {
    /* ignore */
  }
  const onPop = () => {
    if (data) {
      try {
        history.pushState({ secretPanel: true }, '', location.href);
      } catch {
        /* ignore */
      }
    }
  };
  window.addEventListener('popstate', onPop);

  clear(dlg);
  dlg.className = 'wide secret';
  const form = h('div', { class: 'dlg-form' });
  const valueCells = [];
  const preBlocks = [];

  const title = h('h2', { id: 'dlg-title' }, `Segredos de ${data.customer} - guarde agora`);
  const warn = h('p', { class: 'dlg-text lv-bad secret-warn' }, SECRET_WARNING);

  const tbody = h('tbody');
  const table = h('table', { class: 'grid secret-table', 'aria-label': 'Segredos' },
    h('thead', null, h('tr', null,
      h('th', { scope: 'col' }, 'Item'), h('th', { scope: 'col' }, 'Valor'), h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'A\u00e7\u00e3o')))),
    tbody);

  function paintMasks() {
    for (const c of valueCells) c.span.textContent = masked ? c.mask : data?.[c.field] ?? '';
    for (const b of preBlocks) b.pre.textContent = masked && b.block.secret ? b.block.masked : b.block.text;
    for (const t of toggles) {
      t.textContent = masked ? 'Mostrar' : 'Ocultar';
      t.setAttribute('aria-pressed', masked ? 'false' : 'true');
    }
  }
  const toggles = [];
  const addRow = (label, field, mask) => {
    const span = h('span', { class: 'mono secret-value' });
    valueCells.push({ span, field, mask });
    const tg = textButton('Mostrar', () => {
      masked = !masked;
      paintMasks();
    }, { 'aria-pressed': 'false' });
    toggles.push(tg);
    tbody.append(h('tr', null,
      h('th', { scope: 'row' }, label),
      h('td', { class: 'secret-cell' }, span, ' ', tg),
      h('td', null, copyButton('Copiar', () => data?.[field] ?? '', form))));
  };
  if (data.kind === 'issue' && data.token) addRow('Token MCP', 'token', MASK_TOKEN);
  if (data.agentCredential) addRow('Credencial do agente', 'agentCredential', MASK_AGENT);

  const blocksHead = h('h3', { class: 'subhead' }, 'Configura\u00e7\u00e3o pronta');
  const blocksEl = h('div', { class: 'blocks' });
  for (const b of secretBlocks(data)) {
    const pre = h('pre', { class: 'snippet' });
    preBlocks.push({ pre, block: b });
    blocksEl.append(h('div', { class: 'snippet-block' },
      h('div', { class: 'snippet-head' }, h('span', { class: 'snippet-label' }, b.label), copyButton('Copiar', () => b.text, form)),
      pre));
  }

  const copyAll = copyButton('Copiar tudo', () => secretText(data), form);
  const download = button('Baixar .txt', () => {
    const blob = new Blob([secretText(data)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: secretFileName(data.customer, data.tokenId), class: 'offscreen' });
    form.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  const note = h('p', { class: 'muted dlg-text' }, SECRET_NOTE);
  const cbId = `guardei-${Date.now()}`;
  const cb = h('input', { type: 'checkbox', id: cbId });
  const cbLabel = h('label', { for: cbId, class: 'opt guardei' }, cb,
    data.kind === 'issue' ? ' Guardei o token e a credencial em lugar seguro.' : ' Guardei a credencial em lugar seguro.');
  const close = button('Fechar', () => {
    if (!cb.checked) return;
    allowed = true;
    const done = data.onClose;
    if (done) done();
    else dlg.close();
  }, 'primary');
  close.disabled = true;
  cb.addEventListener('change', () => {
    close.disabled = !cb.checked;
  });

  form.append(
    title, warn, h('div', { class: 'table-wrap' }, table), blocksHead, blocksEl,
    h('div', { class: 'dlg-buttons left' }, copyAll, download),
    note, cbLabel,
    h('div', { class: 'dlg-buttons' }, close));
  dlg.append(form);
  if (!dlg.open) dlg.showModal();
  paintMasks();
  const first = form.querySelector('.secret-cell button') || cb;
  first.focus();

  return {
    mayClose: () => allowed,
    wipe() {
      window.removeEventListener('beforeunload', onUnload);
      window.removeEventListener('popstate', onPop);
      for (const c of valueCells) c.span.textContent = '';
      for (const b of preBlocks) {
        b.pre.textContent = '';
        b.block = null;
      }
      valueCells.length = 0;
      preBlocks.length = 0;
      toggles.length = 0;
      clear(form);
      form.remove();
      data = null;
      // Drop the extra history entry pushed when the panel opened (same URL, so no route change).
      if (history.state && history.state.secretPanel) {
        try {
          history.back();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
