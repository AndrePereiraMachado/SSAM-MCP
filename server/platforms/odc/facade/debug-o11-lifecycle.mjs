// Current operational O11 CLI/Studio SSO only. No credential arguments, old checkout or IDE model edits.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { workspaceRoot, anvilRoot, o11Lane } from './workspace.mjs';
import { anvilCli, LANES } from './lanes.mjs';
import { connectionEnvironment } from './studio-session.mjs';
import { kernelReading } from './kernel-reading.mjs';
import { selectedO11Publisher } from './debug-o11-publisher.mjs';
import { selectedO11Compiler } from './debug-o11-compiler.mjs';
import * as W from './debug-wrapper.mjs';

const exec = promisify(execFile), KEY = /^[A-Za-z0-9_+]{22}$/, NAME = /^[A-Za-z_][A-Za-z0-9_]{0,120}$/;
const fail = code => { throw new Error(code); };
export const o11Hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function o11LoginSignature(signature) {
  const inputs = signature?.children?.filter(c => c.kind === 'InputParameterSignature') ?? [];
  const types = { Username: 'Text', Password: 'Text', RememberLogin: 'Boolean' };
  if (signature?.kind !== 'ServerActionSignature' || !KEY.test(signature.key ?? '') || inputs.length !== 3 ||
      signature.children.some(c => c.kind === 'OutputParameterSignature') ||
      new Set(inputs.map(c => c.key)).size !== 3 || inputs.some(c => !KEY.test(c.key ?? '')) ||
      Object.entries(types).some(([name, type]) => inputs.filter(c => c.name === name && c.propertyReferences?.DataType?.kind === 'BasicType' &&
        (c.propertyReferences.DataType.label ?? c.propertyReferences.DataType.name) === type).length !== 1))
    fail('debug_o11_run_native_login_signature_unresolved');
  return { key: signature.key, inputs: inputs.map(c => ({ key: c.key, name: c.name })) };
}
// A read of the verified candidate must establish the actual original-call/login order, not merely node names.
export function o11WrapperContract(tree, action, { loginRef, loginContract, token } = {}) {
  if (tree?.kind !== 'RestServiceAction' || !/^@[A-Za-z0-9_+]{22}$/.test(loginRef ?? '') ||
      loginContract?.key !== loginRef.slice(1) || !/^[a-f0-9]{48}$/.test(token ?? '')) fail('debug_o11_run_wrapper_authentication_unproved');
  const model = W.actionModel(tree), n = W.names(action.name), rows = tree.children ?? [];
  const target = (row, connector) => row?.propertyReferences?.[connector]?.key;
  const one = (key, kind) => { const matches = rows.filter(c => c.key === key); if (matches.length !== 1 || matches[0].kind !== kind || !KEY.test(matches[0].key ?? ''))
      fail('debug_o11_run_wrapper_authentication_unproved'); return matches[0]; };
  // O11 If nodes have no stable Name/Label after native save. Prove the actual
  // connected graph; presentation labels are not authentication evidence.
  const authorized = one(target(rows.find(c => c.key === model.start), 'Target'), 'IfNode'),
    deserialize = one(target(authorized, 'TrueTarget'), 'JSONDeserializeNode'),
    login = one(target(deserialize, 'Target'), 'ExecuteServerActionNode'),
    identity = one(target(login, 'Target'), 'IfNode'),
    call = one(target(identity, 'TrueTarget'), 'ExecuteServerActionNode'),
    denied = one(target(authorized, 'FalseTarget'), 'AssignNode');
  const compact = value => typeof value === 'string' ? value.replace(/\s+/g, '') : '';
  if (model.start == null || target(rows.find(row => row.key === model.start), 'Target') !== authorized.key ||
      compact(authorized.properties?.Condition) !== compact(`${n.token} = "${token}"`) ||
      target(authorized, 'TrueTarget') !== deserialize.key || target(authorized, 'FalseTarget') !== denied.key ||
      target(deserialize, 'Target') !== login.key || login.propertyReferences?.Action?.key !== loginContract.key ||
      target(login, 'Target') !== identity.key || compact(identity.properties?.Condition) !== 'GetUserId()<>NullIdentifier()' ||
      target(identity, 'TrueTarget') !== call.key || target(identity, 'FalseTarget') !== denied.key ||
      call.propertyReferences?.Action?.key !== action.key || rows.find(row => row.key === target(denied, 'Target'))?.kind !== 'EndNode')
    fail('debug_o11_run_wrapper_authentication_unproved');
  for (const parameter of loginContract.inputs) {
    const arguments_ = (login.children ?? []).filter(child => child.kind === 'Argument' && child.propertyReferences?.Parameter?.key === parameter.key);
    const expected = parameter.name === 'RememberLogin' ? 'False' : `${n.deserialize}.Data.${W.APP_USER_FIELDS[parameter.name.toLowerCase()]}`;
    if (arguments_.length !== 1 || compact(arguments_[0].properties?.Value) !== compact(expected)) fail('debug_o11_run_wrapper_authentication_unproved');
  }
  return { key: model.key, callNode: call.key, loginNode: login.key, nativeLoginSignatureKey: loginContract.key,
    authenticationVerified: true, originalActionKey: action.key, nativeIdentityGuardVerified: true,
    loginScope: 'configured-native-provider-in-same-request', serviceBoundaryProved: false };
}
// Native O11 avsig envelopes serialize ObjectKey as its .NET Guid string; model readers expose its 16-byte key.
export function o11SignatureKeyOf(modelKey) {
  if (!KEY.test(modelKey ?? '')) fail('debug_o11_run_module_key_invalid');
  const hex = Buffer.from(modelKey.replace(/_/g, '/') + '==', 'base64').toString('hex');
  const littleEndian = field => field.match(/../g).reverse().join('');
  return `${littleEndian(hex.slice(0, 8))}-${littleEndian(hex.slice(8, 12))}-${littleEndian(hex.slice(12, 16))}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export const o11Read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
export function o11Write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  const fd = fs.openSync(temporary, 'wx');
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
}
export function o11PublicTarget(input) {
  let runtime; try { runtime = new URL(input.runtimeUrl); } catch { fail('debug_o11_run_invalid_target'); }
  if (!NAME.test(input.module ?? '') || !KEY.test(input.moduleKey ?? '') || !KEY.test(input.applicationKey ?? '') ||
      runtime.protocol !== 'https:' || runtime.hostname !== input.host || runtime.host !== input.host || runtime.username || runtime.password ||
      runtime.search || runtime.hash || runtime.pathname !== '/' + input.module + '/') fail('debug_o11_run_invalid_target');
  return { host: input.host, module: input.module, moduleKey: input.moduleKey, applicationKey: input.applicationKey,
    runtimeUrl: runtime.origin + '/' + input.module + '/' };
}
export function matchPublishedModule(inventory, target) {
  const captured = Date.parse(inventory?.capturedAtUtc), now = Date.now();
  if (!Number.isFinite(captured) || captured > now + 30000 || captured < now - 900000 || inventory.host !== target.host) fail('debug_o11_run_inventory_stale_or_mismatched');
  const matches = inventory.modules?.filter(m => m.Key === target.moduleKey) ?? [];
  if (matches.length !== 1 || matches[0].Name !== target.module || matches[0].ApplicationKey !== target.applicationKey ||
      matches[0].IsActive !== true || !Number.isSafeInteger(matches[0].VersionId) || matches[0].VersionId < 1) fail('debug_o11_run_module_scope_mismatch');
  return matches[0];
}

// The private broker validates original model/assets/ABI. This boundary verifies only its public prepared contract.
export function o11NativeEntryMetadata(input, value, sessionId) {
  const target = o11PublicTarget(input), supplied = value?.target, sourceContract = input.nativeEntry?.sourceContract, entry = value?.entry;
  if (value?.schema !== 'ssam-o11-native-entry-receipt/1' || value.prepared !== true || value.originalLoginController !== true ||
      value.publishedAbiValidated !== true || !Number.isInteger(value.sourceAssetsVerified) || value.sourceAssetsVerified < 1 ||
      value.sessionId !== sessionId || !supplied || supplied.lane !== 'o11' ||
      Object.entries(target).some(([key, expected]) => supplied[key] !== expected) ||
      !Number.isSafeInteger(supplied.publishedVersionId) || supplied.publishedVersionId < 1 || !/^[a-f0-9]{64}$/.test(supplied.sourceSha256 ?? '') ||
      value.sourceContract?.path !== sourceContract?.path || value.sourceContract?.sha256 !== sourceContract?.sha256 ||
      entry?.selector !== input.action || !KEY.test(entry.actionKey ?? '') || !KEY.test(entry.apiVersion ?? '') || entry.inputsCount !== 0 ||
      !/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(entry.viewName ?? '') ||
      typeof entry.endpoint !== 'string' || !entry.endpoint.startsWith('/' + target.module + '/screenservices/') ||
      /[?#\\\x00-\x20]/.test(entry.endpoint) || new URL(entry.endpoint, target.runtimeUrl).pathname !== entry.endpoint ||
      !Array.isArray(entry.outputs) || !entry.outputs.length || entry.outputs.length > 60 ||
      new Set(entry.outputs.map(output => output.name)).size !== entry.outputs.length ||
      entry.outputs.some(output => !NAME.test(output.name ?? '') || output.type !== 'Boolean'))
    fail('debug_o11_run_native_entry_preparation_unproved');
  return { target: { lane: 'o11', ...target, publishedVersionId: supplied.publishedVersionId, sourceSha256: supplied.sourceSha256 },
    sourceContract: { ...sourceContract }, sessionId, sourceAssetsVerified: value.sourceAssetsVerified,
    entry: { selector: entry.selector, actionKey: entry.actionKey, endpoint: entry.endpoint, apiVersion: entry.apiVersion,
      viewName: entry.viewName, inputsCount: 0, outputs: entry.outputs.map(output => ({ name: output.name, type: output.type })) } };
}

export function o11CliArguments(verb, args, cliPath, studioDirectory) {
  return [...(verb === 'publish-oml' ? ['--roll-forward', 'LatestMajor'] : []), cliPath, verb, ...args,
    ...(studioDirectory ? ['--ss-dir', studioDirectory] : [])];
}

export async function operationalO11Cli(verb, args, { timeoutMs = 360000 } = {}) {
  const env = { ...process.env, ...connectionEnvironment(anvilRoot, o11Lane.lane) };
  let cliPath;
  try { cliPath = verb === 'publish-oml' ? await selectedO11Publisher(env.ANVIL_STUDIO_DIR) : anvilCli(); }
  catch (error) {
    // Selection only reads the qualified package. No child process or native write
    // exists yet; preserve this distinction instead of creating false uncertainty.
    if (verb === 'publish-oml' && /^debug_o11_publisher_[a-z_]+$/.test(error?.code ?? ''))
      error.publicationStage = 'publisher-selection';
    throw error;
  }
  if (verb === 'apply') cliPath = await selectedO11Compiler(env.ANVIL_STUDIO_DIR, cliPath);
  const argv = o11CliArguments(verb, args, cliPath, env.ANVIL_STUDIO_DIR);
  let stdout;
  try { stdout = (await exec('dotnet', argv, { cwd: anvilRoot, env, windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs })).stdout; }
  catch (error) { stdout = error.stdout; }
  let reply; try { reply = JSON.parse(stdout ?? ''); } catch { fail('debug_o11_run_cli_unavailable'); }
  // Neither stderr nor SDK exception text is an acceptable public diagnostic.
  if (reply.command !== verb || typeof reply.ok !== 'boolean') fail('debug_o11_run_cli_invalid_response');
  if (!reply.ok && verb !== 'publish-oml') fail('debug_o11_run_cli_refused');
  return reply.data ?? { ok: false, state: 'refused', error: 'publish_oml_runtime_unavailable' };
}

export function createO11Lifecycle({ cli = operationalO11Cli, readTree = nativeReadTree, root = workspaceRoot, nativeInventory } = {}) {
  async function inventory(target, directory, { requireModuleId = false } = {}) {
    let reply = await cli('inventory', ['--host', target.host, '--module', target.module, '--read-only']);
    let row = matchPublishedModule(reply, target);
    if (requireModuleId && row.ModuleId == null) {
      const acquire = nativeInventory ?? (await import('./debug-o11-native-inventory.mjs')).acquireO11NativeInventory;
      const nativeReply = await acquire(target, directory, { publishedInventory: reply }), nativeRow = matchPublishedModule(nativeReply, target);
      if (nativeRow.VersionId !== row.VersionId) fail('debug_o11_run_published_version_changed');
      reply = nativeReply; row = nativeRow;
      if (row.ModuleId == null) fail('debug_native_background_native_module_id_unavailable');
    }
    if (row.ModuleId != null && (!Number.isSafeInteger(row.ModuleId) || row.ModuleId < 1 || row.ModuleId > 2147483647))
      fail('debug_o11_native_module_id_invalid');
    // Fresh debugger proof contains exact published identity, never developer/app-user credentials.
    const proof = { host: target.host, capturedAtUtc: reply.capturedAtUtc,
      ...(reply.moduleIdentitySource ? { moduleIdentitySource: reply.moduleIdentitySource } : {}), modules: [{
      Name: row.Name, Key: row.Key, ApplicationKey: row.ApplicationKey, VersionId: row.VersionId, IsActive: row.IsActive,
      ...(row.ModuleId != null ? { ModuleId: row.ModuleId } : {}) }] };
    const proofPath = path.join(directory, 'inventory.json'); o11Write(proofPath, proof);
    return { row, versionId: row.VersionId, proof: { path: proofPath, sha256: o11Hash(fs.readFileSync(proofPath)) } };
  }
  async function snapshot(target, directory) {
    fs.mkdirSync(directory, { recursive: true });
    const listed = await inventory(target, directory);
    const downloaded = await cli('download', ['--host', target.host, '--module', target.moduleKey,
      '--version', String(listed.versionId), '--out', directory, '--read-only']);
    if (downloaded.Status !== 'ok' || downloaded.IsPublishedVersion !== true || downloaded.Key !== target.moduleKey ||
        downloaded.Name !== target.module || downloaded.VersionId !== listed.versionId || !path.isAbsolute(downloaded.FilePath ?? '')) fail('debug_o11_run_snapshot_scope_mismatch');
    const file = downloaded.FilePath, sha256 = o11Hash(fs.readFileSync(file));
    const described = await cli('inspect', ['--oml', file]);
    if (described.Key !== target.moduleKey || described.Name !== target.module) fail('debug_o11_run_snapshot_scope_mismatch');
    return { file, sha256, ...listed, described };
  }
  async function original(base, selector) {
    if (!NAME.test(selector) && !KEY.test(selector)) fail('debug_o11_run_action_invalid');
    const tree = await readTree(base, KEY.test(selector) ? '@' + selector : 'ServerAction:' + selector);
    if (!['ServerAction', 'ServiceAction'].includes(tree?.kind)) fail('debug_o11_run_action_kind_unsupported');
    const action = W.actionModel(tree);
    if (!action.start || !NAME.test(action.name) || !KEY.test(action.key)) fail('debug_o11_run_action_incomplete');
    return action;
  }
  async function resolveLogin(base) {
    const provider = base.described.UserProviderName, providerKey = base.described.UserProviderKey;
    if (!NAME.test(provider ?? '') || !KEY.test(providerKey ?? '')) fail('debug_o11_run_user_provider_unresolved');
    const references = (base.described.References ?? []).filter(r => r.Name === provider && r.Key === providerKey);
    if (references.length !== 1) fail('debug_o11_run_user_provider_unresolved');
    const signature = await readTree(base, 'Reference:' + provider + '/ServerActionSignature:User_Login');
    const loginContract = o11LoginSignature(signature);
    return { loginRef: '@' + signature.key, loginContract: { ...loginContract, provider, providerKey } };
  }
  async function loginReference(base) { return (await resolveLogin(base)).loginRef; }
  async function apply(base, job, directory, { producers = [] } = {}) {
    fs.mkdirSync(directory, { recursive: true });
    if (o11Hash(fs.readFileSync(base.file)) !== base.sha256) fail('debug_o11_run_source_changed');
    const jobPath = path.join(directory, 'job.json'), candidatePath = path.join(directory, 'candidate.oml');
    o11Write(jobPath, job);
    const reply = await cli('apply', ['--base', base.file, '--job', jobPath, '--out', candidatePath,
      ...producers.flatMap(p => ['--producer', p.name + '=' + p.path])]);
    if (reply.accepted !== true || reply.isValid !== true || !fs.existsSync(candidatePath)) fail('debug_o11_run_candidate_refused');
    return { file: candidatePath, sha256: o11Hash(fs.readFileSync(candidatePath)), jobPath, jobSha256: o11Hash(fs.readFileSync(jobPath)) };
  }
  async function loginContext(base, directory, target) {
    const provider = base.described.UserProviderName, providerKey = base.described.UserProviderKey;
    if (!NAME.test(provider ?? '') || !KEY.test(providerKey ?? '')) fail('debug_o11_run_user_provider_unresolved');
    const existing = (base.described.References ?? []).filter(r => r.Key === providerKey);
    if (existing.length) return { source: base, ...await resolveLogin(base), addedReferences: [] };
    fs.mkdirSync(directory, { recursive: true });
    const signaturePath = path.join(directory, provider + '.avsig');
    await cli('signature', ['--host', target.host, '--producer', provider, '--key', providerKey, '--kind', 'eSpace',
      '--elements', 'IServerActionSignature:User_Login', '--out', signaturePath]);
    const signature = o11Read(signaturePath);
    if (signature.FormatVersion !== 2 || typeof signature.ModuleKey !== 'string' || signature.ModuleKey.toLowerCase() !== o11SignatureKeyOf(providerKey) || signature.Name !== provider ||
        signature.Environment !== target.host || signature.Attestation?.Source !== 'server-signature' ||
        signature.Attestation.IsActive !== true || !Number.isSafeInteger(signature.Attestation.VersionId) || signature.Attestation.VersionId < 1)
      fail('debug_o11_run_user_provider_signature_mismatch');
    const imported = await apply(base, { description: 'SSAM debug: import the configured user provider login into a candidate',
      expectValid: true, expectedMessages: [], ops: [{ op: 'reference', producer: provider, elements: ['IServerActionSignature:User_Login'] }] },
      path.join(directory, 'import'), { producers: [{ name: provider, path: signaturePath }] });
    const described = await cli('inspect', ['--oml', imported.file]);
    if (described.UserProviderKey !== providerKey || described.UserProviderName !== provider || described.Key !== target.moduleKey)
      fail('debug_o11_run_user_provider_signature_mismatch');
    const source = { ...base, ...imported, described }, reference = await readTree(source, 'Reference:' + provider);
    if (!KEY.test(reference?.key ?? '')) fail('debug_o11_run_user_provider_unresolved');
    return { source, ...await resolveLogin(source), addedReferences: [{ key: reference.key, name: provider, producerKey: providerKey,
      signaturePath, signatureSha256: o11Hash(fs.readFileSync(signaturePath)), versionId: signature.Attestation.VersionId }] };
  }
  async function wrapper(candidate, action, context) {
    const tree = await readTree(candidate, 'RestService:' + W.SERVICE + '/RestServiceAction:' + action.name);
    if (!KEY.test(tree?.key ?? '')) fail('debug_o11_run_wrapper_unreadable');
    return o11WrapperContract(tree, action, context);
  }
  function publication(target, base, candidate, authorization, directory, message) {
    const operationId = randomUUID(); fs.mkdirSync(directory, { recursive: true });
    if (!authorization?.words || authorization.host !== target.host || !authorization.modules?.includes(target.moduleKey) ||
        authorization.scope !== 'ssam-debug-wrapper-create-remove') fail('debug_o11_run_authorization_required');
    const authorizationPath = path.join(directory, 'authorization.json');
    o11Write(authorizationPath, { operationId, host: target.host, moduleKey: target.moduleKey, candidateSha256: candidate.sha256,
      scope: authorization.scope, words: authorization.words, grantedAt: authorization.grantedAt });
    const request = { operationId, ...target, baseVersionId: base.versionId, basePath: base.file, baseSha256: base.sha256,
      candidatePath: candidate.file, candidateSha256: candidate.sha256, authorizationPath,
      authorizationSha256: o11Hash(fs.readFileSync(authorizationPath)), receiptDirectory: directory, message, timeoutSeconds: 300 };
    delete request.runtimeUrl;
    const requestPath = path.join(directory, 'publish-request.json'); o11Write(requestPath, request);
    return { requestPath, requestSha256: o11Hash(fs.readFileSync(requestPath)), operationId, receiptPath: path.join(directory, operationId + '.json'), request };
  }
  async function publish(operation, mode = 'publish') {
    const request = o11Read(operation.requestPath);
    if (request.operationId !== operation.operationId || JSON.stringify(request) !== JSON.stringify(operation.request) ||
        operation.requestSha256 && o11Hash(fs.readFileSync(operation.requestPath)) !== operation.requestSha256)
      fail('debug_o11_run_publication_request_changed');
    if (!['publish', 'reconcile'].includes(mode)) fail('debug_o11_run_publication_mode_invalid');
    const outcome = reply => {
      if (!reply || !['published', 'failed', 'refused', 'uncertain', 'preparing'].includes(reply.state))
        return { ok: false, state: 'uncertain', error: 'publish_oml_outcome_uncertain', operationId: operation.operationId };
      if (reply.operationId !== operation.operationId || reply.candidateSha256 !== operation.request.candidateSha256 ||
          reply.moduleKey !== operation.request.moduleKey || reply.host !== operation.request.host ||
          reply.state === 'published' && (!Number.isSafeInteger(reply.versionId) || reply.versionId < 1))
        return { ok: false, state: 'uncertain', error: 'publish_oml_receipt_mismatch', operationId: operation.operationId };
      return { ok: reply.state === 'published', state: reply.state, versionId: reply.versionId ?? null,
        operationId: operation.operationId, receiptPath: operation.receiptPath,
        ...(reply.state === 'published' ? {} : { error: 'publish_oml_' + reply.state }) };
    };
    const previous = fs.existsSync(operation.receiptPath) ? o11Read(operation.receiptPath) : null;
    // Reading an existing result is not permission to resend its write, even when no process still owns it.
    if (previous && (mode === 'publish' || previous.state !== 'uncertain')) return outcome(previous);
    let requestPath = operation.requestPath;
    if (mode === 'reconcile') {
      if (!previous || outcome(previous).error === 'publish_oml_receipt_mismatch') fail('debug_o11_run_reconciliation_requires_publication_receipt');
      let reconcilePublishedVersionId;
      if (!previous.versionId) {
        const target = o11PublicTarget({ ...request, runtimeUrl: `https://${request.host}/${request.module}/` });
        const current = await snapshot(target, path.join(request.receiptDirectory, 'reconcile-source-' + randomUUID()));
        if (current.sha256 !== request.candidateSha256) return { ok: false, state: 'uncertain', error: 'publish_oml_reconciliation_source_mismatch', operationId: operation.operationId };
        reconcilePublishedVersionId = current.versionId;
      }
      // Preserve the original write request byte-for-byte; the native command adopts only a proven published source.
      requestPath = path.join(path.dirname(operation.requestPath), 'reconcile-request-' + randomUUID() + '.json');
      o11Write(requestPath, { ...request, mode, ...(reconcilePublishedVersionId ? { reconcilePublishedVersionId } : {}) });
    }
    let reply;
    try { reply = await cli('publish-oml', ['--request', requestPath], { timeoutMs: 630000 }); }
    catch (error) {
      reply = fs.existsSync(operation.receiptPath) ? o11Read(operation.receiptPath) : null;
      if (!reply && mode === 'publish' && error?.publicationStage === 'publisher-selection' &&
          /^debug_o11_publisher_[a-z_]+$/.test(error?.code ?? ''))
        return { ok: false, state: 'refused', error: error.code, operationId: operation.operationId,
          nativeSubmission: false, phase: 'publisher-selection' };
    }
    return outcome(reply);
  }
  async function exists(base, selector) {
    const parts = /^([A-Za-z][A-Za-z0-9]*):([A-Za-z_][A-Za-z0-9_]*)$/.exec(selector);
    if (!parts || o11Hash(fs.readFileSync(base.file)) !== base.sha256) fail('debug_o11_run_source_changed');
    const result = await cli('inspect', ['--oml', base.file, '--kind', parts[1], '--name', parts[2], '--depth', '0',
      '--max', '2', '--properties', 'Name']);
    if (result.sourceSha256?.toLowerCase() !== base.sha256 || result.searchComplete !== true ||
        result.propertyReadErrors !== 0 || !Number.isSafeInteger(result.count) || result.count < 0 || result.count > 1)
      fail('debug_o11_run_model_read_incomplete');
    return result.count === 1;
  }
  return { inventory, snapshot, original, loginReference, loginContext, apply, wrapper, publication, publish, readTree,
    root, cli, exists };
}

const nativeModelReaders = new Map();
async function nativeReadTree(base, selector) {
  const { debugO11Reading, debugO11Map, selectedO11DebugReader } = await import('./debug-o11-reader.mjs');
  const key = base.file + ':' + base.sha256 + ':' + selectedO11DebugReader().generation;
  if (!nativeModelReaders.has(key)) {
    const { createNativeModelReader } = await import('./debug-native-model.mjs');
    const inspect = async options => {
      const args = ['--oml', base.file, '--path', options.path, '--full', '--budget', '1000000', '--expectedSourceSha256', base.sha256];
      for (const name of ['depth', 'max', 'offset', 'scope']) if (options[name] !== undefined) args.push('--' + name, String(options[name]));
      if (options.usages) args.push('--usages');
      const result = await debugO11Reading(args);
      return { ...result.data, ok: result.ok, error: result.error ?? result.data?.error };
    };
    if (nativeModelReaders.size >= 8) nativeModelReaders.delete(nativeModelReaders.keys().next().value);
    nativeModelReaders.set(key, createNativeModelReader({ base, lane: 'o11', inspect, map: debugO11Map }));
  }
  return nativeModelReaders.get(key).tree(selector);
}
