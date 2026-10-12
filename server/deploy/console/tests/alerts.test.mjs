// DESIGN section 5 and 7.2 "alerts": each rule fires at its threshold and not one step below; the production acceptance
// set from a host.json fixture built from today's production facts; hysteresis (2 false evaluations), acks (24 h,
// 7 dias, visto), a critical alert cannot be silenced for 7 days, aquecimento-parcial vs nao-aquecido.
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRules } from '../alert-rules.mjs';
import { createAlerts } from '../alerts.mjs';
import { createState } from '../state.mjs';
import { createTz } from '../tz.mjs';
import { QUOTA_BYTES } from '../workspaces.mjs';
import { HOST_PROD, KERNEL_JSON, clock, makeEnv, startConsole, tempDir, writeHost } from './helpers.mjs';

const tz = createTz('America/Sao_Paulo');
const NOW = Date.parse('2026-10-12T15:00:00Z');   // 12:00 in America/Sao_Paulo
const MIN = 60000, HOUR = 3600000, DAY = 86400000, MIB = 1024 * 1024;
const iso = ms => new Date(ms).toISOString();
const A = 'tok_0000000a1fa0';

function doc(mutate) {
  const d = structuredClone(HOST_PROD);
  d.collectedAt = iso(NOW - 10000);
  mutate?.(d);
  return d;
}
const srv = d => d.docker.containers.find(c => c.service === 'ssam-server');
function ctx(over = {}) {
  return { now: NOW, tz, licenses: [], licensesError: null, tokensUnreadableAt: null, nameOf: t => (t === A ? 'Cliente Alfa' : null),
    sessionsByToken: {}, maxSessions: 8, calls15: { calls: 0, failures: 0, topCode: null, topTool: null }, agentFailures15: [], serverErrors: [],
    serverLogB: 7000, hostStatus: 'ok', hostSchema: 'ssam-console-host/1', doc: doc(), facts: { samples: [], restarts: {}, probeFails: 0 },
    failedSections: [], restarts24h: {}, kernelFile: KERNEL_JSON, workspaces: {}, access: [], activityBetween: () => false, readProblems: {},
    lossAt: null, ...over };
}
const run = over => evaluateRules(ctx(over));
const ACCEPTANCE = { 'backup-ausente': 'critical', 'backup-sem-cron': 'warning', 'rotacao-sem-cron': 'warning', 'reinicio-pendente': 'warning',
  'ssh-senha': 'warning', 'aquecimento-parcial': 'info' };
// the alerts beyond the production acceptance set
const extra = list => list.filter(a => !Object.hasOwn(ACCEPTANCE, a.id));
function fired(over, id) { return run(over).find(a => a.id === id) ?? null; }
function expectFire(over, id, severity, title) {
  const a = fired(over, id);
  assert.ok(a, `${id} should fire`);
  if (severity) assert.equal(a.severity, severity, id);
  if (title) assert.equal(a.title, title);
  return a;
}
function expectNone(over, id) { assert.equal(fired(over, id), null, `${id} should not fire`); }
const lic = (expiresAt, state = 'active') => ({ id: A, customer: 'Cliente Alfa', state, expiresAt: iso(expiresAt), lanes: ['odc', 'o11'] });
const samples = (pcts, load = 0.1) => pcts.map((p, i) => ({ t: iso(NOW - (pcts.length - 1 - i) * 30000), availPct: p, availB: Math.round(8e9 * p / 100), load1: load, nproc: 2 }));

test('production acceptance set: exactly the six host/server alerts of section 5', () => {
  const list = run();
  assert.deepEqual(Object.fromEntries(list.map(a => [a.id, a.severity])), ACCEPTANCE);
  const byId = Object.fromEntries(list.map(a => [a.id, a]));
  assert.equal(byId['backup-ausente'].title, 'Nenhum backup do estado em /var/backups/ssam-server.');
  assert.equal(byId['backup-ausente'].detail, 'DEPLOY.md seção 9; o cron diário instala com host/install.sh --with-crons.');
  assert.equal(byId['backup-sem-cron'].title, 'O backup diário não está agendado (falta /etc/cron.d/ssam-backup).');
  assert.equal(byId['rotacao-sem-cron'].title, 'A rotação de logs não está agendada: o server.log tem 6,8 KiB e só cresce.');
  assert.equal(byId['reinicio-pendente'].title, 'Reinício da VPS pendente desde 07/10/2026 (linux-image-7.0.0-38-generic, linux-base).');
  assert.equal(byId['reinicio-pendente'].detail, 'Reiniciar derruba sessões e chamadas em curso: escolha uma janela.');
  assert.equal(byId['ssh-senha'].title, 'SSH aceita login por senha e root com senha; 40 tentativas falhas em 24 h, sem fail2ban.');
  assert.equal(byId['ssh-senha'].area, 'seguranca');
  assert.equal(byId['aquecimento-parcial'].title, 'O worker ODC falhou no aquecimento, mas está rodando agora (subiu sob demanda).');
});

