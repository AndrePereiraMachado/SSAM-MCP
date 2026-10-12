// DESIGN-QUALIDADE 4.1-4.4 and 7.2 step 2-3: the console reads the fixture days of the design (tests/fixtures/quality, a
// copy of C:\t\qual\fixtures) and answers the golden /api/quality payloads; the hostile file leaves no name, path or text in
// /state, the payloads or the exports; the gz past day is read; a restart from the checkpoint mid-file counts nothing
// twice; deleting /state/agg-quality rebuilds the same payload; an old checkpoint replays the quality only (usage day files
// byte for byte); the idle close after 2 h; the export (CSV, JSON, JSONL limits, headers, errors); the quality-failed event.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FAKE_MODULE, HERE, clock, filesUnder, makeEnv, startConsole } from './helpers.mjs';
import { writeAudit } from './scenario.mjs';
import { sanitizeQualityLine, MAX_LINE_BYTES } from '../quality-line.mjs';
import { csvCell, csvText, createQualityViews } from '../views-quality.mjs';
import { createQualityEngine, emptyQualityDay, summarizeQuality } from '../quality.mjs';
import { createTz } from '../tz.mjs';
import * as S from './shapes.mjs';

const FIX = path.join(HERE, 'fixtures', 'quality');
const NOW = '2026-10-12T21:20:00.000Z';
const TOKENS = { 'tok_0000000a1fa0': 'Cliente Alfa', 'tok_0000000b2fb1': 'Cliente Beta', 'tok_0000000c3fc2': 'Cliente Gama' };
const expectedAll = () => JSON.parse(fs.readFileSync(path.join(FIX, 'expected-api-day-20261012.json'), 'utf8'));
const expectedAlfa = () => JSON.parse(fs.readFileSync(path.join(FIX, 'expected-api-day-20261012-alfa.json'), 'utf8'));
const DAY12 = '/api/quality?range=day&day=2026-10-12';
// What the hostile lines carry and the contract keeps out (quality-line.test.mjs), plus the raw MCP client name. "sntl":
// verb-shaped agent labels outside the agent's lists (odc.pipe:acme-folha-sntl, o11.bridge:sntl_method, file.put:sntl), the
// model's own studio_command text of the privacy finding of 2026-10-12.
const LEAKS = ['Batidas', 'GetColaboradorAtual', 'joao', 'João', 'Abrir', 'passwd', 'texto do cliente', 'Snapshot Module', '__proto__', 'constructor',
  'máquina do', 'Claude Code 2.1.281', 'job.json', 'ssam-quality/2', 'não é json', 'xxxxxxxxxx', 'sntl', 'acme-folha'];

// The fake token store of the design: the three fixture tokens named as the golden payloads expect.
function writeTokens(serverDir) {
  const at = '2026-10-01T12:00:00.000Z';
  const tokens = Object.entries(TOKENS).map(([id, customer], i) => ({ id, customer, createdAt: at, sha256: String(i).repeat(64), agentSha256: String(i + 3).repeat(64),
    agentIssuedAt: at, lanes: ['odc', 'o11'] }));
  fs.writeFileSync(path.join(serverDir, 'tokens.json'), JSON.stringify({ schema: 'ssam-server-tokens/1', tokens }, null, 2) + '\n');
}
// SSAM_SERVER_DIR = a copy of fixtures/server-dir (or the given files), CONSOLE_KERNEL_CATALOG = fixtures/catalog.
function qualityEnv({ copy = true } = {}) {
  const env = makeEnv({ tokenModule: FAKE_MODULE });
  if (copy) fs.cpSync(path.join(FIX, 'server-dir'), env.serverDir, { recursive: true });
  writeTokens(env.serverDir);
  env.config.kernelCatalog = path.join(FIX, 'catalog');
  return env;
}
function assertGolden(got, want, label) {
  assert.equal(got.ok, true, label);
  for (const k of Object.keys(want)) {
    if (k === 'indexing') { assert.equal(got.indexing.state, 'ready', label); continue; }
    assert.deepEqual(got[k], want[k], `${label}: ${k}`);
  }
  assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort(), `${label}: keys`);
}
function leaksIn(text) { return LEAKS.filter(l => text.includes(l)); }

