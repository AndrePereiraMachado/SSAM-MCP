// scripts/tunel.mjs (the owner's quick tunnel, docs/FASE2-AGENTE.md 9.1): argument handling, the exact commands, the URL
// read from cloudflared's log, the client configuration with a token placeholder, and start/stop/status over fakes.
// Nothing here starts a server, a tunnel or any process: every effect goes through the fake deps.
import '../platforms/odc/facade/tests/fixtures/isolated-profile.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TunnelError, clientConfig, main, parseArgs, parseTunnelUrl, plan, publicUrl, validPort } from '../scripts/tunel.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = 'C:\\fake\\server';
const CLOUDFLARED = 'C:\\tools\\cloudflared.exe';
const LOG = path.join(DIR, 'tunnel.log');
const URL = 'https://brave-otter-fluent-sky.trycloudflare.com';
const SAMPLE_LOG = [
  '2026-10-05T20:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...',
  '2026-10-05T20:00:01Z INF +--------------------------------------------------------------------------------------------+',
  '2026-10-05T20:00:01Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |',
  `2026-10-05T20:00:01Z INF |  ${URL}                                         |`,
  '2026-10-05T20:00:01Z INF +--------------------------------------------------------------------------------------------+',
].join('\n');

// Fake effects: a file map, process table, recorded runs, spawns and kills, and a clock that advances on sleep.
function fakeDeps({ files = {}, processes = {}, run = () => ({ code: 0, out: 'Servidor no ar: pid 900, http://127.0.0.1:7300/mcp.' }), onSpawn = () => {} } = {}) {
  const state = { files: { ...files }, processes: { ...processes }, runs: [], spawns: [], kills: [], clock: 1_000_000 };
  const deps = {
    env: { SSAM_SERVER_DIR: DIR },
    run: (file, args) => { state.runs.push([file, ...args]); return run(file, args, state); },
    processInfo: pid => state.processes[pid] ?? null,
    spawnDetached: (file, args) => { state.spawns.push([file, ...args]); const pid = 4242; state.processes[pid] = { name: 'cloudflared.exe', commandLine: [file, ...args].join(' ') }; onSpawn(state); return pid; },
    kill: pid => { state.kills.push(pid); delete state.processes[pid]; },
    which: () => null,
    exists: file => file === CLOUDFLARED || Object.hasOwn(state.files, file),
    readText: file => state.files[file] ?? '',
    writeJson: (file, value) => { state.files[file] = JSON.stringify(value); },
    readJson: file => (Object.hasOwn(state.files, file) ? JSON.parse(state.files[file]) : null),
    remove: file => { delete state.files[file]; },
    sleep: async ms => { state.clock += ms; },
    now: () => state.clock,
  };
  return { deps, state };
}
const hostedServer = (port = 7300, extra = '') => ({ [path.join(DIR, 'server.json')]: JSON.stringify({ pid: 900, port, startedAt: 'x' }) });
const hostedProcess = (extra = '') => ({ 900: { name: 'node.exe', commandLine: `node.exe "${repo}\\facade\\ssam.mjs" serve --port 7300 --log-file "${DIR}\\server.log"${extra}` } });
async function runMain(argv, deps) {
  const lines = [];
  try { return { code: await main(argv, deps, line => lines.push(line)), out: lines.join('\n') }; }
  catch (error) { return { error, out: lines.join('\n') }; }
}

test('arguments: actions, ports, flags and the public URL are checked before anything runs', () => {
  assert.deepEqual(parseArgs(['start']), { action: 'start', port: 7300, cloudflared: null, url: null, server: false });
  assert.deepEqual(parseArgs(['start', '--port', '7310', '--cloudflared', CLOUDFLARED]), { action: 'start', port: 7310, cloudflared: CLOUDFLARED, url: null, server: false });
  assert.equal(parseArgs(['stop', '--server']).server, true);
  for (const bad of [[], ['open'], ['start', '--host', '0.0.0.0'], ['start', '--port'], ['start', '--port', '--cloudflared'], ['stop', '--port', '7300'],
    ['status', '--url', URL], ['config', '--server'], ['start', '--allow-remote']]) {
    assert.throws(() => parseArgs(bad), error => error instanceof TunnelError && error.exitCode === 2, JSON.stringify(bad));
  }
  for (const port of ['80', '1023', '65536', 'abc', '7300.5', '-1', '']) assert.throws(() => validPort(port), TunnelError, port);
  assert.equal(validPort('1024'), 1024); assert.equal(validPort(65535), 65535);
  assert.equal(publicUrl(URL + '/'), URL);
  for (const url of ['http://x.trycloudflare.com', URL + '/mcp', URL + ':8443', 'https://user:pw@x.example', URL + '?a=1', 'not a url'])
    assert.throws(() => publicUrl(url), TunnelError, url);
});

