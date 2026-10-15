// Network of a captured page (docs/PROTOTIPO-NATIVO.md 2.1): files of the source folder only, everything else blocked.
// jsdom gets requestInterceptor(<source files>) in front of a dispatcher that rejects; fetch and XMLHttpRequest of the
// window are replaced (synchronous XHR ignores interceptors); WebSocket, EventSource and sendBeacon throw.
import fs from 'node:fs';
import path from 'node:path';

export const ORIGIN = 'http://prototype.ssam';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.cjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.xml': 'application/xml', '.csv': 'text/csv'
};

export function mimeOf(file) {
  return MIME[path.extname(String(file)).toLowerCase()] ?? 'application/octet-stream';
}

// A same-origin URL of the page maps to a relative path inside source; anything else is foreign.
export function localPath(url, base = ORIGIN + '/') {
  let parsed;
  try { parsed = new URL(url, base); } catch { return null; }
  if (parsed.origin !== ORIGIN) return null;
  const relative = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
  const normal = path.posix.normalize(relative);
  if (!normal || normal === '.' || normal.startsWith('..')) return null;
  return normal;
}

// Reads files of source on demand and records what was read (the IR lists the files the capture read).
export class SourceFiles {
  // aliases: a file served in place of another (mapping.version: the entry's app script -> the version chosen)
  constructor(root, { preload = {}, aliases = {} } = {}) {
    this.root = path.resolve(root);
    this.aliases = aliases ?? {};
    this.cache = new Map(Object.entries(preload).map(([key, value]) => [key, Buffer.isBuffer(value) ? value : Buffer.from(value)]));
    this.read = new Set();
  }
  bytes(relative) {
    const normal = path.posix.normalize(String(relative).replace(/\\/g, '/'));
    if (normal.startsWith('..') || path.isAbsolute(normal)) return null;
    const alias = this.aliases[normal];
    if (typeof alias === 'string' && alias !== normal) return this.bytes(alias);
    if (this.cache.has(normal)) { this.read.add(normal); return this.cache.get(normal); }
    const full = path.resolve(this.root, normal);
    if (!full.startsWith(this.root + path.sep)) return null;
    let data;
    try { if (!fs.statSync(full).isFile()) return null; data = fs.readFileSync(full); } catch { return null; }
    this.cache.set(normal, data);
    this.read.add(normal);
    return data;
  }
  text(relative) { const data = this.bytes(relative); return data == null ? null : data.toString('utf8'); }
}

// Base dispatcher that rejects every request: nothing ever reaches the global undici dispatcher (the network).
export class RejectingDispatcher {
  constructor(onReject = () => {}) { this.onReject = onReject; this.rejected = []; }
  dispatch(options, handler) {
    const url = options?.opaque?.url ?? ((options?.origin ?? '') + (options?.path ?? ''));
    this.rejected.push(String(url));
    this.onReject(String(url));
    const controller = { abort() {}, pause() {}, resume() {}, aborted: false, paused: false, reason: null };
    queueMicrotask(() => {
      try { handler.onRequestStart?.(controller, {}); } catch { /* the handler may already be gone */ }
      try { handler.onResponseError?.(controller, new Error('PrototypeNetworkBlocked ' + url)); } catch { /* idem */ }
    });
    return true;
  }
  close() { return Promise.resolve(); }
  destroy() { return Promise.resolve(); }
  get closed() { return false; }
  get destroyed() { return false; }
}

// jsdom subresource interceptor: answers files of source; returns undefined (-> rejecting dispatcher) otherwise.
export function sourceInterceptor(requestInterceptor, files) {
  return requestInterceptor(async request => {
    const relative = localPath(request.url);
    if (relative == null) return undefined;
    const data = files.bytes(relative);
    if (data == null) return new Response('', { status: 404, statusText: 'Not Found' });
    return new Response(data, { status: 200, headers: { 'Content-Type': mimeOf(relative) } });
  });
}

function blocked(log, kind, url) {
  log.warn({ code: 'PrototypeNetworkBlocked', kind, url: String(url) });
}