test('golden payloads: /api/quality for the fixture day, all customers and one license; the gz past day; day files', async t => {
  const env = qualityEnv();
  const now = clock(NOW);
  const c = await startConsole(env, { now });
  t.after(() => c.close());
  assert.equal(c.app.qualityCold, true);
  await c.app.tickAll();
  const all = await c.get(DAY12);
  assert.equal(all.status, 200);
  assertGolden(all.body, expectedAll(), 'all');
  S.assertShape(assert, all.body, S.Quality, 'quality');
  const alfa = await c.get(DAY12 + '&token=tok_0000000a1fa0');
  assertGolden(alfa.body, expectedAlfa(), 'alfa');
  S.assertShape(assert, alfa.body, { ...S.Quality, token: 'string' }, 'quality alfa');
  // the past day comes from the .gz (rotate-logs.sh compresses past UTC days): one delivered chain of Cliente Alfa
  const prev = (await c.get('/api/quality?range=day&day=2026-10-11')).body;
  assert.equal(prev.totals.calls, 2);
  assert.equal(prev.totals.delivered, 1);
  assert.equal(prev.totals.chains, 1);
  assert.deepEqual(prev.byCustomer.map(r => [r.customer, r.calls]), [['Cliente Alfa', 2]]);
  assert.equal(prev.firstDay, '2026-10-11');
  // 7 days = 10-06 .. 10-12: the past day and the fixture day together
  const week = (await c.get('/api/quality?range=7d')).body;
  assert.equal(week.range.days, 7);
  assert.equal(week.totals.calls, 56);
  assert.equal(week.totals.chains, 9);
  // day files of the local days, schema ssam-console-quality/1; the reader checkpoint knows the three UTC files
  c.app.flushDays();
  const files = fs.readdirSync(path.join(env.stateDir, 'agg-quality')).sort();
  assert.deepEqual(files, ['quality-2026-10-11.json', 'quality-2026-10-12.json', 'quality-2026-10-13.json']);
  const day = JSON.parse(fs.readFileSync(path.join(env.stateDir, 'agg-quality', 'quality-2026-10-12.json'), 'utf8'));
  assert.equal(day.schema, 'ssam-console-quality/1');
  assert.deepEqual(Object.keys(day.byToken).sort(), Object.keys(TOKENS));
  const cp = JSON.parse(fs.readFileSync(path.join(env.stateDir, 'checkpoint.json'), 'utf8'));
  assert.deepEqual(Object.keys(cp.readers.quality.files).sort(), ['20261011', '20261012', '20261013']);
  assert.equal(cp.readers.quality.files['20261011'].complete, true);
  assert.ok(Array.isArray(cp.quality.sessions.list));
  // the reader dropped the hostile lines the contract refuses and skipped the 5 KB one before any parse
  assert.equal(c.app.parts.quality.stats.dropped, 3, 'a bad token, a negative ms, another schema');
  assert.equal(c.app.parts.qualityReader.stats.skipped, 4, 'a time that is no date, the 5 KB line, the cut line and the text line');
});

