import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as trust from './bridge-trust.mjs';
import { studioVersion } from './studio-runtime.mjs';

const exec = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(message); };
const number = protocol => /^(?:v|h)(0|[1-9]\d{0,8})$/.exec(protocol ?? '')?.[1];
const safePart = part => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part) && !/[. ]$/.test(part)
  && !/^(?:con|prn|aux|nul|[c]om[1-9]|lpt[1-9])(?:\.|$)/i.test(part);
const safePath = name => typeof name === 'string' && name.length < 240 && name.split('/').every(safePart);
const textOf = manifest => typeof manifest === 'string' ? manifest : JSON.stringify(manifest);

// No shell, no credentials in arguments. A missing verifier always refuses the download.
export async function verifyAuthenticode(file, thumbprint, { platform = process.platform, runtimeRoot, run = exec } = {}) {
  if (platform === 'win32') {
    const script = "$s=Get-AuthenticodeSignature -LiteralPath '" + file.replaceAll("'", "''")
      + "'; if ($s.Status -ne 'Valid' -or $s.SignatureType -ne 'Authenticode') { exit 1 }; $s.SignerCertificate.Thumbprint";
    const { stdout } = await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30000 });
    if (stdout.trim().toUpperCase() !== thumbprint) fail('Authenticode signer does not match the pinned certificate');
  } else if (platform === 'darwin') {
    await run(path.join(runtimeRoot, trust.BRIDGE_MAC_VERIFIER), ['verify', '-in', file, '-CAfile', path.join(runtimeRoot, 'tools/osslsigncode-ca.pem'), '-require-leaf-hash', 'sha1:' + thumbprint], { timeout: 30000 });
  } else fail('Authenticode verification is unavailable on this platform');
}

