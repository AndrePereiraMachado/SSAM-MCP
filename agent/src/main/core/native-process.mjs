// Only the executable and fixed CLI commands cross this boundary. Credentials use
// stdin, never a command argument, environment variable or temporary file.
import { spawn } from 'node:child_process';

export function spawnNative(executable, args, { cwd, env = process.env, stdio = 'ignore' } = {}) {
  const proc = spawn(executable, args, { cwd, env, stdio, windowsHide: true });
  const ready = new Promise((resolve, reject) => { proc.once('error', reject); proc.once('spawn', () => resolve(proc.pid)); });
  ready.catch(() => {});
  return { ready, on: (event, callback) => proc.on(event, callback), kill: () => proc.kill(), stdout: proc.stdout, stderr: proc.stderr };
}

export function nativeCommand(executable, args, { cwd, env = process.env, input = '', timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = '', length = 0;
    const timer = setTimeout(() => { proc.kill(); reject(new Error('The native agent command timed out.')); }, timeoutMs);
    const capture = target => chunk => { length += chunk.length; if (length > 4 * 1024 * 1024) { proc.kill(); return; } if (target === 'out') output += chunk; else error += chunk; };
    proc.stdout.on('data', capture('out')); proc.stderr.on('data', capture('err'));
    proc.once('error', reason => { clearTimeout(timer); reject(reason); });
    proc.once('close', code => { clearTimeout(timer); resolve({ code: code ?? 1, output, error: error.trim() }); });
    proc.stdin.on('error', () => {});
    proc.stdin.end(input);
  });
}