test('the hostile file leaves no name, path or text in /state, the payloads or the exports', async t => {
  const env = qualityEnv();
  const c = await startConsole(env, { now: clock(NOW) });
  t.after(() => c.close());
  await c.app.tickAll();
  c.app.flushDays();
  c.app.writeCheckpoint(true);
  const texts = [];
  for (const f of filesUnder(env.stateDir)) texts.push([f.file, Buffer.from(f.text, 'latin1').toString('utf8')]);
  for (const q of ['?range=day&day=2026-10-13', '?range=7d', '?range=30d', '?range=day&day=2026-10-13&token=tok_0000000a1fa0']) {
    const r = await c.get('/api/quality' + q);
    assert.equal(r.status, 200, q);
    texts.push(['payload ' + q, r.text]);
  }
  for (const table of ['resumo', 'erros', 'problemas', 'correcoes', 'fases', 'tempo', 'voltas', 'causas', 'clientes', 'clientes-mcp']) {
    for (const format of ['csv', 'json']) {
      const r = await c.get(`/api/quality/export?range=day&day=2026-10-13&table=${table}&format=${format}`);
      assert.equal(r.status, 200, `${table} ${format}`);
      texts.push([`export ${table}.${format}`, r.text]);
    }
  }
  const tudo = await c.get('/api/quality/export?range=7d&table=tudo');
  texts.push(['export tudo', tudo.text]);
  const lines = await c.get('/api/quality/export?range=day&day=2026-10-13&table=linhas');
  texts.push(['export linhas', lines.text]);
  const found = texts.map(([where, text]) => [where, leaksIn(text)]).filter(([, l]) => l.length);
  assert.deepEqual(found, []);
  // the problem codes that are names became NATIVE_UNLISTED, the 40 codes folded into OTHER_CODES
  const d13 = (await c.get('/api/quality?range=day&day=2026-10-13')).body;
  assert.ok(d13.problems.some(p => p.code === 'NATIVE_UNLISTED'));
  assert.ok(d13.problems.some(p => p.code === 'OTHER_CODES'));
  assert.ok(d13.errors.every(e => /^[A-Z][A-Za-z0-9_]*$/.test(e.code)));
  // the lines export of that day is exactly what the contract keeps of each hostile line, in file order
  const expected = fs.readFileSync(path.join(FIX, 'hostile-expected.jsonl'), 'utf8').split('\n').filter(Boolean)
    .map(l => JSON.parse(l)).filter(Boolean).map(l => JSON.stringify(l));
  assert.deepEqual(lines.text.split('\n').filter(Boolean), expected);
  // the raw file does carry the verb-shaped free words; the lines export keeps only the listed verb of that agent.top
  assert.ok(fs.readFileSync(path.join(FIX, 'server-dir', 'quality-20261013.jsonl'), 'utf8').includes('odc.pipe:acme-folha-sntl'));
  const tops = lines.text.split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(l => l.agent?.top).map(l => l.agent.top.map(([label]) => label));
  assert.deepEqual(tops, [['o11.bridge:open_module']]);
});

test('a restart from the checkpoint in the middle of a file counts nothing twice', async t => {
  const env = qualityEnv();
  const file = path.join(env.serverDir, 'quality-20261012.jsonl');
  const full = fs.readFileSync(file);
  // cut inside the first line after 19:25Z, in the middle of Cliente Beta's chains (the console runs in real time: its
  // clock is at the cut, so no session is closed for idleness by a clock ahead of the lines)
  const rows = full.toString('utf8').split('\n');
  const i = rows.findIndex(l => l && JSON.parse(l).time > '2026-10-12T19:25:00.000Z');
  assert.ok(i > 0);
  const cut = Buffer.byteLength(rows.slice(0, i).join('\n') + '\n') + 40;
  fs.writeFileSync(file, full.subarray(0, cut));
  const now = clock('2026-10-12T19:25:00Z');
  const open = new Set();
  t.after(async () => { for (const x of open) await x.close(); });
  const start = async () => { const x = await startConsole(env, { now }); open.add(x); return x; };
  const stop = async x => { open.delete(x); await x.close(); };
  let c = await start();
  await c.app.tickAll();
  const partial = (await c.get(DAY12)).body;
  assert.ok(partial.totals.calls > 40 && partial.totals.calls < 54, `partial: ${partial.totals.calls}`);
  await stop(c);
  fs.writeFileSync(file, full);
  now.set(NOW);
  c = await start();
  assert.equal(c.app.qualityCold, false, 'resumed from the checkpoint');
  await c.app.tickAll();
  assertGolden((await c.get(DAY12)).body, expectedAll(), 'resumed');
  assertGolden((await c.get(DAY12 + '&token=tok_0000000a1fa0')).body, expectedAlfa(), 'resumed alfa');
  // a third start with nothing new changes nothing
  await stop(c);
  c = await start();
  await c.app.tickAll();
  assertGolden((await c.get(DAY12)).body, expectedAll(), 'third start');
});

