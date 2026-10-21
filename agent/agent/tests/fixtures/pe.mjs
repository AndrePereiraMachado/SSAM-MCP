// A minimal PE32+ file with one .rsrc section holding an RT_VERSION resource (VS_VERSIONINFO with VS_FIXEDFILEINFO and
// one StringTable), so the version reader is tested on bytes whose values the test chose (lib/pe-version.mjs).
const utf16z = text => Buffer.from(text + '\0', 'utf16le');
const pad4 = buffer => (buffer.length % 4 ? Buffer.concat([buffer, Buffer.alloc(4 - (buffer.length % 4))]) : buffer);

// One VS_VERSIONINFO node: header, key, padding, value, padding, children (each already 4-aligned).
function node(key, { type = 1, value = Buffer.alloc(0), valueLength = null, children = [] } = {}) {
  const head = Buffer.alloc(6);
  const keyBytes = pad4(Buffer.concat([head, utf16z(key)]));
  const body = Buffer.concat([keyBytes, pad4(value), ...children.map(pad4)]);
  body.writeUInt16LE(body.length, 0);
  body.writeUInt16LE(valueLength ?? (type === 1 ? value.length / 2 : value.length), 2);
  body.writeUInt16LE(type, 4);
  return body;
}
const versionWords = text => { const [a, b, c, d] = text.split('.').map(Number); return [(a << 16) | b, (c << 16) | d].map(n => n >>> 0); };

export function versionResource({ productVersion, fileVersion, fixed = '1.2.3.4' }) {
  const ffi = Buffer.alloc(52);
  ffi.writeUInt32LE(0xfeef04bd, 0); ffi.writeUInt32LE(0x00010000, 4);
  const [fms, fls] = versionWords(fixed);
  ffi.writeUInt32LE(fms, 8); ffi.writeUInt32LE(fls, 12); ffi.writeUInt32LE(fms, 16); ffi.writeUInt32LE(fls, 20);
  const strings = [];
  if (fileVersion !== undefined) strings.push(node('FileVersion', { value: utf16z(fileVersion) }));
  strings.push(node('CompanyName', { value: utf16z('Example') }));
  if (productVersion !== undefined) strings.push(node('ProductVersion', { value: utf16z(productVersion) }));
  const table = node('040904b0', { children: strings });
  const stringInfo = node('StringFileInfo', { children: [table] });
  const varInfo = node('VarFileInfo', { children: [node('Translation', { type: 0, value: Buffer.from([0x09, 0x04, 0xb0, 0x04]) })] });
  return node('VS_VERSION_INFO', { type: 0, value: ffi, children: [stringInfo, varInfo] });
}

export function fakePe(options) {
  const version = versionResource(options);
  const sectionRva = 0x1000; const fileAlign = 0x200;
  // Resource tree: root (type 16) -> name (1) -> language (0x409) -> data entry.
  const dir = (entries) => { const b = Buffer.alloc(16 + entries.length * 8); b.writeUInt16LE(entries.length, 14); entries.forEach(([id, offset], i) => { b.writeUInt32LE(id, 16 + i * 8); b.writeUInt32LE(offset >>> 0, 20 + i * 8); }); return b; };
  const rootDir = dir([[16, 0x80000000 | 24]]);
  const nameDir = dir([[1, 0x80000000 | 48]]);
  const langDir = dir([[0x409, 72]]);
  const dataEntry = Buffer.alloc(16);
  const dataOffset = 88;
  dataEntry.writeUInt32LE(sectionRva + dataOffset, 0); dataEntry.writeUInt32LE(version.length, 4);
  const rsrc = Buffer.concat([rootDir, nameDir, langDir, dataEntry, version]);
  const rawSize = Math.ceil(rsrc.length / fileAlign) * fileAlign;
  const headers = Buffer.alloc(0x200);
  headers.writeUInt16LE(0x5a4d, 0); headers.writeUInt32LE(0x80, 0x3c);
  const pe = 0x80;
  headers.writeUInt32LE(0x00004550, pe); headers.writeUInt16LE(0x8664, pe + 4); headers.writeUInt16LE(1, pe + 6);
  const optionalSize = 240; headers.writeUInt16LE(optionalSize, pe + 20); headers.writeUInt16LE(0x2022, pe + 22);
  const opt = pe + 24;
  headers.writeUInt16LE(0x20b, opt); headers.writeUInt32LE(sectionRva, opt + 16 + 4);
  headers.writeUInt32LE(0x1000, opt + 32); headers.writeUInt32LE(fileAlign, opt + 36);
  headers.writeUInt32LE(sectionRva + Math.ceil(rsrc.length / 0x1000) * 0x1000, opt + 56); headers.writeUInt32LE(0x200, opt + 60);
  headers.writeUInt32LE(16, opt + 108);
  headers.writeUInt32LE(sectionRva, opt + 112 + 16); headers.writeUInt32LE(rsrc.length, opt + 112 + 20);
  const section = opt + optionalSize;
  headers.write('.rsrc', section, 'latin1');
  headers.writeUInt32LE(rsrc.length, section + 8); headers.writeUInt32LE(sectionRva, section + 12);
  headers.writeUInt32LE(rawSize, section + 16); headers.writeUInt32LE(0x200, section + 20);
  headers.writeUInt32LE(0x40000040, section + 36);
  return Buffer.concat([headers, rsrc, Buffer.alloc(rawSize - rsrc.length)]);
}
