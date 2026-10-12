// Child harness (node --experimental-webstorage): runs the REAL private worker over the ORIGINAL published O11 runtime
// assets cached by an earlier proof (read only), with an in-process fake HTTP origin. No network, no vault, no window:
// the login answer, roles and server-action answers are synthetic; the runtime, controllers and converters are original.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseO11Assets } from '../../debug-o11-native-abi.mjs';
import { graphFromAssets, buildO11CallGraph } from '../../debug-o11-entry-graph.mjs';
import { loginSpec, entrySpec, contractAssets, appDefinitionOf } from '../../debug-o11-native-run.mjs';
import { prepareOriginalO11Entry, authenticateOriginalO11Entry, invokeScenarioO11Entry, configureOriginalO11ServerInspection } from '../../debug-o11-native-entry-worker.mjs';
import { appUserBinding } from '../../debug-app-user.mjs';

const [evidence, root] = process.argv.slice(2);
const suspensionProof = process.env.SSAM_DEBUG_SUSPENSION_PROOF === '1';
const inspectionProof = process.env.SSAM_DEBUG_SERVER_INSPECTION_PROOF === '1';
const responseFailureProof = process.env.SSAM_DEBUG_RESPONSE_FAILURE_PROOF === '1';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const dir = process.env.SSAM_DEBUG_O11_ASSET_DIR ?? path.join(evidence, 'proofs', 'o11-service-authenticated-chain', 'acquired', 'e662ebb3-16f8-43ca-b548-ee0fcba16a03');
const module = 'Headless_UI', moduleKey = 'Mif02PxcH0K7KiABEHTwMg', host = 'personal-2qqw9srv.outsystemscloud.com';
const runtimeUrl = 'https://' + host + '/' + module + '/', origin = 'https://' + host;
const USER = 'synthetic-user-ana', PASS = 'synthetic-pass-ó1';
const infoBytes = fs.readFileSync(path.join(dir, 'moduleinfo.json'));
const manifest = JSON.parse(infoBytes.toString('utf8'));
const names = fs.readdirSync(dir).filter(n => n.endsWith('.js') && manifest.manifest.urlVersions['/' + module + '/scripts/' + n]);
const pins = names.map(name => { const file = path.join(dir, name); return { name, path: file, sha256: sha(fs.readFileSync(file)),
  urlPath: '/' + module + '/scripts/' + name, query: manifest.manifest.urlVersions['/' + module + '/scripts/' + name] }; });
const parsed = parseO11Assets(pins.map(p => ({ name: p.name, text: fs.readFileSync(p.path, 'utf8') })), module);
const graph = buildO11CallGraph([graphFromAssets(parsed, { moduleKey })]);
const login = loginSpec(parsed, module);
const pin = (name, value) => { const file = path.join(root, name); const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  fs.writeFileSync(file, bytes); return { path: file, sha256: sha(bytes) }; };
const snapshot = pin('published-capture.oml', Buffer.from('synthetic stand-in for the published capture bytes'));
const target = { lane: 'o11', host, runtimeUrl, module, moduleKey, applicationKey: 'gNS4vvu930yjPSk9Y3awUg', publishedVersionId: manifest.manifest.versionSequence, sourceSha256: snapshot.sha256 };
const inventoryProof = pin('inventory.json', { host, capturedAtUtc: new Date().toISOString(), modules: [{ Name: module, Key: moduleKey, ApplicationKey: target.applicationKey,
  VersionId: target.publishedVersionId, IsActive: true }] });
const moduleInfo = pin('moduleinfo.json', infoBytes);
const appDefinition = appDefinitionOf(fs.readFileSync(path.join(dir, module + '.appDefinition.js'), 'utf8'));

// Fake origin: original assets by exact query, moduleinfo, roles, login and the entry endpoints (synthetic answers).
const posts = [];
const suspensionChecks = [];
const reply = (status, body, cookies = []) => ({ status, url: undefined, headers: new Headers({ 'content-type': 'application/json' }),
  body: null, arrayBuffer: async () => Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)), _cookies: cookies });