test('deleting /state/agg-quality rebuilds the same payload; an old checkpoint replays the quality only (usage files byte for byte)', async t => {
  const env = qualityEnv();
  const now = clock(NOW);
  writeAudit(env.serverDir, [
    { time: '2026-10-12T18:00:02.615Z', token: 'tok_0000000a1fa0', customer: 'Cliente Alfa', tool: 'ssam_doctor', ms: 2615, ok: false, error: 'DOCTOR_LANE_UNUSABLE' },
    { time: '2026-10-12T18:00:11.767Z', token: 'tok_0000000a1fa0', customer: 'Cliente Alfa', tool: 'ssam_connect', ms: 3767, ok: true },
  ]);
  const open = new Set();
  t.after(async () => { for (const x of open) await x.close(); });
  const start = async () => { const x = await startConsole(env, { now }); open.add(x); return x; };
  const stop = async x => { open.delete(x); await x.close(); };
  let c = await start();
  await c.app.tickAll();
  await stop(c);
  const usageFiles = () => Object.fromEntries(fs.readdirSync(path.join(env.stateDir, 'agg')).map(n => [n, fs.readFileSync(path.join(env.stateDir, 'agg', n), 'utf8')]));
  const before = usageFiles();
  assert.ok(Object.keys(before).length > 0);
  // 1. the quality day files are deleted: the quality cold start alone rebuilds them
  fs.rmSync(path.join(env.stateDir, 'agg-quality'), { recursive: true });
  c = await start();
  assert.equal(c.app.cold, false, 'usage resumed');
  assert.equal(c.app.qualityCold, true, 'quality rebuilt');
  await c.app.tickAll();
  assertGolden((await c.get(DAY12)).body, expectedAll(), 'rebuilt');
  assert.equal((await c.get('/api/usage?range=day&day=2026-10-12')).body.totals.calls, 2);
  await stop(c);
  assert.deepEqual(usageFiles(), before, 'usage day files unchanged');
  // 2. a checkpoint of an image before the quality records (no readers.quality, no quality part)
  const cpFile = path.join(env.stateDir, 'checkpoint.json');
  const cp = JSON.parse(fs.readFileSync(cpFile, 'utf8'));
  delete cp.readers.quality;
  delete cp.quality;
  fs.writeFileSync(cpFile, JSON.stringify(cp));
  c = await start();
  assert.equal(c.app.cold, false);
  assert.equal(c.app.qualityCold, true);
  await c.app.tickAll();
  assertGolden((await c.get(DAY12)).body, expectedAll(), 'old checkpoint');
  assertGolden((await c.get(DAY12 + '&token=tok_0000000a1fa0')).body, expectedAlfa(), 'old checkpoint alfa');
  c.app.flushDays();
  assert.deepEqual(usageFiles(), before, 'usage day files unchanged after the quality replay');
  const after = JSON.parse(fs.readFileSync(cpFile, 'utf8'));
  assert.ok(after.readers.quality && after.quality, 'the checkpoint carries the quality part again');
});

test('the idle close after 2 h finishes a pending chain as "sem entrega" with the console clock', async t => {
  const env = qualityEnv();
  const now = clock(NOW);
  const c = await startConsole(env, { now });
  t.after(() => c.close());
  await c.app.tickAll();
  let p = (await c.get(DAY12)).body;
  assert.equal(p.totals.chainsOpen, 1);
  assert.equal(p.rounds.find(r => r.token === 'tok_0000000b2fb1').open, 0, 'the subagent session of Beta is still open (last line 19:25:13Z)');
  now.set('2026-10-12T21:25:12Z');
  await c.app.tickAll();
  assert.equal((await c.get(DAY12)).body.totals.chainsOpen, 1, 'one second before the 2 h');
  now.set('2026-10-12T21:30:00Z');
  await c.app.tickAll();
  p = (await c.get(DAY12)).body;
  assert.equal(p.totals.chainsOpen, 2);
  assert.equal(p.rounds.find(r => r.token === 'tok_0000000b2fb1').open, 1);
  assert.equal(p.totals.chains, 8, 'closed chains unchanged');
});

test('no quality files: available false, firstDay null, zeros; the notice data of the view', async t => {
  const env = qualityEnv({ copy: false });
  const c = await startConsole(env, { now: clock(NOW) });
  t.after(() => c.close());
  await c.app.tickAll();
  const r = (await c.get('/api/quality')).body;
  S.assertShape(assert, r, S.Quality, 'empty');
  assert.equal(r.available, false);
  assert.equal(r.firstDay, null);
  assert.equal(r.range.kind, '7d');
  assert.equal(r.totals.calls, 0);
  assert.equal(r.totals.chains, 0);
  assert.equal(r.totals.wallP50Ms, null);
  for (const k of ['errors', 'problems', 'rules', 'phases', 'timeShare', 'rounds', 'causes', 'byCustomer', 'byClient']) assert.deepEqual(r[k], [], k);
  const vps = (await c.get('/api/vps')).body;
  assert.equal(vps.server.logs.qualityFiles, 0);
});