test('licenses: licenca-vence, licenca-venceu, licencas-ilegiveis, acesso-outra-maquina, espaco-cliente', () => {
  const id = `licenca-vence:${A}`;
  expectFire({ licenses: [lic(NOW + 7 * DAY)] }, id, 'warning', 'Licença de Cliente Alfa vence em 7 dias (19/10/2026).');
  expectNone({ licenses: [lic(NOW + 7 * DAY + MIN)] }, id);
  expectFire({ licenses: [lic(NOW + 2 * DAY)] }, id, 'critical');
  expectFire({ licenses: [lic(NOW + 2 * DAY + MIN)] }, id, 'warning');
  expectFire({ licenses: [lic(NOW + DAY)] }, id, 'critical', 'Licença de Cliente Alfa vence em 1 dia (13/10/2026).');
  expectFire({ licenses: [lic(NOW + 6 * HOUR)] }, id, 'critical', 'Licença de Cliente Alfa vence hoje às 18:00.');
  expectNone({ licenses: [lic(NOW - MIN, 'expired')] }, id);
  const v = `licenca-venceu:${A}`;
  const used = { activityBetween: () => true };
  expectFire({ ...used, licenses: [lic(NOW - 7 * DAY, 'expired')] }, v, 'warning', 'Licença de Cliente Alfa venceu em 05/10/2026 e ele usou o SSAM nos 14 dias anteriores.');
  expectNone({ ...used, licenses: [lic(NOW - 7 * DAY - MIN, 'expired')] }, v);
  expectNone({ licenses: [lic(NOW - DAY, 'expired')] }, v);
  expectFire({ licensesError: 'STORE_INVALID' }, 'licencas-ilegiveis', 'critical').detail === 'STORE_INVALID' || assert.fail('detail');
  expectFire({ tokensUnreadableAt: iso(NOW - 10 * MIN) }, 'licencas-ilegiveis', 'critical');
  expectNone({ tokensUnreadableAt: iso(NOW - 10 * MIN - 1000) }, 'licencas-ilegiveis');
  const line = t => ({ time: iso(t), token: A, customer: 'Cliente Alfa', first: { id: 'abc123', name: 'PC-TESTE-01', user: 'teste' },
    machine: { id: 'def456', name: 'PC-TESTE-02', user: 'teste' }, ip: '203.0.113.50' });
  const acc = expectFire({ access: [line(NOW - 30 * DAY)] }, `acesso-outra-maquina:${A}:def456`, 'critical',
    'Credencial do agente de Cliente Alfa usada em outra máquina: PC-TESTE-02 (teste) em vez de PC-TESTE-01 (teste), IP 203.0.113.50, 12/09/2026 12:00.');
  assert.equal(acc.event, true);
  assert.equal(acc.detail, 'Se não foi o cliente, troque a credencial do agente ou revogue a licença.');
  expectNone({ access: [line(NOW - 30 * DAY - MIN)] }, `acesso-outra-maquina:${A}:def456`);
  const ws = bytes => ({ workspaces: { [A]: { bytes, files: 1, truncated: false } } });
  expectFire(ws(Math.ceil(0.8 * QUOTA_BYTES)), `espaco-cliente:${A}`, 'warning', 'Espaço de trabalho de Cliente Alfa em 80% da cota de 5 GiB (4 GiB).');
  expectNone(ws(Math.ceil(0.8 * QUOTA_BYTES) - 1), `espaco-cliente:${A}`);
  expectFire(ws(Math.ceil(0.95 * QUOTA_BYTES)), `espaco-cliente:${A}`, 'critical');
  expectFire(ws(Math.ceil(0.95 * QUOTA_BYTES) - 1), `espaco-cliente:${A}`, 'warning');
  expectNone({ ...ws(QUOTA_BYTES), licenses: [lic(NOW + 99 * DAY, 'revoked')] }, `espaco-cliente:${A}`);
});

