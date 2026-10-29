import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as trust from './bridge-trust.mjs';
import { studioVersion, bundledBridgeSupports } from './studio-runtime.mjs';
import { lockBridgeSnapshot } from './bridge-lock.mjs';

const exec = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(message); };
const number = protocol => /^(?:v|d)(0|[1-9]\d{0,8})$/.exec(protocol ?? '')?.[1];
const safePart = part => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part) && !/[. ]$/.test(part)
  && !/^(?:con|prn|aux|nul|[c]om[1-9]|lpt[1-9])(?:\.|$)/i.test(part);
const safePath = name => typeof name === 'string' && name.length < 240 && name.split('/').every(safePart);
const textOf = manifest => typeof manifest === 'string' ? manifest : JSON.stringify(manifest);
const pair = m => m.lane + '/' + m.studioVersion;
const identity = m => pair(m) + '/' + m.protocol + '/' + m.sequence;
export const MAC_BRIDGE_REASON = 'Automatic bridge downloads are disabled on macOS in this build; use the bundled bridge.';

export async function verifyAuthenticode(file, thumbprint, { platform = process.platform, runtimeRoot, run = exec } = {}) {
  if (platform === 'win32') {
    const directory = (await run(path.join(runtimeRoot, 'native/ssam-agent.exe'), ['windows-directory'], { windowsHide: true, timeout: 10000 })).stdout.trim();
    if (!path.win32.isAbsolute(directory) || /[\r\n']/.test(directory)) fail('Invalid Windows system directory');
    const module = path.win32.join(directory, 'System32/WindowsPowerShell/v1.0/Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1');
    const script = "Import-Module '" + module + "' -Force -ErrorAction Stop; $s=Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath '"
      + file.replaceAll("'", "''") + "'; if ($s.Status -ne 'Valid' -or $s.SignatureType -ne 'Authenticode') { exit 1 }; $s.SignerCertificate.Thumbprint";
    const { stdout } = await run(path.win32.join(directory, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 30000, env: { ...process.env, PSModulePath: path.win32.join(directory, 'System32/WindowsPowerShell/v1.0/Modules') } });
    if (stdout.trim().toUpperCase() !== thumbprint) fail('Authenticode signer does not match the pinned certificate');
  } else fail(platform === 'darwin' ? MAC_BRIDGE_REASON : 'Authenticode verification is unavailable on this platform');
}

export function createBridgeUpdates({ root, runtimeRoot = root, platform = process.platform, pack = {}, request, notify = () => {},
  anchors = { publicKey: trust.BRIDGE_MANIFEST_PUBLIC_KEY, thumbprint: trust.BRIDGE_AUTHENTICODE_THUMBPRINT },
  authenticode = (file, thumb) => verifyAuthenticode(file, thumb, { platform, runtimeRoot }),
  seal = dir => lockBridgeSnapshot(root, dir, runtimeRoot) } = {}) {
  const home = path.join(root, 'bridges'), stateFile = path.join(root, 'private/bridge-state.json');
  const cache = new Map(), leases = new Set();
  let state, stateError = false, last = null, busy = Promise.resolve();
  try { noLinks(stateFile); state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); if (state.schema !== 2) throw new Error('Invalid bridge state'); }
  catch (error) { stateError = error.code !== 'ENOENT'; state = { schema: 2, watermarks: {}, reports: {}, failures: {} }; }
  try { noLinks(path.join(root, 'private/bridge-update.json')); last = JSON.parse(fs.readFileSync(path.join(root, 'private/bridge-update.json'), 'utf8')); } catch { /* No update yet. */ }
  function noLinks(file) {
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) fail('Bridge path escapes the data directory');
    let at = root;
    for (const part of relative.split(path.sep)) {
      at = path.join(at, part);
      try { if (fs.lstatSync(at).isSymbolicLink()) fail('Bridge paths cannot contain links'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  function atomic(file, bytes) {
    noLinks(file); fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = file + '.' + randomUUID() + '.tmp';
    try { fs.writeFileSync(tmp, bytes, { flag: 'wx', mode: 0o600 }); fs.renameSync(tmp, file); } finally { fs.rmSync(tmp, { force: true }); }
  }
  function save() { if (stateError) fail('Bridge state is unreadable; automatic updates are disabled'); atomic(stateFile, JSON.stringify(state)); }
  function emit(status, message, details = {}) { last = { status, message, ...details }; atomic(path.join(root, 'private/bridge-update.json'), JSON.stringify(last)); notify(last); }
  function report(m, status, reason) {
    state.reports[identity(m)] = { lane: m.lane, studioVersion: m.studioVersion, protocol: m.protocol, sequence: m.sequence, status, reason: String(reason ?? '').slice(0, 500) }; save();
  }
  function manifest(offer) {
    const text = textOf(offer.manifest);
    if (!anchors.publicKey || !/^[A-Fa-f0-9]{40}$/.test(anchors.thumbprint)) fail('Bridge trust anchors are not configured in this build');
    if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024) fail('Invalid bridge manifest size');
    const signature = Buffer.from(offer.signature ?? '', 'base64'), key = createPublicKey(anchors.publicKey);
    if (key.asymmetricKeyType !== 'ed25519' || signature.length !== 64 || !verify(null, Buffer.from(text), key, signature)) fail('Invalid bridge manifest signature');
    const m = JSON.parse(text);
    if (m.schema !== 1 || !['odc', 'o11'].includes(m.lane) || studioVersion(m.studioVersion) !== m.studioVersion || number(m.protocol) === undefined
      || !Number.isSafeInteger(m.sequence) || m.sequence < 1 || !/^net\d+\.\d+$/.test(m.runtime ?? '')
      || !Number.isFinite(Date.parse(m.createdAt)) || m.authenticodeThumbprint?.toUpperCase() !== anchors.thumbprint.toUpperCase()) fail('Invalid bridge manifest identity, sequence or certificate');
    for (const key of ['lane', 'studioVersion', 'protocol']) if (offer[key] !== m[key]) fail('Bridge offer does not match its signed manifest');
    if (!Array.isArray(m.files) || !m.files.length || m.files.length > 512) fail('Invalid bridge file list');
    const seen = new Set(['manifest.json', 'manifest.sig']); let total = 0;
    for (const f of m.files) {
      if (!safePath(f.path) || !/^[a-f0-9]{64}$/.test(f.sha256 ?? '') || !Number.isSafeInteger(f.size) || f.size < 1 || f.size > 128 * 1024 * 1024) fail('Invalid bridge file entry');
      const name = f.path.toLowerCase();
      if (seen.has(name) || [...seen].some(p => p.startsWith(name + '/') || name.startsWith(p + '/'))) fail('Duplicate or conflicting bridge path');
      seen.add(name); total += f.size;
    }
    if (total > 512 * 1024 * 1024) fail('Bridge download exceeds the size limit');
    if (m.lane === 'odc' && (!m.protocol.startsWith('v') || !seen.has('client/odc3.bridge.client.dll')
      || m.files.filter(f => ['ODC3.Bridge.dll', 'ODC3.Bridge.' + m.protocol + '.dll'].includes(path.posix.basename(f.path))).length !== 1)) fail('Missing ODC bridge or matching client');
    if (m.lane === 'o11' && (m.protocol !== 'd1' || seen.has('hook/anvil.runtimehook.agent.dll.json') || !['hook/anvil.runtimehook.agent.dll', 'bridge/anvil.bridge.dll'].every(name => seen.has(name)))) fail('Unsupported O11 downloaded hook layout');
    return { m, text, signature };
  }
  function fingerprint(dir) {
    noLinks(dir); const list = [];
    function walk(at) {
      for (const e of fs.readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.join(at, e.name); noLinks(file);
        if (e.isDirectory()) walk(file);
        else { if (!e.isFile()) fail('Invalid bridge file'); const stat = fs.statSync(file, { bigint: true }); list.push([path.relative(dir, file), String(stat.size), String(stat.mtimeNs), String(stat.ino)]); }
      }
    }
    walk(dir); return JSON.stringify(list);
  }
  async function files(m, dir, generated = {}) {
    const expected = new Set(['manifest.json', 'manifest.sig', ...m.files.map(f => f.path), ...Object.keys(generated)]), listing = JSON.parse(fingerprint(dir));
    if (listing.some(([name]) => !expected.has(name.split(path.sep).join('/'))) || listing.length !== expected.size) fail('Unlisted or missing file in bridge installation');
    for (const f of m.files) { const bytes = fs.readFileSync(path.join(dir, f.path)); if (bytes.length !== f.size || hash(bytes) !== f.sha256) fail('Bridge file size or SHA-256 mismatch: ' + f.path); }
    for (const [name, digest] of Object.entries(generated)) if (hash(fs.readFileSync(path.join(dir, name))) !== digest) fail('The generated hook configuration changed');
    for (const f of m.files) if (/\.(dll|exe)$/i.test(f.path)) {
      try { await authenticode(path.join(dir, f.path), anchors.thumbprint.toUpperCase()); } catch { fail('Authenticode verification failed: ' + f.path); }
    }
  }
  async function read(dir, lane, version, protocol) {
    const stamp = fingerprint(dir), known = cache.get(dir);
    if (known?.stamp === stamp) return known.entry;
    const checked = manifest({ lane, studioVersion: version, protocol, manifest: fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'), signature: fs.readFileSync(path.join(dir, 'manifest.sig'), 'utf8') });
    await files(checked.m, dir); const after = fingerprint(dir); if (after !== stamp) fail('Bridge files changed during verification');
    const entry = { ...checked, dir }; cache.set(dir, { stamp: after, entry }); return entry;
  }
  async function inventory(lane, version) {
    const dir = path.join(home, lane, version); noLinks(dir); if (!fs.existsSync(dir)) return [];
    const entries = [];
    for (const protocol of fs.readdirSync(dir).filter(p => number(p) !== undefined)) {
      const parent = path.join(dir, protocol); noLinks(parent);
      for (const seq of fs.readdirSync(parent).filter(p => /^\d+$/.test(p))) {
        try { entries.push(await read(path.join(parent, seq), lane, version, protocol)); }
        catch (error) { emit('refused', 'Bridge update refused: ' + error.message, { lane }); }
      }
    }
    return entries.sort((a, b) => b.m.sequence - a.m.sequence);
  }
  function watermark(m, rejected = false) {
    if (stateError) fail('Bridge state is unreadable; automatic updates are disabled');
    const known = state.watermarks[pair(m)] ?? { installed: 0, rejected: 0, protocol: 0 };
    if (!rejected && (m.sequence < Math.max(known.installed, known.rejected) || Number(number(m.protocol)) < known.protocol)) fail('Bridge sequence replay or protocol downgrade refused');
    if (rejected) { known.rejected = Math.max(known.rejected, m.sequence); state.watermarks[pair(m)] = known; save(); }
    return known;
  }
  async function install(offer, installed) {
    const { m, text, signature } = manifest(offer);
    try {
      watermark(m);
      if (!installed || studioVersion(installed.version) !== m.studioVersion || installed.runtime !== m.runtime) fail('Bridge does not match the installed Studio and runtime');
      if (bundledBridgeSupports(pack, runtimeRoot, m.lane, installed.version, installed.runtime)) return false;
      const previous = await inventory(m.lane, m.studioVersion);
      if (previous.some(p => p.m.sequence > m.sequence || Number(number(p.m.protocol)) > Number(number(m.protocol)))) fail('Bridge sequence replay or protocol downgrade refused');
      const existing = previous.find(p => p.m.sequence === m.sequence);
      if (existing) { if (existing.text !== text) fail('An installed bridge identity cannot be replaced'); return false; }
      const dest = path.join(home, m.lane, m.studioVersion, m.protocol, String(m.sequence)); noLinks(dest); fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      const staging = path.join(path.dirname(dest), '.staging-' + randomUUID()); fs.mkdirSync(staging, { mode: 0o700 });
      try {
        for (const f of m.files) {
          const response = await request('/agent/bridges/' + [m.lane, m.studioVersion, m.protocol, f.sha256].join('/'), { size: f.size });
          if (response.status !== 200 || response.redirected) { await response.body?.cancel(); fail('Bridge download refused'); }
          if (response.headers.get('content-length') && Number(response.headers.get('content-length')) !== f.size) { await response.body?.cancel(); fail('Bridge download size mismatch'); }
          const file = path.join(staging, f.path); fs.mkdirSync(path.dirname(file), { recursive: true }); const fd = fs.openSync(file, 'wx', 0o600); let size = 0;
          try { for await (const chunk of response.body) { size += chunk.length; if (size > f.size) fail('Bridge download exceeds the signed size'); fs.writeSync(fd, chunk); } if (size !== f.size) fail('Bridge download was interrupted'); fs.fsyncSync(fd); }
          finally { fs.closeSync(fd); }
        }
        fs.writeFileSync(path.join(staging, 'manifest.json'), text); fs.writeFileSync(path.join(staging, 'manifest.sig'), signature.toString('base64')); await files(m, staging);
        const known = watermark(m); known.installed = Math.max(known.installed, m.sequence); known.protocol = Math.max(known.protocol, Number(number(m.protocol))); state.watermarks[pair(m)] = known; save();
        noLinks(dest); fs.renameSync(staging, dest); cache.set(dest, { stamp: fingerprint(dest), entry: { m, text, signature, dir: dest } });
        report(m, 'installed', 'The verified bridge is installed');
        emit('installed', `Updated the ${m.lane} bridge for ${m.lane === 'odc' ? 'ODC Studio' : 'Service Studio'} ${m.studioVersion}`, { lane: m.lane, studioVersion: m.studioVersion, protocol: m.protocol, sequence: m.sequence }); return true;
      } finally { fs.rmSync(staging, { recursive: true, force: true }); }
    } catch (error) { watermark(m, true); throw error; }
  }
  async function offers(welcome, studios) {
    if (platform === 'darwin') return false; let changed = false;
    for (const lane of ['odc', 'o11']) {
      const offer = welcome?.compatible?.[lane]?.bridgeOffer; if (!offer) continue;
      try { if (offer.lane !== lane) fail('Bridge offer lane mismatch'); changed = await install(offer, studios?.[lane]?.installed) || changed; }
      catch (error) { emit('refused', 'Bridge update refused: ' + error.message, { lane }); }
    }
    return changed;
  }
  async function select(lane, version, runtime, context = {}) {
    version = studioVersion(version);
    if (!version || !runtime || platform === 'darwin' || stateError || bundledBridgeSupports(pack, runtimeRoot, lane, version, runtime)) return null;
    for (const entry of await inventory(lane, version)) {
      if (entry.m.runtime !== runtime) continue;
      const blocked = state.failures[identity(entry.m)];
      if (blocked) {
        if (!context.startedUtc || blocked[String(context.pid)] === context.startedUtc) continue;
        if (blocked[String(context.pid)]) { delete blocked[String(context.pid)]; report(entry.m, 'installed', 'The Studio restarted; the bridge can be retried'); }
      }
      return { ...entry.m, root: entry.dir, digest: hash(Buffer.from(entry.text)) };
    }
    return null;
  }
  async function prepareAttach(bridge, context = {}) {
    const base = path.join(root, 'private/bridge-loads'); noLinks(base); fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    const directory = path.join(base, randomUUID().slice(0, 12)); fs.mkdirSync(directory, { mode: 0o700 }); let locked;
    const generated = {};
    try {
      noLinks(bridge.root);
      for (const name of ['manifest.json', 'manifest.sig', ...bridge.files.map(f => f.path)]) {
        const source = path.join(bridge.root, name); noLinks(source); const target = path.join(directory, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      }
      if (bridge.lane === 'o11') {
        const name = 'hook/Anvil.RuntimeHook.Agent.dll.json';
        const bytes = Buffer.from(JSON.stringify({ pid: context.pid, startedUtc: context.startedUtc, port: context.port,
          bridgePath: path.join(directory, 'bridge/Anvil.Bridge.dll'), authorityDir: path.join(root, 'private/authority') }));
        fs.writeFileSync(path.join(directory, name), bytes, { flag: 'wx', mode: 0o600 }); generated[name] = hash(bytes);
      }
      locked = await seal(directory);
      const checked = manifest({ ...bridge, manifest: fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'), signature: fs.readFileSync(path.join(directory, 'manifest.sig'), 'utf8') });
      if (hash(Buffer.from(checked.text)) !== bridge.digest) fail('The bridge changed while preparing the attach');
      await files(checked.m, directory, generated);
      if (locked.alive && !locked.alive()) fail('Bridge snapshot lock was lost');
      const lease = { ...bridge, root: directory, context, release() { leases.delete(lease); return locked.release(); } }; leases.add(lease); return lease;
    } catch (error) { locked?.release(); throw error; }
  }
  function rejectLoad(bridge, reason, context = {}) {
    if (!context.attempted || !context.bridgeFailure || !context.startedUtc) return false;
    const failed = state.failures[identity(bridge)] ?? {};
    failed[String(context.pid)] = context.startedUtc; state.failures[identity(bridge)] = failed;
    watermark(bridge, true); report(bridge, 'failed', reason);
    const previous = Object.values(state.reports).filter(r => r.lane === bridge.lane && r.studioVersion === bridge.studioVersion && r.sequence < bridge.sequence && r.status !== 'failed').sort((a, b) => b.sequence - a.sequence)[0];
    const fallback = previous ?? { lane: bridge.lane, studioVersion: bridge.studioVersion, protocol: pack[bridge.lane === 'odc' ? 'odcBridge' : 'o11Hook'], sequence: 0 };
    if (fallback.protocol) report(fallback, 'fallback', previous ? 'Using the previous verified bridge' : 'Using the bundled bridge');
    emit('fallback', 'The downloaded bridge failed to load; it can be retried after the Studio restarts or a newer sequence arrives.', { lane: bridge.lane, sequence: bridge.sequence }); return true;
  }
  function markActive(bridge, context) {
    report(bridge, 'active', 'The bridge loaded successfully'); Object.assign(state.reports[identity(bridge)], { pid: context.pid, startedUtc: context.startedUtc }); save();
    state.active ??= {}; state.active[bridge.lane + '/' + context.pid + '/' + context.startedUtc] = { studioVersion: bridge.studioVersion, protocol: bridge.protocol }; save();
  }
  function protocolFor(lane, version, context = {}) {
    const active = state.active?.[lane + '/' + context.pid + '/' + context.startedUtc];
    if (active?.studioVersion === studioVersion(version)) return active.protocol;
    const record = Object.values(state.reports).find(r => r.lane === lane && r.studioVersion === studioVersion(version) && r.status === 'active' && r.pid === context.pid && r.startedUtc === context.startedUtc);
    return record?.protocol ?? (lane === 'odc' ? pack.odcBridge : pack.o11Hook);
  }
  return { select, prepareAttach, rejectLoad, markActive, protocolFor, status: () => last,
    reports: () => Object.values(state.reports).map(({ lane, studioVersion, protocol, sequence, status, reason }) => ({ lane, studioVersion, protocol, sequence, status, reason })),
    async dispose() { await busy.catch(() => {}); await Promise.all([...leases].map(lease => lease.release())); },
    offers: (welcome, studios) => { const next = busy.then(() => offers(welcome, studios)); busy = next.catch(() => {}); return next; } };
}
