// screen.render on the agent (docs/FASE2-AGENTE.md 4.4): the renderer is the Electron of the SSAM Agent app, run as a
// short-lived worker ("<app> --ssam-render-worker", src/main/render/worker.mjs) that reads one request on its standard
// input and writes one line of facts. The app's build records it in pack.json, renderer {kind:"electron-worker",
// protocol:1, path (relative to the runtime: Windows ../../SSAM Agent.exe, macOS ../../MacOS/SSAM Agent), electron};
// the agent takes it only when it stays inside the installation, exists and speaks protocol 1, and only then announces
// screen.render. No environment variable or argument names a renderer (tests inject one with deps.renderer).
// One worker at a time and at most two calls waiting (RENDER_BUSY above); the worker is killed at the request's
// timeoutMs or the call's deadline, whichever comes first (RENDER_TIMEOUT); a worker that ends with another code than 0,
// or writes more than 20 MiB, is RENDER_FAILED; its facts are checked (render-request.mjs) before they are answered.
// Rendering changes nothing on this machine: every error says executed:false. The same rules are
// native/Ssam.Agent/RenderKinds.cs.
import fs from 'node:fs';
import path from 'node:path';
import { spawn as spawnProcess, spawnSync } from 'node:child_process';
import { AgentError, refuse } from './errors.mjs';
import { validateRenderRequest, validateRenderFacts, RENDER_PROTOCOL } from './render-request.mjs';
import { insidePath, flavor } from './local-paths.mjs';

export const RENDER_WORKER_FLAG = '--ssam-render-worker';
export const RENDER_STDOUT_BYTES = 20 * 1024 * 1024;
export const RENDER_QUEUE = 2;

// The renderer of this installation: {path, args, version} or {reason}.
export function resolveRenderer({ runtimeRoot, dataRoot, pack, platform = process.platform, files = fs }) {
  const renderer = pack?.renderer;
  if (!renderer) return { reason: 'this installation has no SSAM Agent app to render with' };
  if (renderer.kind !== 'electron-worker' || renderer.protocol !== RENDER_PROTOCOL) return { reason: 'the renderer of this installation speaks another protocol' };
  const p = flavor(platform);
  if (typeof renderer.path !== 'string' || renderer.path === '' || p.isAbsolute(renderer.path)) return { reason: 'the renderer path of this installation is not relative' };
  const runtime = p.resolve(runtimeRoot);
  const install = p.resolve(runtime, '..', '..');
  const file = p.resolve(runtime, renderer.path);
  if (!insidePath(file, install, platform) || insidePath(file, runtime, platform) || (dataRoot && insidePath(file, p.resolve(dataRoot), platform)))
    return { reason: 'the renderer path leaves the installation' };
  try {
    if (!files.statSync(file).isFile()) return { reason: 'the renderer is not a file' };
    const real = (files.realpathSync.native ?? files.realpathSync)(file);
    if (!insidePath(real, (files.realpathSync.native ?? files.realpathSync)(install), platform)) return { reason: 'the renderer path leaves the installation' };
  } catch { return { reason: 'the renderer is missing from the installation' }; }
  return { path: file, args: [], version: typeof renderer.electron === 'string' ? renderer.electron.slice(0, 40) : null };
}

// Ends a worker and the processes it started (Windows: taskkill /T; macOS: its helpers end with it).
function killTree(child, platform) {
  if (!child.pid) return;
  if (platform === 'win32') { try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 }); } catch { /* gone */ } }
  try { child.kill('SIGKILL'); } catch { /* gone */ }
}