test('usage and agents: sessoes-limite, pico-falhas, falhas-agente, erro-servidor, log-grande', () => {
  expectFire({ sessionsByToken: { [A]: 8 } }, `sessoes-limite:${A}`, 'info', 'Cliente Alfa está no limite de 8 sessões MCP abertas.');
  expectNone({ sessionsByToken: { [A]: 7 } }, `sessoes-limite:${A}`);
  const w = (calls, failures) => ({ calls15: { calls, failures, topCode: 'AGENT_NOT_CONNECTED', topTool: 'odc_read' } });
  expectFire(w(40, 10), 'pico-falhas', 'warning', 'Pico de falhas: 10 de 40 chamadas falharam nos últimos 15 min (mais comum: AGENT_NOT_CONNECTED em odc_read).');
  expectNone(w(36, 9), 'pico-falhas');
  expectNone(w(41, 10), 'pico-falhas');
  expectFire(w(60, 30), 'pico-falhas', 'critical');
  expectFire(w(58, 29), 'pico-falhas', 'warning');
  expectFire(w(61, 30), 'pico-falhas', 'warning');
  expectFire({ agentFailures15: [{ token: A, failures: 10, topCode: 'AGENT_TIMEOUT' }] }, `falhas-agente:${A}`, 'warning',
    '10 chamadas ao agente de Cliente Alfa falharam nos últimos 15 min (mais comum: AGENT_TIMEOUT).');
  expectNone({ agentFailures15: [{ token: A, failures: 9, topCode: 'AGENT_TIMEOUT' }] }, `falhas-agente:${A}`);
  expectFire({ serverErrors: [{ time: iso(NOW - HOUR + 1000), event: 'audit-failed', error: 'EACCES' }, { time: iso(NOW - MIN), event: 'request-failed', error: 'EPIPE' }] },
    'erro-servidor', 'warning', 'O servidor registrou 2 erro(s) interno(s) na última hora (request-failed: EPIPE).');
  expectNone({ serverErrors: [] }, 'erro-servidor');
  expectFire({ serverLogB: 512 * MIB + 1 }, 'log-grande', 'warning', 'server.log com 512 MiB: rode a rotação (DEPLOY.md seção 10).');
  expectNone({ serverLogB: 512 * MIB }, 'log-grande');
});

test('server and containers: servidor-fora, caddy-fora, container-reiniciou, container-oom, memoria-container', () => {
  expectFire({ doc: doc(d => { srv(d).state = 'exited'; }) }, 'servidor-fora', 'critical', 'O container ssam-server está parado.');
  expectFire({ doc: doc(d => { d.docker.containers = d.docker.containers.filter(c => c.service !== 'ssam-server'); }) }, 'servidor-fora', 'critical', 'O container ssam-server está ausente.');
  expectFire({ doc: doc(d => { srv(d).health = 'unhealthy'; }), facts: { samples: [], restarts: {}, probeFails: 0, unhealthySince: iso(NOW - 3 * MIN - 5000) } },
    'servidor-fora', 'critical', 'O ssam-server está unhealthy há 3 min 05 s.');
  expectFire({ facts: { samples: [], restarts: {}, probeFails: 2 } }, 'servidor-fora', 'critical', 'O /health do ssam-server não responde a partir da VPS.');
  expectNone({ facts: { samples: [], restarts: {}, probeFails: 1 } }, 'servidor-fora');
  expectNone({ doc: doc(d => { d.server.health.probe.available = false; }), facts: { samples: [], restarts: {}, probeFails: 5 } }, 'servidor-fora');
  expectFire({ doc: doc(d => { d.docker.containers[1].state = 'restarting'; }) }, 'caddy-fora', 'critical', 'O Caddy está reiniciando: ninguém de fora alcança o servidor.');
  expectNone({}, 'caddy-fora');
  expectFire({ restarts24h: { caddy: 2 } }, 'container-reiniciou:caddy', 'warning', 'caddy reiniciou 2 vez(es) nas últimas 24 h.');
  expectNone({ restarts24h: { caddy: 0 } }, 'container-reiniciou:caddy');
  expectFire({ doc: doc(d => { srv(d).oomKilled = true; }) }, 'container-oom:ssam-server', 'critical', 'ssam-server foi encerrado por falta de memória (OOM).');
  const mem = f => ({ doc: doc(d => { srv(d).memB = Math.ceil(srv(d).memLimitB * f); }) });
  expectFire(mem(0.85), 'memoria-container:ssam-server', 'warning', 'ssam-server usa 85% do limite de memória (5,1 GiB de 6 GiB).');
  expectNone({ doc: doc(d => { srv(d).memB = Math.ceil(srv(d).memLimitB * 0.85) - 1; }) }, 'memoria-container:ssam-server');
  expectFire(mem(0.95), 'memoria-container:ssam-server', 'critical');
  expectFire({ doc: doc(d => { srv(d).memB = Math.ceil(srv(d).memLimitB * 0.95) - 1; }) }, 'memoria-container:ssam-server', 'warning');
});

