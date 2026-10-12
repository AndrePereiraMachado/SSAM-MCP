// A static scan of the facade and the Portal runtime (docs/FASE2-AGENTE.md 10.6): what touches a machine (sockets and
// pipes, process listings, the registry, the Studio connector, the bridge clients) lives only in the local
// implementation files behind the executor seam; the O11 lane table port is read only where 4.7 fails it closed; the
// credential prompt windows open only from the two openPrompt functions; and the Portal runtime's HTTP, vault helpers
// and Cognito login stay in the modules that have them today. A new use outside these lists fails here, so a hosted
// call can never reach the owner's machine by a path the seam does not see.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const odc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  if (['node_modules', 'tests'].includes(entry.name)) return [];
  const full = path.join(dir, entry.name);
  return entry.isDirectory() ? walk(full) : /\.(mjs|js|cjs)$/.test(entry.name) ? [full] : [];
});
const sources = [...walk(path.join(odc, 'facade')), ...walk(path.join(odc, 'portal', 'runtime'))]
  .map(file => ({ name: path.relative(odc, file).replaceAll('\\', '/'), text: fs.readFileSync(file, 'utf8') }));
const count = (text, pattern) => (text.match(pattern) ?? []).length;
const hits = (pattern, among = sources) => Object.fromEntries(among.map(s => [s.name, count(s.text, pattern)]).filter(([, n]) => n > 0));

// The local implementation files of the seam (executor.mjs and the transports and locators behind it).
const LOCAL = new Set(['facade/executor.mjs', 'facade/odc-pipe.mjs', 'facade/o11-bridge.mjs', 'facade/studio-connect.mjs', 'facade/studio-locate.mjs',
  'facade/o11-lane.mjs', 'facade/reader-client.mjs', 'facade/anvil-worker.mjs', 'facade/service-center/vault.mjs', 'facade/service-center/bridge.mjs']);
// The files of tools that are unavailable on a hosted server (hosted/tools.json class unavailable; the gate refuses before
// their handler runs): the local preview of ssam_preview (16th release) talks to this machine's Studio pipes by design.
// servidor/fase4-24: the debugger files (facade/debug-*.mjs) belong to ssam_debug and its siblings, all unavailable hosted.
const HOSTED_UNAVAILABLE_FILES = { 'facade/preview/': 'ssam_preview', 'portal/runtime/external-library-upload.mjs': 'odc_external_library', 'facade/debug-': 'ssam_debug' };
const hostedUnavailable = name => Object.keys(HOSTED_UNAVAILABLE_FILES).some(prefix => name.startsWith(prefix));
// servidor/fase4-24 (R3): the handoff pipes of the private transports of the 24th release (a local pipe to a bridge on the
// same machine). Each refuses in hosted mode before it connects (HOSTED_STUDIO_SESSION_ONLY): checked below.
const HOSTED_REFUSED_PIPES = { 'facade/service-center/private-cookie-pipe.mjs': /if\(hostedContext\(\)\)throw hostedHandoffRefusal\(\);/,
  'portal/runtime/private-session-pipe.mjs': /if \(hostedContext\(\)\) throw hostedHandoffRefusal\(\);/ };
