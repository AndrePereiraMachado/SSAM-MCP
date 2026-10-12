// Fakes of the Service Center tests (port of the FakeBridge/FakeVault of kernel/tests/test_service_center_studio.py):
// the contract's bridge verbs in memory, pages by "METHOD /path", API results by operation. No Studio, Service Center,
// identity provider or credential store is contacted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createVault } from '../../service-center/vault.mjs';

export const VERBS = ['sc_session', 'sc_api', 'sc_web', 'studio_login'];
export const SC = '/ServiceCenter/';
export const PAGES = path.join(import.meta.dirname, 'sc-pages');
export const MODERN = path.join(PAGES, 'modern');
// The bridge_manifest serviceCenter catalog of a current bridge (ScApi.Catalog), the operations the facade sends.
export const CATALOG = Object.freeze({ soap: ['AddModuleToApplication', 'ChangeCommitMessage', 'DeleteApplication', 'DeleteModule', 'GetConsumers', 'ListApplications',
  'ListCommits', 'ListEspaces', 'ListExtensions', 'ListVersions', 'MoveModuleBetweenApps', 'PublishSolution', 'UploadAndPublishExtension'],
'server-api': ['AssociateAppWithDatabase', 'GetDatabaseByApplicationKey', 'ListDatabases'], 'sc-rest': ['apply-settings', 'apply-settings-status'], closed: [] });

export class FakeBridge {
  // login: what sc_web login answers (an Error is thrown; anything else signs the hidden window in). serviceCenter: the
  // manifest's catalog (null: a bridge that predates it).
  constructor({ signed = true, web = true, verbs = VERBS, pages = {}, api = {}, capabilities = ['sc_api:soap', 'sc_web', 'sc_http:studioSession'], login = null, serviceCenter = CATALOG } = {}) {
    this.pid = 4242; this.version = '2.0.0'; this.corporate = false;
    this.signed = signed; this.webSigned = web; this.verbSet = new Set(verbs); this.caps = new Set(capabilities); this.loginReply = login;
    this.pages = { ...pages }; this.replies = { ...api }; this.calls = []; this.targets = []; this.catalog = serviceCenter;
    this.refs = new Map(); // call index -> secretRefs of that sc_web fetch
  }
  supports() { return VERBS.every(v => this.verbSet.has(v)); }
  capabilities() { return new Set(this.caps); }
  serviceCenterCatalog() { return this.catalog; }
  session(host) {
    this.calls.push(['session', host]);
    return { ok: true, source: 'studio', host, bridgeVersion: this.version, studio: { signedIn: this.signed, user: 'dev@example.test', loginType: 'sso' },
      web: { open: this.webSigned, signedIn: this.webSigned } };
  }
  login(host) { this.calls.push(['login', host]); return { ok: true }; }
  api(host, surface, operation, args = null, { write = false, operationId = null, authorizeSha256 = null, target = null } = {}) {
    this.calls.push(['api', surface, operation, { ...(args ?? {}) }, write, operationId, authorizeSha256]);
    this.targets.push(target);
    if (!Object.hasOwn(this.replies, operation)) throw new Error('no fake reply for ' + operation);
    let reply = this.replies[operation];
    if (typeof reply === 'function') reply = reply(args ?? {});
    if (reply instanceof Error) throw reply;
    return { ok: true, source: 'studio', host, user: 'dev@example.test', elapsedMs: 3, result: reply };
  }
  web(host, action, { method = null, path: pagePath = null, form = null, accept = null, write = false, operationId = null, authorizeSha256 = null, secretRefs = null, hidden = false } = {}) {
    this.calls.push(['web', action, method, pagePath, { ...(form ?? {}) }, accept, write, operationId, authorizeSha256]);
    if (action === 'open') this.openedHidden = hidden;
    if (secretRefs?.length) this.refs.set(this.calls.length - 1, secretRefs.map(r => ({ ...r })));
    if (action === 'login') {
      if (this.loginReply instanceof Error) throw this.loginReply;
      this.webSigned = true;
      return { ok: true, signedIn: true, submitted: true, hidden: true };
    }
    if (action !== 'fetch') return { ok: true, signedIn: this.webSigned };
    const key = `${method} ${pagePath}`;
    if (!Object.hasOwn(this.pages, key)) throw new Error('no fake page ' + key);
    let entry = this.pages[key];
    if (Array.isArray(entry)) entry = entry.shift();
    if (typeof entry === 'function') entry = entry(form ?? {}, accept);
    if (entry instanceof Error) throw entry;
    if (entry && typeof entry === 'object' && !Buffer.isBuffer(entry)) return entry;
    const base = { ok: true, source: 'studio-web', host, status: 200, finalUrl: `https://${host}${pagePath}` };
    if (Buffer.isBuffer(entry)) return { ...base, contentType: 'application/octet-stream', bodyBase64: entry.toString('base64') };
    return { ...base, contentType: 'text/html; charset=utf-8', html: entry };
  }
  posts() { return this.calls.filter(c => c[0] === 'web' && c[2] === 'POST'); }
  writes() { return this.calls.filter(c => (c[0] === 'api' && c[4]) || (c[0] === 'web' && c[6])); }
  refsOf(call) { return this.refs.get(this.calls.indexOf(call)); }
}

// Status only: no test reads a credential value (the facade never does for database logins and secret values).
export function fakeVault(host, stored = true) {
  const real = createVault(host, null, { present: async () => stored });
  return { host: real.host, target: real.target, present: async () => stored, secretTarget: (kind, name) => real.secretTarget(kind, name) };
}

// Text fixtures read as Python's read_text did: universal newlines (the checkout may have CRLF).
export const readText = file => fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
export function fixture(name, values = {}) {
  let text = readText(path.join(PAGES, name));
  for (const [key, value] of Object.entries(values)) text = text.replaceAll('{' + key + '}', value);
  return text;
}
export function html(name, ...replacements) {
  let text = readText(path.join(MODERN, name));
  for (const [old, now] of replacements) {
    if (!text.includes(old)) throw new Error('fixture ' + name + ' has no ' + old);
    text = text.replaceAll(old, now);
  }
  return text;
}
export const request = name => JSON.parse(fs.readFileSync(path.join(MODERN, name), 'utf8')).request;

// A minimal ZIP (stored parts) for the XLSX helper.
export function zip(files) {
  const locals = []; const central = []; let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8'); const nameBytes = Buffer.from(name, 'utf8'); const crc = zlib.crc32(data) >>> 0;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(nameBytes.length, 28); entry.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data); central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// A minimal XLSX (shared strings + first sheet), as the Service Center export produces.
export function xlsx(rows) {
  const strings = [...new Set(rows.flat().filter(v => !/^\d+$/.test(v.replaceAll('.', ''))))].sort();
  const index = new Map(strings.map((s, i) => [s, i]));
  const cell = (ref, value) => (index.has(value) ? `<c r="${ref}" t="s"><v>${index.get(value)}</v></c>` : `<c r="${ref}"><v>${value}</v></c>`);
  const sheet = rows.map((r, n) => `<row r="${n + 1}">` + r.map((v, i) => (v !== '' ? cell(String.fromCharCode(65 + i) + (n + 1), v) : '')).join('') + '</row>').join('');
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  return zip({ 'xl/sharedStrings.xml': `<sst xmlns="${ns}">` + strings.map(s => `<si><t>${s}</t></si>`).join('') + '</sst>',
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="${ns}"><sheetData>${sheet}</sheetData></worksheet>` });
}

export const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sc-test-'));
export const files = (dir, pattern = /./) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => pattern.test(f)) : []);
export const uuid = () => crypto.randomUUID();
