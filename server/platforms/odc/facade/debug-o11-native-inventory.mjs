// Native module identity without replacing a loaded bridge or changing the app.
// The raw export reader is fail-closed diagnosis; the production path below uses
// GetESpaceId with an independently validated provider host and publication proof.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { anvilRoot, o11Lane } from './workspace.mjs';
import { readConnection } from './studio-session.mjs';
import { bridgeCall } from './studio-connect.mjs';

const fail = suffix => { throw new Error('debug_o11_native_inventory_' + suffix); };
const read = file => {
  const bytes = fs.readFileSync(file);
  if (bytes.length > 8 * 1024 * 1024) fail('reply_too_large');
  return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
};
const hostOf = value => {
  try {
    const url = new URL(String(value).includes('://') ? value : 'https://' + value);
    return url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.port && !url.search && !url.hash ? url.hostname : null;
  } catch { return null; }
};

export async function acquireO11RawExportInventory(target, directory, services = {}) {
  const connection = services.connection ?? readConnection(anvilRoot, o11Lane.lane);
  if (!connection || !Number.isSafeInteger(connection.pid) || !Number.isSafeInteger(connection.port) || !path.isAbsolute(connection.authorityDir ?? ''))
    fail('selected_studio_unavailable');
  let authorization;
  try { authorization = fs.readFileSync(path.join(connection.authorityDir, 'bridge.key'), 'utf8').trim(); }
  catch { fail('authority_unavailable'); }
  if (!authorization) fail('authority_unavailable');
  const invoke = services.bridgeCall ?? bridgeCall;
  const call = async (method, params = {}) => {
    let result;
    try { result = await invoke(connection.port, method, authorization, params, 15000); }
    catch { fail('bridge_unavailable'); }
    if (result?.success !== true) fail('bridge_refused');
    return result.data;
  };
  const ping = await call('ping');
  if (ping?.bridge !== 'anvil' || ping.pid !== connection.pid) fail('selected_studio_changed');
  const active = await call('get_active_module');
  // ExportHandler borrows the active aggregator's provider. No tab selection or environment switch.
  if (active?.environment !== target.host) fail('active_environment_mismatch');
  const manifest = await call('bridge_manifest');
  if (!['export_modules', 'export_status'].every(verb => manifest?.verbs?.includes(verb))) fail('operation_unavailable');
  const exportDirectory = path.join(directory, 'native-inventory-' + randomUUID());
  fs.mkdirSync(exportDirectory, { recursive: true });
  const startedAt = Date.now(), deadline = startedAt + 45000;
  const pause = services.pause ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  // One submission, including when the reply is lost. The durable local status is the only continuation.
  let startReply;
  try { startReply = await invoke(connection.port, 'export_modules', authorization, { out_dir: exportDirectory, max: 0 }, 15000); } catch { }
  if (startReply && startReply.success !== true) fail('bridge_refused');
  const started = startReply?.data;
  if (started && (started.started !== true || path.resolve(started.outDir ?? '') !== path.resolve(exportDirectory) || hostOf(started.host) !== target.host))
    fail('start_scope_mismatch');
  const statusPath = path.join(exportDirectory, 'export-status.json');
  let status;
  while (Date.now() < deadline) {
    try { status = read(statusPath); } catch { status = null; }
    if (status?.state === 'failed') fail('remote_read_failed');
    if (status?.state === 'done') break;
    await pause(100);
  }
  if (status?.state !== 'done') fail('export_unconfirmed');
  if (hostOf(status.host) !== target.host || ['selected', 'done', 'failed', 'bytes'].some(name => status[name] !== 0))
    fail('read_only_export_unproved');
  let raw;
  try { raw = read(path.join(exportDirectory, 'inventory.json')); } catch { fail('result_unavailable'); }
  if (hostOf(raw.host) !== target.host || !Array.isArray(raw.modules)) fail('result_scope_mismatch');
  const matching = raw.modules.filter(row => row.Key === target.moduleKey);
  if (matching.length !== 1 || matching[0].Name !== target.module || matching[0].ApplicationKey !== target.applicationKey ||
      matching[0].IsActive !== true || !Number.isSafeInteger(matching[0].VersionId) || matching[0].VersionId < 1 ||
      !Number.isSafeInteger(matching[0].Id) || matching[0].Id < 1 || matching[0].Id > 2147483647)
    fail('module_identity_unproved');
  const row = matching[0];
  return { host: target.host, capturedAtUtc: new Date(startedAt).toISOString(), modules: [{
    Name: row.Name, Key: row.Key, ApplicationKey: row.ApplicationKey, VersionId: row.VersionId,
    IsActive: true, ModuleId: row.Id,
  }] };
}

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(value)); fs.renameSync(file + '.tmp', file); };