test('warm: nao-aquecido at 6 min, index/builder/worker failures, aquecimento-parcial when the worker runs anyway', () => {
  const noWarm = age => ({ doc: doc(d => { delete d.server.startup.warm; srv(d).startedAt = iso(NOW - age); }) });
  expectFire(noWarm(6 * MIN + 1000), 'nao-aquecido:aquecimento', 'warning', 'O servidor subiu há 6 min 01 s e não terminou o aquecimento.');
  expectNone(noWarm(6 * MIN - 1000), 'nao-aquecido:aquecimento');
  const idx = { doc: doc(d => { d.server.startup.warm.indexes = { ok: false, lanes: { odc: { ok: true }, o11: { ok: false, error: 'INDEX_FAILED' } } }; }) };
  expectFire(idx, 'nao-aquecido:indice', 'warning', 'Aquecimento: o índice O11 falhou (INDEX_FAILED).');
  expectFire({ doc: doc(d => { d.server.startup.warm.delivery.builder = { ok: false, note: 'sem dotnet' }; }) }, 'nao-aquecido:builder', 'warning',
    'Aquecimento: o builder residente não subiu (sem dotnet).');
  const noWorker = { doc: doc(d => { d.server.processes = d.server.processes.filter(p => p.kind !== 'odc-worker'); }) };
  expectFire(noWorker, 'nao-aquecido:worker', 'warning', 'Aquecimento: o worker ODC não subiu (worker ODC não respondeu no aquecimento).');
  expectNone(noWorker, 'aquecimento-parcial');
  expectFire({}, 'aquecimento-parcial', 'info');
  expectNone({}, 'nao-aquecido:worker');
  expectNone({ doc: doc(d => { d.server.startup.warm.delivery.worker = { ok: true }; }) }, 'aquecimento-parcial');
});

