// VPS (DESIGN.md 6.5, SPEC painel v2 4.6): KPI cards (CPU, memory and disk gauges, load, network, TLS, backup, updates,
// collector), six line charts of the last 24 h, then host, updates, security and SSAM server as key-value lists (the
// host's sparklines in their own column), containers, volumes, TLS certificates and backups. Polls every 10 s.

import * as F from '../format.js';
import { h, clear, status, pageHead, panel, inlineNotice, iconChip } from '../dom.js';
import { createTable, kvTable } from '../table.js';
import { createCards } from '../cards.js';
import { meter, meterLevel, meterTicks, lines } from '../charts.js';
import { sparkline, sparkLabel, fmtSparkDecimal } from '../sparkline.js';
import { CONTAINER_STATE, HEALTH_WORD } from '../labels.js';
import { errorMessage, staleText } from './common.js';

const okSection = (s) => s && s.ok !== false;
const unavailable = (s) => `indisponível (${s?.error || 'sem dados'})`;

/** Tag of an image reference, without a registry port or a digest: caddy:2.11.7-alpine@sha256:... -> 2.11.7-alpine. */
export function imageTag(ref) {
  const base = String(ref).split('@')[0];
  const last = base.slice(base.lastIndexOf('/') + 1);
  return last.includes(':') ? last.slice(last.indexOf(':') + 1) : last;
}

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
    { label: 'Registros de qualidade', value: `${F.plural(logs.qualityFiles ?? 0, 'arquivo', 'arquivos')} · ${F.fmtBytes(logs.qualityB ?? 0)}` },
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

/** Memory used in % exactly as host.mjs computes memUsedPct (one decimal). */
export function memUsedPct(mem) {
  if (!mem || !mem.totalB) return null;
  return Math.round((1 - (mem.availableB ?? 0) / mem.totalB) * 1000) / 10;
}

/** The fullest disk (highest usedPct), the one host.mjs reports as diskUsedPct. */
export function fullestDisk(disks) {
  return (Array.isArray(disks) ? disks : []).filter((d) => d && d.usedPct != null)
    .reduce((best, d) => (!best || d.usedPct > best.usedPct ? d : best), null);
}

/** `Coletado às 23:51:00 em 2,4 s · coletor 1 · seções com erro: nenhuma.` (+ ` Coletor parado.`). */
export function collectorLine(col) {
  const c = col || {};
  if (!c.collectedAt) return '';
  const errs = Array.isArray(c.errors) ? c.errors : [];
  const line = `Coletado às ${F.fmtTimeSec(c.collectedAt)} em ${F.fmtDuration(c.durationMs)} · coletor ${c.version ?? F.DASH} · seções com erro: ${errs.length ? errs.join(', ') : 'nenhuma'}.`;
  return c.state === 'stale' ? `${line} Coletor parado.` : line;
}

const worstOf = (levels) => (levels.includes('bad') ? 'bad' : levels.includes('warn') ? 'warn' : 'ok');
const pctGauge = (label, id, v, caption) => ({ label, value: v, max: 100, level: meterLevel(id, v), display: F.fmtPct(v), ticks: meterTicks(id), caption });
const diskMeter = (caption, pct) => ({
  kind: 'meter', label: caption, caption, fraction: pct == null ? null : pct / 100, level: meterLevel('disk', pct), ticks: meterTicks('disk'), valueText: F.fmtPct(pct),
});