export function createBridgeUpdates({ root, runtimeRoot = root, platform = process.platform, request, notify = () => {},
  anchors = { publicKey: trust.BRIDGE_MANIFEST_PUBLIC_KEY, thumbprint: trust.BRIDGE_AUTHENTICODE_THUMBPRINT },
  authenticode = (file, thumb) => verifyAuthenticode(file, thumb, { platform, runtimeRoot }) } = {}) {
  const home = path.join(root, 'bridges');
  let last = null;
  let busy = Promise.resolve();
  const emit = (status, message, details = {}) => {
    last = { status, message, ...details };
    fs.mkdirSync(path.join(root, 'private'), { recursive: true });
    atomic(path.join(root, 'private', 'bridge-update.json'), JSON.stringify(last));
    notify(last);
  };
  function atomic(file, bytes) {
    const tmp = file + '.' + randomUUID() + '.tmp';
    try { fs.writeFileSync(tmp, bytes, { flag: 'wx', mode: 0o600 }); fs.renameSync(tmp, file); }
    finally { fs.rmSync(tmp, { force: true }); }
  }
  function noLinks(file) {
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) fail('Bridge path escapes the data directory');
    let at = root;
    for (const part of relative.split(path.sep)) {
      at = path.join(at, part);
      if (fs.existsSync(at) && fs.lstatSync(at).isSymbolicLink()) fail('Bridge paths cannot contain links');
    }
  }
  function manifest(offer) {
    const text = textOf(offer.manifest);
    if (!anchors.publicKey || !/^[A-Fa-f0-9]{40}$/.test(anchors.thumbprint)) fail('Bridge trust anchors are not configured in this build');
    if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024) fail('Invalid bridge manifest size');
    const signature = Buffer.from(offer.signature ?? '', 'base64');
    const key = createPublicKey(anchors.publicKey);
    if (key.asymmetricKeyType !== 'ed25519' || signature.length !== 64 || !verify(null, Buffer.from(text), key, signature)) fail('Invalid bridge manifest signature');
    const m = JSON.parse(text);
    if (m.schema !== 1 || !['odc', 'o11'].includes(m.lane) || (platform === 'darwin' && m.lane !== 'odc')
      || studioVersion(m.studioVersion) !== m.studioVersion || number(m.protocol) === undefined || !/^net\d+\.\d+$/.test(m.runtime ?? '')
      || !Number.isFinite(Date.parse(m.createdAt)) || m.authenticodeThumbprint?.toUpperCase() !== anchors.thumbprint.toUpperCase()) fail('Invalid bridge manifest identity or certificate');
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
    if (m.lane === 'odc' && (!m.protocol.startsWith('v') || m.files.filter(f => ['ODC3.Bridge.dll', 'ODC3.Bridge.' + m.protocol + '.dll'].includes(path.posix.basename(f.path))).length !== 1)) fail('Missing or ambiguous ODC bridge entrypoint');
    const flatO11 = ['hook/Anvil.RuntimeHook.Agent.dll', 'bridge/Anvil.Bridge.dll'].every(name => seen.has(name.toLowerCase()));
    const releaseO11 = ['studio/o11/hook/Anvil.Hook.h1.dll', 'studio/o11/bridge/b1/Anvil.Bridge.dll', 'release.json', 'release.sig.jws'].every(name => seen.has(name.toLowerCase()));
    if (m.lane === 'o11' && (m.protocol !== 'h1' || (!flatO11 && !releaseO11))) fail('Unsupported O11 hook or incomplete bridge layout');
    return { m, text, signature };
  }
  const folder = m => path.join(home, m.lane, m.studioVersion, m.protocol);
  async function files(m, dir) {
    noLinks(dir);
    const expected = new Set(['manifest.json', 'manifest.sig', ...m.files.map(f => f.path)]);
    const walk = (at, prefix = '') => {
      for (const e of fs.readdirSync(at, { withFileTypes: true })) {
        const rel = prefix + e.name;
        if (e.isSymbolicLink()) fail('Bridge paths cannot contain links');
        if (e.isDirectory()) walk(path.join(at, e.name), rel + '/');
        else if (!e.isFile() || !expected.has(rel)) fail('Unlisted file in bridge installation');
      }
    };
    walk(dir);
    // Check ALL hashes before asking the operating system to inspect any binary.
    for (const f of m.files) {
      const bytes = fs.readFileSync(path.join(dir, f.path));
      if (bytes.length !== f.size || hash(bytes) !== f.sha256) fail('Bridge file size or SHA-256 mismatch: ' + f.path);
    }
    for (const f of m.files) if (/\.(dll|exe)$/i.test(f.path)) {
      try { await authenticode(path.join(dir, f.path), anchors.thumbprint.toUpperCase()); }
      catch { fail('Authenticode verification failed: ' + f.path); }
    }
  }
  function read(dir, lane, version, protocol) {
    noLinks(dir);
    return manifest({ lane, studioVersion: version, protocol, manifest: fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'), signature: fs.readFileSync(path.join(dir, 'manifest.sig'), 'utf8') });
  }
  function inventory(lane, version) {
    const dir = path.join(home, lane, version); noLinks(dir);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(p => number(p) !== undefined).map(p => ({ ...read(path.join(dir, p), lane, version, p), dir: path.join(dir, p) }))
      .sort((a, b) => Number(number(b.m.protocol)) - Number(number(a.m.protocol)));
  }
  async function install(offer, installed) {
    const { m, text, signature } = manifest(offer);
    if (!installed || studioVersion(installed.version) !== m.studioVersion || installed.runtime !== m.runtime) fail('Bridge does not match the installed Studio and runtime');
    const previous = inventory(m.lane, m.studioVersion);
    if (previous.some(p => p.m.protocol[0] !== m.protocol[0] || Number(number(p.m.protocol)) > Number(number(m.protocol)))) fail('Bridge protocol downgrade refused');
    const existing = previous.find(p => p.m.protocol === m.protocol);
    if (existing) {
      if (existing.text !== text) fail('An installed bridge identity cannot be replaced');
      await files(m, existing.dir);
      return false;
    }
    const dest = folder(m); noLinks(dest);
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    const staging = path.join(path.dirname(dest), '.staging-' + randomUUID());
    fs.mkdirSync(staging, { mode: 0o700 });
    try {
      for (const f of m.files) {
        const response = await request('/agent/bridges/' + [m.lane, m.studioVersion, m.protocol, f.sha256].join('/'), { size: f.size });
        if (response.status !== 200 || response.redirected) { await response.body?.cancel(); fail('Bridge download refused'); }
        if (response.headers.get('content-length') && Number(response.headers.get('content-length')) !== f.size) { await response.body?.cancel(); fail('Bridge download size mismatch'); }
        const file = path.join(staging, f.path); fs.mkdirSync(path.dirname(file), { recursive: true });
        const fd = fs.openSync(file, 'wx', 0o600); let size = 0;
        try {
          for await (const chunk of response.body) {
            size += chunk.length; if (size > f.size) fail('Bridge download exceeds the signed size');
            fs.writeSync(fd, chunk);
          }
          if (size !== f.size) fail('Bridge download was interrupted');
          fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
      }
      fs.writeFileSync(path.join(staging, 'manifest.json'), text);
      fs.writeFileSync(path.join(staging, 'manifest.sig'), signature.toString('base64'));
      await files(m, staging);
      noLinks(dest); fs.renameSync(staging, dest);
      emit('installed', `Updated the ${m.lane} bridge for ${m.lane === 'odc' ? 'ODC Studio' : 'Service Studio'} ${m.studioVersion}`, { lane: m.lane, studioVersion: m.studioVersion, protocol: m.protocol });
      return true;
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  }
  async function offers(welcome, studios) {
    let changed = false;
    for (const lane of ['odc', 'o11']) {
      const offer = welcome?.compatible?.[lane]?.bridgeOffer;
      if (!offer) continue;
      try { if (offer.lane !== lane) fail('Bridge offer lane mismatch'); changed = await install(offer, studios?.[lane]?.installed) || changed; }
      catch (e) { emit('refused', 'Bridge update refused: ' + e.message, { lane }); }
    }
    return changed;
  }
  async function select(lane, version, runtime) {
    version = studioVersion(version);
    if (!version || !runtime || (platform === 'darwin' && lane !== 'odc')) return null;
    let entries;
    try { entries = inventory(lane, version); }
    catch (e) { emit('refused', 'Bridge update refused: cached manifest verification failed', { lane }); return null; }
    for (const entry of entries) {
      if (entry.m.runtime !== runtime || failed().includes(hash(Buffer.from(entry.text)))) continue;
      try { await files(entry.m, entry.dir); return { ...entry.m, root: entry.dir, digest: hash(Buffer.from(entry.text)) }; }
      catch (e) { emit('refused', 'Bridge update refused: ' + e.message, { lane }); }
    }
    return null;
  }
  function failed() { try { const saved = JSON.parse(fs.readFileSync(path.join(home, 'failed.json'), 'utf8')); return saved.digests ?? saved; } catch { return []; } }
  function rejectLoad(bridge, reason) {
    noLinks(home); atomic(path.join(home, 'failed.json'), JSON.stringify({ digests: [...new Set([...failed(), bridge.digest])] }));
    emit('fallback', 'The downloaded bridge could not load; the previous bridge or bundled bridge will be used. Restart the Studio if an attach was already sent. ' + reason, { lane: bridge.lane, studioVersion: bridge.studioVersion, protocol: bridge.protocol });
  }
  return { select, rejectLoad, status: () => last,
    offers: (welcome, studios) => { const next = busy.then(() => offers(welcome, studios)); busy = next.catch(() => {}); return next; } };
}