// renderer: resolveRenderer's answer (or the tests' {path, args}). tempRoot: the folder where each worker gets a temporary
// folder of its own (its TEMP, so Chromium's profile lands there), removed after the worker ended (the agent's private\tmp:
// a worker cannot remove the files its own Chromium still holds). spawn and env (tests): the process start and its
// environment (the agent's own, without ELECTRON_RUN_AS_NODE).
export function createRenderer({ renderer, tempRoot = null, platform = process.platform, now = Date.now, spawn = spawnProcess, env = process.env } = {}) {
  const available = Boolean(renderer?.path);
  let running = false;
  const waiting = [];

  function runWorker(request, budgetMs) {
    return new Promise((resolve, reject) => {
      const workerEnv = { ...env };
      delete workerEnv.ELECTRON_RUN_AS_NODE;
      let temp = null;
      try { if (tempRoot) { fs.mkdirSync(tempRoot, { recursive: true }); temp = fs.mkdtempSync(path.join(tempRoot, 'render-')); Object.assign(workerEnv, { TEMP: temp, TMP: temp, TMPDIR: temp }); } }
      catch { reject(new AgentError('RENDER_FAILED', 'The render worker has no temporary folder', { executed: false })); return; }
      const cleanup = () => { if (temp) fs.promises.rm(temp, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }).catch(() => {}); };
      let child;
      try { child = spawn(renderer.path, [...(renderer.args ?? []), RENDER_WORKER_FLAG], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: workerEnv }); }
      catch { cleanup(); reject(new AgentError('RENDER_FAILED', 'The render worker could not start', { executed: false })); return; }
      const chunks = []; let size = 0; let settled = false; let reason = null;
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); cleanup(); if (error) reject(error); else resolve(value); };
      const timer = setTimeout(() => { reason = 'timeout'; killTree(child, platform); }, Math.max(0, budgetMs));
      child.stdout.on('data', chunk => {
        size += chunk.length;
        if (size > RENDER_STDOUT_BYTES) { if (!reason) { reason = 'large'; killTree(child, platform); } return; }
        chunks.push(chunk);
      });
      child.stdin.on('error', () => {});
      child.on('error', () => finish(new AgentError('RENDER_FAILED', 'The render worker could not start', { executed: false })));
      child.on('close', code => {
        if (reason === 'timeout') return finish(new AgentError('RENDER_TIMEOUT', `The render did not finish in ${Math.round(budgetMs / 1000)} s; the worker was stopped`, { executed: false }));
        if (reason === 'large') return finish(new AgentError('RENDER_FAILED', `The render worker wrote more than ${RENDER_STDOUT_BYTES} bytes; the worker was stopped`, { executed: false }));
        if (code !== 0) return finish(new AgentError('RENDER_FAILED', `The render worker ended with code ${code}`, { executed: false }));
        const line = Buffer.concat(chunks).toString('utf8').split(/\r?\n/).filter(text => text.trim()).at(-1);
        let facts;
        try { facts = JSON.parse(line ?? ''); } catch { return finish(new AgentError('RENDER_FAILED', 'The render worker did not write one line of JSON', { executed: false })); }
        finish(null, facts);
      });
      child.stdin.end(JSON.stringify(request));
    });
  }

  async function render(params, { deadline = null } = {}) {
    if (!available) throw refuse('RENDER_UNAVAILABLE', 'This agent cannot render screens: ' + (renderer?.reason ?? 'no renderer') + '. Update the SSAM Agent app to render screens.');
    const request = validateRenderRequest(params);
    if (running && waiting.length >= RENDER_QUEUE) throw refuse('RENDER_BUSY', 'The agent is already rendering and has two renders waiting; try again shortly');
    // A waiting call takes the worker over from the one that ends (running stays true in between).
    if (running) await new Promise(resolve => waiting.push(resolve));
    running = true;
    try {
      const budget = Math.min(request.timeoutMs, deadline === null ? Infinity : deadline - now());
      if (budget <= 0) throw refuse('RENDER_TIMEOUT', 'The deadline of the call passed before the render started');
      return validateRenderFacts(await runWorker(request, budget), request);
    } finally {
      const next = waiting.shift();
      if (next) next(); else running = false;
    }
  }
  return { available, reason: renderer?.reason ?? null, version: renderer?.version ?? null, render };
}

// The doctor's line: "available (Electron 44.9.2)" or "not available (<reason>)".
export const rendererLine = renderer => (renderer?.path ? `available (Electron ${renderer.version ?? 'version unknown'})` : `not available (${renderer?.reason ?? 'no renderer'})`);
