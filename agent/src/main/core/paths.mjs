// Where the app keeps things, as pure functions of the platform and the environment (no Electron here, so tests run
// under plain Node).
//   - the desktop agent root: private application data under Library/Roaming;
//     legacyRoot is used only to migrate the previous home-directory default;
//   - the bundled pack: resources/pack in the installed app (electron-builder extraResources), app/pack in a checkout;
//   - the files of the root the app reads or writes: the same names the agent and its launchers use.
import path from 'node:path';
import os from 'node:os';

export const ROOT_FOLDER_NAME = 'SSAM-Agent';

export function legacyRoot({ platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') return path.win32.join(env.USERPROFILE || os.homedir(), ROOT_FOLDER_NAME);
  const home = env.HOME && env.HOME.startsWith('/') ? env.HOME.replace(/\/+$/, '') : os.homedir();
  return path.posix.join(home, ROOT_FOLDER_NAME);
}

export function defaultRoot({ platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') return path.win32.join(env.APPDATA || path.win32.join(env.USERPROFILE || os.homedir(), 'AppData', 'Roaming'), ROOT_FOLDER_NAME, 'data');
  const home = env.HOME && env.HOME.startsWith('/') ? env.HOME : os.homedir();
  // Keep the data path free of spaces for the Studio bridge path protocol.
  return path.posix.join(home, platform === 'darwin' ? 'Library' : '.local/share', ROOT_FOLDER_NAME, 'data');
}

// Data and program paths are explicit. Legacy standalone callers can still use a single root.
export function rootFiles(root, runtimeRoot = root) {
  const join = (...parts) => path.join(root, ...parts);
  return Object.freeze({
    root,
    pack: path.join(runtimeRoot, 'pack.json'),
    script: path.join(runtimeRoot, 'agent', 'ssam-agent.mjs'),
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
