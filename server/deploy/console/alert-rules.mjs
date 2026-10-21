// Alert rules of DESIGN section 5, as one pure function of a context snapshot (built by app.mjs every 10 s), so each
// threshold can be tested without a running console. Ids are `<rule>:<subject>` (`<rule>` alone for a rule with no
// subject). Titles and details are the pt-BR texts of section 5; {d} = dd/mm/aaaa and {h} = HH:MM in the display zone.
import { pick } from './keys.mjs';
import { QUOTA_BYTES } from './workspaces.mjs';
import { ACTION_NOUN, cap, dockerState, fmt } from './texts.mjs';

const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const MIB = 1024 * 1024;
const days = n => (n === 1 ? '1 dia' : `${fmt.int(n)} dias`);
const safeKey = v => String(v ?? '?').replace(/[^A-Za-z0-9_.\-/]/g, '_').slice(0, 64);
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export const LANE_NAME = { odc: 'ODC', o11: 'O11' };

export function evaluateRules(ctx) {
  const { now, tz } = ctx;
  const out = [];
  // occurredAt (event alerts): the time of the newest occurrence; a "visto" ack holds until a newer one arrives.
  const add = (rule, key, severity, area, view, title, detail = null, subject = {}, event = false, occurredAt = null) =>
    out.push({ id: key ? `${rule}:${key}` : rule, rule, severity, area, view, title, detail, subject, event, ...(occurredAt ? { occurredAt } : {}) });
  const nameOf = token => ctx.nameOf(token) ?? token;
  const doc = ctx.hostStatus === 'ok' ? ctx.doc : null;
  const sec = name => (doc && doc[name] && doc[name].ok === true ? doc[name] : null);

  for(const row of ctx.studioVersions?.rows??[])if(row.status==='unserved'&&row.customers>0){
    const studio=row.lane==='odc'?'ODC Studio':'Service Studio';
    add('studio-version-unserved',row.lane+'-'+row.version,'warning','servidor','visao',studio+' '+row.version+' not served: '+row.customers+' customers',
      'Review the local watcher proposal before changing the versions window.',{lane:row.lane,version:row.version});
  }
  // ---- licenses
  for (const t of ctx.licenses ?? []) {
    const exp = t.expiresAt ? Date.parse(t.expiresAt) : null;
    const subject = { token: t.id, customer: t.customer };
    if (t.state === 'active' && exp != null) {
      const left = exp - now;
      if (left > 0 && left <= 7 * DAY) {
        const title = tz.day(exp) === tz.day(now) ? `Licença de ${t.customer} vence hoje às ${tz.hm(exp)}.`
          : `Licença de ${t.customer} vence em ${days(Math.max(1, tz.dayDiff(now, exp)))} (${tz.dmy(exp)}).`;
        add('licenca-vence', t.id, left <= 2 * DAY ? 'critical' : 'warning', 'licencas', 'licencas', title,
          'Renove em Licenças. Ao vencer, as sessões e o canal do agente dele são fechados.', subject);
      }
    }
    if (t.state === 'expired' && exp != null && now - exp <= 7 * DAY && ctx.activityBetween(t.id, exp - 14 * DAY, exp)) {
      add('licenca-venceu', t.id, 'warning', 'licencas', 'licencas',
        `Licença de ${t.customer} venceu em ${tz.dmy(exp)} e ele usou o SSAM nos 14 dias anteriores.`, 'Renove se o contrato continua.', subject);
    }
  }
  const unreadableRecent = ctx.tokensUnreadableAt && now - Date.parse(ctx.tokensUnreadableAt) <= 10 * MIN;
  if (ctx.licensesError || unreadableRecent) {
    add('licencas-ilegiveis', null, 'critical', 'licencas', 'licencas',
      'O arquivo de licenças (tokens.json) não pode ser lido: o servidor responde 500 e fecha as sessões abertas.',
      ctx.licensesError ?? 'tokens-unreadable');
  }
  const changes = new Map();
  for (const a of ctx.access ?? []) {
    if (now - Date.parse(a.time) > 30 * DAY) continue;
    const key = `${a.token}:${safeKey(a.machine?.id ?? a.machine?.name)}`;
    const cur = changes.get(key);
    if (!cur || cur.time < a.time) changes.set(key, a);
  }
  for (const [key, a] of changes) {
    const c = ctx.nameOf(a.token) ?? a.customer ?? a.token;
    const m = a.machine ?? {}, f = a.first ?? {};
    add('acesso-outra-maquina', key, 'critical', 'licencas', 'licencas',
      `Credencial do agente de ${c} usada em outra máquina: ${m.name ?? '?'} (${m.user ?? '?'}) em vez de ${f.name ?? '?'} (${f.user ?? '?'}), IP ${a.ip ?? '?'}, ${tz.dmy(a.time)} ${tz.hm(a.time)}.`,
      'Se não foi o cliente, troque a credencial do agente ou revogue a licença.',
      { token: a.token, customer: c, machine: m.name ?? null, ip: a.ip ?? null }, true, a.time);
  }
  // License notices (licenses.mjs, 30 days): event alerts, "visto" until a newer notice. A revocation undone stops
  // firing once the license is revoked again; a removed record once it is back in the file. While tokens.json cannot be
  // read the state is unknown and they keep firing.
  const known = Array.isArray(ctx.licenses);
  const byId = new Map((ctx.licenses ?? []).map(t => [t.id, t]));
  for (const n of ctx.licenseNotices ?? []) {
    const at = Date.parse(n.at);
    if (Number.isNaN(at) || now - at > 30 * DAY) continue;
    const c = cap(n.customer ?? null, 64) ?? n.token;
    const key = `${n.token}:${safeKey(n.at)}`;
    const subject = { token: n.token, customer: c };
    const when = `${tz.dmy(at)} ${tz.hm(at)}`;
    if (n.kind === 'unrevoke') {
      const t = byId.get(n.token);
      if (known && (!t || t.state === 'revoked')) continue;
      add('revogacao-desfeita', key, 'critical', 'licencas', 'licencas',
        `A revogação da licença de ${c} foi desfeita fora do painel (${when}): o token e a credencial do agente voltaram a valer.`,
        'Restore de um backup antigo ou tokens.json editado à mão. Se não foi você, revogue de novo em Licenças.', subject, true, n.at);
    } else if (n.kind === 'removed') {
      if (known && byId.has(n.token)) continue;
      add('licenca-removida', key, 'warning', 'licencas', 'licencas',
        `A licença de ${c} (${n.token}) sumiu do tokens.json fora do painel (${when}).`,
        'O token e a credencial do agente dela deixaram de valer. Restore de um backup antigo ou edição à mão; se não foi você, confira o Histórico.',
        subject, true, n.at);
    } else if (n.kind === 'unconfirmed') {
      add('gravacao-nao-confirmada', key, 'critical', 'licencas', 'licencas',
        `${pick(ACTION_NOUN, n.action) ?? 'Ação'} da licença de ${c} não se confirmou no tokens.json (${when}): outro processo gravou o arquivo ao mesmo tempo.`,
        'Confira a licença em Licenças e repita a ação. Sem a trava do 24º envio, não rode o ssam-admin enquanto o painel grava (DEPLOY.md 15.4).',
        subject, true, n.at);
    }
  }
  const revoked = new Set((ctx.licenses ?? []).filter(t => t.state === 'revoked').map(t => t.id));
  for (const [token, w] of Object.entries(ctx.workspaces ?? {})) {
    if (revoked.has(token) || !(w?.bytes >= 0)) continue;
    const pct = (w.bytes / QUOTA_BYTES) * 100;
    if (pct >= 80) {
      add('espaco-cliente', token, pct >= 95 ? 'critical' : 'warning', 'licencas', 'licencas',
        `Espaço de trabalho de ${nameOf(token)} em ${fmt.pct(pct)}% da cota de 5 GiB (${fmt.bytes(w.bytes)}).`,
        'Acima da cota as chamadas recebem WORKSPACE_FULL.', { token, customer: nameOf(token) });
    }
  }

  // ---- sessions, usage, agents, server log
  const limit = ctx.maxSessions ?? 8;
  for (const [token, n] of Object.entries(ctx.sessionsByToken ?? {})) {
    if (n >= limit) add('sessoes-limite', token, 'info', 'agentes', 'agentes', `${nameOf(token)} está no limite de ${limit} sessões MCP abertas.`,
      'A próxima sessão substitui a mais antiga sem fluxo aberto.', { token, customer: nameOf(token) });
  }
  const w15 = ctx.calls15 ?? { calls: 0, failures: 0 };
  if (w15.calls > 0) {
    const ratio = w15.failures / w15.calls;
    const crit = w15.failures >= 30 && ratio >= 0.5;
    if (crit || (w15.failures >= 10 && ratio >= 0.25)) {
      add('pico-falhas', null, crit ? 'critical' : 'warning', 'uso', 'uso',
        `Pico de falhas: ${w15.failures} de ${w15.calls} chamadas falharam nos últimos 15 min (mais comum: ${w15.topCode ?? '?'} em ${w15.topTool ?? '?'}).`);
    }
  }
  for (const a of ctx.agentFailures15 ?? []) {
    if (a.failures >= 10) add('falhas-agente', a.token, 'warning', 'agentes', 'agentes',
      `${a.failures} chamadas ao agente de ${nameOf(a.token)} falharam nos últimos 15 min (mais comum: ${a.topCode ?? '?'}).`, null,
      { token: a.token, customer: nameOf(a.token) });
  }
  const errs = ctx.serverErrors ?? [];
  if (errs.length) {
    const last = errs[errs.length - 1];
    add('erro-servidor', null, 'warning', 'servidor', 'eventos',
      `O servidor registrou ${errs.length} erro(s) interno(s) na última hora (${last.event}: ${last.error ?? '?'}).`);
  }
  if (ctx.serverLogB > 512 * MIB) {
    add('log-grande', null, 'warning', 'servidor', 'vps', `server.log com ${fmt.bytes(ctx.serverLogB)}: rode a rotação (DEPLOY.md seção 10).`);
  }

  // ---- containers and server (host.json)
  const docker = sec('docker');
  const server = sec('server');
  const facts = ctx.facts ?? {};
  const containers = Array.isArray(docker?.containers) ? docker.containers : [];
  const srv = containers.find(c => c.service === 'ssam-server') ?? null;
  if (docker) {
    if (!srv || srv.state !== 'running') {
      add('servidor-fora', null, 'critical', 'servidor', 'vps', `O container ssam-server está ${dockerState(srv?.state)}.`, null, { container: 'ssam-server' });
    } else if (srv.health === 'unhealthy') {
      const since = Date.parse(facts.unhealthySince ?? doc.collectedAt);
      add('servidor-fora', null, 'critical', 'servidor', 'vps', `O ssam-server está unhealthy há ${fmt.duration(now - since)}.`, null, { container: 'ssam-server' });
    } else if (server?.health?.probe?.available && (facts.probeFails ?? 0) >= 2) {
      add('servidor-fora', null, 'critical', 'servidor', 'vps', 'O /health do ssam-server não responde a partir da VPS.', null, { container: 'ssam-server' });
    }
    const caddy = containers.find(c => c.service === 'caddy') ?? null;
    if (!caddy || caddy.state !== 'running') {
      add('caddy-fora', null, 'critical', 'servidor', 'vps', `O Caddy está ${dockerState(caddy?.state)}: ninguém de fora alcança o servidor.`, null, { container: 'caddy' });
    }
    for (const c of containers) {
      const service = cap(c.service || c.name || '?', 64);
      if (c.oomKilled === true) add('container-oom', safeKey(service), 'critical', 'servidor', 'vps', `${service} foi encerrado por falta de memória (OOM).`,
        'Suba SSAM_MEMORY ou baixe SSAM_BUILD_WORKERS (DEPLOY.md seção 10).', { container: service });
    }
    if (srv && num(srv.memB) != null && num(srv.memLimitB)) {
      const pct = (srv.memB / srv.memLimitB) * 100;
      if (pct >= 85) add('memoria-container', 'ssam-server', pct >= 95 ? 'critical' : 'warning', 'vps', 'vps',
        `ssam-server usa ${fmt.pct(pct)}% do limite de memória (${fmt.bytes(srv.memB)} de ${fmt.bytes(srv.memLimitB)}).`, null, { container: 'ssam-server' });
    }
  }
  for (const [service, n] of Object.entries(ctx.restarts24h ?? {})) {
    if (n > 0) add('container-reiniciou', safeKey(service), 'warning', 'servidor', 'vps', `${service} reiniciou ${n} vez(es) nas últimas 24 h.`, null, { container: service });
  }
  if (server && srv && srv.state === 'running') {
    const startup = server.startup ?? {};
    const warm = startup.warm ?? null;
    const startedAt = Date.parse(srv.startedAt ?? startup.startedAt);
    const odcWorker = (server.processes ?? []).some(p => p.kind === 'odc-worker');
    if (!warm) {
      if (now - startedAt > 6 * MIN) add('nao-aquecido', 'aquecimento', 'warning', 'servidor', 'vps',
        `O servidor subiu há ${fmt.duration(now - startedAt)} e não terminou o aquecimento.`);
    } else {
      if (warm.indexes && warm.indexes.ok === false) {
        const lanes = Object.entries(warm.indexes.lanes ?? {}).filter(([, v]) => v && v.ok === false);
        const lane = lanes.length ? lanes.map(([k]) => pick(LANE_NAME, k) ?? cap(k, 20)).join(' e ') : 'ODC e O11';
        const error = cap((lanes[0]?.[1]?.error ?? warm.indexes.error) || 'erro', 200);
        add('nao-aquecido', 'indice', 'warning', 'servidor', 'vps', `Aquecimento: o índice ${lane} falhou (${error}).`);
      }
      const builder = warm.delivery?.builder, worker = warm.delivery?.worker;
      if (builder && builder.ok === false) add('nao-aquecido', 'builder', 'warning', 'servidor', 'vps',
        `Aquecimento: o builder residente não subiu (${cap(builder.note || 'sem nota', 200)}).`);
      if (worker && worker.ok === false) {
        if (odcWorker) add('aquecimento-parcial', null, 'info', 'servidor', 'vps', 'O worker ODC falhou no aquecimento, mas está rodando agora (subiu sob demanda).');
        else add('nao-aquecido', 'worker', 'warning', 'servidor', 'vps', `Aquecimento: o worker ODC não subiu (${cap(worker.note || 'sem nota', 200)}).`);
      }
    }
  }
  const kernel = server?.startup?.kernel?.kernel ?? null;
  if (kernel && typeof kernel === 'object') {
    if (kernel.o11 == null || kernel.odcBridge == null) {
      add('kernel-ausente', null, 'critical', 'servidor', 'vps',
        'O servidor partiu sem kernel.json válido (o11 ou odcBridge nulos): as faixas hospedadas recusam chamadas.', 'DEPLOY.md seção 7.1.');
    }
    const drift = kernelDrift(kernel, ctx.kernelFile);
    if (drift.length) {
      const [field, running, file] = drift[0];
      add('kernel-mudou', null, 'warning', 'servidor', 'vps',
        `kernel.json mudou depois da partida (${field}: ${running} → ${file}); só vale depois de reiniciar o ssam-server.`);
    }
  }

  // ---- TLS, host, backups, updates, security, Caddy, Coolify
  const tls = sec('tls');
  if (tls) {
    const certs = Array.isArray(tls.certs) ? tls.certs : [];
    if (!certs.length) add('certificado-ausente', null, 'critical', 'tls', 'vps', 'Nenhum certificado TLS encontrado no volume do Caddy.');
    for (const c of certs) {
      const end = Date.parse(c.notAfter);
      if (Number.isNaN(end)) continue;
      const left = end - now;
      if (left < 21 * DAY) add('certificado', safeKey(c.name), left < 7 * DAY ? 'critical' : 'warning', 'tls', 'vps',
        `Certificado TLS de ${cap(c.name ?? '?', 120)} vence em ${days(Math.max(0, Math.floor(left / DAY)))} (${tz.dmy(end)}); o Caddy renova com 30 dias, veja o log dele.`);
    }
  }
  const host = sec('host');
  if (host) {
    for (const d of Array.isArray(host.disks) ? host.disks : []) {
      const mount = cap(d.mount ?? '?', 64);
      if (num(d.usedPct) != null && d.usedPct >= 80) add('disco', safeKey(mount), d.usedPct >= 90 ? 'critical' : 'warning', 'vps', 'vps',
        `Disco ${mount} em ${fmt.pct(d.usedPct)}% (${fmt.bytes(d.usedB)} de ${fmt.bytes(d.sizeB)}).`, null, { mount });
      if (num(d.inodesPct) != null && d.inodesPct >= 80) add('disco', `${safeKey(mount)}:inodes`, d.inodesPct >= 90 ? 'critical' : 'warning', 'vps', 'vps',
        `Inodes de ${mount} em ${fmt.pct(d.inodesPct)}%.`, null, { mount });
    }
    if (host.time && host.time.ntpSynced === false) add('relogio', null, 'warning', 'vps', 'vps', 'O relógio da VPS não está sincronizado (NTP).');
    if (num(host.failedUnits) > 0) add('unidades-falhas', null, 'warning', 'vps', 'vps', `${host.failedUnits} unidade(s) do systemd com falha.`);
  }
  const samples = (facts.samples ?? []).filter(s => s.availPct != null);
  if (samples.length >= 2) {
    const [a, b] = samples.slice(-2);
    if (a.availPct < 15 && b.availPct < 15) add('memoria', null, a.availPct < 7 && b.availPct < 7 ? 'critical' : 'warning', 'vps', 'vps',
      `Memória disponível da VPS em ${fmt.pct(b.availPct)}% (${fmt.bytes(b.availB)}); sem swap, um pico pode derrubar o servidor.`);
  }
  const loads = (facts.samples ?? []).filter(s => Date.parse(s.t) > now - 5 * MIN && s.load1 != null && s.nproc);
  if (loads.length && Date.parse(loads[0].t) <= now - 4 * MIN && loads.every(s => s.load1 / s.nproc >= 2)) {
    const last = loads[loads.length - 1];
    add('carga', null, 'warning', 'vps', 'vps', `Carga da VPS em ${fmt.dec2(last.load1)} com ${last.nproc} vCPU há 5 min.`);
  }
  const backups = sec('backups');
  if (backups) {
    const newest = backups.newest ?? null;
    const newestAt = newest ? Date.parse(newest.mtime) : null;
    if (!newest) add('backup-ausente', null, 'critical', 'backup', 'vps', `Nenhum backup do estado em ${cap(backups.dir ?? '?', 120)}.`,
      'DEPLOY.md seção 9; o cron diário instala com host/install.sh --with-crons.');
    else if (now - newestAt > 26 * HOUR) add('backup-velho', null, 'critical', 'backup', 'vps',
      `O último backup tem ${Math.floor((now - newestAt) / HOUR)} h (limite 26 h): ${cap(newest.name ?? '?', 120)}.`);
    const lines = (Array.isArray(backups.cronLogTail) ? backups.cronLogTail : []).map(String).filter(l => l.startsWith('backup:'));
    const lastLine = lines[lines.length - 1];
    if (lastLine && /FAILED/.test(lastLine)) {
      const at = Date.parse((/ at (\S+)/.exec(lastLine) ?? [])[1]);
      if (!newest || Number.isNaN(at) || at > newestAt) add('backup-falhou', null, 'critical', 'backup', 'vps', `O último backup falhou: ${cap(lastLine, 200)}.`);
    }
    if (backups.cron && backups.cron.backup === false) add('backup-sem-cron', null, 'warning', 'backup', 'vps',
      'O backup diário não está agendado (falta /etc/cron.d/ssam-backup).');
    if (backups.cron && backups.cron.rotate === false) add('rotacao-sem-cron', null, 'warning', 'backup', 'vps',
      `A rotação de logs não está agendada: o server.log tem ${fmt.bytes(ctx.serverLogB ?? 0)} e só cresce.`);
  }
  const updates = sec('updates');
  if (updates) {
    const since = updates.rebootRequired ? Date.parse(updates.rebootSince ?? facts.rebootSeenAt ?? '') : NaN;
    if (updates.rebootRequired && !Number.isNaN(since) && now - since > DAY) {
      const pkgs = Array.isArray(updates.rebootPkgs) && updates.rebootPkgs.length ? cap(updates.rebootPkgs.join(', '), 160) : 'pacotes não informados';
      add('reinicio-pendente', null, 'warning', 'vps', 'vps', `Reinício da VPS pendente desde ${tz.dmy(since)} (${pkgs}).`,
        'Reiniciar derruba sessões e chamadas em curso: escolha uma janela.');
    }
    const secSince = Date.parse(facts.securitySince ?? '');
    if (num(updates.security) > 0 && !Number.isNaN(secSince) && now - secSince > 2 * DAY) {
      add('atualizacoes-seguranca', null, 'warning', 'vps', 'vps',
        `${updates.security} atualização(ões) de segurança pendente(s) há ${Math.floor((now - secSince) / DAY)} dias.`);
    }
  }
  const security = sec('security');
  if (security) {
    const ssh = security.ssh ?? {};
    if (ssh.passwordAuth === true) {
      const root = ssh.permitRootLogin === 'yes' ? ' e root com senha' : '';
      const f2b = ssh.fail2ban === 'active' ? '' : ', sem fail2ban';
      add('ssh-senha', null, 'warning', 'seguranca', 'vps', `SSH aceita login por senha${root}; ${num(ssh.failures24h) ?? 0} tentativas falhas em 24 h${f2b}.`,
        'Com acesso só por chave: PasswordAuthentication no e PermitRootLogin prohibit-password.');
    }
    const ufw = security.ufw ?? {};
    if (ufw.active === false) add('firewall', null, 'critical', 'seguranca', 'vps', 'Firewall (ufw) inativo.');
    else if (ufw.active === true) {
      const extra = [...new Set((Array.isArray(ufw.allowIn) ? ufw.allowIn : []).map(String)
        .filter(p => !['22', '80', '443'].includes(p.split('/')[0].trim())).map(p => cap(p, 40)))];
      if (extra.length) add('firewall', null, 'warning', 'seguranca', 'vps', `Firewall libera portas além de 22, 80 e 443: ${extra.join(', ')}.`);
    }
  }
  const caddyLog = sec('caddy');
  if (caddyLog) {
    const byIp = new Map();
    let n429 = 0;
    for (const r of Array.isArray(caddyLog.last15m?.denied) ? caddyLog.last15m.denied : []) {
      const status = Number(r?.status), count = num(r?.count) ?? 0;
      if (status === 401 || status === 403) byIp.set(cap(r.ip ?? '?', 64), (byIp.get(cap(r.ip ?? '?', 64)) ?? 0) + count);
      if (status === 429) n429 += count;
    }
    for (const [ip, n] of byIp) if (n >= 50) add('recusas-acesso', safeKey(ip), 'warning', 'seguranca', 'uso',
      `${n} acessos recusados (401/403) vindos de ${ip} nos últimos 15 min.`, 'O servidor não registra 401/403; o dado vem do log do Caddy, só por IP.', { ip });
    const by429 = num(caddyLog.last15m?.byStatus?.['429']);
    const total429 = by429 ?? n429;
    if (total429 > 0) add('limite-taxa', null, 'info', 'uso', 'uso', `${total429} resposta(s) 429 (limite de taxa) nos últimos 15 min.`);
  }
  const coolify = sec('coolify');
  for (const c of Array.isArray(coolify?.containers) ? coolify.containers : []) {
    if (c.state === 'running') add('coolify-rodando', safeKey(c.name), 'warning', 'servidor', 'vps',
      `Container do Coolify ${cap(c.name ?? '?', 64)} está rodando (foi parado de propósito; o coolify-proxy disputa as portas 80 e 443).`, null, { container: cap(c.name ?? '?', 64) });
  }

  // ---- collector and console
  if (ctx.hostStatus === 'missing') add('coletor', null, 'critical', 'coletor', 'vps', 'O coletor da VPS não está instalado ou nunca rodou (host/install.sh).');
  else if (ctx.hostStatus === 'invalid') add('coletor', null, 'warning', 'coletor', 'vps', `host.json em formato desconhecido (${cap(ctx.hostSchema ?? '?', 60)}); atualize o coletor (host/install.sh).`);
  else if (doc) {
    const at = Date.parse(doc.collectedAt);
    const age = now - at;
    if (age > 120000) add('coletor', null, age > 600000 ? 'critical' : 'warning', 'coletor', 'vps',
      `O coletor da VPS parou: últimos dados às ${tz.hm(at)} (há ${fmt.duration(age)}).`);
    const failed = ctx.failedSections ?? [];
    if (failed.length) add('coleta-parcial', null, 'info', 'coletor', 'vps', `Coleta parcial: ${failed.map(f => f.name).join(', ')} falharam (${failed[0].error}).`);
  }
  for (const [file, code] of Object.entries(ctx.readProblems ?? {})) {
    if (['EACCES', 'EIO', 'EPERM'].includes(code)) add('painel-leitura', safeKey(file), 'critical', 'painel', 'visao', `O painel não consegue ler ${cap(file, 80)} (${code}).`);
  }
  if (ctx.lossAt && now - Date.parse(ctx.lossAt) <= DAY) {
    add('eventos-perdidos', null, 'info', 'painel', 'eventos', 'Parte do server.log girado não pôde ser lida; a contagem desse trecho pode faltar.');
  }
  return out;
}

// [[field, running, file]] for every field of kernel.json that differs from the running `kernel` event.
export function kernelDrift(running, file) {
  if (!running || !file) return [];
  const show = v => (v == null ? '—' : Array.isArray(v) ? v.join(', ') || '—' : cap(String(v), 40));
  const norm = v => (v == null ? null : Array.isArray(v) ? v.map(String).join(',') : String(v));
  const out = [];
  for (const field of ['o11', 'odc', 'odcBridge', 'o11Hook', 'odcBridgeAccepted']) {
    if (norm(running[field]) !== norm(file[field])) out.push([field, show(running[field]), show(file[field])]);
  }
  return out;
}
