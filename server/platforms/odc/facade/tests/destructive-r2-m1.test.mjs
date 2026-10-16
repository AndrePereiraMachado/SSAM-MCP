import './fixtures/isolated-profile.mjs';
// CX15 r2, F4.3 (M1): authorize and operationUuid are optional in the schemas of odc_write, odc_portal_write and odc_deploy
// (a destructive call without confirmationToken only previews), so the access checks them for every other write: a write
// that lacks the words and/or the UUID is ONE refusal naming both (and the input problem found before them, if any), and
// nothing is reserved or sent. Through the MCP SDK (McpServer + Client + InMemoryTransport, the wrap of mcp.mjs) over the
// real OdcAccess and a fake ODC Studio bridge, and through the CLI with SSAM_ODC_OFFLINE=1. Synthetic values only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { registerAccessTools } from '../odc-access.mjs';
import { wrap } from '../mcp.mjs';
import { guardedAccess } from '../../portal/runtime/destructive-preview.mjs';
import { OdcAccess } from '../../portal/runtime/access.mjs';
import { Catalog } from '../../portal/runtime/catalog.mjs';
import { WriteJournal } from '../../portal/runtime/write-journal.mjs';

process.env.SSAM_ODC_OFFLINE = '1';
const here = path.dirname(fileURLToPath(import.meta.url));
const HOST = 'personal-r2m1.outsystems.dev';
const PATCH_USER = 'user-access-management-api-v1:patch:/users/{key}';
const USER = 'aa11bb22-cc33-4d44-8e55-ff66aa77bb88';
const ASSET = '3f2a9c10-1b2c-4d3e-8f40-5a6b7c8d9e01', STAGE = '9e8d7c6b-5a49-4382-a1b0-c9d8e7f6a5b4';
const WORDS = 'sim, pode mudar o nome do usuario';
const valueOf = reply => reply.structuredContent ?? JSON.parse(reply.content[0].text);

async function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx15r2-m1-'));
  const calls = [], requests = new Map(); let n = 0;
  const studio = { running: async () => true, call: async args => {
    calls.push(args[0]);
    if (args[0] === 'auth-status') return { ok: true, bridge: 'v38', sessions: [{ host: HOST, loggedIn: true, user: 'dev@example.test' }], portalWindows: [], capabilities: ['portal-call'] };
    if (args[0] === 'portal-call') { const r = requests.get(args[1]); return { ok: true, status: 200, contentType: 'application/json', body: { method: r?.method }, host: HOST }; }
    return { ok: false, error: 'Unknown command ' + args[0] };
  } };
  const access = new OdcAccess({ catalog: new Catalog(), tenants: { default: HOST, tenants: { [HOST]: { class: 'personal' } } }, studio,
    vault: { apiClient: async () => ({ available: false }), portal: async () => ({ available: false }), bridge: async () => { throw new Error('no vault in this test'); } },
    prompt: { apiClient: async () => ({ opened: true }), portal: async () => ({ opened: true }) },
    portalBroker: () => ({ available: false, authenticated: false, initialize: async () => {} }),
    receipts: new WriteJournal(path.join(dir, 'receipts')), sleep: async () => {},
    requestFile: json => { const file = 'req-' + (++n); requests.set(file, structuredClone(json)); return file; } });
  const server = new McpServer({ name: 'cx15r2-m1', version: '1.0.0' });
  registerAccessTools(server, guardedAccess(access, { root: path.join(dir, 'destructive') }), wrap);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cx15r2-m1-client', version: '1.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const receipts = () => (fs.existsSync(path.join(dir, 'receipts')) ? fs.readdirSync(path.join(dir, 'receipts')) : []);
  return { calls, receipts, call: async (name, args) => { const reply = await client.callTool({ name, arguments: args }); return { isError: reply.isError === true, ...valueOf(reply) }; },
    close: async () => { await client.close(); await server.close(); } };
}
const problemsOf = answer => (answer.error?.problems ?? answer.problems ?? []).map(p => [p.code, p.path ?? null]);
const BOTH = [['AUTHORIZATION_REQUIRED', '/authorize'], ['INPUT_INVALID', '/operationUuid']];

