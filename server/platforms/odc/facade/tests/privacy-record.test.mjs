// The customer's privacy section (docs/AGENTE-CLIENTE.md "Privacidade") against what the hosted server REALLY records
// (privacy re-check of 2026-10-12, low findings: a few statements did not match the record, and a tool name typed by the
// client reached the audit and server.log as typed). A real hosted HTTP server with the hub, the token store, a real MCP
// client and a fake agent speaking ssam-agent/1 runs one session; then every field of every line it wrote is tied to the
// words of the section that describe it:
//   - the audit line (audit-YYYYMMDD.jsonl), every server.log event about the customer (session, calls, the agent's
//     connection, its calls and its channel), machine-pins.json and access-alerts.jsonl: a field without words fails
//     ("a field the privacy section does not describe yet"), and so does an event of http-server.mjs or agent-hub.mjs whose
//     name is not classified here;
//   - the Hello fields the agent sends and the server keeps only in memory (agent folder, Node version, platform, start
//     time, kinds, package, installed Studios): the section names them, and none reaches a file of the server folder;
//   - a tool name outside the hosted catalog is '?' in the audit and in server.log, never as typed;
//   - retention: the log's 56 days depend on the weekly rotation; the first machine and the alerts have no deadline.
// The quality record's own fields are tied by quality-privacy-doc.test.mjs. In the SSAM-MCP server box the guide lives in the
// agent box (../agent/docs); without either copy the section checks skip and the record checks still run.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startHttpServer, toolNameOf } from '../http-server.mjs';
import { createTokenStore } from '../server-tokens.mjs';

const facade = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(facade, '..', '..', '..');
const GUIDE = [path.join(ROOT, 'docs', 'AGENTE-CLIENTE.md'), path.join(ROOT, '..', 'agent', 'docs', 'AGENTE-CLIENTE.md')].find(f => fs.existsSync(f));
const sectionOf = text => {
  const t = text.replace(/\r\n/g, '\n');
  const start = t.indexOf('## Privacidade: o que o servidor registra sobre o seu acesso\n');
  const end = t.indexOf('\n## ', start + 1);
  assert.ok(start >= 0, 'the privacy section');
  return t.slice(start, end < 0 ? undefined : end).replace(/\s+/g, ' ');
};
const catalog = JSON.parse(fs.readFileSync(path.join(facade, 'hosted', 'tools.json'), 'utf8')).tools;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-privacy-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// ---- the words of each recorded field
const LOG_LINE = { time: /em cada linha, a hora/, event: /em cada linha, a hora, o evento/, token: /e o identificador do seu acesso/ };
const SESSION = { ...LOG_LINE, session: /o número da sessão MCP/, customer: /o nome que o dono deu ao seu acesso/, ip: /o IP de onde você conecta/,
  ua: /e o user-agent/, client: /o nome e a versão do cliente MCP/, reason: /Quando a sessão fecha, o motivo/ };
const AGENT_CONNECTED = { ...LOG_LINE, agent: /Quando o agente conecta:\*\* o IP, a versão do agente/, ip: /Quando o agente conecta:\*\* o IP/,
  'machine.name': /o nome do computador/, 'machine.user': /o seu usuário do Windows/, 'machine.id': /um identificador da máquina/,
  'o11.pid': /o número do processo/, 'o11.port': /a porta local/, 'o11.studioVersion': /Com o Service Studio ligado ao agente, também a versão/,
  'o11.startedUtc': /a hora em que ele abriu/ };
const MACHINE = { id: /Na primeira conexão do agente, o servidor guarda o nome do computador, o seu usuário do Windows, o identificador/,
  name: /o servidor guarda o nome do computador/, user: /o servidor guarda o nome do computador, o seu usuário do Windows/,
  at: /o identificador, a hora e o IP/ };
const ALERT = { time: /o dono recebe um alerta com a hora/, event: /o dono recebe um alerta/, token: /e o identificador do seu acesso/,
  customer: /um alerta com a hora, o nome do seu acesso/, ip: /as duas máquinas e o IP/,
  ...Object.fromEntries(Object.entries(MACHINE).flatMap(([k, v]) => [['first.' + k, v], ['machine.' + k, /as duas máquinas/]])) };
const CHANNEL = { ...LOG_LINE, reason: /quando ele conecta, cai ou volta, com o motivo/, route: /um pedido recusado/, status: /um pedido recusado/,
  code: /com o código, o tipo e quantos/, type: /uma mensagem desconhecida, um arquivo que chegou diferente ou expirou\), com o código, o tipo/,
  transfer: /um arquivo que chegou diferente/, count: /com o código, o tipo e quantos/, kind: /Numa chamada ao agente, o tipo/, afterMs: /o tempo, se deu certo/,
  bytes: /Uma parte de arquivo que demora para subir fica com o tamanho/, ms: /fica com o tamanho, o tempo/, via: /e o IP sem o último número/ };
