// Common read-only transport for ODC and O11. Native captures live in a dedicated process.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { RELEASE, authorityDir, childEnv, dotnetPath, layoutPath, root } from './release-layout.mjs';

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
// A long-lived MCP client keeps the generation of the module it actually loaded. The release bundle has no source of
// this module to hash: the release's own identity (release.json: version and the sha256 of every file) takes its place.
const clientSource = RELEASE ? null : fs.readFileSync(layoutPath('platforms/odc/facade/reader-client.mjs', null));
const releaseMode = opts => opts?.release ?? RELEASE;

// opts (tests): {release, env, execPath}, as in release-layout.mjs.
export function readerGeneration(dll, runtimeDir, opts) {
  const release = releaseMode(opts), env = opts?.env ?? process.env;
  // Release: the packaged runtime, never DOTNET_ROOT inherited nor the dotnet of the PATH.
  const dotnetRoot = release ? path.dirname(dotnetPath(opts)) : env.DOTNET_ROOT;
  const hash = createHash('sha256').update('ssam-read-process/1');
  hash.update(release ? fs.readFileSync(path.join(root(opts), 'release.json')) : clientSource);
  hash.update(JSON.stringify([process.arch,dotnetRoot,env.DOTNET_ROLL_FORWARD]));
  // The runtime folder itself: a copy of the installation keeps its names, sizes and times, and a reader started
  // over one folder must never be reused for the other.
  const folder = path.resolve(runtimeDir);
  hash.update(JSON.stringify(['runtime', process.platform === 'win32' ? folder.toLowerCase() : folder]));
  // Hash our executable/dependencies, not just their timestamps. Runtime installation changes
  // also create a new generation. Installed native DLLs are never copied or overwritten.
  for (const name of fs.readdirSync(path.dirname(dll)).filter(n => /\.(dll|json)$/i.test(n)).sort()) {
    hash.update(name); hash.update(fs.readFileSync(path.join(path.dirname(dll), name)));
  }
  for (const name of fs.readdirSync(runtimeDir).filter(n => /\.(dll|exe|json)$/i.test(n)).sort()) {
    const stat = fs.statSync(path.join(runtimeDir, name));
    hash.update(JSON.stringify([name, stat.size, stat.mtimeMs]));
    if (['OutSystems.Model.dll','OutSystems.Model.V1.dll','OutSystems.Model.Implementation.dll','OutSystems.ModelAPILoader.dll'].includes(name))
      hash.update(fs.readFileSync(path.join(runtimeDir,name)));
  }
  const dotnet = path.join(dotnetRoot ?? path.join(env.ProgramFiles ?? 'C:\\Program Files','dotnet'), 'shared','Microsoft.NETCore.App');
  if (fs.existsSync(dotnet)) for(const version of fs.readdirSync(dotnet).sort()) {
    const core = path.join(dotnet,version,'System.Private.CoreLib.dll');
    if (fs.existsSync(core)) { const stat=fs.statSync(core); hash.update(JSON.stringify([version,stat.size,stat.mtimeMs])); }
  }
  return hash.digest('hex');
}

export function readerRpc(state, args, authorization, timeout = 120_000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: state.port });
    let text = '', settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; socket.destroy(); error ? reject(error) : resolve(result); };
    socket.setTimeout(timeout, () => finish(new Error('Read process timed out')));
    socket.setEncoding('utf8');
    socket.on('error', error => finish(error));
    socket.on('end', () => { if (!settled) finish(new Error('Read process closed without a complete response')); });
    socket.on('connect', () => socket.write(JSON.stringify({args, ...(authorization ? {authorization} : {})}) + '\n'));
    socket.on('data', chunk => {
      text += chunk;
      if (text.length > 64 * 1024 * 1024) return finish(new Error('Reading exceeds 64 MiB; select fewer elements or a narrower scope'));
      const newline = text.indexOf('\n');
      if (newline >= 0) { try { finish(null, JSON.parse(text.slice(0, newline))); } catch (error) { finish(error); } }
    });
  });
}

async function liveState(file, generation) {
  try {
    const state = readJson(file);
    if (state.generation !== generation) return null;
    const ping = await readerRpc(state, ['ping'], null, 1000);
    return ping.ok && ping.data?.readOnly === true && ping.data.readerGeneration === generation
      && ping.data.instanceId === state.instanceId && !ping.data.recycling ? state : null;
  } catch { return null; }
}

