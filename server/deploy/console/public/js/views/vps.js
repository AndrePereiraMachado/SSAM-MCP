// VPS (DESIGN.md 6.5): host, updates, security and SSAM server as key-value tables (sparklines of the last 24 h in
// their own column), then containers, volumes, TLS certificates and backups. Polls every 10 s.

import * as F from '../format.js';
import { h, clear, dot, status, sectionHead } from '../dom.js';
import { createTable, kvTable } from '../table.js';
import { sparkline, sparkLabel, fmtSparkDecimal } from '../sparkline.js';
import { CONTAINER_STATE, HEALTH_WORD } from '../labels.js';
import { errorMessage, staleText, muted } from './common.js';

const okSection = (s) => s && s.ok !== false;
const unavailable = (s) => `indisponível (${s?.error || 'sem dados'})`;

function series(points, key) {
  return (points || []).map((p) => (p && p[key] != null ? p[key] : null));
}

function spark(points, key, prefix, fmt = fmtSparkDecimal) {
  const vals = series(points, key);
  if (!vals.some((v) => v != null)) return null;
  return sparkline(vals, sparkLabel(prefix, vals, { fmt, span: '24 h', lastLabel: 'agora' }));
}

/** Rows of the Host block. */
export function hostRows(host, pts) {
  if (!okSection(host)) return [{ label: 'Host', value: unavailable(host), level: 'warn' }];
  const rows = [];
  rows.push({ label: 'Sistema', value: [host.os, host.hostname].filter(Boolean).join(' · ') || F.DASH });
  rows.push({ label: 'Kernel', value: host.kernel || F.DASH, mono: true });
  rows.push({
    label: 'No ar desde',
    value: host.bootAt ? `${F.fmtDateTime(host.bootAt)} (${F.fmtDuration((host.uptimeS || 0) * 1000)})` : F.DASH,
    title: host.bootAt ? F.fmtTitle(host.bootAt) : null,
  });
  const cpu = host.cpu || {};
  rows.push({
    label: 'CPU',
    value: `${F.fmtPctFine(cpu.pct)} · iowait ${F.fmtPctFine(cpu.iowaitPct)} · steal ${F.fmtPctFine(cpu.stealPct)}`,
    spark: spark(pts, 'cpuPct', 'CPU em %'),
  });
  const load = Array.isArray(host.load) ? host.load : [];
  rows.push({
    label: 'Carga',
    value: `${load.map((v) => F.fmtNum2(v)).join(' · ') || F.DASH} (${host.nproc ?? '?'} vCPU)`,
    level: load[0] != null && host.nproc && load[0] / host.nproc >= 2 ? 'warn' : '',
    spark: spark(pts, 'load1', 'Carga de 1 minuto', (v) => F.fmtNum2(v)),
  });
  const mem = host.mem || {};
  if (mem.totalB) {
    const used = mem.totalB - (mem.availableB ?? 0);
    const availPct = ((mem.availableB ?? 0) / mem.totalB) * 100;
    rows.push({
      label: 'Memória',
      value: `${F.fmtBytes(used)} usados de ${F.fmtBytes(mem.totalB)} · ${F.fmtPct(availPct)} disponível`,
      level: availPct < 7 ? 'bad' : availPct < 15 ? 'warn' : '',
      spark: spark(pts, 'memUsedPct', 'Memória usada em %'),
    });
    rows.push({
      label: 'Swap',
      value: mem.swapTotalB ? `${F.fmtBytes(mem.swapUsedB ?? 0)} usados de ${F.fmtBytes(mem.swapTotalB)}` : 'sem swap',
    });
  }
  for (const d of host.disks || []) {
    const lvl = Math.max(d.usedPct ?? 0, d.inodesPct ?? 0);
    rows.push({
      label: `Disco ${d.mount}`,
      value: `${F.fmtBytes(d.usedB)} de ${F.fmtBytes(d.sizeB)} (${F.fmtPct(d.usedPct)}) · inodes ${F.fmtPct(d.inodesPct)}`,
      level: lvl >= 90 ? 'bad' : lvl >= 80 ? 'warn' : '',
      title: d.fs ? `sistema de arquivos ${d.fs}` : null,
    });
  }
  const net = host.net || {};
  rows.push({
    label: `Rede ${net.iface || ''}`.trim(),
    value: `↓ ${F.fmtRate(net.rxBps)} · ↑ ${F.fmtRate(net.txBps)}`,
    spark: spark(pts, 'rxBps', 'Rede, entrada', (v) => F.fmtRate(v)),
  });
  const t = host.time || {};
  rows.push({
    label: 'Relógio',
    value: `${t.ntpSynced ? 'sincronizado (NTP)' : 'não sincronizado'} · ${t.tz || F.DASH}`,
    level: t.ntpSynced === false ? 'warn' : '',
  });
  rows.push({ label: 'Unidades com falha', value: F.fmtInt(host.failedUnits ?? 0), level: host.failedUnits > 0 ? 'warn' : '' });
  const psi = host.psi || {};
  rows.push({
    label: 'Pressão (PSI 10 s)',
    value: `cpu ${F.fmtNumMax1(psi.cpuSome10 ?? 0)} · memória ${F.fmtNumMax1(psi.memSome10 ?? 0)} · io ${F.fmtNumMax1(psi.ioSome10 ?? 0)}`,
  });
  return rows;
}

