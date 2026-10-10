// Atritos 3, lane fa, C29: ssam_evidence never answers 0 items for a filter it did not understand. The friend's session
// (2026-10-06) wrote `kind ~ Container|Button`, `"key"` and `"path ~ Header2"` and got total 0 with ok:true each time.
// Quotes around the clause or the field are taken off, | alternates in = ~ !~, a malformed clause is refused with the
// grammar and an example built from the rows, and a valid filter that keeps 0 of N rows says what the rows hold.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEvidenceReader, parseClause } from '../ssam-evidence.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa3-evidence-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const file = path.join(dir, 'items.json');
fs.writeFileSync(file, JSON.stringify([
  { kind: 'Container', key: 'k1', path: '/Main/Header2' },
  { kind: 'Button', key: 'k2', path: '/Main/Body' },
  { kind: 'Link', key: 'k3', path: '/Main/Footer|Left' },
]));
const read = input => createEvidenceReader({ roots: [dir] }).read({ file, ...input });

test('C29: the three clauses of the session answer 2, 3 and 1', () => {
  assert.equal(read({ where: 'kind ~ Container|Button' }).total, 2);
  assert.equal(read({ where: '"key"' }).total, 3);
  assert.equal(read({ where: '"path ~ Header2"' }).total, 1);
  assert.equal(read({ where: "'kind' = 'Link'" }).total, 1, 'quotes around the field and the value');
  assert.equal(read({ where: '"kind" = "Button|Link"' }).total, 2);
  assert.equal(read({ where: 'kind !~ Container|Button' }).total, 1, '!~ keeps the rows that hold none');
  assert.equal(read({ where: 'path ~ Footer\\|Left' }).total, 1, '\\| is the character');
  assert.equal(read({ where: 'kind == Button' }).total, 1, '== is =');
  assert.deepEqual(parseClause('kind ~ A|B').any, ['a', 'b']);
});

test('C29: a malformed clause is EVIDENCE_FILTER_INVALID with the grammar and a valid example from the rows', () => {
  for (const where of ['kind =~ Container', 'kind <> Button', 'path ~ "Header2', '"kind = Container', 'kind Container', 'nome ~ Header']) {
    const refused = read({ where });
    assert.equal(refused.ok, false, where);
    assert.equal(refused.code, 'EVIDENCE_FILTER_INVALID', where + ' ' + JSON.stringify(refused));
    assert.match(refused.grammar, /alternatives with \|/);
    assert.deepEqual(refused.fields, ['kind', 'key', 'path']);
    assert.equal(refused.example, 'kind=Container|Button');
    assert.deepEqual(refused.continuation, { tool: 'ssam_evidence', arguments: { file, where: 'kind=Container|Button' }, why: refused.continuation.why });
    // The example answers.
    assert.equal(read({ where: refused.example }).total, 2);
  }
  assert.match(read({ where: 'nome ~ Header' }).error, /no row has the field "nome"/);
  // A negation or !field on a field no row has is still a valid question.
  assert.equal(read({ where: 'nome != x' }).total, 3);
  assert.equal(read({ where: '!nome' }).total, 3);
});

test('C29: a valid filter that keeps 0 of N rows answers empty with the fields, kinds and an example', () => {
  const none = read({ where: 'kind = Table' });
  assert.equal(none.ok, true); assert.equal(none.total, 0);
  assert.deepEqual(none.empty, { rows: 3, fields: ['kind', 'key', 'path'], kinds: ['Container', 'Button', 'Link'], example: 'kind=Container|Button' });
  assert.equal(read({ where: 'error' }).empty.rows, 3, 'a bare field nobody has: 0 of 3, explained');
  assert.equal(read({ where: 'kind = Button' }).empty, undefined);
  assert.equal(read({ where: 'kind = Table', max: 0 }).empty.rows, 3);
});