test('export: CSV with BOM, ; and CRLF, JSON tables, the whole payload, JSONL lines; headers and errors', async t => {
  const env = qualityEnv();
  const c = await startConsole(env, { now: clock(NOW) });
  t.after(() => c.close());
  await c.app.tickAll();
  const payload = (await c.get(DAY12)).body;
  const q = '/api/quality/export?range=day&day=2026-10-12';
  let r = await c.get(q + '&table=erros&format=csv');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'text/csv; charset=utf-8');
  assert.equal(r.headers['content-disposition'], 'attachment; filename="ssam-qualidade-erros-2026-10-12-2026-10-12.csv"');
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.ok(r.headers['content-security-policy']);
  assert.ok(r.text.startsWith('\uFEFF'), 'BOM');
  const rows = r.text.slice(1).split('\r\n');
  assert.equal(rows[rows.length - 1], '', 'ends with CRLF');
  assert.ok(!r.text.replace(/\r\n/g, '').includes('\n'), 'CRLF only');
  assert.equal(rows[0], 'Código;Ocorrências;% das falhas;Ferramentas;Clientes;Última vez');
  assert.equal(rows[1], 'PREFLIGHT_REFUSED;3;30;o11_deliver (2), studio_deliver (1);2;2026-10-12T19:24:32.400Z');
  assert.equal(rows.length - 2, payload.errors.length);
  r = await c.get(q + '&table=tempo');
  assert.equal(r.text.slice(1).split('\r\n')[1], 'o11_environment;232364;0;0;6,5;0,4;0;0;87,9;0;5,2', 'decimal comma, default format csv');
  r = await c.get(q + '&table=voltas&format=csv');
  assert.match(r.text.slice(1).split('\r\n')[1], /^Cliente Alfa;tok_0000000a1fa0;4;0;4;8;8;18;1;1;108713;364800;13355;28627;53,5$/);
  r = await c.get(q + '&table=correcoes&format=csv');
  assert.equal(r.text.slice(1).split('\r\n')[1], 'SORT_KEYS_SPLIT;ordenação escrita com vírgulas virou lista de chaves;6;2;studio_deliver (6);1');
  r = await c.get(q + '&table=clientes-mcp&format=csv');
  assert.equal(r.text.slice(1).split('\r\n')[1], 'Claude Code;2;3;1;1;0,3;11852');
  r = await c.get(q + '&table=resumo&format=csv');
  assert.ok(r.text.includes('\r\ncalls;54\r\n') && r.text.includes('\r\nproblemPhases.preflight;20\r\n'));
  r = await c.get(q + '&table=resumo&format=json');
  assert.deepEqual(JSON.parse(r.text).find(x => x.campo === 'idlePct'), { campo: 'idlePct', valor: 52.7 });
  for (const [table, key] of [['problemas', 'problems'], ['fases', 'phases'], ['voltas', 'rounds'], ['causas', 'causes'], ['clientes', 'byCustomer']]) {
    r = await c.get(`${q}&table=${table}&format=json`);
    assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
    assert.deepEqual(JSON.parse(r.text), payload[key], table);
  }
  r = await c.get(q + '&table=tudo&token=tok_0000000a1fa0');
  assert.equal(r.headers['content-disposition'], 'attachment; filename="ssam-qualidade-tudo-2026-10-12-2026-10-12-tok_0000000a1fa0.json"');
  assertGolden(JSON.parse(r.text), expectedAlfa(), 'tudo');
  // the lines of the day, each passed through the contract again: nothing outside the allowlist
  r = await c.get(q + '&table=linhas');
  assert.equal(r.headers['content-type'], 'application/x-ndjson; charset=utf-8');
  const lines = r.text.split('\n').filter(Boolean);
  const day12 = fs.readFileSync(path.join(FIX, 'server-dir', 'quality-20261012.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(lines, day12, 'the fixture day, byte for byte (the fixture is written in the contract order)');
  for (const l of lines) {
    assert.ok(Buffer.byteLength(l) + 1 <= MAX_LINE_BYTES);
    const v = JSON.parse(l);
    assert.deepEqual(sanitizeQualityLine(v, { nativeIds: c.app.parts.nativeIds }), v);
  }
  r = await c.get(q + '&table=linhas&format=jsonl&token=tok_0000000c3fc2');
  assert.ok(r.text.split('\n').filter(Boolean).every(l => JSON.parse(l).token === 'tok_0000000c3fc2'));
  r = await c.get('/api/quality/export?range=7d&table=linhas');
  assert.equal(r.status, 200);
  assert.equal(r.text.split('\n').filter(Boolean).length, 4 + 63, 'the past day (gz) and the fixture day');
  // errors: INVALID_FIELD for range, table and format; the key on every route
  const bad = async (p, field, message) => {
    const x = await c.get(p);
    assert.equal(x.status, 400, p);
    assert.equal(x.body.error.code, 'INVALID_FIELD', p);
    assert.equal(x.body.error.field, field, p);
    if (message) assert.equal(x.body.error.message, message);
  };
  await bad('/api/quality/export?range=30d&table=linhas', 'range', 'Campo inválido: range (linhas: até 7 dias).');
  await bad('/api/quality/export?range=7d&table=nada', 'table');
  await bad('/api/quality/export?range=7d', 'table');
  await bad('/api/quality/export?range=7d&table=__proto__', 'table');
  await bad('/api/quality/export?range=7d&table=tudo&format=csv', 'format');
  await bad('/api/quality/export?range=7d&table=erros&format=xml', 'format');
  await bad('/api/quality/export?range=7d&table=linhas&format=json', 'format');
  await bad('/api/quality?range=ano', 'range');
  await bad('/api/quality?range=day&day=2026-13-40', 'day');
  await bad('/api/quality?token=tok_x', 'token');
  for (const p of ['/api/quality', `${q}&table=erros`]) {
    const x = await c.api('GET', p, { key: null });
    assert.equal(x.status, 401, p);
    assert.equal(x.body.error.code, 'KEY_REQUIRED');
    assert.equal((await c.api('POST', p, { body: {} })).status, 405, p);
  }
});

test('export lines stop at the limit with a last line {"truncated":true,"lines":n}', async () => {
  const env = qualityEnv();
  const tz = createTz('America/Sao_Paulo');
  const views = createQualityViews({ tz, now: () => Date.parse(NOW), quality: null, serverDir: env.serverDir, nativeIds: new Set(), nameOf: () => null,
    indexing: () => null, qualityFileCount: () => 0, maxLines: 5 });
  const out = await views.lines(['2026-10-12'], null);
  assert.equal(out.length, 6);
  assert.deepEqual(JSON.parse(out[5]), { truncated: true, lines: 5 });
});

test('CSV cells: an apostrophe before = + - @ TAB CR, quotes around ; " CR LF, decimal comma, empty for null', () => {
  assert.equal(csvCell('=SOMA(A1:A9)'), "'=SOMA(A1:A9)");
  assert.equal(csvCell('+55 11'), "'+55 11");
  assert.equal(csvCell('-1'), "'-1");
  assert.equal(csvCell('@cmd'), "'@cmd");
  assert.equal(csvCell('\tx'), "'\tx");
  assert.equal(csvCell('\rx'), "\"'\rx\"");
  assert.equal(csvCell('a;b'), '"a;b"');
  assert.equal(csvCell('diz "oi"'), '"diz ""oi"""');
  assert.equal(csvCell('linha\nnova'), '"linha\nnova"');
  assert.equal(csvCell('=a;b'), "\"'=a;b\"");
  assert.equal(csvCell(52.7), '52,7');
  assert.equal(csvCell(54), '54');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvText(['A', 'B'], [['x', 1]]), '\uFEFFA;B\r\nx;1\r\n');
});

