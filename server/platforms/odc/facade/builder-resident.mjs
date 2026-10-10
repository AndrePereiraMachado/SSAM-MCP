// C02 item 2 (package 3): the resident ODC builder. One `ODC3.Builder manifest-serve` process per generation of the builder
// binaries (the generation rule of the resident reader, reader-client.mjs: the binaries, the ODC Studio folder and the
// .NET runtime), started detached from a copy of the binaries in its cache folder (a rebuild never replaces a loaded DLL),
// found again through its state file and its ping, and asked one manifest at a time over loopback with the controller key
// of the local Hybrid authority. It keeps the ODC Studio assemblies bound, the JIT warm and the Model API configured once;
// each request loads its base and candidate once (PrepareManifest.Prepare). It exits after 15 idle minutes.
// residentManifest(args, options) -> {used:true, value} (the cold builder's answer shape) | {used:false, note} (run it cold).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { readerGeneration, readerRpc, readerAuthority } from './reader-client.mjs';
import { childEnv, dotnetPath } from './release-layout.mjs';

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
const firstLine = text => String(text ?? '').split(/\r?\n/).find(Boolean) ?? null;

async function liveState(file, generation, rpc) {
  try {
    const state = readJson(file);
    if (state.generation !== generation) return null;
    const ping = await rpc(state, ['ping'], null, 1000);
    return ping.ok && ping.data?.manifestGeneration === generation && ping.data.instanceId === state.instanceId && !ping.data.recycling ? state : null;
  } catch { return null; }
}

// The running server of this generation, or a new one (one starter at a time: the lock file of the folder).
async function ensureServer({ dll, runtimeDir, directory, generation, authority, rpc, spawnFn, waitMs }) {
  fs.mkdirSync(directory, { recursive: true });
  const stateFile = path.join(directory, 'worker.json');
  let state = await liveState(stateFile, generation, rpc);
  if (state) return state;
  const lock = path.join(directory, 'start.lock');
  const deadline = Date.now() + waitMs;
  for (;;) {
    try { fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { const owner = readJson(lock); process.kill(owner.pid, 0); }
      catch (e) { if (e.code === 'ESRCH' || e instanceof SyntaxError) { try { fs.unlinkSync(lock); } catch { /* raced */ } continue; } }
      state = await liveState(stateFile, generation, rpc); if (state) return state;
      if (Date.now() > deadline) throw new Error('another resident builder is still starting in ' + directory);
      await delay(75);
    }
  }
  try {
    state = await liveState(stateFile, generation, rpc); if (state) return state;
    const deployment = path.join(directory, 'bin');
    if (!fs.existsSync(deployment)) {
      const temporary = path.join(directory, 'bin-' + randomUUID());
      fs.cpSync(path.dirname(dll), temporary, { recursive: true });
      if (readerGeneration(path.join(temporary, path.basename(dll)), runtimeDir) !== generation) throw new Error('builder binaries changed during deployment');
      fs.renameSync(temporary, deployment);
    }
    const log = fs.openSync(path.join(directory, 'builder.log'), 'a');
    let startError;
    const child = spawnFn(dotnetPath(), [path.join(deployment, path.basename(dll)), 'manifest-serve', '--state', stateFile, '--generation', generation], {
      cwd: directory, detached: true, windowsHide: true, stdio: ['ignore', log, log],
      env: { ...childEnv(process.env), ANVIL_AUTHORITY_DIR: authority, ANVIL_ODC_STUDIO_DIR: runtimeDir } });
    child.on?.('error', error => { startError = error; }); child.unref?.(); fs.closeSync(log);
    while (Date.now() <= deadline) {
      if (startError) throw startError;
      state = await liveState(stateFile, generation, rpc); if (state) return state;
      if (child.exitCode != null) throw new Error('the resident builder failed to start; see ' + path.join(directory, 'builder.log'));
      await delay(75);
    }
    throw new Error('the resident builder did not start in time; see ' + path.join(directory, 'builder.log'));
  } finally { try { fs.unlinkSync(lock); } catch { /* already gone */ } }
}

// Warm-up (servidor/fase4): starts the resident builder of this generation when none runs, without any request, so the
// first delivery after a server start finds it warm. -> {ok:true, pid?} | {ok:false, note}. Never throws.
export async function warmResidentBuilder({ dll, runtimeDir, cacheRoot, rpc = readerRpc, spawnFn = spawn, waitMs = 120000 } = {}) {
  try {
    const generation = readerGeneration(path.resolve(dll), path.resolve(runtimeDir));
    const authority = readerAuthority();
    const directory = path.join(path.resolve(cacheRoot), 'odc-manifest', generation);
    const state = await ensureServer({ dll: path.resolve(dll), runtimeDir: path.resolve(runtimeDir), directory, generation, authority, rpc, spawnFn, waitMs });
    return { ok: true, ...(Number.isInteger(state?.pid) ? { pid: state.pid } : {}) };
  } catch (error) { return { ok: false, note: firstLine(error.message) }; }
}
// options: {dll, runtimeDir, cacheRoot, root} (lib.mjs passes the reader's ODC configuration and the builder root), and for
// tests rpc, spawnFn, authorization, waitMs. A refusal of the builder comes back as the cold builder answers it.
export async function residentManifest(args, { dll, runtimeDir, cacheRoot, root, rpc = readerRpc, spawnFn = spawn, authorization, waitMs = 120000 } = {}) {
  let generation, authority, key;
  try {
    generation = readerGeneration(path.resolve(dll), path.resolve(runtimeDir));
    authority = readerAuthority();
    key = authorization ?? fs.readFileSync(path.join(authority, 'bridge.key'), 'utf8').trim();
  } catch (error) { return { used: false, note: 'resident builder unavailable: ' + error.message }; }
  const directory = path.join(path.resolve(cacheRoot), 'odc-manifest', generation);
  let state;
  try { state = await ensureServer({ dll: path.resolve(dll), runtimeDir: path.resolve(runtimeDir), directory, generation, authority, rpc, spawnFn, waitMs }); }
  catch (error) { return { used: false, note: error.message }; }
  let response;
  try { response = await rpc(state, ['manifest', JSON.stringify({ root, args })], key, 600000); }
  catch (error) {
    // Written and no answer: the manifest may exist in its new output folder; never run it again over the same folder.
    return { used: true, value: { ok: false, output: [], error: 'the resident builder gave no answer (' + firstLine(error.message) + '); nothing was merged', resident: true } };
  }
  if (response?.executed === false || response?.retryable === true) return { used: false, note: 'the resident builder did not run the request (' + firstLine(response.error) + ')' };
  if (response?.ok === true && typeof response.data?.manifest === 'string')
    return { used: true, value: { ok: true, manifest: response.data.manifest, output: [response.data.manifest], resident: true } };
  return { used: true, value: { ok: false, output: [], error: firstLine(response?.error) ?? 'builder failed', resident: true } };
}
