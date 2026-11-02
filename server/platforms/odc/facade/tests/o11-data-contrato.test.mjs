import './fixtures/isolated-profile.mjs';
// C-27, C-32 (ported from the proto line): o11_data as the friction reports met it. F-FitBody-52 and F-FT-24: the capture
// the packet named was taken before the delivery, and 42 and 14 DATA_REQUEST_INVALID ("Unknown attribute", "Entity not
// found") came without saying so; the answer now says the capture predates the delivery and the next call is the same read
// on the newest capture of the module. C-27: the schema says operationId is a UUID. No Studio, no kernel.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newerCapture, o11DataAnswer, o11DataRequestSchema } from '../ssam.mjs';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'o11-data-c32-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const refused = message => ({ ok: false, via: 'process', envelope: { ok: false, code: 'DATA_REQUEST_INVALID', error: '1 problem(s) before any write',
  problems: [{ op: 0, pointer: '/records/0/IsTrainingOfDay', code: 'DATA_REQUEST_INVALID', message }] } });

test('C-32: names the capture lacks, with a newer capture of the module, are a capture that predates the delivery', t => {
  const dir = tmp(t);
  const old = path.join(dir, 'FigmaMobile-20261027053505-6d990dfa.oml');
  const current = path.join(dir, 'build-FigmaMobile-20261027061514-d90a22b1.oml');
  for (const f of [old, current, path.join(dir, 'FigmaReactive-20261027070000-aaaa.oml'), path.join(dir, 'FigmaMobileX-20261027080000.oml')]) fs.writeFileSync(f, 'x');
  assert.equal(newerCapture(old, 'FigmaMobile'), current);
  assert.equal(newerCapture(current, 'FigmaMobile'), null);
  // The snapshot of o11_studio has no hash: the same module, and newer than both.
  const snapshot = path.join(dir, 'FigmaMobile-20261027090000.oml');
  fs.writeFileSync(snapshot, 'x');
  assert.equal(newerCapture(old, 'FigmaMobile'), snapshot);
  fs.rmSync(snapshot);
  const call = { host: 'personal.outsystemscloud.com', module: 'FigmaMobile', oml: old };
  const read = { operation: 'read-all', entity: 'FBContent' };
  const answer = o11DataAnswer(refused('Unknown attribute FBContent.IsTrainingOfDay; attributes: Id, Title'), read, call);
  assert.equal(answer.staleCapture.newer, current);
  assert.match(answer.staleCapture.note, /predates the delivery/);
  assert.deepEqual(answer.continuation.arguments, { ...call, oml: current, request: read });
  // A write is never replayed: the newer capture is named, the words go again with the session.
  const write = { operation: 'insert', entity: 'FBContent', operationId: 'a'.repeat(8) + '-0000-5000-8000-' + '0'.repeat(12), authorization: 'sha256:x', records: [{ Title: 'A' }] };
  const written = o11DataAnswer(refused('Entity not found in this module: FBWorkoutLog; entities: FBContent'), write, call);
  assert.equal(written.continuation, undefined);
  assert.match(written.staleCapture.next, /send the same request with oml/);
  // Another refusal, or no newer capture, is as it was.
  assert.equal(o11DataAnswer(refused('delete needs ids'), read, call).staleCapture, undefined);
  assert.equal(o11DataAnswer(refused('Unknown attribute FBContent.X'), read, { ...call, oml: current }).staleCapture, undefined);
  assert.equal(o11DataAnswer(refused('Unknown attribute FBContent.X'), read, { ...call, oml: 'C:\\captures\\FigmaMobile.oml' }).staleCapture, undefined);
});

test('C-27: the schema of o11_data says operationId is a UUID', () => {
  const [single, batch] = o11DataRequestSchema.anyOf;
  assert.equal(single.properties.operationId.format, 'uuid');
  assert.equal(batch.properties.batch.items.properties.operationId.format, 'uuid');
});