/** The KPI cards of VPS (pure, from /api/vps). */
export function kpis(d, now) {
  const host = d?.host || {};
  const hostOk = okSection(d?.host);
  const cards = [];
  if (!hostOk) {
    cards.push({ id: 'recursos', label: 'Recursos', icon: 'cpu', span: 'w2', level: 'unknown', value: unavailable(d?.host), word: true, muted: true });
  } else {
    const cpu = host.cpu || {};
    const mem = host.mem || {};
    const mp = memUsedPct(mem);
    const disk = fullestDisk(host.disks);
    const items = [
      pctGauge('CPU', 'cpu', cpu.pct ?? null, `iowait ${F.fmtPctFine(cpu.iowaitPct)} · steal ${F.fmtPctFine(cpu.stealPct)}`),
      pctGauge('Memória', 'mem', mp, mem.totalB ? `${F.fmtBytes(mem.totalB - (mem.availableB ?? 0))} de ${F.fmtBytes(mem.totalB)}` : ''),
      pctGauge(disk ? `Disco ${disk.mount}` : 'Disco', 'disk', disk ? disk.usedPct : null, disk ? `${F.fmtBytes(disk.usedB)} de ${F.fmtBytes(disk.sizeB)}` : ''),
    ];
    const meters = [];
    for (const x of host.disks || []) if (x !== disk) meters.push(diskMeter(`Disco ${x.mount}`, x.usedPct));
    for (const x of host.disks || []) meters.push(diskMeter(`inodes ${x.mount}`, x.inodesPct));
    cards.push({
      id: 'recursos', label: 'Recursos', icon: 'cpu', span: 'w2',
      level: worstOf([...items.map((g) => g.level), ...meters.map((m) => m.level)]),
      visual: { kind: 'gauges', items, meters },
    });
  }
  const load = Array.isArray(host.load) ? host.load : [];
  const ratio = load[0] != null && host.nproc ? load[0] / host.nproc : null;
  cards.push(hostOk && load.length ? {
    id: 'carga', label: 'Carga', icon: 'load', level: meterLevel('load', ratio) || 'ok', value: F.fmtNum2(load[0]), unit: '1 min',
    context: `${F.fmtNum2(load[1])} · ${F.fmtNum2(load[2])} (${host.nproc ?? '?'} vCPU)`,
    visual: ratio != null ? {
      kind: 'meter', label: 'Carga por vCPU', caption: 'por vCPU (atenção a partir de 2)', fraction: ratio / 3, level: meterLevel('load', ratio),
      ticks: meterTicks('load'), valueText: F.fmtNum2(ratio),
    } : null,
  } : { id: 'carga', label: 'Carga', icon: 'load', level: 'unknown', value: 'sem coleta', word: true, muted: true });
  const net = host.net || {};
  const rx = (d?.series?.points || []).map((p) => (p && p.rxBps != null ? p.rxBps : null));
  cards.push(hostOk && net.rxBps != null ? {
    id: 'rede', label: 'Rede', icon: 'network', level: 'ok', value: `↓ ${F.fmtRate(net.rxBps)}`,
    context: [`↑ ${F.fmtRate(net.txBps)}`, net.iface].filter(Boolean).join(' · '),
    visual: rx.filter((v) => v != null).length >= 2 ? { kind: 'spark', values: rx, label: sparkLabel('Rede, entrada', rx, { fmt: (v) => F.fmtRate(v), span: '24 h', lastLabel: 'agora' }) } : null,
  } : { id: 'rede', label: 'Rede', icon: 'network', level: 'unknown', value: 'sem coleta', word: true, muted: true });

  const certs = Array.isArray(d?.tls?.certs) ? d.tls.certs.filter((c) => c && c.daysLeft != null) : [];
  const cert = certs.reduce((b, c) => (!b || c.daysLeft < b.daysLeft ? c : b), null);
  if (!cert) cards.push({ id: 'tls', label: 'Certificado TLS', icon: 'lock', level: 'bad', value: 'nenhum', word: true, context: 'nenhum certificado no volume do Caddy' });
  else {
    const days = Number(cert.daysLeft);
    const dd = Math.floor(days);
    cards.push({
      id: 'tls', label: 'Certificado TLS', icon: 'lock', level: meterLevel('tls', days), value: dd <= 0 && days <= 0 ? 'venceu' : F.fmtInt(dd), word: days <= 0,
      unit: days <= 0 ? null : (dd === 1 ? 'dia' : 'dias'), context: `${cert.name} · até ${F.fmtDate(cert.notAfter)}`,
      visual: {
        kind: 'meter', label: 'Dias restantes do certificado', caption: 'dias restantes', fraction: Math.min(Math.max(days, 0), 90) / 90,
        level: meterLevel('tls', days), ticks: meterTicks('tls'), valueText: F.plural(Math.max(0, dd), 'dia', 'dias'),
      },
    });
  }

  const b = d?.backups;
  if (!okSection(b)) cards.push({ id: 'backup', label: 'Backup', icon: 'backup', level: 'unknown', value: 'indisponível', word: true, muted: true, context: `(${b?.error || 'sem dados'})` });
  else if (!b.newest) cards.push({ id: 'backup', label: 'Backup', icon: 'backup', level: 'bad', value: 'nenhum', word: true, context: F.plural(b.count ?? 0, 'guardado', 'guardados') });
  else {
    const ageH = b.newest.ageH != null ? Number(b.newest.ageH) : (now - F.toMs(b.newest.mtime)) / F.HOUR;
    cards.push({
      id: 'backup', label: 'Backup', icon: 'backup', level: meterLevel('backup', ageH) || 'ok', value: F.fmtDuration(ageH * F.HOUR), unit: 'desde o último',
      context: `${F.fmtBytes(b.newest.sizeB)} · ${F.plural(b.count ?? 0, 'guardado', 'guardados')}`,
      visual: {
        kind: 'meter', label: 'Idade do último backup', caption: 'idade (limite 26 h)', fraction: Math.min(ageH, 48) / 48, level: meterLevel('backup', ageH),
        ticks: meterTicks('backup'), valueText: F.fmtDuration(ageH * F.HOUR),
      },
    });
  }

  const u = d?.updates;
  if (!okSection(u)) cards.push({ id: 'updates', label: 'Atualizações', icon: 'update', level: 'unknown', value: 'indisponível', word: true, muted: true, context: `(${u?.error || 'sem dados'})` });
  else {
    cards.push({
      id: 'updates', label: 'Atualizações', icon: 'update', level: (u.security ?? 0) > 0 || u.rebootRequired ? 'warn' : 'ok',
      value: F.fmtInt(u.upgradable ?? 0), unit: (u.upgradable ?? 0) === 1 ? 'pacote' : 'pacotes',
      context: `${F.fmtInt(u.security ?? 0)} de segurança · reinício pendente: ${u.rebootRequired ? 'sim' : 'não'}`,
    });
  }

  const col = d?.collector || {};
  if (col.ageS == null) cards.push({ id: 'coletor', label: 'Coletor', icon: 'radar', level: 'bad', value: 'sem coleta', word: true, muted: true });
  else {
    const errs = Array.isArray(col.errors) ? col.errors.length : 0;
    cards.push({
      id: 'coletor', label: 'Coletor', icon: 'radar', level: col.state === 'invalid' ? 'warn' : meterLevel('collector', col.ageS), value: F.fmtAgeS(col.ageS), unit: 'desde a coleta',
      context: `em ${F.fmtDuration(col.durationMs)} · coletor ${col.version ?? F.DASH} · ${F.plural(errs, 'seção com erro', 'seções com erro')}`,
      visual: {
        kind: 'meter', label: 'Frescor da coleta', caption: 'frescor', fraction: Math.min(Number(col.ageS), 300) / 300, level: meterLevel('collector', col.ageS),
        ticks: meterTicks('collector'), valueText: F.fmtAgeS(col.ageS),
      },
    });
  }
  return cards;
}

