// Same qualification cases run against the baseline and the candidate. The base
// loads normally and refuses the unsupported kind; there is no missing-import red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const source = process.env.SSAM_AGENT_SOURCE;
const { createAgent } = await import(source ? pathToFileURL(path.join(source, 'agent/lib/agent.mjs')).href : '../lib/agent.mjs');
const host = 'tenant.example.test';
const cases = [
  ['Service Center logs', { op: 'request', host, service: 'service-center', auth: 'credential', method: 'GET', url: `https://${host}/ServiceCenter/Errors_List.aspx` }],
  ['Service Center private HTTP', { op: 'request', host, service: 'service-center', auth: 'credential', method: 'POST', url: `https://${host}/ServiceCenter/Errors_List.aspx`, body: Buffer.from('search=hello').toString('base64'), contentType: 'application/x-www-form-urlencoded' }],
  ['stored profile', { op: 'status', host, service: 'service-center', auth: 'credential', profile: 'a'.repeat(64) }],
  ['Portal account', { op: 'request', host, service: 'odc-portal', auth: 'credential', method: 'POST', url: `https://${host}/apps/screenservices/apps/List` }],
  ['Portal API client', { op: 'request', host, service: 'odc-portal', auth: 'api-client', method: 'GET', url: `https://${host}/api/apps/v1/apps` }],
];
for (const [name, params] of cases) test('qualification: ' + name + ' dispatches through the private Agent kind', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r40-qualification-'));
  const calls = [];
  const agent = createAgent({ root, config: { credential: 'qualification-account', server: 'http://127.0.0.1:9' },
    deps: { machine: null, locate: async () => null, processes: async () => [], platform: 'win32', fetch: async () => { throw new Error('no external network in qualification'); },
      credentials: { lookup: async () => [{ address: '93.184.216.34' }], exec: async (file, args, input) => {
        calls.push(JSON.parse(input)); return JSON.stringify({ ok: true, available: true, authenticated: true, principal: 'test account', profile: 'a'.repeat(64), status: 200, contentType: 'application/json', body: Buffer.from('{"result":"ok"}').toString('base64') });
      } } } });
  const answer = await agent.execute('credential.session', params);
  assert.equal(answer.ok, true, 'expected private dispatch, got ' + (answer.error?.code ?? 'no error'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].service, params.service);
});
