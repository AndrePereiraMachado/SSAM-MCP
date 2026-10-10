// Deterministic SSAM Debug REST wrapper: what lets a server action without an external entry (private actions,
// public server actions, service actions) be called with chosen inputs and traced like any exposed method.
// POST https://<runtime>/<Module>/rest/SSAMDebug/<Action>, header X-SSAM-Debug-Token, body = JSON of the action
// inputs by name, answer = JSON of its outputs by name. Every name below is derived from the action name only,
// so no session (and no LLM) ever chooses anything.
import { randomBytes } from 'node:crypto';

export const SERVICE = 'SSAMDebug';
export const TOKEN_HEADER = 'X-SSAM-Debug-Token';
export const APP_USER_HEADERS = Object.freeze({
  // Kept for transport compatibility; native O11 jobs consume the UTF-8 JSON fields below, not these headers.
  username: 'X-SSAM-Debug-Username', password: 'X-SSAM-Debug-Password', expectedUserId: 'X-SSAM-Debug-Expected-User',
});
export const APP_USER_FIELDS = Object.freeze({ username: 'SSAMDebugUsername', password: 'SSAMDebugPassword' });
export const COMMIT = { create: 'SSAM Debug REST Create', remove: 'SSAM Debug REST Remove' };
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,120}$/;

export const newToken = () => randomBytes(24).toString('hex');
export function names(action) {
  if (!NAME.test(action)) throw new Error('debug_wrapper_action_name_unsupported');
  return { method: action, request: `SSAMDebug_${action}_Request`, response: `SSAMDebug_${action}_Response`,
    path: `/rest/${SERVICE}/${action}`, auth: 'SSAMDebugAuthorized', deserialize: 'SSAMDebugInputs', call: 'SSAMDebugCall',
    outputs: 'SSAMDebugOutputs', serialize: 'SSAMDebugSerialize', token: 'SSAMDebugToken', body: 'SSAMDebugBody', result: 'SSAMDebugResult' };
}
export const wrapperUrl = (runtimeUrl, module, action) => new URL(runtimeUrl).origin + '/' + module + names(action).path;

// A parameter type for the job: basic types by name, every other type by the exact key of its native element.
export function jobType(parameter) {
  if (parameter.jobType) return parameter.jobType; // native type name chosen by SSAM (context inputs)
  const ref = parameter.dataTypeRef;
  const basicName = ref?.label || ref?.name;
  if (ref?.kind === 'BasicType' && /^[A-Za-z ]+$/.test(basicName ?? '')) return basicName;
  if (ref?.key) return '@' + ref.key;
  throw new Error('debug_wrapper_type_unresolved:' + parameter.name);
}

// Signature and flow graph of one action from its inspect tree (studio_inspect / ssam inspect, depth >= 2).
const nodeKind = kind => /Node$/.test(kind) || ['Aggregate', 'AggregateNode', 'AdvancedSql', 'SqlNode'].includes(kind);
export function actionModel(tree) {
  const children = tree.children ?? [];
  const parameter = c => ({ name: c.name, key: c.key, dataType: c.properties?.DataType ?? null, dataTypeRef: c.propertyReferences?.DataType ?? null, mandatory: c.properties?.IsMandatory === 'True' });
  const nodes = children.filter(c => nodeKind(c.kind)).map(c => {
    const targets = new Set();
    for (const [name, ref] of Object.entries(c.propertyReferences ?? {})) if (/Target$/.test(name) && ref?.key) targets.add(ref.key);
    for (const connector of c.children ?? []) if (connector.kind === 'ActionConnector' && connector.propertyReferences?.Target?.key) targets.add(connector.propertyReferences.Target.key);
    return { key: c.key, kind: c.kind, name: c.properties?.Name || c.modelName || '', label: c.label ?? '', targets: [...targets] };
  });
  const keys = new Set(nodes.map(n => n.key));
  for (const n of nodes) n.targets = n.targets.filter(k => keys.has(k));
  return {
    name: tree.name, key: tree.key, kind: tree.kind, public: tree.properties?.Public === 'True',
    inputs: children.filter(c => c.kind === 'InputParameter').map(parameter),
    outputs: children.filter(c => c.kind === 'OutputParameter').map(parameter),
    locals: children.filter(c => c.kind === 'LocalVariable').map(parameter),
    nodes, start: nodes.find(n => n.kind === 'StartNode')?.key ?? null,
  };
}