export function updatesRows(u) {
  if (!okSection(u)) return [{ label: 'Atualizações', value: unavailable(u), level: 'warn' }];
  const pk = Array.isArray(u.packages) ? u.packages : [];
  const rows = [{
    label: 'Pacotes atualizáveis',
    value: `${F.fmtInt(u.upgradable ?? 0)} (${F.fmtInt(u.security ?? 0)} de segurança)`,
    title: pk.join(', ') || null,
    level: u.security > 0 ? 'warn' : '',
  }];
  const rp = Array.isArray(u.rebootPkgs) && u.rebootPkgs.length ? ` (${u.rebootPkgs.join(', ')})` : '';
  rows.push({
    label: 'Reinício pendente',
    value: u.rebootRequired ? `sim, desde ${F.fmtDateTime(u.rebootSince)}${rp}` : 'não',
    level: u.rebootRequired ? 'warn' : '',
  });
  const un = u.unattended || {};
  rows.push({
    label: 'unattended-upgrades',
    value: un.enabled ? `ativo · última execução ${F.fmtDateTime(un.lastRunAt)}` : 'inativo',
    title: un.lastSuccessAt ? `último sucesso ${F.fmtTitle(un.lastSuccessAt)}` : null,
  });
  return rows;
}

const UFW_WORD = { deny: 'negar', allow: 'permitir', reject: 'rejeitar', disabled: 'desativado' };

export function securityRows(s) {
  if (!okSection(s)) return [{ label: 'Segurança', value: unavailable(s), level: 'warn' }];
  const ufw = s.ufw || {};
  const ssh = s.ssh || {};
  const allow = Array.isArray(ufw.allowIn) ? ufw.allowIn : [];
  const extra = allow.filter((p) => !['22/tcp', '80/tcp', '443/tcp'].includes(p));
  const top = Array.isArray(ssh.topSources) ? ssh.topSources : [];
  return [
    {
      label: 'Firewall (ufw)',
      value: ufw.active
        ? `ativo · entrada: ${UFW_WORD[ufw.defaultIncoming] || ufw.defaultIncoming || F.DASH} · saída: ${UFW_WORD[ufw.defaultOutgoing] || ufw.defaultOutgoing || F.DASH}`
        : 'inativo',
      level: ufw.active ? '' : 'bad',
      title: Array.isArray(ufw.rules) ? ufw.rules.join('\n') : null,
    },
    { label: 'Portas liberadas', value: allow.join(', ') || 'nenhuma', level: extra.length ? 'warn' : '' },
    { label: 'SSH: senha', value: ssh.passwordAuth ? 'aceita' : 'recusada', level: ssh.passwordAuth ? 'warn' : '' },
    { label: 'SSH: root', value: ssh.permitRootLogin || F.DASH, mono: true },
    { label: 'fail2ban', value: ssh.fail2ban === 'active' ? 'ativo' : ssh.fail2ban === 'absent' ? 'ausente' : (ssh.fail2ban || F.DASH) },
    {
      label: 'Falhas de login SSH em 24 h',
      value: `${F.fmtInt(ssh.failures24h ?? 0)}${top.length ? ` · principais: ${top.map((t) => `${t.ip} (${F.fmtInt(t.count)})`).join(', ')}` : ''}`,
    },
  ];
}