test('M1: a non-destructive odc_write, odc_portal_write or odc_deploy without authorize and operationUuid is ONE refusal naming both; nothing is sent', async () => {
  const w = await world();
  try {
    const patch = await w.call('odc_write', { tenant: HOST, operationId: PATCH_USER, path: { key: USER }, body: { name: 'X' } });
    assert.equal(patch.isError, true); assert.equal(patch.error?.code, 'AUTHORIZATION_REQUIRED', JSON.stringify(patch).slice(0, 400));
    assert.deepEqual(problemsOf(patch), BOTH, JSON.stringify(patch).slice(0, 600));
    assert.match(patch.error.message, /authorize/); assert.match(patch.error.message, /operationUuid/);
    const portal = await w.call('odc_portal_write', { tenant: HOST, operationId: 'agents.datasetCreate', input: { inputParameters: {} } });
    assert.equal(portal.isError, true);
    assert.deepEqual(problemsOf(portal), BOTH, JSON.stringify(portal).slice(0, 600));
    const deploy = await w.call('odc_deploy', { tenant: HOST, assetKey: ASSET, environmentKey: STAGE, waitSeconds: 0 });
    assert.equal(deploy.isError, true);
    const deployProblems = problemsOf(deploy);
    for (const expected of BOTH) assert.ok(deployProblems.some(p => p[0] === expected[0] && p[1] === expected[1]), JSON.stringify(deploy).slice(0, 600));
    assert.equal(w.calls.includes('portal-call'), false, 'nothing reached the tenant');
    assert.deepEqual(w.receipts(), [], 'nothing was reserved');
  } finally { await w.close(); }
});

test('M1: one field missing keeps today\'s refusal of that field; an input problem and the missing fields are one refusal', async () => {
  const w = await world();
  try {
    const noUuid = await w.call('odc_write', { tenant: HOST, operationId: PATCH_USER, path: { key: USER }, body: { name: 'X' }, authorize: WORDS });
    assert.equal(noUuid.error?.code, 'INPUT_INVALID'); assert.match(noUuid.error.message, /operationUuid/); assert.equal(noUuid.error.problems, undefined);
    const noWords = await w.call('odc_write', { tenant: HOST, operationId: PATCH_USER, path: { key: USER }, body: { name: 'X' }, operationUuid: crypto.randomUUID() });
    assert.equal(noWords.error?.code, 'AUTHORIZATION_REQUIRED'); assert.equal(noWords.error.problems, undefined);
    // An unknown query parameter found before the words: the same single refusal names the three problems.
    const all = await w.call('odc_write', { tenant: HOST, operationId: PATCH_USER, path: { key: USER }, query: { bogus: '1' }, body: { name: 'X' } });
    assert.equal(all.error?.code, 'INPUT_INVALID', JSON.stringify(all).slice(0, 400));
    assert.deepEqual(problemsOf(all).map(p => p[0]), ['INPUT_INVALID', 'AUTHORIZATION_REQUIRED', 'INPUT_INVALID'], JSON.stringify(all).slice(0, 600));
    assert.deepEqual(problemsOf(all).slice(1), BOTH);
    assert.equal(w.calls.includes('portal-call'), false); assert.deepEqual(w.receipts(), []);
  } finally { await w.close(); }
});

test('M1 through the CLI: .\\odc portal write without --authorize and --operation-uuid is one refusal naming both', async () => {
  const cli = path.resolve(here, '..', 'odc.mjs');
  const out = await new Promise(resolve => execFile(process.execPath, [cli, 'portal', '--tenant', HOST, 'write', PATCH_USER, '--path', JSON.stringify({ key: USER }), '--body', JSON.stringify({ name: 'X' })],
    { env: { ...process.env, SSAM_ODC_OFFLINE: '1' }, windowsHide: true, timeout: 90000 }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout: String(stdout), stderr: String(stderr) })));
  let answer; try { answer = JSON.parse(out.stdout); } catch { answer = { unparsed: out.stdout.slice(0, 300), stderr: out.stderr.slice(0, 300) }; }
  assert.equal(out.code, 1);
  assert.equal(answer.error?.code, 'AUTHORIZATION_REQUIRED', JSON.stringify(answer).slice(0, 400));
  assert.deepEqual(problemsOf(answer), BOTH, JSON.stringify(answer).slice(0, 600));
});