const fetchImpl = async (url, init) => {
  const u = new URL(url);
  let response;
  if (init.method === 'GET' && u.pathname === '/' + module + '/moduleservices/moduleinfo') response = reply(200, infoBytes.toString('utf8'));
  else if (init.method === 'GET' && u.pathname === '/' + module + '/moduleservices/roles') response = reply(200, { rolesInfo: ',synthetic-role-key,' });
  else if (init.method === 'GET' && u.pathname === '/' + module + '/moduleservices/checkrequestsuspended') {
    suspensionChecks.push({ tokenPresent: /^\d{1,16}$/.test(u.searchParams.get('requestToken') ?? '') });
    // The consumer can report false while a Service Action in a producer is
    // paused. Interactive lifetime must not depend on this being true.
    response = reply(200, !inspectionProof);
  }
  else if (init.method === 'GET') { const asset = pins.find(p => p.urlPath === u.pathname && p.query === u.search);
    response = asset ? reply(200, fs.readFileSync(asset.path)) : reply(404, ''); if (asset) response.arrayBuffer = async () => fs.readFileSync(asset.path); }
  else {
    const body = JSON.parse(init.body);
    posts.push({ path: u.pathname, keys: Object.keys(body).sort(), viewName: body.viewName, inputParameters: body.inputParameters ?? null, csrf: init.headers['X-CSRFToken'] });
    const ok = data => reply(200, { versionInfo: { hasModuleVersionChanged: false, hasApiVersionChanged: false }, data });
    if (u.pathname.endsWith('/ActionDoLogin')) response = body.inputParameters?.Username === USER && body.inputParameters?.Password === PASS
      ? ok({}) : reply(200, { versionInfo: {}, exception: { name: 'ServerException', message: 'Invalid' } });
    if (u.pathname.endsWith('/ActionDoLogin') && response.status === 200 && body.inputParameters?.Username === USER)
      response._cookies = ['nr2Users=' + encodeURIComponent('crf=SyntheticCsrf123=;uid=7;unm=' + USER) + '; Path=/; Secure; SameSite=Lax'];
    else if (u.pathname.endsWith('/ActionUser_GetUnifiedLoginUrl')) {
      response = body.inputParameters.ToolName === 'fail'
        ? reply(200, { versionInfo: { hasModuleVersionChanged: false, hasApiVersionChanged: false }, exception: { name: 'ServerException', specificType: 'Users.SyntheticFailure',
            message: 'synthetic server failure for ' + USER } })
        : ok({ Url: body.inputParameters.OriginalUrl + '#' + body.inputParameters.ToolName });
    } else if (u.pathname.endsWith('/DataActionGetUserNameFromServer')) {
      if (responseFailureProof) {
        response = reply(504, '<html>synthetic private gateway error ' + USER + '</html>');
        response.headers.getSetCookie = () => [];
        return response;
      }
      if (suspensionProof || inspectionProof) await new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new Error('synthetic request aborted')); };
        const timer = setTimeout(() => { init.signal.removeEventListener('abort', abort); resolve(); }, 12000);
        init.signal.addEventListener('abort', abort, { once: true });
      });
      response = ok({ UserName: 'Display Name of ' + USER });
    }
  }
  response.headers.getSetCookie = () => response._cookies;
  return response;
};