function kernelText(k) {
  if (!k) return F.DASH;
  const kk = k.kernel && typeof k.kernel === 'object' ? k.kernel : k;
  const acc = Array.isArray(kk.odcBridgeAccepted) && kk.odcBridgeAccepted.length ? ` (aceita ${kk.odcBridgeAccepted.join(', ')})` : '';
  return `O11 ${kk.o11 ?? 'nulo'} · ODC ${kk.odc ?? 'nulo'} · bridge ${kk.odcBridge ?? 'nula'}${acc}`;
}

export function warmText(w) {
  if (!w) return F.DASH;
  const parts = [];
  const secs = w.ms != null ? ` em ${F.fmtInt(Math.round(w.ms / 1000))} s` : '';
  const head = { warm: `ok${secs}`, partial: `parcial${secs}`, warming: 'aquecendo', cold: 'não aquecido' }[w.state] || 'desconhecido';
  parts.push(head);
  const lanes = w.indexes?.lanes || {};
  const names = { odc: 'ODC', o11: 'O11' };
  const okL = Object.keys(lanes).filter((l) => lanes[l]?.ok).map((l) => names[l] || l);
  const badL = Object.keys(lanes).filter((l) => lanes[l] && !lanes[l].ok).map((l) => names[l] || l);
  if (okL.length) parts.push(`${okL.length > 1 ? 'índices' : 'índice'} ${okL.join(' e ')} ok`);
  for (const l of badL) parts.push(`índice ${l} falhou`);
  const d = w.delivery || {};
  if (d.builder) parts.push(d.builder.ok ? 'builder ok' : 'builder falhou');
  if (d.worker) {
    if (d.worker.ok) parts.push('worker ODC ok');
    else parts.push(w.workerRunning ? 'worker ODC falhou e subiu depois' : 'worker ODC falhou');
  }
  return parts.join(' · ');
}

export function serverRows(srv) {
  if (!srv) return [{ label: 'Servidor SSAM', value: 'sem dados' }];
  const img = srv.image || {};
  const k = srv.kernel || {};
  const hl = srv.health || {};
  const probe = hl.probe || {};
  const logs = srv.logs || {};
  let probeTxt;
  if (!probe.available) probeTxt = 'sem sonda ainda';
  else if (probe.ok) probeTxt = `ok em ${F.fmtDuration(probe.ms)}`;
  else probeTxt = `falhou (${probe.error || 'sem resposta'})`;
  const dockerTxt = HEALTH_WORD[hl.docker] || (hl.docker ? String(hl.docker) : 'sem verificação');
  return [
    { label: 'Imagem', value: img.tag || F.DASH, mono: true },
    { label: 'Revisão', value: img.revision ? String(img.revision).slice(0, 7) : F.DASH, mono: true, title: img.revision || null },
    { label: 'Criada em', value: img.created ? F.fmtDateTime(img.created) : F.DASH, title: img.created ? F.fmtTitle(img.created) : null },
    { label: 'Kernel em uso', value: kernelText(k.running) },
    {
      label: 'kernel.json',
      value: !k.file ? 'não lido' : k.drift ? `mudou: ${(k.driftFields || []).join(', ') || 'campos'}` : 'igual ao em uso',
      level: k.drift ? 'warn' : '',
    },
    { label: 'Aquecimento', value: warmText(srv.warm), level: srv.warm && srv.warm.state !== 'warm' ? 'warn' : '' },
    { label: '/health', value: `${probeTxt} · Docker: ${dockerTxt}`, level: probe.available && !probe.ok ? 'bad' : hl.docker === 'unhealthy' ? 'bad' : '' },
    { label: 'server.log', value: `${F.fmtBytes(logs.serverLogB)} · ${F.plural(logs.rotatedCount ?? 0, 'girado', 'girados')}${logs.rotatedB ? ` (${F.fmtBytes(logs.rotatedB)})` : ''}` },
    {
      label: 'Auditoria',
      value: `${F.plural(logs.auditFiles ?? 0, 'arquivo', 'arquivos')} · ${F.fmtBytes(logs.auditB ?? 0)}${logs.consoleAuditB != null ? ` · histórico do painel ${F.fmtBytes(logs.consoleAuditB)}` : ''}`,
    },
  ];
}