// Variable roots the tracer dumps at every node of this action: parameters, locals and the named nodes that
// expose outputs (<Node>.<Output>). A name that is not in scope at a node answers "-unavailable-", nothing more.
export function scopeRoots(model, max = 60) {
  const outputNodes = model.nodes.filter(n => n.name && NAME.test(n.name) && !['StartNode', 'EndNode', 'IfNode', 'AssignNode', 'RaiseExceptionNode', 'SwitchNode', 'CommentNode'].includes(n.kind)).map(n => n.name);
  return [...new Set([...model.inputs, ...model.locals, ...model.outputs].map(p => p.name).concat(outputNodes))].filter(n => NAME.test(n)).slice(0, max);
}

// Window: breakpoints at every node `before` steps upstream of `around` (or the start of the action), so that
// stepping `before + 1 + after` visits covers the region. Paths shorter than `before` start at the Start node.
export function traceWindow(model, { around, before = 0, after = 300 } = {}) {
  const anchor = around ?? model.start;
  if (!anchor || !model.nodes.some(n => n.key === anchor)) throw new Error('debug_trace_anchor_not_in_action');
  const incoming = new Map(model.nodes.map(n => [n.key, []]));
  for (const n of model.nodes) for (const t of n.targets) incoming.get(t)?.push(n.key);
  let frontier = new Set([anchor]); const entries = new Set(); const seen = new Set([anchor]);
  for (let d = 0; d < before; d++) {
    const next = new Set();
    for (const k of frontier) {
      const preds = incoming.get(k) ?? [];
      if (!preds.length) entries.add(k); // reached the Start (or an exception handler) before the full distance
      for (const p of preds) if (!seen.has(p)) { seen.add(p); next.add(p); }
    }
    frontier = next; if (!frontier.size) break;
  }
  for (const k of frontier) entries.add(k);
  return { anchor, entries: [...entries], steps: Math.min(2000, before + 1 + after) };
}

