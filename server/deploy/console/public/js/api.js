// Fetch wrapper of the owner console (DESIGN.md 4, 6.12): access key header, JSON, pt-BR errors, the clock of the
// server (every payload's `now`), and the mock switch. The request code is the same in mock and real mode; only the
// server behind it changes (`?mock=<scenario>` is forwarded as X-Mock-Scenario, which the real API ignores).

const KEY_STORE = 'ssam-console-key';
const KEY_HEADER = 'X-SSAM-Console-Key';
const MOCK_RE = /^[a-z][a-z0-9-]{0,31}$/;

let memoryKey = null;

export class ApiError extends Error {
  constructor(kind, status, code, message, field) {
    super(message);
    this.kind = kind; // network | auth | http
    this.status = status;
    this.code = code;
    this.field = field || null;
  }
}

/** Mock scenario from `?mock=` (null in production). */
export function mockScenario() {
  try {
    const v = new URLSearchParams(location.search).get('mock');
    if (v == null) return null;
    return MOCK_RE.test(v) ? v : 'normal';
  } catch {
    return null;
  }
}

function storeKey(k) {
  memoryKey = k;
  try {
    sessionStorage.setItem(KEY_STORE, k);
  } catch {
    /* storage blocked: the key lives in memory for this page only */
  }
}

/**
 * Reads `#k=<key>` once into sessionStorage and strips it from the address bar (and history) at once.
 * Returns the key or null.
 */
export function initKey() {
  const m = /(?:^#|[#&?])k=([A-Za-z0-9_-]{1,128})/.exec(location.hash);
  if (m) {
    storeKey(m[1]);
    try {
      history.replaceState(null, '', `${location.pathname}${location.search}#/visao`);
    } catch {
      location.hash = '#/visao';
    }
  }
  return getKey();
}

export function getKey() {
  if (memoryKey) return memoryKey;
  try {
    const k = sessionStorage.getItem(KEY_STORE);
    if (k) {
      memoryKey = k;
      return k;
    }
  } catch {
    /* ignore */
  }
  if (mockScenario()) return 'mock';
  return null;
}

/** Server clock: offset learned from every payload's `now`, so relative times match the VPS clock. */
export const clock = {
  offset: 0,
  learned: false,
  now() {
    return Date.now() + this.offset;
  },
  learn(iso) {
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) {
      this.offset = ms - Date.now();
      this.learned = true;
    }
  },
};

const listeners = { network: [], ok: [], auth: [] };
export function on(kind, fn) {
  listeners[kind].push(fn);
}
function emit(kind, arg) {
  for (const fn of listeners[kind]) {
    try {
      fn(arg);
    } catch {
      /* a listener never breaks a request */
    }
  }
}

async function request(method, path, body) {
  const headers = { Accept: 'application/json' };
  const key = getKey();
  if (key) headers[KEY_HEADER] = key;
  const mock = mockScenario();
  if (mock) headers['X-Mock-Scenario'] = mock;
  const init = { method, headers, cache: 'no-store', credentials: 'same-origin', redirect: 'error' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    const err = new ApiError('network', 0, 'NETWORK', 'sem conexão com o painel');
    emit('network', err);
    throw err;
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (res.status === 401) {
    const code = json?.error?.code || 'KEY_INVALID';
    const err = new ApiError('auth', 401, code, json?.error?.message || 'Chave de acesso inválida.');
    emit('auth', err);
    throw err;
  }
  if (!res.ok || !json || json.ok !== true) {
    const e = json?.error || {};
    const msg = e.message || `Erro interno do painel (HTTP ${res.status}).`;
    emit('ok');
    throw new ApiError('http', res.status, e.code || `HTTP_${res.status}`, msg, e.field);
  }
  if (typeof json.now === 'string') clock.learn(json.now);
  emit('ok');
  return json;
}

/** File name of a download: the server's Content-Disposition name, letters, digits, dot, dash and underscore only. */
export function downloadName(disposition, fallback = 'ssam-qualidade') {
  const m = /filename="([^"]{1,160})"/.exec(String(disposition || ''));
  const name = (m ? m[1] : fallback).replace(/[^A-Za-z0-9._-]/g, '_');
  return name || fallback;
}

/**
 * A file answer of the API (DESIGN-QUALIDADE 4.4, the Qualidade exports): fetch with the key header, then a Blob URL on an
 * <a download> clicked by script (no inline script; the CSP is unchanged). Errors as request() throws them.
 */
async function download(path) {
  const headers = { Accept: 'text/csv, application/json, application/x-ndjson' };
  const key = getKey();
  if (key) headers[KEY_HEADER] = key;
  const mock = mockScenario();
  if (mock) headers['X-Mock-Scenario'] = mock;
  let res;
  try {
    res = await fetch(path, { method: 'GET', headers, cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
  } catch {
    const err = new ApiError('network', 0, 'NETWORK', 'sem conexão com o painel');
    emit('network', err);
    throw err;
  }
  if (!res.ok) {
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    const e = json?.error || {};
    if (res.status === 401) {
      const err = new ApiError('auth', 401, e.code || 'KEY_INVALID', e.message || 'Chave de acesso inválida.');
      emit('auth', err);
      throw err;
    }
    emit('ok');
    throw new ApiError('http', res.status, e.code || `HTTP_${res.status}`, e.message || `Erro interno do painel (HTTP ${res.status}).`, e.field);
  }
  const blob = await res.blob();
  emit('ok');
  const name = downloadName(res.headers.get('Content-Disposition'));
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return name;
}

function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v != null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export const api = {
  meta: () => request('GET', '/api/meta'),
  overview: () => request('GET', '/api/overview'),
  licenses: () => request('GET', '/api/licenses'),
  usage: (p) => request('GET', `/api/usage${qs(p)}`),
  quality: (p) => request('GET', `/api/quality${qs(p)}`),
  /** Downloads one export of the Qualidade view (table and format in p); resolves with the file name. */
  qualityExport: (p) => download(`/api/quality/export${qs(p)}`),
  live: () => request('GET', '/api/live'),
  vps: () => request('GET', '/api/vps'),
  events: (p) => request('GET', `/api/events${qs(p)}`),
  history: (p) => request('GET', `/api/history${qs(p)}`),
  issue: (body) => request('POST', '/api/licenses', body),
  renew: (id, body) => request('POST', `/api/licenses/${encodeURIComponent(id)}/renew`, body),
  lanes: (id, body) => request('POST', `/api/licenses/${encodeURIComponent(id)}/lanes`, body),
  agentRotate: (id, body) => request('POST', `/api/licenses/${encodeURIComponent(id)}/agent-rotate`, body),
  revoke: (id, body) => request('POST', `/api/licenses/${encodeURIComponent(id)}/revoke`, body),
  ack: (body) => request('POST', '/api/alerts/ack', body),
  unack: (body) => request('POST', '/api/alerts/unack', body),
};

/** Shared caches the views read (overview for the status line and alert links, licenses for selects, meta). */
export const store = {
  meta: null,
  overview: null,
  overviewAt: 0,
  licenses: null,
  licensesAt: 0,
  live: null,
};