const CARD_DEFS = [
  { id: 'recursos', label: 'Recursos', icon: 'cpu', span: 'w2' }, { id: 'carga', label: 'Carga', icon: 'load' }, { id: 'rede', label: 'Rede', icon: 'network' },
  { id: 'tls', label: 'Certificado TLS', icon: 'lock' }, { id: 'backup', label: 'Backup', icon: 'backup' }, { id: 'updates', label: 'Atualizações', icon: 'update' },
  { id: 'coletor', label: 'Coletor', icon: 'radar' },
];

/** x ticks of the 24 h charts: every 6 h of local time (00:00, 06:00, 12:00, 18:00). */
function sixHours(t0, t1) {
  const out = [];
  for (let t = Math.ceil(t0 / F.HOUR) * F.HOUR; t <= t1; t += F.HOUR) {
    const p = F.localParts(t);
    if (p.h % 6 === 0 && p.mi === 0) out.push({ t, label: F.fmtTime(t) });
  }
  return out;
}

const SERIES_CHARTS = [
  { id: 'cpu', title: 'CPU', series: [{ key: 'cpuPct', label: 'CPU', c: 's1' }], max: 100, fmt: (v) => `${F.fmtNumMax1(v)}%` },
  { id: 'mem', title: 'Memória', series: [{ key: 'memUsedPct', label: 'Memória', c: 's1' }], max: 100, fmt: (v) => `${F.fmtNumMax1(v)}%` },
  { id: 'load', title: 'Carga', series: [{ key: 'load1', label: 'Carga de 1 minuto', c: 's1' }], fmt: (v) => F.fmtNum2(v) },
  { id: 'net', title: 'Rede', series: [{ key: 'rxBps', label: '↓ entrada', c: 's1' }, { key: 'txBps', label: '↑ saída', c: 's2' }], fmt: (v) => F.fmtRate(v), bytes: true },
  { id: 'srvcpu', title: 'CPU do ssam-server', series: [{ key: 'srvCpuPct', label: 'CPU do ssam-server', c: 's1' }], fmt: (v) => `${F.fmtNumMax1(v)}%` },
  { id: 'srvmem', title: 'Memória do ssam-server', series: [{ key: 'srvMemB', label: 'Memória do ssam-server', c: 's1' }], fmt: (v) => F.fmtBytes(v), bytes: true },
];