test('the engine keeps tool, code and family keys as own data (a tool named constructor, codes after a reload)', () => {
  const before = Object.getOwnPropertyNames(Object.prototype).sort();
  const days = new Map();
  const engine = createQualityEngine({ dayOf: iso => iso.slice(0, 10), dayAgg: d => { if (!days.has(d)) days.set(d, emptyQualityDay(d)); return days.get(d); } });
  const frame = { schema: 'ssam-quality/1', kind: 'call', token: 'tok_0000000a1fa0', session: 'abcdef012345', op: null, lane: null, gapMs: null, inFlight: 0 };
  engine.apply(sanitizeQualityLine({ ...frame, time: '2026-10-12T12:00:00.000Z', call: 1, tool: 'constructor', ms: 5, ok: false, code: 'RPC_32602', class: 'protocol' }));
  engine.apply(sanitizeQualityLine({ ...frame, time: '2026-10-12T12:00:01.000Z', call: 2, tool: 'constructor', ms: 5, ok: true, class: 'ok',
    norm: { n: 1, byRule: { SORT_KEYS_SPLIT: 1 } } }));
  const reloaded = JSON.parse(JSON.stringify([...days.values()]));
  const s = summarizeQuality(reloaded);
  assert.equal(s.totals.calls, 2);
  assert.deepEqual(s.errors.map(e => [e.code, e.tools[0].tool]), [['RPC_32602', 'constructor']]);
  assert.deepEqual(s.rules.map(r => r.rule), ['SORT_KEYS_SPLIT']);
  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), before);
});

