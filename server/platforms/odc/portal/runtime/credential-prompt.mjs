// Only the owned credential form reports visibility. A spawned PID is not a window.
// State shared by all SSAM sessions contains window metadata, never field values.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('./windows-credential-prompt.ps1', import.meta.url));
const inFlight = new Map();
export function promptContext(kind, host, name = '') {
  if (!['portal', 'api-client', 'database', 'setting'].includes(kind)
      || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)
      || (['database', 'setting'].includes(kind) ? !/^[A-Za-z0-9_.-]{1,64}$/.test(name) : name !== ''))
    throw new Error('Invalid private prompt context');
  return { kind, host, name, key: createHash('sha256').update(JSON.stringify([kind, host, name])).digest('hex') };
}
export function projectPrompt(raw) {
  const allowed = ['visible', 'starting', 'absent', 'cancelled', 'stored', 'failed'];
  const state = allowed.includes(raw?.state) ? raw.state : 'failed';
  const visible = state === 'visible' && raw?.visible === true && Number.isInteger(raw?.pid) && raw.pid > 0;
  const code = /^CREDENTIAL_(?:PROMPT|FOCUS)_[A-Z_]+$/.test(raw?.code ?? '') ? raw.code : undefined;
  return { state: state === 'visible' && !visible ? 'failed' : state, visible, foreground: visible && raw?.foreground === true,
    opened: visible && raw?.opened === true, alreadyOpen: visible && raw?.opened !== true,
    ...(visible ? { pid: raw.pid } : {}), ...(code ? { code } : {}),
    ...(typeof raw?.recovered === 'boolean' ? { recovered: raw.recovered } : {}) };
}
export function createCredentialPrompt({ env = process.env, run = execFile, platform = process.platform } = {}) {
  return async (kind, host, name = '', action = 'ensure') => {
    const context = promptContext(kind, host, name);
    if (!['ensure', 'status', 'focus'].includes(action)) throw new Error('Invalid private prompt action');
    if (platform !== 'win32' || env.SSAM_ODC_OFFLINE === '1')
      return { state: 'failed', visible: false, opened: false, code: 'CREDENTIAL_PROMPT_UNAVAILABLE' };
    const state = path.join(env.USERPROFILE || os.homedir(), '.ssam-hybrid', 'auth', 'prompts', 'odc-' + context.key);
    const key = state + ':' + action;
    if (inFlight.has(key)) return inFlight.get(key);
    const work = (async () => {
      fs.mkdirSync(state, { recursive: true });
      const powershell = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper,
        '-Mode', action, '-Kind', kind, '-HostName', host, '-ContextKey', context.key, '-StateDirectory', state,
        ...(name ? ['-EntryName', name] : [])];
      return new Promise(resolve => run(powershell, args, { windowsHide: true, timeout: 16000, maxBuffer: 4096 }, (error, stdout) => {
        // Never forward stderr or arbitrary helper output: only fixed window metadata.
        if (error) return resolve({ state: 'failed', visible: false, opened: false, code: 'CREDENTIAL_PROMPT_UNAVAILABLE' });
        try { resolve(projectPrompt(JSON.parse(String(stdout).replace(/^\uFEFF/, '')))); }
        catch { resolve({ state: 'failed', visible: false, opened: false, code: 'CREDENTIAL_PROMPT_PROTOCOL_INVALID' }); }
      }));
    })();
    inFlight.set(key, work);
    try { return await work; } finally { inFlight.delete(key); }
  };
}
