// SPEC painel v2 8.2: the pure rules of the v2 console. Gauge and tick geometry, the meter thresholds of 5.1 at every
// boundary, nice axis ticks, column and line geometry, the alert level per view, the two-line validity cell and the
// stacked p50 / p90 pair, every view's KPI cards on the fixtures (values from the payload, words for missing data,
// never 0 for a missing datum), the area cards carrying the old Resumo "Agora" text, and the closed icon list.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pub, fixture, readPublic, publicFiles } from './helpers.mjs';

const NOW = Date.parse('2026-10-13T02:51:08Z');
const D = 86400000;

const C = await import(pub('js/charts.js'));
const I = await import(pub('js/icons.js'));
const F = await import(pub('js/format.js'));
const common = await import(pub('js/views/common.js'));
const visao = await import(pub('js/views/visao.js'));
const licencas = await import(pub('js/views/licencas.js'));
const uso = await import(pub('js/views/uso.js'));
const qualidade = await import(pub('js/views/qualidade.js'));
const agentes = await import(pub('js/views/agentes.js'));
const vps = await import(pub('js/views/vps.js'));
const eventos = await import(pub('js/views/eventos.js'));
const historico = await import(pub('js/views/historico.js'));

const SCENARIOS = ['normal', 'problemas', 'vazio', 'sem-coletor'];
const maybe = (s, n) => {
  try {
    return fixture(s, n);
  } catch {
    return null;
  }
};

test('gauge geometry: 270 degree dash and threshold ticks just outside the arc', () => {
  assert.equal(C.gaugeDash(0), '0 301.59');
  assert.equal(C.gaugeDash(1), '226.19 301.59');
  assert.equal(C.gaugeDash(0.5), '113.1 301.59');
  assert.equal(C.gaugeDash(2), '226.19 301.59', 'clamped to the arc');
  assert.equal(C.gaugeDash(-1), '0 301.59');
  assert.equal(C.gaugeDash(null), '0 301.59');
  assert.deepEqual(C.tickAngle(0), { x1: 21.82, y1: 98.18, x2: 17.57, y2: 102.43 });
  assert.deepEqual(C.tickAngle(1), { x1: 98.18, y1: 98.18, x2: 102.43, y2: 102.43 });
  assert.deepEqual(C.tickAngle(0.5), { x1: 60, y1: 6, x2: 60, y2: 0 });
});

test('meter thresholds of SPEC 5.1 at every boundary; a missing value has no level', () => {
  const cases = {
    cpu: [[79.9, 'ok'], [80, 'warn'], [94.9, 'warn'], [95, 'bad']],
    mem: [[84.9, 'ok'], [85, 'warn'], [92.9, 'warn'], [93, 'bad']],
    disk: [[79.9, 'ok'], [80, 'warn'], [89.9, 'warn'], [90, 'bad']],
    load: [[1.99, 'ok'], [2, 'warn'], [9, 'warn']],
    tls: [[21, 'ok'], [20.9, 'warn'], [7, 'warn'], [6.9, 'bad'], [0, 'bad'], [-3, 'bad']],
    backup: [[26, 'ok'], [26.1, 'bad']],
    collector: [[120, 'ok'], [121, 'warn']],
    workspace: [[79.9, 'ok'], [80, 'warn'], [94.9, 'warn'], [95, 'bad']],
    validity: [[8, 'ok'], [7, 'warn'], [2.1, 'warn'], [2, 'bad'], [0.01, 'bad'], [0, 'warn'], [-5, 'warn']],
    seats: [[0.99, 'ok'], [1, 'warn']],
    agents: [[0, 'accent'], [1, 'accent']],
    success: [[75, 'ok'], [74.9, 'warn'], [50, 'warn'], [49.9, 'bad']],
    refusal: [[14.9, 'ok'], [15, 'warn'], [29.9, 'warn'], [30, 'bad']],
    share: [[0.5, 'accent']],
    containerMem: [[84.9, 'ok'], [85, 'warn'], [94.9, 'warn'], [95, 'bad']],
  };
  for (const [id, list] of Object.entries(cases)) {
    for (const [v, want] of list) assert.equal(C.meterLevel(id, v), want, `${id} ${v}`);
    assert.equal(C.meterLevel(id, null), null, `${id} null`);
    assert.equal(C.meterLevel(id, undefined), null, `${id} undefined`);
  }
  assert.deepEqual(Object.keys(cases).sort(), Object.keys(C.METER_RULES).sort(), 'every rule is tested');
  assert.throws(() => C.meterLevel('nada', 1));
  assert.deepEqual(C.meterTicks('cpu'), [{ at: 0.8, level: 'warn' }, { at: 0.95, level: 'bad' }]);
  assert.deepEqual(C.meterTicks('backup'), [{ at: 26 / 48, level: 'bad' }]);
  assert.deepEqual(C.meterTicks('agents'), []);
  assert.equal(C.levelWord('bad'), 'crítico');
  assert.equal(C.levelWord('accent'), '');
});

