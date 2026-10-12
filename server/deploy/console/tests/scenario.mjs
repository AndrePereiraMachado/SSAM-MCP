// A realistic state volume for the view tests: three licenses issued through a token module (as ssam-admin would, before
// the console starts), a server.log with a running process, sessions and an agent, audit lines in the UTC-day files they
// belong to, a registered machine, an access alert, a customer workspace and the production host.json (neutral names).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HOST_PROD, REAL_MODULE, writeHost, writeLines } from './helpers.mjs';

export const utcKeyOf = iso => iso.slice(0, 10).replaceAll('-', '');

export function writeAudit(serverDir, lines) {
  const byKey = new Map();
  for (const l of lines) { const k = utcKeyOf(l.time); byKey.set(k, [...(byKey.get(k) ?? []), l]); }
  for (const [k, list] of byKey) fs.appendFileSync(path.join(serverDir, `audit-${k}.jsonl`), list.map(l => JSON.stringify(l) + '\n').join(''));
}

export async function buildScenario(env, { module = REAL_MODULE, t0 = Date.now() } = {}) {
  const { createTokenStore } = await import(pathToFileURL(module).href);
  const store = createTokenStore(env.serverDir);
  const alfa = store.issue({ customer: 'Cliente Alfa', days: 30, lanes: ['odc', 'o11'] });
  const beta = store.issue({ customer: 'Cliente Beta', days: 2, lanes: ['odc'] });
  const gama = store.issue({ customer: 'Cliente Gama', days: 30, lanes: ['odc'] });
  store.revoke(gama.id);
  const at = minutes => new Date(t0 - minutes * 60000).toISOString();
  const s1 = '11111111-aaaa-4bbb-8ccc-000000000001', s2 = '22222222-aaaa-4bbb-8ccc-000000000002';
  const pinnedAt = at(79);
  writeLines(path.join(env.serverDir, 'server.log'), [
    { time: at(120), event: 'kernel', kernel: { o11: '11.55.91', odc: '1.7.27', odcBridge: 'v48', o11Hook: null } },
    { time: at(119), event: 'listening', url: 'http://0.0.0.0:7310', mode: 'hosted', pid: 7, ratePerMinute: 240, maxSessionsPerToken: 8, publicHosts: ['ssam.example.com'] },
    { time: at(100), event: 'session-opened', session: s1, token: alfa.id, customer: 'Cliente Alfa', ip: '192.0.2.10', ua: 'claude-code/2.1.281', client: 'claude-code 2.1.281' },
    { time: at(90), event: 'mcp-response-flushed', session: s1, token: alfa.id, tools: ['studio_inspect'], bytes: 1200, ms: 900 },
    { time: at(80), event: 'agent-connected', token: alfa.id, agent: '0.2.0', ip: '192.0.2.10', machine: { id: 'abc123', name: 'PC-TESTE-01', user: 'teste' },
      o11: JSON.stringify({ pid: 4321, startedUtc: at(200), port: 50123, studioVersion: '11.55.91' }) },
    { time: pinnedAt, event: 'agent-machine-pinned', token: alfa.id, machine: { id: 'abc123', name: 'PC-TESTE-01', user: 'teste', at: pinnedAt }, ip: '192.0.2.10' },
    { time: at(78), event: 'agent-stream-opened', token: alfa.id },
    { time: at(4), event: 'agent-call', token: alfa.id, kind: 'odc_read', ms: 300, ok: false, code: 'AGENT_TIMEOUT' },
    { time: at(3), event: 'agent-call', token: alfa.id, kind: 'odc_read', ms: 120, ok: true },
    { time: at(60), event: 'session-opened', session: s2, token: beta.id, customer: 'Cliente Beta', ip: '198.51.100.20', ua: 'codex', client: null },
    { time: at(50), event: 'session-closed', session: s2, token: beta.id, reason: 'client-delete' },
  ]);
  const audit = [
    { time: at(5), token: alfa.id, customer: 'Cliente Alfa', tool: 'studio_inspect', ms: 900, ok: true },
    { time: at(4), token: alfa.id, customer: 'Cliente Alfa', tool: 'studio_inspect', ms: 1100, ok: true },
    { time: at(3), token: alfa.id, customer: 'Cliente Alfa', tool: 'odc_read', ms: 2100, ok: false, error: 'AGENT_NOT_CONNECTED' },
    { time: at(2), token: beta.id, customer: 'Cliente Beta', tool: 'ssam_doctor', ms: 40, ok: true },
  ];
  writeAudit(env.serverDir, audit);
  fs.writeFileSync(path.join(env.serverDir, 'machine-pins.json'), JSON.stringify({ [alfa.id]: { id: 'abc123', name: 'PC-TESTE-01', user: 'teste', at: pinnedAt } }, null, 2));
  writeLines(path.join(env.serverDir, 'access-alerts.jsonl'), [{ time: at(30), event: 'agent-machine-changed', token: alfa.id, customer: 'Cliente Alfa',
    first: { id: 'abc123', name: 'PC-TESTE-01', user: 'teste', at: pinnedAt }, machine: { id: 'def456', name: 'PC-TESTE-02', user: 'teste' }, ip: '203.0.113.50' }]);
  const ws = path.join(env.serverDir, 'customers', alfa.id, 'odc', 'snapshots');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'a.oml'), Buffer.alloc(4096, 1));
  const host = writeHost(env, HOST_PROD, new Date(t0 - 10000).toISOString());
  return { store, alfa, beta, gama, audit, host, t0, at };
}
