// ODC Timer wake through an existing published client/server caller. The native
// generated Timer signature schedules work; the Timer action is never invoked.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { actionModel, scopeRoots, traceWindow } from './debug-wrapper.mjs';
import { classifyEffects } from './debug-odc-native-run.mjs';
import { runOdcOriginalBackground } from './debug-odc-workflow-run.mjs';

const KEY = /^[A-Za-z0-9_+]{22}$/;
const fail = code => { throw new Error('debug_odc_timer_wake_' + code); };
const one = (rows, code) => { if (rows.length !== 1) fail(code); return rows[0]; };
const unproved = { appUserIdentityProved: false, rolesProved: false, propagationProved: false,
  requestOwnershipProved: false, instanceCorrelationProved: false, executionCompleted: false, valuesComplete: false };
function complete(node) {
  if (!node || !Array.isArray(node.children) || node.childrenOmitted !== 0 || node.childrenTotal !== node.children.length ||
      Object.keys(node.propertyErrors ?? {}).length || Object.keys(node.propertiesOmitted ?? {}).length || node.propertiesMissing?.length)
    fail('model_projection_incomplete');
  node.children.forEach(complete);
}
export function nativeOdcTimerWake(timer) {
  complete(timer);
  const action = timer.propertyReferences?.Action;
  if (timer.kind !== 'Timer' || !KEY.test(timer.key ?? '') || action?.kind !== 'ServerAction' || !KEY.test(action.key ?? '') ||
      /^Reference:/.test(timer.path ?? '') || /^Reference:/.test(action.path ?? '')) fail('native_binding_invalid');
  // This ODC SDK exposes WakeTimerAction as the Timer's owned ActionSignature
  // child, unlike O11's additional property reference. No name/URL inference.
  const signature = one(timer.children.filter(c => c.kind === 'ActionSignature' && c.key === timer.key + '.#WakeTimer'), 'signature_unavailable');
  if (signature.children.length) fail('native_signature_has_inputs');
  return { timerKey: timer.key, name: timer.name, actionKey: action.key, wakeActionKey: signature.key, wakePath: signature.path };
}

