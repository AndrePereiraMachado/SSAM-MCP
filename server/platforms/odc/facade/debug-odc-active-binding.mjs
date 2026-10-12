// Marker of an ODC app whose debug request may be in flight, paused or held:
// .local/debugger/active-odc/<applicationKey>.json. Deployment writes read it
// before reserving anything; ApplyConfigs/Deploy/Undeploy pass only when it is
// absent, held or idle. An uncertain run retains it until reconciled.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { workspaceRoot } from './workspace.mjs';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail = code => { throw new Error('debug_odc_active_binding_' + code); };
export const ACTIVE_BINDING_STATES = Object.freeze(['request-in-flight', 'paused', 'held', 'idle']);
const DEPLOYABLE = new Set(['held', 'idle']);
export function activeBindingFile(root, applicationKey) {
  const key = String(applicationKey ?? '').toLowerCase();
  if (!GUID.test(key)) fail('application_key_invalid');
  return path.join(root, '.local', 'debugger', 'active-odc', key + '.json');
}
// Windows briefly denies a read, replace or removal while another process (an
// antivirus scan, a guard read) holds the file: retry with backoff, bounded.
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function retrying(action, budgetMs = 4000) {
  const deadline = performance.now() + budgetMs; // monotonic: unaffected by a mocked or shifted clock
  for (let attempt = 0; ; attempt++) {
    try { return action(); }
    catch (error) { if (!TRANSIENT.has(error.code) || performance.now() >= deadline) throw error; pause(Math.min(250, 5 * 2 ** attempt, Math.max(1, deadline - performance.now()))); }
  }
}
export function readOdcActiveBinding(root, applicationKey) {
  const file = activeBindingFile(root, applicationKey);
  let text; try { text = retrying(() => fs.readFileSync(file, 'utf8'), 500); } catch (error) { if (error.code === 'ENOENT') return { file, present: false }; return { file, present: true, unreadable: true }; }
  try { const record = JSON.parse(text); return record && typeof record === 'object' ? { file, present: true, record } : { file, present: true, unreadable: true }; }
  catch { return { file, present: true, unreadable: true }; }
}

export function createOdcActiveBinding({ root = workspaceRoot, applicationKey, operationId, sessionId, runtimeUrl, moduleKey, environmentKey, io = fs, retryMs = 4000 } = {}) {
  const file = activeBindingFile(root, applicationKey), key = path.basename(file, '.json');
  let record = null, created = false, covered = false, released = false;
  const replace = next => {
    const temporary = file + '.' + randomUUID() + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(next), { flag: 'wx' });
    try { retrying(() => io.renameSync(temporary, file), retryMs); }
    finally { try { fs.unlinkSync(temporary); } catch { /* moved by the replace */ } }
  };
  function persist(next) {
    if (created) { replace(next); record = next; return; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let fd;
    // The first write creates the marker exclusively; a reader racing it sees an unreadable marker, which blocks.
    try { fd = fs.openSync(file, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const seen = readOdcActiveBinding(root, key).record;
      // A finished run whose marker could not be removed left it released: it is taken over.
      if (seen?.released === true && seen.retained !== true && seen.uncertain !== true) { replace(next); created = true; record = next; return; }
      // A retained uncertain marker of another run already blocks deployments; never replace or remove it.
      if (seen?.retained !== true || seen.uncertain !== true || seen.operationId === operationId) fail('busy');
      covered = true; record = next; return;
    }
    created = true;
    try { fs.writeSync(fd, JSON.stringify(next)); } finally { fs.closeSync(fd); }
    record = next;
  }
  const handle = {
    file,
    get state() { return record?.state ?? null; },
    get covered() { return covered; },
    mark(state) {
      if (!ACTIVE_BINDING_STATES.includes(state)) fail('state_invalid');
      if (released) fail('released');
      const next = { schema: 'ssam-odc-active-binding/1', applicationKey: key, state, operationId, sessionId, runtimeUrl, moduleKey,
        ...(environmentKey ? { environmentKey } : {}), pid: process.pid, updatedAt: new Date().toISOString() };
      if (covered) record = next; else persist(next);
      return state;
    },
    // Native pause events move only between in-flight and paused; held/idle belong to the runner.
    paused(flag) {
      if (flag && record?.state === 'request-in-flight') return handle.mark('paused');
      if (!flag && record?.state === 'paused') return handle.mark('request-in-flight');
      return record?.state ?? null;
    },
    release({ uncertain = false } = {}) {
      const state = record?.state ?? null;
      if (released) fail('released');
      released = true;
      if (covered) return { file, state, removed: false, retained: false, covered: true };
      if (!created) return { file, state, removed: false, retained: false };
      if (uncertain) {
        try { replace({ ...record, retained: true, uncertain: true, updatedAt: new Date().toISOString() }); }
        catch { /* the previous marker still blocks deployments */ }
        return { file, state, removed: false, retained: fs.existsSync(file), uncertain: true };
      }
      try { retrying(() => io.unlinkSync(file), retryMs); return { file, state, removed: true, retained: false }; }
      catch (error) { if (error.code === 'ENOENT') return { file, state, removed: true, retained: false }; }
      // Still denied: an idle released marker blocks neither deployments nor the next run, which takes it over.
      try { replace({ ...record, state: 'idle', released: true, updatedAt: new Date().toISOString() }); return { file, state, removed: false, retained: false, releasedMarker: true }; }
      catch { return { file, state, removed: false, retained: true }; }
    },
  };
  return handle;
}

// One run may hold a request in more than one app (entry and server-trace app):
// every marker moves together and all are released.
export function combineOdcActiveBindings(handles) {
  if (handles.length === 1) return handles[0];
  return {
    file: handles[0].file, files: handles.map(h => h.file),
    get state() { return handles[0].state; },
    get covered() { return handles.every(h => h.covered); },
    mark(state) { for (const h of handles) h.mark(state); return state; },
    paused(flag) { for (const h of handles) h.paused(flag); return handles[0].state; },
    release(options) {
      const bindings = handles.map(h => { try { return h.release(options); } catch { return { file: h.file, removed: false, retained: true }; } });
      return { ...bindings[0], removed: bindings.every(b => b.removed || (!b.retained && !b.state)), retained: bindings.some(b => b.retained), bindings };
    },
  };
}

// Injected into the Portal access layer: refuses a deployment-operations write
// for an app with an active debug request before any reservation or send.
export function odcDeploymentGuard({ root = workspaceRoot } = {}) {
  return ({ operation, assetKey } = {}) => {
    const key = String(assetKey ?? '').toLowerCase();
    if (!GUID.test(key)) return null;
    const seen = readOdcActiveBinding(root, key);
    if (!seen.present) return null;
    const r = seen.record;
    if (r && DEPLOYABLE.has(r.state) && r.uncertain !== true && r.retained !== true) return null;
    const message = (operation ?? 'Deploy') + ' would restart ' + key + ' while a debug request is ' + (seen.unreadable ? 'in an unreadable state' : r.uncertain ? 'uncertain' : r.state)
      + '. Hold the debug session between scenarios (or let it finish) first. Nothing was reserved or sent.';
    return { ok: false, code: 'DEBUG_SESSION_ACTIVE', sent: false, error: { code: 'DEBUG_SESSION_ACTIVE', message },
      activeDebugSession: { applicationKey: key, state: r?.state ?? null, operationId: r?.operationId ?? null, sessionId: r?.sessionId ?? null,
        uncertain: r?.uncertain === true, unreadable: seen.unreadable === true } };
  };
}
