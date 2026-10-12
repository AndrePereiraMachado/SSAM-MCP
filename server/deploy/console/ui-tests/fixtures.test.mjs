// Mock fixtures (DESIGN.md 6.12): committed files equal the generator output, every file fits the section 4 shapes,
// each scenario holds what 7.3 asks for, and every value is neutral (documentation IPs, example domain, fake secrets).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MOCK, fixture, pub } from './helpers.mjs';
import * as SH from './shapes.mjs';

const gen = await import(pub('mock/make-fixtures.mjs'));
const SCENARIOS = ['normal', 'vazio', 'problemas', 'sem-coletor', 'sem-renovar'];

test('the committed fixtures equal the generator output (node public/mock/make-fixtures.mjs)', () => {
  const files = gen.allFixtures();
  const stale = [];
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(MOCK, ...rel.split('/'));
    if (!fs.existsSync(full) || fs.readFileSync(full, 'utf8') !== text) stale.push(rel);
  }
  for (const s of SCENARIOS) {
    for (const f of fs.readdirSync(path.join(MOCK, s))) if (!(`${s}/${f}` in files)) stale.push(`${s}/${f} (sobra)`);
  }
  assert.deepEqual(stale, []);
  assert.deepEqual(gen.SCENARIOS, SCENARIOS);
});

test('the shape checker refuses extra keys, missing keys, wrong types and wrong enums', () => {
  const lic = fixture('normal', 'licenses');
  assert.deepEqual(SH.check(lic, SH.Licenses), []);
  const extra = structuredClone(lic);
  extra.licenses[0].extra = 1;
  assert.match(SH.check(extra, SH.Licenses)[0], /extra: unexpected key/);
  const missing = structuredClone(lic);
  delete missing.licenses[1].daily14;
  assert.match(SH.check(missing, SH.Licenses)[0], /daily14: missing/);
  const wrong = structuredClone(lic);
  wrong.licenses[0].expiresAt = '11/11/2026';
  assert.match(SH.check(wrong, SH.Licenses)[0], /expiresAt: expected ISO UTC time/);
  const state = structuredClone(lic);
  state.licenses[0].state = 'ativa';
  assert.match(SH.check(state, SH.Licenses)[0], /state: expected one of/);
  const short = structuredClone(lic);
  short.licenses[0].daily14 = [1, 2];
  assert.match(SH.check(short, SH.Licenses)[0], /expected 14 items/);
});

const SPEC_BY_FILE = {
  meta: SH.Meta, overview: SH.Overview, licenses: SH.Licenses, 'usage-today': SH.Usage, 'usage-7d': SH.Usage,
  'usage-30d': SH.Usage, live: SH.Live, vps: SH.Vps, 'vps-missing': SH.Vps, events: SH.Events, history: SH.HistoryResponse,
  issue: SH.IssueAnswer, renew: SH.RenewAnswer, lanes: SH.LanesAnswer, 'agent-rotate': SH.RotateAnswer, revoke: SH.RevokeAnswer,
};

for (const s of SCENARIOS) {
  test(`scenario ${s}: every fixture fits the shapes of DESIGN.md section 4`, () => {
    const problems = [];
    const names = fs.readdirSync(path.join(MOCK, s)).map((f) => f.replace(/\.json$/, ''));
    for (const n of names) {
      const v = fixture(s, n);
      const spec = n.startsWith('error-') ? SH.ErrorAnswer : SPEC_BY_FILE[n];
      if (!spec) {
        problems.push(`${n}: no shape for this file`);
        continue;
      }
      problems.push(...SH.check(v, spec, `${s}/${n}`));
      if (n === 'overview') problems.push(...SH.summaryRowsProblems(v.summary).map((x) => `${s}/overview ${x}`));
    }
    for (const need of ['meta', 'overview', 'licenses', 'usage-today', 'usage-7d', 'usage-30d', 'live', 'events', 'history',
      'issue', 'renew', 'lanes', 'agent-rotate', 'revoke']) {
      if (!names.includes(need)) problems.push(`${need}.json missing`);
    }
    if (!names.includes('vps') && !names.includes('vps-missing')) problems.push('vps.json or vps-missing.json missing');
    if (!names.some((n) => n.startsWith('error-'))) problems.push('no error-*.json');
    assert.deepEqual(problems.slice(0, 40), []);
  });
}