// fetch / XMLHttpRequest / WebSocket / EventSource / sendBeacon of the window.
export function installNetwork(window, { files, log, onJson }) {
  const base = () => window.location.href;
  const respond = (url) => {
    const relative = localPath(url, base());
    if (relative == null) return null;
    const data = files.bytes(relative);
    if (data == null) return { status: 404, data: Buffer.alloc(0), mime: 'text/plain', relative };
    return { status: 200, data, mime: mimeOf(relative), relative };
  };
  const seenJson = (relative, data, mime) => {
    if (!/json/.test(mime)) return;
    try { onJson?.(relative, JSON.parse(data.toString('utf8'))); } catch { /* not JSON */ }
  };
  window.fetch = function fetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    const method = String(init.method ?? input?.method ?? 'GET').toUpperCase();
    let resolved;
    try { resolved = new URL(url, base()).href; } catch { return Promise.reject(new window.TypeError('Failed to fetch')); }
    if (resolved.startsWith('data:')) return globalThis.fetch(resolved);
    const answer = method === 'GET' || method === 'HEAD' ? respond(resolved) : null;
    if (!answer) { blocked(log, 'fetch', resolved); return Promise.reject(new window.TypeError('Failed to fetch')); }
    log.network({ kind: 'fetch', url: answer.relative, status: answer.status });
    if (answer.status === 200) seenJson(answer.relative, answer.data, answer.mime);
    const response = new Response(method === 'HEAD' ? null : answer.data, { status: answer.status, headers: { 'Content-Type': answer.mime } });
    Object.defineProperty(response, 'url', { value: resolved });
    return Promise.resolve(response);
  };
  for (const name of ['Response', 'Headers', 'Request']) if (!window[name]) window[name] = globalThis[name];
  const EventTargetBase = window.EventTarget;
  class XMLHttpRequest extends EventTargetBase {
    constructor() {
      super();
      this.readyState = 0; this.status = 0; this.statusText = ''; this.responseText = ''; this.response = '';
      this.responseType = ''; this.responseURL = ''; this.timeout = 0; this.withCredentials = false;
      this.onload = this.onerror = this.onreadystatechange = this.onloadend = this.onabort = this.ontimeout = this.onloadstart = this.onprogress = null;
      this._headers = {};
    }
    open(method, url, async = true) { this._method = String(method).toUpperCase(); this._url = url; this._async = async !== false; this._set(1); }
    setRequestHeader() {}
    getResponseHeader(name) { return String(name).toLowerCase() === 'content-type' ? this._mime ?? null : null; }
    getAllResponseHeaders() { return this._mime ? 'content-type: ' + this._mime + '\r\n' : ''; }
    overrideMimeType() {}
    abort() {}
    _set(state) { this.readyState = state; this._fire('readystatechange'); }
    _fire(type) {
      const event = new window.Event(type);
      const handler = this['on' + type];
      if (typeof handler === 'function') handler.call(this, event);
      this.dispatchEvent(event);
    }
    send() {
      let resolved;
      try { resolved = new URL(this._url, base()).href; } catch { resolved = String(this._url); }
      const answer = this._method === 'GET' || this._method === 'HEAD' ? respond(resolved) : null;
      const finish = () => {
        if (!answer) { blocked(log, 'xhr', resolved); this.status = 0; this._set(4); this._fire('error'); this._fire('loadend'); return; }
        log.network({ kind: 'xhr', url: answer.relative, status: answer.status });
        this.status = answer.status; this.statusText = answer.status === 200 ? 'OK' : 'Not Found'; this.responseURL = resolved; this._mime = answer.mime;
        const text = answer.data.toString('utf8');
        this.responseText = text;
        if (answer.status === 200) seenJson(answer.relative, answer.data, answer.mime);
        if (this.responseType === 'json') { try { this.response = JSON.parse(text); } catch { this.response = null; } }
        else this.response = text;
        this._set(2); this._set(3); this._set(4); this._fire('load'); this._fire('loadend');
      };
      if (this._async) queueMicrotask(finish); else finish();
    }
  }
  window.XMLHttpRequest = XMLHttpRequest;
  const throwing = name => function () { log.warn({ code: 'PrototypeNetworkBlocked', kind: name }); throw new window.Error(name + ' is not available in the prototype capture'); };
  window.WebSocket = throwing('WebSocket');
  window.EventSource = throwing('EventSource');
  if (window.navigator) {
    try { Object.defineProperty(window.navigator, 'sendBeacon', { configurable: true, value: throwing('sendBeacon') }); } catch { /* read-only navigator */ }
  }
}
