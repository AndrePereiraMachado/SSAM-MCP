// Boot of the owner console (DESIGN.md 6.2, 6.3, 6.8, 6.9; the Qualidade tab of DESIGN-QUALIDADE 4.5, shortcut 4; the
// v2 shell of SPEC painel v2 section 2): key from #k=, hash routes, the left sidebar (icons, counts, alert dots), the
// top bar (server, image, warm, collector, indexing), polling per view (paused while the document is hidden, backoff
// on errors), theme (dark by default), keyboard shortcuts, toasts.

import { api, initKey, getKey, on, clock, store, setSession } from './api.js';
import { VIEWS, SERVER_WORD, WARM_WORD } from './labels.js';
import * as F from './format.js';
import { h, clear, dot, iconButton, iconChip } from './dom.js';
import { icon } from './icons.js';
import { meter } from './charts.js';
import { createDialogs } from './dialogs.js';
import { viewAlertLevels } from './views/common.js';
import createVisao from './views/visao.js';
import createLicencas from './views/licencas.js';
import createUso from './views/uso.js';
import createQualidade from './views/qualidade.js';
import createAgentes from './views/agentes.js';
import createVps from './views/vps.js';
import createEventos from './views/eventos.js';
import createHistorico from './views/historico.js';

const $ = (id) => document.getElementById(id);
const THEME_KEY = 'ssam-console-theme';
const THEMES = [
  { id: 'auto', label: 'automático', icon: 'theme-auto' },
  { id: 'light', label: 'claro', icon: 'sun' },
  { id: 'dark', label: 'escuro', icon: 'moon' },
];
const DEFAULT_THEME = 'dark';

const state = {
  current: null,
  params: new URLSearchParams(),
  hash: '',
  dead: false,
  connLostAt: null,
  lastOverviewOkAt: null,
  pendingSubject: null,
  timers: { view: null, status: null, meta: null, tick: null },
  failures: { view: 0, status: 0, meta: 0 },
  inflight: { view: false, status: false, meta: false },
  rerunView: false,
};

// ---------------------------------------------------------------- theme (dark unless the owner chose another)

function readTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return THEMES.some((t) => t.id === v) ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

function applyTheme(id) {
  const root = document.documentElement;
  if (id === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', id);
  const t = THEMES.find((x) => x.id === id) || THEMES[2];
  const btn = $('btn-theme');
  clear(btn);
  btn.append(icon(t.icon, 18));
  btn.setAttribute('aria-label', `Tema: ${t.label}`);
  btn.title = `Tema: ${t.label}`;
}

function cycleTheme() {
  const cur = themeOverride || readTheme();
  const idx = THEMES.findIndex((t) => t.id === cur);
  const next = THEMES[(idx + 1) % THEMES.length].id;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* storage blocked: the theme holds for this page only */
  }
  applyTheme(next);
  themeOverride = next;
}
let themeOverride = null;

// ---------------------------------------------------------------- toasts (6.9, SPEC 2.5)

const noticeTimers = new WeakMap();
const TOAST_ICON = { ok: 'check-circle', warn: 'alert-triangle', bad: 'alert-octagon', info: 'info' };

function noticeFor(section) {
  let p = section.querySelector(':scope > .toast');
  if (!p) {
    p = h('div', { class: 'toast', role: 'status', tabindex: '-1', hidden: true });
    section.prepend(p);
  }
  return p;
}

