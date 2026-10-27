// Shared fixtures of the served-proof tests (F1): a block's base and candidate stylesheets as the kernel reports them,
// what the platform serves, a fake fetch, and an o11_deliver server over a fake Anvil CLI. Synthetic names only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { registerO11Cycle } from '../../o11-cycle.mjs';
import { fakeAnvil } from './fake-anvil.mjs';
import envelopes from './o11-cycle-envelopes.json' with { type: 'json' };

export const ORIGIN = 'https://env-a.example.test';
// The base and the candidate of a block, as the kernel reports them, and what the platform serves (reformatted).
export const BASE = '.app-shell .acct{display:flex;align-items:center;gap:12px}\n.app-shell .acct>.av{flex:0 0 30px;width:30px}\n';
export const DELIVERED = BASE + '@media (max-width: 600px){.app-shell .acct{gap:4px!important}}\n.app-shell .title>span{display:contents}\n';
export const SERVED_NEW = '.app-shell .acct {\n    display: flex;\n    align-items: center;\n    gap: 12px\n}\n\n.app-shell .acct > .av {\n    flex: 0 0 30px;\n    width: 30px;\n}\n'
  + '@media (max-width:600px) {\n  .app-shell .acct { gap: 4px !important; }\n}\n.app-shell .title>span {\n    display: contents\n}\n';
export const SERVED_OLD = '.app-shell .acct {\n    display: flex;\n    align-items: center;\n    gap: 12px\n}\n\n.app-shell .acct > .av {\n    flex: 0 0 30px;\n    width: 30px;\n}\n';
export const KERNEL = [{ key: 'blk', kind: 'block', name: 'AccountMenu', flow: 'Common', flavor: 'traditional', baseStyleSheet: BASE, styleSheet: DELIVERED,
  touch: { key: 'w2', name: 'Row', prop: 'Style', value: ' ', from: '' }, reason: null }];
export const BLOCK_URL = ORIGIN + '/SalesPortal/Blocks/SalesPortal/Common/AccountMenu.css';

export function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const route = typeof routes === 'function' ? routes(url, init) : routes[url];
    if (route instanceof Error) throw route;
    if (!route) return { status: 404, headers: { get: () => null }, text: async () => 'not found' };
    const headers = { 'content-type': route.type ?? 'text/css', ...(route.location ? { location: route.location } : {}) };
    return { status: route.status ?? 200, headers: { get: name => headers[name.toLowerCase()] ?? null }, text: async () => route.body ?? '', ...(route.stream ? { body: route.stream } : {}) };
  };
  fn.calls = calls;
  return fn;
}
// ---- o11_deliver {publish:true}
const WORDS = 'yes, deliver and publish the sales portal';
export function sandbox(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'served-proof-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'anvil'), home = path.join(base, 'home'), auth = path.join(base, 'authority');
  for (const dir of [root, home, auth]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(auth, 'bridge.key'), 'TESTKEY');
  const env = { USERPROFILE: home, HOME: home, LOCALAPPDATA: path.join(home, 'AppData', 'Local'), ANVIL_AUTHORITY_DIR: auth, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', ANVIL_LANE: 'ss4' };
  fs.mkdirSync(path.join(root, '.local', 'connections'), { recursive: true });
  fs.writeFileSync(path.join(root, '.local', 'connections', 'ss4.json'), JSON.stringify({ ok: true, lane: 'o11', anvilLane: 'ss4', pid: 4242, port: 45998, studioDir: path.join(base, 'Studio'), authorityDir: auth }));
  const job = (name, document) => { const file = path.join(base, 'jobs', name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(document)); return file; };
  let clock = Date.parse('2026-10-22T10:00:00.000Z');
  return { base, root, env, job, now: () => new Date(clock += 1000) };
}
export async function serve(t, deps) {
  const server = new McpServer({ name: 'served-proof', version: '1.0.0' });
  registerO11Cycle(server, deps);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'served-proof-client', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  return args => client.callTool({ name: 'o11_deliver', arguments: args }).then(reply => reply.structuredContent ?? JSON.parse(reply.content[0].text));
}
export function setup(t, { servedFetch, styleSheets = KERNEL, publish = { ok: true, result: 'published' }, extra = {} } = {}) {
  const box = sandbox(t);
  const data = structuredClone(envelopes.delivered.data);
  if (styleSheets) data.apply.styleSheets = styleSheets;
  const runAnvil = fakeAnvil({ deliver: () => ({ ...envelopes.delivered, data }) });
  const deps = { root: box.root, env: box.env, lane: 'ss4', now: box.now, runAnvil, assertSelected: async () => {}, grantsFile: path.join(box.base, 'grants.json'),
    lastPublication: async () => null, publish: async () => publish, ...(servedFetch !== undefined ? { servedFetch } : {}), readerCheck: null, ...extra };
  return { ...box, runAnvil, deps };
}
export const cssJob = { ops: [{ op: 'set', target: 'IWebBlock:AccountMenu', prop: 'StyleSheet', value: DELIVERED }] };