// server.log: the events of http-server.mjs and agent-hub.mjs. null = about the server only (no field of the customer).
const LOG = {
  'session-opened': SESSION, 'session-closed': SESSION,
  'mcp-response-flushed': { ...LOG_LINE, session: /o número da sessão MCP/, tools: /as ferramentas \(só as da lista do servidor; outro nome vira `\?`\)/,
    bytes: /o tamanho da resposta/, ms: /o tamanho da resposta e o tempo/ },
  'agent-connected': AGENT_CONNECTED, 'agent-resumed': AGENT_CONNECTED,
  'agent-machine-pinned': { ...LOG_LINE, ip: /o identificador, a hora e o IP/, ...Object.fromEntries(Object.entries(MACHINE).map(([k, v]) => ['machine.' + k, v])) },
  'agent-machine-changed': ALERT,
  'agent-call': { ...LOG_LINE, kind: /Numa chamada ao agente, o tipo/, command: /o comando \(só da lista do agente\)/, method: /o comando \(só da lista do agente\)/,
    operation: /o comando \(só da lista do agente\)/, ms: /o comando \(só da lista do agente\), o tempo/, ok: /o tempo, se deu certo/, code: /e o código do resultado/ },
  'agent-call-unaccepted': CHANNEL, 'agent-channel-closed': CHANNEL, 'agent-dead': CHANNEL, 'agent-replaced': CHANNEL, 'agent-stream-opened': CHANNEL,
  'agent-route-refused': CHANNEL, 'agent-blob-mismatch': CHANNEL, 'agent-transfers-expired': CHANNEL, 'agent-unknown-id': CHANNEL,
  'agent-unknown-message': CHANNEL, 'agent-upload-slow': CHANNEL,
  listening: null, 'tokens-unreadable': null, 'request-failed': null, 'audit-failed': null,
};
const AUDIT = { time: /Em toda linha:\*\* a hora/, token: /Em toda linha:\*\* a hora, o identificador do seu acesso/, customer: /o nome que o dono deu a ele/,
  tool: /A chamada:\*\* a ferramenta \(só da lista de ferramentas do servidor; outro nome vira `\?`\)/, ms: /a duração/, ok: /se deu certo/, error: /o código; o passo/ };
// The Hello fields kept only in memory (agent-hub.mjs state.hello), with their words.
const HELLO_MEMORY = { 'agent.root': /a pasta onde ele está \(ela costuma ter o seu usuário do Windows\)/, 'agent.node': /a versão do Node/,
  'agent.platform': /o sistema/, 'agent.startedAt': /a hora em que o agente abriu/, 'agent.kinds': /o que ele sabe fazer/, pack: /o pacote instalado/,
  studios: /a pasta e a versão de cada Studio instalado/ };

const flat = (value, prefix = '') => Object.entries(value ?? {}).flatMap(([k, v]) =>
  v && typeof v === 'object' && !Array.isArray(v) ? flat(v, prefix + k + '.') : [prefix + k]);
const readLines = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];

