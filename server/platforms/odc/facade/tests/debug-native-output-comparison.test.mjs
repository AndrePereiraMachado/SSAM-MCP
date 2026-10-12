import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeOutputComparison } from '../debug-native-output-comparison.mjs';

test('compares native list envelopes without replacing converted values', () => {
  const row = { Id: 'B', Label: 'B', Order: 1, Is_Active: true };
  const wire = { FloodZoneList: { List: [row], EmptyListItem: {} } };
  const converted = { FloodZoneList: [{ ...row }] };
  const result = nativeOutputComparison(wire, converted);
  assert.equal(result.complete, true); assert.equal(result.representationEqual, true);
  assert.equal(result.comparedScalars, 4); assert.equal(result.nativeListEnvelopes, 1);
  assert.deepEqual(wire.FloodZoneList.List[0], row); assert.deepEqual(converted.FloodZoneList[0], row);
});

test('detects the observed default pattern without emitting field names or private values', () => {
  const result = nativeOutputComparison({ SecretField: { List: [{ Id: 'PRIVATE_ID', Order: 7, Is_Active: true }] } },
    { SecretField: [{ Id: '', Order: 0, Is_Active: false }] });
  assert.equal(result.representationEqual, false); assert.equal(result.unequalScalars, 3);
  assert.doesNotMatch(JSON.stringify(result), /SecretField|PRIVATE_ID|Is_Active/);
});

test('separates missing and additional fields from values and type changes', () => {
  const r = nativeOutputComparison({ a: 0, b: 1, c: null }, { a: '0', c: null, d: false });
  assert.equal(r.typeDifferences, 1); assert.equal(r.missingFields, 1); assert.equal(r.extraFields, 1);
  assert.equal(r.comparedScalars, 1); assert.equal(r.representationEqual, false);
});

test('does not claim semantic equality for different native representations', () => {
  const r = nativeOutputComparison({ Date: '2026-10-08T00:00:00Z', Decimal: 1 }, { Date: '2026-10-08', Decimal: '1' });
  assert.equal(r.semanticEqualityAssessed, false); assert.equal(r.typeDifferences, 1); assert.equal(r.unequalScalars, 1);
});

test('incomplete budgets, cyclic or unsupported values can never qualify equality', () => {
  const cycle = {}; cycle.self = cycle;
  for (const r of [nativeOutputComparison([1, 2], [1, 2], { maxNodes: 1 }),
    nativeOutputComparison(cycle, cycle), nativeOutputComparison(undefined, undefined),
    nativeOutputComparison(new Date(0), new Date(0)), nativeOutputComparison(Infinity, Infinity)]) {
    assert.equal(r.complete, false); assert.equal(r.representationEqual, false);
  }
});

test('record named List with additional fields is not mistaken for a native list', () => {
  const r = nativeOutputComparison({ List: [], Other: 3 }, []);
  assert.equal(r.nativeListEnvelopes, 0); assert.equal(r.typeDifferences, 1); assert.equal(r.representationEqual, false);
});

// Producer End output (native evaluator values) vs original wire response: per-path
// HMAC fingerprints under one random key, compared by canonical class; counts only.
import { nativeWireParity, parseWireJson, wireParityLeaves, nativeParityLeaves, parityPrints, compareParityPrints } from '../debug-native-output-comparison.mjs';
const scalar = (path, value, type = 'Scalar') => ({ type, value, path, unavailable: false, undefined: false, trimmed: false, deferred: false, children: [] });
const container = (path, type, children) => ({ type, value: type, path, unavailable: false, undefined: false, trimmed: false, deferred: false, children });
const list = (path, items) => container(path, 'RecordList', [scalar(path + '.Length', String(items.length)), ...items.map((item, i) => item(path + '.[' + i + ']'))]);
const row = (name, price, id, at) => p => container(p, 'Record', [scalar(p + '.Name', '"' + name + '"'), scalar(p + '.Price', price),
  scalar(p + '.Id', id), scalar(p + '.At', at)]);
const BIG = '9007199254740993', GUID_UPPER = '9F1E2D3C-4B5A-4978-8695-A4B3C2D1E0F9';
const wireText = JSON.stringify({ versionInfo: { hasModuleVersionChanged: false }, data: {
  Total: 0, Name: 'PRIVATE-Ω', Count: 'COUNT', Active: true, Day: '2026-10-08', When: '2026-10-08T10:00:00Z', UserId: GUID_UPPER.toLowerCase(),
  Rows: { List: [{ Name: 'a', Price: 12.5, Id: 'ID', At: '1900-01-01T00:00:00' }, { Name: 'b', Price: '0.10', Id: 'ID2', At: '2026-01-02T03:04:05.000Z' }],
    EmptyListItem: { Name: '', Price: 0, Id: '0', At: '1900-01-01T00:00:00' } } } }).replace('"COUNT"', BIG).replace('"Total":0', '"Total":1.50');