// The job that creates (or extends) the wrapper for the given actions. ODC REST methods are born with Start/End.
export function createJob({ lane = 'odc', actions, token, description = 'SSAM Debug REST wrapper', appUser = false, loginRef }) {
  if (!/^[a-f0-9]{48}$/.test(token)) throw new Error('debug_wrapper_token_invalid');
  if (!actions?.length || new Set(actions.map(a => a.name)).size !== actions.length) throw new Error('debug_wrapper_actions_required');
  if (typeof appUser !== 'boolean') throw new Error('debug_wrapper_app_user_option_invalid');
  if (appUser) {
    if (!['odc', 'o11'].includes(lane)) throw new Error('debug_wrapper_app_user_lane_invalid');
    if (actions.some(a => a.call || a.copy)) throw new Error('debug_wrapper_app_user_requires_original_action');
    if (lane === 'o11' && actions.some(a => a.inputs.some(p => Object.values(APP_USER_FIELDS).some(name => name.toLowerCase() === p.name.toLowerCase()))))
      throw new Error('debug_wrapper_app_user_reserved_input');
    // The caller resolves the published login signature in this base/provider. No name lookup, import, or
    // System.Login(UserId) fallback: the exact action must authenticate Username/Password/RememberLogin.
    if (lane === 'o11' && !/^@[A-Za-z0-9_+]{22}$/.test(loginRef ?? '')) throw new Error('debug_wrapper_app_user_login_ref_required');
    if (lane === 'odc' && loginRef != null) throw new Error('debug_wrapper_app_user_odc_login_not_server_side');
  }
  const ops = [
    { op: 'create', parent: '@espace', type: 'IRestService', name: SERVICE, as: '$svc' },
    { op: 'set', target: '$svc', prop: 'Description', value: 'Temporary SSAM debug entry: created and removed automatically by SSAM debug sessions (' + COMMIT.create + ' / ' + COMMIT.remove + ').' },
  ];
  actions.forEach((action, i) => {
    const n = names(action.name), id = s => '$' + s + i;
    const structure = (name, alias, params, filler) => {
      ops.push({ op: 'create', parent: '@espace', type: 'IStructure', name, as: id(alias) });
      ops.push({ op: 'set', target: id(alias), prop: 'Description', value: description + ' for ' + action.name });
      const list = params.length ? params : [{ name: filler, dataTypeRef: { kind: 'BasicType', label: 'Boolean' } }];
      list.forEach((p, j) => {
        ops.push({ op: 'create', parent: id(alias), type: 'IStructureAttribute', name: p.name, as: id(alias + 'a' + j) });
        ops.push({ op: 'set', target: id(alias + 'a' + j), prop: 'DataType', value: jobType(p) });
      });
    };
    // action.call: call a debug copy (user context) instead of the action, with extra inputs carried by the request.
    const extra = action.call?.inputs ?? [];
    // The private O11 HTTP worker adds these UTF-8 body values only at send time. They are never literals in
    // the job/candidate, and unlike HTTP ByteString headers they accept every Unicode password character.
    const credentials = appUser && lane === 'o11'
      ? Object.values(APP_USER_FIELDS).map(name => ({ name, jobType: 'Text' })) : [];
    structure(n.request, 'req', [...action.inputs, ...extra, ...credentials], 'SSAMDebugNoInputs');
    structure(n.response, 'res', action.outputs, 'SSAMDebugCompleted');
    const m = id('m');
    ops.push(
      { op: 'create', parent: '$svc', type: 'IRestServiceAction', name: n.method, as: m },
      { op: 'set', target: m, prop: 'HTTPMethod', value: 'POST' },
      { op: 'set', target: m, prop: 'URLPath', value: '/' + n.method },
      { op: 'set', target: m, prop: 'Description', value: description + ': calls ' + action.name + ' with the JSON body and answers the JSON of its outputs.' },
      { op: 'create', parent: m, type: 'IRestServiceActionInput', name: n.token, as: id('tok') },
      { op: 'set', target: id('tok'), prop: 'DataType', value: 'Text' },
      { op: 'set', target: id('tok'), prop: 'ReceiveIn', value: 'Header' },
      { op: 'set', target: id('tok'), prop: 'ReceiveAs', value: TOKEN_HEADER },
      { op: 'create', parent: m, type: 'IRestServiceActionInput', name: n.body, as: id('body') },
      { op: 'set', target: id('body'), prop: 'DataType', value: 'Text' },
      { op: 'set', target: id('body'), prop: 'ReceiveIn', value: 'Body' },
      { op: 'create', parent: m, type: 'IRestServiceActionOutput', name: n.result, as: id('out') },
      { op: 'set', target: id('out'), prop: 'DataType', value: 'Text' },
      { op: 'set', target: id('out'), prop: 'SendIn', value: 'Body' },
      { op: 'create', parent: m, type: 'ILocalVariable', name: n.outputs, as: id('local') },
      { op: 'set', target: id('local'), prop: 'DataType', value: n.response },
      { op: 'create', parent: m, type: 'IIfNode', name: n.auth, as: id('if') },
      { op: 'set', target: id('if'), prop: 'Condition', value: `${n.token} = "${token}"` },
      { op: 'create', parent: m, type: 'IJSONDeserializeNode', name: n.deserialize, as: id('jd') },
      { op: 'set', target: id('jd'), prop: 'DataType', value: n.request },
      { op: 'set', target: id('jd'), prop: 'JSONString', value: n.body },
      { op: 'create', parent: m, type: 'IExecuteServerActionNode', name: n.call, as: id('call') },
      { op: 'set', target: id('call'), prop: 'Action', value: action.call?.ref ?? '@' + action.key },
    );
    if (appUser) {
      const header = (name, alias, receiveAs, type = 'Text') => ops.push(
        { op: 'create', parent: m, type: 'IRestServiceActionInput', name, as: id(alias) },
        { op: 'set', target: id(alias), prop: 'DataType', value: type },
        { op: 'set', target: id(alias), prop: 'ReceiveIn', value: 'Header' },
        { op: 'set', target: id(alias), prop: 'ReceiveAs', value: receiveAs },
        { op: 'set', target: id(alias), prop: 'IsMandatory', value: true });
      if (lane === 'o11') {
        ops.push(
          { op: 'create', parent: m, type: 'IExecuteServerActionNode', name: 'SSAMDebugLogin', as: id('login') },
          { op: 'set', target: id('login'), prop: 'Action', value: loginRef },
          { op: 'set', target: id('login') + '/Username', prop: 'Value', value: `${n.deserialize}.Data.${APP_USER_FIELDS.username}` },
          { op: 'set', target: id('login') + '/Password', prop: 'Value', value: `${n.deserialize}.Data.${APP_USER_FIELDS.password}` },
          { op: 'set', target: id('login') + '/RememberLogin', prop: 'Value', value: 'False' });
      } else {
        // ODC receives its runtime bearer as Authorization on the HTTP request; it is never a model input.
        // User Identifier is the native text identifier already referenced by the app, so no guessed conversion.
        header('SSAMDebugExpectedUserId', 'expectedUser', APP_USER_HEADERS.expectedUserId, 'User Identifier');
      }
      ops.push(
        { op: 'create', parent: m, type: 'IIfNode', name: 'SSAMDebugIdentityValid', as: id('identity') },
        { op: 'set', target: id('identity'), prop: 'Condition', value: lane === 'odc'
          ? 'GetUserId() <> NullTextIdentifier() and GetUserId() = SSAMDebugExpectedUserId'
          : 'GetUserId() <> NullIdentifier()' },
        // A safe response avoids referencing a platform exception that has not been resolved in the base.
        // Both failed gates end here; no default/anonymous identity can reach the original action.
        { op: 'create', parent: m, type: 'IAssignNode', name: 'SSAMDebugAuthenticationRequired', as: id('authFailure') },
        { op: 'set', target: id('authFailure'), prop: 'Label', value: 'SSAMDebugAuthenticationRequired' },
        { op: 'create', parent: id('authFailure'), type: 'IAssignment', as: id('authFailureValue') },
        { op: 'set', target: id('authFailureValue'), prop: 'Variable', value: n.result },
        { op: 'set', target: id('authFailureValue'), prop: 'Value', value: '"{""error"":""debug_app_user_authentication_required""}"' });
    }
    for (const p of [...action.inputs, ...extra]) ops.push({ op: 'set', target: id('call') + '/' + p.name, prop: 'Value', value: `${n.deserialize}.Data.${p.name}` });
    ops.push({ op: 'create', parent: m, type: 'IAssignNode', name: 'SSAMDebugSetOutputs', as: id('as') },
      { op: 'set', target: id('as'), prop: 'Label', value: 'SSAMDebugSetOutputs' });
    const assigned = action.outputs.length ? action.outputs.map(p => [`${n.outputs}.${p.name}`, `${n.call}.${p.name}`]) : [[`${n.outputs}.SSAMDebugCompleted`, 'True']];
    assigned.forEach(([variable, value], j) => ops.push(
      { op: 'create', parent: id('as'), type: 'IAssignment', as: id('as' + j) },
      { op: 'set', target: id('as' + j), prop: 'Variable', value: variable },
      { op: 'set', target: id('as' + j), prop: 'Value', value }));
    ops.push(
      { op: 'create', parent: m, type: 'IJSONSerializeNode', name: n.serialize, as: id('js') },
      { op: 'set', target: id('js'), prop: 'Data', value: n.outputs },
      // Every output in the answer, defaults included (seen live: IsValid=False was omitted without it).
      { op: 'set', target: id('js'), prop: 'SerializeDefaultValues', value: true },
      { op: 'create', parent: m, type: 'IAssignNode', name: 'SSAMDebugSetResult', as: id('res2') },
      { op: 'set', target: id('res2'), prop: 'Label', value: 'SSAMDebugSetResult' },
      { op: 'create', parent: id('res2'), type: 'IAssignment', as: id('res2a') },
      { op: 'set', target: id('res2a'), prop: 'Variable', value: n.result },
      // ODC uses JSON. The native O11 output is Json (proved by the current operational model Verify);
      // the pre-existing O11 spelling remains confined to the legacy opt-out for compatibility.
      { op: 'set', target: id('res2a'), prop: 'Value', value: `${n.serialize}.${lane === 'odc' ? 'JSON' : appUser ? 'Json' : 'JSONText'}` },
      { op: 'link', from: m + '/#IStartNode[1]', to: id('if') },
      { op: 'link', from: id('if'), connector: 'TrueTarget', to: id('jd') },
      { op: 'link', from: id('if'), connector: 'FalseTarget', to: appUser ? id('authFailure') : m + '/#IEndNode[1]' },
      { op: 'link', from: id('jd'), to: appUser ? id(lane === 'o11' ? 'login' : 'identity') : id('call') },
      { op: 'link', from: id('call'), to: id('as') },
      { op: 'link', from: id('as'), to: id('js') },
      { op: 'link', from: id('js'), to: id('res2') },
      { op: 'link', from: id('res2'), to: m + '/#IEndNode[1]' },
      ...(!appUser ? [{ op: 'layout', target: m }] : []),
      { op: 'get', target: id('call') },
    );
    if (appUser) {
      if (lane === 'o11') ops.push({ op: 'link', from: id('login'), to: id('identity') });
      ops.push(
        { op: 'link', from: id('identity'), connector: 'TrueTarget', to: id('call') },
        { op: 'link', from: id('identity'), connector: 'FalseTarget', to: id('authFailure') },
        { op: 'link', from: id('authFailure'), to: m + '/#IEndNode[1]' });
      // Lay out the fully linked flow, including the authentication branches.
      ops.push({ op: 'layout', target: m });
    }
  });
  return { description: `${COMMIT.create}: ${actions.map(a => a.name).join(', ')} (${lane})`, expectValid: true, ops };
}

// Removal: everything the creation added, by its deterministic names.
export function removeJob({ lane = 'odc', actions }) {
  const ops = [{ op: 'delete', target: 'IRestService:' + SERVICE }];
  // User-context copies were only called by the wrapper: no consumer is left once the service is gone.
  for (const a of actions.filter(a => a.copy)) ops.push({ op: 'delete', target: 'IServerAction:' + a.copy });
  // Typing the JSON nodes by a structure materializes module-level derived types "<Structure> Record" and
  // "<Structure> Record List" (seen in the candidate's usages); they go first, then the structure has no consumer.
  for (const a of actions) {
    const n = names(a.name);
    for (const structure of [n.request, n.response]) ops.push({ op: 'delete', target: 'IListType:' + structure + ' Record List' },
      { op: 'delete', target: 'IAnonymousStructure:' + structure + ' Record' }, { op: 'delete', target: 'IStructure:' + structure });
  }
  return { description: `${COMMIT.remove}: ${actions.map(a => a.name).join(', ')} (${lane})`, expectValid: true, ops };
}
