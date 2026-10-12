// Test double of the 24th image's token module (DESIGN 7.1 TOKENS lane): the same file format and verbs as
// server/platforms/odc/facade/server-tokens.mjs plus renew(id, {days}) and setLanes(id, lanes), with error codes and the
// old messages. Used by the console tests to exercise the Renovar/Faixas paths; never shipped.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const LANES = ['odc', 'o11'];
const DAY = 86400000;
const sha = t => createHash('sha256').update(t, 'utf8').digest('hex');
const fail = (code, message) => Object.assign(new Error(message), { code });
const customerPattern = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u;

function parseLanes(value) {
  if (Array.isArray(value)) value = value.join(',');
  const lanes = [...new Set(String(value ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean))];
  if (!lanes.length || lanes.some(l => !LANES.includes(l))) throw fail('INVALID_LANES', 'lanes: odc, o11 or odc,o11');
  return LANES.filter(l => lanes.includes(l));
}

export function createTokenStore(dir, { now = () => new Date() } = {}) {
  const file = path.join(dir, 'tokens.json');
  const load = () => {
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed?.schema !== 'ssam-server-tokens/1' || !Array.isArray(parsed.tokens)) throw fail('STORE_INVALID', 'Invalid tokens file: ' + file);
    return parsed.tokens;
  };
  const save = tokens => {
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ schema: 'ssam-server-tokens/1', tokens }, null, 2) + '\n');
    fs.renameSync(tmp, file);
  };
  const stateOf = t => (t.revokedAt ? 'revoked' : t.expiresAt && Date.parse(t.expiresAt) <= now().getTime() ? 'expired' : 'active');
  const lanesOf = t => (Array.isArray(t.lanes) ? t.lanes.filter(l => LANES.includes(l)) : [...LANES]);
  const view = t => ({ id: t.id, customer: t.customer, createdAt: t.createdAt, ...(t.expiresAt ? { expiresAt: t.expiresAt } : {}),
    ...(t.revokedAt ? { revokedAt: t.revokedAt } : {}), state: stateOf(t), lanes: lanesOf(t), agent: t.agentSha256 ? { issuedAt: t.agentIssuedAt ?? null } : null });
  const find = (tokens, id) => { const t = tokens.find(x => x.id === id); if (!t) throw fail('UNKNOWN_TOKEN', 'Unknown token id: ' + id); return t; };
  return {
    file,
    issue({ customer, days, lanes = LANES } = {}) {
      if (typeof customer !== 'string' || !customerPattern.test(customer.trim())) throw fail('INVALID_CUSTOMER', 'customer: 1-64 letters, digits, space, dot, dash or underscore');
      if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 3650)) throw fail('INVALID_DAYS', 'days: an integer from 1 to 3650');
      const tokens = load();
      const token = 'ssam_' + randomBytes(32).toString('base64url');
      const agentCredential = 'ssam_agent_' + randomBytes(32).toString('base64url');
      const at = now();
      const entry = { id: 'tok_' + randomBytes(6).toString('hex'), customer: customer.trim(), createdAt: at.toISOString(),
        ...(days ? { expiresAt: new Date(at.getTime() + days * DAY).toISOString() } : {}), sha256: sha(token), agentSha256: sha(agentCredential),
        agentIssuedAt: at.toISOString(), lanes: parseLanes(lanes) };
      tokens.push(entry);
      save(tokens);
      return { token, agentCredential, ...view(entry) };
    },
    agentRotate(id) {
      const tokens = load();
      const t = find(tokens, id);
      if (stateOf(t) !== 'active') throw fail('TOKEN_NOT_ACTIVE', 'Token ' + id + ' is ' + stateOf(t) + '; issue a new one instead.');
      const agentCredential = 'ssam_agent_' + randomBytes(32).toString('base64url');
      t.agentSha256 = sha(agentCredential);
      t.agentIssuedAt = now().toISOString();
      save(tokens);
      return { agentCredential, ...view(t) };
    },
    revoke(id) {
      const tokens = load();
      const t = find(tokens, id);
      if (!t.revokedAt) { t.revokedAt = now().toISOString(); save(tokens); }
      return view(t);
    },
    renew(id, { days } = {}) {
      const tokens = load();
      const t = find(tokens, id);
      if (t.revokedAt) throw fail('TOKEN_REVOKED', 'Token ' + id + ' is revoked; issue a new one instead.');
      if (!t.expiresAt) throw fail('NO_EXPIRY', 'Token ' + id + ' has no expiry; nothing to renew.');
      if (!Number.isInteger(days) || days < 1 || days > 3650) throw fail('INVALID_DAYS', 'days: an integer from 1 to 3650');
      const base = Math.max(now().getTime(), Date.parse(t.expiresAt));
      const next = base + days * DAY;
      if (next > now().getTime() + 3650 * DAY) throw fail('EXPIRY_TOO_FAR', 'expiry: at most 3650 days from now');
      const previousExpiresAt = t.expiresAt;
      t.expiresAt = new Date(next).toISOString();
      save(tokens);
      return { previousExpiresAt, ...view(t) };
    },
    setLanes(id, lanes) {
      const tokens = load();
      const t = find(tokens, id);
      if (t.revokedAt) throw fail('TOKEN_REVOKED', 'Token ' + id + ' is revoked; issue a new one instead.');
      const next = parseLanes(lanes);
      const previousLanes = lanesOf(t);
      if (next.join(',') !== previousLanes.join(',')) { t.lanes = next; save(tokens); }
      return { previousLanes, ...view(t) };
    },
    list() { return load().map(view); },
    stateOf(id) { const t = load().find(x => x.id === id); return t ? stateOf(t) : 'unknown'; },
  };
}