const local = name => LOCAL.has(name) || /^facade\/debug-[^/]*\.mjs$/.test(name) || hostedUnavailable(name) || Object.hasOwn(HOSTED_REFUSED_PIPES, name);
const MACHINE = {
  'net.createConnection': /net\.createConnection/g,
  tasklist: /\btasklist\b/g,
  'Get-CimInstance': /Get-CimInstance/g,
  'reg query / reg.exe': /\breg query\b|\breg\.exe\b|['"]reg['"]\s*,\s*\[\s*['"]query['"]/gi,
  'Anvil.Connect': /Anvil\.Connect/g,
  'paths.client': /\bpaths\.client\b/g,
  pipeCall: /\bpipeCall\b/g,
  bridgeRequest: /\bbridgeRequest\b/g,
  bridgeCall: /\bbridgeCall\b/g,
};

test('the scan sees the facade and the Portal runtime', () => {
  const names = sources.map(s => s.name);
  for (const expected of ['facade/executor.mjs', 'facade/lib.mjs', 'facade/mcp.mjs', 'facade/service-center/index.mjs', 'portal/runtime/access.mjs'])
    assert.ok(names.includes(expected), expected);
  assert.ok(!names.some(n => n.includes('/tests/')));
});

for (const [label, pattern] of Object.entries(MACHINE)) {
  test('machine access by ' + label + ' only in the local implementation files', () => {
    const outside = Object.keys(hits(pattern)).filter(name => !local(name));
    assert.deepEqual(outside, [], label + ' outside the seam: ' + outside.join(', '));
  });
}

test('the private handoff pipes refuse in hosted mode before they connect, at the top of their only entry', () => {
  for (const [name, guard] of Object.entries(HOSTED_REFUSED_PIPES)) {
    const text = sources.find(s => s.name === name)?.text;
    assert.ok(text, name + ' exists');
    assert.match(text, guard, name + ': the hosted refusal');
    assert.equal(count(text, /net\.createConnection/g), 1, name + ': one connect, as the default of its entry');
    const guardAt = text.search(guard), connectAt = text.search(/export async function with\w+\(/);
    assert.ok(connectAt >= 0 && guardAt > connectAt, name + ': the refusal is inside the entry that connects');
  }
});

test('the executor seam is where the local transports are called', () => {
  const executor = sources.find(s => s.name === 'facade/executor.mjs').text;
  for (const pattern of [/\bpipeCall\b/, /\bbridgeRequest\b/, /Get-CimInstance/]) assert.match(executor, pattern);
  // lib.mjs, lanes.mjs and the Service Center list processes and reach the bridges only through the executor.
  for (const name of ['facade/lib.mjs', 'facade/lanes.mjs', 'facade/service-center/auth.mjs'])
    assert.match(sources.find(s => s.name === name).text, /currentExecutor\(\)/, name);
});

test('the O11 lane table port (o11LaneOf(...).bridge) is read only at the known sites of 4.7', () => {
  // Each site reads the port only when the connection record has none; hosted the getter fails with O11_NOT_CONNECTED.
  const KNOWN = { 'facade/o11-bridge.mjs': 1, 'facade/o11-cycle.mjs': 1, 'facade/o11-access.mjs': 1, 'facade/job-runner.mjs': 1,
    'facade/service-center/bridge.mjs': 1, 'facade/o11-app-session.mjs': 1 };
  const site = /(?:\bo11LaneOf\([^;]*?\)|\blane\(\)|(?<!['"\w.])o11)\.bridge\b/g;
  // Code only: comments name the o11.bridge call kind.
  const code = sources.filter(s => s.name !== 'facade/o11-lane.mjs').map(s => ({ ...s, text: s.text.replace(/(^|[^:'"\\])\/\/.*$/gm, '$1') }));
  assert.deepEqual(hits(site, code), KNOWN);
});

test('credential prompt windows open only from the two openPrompt functions', () => {
  // The prompt is a PowerShell -File of a credential script, detached in its own window.
  const inPrompt = { 'facade/lib.mjs': 1, 'facade/service-center/auth.mjs': 1 };
  const statusOnly = new Set(['portal/runtime/api-client-credential.mjs', 'portal/runtime/odc3-context.mjs']); // -NonInteractive status reads
  // servidor/fase4-24: the private credential-profile selector of the 24th release (credential-profiles.mjs lists and
  // launches scripts/credential-profiles.ps1) is the third -File site; both of its helpers refuse hosted before they start.
  const selector = 'facade/credential-profiles.mjs';
  const files = hits(/'-File'/g);
  for (const [name, n] of Object.entries(files)) {
    if (/^facade\/debug-[^/]*\.mjs$/.test(name) || statusOnly.has(name) || name === selector) continue;
    assert.equal(n, inPrompt[name], name + ' starts a PowerShell -File outside openPrompt');
    const lines = sources.find(s => s.name === name).text.split(/\r?\n/);
    const start = lines.findIndex(l => /^(export )?function openPrompt\(/.test(l));
    const end = lines.findIndex((l, i) => i > start && /^}/.test(l));
    const at = lines.findIndex(l => l.includes("'-File'"));
    assert.ok(start >= 0 && at > start && at < end, name + ': the -File spawn is not inside openPrompt');
  }
  for (const name of Object.keys(inPrompt)) assert.ok(files[name], name + ' still opens its prompt');
  // Each openPrompt refuses in hosted mode before anything opens.
  assert.match(sources.find(s => s.name === 'facade/lib.mjs').text, /function openPrompt\([^)]*\) \{\r?\n  ownerSecrets\(hostedPromptRefusal\);/);
  assert.match(sources.find(s => s.name === 'facade/service-center/auth.mjs').text, /export function openPrompt\([^\n]*\) \{\r?\n  if \(hostedContext\(\)\) throw hostedNoPrompt\(/);
  const selectorText = sources.find(s => s.name === selector)?.text ?? '';
  assert.equal(files[selector], 1, selector + ': one -File, shared by its two helpers');
  assert.match(selectorText, /function nativeList\(context\) \{\r?\n  if \(hostedContext\(\)\) return Promise\.reject\(hostedError\(\)\);/, selector + ': list refuses hosted');
  assert.match(selectorText, /async function nativeOpen\([^)]*\) \{\r?\n  if \(hostedContext\(\)\) throw hostedError\(\);/, selector + ': the selector refuses hosted');
});

test('the Portal runtime keeps its HTTP, vault helpers and Cognito login in today\'s modules', () => {
  const runtime = sources.filter(s => s.name.startsWith('portal/runtime/'));
  assert.deepEqual(Object.keys(hits(/(?<![\w.$])fetch\(|globalThis\.fetch/g, runtime)).sort(),
    ['portal/runtime/auth.mjs', 'portal/runtime/bridge.mjs', 'portal/runtime/external-library-upload.mjs', 'portal/runtime/odc3-host.mjs']);
  assert.deepEqual(Object.keys(hits(/windowsApiClientCredential|portalVault|resolvePublicApiEnvironment|CredRead/g, runtime)).sort(),
    ['portal/runtime/api-client-credential.mjs', 'portal/runtime/odc3-context.mjs', 'portal/runtime/odc3-host.mjs']);
  assert.deepEqual(Object.keys(hits(/cognito-login|cognitoLogin/g, runtime)).sort(), ['portal/runtime/cognito-login.mjs', 'portal/runtime/odc3-context.mjs']);
  // The facade reaches the vault helpers only from lib.mjs (refused hosted) and the Service Center's own vault module;
  // the debugger files of the hosted-unavailable tools are left out (servidor/fase4-24: debug-odc-portal.mjs).
  assert.deepEqual(Object.keys(hits(/windowsApiClientCredential|portalVault/g, sources.filter(s => s.name.startsWith('facade/') && !hostedUnavailable(s.name)))).sort(), ['facade/lib.mjs']);
  // odc3-context.mjs (the Portal account of the server and its direct HTTPS) refuses hosted in its vault, broker and host context.
  const odc3 = sources.find(s => s.name === 'portal/runtime/odc3-context.mjs').text;
  assert.ok(count(odc3, /^\s*hostedDirect\(\);/gm) >= 4, 'odc3-context.mjs: hostedDirect() in portalVault, the broker, its request and the host context');
});

// The exceptions above hold only while their tools stay unavailable on a hosted server: the gate refuses those tools
// before any handler runs, so their machine access never happens for a customer.
test('the files of hosted-unavailable tools belong to tools classified unavailable', async () => {
  const { hostedTools } = await import('../hosted/policy.mjs');
  const tools = hostedTools();
  for (const tool of new Set(Object.values(HOSTED_UNAVAILABLE_FILES))) assert.equal(tools[tool]?.class, 'unavailable', tool);
  for (const prefix of Object.keys(HOSTED_UNAVAILABLE_FILES)) assert.ok(sources.some(s => s.name.startsWith(prefix)), prefix + ' exists');
});