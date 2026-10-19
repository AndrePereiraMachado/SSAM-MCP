import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_FILE_FORMATS, DATA_FILES_MAX, DATA_FILE_MAX_BYTES, DATA_FILES_MAX_BYTES, readDataFiles } from '../data-files.mjs';

test('M2 repeated paths and identical file SHA are refused together', t => {
  const put=setup(t),first=put('first.json','[{"Name":"A"}]'),copy=put('copy.json','[{"Name":"A"}]'),other=put('other.json','[{"Name":"B"}]');
  const result=readDataFiles([first,first,copy,other]);
  const duplicates=result.problems.filter(p=>p.code==='DATA_FILE_DUPLICATE');
  assert.equal(duplicates.length,2);
  assert.deepEqual(duplicates.map(p=>p.at),['files/1','files/2']);
  assert.ok(duplicates.every(p=>p.reason.includes('already')));
});

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx13-files-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return (name, value) => {
    const file = path.join(root, name);
    fs.writeFileSync(file, value);
    return file;
  };
}

test('JSON arrays, checked envelopes and ignored envelope keys preserve order and SHA of original bytes', t => {
  const put = setup(t);
  const a = put('a.json', '\ufeff[{"Name":"A","Empty":null,"Count":2,"Active":true}]');
  const b = put('b.json', JSON.stringify({ module: 'M', entity: 'E', count: 1, operationId: 'old', records: [{ Name: 'B' }] }));
  const result = readDataFiles([a,b], { module: 'M', entity: 'E' });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.rows.map(r => [r.file,r.row,r.values.Name]), [[a,1,'A'],[b,1,'B']]);
  assert.equal(result.files[0].sha256, createHash('sha256').update(fs.readFileSync(a)).digest('hex'));
  assert.deepEqual(result.notes.find(n => n.ignoredKeys)?.ignoredKeys, ['operationId']);
  assert.ok(result.notes.some(n => n.rule === 'utf8-bom-removed'));
  const bad = put('bad.json', JSON.stringify({ module:'Other', entity:'Other', count:2, records:[{A:1}] }));
  assert.equal(readDataFiles([bad], {module:'M',entity:'E'}).problems.length, 3);
});

test('JSONL and NDJSON use physical lines, skip blanks and collect every malformed row and cell', t => {
  const put = setup(t);
  const a = put('a.jsonl', '\ufeff{"Name":"A"}\r\n\r\n{broken}\r\n{"Name":"B","X":[],"Y":{"$ref":"id"}}\r\n42\r\n');
  const b = put('b.ndjson', '{"Name":"C"}\n');
  const result = readDataFiles([a,b]);
  assert.deepEqual(result.rows.map(r => r.row), [1,4,1]);
  assert.deepEqual(result.problems.map(p => [p.row,p.code]), [[3,'DATA_FILE_JSON_INVALID'],[4,'DATA_VALUE_INVALID'],[4,'DATA_VALUE_INVALID'],[5,'DATA_ROW_INVALID']]);
  assert.equal(result.files[0].rows, 4);
  assert.ok(result.notes.some(n => n.rule === 'jsonl-blank-line-skipped' && n.row === 2));
});

test('RFC4180 quoted delimiters, escaped quotes, BOM, CRLF and multiline physical row starts', t => {
  const put = setup(t);
  const file = put('quoted.csv', '\ufeffName,Detail,Empty\r\n"A,B","a ""quote""",\r\nNext,"two\r\nlines",x\r\nLast,plain,y\r\n');
  const result = readDataFiles([file]);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.rows.map(r => [r.row,r.values]), [
    [2,{Name:'A,B',Detail:'a "quote"'}],
    [3,{Name:'Next',Detail:'two\r\nlines',Empty:'x'}],
    [5,{Name:'Last',Detail:'plain',Empty:'y'}],
  ]);
  assert.ok(result.notes.some(n => n.rule === 'csv-empty-cell-absent'));
});

test('delimiter is explicit, never guessed; semicolon fix and invalid delimiters', t => {
  const put = setup(t);
  const file = put('semi.csv', 'Name;Count\nA;1\n');
  const missing = readDataFiles([file]);
  assert.deepEqual(missing.problems[0].fix, {delimiter:';'});
  assert.equal(missing.rows.length, 0);
  assert.deepEqual(readDataFiles([file],{delimiter:';'}).rows[0].values, {Name:'A',Count:'1'});
  for (const delimiter of ['', '::', '"', '\n']) assert.equal(readDataFiles([file],{delimiter}).problems[0].code,'INPUT_INVALID');
});