test('nice axis ticks: 3 to 5 round steps from 0 up to at least the maximum', () => {
  assert.deepEqual(C.niceTicks(100), [0, 25, 50, 75, 100]);
  assert.deepEqual(C.niceTicks(2130, { integer: true }), [0, 1000, 2000, 3000]);
  assert.deepEqual(C.niceTicks(1322, { integer: true }), [0, 500, 1000, 1500]);
  assert.deepEqual(C.niceTicks(14, { integer: true }), [0, 5, 10, 15]);
  assert.deepEqual(C.niceTicks(1, { integer: true }), [0, 1]);
  assert.deepEqual(C.niceTicks(0.3), [0, 0.1, 0.2, 0.3]);
  assert.deepEqual(C.niceTicks(0), [0, 1]);
  assert.deepEqual(C.niceTicks(null), [0, 1]);
  for (const m of [3, 7, 12, 99, 101, 4.82, 186000, 6227702579]) {
    const t = C.niceTicks(m);
    assert.ok(t.length >= 3 && t.length <= 6, `${m}: ${t}`);
    assert.ok(t[t.length - 1] >= m, `${m} reached`);
    assert.equal(t[0], 0);
  }
});

test('columns: bars at most 24 px, rounded top only on the top segment, 2 px gap between stacked segments', () => {
  const geo = C.columnGeometry([[10, 5], [0, 0], [20, 0]], { left: 48, top: 8, width: 300, height: 180 }, 20);
  assert.equal(geo.length, 3);
  assert.equal(geo[0].w, 24, 'min(24, 60 % of a 100 px band)');
  assert.equal(geo[0].x, 86);
  assert.equal(geo[0].segs.length, 2);
  const [low, top] = geo[0].segs;
  assert.deepEqual([low.y, low.h], [98, 90]);
  assert.equal(low.d, 'M86 188V98H110V188Z', 'square segment');
  assert.deepEqual([top.y, top.h], [53, 43], 'the 2 px gap comes off the upper segment');
  assert.match(top.d, /A4 4 0 0 1/, 'rounded top');
  assert.deepEqual(geo[1].segs, [], 'a zero day draws nothing');
  assert.equal(geo[2].segs.length, 1);
  assert.deepEqual([geo[2].segs[0].y, geo[2].segs[0].h], [8, 180]);
  const narrow = C.columnGeometry(Array.from({ length: 30 }, () => [1]), { left: 0, top: 0, width: 300, height: 100 }, 1);
  assert.equal(narrow[0].w, 6, '60 % of a 10 px band');
});

test('lines: a null breaks the path', () => {
  assert.equal(C.linePath([[0, 0], [1, 1.234], null, [3, 3]]), 'M0 0L1 1.23M3 3');
  assert.equal(C.linePath([null, null]), '');
  assert.equal(C.linePath([[5, 5]]), 'M5 5');
});

test('alert level per view: highest open severity, own view ids only', () => {
  const got = common.viewAlertLevels([
    { view: 'vps', severity: 'warning' }, { view: 'vps', severity: 'critical' }, { view: 'uso', severity: 'info' },
    { view: '__proto__', severity: 'critical' }, { view: 'constructor', severity: 'critical' }, { view: 'vps', severity: 'critical', acked: true },
    { view: 'licencas', severity: 'warning' }, null,
  ]);
  assert.deepEqual(got, {
    vps: { level: 'bad', count: 2, critical: 1 }, uso: { level: 'info', count: 1, critical: 0 }, licencas: { level: 'warn', count: 1, critical: 0 },
  });
  assert.equal({}.level, undefined, 'nothing reached Object.prototype');
  assert.deepEqual(common.viewAlertLevels(null), {});
  const p = common.viewAlertLevels(fixture('problemas', 'overview').alerts);
  assert.equal(p.vps.level, 'bad');
  assert.equal(p.licencas.level, 'bad');
  for (const k of Object.keys(p)) assert.ok(['visao', 'licencas', 'uso', 'qualidade', 'agentes', 'vps', 'eventos', 'historico'].includes(k));
});

