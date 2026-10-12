// One captured window (docs/PROTOTIPO-NATIVO.md 2.1): jsdom 30.1.1 with runScripts "outside-only" and
// pretendToBeVisual, a fixed clock, a seeded random, fake timers and requestAnimationFrame, the polyfills of the
// contract, the listener registry (addEventListener, on<type> setters, inline attributes, React/Vue/Preact hooks) and
// the storage recorder. Scripts are run by SSAM in document order; the lifecycle events are SSAM's, never jsdom's.
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { ORIGIN, RejectingDispatcher, sourceInterceptor, installNetwork, localPath } from './network.mjs';
import { planScripts, runModules, siteOf, describeError, RenderFailure } from './scripts.mjs';
import { isRemote } from './vendor.mjs';

const require = createRequire(import.meta.url);
const { JSDOM, VirtualConsole, requestInterceptor } = require('jsdom');

export const JSDOM_VERSION = require('jsdom/package.json').version;

const EVENT_TYPES = ['click', 'dblclick', 'input', 'change', 'submit', 'reset', 'keydown', 'keyup', 'keypress', 'focus', 'blur', 'focusin', 'focusout', 'mousedown', 'mouseup', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave', 'pointerdown', 'pointerup', 'toggle', 'load', 'error', 'scroll', 'wheel', 'touchstart', 'touchend'];
const SKIP_TAGS = new Set(['script', 'noscript', 'template', 'style', 'link', 'meta', 'base', 'title']);
const LUCIDE_DEFAULTS = new Set(['xmlns', 'width', 'height', 'viewbox', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'data-lucide']);

// An svg that paints only with currentColor (or none): no other color, gradient, pattern, image, reference or inline style.
const PAINTS = new Set(['', 'none', 'currentcolor', 'transparent']);
function monochrome(svg) {
  for (const node of [svg, ...svg.querySelectorAll('*')]) {
    const tag = node.localName.toLowerCase();
    if (['image', 'use', 'lineargradient', 'radialgradient', 'pattern', 'foreignobject', 'style', 'script', 'mask', 'filter'].includes(tag)) return false;
    if (node.hasAttribute('style')) return false;
    for (const attribute of ['fill', 'stroke', 'color', 'stop-color']) if (node.hasAttribute(attribute) && !PAINTS.has(node.getAttribute(attribute).trim().toLowerCase())) return false;
  }
  return svg.children.length > 0;
}

function fnv(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(16).padStart(8, '0');
}
const MAX_TIMER = 1000, MAX_FRAMES = 60, FRAME = 16;
const HANDLER_PROPERTIES = [...EVENT_TYPES, 'hashchange', 'popstate', 'close', 'cancel', 'contextmenu', 'dragstart', 'drop', 'animationend', 'transitionend', 'beforeinput', 'search', 'select', 'invalid'].map(type => 'on' + type);

// Stack capture of the registry and the timers: a short stack is enough to reach the prototype frame.
function shortStack() {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 24;
  const stack = new Error().stack;
  Error.stackTraceLimit = limit;
  return stack;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Log {
  constructor() { this.warnings = []; this.network = []; this.storage = []; this.errors = []; this.problems = []; this.seen = new Set(); }
  warn(warning) {
    const key = JSON.stringify(warning);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.warnings.push(warning);
  }
}

function makeStorage(kind, initial, log) {
  const items = new Map(Object.entries(initial ?? {}).map(([key, value]) => [String(key), String(value)]));
  const api = {
    get length() { return items.size; },
    key(index) { return [...items.keys()][index] ?? null; },
    getItem(key) { return items.has(String(key)) ? items.get(String(key)) : null; },
    setItem(key, value) { items.set(String(key), String(value)); log.storage.push({ kind, op: 'set', key: String(key), value: String(value) }); },
    removeItem(key) { items.delete(String(key)); log.storage.push({ kind, op: 'remove', key: String(key) }); },
    clear() { items.clear(); log.storage.push({ kind, op: 'clear' }); }
  };
  const dump = () => Object.fromEntries([...items.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  const proxy = new Proxy(api, {
    get(target, key) {
      if (key === '__dump') return dump;
      if (key in target) return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
      return typeof key === 'string' && items.has(key) ? items.get(key) : undefined;
    },
    set(target, key, value) { if (key in target) return false; api.setItem(key, value); return true; },
    deleteProperty(target, key) { api.removeItem(key); return true; },
    ownKeys() { return [...items.keys()]; },
    getOwnPropertyDescriptor(target, key) { return items.has(key) ? { configurable: true, enumerable: true, value: items.get(key), writable: true } : undefined; }
  });
  return proxy;
}

// Specificity (a, b, c) of one complex selector; enough for the cascade of stroke-width (2.9).
export function specificity(selector) {
  let a = 0, b = 0, c = 0;
  let text = String(selector);
  text = text.replace(/:where\((?:[^()]|\([^()]*\))*\)/g, '');
  const inner = [];
  text = text.replace(/:(is|not|has)\(((?:[^()]|\([^()]*\))*)\)/g, (match, name, args) => {
    const best = args.split(',').map(part => specificity(part.trim())).sort((x, y) => (y[0] - x[0]) || (y[1] - x[1]) || (y[2] - x[2]))[0] ?? [0, 0, 0];
    inner.push(best);
    return '';
  });
  for (const [x, y, z] of inner) { a += x; b += y; c += z; }
  text = text.replace(/\[[^\]]*\]/g, () => { b++; return ''; });
  text = text.replace(/#[\w-]+/g, () => { a++; return ''; });
  text = text.replace(/\.[\w-]+/g, () => { b++; return ''; });
  text = text.replace(/::[\w-]+(\([^)]*\))?/g, () => { c++; return ''; });
  text = text.replace(/:[\w-]+(\([^)]*\))?/g, () => { b++; return ''; });
  for (const part of text.split(/[\s>+~]+/)) if (/^[a-zA-Z][\w-]*$/.test(part)) c++;
  return [a, b, c];
}

function compareSpec(x, y) { return (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2]); }

export class Page {
  constructor(options) {
    this.options = options;
    this.log = new Log();
    this.now = 0;
    this.timers = [];
    this.frames = [];
    this.timerId = 0;
    this.registry = new Map();
    this.globals = [];
    this.returned = [];
    this.jsonFetched = [];
    this.handledScripts = new WeakSet();
    this.lifecycle = false;
    this.readyState = 'loading';
    this.iconSvg = new Map();
    this.styleSeen = new Map();
    this.pendingStyles = [];
  }

  // ---- registry ----------------------------------------------------------------------------------------------------
  record(target, type, kind, site) {
    if (!this.registry.has(target)) this.registry.set(target, []);
    this.registry.get(target).push({ type: String(type).toLowerCase(), kind, site });
  }

  listenerTypes(target) {
    const types = new Set((this.registry.get(target) ?? []).map(entry => entry.type));
    if (target?.attributes) {
      for (const attribute of target.attributes) if (/^on[a-z]+$/.test(attribute.name)) types.add(attribute.name.slice(2));
      for (const key of Object.keys(target)) {
        if (key.startsWith('__reactProps$')) {
          for (const prop of Object.keys(target[key] ?? {})) {
            const match = prop.match(/^on([A-Z][a-zA-Z]*?)(Capture)?$/);
            if (!match || typeof target[key][prop] !== 'function') continue;
            const type = match[1].toLowerCase();
            types.add(type === 'doubleclick' ? 'dblclick' : type);
            if (type === 'change') types.add('input');
          }
        }
        if (key === '_vei') for (const prop of Object.keys(target._vei ?? {})) if (target._vei[prop]) types.add(prop.replace(/^on/, '').toLowerCase());
        if (key === 'l' && target.l && typeof target.l === 'object') for (const prop of Object.keys(target.l)) types.add(prop.replace(/(true|false)$/, '').toLowerCase());
      }
    }
    return [...types].sort();
  }

  globalListeners() {
    const out = [];
    for (const [target, entries] of this.registry) {
      const where = target === this.window ? 'window' : target === this.document ? 'document' : null;
      if (!where) continue;
      for (const entry of entries) out.push({ target: where, type: entry.type, kind: entry.kind, handler: entry.site });
    }
    return out;
  }

  ownListeners(element) {
    return (this.registry.get(element) ?? []).map(entry => ({ type: entry.type, kind: entry.kind, handler: entry.site }));
  }

  // ---- polyfills ---------------------------------------------------------------------------------------------------
  install(window) {
    const page = this;
    const clock = this.options.clock;
    this.window = window;
    vm.runInContext(`(function(clock){
      const D = globalThis.Date;
      const FakeDate = function Date(...args) {
        if (!new.target) return new D(clock).toString();
        return args.length === 0 ? new D(clock) : new D(...args);
      };
      Object.setPrototypeOf(FakeDate, D);
      FakeDate.prototype = D.prototype;
      FakeDate.now = () => clock;
      FakeDate.parse = D.parse; FakeDate.UTC = D.UTC;
      Object.defineProperty(D.prototype, 'constructor', { value: FakeDate, configurable: true, writable: true });
      globalThis.Date = FakeDate;
    })`, window)(clock);
    const random = mulberry32(this.options.seed ?? 1);
    window.Math.random = random;
    const cryptoObject = window.crypto ?? {};
    const fill = array => { for (let i = 0; i < array.length; i++) array[i] = Math.floor(random() * 256); return array; };
    try {
      Object.defineProperty(window, 'crypto', { configurable: true, value: {
        getRandomValues(array) { const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength); fill(bytes); return array; },
        randomUUID() { const b = fill(new Uint8Array(16)); b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80; const h = [...b].map(x => x.toString(16).padStart(2, '0')).join(''); return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20); },
        subtle: cryptoObject.subtle
      } });
    } catch { /* keep jsdom crypto */ }
    const performanceObject = window.performance;
    try { Object.defineProperty(performanceObject, 'now', { configurable: true, value: () => page.now }); } catch { /* read-only */ }
    // Timers: <= 1000 ms run in order when draining; longer delays and intervals never run (warnings with file:line).
    window.setTimeout = function setTimeout(handler, delay = 0, ...args) {
      const id = ++page.timerId;
      const wait = Math.max(0, Number(delay) || 0);
      if (typeof handler !== 'function') { page.log.warn({ code: 'PrototypeTimerString', where: siteText(siteOf(shortStack())) }); return id; }
      if (wait > MAX_TIMER) { page.log.warn({ code: 'PrototypeTimerSkipped', delay: wait, where: siteText(siteOf(shortStack())) }); return id; }
      page.timers.push({ id, at: page.now + wait, handler, args });
      return id;
    };
    window.clearTimeout = function clearTimeout(id) { page.timers = page.timers.filter(timer => timer.id !== id); };
    window.setInterval = function setInterval(handler, delay = 0) {
      page.log.warn({ code: 'PrototypeIntervalSkipped', delay: Number(delay) || 0, where: siteText(siteOf(shortStack())) });
      return ++page.timerId;
    };
    window.clearInterval = function clearInterval() {};
    window.setImmediate = undefined;
    window.requestAnimationFrame = function requestAnimationFrame(callback) { const id = ++page.timerId; page.frames.push({ id, callback }); return id; };
    window.cancelAnimationFrame = function cancelAnimationFrame(id) { page.frames = page.frames.filter(frame => frame.id !== id); };
    window.requestIdleCallback = function requestIdleCallback(callback) { return window.setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 50 }), 1); };
    window.cancelIdleCallback = window.clearTimeout;
    // Storage with a record of every write.
    const local = makeStorage('local', this.options.storage?.local, this.log);
    const session = makeStorage('session', this.options.storage?.session, this.log);
    Object.defineProperty(window, 'localStorage', { configurable: true, get: () => local });
    Object.defineProperty(window, 'sessionStorage', { configurable: true, get: () => session });
    this.local = local;
    // Dialog, scrolling, media, observers, innerText, CSS.escape, dialogs of the browser.
    const Dialog = window.HTMLDialogElement?.prototype;
    if (Dialog) {
      Dialog.showModal = function showModal() { this.setAttribute('open', ''); this.__ssamModal = true; };
      Dialog.show = function show() { this.setAttribute('open', ''); this.__ssamModal = false; };
      Dialog.close = function close(value) {
        if (!this.hasAttribute('open')) return;
        if (value !== undefined) this.returnValue = String(value);
        this.removeAttribute('open');
        this.dispatchEvent(new window.Event('close'));
      };
    }
    window.scrollTo = window.scroll = window.scrollBy = function () {};
    window.Element.prototype.scrollIntoView = function () {};
    window.Element.prototype.scrollTo = window.Element.prototype.scrollBy = function () {};
    window.matchMedia = function matchMedia(media) {
      return { matches: false, media: String(media), onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } };
    };
    class InertObserver { constructor() {} observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } }
    window.IntersectionObserver = InertObserver;
    window.ResizeObserver = InertObserver;
    Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
      configurable: true,
      get() {
        let text = '';
        const walk = node => {
          for (const child of node.childNodes) {
            if (child.nodeType === 3) text += child.data;
            else if (child.nodeType === 1) { if (child.localName === 'br') text += '\n'; else if (!['script', 'style'].includes(child.localName)) walk(child); }
          }
        };
        walk(this);
        return text;
      },
      set(value) { this.textContent = String(value); }
    });
    window.CSS = window.CSS ?? {};
    window.CSS.escape = value => String(value).replace(/[^a-zA-Z0-9_ -￿-]/g, char => '\\' + char);
    window.CSS.supports = window.CSS.supports ?? (() => false);
    window.alert = message => page.log.warn({ code: 'PrototypeAlert', message: String(message) });
    window.confirm = () => true;
    window.prompt = () => '';
    window.print = () => {};
    window.open = () => null;
    // Network.
    installNetwork(window, { files: this.options.files, log: { warn: w => page.log.warn(w), network: n => page.log.network.push(n) }, onJson: (relative, value) => page.jsonFetched.push({ relative, value }) });
    // Listener registry.
    const proto = window.EventTarget.prototype;
    const add = proto.addEventListener, remove = proto.removeEventListener;
    this.addInternal = (target, type, listener, options) => add.call(target, type, listener, options);
    proto.addEventListener = function addEventListener(type, listener, options) {
      const site = listener ? siteOf(shortStack()) : null;
      if (site) page.record(this, type, 'listener', site);
      return add.call(this, type, listener, options);
    };
    proto.removeEventListener = function removeEventListener(type, listener, options) {
      return remove.call(this, type, listener, options);
    };
    // <form method="dialog"> (HTML): a submission nobody cancels closes its dialog with the submitter's value as returnValue
    // and fires close, as a browser does (jsdom leaves the dialog open, so a login made in a dialog never happened).
    let submitter = null;
    this.addInternal(window.document, 'click', event => { const button = event.target?.closest?.('button, input[type="submit"]'); submitter = button?.form ? button : null; }, true);
    this.addInternal(window.document, 'submit', event => {
      const form = event.target;
      const by = event.submitter ?? (submitter?.form === form ? submitter : null);
      submitter = null;
      if (String(form?.getAttribute?.('method') ?? '').toLowerCase() !== 'dialog') return;
      page.dialogSubmit = { form, value: by?.value ?? '' };
    }, true);
    this.addInternal(window, 'submit', event => {
      const pending = page.dialogSubmit;
      page.dialogSubmit = null;
      if (!pending || pending.form !== event.target || event.defaultPrevented) return;
      const dialog = pending.form.closest('dialog');
      if (dialog?.hasAttribute('open')) dialog.close(pending.value);
    });
    const wrapHandlers = target => {
      if (!target) return;
      for (const name of HANDLER_PROPERTIES) {
        const descriptor = Object.getOwnPropertyDescriptor(target, name);
        if (!descriptor?.set || !descriptor.configurable) continue;
        Object.defineProperty(target, name, {
          configurable: true, enumerable: descriptor.enumerable, get: descriptor.get,
          set(value) { const site = typeof value === 'function' ? siteOf(shortStack()) : null; if (site) page.record(this, name.slice(2), 'property', site); return descriptor.set.call(this, value); }
        });
      }
    };
    for (const target of [window.HTMLElement?.prototype, window.SVGElement?.prototype, window.Element?.prototype, window.Document?.prototype, Object.getPrototypeOf(window), window]) wrapHandlers(target);
    // Inline on<type> attributes (jsdom only compiles them with runScripts "dangerously").
    const compiled = new WeakMap();
    const inline = event => {
      const path = event.composedPath();
      for (const node of path) {
        if (!node?.getAttribute) continue;
        const code = node.getAttribute('on' + event.type);
        if (code == null) continue;
        const known = compiled.get(node) ?? {};
        if (known[event.type] === code) continue;
        known[event.type] = code;
        compiled.set(node, known);
        try {
          const fn = new window.Function('event', code);
          const descriptor = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'on' + event.type);
          if (descriptor?.set) descriptor.set.call(node, fn); else node['on' + event.type] = fn;
        } catch (error) { page.log.errors.push(describeError(error)); }
      }
    };
    for (const type of EVENT_TYPES) add.call(window, type, inline, true);
    // SSAM owns DOMContentLoaded and load: jsdom's own (asynchronous) dispatches are stopped before any listener.
    const lifecycleUntrusted = event => { if (!page.lifecycle) event.stopImmediatePropagation(); };
    add.call(window, 'DOMContentLoaded', lifecycleUntrusted, true);
    add.call(window, 'load', event => { if (event.target === window.document || event.target === window) lifecycleUntrusted(event); }, true);
    const documentObject = window.document;
    Object.defineProperty(documentObject, 'readyState', { configurable: true, get: () => page.readyState });
    documentObject.write = documentObject.writeln = function write() {
      const failure = new RenderFailure('document.write is not supported', { documentWrite: true });
      page.log.problems.push({ reason: 'document.write', message: 'document.write at ' + (siteText(siteOf(shortStack())) ?? 'load'), site: siteOf(shortStack()) });
      throw failure;
    };
    this.realmize(window);
  }

  // Defence in depth over the child's OS sandbox (pool.mjs): the globals SSAM installs above are host-realm closures,
  // so a page script could reach the host Function (and from there the Node realm) through `<global>.constructor`.
  // Reparent each one onto the realm's own Function.prototype (window.Function belongs to the jsdom realm), so that
  // `.constructor` is the realm Function, whose `Function('return process')()` runs in the jsdom realm where `process`
  // does not exist. This closes the installed-global vectors; the authoritative boundary for the escapes inherent to
  // jsdom (e.g. document.createElement.constructor) remains the permission-model sandbox of the capture child.
  realmize(window) {
    const realmProto = window.Function?.prototype;
    if (!realmProto || realmProto === Function.prototype) return;
    const reparent = fn => { if (typeof fn === 'function' && Object.getPrototypeOf(fn) === Function.prototype) { try { Object.setPrototypeOf(fn, realmProto); } catch { /* frozen */ } } };
    for (const name of ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'alert', 'confirm', 'prompt', 'print', 'open', 'scrollTo', 'scroll', 'scrollBy', 'matchMedia', 'IntersectionObserver', 'ResizeObserver']) reparent(window[name]);
    reparent(window.Math?.random);
    if (window.CSS) { reparent(window.CSS.escape); reparent(window.CSS.supports); }
    if (window.crypto) { reparent(window.crypto.getRandomValues); reparent(window.crypto.randomUUID); }
    reparent(window.navigator?.sendBeacon);
    reparent(window.Element?.prototype?.scrollIntoView);
    reparent(window.Element?.prototype?.scrollTo);
    reparent(window.Element?.prototype?.scrollBy);
  }

  // ---- drain -------------------------------------------------------------------------------------------------------
  async microtasks() { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)); }

  async drain() {
    let frames = 0;
    for (let round = 0; round < 5000; round++) {
      await this.microtasks();
      if (this.timers.length) {
        this.timers.sort((x, y) => (x.at - y.at) || (x.id - y.id));
        const timer = this.timers.shift();
        this.now = Math.max(this.now, timer.at);
        try { timer.handler.apply(this.window, timer.args); } catch (error) { this.log.errors.push(describeError(error)); }
        continue;
      }
      if (this.frames.length && frames < MAX_FRAMES) {
        frames++;
        this.now += FRAME;
        const due = this.frames; this.frames = [];
        for (const frame of due) { try { frame.callback(this.now); } catch (error) { this.log.errors.push(describeError(error)); } }
        continue;
      }
      break;
    }
    if (this.frames.length) this.log.warn({ code: 'PrototypeAnimationFramesCapped', frames: MAX_FRAMES });
  }

  // ---- scripts and lifecycle ---------------------------------------------------------------------------------------
  trackGlobals(before) {
    const window = this.window;
    for (const name of Object.getOwnPropertyNames(window)) {
      if (before.has(name)) continue;
      before.add(name);
      let value;
      try { value = window[name]; } catch { continue; }
      this.globals.push(name);
      if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof window.Node)) this.wrapNamespace(name, value);
    }
  }

  // Calls to functions of script-created namespaces are observed so that objects they return (a model instance,
  // for example) can offer data arrays (2.7: "Arrays de objetos planos fora do store").
  wrapNamespace(name, object) {
    const page = this;
    for (const key of Object.keys(object)) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor || typeof descriptor.value !== 'function' || !descriptor.writable) continue;
      const original = descriptor.value;
      object[key] = new Proxy(original, {
        apply(target, self, args) { const result = Reflect.apply(target, self, args); page.noteReturn(name + '.' + key, result); return result; },
        construct(target, args, newTarget) { const result = Reflect.construct(target, args, newTarget); page.noteReturn(name + '.' + key, result); return result; }
      });
    }
  }

  noteReturn(path, value) {
    if (value && typeof value === 'object' && !Array.isArray(value) && this.returned.length < 16 && !this.returned.some(entry => entry.value === value)) this.returned.push({ path, value });
  }

  runClassic(text, filename, lineOffset = 0, columnOffset = 0) {
    const before = new Set(Object.getOwnPropertyNames(this.window));
    try {
      const script = this.options.cache.classic(text, filename, lineOffset, columnOffset);
      script.runInContext(this.context);
    } catch (error) {
      if (error instanceof RenderFailure && error.detail?.documentWrite) return;
      const info = describeError(error);
      this.log.problems.push({ reason: 'script', message: 'script error at ' + (info.where ?? filename) + ': ' + info.message, site: info.site });
    }
    this.trackGlobals(before);
  }

  async runModuleEntries(entries) {
    const before = new Set(Object.getOwnPropertyNames(this.window));
    try {
      await runModules(entries, { context: this.context, importMap: this.importMap, readText: relative => this.options.files.text(relative), vendors: this.options.vendors });
    } catch (error) {
      if (error instanceof RenderFailure) this.log.problems.push({ reason: error.detail.bare ? 'bare-specifier' : error.detail.vendor ? 'vendor' : 'module', message: error.message, url: error.detail.url, specifier: error.detail.specifier });
      else { const info = describeError(error); this.log.problems.push({ reason: 'script', message: 'module error at ' + (info.where ?? 'module') + ': ' + info.message, site: info.site }); }
    }
    this.trackGlobals(before);
  }

  scriptSource(entry) {
    if (entry.text != null) return { text: entry.text, filename: this.options.entry, line: entry.line - 1, column: entry.column - 1 };
    if (entry.local != null) {
      const text = this.options.files.text(entry.local);
      if (text == null) { this.log.problems.push({ reason: 'missing-script', message: 'script ' + entry.local + ' does not exist in source' }); return null; }
      return { text, filename: entry.local, line: 0, column: 0 };
    }
    if (entry.remote) {
      const vendor = this.options.vendors.get(entry.url);
      if (!vendor) { this.log.problems.push({ reason: 'vendor', url: entry.url, message: 'script ' + entry.url + ' is not available' }); return null; }
      return { text: vendor.text, filename: entry.url, line: 0, column: 0 };
    }
    return null;
  }

  async runEntry(entry) {
    this.handledScripts.add(entry.element);
    if (entry.kind === 'module') {
      await this.runModuleEntries([entry.text != null ? { inline: entry.text, identifier: this.options.entry + ':module-' + entry.index } : { url: entry.url }]);
      return;
    }
    const source = this.scriptSource(entry);
    if (source) this.runClassic(source.text, source.filename, source.line, source.column);
  }

  async load() {
    const { window } = this;
    const document = window.document;
    this.context = this.dom.getInternalVMContext();
    // <link rel=stylesheet> of source -> <style data-ssam-href> in the same place (CSSOM without loading resources).
    for (const link of [...document.querySelectorAll('link[rel~="stylesheet"][href]')]) {
      const href = link.getAttribute('href');
      const relative = localPath(new URL(href, document.URL).href, document.URL);
      if (relative == null) continue;
      const text = this.options.files.text(relative);
      if (text == null) continue;
      const style = document.createElement('style');
      style.setAttribute('data-ssam-href', relative);
      for (const attribute of link.attributes) if (attribute.name === 'media') style.setAttribute('media', attribute.value);
      link.replaceWith(style);
      this.pendingStyles.push({ style, text });
    }
    for (const style of document.querySelectorAll('style')) this.styleSeen.set(style, 'initial');
    this.sheetTexts = [...document.querySelectorAll('style')].map(style => this.pendingStyles.find(item => item.style === style)?.text ?? style.textContent);
    this.installLazyStyles();
    const plan = planScripts(document, { nodeLocation: element => { try { return this.dom.nodeLocation(element); } catch { return null; } } });
    this.importMap = null;
    for (const entry of plan.filter(item => item.kind === 'importmap')) {
      try { this.importMap = JSON.parse(entry.text ?? '{}'); } catch { this.log.problems.push({ reason: 'importmap', message: 'invalid import map' }); }
    }
    const runnable = plan.filter(entry => (entry.kind === 'classic' && !entry.nomodule) || entry.kind === 'module');
    for (const entry of plan) this.handledScripts.add(entry.element);
    const sync = runnable.filter(entry => entry.kind === 'classic' && (entry.text != null || (!entry.defer && !entry.async)));
    const deferred = runnable.filter(entry => !sync.includes(entry) && !(entry.async && (entry.url || entry.kind === 'module')));
    const asynchronous = runnable.filter(entry => !sync.includes(entry) && !deferred.includes(entry));
    for (const entry of sync) await this.runEntry(entry);
    // Spec order: deferred classic scripts and module scripts in document order, then DOMContentLoaded.
    for (const entry of deferred) await this.runEntry(entry);
    this.watchDynamicScripts();
    this.readyState = 'interactive';
    this.lifecycle = true;
    try { document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true })); } finally { this.lifecycle = false; }
    await this.drain();
    for (const entry of asynchronous) await this.runEntry(entry);
    await this.drain();
    this.readyState = 'complete';
    this.lifecycle = true;
    try {
      window.dispatchEvent(new window.Event('load'));
      const bodyLoad = document.body?.getAttribute('onload');
      if (bodyLoad) new window.Function('event', bodyLoad).call(window, new window.Event('load'));
    } catch (error) { this.log.errors.push(describeError(error)); } finally { this.lifecycle = false; }
    await this.drain();
  }

  watchDynamicScripts() {
    const { window } = this;
    const page = this;
    const observer = new window.MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node.localName !== 'script' || page.handledScripts.has(node)) continue;
        page.handledScripts.add(node);
        const [entry] = planScripts({ querySelectorAll: () => [node], URL: window.document.URL });
        if (!entry || !['classic', 'module'].includes(entry.kind)) continue;
        if (entry.remote && !page.options.vendors.has(entry.url)) page.log.problems.push({ reason: 'vendor', url: entry.url, message: 'script ' + entry.url + ' inserted at runtime is not available', dynamic: true });
        page.runEntry(entry).then(() => node.dispatchEvent(new window.Event('load')));
      }
    });
    observer.observe(window.document, { childList: true, subtree: true });
  }

  // ---- actions -----------------------------------------------------------------------------------------------------
  resolveTarget(target) {
    const document = this.window.document;
    if (!target) return null;
    if (target.id) return document.getElementById(target.id);
    if (target.sel) return document.querySelectorAll(target.sel)[target.i ?? 0] ?? null;
    if (target.m) {
      const found = [...document.body.querySelectorAll(target.m.t)].filter(element => !this.hiddenFromCapture(element) && (target.m.a ?? []).every(([name, value]) => element.getAttribute(name) === value));
      return found[target.i ?? 0] ?? null;
    }
    if (target.path) {
      let node = document.body;
      for (const index of target.path) {
        node = this.serializableChildren(node)[index];
        if (!node) return null;
      }
      return node;
    }
    return null;
  }

  navigate(route, kind) {
    const window = this.window;
    if (kind === 'spa-path') {
      window.history.pushState({}, '', route || '/');
      window.dispatchEvent(new window.PopStateEvent('popstate', { state: {} }));
      return;
    }
    const next = route ? '#' + route : '';
    if (window.location.hash === next || (next === '' && window.location.hash === '')) {
      // Same hash: a router re-render needs the event the browser would not send; nothing to do.
      return;
    }
    if (next === '') {
      window.history.pushState(null, '', window.location.pathname + window.location.search);
      window.dispatchEvent(new window.HashChangeEvent('hashchange', { oldURL: window.location.href, newURL: window.location.href }));
      return;
    }
    window.location.hash = next;
  }

  setControl(element, value) {
    const window = this.window;
    if (!element) return false;
    const tag = element.localName;
    if (tag === 'input' && ['checkbox', 'radio'].includes(String(element.type))) {
      const wanted = value === true || value === 'true' || value === 'on' || value === '1';
      if (element.type === 'radio') { if (!element.checked) element.click(); return true; }
      if (element.checked !== wanted) element.click();
      return true;
    }
    if (tag === 'select') {
      element.value = String(value);
    } else {
      element.value = String(value);
    }
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
    element.dispatchEvent(new window.Event('change', { bubbles: true }));
    return true;
  }

  typeText(element, value) {
    const window = this.window;
    if (!element) return false;
    element.value = String(value);
    element.dispatchEvent(new window.InputEvent('input', { bubbles: true, data: String(value) }));
    return true;
  }

  click(element, coords) {
    const window = this.window;
    if (!element) return false;
    if (coords) {
      element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: coords[0], clientY: coords[1] }));
      return true;
    }
    if (element.disabled) return false;
    if (typeof element.click === 'function') element.click();
    else element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return true;
  }

  submit(form) {
    const window = this.window;
    if (!form) return false;
    const event = new window.Event('submit', { bubbles: true, cancelable: true });
    const proceed = form.dispatchEvent(event);
    // method="dialog" closes its dialog (the listener above), it never navigates
    if (proceed && String(form.getAttribute('method') ?? '').toLowerCase() !== 'dialog') this.log.warn({ code: 'PrototypeFormNavigation', form: form.id || form.getAttribute('name') || 'form' });
    return true;
  }

  key(element, key) {
    const window = this.window;
    if (!element) return false;
    element.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key }));
    return true;
  }

  // ---- serialization -----------------------------------------------------------------------------------------------
  ignored(element) {
    const selectors = this.options.mapping?.ignore ?? [];
    for (const selector of selectors) { try { if (element.matches(selector)) return true; } catch { /* invalid selector */ } }
    return false;
  }

  hiddenFromCapture(element) {
    for (let node = element; node && node !== this.window.document.body; node = node.parentElement) {
      if (SKIP_TAGS.has(node.localName) || this.ignored(node)) return true;
    }
    return false;
  }

  serializableChildren(node) {
    const out = [];
    for (const child of node.childNodes) {
      if (child.nodeType === 3) out.push(child);
      else if (child.nodeType === 1 && !SKIP_TAGS.has(child.localName) && !this.ignored(child)) out.push(child);
    }
    return out;
  }

  fillStyles() {
    if (!this.pendingStyles.length) return;
    const pending = this.pendingStyles; this.pendingStyles = [];
    for (const { style, text } of pending) style.textContent = text;
  }

  installLazyStyles() {
    const page = this;
    const window = this.window;
    const getComputedStyle = window.getComputedStyle;
    window.getComputedStyle = function (...args) { page.fillStyles(); return getComputedStyle.apply(window, args); };
    const proto = Object.getPrototypeOf(window.document);
    const sheets = Object.getOwnPropertyDescriptor(window.Document.prototype, 'styleSheets') ?? Object.getOwnPropertyDescriptor(proto, 'styleSheets');
    if (sheets?.get) Object.defineProperty(window.document, 'styleSheets', { configurable: true, get() { page.fillStyles(); return sheets.get.call(this); } });
    const sheet = Object.getOwnPropertyDescriptor(window.HTMLStyleElement.prototype, 'sheet');
    if (sheet?.get) Object.defineProperty(window.HTMLStyleElement.prototype, 'sheet', { configurable: true, get() { page.fillStyles(); return sheet.get.call(this); } });
  }

  // Rules of the initial sheets (outside @media), parsed once per child process: stroke-width (icons) and display
  // (visibility of modal candidates), with specificity and order for the cascade.
  cssRules() {
    if (this._cssRules) return this._cssRules;
    const cache = this.options.ruleCache ?? new Map();
    const rules = [];
    let order = 0;
    for (const text of this.sheetTexts ?? []) {
      if (!cache.has(text)) cache.set(text, parseRules(text));
      for (const rule of cache.get(text)) rules.push({ ...rule, order: order++ });
    }
    this._cssRules = rules;
    return rules;
  }

  strokeRules() { return this.cssRules().filter(rule => rule.stroke); }

  cascade(element, property) {
    let best = null;
    for (const rule of this.cssRules()) {
      const value = rule[property];
      if (!value) continue;
      let matches = false;
      try { matches = element.matches(rule.selector); } catch { matches = false; }
      if (!matches) continue;
      const important = rule[property + 'Important'];
      if (!best || (important && !best.important) || (important === best.important && (compareSpec(rule.spec, best.spec) > 0 || (compareSpec(rule.spec, best.spec) === 0 && rule.order > best.order)))) best = { value, important, spec: rule.spec, order: rule.order };
    }
    return best?.value ?? null;
  }

  // Effective stroke-width: the winning declaration among the prototype rules that match (outside @media), else the attribute.
  effectiveStroke(element) {
    const value = this.cascade(element, 'stroke') ?? element.getAttribute('stroke-width');
    const number = Number.parseFloat(value);
    return Number.isFinite(number) ? number : null;
  }

  iconOf(element) {
    const classList = String(element.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
    let name = element.getAttribute('data-lucide');
    if (!name && classList.includes('lucide')) name = classList.find(token => token.startsWith('lucide-'))?.slice(7);
    // A hand-written monochrome inline svg (strokes and fills in currentColor or none) is an icon too, named by its markup.
    if (!name && monochrome(element)) name = 'svg-' + fnv((element.getAttribute('viewBox') ?? '') + '|' + element.innerHTML.replace(/\s+/g, ' ').trim());
    if (!name) return null;
    const from = [];
    for (const attribute of element.attributes) {
      if (LUCIDE_DEFAULTS.has(attribute.name.toLowerCase())) continue;
      if (attribute.name === 'class') {
        const kept = classList.filter(token => token !== 'lucide' && token !== 'lucide-' + name && !(token.startsWith('lucide-') && token.slice(7) === name));
        if (kept.length) from.push(['class', kept.join(' ')]);
        continue;
      }
      from.push([attribute.name, attribute.value]);
    }
    if (!this.iconSvg.has(name)) {
      const keep = ['xmlns', 'viewBox', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin'];
      const attrs = keep.filter(key => element.getAttribute(key) != null).map(key => key + '="' + element.getAttribute(key) + '"').join(' ');
      this.iconSvg.set(name, { viewBox: element.getAttribute('viewBox') ?? '0 0 24 24', svg: '<svg ' + attrs + '>' + element.innerHTML + '</svg>' });
    }
    return { name, strokeWidth: this.effectiveStroke(element), from };
  }

  // Visibility of top-level regions and modal candidates: hidden attribute, dialog open, inline display, and the
  // computed display only for modal-like elements (getComputedStyle walks every rule; it is never run per element).
  hiddenState(element) {
    if (element.hasAttribute('hidden')) return true;
    if (element.localName === 'dialog') return !element.hasAttribute('open');
    const inline = element.style?.display;
    if (inline === 'none') return true;
    if (inline) return false;
    const modalLike = element.getAttribute('role') === 'dialog' || element.hasAttribute('aria-modal') || /modal|dialog|popup|overlay|drawer|lightbox/i.test((element.getAttribute('class') ?? '') + ' ' + element.id);
    if (!modalLike) return false;
    return this.cascade(element, 'display') === 'none';
  }

  serialize(node, depth = 0) {
    if (node.nodeType === 3) return { x: node.data };
    const tag = node.localName.toLowerCase();
    const out = { t: tag };
    const attributes = [...node.attributes].map(attribute => [attribute.name, attribute.value]);
    if (attributes.length) out.a = attributes;
    const listeners = this.listenerTypes(node);
    if (listeners.length) out.L = listeners;
    const own = this.registry.get(node);
    if (own?.length) out.LS = [...new Set(own.map(entry => entry.type + '@' + (entry.site ? entry.site.file + ':' + entry.site.line : '?')))];
    if (tag === 'svg') {
      const icon = this.iconOf(node);
      if (icon) out.icon = icon; else out.svg = node.outerHTML;
      return out;
    }
    if (['input', 'select', 'textarea'].includes(tag)) {
      out.p = { v: String(node.value ?? '') };
      if (tag === 'input' && ['checkbox', 'radio'].includes(String(node.type))) out.p.ck = Boolean(node.checked);
      if (node.disabled) out.p.d = true;
    } else if (tag === 'button' && node.disabled && !node.hasAttribute('disabled')) out.p = { d: true };
    const sectionLike = (node.id && this._sectionIds?.has(node.id)) || node.hasAttribute('data-view') || node.hasAttribute('data-page') || node.hasAttribute('data-screen') || node.hasAttribute('data-section') || node.getAttribute('role') === 'tabpanel';
    if (depth <= 2 || sectionLike || tag === 'dialog' || node.getAttribute('role') === 'dialog' || node.hasAttribute('aria-modal')) {
      if (sectionLike && !node.hasAttribute('hidden') && node.localName !== 'dialog' && !node.style?.display) {
        if (this.cascade(node, 'display') === 'none') out.h = true;
      } else if (this.hiddenState(node)) out.h = true;
    }
    const kids = this.serializableChildren(node);
    if (kids.length) out.c = kids.map(child => this.serialize(child, depth + 1));
    return out;
  }

  runtimeStyles() {
    const out = [];
    for (const style of this.window.document.querySelectorAll('style')) {
      if (this.styleSeen.get(style) === 'initial') continue;
      out.push(style.textContent);
    }
    return out;
  }

  snapshot(tag) {
    const window = this.window;
    const document = window.document;
    this._sectionIds = new Set();
    for (const anchor of document.querySelectorAll('a[href^="#"]')) { const id = anchor.getAttribute('href').slice(1); if (id) this._sectionIds.add(decodeURIComponent(id)); }
    for (const control of document.querySelectorAll('[aria-controls]')) for (const id of control.getAttribute('aria-controls').split(/\s+/)) if (id) this._sectionIds.add(id);
    const snap = {
      tag,
      url: window.location.href.slice(ORIGIN.length),
      hash: window.location.hash,
      path: window.location.pathname,
      title: document.title,
      body: this.serialize(document.body),
      storage: this.local.__dump(),
      runtimeStyles: this.runtimeStyles(),
      errors: this.log.errors.splice(0)
    };
    if (this.liveStore) snap.store = this.liveStore();
    return snap;
  }

  close() { try { this.window.close(); } catch { /* already closed */ } }
}

function siteText(site) { return site ? site.file + ':' + site.line : null; }

// One CSS text -> [{selector, spec, display, displayImportant, stroke, strokeImportant}] (style rules outside @media),
// through a throwaway jsdom document (the same parser as the windows).
export function parseRules(text) {
  const dom = new JSDOM('<!doctype html><style></style>');
  const out = [];
  try {
    dom.window.document.querySelector('style').textContent = text;
    const visit = (list, inMedia) => {
      for (const rule of list ?? []) {
        if (rule.type === 1) {
          if (inMedia) continue;
          const display = rule.style.getPropertyValue('display'), stroke = rule.style.getPropertyValue('stroke-width');
          if (!display && !stroke) continue;
          for (const selector of rule.selectorText.split(',').map(part => part.trim())) out.push({ selector, spec: specificity(selector), display: display || null, displayImportant: rule.style.getPropertyPriority('display') === 'important', stroke: stroke || null, strokeImportant: rule.style.getPropertyPriority('stroke-width') === 'important' });
        } else if (rule.cssRules) visit(rule.cssRules, inMedia || rule.type === 4 || rule.type === 12);
      }
    };
    visit(dom.window.document.styleSheets[0]?.cssRules, false);
  } finally { dom.window.close(); }
  return out;
}

// Opens a window: parses the entry HTML with the polyfills installed before parsing, then runs its scripts.
export async function openPage(options) {
  const page = new Page(options);
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => {
    const text = String(error?.message ?? error);
    if (/Not implemented: (HTMLFormElement|navigation)/.test(text)) return;
    if (/Could not load (link|img|script|iframe)/.test(text) || /PrototypeNetworkBlocked/.test(text)) { page.log.warn({ code: 'PrototypeResourceBlocked', message: text.slice(0, 200) }); return; }
    page.log.errors.push(describeError(error?.cause ?? error));
  });
  const dispatcher = new RejectingDispatcher(url => page.log.warn({ code: 'PrototypeNetworkBlocked', kind: 'resource', url }));
  page.dispatcher = dispatcher;
  const dom = new JSDOM(options.html, {
    url: ORIGIN + '/' + options.entry,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    includeNodeLocations: true,
    virtualConsole,
    resources: { dispatcher, interceptors: [sourceInterceptor(requestInterceptor, options.files)] },
    beforeParse(window) { page.install(window); }
  });
  page.dom = dom;
  page.document = dom.window.document;
  await page.load();
  return page;
}

export { isRemote };
