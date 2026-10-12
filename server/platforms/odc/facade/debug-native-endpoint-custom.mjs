// Custom REST authentication contract, read from the RestService OnAuthentication
// subtree of the SAME hash-bound published capture. Only literal header names read
// through the native request-header API qualify (O11 HTTPRequestHandler.GetRequestHeader, HeaderName).
// Developer logic, not SSAM, decides acceptance; values come only from a private dialog.
const fail = code => { throw new Error('debug_native_endpoint_custom_authentication_' + code); };
const SHA = /^[a-f0-9]{64}$/i, KEY = /^[A-Za-z0-9_+]{22}$/;
// A plain token literal: no concatenation, variable, escape or whitespace.
const LITERAL = /^"([A-Za-z][A-Za-z0-9-]{0,63})"$/;
const RESERVED = /^(?:host|connection|content-length|content-type|content-encoding|transfer-encoding|te|trailer|upgrade|expect|keep-alive|accept|accept-encoding|accept-charset|user-agent|origin|referer|forwarded|x-forwarded-[a-z-]*|proxy-[a-z-]*)$/i;
const REQUEST_API = 'HTTPRequestHandler';
// The header name input as the published capture resolves it (InputParameterSignature:HeaderName).
const HEADER_NAME = 'Reference:HTTPRequestHandler/ServerActionSignature:GetRequestHeader/InputParameterSignature:HeaderName';
// The only calls accepted outside the request-header API: the native logins (callsLogin).
const LOGIN = { '(System)': ['Login', 'LoginPassword'], Users: ['User_Login'] };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function complete(node) {
  if (!object(node) || !Array.isArray(node.children) || node.childrenOmitted !== 0 ||
      node.childrenTotal !== node.children.length || Object.keys(node.propertyErrors ?? {}).length ||
      Object.keys(node.propertiesOmitted ?? {}).length || node.propertiesMissing?.length) fail('model_incomplete');
  for (const child of node.children) complete(child);
}
const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);

// The called action as the capture names it: Reference:<Module>/<Kind>ActionSignature:<Name>.
// A local action is opaque here: its request reads are outside this subtree.
function callee(node) {
  const reference = node.propertyReferences?.Action, path = reference?.path;
  const external = /^Reference:(\(System\)|[A-Za-z_][A-Za-z0-9_]*)\/[A-Za-z]*ActionSignature:([A-Za-z_][A-Za-z0-9_]*)$/.exec(path ?? '');
  if (external) return { module: external[1], action: external[2] };
  if (typeof path === 'string' && path) return { module: null, action: reference.name ?? null };
  fail('call_unresolved');
}
const parameterName = argument => argument.propertyReferences?.Parameter?.name ?? /:([A-Za-z_]\w*)$/.exec(argument.properties?.Parameter ?? '')?.[1];
// One HeaderName argument bound to GetRequestHeader whose Value is a plain literal; the child
// Expression the real reading carries must restate that same Text literal.
function headerLiteral(node) {
  const names = node.children.filter(child => child.kind === 'Argument' && parameterName(child) === 'HeaderName');
  if (names.length !== 1) return null;
  const [argument] = names, value = argument.properties?.Value ?? '', path = argument.propertyReferences?.Parameter?.path;
  if (path !== undefined && path !== HEADER_NAME) return null;
  const expressions = argument.children.filter(child => child.kind === 'Expression');
  if (expressions.length !== argument.children.length || expressions.length > 1) return null;
  const [expression] = expressions, type = expression?.properties?.Type;
  if (expression && (expression.properties?.Text !== value || type !== undefined && type !== 'BasicType:Text')) return null;
  return LITERAL.exec(value);
}