test('kernel, TLS, disks, memory, load', () => {
  expectFire({ doc: doc(d => { d.server.startup.kernel.kernel.odcBridge = null; }), kernelFile: { ...KERNEL_JSON, odcBridge: null } }, 'kernel-ausente', 'critical',
    'O servidor partiu sem kernel.json válido (o11 ou odcBridge nulos): as faixas hospedadas recusam chamadas.');
  expectFire({ kernelFile: { ...KERNEL_JSON, odcBridge: 'v49' } }, 'kernel-mudou', 'warning',
    'kernel.json mudou depois da partida (odcBridge: v48 → v49); só vale depois de reiniciar o ssam-server.');
  expectNone({ kernelFile: { ...KERNEL_JSON } }, 'kernel-mudou');
  const cert = left => ({ doc: doc(d => { d.tls.certs[0].notAfter = iso(NOW + left); }) });
  expectFire(cert(21 * DAY - MIN), 'certificado:ssam.example.com', 'warning', 'Certificado TLS de ssam.example.com vence em 20 dias (02/11/2026); o Caddy renova com 30 dias, veja o log dele.');
  expectNone(cert(21 * DAY), 'certificado:ssam.example.com');
  expectFire(cert(7 * DAY - MIN), 'certificado:ssam.example.com', 'critical');
  expectFire(cert(7 * DAY), 'certificado:ssam.example.com', 'warning');
  expectFire({ doc: doc(d => { d.tls.certs = []; }) }, 'certificado-ausente', 'critical', 'Nenhum certificado TLS encontrado no volume do Caddy.');
  const disk = (used, inodes = 1) => ({ doc: doc(d => { Object.assign(d.host.disks[0], { usedPct: used, inodesPct: inodes }); }) });
  expectFire(disk(80), 'disco:/', 'warning', 'Disco / em 80% (5,4 GiB de 94 GiB).');
  expectNone(disk(79), 'disco:/');
  expectFire(disk(90), 'disco:/', 'critical');
  expectFire(disk(89), 'disco:/', 'warning');
  expectFire(disk(6, 80), 'disco:/:inodes', 'warning', 'Inodes de / em 80%.');
  expectNone(disk(6, 79), 'disco:/:inodes');
  const facts = s => ({ facts: { samples: s, restarts: {}, probeFails: 0 } });
  expectFire(facts(samples([14.9, 14.9])), 'memoria', 'warning', 'Memória disponível da VPS em 14% (1,1 GiB); sem swap, um pico pode derrubar o servidor.');
  expectNone(facts(samples([15, 14.9])), 'memoria');
  expectNone(facts(samples([14.9])), 'memoria');
  expectFire(facts(samples([6.9, 6.9])), 'memoria', 'critical');
  expectFire(facts(samples([7, 6.9])), 'memoria', 'warning');
  const load = (value, minutes = 5) => facts(Array.from({ length: minutes * 2 }, (_, i) => ({ t: iso(NOW - (minutes * 2 - 1 - i) * 30000 + 1), availPct: 80, availB: 1, load1: value, nproc: 2 })));
  expectFire(load(4), 'carga', 'warning', 'Carga da VPS em 4,00 com 2 vCPU há 5 min.');
  expectNone(load(3.99), 'carga');
  expectNone(load(4, 2), 'carga');
  const mixed = load(4);
  mixed.facts.samples[3].load1 = 3.9;
  expectNone(mixed, 'carga');
});

