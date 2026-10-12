// Private process for the original REST endpoint. The Basic credential is read
// from the same secure App User dialog vault used by the native runtime. It never
// appears in argv, a receipt, the parent's process or a public tool argument.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { privateAppUserVault, appUserBinding, sameAppUserTarget, endpointCredentialBinding, sameEndpointCredentialTarget } from './debug-app-user.mjs';
import { validatePrivateDescriptor, validateEndpointCredentialDescriptor, endpointCredentialRecordHeaders, endpointCredentialRecordValues, publicWrapperBody } from './debug-app-user-worker.mjs';
import { compileNativeRestEndpoint, buildNativeEndpointRequest, decodeNativeEndpointResponse } from './debug-native-endpoint.mjs';
import { compileNativeSoapEndpoint, buildNativeSoapRequest, decodeNativeSoapResponse } from './debug-native-endpoint-soap.mjs';
import { o11NativeDirectory } from './debug-o11-native-entry.mjs';
import { blockedBinding, bindingHash } from './debug-o11-native-run.mjs';

const fail = code => { throw new Error('debug_native_endpoint_' + code); };
const hash = value => createHash('sha256').update(value).digest('hex');
const GUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const worker = fileURLToPath(import.meta.url);
const publicError = error => /^debug_native_endpoint_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'debug_native_endpoint_execution_failed';

// Internal runner-to-worker contract. Interactive waits share the fixed native
// session deadline; neither a step nor a new scenario can extend that deadline.
export function nativeEndpointRequestBudget(input, now = Date.now()) {
  if (!Number.isInteger(input.timeoutSeconds) || input.timeoutSeconds < 1 || input.timeoutSeconds > 300) fail('invocation_invalid');
  if (input.inspectionExpiresAt === undefined) return input.timeoutSeconds * 1000;
  const deadline = Date.parse(input.inspectionExpiresAt), userDeadline = Date.parse(input.descriptor?.expiresAt);
  const anonymous = input.context === 'explicit-anonymous' && ['o11', 'odc'].includes(input.contract?.binding?.lane) && !input.descriptor;
  if ((!anonymous && (!['app-user', 'endpoint-credential'].includes(input.context) || !Number.isFinite(userDeadline) || deadline > userDeadline)) ||
      typeof input.inspectionExpiresAt !== 'string' || !Number.isFinite(deadline) ||
      deadline <= now || deadline - now > 600000) fail('inspection_deadline_invalid');
  return deadline - now;
}

// Kept for unqualified captures (former code as alias): qualified ODC Basic runs with an endpoint-credential basic record.
export const ODC_BASIC_LIMITATION = 'SSAM policy: this ODC Basic OnAuthentication is not qualified (a complete Basic callback with exactly two ' +
  'inputs and an OpenAPI http/basic scheme are required); the app-user password is discarded after Cognito SRP and is never an endpoint credential. ' +
  'This is not a platform limit.';
const BASIC_DEVELOPER_LIMITATION = 'Basic credentials are validated by developer logic in OnAuthentication; no app-user identity follows';
const TOKEN = /^[A-Za-z0-9_]{1,40}$/;