export default function createVps(ctx, section) {
  const { clock } = ctx;
  let lastOk = null;

  const head = pageHead('t-vps', 'VPS');
  const missing = h('section', { class: 'panel', 'aria-label': 'Coletor da VPS', hidden: true },
    h('div', { class: 'empty-state' }, iconChip('alert-octagon', 'bad', 24),
      h('p', null, 'O coletor da VPS não está instalado ou nunca rodou. Rode sh host/install.sh na VPS (DEPLOY.md seção 15).')));
  const errLine = inlineNotice('bad', '');
  errLine.el.hidden = true;
  const cards = createCards('vps', CARD_DEFS);

  // Últimas 24 h: six small line charts (their table twin is the Host list's spark column and the payload)
  const lastDayP = panel('h-vps-24h', 'Últimas 24 h', { icon: 'clock' });
  const grid = h('div', { class: 'minicharts' });
  const charts = SERIES_CHARTS.map((c) => {
    const ch = lines({
      title: c.title, series: c.series, max: c.max, fmt: c.fmt, bytes: c.bytes, cls: 'flat', height: 96, xTicks: sixHours,
      heading: (p) => F.fmtDayMonthTime(p.t), unitLabel: '',
      aria: (pts) => sparkLabel(c.title, pts.map((p) => p.values[c.series[0].key]), { fmt: c.fmt, span: '24 h', lastLabel: 'agora' }),
    });
    const empty = h('p', { class: 'mc-empty', hidden: true }, 'sem dados nas últimas 24 h');
    ch.el.querySelector('.ch-plot').append(empty);
    grid.append(ch.el);
    return { ...c, ch, empty };
  });
  lastDayP.el.append(grid);

  const hostP = panel('h-vps-host', 'Host', { icon: 'vps' });
  const srvP = panel('h-vps-srv', 'Servidor SSAM', { icon: 'server' });
  const updP = panel('h-vps-upd', 'Atualizações', { icon: 'update' });
  const secP = panel('h-vps-sec', 'Segurança', { icon: 'shield' });

  const contP = panel('h-vps-cont', 'Containers', { icon: 'container' });
  let coolify = [];
  const contTable = createTable({
    label: 'Containers',
    dense: true,
    columns: [
      {
        key: 'service', label: 'Serviço', subLabel: 'container', sort: (r) => r.service || r.name, text: (r) => r.service || r.name,
        sub: (r) => h('span', { class: 'mono', title: r.name }, r.name),
      },
      {
        key: 'state', label: 'Estado', sort: (r) => r.state,
        cell: (r, td) => {
          const s = CONTAINER_STATE[r.state] || { word: r.state || F.DASH, level: 'muted' };
          td.append(status(s.level, s.word));
        },
      },
      {
        key: 'health', label: 'Saúde', cls: 'lvstrong', sort: (r) => r.health ?? null,
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
        key: 'memB', label: 'Memória', num: true, cls: 'lvstrong', sort: (r) => r.memB ?? null,
        text: (r) => (r.memB == null ? F.DASH : r.memLimitB ? `${F.fmtBytes(r.memB)} de ${F.fmtBytes(r.memLimitB)} (${F.fmtPct((r.memB / r.memLimitB) * 100)})` : F.fmtBytes(r.memB)),
        level: (r) => (r.memLimitB && r.memB / r.memLimitB >= 0.95 ? 'bad' : r.memLimitB && r.memB / r.memLimitB >= 0.85 ? 'warn' : ''),
        sub: (r) => {
          if (r.memB == null || !r.memLimitB) return null;
          const p = (r.memB / r.memLimitB) * 100;
          return meter({ label: `Memória de ${r.name}`, fraction: p / 100, level: meterLevel('containerMem', p), ticks: meterTicks('containerMem'), mini: true, cls: 'w48', valueText: F.fmtPct(p) }).el;
        },
      },
      { key: 'net', label: 'Rede ↓/↑', num: true, sort: (r) => r.netRxB ?? null, text: (r) => `${F.fmtBytes(r.netRxB)} / ${F.fmtBytes(r.netTxB)}` },
      {
        key: 'image', label: 'Imagem', mono: true, flex: true, sort: (r) => r.image,
        text: (r) => (r.image ? imageTag(r.image) : F.DASH), title: (r) => r.image || '',
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
          h('th', { scope: 'row' }, h('span', { class: 't1' }, c.name), h('span', { class: 't2 mono' }, c.name)),
          h('td', null, status(c.state === 'running' ? 'warn' : 'muted', s.word)),
          h('td', { colspan: ncols - 2, class: 'muted' }, `Política de reinício: ${c.restartPolicy || F.DASH}`)));
      }
    },
  });
  contP.el.append(contTable.el);

  const volP = panel('h-vps-vol', 'Volumes', { icon: 'disk' });
  let systemDf = null;
  const volTable = createTable({
    label: 'Volumes',
    columns: [
      { key: 'name', label: 'Volume', mono: true, flex: true, sort: (r) => r.name, text: (r) => r.name },
      { key: 'sizeB', label: 'Tamanho', num: true, sort: (r) => r.sizeB ?? null, text: (r) => F.fmtBytes(r.sizeB) },
    ],
    rowKey: (r) => r.name,
    defaultSort: { key: 'name', dir: 'asc' },
    empty: 'Nenhum volume do projeto encontrado.',
  });
  const dockerLine = h('div', { class: 'panel-foot', hidden: true });
  volP.el.append(volTable.el, dockerLine);

  const tlsP = panel('h-vps-tls', 'Certificados TLS', { icon: 'lock' });
  const tlsTable = createTable({
    label: 'Certificados TLS',
    columns: [
      { key: 'name', label: 'Nome', sort: (r) => r.name, text: (r) => r.name },
      { key: 'issuer', label: 'Emissor', ell: 'text', flex: true, sort: (r) => r.issuer, text: (r) => r.issuer || F.DASH },
      { key: 'notBefore', label: 'Válido desde', sort: (r) => F.toMs(r.notBefore) || null, text: (r) => F.fmtDate(r.notBefore), title: (r) => F.fmtTitle(r.notBefore) },
      { key: 'notAfter', label: 'Válido até', sort: (r) => F.toMs(r.notAfter) || null, text: (r) => F.fmtDate(r.notAfter), title: (r) => F.fmtTitle(r.notAfter) },
      {
        key: 'daysLeft', label: 'Dias restantes', num: true, cls: 'lvstrong', sort: (r) => r.daysLeft ?? null,
        text: (r) => (r.daysLeft == null ? F.DASH : F.fmtInt(Math.floor(r.daysLeft))),
        level: (r) => (r.daysLeft == null ? '' : r.daysLeft < 7 ? 'bad' : r.daysLeft < 21 ? 'warn' : ''),
        sub: (r) => (r.daysLeft == null ? null : meter({
          label: `Dias restantes de ${r.name}`, fraction: Math.min(Math.max(r.daysLeft, 0), 90) / 90, level: meterLevel('tls', r.daysLeft),
          ticks: meterTicks('tls'), mini: true, cls: 'w48', valueText: F.plural(Math.max(0, Math.floor(r.daysLeft)), 'dia', 'dias'),
        }).el),
      },
    ],
    rowKey: (r) => r.name,
    defaultSort: { key: 'notAfter', dir: 'asc' },
    empty: (mk) => {
      const tr = mk('Nenhum certificado encontrado no volume do Caddy.', 'error');
      tr.classList.remove('error');
      tr.classList.add('empty');
      return tr;
    },
  });
  tlsP.el.append(tlsTable.el);

  const bkP = panel('h-vps-bk', 'Backups', { icon: 'backup' });
  const bkBody = h('div');
  const cron = h('pre', { class: 'cron', 'aria-label': 'Últimas linhas do cron.log' });
  bkP.el.append(bkBody, h('p', { class: 'cron-head' }, 'Últimas linhas do cron.log'), cron);

  const body = h('div', { class: 'vps-body' },
    errLine.el, cards.el, lastDayP.el,
    h('div', { class: 'cols-2 stretch' }, hostP.el, srvP.el),
    h('div', { class: 'cols-2 stretch' }, updP.el, secP.el),
    contP.el,
    h('div', { class: 'cols-2' }, volP.el, tlsP.el),
    bkP.el);
  section.append(head.el, missing, body);

  function setKv(p, rows, spark) {
    const old = p.el.querySelector(':scope > table.kv');
    const t = kvTable(rows, { label: p.h2.textContent, spark });
    if (spark) {
      t.prepend(h('thead', null, h('tr', null,
        h('th', { scope: 'col' }, 'Item'), h('th', { scope: 'col' }, 'Valor'), h('th', { scope: 'col', class: 'sparkhead' }, 'Últimas 24 h'))));
    }
    if (old) old.replaceWith(t);
    else p.el.append(t);
  }

  function paintCharts(pts) {
    const points = (pts || []).map((p) => ({ t: F.toMs(p.t), values: p })).filter((p) => Number.isFinite(p.t));
    for (const c of charts) {
      const has = points.some((p) => c.series.some((s) => p.values[s.key] != null));
      c.empty.hidden = has;
      c.ch.el.classList.toggle('is-empty', !has);
      c.ch.update(has ? points : []);
    }
  }

  function render(d) {
    const col = d.collector || {};
    const isMissing = col.state === 'missing';
    missing.hidden = !isMissing;
    body.hidden = isMissing;
    head.setSub(isMissing ? '' : collectorLine(col));
    head.sub.classList.toggle('lv-warn', col.state === 'stale' || col.state === 'invalid');
    if (isMissing) return;
    errLine.el.hidden = true;
    const pts = d.series?.points || [];
    cards.render(kpis(d, clock.now()));
    paintCharts(pts);
    setKv(hostP, hostRows(d.host, pts), true);
    setKv(updP, updatesRows(d.updates), false);
    setKv(secP, securityRows(d.security), false);
    setKv(srvP, serverRows(d.server), false);
    coolify = Array.isArray(d.coolify) ? d.coolify : [];
    contTable.setRows(d.containers || []);
    contP.setCount(contTable.countText());
    systemDf = d.systemDf || null;
    volTable.setRows(d.volumes || []);
    volP.setCount(volTable.countText());
    dockerLine.textContent = systemDf
      ? `Docker: imagens ${F.fmtBytes(systemDf.imagesB)} (${F.fmtBytes(systemDf.imagesReclaimableB)} recuperáveis) · volumes ${F.fmtBytes(systemDf.volumesB)}${systemDf.buildCacheB ? ` · cache de build ${F.fmtBytes(systemDf.buildCacheB)}` : ''}`
      : '';
    dockerLine.hidden = !systemDf;
    tlsTable.setRows(d.tls?.certs || []);
    clear(bkBody);
    bkBody.append(kvTable(backupRows(d.backups, clock.now()), { label: 'Backups' }));
    const linesTail = d.backups?.cronLogTail || [];
    cron.textContent = linesTail.length ? linesTail.join('\n') : 'cron.log vazio.';
    cron.classList.toggle('muted', !linesTail.length);
    for (const p of [hostP, updP, secP, srvP, contP, volP, tlsP, bkP, lastDayP]) p.setStale('');
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
        errLine.set(`Não foi possível carregar: ${msg}.${lastOk ? ` ${staleText(lastOk)}` : ''}`);
        errLine.el.hidden = false;
        for (const t of [contTable, volTable, tlsTable]) t.setError(msg);
        cards.error(msg, lastOk ? `dados de ${F.fmtTimeSec(lastOk)}` : '');
        throw e;
      }
    },
  };
}