test('server.log quality-failed: an Eventos line (warning, servidor) with the stage and the fs code', async t => {
  const env = qualityEnv({ copy: false });
  fs.writeFileSync(path.join(env.serverDir, 'server.log'), [
    { time: '2026-10-12T21:00:00.000Z', event: 'listening', mode: 'hosted', pid: 7, publicHosts: ['ssam.example.com'] },
    { time: '2026-10-12T21:10:00.000Z', event: 'quality-failed', stage: 'write', error: 'ENOSPC' },
  ].map(l => JSON.stringify(l) + '\n').join(''));
  const c = await startConsole(env, { now: clock(NOW) });
  t.after(() => c.close());
  const ev = (await c.get('/api/events?group=servidor')).body.events.find(e => e.text.includes('qualidade'));
  assert.equal(ev.text, 'O servidor não conseguiu gravar um registro de qualidade (write: ENOSPC).');
  assert.equal(ev.level, 'warning');
  assert.equal(ev.code, 'ENOSPC');
});

test('/api/vps reports the quality files and their bytes', async t => {
  const env = qualityEnv();
  const c = await startConsole(env, { now: clock(NOW) });
  t.after(() => c.close());
  const logs = (await c.get('/api/vps')).body.server.logs;
  assert.equal(logs.qualityFiles, 3);
  const size = ['quality-20261011.jsonl.gz', 'quality-20261012.jsonl', 'quality-20261013.jsonl'].reduce((s, n) => s + fs.statSync(path.join(env.serverDir, n)).size, 0);
  assert.equal(logs.qualityB, size);
});

