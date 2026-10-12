// Pure logic of the dialogs (6.10), the one-time secret panel (6.11) and the views (6.5), against the normal fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pub, fixture } from './helpers.mjs';

const NOW = Date.parse('2026-10-13T02:51:08Z');
const D = 86400000;

const dialogs = await import(pub('js/dialogs.js'));
const secret = await import(pub('js/secret.js'));
const visao = await import(pub('js/views/visao.js'));
const licencas = await import(pub('js/views/licencas.js'));
const uso = await import(pub('js/views/uso.js'));
const agentes = await import(pub('js/views/agentes.js'));
const vps = await import(pub('js/views/vps.js'));
const eventos = await import(pub('js/views/eventos.js'));
const historico = await import(pub('js/views/historico.js'));
const labels = await import(pub('js/labels.js'));

test('dialogs: customer names, days, renewal date, exact confirmation', () => {
  assert.equal(dialogs.validCustomer('Cliente Delta'), true);
  assert.equal(dialogs.validCustomer('  Cliente Ação_2.0-b  '), true);
  assert.equal(dialogs.validCustomer(''), false);
  assert.equal(dialogs.validCustomer('Cliente <b>'), false);
  assert.equal(dialogs.validCustomer('a'.repeat(64)), true);
  assert.equal(dialogs.validCustomer('a'.repeat(65)), false);
  assert.equal(dialogs.parseDays('30'), 30);
  assert.equal(dialogs.parseDays(' 12 '), 12);
  assert.equal(dialogs.parseDays('3650'), 3650);
  for (const bad of ['0', '3651', '1.5', '-3', '', 'trinta', null]) assert.equal(dialogs.parseDays(bad), null, String(bad));
  assert.equal(dialogs.renewedExpiry('2026-11-11T21:00:00Z', 30, NOW), Date.parse('2026-12-11T21:00:00Z'));
  assert.equal(dialogs.renewedExpiry('2026-10-09T15:00:00Z', 30, NOW), NOW + 30 * D, 'an expired license counts from today');
  assert.equal(dialogs.renewedExpiry(null, 1, NOW), NOW + D);
  assert.equal(dialogs.renewLine('2026-10-15T02:58:00Z', 30, NOW), 'Nova validade: até 13/11/2026 (conta a partir da validade atual).');
  assert.equal(dialogs.renewLine('2026-10-09T15:00:00Z', 30, NOW), 'Nova validade: até 11/11/2026 (conta a partir de hoje).');
  assert.equal(dialogs.confirmMatches('Cliente Gama ', 'Cliente Gama'), true);
  assert.equal(dialogs.confirmMatches('cliente gama', 'Cliente Gama'), false);
  assert.equal(dialogs.confirmMatches('Cliente  Gama', 'Cliente Gama'), false);
  assert.equal(dialogs.confirmMatches('', ''), false);
});

const ISSUE = {
  kind: 'issue', customer: 'Cliente Delta', tokenId: 'tok_00000000de17',
  token: 'ssam_EXEMPLO_NAO_E_UM_TOKEN_DELTA_0001', agentCredential: 'ssam_agent_EXEMPLO_NAO_E_UMA_CREDENCIAL_DELTA_0001',
  publicUrl: 'https://ssam.example.com/mcp', serverUrl: 'https://ssam.example.com',
};

