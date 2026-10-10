// Access tokens of the served MCP (docs/SERVIDOR-LOCAL.md, docs/FASE2-AGENTE.md 2.2): the license and the kill switch.
// A token is 32 random bytes in base64url behind the "ssam_" prefix, shown ONCE when issued; the file keeps only its
// SHA-256, with {id, customer, createdAt, revokedAt?, expiresAt?}. Phase 2 adds to the SAME record the credential of
// the customer's agent ("ssam_agent_" + 32 random bytes, also shown once, also kept only as SHA-256) and the lanes the
// token may use: {agentSha256?, agentIssuedAt?, lanes?}. The schema stays ssam-server-tokens/1 (the new fields are
// optional; phase-1 records stay valid). One never works in place of the other: verify() refuses agent credentials and
// verifyAgent() accepts only them. The file lives under <workspace>/.local/server (outside git). Admin is local only
// (`ssam server-token issue|agent-rotate|revoke|list`): only this CLI writes tokens.json, never the server; nothing here
// is reachable over HTTP and no function returns or logs a stored secret.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOKEN_PREFIX = 'ssam_';
export const AGENT_PREFIX = 'ssam_agent_';
export const TOKEN_LANES = Object.freeze(['odc', 'o11']);
const sha256 = text => createHash('sha256').update(text, 'utf8').digest();
const customerPattern = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u;
// Phase-1 records have no lanes field: they keep the default of a new token.
const lanesOf = t => Array.isArray(t.lanes) ? t.lanes.filter(l => TOKEN_LANES.includes(l)) : [...TOKEN_LANES];

// The folder of the served mode: SSAM_SERVER_DIR (tests, another clone) or <root>/.local/server.
export const serverDir = (root, env = process.env) => env.SSAM_SERVER_DIR ? path.resolve(env.SSAM_SERVER_DIR) : path.join(root, '.local', 'server');

// "odc,o11" -> ['odc', 'o11'] (each known, no repeats, at least one).
export function parseLanes(value) {
  if (Array.isArray(value)) value = value.join(',');
  const lanes = [...new Set(String(value ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean))];
  if (!lanes.length || lanes.some(l => !TOKEN_LANES.includes(l))) throw new Error('lanes: odc, o11 or odc,o11');
  return TOKEN_LANES.filter(l => lanes.includes(l));
}