/** One toast per view, bottom right: icon + sentence + Fechar. Errors stay; others hide after 15 s. */
function notify(text, level = 'ok', { focus = true } = {}) {
  const view = state.current ? views[state.current] : null;
  const section = view ? view.section : $('view-visao');
  const p = noticeFor(section);
  clear(p);
  const lv = TOAST_ICON[level] ? level : 'info';
  p.append(iconChip(TOAST_ICON[lv], lv, 16, 'toast-icon'), h('p', { class: 'toast-text' }, text),
    iconButton('x', 'Fechar', () => {
      p.hidden = true;
    }, { class: 'btn-sm toast-close' }));
  p.className = `toast toast-${lv}${level === 'bad' ? ' is-error' : ''}`;
  p.hidden = false;
  clearTimeout(noticeTimers.get(p));
  if (level !== 'bad') noticeTimers.set(p, setTimeout(() => { p.hidden = true; }, 15000));
  if (focus) p.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- top bar (6.3, SPEC 2.3)

const WARM_LEVEL = { warm: 'plain', partial: 'warn', warming: 'warn', cold: 'warn', unknown: 'muted' };

function collectorItem(col, now) {
  if (col.state === 'fresh' && col.collectedAt) {
    const rel = F.fmtRelative(col.collectedAt, now);
    return h('span', { class: 'tb-col', title: F.fmtTitle(col.collectedAt) }, icon('radar', 16), rel === 'agora' ? 'coletado agora' : `coletado ${rel}`);
  }
  if (col.state === 'stale') {
    return h('span', { class: 'tb-col lv-warn strong', title: col.collectedAt ? F.fmtTitle(col.collectedAt) : '' }, icon('radar', 16), 'coletor parado');
  }
  if (col.state === 'missing') return h('span', { class: 'tb-col lv-bad strong' }, icon('radar', 16), 'coletor ausente');
  if (col.state === 'invalid') return h('span', { class: 'tb-col lv-warn strong' }, icon('radar', 16), 'coletor em formato desconhecido');
  return null;
}

function renderFacts() {
  const facts = $('facts');
  const ov = store.overview;
  if (!ov || !ov.status) {
    if (!state.connLostAt) facts.textContent = 'Carregando…';
    return;
  }
  const st = ov.status;
  const now = clock.now();
  const srv = st.server || {};
  const sw = SERVER_WORD[srv.state] || SERVER_WORD.unknown;
  const warmWord = WARM_WORD[srv.warm] || WARM_WORD.unknown;
  const pill = h('span', { class: ['srv-pill', `pill-${sw.level}`] }, dot(sw.level), h('span', { class: 'srv-k' }, 'Servidor'), ' ',
    h('span', { class: 'srv-w' }, sw.word));
  const pillTitle = [];
  if (srv.state === 'up' && srv.since) {
    pill.append(h('span', { class: 'srv-since' }, ` · há ${F.fmtDuration(now - F.toMs(srv.since))}`));
    pillTitle.push(`no ar desde ${F.fmtTitle(srv.since)}`);
  }
  pillTitle.push(warmWord);
  pill.title = pillTitle.join(' · ');
  const items = [pill];
  if (srv.imageTag) items.push(h('span', { class: 'tb-chip tb-image', title: 'Imagem do servidor' }, icon('server', 16), h('span', { class: 'mono' }, srv.imageTag)));
  const wl = WARM_LEVEL[srv.warm] || 'muted';
  items.push(h('span', { class: ['tb-chip', 'tb-warm', `w-${wl}`], title: srv.warmDetail || warmWord }, icon('bolt', 16), warmWord));
  items.push(h('span', { class: 'tb-spacer' }));
  const ci = collectorItem(st.collector || {}, now);
  if (ci) items.push(ci);
  const idx = store.meta?.indexing || ov.indexing;
  if (idx && idx.state === 'running') {
    const pct = Math.round((Number(idx.progress) || 0) * 100);
    const m = meter({ label: 'Indexação do histórico', fraction: Number(idx.progress) || 0, level: 'accent', mini: true, valueText: `${pct}%` });
    items.push(h('span', { class: 'tb-idx' }, 'indexando histórico', m.el, h('span', { class: 'tnum' }, `${pct}%`)));
  }
  if (state.lastOverviewOkAt) items.push(h('span', { class: 'tb-upd' }, `atualizado às ${F.fmtTimeSec(state.lastOverviewOkAt)}`));
  $('btn-refresh').title = state.lastOverviewOkAt ? `Atualizar agora (r). Atualizado às ${F.fmtTimeSec(state.lastOverviewOkAt)}.` : 'Atualizar agora (r)';
  clear(facts);
  facts.append(...items);
}

// ---------------------------------------------------------------- sidebar counts and alert dots (SPEC 2.2)

function renderTabCounts() {
  const ov = store.overview;
  const st = ov?.status;
  if (!st) return;
  const a = st.alerts || {};
  const unacked = (a.critical || 0) + (a.warning || 0) + (a.info || 0);
  const levels = viewAlertLevels(ov.alerts);
  const active = st.licenses?.active ?? 0;
  const agents = st.agentsConnected ?? 0;
  const sessions = st.sessionsOpen ?? 0;
  for (const v of VIEWS) {
    const tab = $(`tab-${v.id}`);
    let count = '';
    let countLevel = 'neutral';
    let countSr = '';
    if (v.id === 'visao' && unacked) {
      count = F.fmtInt(unacked);
      countLevel = a.critical ? 'bad' : a.warning ? 'warn' : 'neutral';
      countSr = `${F.plural(unacked, 'alerta aberto', 'alertas abertos')}${a.critical ? `, ${F.plural(a.critical, 'crítico', 'críticos')}` : ''}`;
    } else if (v.id === 'licencas') {
      count = F.fmtInt(active);
      countSr = active === 1 ? '1 licença ativa' : `${F.fmtInt(active)} licenças ativas`;
    } else if (v.id === 'agentes') {
      count = `${F.fmtInt(agents)}/${F.fmtInt(sessions)}`;
      countSr = `${F.plural(agents, 'agente conectado', 'agentes conectados')}, ${F.plural(sessions, 'sessão aberta', 'sessões abertas')}`;
    }
    const tc = tab.querySelector('.tcount');
    tc.textContent = count;
    tc.className = `tcount c-${countLevel}`;
    tc.hidden = !count;
    const al = v.id === 'visao' ? null : levels[v.id];
    const dotLevel = al && (al.level === 'bad' || al.level === 'warn') ? al.level : null;
    const td = tab.querySelector('.tdot');
    td.className = `tdot${dotLevel ? ` lv-${dotLevel}` : ''}`;
    td.hidden = !dotLevel;
    const dotSr = dotLevel ? `${F.plural(al.count, 'alerta', 'alertas')}${al.critical ? ` (${F.plural(al.critical, 'crítico', 'críticos')})` : ''}` : '';
    tab.querySelector('.tsr').textContent = [countSr, dotSr].filter(Boolean).map((x) => `, ${x}`).join('');
    tab.title = [v.label, countSr, dotSr].filter(Boolean).join(' · ');
  }
  const widths = $('tabs').textContent;
  if (widths !== lastTabText) {
    lastTabText = widths;
    ensureTabVisible();
  }
}
let lastTabText = '';

function renderMetaBits() {
  const m = store.meta;
  if (!m) return;
  $('brand-host').textContent = m.publicHost || '';
  $('side-ver').textContent = m.console?.version ? `Painel v${m.console.version}` : '';
  // the GitHub mode: the CSRF token of the POSTs and the logout button with the login
  setSession(m.auth);
  const out = $('btn-logout');
  if (m.auth?.mode === 'github') {
    out.hidden = false;
    out.textContent = m.auth.login ? `Sair (${m.auth.login})` : 'Sair';
    out.title = 'Encerrar a sessão do painel';
  } else {
    out.hidden = true;
  }
}

const isGithubMode = () => store.meta?.auth?.mode === 'github';

/** The logout button: ends the session on the server, then the sign-in page (even when the call fails). */
async function logout() {
  const b = $('btn-logout');
  b.disabled = true;
  stopTimers();
  state.dead = true;
  try {
    await api.logout();
  } catch {
    /* the cookie is cleared by the sign-in page's next entry anyway */
  }
  location.replace('/auth/signin?r=saiu');
}

/**
 * 401 from the API: in the GitHub mode a missing or ended session goes to the sign-in page; in the key mode a missing
 * key is the "open through painel-ssam.ps1" card and a wrong one the fatal card.
 */
function handleAuthError(err) {
  const code = String(err?.code || '');
  stopTimers();
  state.dead = true;
  if (code === 'SESSION_REQUIRED' || code === 'SESSION_INVALID') {
    location.replace(code === 'SESSION_REQUIRED' ? '/auth/signin' : '/auth/signin?r=expirou');
    return;
  }
  if (code === 'KEY_REQUIRED' && !getKey()) {
    showNoKey();
    return;
  }
  showFatal('Chave de acesso inválida ou trocada (o painel reiniciou ou outra sessão abriu). Feche esta aba e rode painel-ssam.ps1.');
}

function showConnLost() {
  if (!state.connLostAt) state.connLostAt = clock.now();
  const conn = $('conn');
  clear(conn);
  const hint = isGithubMode() ? 'A VPS ou o proxy estão fora do ar?' : 'O túnel SSH caiu? Rode painel-ssam.ps1 de novo.';
  conn.append(icon('alert-octagon', 18), h('span', null,
    `Sem conexão com o painel desde ${F.fmtTimeSec(state.connLostAt)}. ${hint}`));
  conn.hidden = false;
  $('facts').hidden = true;
}

function clearConnLost() {
  if (!state.connLostAt) return;
  state.connLostAt = null;
  $('conn').hidden = true;
  $('facts').hidden = false;
}

/** The centered card that replaces the whole page (SPEC 2.7): no key (warn) or a refused key (bad). */
function fatalCard(level, text) {
  state.dead = true;
  $('app').hidden = true;
  const dlg = $('dlg');
  if (dlg.open) dlg.close();
  const f = $('fatal');
  clear(f);
  f.append(h('div', { class: 'fatal-card' },
    h('div', { class: 'fatal-brand' }, h('span', { class: 'brand-mark lg', 'aria-hidden': 'true' }, icon('brand', 22)), h('p', { class: 'fatal-name' }, 'Painel SSAM')),
    iconChip(level === 'bad' ? 'alert-octagon' : 'alert-triangle', level, 20, 'fatal-chip'),
    h('p', { class: 'fatal-text' }, text)));
  f.hidden = false;
}

function showFatal(text) {
  stopTimers();
  fatalCard('bad', text);
}

function showNoKey() {
  fatalCard('warn', 'Abra o painel pelo painel-ssam.ps1: ele cria o túnel e a chave desta sessão.');
}

// ---------------------------------------------------------------- data shared by the status line

async function refreshOverview() {
  if (state.inflight.status) return store.overview;
  state.inflight.status = true;
  try {
    const ov = await api.overview();
    store.overview = ov;
    store.overviewAt = clock.now();
    state.lastOverviewOkAt = clock.now();
    renderFacts();
    renderTabCounts();
    return ov;
  } finally {
    state.inflight.status = false;
  }
}

async function refreshMeta() {
  if (state.inflight.meta) return store.meta;
  state.inflight.meta = true;
  try {
    store.meta = await api.meta();
    renderMetaBits();
    renderFacts();
    return store.meta;
  } finally {
    state.inflight.meta = false;
  }
}

// ---------------------------------------------------------------- polling

function stopTimers() {
  for (const k of Object.keys(state.timers)) {
    clearTimeout(state.timers[k]);
    clearInterval(state.timers[k]);
    state.timers[k] = null;
  }
}

function backoff(base, failures) {
  if (!failures) return base;
  return Math.min(Math.max(base, 3000) * 2 ** Math.min(failures, 6), 120000);
}

function scheduleView() {
  clearTimeout(state.timers.view);
  if (state.dead || document.hidden) return;
  const v = views[state.current];
  const base = v && v.interval ? v.interval() : 0;
  if (!base || !Number.isFinite(base)) return;
  state.timers.view = setTimeout(runView, backoff(base, state.failures.view));
}

async function runView(force = false) {
  if (state.dead || (document.hidden && !force)) return;
  const v = views[state.current];
  if (v && state.inflight.view && force) {
    // A filter change, a tab switch or a mutation while a poll is in flight: run again as soon as it ends, with the
    // view's current parameters (otherwise the older answer would stay on screen until the next poll).
    state.rerunView = true;
    return;
  }
  if (!v || state.inflight.view) {
    scheduleView();
    return;
  }
  state.inflight.view = true;
  try {
    await v.refresh();
    state.failures.view = 0;
    if (state.pendingSubject && state.pendingSubject.view === state.current) {
      const s = state.pendingSubject;
      state.pendingSubject = null;
      if (v.focusSubject) v.focusSubject(s.subject);
    }
  } catch (e) {
    if (e?.kind !== 'auth') state.failures.view += 1;
  } finally {
    state.inflight.view = false;
    if (state.rerunView) {
      state.rerunView = false;
      runView(true);
    } else {
      scheduleView();
    }
  }
}

function scheduleStatus() {
  clearTimeout(state.timers.status);
  if (state.dead || document.hidden) return;
  const base = state.current === 'visao' ? 0 : 10000;
  if (!base) return;
  state.timers.status = setTimeout(runStatus, backoff(base, state.failures.status));
}

async function runStatus(force = false) {
  if (state.dead || (document.hidden && !force)) return;
  try {
    await refreshOverview();
    state.failures.status = 0;
  } catch (e) {
    if (e?.kind !== 'auth') state.failures.status += 1;
  } finally {
    scheduleStatus();
  }
}

function scheduleMeta() {
  clearTimeout(state.timers.meta);
  if (state.dead || document.hidden) return;
  const running = (store.meta?.indexing || store.overview?.indexing)?.state === 'running';
  state.timers.meta = setTimeout(runMeta, backoff(running ? 5000 : 60000, state.failures.meta));
}

async function runMeta(force = false) {
  if (state.dead || (document.hidden && !force)) return;
  try {
    await refreshMeta();
    state.failures.meta = 0;
  } catch (e) {
    if (e?.kind !== 'auth') state.failures.meta += 1;
  } finally {
    scheduleMeta();
  }
}

function startTicker() {
  clearInterval(state.timers.tick);
  state.timers.tick = setInterval(() => {
    if (!document.hidden && !state.dead) renderFacts();
  }, 5000);
}

/** Refresh now: the active view and the status line (button Atualizar, key r, after mutations). */
function refreshNow() {
  if (state.dead) return;
  state.failures.view = 0;
  state.failures.status = 0;
  clearTimeout(state.timers.view);
  runView(true);
  if (state.current !== 'visao') {
    clearTimeout(state.timers.status);
    runStatus(true);
  }
}

// ---------------------------------------------------------------- routing (6.2)

function parseHash() {
  const m = /^#\/([a-z]+)(?:\?(.*))?$/.exec(location.hash || '');
  const id = m && VIEWS.some((v) => v.id === m[1]) ? m[1] : 'visao';
  return { id, params: new URLSearchParams(m && m[2] ? m[2] : '') };
}

function hashOf(id, params) {
  const s = params && params.toString();
  return `#/${id}${s ? `?${s}` : ''}`;
}

function navigate(id, params, subject) {
  if (subject) state.pendingSubject = { view: id, subject };
  const target = hashOf(id, params instanceof URLSearchParams ? params : new URLSearchParams(params || {}));
  if (location.hash === target) route();
  else location.hash = target;
}

function setActiveTab(id) {
  for (const tab of $('tabs').querySelectorAll('[role="tab"]')) {
    const on = tab.dataset.view === id;
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
    tab.tabIndex = on ? 0 : -1;
    if (on) requestAnimationFrame(ensureTabVisible);
  }
}

/** Keeps the active tab visible in the sideways-scrolling tab row (phone width); counts change tab widths. */
function ensureTabVisible() {
  const row = $('tabs');
  const tab = row.querySelector('[aria-selected="true"]');
  if (!tab || row.scrollWidth <= row.clientWidth) return;
  const left = tab.offsetLeft - row.offsetLeft;
  if (left < row.scrollLeft || left + tab.offsetWidth > row.scrollLeft + row.clientWidth) {
    row.scrollLeft = Math.max(0, left - 16);
  }
}

function route() {
  if (state.dead) return;
  if (dialogs && dialogs.isSecretOpen()) {
    // The one-time secret panel is open: the browser's back/forward does nothing (6.11).
    history.replaceState(null, '', `${location.pathname}${location.search}${state.hash}`);
    return;
  }
  const { id, params } = parseHash();
  const prev = state.current;
  state.hash = hashOf(id, params);
  state.params = params;
  if (prev !== id) {
    if (prev && views[prev] && views[prev].hide) views[prev].hide();
    for (const v of VIEWS) views[v.id].section.hidden = v.id !== id;
    state.current = id;
    setActiveTab(id);
    if (prev) window.scrollTo(0, 0);
  }
  state.failures.view = 0;
  if (views[id].show) views[id].show(params);
  clearTimeout(state.timers.view);
  runView(true);
  scheduleStatus();
}

// ---------------------------------------------------------------- keyboard (6.2, 6.8)

function inField(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || el.isContentEditable;
}

function onKey(e) {
  if (state.dead || e.ctrlKey || e.metaKey || e.altKey) return;
  if ($('dlg').open || inField(e.target)) return;
  if (e.key >= '1' && e.key <= '8') {
    const v = VIEWS[Number(e.key) - 1];
    if (v) {
      e.preventDefault();
      navigate(v.id);
      $(`tab-${v.id}`).focus();
    }
  } else if (e.key === '/') {
    const v = views[state.current];
    if (v && v.focusFilter && v.focusFilter()) e.preventDefault();
  } else if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    refreshNow();
  } else if (e.key === '?') {
    e.preventDefault();
    dialogs.shortcuts(document.activeElement);
  }
}