async function runEntry(label, entryId, scenarios) {
  const entry = entrySpec(graph, { entry: { id: entryId }, bindings: [] }, parsed, module);
  const contract = { schema: 'ssam-o11-native-entry-source/2', selector: label, target, ...appDefinition, applicationDefinition: module + '.appDefinition',
    snapshot, inventoryProof, moduleInfo, assets: contractAssets(parsed, pins, module, login, entry), login, entry };
  const sourceContract = pin(label + '-contract.json', contract);
  const sessionId = randomUUID().replaceAll('-', ''), directory = path.join(root, '.local', 'debugger', label);
  const submissions = [];
  const handle = await prepareOriginalO11Entry({ root, target, sourceContract, action: label, sessionId, timeoutSeconds: inspectionProof ? 5 : 20, directory },
    { fetchImpl, beforeRequest: async s => { submissions.push({ scenario: s.scenario, endpoint: s.endpoint, seq: s.seq }); } });
  const descriptor = { credentialRef: randomUUID(), binding: appUserBinding({ lane: 'o11', ...target }, sessionId), expiresAt: new Date(Date.now() + (inspectionProof ? 600000 : 120000)).toISOString() };
  const authenticated = await authenticateOriginalO11Entry(handle, descriptor, { vault: async (mode, safe) => ({ ok: true, kind: 'credentials', binding: safe.binding,
    expiresAt: safe.expiresAt, username: USER, password: PASS }) });
  if (inspectionProof) configureOriginalO11ServerInspection(handle, { expiresAt: new Date(Date.now() + 250000).toISOString() });
  const results = [];
  for (const scenario of scenarios) results.push((await invokeScenarioO11Entry(handle, scenario)).scenario);
  const receipt = await handle.dispose();
  const persisted = fs.readFileSync(path.join(directory, 'native-entry-receipt.json'), 'utf8');
  return { label, entryKind: entry.kind, viewName: entry.viewName ?? null, assets: contract.assets.length, authenticated: authenticated.authenticated,
    results, submissions, receipt: { memoryCleared: receipt.memoryCleared, nativeScreenPermissionsPassed: receipt.nativeScreenPermissionsPassed, requestSubmittedCount: receipt.requestSubmittedCount,
      requestAnsweredCount: receipt.requestAnsweredCount, requestUncertain: receipt.requestUncertain, scenarios: receipt.scenarios, diagnostics: receipt.diagnostics,
      ...(receipt.lastEntryResponse ? { lastEntryResponse: receipt.lastEntryResponse } : {}),
      ...(receipt.serverInspection ? { serverInspection: receipt.serverInspection } : {}) },
    leaks: [persisted, JSON.stringify(results)].some(text => text.includes(USER) || text.includes(PASS)) };
}

const out = [];
if (suspensionProof || inspectionProof || responseFailureProof) {
  out.push(await runEntry('suspension', moduleKey + '*qp8AovV7Y0iz+OhOM94Ccw', [{ name: 'suspended', values: {}, trace: 'none' }]));
  process.stdout.write(JSON.stringify({ out, posts, suspensionChecks }) + '\n');
} else {
const stub = graph.nodes.get([...graph.nodes.keys()].find(id => id === 'stub:' + moduleKey + ':Common.UserInfo:User_GetUnifiedLoginUrl')).id;
out.push(await runEntry('stub', stub, [
  { name: 'ok', values: { OriginalUrl: 'https://example.invalid/back', ToolName: 'Tool Ü' }, trace: 'none' },
  { name: 'server-exception', values: { OriginalUrl: '', ToolName: 'fail' }, trace: 'none' },
  { name: 'defaults', values: {}, trace: 'none' }]));
out.push(await runEntry('data', moduleKey + '*qp8AovV7Y0iz+OhOM94Ccw', [{ name: 'fetch', values: {}, trace: 'none' }]));
out.push(await runEntry('slugify', moduleKey + '*6JwZbhuDlEaqKBmGQNf6dg', [{ name: 'traced', values: { Text: 'Olá Mundo' }, trace: 'full' },
  { name: 'nodes-only', values: { Text: 'x' }, trace: 'nodes' }]));
// Original OnInitialize calls GetUsername through a JS proxy without returning the promise. The debugger must
// await that proxy and include only its GetUserNameFromServer endpoint, not prefetch the blocked debug DataAction.
out.push(await runEntry('lifecycle', moduleKey + '*Ra0cqNIQbkCP0C9mKy4plg', [{ name: 'initialize', values: {}, trace: 'nodes' }]));
process.stdout.write(JSON.stringify({ out, posts }) + '\n');
}