test('backups, updates, security, Caddy, Coolify, clock, systemd', () => {
  const newest = (ageMs, extra = {}) => ({ doc: doc(d => { d.backups.newest = { name: 'ssam-state-20261012T033000Z.tar.gz', sizeB: 12 * MIB, mtime: iso(NOW - ageMs) }; d.backups.count = 1; Object.assign(d.backups, extra); }) });
  expectFire(newest(26 * HOUR + MIN), 'backup-velho', 'critical', 'O último backup tem 26 h (limite 26 h): ssam-state-20261012T033000Z.tar.gz.');
  expectNone(newest(26 * HOUR), 'backup-velho');
  expectNone(newest(HOUR), 'backup-ausente');
  expectFire(newest(5 * HOUR, { cronLogTail: ['backup: ssam-state-x.tar.gz (12 MB), sha256 ab', 'backup: FAILED (exit 2) at 2026-10-12T14:00:00Z'] }), 'backup-falhou', 'critical',
    'O último backup falhou: backup: FAILED (exit 2) at 2026-10-12T14:00:00Z.');
  expectNone(newest(5 * HOUR, { cronLogTail: ['backup: FAILED (exit 2) at 2026-10-12T05:00:00Z'] }), 'backup-falhou');
  expectNone(newest(5 * HOUR, { cronLogTail: ['backup: FAILED (exit 2) at 2026-10-12T14:00:00Z', 'backup: ssam-state-y.tar.gz (12 MB), sha256 cd'] }), 'backup-falhou');
  expectNone({ doc: doc(d => { d.backups.cron = { backup: true, rotate: true }; }) }, 'backup-sem-cron');
  expectNone({ doc: doc(d => { d.backups.cron = { backup: true, rotate: true }; }) }, 'rotacao-sem-cron');
  const reboot = ageMs => ({ doc: doc(d => { d.updates.rebootSince = iso(NOW - ageMs); }) });
  expectFire(reboot(DAY + MIN), 'reinicio-pendente', 'warning');
  expectNone(reboot(DAY - MIN), 'reinicio-pendente');
  expectNone({ doc: doc(d => { d.updates.rebootRequired = false; }) }, 'reinicio-pendente');
  const secu = ageMs => ({ doc: doc(d => { d.updates.security = 3; }), facts: { samples: [], restarts: {}, probeFails: 0, securitySince: iso(NOW - ageMs) } });
  expectFire(secu(2 * DAY + MIN), 'atualizacoes-seguranca', 'warning', '3 atualização(ões) de segurança pendente(s) há 2 dias.');
  expectNone(secu(2 * DAY - MIN), 'atualizacoes-seguranca');
  expectNone({ doc: doc(d => { d.security.ssh.passwordAuth = false; }) }, 'ssh-senha');
  expectFire({ doc: doc(d => { Object.assign(d.security.ssh, { permitRootLogin: 'prohibit-password', fail2ban: 'active', failures24h: 3 }); }) }, 'ssh-senha', 'warning',
    'SSH aceita login por senha; 3 tentativas falhas em 24 h.');
  expectFire({ doc: doc(d => { d.security.ufw.active = false; }) }, 'firewall', 'critical', 'Firewall (ufw) inativo.');
  expectFire({ doc: doc(d => { d.security.ufw.allowIn.push('8080/tcp', '8080/tcp (v6)'); }) }, 'firewall', 'warning', 'Firewall libera portas além de 22, 80 e 443: 8080/tcp, 8080/tcp (v6).');
  expectNone({}, 'firewall');
  const denied = n => ({ doc: doc(d => { d.caddy.last15m.denied = [{ ip: '203.0.113.9', status: 401, path: '/mcp', count: n - 10 }, { ip: '203.0.113.9', status: 403, path: '/agent', count: 10 }]; }) });
  expectFire(denied(50), 'recusas-acesso:203.0.113.9', 'warning', '50 acessos recusados (401/403) vindos de 203.0.113.9 nos últimos 15 min.');
  expectNone(denied(49), 'recusas-acesso:203.0.113.9');
  expectFire({ doc: doc(d => { d.caddy.last15m.byStatus['429'] = 1; }) }, 'limite-taxa', 'info', '1 resposta(s) 429 (limite de taxa) nos últimos 15 min.');
  expectNone({}, 'limite-taxa');
  expectFire({ doc: doc(d => { d.coolify.containers.push({ name: 'coolify-proxy', state: 'running', restartPolicy: 'always' }); }) }, 'coolify-rodando:coolify-proxy', 'warning',
    'Container do Coolify coolify-proxy está rodando (foi parado de propósito; o coolify-proxy disputa as portas 80 e 443).');
  expectFire({ doc: doc(d => { d.host.time.ntpSynced = false; }) }, 'relogio', 'warning', 'O relógio da VPS não está sincronizado (NTP).');
  expectFire({ doc: doc(d => { d.host.failedUnits = 1; }) }, 'unidades-falhas', 'warning', '1 unidade(s) do systemd com falha.');
  expectNone({}, 'unidades-falhas');
});

test('collector and console: coletor, coleta-parcial, painel-leitura, eventos-perdidos', () => {
  expectFire({ hostStatus: 'missing', doc: null }, 'coletor', 'critical', 'O coletor da VPS não está instalado ou nunca rodou (host/install.sh).');
  expectFire({ hostStatus: 'invalid', hostSchema: 'ssam-console-host/9', doc: null }, 'coletor', 'warning',
    'host.json em formato desconhecido (ssam-console-host/9); atualize o coletor (host/install.sh).');
  const age = s => ({ doc: doc(d => { d.collectedAt = iso(NOW - s * 1000); }) });
  expectFire(age(121), 'coletor', 'warning', 'O coletor da VPS parou: últimos dados às 11:57 (há 2 min 01 s).');
  expectNone(age(120), 'coletor');
  expectFire(age(601), 'coletor', 'critical');
  expectFire(age(600), 'coletor', 'warning');
  expectFire({ failedSections: [{ name: 'updates', error: 'TIMEOUT' }, { name: 'tls', error: 'EXIT_1' }] }, 'coleta-parcial', 'info', 'Coleta parcial: updates, tls falharam (TIMEOUT).');
  expectFire({ readProblems: { 'server.log': 'EACCES' } }, 'painel-leitura:server.log', 'critical', 'O painel não consegue ler server.log (EACCES).');
  expectNone({ readProblems: { 'server.log': 'ENOENT' } }, 'painel-leitura:server.log');
  expectFire({ lossAt: iso(NOW - HOUR) }, 'eventos-perdidos', 'info', 'Parte do server.log girado não pôde ser lida; a contagem desse trecho pode faltar.');
  expectNone({ lossAt: iso(NOW - DAY - MIN) }, 'eventos-perdidos');
  // missing host.json: only the collector alert among host rules
  assert.deepEqual(run({ hostStatus: 'missing', doc: null }).map(a => a.id), ['coletor']);
  assert.deepEqual(extra(run()), []);
});

