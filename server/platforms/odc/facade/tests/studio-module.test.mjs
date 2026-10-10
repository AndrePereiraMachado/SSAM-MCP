// The module a Studio tool names reaches the open module (studio-module.mjs, lib.mjs resolveModuleArgs). QuizLive,
// 2026-10-05: studio_deliver {module:"QuizLive Web"} failed at the snapshot ("Expected exactly one open QuizLive Web;
// found 0") and the session spent a status call and a second delivery on the name. Pure, plus a fake bridge client.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOpenModule, compactName } from '../studio-module.mjs';
import { resolveModuleArgs } from '../lib.mjs';

const OPEN = [{ name: 'QuizLiveWeb', key: '6NF7DqvTFkaZgeoBRWvrZg' }, { name: 'QuizLiveMobile', key: 'K2' }];
const CATALOG = { tenant: 'personal.test', modules: [{ name: 'QuizLive Web', key: '6NF7DqvTFkaZgeoBRWvrZg' }, { name: 'QuizLive Mobile', key: 'K2' }, { name: 'Escala Viva', key: 'K3' }] };

test('the rules in order: exact name or key, case, catalog asset name, letters and digits', () => {
  assert.deepEqual(resolveOpenModule('QuizLiveWeb', { open: OPEN }), { ok: true, module: 'QuizLiveWeb', via: 'exact', requested: 'QuizLiveWeb' });
  assert.equal(resolveOpenModule('6NF7DqvTFkaZgeoBRWvrZg', { open: OPEN }).via, 'exact');
  assert.deepEqual(resolveOpenModule('quizliveweb', { open: OPEN }), { ok: true, module: 'QuizLiveWeb', via: 'case', requested: 'quizliveweb' });
  assert.deepEqual(resolveOpenModule('QuizLive Web', { open: OPEN, catalog: CATALOG }), { ok: true, module: 'QuizLiveWeb', via: 'catalog', requested: 'QuizLive Web' });
  assert.deepEqual(resolveOpenModule('QuizLive Web', { open: OPEN }), { ok: true, module: 'QuizLiveWeb', via: 'compact', requested: 'QuizLive Web' });
  assert.equal(resolveOpenModule('  QuizLive_Mobile ', { open: OPEN }).module, 'QuizLiveMobile');
  assert.equal(compactName('Quiz Live-Web_é'), 'quizlivewebe');
});

test('two open modules for one name are ambiguous and never chosen; a name no open module has is refused with the open modules', () => {
  const ambiguous = resolveOpenModule('Quiz Live', { open: [{ name: 'Quiz_Live', key: 'a' }, { name: 'QuizLive', key: 'b' }] });
  assert.equal(ambiguous.ok, false); assert.equal(ambiguous.code, 'MODULE_AMBIGUOUS'); assert.equal(ambiguous.outcome, 'not_sent');
  assert.deepEqual(ambiguous.candidates, ['QuizLive', 'Quiz_Live']); assert.deepEqual(ambiguous.openModules, ['QuizLive', 'Quiz_Live']);
  assert.deepEqual(resolveOpenModule('Quiz Live', { open: [{ name: 'QuizLive', key: 'b' }, { name: 'Quiz_Live', key: 'a' }] }), ambiguous, 'the Studio order changes nothing');
  assert.equal(ambiguous.continuation, undefined, 'no module is guessed for the next call');
  const missing = resolveOpenModule('Escala Viva', { open: OPEN, catalog: CATALOG });
  assert.equal(missing.ok, false); assert.equal(missing.code, 'MODULE_NOT_OPEN');
  assert.deepEqual(missing.openModules, ['QuizLiveMobile', 'QuizLiveWeb']);
  assert.match(missing.error, /No module open in the ODC Studio is "Escala Viva" \(open: QuizLiveMobile, QuizLiveWeb\); nothing was sent/);
  // The catalog knows the asset: studio_open by its key, the exact identity.
  assert.deepEqual(missing.continuation.tool, 'studio_open'); assert.deepEqual(missing.continuation.arguments, { module: 'K3' });
  assert.match(resolveOpenModule('X', { open: [] }).error, /open: none/);
  assert.deepEqual(resolveOpenModule('X', { open: [] }).continuation.arguments, { module: 'X' });
  // Same input, same answer.
  assert.deepEqual(resolveOpenModule('Escala Viva', { open: [...OPEN].reverse(), catalog: CATALOG }), missing);
});