export function nativeCustomAuthenticationContract({ binding, model }) {
  if (!object(binding) || !SHA.test(binding.sourceSha256 ?? '') || model?.schema !== 'ssam-reading/1' || model.model !== binding.module ||
      model.sourceSha256?.toLowerCase() !== binding.sourceSha256.toLowerCase() || model.tree?.kind !== 'RestService' ||
      model.tree.properties?.Authentication !== 'Custom') fail('model_binding_invalid');
  complete(model.tree);
  const service = model.tree, flows = service.children.filter(node => node.kind === 'RestServiceAuthenticationFlow');
  if (!flows.length) fail('callback_missing');
  if (flows.length > 1) fail('callback_ambiguous');
  const flow = flows[0], type = flow.properties?.AuthenticationCallbackType;
  if (!KEY.test(flow.key ?? '') || !KEY.test(service.key ?? '') || type !== undefined && type !== 'Custom') fail('callback_type_mismatch');
  // ODC's request-header API inside OnAuthentication is not qualified yet.
  if (binding.lane !== 'o11') fail('request_header_api_unqualified');
  const headers = new Map(); let callsLogin = false;
  for (const node of descendants(flow)) {
    if (/Input$/.test(node.kind) || node.kind === 'InputParameter') fail('callback_input_unsupported');
    if (!/^Execute[A-Za-z]*ActionNode$/.test(node.kind)) continue;
    const { module, action } = callee(node);
    if (module === REQUEST_API) {
      if (/cookie/i.test(action)) fail('cookie_unsupported');
      if (action !== 'GetRequestHeader') fail('query_or_body_unsupported');
      const literal = headerLiteral(node);
      if (!literal) fail('header_name_computed');
      const name = literal[1], lower = name.toLowerCase();
      if (lower === 'cookie' || lower === 'set-cookie') fail('cookie_unsupported');
      // The scheme and token format inside Authorization are developer logic, not a header contract.
      if (lower === 'authorization' || lower === 'proxy-authorization') fail('authorization_scheme_ambiguous');
      if (RESERVED.test(name)) fail('header_unsupported');
      if (!headers.has(lower)) headers.set(lower, name);
    } else if (LOGIN[module]?.includes(action)) callsLogin = true;
    else fail('call_unqualified');
  }
  if (!headers.size) fail('header_missing');
  if (headers.size > 8) fail('header_limit');
  // Optional branches are developer logic; the dialog asks for every header the callback reads.
  return { scheme: 'header', headers: [...headers.values()].map(name => ({ name, required: true })), callsLogin,
    callbackKey: flow.key, serviceKey: service.key };
}

// One argument for the named parameter whose child Expression (if any) restates Value; else null.
function argumentText(node, parameter) {
  const found = node.children.filter(child => child.kind === 'Argument' && parameterName(child) === parameter);
  if (found.length !== 1) return null;
  const value = found[0].properties?.Value, expressions = found[0].children.filter(child => child.kind === 'Expression');
  if (typeof value !== 'string' || expressions.length !== found[0].children.length || expressions.length > 1 ||
      expressions.length && expressions[0].properties?.Text !== value) return null;
  return value.trim();
}
// Identifiers of an expression outside its "..." literals (dotted paths keep their first segment).
const identifiers = text => typeof text !== 'string' ? [] : text.replace(/"(?:[^"]|"")*"/g, ' ').match(/(?<![\w.])[A-Za-z_]\w*/g) ?? [];
const references = (nodes, names) => nodes.some(node => Object.entries(node.properties ?? {}).some(([key, value]) => !['Action', 'Parameter'].includes(key) && identifiers(value).some(id => names.includes(id))) ||
  Object.values(node.propertyReferences ?? {}).some(ref => names.includes(ref?.name) && /AuthenticationFlowInput/.test(ref?.kind ?? '')));
const basicFail = code => { throw new Error('debug_native_endpoint_basic_' + code); };
// The request-API calls that read a client value, with the P08 reason; response writers (SetStatusCode, AddHeader,
// SetCookie) and request metadata (GetIP, GetRequestURL) read no credential and return null.
function requestRead(action) {
  if (/^(?:Get|Read)[A-Za-z]*Cookie/i.test(action)) return 'cookie_unsupported';
  if (action === 'GetRequestHeader') return 'header';
  if (/^Get(?:Request)?Headers?$/i.test(action)) return 'header_name_computed';
  if (/^Get(?:Request)?(?:Content|Body|Form|Query|Parameter)/i.test(action)) return 'query_or_body_unsupported';
  return null;
}
const IDENTIFIER = /^[A-Za-z_]\w*$/;

