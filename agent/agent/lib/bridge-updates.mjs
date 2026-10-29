import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as trust from './bridge-trust.mjs';
import { studioVersion, bundledBridgeSupports } from './studio-runtime.mjs';
import { lockBridgeSnapshot } from './bridge-lock.mjs';
import { instanceStart, sameInstance, completeInstances } from './studio-instance.mjs';

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

export function authenticodeDisposition(result, thumbprint, signer = 'owner') {
  if (!Number.isInteger(result?.hresult) || result.hresult < -2147483648 || result.hresult > 0xffffffff) return 'retry';
  const status = result.hresult >>> 0;
  if (status === 0 && result.signatureValid === true) {
    return result.ok === true && (signer !== 'owner' || result.thumbprint?.toUpperCase() === thumbprint.toUpperCase()) ? 'accepted' : 'refused';
  }
  return status === 0x800B0100 || status === 0x80096010 || (status === 0x800B0004 && result.policyFailure === true) ? 'refused' : 'retry';
}

export async function verifyAuthenticode(file, thumbprint, { platform = process.platform, runtimeRoot, run = exec, signer = 'owner' } = {}) {
  if (platform === 'win32') {
    let stdout;
    try { ({ stdout } = await run(path.join(runtimeRoot, 'native/ssam-agent.exe'), ['authenticode', '--file', file, '--signer', signer], { windowsHide: true, timeout: 30000 })); }
    catch (error) { if (!error.stdout) throw error; stdout = error.stdout; }
    const result = JSON.parse(stdout);
    const disposition = authenticodeDisposition(result, thumbprint, signer);
    if (disposition !== 'accepted') throw Object.assign(new Error(disposition === 'refused' ? 'Authenticode signer does not match the pinned policy' : 'VERIFY_FAILED: local Authenticode trust could not be established; retry after repairing the certificate chain'), { signerRefused: disposition === 'refused', trustUnavailable: disposition === 'retry', hresult: result.hresult });
  } else fail(platform === 'darwin' ? MAC_BRIDGE_REASON : 'Authenticode verification is unavailable on this platform');
}