test('validity cell in two lines with the remaining share of the term', () => {
  const lic = (over) => ({ state: 'active', createdAt: '2026-09-15T02:58:00Z', expiresAt: '2026-10-15T02:58:00Z', ...over });
  const two = F.validityParts(lic(), NOW);
  assert.deepEqual([two.main, two.sub, two.level], ['até 14/10/2026', '2 dias', 'warn']);
  assert.ok(two.fraction > 0.06 && two.fraction < 0.07, String(two.fraction));
  const today = F.validityParts(lic({ expiresAt: '2026-10-13T02:58:00Z' }), NOW);
  assert.deepEqual([today.main, today.sub, today.level], ['vence hoje', 'às 23:58', 'bad']);
  assert.deepEqual(F.validityParts(lic({ state: 'expired', expiresAt: '2026-10-10T15:00:00Z' }), NOW), { main: 'venceu', sub: 'em 10/10/2026', level: 'warn', fraction: 0 });
  assert.deepEqual(F.validityParts(lic({ expiresAt: null }), NOW), { main: 'sem validade', sub: '', level: '', fraction: null });
  assert.deepEqual(F.validityParts(lic({ state: 'revoked', revokedAt: '2026-08-01T15:00:00Z' }), NOW), { main: 'revogada', sub: 'em 01/08/2026', level: '', fraction: null });
  const far = F.validityParts(lic({ createdAt: null, expiresAt: '2027-10-13T02:58:00Z' }), NOW);
  assert.deepEqual([far.main, far.level, far.fraction], ['até 12/10/2027', '', null]);
  // the cell title keeps the one-line text of fmtValidity
  assert.equal(F.fmtValidity(lic(), NOW).text, 'até 14/10/2026 (2 dias)');
});

test('p50 / p90 pair stacked: two texts, the one-line title, a dash when both are missing or 0', () => {
  assert.deepEqual(F.pairParts(1200, 4000, F.fmtDuration), { dash: false, a: '1,2 s', b: '4,0 s', title: '1,2 s / 4,0 s' });
  assert.deepEqual(F.pairParts(2, 8), { dash: false, a: '2', b: '8', title: '2 / 8' });
  assert.equal(F.pairParts(null, null).dash, true);
  assert.equal(F.pairParts(0, 0, F.fmtDuration).dash, true);
  assert.equal(F.fmtAgeS(12), '12 s');
  assert.equal(F.fmtAgeS(340), '5 min 40 s');
  assert.equal(F.fmtAgeS(null), '—');
});

// ---- the KPI cards of every view

