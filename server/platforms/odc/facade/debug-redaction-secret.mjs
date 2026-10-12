// Redaction-only secrets: typed by the user in the private dialog (use:'redact-only' vault record) and used
// solely to redact debugger frames and to prove that receipts are clean. No worker ever sends them.
// secretVariants is a stable export (value | {username,password} | array) -> string[]; the leak audit reuses it.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { privateAppUserVault, armExpiry, redactionSecretBinding, sameRedactionSecretTarget } from './debug-app-user.mjs';
import { privateEndpointCredentialValues, validateRedactionSecretDescriptor } from './debug-app-user-worker.mjs';

const GUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const failure = code => { throw new Error(code); };

export async function releaseRedactionSecret(descriptor, { vault = privateAppUserVault } = {}) {
  if (!descriptor) return { ok: true };
  const safe = validateRedactionSecretDescriptor(descriptor);
  return vault('forget', safe);
}

// One masked field per declared role in the private dialog; request JSON carries role names only.
// The record expires with the debug session that supplies seconds (30..3600, default 600).
export async function prepareRedactionSecret(input, { vault = privateAppUserVault, expire = armExpiry, sessionId } = {}) {
  if (['values', 'credentials', 'secrets', 'password', 'token', 'username'].some(key => Object.hasOwn(input ?? {}, key))) failure('debug_app_user_redaction_secret_invalid_target');
  const binding = redactionSecretBinding(input, sessionId), ttlSeconds = Math.max(30, Math.min(3600, input.seconds ?? 600));
  const credentialRef = randomUUID(), provisional = { credentialRef, binding, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(), use: 'redact-only' };
  try {
    const entered = await vault('prompt-endpoint', { binding, ttlSeconds, credentialRef });
    if (entered.cancelled === true) {
      await releaseRedactionSecret(provisional, { vault }).catch(() => {});
      return { ok: false, state: 'cancelled', error: 'debug_app_user_cancelled' };
    }
    if (entered.ok !== true || entered.kind !== 'endpoint-credential' || entered.credentialRef !== credentialRef || !GUID.test(entered.credentialRef) ||
        !sameRedactionSecretTarget(entered.binding, binding) || !(Date.parse(entered.expiresAt) > Date.now())) failure('debug_app_user_scope_mismatch');
    const descriptor = { credentialRef, binding, expiresAt: new Date(Math.min(Date.parse(entered.expiresAt), Date.parse(provisional.expiresAt))).toISOString(),
      kind: 'endpoint-credential', use: 'redact-only', state: 'credentials-entered', authenticated: false };
    await expire(descriptor); // Forgotten at expiry even if the run is interrupted.
    return { ok: true, credentialSource: 'private-dialog', descriptor };
  } catch (error) {
    await releaseRedactionSecret(provisional, { vault }).catch(() => {});
    throw new Error(/^debug_app_user_[a-z_]+$/.test(error.message ?? '') ? error.message : 'debug_app_user_redaction_secret_unavailable');
  }
}

const invalid = () => failure('debug_redaction_secret_invalid');
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 65536 ? value : invalid();
const unicode = (value, upper) => JSON.stringify(value).slice(1, -1).replace(/[<>&'+`\u0080-￿]/g, c => {
  const hex = c.charCodeAt(0).toString(16).padStart(4, '0'); return '\\u' + (upper ? hex.toUpperCase() : hex); });
const ENCODINGS = [
  v => v,
  v => JSON.stringify(v).slice(1, -1),                                   // JSON string body
  v => unicode(v, false),                                                // ConvertTo-Json / JavaScriptSerializer
  v => unicode(v, true),                                                 // System.Text.Json
  v => unicode(v, true).replace(/\\"/g, '\\u0022'),
  v => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'),
  v => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'), // XML text node
  v => encodeURIComponent(v),
  v => encodeURIComponent(v).replace(/%[0-9A-F]{2}/g, m => m.toLowerCase()),
  v => new URLSearchParams([['k', v]]).toString().slice(2),             // application/x-www-form-urlencoded
  v => encodeURIComponent(v).replace(/%20/g, '+'),
  v => Buffer.from(v, 'utf8').toString('base64'),
  v => Buffer.from(v, 'utf8').toString('base64url'),
  v => Buffer.from(v, 'utf8').toString('base64').replace(/=+$/, ''),
];
// Base strings: each value; a Basic pair adds user:pass, base64(user:pass) and 'Basic '+b64.
function bases(value, out = []) {
  if (Array.isArray(value)) { if (!value.length) invalid(); for (const item of value) bases(item, out); return out; }
  if (typeof value === 'string') { out.push(text(value)); return out; }
  if (!value || typeof value !== 'object') invalid();
  const username = text(value.username), password = text(value.password), b64 = Buffer.from(username + ':' + password, 'utf8').toString('base64');
  out.push(username, password, username + ':' + password, b64, 'Basic ' + b64);
  return out;
}
export function secretVariants(value) {
  const variants = new Set();
  for (const base of bases(value)) for (const encode of ENCODINGS) { const variant = encode(base); if (variant) variants.add(variant); }
  return [...variants];
}

// Opened record shapes (private callers only): a value, a Basic pair, {secrets}, {headers} or {values}.
function recordValues(record) {
  if (typeof record === 'string' || Array.isArray(record)) return record;
  if (record?.scheme === 'basic' || (record?.username !== undefined && record?.password !== undefined)) return { username: record.username, password: record.password };
  for (const key of ['secrets', 'headers', 'values']) if (Array.isArray(record?.[key])) return record[key].map(item => typeof item === 'string' ? item : item?.value);
  return invalid();
}

function receiptFiles(entries, limit = 4096) {
  const files = [], walk = (entry, depth) => {
    let stat; try { stat = fs.statSync(entry); } catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    if (stat.isDirectory()) { if (depth > 12) invalid(); for (const name of fs.readdirSync(entry).sort()) walk(path.join(entry, name), depth + 1); }
    else if (stat.isFile()) { files.push(entry); if (files.length > limit || stat.size > 268435456) invalid(); }
  };
  for (const entry of Array.isArray(entries) ? entries : [entries]) walk(path.resolve(String(entry)), 0);
  return files;
}

// Proves that no variant of the private values occurs in the given receipts (files or directories).
// The answer is only {redactionSecretAbsent}; any doubt (unopened record, unreadable file) is false.
export async function scanReceipts(files, record, { vault = privateAppUserVault, now = Date.now } = {}) {
  let values = [], needles = [], found = false, opened = false;
  try {
    opened = typeof record?.credentialRef === 'string';
    values = opened ? await privateEndpointCredentialValues(record, { vault, now }) : recordValues(record);
    needles = secretVariants(values).flatMap(variant => [Buffer.from(variant, 'utf8'), Buffer.from(variant, 'utf16le')]);
    for (const file of receiptFiles(files)) {
      const bytes = fs.readFileSync(file);
      try { found = needles.some(needle => bytes.includes(needle)); } finally { bytes.fill(0); }
      if (found) break;
    }
    return { redactionSecretAbsent: !found };
  } catch { return { redactionSecretAbsent: false }; }
  finally {
    if (opened && Array.isArray(values)) values.fill(''); // Caller-owned values are left to the caller.
    for (const needle of needles) needle.fill(0);
    values = null; needles = [];
  }
}
