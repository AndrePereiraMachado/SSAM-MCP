// Boot of the owner console (DESIGN.md 6.2, 6.3, 6.8, 6.9): key from #k=, hash routes, status line, tabs,
// polling per view (paused while the document is hidden, backoff on errors), theme, keyboard shortcuts, notices.

import { api, initKey, getKey, on, clock, store } from './api.js';
import { VIEWS, SERVER_WORD, WARM_WORD } from './labels.js';
import * as F from './format.js';
import { h, clear, dot, joinDots, textButton } from './dom.js';
import { createDialogs } from './dialogs.js';
import createVisao from './views/visao.js';
import createLicencas from './views/licencas.js';
import createUso from './views/uso.js';
import createAgentes from './views/agentes.js';
import createVps from './views/vps.js';
import createEventos from './views/eventos.js';
import createHistorico from './views/historico.js';

const $ = (id) => document.getElementById(id);
const THEME_KEY = 'ssam-console-theme';
const THEMES = [
  { id: 'auto', label: 'automático' },
  { id: 'light', label: 'claro' },
  { id: 'dark', label: 'escuro' },
];

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
};

// ---------------------------------------------------------------- theme

function readTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return THEMES.some((t) => t.id === v) ? v : 'auto';
  } catch {
    return 'auto';
  }
}

function applyTheme(id) {
  const root = document.documentElement;
  if (id === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', id);
  const t = THEMES.find((x) => x.id === id) || THEMES[0];
  $('btn-theme').textContent = `Tema: ${t.label}`;
}

function cycleTheme() {
  const cur = readTheme();
  const idx = THEMES.findIndex((t) => t.id === cur);
  const next = THEMES[(idx + 1) % THEMES.length].id;
  try {
    if (next === 'auto') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, next);
  } catch {
    /* storage blocked: the theme holds for this page only */
  }
  applyTheme(next);
  themeOverride = next;
}
let themeOverride = null;

// ---------------------------------------------------------------- notices (6.9)

const noticeTimers = new WeakMap();

function noticeFor(section) {
  let p = section.querySelector(':scope > .notice');
  if (!p) {
    p = h('p', { class: 'notice', role: 'status', tabindex: '-1', hidden: true });
    section.prepend(p);
  }
  return p;
}

/** One text line at the top of the active view: dot + sentence + Fechar. Errors stay; others hide after 15 s. */
function notify(text, level = 'ok', { focus = true } = {}) {
  const view = state.current ? views[state.current] : null;
  const section = view ? view.section : $('view-visao');
  const p = noticeFor(section);
  clear(p);
  const close = textButton('Fechar', () => {
    p.hidden = true;
  });
  p.append(dot(level), h('span', { class: 'ntext' }, text), ' ', close);
  p.classList.toggle('is-error', level === 'bad');
  p.hidden = false;
  clearTimeout(noticeTimers.get(p));
  if (level !== 'bad') noticeTimers.set(p, setTimeout(() => { p.hidden = true; }, 15000));
  if (focus) p.focus({ preventScroll: false });
}

// ---------------------------------------------------------------- status line (6.3)

function alertsText(a) {
  if (!a) return null;
  const n = (a.critical || 0) + (a.warning || 0) + (a.info || 0);
  if (!n) return 'sem alertas';
  const base = F.plural(n, 'alerta', 'alertas');
  if (!a.critical) return base;
  return `${base} (${F.plural(a.critical, 'crítico', 'críticos')})`;
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
  let serverTxt = `Servidor ${sw.word}`;
  if (srv.state === 'up' && srv.since) serverTxt += ` há ${F.fmtDuration(now - F.toMs(srv.since))}`;
  const items = [h('span', { class: 'st' }, dot(sw.level), serverTxt)];
  if (srv.imageTag) items.push(h('span', { class: 'mono' }, srv.imageTag));
  items.push(WARM_WORD[srv.warm] || WARM_WORD.unknown);
  items.push(F.plural(st.sessionsOpen ?? 0, 'sessão', 'sessões'));
  items.push(F.plural(st.agentsConnected ?? 0, 'agente', 'agentes'));
  const act = st.licenses?.active ?? 0;
  items.push(act === 1 ? '1 licença ativa' : `${F.fmtInt(act)} licenças ativas`);
  const at = alertsText(st.alerts);
  if (at) items.push(st.alerts?.critical ? h('span', { class: 'lv-bad' }, at) : at);
  const col = st.collector || {};
  if (col.state === 'fresh' && col.collectedAt) {
    const rel = F.fmtRelative(col.collectedAt, now);
    items.push(h('span', { title: F.fmtTitle(col.collectedAt) }, rel === 'agora' ? 'coletado agora' : `coletado ${rel}`));
  } else if (col.state === 'stale') {
    items.push(h('span', { class: 'lv-warn', title: col.collectedAt ? F.fmtTitle(col.collectedAt) : '' }, 'coletor parado'));
  } else if (col.state === 'missing') {
    items.push(h('span', { class: 'lv-bad' }, 'coletor ausente'));
  } else if (col.state === 'invalid') {
    items.push(h('span', { class: 'lv-warn' }, 'coletor em formato desconhecido'));
  }
  if (state.lastOverviewOkAt) items.push(`atualizado às ${F.fmtTimeSec(state.lastOverviewOkAt)}`);
  const idx = store.meta?.indexing || ov.indexing;
  if (idx && idx.state === 'running') {
    items.push(`indexando histórico: ${Math.round((idx.progress || 0) * 100)}%`);
  }
  clear(facts);
  facts.append(...joinDots(items));
}