// ---- the run
const SENTINEL = { root: 'C:\\AgentRootQz9', node: 'v99.0.0-qz9', studioDir: 'C:\\StudiosQz9\\ODC', pack: 'pack-qz9', typed: 'GetFolhaPagamentoQz9' };
let run = null;
async function runSession() {
  if (run) return run;
  const dir = fs.mkdtempSync(path.join(tmp, 'dir'));
  process.env.SSAM_ACCESS_NOTIFY = '0';
  const createServer = async () => {
    const server = new McpServer({ name: 'privacy', version: '1.0.0' });
    server.registerTool('ssam_doctor', { description: 'doctor' }, async () => ({ content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true } }));
    return server;
  };
  const handle = await startHttpServer({ createServer, dir, port: 0, logFile: path.join(dir, 'server.log'), tools: Object.keys(catalog),
    agents: { kernel: { o11: '11.55.92', odc: '1.7.28', odcBridge: 'v97' }, limits: { sweepMs: 50, callTimeoutMs: 400, acceptMs: 200, reconnectGraceMs: 100, reconnectWaitMs: 100 } } });
  const base = handle.url.replace(/\/mcp$/, '');
  const store = createTokenStore(dir);
  const t = store.issue({ customer: 'Cliente Privacidade', lanes: ['odc', 'o11'] });
  try {
    // the MCP session: a catalog tool and a typed one
    const transport = new StreamableHTTPClientTransport(new URL(handle.url), { requestInit: { headers: { authorization: 'Bearer ' + t.token, 'x-forwarded-for': '203.0.113.9', 'user-agent': 'privacy-test/1' } } });
    const client = new Client({ name: 'privacy-client', version: '1.2.3' });
    await client.connect(transport);
    await client.callTool({ name: 'ssam_doctor', arguments: {} });
    await client.callTool({ name: SENTINEL.typed, arguments: {} }).catch(() => null);
    await client.close();
    // the agent: Hello with every field, a second machine, a stream and a call that is never accepted
    const hello = (machine) => ({ t: 'hello', protocol: 'ssam-agent/1', instance: randomUUID(),
      agent: { version: '0.3.1', node: SENTINEL.node, platform: 'win32', startedAt: new Date().toISOString(), root: SENTINEL.root,
        kinds: ['studio.processes', 'odc.pipe', 'o11.bridge', 'file.get'], machine },
      pack: { id: SENTINEL.pack, lanes: ['odc', 'o11'], odcBridge: 'v97', o11BuiltFor: '11.55.92.65269', o11Hook: 'dev' },
      studios: { odc: { installed: { dir: SENTINEL.studioDir, version: '1.7.28.10850' } }, o11: { installed: { dir: SENTINEL.studioDir + '11', version: '11.55.92.65269' } } },
      o11Connection: { pid: 4242, startedUtc: '2026-10-12T10:00:00.000Z', port: 4516, studioVersion: '11.55.92.65269' } });
    const post = (route, body) => fetch(base + '/agent/v1/' + route, { method: 'POST', headers: { authorization: 'Bearer ' + t.agentCredential, 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' }, body: JSON.stringify(body) });
    const first = await (await post('hello', hello({ id: 'aaaa0000', name: 'PC-PRIVACIDADE', user: 'usuario.windows' }))).json();
    assert.equal(first.t, 'welcome');
    const welcome = await (await post('hello', hello({ id: 'bbbb1111', name: 'PC-OUTRO', user: 'outro.usuario' }))).json();
    const stream = await fetch(base + '/agent/v1/stream?channel=' + welcome.channel, { headers: { authorization: 'Bearer ' + t.agentCredential } });
    const link = handle.hub.link(t.id);
    await link.call('odc.pipe', { pid: 1, version: 'v97', args: ['status'] }, { timeoutMs: 400 }).catch(() => null);
    await fetch(base + '/agent/v1/stream?channel=' + 'f'.repeat(32), { headers: { authorization: 'Bearer ' + t.agentCredential } }).then(r => r.text());
    stream.body?.cancel().catch(() => {});
  } finally { await handle.close(); }
  const files = fs.readdirSync(dir);
  run = { dir, files, audit: files.filter(f => /^audit-\d{8}\.jsonl$/.test(f)).flatMap(f => readLines(path.join(dir, f))),
    log: readLines(path.join(dir, 'server.log')), pins: JSON.parse(fs.readFileSync(path.join(dir, 'machine-pins.json'), 'utf8')),
    alerts: readLines(path.join(dir, 'access-alerts.jsonl')), tokenId: t.id };
  return run;
}

test('a tool name outside the hosted catalog is ? in the audit and in server.log, never as typed', async () => {
  const r = await runSession();
  assert.deepEqual(r.audit.map(a => a.tool).sort(), ['?', 'ssam_doctor']);
  const flushed = r.log.filter(e => e.event === 'mcp-response-flushed').flatMap(e => e.tools);
  assert.ok(flushed.includes('?') && flushed.includes('ssam_doctor'), JSON.stringify(flushed));
  for (const f of r.files) if (fs.statSync(path.join(r.dir, f)).isFile()) assert.equal(fs.readFileSync(path.join(r.dir, f), 'utf8').includes(SENTINEL.typed), false, f);
  assert.equal(toolNameOf('ssam_doctor', new Set(['ssam_doctor'])), 'ssam_doctor');
  assert.equal(toolNameOf(SENTINEL.typed, new Set(['ssam_doctor'])), '?');
  assert.equal(toolNameOf(SENTINEL.typed), SENTINEL.typed, 'without a catalog (--local-studios) the shape check stays');
});

test('the Hello fields kept only in memory never reach a file of the server folder', async () => {
  const r = await runSession();
  for (const f of r.files) {
    const file = path.join(r.dir, f);
    if (!fs.statSync(file).isFile()) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const [name, value] of Object.entries(SENTINEL)) if (name !== 'typed') assert.equal(text.includes(JSON.stringify(value).slice(1, -1)), false, name + ' in ' + f);
  }
});

test('every field the hosted server records about the customer has its words in the privacy section', { skip: !GUIDE && 'docs/AGENTE-CLIENTE.md is in the agent box' }, async () => {
  const section = sectionOf(fs.readFileSync(GUIDE, 'utf8'));
  const r = await runSession();
  const tie = (where, words, fields) => {
    for (const field of fields) {
      assert.ok(Object.hasOwn(words, field), `a field the privacy section does not describe yet: ${where} ${field}`);
      assert.match(section, words[field], `${where} ${field}`);
    }
  };
  assert.ok(r.audit.length >= 2, 'audit lines');
  for (const line of r.audit) tie('audit', AUDIT, flat(line));
  const seen = new Set();
  for (const event of r.log) {
    assert.ok(Object.hasOwn(LOG, event.event), 'a server.log event not classified by this test: ' + event.event);
    seen.add(event.event);
    if (LOG[event.event] === null) continue;
    // agent-connected keeps the O11 connection as a JSON text (agent-hub.mjs): its fields are read from it
    const fields = flat({ ...event, o11: typeof event.o11 === 'string' ? JSON.parse(event.o11) : event.o11 ?? undefined });
    tie('server.log ' + event.event, LOG[event.event], fields.filter(f => !(f === 'o11' && event.o11 == null)));
  }
  for (const name of ['session-opened', 'session-closed', 'mcp-response-flushed', 'agent-connected', 'agent-machine-pinned', 'agent-machine-changed', 'agent-call', 'agent-route-refused'])
    assert.ok(seen.has(name), 'the run produced ' + name);
  for (const pin of Object.values(r.pins)) tie('machine-pins.json', MACHINE, flat(pin));
  assert.ok(r.alerts.length === 1);
  for (const alert of r.alerts) tie('access-alerts.jsonl', ALERT, flat(alert));
  for (const words of Object.values(HELLO_MEMORY)) assert.match(section, words);
  assert.match(section, /O servidor usa esses dados só na memória, para conferir as versões e para o `ssam_doctor`\. Eles não vão para o log, para a auditoria nem para o registro de qualidade\./);
});

test('every server.log event of http-server.mjs and agent-hub.mjs is classified by this test', () => {
  for (const file of ['http-server.mjs', 'agent-hub.mjs']) {
    const source = fs.readFileSync(path.join(facade, file), 'utf8');
    const names = new Set([...source.matchAll(/event: '([a-z0-9-]+)'/g)].map(m => m[1]));
    if (file === 'agent-hub.mjs') { names.add('agent-connected'); names.add('agent-resumed'); }
    for (const name of names) assert.ok(Object.hasOwn(LOG, name), file + ' logs ' + name + ', which this test does not classify');
  }
});

test('the retention words: the 56 days of the log need the weekly rotation; the first machine and the alerts have no deadline', { skip: !GUIDE && 'docs/AGENTE-CLIENTE.md is in the agent box' }, () => {
  const section = sectionOf(fs.readFileSync(GUIDE, 'utf8'));
  assert.match(section, /Os 56 dias valem com a limpeza semanal do servidor ligada; sem ela, o log fica até o dono apagá-lo\./);
  assert.match(section, /O registro da primeira máquina e os alertas de outra máquina não têm prazo: ficam até o dono apagá-los\./);
  assert.doesNotMatch(section, /Nada além disso sobre a sua máquina é enviado: nenhum arquivo,/, 'the agent sends the files of its folder');
});

test('the agent and session events keep the shape the owner console parses (telemetry adds event names only)', async () => {
  const r = await runSession();
  const keys = name => r.log.filter(e => e.event === name).map(e => Object.keys(e).filter(k => k !== 'time').sort().join(','));
  for (const k of keys('agent-connected')) assert.equal(k, 'agent,event,ip,machine,o11,token');
  for (const k of keys('session-opened')) assert.equal(k, 'client,customer,event,ip,session,token,ua');
  for (const k of keys('mcp-response-flushed')) assert.equal(k, 'bytes,event,ms,session,token,tools');
  // agent-call: kind, ms, ok and code as at a415531d; the verb only from closed lists (method/operation, and command since the quality line)
  for (const e of r.log.filter(e => e.event === 'agent-call'))
    for (const k of Object.keys(e)) assert.ok(['time', 'event', 'token', 'kind', 'command', 'method', 'operation', 'ms', 'ok', 'code'].includes(k), 'agent-call ' + k);
});
