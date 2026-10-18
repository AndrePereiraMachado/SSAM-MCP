import './fixtures/isolated-profile.mjs';
// fix/posix-segment (review C:\t\revisoes\no-internals-7\REVISAO.md, item 6): a root of a POSIX server (/app, /opt, /tmp,
// /data/server...) is a server path only as a whole segment. A JSON pointer that starts with the same letters
// (/applicationKey, /apps, /options/0) is the name of an argument, and a path at the end of a sentence leaves its period
// (as a Windows path does). A pointer the answer itself names in violations[].path (an exact root name such as /app
// included) is never a server path, in the runtime, report and documentation modes alike: a licensee reads an
// INPUT_INVALID refusal exactly as the owner does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { exposedValue } from '../exposure.mjs';

const runtime = text => exposedValue({ ok: false, error: text }, { exposure: 'licensee', tool: 'ssam_job' }).error;

test('a POSIX root is a server path only as a whole segment, and a path leaves its period (item 6)', () => {
  const server = [
    ['cannot read /opt/ssam/x.json', 'cannot read <server>'], ['cannot read /tmp/a.json.', 'cannot read <server>.'],
    ['HOME is /home/ssam', 'HOME is <server>'], ['see (/srv/x)', 'see (<server>)'],
    ['state in /data/server/state/day.json; retry', 'state in <server>; retry'], ['under /app/kernel/.local', 'under <server>'],
    ['the Studio /studio/o11/bin', 'the Studio <server>'], ['log /var/log/x.log, again', 'log <server>, again'],
    ['the root /tmp.', 'the root <server>.'], ['at /opt: x', 'at <server>: x'],
  ];
  for (const [text, expected] of server) assert.equal(runtime(text), expected, text);
  const pointers = ['the value at /options/0 is not one of the enum', '1 argument problem(s): /applicationKey expected string', '/apps expected array',
    'see /variables/0', 'see /tmpl/x', '/data/serverName is unset', '/homepage'];
  for (const text of pointers) assert.equal(runtime(text), text, text);
  // an exact root name that no answer names as an argument is still read as the root
  assert.equal(runtime('/app expected string'), '<server> expected string');
});

test('a pointer the answer names in violations[].path stays, in every mode; a server path beside it still goes (item 6)', () => {
  const refusal = { ok: false, code: 'INPUT_INVALID', error: '2 argument problem(s) for o11_environment: /apps expected array, received string; /app expected string',
    violations: [{ path: '/apps', message: 'expected array, received string' }, { path: '/app', message: 'expected string' }] };
  // runtime (a lane tool), report (ssam_doctor) and documentation (ssam_discover)
  for (const tool of ['o11_environment', 'ssam_doctor', 'ssam_discover']) {
    const out = exposedValue(refusal, { exposure: 'licensee', tool });
    assert.equal(out.error, refusal.error, tool);
    assert.deepEqual(out.violations, refusal.violations, tool);
  }
  const mixed = { ok: false, code: 'INPUT_INVALID', error: '1 argument problem(s): /app expected string; cannot read /app/kernel/x.json nor /app', violations: [{ path: '/app' }] };
  for (const tool of ['o11_environment', 'ssam_discover']) {
    assert.equal(exposedValue(mixed, { exposure: 'licensee', tool }).error, '1 argument problem(s): /app expected string; cannot read <server> nor /app', tool);
  }
  // no violations: the root is the root
  assert.equal(exposedValue({ ok: false, error: 'cannot read /app and /opt/x' }, { exposure: 'licensee', tool: 'o11_environment' }).error, 'cannot read <server> and <server>');
});

// The real refusals of the review (and the other tools whose top-level arguments start like a root, from the listing): the
// input layer refuses them before any handler runs, so no Studio, CLI or network is involved.
const CALLS = [['ssam_debug_run', { applicationKey: 5 }], ['o11_environment', { apps: 'x', app: 5 }], ['o11_service_center_read', { applications: 'x', applicationLimit: 'y' }],
  ['o11_extension', { application: 5 }], ['ssam_discover', { lane: 'o11', intent: 'x', app: { a: 1 } }], ['ssam_preview', { app: { a: 1 } }],
  ['ssam_app_url', { app: { a: 1 } }], ['ssam_grant', { app: { a: 1 } }]];
async function refusals(profile) {
  const { createSsamServer } = await import('../ssam.mjs');
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { Client } = await import('@modelcontextprotocol/client');
  const server = await createSsamServer({ profile: 'all', deps: { exposure: { profile, caller: () => 'pointers-' + profile + '-' + process.pid, dayBytes: 1e9 } } });
  const client = new Client({ name: 'no-internals-pointers', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const out = [];
    for (const [name, args] of CALLS) {
      const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
      out.push(r.structuredContent ?? JSON.parse(r.content[0].text));
    }
    return out;
  } finally { await client.close(); await server.close(); }
}
test('live: a licensee reads an INPUT_INVALID refusal exactly as the owner does, error and violations[].path (item 6)', async () => {
  const owner = await refusals('owner');
  const licensee = await refusals('licensee');
  CALLS.forEach(([name, args], i) => {
    const label = name + ' ' + JSON.stringify(args);
    assert.equal(owner[i].code, 'INPUT_INVALID', label);
    assert.equal(licensee[i].code, 'INPUT_INVALID', label);
    assert.doesNotMatch(licensee[i].error, /<server>/, label);
    assert.equal(licensee[i].error, owner[i].error, label);
    assert.deepEqual(licensee[i].violations, owner[i].violations, label);
  });
});
