import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const DATA_FILE_FORMATS = Object.freeze({ '.json': 'json', '.jsonl': 'jsonl', '.ndjson': 'jsonl', '.csv': 'csv' });
export const DATA_FILES_MAX = 1000;
export const DATA_FILE_MAX_BYTES = 64 * 1024 * 1024;
export const DATA_FILES_MAX_BYTES = 256 * 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const scalar = value => value === null || ['string', 'number', 'boolean'].includes(typeof value);
// Keep JSON number tokens alongside their ordinary scalar values: Number alone can
// round an identifier or erase decimal scale before the type validator sees it.
function parseJson(text) {
  const numbers = new WeakMap();
  const value = JSON.parse(text, function (key, value, context) {
    if (typeof value === 'number' && context?.source) {
      if (!numbers.has(this)) numbers.set(this, Object.create(null));
      numbers.get(this)[key] = context.source;
    }
    return value;
  });
  return { value, numbers };
}

// A state machine retains physical start lines and quoted CRLF bytes. Syntax errors
// are collected per record; malformed records never enter the returned row list.
function csvRecords(text, delimiter, report) {
  const records = [];
  let cells = [], cell = '', state = 'start', line = 1, start = 1, invalid = false, touched = false;
  const fail = reason => { report(start, cells.length + 1, reason); invalid = true; };
  const finish = () => {
    cells.push(cell);
    records.push({ row: start, cells, invalid });
    cells = []; cell = ''; state = 'start'; invalid = false; touched = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const newline = c === '\r' || c === '\n';
    if (state === 'quoted') {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else state = 'closed';
      } else if (newline) {
        if (c === '\r' && text[i + 1] === '\n') { cell += '\r\n'; i++; }
        else cell += c;
        line++;
      } else cell += c;
      touched = true;
      continue;
    }
    if (newline) {
      finish();
      if (c === '\r' && text[i + 1] === '\n') i++;
      line++; start = line;
      continue;
    }
    touched = true;
    if (c === delimiter) { cells.push(cell); cell = ''; state = 'start'; continue; }
    if (state === 'closed') {
      fail('characters after a closing quote; only a delimiter or line ending is allowed');
      state = 'unquoted'; cell += c;
    } else if (c === '"') {
      if (state === 'start') state = 'quoted';
      else { fail('a quote in an unquoted field must be escaped inside a quoted field'); cell += c; }
    } else { cell += c; state = 'unquoted'; }
  }
  if (state === 'quoted') fail('quoted field is not closed');
  if (touched || cells.length || cell.length || state !== 'start') finish();
  return records;
}

