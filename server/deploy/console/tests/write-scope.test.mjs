// DESIGN 2.4 "What the console writes": a static scan of server/deploy/console/*.mjs for file-writing calls, allowed only in
// the module that owns /state writes (state.mjs, paths under CONSOLE_STATE_DIR), in the console-audit appender
// (history.mjs, the fixed console-audit.jsonl name) and, for the socket the design asks for (7.2: unlink a stale socket,
// chmod 0600), in listen.mjs on CONSOLE_SOCKET only. Then a runtime check: after a full session with every mutation, the
// only files created or changed are under the state dir, console-audit.jsonl and the token module's tokens.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CONSOLE_DIR, FAKE_MODULE, HERE, makeEnv, startConsole } from './helpers.mjs';
import { buildScenario } from './scenario.mjs';

const WRITE = /\b(writeFile|appendFile|rename|unlink|rm|rmdir|mkdir|mkdtemp|copyFile|cp|createWriteStream|truncate|ftruncate|chmod|chown|lchown|symlink|link|utimes|open)(Sync)?\s*\(/g;
const SOURCES = fs.readdirSync(CONSOLE_DIR).filter(n => n.endsWith('.mjs'));

function calls(text) {
  const out = [];
  for (const m of text.matchAll(WRITE)) {
    const name = m[1];
    if (name === 'open') {
      // a read-only open is fine: fsp.open(file, 'r') / fs.openSync(file, 'r'); anything else is a write
      const rest = text.slice(m.index + m[0].length, m.index + m[0].length + 120);
      if (/^[^)]*,\s*'r'\s*\)/.test(rest)) continue;
    }
    out.push({ name: name + (m[2] ?? ''), arg: firstArg(text, m.index + m[0].length) });
  }
  return out;
}
// The first argument of a call, up to the first top-level comma or the closing parenthesis.
function firstArg(text, from) {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) return text.slice(from, i).trim(); depth--; }
    else if (ch === ',' && depth === 0) return text.slice(from, i).trim();
  }
  return text.slice(from).trim();
}

test('static scan: write calls only in state.mjs, the console-audit appender and the socket of listen.mjs', () => {
  assert.ok(SOURCES.length >= 15, 'console modules found');
  const found = {};
  for (const name of SOURCES) {
    const list = calls(fs.readFileSync(path.join(CONSOLE_DIR, name), 'utf8'));
    if (list.length) found[name] = list;
  }
  assert.deepEqual(Object.keys(found).sort(), ['history.mjs', 'listen.mjs', 'state.mjs']);
  // state.mjs: every path comes from target(rel) under the state root (file, tmp, the dir of file, dirOf(rel))
  for (const c of found['state.mjs']) assert.ok(['file', 'tmp', 'path.dirname(file)', 'dirOf(rel)'].includes(c.arg), `state.mjs ${c.name}(${c.arg})`);
  const state = fs.readFileSync(path.join(CONSOLE_DIR, 'state.mjs'), 'utf8');
  assert.match(state, /const root = path\.resolve\(stateDir\);/);
  assert.match(state, /if \(!full\.startsWith\(root \+ path\.sep\)\) throw new Error\('state path refused'\);/);
  // history.mjs: one append, to <SSAM_SERVER_DIR>/console-audit.jsonl
  assert.deepEqual(found['history.mjs'], [{ name: 'appendFileSync', arg: 'auditFile' }]);
  const historyText = fs.readFileSync(path.join(CONSOLE_DIR, 'history.mjs'), 'utf8');
  assert.match(historyText, /export const AUDIT_FILE = 'console-audit\.jsonl';/);
  assert.match(historyText, /const auditFile = path\.join\(serverDir, AUDIT_FILE\);/);
  // listen.mjs: the stale socket and its mode, nothing else
  assert.deepEqual(found['listen.mjs'], [{ name: 'unlinkSync', arg: 'socketPath' }, { name: 'chmodSync', arg: 'socketPath' }]);
  assert.match(fs.readFileSync(path.join(CONSOLE_DIR, 'listen.mjs'), 'utf8'), /const socketPath = config\.socket;/);
  // the state module is built from CONSOLE_STATE_DIR only
  assert.match(fs.readFileSync(path.join(CONSOLE_DIR, 'app.mjs'), 'utf8'), /const state = createState\(config\.stateDir\);/);
  // nobody but the token module touches tokens.json, and nothing reads it directly
  for (const name of SOURCES) assert.ok(!fs.readFileSync(path.join(CONSOLE_DIR, name), 'utf8').includes("'tokens.json'"), `${name} names tokens.json`);
});