test('plan: the server through servidor.ps1 and the quick tunnel of the docs, always in front of 127.0.0.1', () => {
  const commands = plan({ port: 7311, cloudflared: CLOUDFLARED, dir: DIR });
  assert.deepEqual(commands.server, { file: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repo, 'scripts', 'servidor.ps1'), 'start', '-Port', '7311'] });
  assert.deepEqual(commands.tunnel, { file: CLOUDFLARED, args: ['tunnel', '--url', 'http://127.0.0.1:7311', '--http-host-header', '127.0.0.1:7311', '--no-autoupdate', '--logfile', LOG] });
  assert.equal(commands.stateFile, path.join(DIR, 'tunnel.json'));
});

test('the URL comes from cloudflared\'s log; the API host is not the tunnel', () => {
  assert.equal(parseTunnelUrl(SAMPLE_LOG), URL);
  assert.equal(parseTunnelUrl('INF Requesting new quick Tunnel on https://api.trycloudflare.com/tunnel'), null);
  assert.equal(parseTunnelUrl(''), null);
  assert.equal(parseTunnelUrl('https://BRAVE-otter.trycloudflare.com'), 'https://brave-otter.trycloudflare.com');
});

test('client configuration: the MCP URL and the agent setup, with the token only as a placeholder', () => {
  const config = clientConfig(URL);
  assert.equal(config.mcpUrl, URL + '/mcp');
  assert.deepEqual(config.mcpJson, { mcpServers: { ssam: { type: 'http', url: URL + '/mcp', headers: { Authorization: 'Bearer ${SSAM_TOKEN}' } } } });
  assert.match(config.claudeCli, /--header "Authorization: Bearer \$env:SSAM_TOKEN"$/);
  assert.match(config.agentSetup, new RegExp('setup --server ' + URL.replace(/\./g, '\\.') + ' --root C:\\\\SSAM-Agent$'));
  assert.doesNotMatch(JSON.stringify(config), /ssam_[A-Za-z0-9]{8}|ssam_agent_/, 'never a token or an agent credential');
});