export function backupRows(b, now) {
  if (!okSection(b)) return [{ label: 'Backups', value: unavailable(b), level: 'warn' }];
  const n = b.newest;
  const cron = b.cron || {};
  const rows = [{
    label: 'Último backup',
    value: n ? `${n.name} · ${F.fmtBytes(n.sizeB)} · ${F.fmtRelative(n.mtime, now)}` : 'nenhum',
    level: !n ? 'bad' : (n.ageH ?? 0) > 26 ? 'bad' : '',
    title: n?.mtime ? F.fmtTitle(n.mtime) : null,
  }];
  if (n) {
    const has = [n.sha256File && 'sha256', n.infoFile && '.info'].filter(Boolean);
    const miss = [!n.sha256File && 'sha256', !n.infoFile && '.info'].filter(Boolean);
    rows.push({
      label: 'Conferência',
      value: miss.length ? `falta ${miss.join(' e ')}` : `${has.join(' e ')} presentes`,
      level: miss.length ? 'warn' : '',
    });
    rows.push({ label: 'Imagem do backup', value: [n.image, n.revision ? String(n.revision).slice(0, 7) : null, n.mode].filter(Boolean).join(' · ') || F.DASH });
  }
  rows.push({ label: 'Agendamento do backup', value: `/etc/cron.d/ssam-backup: ${cron.backup ? 'sim' : 'não'}`, level: cron.backup ? '' : 'warn' });
  rows.push({ label: 'Agendamento da rotação', value: `/etc/cron.d/ssam-rotate: ${cron.rotate ? 'sim' : 'não'}`, level: cron.rotate ? '' : 'warn' });
  rows.push({ label: 'Arquivos guardados', value: `${F.fmtInt(b.count ?? 0)} · ${F.fmtBytes(b.totalB ?? 0)}`, title: b.dir || null });
  return rows;
}

function block(id, title, ...children) {
  const head = sectionHead(title, { id });
  return { head, el: h('div', { class: 'block', role: 'region', 'aria-labelledby': id }, head.el, ...children) };
}