// Transport refusals from the hash-bound model (PX01 enums: HttpSecurity None/SSL, Authentication None/Basic/Custom).
// Client certificates have no HttpSecurity value in the evidenced Studios, so that refusal is SSAM policy.
export function nativeRestTransportRefusal(transport, authentication) {
  const base = { executable: false, appUserIdentityProved: false };
  if (transport?.internalAccess === 'Yes') return { ...base, error: 'debug_native_endpoint_internal_access_only', platformRestriction: true,
    evidence: 'model property InternalAccess=Yes', limitation: 'The service accepts only calls from the platform internal network; the SSAM caller is outside the platform internal network.' };
  if (transport?.httpSecurity != null && !['None', 'SSL'].includes(transport.httpSecurity)) return { ...base, error: 'debug_native_endpoint_client_certificate_unsupported',
    platformRestriction: false, policy: 'ssam', platformLimit: false,
    evidence: 'model property HttpSecurity=' + (TOKEN.test(String(transport.httpSecurity)) ? transport.httpSecurity : 'unrecognized'),
    limitation: 'SSAM policy: only HttpSecurity None or SSL is qualified; no client-certificate credential source exists. Not evidenced as a platform limit.' };
  if (transport?.authenticationCallbackType === 'OAuth2' || authentication !== undefined && !['None', 'Basic', 'Custom'].includes(authentication))
    return { ...base, error: 'debug_native_endpoint_exposed_oauth2_unqualified', platformRestriction: false, policy: 'ssam', platformLimit: false,
      evidence: transport?.authenticationCallbackType === 'OAuth2' ? 'model property AuthenticationCallbackType=OAuth2'
        : 'model property Authentication=' + (TOKEN.test(String(authentication)) ? authentication : 'unrecognized'),
      limitation: 'SSAM policy: an exposed OAuth2 or unknown authentication has no qualified credential source.' };
  return null;
}
// For a prepare receipt when acquisition refused before any GET (InternalAccess=Yes).
export function nativeRestTransportRefusalFromError(error) {
  return error?.message === 'debug_native_endpoint_internal_access_only' ? nativeRestTransportRefusal({ internalAccess: 'Yes' }) : null;
}

export function nativeEndpointAuthenticationCapability(plan) {
  const protocol = plan.authentication.protocol, custom = plan.authentication.custom;
  // Transport first: refused before any dialog, lock or send. SOAP plans carry their own model checks.
  if (plan.schema === 'ssam-native-rest-entry/1') {
    const refusal = nativeRestTransportRefusal(plan.entry?.transport, plan.authentication.native);
    if (refusal) return refusal;
  }
  // REST Custom (OnAuthentication) or O11 SOAP header check inside the WebServiceMethod flow (protocol 'header').
  const soapHeader = plan.schema === 'ssam-native-soap-entry/1' && protocol === 'header';
  if (plan.authentication.native === 'Custom' || soapHeader) return custom ? { executable: true, requiredContext: 'endpoint-credential', credentialScheme: 'header',
    headers: custom.headers.map(header => header.name), callsLogin: custom.callsLogin === true, appUserIdentityProved: false,
    source: soapHeader ? 'published WebServiceMethod flow' : 'published OnAuthentication',
    limitation: 'The endpoint receives only the request headers its ' + (soapHeader ? 'published WebServiceMethod flow' : 'published OnAuthentication') +
      ' reads, entered in the private Endpoint Credential dialog; acceptance, UID and roles are developer logic and need server evidence.' }
    : { executable: false, error: 'debug_native_endpoint_custom_authentication_unqualified',
      ...(plan.authentication.customRefusal ? { reason: plan.authentication.customRefusal } : {}) };
  // Authentication=None with a literal request-header guard: the P08 header record carries exactly those headers.
  if (plan.authentication.native === 'None' && protocol === 'header') {
    if (!plan.authentication.headers?.length) return { executable: false, error: 'debug_native_endpoint_request_header_guard_unqualified',
      ...(plan.authentication.guardRefusal ? { reason: plan.authentication.guardRefusal } : {}), policy: 'ssam', platformLimit: false };
    const where = plan.authentication.source === 'OnRequest' ? 'published OnRequest callback' : 'published REST method flow';
    return { executable: true, requiredContext: 'endpoint-credential', credentialScheme: 'header', headers: plan.authentication.headers.map(header => header.name),
      appUserIdentityProved: false, source: where, limitation: 'The endpoint receives only the request headers its ' + where +
        ' reads, entered in the private Endpoint Credential dialog; acceptance is developer logic and needs server evidence.' };
  }
  if (protocol === 'none') return { executable: true, requiredContext: 'explicit-anonymous',
    appUserIdentityProved: false, limitation: 'No application-user identity follows from an anonymous endpoint contract.' };
  const basic = plan.authentication.basic, lane = plan.binding.lane;
  // ODC Basic, or O11 Basic validated by developer logic: an endpoint-credential basic record, never the app-user password.
  // Local actions the callback calls are not read: a login inside one would set an identity SSAM does not report.
  if (protocol === 'basic' && basic && (lane === 'odc' || basic.validation === 'developer-logic')) return { executable: true,
    requiredContext: 'endpoint-credential', credentialScheme: 'basic', headers: ['Authorization'], validation: 'developer-logic',
    ...(basic.localActions?.length ? { localActions: basic.localActions } : {}),
    appUserIdentityProved: false, source: 'published OnAuthentication', limitation: (lane === 'odc' ? 'ODC ' : 'O11 ') + BASIC_DEVELOPER_LIMITATION +
      (basic.localActions?.length ? '; the callback calls local actions SSAM does not read (' + basic.localActions.join(', ') + '); any login they perform needs server evidence' : '') };
  if (protocol === 'basic' && lane === 'o11' && !plan.authentication.basicRefusal) return { executable: true, requiredContext: 'app-user',
    ...(basic ? { validation: basic.validation, loginProvider: basic.loginProvider } : {}),
    appUserIdentityProved: false, limitation: 'The endpoint receives the entered app-user credentials; native UID, roles and propagation require server evidence.' };
  if (protocol === 'basic' && lane === 'o11') return { executable: false, error: 'debug_native_endpoint_basic_validation_ambiguous',
    reason: plan.authentication.basicRefusal, policy: 'ssam', platformLimit: false };
  // Stable code plus the documented former code; refused before any dialog, lock or send.
  if (protocol === 'basic' && lane === 'odc') return { executable: false, error: 'debug_native_endpoint_odc_basic_unqualified',
    alias: 'debug_native_endpoint_basic_credentials_unavailable_after_odc_srp', reason: plan.authentication.basicRefusal ?? 'debug_native_endpoint_basic_callback_missing',
    policy: 'ssam', platformLimit: false, limitation: ODC_BASIC_LIMITATION };
  return { executable: false, error: 'debug_native_endpoint_authentication_unqualified' };
}

