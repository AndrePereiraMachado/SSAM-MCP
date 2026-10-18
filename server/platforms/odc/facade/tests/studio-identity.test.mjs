// A-M1 + E2 of the minimal multi-version proposal (C:\t\multiver\minimo\PROPOSTA.md; docs/FASE2-AGENTE.md 7): the identity
// of the user's Studio against the build the hosted server serves, the one function the hub, the gate and the events read.
// Synthetic builds only (1.7.28.5000 served, 1.7.28.5023 installed): four numbers decide; another three-part version is
// never served; a build that differs only in the fourth number follows kernel.json studioBuildPolicy ("warn" by default,
// "refuse"); one refusal per direction (update the Studio / the server does not serve it yet) with both builds, what still
// works and "nothing ran", in English for the user and for the model (B3 of round 3: no pt-BR); the warnings studioBuildDiffers and
// studioNotServed.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { studioIdentity, buildPolicyOf, studioRefusal, studioWarningOf, studioVersions, fourPart, SERVER_ONLY_EXAMPLES, DEFAULT_BUILD_POLICY }
  from '../studio-identity.mjs';
import { hostedTools } from '../hosted/policy.mjs';

const K = { odc: '1.7.28', o11: '11.55.92', odcBridge: 'v97', builds: { odc: '1.7.28.5000', o11: '11.55.92.6000' } };
const at = (lane, version, kernel = K) => studioIdentity(lane, version === null ? null : { dir: 'C:\\Users\\someone\\Studio', version }, kernel);
const pick = (id, keys = ['lane', 'installed', 'served', 'relation', 'direction', 'policy', 'ok', 'warn']) => Object.fromEntries(keys.map(k => [k, id?.[k]]));

test('identity: the four-part build against the served build; another three-part version is older or newer, never served', () => {
  assert.deepEqual(pick(at('odc', '1.7.28.5000')), { lane: 'odc', installed: '1.7.28.5000', served: '1.7.28.5000', relation: 'same', direction: null, policy: 'warn', ok: true, warn: false });
  assert.deepEqual(pick(at('odc', '1.7.28.5023')), { lane: 'odc', installed: '1.7.28.5023', served: '1.7.28.5000', relation: 'build-differs', direction: 'newer', policy: 'warn', ok: true, warn: true });
  assert.deepEqual(pick(at('odc', '1.7.28.4990')), { lane: 'odc', installed: '1.7.28.4990', served: '1.7.28.5000', relation: 'build-differs', direction: 'older', policy: 'warn', ok: true, warn: true });
  assert.deepEqual(pick(at('odc', '1.7.29.100')), { lane: 'odc', installed: '1.7.29.100', served: '1.7.28.5000', relation: 'newer', direction: 'newer', policy: 'warn', ok: false, warn: false });
  assert.deepEqual(pick(at('o11', '11.55.91.65258')), { lane: 'o11', installed: '11.55.91.65258', served: '11.55.92.6000', relation: 'older', direction: 'older', policy: 'warn', ok: false, warn: false });
  assert.equal(at('odc', '1.7.100.1').relation, 'newer', 'numbers, not text: 1.7.100 is newer than 1.7.28');
  assert.equal(at('odc', '1.7.3.99999').relation, 'older');
  // the agent reports no fourth number: the build cannot be confirmed, so the build policy decides (warn by default)
  assert.deepEqual(pick(at('odc', '1.7.28')), { lane: 'odc', installed: '1.7.28', served: '1.7.28.5000', relation: 'build-unknown', direction: null, policy: 'warn', ok: true, warn: true });
  // an installed Studio whose version the agent could not read, and no Studio at all
  assert.deepEqual(pick(at('odc', null)), { lane: 'odc', installed: null, served: '1.7.28.5000', relation: 'not-installed', direction: null, policy: 'warn', ok: false, warn: false });
  const unread = studioIdentity('odc', { dir: 'C:\\x', version: null }, K);
  assert.deepEqual(pick(unread), { lane: 'odc', installed: null, served: '1.7.28.5000', relation: 'unknown', direction: null, policy: 'warn', ok: false, warn: false });
  assert.equal(studioIdentity('odc', { version: 'garbage' }, K).relation, 'unknown');
  // a version string the hub keeps as given (Hello), or the version alone
  assert.equal(studioIdentity('odc', '1.7.28.5023', K).relation, 'build-differs');
  // a server that does not know its own build (outside an image, no Studio of its own) compares three numbers, as before
  assert.deepEqual(pick(at('odc', '1.7.28.5023', { odc: '1.7.28', odcBridge: 'v97' })), { lane: 'odc', installed: '1.7.28.5023', served: '1.7.28', relation: 'same', direction: null, policy: 'warn', ok: true, warn: false });
  // a build of another three-part version in kernel.builds is not the served build
  assert.equal(at('odc', '1.7.28.5023', { ...K, builds: { odc: '1.7.27.1' } }).served, '1.7.28');
  // no kernel for the lane: no identity (the hub answers KERNEL_UNAVAILABLE before)
  assert.equal(at('odc', '1.7.28.5000', { o11: '11.55.92' }), null);
  assert.equal(fourPart('1.7.28.10873'), '1.7.28.10873'); assert.equal(fourPart('01.7.28.010873 (x)'), '1.7.28.10873'); assert.equal(fourPart('1.7.28'), null);
});