test('secret panel blocks: only the env var block carries the token; .mcp.json and Codex read SSAM_TOKEN', () => {
  const blocks = secret.secretBlocks(ISSUE);
  assert.deepEqual(blocks.map((b) => b.id), ['env', 'mcp', 'codex', 'agent']);
  const withToken = blocks.filter((b) => b.text.includes(ISSUE.token));
  assert.deepEqual(withToken.map((b) => b.id), ['env']);
  assert.ok(!blocks.some((b) => b.text.includes(ISSUE.agentCredential)), 'the agent setup asks for the credential itself');
  assert.equal(blocks[0].text, `[Environment]::SetEnvironmentVariable('SSAM_TOKEN', '${ISSUE.token}', 'User')`);
  assert.ok(!blocks[0].masked.includes(ISSUE.token));
  assert.equal(blocks[0].label, 'Variável de ambiente no Windows do cliente (PowerShell, uma vez)');
  const mcp = JSON.parse(blocks[1].text);
  assert.deepEqual(mcp, { mcpServers: { ssam: { type: 'http', url: 'https://ssam.example.com/mcp', headers: { Authorization: 'Bearer ${SSAM_TOKEN}' } } } });
  assert.equal(blocks[1].label, '.mcp.json do projeto (Claude Code)');
  assert.equal(blocks[2].text, '[mcp_servers.ssam]\nurl = "https://ssam.example.com/mcp"\nbearer_token_env_var = "SSAM_TOKEN"');
  assert.equal(blocks[2].label, 'Codex (~/.codex/config.toml)');
  assert.equal(blocks[3].text, [
    'Expand-Archive .\\ssam-agent.zip -DestinationPath C:\\SSAM-Agent',
    'C:\\SSAM-Agent\\agent\\node\\node.exe C:\\SSAM-Agent\\agent\\ssam-agent.mjs setup --server https://ssam.example.com --root C:\\SSAM-Agent',
    'powershell -ExecutionPolicy Bypass -File C:\\SSAM-Agent\\agent\\ssam-agent.ps1 start',
  ].join('\n'));
  assert.equal(blocks[3].label, 'Agente (Windows do cliente)');
  const rot = secret.secretBlocks({ ...ISSUE, kind: 'rotate' });
  assert.deepEqual(rot.map((b) => b.id), ['agent']);
});

test('secret panel text (Copiar tudo / Baixar .txt) and file name', () => {
  const t = secret.secretText(ISSUE);
  assert.ok(t.startsWith('Segredos de Cliente Delta - guarde agora\n'));
  assert.ok(t.includes(secret.SECRET_WARNING));
  assert.ok(t.includes(`Token MCP: ${ISSUE.token}`));
  assert.ok(t.includes(`Credencial do agente: ${ISSUE.agentCredential}`));
  assert.ok(t.includes(secret.SECRET_NOTE));
  for (const b of secret.secretBlocks(ISSUE)) assert.ok(t.includes(b.text));
  const r = secret.secretText({ ...ISSUE, kind: 'rotate' });
  assert.ok(!r.includes(ISSUE.token), 'rotate never repeats a token');
  assert.ok(r.includes(ISSUE.agentCredential));
  assert.equal(secret.secretFileName('Cliente Ação', 'tok_00000000de17'), 'ssam-cliente-acao-tok_00000000de17.txt');
  assert.equal(secret.SECRET_WARNING, 'Eles aparecem só agora. O servidor guarda só o hash; se perder, troque a credencial ou emita outra licença.');
});

test('Visão geral: Resumo texts of every area (normal scenario)', () => {
  const ov = fixture('normal', 'overview');
  const got = Object.fromEntries(ov.summary.map((r) => [r.area, visao.summaryTexts(r, ov, NOW)]));
  assert.deepEqual(got.servidor, { agora: 'no ar há 5 h 12 min (pid 7)', detalhe: 'prod-20261011-ed0f94b · aquecido · /health 3 ms' });
  assert.deepEqual(got.licencas, { agora: '2 ativas · 0 vencidas · 1 revogada', detalhe: 'próxima a vencer: Cliente Beta em 2 dias' });
  assert.deepEqual(got.uso, { agora: '14 chamadas · 1 falha (7%)', detalhe: 'p90 2,1 s · 1 cliente ativo' });
  assert.deepEqual(got.agentes, { agora: '1 conectado de 2 licenças ativas', detalhe: 'último sinal há 12 s' });
  assert.deepEqual(got.sessoes, { agora: '1 aberta', detalhe: 'Cliente Alfa (claude-code 2.1.281)' });
  assert.deepEqual(got.vps, { agora: 'CPU 1% · memória 13% · disco 6%', detalhe: 'reinício pendente desde 07/10/2026' });
  assert.deepEqual(got.containers, { agora: '2 de 2 rodando', detalhe: 'ssam-server saudável · 0 reinícios em 24 h' });
  assert.deepEqual(got.backup, { agora: 'nenhum backup', detalhe: 'cron diário ausente' });
  assert.deepEqual(got.tls, { agora: 'vence em 88 dias (09/01/2027)', detalhe: 'ssam.example.com' });
  assert.deepEqual(got.coletor, { agora: 'coletado há 12 s', detalhe: '0 seções com erro' });
  const vazio = fixture('vazio', 'overview');
  const lic = visao.summaryTexts(vazio.summary.find((r) => r.area === 'licencas'), vazio, NOW);
  assert.equal(lic.detalhe, 'nenhuma vence em 30 dias');
  const miss = fixture('sem-coletor', 'overview');
  assert.equal(visao.summaryTexts(miss.summary.find((r) => r.area === 'vps'), miss, NOW).agora, 'sem dados do coletor');
});

