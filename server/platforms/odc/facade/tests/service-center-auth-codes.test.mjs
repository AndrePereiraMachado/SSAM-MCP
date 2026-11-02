// Lote 4, F3: the authentication codes of the friction queue (SC_AUTH_EXPIRED, IDENTITY_TIMEOUT, HEADLESS_AUTH_UNAVAILABLE,
// AUTH_REQUIRED) and of this front (ENVIRONMENT_SESSION_EXPIRED, VAULT_API_UNAVAILABLE) are documented in refusal-codes.mjs
// and answered with an executable continuation: a registered tool whose own input schema accepts the arguments. No
// continuation asks for a secret. Offline: captured tool registrations, synthetic bridge and pages.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AUTH_CODES, authContinuation, codeFromText } from '../refusal-codes.mjs';
import { MCP_TOOLS } from '../continuations.mjs';
import { registerO11Operations } from '../o11-operations.mjs';
import { registerO11Studio } from '../o11-studio.mjs';
import { registerAccessTools } from '../odc-access.mjs';
import { runServiceCenter } from '../service-center/index.mjs';
import { Journal } from '../service-center/client.mjs';
import { AuthRequired, ProtocolError } from '../service-center/errors.mjs';
import { publicError, OdcError } from '../../portal/runtime/errors.mjs';
import { FakeBridge, temp } from './fixtures/sc-fake-bridge.mjs';

const HOST = 'test.example.com';
const TENANT = 'personal-test.outsystems.dev';
const REGISTRY = path.join(import.meta.dirname, 'fixtures', 'sc-hosts.json');

// The input schemas of the tools the continuations name, as each front registers them.
function schemas() {
  const tools = new Map();
  const capture = { registerTool: (name, config) => tools.set(name, config.inputSchema) };
  registerO11Operations(capture, schema => schema, {});
  registerO11Studio(capture, {});
  registerAccessTools(capture, {}, fn => fn);
  return tools;
}
// A JSON schema (o11 operations) or a zod schema (the others) accepts the arguments.
function accepts(schema, args) {
  if (typeof schema?.safeParse === 'function') return schema.safeParse(args).success;
  if (schema?.type === 'object') {
    for (const key of schema.required ?? []) if (!(key in args)) return false;
    for (const [key, value] of Object.entries(args)) {
      const property = schema.properties?.[key];
      if (!property) return schema.additionalProperties !== false;
      if (property.enum && !property.enum.includes(value)) return false;
    }
    return true;
  }
  return false;
}
const ALWAYS_THERE = new Set(['ssam_doctor', 'ssam_connect']); // registered by ssam.mjs itself, arguments {lane} only

test('every authentication code is documented and goes on to an executable call on both lanes', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'refusal-codes.mjs'), 'utf8');
  const tools = schemas();
  for (const code of AUTH_CODES) {
    assert.match(source, new RegExp('^//   ' + code + '\\s', 'm'), code + ' documented');
    for (const lane of ['o11', 'odc']) {
      const next = authContinuation(code, { lane, host: HOST, tenant: TENANT });
      assert.ok(next, code + ' ' + lane);
      assert.ok(MCP_TOOLS.includes(next.tool), next.tool);
      assert.ok(typeof next.why === 'string' && next.why.length > 20);
      assert.doesNotMatch(JSON.stringify(next.arguments), /password|secret|token|credential/i, code);
      if (ALWAYS_THERE.has(next.tool)) assert.deepEqual(next.arguments, { lane: 'o11' });
      else assert.ok(accepts(tools.get(next.tool), next.arguments), `${code} ${lane}: ${next.tool} ${JSON.stringify(next.arguments)}`);
    }
  }
  assert.equal(authContinuation('SOMETHING_ELSE'), null);
  // IDENTITY_TIMEOUT repeats the refused call when it is known: nothing protected was sent.
  assert.deepEqual(authContinuation('IDENTITY_TIMEOUT', { same: { tool: 'o11_service_center_read', arguments: { action: 'timers', host: HOST } } }).arguments,
    { action: 'timers', host: HOST });
  // The texts of a lost code are classified the same way (friction store).
  assert.equal(codeFromText("environment_session: FaultException: ... ---> IDX20803: Unable to obtain configuration"), 'ENVIRONMENT_SESSION_EXPIRED');
  assert.equal(codeFromText('Service Center login required or session expired'), 'SC_AUTH_EXPIRED');
  // Only the O11 environment session's text: an IDX of another lane (an ODC portal answer) keeps its own classification.
  assert.notEqual(codeFromText('portal: IDX10223: Lifetime validation failed'), 'ENVIRONMENT_SESSION_EXPIRED');
  assert.equal(codeFromText('EnvironmentSessionExpiredException: The OutSystems environment h refused the session'), 'ENVIRONMENT_SESSION_EXPIRED');
});