// The console's incremental rules against the normative text (tests/fixtures/quality/reference-aggregate.mjs) on random
// days: several customers, sessions and MCP clients, deliveries refused and fixed, creations, parallel calls, pauses that
// break a chain, sessions left open (closed for idleness by the clock), three local days, one license or all.
test('random days: the engine and the range summary give what reference-aggregate.mjs gives', async () => {
  const { aggregate } = await import(new URL('./fixtures/quality/reference-aggregate.mjs', import.meta.url).href);
  const tz = createTz('America/Sao_Paulo');
  let seed = 7;
  const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  const pickOne = list => list[Math.floor(rnd() * list.length)];
  const TOOLS = ['ssam_doctor', 'ssam_map', 'ssam_discover', 'o11_deliver', 'studio_deliver', 'o11_environment', 'studio_create', 'o11_inspect'];
  const CODES = ['EXPR_UNKNOWN_IDENTIFIER', 'EXPRESSION_SYNTAX', 'FUNCTION_UNKNOWN', 'ExpressionUnknownObject', 'PROPERTY_NOT_WRITABLE'];
  const toks = ['tok_0000000a1fa0', 'tok_0000000b2fb1', 'tok_0000000c3fc2'];
  const native = new Set(['ExpressionUnknownObject']);
  const seen = { chains: 0, open: 0, causes: 0, longGaps: 0, shared: 0, clients: 0, normalizations: 0 };
  for (let round = 0; round < 12; round++) {
    const lines = [];
    const base = Date.parse('2026-10-10T12:00:00.000Z');
    for (let s = 0; s < 9; s++) {
      const token = pickOne(toks), session = (round * 100 + s).toString(16).padStart(12, '0');
      let t = base + Math.floor(rnd() * 3 * 86400_000);
      const head = { schema: 'ssam-quality/1', token, session };
      lines.push({ ...head, kind: 'session', time: new Date(t).toISOString(), event: 'opened', client: pickOne(['codex', 'claude-code', 'cursor', 'other']) });
      let lastEnd = null;
      const n = 1 + Math.floor(rnd() * 25);
      for (let call = 1; call <= n; call++) {
        const gap = rnd() < 0.08 ? 700_000 + Math.floor(rnd() * 2_400_000) : Math.floor(rnd() * 40_000);
        const parallel = call > 1 && rnd() < 0.15;
        const arrival = lastEnd === null ? t : parallel ? lastEnd - 200 : lastEnd + gap;
        const ms = 50 + Math.floor(rnd() * 30_000);
        const tool = pickOne(TOOLS);
        const op = tool === 'o11_environment' ? pickOne(['inventory', 'create-app']) : null;
        const roll = rnd();
        const attempt = ['o11_deliver', 'studio_deliver', 'studio_create'].includes(tool) || op === 'create-app';
        const fields = attempt && roll < 0.35
          ? { ok: false, code: 'PREFLIGHT_REFUSED', class: 'refused', deliv: null,
            problems: { n: 3, err: 3, warn: 0, byCode: { [pickOne(CODES)]: 2, [pickOne(CODES)]: 1 }, withPatch: { [CODES[0]]: 1 }, byPhase: { preflight: 3 }, cut: false } }
          : attempt && roll < 0.75 ? { ok: true, code: null, class: 'delivered', deliv: tool === 'studio_create' || op ? 'criado' : 'entregue' }
          : roll < 0.85 ? { ok: false, code: 'AGENT_NOT_CONNECTED', class: 'failed', deliv: null } : { ok: true, code: null, class: 'ok', deliv: null };
        const shared = rnd() < 0.1;
        lines.push({ ...head, kind: 'call', time: new Date(arrival + ms).toISOString(), call, tool, op, lane: 'o11', ms,
          gapMs: call === 1 || parallel ? null : arrival - lastEnd, inFlight: parallel ? 1 : 0, ...fields, step: null,
          ...(rnd() < 0.3 ? { norm: { n: 2, byRule: { SORT_KEYS_SPLIT: 2 } } } : {}),
          t: { capture: Math.floor(ms / 4), kernelOwn: Math.floor(ms / 3), rest: ms - Math.floor(ms / 4) - Math.floor(ms / 3) },
          agent: { n: 2, failed: 0, bytes: 1000, shared }, ...(rnd() < 0.3 ? { kernel: { runs: 1, cold: 1, worker: 0, ms: Math.floor(ms / 3) } } : {}) });
        lastEnd = Math.max(lastEnd ?? 0, arrival + ms);
      }
      if (rnd() < 0.6) lines.push({ ...head, kind: 'session', time: new Date(lastEnd + 60_000).toISOString(), event: 'closed', client: 'codex', reason: 'idle', calls: n, openMs: 1 });
    }
    lines.sort((a, b) => a.time.localeCompare(b.time) || (a.kind === 'session' && a.event === 'opened' ? -1 : 0));
    const now = base + 4 * 86400_000;
    const days = new Map();
    const engine = createQualityEngine({ dayOf: iso => tz.day(iso), dayAgg: d => { if (!days.has(d)) days.set(d, emptyQualityDay(d)); return days.get(d); } });
    for (const l of lines) { const clean = sanitizeQualityLine(l, { nativeIds: native }); assert.ok(clean, JSON.stringify(l)); engine.apply(clean); }
    engine.sweep(now);
    const stored = JSON.parse(JSON.stringify([...days.values()]));
    for (const range of [['2026-10-10'], ['2026-10-11'], ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13']]) {
      for (const token of [null, toks[0]]) {
        const want = aggregate(lines, { days: range, token, now, nativeIds: native });
        const got = summarizeQuality(stored.filter(d => range.includes(d.day)), { token });
        assert.deepEqual(got, want, `round ${round}, ${range.join(',')}, ${token ?? 'all'}`);
        seen.chains += want.totals.chains; seen.open += want.totals.chainsOpen; seen.causes += want.causes.length; seen.longGaps += want.totals.longGaps;
        seen.shared += want.totals.sharedCalls; seen.clients += want.byClient.length; seen.normalizations += want.totals.normalizations;
      }
    }
  }
  for (const [k, v] of Object.entries(seen)) assert.ok(v > 0, `the random days exercised ${k}`);
});