test('start: hosted server first, then cloudflared detached; the URL and the configuration are printed and recorded', async () => {
  const { deps, state } = fakeDeps({ files: hostedServer(), processes: hostedProcess(),
    onSpawn: s => { s.files[LOG] = 'INF Requesting new quick Tunnel on trycloudflare.com...'; } });
  // The URL appears in the log only after a few polls.
  let polls = 0;
  const readText = deps.readText;
  deps.readText = file => (file === LOG && ++polls >= 3 ? SAMPLE_LOG : readText(file));
  const result = await runMain(['start', '--cloudflared', CLOUDFLARED], deps);
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.code, 0);
  assert.deepEqual(state.runs, [['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repo, 'scripts', 'servidor.ps1'), 'start', '-Port', '7300']]);
  assert.deepEqual(state.spawns, [[CLOUDFLARED, 'tunnel', '--url', 'http://127.0.0.1:7300', '--http-host-header', '127.0.0.1:7300', '--no-autoupdate', '--logfile', LOG]]);
  const record = JSON.parse(state.files[path.join(DIR, 'tunnel.json')]);
  assert.equal(record.pid, 4242); assert.equal(record.port, 7300); assert.equal(record.url, URL); assert.equal(record.cloudflared, CLOUDFLARED);
  assert.match(result.out, /URL publica: https:\/\/brave-otter-fluent-sky\.trycloudflare\.com/);
  assert.ok(result.out.includes('"Authorization":"Bearer ${SSAM_TOKEN}"'), result.out);
  assert.doesNotMatch(result.out, /ssam_[A-Za-z0-9]{8}/);

  // Again: the running tunnel is reported, nothing else starts.
  const again = await runMain(['start', '--cloudflared', CLOUDFLARED], deps);
  assert.equal(again.code, 0); assert.match(again.out, /ja esta no ar: pid 4242/);
  assert.equal(state.spawns.length, 1); assert.equal(state.runs.length, 1);
  // Another port while it runs: refused.
  assert.match((await runMain(['start', '--port', '7310', '--cloudflared', CLOUDFLARED], deps)).error.message, /Ja ha um tunel na porta 7300/);

  // status and config read the record; stop kills only that cloudflared.
  const status = await runMain(['status'], deps);
  assert.equal(status.code, 0); assert.match(status.out, /Tunel: pid 4242, porta 7300, https:\/\/brave-otter/);
  const config = await runMain(['config'], deps);
  assert.match(config.out, /"url":"https:\/\/brave-otter-fluent-sky\.trycloudflare\.com\/mcp"/);
  const stopped = await runMain(['stop'], deps);
  assert.equal(stopped.code, 0); assert.deepEqual(state.kills, [4242]);
  assert.equal(state.files[path.join(DIR, 'tunnel.json')], undefined);
  assert.equal((await runMain(['status'], deps)).code, 3);
});

test('start refuses a --local-studios server, a server on another port, a failed server start and a missing cloudflared', async () => {
  const local = fakeDeps({ files: hostedServer(), processes: hostedProcess(' --local-studios') });
  const refusedLocal = await runMain(['start', '--cloudflared', CLOUDFLARED], local.deps);
  assert.match(refusedLocal.error.message, /--local-studios .*nunca o exponha por tunel/);
  assert.equal(local.state.spawns.length, 0, 'no tunnel in front of the owner\'s own Studios');

  const other = fakeDeps({ files: hostedServer(7400), processes: hostedProcess() });
  assert.match((await runMain(['start', '--cloudflared', CLOUDFLARED], other.deps)).error.message, /Nenhum servidor hospedado do servidor\.ps1 na porta 7300/);
  assert.equal(other.state.spawns.length, 0);

  const notSsam = fakeDeps({ files: hostedServer(), processes: { 900: { name: 'node.exe', commandLine: 'node other.js' } } });
  assert.match((await runMain(['start', '--cloudflared', CLOUDFLARED], notSsam.deps)).error.message, /nao e o servidor do ssam/);

  const failed = fakeDeps({ run: () => ({ code: 1, out: 'Porta 7300 ocupada por outro processo (pid 77).' }) });
  const refusedFailed = await runMain(['start', '--cloudflared', CLOUDFLARED], failed.deps);
  assert.match(refusedFailed.error.message, /O servidor hospedado nao subiu.*ocupada por outro processo/);
  assert.equal(failed.state.spawns.length, 0);

  const none = fakeDeps({ files: hostedServer(), processes: hostedProcess() });
  assert.match((await runMain(['start'], none.deps)).error.message, /cloudflared nao encontrado.*nunca baixa nada/);
  assert.match((await runMain(['start', '--cloudflared', 'C:\\nope\\cloudflared.exe'], none.deps)).error.message, /cloudflared nao existe/);
  assert.equal(none.state.runs.length, 0, 'nothing ran before cloudflared was found');
});

test('start gives up when cloudflared shows no URL, stops it and keeps no record; stop never kills a reused pid', async () => {
  const { deps, state } = fakeDeps({ files: hostedServer(), processes: hostedProcess() });
  const result = await runMain(['start', '--cloudflared', CLOUDFLARED], deps);
  assert.match(result.error.message, /nao mostrou a URL publica em 45 s/);
  assert.deepEqual(state.kills, [4242]);
  assert.equal(state.files[path.join(DIR, 'tunnel.json')], undefined);

  // A record whose pid now belongs to another program: stale, removed, nothing killed.
  const stale = fakeDeps({ files: { [path.join(DIR, 'tunnel.json')]: JSON.stringify({ pid: 31, port: 7300, url: URL }) }, processes: { 31: { name: 'notepad.exe', commandLine: 'notepad' } } });
  const stopped = await runMain(['stop'], stale.deps);
  assert.equal(stopped.code, 0); assert.match(stopped.out, /ja estava parado/);
  assert.deepEqual(stale.state.kills, []);
  assert.equal(stale.state.files[path.join(DIR, 'tunnel.json')], undefined);
  // config without a record or --url: refused; with --url: placeholder only.
  assert.match((await runMain(['config'], stale.deps)).error.message, /Nenhuma URL/);
  assert.match((await runMain(['config', '--url', URL], stale.deps)).out, /Bearer \$\{SSAM_TOKEN\}/);
  // plan runs nothing.
  const planned = fakeDeps();
  const shown = await runMain(['plan', '--port', '7320', '--cloudflared', CLOUDFLARED], planned.deps);
  assert.equal(shown.code, 0);
  assert.equal(JSON.parse(shown.out).tunnel.args[2], 'http://127.0.0.1:7320');
  assert.deepEqual([planned.state.runs, planned.state.spawns, planned.state.kills], [[], [], []]);
});