export async function prepareOdcTimerWake(input, readers, { prepareEntry }) {
  if (input.contextMode !== 'native-background' || input.launch?.contextMode !== 'app-user') fail('explicit_launch_context_required');
  if (input.workflow || input.context !== undefined || input.scenarios !== undefined || input.inputs !== undefined ||
      !input.launch.inputs || Array.isArray(input.launch.inputs) || Object.keys(input.launch.inputs).length) fail('timer_has_no_direct_inputs');
  const source = readers.sourceContract;
  if (!source || !/^[a-f0-9]{64}$/i.test(source.sha256 ?? '') || createHash('sha256').update(fs.readFileSync(source.path ?? source.file)).digest('hex') !== source.sha256.toLowerCase()) fail('published_source_changed');
  const requested = await readers.resolveTarget(input.action);
  if (!['Timer', 'ServerAction'].includes(requested?.kind) || requested.producerTarget || /^Reference:/.test(requested.path ?? '')) fail('owned_target_required');
  let timerTree;
  if (requested.kind === 'Timer') timerTree = await readers.tree('@' + requested.key);
  else {
    const timers = [];
    for (const row of await readers.list('Timer')) {
      const candidate = await readers.properties('@' + row.key);
      if (candidate.propertyReferences?.Action?.key === requested.key) timers.push(candidate.key);
    }
    timerTree = await readers.tree('@' + one(timers, 'timer_ambiguous_or_absent'));
  }
  const timer = nativeOdcTimerWake(timerTree), action = await readers.resolveTarget('@' + timer.actionKey);
  if (action.kind !== 'ServerAction' || action.inputs.length) fail('timer_action_unqualified');
  const targetTree = await readers.tree('@' + timer.actionKey); complete(targetTree);
  const callers = [];
  for (const usage of await readers.usages(timer.wakeActionKey)) {
    const consumer = usage.consumer;
    if (consumer?.kind !== 'ExecuteServerActionNode') continue;
    const call = await readers.tree('@' + consumer.key); complete(call);
    if (call.propertyReferences?.Action?.key !== timer.wakeActionKey || call.propertyReferences.Action.path !== timer.wakePath) continue;
    const parent = consumer.path.split('/').slice(0, -1).join('/'), owner = await readers.resolveTarget(parent);
    if (owner?.kind === 'ServerAction' && !/^Reference:/.test(owner.path ?? '')) callers.push({ call, owner });
  }
  const { call, owner } = one(callers, 'original_caller_ambiguous_or_absent');
  const callerTree = await readers.tree('@' + owner.key); complete(callerTree);
  const start = one(callerTree.children.filter(n => n.kind === 'StartNode'), 'caller_flow_unqualified');
  const end = one(callerTree.children.filter(n => n.kind === 'EndNode'), 'caller_flow_unqualified');
  if (owner.inputs.length || call.children.some(n => n.kind === 'Argument') || start.propertyReferences?.Target?.key !== call.key ||
      call.propertyReferences?.Target?.key !== end.key || [start, call, end].some(n => n.properties?.IsDisabled !== 'False') ||
      callerTree.children.filter(n => /Node$/.test(n.kind) && n.kind !== 'CommentNode').length !== 3) fail('caller_flow_unqualified');
  const { launch: _launch, ...originalInput } = input;
  const emission = await prepareEntry({ ...originalInput, action: '@' + owner.key, contextMode: 'app-user', inputs: {}, trace: 'none', persist: false }, readers);
  if (!emission.ok || emission.adapter || !emission.entry || emission.scenarios.length !== 1 || Object.keys(emission.scenarios[0].inputs).length)
    fail('original_caller_entry_unavailable');
  const model = actionModel(targetTree), selected = traceWindow(model, input.window ?? {}), roots = scopeRoots(model, Number.MAX_SAFE_INTEGER);
  if (!KEY.test(model.start ?? '') || !selected.entries.length) fail('action_trace_unavailable');
  const effects = [...new Set([...emission.effects, ...classifyEffects(action.closureCalls ?? await readers.closure('@' + action.key)), 'timer-wake'])];
  const prepared = { ok: true, state: 'prepared', lane: 'odc', execution: 'native-entry', sourceContract: readers.sourceContract,
    action: { key: requested.key, name: requested.name, kind: requested.kind, inputs: [] }, entry: emission.entry,
    path: emission.path, callPath: emission.callPath, scenarios: emission.scenarios, scenariosValidated: 1, effects,
    adapter: { kind: 'timer-original-wake', executable: true, ...timer, callerKey: owner.key, callNodeKey: call.key,
      launchContext: 'app-user', activityContext: 'native-background', directActivityInvocation: false, ...unproved },
    tracePlan: { mode: input.trace ?? 'none', functionKey: action.key, nodeKeys: selected.entries, steps: selected.steps,
      depth: input.depth ?? 2, fullValues: input.trace === 'full', scopes: input.trace === 'full' ? { [action.key]: roots.slice(0, 60) } : {},
      omittedScopeRoots: Math.max(0, roots.length - 60), observationSeconds: Math.min(60, input.timeoutSeconds ?? 30), ...unproved },
    needs: { login: 'secure app-user sign-in for original Timer caller', contextMode: 'native-background', launchContextMode: 'app-user',
      words: true, acknowledgeEffects: effects, inputContract: 'launch.inputs must be empty for the native Timer wake' },
    assumptions: ['The original wake response and background function frames do not establish request ownership or Timer execution completion'] };
  Object.defineProperty(prepared, 'emission', { value: emission, enumerable: false });
  return prepared;
}

export function runOdcTimerWake(input, prepared, readers, services = {}) {
  if (prepared.adapter?.kind !== 'timer-original-wake') fail('unprepared');
  return runOdcOriginalBackground(input, prepared, readers, services);
}
