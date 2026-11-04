// Shared machine-private primitives. No object from this module is a wire response.
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { refuse } from './errors.mjs';

const short = value => createHash('sha256').update(value).digest('hex').slice(0, 16);
export const privateScope = (dataRoot, account = '') => short(path.resolve(dataRoot).toLowerCase()) + short('account|' + account);

// Only counters are persisted. Both private families count before sending a
// login, so a crashed helper cannot grant another password attempt on restart.
export function createLoginBrake({ file, scope, unavailableCode = 'CREDENTIAL_LOGIN_PAUSED' }) {
  const unavailable = () => refuse(unavailableCode, 'The private sign-in attempt state could not be read safely. No sign-in was sent.');
  const read = () => {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (error) { if (error?.code === 'ENOENT') return {}; throw unavailable(); }
    let value;
    try { value = JSON.parse(text); } catch { throw unavailable(); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(count => !Number.isSafeInteger(count) || count < 0)) throw unavailable();
    return value;
  };
  const full = key => scope + '|' + key;
  const write = all => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(all)); };
  return {
    count: key => Number(read()[full(key)]) || 0,
    set(key, count) {
      const all = read();
      if ((Number(all[full(key)]) || 0) === count) return;
      if (count > 0) all[full(key)] = count; else delete all[full(key)];
      write(all);
    },
    clearPrefix(prefix) {
      const all = read(); let changed = false;
      for (const key of Object.keys(all)) if (key.startsWith(full(prefix))) { delete all[key]; changed = true; }
      if (changed) write(all);
    },
  };
}

export function createCookieStore() {
  const jars = new Map();
  return {
    header: key => [...(jars.get(key)?.entries() ?? [])].map(([name, value]) => name + '=' + value).join('; '),
    delete: key => jars.delete(key),
    store(key, encoded) {
      for (const item of Array.isArray(encoded) ? encoded : []) {
        const first = Buffer.from(String(item), 'base64').toString('utf8').split(';')[0], mark = first.indexOf('=');
        if (mark <= 0) continue;
        const jar = jars.get(key) ?? new Map(), name = first.slice(0, mark).trim(), value = first.slice(mark + 1).trim();
        if (value) jar.set(name, value); else jar.delete(name);
        jars.set(key, jar);
      }
    },
  };
}