// O11: runServiceCenter answers each code with its continuation, from every kind of failure that carries it.
test('the Service Center tool answers each authentication code with its continuation', async () => {
  const dir = temp();
  const run = (argv, deps) => runServiceCenter([...argv, '--host', HOST], { journal: new Journal(dir), present: async () => false, running: async () => false,
    registry: REGISTRY, exports: dir, sleep: async () => {}, env: { USERPROFILE: dir, SSAM_ODC_OFFLINE: '1' },
    // Never the real window manager: a call that reached it would be a defect of this test.
    promptManager: async () => assert.fail('no private window in this test'), ...deps });
  // AUTH_REQUIRED: a pages read with authPrompt=never and nothing stored (no Studio, no profile).
  const required = await run(['solutions', '--auth-prompt', 'never'], { locate: () => null });
  assert.equal(required.code, 'AUTH_REQUIRED');
  assert.deepEqual(required.continuation.arguments, { action: 'sign-in', host: HOST, session: 'vault' });
  // authPrompt=never holds on sign-in too, on every surface: AUTH_REQUIRED, never the window (the manager fails the test).
  for (const extra of [[], ['--surface', 'lifetime']]) {
    const never = await run(['session-sign-in', '--auth-prompt', 'never', ...extra], { locate: () => null });
    assert.equal(never.code, 'AUTH_REQUIRED', extra.join(' '));
    assert.match(never.error, /nothing was prompted \(authPrompt=never\)/);
    assert.equal(never.continuation.tool, 'o11_service_center_session');
  }
  // The line refuses session=vault without a private profile store before any prompt, with its own code (VAULT_UNAVAILABLE).
  const vault = await run(['session-sign-in', '--auth-prompt', 'never', '--session', 'vault'], { locate: () => null });
  assert.equal(vault.code, 'VAULT_UNAVAILABLE');
  assert.match(vault.error, /no prompt was opened/);
  // HEADLESS_AUTH_UNAVAILABLE: the bridge has no headless Service Center transport (a pages read with session=studio).
  const headless = await run(['solutions', '--session', 'studio'], { locate: () => new FakeBridge({ capabilities: ['sc_api:soap'] }) });
  assert.equal(headless.code, 'HEADLESS_AUTH_UNAVAILABLE');
  assert.deepEqual(headless.continuation, { tool: 'ssam_doctor', arguments: { lane: 'o11' }, why: headless.continuation.why });
  // SC_AUTH_EXPIRED and IDENTITY_TIMEOUT thrown deep in a read, as AuthRequired and as a plain ProtocolError.
  for (const [error, code] of [[new AuthRequired('SC_AUTH_EXPIRED', 'Service Center answered with its login page'), 'SC_AUTH_EXPIRED'],
    [new ProtocolError('Service Center login required or session expired', 'SC_AUTH_EXPIRED'), 'SC_AUTH_EXPIRED'],
    [new AuthRequired('IDENTITY_TIMEOUT', 'The identity provider did not answer in time'), 'IDENTITY_TIMEOUT']]) {
    const bridge = new FakeBridge();
    bridge.web = () => { throw error; };
    const answer = await run(['solutions'], { locate: () => bridge });
    assert.equal(answer.code, code);
    assert.ok(answer.continuation?.tool, code + ' continuation');
    if (code === 'SC_AUTH_EXPIRED') assert.deepEqual(answer.continuation.arguments, { action: 'sign-in', host: HOST });
    else assert.deepEqual(answer.continuation.arguments, { action: 'solutions', host: HOST }, 'the same read, once');
  }
});

