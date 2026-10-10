// Rows of the first sheet of a Service Center XLSX export (port of client.xlsx_rows), with Node alone: the ZIP central
// directory, stored or deflated parts, and a small namespace-aware XML reader for sharedStrings and sheet1.
import zlib from 'node:zlib';
import { ProtocolError } from './errors.mjs';

const PART_LIMIT = 64 * 1024 * 1024;
const MAIN = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}';

function zipEntries(body) {
  let eocd = -1;
  for (let i = body.length - 22; i >= Math.max(0, body.length - 65557); i--) if (body.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('no end of central directory');
  const count = body.readUInt16LE(eocd + 10);
  let p = body.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (body.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const nameLength = body.readUInt16LE(p + 28);
    entries.set(body.toString('utf8', p + 46, p + 46 + nameLength), { method: body.readUInt16LE(p + 10), crc: body.readUInt32LE(p + 16),
      compressed: body.readUInt32LE(p + 20), size: body.readUInt32LE(p + 24), local: body.readUInt32LE(p + 42) });
    p += 46 + nameLength + body.readUInt16LE(p + 30) + body.readUInt16LE(p + 32);
  }
  return entries;
}

function zipRead(body, entry) {
  const p = entry.local;
  if (body.readUInt32LE(p) !== 0x04034b50) throw new Error('bad local header');
  const start = p + 30 + body.readUInt16LE(p + 26) + body.readUInt16LE(p + 28);
  const data = body.subarray(start, start + entry.compressed);
  let out;
  if (entry.method === 0) out = data;
  else if (entry.method === 8) out = zlib.inflateRawSync(data, { maxOutputLength: PART_LIMIT + 1 });
  else throw new Error('unsupported compression');
  if (out.length !== entry.size || zlib.crc32(out) >>> 0 !== entry.crc >>> 0) throw new Error('Bad CRC-32');
  return out.toString('utf8');
}

const XML_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const xmlText = text => text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : XML_ENTITIES[e] ?? m);

// Elements as {name: '{ns}local', attrs, children, text}: text is ElementTree's .text (the text before the first child).
export function parseXml(source) {
  const root = { name: null, attrs: {}, children: [], text: null, ns: { xml: 'http://www.w3.org/XML/1998/namespace' } };
  const stack = [root];
  const addText = text => { const top = stack.at(-1); if (top.children.length === 0) top.text = (top.text ?? '') + text; };
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/gy;
  let match;
  while (re.lastIndex < source.length && (match = re.exec(source))) {
    if (match[1] !== undefined) addText(match[1]);
    else if (match[2] !== undefined) { if (stack.length < 2) throw new Error('unbalanced XML'); stack.pop(); }
    else if (match[3] !== undefined) {
      const parent = stack.at(-1);
      const raw = {};
      for (const a of match[4].matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) raw[a[1]] = xmlText(a[2] ?? a[3]);
      const ns = { ...parent.ns };
      for (const [k, v] of Object.entries(raw)) if (k === 'xmlns') ns[''] = v; else if (k.startsWith('xmlns:')) ns[k.slice(6)] = v;
      const [prefix, local] = match[3].includes(':') ? match[3].split(':', 2) : ['', match[3]];
      const uri = ns[prefix];
      const attrs = Object.fromEntries(Object.entries(raw).filter(([k]) => k !== 'xmlns' && !k.startsWith('xmlns:')));
      const element = { name: uri ? `{${uri}}${local}` : local, attrs, children: [], text: null, ns };
      parent.children.push(element);
      if (!match[5]) stack.push(element);
    } else if (match[6] !== undefined) addText(xmlText(match[6]));
    // otherwise a comment, a processing instruction or the DOCTYPE: skipped
  }
  if (re.lastIndex < source.length || stack.length !== 1 || root.children.length !== 1) throw new Error('malformed XML');
  return root.children[0];
}
function* iter(element, name) { if (element.name === name) yield element; for (const c of element.children) yield* iter(c, name); }
const findall = (element, name) => element.children.filter(c => c.name === name);
const joinText = (element, name) => [...iter(element, name)].map(t => t.text ?? '').join('');

export function xlsxRows(body) {
  if (!body.subarray(0, 2).equals(Buffer.from('PK'))) throw new ProtocolError('Service Center export is not an XLSX file');
  let entries;
  try { entries = zipEntries(body); } catch { throw new ProtocolError('Service Center export is not a valid XLSX file'); }
  const part = name => {
    if (entries.get(name).size > PART_LIMIT) throw new ProtocolError('XLSX part exceeds 64 MiB');
    return parseXml(zipRead(body, entries.get(name)));
  };
  if (!entries.has('xl/worksheets/sheet1.xml')) throw new ProtocolError('XLSX export has no first sheet');
  const shared = entries.has('xl/sharedStrings.xml') ? findall(part('xl/sharedStrings.xml'), MAIN + 'si').map(si => joinText(si, MAIN + 't')) : [];
  const rows = [];
  for (const row of iter(part('xl/worksheets/sheet1.xml'), MAIN + 'row')) {
    const values = new Map();
    findall(row, MAIN + 'c').forEach((cell, position) => {
      const letters = /^[A-Z]+/.exec(cell.attrs.r ?? '');
      const index = letters ? [...letters[0]].reverse().reduce((sum, ch, i) => sum + (ch.charCodeAt(0) - 64) * 26 ** i, 0) - 1 : position;
      const v = findall(cell, MAIN + 'v')[0];
      if (cell.attrs.t === 's' && v && /^[0-9]+$/.test(v.text ?? '') && Number(v.text) < shared.length) values.set(index, shared[Number(v.text)]);
      else if (v) values.set(index, v.text ?? '');
      else values.set(index, joinText(cell, MAIN + 't'));
    });
    rows.push(values.size ? Array.from({ length: Math.max(...values.keys()) + 1 }, (_, i) => values.get(i) ?? '') : []);
  }
  return rows;
}

// (datetime(1899, 12, 30) + timedelta(days=float(value))).strftime('%Y-%m-%d %H:%M:%S'); the text itself otherwise.
export function excelTime(value) {
  if (!/^\s*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?\s*$/.test(String(value))) return value;
  const micros = Math.round(Number(value) * 86400e6);
  const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(micros / 1000));
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}