const BAD_TEXT = /NaN|undefined|null|\[object/;

function cardText(c) {
  const parts = [c.value, c.unit, c.context, c.detail];
  const v = c.visual;
  if (v) {
    for (const g of v.items || []) parts.push(g.display, g.caption, g.label);
    for (const m of v.meters || []) parts.push(m.valueText, m.caption);
    if (v.valueText) parts.push(v.valueText);
    for (const p of v.parts || []) parts.push(p.word);
    if (v.empty) parts.push(v.empty);
  }
  return parts.filter((x) => x != null && x !== '').join(' ');
}

function checkCards(name, cards) {
  assert.ok(Array.isArray(cards) && cards.length > 0, name);
  const ids = new Set();
  for (const c of cards) {
    assert.ok(c.id && !ids.has(c.id), `${name}: card id ${c.id}`);
    ids.add(c.id);
    assert.ok(['ok', 'warn', 'bad', 'info', 'unknown'].includes(c.level), `${name}/${c.id}: level ${c.level}`);
    assert.doesNotMatch(cardText(c), BAD_TEXT, `${name}/${c.id}: ${cardText(c)}`);
    assert.ok(I.ICON_NAMES.includes(c.icon), `${name}/${c.id}: icon ${c.icon}`);
    if (c.visual?.fraction != null) assert.ok(c.visual.fraction >= 0 && c.visual.fraction <= 1.0001, `${name}/${c.id}: fraction`);
  }
  return Object.fromEntries(cards.map((c) => [c.id, c]));
}

test('Visão geral: one card per area; the old Agora numbers are all on the card; missing data is a word', () => {
  for (const s of SCENARIOS) {
    const ov = fixture(s, 'overview');
    const cards = checkCards(`visao/${s}`, visao.kpis(ov, NOW));
    assert.deepEqual(Object.keys(cards), visao.AREA_ORDER.filter((a) => ov.summary.some((r) => r.area === a)), 'placement order');
    for (const row of ov.summary) {
      const card = visao.areaCard(row, ov, NOW);
      const t = visao.summaryTexts(row, ov, now());
      const text = cardText(card).toLocaleLowerCase('pt-BR');
      const numbers = t.agora.match(/\d[\d.,]*/g) || [];
      for (const n of numbers) assert.ok(text.includes(n.replace(/[.,]$/, '')), `${s}/${row.area}: ${n} of "${t.agora}" in "${text}"`);
      if (!numbers.length) assert.ok(card.word || card.visual?.empty, `${s}/${row.area}: "${t.agora}" as a word`);
      assert.equal(card.detail, t.detalhe === '—' ? null : t.detalhe, `${s}/${row.area}: Detalhe word for word`);
    }
  }
  function now() {
    return NOW;
  }
  const n = checkCards('normal', visao.kpis(fixture('normal', 'overview'), NOW));
  assert.deepEqual([n.servidor.value, n.servidor.context], ['No ar', 'há 5 h 12 min · pid 7']);
  assert.deepEqual([n.licencas.value, n.licencas.unit, n.licencas.level], ['2', 'ativas', 'warn']);
  assert.deepEqual(n.vps.visual.items.map((g) => [g.label, g.display, g.level]), [['CPU', '1%', 'ok'], ['Memória', '13%', 'ok'], ['Disco', '6%', 'ok']]);
  assert.equal(n.backup.value, 'nenhum');
  assert.deepEqual([n.tls.value, n.tls.unit], ['88', 'dias']);
  assert.deepEqual([n.coletor.value, n.coletor.unit], ['12 s', 'desde a coleta']);
  const p = checkCards('problemas', visao.kpis(fixture('problemas', 'overview'), NOW));
  assert.deepEqual(p.vps.visual.items.map((g) => g.level), ['warn', 'bad', 'bad']);
  assert.deepEqual([p.backup.value, p.backup.visual.level], ['1 d 16 h', 'bad']);
  assert.deepEqual([p.tls.value, p.tls.visual.level], ['5', 'bad']);
  assert.deepEqual([p.coletor.value, p.coletor.visual.level], ['5 min 40 s', 'warn']);
  const m = checkCards('sem-coletor', visao.kpis(fixture('sem-coletor', 'overview'), NOW));
  assert.equal(m.vps.visual.empty, 'sem dados do coletor');
  for (const id of ['containers', 'backup', 'tls', 'coletor']) assert.deepEqual([m[id].value, m[id].word, m[id].muted], ['sem coleta', true, true], id);
  const v = checkCards('vazio', visao.kpis(fixture('vazio', 'overview'), NOW));
  assert.deepEqual([v.uso.value, v.uso.context, v.uso.visual.items[0].value], ['0', 'sem chamadas', null]);
  assert.equal(visao.alertsSubtitle(fixture('problemas', 'overview').status.alerts), '46 alertas abertos · 19 críticos · 2 silenciados');
  assert.equal(visao.alertsSubtitle(fixture('vazio', 'overview').status.alerts), 'Nenhum alerta aberto');
});

test('Licenças: active, next expiry, calls today with the 14-day sum, the fullest workspace', () => {
  for (const s of SCENARIOS) checkCards(`licencas/${s}`, licencas.kpis(fixture(s, 'licenses').licenses, NOW));
  const n = checkCards('normal', licencas.kpis(fixture('normal', 'licenses').licenses, NOW));
  assert.deepEqual([n.ativas.value, n.ativas.context], ['2', 'de 3 · 0 vencidas · 1 revogada']);
  assert.deepEqual([n.proxima.value, n.proxima.unit, n.proxima.context, n.proxima.level], ['2', 'dias', 'Cliente Beta · até 14/10/2026', 'warn']);
  const lic = fixture('normal', 'licenses').licenses;
  const sum14 = lic[0].daily14.map((_, i) => lic.reduce((s, l) => s + (l.daily14?.[i] || 0), 0));
  assert.deepEqual(n.chamadas.visual.values, sum14);
  assert.equal(n.chamadas.value, F.fmtInt(lic.reduce((s, l) => s + (l.today?.calls || 0), 0)));
  const p = checkCards('problemas', licencas.kpis(fixture('problemas', 'licenses').licenses, NOW));
  assert.deepEqual([p.proxima.value, p.proxima.unit, p.proxima.level], ['hoje', 'às 23:58', 'bad']);
  assert.deepEqual([p.espaco.value, p.espaco.level], ['96%', 'bad']);
  const v = checkCards('vazio', licencas.kpis(fixture('vazio', 'licenses').licenses, NOW));
  assert.deepEqual([v.proxima.value, v.proxima.context], ['nenhuma', 'nenhuma licença ativa com validade']);
  assert.deepEqual([v.espaco.value, v.espaco.muted], ['sem coleta', true]);
  assert.equal(licencas.licensesSubtitle(fixture('problemas', 'licenses').licenses), '5 ativas · 1 vencida · 1 revogada');
});

test('Uso: totals, day sparklines oldest first, denials by status; dash for a response time without calls', () => {
  for (const s of SCENARIOS) checkCards(`uso/${s}`, uso.kpis(fixture(s, 'usage-7d'), fixture(s, 'overview').alerts));
  const d = fixture('problemas', 'usage-7d');
  const p = checkCards('problemas', uso.kpis(d, fixture('problemas', 'overview').alerts));
  assert.deepEqual([p.chamadas.value, p.falhas.value, p.tempo.value, p.tempo.unit], ['8.849', '188', '19,0 s', 'p90']);
  assert.deepEqual(p.chamadas.visual.values, uso.daysAscending(d).map((x) => x.calls));
  assert.ok(uso.daysAscending(d)[0].day < uso.daysAscending(d)[6].day);
  assert.deepEqual(p.recusas.visual.parts.map((x) => x.word), ['401 · 1.185', '403 · 507', '429 · 391']);
  assert.equal(p.recusas.value, '2.083');
  const v = checkCards('vazio', uso.kpis(fixture('vazio', 'usage-7d'), []));
  assert.deepEqual([v.tempo.value, v.tempo.muted, v.falhas.context], ['—', true, 'sem chamadas']);
  const m = checkCards('sem-coletor', uso.kpis(fixture('sem-coletor', 'usage-7d'), []));
  assert.deepEqual([m.recusas.value, m.recusas.muted], ['sem coleta', true]);
  const today = checkCards('today', uso.kpis(fixture('normal', 'usage-today'), []));
  assert.equal(today.chamadas.visual, null, 'one day: no sparkline');
});

test('Qualidade: success and refusal gauges, deliveries, dashes when nothing was recorded', () => {
  for (const s of SCENARIOS) checkCards(`qualidade/${s}`, qualidade.kpis(fixture(s, 'quality-7d').totals));
  const p = checkCards('problemas', qualidade.kpis(fixture('problemas', 'quality-7d').totals));
  assert.deepEqual(p.sucesso.visual.items.map((g) => [g.label, g.display, g.level]), [['Sucesso', '68%', 'warn'], ['Recusas', '23%', 'warn']]);
  assert.equal(p.sucesso.level, 'warn');
  assert.equal(p.entregas.visual.valueText, '61 de 71');
  const v = checkCards('vazio', qualidade.kpis(fixture('vazio', 'quality-7d').totals));
  assert.deepEqual(v.sucesso.visual.items.map((g) => g.value), [null, null]);
  for (const id of ['tempo', 'voltas', 'parado']) assert.deepEqual([v[id].value, v[id].muted], ['—', true], id);
  const rows = qualidade.timeShareRows(fixture('normal', 'quality-7d').timeShare);
  assert.ok(rows.length <= 6);
  for (const r of rows) assert.equal(r.parts.queueRest, r.parts.queue + r.parts.rest);
});

test('Agentes e sessões: connected agents, the fullest license, calls in 1 h, sessions closed today', () => {
  for (const s of SCENARIOS) checkCards(`agentes/${s}`, agentes.kpis(fixture(s, 'live'), fixture(s, 'overview'), NOW));
  const p = checkCards('problemas', agentes.kpis(fixture('problemas', 'live'), fixture('problemas', 'overview'), NOW));
  assert.deepEqual([p.agentes.value, p.agentes.unit, p.agentes.level], ['3', 'de 6', 'warn']);
  assert.deepEqual([p.sessoes.visual.valueText, p.sessoes.visual.level], ['8 de 8', 'warn']);
  assert.equal(p.chamadas.level, 'bad');
  assert.match(p.encerradas.context, /^mais comum: substituída/);
  assert.equal(agentes.liveSubtitle(fixture('problemas', 'live')), '3 agentes conectados · 11 sessões MCP abertas · limite de 120 chamadas/min · até 8 sessões por licença');
});

test('VPS: gauges as host.mjs computes them, other mounts and inodes as meters, words when a section is missing', () => {
  for (const s of SCENARIOS) checkCards(`vps/${s}`, vps.kpis(maybe(s, 'vps') || fixture(s, 'vps-missing'), NOW));
  const d = fixture('problemas', 'vps');
  const p = checkCards('problemas', vps.kpis(d, NOW));
  assert.deepEqual(p.recursos.visual.items.map((g) => [g.label, g.display, g.level]), [['CPU', '91%', 'warn'], ['Memória', '95%', 'bad'], ['Disco /', '92%', 'bad']]);
  assert.equal(vps.memUsedPct(d.host.mem), Math.round((1 - d.host.mem.availableB / d.host.mem.totalB) * 1000) / 10);
  assert.equal(vps.fullestDisk(d.host.disks).mount, '/');
  assert.deepEqual(p.recursos.visual.meters.map((m) => m.caption), ['Disco /var/lib/docker', 'Disco /boot', 'inodes /', 'inodes /var/lib/docker', 'inodes /boot']);
  assert.deepEqual([p.carga.value, p.carga.level], ['4,82', 'warn']);
  assert.deepEqual([p.updates.value, p.updates.level], ['indisponível', 'unknown']);
  assert.deepEqual([p.coletor.value, p.coletor.level], ['5 min 40 s', 'warn']);
  const m = checkCards('sem-coletor', vps.kpis(fixture('sem-coletor', 'vps-missing'), NOW));
  assert.equal(m.coletor.value, 'sem coleta');
  assert.equal(vps.collectorLine(d.collector), 'Coletado às 23:45:28 em 24,8 s · coletor 1 · seções com erro: updates: TIMEOUT, tls: TIMEOUT. Coletor parado.');
});

test('Eventos and Histórico: counts of the loaded rows', () => {
  for (const s of SCENARIOS) {
    const ev = fixture(s, 'events');
    checkCards(`eventos/${s}`, eventos.kpis(ev.events, { lastSeq: ev.lastSeq, now: NOW }));
    checkCards(`historico/${s}`, historico.kpis(fixture(s, 'history').entries, NOW));
  }
  const ev = fixture('problemas', 'events').events;
  const e = checkCards('problemas', eventos.kpis(ev, { lastSeq: 5200, paused: true, pending: 12, now: NOW }));
  assert.equal(e.erros.value, F.fmtInt(ev.filter((x) => x.level === 'error').length));
  assert.equal(e.erros.context, `nos ${ev.length} eventos carregados`);
  assert.deepEqual([e.recente.level, e.recente.context], ['warn', 'Pausado · 12 novos']);
  const empty = checkCards('vazio', eventos.kpis([], { lastSeq: 0, now: NOW }));
  assert.deepEqual([empty.recente.value, empty.recente.context], ['nenhum', null]);
  const h = checkCards('problemas', historico.kpis(fixture('problemas', 'history').entries, NOW));
  assert.deepEqual([h.acoes.value, h.fora.value, h.fora.level, h.erros.value, h.erros.level], ['18', '8', 'warn', '1', 'bad']);
});

test('icons: the list is closed and every icon the code names exists', () => {
  assert.throws(() => I.iconShapes('nao-existe'));
  assert.throws(() => I.iconShapes('constructor'));
  for (const n of I.ICON_NAMES) assert.ok(I.iconShapes(n).length > 0, n);
  const used = new Set();
  for (const f of publicFiles().filter((x) => x.startsWith('js/') && x.endsWith('.js'))) {
    const src = readPublic(f);
    for (const m of src.matchAll(/\bicon(?:Chip|Button)?\(\s*'([a-z-]+)'/g)) used.add(m[1]);
    for (const m of src.matchAll(/\bicon: '([a-z-]+)'/g)) used.add(m[1]);
  }
  const missing = [...used].filter((n) => !I.ICON_NAMES.includes(n));
  assert.deepEqual(missing, []);
  assert.ok(used.size > 30, `icons named in the code: ${used.size}`);
  assert.ok(fs.existsSync(new URL(pub('js/icons.js'))));
});

// ---- review fixes of 03539ac (rev-visual A1, M2, M5)

const cards = await import(pub('js/cards.js'));

test('Visão geral: collapsed Alertas keep 3 one-line rows; Uso hoje names the spike of the last 15 min next to the day gauge', () => {
  assert.equal(visao.COLLAPSED, 3);
  assert.match(readPublic('app.css'), /\.grid\.alerts\.compact td\.wrap\s*\{[^}]*white-space:\s*nowrap/);
  const ov = fixture('problemas', 'overview');
  const spike = ov.alerts.find((a) => a.rule === 'pico-falhas');
  assert.equal(visao.areaAlert(ov, 'uso', ['pico-falhas', 'limite-taxa']).id, spike.id, 'critical before info');
  assert.equal(visao.areaAlert(ov, 'uso', ['nao-existe']), null);
  const f = ov.summary.find((r) => r.area === 'uso').facts;
  const p = checkCards('problemas', visao.kpis(ov, NOW));
  assert.deepEqual([p.uso.context, p.uso.contextLevel], [spike.title, 'bad']);
  assert.deepEqual([p.uso.visual.items[0].label, p.uso.visual.items[0].caption],
    ['Sucesso no dia', `${F.plural(f.failures, 'falha', 'falhas')} (${F.fmtShare(f.failures, f.calls)})`]);
  const n = checkCards('normal', visao.kpis(fixture('normal', 'overview'), NOW));
  assert.deepEqual([n.uso.context, n.uso.contextLevel, n.uso.visual.items[0].label, n.uso.visual.items[0].caption],
    ['1 falha (7%)', null, 'Sucesso no dia', undefined]);
});

test('cards: a card in attention or critical always says it in a word (atenção / crítico), on every view', () => {
  assert.deepEqual(cards.levelPill({ level: 'warn' }), { level: 'warn', word: 'atenção' });
  assert.deepEqual(cards.levelPill({ level: 'bad' }), { level: 'bad', word: 'crítico' });
  for (const level of ['ok', 'info', 'unknown']) assert.equal(cards.levelPill({ level }), null, level);
  assert.deepEqual(cards.levelPill({ level: 'bad', pill: { level: 'muted', word: 'desconhecido' } }), { level: 'muted', word: 'desconhecido' });
  assert.equal(cards.levelPill({ level: 'bad', pill: null }), null, 'an explicit null keeps the card without a pill');
  const lic = fixture('problemas', 'licenses').licenses;
  const all = [
    ...licencas.kpis(lic, NOW), ...uso.kpis(fixture('problemas', 'usage-7d'), fixture('problemas', 'overview').alerts),
    ...qualidade.kpis(fixture('problemas', 'quality-7d').totals), ...agentes.kpis(fixture('problemas', 'live'), fixture('problemas', 'overview'), NOW),
    ...vps.kpis(fixture('problemas', 'vps'), NOW), ...historico.kpis(fixture('problemas', 'history').entries, NOW),
  ];
  const loud = all.filter((c) => c.level === 'warn' || c.level === 'bad');
  assert.ok(loud.length >= 8, `cards in attention or critical: ${loud.length}`);
  for (const c of loud) assert.ok(cards.levelPill(c)?.word, `${c.id}: a word for ${c.level}`);
});