test('internal consistency: same clock, ordering of events and history, counts of the status line', () => {
  for (const s of SCENARIOS) {
    const meta = fixture(s, 'meta');
    const ov = fixture(s, 'overview');
    const lic = fixture(s, 'licenses');
    const live = fixture(s, 'live');
    const ev = fixture(s, 'events');
    const hi = fixture(s, 'history');
    assert.equal(ov.now, meta.now, s);
    assert.equal(lic.now, meta.now, s);
    assert.equal(live.now, meta.now, s);
    const seqs = ev.events.map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), `${s}: events ascending by seq`);
    assert.equal(ev.lastSeq, seqs.length ? seqs[seqs.length - 1] : 0, `${s}: lastSeq`);
    const times = hi.entries.map((e) => e.time);
    assert.deepEqual(times, [...times].sort().reverse(), `${s}: history newest first`);
    assert.equal(ov.status.licenses.active, lic.licenses.filter((l) => l.state === 'active').length, `${s}: active`);
    assert.equal(ov.status.sessionsOpen, live.sessions.length, `${s}: sessions`);
    assert.equal(ov.status.agentsConnected, live.agents.filter((a) => a.state === 'connected').length, `${s}: agents`);
    const count = (sev) => ov.alerts.filter((a) => a.severity === sev).length;
    assert.deepEqual(ov.status.alerts, { critical: count('critical'), warning: count('warning'), info: count('info'), acked: ov.acked.length }, s);
    assert.deepEqual(lic.capabilities, meta.capabilities, s);
    for (const l of lic.licenses) {
      if (l.daysLeft != null) assert.ok(Math.abs(l.daysLeft - (Date.parse(l.expiresAt) - Date.parse(meta.now)) / 86400000) < 0.001, `${s} ${l.id} daysLeft`);
    }
    for (const range of ['today', '7d', '30d']) {
      const u = fixture(s, `usage-${range}`);
      assert.equal(u.byDay.length, u.range.days, `${s} ${range}: one row per day`);
      assert.deepEqual(u.byDay.map((d) => d.day), [...u.byDay.map((d) => d.day)].sort().reverse(), `${s} ${range}: byDay newest first`);
      assert.equal(u.totals.calls, u.byCustomer.reduce((a, c) => a + c.calls, 0), `${s} ${range}: totals`);
      assert.equal(u.totals.calls, u.byDay.reduce((a, d) => a + d.calls, 0), `${s} ${range}: byDay sum`);
      assert.equal(u.totals.calls, u.byTool.reduce((a, t) => a + t.calls, 0), `${s} ${range}: byTool sum`);
      assert.equal(u.totals.failures, u.byCode.reduce((a, c) => a + c.count, 0), `${s} ${range}: byCode sum`);
      for (const c of u.byCustomer) assert.equal(c.daily.length, u.range.days, `${s} ${range} ${c.token}: daily`);
      for (const r of [...u.byCustomer, ...u.byTool, ...u.byDay]) if (!r.calls) assert.equal(r.p50Ms, null, `${s} ${range}: p50 null when no calls`);
    }
  }
});

test('normal: three licenses (Alfa 29 days with agent and session, Beta 2 days, Gama revoked), 14 calls, the 6 acceptance alerts', () => {
  const lic = fixture('normal', 'licenses').licenses;
  const by = Object.fromEntries(lic.map((l) => [l.customer, l]));
  assert.deepEqual(Object.keys(by).sort(), ['Cliente Alfa', 'Cliente Beta', 'Cliente Gama']);
  assert.equal(by['Cliente Alfa'].state, 'active');
  assert.equal(Math.floor(by['Cliente Alfa'].daysLeft), 29);
  assert.equal(by['Cliente Alfa'].agent.state, 'connected');
  assert.equal(by['Cliente Alfa'].sessionsOpen, 1);
  assert.equal(by['Cliente Beta'].state, 'active');
  assert.equal(Math.floor(by['Cliente Beta'].daysLeft), 2);
  assert.equal(by['Cliente Gama'].state, 'revoked');
  const today = fixture('normal', 'usage-today').totals;
  assert.equal(today.calls, 14);
  assert.equal(today.failures, 1);
  const rules = fixture('normal', 'overview').alerts.map((a) => `${a.rule}:${a.severity}`).sort();
  for (const r of ['backup-ausente:critical', 'backup-sem-cron:warning', 'rotacao-sem-cron:warning', 'reinicio-pendente:warning',
    'ssh-senha:warning', 'aquecimento-parcial:info']) assert.ok(rules.includes(r), r);
  assert.ok(fixture('normal', 'meta').capabilities.renew);
});

const RULES = [
  'licenca-vence', 'licenca-venceu', 'licencas-ilegiveis', 'acesso-outra-maquina', 'espaco-cliente', 'sessoes-limite', 'pico-falhas',
  'falhas-agente', 'erro-servidor', 'servidor-fora', 'caddy-fora', 'container-reiniciou', 'container-oom', 'nao-aquecido',
  'aquecimento-parcial', 'kernel-ausente', 'kernel-mudou', 'certificado', 'certificado-ausente', 'disco', 'memoria',
  'memoria-container', 'carga', 'backup-ausente', 'backup-velho', 'backup-falhou', 'backup-sem-cron', 'rotacao-sem-cron',
  'log-grande', 'reinicio-pendente', 'atualizacoes-seguranca', 'ssh-senha', 'firewall', 'coolify-rodando', 'recusas-acesso',
  'limite-taxa', 'relogio', 'unidades-falhas', 'coletor', 'coleta-parcial', 'painel-leitura', 'eventos-perdidos',
];