async function ensureReader({dll, runtimeDir, platform, directory, generation, authority, indexRoot}) {
  fs.mkdirSync(directory, {recursive:true});
  const stateFile = path.join(directory, 'worker.json');
  let state = await liveState(stateFile, generation);
  if (state) return state;
  const lock = path.join(directory, 'start.lock');
  const deadline = Date.now() + 120_000;
  while (true) {
    try {
      fs.writeFileSync(lock, JSON.stringify({pid:process.pid,at:Date.now()}), {flag:'wx'});
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Recover a starter that exited before writing the connection record.
      try { const owner = readJson(lock); try { process.kill(owner.pid, 0); } catch (e) {
        if (e.code === 'ESRCH') { fs.unlinkSync(lock); continue; }
      } } catch {
        // An interrupted create can leave an empty lock without a PID. Give a
        // concurrent writer its full startup window before recovering that lock.
        try { if (Date.now() - fs.statSync(lock).mtimeMs > 120_000) { fs.unlinkSync(lock); continue; } } catch { }
      }
      state = await liveState(stateFile, generation); if (state) return state;
      if (Date.now() > deadline) throw new Error('Another read process is still starting; inspect ' + directory);
      await delay(75);
    }
  }
  try {
    state = await liveState(stateFile, generation); if (state) return state;
    const deployment = path.join(directory, 'bin');
    if (!fs.existsSync(deployment)) {
      const temporary = path.join(directory, 'bin-' + randomUUID());
      fs.cpSync(path.dirname(dll), temporary, {recursive:true});
      // A concurrent build must never produce a mixed generation.
      if (readerGeneration(path.join(temporary, path.basename(dll)), runtimeDir) !== generation)
        throw new Error('Reader binaries changed during deployment; retry after the build completes');
      fs.renameSync(temporary, deployment);
    }
    const log = fs.openSync(path.join(directory, 'reader.log'), 'a');
    let startError;
    // The child loads the runtime the generation hashed: the ODC reader (ODC3.Builder) binds ANVIL_ODC_STUDIO_DIR
    // and refuses a folder that is not an ODC Studio; the other variables it inherits (ANVIL_ODC_FEATURES_DIR too).
    // indexRoot: the module index store the caller reads (module-map.mjs indexRoot), absolute, so the reader writes
    // there even when its copy lives outside the workspace (SSAM_READER_CACHE_ROOT elsewhere).
    // dotnetPath and childEnv answer 'dotnet' and a copy of the environment in the checkout; in a release, the packaged
    // runtime and the contract's variables (DOTNET_ROOT among them, the runtime the generation hashed).
    const child = spawn(dotnetPath(), [path.join(deployment,path.basename(dll)), 'read-serve', '--state', stateFile,
      '--generation', generation, '--work', path.join(directory, 'work')], {
      cwd:directory, detached:true, windowsHide:true, stdio:['ignore',log,log],
      env:{...childEnv(process.env), ANVIL_AUTHORITY_DIR:authority, ANVIL_STUDIO_DIR:runtimeDir,
        ...(platform === 'odc' ? {ANVIL_ODC_STUDIO_DIR:runtimeDir} : {}), ...(indexRoot ? {SSAM_MODULE_INDEX_ROOT:indexRoot} : {})}
    });
    child.on('error', error => { startError = error; }); child.unref(); fs.closeSync(log);
    while (Date.now() <= deadline) {
      if (startError) throw startError;
      state = await liveState(stateFile, generation); if (state) return state;
      if (child.exitCode != null) throw new Error('Read process failed to start; see ' + path.join(directory, 'reader.log'));
      await delay(75);
    }
    throw new Error('Read process startup timed out; see ' + path.join(directory, 'reader.log'));
  } finally { fs.unlinkSync(lock); }
}

// The authority whose bridge.key the reader trusts. Release: release-layout authorityDir (config.json authorityDir, else
// %USERPROFILE%\.anvil\authority); an inherited ANVIL_AUTHORITY_DIR and LOCALAPPDATA are never read. Checkout:
// ANVIL_AUTHORITY_DIR, else %LOCALAPPDATA%\Anvil\authority, as before.
export function readerAuthority(opts) {
  if (releaseMode(opts)) return authorityDir(opts);
  const env = opts?.env ?? process.env;
  return env.ANVIL_AUTHORITY_DIR ?? path.join(env.LOCALAPPDATA, 'Anvil', 'authority');
}

