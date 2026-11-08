// The state of the app's own update, as a small reducer over the events of electron-updater (checking-for-update,
// update-available, update-not-available, download-progress, update-downloaded, error) plus the app's own (off,
// scheduled). Pure, so the tray and the panel are tested without Electron.
//   status: off | idle | checking | available | downloading | ready | up-to-date | error
export const INITIAL = Object.freeze({ status: 'idle', url: null, version: null, percent: null, checkedAt: null, error: null, nextCheckAt: null });

export function reduce(state, event) {
  switch (event.type) {
    case 'off': return { ...INITIAL, status: 'off', error: event.reason ? String(event.reason).slice(0, 300) : null };
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
    case 'off': return `Version ${appVersion}. Updates are off: ${state.error ?? 'no update server is configured'}.`;
    case 'checking': return `Version ${appVersion}. Checking for updates...`;
    case 'available': return `Version ${appVersion}. Update ${state.version ?? ''} found; downloading.`;
    case 'downloading': return `Version ${appVersion}. Downloading update ${state.version ?? ''}: ${state.percent ?? 0}%.`;
    case 'ready': return `Update ${state.version ?? ''} is ready: restart the app to install it.`;
    case 'up-to-date': return `Version ${appVersion} is up to date${state.checkedAt ? ` (checked ${state.checkedAt})` : ''}.`;
    case 'error': return `Version ${appVersion}. The last update check failed: ${state.error}`;
    default: return `Version ${appVersion}.`;
  }
}

// Whether this build may install updates by itself. App 0.2.0 required an Authenticode publisher (publisherName in
// resources/app-update.yml, checked by electron-updater). App 0.2.8: the Windows app is never Authenticode-signed, so a
// Windows build updates itself only with a pinned Ed25519 update key (update-trust.mjs, from the build input): every
// downloaded installer must then carry the owner's signed statement (update-signature.mjs), checked before it is installed.
// A build without the key never updates itself (the sha512 of latest.yml only proves the download matches the feed, not who
// made it). A publisherName, when a build still has one, is checked by electron-updater on top of the statement.
// macOS: Squirrel.Mac checks the code signature itself.
export function publisherNames(appUpdateYml) {
  const lines = String(appUpdateYml ?? '').split(/\r?\n/);
  const at = lines.findIndex(line => /^publisherName:/.test(line));
  if (at < 0) return [];
  // A YAML scalar: 'single' ('' is a quote), "double" (\" is a quote) or plain. A full DN keeps its commas (review M1).
  const clean = value => {
    const v = value.trim();
    if (/^'.*'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'");
    if (/^".*"$/.test(v)) return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    return v;
  };
  // A flow list [a, 'b, c'] splits on the commas outside quotes; a plain scalar is one name, commas included.
  const flow = text => {
    const items = []; let current = '', quote = null;
    for (const ch of text) {
      if (quote) { if (ch === quote) quote = null; current += ch; continue; }
      if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
      if (ch === ',') { items.push(current); current = ''; continue; }
      current += ch;
    }
    items.push(current);
    return items.map(clean).filter(Boolean);
  };
  const inline = lines[at].slice('publisherName:'.length).trim();
  if (inline) return /^\[.*\]$/.test(inline) ? flow(inline.slice(1, -1)) : [clean(inline)].filter(Boolean);
  const names = [];
  for (const line of lines.slice(at + 1)) {
    const item = /^\s+-\s*(.*)$/.exec(line);
    if (!item) break;
    if (clean(item[1])) names.push(clean(item[1]));
  }
  return names;
}
export function updateTrustProblem({ platform, isPackaged, updatePublicKey }) {
  if (platform !== 'win32' || !isPackaged) return null;
  if (!String(updatePublicKey ?? '').trim())
    return 'this build cannot verify the signature of an update (UPDATE_KEY_MISSING: no pinned update key); install the next SSAM Agent by hand';
  return null;
}

// The installer electron-updater downloaded must BE the version latest.yml announced, and newer than this app (review M2 of
// F5): allowDowngrade only compares the label of latest.yml, and its sha512 comes from the same file, so a feed could serve
// an older, genuinely signed installer under a higher label and roll every machine back. productVersion is the installer's
// own version resource (electron-builder writes the app version there); productName must be the app's.
export function installerVersionProblem({ productVersion, productName, label, current, appName = 'SSAM Agent' }) {
  const parts = value => /^(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? ''))?.slice(1).map(Number) ?? null;
  const cmp = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
  const got = parts(productVersion), want = parts(label), now = parts(current);
  // UPDATE_INSTALLER_MISMATCH (app 0.2.8): the code the log keeps for every refusal of this check.
  if (!got) return 'the downloaded installer has no readable version; it is not installed';
  if (productName !== undefined && productName !== appName) return `the downloaded installer is "${productName}", not ${appName}; it is not installed`;
  if (!want || cmp(got, want) !== 0) return `the downloaded installer is version ${productVersion}, but the update server announced ${label}; it is not installed`;
  if (now && cmp(got, now) <= 0) return `the downloaded installer is version ${productVersion}, not newer than this app (${current}); it is not installed`;
  return null;
}

// Whether a check may start now (never over a download or an install that is ready).
export const canCheck = state => ['idle', 'up-to-date', 'error', 'available'].includes(state.status);

// The error of electron-updater in words for the panel: a 404 on latest.yml (or latest-mac.yml) is an update server
// with nothing published yet, not a broken app; anything else keeps the first line of its message.
export function describeUpdateError(message) {
  const text = String(message ?? 'unknown error');
  if (/404/.test(text) && /latest(-mac)?\.yml/.test(text)) return 'the update server has no version published yet (latest.yml not found); nothing to do until the owner publishes one';
  if (/ENOTFOUND|ERR_NAME_NOT_RESOLVED/.test(text)) return 'the update server could not be found (DNS); check the network or the update server address';
  if (/ECONNREFUSED|ETIMEDOUT|ERR_CONNECTION/.test(text)) return 'the update server did not answer; check the network or the update server address';
  return text.split('\n')[0].slice(0, 200);
}
