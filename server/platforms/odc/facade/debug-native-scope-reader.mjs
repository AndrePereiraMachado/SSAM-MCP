// Read the installed Model API's debugger scope in a separate, hash-built CLI.
// No values are synthesized, and no loaded Studio/worker assembly is replaced.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { anvilRoot, workspaceRoot, o11Lane } from './workspace.mjs';
import { nativeInspectionScopeMetadata } from './debug-native-inspection-metadata.mjs';
import { connectionEnvironment } from './studio-session.mjs';
const exec = promisify(execFile), builds = new Map();
const fail = code => { throw new Error('debug_native_scope_' + code); };
// O11 platform callback flows are debugger functions of their own (parent of their nodes):
// a callback scope names its flow key as functionKey, never the owning service/client.
export const O11_CALLBACK_FLOWS = Object.freeze({ RestServiceAuthenticationFlow: ['OnAuthentication'], RestServiceCallbackActionFlow: ['OnRequest', 'OnResponse'],
  RestCallbackActionFlow: ['OnBeforeRequest', 'OnBeforeRequestAdvanced', 'OnAfterResponse'], SOAPCallbackActionFlow: ['OnBeforeRequest', 'OnBeforeRequestAdvanced', 'OnAfterResponse'] });
// ODC REST callback flows (RESTService/REST plugin kinds of the installed ODC model; ODC has no SOAP callbacks).
export const ODC_CALLBACK_FLOWS = Object.freeze({ RestServiceAuthenticationFlow: ['OnAuthentication'], RestServiceCallbackActionFlow: ['OnRequest', 'OnResponse'],
  RestCallbackActionFlow: ['OnBeforeRequest', 'OnBeforeRequestAdvanced', 'OnAfterResponse', 'OnAfterResponseAdvanced'] });