test('Visão geral: alerts sort by severity then since', () => {
  const list = [
    { severity: 'info', since: '2026-10-12T01:00:00Z' }, { severity: 'critical', since: '2026-10-12T05:00:00Z' },
    { severity: 'warning', since: '2026-10-12T03:00:00Z' }, { severity: 'critical', since: '2026-10-12T04:00:00Z' },
  ];
  assert.deepEqual(list.slice().sort(visao.alertCompare).map((a) => `${a.severity}@${a.since.slice(11, 13)}`),
    ['critical@04', 'critical@05', 'warning@03', 'info@01']);
});

test('Licenças: default order, workspace share, failure color', () => {
  const lic = fixture('normal', 'licenses').licenses;
  assert.deepEqual(lic.slice().sort(licencas.licenseCompare).map((l) => l.customer), ['Cliente Beta', 'Cliente Alfa', 'Cliente Gama']);
  const prob = fixture('problemas', 'licenses').licenses.slice().sort(licencas.licenseCompare);
  assert.deepEqual(prob.map((l) => l.state), ['active', 'active', 'active', 'active', 'active', 'expired', 'revoked']);
  assert.equal(prob[4].expiresAt, null, 'sem validade comes last among the active ones');
  assert.equal(licencas.workspacePct({ bytes: 4294967296, quotaBytes: 5368709120 }), 80);
  assert.equal(licencas.workspacePct(null), null);
  assert.equal(licencas.failuresLevel({ calls: 12, failures: 3 }), 'bad');
  assert.equal(licencas.failuresLevel({ calls: 13, failures: 3 }), '');
  assert.equal(licencas.failuresLevel({ calls: 4, failures: 2 }), '');
  assert.equal(licencas.failuresLevel({ calls: 0, failures: 0 }), '');
});

test('Uso: the range line', () => {
  assert.equal(uso.rangeText({ from: '2026-10-06', to: '2026-10-12', timeZone: 'America/Sao_Paulo' }), 'De 06/10/2026 a 12/10/2026 (America/Sao_Paulo)');
  assert.equal(uso.rangeText({ from: '2026-10-12', to: '2026-10-12', timeZone: 'America/Sao_Paulo' }), 'Em 12/10/2026 (America/Sao_Paulo)');
  assert.equal(uso.rangeText(null), '');
  assert.equal(uso.rangeText(fixture('normal', 'usage-7d').range), 'De 06/10/2026 a 12/10/2026 (America/Sao_Paulo)');
});

test('Agentes: Studio O11 and pack cells', () => {
  assert.equal(agentes.studioText({ version: '11.55.91', port: 50123, pid: 1 }), '11.55.91 (porta 50123)');
  assert.equal(agentes.studioText(null), '—');
  assert.equal(agentes.packText(null), '—');
  assert.equal(agentes.packText({ id: 'pack-1', odcBridge: 'v48', o11BuiltFor: '11.55.91' }), 'pack-1 · bridge v48 · O11 11.55.91');
  assert.equal(labels.agentCloseWord('rotated'), 'credencial trocada');
  assert.equal(labels.agentCloseWord('sem sinal'), 'sem sinal');
  assert.equal(labels.sessionCloseWord('idle'), 'inativa por 60 min');
});

