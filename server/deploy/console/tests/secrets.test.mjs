// DESIGN 2.3 and 7.2 "secrets": issue and agent-rotate through the real token module and through a module with
// renew/setLanes; then no file under the state dirs, no console-audit line, no event and no stdout line may match
// ssam_[A-Za-z0-9_-]{20,}. Also run the real entry point (server.mjs --tcp) and scan its captured stdout.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CONSOLE_DIR, FAKE_MODULE, REAL_MODULE, SECRET, filesUnder, makeEnv, request, sleep, startConsole } from './helpers.mjs';
import { buildScenario } from './scenario.mjs';

function scan(env, logs, extra = []) {
  const hits = [];
  for (const f of filesUnder(env.stateDir)) if (SECRET.test(f.text)) hits.push(f.file);
  const audit = path.join(env.serverDir, 'console-audit.jsonl');
  if (fs.existsSync(audit) && SECRET.test(fs.readFileSync(audit, 'utf8'))) hits.push(audit);
  for (const l of logs) if (SECRET.test(l)) hits.push('log: ' + l.slice(0, 60));
  for (const x of extra) if (SECRET.test(x)) hits.push('extra: ' + x.slice(0, 60));
  return hits;
}

for (const [label, module] of [['real module (current image)', REAL_MODULE], ['module with renew/setLanes (24th image)', FAKE_MODULE]]) {
  test(`no secret is stored or logged: ${label}`, async t => {
    const env = makeEnv({ tokenModule: module });
    const sc = await buildScenario(env, { module });
    const c = await startConsole(env);
    t.after(() => c.close());
    const issued = await c.post('/api/licenses', { customer: 'Cliente Delta', days: 30, lanes: ['odc', 'o11'], confirm: 'Cliente Delta' });
    assert.equal(issued.status, 201);
    assert.match(issued.body.secret.token, SECRET, 'the answer carries the token once');
    assert.match(issued.body.secret.agentCredential, SECRET);
    assert.equal(issued.headers['cache-control'], 'no-store');
    const rotated = await c.post(`/api/licenses/${sc.alfa.id}/agent-rotate`, { confirm: 'Cliente Alfa' });
    assert.equal(rotated.status, 200);
    assert.match(rotated.body.secret.agentCredential, SECRET);
    if (module === FAKE_MODULE) {
      const lic = (await c.get('/api/licenses')).body.licenses.find(l => l.id === sc.beta.id);
      assert.equal((await c.post(`/api/licenses/${sc.beta.id}/renew`, { days: 30, confirm: 'Cliente Beta', expectExpiresAt: lic.expiresAt })).status, 200);
      assert.equal((await c.post(`/api/licenses/${sc.beta.id}/lanes`, { lanes: ['odc', 'o11'], confirm: 'Cliente Beta', expectLanes: ['odc'] })).status, 200);
    }
    await c.post(`/api/licenses/${issued.body.license.id}/revoke`, { confirm: 'Cliente Delta' });
    await c.post('/api/key/rotate', {}).then(r => { c.key = r.body.key; });
    await c.app.tickAll();
    c.app.flushDays();
    c.app.writeCheckpoint(true);
    const events = JSON.stringify((await c.get('/api/events?limit=500')).body);
    const history = JSON.stringify((await c.get('/api/history')).body);
    const others = await Promise.all(['/api/overview', '/api/licenses', '/api/live', '/api/usage?range=30d', '/api/vps', '/api/meta'].map(p => c.get(p).then(r => r.text)));
    assert.deepEqual(scan(env, c.logs, [events, history, ...others]), []);
    assert.ok(fs.existsSync(path.join(env.stateDir, 'checkpoint.json')));
    assert.ok(c.logs.some(l => l.includes('"action":"issue"')), 'mutations are logged');
    for (const l of c.logs) assert.ok(!/Cliente/.test(l), `customer name in a log line: ${l}`);
    const auditLines = fs.readFileSync(path.join(env.serverDir, 'console-audit.jsonl'), 'utf8').trim().split('\n').map(x => JSON.parse(x));
    assert.ok(auditLines.length >= 4);
  });
}

test('the entry point logs no secret and no customer name on stdout', async t => {
  const env = makeEnv();
  await buildScenario(env);
  const child = spawn(process.execPath, [path.join(CONSOLE_DIR, 'server.mjs'), '--tcp', '127.0.0.1:0'], {
    env: { ...process.env, SSAM_SERVER_DIR: env.serverDir, CONSOLE_STATE_DIR: env.stateDir, CONSOLE_HOST_JSON: env.hostJson,
      CONSOLE_PUBLIC_DIR: env.publicDir, CONSOLE_TOKEN_MODULE: REAL_MODULE, CONSOLE_DOMAIN: 'ssam.example.com' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  t.after(() => { try { child.kill(); } catch { /* gone */ } });
  let port = null;
  for (let i = 0; i < 100 && !port; i++) { await sleep(50); const m = /"console":"listening","socket":"127\.0\.0\.1:(\d+)"/.exec(out); if (m) port = Number(m[1]); }
  assert.ok(port, 'listening line: ' + out + err);
  const first = JSON.parse(out.trim().split('\n')[0]);
  assert.deepEqual(Object.keys(first), ['console', 'socket', 'capabilities']);
  assert.deepEqual(first.capabilities, { issue: true, revoke: true, agentRotate: true, renew: false, lanes: false });
  const key = fs.readFileSync(path.join(env.stateDir, 'access.key'), 'utf8');
  assert.match(key, /^[A-Za-z0-9_-]{43}$/);
  const headers = { 'X-SSAM-Console-Key': key, 'Content-Type': 'application/json' };
  const issued = await request(port, { method: 'POST', path: '/api/licenses', headers, body: { customer: 'Cliente Delta', days: 30, lanes: ['odc'], confirm: 'Cliente Delta' } });
  assert.equal(issued.status, 201);
  const rotated = await request(port, { method: 'POST', path: `/api/licenses/${issued.body.license.id}/agent-rotate`, headers, body: { confirm: 'Cliente Delta' } });
  assert.equal(rotated.status, 200);
  const bad = await request(port, { method: 'POST', path: '/api/licenses', headers, raw: '{"customer": "ssam_AAAAAAAAAAAAAAAAAAAAAAAAAAAA", oops' });
  assert.equal(bad.status, 400);
  await sleep(100);
  assert.ok(!SECRET.test(out), 'secret on stdout');
  assert.ok(!/Cliente/.test(out), 'customer name on stdout');
  assert.ok(out.includes('"console":"action","action":"issue"'));
  assert.ok(out.includes('"console":"action","action":"agent-rotate"'));
  assert.ok(!out.includes(key), 'access key on stdout');
  for (const f of filesUnder(env.stateDir)) if (path.basename(f.file) !== 'access.key') assert.ok(!f.text.includes(key), `access key in ${f.file}`);
  // the stat of the socket file mode cannot be checked on Windows (TCP mode); listen.mjs chmods it to 0600 on Linux
});
