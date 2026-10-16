// The code under test writes under the user's profile: this process's profile is a temporary folder.
import './fixtures/isolated-profile.mjs';
// Lane F8 of the atritos 2 package (docs/PACOTE-ATRITOS-2.md, A22): the delete refused "The user's words do not name the
// module Cardapio_UI" although the user had said "tanto o Back Office quanto o UI" (06/10 13:34); the model then dictated
// a sentence for the user to type. Inside the target application the words may name a module by its distinctive suffix
// after <App>_ (case and spaces normalized) when no other target shares it; the resolved targets come back in the answer;
// an ambiguous suffix stays WORDS_MUST_NAME with the candidates. Offline: the fake bridge of sc-fake-bridge.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Journal } from '../service-center/client.mjs';
import { runServiceCenter } from '../service-center/index.mjs';
import { appSuffix, namesSuffix } from '../service-center/delete.mjs';
import { FakeBridge, temp } from './fixtures/sc-fake-bridge.mjs';
import { fakeClock, noBackup, previewThenConfirm } from './fixtures/destructive-flow.mjs';

const PERSONAL = 'personal-0000test.outsystemscloud.com';
const REGISTRY = path.join(import.meta.dirname, 'fixtures', 'sc-hosts.json');
const PARENT = '11111111-2222-4333-8444-555555555555';

function environment({ apps, espaces }) {
  const s = { apps, espaces, dir: temp(), clock: fakeClock() };
  s.journal = new Journal(path.join(s.dir, 'receipts'));
  const listed = rows => rows.filter(r => !r.gone);
  s.bridge = new FakeBridge({ api: {
    ListApplications: () => listed(s.apps).map(a => ({ Key: a.key, Name: a.name })),
    ListEspaces: () => listed(s.espaces).map(m => ({ Key: m.key, Name: m.name, ApplicationKey: m.app })),
    ListExtensions: () => [],
    GetConsumers: () => [],
    DeleteModule: args => { for (const m of s.espaces) if (m.key === args.moduleKey) m.gone = true; return { success: true, message: null }; },
  } });
  s.run = (...argv) => runServiceCenter([...argv, '--host=' + PERSONAL], { journal: s.journal, locate: () => s.bridge, present: async () => false, running: async () => false,
    opener: () => assert.fail('no prompt with a Studio connected'), exports: s.dir, registry: REGISTRY, sleep: async () => {}, uuid: () => PARENT,
    consumerNames: () => [], clock: s.clock, destructiveRoot: path.join(s.dir, 'destructive'), backup: noBackup });
  // CX15: the preview, 5 s, then the token with the owner's words (they state the count).
  s.confirm = async (argv, words) => (await previewThenConfirm(s.run, argv, words, { clock: s.clock })).result;
  s.sent = () => s.bridge.calls.filter(c => c[0] === 'api' && c[2] === 'DeleteModule' && c[4]).map(c => c[3].moduleKey);
  return s;
}
const cardapio = () => environment({ apps: [{ key: 'app-c', name: 'Cardapio' }, { key: 'app-o', name: 'Outro' }],
  espaces: [{ key: 'k-ui', name: 'Cardapio_UI', app: 'app-c' }, { key: 'k-bo', name: 'Cardapio_BackOffice', app: 'app-c' }, { key: 'k-cs', name: 'Cardapio_CS', app: 'app-c' },
    { key: 'k-oui', name: 'Outro_UI', app: 'app-o' }] });

test('"o UI e o BackOffice" names Cardapio_UI and Cardapio_BackOffice inside the Cardapio app; the resolved targets come back', async () => {
  const s = cardapio();
  const done = await s.confirm(['delete', '--target=module:Cardapio_UI', '--target=module:Cardapio_BackOffice'], 'pode apagar os 2, tanto o Back Office quanto o UI');
  assert.deepEqual([done.ok, done.state], [true, 'confirmed']);
  assert.deepEqual(s.sent().sort(), ['k-bo', 'k-ui']);
  assert.deepEqual(done.named.map(n => [n.name, n.by, n.as]).sort(), [['Cardapio_BackOffice', 'suffix', 'BackOffice'], ['Cardapio_UI', 'suffix', 'UI']]);
  // The plan (execute:false never applies the words) and the exact phrase of the report.
  const again = cardapio();
  const exact = await again.confirm(['delete', '--target=module:Cardapio_UI', '--target=module:Cardapio_BackOffice'], 'os 2: o UI e o BackOffice');
  assert.equal(exact.state, 'confirmed');
});

test('an ambiguous suffix stays WORDS_MUST_NAME with the candidates; nothing is sent', async () => {
  const s = cardapio();
  const refused = await s.confirm(['delete', '--target=module:Cardapio_UI', '--target=module:Outro_UI'], 'pode apagar os 2, o UI');
  assert.deepEqual([refused.ok, refused.code], [false, 'DELETE_REFUSED']);
  assert.deepEqual(refused.problems.map(p => [p.code, p.target, p.ssamRule]).sort(), [['WORDS_MUST_NAME', 'Cardapio_UI', true], ['WORDS_MUST_NAME', 'Outro_UI', true]]);
  for (const p of refused.problems) assert.deepEqual(p.candidates.map(c => c.name).sort(), ['Cardapio_UI', 'Outro_UI']);
  assert.deepEqual(s.sent(), []);
  // Whole names still decide (one by its name, the other by its now unique suffix in the words... both whole here).
  const named = cardapio();
  assert.equal((await named.confirm(['delete', '--target=module:Cardapio_UI', '--target=module:Outro_UI'], 'apagar os 2, Cardapio_UI e Outro_UI')).state, 'confirmed');
});

test('a suffix not in the words is still refused, and the fix names it', async () => {
  const s = cardapio();
  const refused = await s.confirm(['delete', '--target=module:Cardapio_CS'], 'pode apagar o 1, o UI');
  assert.deepEqual(refused.problems.map(p => p.code), ['WORDS_MUST_NAME']);
  assert.match(refused.problems[0].fix, /CS, its name inside Cardapio/);
  assert.deepEqual(s.sent(), []);
});

test('the suffix rule: <App>_ of the target application, whole words, case and spaces normalized', () => {
  const t = (name, application) => ({ kind: 'module', name, application });
  assert.equal(appSuffix(t('Cardapio_BackOffice', 'Cardapio')), 'BackOffice');
  assert.equal(appSuffix(t('ZZ_Demo_UI', 'ZZ Demo')), null, 'the app name without spaces is ZZDemo');
  assert.equal(appSuffix(t('ZZDemo_UI', 'ZZ Demo')), 'UI');
  assert.equal(appSuffix(t('Orders', 'Orders App')), null);
  assert.equal(appSuffix(t('Cardapio_X', 'Cardapio')), null, 'one character is not distinctive');
  assert.equal(appSuffix({ kind: 'application', name: 'Cardapio_UI', application: 'Cardapio' }), null);
  assert.equal(namesSuffix('tanto o Back Office quanto o UI', 'BackOffice'), true);
  assert.equal(namesSuffix('o backoffice', 'BackOffice'), true);
  assert.equal(namesSuffix('o UI', 'UI'), true);
  assert.equal(namesSuffix('a UIX nova', 'UI'), false);
  assert.equal(namesSuffix('o BackOfficer', 'BackOffice'), false);
  assert.equal(namesSuffix('o Back_Office', 'BackOffice'), true);
  assert.equal(namesSuffix('apague o serviço', 'Servico'), true, 'accent-insensitive');
});
