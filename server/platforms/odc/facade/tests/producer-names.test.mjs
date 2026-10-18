// fix/system-reference: the one rule for a producer's name (producer-names.mjs), the facade's copy of the kernel's
// JobSources.BindingKey / SameProducer / StudioName (kernel tests: SystemProducerReferenceTests).
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { bindingKeyOf, canonicalKeyOf, captureEntryOf, isProducerName, listedNameOf, nameNote, producerBindings, producersNamed, sameProducer, studioNameOf } from '../producer-names.mjs';

test('the Studio form (System) and the bare System are one producer, bound as System', () => {
  assert.equal(bindingKeyOf('(System)'), 'System');
  assert.equal(bindingKeyOf('( System )'), 'System');
  assert.equal(bindingKeyOf('Users'), 'Users');
  for (const other of ['job:producer', 'C:\\x\\System.avsig', 'tests/fixtures/x.oml', '', null, '..\\System', '()', '-']) assert.equal(bindingKeyOf(other), null, String(other));
  // Round 2 (H1): a name that is no identifier binds by its letters and digits; one pair of parentheses is dropped.
  assert.equal(bindingKeyOf('(Sys tem)'), 'System');
  assert.equal(bindingKeyOf('((System))'), 'System');
  assert.equal(bindingKeyOf('OutSystems UI'), 'OutSystemsUI');
  assert.equal(bindingKeyOf(' Flood-Utils '), 'FloodUtils');
  assert.ok(isProducerName('(System)') && !isProducerName('job:x'));
  for (const written of ['System', 'system', '(System)', '(system)', 'SYSTEM']) {
    assert.equal(canonicalKeyOf(written), 'System');
    assert.equal(studioNameOf(written), '(System)');
    assert.equal(captureEntryOf(written), 'System=(System)');
    assert.ok(sameProducer(written, '(System)'));
  }
  assert.equal(studioNameOf('(Tools)'), '(Tools)');
  assert.equal(studioNameOf('Users'), 'Users');
  assert.equal(captureEntryOf('Users'), 'Users');
  assert.ok(!sameProducer('Users', 'System'));
  assert.ok(!sameProducer('job:a', 'job:a'), 'a path or job source is no producer name');
});

test('the producers a job names: one per key, in job order, with every spelling it used', () => {
  assert.deepEqual(producersNamed(['(System)', 'OutSystemsUI', 'system', null, 'job:lib', 'System']), [
    // Round 3 (M5): each slot also says the distinct texts it was written in (one here: "(System)" and "System" are one).
    { key: 'System', studio: '(System)', written: ['(System)', 'system', 'System'], spellings: ['system'] },
    { key: 'OutSystemsUI', studio: 'OutSystemsUI', written: ['OutSystemsUI'], spellings: ['outsystemsui'] },
  ]);
});

test('a listing of the session resolves a name by itself or by its key, never by a guess between two', () => {
  const listed = [{ name: '(System)' }, { name: 'OutSystemsUI' }, { name: '(Tools)' }];
  assert.equal(listedNameOf('system', listed), '(System)', 'the same key');
  assert.equal(listedNameOf('(System)', listed), '(System)');
  assert.equal(listedNameOf('outsystemsui', listed), 'OutSystemsUI');
  assert.equal(listedNameOf('Tools', listed), '(Tools)');
  assert.equal(listedNameOf('Sistema', listed), null);
  assert.equal(listedNameOf('Tools', ['Tools2', '(Tools)', 'tools']), 'tools', 'the same name wins over the same key');
  assert.equal(listedNameOf('Tools', ['(Tools)', '( Tools )']), null, 'two producers of one key: never guessed');
});

test('a producers map is keyed by binding key; a bad name or two names of one producer is a problem, never silent', () => {
  assert.deepEqual(producerBindings({ '(System)': 'a.avsig', Users: 'b.oml' }), { bindings: { System: 'a.avsig', Users: 'b.oml' }, problems: [] });
  const twice = producerBindings({ '(System)': 'a', System: 'b' });
  assert.deepEqual(twice.bindings, { System: 'a' });
  assert.match(twice.problems[0].error, /bound twice/);
  // Round 3 (H1-R): a name with / or \ takes the slot of its letters ("C:\x" -> Cx; the kernel binds it only to a capture
  // that names it exactly); a name with no letter or digit is the bad one.
  // fix/a5-lows (B10, declared change): only when the job writes that exact text; without the job's names it is refused.
  assert.deepEqual(producerBindings({ 'C:\\x': 'a' }, { names: ['C:\\x'] }).bindings, { Cx: 'a' });
  assert.deepEqual(producerBindings({ 'C:\\x': 'a' }).bindings, {});
  assert.match(producerBindings({ 'C:\\x': 'a' }).problems[0].error, /no job was given to match it against/);
  assert.match(producerBindings({ '-': 'a' }).problems[0].error, /Invalid producer binding name/);
  assert.match(producerBindings(['x']).problems[0].error, /producers is/);
  assert.equal(nameNote('(System)', '(System)'), null);
  assert.match(nameNote('System', '(System)'), /lists this producer as "\(System\)".*bound as System/);
});