// A name the catalog knows is that asset and no other: the letters-and-digits rule never moves it to another open app.
test('a catalog asset that is not open is never resolved to an open module with the same letters and digits', () => {
  const catalog = { modules: [{ name: 'Escala Viva', key: 'K3' }, { name: 'EscalaViva', key: 'K9' }], otherTenants: {} };
  const open = [{ name: 'EscalaViva', key: 'K9' }];
  const refused = resolveOpenModule('Escala Viva', { open, catalog });
  assert.equal(refused.ok, false); assert.equal(refused.code, 'MODULE_NOT_OPEN'); assert.equal(refused.outcome, 'not_sent');
  assert.deepEqual(refused.continuation.arguments, { module: 'K3' });
  assert.deepEqual(refused.openModules, ['EscalaViva']);
  const lower = resolveOpenModule('escala viva', { open, catalog }); // the same name in another case is the same asset
  assert.equal(lower.code, 'MODULE_NOT_OPEN'); assert.deepEqual(lower.continuation.arguments, { module: 'K3' });
  // The QuizLive case of the review: "Quiz Live Web" (K1, closed) and "QuizLive Web" (K2, open as QuizLiveWeb).
  const quiz = { modules: [{ name: 'Quiz Live Web', key: 'K1' }, { name: 'QuizLive Web', key: 'K2' }] };
  assert.equal(resolveOpenModule('Quiz Live Web', { open: [{ name: 'QuizLiveWeb', key: 'K2' }], catalog: quiz }).code, 'MODULE_NOT_OPEN');
  assert.deepEqual(resolveOpenModule('QuizLive Web', { open: [{ name: 'QuizLiveWeb', key: 'K2' }], catalog: quiz }),
    { ok: true, module: 'QuizLiveWeb', via: 'catalog', requested: 'QuizLive Web' });
  // A name the catalog does not know, whose letters and digits are two assets: ambiguous, never a guess.
  const ambiguous = resolveOpenModule('QuizLive_Web', { open: [{ name: 'QuizLiveWeb', key: 'K2' }], catalog: quiz });
  assert.equal(ambiguous.code, 'MODULE_AMBIGUOUS'); assert.deepEqual(ambiguous.candidates, ['Quiz Live Web', 'QuizLiveWeb']);
  assert.equal(ambiguous.continuation, undefined);
  // The same app in another tenant has the open module's own catalog name: not another app.
  const tenants = { modules: [{ name: 'QuizLive Web', key: 'K2' }], otherTenants: { other: { modules: [{ name: 'QuizLive Web', key: 'K7' }] } } };
  assert.deepEqual(resolveOpenModule('QuizLive_Web', { open: [{ name: 'QuizLiveWeb', key: 'K2' }], catalog: tenants }),
    { ok: true, module: 'QuizLiveWeb', via: 'compact', requested: 'QuizLive_Web' });
});

test('O11: the catalog is not read and a name no open module has passes on (o11_deliver opens it by name)', () => {
  assert.deepEqual(resolveOpenModule('GameStore CS', { open: [{ name: 'GameStore_CS', key: 'k' }, { name: 'GameStore_UI', key: 'u' }], lane: 'o11' }),
    { ok: true, module: 'GameStore_CS', via: 'compact', requested: 'GameStore CS' });
  assert.deepEqual(resolveOpenModule('OfficePet Core', { open: [{ name: 'OfficePet_CS' }], lane: 'o11', catalog: CATALOG }),
    { ok: true, module: 'OfficePet Core', via: 'unresolved', requested: 'OfficePet Core' });
});