test('engine: hysteresis of 2 evaluations, Resolvido event, persisted first-seen times', () => {
  const dir = tempDir('al');
  const now = clock(NOW);
  const events = [];
  let on = true;
  const rules = () => (on ? [{ id: 'disco:/', rule: 'disco', severity: 'warning', area: 'vps', view: 'vps', title: 'Disco / em 81% (x de y).', detail: null, subject: { mount: '/' }, event: false }] : []);
  let engine = createAlerts({ state: createState(dir), now, emit: e => events.push(e), rules });
  engine.evaluate({});
  const since = engine.list().alerts[0].since;
  now.advance(10000);
  engine = createAlerts({ state: createState(dir), now, emit: e => events.push(e), rules });   // restart keeps since
  engine.evaluate({});
  assert.equal(engine.list().alerts[0].since, since);
  assert.equal(engine.list().alerts[0].lastSeen, now.iso());
  on = false;
  now.advance(10000);
  engine.evaluate({});
  assert.equal(engine.list().alerts.length, 1, 'one false evaluation keeps it');
  on = true;
  engine.evaluate({});
  on = false;
  engine.evaluate({});
  assert.equal(engine.list().alerts.length, 1, 'the false count restarts after a true evaluation');
  engine = createAlerts({ state: createState(dir), now, emit: e => events.push(e), rules });   // hysteresis survives a restart
  engine.evaluate({});
  assert.equal(engine.list().alerts.length, 0, 'cleared after 2 consecutive false evaluations');
  assert.deepEqual(events.map(e => [e.group, e.level, e.text]), [['painel', 'info', 'Resolvido: Disco / em 81% (x de y).']]);
  on = true;
  engine.evaluate({});
  assert.notEqual(engine.list().alerts[0].since, since, 'a new occurrence has a new since');
});

test('engine: acks for 24 h and 7 days, critical only 24 h, event alerts marked visto for good, unack', () => {
  const now = clock(NOW);
  const list = [
    { id: 'disco:/', rule: 'disco', severity: 'warning', area: 'vps', view: 'vps', title: 'w', subject: {}, event: false },
    { id: 'backup-ausente', rule: 'backup-ausente', severity: 'critical', area: 'backup', view: 'vps', title: 'c', subject: {}, event: false },
    { id: `acesso-outra-maquina:${A}:def456`, rule: 'acesso-outra-maquina', severity: 'critical', area: 'licencas', view: 'licencas', title: 'e', subject: { token: A }, event: true },
  ];
  const engine = createAlerts({ state: createState(tempDir('al')), now, rules: () => list });
  engine.evaluate({});
  assert.equal(engine.ack('disco:/', 168).until, iso(NOW + 7 * DAY));
  assert.throws(() => engine.ack('backup-ausente', 168), e => e.apiCode === 'INVALID_FIELD' && e.field === 'hours');
  assert.throws(() => engine.ack('backup-ausente', null), e => e.apiCode === 'INVALID_FIELD');
  assert.equal(engine.ack('backup-ausente', 24).until, iso(NOW + DAY));
  assert.throws(() => engine.ack(`acesso-outra-maquina:${A}:def456`, 24), e => e.apiCode === 'INVALID_FIELD');
  assert.equal(engine.ack(`acesso-outra-maquina:${A}:def456`, null).until, null);
  assert.throws(() => engine.ack('nada', 24), e => e.apiCode === 'NOT_FOUND');
  let l = engine.list();
  assert.deepEqual(l.alerts, []);
  // severity first, then since, then id
  assert.deepEqual(l.acked.map(a => [a.id, a.ackedUntil]), [[`acesso-outra-maquina:${A}:def456`, null], ['backup-ausente', iso(NOW + DAY)], ['disco:/', iso(NOW + 7 * DAY)]]);
  assert.deepEqual(engine.counts(), { critical: 0, warning: 0, info: 0, acked: 3 });
  now.advance(DAY + 1000);
  engine.evaluate({});
  l = engine.list();
  assert.deepEqual(l.alerts.map(a => a.id), ['backup-ausente'], 'the 24 h silence is over');
  now.advance(30 * DAY);
  engine.evaluate({});
  l = engine.list();
  assert.ok(l.acked.some(a => a.id === `acesso-outra-maquina:${A}:def456`), 'visto is permanent for that id');
  assert.ok(l.alerts.some(a => a.id === 'disco:/'));
  engine.unack(`acesso-outra-maquina:${A}:def456`);
  assert.throws(() => engine.unack(`acesso-outra-maquina:${A}:def456`), e => e.apiCode === 'NOT_FOUND');
  assert.equal(engine.list().alerts[0].id, `acesso-outra-maquina:${A}:def456`, 'critical first');
});

