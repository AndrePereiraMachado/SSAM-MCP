// The built-ins the work packet carries (builtin-functions.mjs, 2026-10-12): from the kernel's checked-in catalog, the
// signatures of the functions the intent names and of every date and time function when it speaks of dates; a typed null
// the catalog lacks (NullDateTime, NullTime) with its closest names and the literal that means it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBuiltins, catalogFile, intentFunctions, closestBuiltins, functionNames, TYPED_NULLS } from '../builtin-functions.mjs';

const kernel = fileURLToPath(new URL('../../../../kernel', import.meta.url));

test('the newest checked-in catalog is read, by version and not by name order', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'builtins-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'catalog'));
  for (const v of ['11.9.1', '11.55.87', '11.100.2']) fs.writeFileSync(path.join(dir, 'catalog', `functions-${v}.json`), JSON.stringify({ Studio: v, Functions: [{ Name: 'F' + v.replace(/\./g, ''), Group: 'Math', Signature: 'F(): Integer' }] }));
  assert.equal(path.basename(catalogFile(dir)), 'functions-11.100.2.json');
  assert.equal(loadBuiltins(dir).studio, '11.100.2');
  assert.equal(loadBuiltins(path.join(dir, 'none')), null);
});

test('the intent of the 2026-10-12 test: GetUserId named, every date and time signature, no short plain word', () => {
  const catalog = loadBuiltins(kernel);
  assert.ok(catalog?.functions.length > 100, 'the repository catalog');
  const f = intentFunctions('server actions aggregate filter sort maxRecords call assign if foreach list append DateTime calculations input output parameters exception authentication current user GetUserId', catalog);
  assert.deepEqual(f.named, ['GetUserId']);
  for (const s of ['GetUserId(): UserId', 'AddMinutes(dt: Date Time, n: Integer): Date Time', 'NewTime(h: Integer, m: Integer, s: Integer): Time', 'NullDate(): Date', 'DateTimeToTime(dt: Date Time): Time'])
    assert.ok(f.signatures.includes(s), s);
  assert.ok(!f.signatures.some(s => /^If\(|^Max\(|^Index\(/.test(s)), 'if, max and index are words here, not calls');
  assert.equal(f.more.arguments.kind, 'functions');
  assert.match(f.note, /NullDateTime: use NullDate\(\)/);
  assert.ok(Buffer.byteLength(JSON.stringify(f), 'utf8') < 3000);
  const names = functionNames(f);
  assert.ok(names.names.includes('AddDays') && !('signatures' in names));
});

test('a call, a CamelCase name or a long name counts; a typed null the catalog lacks comes with its closest names and literal', () => {
  const catalog = loadBuiltins(kernel);
  const f = intentFunctions('somar com If(a, 1, 2) e currdatetime; usar NullDateTime() e NullTime no lugar de vazio', catalog);
  assert.deepEqual(f.named, ['If', 'CurrDateTime']);
  assert.equal(f.group, undefined, 'no date word: no group');
  const nullDateTime = f.unknown.find(u => u.name === 'NullDateTime');
  assert.ok(nullDateTime.closest.includes('NullDate')); assert.equal(nullDateTime.use, TYPED_NULLS.NullDateTime);
  assert.ok(f.unknown.find(u => u.name === 'NullTime').closest.includes('NewTime'));
  assert.equal(intentFunctions('criar uma entidade Pedido', catalog), null, 'nothing named: nothing carried');
  assert.ok(closestBuiltins('Substring', catalog).includes('Substr'));
});