export function createTokenStore(dir, { now = () => new Date() } = {}) {
  const file = path.join(dir, 'tokens.json');
  let cache = { stamp: null, tokens: [] };

  const stampOf = () => { try { const s = fs.statSync(file); return s.mtimeMs + ':' + s.size; } catch { return 'missing'; } };
  // The file is re-read only when it changed (mtime + size), so a revoke from the admin command is seen at the next request.
  function load() {
    const stamp = stampOf();
    if (stamp === cache.stamp) return cache.tokens;
    let tokens = [];
    if (stamp !== 'missing') {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed?.schema !== 'ssam-server-tokens/1' || !Array.isArray(parsed.tokens)) throw new Error('Invalid tokens file: ' + file);
      tokens = parsed.tokens;
    }
    cache = { stamp, tokens };
    return tokens;
  }
  function save(tokens) {
    fs.mkdirSync(dir, { recursive: true });
    const temp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, JSON.stringify({ schema: 'ssam-server-tokens/1', tokens }, null, 2) + '\n');
    fs.renameSync(temp, file);
    cache = { stamp: null, tokens: [] };
  }
  const publicView = t => ({ id: t.id, customer: t.customer, createdAt: t.createdAt, ...(t.expiresAt ? { expiresAt: t.expiresAt } : {}),
    ...(t.revokedAt ? { revokedAt: t.revokedAt } : {}), state: stateOf(t), lanes: lanesOf(t),
    agent: t.agentSha256 ? { issuedAt: t.agentIssuedAt ?? null } : null });
  const stateOf = t => t.revokedAt ? 'revoked' : t.expiresAt && Date.parse(t.expiresAt) <= now().getTime() ? 'expired' : 'active';
  const newAgentCredential = () => AGENT_PREFIX + randomBytes(32).toString('base64url');
  // Every stored hash of the field is compared in constant time, with no early exit.
  function find(field, presented) {
    const digest = sha256(presented);
    let found = null;
    for (const t of load()) {
      const stored = Buffer.from(String(t[field] ?? ''), 'hex');
      if (stored.length === digest.length && timingSafeEqual(stored, digest) && !found) found = t;
    }
    return found;
  }

  return {
    file,
    // Issue: both plaintexts (MCP token and agent credential) come back here once and are never written anywhere.
    issue({ customer, days, lanes = TOKEN_LANES } = {}) {
      if (typeof customer !== 'string' || !customerPattern.test(customer.trim())) throw new Error('customer: 1-64 letters, digits, space, dot, dash or underscore');
      if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 3650)) throw new Error('days: an integer from 1 to 3650');
      const tokenLanes = parseLanes(lanes);
      const tokens = load().slice();
      const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
      const agentCredential = newAgentCredential();
      const created = now();
      const entry = { id: 'tok_' + randomBytes(6).toString('hex'), customer: customer.trim(), createdAt: created.toISOString(),
        ...(days ? { expiresAt: new Date(created.getTime() + days * 86400000).toISOString() } : {}),
        sha256: sha256(token).toString('hex'), agentSha256: sha256(agentCredential).toString('hex'), agentIssuedAt: created.toISOString(),
        lanes: tokenLanes };
      tokens.push(entry);
      save(tokens);
      return { token, agentCredential, ...publicView(entry) };
    },
    // A new agent credential for the same record; the old one stops at once (401) and its open channel is closed
    // by the server within a second (Close rotated).
    agentRotate(id) {
      const tokens = load().map(t => ({ ...t }));
      const entry = tokens.find(t => t.id === id);
      if (!entry) throw new Error('Unknown token id: ' + id);
      if (stateOf(entry) !== 'active') throw new Error('Token ' + id + ' is ' + stateOf(entry) + '; issue a new one instead.');
      const agentCredential = newAgentCredential();
      entry.agentSha256 = sha256(agentCredential).toString('hex');
      entry.agentIssuedAt = now().toISOString();
      save(tokens);
      return { agentCredential, ...publicView(entry) };
    },
    // Revoking the record kills both secrets: the MCP token and the agent credential.
    revoke(id) {
      const tokens = load().map(t => ({ ...t }));
      const entry = tokens.find(t => t.id === id);
      if (!entry) throw new Error('Unknown token id: ' + id);
      if (!entry.revokedAt) { entry.revokedAt = now().toISOString(); save(tokens); }
      return publicView(entry);
    },
    list() { return load().map(publicView); },
    // Verify a presented MCP bearer token (never an agent credential).
    verify(presented) {
      if (typeof presented !== 'string' || !presented.startsWith(TOKEN_PREFIX) || presented.startsWith(AGENT_PREFIX) || presented.length > 256) return { status: 'unknown' };
      const found = find('sha256', presented);
      if (!found) return { status: 'unknown' };
      const state = stateOf(found);
      return { status: state === 'active' ? 'ok' : state, id: found.id, customer: found.customer, lanes: lanesOf(found) };
    },
    // Verify a presented agent credential. agentSha256 is the stored hash the channel keeps to notice an agent-rotate.
    verifyAgent(presented) {
      if (typeof presented !== 'string' || !presented.startsWith(AGENT_PREFIX) || presented.length > 256) return { status: 'unknown' };
      const found = find('agentSha256', presented);
      if (!found) return { status: 'unknown' };
      const state = stateOf(found);
      return { status: state === 'active' ? 'ok' : state, id: found.id, customer: found.customer, lanes: lanesOf(found), agentSha256: found.agentSha256 };
    },
    // The state of a token id now (sessions of a revoked or expired token are closed by the server).
    stateOf(id) { const t = load().find(x => x.id === id); return t ? stateOf(t) : 'unknown'; },
    // What the server needs about a record, with no secret: state, lanes, whether it has an agent credential, and the
    // hash of that credential (to close a channel opened with a rotated one). null for an unknown id.
    lookup(id) {
      const t = load().find(x => x.id === id);
      return t ? { id: t.id, customer: t.customer, state: stateOf(t), lanes: lanesOf(t), credential: !!t.agentSha256, agentSha256: t.agentSha256 ?? null } : null;
    },
  };
}

const USAGE = 'Usage: ssam server-token issue --customer <name> [--days N] [--lanes odc,o11] | agent-rotate --id <id> | revoke --id <id> | list';

// `ssam server-token issue --customer <name> [--days N] [--lanes odc,o11] | agent-rotate --id <id> | revoke --id <id> | list`
export function tokenCli(args, { root, env = process.env } = {}) {
  const store = createTokenStore(serverDir(root, env));
  const value = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const [action] = args;
  if (action === 'issue') {
    const days = value('--days');
    const lanes = value('--lanes');
    if (args.includes('--lanes') && lanes === undefined) throw new Error(USAGE);
    const issued = store.issue({ customer: value('--customer'), ...(days !== undefined ? { days: Number(days) } : {}), ...(lanes !== undefined ? { lanes } : {}) });
    return { ok: true, ...issued,
      note: 'O token e a credencial do agente aparecem só agora. O token vai na configuração do cliente MCP; a credencial vai no setup do agente. O servidor guarda só o hash SHA-256 de cada um.' };
  }
  if (action === 'agent-rotate') {
    const id = value('--id');
    if (!id) throw new Error('Usage: ssam server-token agent-rotate --id <id>');
    const rotated = store.agentRotate(id);
    const { agentCredential, ...view } = rotated;
    return { ok: true, agentCredential, rotated: view,
      note: 'A credencial nova aparece só agora. A anterior já não vale e o canal do agente aberto com ela fecha em até 1 s; rode o setup do agente com a nova.' };
  }
  if (action === 'revoke') {
    const id = value('--id');
    if (!id) throw new Error('Usage: ssam server-token revoke --id <id>');
    return { ok: true, revoked: store.revoke(id), note: 'Vale já para o token e para a credencial do agente: pedidos novos recebem 403, as sessões abertas e o canal do agente deste token são fechados.' };
  }
  if (action === 'list') return { ok: true, file: store.file, tokens: store.list() };
  throw new Error(USAGE);
}