test('policy: kernel.json studioBuildPolicy, one word or per lane; "warn" by default; an unknown value refuses and is named', () => {
  assert.equal(DEFAULT_BUILD_POLICY, 'warn');
  assert.deepEqual(buildPolicyOf(undefined), { odc: 'warn', o11: 'warn', invalid: false });
  assert.deepEqual(buildPolicyOf('refuse'), { odc: 'refuse', o11: 'refuse', invalid: false });
  assert.deepEqual(buildPolicyOf(' Warn '), { odc: 'warn', o11: 'warn', invalid: false });
  assert.deepEqual(buildPolicyOf({ odc: 'refuse' }), { odc: 'refuse', o11: 'warn', invalid: false });
  assert.deepEqual(buildPolicyOf('block'), { odc: 'refuse', o11: 'refuse', invalid: true }, 'fails closed');
  assert.deepEqual(buildPolicyOf({ odc: 3, o11: 'warn' }), { odc: 'refuse', o11: 'warn', invalid: true });
  assert.deepEqual(buildPolicyOf(42), { odc: 'refuse', o11: 'refuse', invalid: true });
  const refuse = { ...K, studioBuildPolicy: { odc: 'refuse' } };
  assert.deepEqual(pick(at('odc', '1.7.28.5023', refuse)), { lane: 'odc', installed: '1.7.28.5023', served: '1.7.28.5000', relation: 'build-differs', direction: 'newer', policy: 'refuse', ok: false, warn: false });
  assert.equal(at('odc', '1.7.28', refuse).ok, false, 'a build the agent does not report is refused too');
  assert.equal(at('odc', '1.7.28.5000', refuse).ok, true, 'the same build is served');
  assert.equal(at('o11', '11.55.92.6001', refuse).warn, true, 'the other lane keeps its own policy');
  assert.equal(at('odc', '1.7.28.5023', { ...K, studioBuildPolicy: 'refuse' }).ok, false, 'one word for both lanes');
});