test('VPS: the key-value texts of 6.5 from the normal host.json facts', () => {
  const d = fixture('normal', 'vps');
  const kv = (rows) => Object.fromEntries(rows.map((r) => [r.label, r.value]));
  const host = kv(vps.hostRows(d.host, []));
  assert.equal(host.Sistema, 'Ubuntu 26.04.1 LTS · vps-exemplo');
  assert.equal(host.Kernel, '7.0.0-34-generic');
  assert.equal(host['No ar desde'], '07/10/2026 12:41 (5 d 11 h)');
  assert.equal(host.CPU, '1,2% · iowait 0% · steal 0,5%');
  assert.equal(host.Carga, '0,09 · 0,04 · 0,01 (2 vCPU)');
  assert.equal(host['Memória'], '1,0 GiB usados de 7,7 GiB · 87% disponível');
  assert.equal(host.Swap, 'sem swap');
  assert.equal(host['Disco /'], '5,5 GiB de 94 GiB (6%) · inodes 1%');
  assert.equal(host['Rede eth0'], '↓ 1,8 KiB/s · ↑ 410 B/s');
  assert.equal(host['Relógio'], 'sincronizado (NTP) · Etc/UTC');
  assert.equal(host['Unidades com falha'], '0');
  assert.equal(host['Pressão (PSI 10 s)'], 'cpu 0 · memória 0 · io 0');
  const upd = kv(vps.updatesRows(d.updates));
  assert.equal(upd['Pacotes atualizáveis'], '10 (0 de segurança)');
  assert.equal(upd['Reinício pendente'], 'sim, desde 07/10/2026 12:50 (linux-image-7.0.0-38-generic, linux-base)');
  assert.equal(upd['unattended-upgrades'], 'ativo · última execução 11/10/2026 03:30');
  const sec = kv(vps.securityRows(d.security));
  assert.equal(sec['Firewall (ufw)'], 'ativo · entrada: negar · saída: permitir');
  assert.equal(sec['Portas liberadas'], '22/tcp, 80/tcp, 443/tcp');
  assert.equal(sec['SSH: senha'], 'aceita');
  assert.equal(sec['SSH: root'], 'yes');
  assert.equal(sec.fail2ban, 'ausente');
  assert.equal(sec['Falhas de login SSH em 24 h'], '40 · principais: 198.51.100.7 (12), 203.0.113.50 (9), 192.0.2.77 (6)');
  const srv = kv(vps.serverRows(d.server));
  assert.equal(srv.Imagem, 'prod-20261011-ed0f94b');
  assert.equal(srv['Revisão'], 'ed0f94b');
  assert.equal(srv['Kernel em uso'], 'O11 11.55.91 · ODC 1.7.27 · bridge v48 (aceita v45)');
  assert.equal(srv['kernel.json'], 'igual ao em uso');
  assert.equal(srv.Aquecimento, 'ok em 148 s · índices ODC e O11 ok · builder ok · worker ODC falhou e subiu depois');
  assert.equal(srv['/health'], 'ok em 3 ms · Docker: saudável');
  assert.equal(srv['server.log'], '7,2 KiB · 0 girados');
  const bk = vps.backupRows(d.backups, NOW);
  assert.equal(bk[0].value, 'nenhum');
  assert.equal(bk[0].level, 'bad');
  assert.equal(kv(bk)['Agendamento do backup'], '/etc/cron.d/ssam-backup: não');
  const failed = vps.updatesRows({ ok: false, error: 'TIMEOUT', at: '2026-10-13T02:20:00Z' });
  assert.equal(failed[0].value, 'indisponível (TIMEOUT)');
  const p = fixture('problemas', 'vps');
  const psrv = kv(vps.serverRows(p.server));
  assert.equal(psrv['kernel.json'], 'mudou: o11, odcBridge');
  assert.equal(psrv['/health'], 'falhou (ECONNREFUSED) · Docker: com falha');
});