// ODC: a thrown authentication error of the Portal runtime carries its continuation, which odc-access.mjs lifts.
test('the Portal runtime answers each authentication code with its continuation', async () => {
  for (const code of ['HEADLESS_AUTH_UNAVAILABLE', 'AUTH_REQUIRED', 'IDENTITY_TIMEOUT']) {
    const error = publicError(new OdcError(code, 'synthetic'));
    assert.deepEqual(error.continuation, authContinuation(code, { lane: 'odc' }));
  }
  // An error that already says what goes on keeps it; another code gets none.
  assert.equal(publicError(new OdcError('HEADLESS_AUTH_UNAVAILABLE', 'x', { continuation: { tool: 'studio_attach', arguments: {} } })).continuation.tool, 'studio_attach');
  assert.equal(publicError(new OdcError('PORTAL_CONTRACT_CHANGED', 'x')).continuation, undefined);
  // Through the registered tool: odc_portal_login of a Studio without the headless Portal transport.
  const tools = new Map();
  registerAccessTools({ registerTool: (name, config, handler) => tools.set(name, handler) },
    { portalLogin: async () => ({ ok: false, error: publicError(new OdcError('HEADLESS_AUTH_UNAVAILABLE', 'The attached Studio has no headless Portal session transport.')), tenant: TENANT }) },
    fn => fn);
  const answer = await tools.get('odc_portal_login')({ tenant: TENANT });
  const value = answer?.structuredContent ?? (answer?.content?.[0]?.text ? JSON.parse(answer.content[0].text) : answer);
  assert.equal(value.code, 'HEADLESS_AUTH_UNAVAILABLE');
  assert.deepEqual(value.continuation.arguments, { tenant: TENANT });
  assert.equal(value.continuation.tool, 'odc_auth_status');
});

// The server line is a multi-user hosted server: there a continuation never sends the user to a prompt, the vault or a stored
// profile of the server (hosted mode refuses them: HOSTED_PROMPT_UNAVAILABLE, HOSTED_STUDIO_SESSION_ONLY).
test('hosted, no authentication continuation leads to a prompt, the vault or a stored profile of the server', async () => {
  const tools = schemas();
  for (const code of AUTH_CODES) for (const lane of ['o11', 'odc']) for (const host of [HOST, null]) {
    const next = authContinuation(code, { lane, host, tenant: TENANT, hosted: true });
    assert.ok(next && MCP_TOOLS.includes(next.tool), code + ' ' + lane);
    const args = JSON.stringify(next.arguments);
    assert.doesNotMatch(args, /"session":"vault"|"action":"prompt"|portal-credential/, `${code} ${lane}: ${args}`);
    assert.doesNotMatch(next.why, /private window|saved Portal profile|stored profile/, `${code} ${lane}: ${next.why}`);
    if (!ALWAYS_THERE.has(next.tool)) assert.ok(accepts(tools.get(next.tool), next.arguments), `${code} ${lane}: ${next.tool} ${args}`);
  }
  assert.deepEqual(authContinuation('AUTH_REQUIRED', { lane: 'o11', host: HOST, hosted: true }), { tool: 'o11_studio', arguments: { command: 'login', args: { host: HOST } },
    why: authContinuation('AUTH_REQUIRED', { lane: 'o11', host: HOST, hosted: true }).why });
  assert.deepEqual(authContinuation('AUTH_REQUIRED', { lane: 'odc', tenant: TENANT, hosted: true }).arguments, { lane: 'odc' });
  // Installed (the default), the private window stays the next step, only when the person wants it.
  assert.deepEqual(authContinuation('AUTH_REQUIRED', { lane: 'o11', host: HOST }).arguments, { action: 'sign-in', host: HOST, session: 'vault' });
});