// Basic OnAuthentication (Studio-generated Username/Password inputs). ODC never calls User_Login: developer logic.
// O11: one <provider>.User_Login bound to both inputs by identifier is the platform login; no login is developer logic.
export function readBasicAuthenticationContract(serviceTree, lane) {
  if (!object(serviceTree) || serviceTree.kind !== 'RestService' || serviceTree.properties?.Authentication !== 'Basic' || !['o11', 'odc'].includes(lane)) basicFail('model_invalid');
  try { complete(serviceTree); } catch { basicFail('callback_missing'); }
  const flows = serviceTree.children.filter(node => node.kind === 'RestServiceAuthenticationFlow');
  const flow = flows.length === 1 ? flows[0] : null, inputs = flow?.children.filter(node => node.kind === 'RestServiceAuthenticationFlowInput') ?? [];
  if (!flow || flow.properties?.AuthenticationCallbackType !== 'Basic' || !KEY.test(flow.key ?? '') || !KEY.test(serviceTree.key ?? '') ||
      inputs.length !== 2 || inputs.some(input => !IDENTIFIER.test(input.name ?? '')) || inputs[0].name === inputs[1].name) basicFail('callback_missing');
  const inputNames = inputs.map(input => input.name), body = descendants(flow).filter(node => !inputs.includes(node));
  const result = { scheme: 'basic', validation: 'developer-logic', inputNames, credentialsReferencedInFlow: references(body, inputNames),
    callbackKey: flow.key, serviceKey: serviceTree.key };
  const calls = body.filter(node => /^Execute[A-Za-z]*ActionNode$/.test(node.kind)).map(node => { try { return { node, ...callee(node) }; } catch { return { node, unresolved: true }; } });
  // Another credential read beside the pair (request headers, cookies, parameters) is not a Basic contract.
  if (calls.some(call => call.module === REQUEST_API && requestRead(call.action))) basicFail('validation_ambiguous');
  // Local actions are opaque here: a login inside one is not read, so the result names them for the limitation.
  const local = calls.filter(call => !call.unresolved && call.module === null).map(call => call.action ?? '?');
  if (local.length) result.localActions = [...new Set(local)];
  if (lane === 'odc') return result;
  // An unresolved call could hide a login: the credential source would be a guess.
  if (calls.some(call => call.unresolved)) basicFail('validation_ambiguous');
  const logins = calls.filter(call => call.action === 'User_Login' && call.module), otherLogins = calls.filter(call => LOGIN['(System)'].includes(call.action) && call.module === '(System)');
  if (!logins.length && !otherLogins.length) { if (!result.credentialsReferencedInFlow) basicFail('validation_ambiguous'); return result; }
  if (logins.length !== 1 || otherLogins.length) basicFail('validation_ambiguous');
  const username = argumentText(logins[0].node, 'Username'), password = argumentText(logins[0].node, 'Password');
  if (!inputNames.includes(username) || !inputNames.includes(password) || username === password) basicFail('validation_ambiguous');
  return { ...result, validation: 'platform-login', loginProvider: logins[0].module };
}

