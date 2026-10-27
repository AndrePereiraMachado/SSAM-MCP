// R6, EQUIVALENCE_UNCERTAIN: an uncertain merge names what the native gate (native-equivalence.txt, the MatchTree dump of
// the open module against the candidate) could not compare, and why, apart from what differs. Incident 165c972a (
// lab 71): the gate reported a screen's "Screen Content" summary and the [Not Visible] DisplayOrder of aggregate
// attributes whose owners are [None]; the reader skipped those properties (owner [None]) and the answer said only
// "uncertain". The shape of that dump, reduced; offline.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { divergencesOf } from '../kernel-delivery.mjs';

const dump = [
  '(Object App) SampleApp [DifferenceInLocalMergeUnit]',
  '+-- (Folder) UI Flows',
  '|    |',
  '|    +-- (Object UI Flow) MainFlow [DifferenceInLocalMergeUnit]',
  '|    |    |',
  '|    |    +-- (Object Screen) Options [ChangedInLocal]',
  '|    |    |    |         >> Screen Content[The Screen content has changed] / Screen Content[] [DifferenceInLocalChildren]',
  '|    |    |    |',
  '|    |    |    +-- (Object Aggregate) ReadCarriers [None]',
  '|    |    |    |    |',
  '|    |    |    |    +-- (Object Attribute) HasBuildingMax [None]',
  '|    |    |    |    |    |         >> DisplayOrder[10] / DisplayOrder[11] [ChangedInLocal] [Not Visible]',
  '|    |    |    |    |',
  '|    |    |    |    +-- (Object Expression) Label [ChangedInLocal]',
  '|    |    |    |    |    |         >> Value["Building"] / Value["Contents"]',
  ''].join('\r\n');

test('a property flagged under an owner the gate marks [None] is read, with its visibility apart from its value', () => {
  const found = divergencesOf(dump);
  const order = found.find(d => d.property === 'DisplayOrder');
  assert.deepEqual(order, { element: 'MainFlow/Options/ReadCarriers/HasBuildingMax', kind: 'Attribute', property: 'DisplayOrder', local: '10', candidate: '11',
    visible: false, why: 'native metadata the Studio does not show (not authored content); the native gate cannot tell it from content' });
  const summary = found.find(d => d.property === 'Screen Content');
  assert.equal(summary.local, 'The Screen content has changed'); assert.equal(summary.candidate, '');
  assert.match(summary.why, /summary of the screen's children/);
  // A real difference is a difference: no why.
  const label = found.find(d => d.property === 'Value');
  assert.deepEqual(label, { element: 'MainFlow/Options/ReadCarriers/Label', kind: 'Expression', property: 'Value', local: '"Building"', candidate: '"Contents"' });
  assert.equal(found.length, 3);
});

test('an owner [None] with no property of its own flagged is never a divergence', () => {
  const quiet = dump.replace(' [ChangedInLocal] [Not Visible]', ' [Not Visible]');
  assert.equal(divergencesOf(quiet).some(d => d.property === 'DisplayOrder'), false);
});