export async function readSnapshot({dll, runtimeDir, cacheRoot, platform, request, indexRoot}) {
  const started = performance.now();
  // The child runs inside its own cache directory. Resolve caller-relative paths
  // before changing that working directory (including an optional cache override).
  dll=path.resolve(dll);runtimeDir=path.resolve(runtimeDir);cacheRoot=path.resolve(cacheRoot);
  if (indexRoot) indexRoot=path.resolve(indexRoot);
  const generation = readerGeneration(dll, runtimeDir);
  const generationMs = performance.now() - started;
  const authority = readerAuthority();
  const authorization = fs.readFileSync(path.join(authority,'bridge.key'), 'utf8').trim();
  const directory = path.join(cacheRoot, platform, generation);
  for (let attempt=0; attempt<2; attempt++) {
    const state = await ensureReader({dll,runtimeDir,platform,directory,generation,authority,indexRoot});
    const phase = performance.now();
    let response;
    try { response = await readerRpc(state, ['read', JSON.stringify(request)], authorization); }
    catch (error) { if (attempt === 0) continue; throw error; }
    if (response.retryable && response.executed === false && attempt === 0) { await delay(100); continue; }
    if (!response.ok) throw new Error(response.error ?? 'Snapshot reading failed');
    return {...response, cache:{...response.cache,generation,instanceId:state.instanceId,pid:state.pid,runtime:state.runtime},
      timings:{...response.timings,generationMs,transportMs:performance.now()-phase,clientMs:performance.now()-started}};
  }
  throw new Error('Read process recycled twice; retry this read-only request');
}

// Navigation remains useful when a rich result exceeds the inline budget.
export function readingSummary(data) {
  let nodes=0, childrenOmitted=0, propertyErrors=0, propertyOmissions=0, propertiesMissing=0;
  const targets=[];
  const walk = (node, top=false) => {
    if (!node || typeof node !== 'object') return;
    if (node.tree) { walk(node.tree,true); return; }
    if (node.kind && node.key) {
      nodes++; childrenOmitted += node.childrenOmitted ?? 0;
      propertyErrors += Object.keys(node.propertyErrors ?? {}).length;
      propertyOmissions += Object.keys(node.propertiesOmitted ?? {}).length;
      propertiesMissing += (node.propertiesMissing ?? []).length;
      if (top) targets.push({kind:node.kind,name:node.name,reference:node.reference,path:node.path});
      for(const child of node.children ?? []) walk(child);
    } else if (Array.isArray(node.entries)) {
      for(const entry of node.entries) entry.data ? walk(entry.data) : walk(entry,true);
    }
  };
  walk(data,true);
  return {schema:data.schema, nodes, childrenOmitted, propertyErrors, propertyOmissions, propertiesMissing,
    ...(data.count != null ? {count:data.count,returned:data.returned,nextOffset:data.nextOffset,
      kindObserved:data.kindObserved,searchComplete:data.searchComplete,complete:data.complete,
      propertyReadErrors:data.propertyReadErrors,referenceReadErrors:data.referenceReadErrors,errorSamples:data.errorSamples} : {}),
    ...(data.schema === 'ssam-usages/1' ? {scope:data.scope,edges:data.entries.slice(0,8),edgesOmitted:Math.max(0,data.entries.length-8)} : {}),
    ...(data.requested != null ? {requested:data.requested,complete:data.complete,
      failures:data.entries.filter(e=>!e.ok).map(e=>({selector:e.selector,error:e.error})),
      selections:data.entries.filter(e=>e.ok).map(e=>({selector:e.selector,...readingSummary(e.data)}))} : {}),
    targets:targets.slice(0,32), targetsOmitted:Math.max(0,targets.length-32),
    notices:data.notices};
}

export function presentReading(response, {file,out,budget=60000}) {
  const started=performance.now();
  const json=JSON.stringify(response.data,null,2);
  fs.mkdirSync(path.dirname(out),{recursive:true});
  const temporary=out+'.'+randomUUID()+'.tmp'; fs.writeFileSync(temporary,json); fs.renameSync(temporary,out);
  return {ok:true,file,out,bytes:Buffer.byteLength(json),characters:json.length,inline:json.length<=budget,
    sourceSha256:response.sourceSha256,cache:response.cache,
    timings:{...response.timings,presentationMs:performance.now()-started},
    ...(json.length<=budget ? response.data : {summary:readingSummary(response.data),
      navigation:{target:file,expectedSourceSha256:response.sourceSha256},
      hint:'Use navigation.target (.oml), expectedSourceSha256 and a summary target reference as path for details. out is the saved JSON evidence.'})};
}