const nativeRoots = () => [['Total', scalar('Total', '1.5')], ['Name', scalar('Name', '"PRIVATE-Ω"')], ['Count', scalar('Count', BIG)],
  ['Active', scalar('Active', 'True')], ['Day', scalar('Day', '#2026-10-08#')], ['When', scalar('When', '#2026-10-08 10:00:00#')],
  ['UserId', scalar('UserId', '"' + GUID_UPPER + '"')],
  ['Rows', list('Rows', [row('a', '12.50', 'ID', '#1900-01-01 00:00:00#'), row('b', '0.1', 'ID2', '#2026-01-02 03:04:05#')])]];

test('native evaluator values canonicalize to wire forms: Decimal precision, Int64, Date/DateTime, GUID case, list envelopes', () => {
  const r = nativeWireParity(nativeRoots(), wireText);
  assert.deepEqual(r, { schema: 'ssam-producer-output-parity/1', complete: true, compared: 16, unequal: 0, missing: 0, extra: 0, typeDifferences: 0, parityEqual: true });
  // Int64 beyond 2^53 keeps its source digits: one digit off is unequal, never rounded equal.
  const off = nativeRoots(); off[2][1] = scalar('Count', '9007199254740992');
  assert.equal(nativeWireParity(off, wireText).unequal, 1);
});

test('native-typed client values (Text, Integer, Long Integer, Decimal, Boolean, Date, Date Time, Identifier) use their declared type', () => {
  const typed = [['Total', { type: 'Decimal', value: '1.500' }], ['Name', { type: 'Text', value: 'PRIVATE-Ω' }], ['Count', { type: 'LongInteger', value: BIG }],
    ['Active', { type: 'Boolean', value: true }], ['Day', { type: 'Date', value: '2026-10-08' }], ['When', { type: 'DateTime', value: '2026-10-08T10:00:00.000Z' }],
    ['UserId', { type: 'Identifier', value: GUID_UPPER }]];
  const r = nativeWireParity(typed, wireText, { roots: typed.map(([name]) => name) });
  assert.equal(r.complete, true); assert.equal(r.compared, 7); assert.equal(r.unequal, 0); assert.equal(r.typeDifferences, 0);
  // A Text rendering of a number never equals a numeric wire field; a Date never equals a Date Time.
  const wrong = nativeWireParity([['Total', scalar('Total', '"1.5"')], ['Day', scalar('Day', '#2026-10-08 00:00:00#')]], wireText, { roots: ['Total', 'Day'] });
  assert.equal(wrong.typeDifferences, 2); assert.equal(wrong.compared, 0); assert.equal(wrong.parityEqual, false);
});

test('the e55c6e2d class: divergent, missing and extra fields are counted, never named, valued or hashed', () => {
  const roots = nativeRoots();
  roots[1][1] = scalar('Name', '"OTHER-PRIVATE"');
  roots[7][1] = list('Rows', [row('a', '12.49', 'ID', '#1900-01-01 00:00:00#')]);
  roots.push(['Ghost', scalar('Ghost', '"GHOST-PRIVATE"')]);
  const r = nativeWireParity(roots, wireText);
  assert.equal(r.unequal, 3, 'Name, Rows.Length and Rows[0].Price'); assert.equal(r.missing, 1); assert.equal(r.extra, 4, 'Rows[1].* on the wire only');
  assert.equal(r.parityEqual, false);
  assert.deepEqual(Object.keys(r).sort(), ['compared', 'complete', 'extra', 'missing', 'parityEqual', 'schema', 'typeDifferences', 'unequal']);
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE|GHOST|Name|Rows|Price|[a-f0-9]{32}/);
});

test('incomplete native wire, unknown renderings and budgets can never claim parity', () => {
  for (const node of [{ ...scalar('Name', '"x"'), trimmed: true }, scalar('Name', '-undefined-'), scalar('Name', 'BinaryData (3 bytes)'),
    container('Rows', 'RecordList', [scalar('Rows.Length', '2'), scalar('Rows.[0]', '1')])]) {
    const r = nativeWireParity([['Name', node]], wireText, { roots: ['Name'] });
    assert.equal(r.complete, false); assert.equal(r.parityEqual, false);
  }
  const wide = JSON.stringify({ data: { Items: Array.from({ length: 30 }, (_, i) => i) } });
  assert.equal(nativeWireParity([['Items', scalar('Items', '1')]], wide, { maxLeaves: 10 }).complete, false);
  // Prints are keyed HMACs: another key never matches, and a foreign shape is refused.
  const key = Buffer.alloc(32, 7), other = Buffer.alloc(32, 9);
  const wire = parityPrints(wireParityLeaves(parseWireJson(wireText)), key), native = parityPrints(nativeParityLeaves(nativeRoots()), other);
  assert.equal(compareParityPrints(native, wire).missing, 16);
  assert.equal(compareParityPrints(native, { leaves: 'x' }).complete, false);
});
