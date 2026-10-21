// Live proof 2 of docs/PROVAS-AO-VIVO.md (docs/O11-BRIDGE-FINA.md 8.8 item 2): each verb of the thin O11 bridge once
// (answer_dependencies_dialog aside: it needs the dialog on screen), on the TEST CLIENT, through the agent's own
// connection record and key. sc_http (24th release) reads the Service Center status through the Studio's own session. A TypeLoadException,
// MissingMethodException or MissingFieldException only shows on the first JIT of a handler inside the real Service
// Studio; any other answer (success, or a refusal by the handler itself) proves the verb runs there. Only the owner
// runs it, with the Service Studio connected by the agent (ssam_connect {lane:"o11"}).
//   node scripts/prova-verbos.mjs --root C:\SSAM-Agent-Teste [--host <O11 environment host>] [--module <test module>] [--publish]
// Default: read-only calls. snapshot_module writes one OML under <root>\o11\prova (the agent's own folder);
// environment_session takes a read-only lease (connect, modules, close); merge_from_oml and close_dialog are sent with
// a candidate or a title that do not exist, so the handler runs and refuses before touching the model; refresh_references
// (ninth release) names a producer key no reference has, so the handler runs and refreshes nothing. Without --host
// the Service Center verbs (sc_api, sc_web, sc_http, studio_login) are skipped; studio_login runs only when sc_session says the
// Studio is already signed in on that host (otherwise it would open the sign-in dialog). --module <name> opens that
// module and closes it (open_module, close_module); --publish also runs 1-Click Publish of it (publish): both change the
// Studio, so they are opt-in and need a module the owner chose for the test.
// Prints one line per verb and a JSON summary; exits 0 only when every verb answered without a load error.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { bridgeRequest } from '../agent/lib/o11-wire.mjs';

export const VERBS = Object.freeze(['ping', 'bridge_manifest', 'get_active_module', 'list_open_modules', 'get_errors', 'open_module',
  'close_module', 'publish', 'windows', 'ui_alive', 'close_dialog', 'snapshot_module', 'merge_from_oml', 'merge_status',
  'environment_session', 'sc_api', 'sc_web', 'sc_http', 'studio_login', 'sc_session', 'publish_log', 'refresh_references']);
const LOAD_ERROR = /\b(TypeLoadException|MissingMethodException|MissingFieldException|FileNotFoundException: Could not load file or assembly|BadImageFormatException)\b/;

export function parseArgs(argv) {
  const options = { root: null, host: null, module: null, publish: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--publish') { options.publish = true; continue; }
    if (!['--root', '--host', '--module'].includes(flag)) throw new Error('Unknown option: ' + flag);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(flag + ' requires a value');
    options[flag.slice(2)] = value;
  }
  if (!options.root) throw new Error('Usage: node scripts/prova-verbos.mjs --root <agent folder> [--host <O11 host>] [--module <test module>] [--publish]');
  if (options.host && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(options.host)) throw new Error('--host is the environment DNS name, without a scheme or path');
  if (options.publish && !options.module) throw new Error('--publish requires --module <test module>');
  return options;
}

// The connection the agent recorded and its own key: the same port and authorization o11.bridge uses.
export function agentTarget(root) {
  const record = JSON.parse(fs.readFileSync(path.join(root, 'private', 'o11-connection.json'), 'utf8').replace(/^\uFEFF/, ''));
  const key = fs.readFileSync(path.join(root, 'private', 'authority', 'bridge.key'), 'utf8').trim();
  if (!Number.isInteger(record?.port) || !key) throw new Error('No agent O11 connection in ' + root + ' (run ssam_connect {lane:"o11"} first).');
  return { port: record.port, authorization: key, pid: record.pid };
}

// One verb: {verb, outcome: ok | refused | load-error | transport | skipped, detail}.
export function classify(verb, reply) {
  const text = JSON.stringify(reply ?? null);
  if (LOAD_ERROR.test(text)) return { verb, outcome: 'load-error', detail: String(reply?.error ?? text).slice(0, 300) };
  if (reply?.success === true) return { verb, outcome: 'ok', detail: '' };
  return { verb, outcome: 'refused', detail: String(reply?.error ?? reply?.data?.message ?? 'success:false').slice(0, 300) };
}