const STILL = ['ssam_discover', 'ssam_reference', 'odc_search_operations'];
// B3 (round 3, owner rule of 2026-10-15): every text SSAM emits is English, with no bilingual line.
const PT_BR = /[ãõçáéíóúâêôà]|\b(não|deste|computador|Atualize|Aviso|Nada rodou|servidor|dono|ferramentas|continuam|rodou|repita|peça|abra|conecte|versões|faixa)\b/i;
test('one refusal per direction: both builds, what to do, what still works and "nothing ran", in English for the user and for the model', () => {
  const older = studioRefusal(at('odc', '1.7.27.10846'), { stillWorks: STILL });
  assert.deepEqual({ ok: older.ok, code: older.code, cause: older.cause, lane: older.lane, installed: older.installed, served: older.served, relation: older.relation, outcome: older.outcome, stillWorks: older.stillWorks },
    { ok: false, code: 'STUDIO_VERSION_MISMATCH', cause: 'STUDIO_UPDATE_REQUIRED', lane: 'odc', installed: '1.7.27.10846', served: ['1.7.28.5000'], relation: 'older', outcome: 'not-sent', stillWorks: STILL });
  assert.match(older.userMessage, /^The ODC Studio on this computer \(1\.7\.27\.10846\) is older than the ODC Studio the SSAM server serves \(1\.7\.28\.5000\)\./);
  assert.match(older.userMessage, /Update ODC Studio to 1\.7\.28\.5000 and open it again; then repeat the request\./);
  assert.match(older.userMessage, /Nothing ran on your Studio\./);
  assert.match(older.userMessage, /the server-only tools \(ssam_discover, ssam_reference, ssam_map, ssam_job, odc_search_operations\) keep working, with a warning\./);
  assert.match(older.error, /^This SSAM server serves ODC Studio 1\.7\.28\.5000; the user's machine has ODC Studio 1\.7\.27\.10846, which is older: update ODC Studio to 1\.7\.28\.5000/);
  assert.match(older.error, /Nothing ran on the user's Studio\./);
  assert.match(older.error, /Server-only tools \(ssam_discover, ssam_reference, ssam_map, ssam_job, odc_search_operations\) still work/);
  assert.equal(older.continuation.tool, 'ssam_doctor');
  assert.match(older.continuation.why, /userMessage/);
  assert.doesNotMatch(older.continuation.why, /pt-BR/, 'B3: the why no longer names pt-BR');

  const newer = studioRefusal(at('odc', '1.7.29.10900'), { stillWorks: STILL });
  assert.equal(newer.cause, 'STUDIO_VERSION_NOT_SERVED_YET');
  assert.match(newer.userMessage, /^The ODC Studio on this computer \(1\.7\.29\.10900\) is newer than the ODC Studio the SSAM server serves today \(1\.7\.28\.5000\)\./);
  assert.match(newer.userMessage, /The server does not have this version yet; the SSAM owner was already notified/);
  assert.match(newer.userMessage, /Do not roll ODC Studio back to the previous version and do not reinstall the agent/);
  assert.match(newer.userMessage, /Nothing ran on your Studio\./);
  assert.match(newer.error, /the server does not serve this version yet; the owner was notified/);
  assert.match(newer.error, /Do not roll the Studio back and do not reinstall the agent/);
  assert.match(newer.continuation.why, /never ask the user to roll the Studio back or to reinstall the agent/);
  for (const r of [older, newer]) {
    // the impossible continuation of the old gate ("install the Studio at the server's version") is gone
    assert.doesNotMatch(JSON.stringify(r), /install ODC Studio|instal(e|ar) o ODC Studio|to install/i);
  }

  // the same three numbers, another build, under "refuse": the direction decides the text
  const refuse = { ...K, studioBuildPolicy: 'refuse' };
  const buildNewer = studioRefusal(at('odc', '1.7.28.5023', refuse));
  assert.deepEqual({ cause: buildNewer.cause, relation: buildNewer.relation, installed: buildNewer.installed, served: buildNewer.served, policy: buildNewer.policy },
    { cause: 'STUDIO_VERSION_NOT_SERVED_YET', relation: 'build-differs', installed: '1.7.28.5023', served: ['1.7.28.5000'], policy: 'refuse' });
  assert.match(buildNewer.userMessage, /^The ODC Studio on this computer is build 1\.7\.28\.5023; the SSAM server serves build 1\.7\.28\.5000 \(same version 1\.7\.28, another build\)/);
  assert.match(buildNewer.userMessage, /does not have this build yet; the SSAM owner was already notified/);
  assert.match(buildNewer.error, /same version 1\.7\.28, another build.*studioBuildPolicy "refuse"/);
  const buildOlder = studioRefusal(at('odc', '1.7.28.4990', refuse));
  assert.equal(buildOlder.cause, 'STUDIO_UPDATE_REQUIRED');
  assert.match(buildOlder.userMessage, /Update ODC Studio \(the server serves build 1\.7\.28\.5000\)/);
  const unknownBuild = studioRefusal(at('odc', '1.7.28', refuse));
  assert.equal(unknownBuild.cause, 'STUDIO_BUILD_UNKNOWN');
  assert.match(unknownBuild.userMessage, /without its build \(the 4 numbers\)/);
  const unread = studioRefusal(studioIdentity('o11', { version: null }, K));
  assert.equal(unread.cause, 'STUDIO_VERSION_UNKNOWN');
  assert.match(unread.userMessage, /could not read the version of the Service Studio on this computer/);
  // the O11 lane names the Service Studio and its own server-only tools
  const o11 = studioRefusal(at('o11', '11.55.91.65258'));
  assert.match(o11.userMessage, /Update Service Studio to 11\.55\.92\.6000/);
  assert.match(o11.userMessage, /o11_job/);
  assert.deepEqual(o11.stillWorks, SERVER_ONLY_EXAMPLES.o11, 'without a list, the short examples of the lane');
  for (const r of [older, newer, buildNewer, buildOlder, unknownBuild, unread, o11]) {
    assert.equal(r.outcome, 'not-sent');
    assert.match(r.userMessage, /Nothing ran on your Studio\./);
    assert.doesNotMatch(JSON.stringify(r), PT_BR, 'B3: no pt-BR text');
    assert.match(r.error, /Nothing ran on the user's Studio\./);
    assert.doesNotMatch(JSON.stringify(r), /someone|Users\\\\/, 'no folder of the user');
  }
  assert.equal(studioRefusal(at('odc', '1.7.28.5000')), null, 'a served Studio has no refusal');
});

test('warnings: studioBuildDiffers when another build is served; studioNotServed for a tool that ran while the Studio is not served; nothing for the same build', () => {
  const differs = studioWarningOf(at('odc', '1.7.28.5023'));
  assert.deepEqual({ code: differs.code, lane: differs.lane, installed: differs.installed, served: differs.served, relation: differs.relation, policy: differs.policy },
    { code: 'studioBuildDiffers', lane: 'odc', installed: '1.7.28.5023', served: '1.7.28.5000', relation: 'build-differs', policy: 'warn' });
  assert.match(differs.userMessage, /^Warning: the ODC Studio on this computer is build 1\.7\.28\.5023 and the SSAM server uses the kernel of build 1\.7\.28\.5000 \(same version 1\.7\.28, another build\)\./);
  assert.match(differs.userMessage, /Check the result in ODC Studio before publishing\./);
  assert.match(differs.error, /^Warning: the user's ODC Studio is build 1\.7\.28\.5023; this SSAM server runs the kernel of build 1\.7\.28\.5000 \(same version 1\.7\.28, another build\)/);
  assert.match(studioWarningOf(at('odc', '1.7.28')).userMessage, /without its build/);
  const notServed = studioWarningOf(at('odc', '1.7.29.10900'));
  assert.deepEqual({ code: notServed.code, cause: notServed.cause, installed: notServed.installed, served: notServed.served },
    { code: 'studioNotServed', cause: 'STUDIO_VERSION_NOT_SERVED_YET', installed: '1.7.29.10900', served: '1.7.28.5000' });
  assert.match(notServed.userMessage, /^Warning: this tool ran on the server only, with the kernel of ODC Studio 1\.7\.28\.5000, but the ODC Studio on this computer \(1\.7\.29\.10900\) is not served by this server/);
  assert.match(notServed.userMessage, /the SSAM owner was already notified/);
  assert.match(notServed.error, /^Warning: this tool ran on the server only, with the kernel of ODC Studio 1\.7\.28\.5000, but the user's ODC Studio 1\.7\.29\.10900 is not served/);
  assert.equal(studioWarningOf(at('o11', '11.55.91.1')).cause, 'STUDIO_UPDATE_REQUIRED');
  assert.equal(studioWarningOf(at('odc', '1.7.28.5000')), null);
  assert.equal(studioWarningOf(at('odc', null)), null, 'no Studio installed: no claim about it');
  assert.equal(studioWarningOf(null), null);
});

test('B3: every refusal and warning text of every relation, in both lanes and both policies, is English; the why names no pt-BR', () => {
  const versions = { odc: ['1.7.27.10846', '1.7.29.10900', '1.7.28.5023', '1.7.28.4990', '1.7.28', 'x'], o11: ['11.55.91.65258', '11.55.93.1', '11.55.92.6011', '11.55.92.5990', '11.55.92', 'x'] };
  let refusals = 0, warnings = 0;
  for (const policy of ['warn', 'refuse']) for (const lane of ['odc', 'o11']) for (const version of versions[lane]) {
    const id = studioIdentity(lane, { version }, { ...K, studioBuildPolicy: policy });
    const refusal = studioRefusal(id);
    const warning = studioWarningOf(id);
    for (const value of [refusal, warning].filter(Boolean)) {
      assert.doesNotMatch(JSON.stringify(value), PT_BR, `${policy} ${lane} ${version} ${value.code}`);
      assert.equal(typeof value.userMessage, 'string');
      assert.notEqual(value.userMessage, value.error, 'the user\'s text and the model\'s text stay two texts');
    }
    if (refusal) { refusals++; assert.doesNotMatch(refusal.continuation.why, /pt-BR/); }
    if (warning) warnings++;
  }
  assert.ok(refusals >= 12 && warnings >= 12, `${refusals} refusals, ${warnings} warnings`);
});

test('studioVersions: only the version numbers of the Hello, never the folder', () => {
  assert.deepEqual(studioVersions({ odc: { installed: { dir: 'C:\\Users\\someone\\AppData\\Local\\ODC Studio', version: '1.7.28.5023' } }, o11: { installed: null } }),
    { odc: '1.7.28.5023', o11: null });
  assert.deepEqual(studioVersions({ odc: { installed: { dir: 'C:\\x', version: '11.55.92.6000 C:\\Users\\someone' } }, o11: { installed: { version: 'n/a' } } }),
    { odc: '11.55.92.6000', o11: '?' }, 'only the leading numbers; an unreadable version is ?');
  assert.deepEqual(studioVersions(null), { odc: null, o11: null });
});

test('the examples of server-only tools in the texts are server tools of the hosted catalog', () => {
  const tools = hostedTools();
  for (const [lane, names] of Object.entries(SERVER_ONLY_EXAMPLES))
    for (const name of names) assert.equal(tools[name]?.class, 'server', lane + ' ' + name);
});