test('API: acceptance set and acks end to end, history records the acks', async t => {
  const env = makeEnv();
  const now = clock('2026-10-12T03:00:00Z');
  writeHost(env, HOST_PROD, '2026-10-12T02:59:50Z');
  const c = await startConsole(env, { now });
  t.after(() => c.close());
  await c.app.tickAll();
  const ov = (await c.get('/api/overview')).body;
  assert.deepEqual(Object.fromEntries(ov.alerts.map(a => [a.id, a.severity])), ACCEPTANCE);
  assert.deepEqual(ov.status.alerts, { critical: 1, warning: 4, info: 1, acked: 0 });
  assert.deepEqual(ov.alerts.map(a => a.severity), ['critical', 'warning', 'warning', 'warning', 'warning', 'info']);
  assert.equal(ov.summary.find(r => r.area === 'backup').state, 'critical');
  assert.equal(ov.summary.find(r => r.area === 'vps').state, 'warning');
  assert.equal(ov.summary.find(r => r.area === 'servidor').state, 'ok');
  assert.equal((await c.post('/api/alerts/ack', { id: 'backup-ausente', hours: 168 })).body.error.code, 'INVALID_FIELD');
  const ack = await c.post('/api/alerts/ack', { id: 'backup-ausente', hours: 24 });
  assert.equal(ack.body.until, '2026-10-13T03:00:00.000Z');
  assert.equal((await c.post('/api/alerts/ack', { id: 'nada', hours: 24 })).status, 404);
  const after = (await c.get('/api/overview')).body;
  assert.deepEqual(after.acked.map(a => a.id), ['backup-ausente']);
  assert.equal(after.summary.find(r => r.area === 'backup').state, 'warning', 'state = worst unacked alert');
  await c.post('/api/alerts/unack', { id: 'backup-ausente' });
  const hist = (await c.get('/api/history')).body.entries;
  assert.deepEqual(hist.map(e => [e.action, e.detail]), [['alert-unack', { alert: 'backup-ausente' }], ['alert-ack', { alert: 'backup-ausente', hours: 24 }]]);
  // resolving: backups appear, two evaluations later the alert is gone with a Resolvido event
  writeHost(env, { ...HOST_PROD, backups: { ...HOST_PROD.backups, count: 1, newest: { name: 'ssam-state-20261012T025000Z.tar.gz', sizeB: 1, mtime: '2026-10-12T02:50:00Z' } } }, '2026-10-12T03:00:20Z');
  now.set('2026-10-12T03:00:30Z');
  await c.app.tickAll();
  assert.ok((await c.get('/api/overview')).body.alerts.some(a => a.id === 'backup-ausente'));
  now.advance(10000);
  await c.app.tickAlerts();
  assert.ok(!(await c.get('/api/overview')).body.alerts.some(a => a.id === 'backup-ausente'));
  const ev = (await c.get('/api/events?group=painel')).body.events;
  assert.equal(ev[ev.length - 1].text, 'Resolvido: Nenhum backup do estado em /var/backups/ssam-server.');
});
