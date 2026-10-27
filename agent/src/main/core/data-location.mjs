import fs from 'node:fs';
import path from 'node:path';
import { defaultRoot, legacyRoot } from './paths.mjs';

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

// Move only the former default, never a user-selected folder. A rename on the
// same volume preserves permissions and credentials without a partial copy.
export function resolveDataLocation({ configured, platform = process.platform, env = process.env, isAlive = alive } = {}) {
  const previous = legacyRoot({ platform, env }), target = defaultRoot({ platform, env });
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const same = (a, b) => platform === 'win32' ? paths.resolve(a).toLowerCase() === paths.resolve(b).toLowerCase() : paths.resolve(a) === paths.resolve(b);
  if (configured && !same(configured, previous)) return { root: configured };
  if (!fs.existsSync(previous)) return { root: target };
  if (fs.existsSync(target)) return { root: previous, deferred: 'Both data locations exist; preserving the active data.' };
  if (fs.lstatSync(previous).isSymbolicLink() || !fs.existsSync(path.join(previous, 'private', 'config.json')))
    return { root: previous, deferred: 'The previous folder is not a recognized agent data directory.' };
  const pids = [];
  try { pids.push(Number(fs.readFileSync(path.join(previous, 'private', 'agent.pid'), 'utf8'))); } catch {}
  try { pids.push(JSON.parse(fs.readFileSync(path.join(previous, 'private', 'agent.json'), 'utf8')).pid); } catch {}
  if (pids.some(pid => Number.isInteger(pid) && pid > 0 && isAlive(pid)))
    return { root: previous, deferred: 'An agent still uses the previous data directory.' };
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.renameSync(previous, target);
    return { root: target, migrated: true };
  } catch (error) {
    return { root: previous, deferred: error.code || 'Data migration failed.' };
  }
}
