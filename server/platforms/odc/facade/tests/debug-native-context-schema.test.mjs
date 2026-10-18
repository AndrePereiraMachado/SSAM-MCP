import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { debugRunToolSchema, nativeEntrySchema, runSchema } from '../debug-run.mjs';
import { o11RunSchema } from '../debug-o11-run.mjs';
import { nativeScreenContextSchema } from '../debug-native-context-schema.mjs';
import * as z from 'zod/v4';

const state = { screen: { inputs: { QuoteId: '42' }, variables: { Search: 'abc' } }, block: { inputs: { Enabled: true } } };
const odc = { op: 'run', execution: 'native-entry', tenant: 'dev.example.test', module: 'App', action: 'Act' };
const o11 = { ...odc, lane: 'o11', tenant: undefined, host: 'dev.example.test', moduleKey: 'A'.repeat(22),
  applicationKey: 'B'.repeat(22), runtimeUrl: 'https://dev.example.test/App/' };
delete o11.tenant;

test('MCP and both native lane contracts preserve top-level and scenario owner state', () => {
  for (const [schema, base] of [[nativeEntrySchema, odc], [o11RunSchema, o11], [debugRunToolSchema, odc], [debugRunToolSchema, o11]]) {
    const parsed = schema.parse({ ...base, context: state, scenarios: [{ name: 'changed', inputs: {}, context: { screen: { variables: { Search: '' } } } }] });
    assert.deepEqual(parsed.context, state);
    assert.deepEqual(parsed.scenarios[0].context, { screen: { variables: { Search: '' } } });
  }
});

test('owner state is not an identity, role, arbitrary owner or prototype override', () => {
  for (const context of [{ roles: { Admin: true } }, { user: 'other' }, { session: {} }, { screen: { roles: {} } },
    JSON.parse('{"screen":{"variables":{"__proto__":{}}}}'), { block: { inputs: { constructor: 'x' } } }])
    assert.equal(nativeScreenContextSchema.safeParse(context).success, false);
  const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => ['a' + i, i]));
  assert.equal(nativeScreenContextSchema.safeParse({ screen: { variables: many } }).success, false);
});

test('legacy execution cannot silently discard the new context fields', () => {
  assert.equal(runSchema.safeParse({ op: 'run', tenant: 'dev.example.test', module: 'App', action: 'Act', context: state }).success, false);
  assert.equal(o11RunSchema.safeParse({ ...o11, execution: 'rest-wrapper', context: state }).success, false);
  assert.equal(o11RunSchema.safeParse({ ...o11, execution: 'rest-wrapper', contextMode: 'anonymous' }).success, false);
});

test('the public MCP input stays serializable after raw owner-state validation', () => {
  const schema = z.toJSONSchema(debugRunToolSchema, { io: 'input' });
  assert.equal(schema.type, 'object'); assert.equal(schema.properties.context.type, 'object');
});