export default function createVps(ctx, section) {
  const { clock } = ctx;
  let lastOk = null;

  const missing = h('div', { class: 'block', hidden: true },
    h('div', { class: 'table-wrap' }, h('table', { class: 'grid notice-table' }, h('tbody', null, h('tr', { class: 'state' },
      h('td', null, dot('bad'), 'O coletor da VPS não está instalado ou nunca rodou. Rode sh host/install.sh na VPS (DEPLOY.md seção 15).'))))));

  const errLine = h('p', { class: 'errline', hidden: true });
  const hostB = block('h-vps-host', 'Host');
  const updB = block('h-vps-upd', 'Atualizações');
  const secB = block('h-vps-sec', 'Segurança');
  const srvB = block('h-vps-srv', 'Servidor SSAM');

  const contHead = sectionHead('Containers', { id: 'h-vps-cont' });
  let coolify = [];
  const contTable = createTable({
    label: 'Containers',
    columns: [
      { key: 'service', label: 'Serviço', sort: (r) => r.service || r.name, text: (r) => r.service || r.name },
      { key: 'name', label: 'Container', mono: true, ell: 'code', sort: (r) => r.name, text: (r) => r.name },
      {
        key: 'state', label: 'Estado', sort: (r) => r.state,
        cell: (r, td) => {
          const s = CONTAINER_STATE[r.state] || { word: r.state || F.DASH, level: 'muted' };
          td.append(status(s.level, s.word));
        },
      },
      {
        key: 'health', label: 'Saúde', sort: (r) => r.health ?? null,
        text: (r) => HEALTH_WORD[r.health] || F.DASH, level: (r) => (r.health === 'unhealthy' ? 'bad' : ''),
        title: (r) => (r.failingStreak ? `${r.failingStreak} verificações seguidas com falha` : ''),
      },
      {
        key: 'sinceS', label: 'Ativo há', num: true, sort: (r) => (r.state === 'running' ? r.sinceS ?? null : null),
        text: (r) => (r.state === 'running' && r.sinceS != null ? F.fmtDuration(r.sinceS * 1000) : F.DASH),
        title: (r) => (r.startedAt ? `desde ${F.fmtTitle(r.startedAt)}` : ''),
      },
      { key: 'restartCount', label: 'Reinícios', num: true, sort: (r) => r.restartCount ?? 0, text: (r) => F.fmtInt(r.restartCount ?? 0) },
      {
        key: 'oom', label: 'OOM', sort: (r) => !!r.oomKilled,
        cell: (r, td) => {
          if (r.oomKilled) td.append(status('bad', 'sim'));
          else td.textContent = 'não';
        },
      },
      { key: 'cpuPct', label: 'CPU', num: true, sort: (r) => r.cpuPct ?? null, text: (r) => F.fmtPctFine(r.cpuPct) },
      {
        key: 'memB', label: 'Memória', num: true, sort: (r) => r.memB ?? null,
        text: (r) => (r.memB == null ? F.DASH : r.memLimitB ? `${F.fmtBytes(r.memB)} de ${F.fmtBytes(r.memLimitB)} (${F.fmtPct((r.memB / r.memLimitB) * 100)})` : F.fmtBytes(r.memB)),
        level: (r) => (r.memLimitB && r.memB / r.memLimitB >= 0.95 ? 'bad' : r.memLimitB && r.memB / r.memLimitB >= 0.85 ? 'warn' : ''),
      },
      { key: 'net', label: 'Rede ↓/↑', num: true, sort: (r) => r.netRxB ?? null, text: (r) => `${F.fmtBytes(r.netRxB)} / ${F.fmtBytes(r.netTxB)}` },
      {
        key: 'image', label: 'Imagem', mono: true, ell: 'code', sort: (r) => r.image,
        text: (r) => (r.image ? String(r.image).split(':').slice(1).join(':') || r.image : F.DASH), title: (r) => r.image || '',
      },
    ],
    rowKey: (r) => r.name,
    defaultSort: { key: 'service', dir: 'asc' },
    empty: 'Nenhum container do projeto encontrado.',
    after(tbody, ncols) {
      if (!coolify.length) return;
      tbody.append(h('tr', { class: 'group' }, h('th', { colspan: ncols, scope: 'rowgroup' }, 'Coolify (parado de propósito)')));
      for (const c of coolify) {
        const s = CONTAINER_STATE[c.state] || { word: c.state || F.DASH, level: 'muted' };
        tbody.append(h('tr', { dataset: { key: `coolify:${c.name}` } },
          h('th', { scope: 'row' }, c.name),
          h('td', { class: 'mono' }, c.name),
          h('td', null, status(c.state === 'running' ? 'warn' : 'muted', s.word)),
          h('td', { colspan: ncols - 3, class: 'muted' }, `Política de reinício: ${c.restartPolicy || F.DASH}`)));
      }
    },
  });

  const volHead = sectionHead('Volumes', { id: 'h-vps-vol' });
  let systemDf = null;
  const volTable = createTable({
    label: 'Volumes',
    columns: [
      { key: 'name', label: 'Volume', mono: true, sort: (r) => r.name, text: (r) => r.name },
      { key: 'sizeB', label: 'Tamanho', num: true, sort: (r) => r.sizeB ?? null, text: (r) => F.fmtBytes(r.sizeB) },
    ],
    rowKey: (r) => r.name,
    defaultSort: { key: 'name', dir: 'asc' },
    empty: 'Nenhum volume do projeto encontrado.',
    footer(tfoot, ncols) {
      if (!systemDf) return;
      tfoot.append(h('tr', null, h('td', { colspan: ncols },
        `Docker: imagens ${F.fmtBytes(systemDf.imagesB)} (${F.fmtBytes(systemDf.imagesReclaimableB)} recuperáveis) · volumes ${F.fmtBytes(systemDf.volumesB)}${systemDf.buildCacheB ? ` · cache de build ${F.fmtBytes(systemDf.buildCacheB)}` : ''}`)));
    },
  });

  const tlsHead = sectionHead('Certificados TLS', { id: 'h-vps-tls' });
  const tlsTable = createTable({
    label: 'Certificados TLS',
    columns: [
      { key: 'name', label: 'Nome', sort: (r) => r.name, text: (r) => r.name },
      { key: 'issuer', label: 'Emissor', ell: 'text', sort: (r) => r.issuer, text: (r) => r.issuer || F.DASH },
      { key: 'notBefore', label: 'Válido desde', sort: (r) => F.toMs(r.notBefore) || null, text: (r) => F.fmtDate(r.notBefore), title: (r) => F.fmtTitle(r.notBefore) },
      { key: 'notAfter', label: 'Válido até', sort: (r) => F.toMs(r.notAfter) || null, text: (r) => F.fmtDate(r.notAfter), title: (r) => F.fmtTitle(r.notAfter) },
      {
        key: 'daysLeft', label: 'Dias restantes', num: true, sort: (r) => r.daysLeft ?? null,
        text: (r) => (r.daysLeft == null ? F.DASH : F.fmtInt(Math.floor(r.daysLeft))),
        level: (r) => (r.daysLeft == null ? '' : r.daysLeft < 7 ? 'bad' : r.daysLeft < 21 ? 'warn' : ''),
      },
    ],
    rowKey: (r) => r.name,
    defaultSort: { key: 'notAfter', dir: 'asc' },
    empty: (mk) => {
      const tr = mk('Nenhum certificado encontrado no volume do Caddy.', 'empty');
      tr.firstChild.prepend(dot('bad'));
      return tr;
    },
  });

  const bkB = block('h-vps-bk', 'Backups');
  const cronTable = h('table', { class: 'grid cronlog', 'aria-label': 'Últimas linhas do cron.log' });
  const cronWrap = h('div', { class: 'table-wrap' }, cronTable);
  const footer = muted('', 'vpsfoot');

  const body = h('div', { class: 'vps-body' },
    errLine,
    hostB.el, updB.el, secB.el, srvB.el,
    h('div', { class: 'block', role: 'region', 'aria-labelledby': 'h-vps-cont' }, contHead.el, contTable.el),
    h('div', { class: 'block', role: 'region', 'aria-labelledby': 'h-vps-vol' }, volHead.el, volTable.el),
    h('div', { class: 'block', role: 'region', 'aria-labelledby': 'h-vps-tls' }, tlsHead.el, tlsTable.el),
    bkB.el,
    footer);
  section.append(missing, body);

  function setKv(b, rows, spark) {
    const old = b.el.querySelector('table.kv');
    const t = kvTable(rows, { label: b.head.h2.textContent, spark });
    if (spark) {
      const thead = h('thead', null, h('tr', null,
        h('th', { scope: 'col' }, 'Item'), h('th', { scope: 'col' }, 'Valor'), h('th', { scope: 'col' }, 'Últimas 24 h')));
      t.prepend(thead);
    }
    if (old) old.replaceWith(t);
    else b.el.append(t);
  }

  function render(d) {
    const col = d.collector || {};
    const isMissing = col.state === 'missing';
    missing.hidden = !isMissing;
    body.hidden = isMissing;
    if (isMissing) return;
    errLine.hidden = true;
    const pts = d.series?.points || [];
    setKv(hostB, hostRows(d.host, pts), true);
    setKv(updB, updatesRows(d.updates), false);
    setKv(secB, securityRows(d.security), false);
    setKv(srvB, serverRows(d.server), false);
    coolify = Array.isArray(d.coolify) ? d.coolify : [];
    contTable.setRows(d.containers || []);
    contHead.setCount(contTable.countText());
    systemDf = d.systemDf || null;
    volTable.setRows(d.volumes || []);
    tlsTable.setRows(d.tls?.certs || []);
    setKv(bkB, backupRows(d.backups, clock.now()), false);
    clear(cronTable);
    const lines = d.backups?.cronLogTail || [];
    const tb = h('tbody');
    if (!lines.length) tb.append(h('tr', { class: 'state' }, h('td', null, 'cron.log vazio.')));
    for (const l of lines) tb.append(h('tr', null, h('td', { class: 'mono' }, l)));
    cronTable.append(h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Últimas linhas do cron.log'))), tb);
    bkB.el.append(cronWrap);
    const errs = Array.isArray(col.errors) ? col.errors : [];
    footer.textContent = col.collectedAt
      ? `Coletado às ${F.fmtTimeSec(col.collectedAt)} em ${F.fmtDuration(col.durationMs)} · coletor ${col.version ?? F.DASH} · seções com erro: ${errs.length ? errs.join(', ') : 'nenhuma'}.`
      : '';
    footer.classList.toggle('lv-warn', col.state === 'stale' || col.state === 'invalid');
    if (col.state === 'stale') footer.textContent = `${footer.textContent} Coletor parado.`;
    for (const hd of [hostB.head, updB.head, secB.head, srvB.head, contHead, volHead, tlsHead, bkB.head]) hd.setStale('');
  }

  return {
    interval: () => 10000,
    async refresh() {
      try {
        const d = await ctx.api.vps();
        lastOk = clock.now();
        render(d);
      } catch (e) {
        if (e.kind === 'auth') throw e;
        const msg = errorMessage(e);
        clear(errLine);
        errLine.append(dot('bad'), `Não foi possível carregar: ${msg}.`, lastOk ? ` ${staleText(lastOk)}` : '');
        errLine.hidden = false;
        for (const t of [contTable, volTable, tlsTable]) t.setError(msg);
        throw e;
      }
    },
  };
}
