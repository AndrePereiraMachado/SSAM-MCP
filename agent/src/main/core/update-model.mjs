// The state of the app's own update, as a small reducer over the events of electron-updater (checking-for-update,
// update-available, update-not-available, download-progress, update-downloaded, error) plus the app's own (off,
// scheduled). Pure, so the tray and the panel are tested without Electron.
//   status: off | idle | checking | available | downloading | ready | up-to-date | error
export const INITIAL = Object.freeze({ status: 'idle', url: null, version: null, percent: null, checkedAt: null, error: null, nextCheckAt: null });

export function reduce(state, event) {
  switch (event.type) {
    case 'off': return { ...INITIAL, status: 'off' };
    case 'configured': return { ...state, status: state.status === 'off' ? 'idle' : state.status, url: event.url };
    case 'scheduled': return { ...state, nextCheckAt: event.at };
    case 'checking-for-update': return { ...state, status: 'checking', error: null };
    case 'update-available': return { ...state, status: 'available', version: event.version ?? null, percent: 0, error: null };
    case 'update-not-available': return { ...state, status: 'up-to-date', version: null, percent: null, checkedAt: event.at, error: null };
    case 'download-progress': return { ...state, status: 'downloading', percent: Math.max(0, Math.min(100, Math.round(event.percent ?? 0))) };
    case 'update-downloaded': return { ...state, status: 'ready', version: event.version ?? state.version, percent: 100, error: null };
    case 'error': return { ...state, status: state.status === 'ready' ? 'ready' : 'error', error: String(event.message ?? 'unknown error').slice(0, 300) };
    default: return state;
  }
}

// One line for the tray and the panel.
export function updateText(state, appVersion) {
  switch (state.status) {
    case 'off': return `Version ${appVersion}. Updates are off: no update server is configured.`;
    case 'checking': return `Version ${appVersion}. Checking for updates...`;
    case 'available': return `Version ${appVersion}. Update ${state.version ?? ''} found; downloading.`;
    case 'downloading': return `Version ${appVersion}. Downloading update ${state.version ?? ''}: ${state.percent ?? 0}%.`;
    case 'ready': return `Update ${state.version ?? ''} is ready: restart the app to install it.`;
    case 'up-to-date': return `Version ${appVersion} is up to date${state.checkedAt ? ` (checked ${state.checkedAt})` : ''}.`;
    case 'error': return `Version ${appVersion}. The last update check failed: ${state.error}`;
    default: return `Version ${appVersion}.`;
  }
}

// Whether a check may start now (never over a download or an install that is ready).
export const canCheck = state => ['idle', 'up-to-date', 'error', 'available'].includes(state.status);