test('Eventos: merge keeps one row per seq, ascending, at most 500', () => {
  const a = [{ seq: 1 }, { seq: 2 }, { seq: 3 }];
  assert.deepEqual(eventos.mergeEvents(a, [{ seq: 3, x: 1 }, { seq: 4 }]).map((e) => e.seq), [1, 2, 3, 4]);
  assert.equal(eventos.mergeEvents(a, [{ seq: 3, x: 1 }]).find((e) => e.seq === 3).x, 1);
  const many = Array.from({ length: 600 }, (_, i) => ({ seq: i + 1 }));
  const kept = eventos.mergeEvents([], many);
  assert.equal(kept.length, 500);
  assert.equal(kept[0].seq, 101);
  assert.equal(eventos.mergeEvents([], many, 10).length, 10);
});

test('Histórico: the Detalhe column', () => {
  assert.equal(historico.historyDetail({ action: 'issue', detail: { days: 30, lanes: ['odc', 'o11'] } }), '30 dias, ODC e O11');
  assert.equal(historico.historyDetail({ action: 'issue', detail: { days: null, lanes: ['o11'] } }), 'sem validade, O11');
  assert.equal(historico.historyDetail({ action: 'renew', detail: { days: 30, previousExpiresAt: '2026-11-11T21:00:00Z', expiresAt: '2026-12-11T21:00:00Z' } }), '11/11/2026 → 11/12/2026');
  assert.equal(historico.historyDetail({ action: 'lanes', detail: { previousLanes: ['odc', 'o11'], lanes: ['odc'] } }), 'ODC, O11 → ODC');
  assert.equal(historico.historyDetail({ action: 'alert-ack', detail: { alert: 'disco:/', hours: 24 } }), '24 h · disco:/');
  assert.equal(historico.historyDetail({ action: 'alert-ack', detail: { alert: 'x', hours: 168 } }), '7 dias · x');
  assert.equal(historico.historyDetail({ action: 'alert-ack', detail: { alert: 'x', hours: null } }), 'visto · x');
  assert.equal(historico.historyDetail({ action: 'revoke', detail: {} }), '—');
  // seen outside the console (CLI): only expiresAt; a refused renewal shows what was asked
  assert.equal(historico.historyDetail({ action: 'issue', detail: { expiresAt: '2026-11-11T21:00:00Z', lanes: ['odc', 'o11'] } }), 'até 11/11/2026, ODC e O11');
  assert.equal(historico.historyDetail({ action: 'issue', detail: { expiresAt: null, lanes: ['odc'] } }), 'sem validade, ODC');
  assert.equal(historico.historyDetail({ action: 'renew', detail: { days: 30, previousExpiresAt: '2026-11-11T21:00:00Z' } }), '+30 dias');
  assert.equal(labels.HISTORY_ACTION['key-rotate'], 'Chave do painel trocada');
});

test('VPS containers: the image column shows the tag only (no digest, no registry port)', () => {
  assert.equal(vps.imageTag('caddy:2.11.7-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f'), '2.11.7-alpine');
  assert.equal(vps.imageTag('ssam-server:prod-20261011-ed0f94b'), 'prod-20261011-ed0f94b');
  assert.equal(vps.imageTag('ssam-server:prod-20261011-ed0f94b@sha256:232e6a22dec2'), 'prod-20261011-ed0f94b');
  assert.equal(vps.imageTag('registry.example.com:5000/ssam-server:prod-1'), 'prod-1');
  assert.equal(vps.imageTag('ssam-server'), 'ssam-server');
});