function renderTabCounts() {
  const st = store.overview?.status;
  const set = (id, text, critical) => {
    const tab = $(`tab-${id}`);
    const c = tab.querySelector('.tcount');
    c.textContent = text ? ` (${text})` : '';
    let d = tab.querySelector('.dot');
    if (critical && !d) {
      d = dot('bad');
      tab.prepend(d);
      tab.append(h('span', { class: 'sr-only' }, ', com alerta crítico'));
    } else if (!critical && d) {
      d.remove();
      tab.querySelector('.sr-only')?.remove();
    }
  };
  if (!st) return;
  const a = st.alerts || {};
  const unacked = (a.critical || 0) + (a.warning || 0) + (a.info || 0);
  set('visao', unacked ? String(unacked) : '', (a.critical || 0) > 0);
  set('licencas', String(st.licenses?.active ?? 0), false);
  set('agentes', `${st.agentsConnected ?? 0}/${st.sessionsOpen ?? 0}`, false);
  const widths = $('tabs').textContent;
  if (widths !== lastTabText) {
    lastTabText = widths;
    ensureTabVisible();
  }
}
let lastTabText = '';

function showConnLost() {
  if (!state.connLostAt) state.connLostAt = clock.now();
  const conn = $('conn');
  clear(conn);
  conn.append(dot('bad'), `Sem conexão com o painel desde ${F.fmtTimeSec(state.connLostAt)}. O túnel SSH caiu? Rode painel-ssam.ps1 de novo.`);
  conn.hidden = false;
  $('facts').hidden = true;
}

function clearConnLost() {
  if (!state.connLostAt) return;
  state.connLostAt = null;
  $('conn').hidden = true;
  $('facts').hidden = false;
}

function showFatal(text) {
  state.dead = true;
  stopTimers();
  $('top').hidden = true;
  $('main').hidden = true;
  const dlg = $('dlg');
  if (dlg.open) dlg.close();
  const f = $('fatal');
  clear(f);
  f.append(h('p', null, text));
  f.hidden = false;
}

function showNoKey() {
  state.dead = true;
  const conn = $('conn');
  clear(conn);
  conn.append(dot('warn'), 'Abra o painel pelo painel-ssam.ps1: ele cria o túnel e a chave desta sessão.');
  conn.hidden = false;
  $('facts').hidden = true;
  $('hbtns').hidden = true;
  $('tabs').hidden = true;
  $('main').hidden = true;
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
    scheduleView();
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
  if (e.key >= '1' && e.key <= '7') {
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
  if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
  else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
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

function boot() {
  applyTheme(readTheme());
  try {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(themeOverride || readTheme()));
  } catch {
    /* old engines */
  }
  $('btn-theme').addEventListener('click', cycleTheme);
  $('btn-refresh').addEventListener('click', refreshNow);

  const key = initKey();
  if (!key) {
    showNoKey();
    return;
  }

  on('network', showConnLost);
  on('ok', clearConnLost);
  on('auth', () => showFatal('Chave de acesso inválida ou trocada (o painel reiniciou ou outra sessão abriu). Feche esta aba e rode painel-ssam.ps1.'));

  dialogs = createDialogs(ctx);
  const makers = {
    visao: createVisao, licencas: createLicencas, uso: createUso, agentes: createAgentes, vps: createVps,
    eventos: createEventos, historico: createHistorico,
  };
  for (const v of VIEWS) {
    const section = $(`view-${v.id}`);
    views[v.id] = makers[v.id](ctx, section);
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

  if (!getKey()) {
    showNoKey();
    return;
  }
  startTicker();
  runMeta(true);
  if (parseHash().id !== 'visao') runStatus(true);
  route();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