export function createBridgeUpdates({ root, runtimeRoot = root, platform = process.platform, pack = {}, request, notify = () => {},
  anchors = { publicKey: trust.BRIDGE_MANIFEST_PUBLIC_KEY, thumbprint: trust.BRIDGE_AUTHENTICODE_THUMBPRINT },
  authenticode = (file, thumb, signer) => verifyAuthenticode(file, thumb, { platform, runtimeRoot, signer }),
  seal = dir => lockBridgeSnapshot(root, dir, runtimeRoot), running } = {}) {
  const home = path.join(root, 'bridges'), stateFile = path.join(root, 'private/bridge-state.json');
  const cache = new Map(), leases = new Set(), preparations = new Map();
  let state, stateError = false, last = null, busy = Promise.resolve();
  let initialized = false, stopped = false, reconciling = false, preparing = 0, startupScan = fs.existsSync(path.join(root, 'private/bridge-loads'));
  let reportClock = Date.now();
  try { noLinks(stateFile); state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); if (state.schema !== 2 || ['watermarks', 'reports', 'failures'].some(k => !state[k] || typeof state[k] !== 'object' || Array.isArray(state[k]))
    || Object.values(state.reports).some(r => !r || typeof r !== 'object' || Array.isArray(r) || !Number.isSafeInteger(r.sequence))) throw new Error('Invalid bridge state'); }
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
  function emit(status, message, details = {}) { last = { status, message: String(message).replaceAll(root, '[data]').replaceAll(runtimeRoot, '[runtime]').replace(/[A-Za-z]:[\\/][^\s]*/g, '[path]'), ...details }; atomic(path.join(root, 'private/bridge-update.json'), JSON.stringify(last)); notify(last); }
  function reasonCode(error) {
    const message = String(error?.message ?? error);
    return /anchors/i.test(message) ? 'TRUST_ANCHOR_MISSING' : /signer|Authenticode/i.test(message) ? 'SIGNER_REFUSED' : 'VERIFY_FAILED';
  }
  function report(m, status, reason, context = null) {
    if (!Number.isSafeInteger(m.sequence) || m.sequence < 1) return false;
    const record = { lane: m.lane, studioVersion: m.studioVersion, protocol: m.protocol, sequence: m.sequence, status, reason, ...(status === 'refused' ? { authenticated: true } : {}), ...(context ? { pid: context.pid, startedUtc: instanceStart(context.startedUtc) } : {}) };
    const { updatedAt, ...previous } = state.reports[identity(m)] ?? {};
    if (JSON.stringify(previous) === JSON.stringify(record)) return false;
    state.reports[identity(m)] = { ...record, updatedAt: reportClock = Math.max(Date.now(), reportClock + 1) }; save(); return true;
  }
  const definitive = (m, code, message) => Object.assign(new Error(message), { authenticatedManifest: m, refusalCode: code });
  function reports() {
    const sorted = Object.values(state.reports).filter(r => r.status !== 'refused' || r.authenticated === true).sort((a, b) => (b.updatedAt ?? b.sequence) - (a.updatedAt ?? a.sequence));
    const current = new Map(); for (const item of sorted) if (!current.has(pair(item))) current.set(pair(item), item);
    const selected = [...current.values()];
    for (const item of sorted) if (selected.length < 16 && !selected.includes(item)) selected.push(item);
    return selected.filter(r => r.sequence > 0).sort((a, b) => (b.updatedAt ?? b.sequence) - (a.updatedAt ?? a.sequence)).slice(0, 16).map(({ lane, studioVersion, protocol, sequence, status, reason }) => ({ lane, studioVersion, protocol, sequence, status, reason: /^[A-Z_]{1,64}$/.test(reason) ? reason : status.toUpperCase() }));
  }
  function manifest(offer) {
    const text = textOf(offer.manifest);
    if (!anchors.publicKey) fail('Bridge trust anchors are not configured in this build');
    if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024) fail('Invalid bridge manifest size');
    const signature = Buffer.from(offer.signature ?? '', 'base64'), key = createPublicKey(anchors.publicKey);
    if (key.asymmetricKeyType !== 'ed25519' || signature.length !== 64 || !verify(null, Buffer.from(text), key, signature)) fail('Invalid bridge manifest signature');
    const m = JSON.parse(text);
    if (m.schema !== 1 || !['odc', 'o11'].includes(m.lane) || studioVersion(m.studioVersion) !== m.studioVersion || number(m.protocol) === undefined
      || !Number.isSafeInteger(m.sequence) || m.sequence < 1 || !/^net\d+\.\d+$/.test(m.runtime ?? '')
      || !Number.isFinite(Date.parse(m.createdAt))) fail('Invalid bridge manifest identity or sequence');
    for (const key of ['lane', 'studioVersion', 'protocol']) if (offer[key] !== m[key]) fail('Bridge offer does not match its signed manifest');
    if (!/^[A-Fa-f0-9]{40}$/.test(anchors.thumbprint)) throw definitive(m, 'TRUST_ANCHOR_MISSING', 'Bridge trust anchors are not configured in this build');
    if (m.authenticodeThumbprint?.toUpperCase() !== anchors.thumbprint.toUpperCase()) throw definitive(m, 'SIGNER_REFUSED', 'Bridge manifest certificate does not match the pinned signer');
    if (!Array.isArray(m.files) || !m.files.length || m.files.length > 512) fail('Invalid bridge file list');
    const seen = new Set(['manifest.json', 'manifest.sig']); let total = 0;
    for (const f of m.files) {
      if (!safePath(f.path) || !/^[a-f0-9]{64}$/.test(f.sha256 ?? '') || !Number.isSafeInteger(f.size) || f.size < 1 || f.size > 128 * 1024 * 1024) fail('Invalid bridge file entry');
      const name = f.path.toLowerCase();
      if (/\.(dll|exe)$/i.test(name) && (!['owner', 'microsoft'].includes(f.signer) || (/(^|\/)(odc3\.|anvil\.)|^hook\//i.test(name) && f.signer !== 'owner'))) throw definitive(m, 'SIGNER_REFUSED', 'Bridge signer policy refused');
      if (seen.has(name) || [...seen].some(p => p.startsWith(name + '/') || name.startsWith(p + '/'))) fail('Duplicate or conflicting bridge path');
      seen.add(name); total += f.size;
    }
    if (total > 512 * 1024 * 1024) fail('Bridge download exceeds the size limit');
    if (m.lane === 'odc' && (!m.protocol.startsWith('v') || !seen.has('client/odc3.bridge.client.dll')
      || m.files.filter(f => path.posix.basename(f.path) === 'ODC3.Bridge.' + m.protocol + '.dll').length !== 1
      || seen.has('bridge/odc3.bridge.dll'))) fail('Missing ODC bridge or matching client');
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
      try { await authenticode(path.join(dir, f.path), anchors.thumbprint.toUpperCase(), f.signer); }
      catch (error) { if (error.signerRefused) throw definitive(m, 'SIGNER_REFUSED', 'Authenticode verification failed'); if (error.trustUnavailable) throw error; throw new Error('Authenticode verification unavailable'); }
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
        catch (error) { emit(error.trustUnavailable ? 'warning' : 'refused', (error.trustUnavailable ? '' : 'Bridge update refused: ') + error.message, { lane, reason: error.trustUnavailable ? 'VERIFY_FAILED' : undefined }); }
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
    watermark(m);
    if (!installed || studioVersion(installed.version) !== m.studioVersion || installed.runtime !== m.runtime) fail('Bridge does not match the installed Studio and runtime');
    if (bundledBridgeSupports(pack, runtimeRoot, m.lane, installed.version, installed.runtime)) return false;
    const previous = await inventory(m.lane, m.studioVersion);
    if (previous.some(p => p.m.sequence > m.sequence || Number(number(p.m.protocol)) > Number(number(m.protocol)))) fail('Bridge sequence replay or protocol downgrade refused');
    const existing = previous.find(p => p.m.sequence === m.sequence);
    if (existing) {
      if (existing.text !== text) fail('An installed bridge identity cannot be replaced');
      const record = state.reports[identity(m)];
      return !['active', 'failed'].includes(record?.status) && report(m, 'installed', 'INSTALLED');
    }
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
      report(m, 'installed', 'INSTALLED');
      emit('installed', `Updated the ${m.lane} bridge for ${m.lane === 'odc' ? 'ODC Studio' : 'Service Studio'} ${m.studioVersion}`, { lane: m.lane, studioVersion: m.studioVersion, protocol: m.protocol, sequence: m.sequence }); return true;
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  }
  async function offers(welcome, studios) {
    if (platform === 'darwin') return false; let changed = false;
    for (const lane of ['odc', 'o11']) {
      const offer = welcome?.compatible?.[lane]?.bridgeOffer; if (!offer) continue;
      try { if (offer.lane !== lane) fail('Bridge offer lane mismatch'); changed = await install(offer, studios?.[lane]?.installed) || changed; }
      catch (error) {
        if (error.authenticatedManifest && !stateError) watermark(error.authenticatedManifest, true);
        const m = error.authenticatedManifest;
        if (m?.lane === lane && ['SIGNER_REFUSED', 'TRUST_ANCHOR_MISSING'].includes(error.refusalCode)
          && !['installed', 'active', 'failed'].includes(state.reports[identity(m)]?.status)) report(m, 'refused', error.refusalCode);
        emit(error.trustUnavailable ? 'warning' : 'refused', (error.trustUnavailable ? '' : 'Bridge update refused: ') + String(error.message).replace(/[A-Za-z]:[\\/][^\s]*/g, '[path]'), { lane, reason: error.refusalCode ?? 'VERIFY_FAILED' });
      }
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
        if (!context.startedUtc || instanceStart(blocked[String(context.pid)]) === instanceStart(context.startedUtc)) continue;
        if (blocked[String(context.pid)]) { delete blocked[String(context.pid)]; report(entry.m, 'installed', 'STUDIO_RESTARTED'); }
      }
      return { ...entry.m, root: entry.dir, digest: hash(Buffer.from(entry.text)) };
    }
    return null;
  }
  const leaseKey = (bridge, context) => identity(bridge) + '/' + context.pid + '/' + instanceStart(context.startedUtc);
  function prepareAttach(bridge, context = {}) {
    const key = leaseKey(bridge, context);
    if (preparations.has(key)) return preparations.get(key);
    preparing++;
    const pending = prepareCopy(bridge, context, key).catch(error => { preparations.delete(key); throw error; }).finally(() => { preparing--; });
    preparations.set(key, pending); return pending;
  }
  async function prepareCopy(bridge, context, key) {
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
      const index = { ...context, startedUtc: instanceStart(context.startedUtc), lane: bridge.lane, studioVersion: bridge.studioVersion, identity: identity(bridge) };
      atomic(directory + '.json', JSON.stringify(index));
      let attempted = false, closing = null;
      const close = () => closing ??= Promise.resolve().then(() => locked.release());
      const remove = async () => {
        preparations.delete(key);
        try { await close(); noLinks(directory); fs.rmSync(directory, { recursive: true, force: true }); fs.rmSync(directory + '.json', { force: true }); leases.delete(lease); return true; }
        catch { return false; } // Keep the index and retry; cleanup never replaces an attach error.
      };
      const lease = { ...bridge, root: directory, context, get mayBeLoaded() { return attempted; },
        retain() { if (!attempted) { atomic(directory + '.json', JSON.stringify({ ...index, attempted: true })); attempted = true; } },
        release: () => attempted ? Promise.resolve(false) : remove(), retire: remove, close,
      }; leases.add(lease); return lease;
    } catch (error) { try { await locked?.release(); noLinks(directory); fs.rmSync(directory, { recursive: true, force: true }); } catch { /* Preserve the primary verification error. */ } throw error; }
  }
  function rejectLoad(bridge, reason, context = {}) {
    if (!context.attempted || !context.bridgeFailure || !context.startedUtc) return false;
    const failed = state.failures[identity(bridge)] ?? {};
    failed[String(context.pid)] = instanceStart(context.startedUtc); state.failures[identity(bridge)] = failed;
    watermark(bridge, true); report(bridge, 'failed', 'LOAD_FAILED', context);
    const previous = Object.values(state.reports).filter(r => r.lane === bridge.lane && r.studioVersion === bridge.studioVersion && r.sequence < bridge.sequence && ['installed', 'active', 'fallback'].includes(r.status)).sort((a, b) => b.sequence - a.sequence)[0];
    if (previous) report(previous, 'installed', 'FALLBACK_PREVIOUS');
    else report(bridge, 'failed', 'FALLBACK_BUNDLED', context);
    emit('fallback', 'The downloaded bridge failed to load; it can be retried after the Studio restarts or a newer sequence arrives.', { lane: bridge.lane, sequence: bridge.sequence }); return true;
  }
  function markActive(bridge, context) {
    for (const lease of leases) if (identity(lease) === identity(bridge) && sameInstance(lease.context, context)) lease.retain();
    report(bridge, 'active', 'ACTIVE', context);
    state.active ??= {}; state.active[bridge.lane + '/' + context.pid + '/' + instanceStart(context.startedUtc)] = { studioVersion: bridge.studioVersion, protocol: bridge.protocol, identity: identity(bridge) }; save();
  }
  function protocolFor(lane, version, context = {}) {
    const active = state.active?.[lane + '/' + context.pid + '/' + instanceStart(context.startedUtc)]
      ?? Object.entries(state.active ?? {}).find(([key]) => { const [l, pid, startedUtc] = key.split('/'); return l === lane && sameInstance({ pid, startedUtc }, context); })?.[1];
    if (active?.studioVersion === studioVersion(version)) return active.protocol;
    const record = Object.values(state.reports).find(r => r.lane === lane && r.studioVersion === studioVersion(version) && r.status === 'active' && sameInstance(r, context));
    return record?.protocol ?? (lane === 'odc' ? pack.odcBridge : pack.o11Hook);
  }
  const installation = m => path.join(home, m.lane, m.studioVersion, m.protocol, String(m.sequence));
  function present(m) { try { noLinks(installation(m)); return fs.statSync(installation(m)).isDirectory(); } catch (error) { return error.code === 'ENOENT' ? false : null; } }
  async function initialize(installed) {
    if (initialized || stateError) return;
    try {
      for (const lane of ['odc', 'o11']) {
        const version = studioVersion(installed?.[lane]?.installed?.version); if (!version) continue;
        for (const { m } of await inventory(lane, version)) if (!['installed', 'active', 'failed'].includes(state.reports[identity(m)]?.status)) report(m, 'installed', 'INSTALLED');
      }
      initialized = true;
    } catch { /* Startup maintenance must not prevent the authenticated channel from opening. */ }
  }
  async function reconcile(running, installed) {
    if (stateError || preparing || reconciling) return false;
    reconciling = true;
    try {
      if (!completeInstances(running)) return false;
      const alive = c => running.some(p => sameInstance(p, c));
      const base = path.join(root, 'private/bridge-loads'); noLinks(base);
      const indexed = [];
      if (fs.existsSync(base)) for (const name of fs.readdirSync(base).filter(n => /^[a-f0-9-]{12}$/.test(n))) {
        const dir = path.join(base, name);
        noLinks(dir); noLinks(dir + '.json');
        let context; try { context = JSON.parse(fs.readFileSync(dir + '.json')); } catch { continue; }
        indexed.push({ dir, context });
      }
      const known = [...leases].map(l => l.context).concat(indexed.map(i => i.context), Object.keys(state.active ?? {}).map(key => { const [, pid, startedUtc] = key.split('/'); return { pid, startedUtc }; }));
      const stillRunning = context => { try { process.kill(Number(context.pid), 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
      if (known.some(context => !alive(context) && stillRunning(context))) return false;
      startupScan = false;
      for (const lease of [...leases]) if (!alive(lease.context) && !await lease.retire()) startupScan = true;
      for (const { dir, context } of indexed) {
        if ([...leases].some(l => l.root === dir)) continue;
        if (!alive(context)) { try { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(dir + '.json', { force: true }); } catch { startupScan = true; } }
      }
      let changed = false;
      for (const [key] of Object.entries(state.active ?? {})) { const [, pid, startedUtc] = key.split('/'); if (!alive({ pid, startedUtc })) { delete state.active[key]; changed = true; } }
      for (const [key, item] of Object.entries(state.reports)) {
        const exists = present(item), version = studioVersion(installed?.[item.lane]?.installed?.version);
        if ((exists === false && item.status !== 'refused') || (version && version !== item.studioVersion)) { delete state.reports[key]; changed = true; }
        else if (exists && ((item.pid && !alive(item)) || item.status === 'fallback')) changed = report(item, 'installed', 'INSTALLED') || changed;
      }
      if (changed) save();
      return changed;
    } catch { return false; } finally { reconciling = false; }
  }
  function isActive(bridge, context) {
    return Object.entries(state.active ?? {}).some(([key, active]) => { const [lane, pid, startedUtc] = key.split('/'); return lane === bridge.lane && active.identity === identity(bridge) && sameInstance({ pid, startedUtc }, context); });
  }
  const needsReconcile = () => !stateError && (startupScan || leases.size > 0 || Object.keys(state.active ?? {}).length > 0);
  let cleanup;
  function schedule() {
    if (!running || stopped) return;
    cleanup = setTimeout(async () => { try { if (needsReconcile()) await reconcile(await running()); } catch { /* Unavailable or partial process discovery is not evidence of exit. */ } finally { schedule(); } }, leases.size ? 5000 : 30000);
    cleanup.unref();
  }
  schedule();
  const wireStatus = () => last && last.status !== 'warning' ? { status: ['installed', 'fallback', 'refused'].includes(last.status) ? last.status : 'refused', lane: ['odc', 'o11'].includes(last.lane) ? last.lane : null } : null;
  return { select, prepareAttach, rejectLoad, markActive, protocolFor, initialize, reconcile, needsReconcile, isActive, status: () => last, wireStatus,
    reports,
    async dispose() { stopped = true; clearTimeout(cleanup); await busy.catch(() => {}); await Promise.all([...leases].map(lease => lease.close())); },
    offers: (welcome, studios) => { const next = busy.then(() => offers(welcome, studios)); busy = next.catch(() => {}); return next; } };
}