test('Histórico: changes seen outside the console (revocation undone, record removed, earlier expiry, rename)', () => {
  assert.equal(historico.historyDetail({ action: 'unrevoke', detail: { previousRevokedAt: '2026-10-01T15:00:00Z' } }), 'revogada em 01/10/2026, voltou a valer');
  assert.equal(historico.historyDetail({ action: 'removed', detail: { previousState: 'active' } }), 'estava ativa');
  assert.equal(historico.historyDetail({ action: 'removed', detail: { previousState: 'constructor' } }), '—');
  assert.equal(historico.historyDetail({ action: 'expiry-shortened', detail: { previousExpiresAt: '2027-01-10T12:00:00Z', expiresAt: '2026-12-10T12:00:00Z' } }), '10/01/2027 → 10/12/2026');
  assert.equal(historico.historyDetail({ action: 'expiry-shortened', detail: { previousExpiresAt: null, expiresAt: '2026-12-10T12:00:00Z' } }), 'sem validade → 10/12/2026');
  assert.equal(historico.historyDetail({ action: 'renew', detail: { previousExpiresAt: '2026-11-11T21:00:00Z', expiresAt: null } }), '11/11/2026 → sem validade');
  assert.equal(historico.historyDetail({ action: 'rename', detail: { previousCustomer: 'Cliente Alfa Ltda' } }), 'antes: Cliente Alfa Ltda');
  assert.equal(labels.HISTORY_ACTION.unrevoke, 'Revogação desfeita');
  assert.equal(labels.HISTORY_ACTION['expiry-shortened'], 'Validade encurtada');
  // a word table looked up by data never answers with an inherited member
  assert.equal(labels.sessionCloseWord('constructor'), 'constructor');
  assert.equal(labels.agentCloseWord('__proto__'), '__proto__');
  assert.equal(labels.sessionCloseWord('idle'), 'inativa por 60 min');
});

test('Licenças: the capability line (read-only by CONSOLE_LICENSE_WRITES, or renew/lanes not in the image)', () => {
  const caps = (over = {}) => ({ issue: true, revoke: true, agentRotate: true, renew: true, lanes: true, readOnly: null, ...over });
  assert.equal(licencas.capabilityLine(caps()), null);
  assert.equal(licencas.capabilityLine(null), null);
  assert.match(licencas.capabilityLine(caps({ renew: false, lanes: false })), /^Renovar e mudar faixas chegam com a imagem do 24º envio/);
  const off = caps({ issue: false, revoke: false, agentRotate: false, renew: false, lanes: false, readOnly: 'sem-trava' });
  assert.equal(licencas.capabilityLine(off), 'Ações de licença desligadas: esta imagem não trava o tokens.json entre o painel e o ssam-admin. Até a imagem do 24º envio, emita, renove e revogue pelo ssam-admin (DEPLOY.md 15.4).');
  assert.equal(licencas.capabilityLine({ ...off, readOnly: 'desligado' }), 'Ações de licença desligadas neste painel (CONSOLE_LICENSE_WRITES=off).');
});

// DESIGN-QUALIDADE 4.5: the texts of the Qualidade view, against the golden payload of the design (normal, today).
const qualidade = await import(pub('js/views/qualidade.js'));
const api = await import(pub('js/api.js'));

test('qualidade: the Resumo rows of the fixture day, word for word', () => {
  const t = fixture('normal', 'quality-today').totals;
  const rows = qualidade.resumoRows(t);
  assert.deepEqual(rows.map((r) => [r.label, r.value]), [
    ['Chamadas', '54 · 10 com falha (19%)'],
    ['Entregas', '8 entregues ou criadas · 4 recusas · 0 incertas'],
    ['Cadeias até entregar', '8 entregues · 2 sem entrega'],
    ['Voltas do modelo por cadeia', 'p50 2 · p90 8'],
    ['Chamadas por cadeia', 'p50 2 · p90 18'],
    ['Recusas antes de entregar', 'p50 0 · máximo 1'],
    // the console's duration format truncates: 364 800 ms is 6 min 04 s (the design's example rounds to 05)
    ['Tempo até entregar', 'p50 46,1 s · p90 6 min 04 s'],
    ['Parado entre chamadas', 'p50 12,4 s · p90 38,1 s · 1 pausa acima de 10 min'],
    ['Parte parada das cadeias', '53%'],
    ['Problemas nas recusas', '23 · 15 com correção pronta · preflight 20 · verificação 3'],
    ['Correções automáticas', '7 em 2 chamadas'],
    ['Chamadas em paralelo', '2 (fora das tabelas de fases)'],
  ]);
  // nothing yet: zeros, dashes, singular and plural words
  const empty = qualidade.resumoRows(fixture('vazio', 'quality-7d').totals);
  assert.deepEqual(empty.map((r) => r.value), ['0 · 0 com falha', '0 entregues ou criadas · 0 recusas · 0 incertas', '0 entregues · 0 sem entrega',
    '—', '—', '—', '—', '0 pausas acima de 10 min', '—', '0 · 0 com correção pronta', '0 em 0 chamadas', '0 (fora das tabelas de fases)']);
  const one = qualidade.resumoRows({ calls: 1, failures: 0, delivered: 1, refusals: 1, uncertain: 1, chains: 1, chainsOpen: 0, longGaps: 1,
    normalizations: 1, normalizedCalls: 1, problems: 1, withPatch: 0, problemPhases: { base: 1, other: 2 } });
  assert.equal(one[1].value, '1 entregue ou criada · 1 recusa · 1 incerta');
  assert.equal(one[7].value, '1 pausa acima de 10 min');
  assert.equal(one[9].value, '1 · 0 com correção pronta · base 1 · outra 2');
  assert.equal(one[10].value, '1 em 1 chamada');
});