// The older ExportHandler serializes HostInfo.ToString() as a type name. Its raw
// Id is useful diagnosis, but cannot prove the environment. Use the original
// GetESpaceId API through an independent component whose provider host is checked.
export async function acquireO11NativeInventory(target, directory, services = {}) {
  const screenRoutes = services.screenRoutes;
  if (screenRoutes !== undefined && (!Array.isArray(screenRoutes) || screenRoutes.length < 1 || screenRoutes.length > 4 ||
      new Set(screenRoutes).size !== screenRoutes.length || screenRoutes.some(name => !/^[A-Za-z_][A-Za-z0-9_]{0,198}$/.test(name))))
    fail('route_contract_invalid');
  const connection = services.connection ?? readConnection(anvilRoot, o11Lane.lane);
  const supplied = services.publishedInventory, matching = supplied?.modules?.filter(row => row.Key === target.moduleKey) ?? [];
  const captured = Date.parse(supplied?.capturedAtUtc);
  if (!Number.isFinite(captured) || captured > Date.now() + 30000 || captured < Date.now() - 900000 || supplied?.host !== target.host ||
      matching.length !== 1 || matching[0].Name !== target.module || matching[0].ApplicationKey !== target.applicationKey ||
      matching[0].IsActive !== true || !Number.isSafeInteger(matching[0].VersionId) || matching[0].VersionId < 1)
    fail('publication_proof_invalid');
  if (!connection || !Number.isSafeInteger(connection.pid) || !path.isAbsolute(connection.studioDir ?? '')) fail('selected_studio_unavailable');
  const transport = services.transport ?? await (await import('./debug-o11-auth.mjs')).createO11HookTransport();
  const actual = await transport.describe(connection.pid);
  if (actual.pid !== connection.pid || actual.startedUtc !== connection.startedUtc || actual.studioDir !== connection.studioDir || actual.diagnosticsAvailable !== true)
    fail('selected_studio_changed');
  const operationId = randomUUID(), project = path.join(anvilRoot, 'tools', 'Anvil.DebugInventoryHook');
  const sourceHash = () => hash(Buffer.concat(['Anvil.DebugInventoryHook.csproj', 'StartupHook.cs'].map(name => fs.readFileSync(path.join(project, name)))));
  const sourceSha256 = sourceHash(), assemblyName = 'Anvil.DebugInventoryHook.' + operationId.replaceAll('-', '');
  const operationDirectory = path.join(directory, 'native-identity-' + operationId);
  // MSBuild's copy tasks still fail on long Windows artifact paths. Keep only
  // the isolated binary output short; the requested evidence stays with the run.
  const out = path.join(services.buildRoot ?? path.join(anvilRoot, '.local', 'native-identity'), operationId.replaceAll('-', ''), 'hook');
  const hook = path.join(out, assemblyName + '.dll'), receiptPath = hook + '.receipt.json';
  const row = matching[0], proofPath = path.join(operationDirectory, 'published-proof.json');
  const binding = { pid: actual.pid, startedUtc: actual.startedUtc, host: target.host, module: target.module,
    moduleKey: target.moduleKey, applicationKey: target.applicationKey, publishedVersionId: row.VersionId };
  write(proofPath, { host: supplied.host, capturedAtUtc: supplied.capturedAtUtc, modules: [{
    Name: row.Name, Key: row.Key, ApplicationKey: row.ApplicationKey, VersionId: row.VersionId, IsActive: true }] });
  const journalPath = path.join(operationDirectory, 'journal.json');
  write(journalPath, { phase: 'building', operationId, binding, sourceSha256 });
  try { await transport.build(path.join(project, 'Anvil.DebugInventoryHook.csproj'), out,
    ['-p:StudioDir=' + actual.studioDir, '-p:AssemblyName=' + assemblyName]); }
  catch { fail('hook_build_failed'); }
  if (sourceHash() !== sourceSha256) fail('source_changed');
  const assemblySha256 = hash(fs.readFileSync(hook)), current = await transport.describe(connection.pid);
  if (current.startedUtc !== actual.startedUtc || current.studioDir !== actual.studioDir) fail('selected_studio_changed');
  write(hook + '.json', { operationId, binding, proofPath, proofSha256: hash(fs.readFileSync(proofPath)), assemblySha256,
    ...(screenRoutes ? { screenRoutes } : {}),
    expiresAt: new Date(Date.now() + 90000).toISOString() });
  write(journalPath, { phase: 'attaching', operationId, binding, sourceSha256, assemblySha256, receiptPath });
  // A lost attach reply is not another attach. Reconcile only this component's receipt.
  try { await transport.attach({ pid: actual.pid, startedUtc: actual.startedUtc, hook }); } catch { }
  const deadline = Date.now() + 45000, pause = services.pause ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let receipt;
  while (Date.now() < deadline) {
    try { receipt = read(receiptPath); } catch { receipt = null; }
    if (['failed', 'completed'].includes(receipt?.phase)) break;
    await pause(100);
  }
  if (receipt?.operationId !== operationId || !['completed', 'failed'].includes(receipt?.phase)) fail('attach_unconfirmed');
  if (receipt.phase === 'failed') throw Error(/^debug_o11_native_inventory_[a-z_]+$/.test(receipt.error ?? '') ? receipt.error : 'debug_o11_native_inventory_read_failed');
  const result = receipt.proof, identity = result?.modules?.[0];
  if (receipt.ok !== true || JSON.stringify(receipt.binding) !== JSON.stringify(binding) || receipt.assemblySha256 !== assemblySha256 ||
      receipt.source !== 'ApplicationManagementService.GetESpaceId' || receipt.hostSource !== 'LoginInfo.HostInfo.HostName' ||
      result?.host !== target.host || result.modules?.length !== 1 || identity.Name !== target.module || identity.Key !== target.moduleKey ||
      identity.ApplicationKey !== target.applicationKey || identity.VersionId !== row.VersionId || identity.IsActive !== true ||
      !Number.isSafeInteger(identity.ModuleId) || identity.ModuleId < 1 || identity.ModuleId > 2147483647) fail('receipt_scope_mismatch');
  const provenance = { operationId, sourceSha256, assemblySha256, receiptPath, source: receipt.source, hostSource: receipt.hostSource };
  if (screenRoutes) {
    if (receipt.screenRoutesSource !== 'DebuggerService.GetEntryPointUri' || !receipt.screenRoutes ||
        Object.keys(receipt.screenRoutes).length !== screenRoutes.length) fail('route_receipt_invalid');
    for (const screen of screenRoutes) {
      let url; try { url = new URL(receipt.screenRoutes[screen]); } catch { fail('route_receipt_invalid'); }
      if (url.origin !== 'https://' + target.host || url.username || url.password || url.hash || !url.pathname.startsWith('/' + target.module + '/'))
        fail('route_scope_mismatch');
    }
  }
  write(journalPath, { phase: 'completed', binding, ...provenance });
  return { ...result, moduleIdentitySource: provenance,
    ...(screenRoutes ? { screenRoutes: receipt.screenRoutes, screenRoutesSource: receipt.screenRoutesSource } : {}) };
}