const callbackOf = (lane, callback) => {
  if (callback === undefined) return null;
  const flows = lane === 'o11' ? O11_CALLBACK_FLOWS : lane === 'odc' ? ODC_CALLBACK_FLOWS : null;
  if (!flows || !callback || typeof callback !== 'object' || !Object.hasOwn(flows, callback.kind) ||
      !flows[callback.kind].includes(callback.name)) fail('callback_invalid');
  return { kind: callback.kind, name: callback.name };
};
function sources(directory, hash) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (['bin', 'obj', '.local'].includes(item.name)) continue;
    const file = path.join(directory, item.name);
    if (item.isDirectory()) sources(file, hash);
    else if (/\.(cs|csproj|props|targets|json)$/.test(item.name)) hash.update(file).update(fs.readFileSync(file));
  }
}
async function build(lane) {
  const studioDir = lane === 'odc' ? (await import('./lib.mjs')).odcStudioDir()
    : connectionEnvironment(anvilRoot, o11Lane.lane).ANVIL_STUDIO_DIR ?? process.env.ANVIL_STUDIO_DIR
      ?? (await (await import('./lanes.mjs')).anvilLaneFacts()).studioDir;
  if (!studioDir || !fs.existsSync(path.join(studioDir, 'OutSystems.Model.Implementation.dll'))) fail('installation_unavailable');
  const hash = createHash('sha256').update(lane).update(studioDir);
  for (const name of ['Anvil.Core', 'Anvil.Core.Odc', 'Anvil.Cli', 'Anvil.Cli.Odc']) sources(path.join(anvilRoot, 'src', name), hash);
  for (const name of ['Directory.Build.props', 'Directory.Build.targets', 'Directory.Packages.props']) {
    const file = path.join(anvilRoot, name); if (fs.existsSync(file)) hash.update(fs.readFileSync(file));
  }
  for (const name of ['OutSystems.Model.Implementation.dll', 'ServiceStudio.Presenter.dll']) {
    const stat = fs.statSync(path.join(studioDir, name)); hash.update(name + ':' + stat.size + ':' + stat.mtimeMs);
  }
  const directory = path.join(workspaceRoot, '.local', 'debugger', 'scope-builds', lane, hash.digest('hex').slice(0, 24));
  const dll = path.join(directory, lane === 'o11' ? 'anvil.dll' : 'anvil-odc.dll');
  if (!fs.existsSync(path.join(directory, 'ready.json'))) {
    fs.mkdirSync(directory, { recursive: true });
    const lock = path.join(workspaceRoot, '.local', 'debugger', 'scope-build-' + lane + '.lock'); let fd;
    try { fd = fs.openSync(lock, 'wx'); } catch { fail('build_in_progress'); }
    try {
      const project = lane === 'o11' ? 'Anvil.Cli' : 'Anvil.Cli.Odc';
      await exec('dotnet', ['build', path.join(anvilRoot, 'src', project, project + '.csproj'), '-c', 'Release', '-o', directory,
        '-p:' + (lane === 'o11' ? 'SSDir' : 'OdcInstall') + '=' + studioDir, '--nologo', '-v', 'quiet'],
      { windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
      fs.writeFileSync(path.join(directory, 'ready.json'), JSON.stringify({ lane, studioDir }));
    } catch { fail('build_failed'); }
    finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
  return { dll, studioDir };
}
// callbackFlows: the callback flows of the published capture ({ functionKey, kind, callback }, e.g.
// the runner-derived callback scopes). The native reply does not name the flow kind, so a callback
// label is accepted only when this list holds that exact flow; otherwise it is refused before reading.
export async function readNativeInspectionScopes({ lane, source, moduleKey, scopes, directory, runtime = 'client', callbackFlows }, services = {}) {
  if (!['o11', 'odc'].includes(lane)) fail('lane_invalid');
  if (!['client', 'server'].includes(runtime)) fail('runtime_invalid');
  const sha = source.sha256.toLowerCase();
  const callbacks = scopes.map(scope => callbackOf(lane, scope.callback)), callbackScopes = [];
  scopes.forEach((scope, i) => { if (callbacks[i] && !(Array.isArray(callbackFlows) && callbackFlows.some(flow => flow?.functionKey === scope.functionKey &&
    flow.kind === callbacks[i].kind && (flow.callback ?? flow.name) === callbacks[i].name && (flow.moduleKey ?? moduleKey) === moduleKey))) fail('callback_unverified'); });
  const guard = () => { if (createHash('sha256').update(fs.readFileSync(source.path)).digest('hex') !== sha) fail('source_changed'); };
  guard();
  if (!services.build && !builds.has(lane)) builds.set(lane, build(lane).catch(error => { builds.delete(lane); throw error; }));
  const { dll, studioDir } = await (services.build ? services.build(lane) : builds.get(lane)), variables = [], evidence = [], coverage = [];
  let nativeBuiltins;
  const expressionBindings = [], functionHashes = new Map();
  fs.mkdirSync(directory, { recursive: true });
  for (const scope of scopes) for (const nodeKey of scope.nodeKeys) {
    // Native frame functionType, when the caller has it. Screen/block Aggregates (NRNodes.WebScreenDataSet) are
    // not IBreakpointable in either installed model: no node scope exists to read, so refuse before the reader.
    if (scope.functionType != null && (typeof scope.functionType !== 'string' || scope.functionType.length > 200)) fail('function_type_invalid');
    if (/(?:^|\.)WebScreenDataSet$/.test(scope.functionType ?? '')) fail('aggregate_not_breakpointable');
    if (scope.previousNodeKey != null && (scope.nodeKeys.length !== 1 || !/^[A-Za-z0-9_+]{22}$/.test(scope.previousNodeKey)))
      fail('previous_node_invalid');
    guard();
    const argv = [dll, 'debug-scope', '--oml', source.path, '--expected-sha256', sha,
      '--node-key', nodeKey, '--function-key', scope.functionKey, '--work', path.join(directory, 'model')];
    if (lane === 'o11') argv.push('--ss-dir', studioDir);
    if (scope.previousNodeKey) argv.push('--previous-node-key', scope.previousNodeKey);
    let value;
    try {
      const { stdout } = await (services.exec ?? exec)('dotnet', argv, { windowsHide: true, timeout: 90000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, ANVIL_LANE: lane === 'o11' ? o11Lane.lane : 'odc',
          ANVIL_STUDIO_DIR: studioDir, ANVIL_ODC_STUDIO_DIR: studioDir } });
      value = JSON.parse(stdout);
    } catch { fail('read_failed'); }
    guard();
    if (!value.ok) fail('read_refused');
    if (value.data.expressionBindings) {
      const binding = value.data.expressionBindings;
      if (binding.identity?.sourceSha256 !== sha || binding.identity?.moduleKey !== moduleKey || binding.identity?.functionKey !== scope.functionKey)
        fail('expression_binding_mismatch');
      expressionBindings.push(binding);
    }
    if (value.data.nativeBuiltins) {
      if (nativeBuiltins && JSON.stringify(nativeBuiltins) !== JSON.stringify(value.data.nativeBuiltins)) fail('native_identity_changed');
      nativeBuiltins = value.data.nativeBuiltins;
    }
    const metadata = nativeInspectionScopeMetadata({ scope: value.data, moduleKey, sourceSha256: sha, functionKey: scope.functionKey, nodeKey,
      previousNodeKey: scope.previousNodeKey ?? null, lane });
    if (!metadata[runtime]) fail(runtime + '_scope_required');
    if (runtime === 'client') {
      const nativeHash = value.data.functionDebuggerHash;
      if (!/^[A-Za-z0-9_+]{22}$/.test(nativeHash ?? '')) fail('function_hash_unavailable');
      if (functionHashes.has(scope.functionKey) && functionHashes.get(scope.functionKey) !== nativeHash)
        fail('function_hash_changed');
      functionHashes.set(scope.functionKey, nativeHash);
    }
    variables.push(...metadata[runtime].variables); coverage.push(metadata.coverage);
    const callback = callbacks[scopes.indexOf(scope)];
    if (callback) callbackScopes.push({ moduleKey, functionKey: scope.functionKey, nodeKey, ...callback });
    const file = path.join(directory, 'scope-' + evidence.length + '.json');
    fs.writeFileSync(file, JSON.stringify(value)); evidence.push(file);
  }
  return { modules: [{ moduleKey, sourceSha256: sha }], variables, evidence, coverage, expressionBindings,
    functionHashes: [...functionHashes].map(([functionKey, debuggerHash]) => ({moduleKey, functionKey, debuggerHash, sourceSha256: sha})),
    ...(nativeBuiltins ? { nativeBuiltins } : {}), ...(callbackScopes.length ? { callbackScopes } : {}),
    breakpoints: scopes.flatMap(scope => scope.nodeKeys.map(key => moduleKey + ':' + key)) };
}