export function parsePrivatePromptCompletion(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('Invalid private prompt completion.'); }
  const keys = ['ok', 'saved', 'remembered', 'profile', 'principal', 'privateCredential'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.ok !== true || typeof value.saved !== 'boolean' || typeof value.remembered !== 'boolean' || Object.keys(value).some(key => !keys.includes(key))) throw new Error('Invalid private prompt completion.');
  if (!value.saved) {
    if (value.privateCredential !== undefined) throw new Error('Invalid private prompt completion.');
    return { saved: false, remembered: false };
  }
  if (value.profile !== undefined && (typeof value.profile !== 'string' || !/^(?:[a-f0-9]{64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.test(value.profile))) throw new Error('Invalid private prompt completion.');
  if (value.principal !== undefined && (typeof value.principal !== 'string' || value.principal.length > 1024 || /[\u0000-\u001f\u007f]/.test(value.principal))) throw new Error('Invalid private prompt completion.');
  if (value.remembered) {
    if (value.privateCredential !== undefined) throw new Error('Invalid private prompt completion.');
  } else {
    const credential = value.privateCredential;
    if (!credential || typeof credential !== 'object' || Array.isArray(credential) || Object.keys(credential).some(key => !['username', 'password'].includes(key)) ||
      typeof credential.username !== 'string' || !credential.username.length || credential.username.length > 1024 || /[\u0000-\u001f\u007f]/.test(credential.username) ||
      typeof credential.password !== 'string' || !credential.password.length || credential.password.length > 8192 || value.principal !== undefined && value.principal !== credential.username) throw new Error('Invalid private prompt completion.');
  }
  return value;
}

// The only prompt IPC collector: bytes never touch a file or a public result.
// Exit alone is insufficient; stdout may still contain the final private bytes.
export function capturePrivatePrompt(child) {
  const record = { done: false, failed: false, value: null };
  let chunks = [], size = 0, ended = false, closed = false, exitCode = null;
  const finish = () => {
    if (!ended || !closed || record.done) return;
    record.done = true;
    if (record.failed || exitCode !== 0) { chunks = []; record.failed = true; return; }
    try { record.value = parsePrivatePromptCompletion(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { record.failed = true; }
    chunks = [];
  };
  if (!child.stdout?.on) { record.done = true; record.failed = true; return record; }
  child.stdout.on('data', bytes => {
    if (record.failed) return;
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    size += buffer.length;
    if (size > 32768) { chunks = []; record.failed = true; return; }
    chunks.push(buffer);
  });
  child.stdout.on('end', () => { ended = true; finish(); });
  child.stdout.on('error', () => { ended = true; record.failed = true; finish(); });
  child.on?.('close', code => { closed = true; exitCode = code; finish(); });
  child.on?.('error', () => { ended = true; closed = true; record.failed = true; finish(); });
  return record;
}

export function createPrivateCredentialMemory(family = 'CREDENTIAL') {
  const entries = new Map();
  return {
    get: key => entries.get(key) ?? null,
    set(keys, value) {
      if (new Set([...entries.keys(), ...keys]).size > 256) throw refuse(family === 'USERS' ? 'USERS_SESSION_LIMIT' : 'CREDENTIAL_SESSION_LIMIT', 'Too many private credential sessions are active. Sign out of an unused session first.');
      for (const key of keys) entries.set(key, value);
    },
    delete(key) { const value = entries.get(key); if (value) for (const [name, item] of entries) if (item === value) entries.delete(name); },
    deletePrefix(prefix) { for (const key of entries.keys()) if (key.startsWith(prefix)) entries.delete(key); },
    clear() { entries.clear(); },
  };
}

// One shared budget is passed to every private family in an agent/account. The
// providers settle their own process records; even simultaneous families cannot
// open independent sets of windows to bypass the person's refusal.
export function createPrivateRuntime({ dataRoot, account = '', now = Date.now } = {}) {
  const busy = new Set();
  let opened = [], refusals = [];
  const codes = {
    USERS: { busy: 'USERS_WINDOW_BUSY', limit: 'USERS_WINDOW_LIMIT' },
    CREDENTIAL: { busy: 'CREDENTIAL_WINDOW_BUSY', limit: 'CREDENTIAL_WINDOW_LIMIT' },
  };
  return {
    scope: privateScope(dataRoot, account),
    registerBusy(provider) { busy.add(provider); return () => busy.delete(provider); },
    takeWindow(prefix = 'CREDENTIAL') {
      const family = Object.hasOwn(codes, prefix) ? codes[prefix] : codes.CREDENTIAL;
      if ([...busy].some(provider => provider())) throw refuse(family.busy, 'Another window of this agent is open: answer that one first.');
      opened = opened.filter(at => now() - at < 600000);
      refusals = refusals.filter(at => now() - at < 600000);
      if (opened.length >= 20 || refusals.length >= 3) throw refuse(family.limit, 'Too many windows in a few minutes, so no other was opened.');
      opened.push(now());
    },
    windowRefused() { refusals.push(now()); },
  };
}

// All values used to authenticate remain private, including their common echo
// encodings. Helpers must register credentials, old/new cookies and tokens before
// any response is allowed to cross the agent channel.
export function createSecretRedactor() {
  const secrets = new Set();
  let secretBytes = 0;
  const add = value => {
    if (typeof value === 'string' && value.length && !secrets.has(value)) {
      const bytes = Buffer.byteLength(value);
      if (secrets.size >= 4096 || bytes > 65536 || secretBytes + bytes > 4 * 1024 * 1024) throw refuse('CREDENTIAL_SECRET_LIMIT', 'The private session exceeded its secret tracking limit. Sign out and sign in again.');
      secrets.add(value); secretBytes += bytes;
    }
    else if (Array.isArray(value)) value.forEach(add);
    else if (value && typeof value === 'object') Object.values(value).forEach(add);
  };
  return {
    add,
    clear() { secrets.clear(); secretBytes = 0; },
    text(value) {
      let result = String(value ?? '');
      const forms = new Set();
      for (const secret of secrets) {
        const html = secret.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
        let uri = secret;
        try { uri = encodeURIComponent(secret); } catch { /* an unpaired surrogate still has literal and binary forms */ }
        for (const form of [secret, html, html.replaceAll('&#39;', '&apos;'), uri, new URLSearchParams({ s: secret }).toString().slice(2),
          JSON.stringify(secret).slice(1, -1), secret.replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026'),
          Buffer.from(secret).toString('base64'), Buffer.from(secret, 'utf16le').toString('base64')]) forms.add(form);
      }
      for (const form of [...forms].sort((a, b) => b.length - a.length)) result = result.replace(new RegExp(form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[redacted]');
      return result;
    },
  };
}
