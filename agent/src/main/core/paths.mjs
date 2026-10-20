// Where the app keeps things, as pure functions of the platform and the environment (no Electron here, so tests run
// under plain Node).
//   - the agent root: the folder the pack is synced to and the agent runs from ("Folders" in docs/AGENTE-CLIENTE.md
//     and docs/AGENTE-MAC.md); the default is the one the guides give, %USERPROFILE%\SSAM-Agent or ~/SSAM-Agent;
//   - the bundled pack: resources/pack in the installed app (electron-builder extraResources), app/pack in a checkout;
//   - the files of the root the app reads or writes: the same names the agent and its launchers use.
import path from 'node:path';
import os from 'node:os';

export const ROOT_FOLDER_NAME = 'SSAM-Agent';

export function defaultRoot({ platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') return path.win32.join(env.USERPROFILE || os.homedir(), ROOT_FOLDER_NAME);
  const home = env.HOME && env.HOME.startsWith('/') ? env.HOME.replace(/\/+$/, '') : os.homedir();
  return path.posix.join(home, ROOT_FOLDER_NAME);
}

// The files of a root the app touches. agent/ssam-agent.mjs is the agent's entry (the copy the pack put in the root).
export function rootFiles(root) {
  const join = (...parts) => path.join(root, ...parts);
  return Object.freeze({
    root,
    pack: join('pack.json'),
    script: join('agent', 'ssam-agent.mjs'),
    config: join('private', 'config.json'),
    credential: join('private', 'credential'),
    state: join('private', 'agent.json'),
    stop: join('private', 'agent.stop'),
    pid: join('private', 'agent.pid'),
    log: join('private', 'agent.log'),
    inbox: join('inbox'),
  });
}

// The pack bundled with the app: resources/pack when packaged, <app>/pack in a checkout (scripts/build.mjs fills it).
export function bundledPackDir({ isPackaged, resourcesPath, appPath }) {
  return isPackaged ? path.join(resourcesPath, 'pack') : path.join(appPath, 'pack');
}