function snapshot(root) {
  const out = new Map();
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else { const st = fs.statSync(full); out.set(full, `${st.size}:${st.mtimeMs}`); }
    }
  };
  walk(root);
  return out;
}

test('runtime: a full session writes only the state dir, console-audit.jsonl and tokens.json', async t => {
  const env = makeEnv({ tokenModule: FAKE_MODULE });
  const sc = await buildScenario(env, { module: FAKE_MODULE });
  // the quality records of DESIGN-QUALIDADE (fixture days, gz and hostile lines): read, aggregated and exported, written
  // only under the state dir (agg-quality/, the checkpoint)
  fs.cpSync(path.join(HERE, 'fixtures', 'quality', 'server-dir'), env.serverDir, { recursive: true });
  env.config.kernelCatalog = path.join(HERE, 'fixtures', 'quality', 'catalog');
  const before = snapshot(env.root);
  const c = await startConsole(env);
  t.after(() => c.close());
  await c.app.tickAll();
  await c.app.parts.workspaces.run();
  for (const p of ['/api/quality?range=30d', '/api/quality/export?range=30d&table=fases', '/api/quality/export?range=7d&table=linhas', '/api/quality/export?range=7d&table=tudo']) {
    assert.equal((await c.get(p)).status, 200, p);
  }
  assert.ok(fs.readdirSync(path.join(env.stateDir, 'agg-quality')).length > 0);
  const lic = (await c.get('/api/licenses')).body.licenses;
  const beta = lic.find(l => l.id === sc.beta.id);
  const steps = [
    ['/api/licenses', { customer: 'Cliente Delta', days: 30, lanes: ['odc'], confirm: 'Cliente Delta' }],
    [`/api/licenses/${sc.beta.id}/renew`, { days: 30, confirm: 'Cliente Beta', expectExpiresAt: beta.expiresAt }],
    [`/api/licenses/${sc.alfa.id}/lanes`, { lanes: ['odc'], confirm: 'Cliente Alfa', expectLanes: ['odc', 'o11'] }],
    [`/api/licenses/${sc.alfa.id}/agent-rotate`, { confirm: 'Cliente Alfa' }],
    [`/api/licenses/${sc.beta.id}/revoke`, { confirm: 'Cliente Beta' }],
    ['/api/alerts/ack', { id: `acesso-outra-maquina:${sc.alfa.id}:def456`, hours: null }],
    ['/api/alerts/unack', { id: `acesso-outra-maquina:${sc.alfa.id}:def456` }],
  ];
  await c.app.tickAlerts();
  for (const [p, body] of steps) { const r = await c.post(p, body); assert.ok(r.status < 300, `${p}: ${r.text}`); }
  await c.app.tickAll();
  c.app.flushDays();
  c.app.writeCheckpoint(true);
  const after = snapshot(env.root);
  const allowed = f => f.startsWith(env.stateDir + path.sep) || f === path.join(env.serverDir, 'console-audit.jsonl') || f === path.join(env.serverDir, 'tokens.json');
  const changed = [...after].filter(([f, sig]) => before.get(f) !== sig).map(([f]) => f);
  assert.ok(changed.length > 0);
  assert.deepEqual(changed.filter(f => !allowed(f)), []);
  for (const f of before.keys()) assert.ok(after.has(f), `${f} was removed`);
});