/** Read all input files and report every independent offline problem before a write. */
export function readDataFiles(input, { delimiter = ',', module, entity } = {}) {
  const files = [], rows = [], problems = [], notes = [];
  const problem = (code, reason, details = {}) => problems.push({ code, reason, ...details });
  const delimiterValid = typeof delimiter === 'string' && delimiter.length === 1 && !/["\r\n\uFEFF]/.test(delimiter);
  if (!delimiterValid) problem('INPUT_INVALID', 'delimiter must be one character other than a quote or line ending', { at: 'delimiter' });
  if (!Array.isArray(input) || input.length < 1 || input.length > DATA_FILES_MAX) {
    problem('INPUT_INVALID', `files must contain 1 to ${DATA_FILES_MAX} absolute paths`, { at: 'files' });
    if (!Array.isArray(input)) return { files, rows, problems, notes };
  }
  let total = 0;
  const knownPaths = new Map(), knownHashes = new Map();
  const addRow = (file, row, values, numbers) => {
    if (!object(values)) { problem('DATA_ROW_INVALID', 'each record must be an object', { file, row }); return; }
    for (const [column, value] of Object.entries(values)) {
      if (!scalar(value)) problem('DATA_VALUE_INVALID', 'JSON cells must be scalar or null; objects, arrays and $ref are not accepted', { file, row, column });
    }
    const numericSources = numbers?.get(values);
    rows.push({ file, row, values, ...(numericSources ? { numericSources: { ...numericSources } } : {}) });
  };
  input.forEach((file, index) => {
    const at = `files/${index}`;
    const fail = (code, reason, details = {}) => problem(code, reason, { file: typeof file === 'string' ? file : undefined, at, ...details });
    const absolute = typeof file === 'string' && path.isAbsolute(file);
    const extension = typeof file === 'string' ? path.extname(file).toLowerCase() : '';
    const format = DATA_FILE_FORMATS[extension];
    if (!absolute) fail('INPUT_INVALID', 'file path must be absolute');
    if (!format) fail('DATA_FILE_FORMAT_INVALID', `unsupported extension: ${extension || '(none)'}`);
    if (!absolute || !format) return;
    let bytes;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) { fail('DATA_FILE_INVALID', 'path is not a file'); return; }
      total += stat.size;
      const tooLarge = stat.size > DATA_FILE_MAX_BYTES;
      const totalExceeded = total > DATA_FILES_MAX_BYTES;
      if (tooLarge) fail('DATA_FILE_TOO_LARGE', `file exceeds ${DATA_FILE_MAX_BYTES} bytes`);
      if (totalExceeded) fail('DATA_FILES_TOO_LARGE', `files exceed ${DATA_FILES_MAX_BYTES} total bytes`);
      if (tooLarge || totalExceeded) return;
      bytes = fs.readFileSync(file);
      total += bytes.length - stat.size;
      if (total > DATA_FILES_MAX_BYTES) { fail('DATA_FILES_TOO_LARGE', `files exceed ${DATA_FILES_MAX_BYTES} total bytes`); return; }
      if (bytes.length > DATA_FILE_MAX_BYTES) { fail('DATA_FILE_TOO_LARGE', `file exceeds ${DATA_FILE_MAX_BYTES} bytes`); return; }
    } catch (error) { fail('DATA_FILE_READ_FAILED', `cannot read file: ${error.code ?? 'read failed'}`); return; }
    const info = { path: file, sha256: createHash('sha256').update(bytes).digest('hex'), format, rows: 0 };
    let resolved;
    try { resolved = fs.realpathSync(file); } catch { resolved = path.resolve(file); }
    if (process.platform === 'win32') resolved = resolved.toLowerCase();
    const previousPath = knownPaths.get(resolved), previousHash = knownHashes.get(info.sha256);
    if (previousPath !== undefined) fail('DATA_FILE_DUPLICATE', 'file path was already supplied', { firstFileIndex: previousPath });
    else if (previousHash !== undefined) fail('DATA_FILE_DUPLICATE', 'file SHA256 was already supplied by another file', { firstFileIndex: previousHash });
    if (previousPath === undefined) knownPaths.set(resolved, index);
    if (previousHash === undefined) knownHashes.set(info.sha256, index);
    files.push(info);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { fail('DATA_FILE_ENCODING_INVALID', 'file must be valid UTF-8'); return; }
    if (text.startsWith('\uFEFF')) { text = text.slice(1); notes.push({ rule: 'utf8-bom-removed', file }); }
    if (!text.trim()) { fail('DATA_FILE_EMPTY', 'file is empty'); return; }
    if (format === 'json') {
      let value, numbers;
      try { ({ value, numbers } = parseJson(text)); }
      catch { fail('DATA_FILE_JSON_INVALID', 'file is not valid JSON'); return; }
      const records = Array.isArray(value) ? value : object(value) ? value.records : undefined;
      if (!Array.isArray(records)) { fail('DATA_FILE_JSON_INVALID', 'JSON must be an array of records or {records:[...]}'); return; }
      if (!Array.isArray(value)) {
        for (const key of ['module', 'entity']) {
          if (Object.hasOwn(value, key) && value[key] !== ({ module, entity })[key]) fail('DATA_FILE_METADATA_MISMATCH', `${key} does not match the call`, { column: key });
        }
        if (Object.hasOwn(value, 'count') && value.count !== records.length) fail('DATA_FILE_METADATA_MISMATCH', 'count does not match the number of records', { column: 'count' });
        const ignoredKeys = Object.keys(value).filter(key => !['records', 'module', 'entity', 'count'].includes(key));
        if (ignoredKeys.length) notes.push({ rule: 'json-envelope-keys-ignored', file, ignoredKeys });
      }
      info.rows = records.length;
      records.forEach((record, i) => addRow(file, i + 1, record, numbers));
    } else if (format === 'jsonl') {
      const lines = text.split(/\r\n|\n|\r/);
      for (const [i, line] of lines.entries()) {
        if (!line.trim()) { if (i < lines.length - 1) notes.push({ rule: 'jsonl-blank-line-skipped', file, row: i + 1 }); continue; }
        info.rows++;
        let value, numbers;
        try { ({ value, numbers } = parseJson(line)); }
        catch { fail('DATA_FILE_JSON_INVALID', 'line is not valid JSON', { row: i + 1 }); continue; }
        addRow(file, i + 1, value, numbers);
      }
    } else if (delimiterValid) {
      notes.push({ rule: 'csv-empty-cell-absent', file });
      const parsed = csvRecords(text, delimiter, (row, column, reason) => fail('DATA_FILE_CSV_INVALID', reason, { row, column }));
      const header = parsed.shift();
      if (!header) { fail('DATA_FILE_CSV_INVALID', 'CSV requires a header'); return; }
      let validHeader = !header.invalid;
      const seen = new Set();
      header.cells.forEach((column, i) => {
        if (!column || seen.has(column)) { fail('DATA_FILE_CSV_HEADER_INVALID', column ? 'CSV header repeats a column' : 'CSV header column is empty', { row: 1, column: column || i + 1 }); validHeader = false; }
        seen.add(column);
      });
      if (delimiter === ',' && header.cells.length === 1 && header.cells[0].includes(';')) {
        fail('DATA_FILE_CSV_DELIMITER', 'header contains semicolons; declare delimiter explicitly', { row: 1, fix: { delimiter: ';' } }); validHeader = false;
      }
      info.rows = parsed.length;
      for (const record of parsed) {
        if (record.cells.length !== header.cells.length) fail('DATA_FILE_CSV_FIELDS', `expected ${header.cells.length} fields, found ${record.cells.length}`, { row: record.row });
        if (!validHeader || record.invalid) continue;
        // Known cells of a field-count-invalid row still reach type/FK/key checks.
        // The file problem prevents all writes; missing cells remain absent.
        const values = Object.fromEntries(header.cells.flatMap((column, i) => record.cells[i] === '' || record.cells[i] === undefined ? [] : [[column, record.cells[i]]]));
        rows.push({ file, row: record.row, values, sourceColumns: header.cells });
      }
    }
    if (info.rows === 0) fail('DATA_FILE_EMPTY', 'file contains no data records');
  });
  return { files, rows, problems, notes };
}
