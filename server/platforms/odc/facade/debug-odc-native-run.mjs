// ODC native-entry debugger: prepare / run / status.
//
// Decision of 2026-10-04: NO WRAPPER, NO PUBLISHING. A private action with no public entry is dead code, never
// called; so every action that matters is reachable from an existing entry (screen, block, data action, public
// action, REST, timer). We debug it by calling that ORIGINAL entry in the already-published app, with chosen inputs.
// The CODE, not the LLM, picks the nearest public entry deterministically (debug-odc-native-entry-resolve.mjs).
//
// prepare resolves and validates everything that can be checked offline, and reports what run needs (the secure
// login window and the one live binding). run executes each scenario through the original entry and returns, per
// scenario: typed outputs, a classified exception, the visited nodes/variables when traced, and the duration.
// Assumption (documented): DEV environments; a breakpoint set on an entry could also catch another user's request on
// the same action. One live session per binding; private values are filtered from every output.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { workspaceRoot } from './workspace.mjs';
import { buildModelGraph, materializeGraph } from './debug-odc-native-graph.mjs';
import { resolveEntry, resolveOverride } from './debug-odc-native-entry-resolve.mjs';
import { canonicalizeInputs } from './debug-odc-native-types.mjs';

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,120}$/, KEY = /^[A-Za-z0-9_+]{22}$/;
const root = path.join(workspaceRoot, '.local', 'debugger', 'native-entries', 'odc');
const now = () => new Date().toISOString();
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 1)); fs.renameSync(file + '.tmp', file); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// Effect classes from the target's own call closure (best effort, read-only). entity-write / external-http / email /
// timer / process require the caller to acknowledge them; read-only needs nothing. Unknown calls are flagged.
export function classifyEffects(closureCalls = []) {
  const effects = new Set();
  for (const call of closureCalls) {
    const kind = call.kind, ref = call.action ?? '';
    if (/#(Create|Update|Delete|CreateOrUpdate)\b/.test(ref) || /EntityAction/.test(call.actionKind ?? '')) effects.add('entity-write');
    else if (call.external === true || /RestServiceAction/.test(call.actionKind ?? '')) effects.add('external-http');
    else if (kind === 'SendEmailNode') effects.add('email');
    else if (/Timer/.test(kind)) effects.add('timer-wake');
    else if (/Launch\w*Process/.test(kind)) effects.add('process-launch');
  }
  return [...effects];
}

// Resolve the target and the deterministic entry, validate scenarios. `readers` is the model-graph adapter plus a
// target resolver; live code builds it from the Portal download, tests inject it.
export async function prepareNativeEntry(input, readers) {
  const target = await readers.resolveTarget(input.action);
  if (!target) throw new Error('debug_odc_native_action_not_found:' + input.action);
  // Live readers are async: prefetch the reachable graph into a synchronous one so the resolver stays pure. Synchronous
  // (test) readers are used directly.
  const graph = readers.async ? await materializeGraph(readers, target.path) : (() => { const g = buildModelGraph(readers); g.seed(target.path); return g; })();
  const resolution = input.entry
    ? resolveOverride(graph, target.key, input.entry)
    : resolveEntry(graph, target.key);
  if (!resolution.ok && resolution.deadCode)
    return { ok: false, state: 'dead-code', error: 'dead code: no public entry reaches ' + (target.name ?? input.action),
      target: { key: target.key, name: target.name, kind: target.kind } };
  if (!resolution.ok) return { ok: false, state: 'entry-unresolved', ...resolution };
  // Canonicalize each scenario against the target signature, offline, before any login.
  const signature = (target.inputs ?? []).map(p => ({ name: p.name, dataType: p.dataType, mandatory: p.mandatory !== false, complexType: p.complexType }));
  // The deterministic entry is resolved regardless of inputs. Scenarios are validated only when supplied; prepare with
  // no inputs/scenarios still reports the entry, path and bindings (and that run will need inputs).
  const given = input.scenarios?.length ? input.scenarios : (input.inputs !== undefined ? [{ name: 'scenario-1', inputs: input.inputs }] : []);
  const scenarios = given.map((s, i) => ({ name: s.name ?? 'scenario-' + (i + 1), inputs: canonicalizeInputs(s.inputs ?? {}, signature) }));
  const effects = classifyEffects(target.closureCalls ?? []);
  const sourceContract = readers.sourceContract ?? null;
  const prepared = {
    ok: true, state: 'prepared', lane: 'odc', execution: 'native-entry',
    action: { key: target.key, name: target.name, kind: target.kind, inputs: signature },
    algorithm: resolution.algorithm, entry: resolution.entry, distance: resolution.entry.distance, callPath: resolution.callPath,
    path: resolution.path, bindings: resolution.bindings,
    alternatives: resolution.alternatives ?? [], overridden: resolution.overridden ?? false,
    ...(resolution.deterministicEntry ? { deterministicEntry: resolution.deterministicEntry } : {}),
    scenarios, scenariosValidated: scenarios.length, effects,
    needs: { login: 'secure app-user sign-in window', binding: resolution.entry.key, acknowledgeEffects: effects.filter(e => e !== 'read-only') },
    assumptions: ['DEV environment; a breakpoint on the entry could also catch another user request on the same action'],
    ...(sourceContract ? { sourceContract } : {}),
  };
  if (input.persist !== false) {
    const file = receiptFile(readers.binding, target.key);
    // The receipt records the decision, not the chosen input values (scenario inputs are dropped from the persisted copy).
    const { scenarios: _drop, ...persistable } = prepared;
    write(file, { schema: 'ssam-odc-native-receipt/1', op: 'prepare', at: now(), prepared: persistable });
    prepared.receiptPath = file;
  }
  return prepared;
}

function receiptFile(binding, targetKey) {
  const tenant = (binding?.tenant ?? 'offline').replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(root, tenant, (binding?.module ?? 'module') + '.' + targetKey.replace(/[^A-Za-z0-9_+]/g, '_') + '.' + randomUUID() + '.json');
}

// run: execute each prepared scenario through the ORIGINAL entry. Live only: it needs the secure login window and one
// live session per binding, which the HARD RULES of this build forbid. With an injected worker (tests) it runs the
// worker; otherwise it returns the exact live plan without touching the network.
export async function runNativeEntry(input, readers, { worker, login } = {}) {
  const prepared = await prepareNativeEntry({ ...input, persist: false }, readers);
  if (!prepared.ok) return prepared;
  if (!worker || !login) {
    return { ok: false, state: 'needs-live', prepared,
      livePlan: [
        'Open the secure app-user sign-in window for ' + (readers.binding?.app ?? prepared.entry.name) + ' (debug-app-user-odc.mjs).',
        'Bind one live session to the entry ' + prepared.entry.name + ' (' + prepared.entry.entryKind + ').',
        'For each of the ' + prepared.scenariosValidated + ' scenario(s): call the original entry with the bound inputs through the native host/transport, observe outputs/exception' + (input.trace && input.trace !== 'none' ? '/trace' : '') + ', one send.',
        'Filter private values from every output; confirm cleanup and release the session.',
      ] };
  }
  // Effects gate, before the login window: every effect class prepare reported must be acknowledged by the caller.
  const missing = prepared.needs.acknowledgeEffects.filter(effect => !(input.acknowledgeEffects ?? []).includes(effect));
  if (missing.length) return { ok: false, state: 'effects-not-acknowledged', missing, entry: prepared.entry,
    message: 'run may cause ' + missing.join(', ') + '; pass acknowledgeEffects with these classes to run in DEV' };
  const session = await login(readers.binding);
  const results = [];
  try {
    for (const scenario of prepared.scenarios ?? []) {
      results.push(await worker.invoke({ session, entry: prepared.entry, path: prepared.path, bindings: prepared.bindings, scenario, trace: input.trace ?? 'none' }));
    }
  } finally { await worker.dispose?.().catch(() => {}); await session?.release?.().catch(() => {}); }
  return { ok: results.every(r => r.ok), state: 'answered', entry: prepared.entry, results };
}

export function statusNativeEntry(binding, { dir = root } = {}) {
  const tenant = (binding?.tenant ?? 'offline').replace(/[^A-Za-z0-9_.-]/g, '_');
  const folder = path.join(dir, tenant);
  if (!fs.existsSync(folder)) return { ok: true, receipts: [] };
  const files = fs.readdirSync(folder).filter(f => f.endsWith('.json')).map(f => path.join(folder, f));
  const latest = files.map(f => ({ f, at: fs.statSync(f).mtimeMs })).sort((a, b) => b.at - a.at).slice(0, 10);
  return { ok: true, receipts: latest.map(({ f }) => { try { const r = read(f); return { path: f, op: r.op, at: r.at, state: r.prepared?.state ?? r.state ?? null }; } catch { return { path: f, error: 'unreadable' }; } }) };
}
