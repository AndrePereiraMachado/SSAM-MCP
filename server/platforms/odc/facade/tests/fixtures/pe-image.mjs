// Test fixture: a minimal Windows PE image carrying a file version, for the Studio folder readers (kernel-image.mjs
// peFileVersion). Shared by kernel-image.test.mjs and the window 4x4 tests.
// A minimal PE32+ image with one .rsrc section holding RT_VERSION / 1 / 0x409 -> VS_VERSIONINFO (VS_FIXEDFILEINFO).
export function makePe(file, product = file) {
  const rsrc = Buffer.alloc(0x58 + 40 + 52);
  const dir = (at, id, to) => { rsrc.writeUInt16LE(1, at + 14); rsrc.writeUInt32LE(id, at + 16); rsrc.writeUInt32LE(to >>> 0, at + 20); };
  dir(0x00, 16, 0x80000000 | 0x18);
  dir(0x18, 1, 0x80000000 | 0x30);
  dir(0x30, 0x409, 0x48);
  rsrc.writeUInt32LE(0x1000 + 0x58, 0x48); rsrc.writeUInt32LE(40 + 52, 0x4c);
  rsrc.writeUInt16LE(40 + 52, 0x58); rsrc.writeUInt16LE(52, 0x5a);
  Buffer.from('VS_VERSION_INFO\0', 'utf16le').copy(rsrc, 0x58 + 6);
  const fixed = 0x58 + 40;
  rsrc.writeUInt32LE(0xfeef04bd, fixed); rsrc.writeUInt32LE(0x10000, fixed + 4);
  rsrc.writeUInt32LE(((file[0] << 16) | file[1]) >>> 0, fixed + 8); rsrc.writeUInt32LE(((file[2] << 16) | file[3]) >>> 0, fixed + 12);
  rsrc.writeUInt32LE(((product[0] << 16) | product[1]) >>> 0, fixed + 16); rsrc.writeUInt32LE(((product[2] << 16) | product[3]) >>> 0, fixed + 20);
  const head = Buffer.alloc(0x200);
  head.write('MZ', 0, 'latin1'); head.writeUInt32LE(0x40, 0x3c); head.write('PE\0\0', 0x40, 'latin1');
  head.writeUInt16LE(0x8664, 0x44); head.writeUInt16LE(1, 0x46); head.writeUInt16LE(240, 0x54);
  const opt = 0x58;
  head.writeUInt16LE(0x20b, opt); head.writeUInt32LE(16, opt + 108); head.writeUInt32LE(0x1000, opt + 112 + 16); head.writeUInt32LE(rsrc.length, opt + 112 + 20);
  const sec = opt + 240;
  head.write('.rsrc', sec, 'latin1'); head.writeUInt32LE(rsrc.length, sec + 8); head.writeUInt32LE(0x1000, sec + 12); head.writeUInt32LE(rsrc.length, sec + 16); head.writeUInt32LE(0x200, sec + 20);
  return Buffer.concat([head, rsrc]);
}