// Authentication=None guarded by a literal request header: O11 GetRequestHeader (P08 rule) in OnRequest or the method
// flow, or ListIndexOf/ListFilter/ListAny over the OnRequest Request.Headers with a literal Name comparison. Returns null
// without a guard (explicit-anonymous); a credential read SSAM cannot reproduce is refused with the P08 reason codes.
const HEADER_LISTS = ['ListIndexOf', 'ListFilter', 'ListAny'];
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function readRequestHeaderGuard(serviceTree, entryKey, lane = 'o11') {
  if (!object(serviceTree) || serviceTree.kind !== 'RestService' || !KEY.test(serviceTree.key ?? '') || !['o11', 'odc'].includes(lane)) fail('model_binding_invalid');
  // The service's child list must be complete (an omitted OnRequest would hide a guard); only the OnRequest callback
  // and the target method are read, so an incomplete unrelated node does not refuse an anonymous endpoint.
  if (!Array.isArray(serviceTree.children) || serviceTree.childrenOmitted !== 0 || serviceTree.childrenTotal !== serviceTree.children.length) fail('model_incomplete');
  const actions = serviceTree.children.filter(node => node.kind === 'RestServiceAction' && node.key === entryKey);
  if (actions.length !== 1) fail('model_binding_invalid');
  const onRequest = serviceTree.children.filter(node => node.kind === 'RestServiceCallbackActionFlow' &&
    (node.properties?.CallbackType ?? node.name) === 'OnRequest');
  if (onRequest.length > 1) fail('callback_ambiguous');
  complete(actions[0]); if (onRequest.length) complete(onRequest[0]);
  const headers = new Map(); let source = null;
  const accept = (name, where) => {
    const lower = name.toLowerCase();
    if (lower === 'cookie' || lower === 'set-cookie') fail('cookie_unsupported');
    if (lower === 'authorization' || lower === 'proxy-authorization') fail('authorization_scheme_ambiguous');
    if (RESERVED.test(name)) fail('header_unsupported');
    if (!headers.has(lower)) headers.set(lower, name); source ??= where;
  };
  const scan = (flow, where) => {
    const requestInputs = where === 'OnRequest' ? flow.children.filter(node => node.kind === 'RestServiceCallbackActionFlowInput').map(node => node.name) : [];
    for (const node of descendants(flow)) {
      if (!/^Execute[A-Za-z]*ActionNode$/.test(node.kind)) continue;
      let called; try { called = callee(node); } catch { continue; } // Opaque: an unrecognized guard is answered 401, never a secret.
      const { module, action } = called;
      if (module === REQUEST_API) {
        const read = requestRead(action);
        if (!read) continue; // Writes the response or reads request metadata: no credential.
        if (read !== 'header' && read !== 'header_name_computed') fail(read);
        if (lane !== 'o11') fail('request_header_api_unqualified');
        if (read !== 'header') fail(read);
        const literal = headerLiteral(node);
        if (!literal) fail('header_name_computed');
        accept(literal[1], where);
      } else if (module === '(System)' && HEADER_LISTS.includes(action) && requestInputs.length) {
        const list = argumentText(node, 'List'), request = requestInputs.find(name => list?.startsWith(name + '.'));
        if (!request) continue; // A business list, not the callback request.
        if (list !== request + '.Headers') fail(/cookie/i.test(list) ? 'cookie_unsupported' : 'query_or_body_unsupported');
        const condition = new RegExp('^(?:' + escapeRegExp(request) + '\\.Headers\\.Current\\.)?Name\\s*=\\s*"([A-Za-z][A-Za-z0-9-]{0,63})"$').exec(argumentText(node, 'Condition') ?? '');
        if (!condition) fail('header_name_computed');
        accept(condition[1], where);
      }
    }
  };
  if (onRequest.length) scan(onRequest[0], 'OnRequest');
  scan(actions[0], 'method');
  if (!headers.size) return null;
  if (headers.size > 8) fail('header_limit');
  // A business header input with the guard's name would let request JSON replace the private value.
  if (actions[0].children.some(node => ['RestServiceActionInput', 'InputParameter'].includes(node.kind) && node.properties?.ReceiveIn === 'Header' &&
      headers.has(String(node.properties?.ReceiveAs || node.name).toLowerCase()))) fail('header_collision');
  return { native: 'None', protocol: 'header', source, headers: [...headers.values()].map(name => ({ name, required: true })),
    callbackKey: source === 'OnRequest' ? onRequest[0].key : null, serviceKey: serviceTree.key };
}
