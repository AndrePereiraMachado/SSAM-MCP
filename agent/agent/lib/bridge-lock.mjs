import path from 'node:path';
import { spawn } from 'node:child_process';

// The native helper opens each snapshot file with FileShare.Read before reporting readiness.
// Keep it alive while the agent may use the snapshot, including lazy dependency loads.
export function lockBridgeSnapshot(root, directory, runtimeRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(runtimeRoot, 'native', 'ssam-agent.exe'), ['bridge-lock', '--root', root, '--directory', directory],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let ready = false; let text = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Bridge snapshot lock timed out')); }, 15000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stderr.resume();
    child.stdout.on('data', chunk => {
      text += chunk;
      if (!ready && /locked\r?\n/.test(text)) {
        ready = true; clearTimeout(timer);
        resolve({ release() { return new Promise(done => { if (child.exitCode !== null) return done(); child.once('exit', done); child.stdin.end(); }); }, alive: () => child.exitCode === null });
      }
    });
    child.on('exit', () => { clearTimeout(timer); if (!ready) reject(new Error('Bridge snapshot could not be locked')); });
  });
}
