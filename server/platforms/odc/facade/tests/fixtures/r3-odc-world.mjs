// CX15 r3 (ODC): the real OdcAccess over a fake ODC Studio bridge (portal-call) serving an in-memory synthetic tenant, behind
// the odc_* guard (guardedAccess), through the MCP SDK (McpServer + Client + InMemoryTransport) with the wrap of mcp.mjs and
// ssam_task. Hooks let a test act inside the access: beforeGet(route) during a read, beforeWrite(request) while a write is
// being sent (after the request left the access). Synthetic values only; no network, no Studio.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { registerAccessTools } from '../../odc-access.mjs';
import { wrap } from '../../mcp.mjs';
import { registerSsamTask } from '../../ssam-task.mjs';
import { guardedAccess } from '../../../portal/runtime/destructive-preview.mjs';
import { CONFIRM_MIN_AGE_MS } from '../../destructive-operations.mjs';
import { OdcAccess } from '../../../portal/runtime/access.mjs';
import { Catalog } from '../../../portal/runtime/catalog.mjs';
import { WriteJournal } from '../../../portal/runtime/write-journal.mjs';

process.env.SSAM_ODC_OFFLINE = '1';
export const HOST = 'personal-r3odc.outsystems.dev';
export const LIB = '3f2a9c10-1b2c-4d3e-8f40-5a6b7c8d9e31';
export const GROUP = '6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c41';
export const USERS = { '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e51': 'ZZAna', '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e61': 'ZZBia', '3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e71': 'ZZCaio', '4c5d6e7f-8a9b-4cad-9e2f-3a4b5c6d7e81': 'ZZDuda' };
export const ROLES = { '5d6e7f80-9aab-4cbd-8e3f-4a5b6c7d8e91': 'ZZRoleLeitor', '6d7e8f90-aabb-4ccd-9e4f-5a6b7c8d9ea1': 'ZZRoleEditor' };
export const valueOf = reply => reply.structuredContent ?? JSON.parse(reply.content[0].text);
export const files = dir => { const out = []; const walk = d => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); e.isDirectory() ? walk(f) : out.push(f); } }; walk(dir); return out; };

export async function r3OdcWorld({ hooks = {}, now = Date.parse('2026-10-15T12:00:00.000Z'), extraAssets = {}, consumers = {}, portal = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx15r3-odc-')), root = path.join(dir, 'destructive');
  const assets = { [LIB]: { assetKey: LIB, name: 'ZZScratchLib', revision: 2, assetType: 'Library' }, ...structuredClone(extraAssets) };
  const groups = { [GROUP]: { key: GROUP, name: 'ZZOps', description: 'synthetic' } };
  const writes = [], gets = [], requests = new Map(); let n = 0;
  const reply = (body, status = 200) => ({ ok: true, status, contentType: 'application/json', body, host: HOST });
  const tenantCall = async request => {
    const route = request.basePath + request.path; let m;
    if (request.method !== 'GET') {
      writes.push({ method: request.method, route, body: request.body ?? null });
      if (hooks.beforeWrite) await hooks.beforeWrite(request);
    } else {
      gets.push(route);
      if (hooks.beforeGet) await hooks.beforeGet(route, request);
    }
    if (route === '/api/portfolios/v2/environments') return reply({ results: [{ key: 'dev' }, { key: 'qa' }] });
    if ((m = /^\/api\/dependency-management\/v1\/assets\/([^/]+)\/consumers$/.exec(route))) return reply({ results: assets[m[1]] ? (consumers[m[1]] ?? []).filter(c => assets[c.key]) : [] });
    if ((m = /^\/api\/asset-repository\/v1\/assets\/([^/]+)$/.exec(route))) {
      if (request.method === 'DELETE') { delete assets[m[1]]; return { ok: true, status: 204, host: HOST }; }
      return assets[m[1]] ? reply(assets[m[1]]) : reply({ title: 'not found' }, 404);
    }
    if ((m = /^\/api\/identity\/v1\/groups\/([^/]+)$/.exec(route))) return groups[m[1]] ? reply(groups[m[1]]) : reply({ title: 'not found' }, 404);
    if ((m = /^\/api\/identity\/v1\/users\/([^/]+)$/.exec(route))) return USERS[m[1]] ? reply({ key: m[1], name: USERS[m[1]], email: USERS[m[1]].toLowerCase() + '@ssam-proof.invalid' }) : reply({ title: 'not found' }, 404);
    if (route === '/api/identity/v1/application-roles') {
      const key = new URLSearchParams(request.query ?? '').get('key');
      return reply({ results: ROLES[key] ? [{ key, name: ROLES[key] }] : [], page: { totalResults: ROLES[key] ? 1 : 0, offset: 0 } });
    }
    if ((m = /^\/api\/identity\/v1\/groups\/([^/]+)\/(users|application-roles)$/.exec(route)) && request.method === 'PATCH') return { ok: true, status: 204, host: HOST };
    return reply({ title: 'unexpected ' + request.method + ' ' + route }, 400);
  };
  const studio = { running: async () => true, call: async args => {
    if (args[0] === 'auth-status') return { ok: true, bridge: 'v38', sessions: [{ host: HOST, loggedIn: true, user: 'dev@example.test' }], portalWindows: [], capabilities: ['portal-call'] };
    if (args[0] === 'portal-call') return tenantCall(requests.get(args[1]));
    return { ok: false, error: 'Unknown command ' + args[0] };
  } };
  const access = new OdcAccess({ catalog: new Catalog(), tenants: { default: HOST, tenants: { [HOST]: { class: 'personal' } } }, studio,
    vault: { apiClient: async () => ({ available: false }), portal: async () => ({ available: false }), bridge: async () => { throw new Error('no vault in this test'); } },
    prompt: { apiClient: async () => ({ opened: true }), portal: async () => ({ opened: true }) },
    portalBroker: () => ({ available: false, authenticated: false, initialize: async () => {} }),
    receipts: new WriteJournal(path.join(dir, 'receipts')), sleep: async () => {},
    requestFile: json => { const file = 'req-' + (++n); requests.set(file, structuredClone(json)); return file; } });
  // Optional Portal: the reads (portal.read(operationId, input)) and the screenservice transport, counted (no session).
  const portalLog = { reads: [], sends: [] };
  if (portal) {
    access.portalRead = async ({ operationId, input }) => { portalLog.reads.push(operationId); if (hooks.beforePortalRead) await hooks.beforePortalRead(operationId); return portal.read(operationId, input); };
    access.resolvePortal = async () => ({ ok: true, path: 'vault', broker: { callScreenservice: async request => { portalLog.sends.push(structuredClone(request.input)); return { data: {} }; } } });
  }
  const clock = { t: now };
  const server = new McpServer({ name: 'cx15r3-odc', version: '1.0.0' });
  registerAccessTools(server, guardedAccess(access, { now: () => clock.t, root }), wrap);
  registerSsamTask(server, { destructiveRoot: root, tasksDir: path.join(dir, 'tasks') });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cx15r3-odc-client', version: '1.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { dir, root, access, assets, groups, writes, gets, clock, hooks, client, portalLog,
    call: async (name, args, options) => valueOf(await client.callTool({ name, arguments: args }, options)),
    wait: () => { clock.t += CONFIRM_MIN_AGE_MS + 1000; },
    receipts: () => files(path.join(dir, 'receipts')).filter(f => f.endsWith('.json')).map(f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }).filter(Boolean),
    close: async () => { await client.close(); await server.close(); } };
}