test('CSV reports repeated/empty headers, all field-count errors and all quote errors across files', t => {
  const put = setup(t);
  const header = put('header.csv', 'A,A,\n1,2,3\n1\n');
  const fields = put('fields.csv', 'A,B\n1\n1,2,3\n"multi\nline",ok\nlast,ok\n');
  const quotes = put('quotes.csv', 'A,B\nfoo"bar,x\n"closed"tail,x\n"open,x');
  const result = readDataFiles([header,fields,quotes]);
  assert.equal(result.problems.filter(p => p.code === 'DATA_FILE_CSV_HEADER_INVALID').length,2);
  assert.deepEqual(result.problems.filter(p => p.code === 'DATA_FILE_CSV_FIELDS').map(p=>p.row),[3,2,3,4]);
  assert.deepEqual(result.problems.filter(p => p.code === 'DATA_FILE_CSV_INVALID').map(p=>p.row),[2,3,4]);
  assert.deepEqual(result.rows.filter(r=>r.file===fields).map(r=>r.row),[2,3,4,6]);
});

test('all invalid file inputs and encodings are collected; empty record sets refuse', t => {
  const put = setup(t);
  const invalidUtf8 = put('bad.json', Buffer.from([0xc3,0x28]));
  const unsupported = put('unknown.txt','[]');
  const empty = put('empty.csv','A,B\n');
  const whitespace = put('white.json',' \n');
  const noRecords = put('none.json','[]');
  const missing = path.join(path.dirname(empty),'missing.json');
  const result = readDataFiles(['relative.json', unsupported, invalidUtf8, empty, whitespace, noRecords, missing]);
  assert.equal(result.problems.length,7);
  assert.ok(result.problems.some(p=>p.code==='DATA_FILE_ENCODING_INVALID'));
  assert.equal(result.problems.filter(p=>p.code==='DATA_FILE_EMPTY').length,3);
  assert.equal(result.rows.length,0);
  assert.equal(DATA_FILES_MAX,1000);
  assert.equal(DATA_FILE_FORMATS['.ndjson'],'jsonl');
  assert.equal(readDataFiles([]).problems[0].code,'INPUT_INVALID');
  assert.equal(readDataFiles(null).problems[0].code,'INPUT_INVALID');
});

test('single-file and cumulative byte ceilings are checked without reading oversized files', t => {
  const put = setup(t);
  const files = Array.from({length:5},(_,i)=>put(`large-${i}.json`,''));
  for (const file of files) fs.truncateSync(file, DATA_FILE_MAX_BYTES+1);
  const result = readDataFiles(files);
  assert.equal(DATA_FILES_MAX_BYTES,256*1024*1024);
  assert.equal(result.problems.filter(p=>p.code==='DATA_FILE_TOO_LARGE').length,5);
  assert.equal(result.problems.filter(p=>p.code==='DATA_FILES_TOO_LARGE').length,2);
  assert.equal(result.files.length,0);
});

test('JSON rejects all non-object rows and non-scalar cells without leaking their values in reasons', t => {
  const put = setup(t);
  const file = put('values.json','[null,[],42,{"A":[],"B":{"secret":"private"}},{"Name":"ok"}]');
  const result = readDataFiles([file]);
  assert.equal(result.problems.length,5);
  assert.ok(result.problems.every(p=>!p.reason.includes('private')));
  assert.equal(result.files[0].rows,5);
  assert.deepEqual(result.rows.at(-1).values,{Name:'ok'});
});

test('numeric lexemes retain precision and scale without changing JSON value types', t => {
  const put = setup(t);
  for (const extension of ['json','jsonl']) {
    const record = '{"Id":9007199254740993,"Amount":12.50,"Exponent":1e-3,"Name":"12.50"}';
    const file = put(`number.${extension}`,extension === 'json' ? `[${record}]` : record);
    const result = readDataFiles([file]);
    assert.deepEqual(result.problems,[]);
    assert.equal(typeof result.rows[0].values.Id,'number');
    assert.deepEqual(result.rows[0].numericSources,{Id:'9007199254740993',Amount:'12.50',Exponent:'1e-3'});
  }
});

test('CSV source columns survive absent empty cells and file-count cap still visits all inputs', t => {
  const put = setup(t);
  const file = put('empty-cells.csv','Name,Unknown\nA,\n,\n');
  const result = readDataFiles([file]);
  assert.deepEqual(result.rows.map(r=>r.values),[{Name:'A'},{}]);
  assert.deepEqual(result.rows[0].sourceColumns,['Name','Unknown']);
  const over = readDataFiles(Array(DATA_FILES_MAX+1).fill('relative.json'));
  assert.equal(over.problems.length,DATA_FILES_MAX+2);
  assert.equal(over.problems[0].at,'files');
});

test('field-count problems retain known cells so later validation can find every independent problem', t => {
  const put = setup(t);
  const file = put('cross-validation.csv','Name,Date,Parent\nA,invalid-date,missing-parent,extra\nB,another-invalid-date\n');
  const result = readDataFiles([file]);
  assert.deepEqual(result.problems.map(p=>[p.code,p.row]),[['DATA_FILE_CSV_FIELDS',2],['DATA_FILE_CSV_FIELDS',3]]);
  assert.deepEqual(result.rows.map(r=>r.values),[
    {Name:'A',Date:'invalid-date',Parent:'missing-parent'},
    {Name:'B',Date:'another-invalid-date'},
  ]);
  assert.deepEqual(result.rows[1].sourceColumns,['Name','Date','Parent']);
});
