// The friction queue keeps the protocol detail of an SC_PROTOCOL_INVALID (and SC_PAGE_NOT_FOUND): before, it kept only the code, and the
// 34 SC_PROTOCOL_INVALID of 14..24/10 could not be explained from it. Only the five documented fields, cut; never for another code.
import '../platforms/odc/facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../facade/friction-store.mjs';
import { observeMcp, protocolOf } from '../facade/friction-boundary.mjs';

delete process.env.SSAM_FRICTION_DIR;
const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-friction-protocol-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const PROTOCOL = { operation: 'GET /ServiceCenter/eSpace_Edit.aspx', expected: 'HTTP 200 text/html (a Service Center page)', got: 'HTTP 500, text/html, error-page',
  sample: '<html><head><title>Runtime Error</title></head>', form: 'error-page', extra: 'never kept' };

function call(t, value) {
  const directory = temp(t);
  const store = createStore({ directory, warning: () => {} });
  const observer = observeMcp({ root: path.resolve('.'), entry: 'ssam', args: ['mcp'], store, toServer: () => {}, toClient: () => {} });
  observer.request.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'o11_service_center_read', arguments: { action: 'timers', host: 'h.example.test' } } }) + '\n');
  observer.response.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: true } }) + '\n');
  observer.close();
  const [operation] = store.snapshot().operations;
  return { operation, files: fs.readdirSync(path.join(directory, 'operations')).map(f => fs.readFileSync(path.join(directory, 'operations', f), 'utf8')).join() };
}

test('an SC_PROTOCOL_INVALID answer leaves its protocol detail in the operation record', t => {
  const answer = { ok: false, lane: 'o11', verb: 'service-center', exitCode: 1, code: 'SC_PROTOCOL_INVALID', stage: 'service-center',
    result: { ok: false, code: 'SC_PROTOCOL_INVALID', stage: 'service-center', error: 'Service Center returned HTTP 500', protocol: PROTOCOL } };
  const { operation, files } = call(t, answer);
  assert.equal(operation.code, 'SC_PROTOCOL_INVALID');
  assert.deepEqual(operation.protocol, { operation: PROTOCOL.operation, expected: PROTOCOL.expected, got: PROTOCOL.got, sample: PROTOCOL.sample, form: 'error-page' });
  assert.doesNotMatch(files, /never kept/);
});

test('another code keeps no protocol field, and a long sample is cut', t => {
  const other = call(t, { ok: false, code: 'SC_ARGUMENT_INVALID', result: { ok: false, code: 'SC_ARGUMENT_INVALID', error: 'Required: --host', protocol: PROTOCOL } });
  assert.equal(other.operation.code, 'SC_ARGUMENT_INVALID');
  assert.equal(other.operation.protocol, undefined);
  const long = call(t, { ok: false, code: 'SC_PROTOCOL_INVALID', result: { ok: false, code: 'SC_PROTOCOL_INVALID', protocol: { ...PROTOCOL, sample: 'x'.repeat(5000) } } });
  assert.equal(long.operation.protocol.sample.length, 300);
  assert.equal(protocolOf({ structuredContent: { result: { code: 'SC_PROTOCOL_INVALID', protocol: PROTOCOL } } }), PROTOCOL);
  assert.equal(protocolOf({ ok: true }), undefined);
});

test('an SC_PAGE_NOT_FOUND answer (HTTP 404, split from SC_PROTOCOL_INVALID) keeps the same detail', t => {
  const notFound = { ...PROTOCOL, got: 'HTTP 404, text/html, error-page' };
  const { operation } = call(t, { ok: false, code: 'SC_PAGE_NOT_FOUND', result: { ok: false, code: 'SC_PAGE_NOT_FOUND', protocol: notFound } });
  assert.equal(operation.code, 'SC_PAGE_NOT_FOUND');
  assert.equal(operation.protocol.got, 'HTTP 404, text/html, error-page');
  assert.equal(operation.protocol.extra, undefined);
});
