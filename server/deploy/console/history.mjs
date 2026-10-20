// License history (DESIGN 3.5): the console appends one line per console action and per external change to
// <SSAM_SERVER_DIR>/console-audit.jsonl (0600, backed up with tokens.json), and reads the file back for /api/history and
// for the last entries of each license. This module is the console-audit appender: the only console code that writes
// outside CONSOLE_STATE_DIR (besides the token module verbs). A line never holds a secret: the fields are whitelisted and
// anything secret-shaped is removed before the write.
import fs from 'node:fs';
import path from 'node:path';
import { cap, redact } from './texts.mjs';

export const AUDIT_FILE = 'console-audit.jsonl';
// unrevoke, removed, expiry-shortened and rename exist only as external changes (actor "externo", 3.5): a revocation
// undone, a record gone, an expiry moved earlier, a customer renamed. signin, signin-refused and signout are the GitHub
// sign-in of the Coolify mode (github-auth.mjs), with the GitHub login in detail.login.
export const HISTORY_ACTIONS = ['issue', 'renew', 'lanes', 'agent-rotate', 'revoke', 'key-rotate', 'alert-ack', 'alert-unack',
  'unrevoke', 'removed', 'expiry-shortened', 'rename', 'signin', 'signin-refused', 'signout'];
const ACTIONS = new Set(HISTORY_ACTIONS);
const DETAIL_KEYS = ['days', 'expiresAt', 'previousExpiresAt', 'lanes', 'previousLanes', 'alert', 'hours', 'previousRevokedAt', 'previousState', 'previousCustomer', 'login'];

function clean(entry) {
  const detail = {};
  for (const k of DETAIL_KEYS) if (entry.detail && entry.detail[k] !== undefined) detail[k] = entry.detail[k];
  return {
    time: String(entry.time), action: String(entry.action), actor: entry.actor === 'externo' ? 'externo' : 'painel',
    token: entry.token ? cap(entry.token, 40) : null, customer: entry.customer ? cap(entry.customer, 64) : null,
    result: entry.result === 'error' ? 'error' : 'ok', code: entry.code ? cap(entry.code, 64) : null, detail,
  };
}

export function createHistory({ serverDir, log = () => {} }) {
  const auditFile = path.join(serverDir, AUDIT_FILE);
  let entries = [];
  let offset = 0;
  let ino = null;

  function append(entry) {
    const line = redact(JSON.stringify(clean(entry)));
    try {
      fs.appendFileSync(auditFile, line + '\n', { mode: 0o600 });
      refresh();
      return { written: true };
    } catch (error) {
      log({ console: 'audit-write-failed', code: error.code ?? 'WRITE' });
      return { written: false };
    }
  }
  // Incremental read; a shorter or replaced file (restore from a backup) is read again from the start.
  function refresh() {
    let st;
    try { st = fs.statSync(auditFile, { bigint: true }); } catch { if (ino !== null) { entries = []; offset = 0; ino = null; } return; }
    const size = Number(st.size);
    if (String(st.ino) !== ino || size < offset) { entries = []; offset = 0; ino = String(st.ino); }
    if (size === offset) return;
    let text;
    try {
      const fd = fs.openSync(auditFile, 'r');
      try { const buf = Buffer.alloc(size - offset); fs.readSync(fd, buf, 0, buf.length, offset); text = buf.toString('utf8'); } finally { fs.closeSync(fd); }
    } catch { return; }
    const end = text.lastIndexOf('\n');
    if (end < 0) return;
    offset += Buffer.byteLength(text.slice(0, end + 1));
    for (const raw of text.slice(0, end).split('\n')) {
      let e; try { e = JSON.parse(raw); } catch { continue; }
      if (!e || typeof e.time !== 'string' || !ACTIONS.has(e.action)) continue;
      entries.push(clean(e));
    }
  }
  // History entries newest first.
  function query({ limit = 200, before = null, token = null, action = null } = {}) {
    refresh();
    const out = [];
    for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
      const e = entries[i];
      if (before && !(e.time < before)) continue;
      if (token && e.token !== token) continue;
      if (action && e.action !== action) continue;
      out.push(e);
    }
    return out;
  }
  const size = () => { try { return fs.statSync(auditFile).size; } catch { return 0; } };
  return { append, refresh, query, size, file: auditFile };
}