function checkOutstanding(root, binding, operationId) {
  const host = new URL(binding.runtimeUrl).hostname;
  if (binding.lane === 'o11' && blockedBinding(root, host, binding.moduleKey)) fail('binding_blocked');
  const debuggerRoot = path.join(root, '.local', 'debugger');
  const lock = binding.lane === 'o11'
    ? path.join(debuggerRoot, 'native-runs', 'o11', host, binding.moduleKey + '.lock')
    : path.join(debuggerRoot, 'native-runs', hash('odc|' + binding.runtimeUrl + '|' + binding.moduleKey) + '.lock');
  if (fs.existsSync(lock)) {
    let record; try { record = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch { fail('binding_blocked'); }
    if (record.operationId !== operationId) fail('binding_blocked');
  }
  const registry = path.join(debuggerRoot, 'blocked-bindings', binding.lane === 'o11'
    ? bindingHash(host, binding.moduleKey) + '.json' : hash('odc|' + binding.runtimeUrl + '|' + binding.moduleKey) + '.json');
  if (fs.existsSync(registry)) fail('binding_blocked');
}

const redactOnly = value => value !== null && typeof value === 'object' &&
  (value.use === 'redact-only' || value.kind === 'redaction-secret' || value.binding?.use === 'redact-only');

function durableWrite(file, value, exclusive = false) {
  const destination = exclusive ? file : file + '.tmp';
  const fd = fs.openSync(destination, exclusive ? 'wx' : 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (!exclusive) fs.renameSync(destination, file);
}

// Exported only for offline tests. Production invokes this function in the
// child below; services are implementation dependencies, not request fields.
export async function invokePrivateNativeEndpoint(input, { vault = privateAppUserVault, fetchImpl = fetch, now = Date.now } = {}) {
  if (input.protocol !== undefined && !['rest', 'soap'].includes(input.protocol)) fail('protocol_invalid');
  // Credential values live only in the private vault record, never in this request JSON.
  if (['headers', 'credentials', 'endpointCredential', 'privateValues', 'secrets'].some(key => Object.hasOwn(input, key))) fail('private_value_in_request');
  // A redaction-only record redacts frames and checks receipts; it is never placed in a request (before lock or fetch).
  if (redactOnly(input.descriptor)) fail('redaction_record_not_sendable');
  const soap = input.protocol === 'soap';
  const plan = (soap ? compileNativeSoapEndpoint : compileNativeRestEndpoint)(input.contract);
  const request = (soap ? buildNativeSoapRequest : buildNativeEndpointRequest)(plan, input.inputs);
  if (!GUID.test(input.operationId ?? '') || !/^[A-Za-z0-9_-]{1,80}$/.test(input.scenarioId ?? '') ||
      !Number.isInteger(input.timeoutSeconds) || input.timeoutSeconds < 1 || input.timeoutSeconds > 300) fail('invocation_invalid');
  nativeEndpointRequestBudget(input, now());
  o11NativeDirectory(input.root, input.directory);
  checkOutstanding(input.root, plan.binding, input.operationId);
  const capability = nativeEndpointAuthenticationCapability(plan);
  if (!capability.executable) throw new Error(capability.error);
  if (input.context !== capability.requiredContext) fail('context_explicit_required');
  const report = { schema: 'ssam-native-endpoint-receipt/1', operationId: input.operationId, scenarioId: input.scenarioId,
    binding: plan.binding, entryKey: plan.entry.entryKey, method: plan.method, contractSha256: plan.source.sha256,
    state: 'prepared', sent: false, answered: false, uncertain: false, ok: false,
    authentication: { protocol: plan.authentication.protocol, context: input.context, credentialsFromPrivateDialog: false,
      appUserIdentityProved: false, rolesProved: false, propagationProved: false },
    serverTraceProved: false, requestOwnershipProved: false, memoryReferencesReleased: false };
  if (input.inspectionExpiresAt !== undefined) report.inspection = { expiresAt: input.inspectionExpiresAt, fixed: true };
  const file = path.join(input.directory, 'endpoint-' + input.scenarioId + '.json');
  const bindingDirectory = path.join(input.root, '.local', 'debugger', 'native-endpoint-bindings');
  o11NativeDirectory(input.root, bindingDirectory);
  const bindingLock = path.join(bindingDirectory, hash(plan.binding.lane + '|' + plan.binding.runtimeUrl + '|' + plan.binding.moduleKey) + '.lock');
  fs.mkdirSync(input.directory, { recursive: true });
  let record, authorization, reserved = false, ownsBindingLock = false;
  const privateValues = [];
  try {
    if (input.context === 'app-user') {
      const descriptor = validatePrivateDescriptor(input.descriptor);
      if (Date.parse(descriptor.expiresAt) <= now() || !sameAppUserTarget(descriptor.binding, appUserBinding(plan.binding, descriptor.binding.sessionId))) fail('app_user_scope_mismatch');
      record = await vault('read', descriptor);
      if (redactOnly(record)) fail('redaction_record_not_sendable');
      if (!record.ok || record.kind !== 'credentials' || !sameAppUserTarget(record.binding, descriptor.binding) ||
          Date.parse(record.expiresAt) <= now() || typeof record.username !== 'string' || !record.username ||
          typeof record.password !== 'string' || !record.password || /[:\x00-\x1f\x7f]/.test(record.username) || /[\x00-\x1f\x7f]/.test(record.password)) fail('app_user_credentials_unavailable');
      // RFC 7617 is the endpoint's declared authentication contract. This does
      // not assert that a custom app provider maps it to a particular native UID.
      authorization = 'Basic ' + Buffer.from(record.username + ':' + record.password, 'utf8').toString('base64');
      request.headers.Authorization = authorization;
      privateValues.push(record.username, record.password, authorization, authorization.slice(6));
      report.authentication.credentialsFromPrivateDialog = true;
    } else if (input.context === 'endpoint-credential') {
      // Exactly the headers the published contract reads (OnAuthentication, OnRequest/method guard, SOAP method),
      // or Authorization for a Basic record, bound to this revision, service and scheme.
      const names = capability.headers, scheme = capability.credentialScheme ?? 'header';
      let descriptor; try { descriptor = validateEndpointCredentialDescriptor(input.descriptor); } catch { fail('credential_scope_mismatch'); }
      const expected = endpointCredentialBinding({ ...plan.binding, serviceKey: plan.entry.serviceKey, headers: names, scheme }, descriptor.binding.sessionId);
      // sameEndpointCredentialTarget compares the scheme too (PX03 binding: undefined = header, 'basic').
      if (!(Date.parse(descriptor.expiresAt) > now()) || !sameEndpointCredentialTarget(descriptor.binding, expected)) fail('credential_scope_mismatch');
      try { record = await vault('read', descriptor); } catch { fail('credential_unavailable'); }
      if (redactOnly(record)) fail('redaction_record_not_sendable');
      // One composition path (PX03): every private form first (Basic: username, password, b64, 'Basic '+b64), then the
      // bound headers (Basic composes its one Authorization on record.headers). Both are zeroed in finally.
      let headers; try { privateValues.push(...endpointCredentialRecordValues(record, descriptor, now())); headers = endpointCredentialRecordHeaders(record, descriptor, now()); }
      catch { fail('credential_unavailable'); }
      for (const header of headers) {
        if (Object.keys(request.headers).some(name => name.toLowerCase() === header.name.toLowerCase())) fail('credential_header_collision');
        request.headers[header.name] = header.value;
      }
      report.authentication.credentialsFromPrivateDialog = true; report.authentication.scheme = scheme; report.authentication.endpointHeaders = names;
    } else if (input.descriptor) fail('anonymous_descriptor_forbidden');
    // The operation/scenario marker is immutable until a definitive answer is
    // recorded. Existing markers never cause a second HTTP request.
    fs.mkdirSync(bindingDirectory, { recursive: true });
    try { durableWrite(bindingLock, { operationId: input.operationId, scenarioId: input.scenarioId, state: 'sending' }, true); ownsBindingLock = true; }
    catch (error) { if (error?.code === 'EEXIST') fail('binding_blocked'); throw error; }
    report.state = 'sending'; report.sent = true; report.uncertain = true;
    durableWrite(file, report, true); reserved = true;
    const response = await fetchImpl(request.url, { method: request.method, headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body }), redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(nativeEndpointRequestBudget(input, now())) });
    // A full bounded response is required. Network/body cancellation after send
    // remains uncertain even when the server returned response headers.
    if (response.url && response.url !== request.url) fail('response_origin_changed');
    const chunks = [], reader = response.body?.getReader(); let size = 0;
    if (reader) while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength;
      if (size > 4 * 1024 * 1024) { await reader.cancel(); fail('response_size_limit'); } chunks.push(Buffer.from(chunk.value)); }
    report.answered = true; report.uncertain = false; report.state = 'answered'; report.status = response.status;
    const result = (soap ? decodeNativeSoapResponse : decodeNativeEndpointResponse)(plan, { status: response.status, contentType: response.headers.get('content-type'),
      headers: Object.fromEntries(response.headers.entries()), body: Buffer.concat(chunks).toString('utf8') });
    report.result = publicWrapperBody(result, privateValues);
    report.ok = result.successful; report.authentication.httpAccepted = result.successful;
  } catch (error) {
    report.error = error?.code === 'EEXIST' ? 'debug_native_endpoint_already_submitted' : publicError(error);
    report.state = report.sent && reserved && !report.answered ? 'uncertain' : 'failed';
    report.uncertain = report.state === 'uncertain';
    if (!reserved) { report.sent = false; report.uncertain = false; }
  } finally {
    if (record) { record.username = ''; record.password = '';
      if (Array.isArray(record.headers)) for (const header of record.headers) if (header && typeof header === 'object') header.value = ''; }
    for (const key of Object.keys(request.headers)) request.headers[key] = '';
    authorization = undefined; privateValues.fill(''); record = undefined;
    report.memoryReferencesReleased = true; report.finishedAt = new Date(now()).toISOString();
    if (reserved) durableWrite(file, report);
    if (ownsBindingLock) {
      if (!report.uncertain) fs.unlinkSync(bindingLock);
      else durableWrite(bindingLock, { operationId: input.operationId, scenarioId: input.scenarioId, state: 'uncertain', receipt: file });
      report.bindingLockRetained = report.uncertain;
      if (reserved) durableWrite(file, report);
    }
  }
  return report;
}