export async function run(options, { request = bridgeRequest, now = () => new Date() } = {}) {
  const target = agentTarget(options.root);
  const call = (method, params = {}) => request({ port: target.port, authorization: target.authorization }, method, params);
  const results = [];
  const step = async (verb, params) => {
    try { const reply = await call(verb, params); results.push(classify(verb, reply)); return reply; }
    catch (error) { results.push({ verb, outcome: 'transport', detail: (error.code ? error.code + ': ' : '') + error.message }); return null; }
  };
  const skip = (verb, why) => results.push({ verb, outcome: 'skipped', detail: why });
  const proofDir = path.join(options.root, 'o11', 'prova');
  fs.mkdirSync(proofDir, { recursive: true });

  await step('ping');
  await step('bridge_manifest');
  await step('get_active_module');
  await step('list_open_modules');
  await step('get_errors', { max: 5 });
  await step('windows', { max_texts: 5 });
  await step('ui_alive', { timeout_ms: 1000 });
  await step('close_dialog', { title: 'SSAM prova inexistente ' + randomUUID() });
  await step('snapshot_module', { path: path.join(proofDir, 'verbos-' + now().toISOString().replace(/[:.]/g, '-') + '.oml') });
  await step('merge_status', { operation_id: randomUUID() });
  await step('merge_from_oml', { foreign_path: path.join(proofDir, 'nao-existe-' + randomUUID() + '.oml'), mode: 'preview' });
  const lease = await step('environment_session', { operation: 'connect', readOnly: true });
  const leaseId = lease?.success === true ? lease.data?.lease : null;
  if (leaseId) {
    await call('environment_session', { operation: 'modules', lease: leaseId, arguments: {} }).catch(() => null);
    await call('environment_session', { operation: 'close', lease: leaseId }).catch(() => null);
  }
  const session = await step('sc_session', options.host ? { host: options.host } : {});
  if (options.host) {
    await step('sc_api', { host: options.host, surface: 'soap', operation: 'ListEspaces', args: {} });
    await step('sc_web', { host: options.host, action: 'status' });
    await step('sc_http', { host: options.host, action: 'status' });
    if (session?.success === true && session.data?.studio?.signedIn === true) await step('studio_login', { host: options.host, waitMs: 0 });
    else skip('studio_login', 'the Studio is not signed in on ' + options.host + ': studio_login would open the sign-in dialog');
  } else for (const verb of ['sc_api', 'sc_web', 'sc_http', 'studio_login']) skip(verb, 'no --host');
  await step('publish_log', { max: 5 });
  await step('refresh_references', { producer_keys: ['ssam-prova-inexistente-' + randomUUID()], timeout: 10 });
  if (options.module) {
    await step('open_module', { name: options.module, timeout: 120 });
    if (options.publish) await step('publish', { message: 'SSAM prova ao vivo (verbos da bridge fina)' });
    else skip('publish', 'no --publish (1-Click Publish changes the environment)');
    await step('close_module', {});
  } else for (const verb of ['open_module', 'publish', 'close_module']) skip(verb, 'no --module (opens, publishes and closes a test module)');

  const order = new Map(VERBS.map((verb, i) => [verb, i]));
  results.sort((a, b) => order.get(a.verb) - order.get(b.verb));
  const summary = { pid: target.pid, port: target.port, total: results.length,
    ok: results.filter(r => r.outcome === 'ok').length, refused: results.filter(r => r.outcome === 'refused').length,
    skipped: results.filter(r => r.outcome === 'skipped').map(r => r.verb),
    loadErrors: results.filter(r => r.outcome === 'load-error').map(r => r.verb),
    transport: results.filter(r => r.outcome === 'transport').map(r => r.verb) };
  return { results, summary, passed: summary.loadErrors.length === 0 && summary.transport.length === 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  (async () => {
    const { results, summary, passed } = await run(parseArgs(process.argv.slice(2)));
    for (const r of results) console.log(r.verb.padEnd(20) + r.outcome.padEnd(11) + r.detail);
    console.log(JSON.stringify(summary));
    process.exitCode = passed ? 0 : 1;
  })().catch(error => { console.error(error.message); process.exitCode = 2; });
}
