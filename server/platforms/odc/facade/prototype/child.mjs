// Child process of the capture pool (docs/PROTOTIPO-NATIVO.md 2.1, 2.6): node --experimental-vm-modules with TZ
// pinned and a minimal environment. It compiles each classic script once and runs batches of probes; each batch
// starts from a fresh window, and a window is reused inside a batch only while it stays clean.
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';

// V8 compile cache of the child's modules (jsdom is large): later captures start the pool faster.
try { module.enableCompileCache?.(path.join(os.tmpdir(), 'ssam-prototype-compile-cache')); } catch { /* optional */ }
let openPage, JSDOM_VERSION, ScriptCache, SourceFiles, discoverStore, dataArrays, documentInfo, cssSheets, liveStore;
const loaded = (async () => {
  ({ openPage, JSDOM_VERSION } = await import('./dom-runtime.mjs'));
  ({ ScriptCache } = await import('./scripts.mjs'));
  ({ SourceFiles } = await import('./network.mjs'));
  ({ discoverStore, dataArrays, documentInfo, cssSheets, liveStore } = await import('./store.mjs'));
  cache = new ScriptCache();
})();

Error.stackTraceLimit = 50;
let config = null, files = null, vendors = new Map();
let warm = Promise.resolve();
let cache = null;
const ruleCache = new Map();

// The page's own errors that escape every handler of the page (a promise of the page rejected with no catch, an exception
// thrown by its code in a microtask: a fetch to the network without .catch, the page's Babel throwing on a JSX it cannot
// compile, a .jsx it cannot fetch) end the process by default. A browser logs them and the page goes on: here they are
// written to the log of the window that runs (a rejection as a warning, as the browser console shows it; an exception as a
// script error of the page, as a script that throws at load) and the capture goes on.
// While a window opens (openPage loads the page) its log does not exist yet: what escapes then waits in `opening` and goes to
// the window's log when it is there.
let active = null, opening = null;
const describe = error => String(error?.stack ?? error?.message ?? error).split('\n').slice(0, 3).join(' | ').slice(0, 600);
const record = item => {
  if (opening) { opening.push(item); return; }
  if (active) { if (item.problem) active.log.problems.push(item.problem); else active.log.warn(item.warning); return; }
  process.stderr.write('uncaught outside a window: ' + (item.problem?.message ?? item.warning?.message) + '\n');
};
process.on('unhandledRejection', reason => {
  try { record({ warning: { code: 'PrototypeUnhandledRejection', message: 'a promise of the page was rejected with no catch: ' + describe(reason) } }); } catch { /* the window is gone */ }
});
process.on('uncaughtException', error => {
  try { record({ problem: { reason: 'script', message: 'uncaught error of the page: ' + describe(error) } }); } catch { /* the window is gone */ }
});

async function fresh(batch) {
  const html = files.text(batch.page);
  if (html == null) throw new Error('page ' + batch.page + ' does not exist in source');
  active = null; opening = [];
  let page;
  try { page = await openPage({ html, entry: batch.page, files, cache, vendors, clock: config.clock, seed: config.seed ?? 1, storage: batch.storage ?? null, mapping: config.mapping ?? {}, ruleCache }); }
  finally {
    const waiting = opening; opening = null; active = page ?? null;
    for (const item of waiting) record(item);
  }
  // An in-memory store (store.live, found by the load inspect): every snapshot carries its value read again.
  if (batch.live) page.liveStore = () => liveStore(page, batch.live);
  return page;
}

async function step(page, action, kind, snaps) {
  const target = action.target ? page.resolveTarget(action.target) : null;
  switch (action.do) {
    case 'nav': page.navigate(action.route, kind); break;
    case 'set': if (!page.setControl(target, action.value)) return { missing: action.target }; break;
    case 'type': if (!page.typeText(target, action.value)) return { missing: action.target }; break;
    case 'click': if (!target) return { missing: action.target }; page.click(target, action.coords); break;
    case 'submit': if (!target) return { missing: action.target }; page.submit(target.localName === 'form' ? target : target.form ?? target.closest('form')); break;
    case 'key': if (!page.key(target, action.key)) return { missing: action.target }; break;
    case 'value': if (!target) return { missing: action.target }; target.value = String(action.value); break;
    // a dialog of the page opened as its own opener would (a session state is reached through its form)
    case 'open': if (!target) return { missing: action.target }; if (target.localName === 'dialog' && !target.hasAttribute('open')) target.showModal(); break;
    case 'snap': snaps.push(page.snapshot(action.tag)); return null;
    case 'inspect': snaps.push(inspect(page, action)); return null;
    default: throw new Error('unknown step ' + action.do);
  }
  await page.drain();
  return null;
}