test('resolveModuleArgs: one status read, the open module in the command, the request named in the answer', async () => {
  const calls = [];
  const call = async (pid, args) => { calls.push([pid, args]); return { ok: true, field: 'modules', value: OPEN.map(m => ({ ...m, modified: false })) }; };
  const catalog = () => CATALOG;
  assert.deepEqual(await resolveModuleArgs(7, ['snapshot', 'QuizLive Web'], { call, catalog }), { args: ['snapshot', 'QuizLiveWeb'], requested: 'QuizLive Web' });
  assert.deepEqual(calls, [[7, ['status', 'modules']]]);
  assert.deepEqual(await resolveModuleArgs(7, ['data-insert', 'QuizLive Web', 'Quiz', '--records-file', 'r.json', '--authorize', 'w'], { call, catalog }),
    { args: ['data-insert', 'QuizLiveWeb', 'Quiz', '--records-file', 'r.json', '--authorize', 'w'], requested: 'QuizLive Web' });
  const reference = await resolveModuleArgs(7, ['reference-snapshot', JSON.stringify({ module: 'QuizLive Web', producer: 'OutSystemsUI', output: 'o.avsig' })], { call, catalog });
  assert.deepEqual(JSON.parse(reference.args[1]), { module: 'QuizLiveWeb', producer: 'OutSystemsUI', output: 'o.avsig' });
  assert.deepEqual(await resolveModuleArgs(7, ['snapshot', 'QuizLiveWeb'], { call, catalog }), { args: ['snapshot', 'QuizLiveWeb'] });
  const refused = await resolveModuleArgs(7, ['snapshot', 'Escala Viva'], { call, catalog });
  assert.equal(refused.refusal.code, 'MODULE_NOT_OPEN'); assert.equal(refused.args, undefined, 'nothing is sent');
  // A mutating command never reaches another open app with the same letters and digits as a closed catalog asset.
  const collision = { modules: [{ name: 'Escala Viva', key: 'K3' }, { name: 'EscalaViva', key: 'K9' }] };
  const one = async () => ({ ok: true, field: 'modules', value: [{ name: 'EscalaViva', key: 'K9', modified: false }] });
  for (const command of [['data-delete', 'Escala Viva', 'Turno', '--authorize', 'w'], ['data-update', 'Escala Viva', 'Turno', '--authorize', 'w'], ['snapshot', 'Escala Viva']])
    assert.equal((await resolveModuleArgs(7, command, { call: one, catalog: () => collision })).refusal?.code, 'MODULE_NOT_OPEN', command[0]);
  assert.deepEqual(await resolveModuleArgs(7, ['close', 'Escala Viva', '--discard'], { call: one, catalog: () => collision }), { args: ['close', 'Escala Viva', '--discard'] },
    'close passes the name unresolved: the bridge closes only an exact open module');
  // Closing what is not open is the bridge's answer, never "open it first"; an open one by its app name is resolved.
  assert.deepEqual(await resolveModuleArgs(7, ['close', 'Escala Viva'], { call, catalog }), { args: ['close', 'Escala Viva'] });
  assert.deepEqual(await resolveModuleArgs(7, ['close', 'QuizLive Web', '--duplicates'], { call, catalog }), { args: ['close', 'QuizLiveWeb', '--duplicates'], requested: 'QuizLive Web' });
  // Commands without a module, and a bridge that does not answer the field, keep the old path.
  const before = calls.length;
  assert.deepEqual(await resolveModuleArgs(7, ['preview', 'manifest.json'], { call, catalog }), { args: ['preview', 'manifest.json'] });
  assert.equal(calls.length, before);
  assert.deepEqual(await resolveModuleArgs(7, ['snapshot', 'QuizLive Web'], { call: async () => ({ ok: true, field: 'modules' }), catalog }), { args: ['snapshot', 'QuizLive Web'] });
});