// Read-only recovery after the child has terminated. A final local receipt
// replacement failure must not erase an already durable HTTP answer.
export function recoverNativeEndpointMarker(input) {
  try {
    o11NativeDirectory(input.root, input.directory);
    if (!GUID.test(input.operationId ?? '') || !/^[A-Za-z0-9_-]{1,80}$/.test(input.scenarioId ?? '')) throw new Error();
    const file = path.join(input.directory, 'endpoint-' + input.scenarioId + '.json');
    if (!fs.existsSync(file)) return { ok:false,state:'failed',sent:false,answered:false,uncertain:false,error:'debug_native_endpoint_worker_unavailable' };
    const plan=(input.protocol==='soap'?compileNativeSoapEndpoint:compileNativeRestEndpoint)(input.contract);
    const bytes=fs.readFileSync(file),receipt=JSON.parse(bytes.toString('utf8'));
    if(receipt.schema!=='ssam-native-endpoint-receipt/1' || receipt.operationId!==input.operationId || receipt.scenarioId!==input.scenarioId ||
        receipt.entryKey!==plan.entry.entryKey || receipt.method!==plan.method || receipt.contractSha256!==plan.source.sha256 ||
        ['lane','runtimeUrl','module','moduleKey','revision','sourceSha256'].some(k=>receipt.binding?.[k]!==plan.binding[k]) ||
        typeof receipt.sent!=='boolean' || typeof receipt.answered!=='boolean' || typeof receipt.uncertain!=='boolean' ||
        receipt.answered && !receipt.sent)throw new Error();
    const bindingLock=path.join(input.root,'.local','debugger','native-endpoint-bindings',hash(plan.binding.lane+'|'+plan.binding.runtimeUrl+'|'+plan.binding.moduleKey)+'.lock');
    const bindingLockRetained=fs.existsSync(bindingLock);
    const uncertain=receipt.uncertain || receipt.sent && !receipt.answered || receipt.memoryReferencesReleased!==true || bindingLockRetained;
    return {...receipt,ok:receipt.ok===true && !uncertain,state:uncertain?'uncertain':receipt.state,uncertain,
      bindingLockRetained,recoveredFromMarker:true,markerSha256:hash(bytes)};
  }catch{return{ok:false,state:'uncertain',sent:null,uncertain:true,error:'debug_native_endpoint_worker_outcome_unavailable'};}
}