test('qualidade: cells and lines (time share, cold kernel, tools, Todos row, indexing, notice, privacy)', () => {
  assert.equal(qualidade.pctCell(48.9), '48,9%');
  assert.equal(qualidade.pctCell(100), '100%');
  assert.equal(qualidade.pctCell(0), '—');
  assert.equal(qualidade.pctCell(null), '—');
  assert.equal(qualidade.coldText({ kernelRuns: 10, kernelCold: 8 }), '8 de 10');
  assert.equal(qualidade.coldText({ kernelRuns: 0, kernelCold: 0 }), '—');
  assert.equal(qualidade.toolsText([{ tool: 'o11_deliver', count: 2 }, { tool: 'studio_deliver', count: 1 }]), 'o11_deliver (2), studio_deliver (1)');
  assert.equal(qualidade.toolsText([]), '—');
  const t = fixture('normal', 'quality-today').totals;
  const all = qualidade.totalRound(t);
  assert.deepEqual([all.customer, all.chains, all.open, all.turnsP50, all.turnsP90, all.idlePct], ['Todos', 8, 2, 2, 8, 52.7]);
  assert.equal(qualidade.indexingText({ state: 'running', progress: 0.42 }), 'Indexando os registros de qualidade: 42%.');
  assert.equal(qualidade.indexingText({ state: 'ready', progress: 1 }), '');
  assert.equal(qualidade.UNAVAILABLE, 'O servidor ainda não grava os registros de qualidade (imagem anterior ao registro, ou SSAM_QUALITY=0).');
  assert.equal(qualidade.PRIVACY, 'Só códigos, contagens e tempos. Nenhum nome, expressão, caminho, job ou texto dos clientes é gravado.');
  assert.equal(qualidade.LINES_ONLY_7D, 'Só para períodos de até 7 dias.');
  // the words of the tables
  assert.deepEqual(labels.VIEWS.map((v) => v.id), ['visao', 'licencas', 'uso', 'qualidade', 'agentes', 'vps', 'eventos', 'historico']);
  assert.deepEqual(labels.PHASE_KEYS.map((k) => labels.PHASE_WORD[k]),
    ['Fila', 'Captura', 'Compilação', 'Studio', 'Verificação', 'Publicação', 'Ambiente', 'Transferência', 'Servidor']);
  assert.deepEqual(Object.values(labels.CLIENT_WORD), ['Claude Code', 'claude.ai', 'Claude Desktop', 'Codex', 'Cursor', 'VS Code', 'Windsurf', 'outro', 'sem nome']);
  assert.equal(labels.wordOf(labels.RULE_TEXT, 'SORT_KEYS_SPLIT'), 'ordenação escrita com vírgulas virou lista de chaves');
  assert.equal(labels.wordOf(labels.RULE_TEXT, 'constructor'), undefined);
  // the file name of a download: the server's name, nothing else
  assert.equal(api.downloadName('attachment; filename="ssam-qualidade-erros-2026-10-12-2026-10-12.csv"'), 'ssam-qualidade-erros-2026-10-12-2026-10-12.csv');
  assert.equal(api.downloadName('attachment; filename="../../x y.csv"'), '.._.._x_y.csv');
  assert.equal(api.downloadName(null), 'ssam-qualidade');
});