function onTabsKey(e) {
  const tabs = [...$('tabs').querySelectorAll('[role="tab"]')];
  const i = tabs.indexOf(document.activeElement);
  if (i < 0) return;
  let j = null;
  if (e.key === 'ArrowDown' || e.key === 'ArrowRight') j = (i + 1) % tabs.length;
  else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
  else if (e.key === 'Home') j = 0;
  else if (e.key === 'End') j = tabs.length - 1;
  else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    navigate(tabs[i].dataset.view);
    return;
  }
  if (j != null) {
    e.preventDefault();
    for (const t of tabs) t.tabIndex = -1;
    tabs[j].tabIndex = 0;
    tabs[j].focus();
  }
}

// ---------------------------------------------------------------- boot

let dialogs = null;
const views = {};

const ctx = {
  api,
  store,
  clock,
  notify,
  navigate,
  refreshNow,
  refreshOverview,
  refreshMeta,
  get params() {
    return state.params;
  },
  get dialogs() {
    return dialogs;
  },
  /** After a license mutation: licenses, status line and history reload. */
  async afterMutation() {
    try {
      await Promise.allSettled([views.licencas.refresh(), refreshOverview()]);
      views.historico.invalidate?.();
    } catch {
      /* the next poll retries */
    }
  },
};

const VIEW_ICON = { visao: 'visao', licencas: 'licencas', uso: 'uso', qualidade: 'qualidade', agentes: 'agentes', vps: 'vps', eventos: 'eventos', historico: 'historico' };