test('problemas: every alert rule of section 5 fires, long names, 200 events, 50 denied IPs, O11 workers, silenced alerts', () => {
  const ov = fixture('problemas', 'overview');
  const fired = new Set(ov.alerts.map((a) => a.rule));
  assert.deepEqual(RULES.filter((r) => !fired.has(r)), []);
  assert.ok(ov.acked.length >= 2);
  assert.ok(ov.acked.some((a) => a.event && a.ackedUntil === null));
  assert.equal(new Set(ov.alerts.map((a) => a.id)).size, ov.alerts.length, 'alert ids unique');
  assert.equal(fixture('problemas', 'events').events.length, 200);
  assert.equal(fixture('problemas', 'usage-7d').denied.rows.length, 50);
  assert.ok(fixture('problemas', 'live').workers.rows.some((w) => w.kind === 'o11-worker' && w.token));
  const names = fixture('problemas', 'licenses').licenses.map((l) => l.customer);
  assert.ok(names.some((n) => n.length >= 60 && n.length <= 64), 'a 60-64 character customer name');
  assert.ok(names.every((n) => n.length <= 64));
  assert.equal(fixture('problemas', 'meta').indexing.state, 'running');
});

test('vazio: nothing yet (no license, no event, no alert, no session), collector fresh', () => {
  assert.deepEqual(fixture('vazio', 'licenses').licenses, []);
  assert.deepEqual(fixture('vazio', 'events').events, []);
  assert.deepEqual(fixture('vazio', 'history').entries, []);
  const ov = fixture('vazio', 'overview');
  assert.deepEqual(ov.alerts, []);
  assert.deepEqual(ov.recentEvents, []);
  assert.equal(ov.status.collector.state, 'fresh');
  assert.deepEqual(fixture('vazio', 'live').sessions, []);
  assert.deepEqual(fixture('vazio', 'usage-7d').byCustomer, []);
});

test('sem-coletor: host.json missing everywhere it shows', () => {
  assert.ok(!fs.existsSync(path.join(MOCK, 'sem-coletor', 'vps.json')));
  const vps = fixture('sem-coletor', 'vps-missing');
  assert.equal(vps.collector.state, 'missing');
  for (const k of ['host', 'updates', 'security', 'tls', 'backups', 'containers', 'volumes', 'systemDf', 'coolify', 'series']) assert.equal(vps[k], null, k);
  const ov = fixture('sem-coletor', 'overview');
  assert.equal(ov.status.collector.state, 'missing');
  assert.equal(ov.status.host, null);
  assert.ok(ov.alerts.some((a) => a.rule === 'coletor' && a.severity === 'critical'));
  assert.equal(fixture('sem-coletor', 'live').workers.available, false);
  assert.equal(fixture('sem-coletor', 'usage-7d').denied.available, false);
});

test('sem-renovar: renew and lanes off in the capabilities and in every license, with the reason of 4.2', () => {
  const caps = fixture('sem-renovar', 'meta').capabilities;
  assert.equal(caps.renew, false);
  assert.equal(caps.lanes, false);
  assert.equal(caps.issue && caps.revoke && caps.agentRotate, true);
  for (const l of fixture('sem-renovar', 'licenses').licenses.filter((x) => x.state !== 'revoked')) {
    assert.deepEqual(l.actions.renew, { allowed: false, reason: 'Indisponível nesta imagem (chega com o 24º envio).' });
    assert.deepEqual(l.actions.lanes, { allowed: false, reason: 'Indisponível nesta imagem (chega com o 24º envio).' });
  }
});

test('neutral data only: documentation IPs, example domain, PC-TESTE machines, fake secrets, Cliente names', () => {
  const problems = [];
  const docNet = /^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}$/;
  for (const s of SCENARIOS) {
    for (const f of fs.readdirSync(path.join(MOCK, s))) {
      const text = fs.readFileSync(path.join(MOCK, s, f), 'utf8');
      for (const m of text.matchAll(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g)) {
        if (!docNet.test(m[0])) problems.push(`${s}/${f}: IP ${m[0]}`);
      }
      if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/.test(text)) problems.push(`${s}/${f}: e-mail`);
      for (const m of text.matchAll(/\bssam_[A-Za-z0-9_-]{20,}/g)) {
        if (!/^ssam_(agent_)?EXEMPLO_NAO_E_/.test(m[0])) problems.push(`${s}/${f}: secret-like ${m[0]}`);
      }
      for (const m of text.matchAll(/https?:\/\/([^/"\s]+)/g)) if (m[1] !== 'ssam.example.com') problems.push(`${s}/${f}: domain ${m[1]}`);
      const json = JSON.parse(text);
      const walk = (v, k) => {
        if (Array.isArray(v)) v.forEach((x) => walk(x, k));
        else if (v && typeof v === 'object') for (const [kk, vv] of Object.entries(v)) walk(vv, kk);
        else if (typeof v === 'string') {
          if (k === 'customer' && !v.startsWith('Cliente ')) problems.push(`${s}/${f}: customer ${v}`);
          if (k === 'user' && !/^teste/.test(v)) problems.push(`${s}/${f}: user ${v}`);
          if (k === 'name' && /^PC-/.test(v) && !/^PC-TESTE-\d\d$/.test(v)) problems.push(`${s}/${f}: machine ${v}`);
        }
      };
      walk(json, null);
    }
  }
  assert.deepEqual(problems.slice(0, 30), []);
});