export function invokeNativeEndpointWorker(input, { spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const budget = nativeEndpointRequestBudget(input);
    const child = spawnImpl(process.execPath, [worker, 'invoke'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let text = '', settled = false, interrupted = false;
    const recover = () => recoverNativeEndpointMarker(input);
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); text = ''; resolve(error ? recover() : result); };
    const timer = setTimeout(() => { interrupted = true; child.kill(); }, budget + 30000);
    child.once('error', () => finish(true)); child.stdin.on('error', () => {}); child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => { text += data; if (Buffer.byteLength(text) > 8 * 1024 * 1024) { interrupted = true; child.kill(); } });
    child.once('close', code => { if (interrupted) { finish(true); return; } try { const result = JSON.parse(text);
      code === 0 && ['ok','sent','answered','uncertain','memoryReferencesReleased'].every(k=>typeof result[k]==='boolean')
        ? finish(false, result) : finish(true);
    } catch { finish(true); } });
    child.stdin.end(JSON.stringify(input));
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  let output;
  try {
    if (process.argv[2] !== 'invoke') fail('operation_invalid');
    let bytes = ''; for await (const chunk of process.stdin) { bytes += chunk; if (Buffer.byteLength(bytes) > 12 * 1024 * 1024) fail('request_size_limit'); }
    output = await invokePrivateNativeEndpoint(JSON.parse(bytes)); bytes = '';
  } catch (error) { output = { ok: false, state: 'refused', error: publicError(error) }; }
  process.stdout.write(JSON.stringify(output));
}