/** Icons of the shell, from icons.js (nothing inline in the HTML). */
function paintShellIcons() {
  $('brand-mark').append(icon('brand', 18));
  for (const v of VIEWS) $(`tab-${v.id}`).querySelector('.ticon').append(icon(VIEW_ICON[v.id], 20));
  $('btn-keys').querySelector('.ticon').append(icon('keyboard', 20));
  $('btn-refresh').prepend(icon('refresh', 16));
}

function boot() {
  paintShellIcons();
  applyTheme(readTheme());
  try {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(themeOverride || readTheme()));
  } catch {
    /* old engines */
  }
  $('btn-theme').addEventListener('click', cycleTheme);
  $('btn-refresh').addEventListener('click', refreshNow);
  $('btn-logout').addEventListener('click', logout);

  // the key of the tunnel mode, when there is one; without it the first /api/meta decides (a session cookie in the
  // GitHub mode, or the "open through painel-ssam.ps1" card)
  initKey();

  on('network', showConnLost);
  on('ok', clearConnLost);
  on('auth', handleAuthError);

  dialogs = createDialogs(ctx);
  $('btn-keys').addEventListener('click', (e) => dialogs.shortcuts(e.currentTarget));
  const makers = {
    visao: createVisao, licencas: createLicencas, uso: createUso, qualidade: createQualidade, agentes: createAgentes, vps: createVps,
    eventos: createEventos, historico: createHistorico,
  };
  for (const v of VIEWS) {
    const section = $(`view-${v.id}`);
    // The view body is the container of the card grid's queries; toasts stay outside it (fixed to the window).
    const body = h('div', { class: 'vbody' });
    section.append(body);
    views[v.id] = makers[v.id](ctx, body);
    views[v.id].section = section;
  }

  for (const tab of $('tabs').querySelectorAll('[role="tab"]')) {
    tab.addEventListener('click', () => navigate(tab.dataset.view));
  }
  $('tabs').addEventListener('keydown', onTabsKey);
  document.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', route);
  window.addEventListener('resize', () => requestAnimationFrame(ensureTabVisible));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopTimers();
    } else if (!state.dead) {
      startTicker();
      runMeta();
      runView();
      if (state.current !== 'visao') runStatus();
    }
  });

  startTicker();
  runMeta(true);
  if (parseHash().id !== 'visao') runStatus(true);
  route();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