function inspect(page, action) {
  const snap = page.snapshot(action.tag ?? 'inspect');
  snap.inspect = {
    jsdom: JSDOM_VERSION,
    problems: page.log.problems.slice(),
    warnings: page.log.warnings.slice(),
    listeners: page.globalListeners(),
    globals: page.globals.slice(),
    storageLog: page.log.storage.slice(),
    network: page.log.network.slice(),
    store: discoverStore(page, config.mapping ?? {}),
    arrays: dataArrays(page),
    document: documentInfo(page),
    sheets: cssSheets(page),
    icons: Object.fromEntries([...page.iconSvg.entries()].sort(([a], [b]) => a < b ? -1 : 1)),
    read: [...files.read].sort()
  };
  return snap;
}

// A batch shares one prefix. The first probe opens a window; after each probe the window is reused only when it is
// clean (2.6): the store writes did not change localStorage (nor the in-memory store) and replaying the prefix gives the same serialized DOM
// (live control values included) as right after the prefix. Otherwise the next probe opens a fresh window.
async function runBatch(batch) {
  const started = performance.now();
  let openMs = 0;
  const results = [];
  let page = null, baseline = null, baselineBody = null, beforeSnap = null, windows = 0, reused = 0;
  const prefix = async () => {
    const snaps = [];
    for (const action of batch.prefix ?? []) {
      const failure = await step(page, action, batch.kind, snaps);
      if (failure) return failure;
    }
    return null;
  };
  const open = async () => {
    page?.close();
    const t = performance.now();
    page = await fresh(batch);
    openMs += performance.now() - t;
    windows++;
    const failure = await prefix();
    beforeSnap = page.snapshot('before');
    // both storages: a window is reused only when neither changed (a probe never sees the writes of another one)
    baseline = JSON.stringify([page.local.__dump(), page.sessionStore?.__dump?.() ?? null, beforeSnap.store ?? null]);
    baselineBody = JSON.stringify(beforeSnap.body);
    return failure;
  };
  let dirty = true;
  for (const probe of batch.probes) {
    const snaps = [];
    let failure = null;
    try {
      if (dirty) failure = await open();
      if (!failure) for (const [index, action] of probe.steps.entries()) {
        if (index === 0 && action.do === 'snap' && action.tag === 'before' && beforeSnap) { snaps.push({ ...beforeSnap, errors: [] }); continue; }
        failure = await step(page, action, batch.kind, snaps);
        if (failure) break;
      }
    } catch (error) {
      failure = { error: String(error?.stack ?? error).slice(0, 2000) };
    }
    const icons = page ? Object.fromEntries(page.iconSvg) : {};
    const warnings = page ? page.log.warnings.slice() : [];
    results.push({ key: probe.key, snaps, failure, icons, warnings });
    dirty = true;
    const last = probe === batch.probes[batch.probes.length - 1];
    if (!last && page && !failure && JSON.stringify([page.local.__dump(), page.sessionStore?.__dump?.() ?? null, page.liveStore?.() ?? null]) === baseline && !page.log.problems.length) {
      try {
        const after = snaps.findLast?.(snap => snap.tag === 'after') ?? snaps[snaps.length - 1];
        if (batch.shared) dirty = false;
        else if (after && after.url === beforeSnap?.url && JSON.stringify(after.body) === baselineBody) { dirty = false; reused++; }
        // the prefix played again on the same window: reused only when the page AND both storages are back to the baseline
        else if (!(await prefix()) && JSON.stringify(page.serialize(page.window.document.body)) === baselineBody
          && JSON.stringify([page.local.__dump(), page.sessionStore?.__dump?.() ?? null, page.liveStore?.() ?? null]) === baseline) { dirty = false; reused++; }
      } catch { dirty = true; }
    }
  }
  page?.close();
  return { results, windows, reused, ms: Math.round(performance.now() - started), openMs: Math.round(openMs) };
}

process.on('message', async message => {
  await loaded;
  try {
    if (message.type === 'init') {
      config = message.config;
      files = new SourceFiles(config.root, { aliases: config.aliases ?? {} });
      vendors = new Map((config.vendors ?? []).map(vendor => [vendor.url, vendor]));
      for (const script of config.prewarm ?? []) { try { cache.classic(files.text(script.file) ?? '', script.file); } catch { /* reported when the window runs it */ } }
      process.send({ type: 'ready', tz: process.env.TZ ?? null, offset: new Date(0).getTimezoneOffset() });
      files.read.clear();
    } else if (message.type === 'batch') {
      await warm;
      const result = await runBatch(message.batch);
      result.read = [...files.read].sort();
      process.send({ type: 'result', key: message.batch.key, result });
    } else if (message.type === 'warm') {
      // A throwaway window while this child is idle (JIT, jsdom internals); the next batch waits for it.
      const done = warm.then(async () => { const before = new Set(files.read); try { const page = await fresh({ page: message.page }); page.close(); } catch { /* the real batch reports */ } for (const name of [...files.read]) if (!before.has(name)) files.read.delete(name); });
      warm = done;
    } else if (message.type === 'exit') {
      process.exit(0);
    }
  } catch (error) {
    process.send({ type: 'error', key: message.batch?.key ?? null, error: String(error?.stack ?? error).slice(0, 4000) });
  }
});
