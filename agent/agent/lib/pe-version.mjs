// The version resource (VS_VERSIONINFO) of a PE file, read as bytes: nothing is loaded or run. On macOS the Studio's
// managed entry assembly (ODCStudio.dll, ServiceStudio.dll) carries the same version resource that the Windows apphost
// copies into ODCStudio.exe / ServiceStudio.exe, so the agent reports the same four-number build on both systems (the
// identity the server judges, docs/FASE2-AGENTE.md 7). Windows keeps reading VersionInfo through PowerShell.
import fs from 'node:fs';

const RT_VERSION = 16;
const FIXED_SIGNATURE = 0xfeef04bd;

// {rva -> file offset} over the section table, or null.
function layout(b) {
  if (b.length < 0x40 || b.readUInt16LE(0) !== 0x5a4d) return null;
  const pe = b.readUInt32LE(0x3c);
  if (pe + 24 > b.length || b.readUInt32LE(pe) !== 0x00004550) return null;
  const count = b.readUInt16LE(pe + 6);
  const optionalSize = b.readUInt16LE(pe + 20);
  const optional = pe + 24;
  const magic = b.readUInt16LE(optional);
  const directories = magic === 0x20b ? optional + 112 : magic === 0x10b ? optional + 96 : -1;
  if (directories < 0 || directories + 24 > b.length || b.readUInt32LE(directories - 4) < 3) return null;
  const sections = [];
  const table = optional + optionalSize;
  for (let i = 0; i < count; i++) {
    const at = table + i * 40;
    if (at + 40 > b.length) return null;
    sections.push({ va: b.readUInt32LE(at + 12), size: Math.max(b.readUInt32LE(at + 8), b.readUInt32LE(at + 16)), raw: b.readUInt32LE(at + 20) });
  }
  const offsetOf = rva => { const s = sections.find(x => rva >= x.va && rva < x.va + x.size); return s ? s.raw + (rva - s.va) : -1; };
  return { offsetOf, resources: b.readUInt32LE(directories + 16) };
}

// The data of the first RT_VERSION resource: {at, size}, or null.
function versionResource(b, pe) {
  const base = pe.offsetOf(pe.resources);
  if (!pe.resources || base < 0) return null;
  const entries = dir => {
    if (dir + 16 > b.length) return [];
    const total = b.readUInt16LE(dir + 12) + b.readUInt16LE(dir + 14);
    const list = [];
    for (let i = 0; i < total && dir + 16 + i * 8 + 8 <= b.length; i++)
      list.push({ id: b.readUInt32LE(dir + 16 + i * 8), data: b.readUInt32LE(dir + 16 + i * 8 + 4) });
    return list;
  };
  const type = entries(base).find(e => (e.id & 0x80000000) === 0 && e.id === RT_VERSION);
  if (!type || !(type.data & 0x80000000)) return null;
  const name = entries(base + (type.data & 0x7fffffff))[0];
  if (!name || !(name.data & 0x80000000)) return null;
  const language = entries(base + (name.data & 0x7fffffff))[0];
  if (!language || language.data & 0x80000000) return null;
  const entry = base + language.data;
  if (entry + 8 > b.length) return null;
  const at = pe.offsetOf(b.readUInt32LE(entry));
  const size = b.readUInt32LE(entry + 4);
  return at < 0 || at + size > b.length ? null : { at, size };
}

// One node of the VS_VERSIONINFO tree: {key, type, valueAt, valueEnd, children, end}.
function node(b, at, end, origin) {
  if (at + 6 > end) return null;
  const length = b.readUInt16LE(at);
  if (length < 6 || at + length > end) return null;
  const valueLength = b.readUInt16LE(at + 2);
  const type = b.readUInt16LE(at + 4);
  const stop = at + length;
  let p = at + 6; let key = '';
  while (p + 1 < stop) { const c = b.readUInt16LE(p); p += 2; if (c === 0) break; key += String.fromCharCode(c); }
  const align = x => origin + Math.ceil((x - origin) / 4) * 4;
  p = align(p);
  const valueAt = p;
  const valueEnd = Math.min(stop, p + (type === 1 ? valueLength * 2 : valueLength));
  p = align(valueEnd);
  const children = [];
  while (p + 6 <= stop) {
    const child = node(b, p, stop, origin);
    if (!child) break;
    children.push(child);
    p = align(child.end);
  }
  return { key, type, valueAt, valueEnd, children, end: stop };
}

const text = (b, at, end) => { let s = ''; for (let p = at; p + 1 < end; p += 2) { const c = b.readUInt16LE(p); if (c === 0) break; s += String.fromCharCode(c); } return s; };
const numbers = (ms, ls) => [ms >>> 16, ms & 0xffff, ls >>> 16, ls & 0xffff].join('.');

// {productVersion, fileVersion, fixedFileVersion, fixedProductVersion} of a PE buffer, or null without a version
// resource. The strings come from the first StringTable that has them (FileVersionInfo does the same for an assembly,
// which carries one table).
export function peVersionInfo(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const pe = layout(b);
  if (!pe) return null;
  const resource = versionResource(b, pe);
  if (!resource) return null;
  const root = node(b, resource.at, resource.at + resource.size, resource.at);
  if (!root || root.key !== 'VS_VERSION_INFO') return null;
  const out = { productVersion: null, fileVersion: null, fixedFileVersion: null, fixedProductVersion: null };
  if (root.valueEnd - root.valueAt >= 52 && b.readUInt32LE(root.valueAt) === FIXED_SIGNATURE) {
    out.fixedFileVersion = numbers(b.readUInt32LE(root.valueAt + 8), b.readUInt32LE(root.valueAt + 12));
    out.fixedProductVersion = numbers(b.readUInt32LE(root.valueAt + 16), b.readUInt32LE(root.valueAt + 20));
  }
  for (const info of root.children.filter(child => child.key === 'StringFileInfo')) {
    for (const table of info.children) {
      for (const entry of table.children) {
        const value = text(b, entry.valueAt, entry.end);
        if (entry.key === 'ProductVersion' && out.productVersion === null) out.productVersion = value;
        if (entry.key === 'FileVersion' && out.fileVersion === null) out.fileVersion = value;
      }
    }
  }
  return out;
}

// The ProductVersion string of a PE file (what Windows shows as VersionInfo.ProductVersion), or null.
export function productVersionOf(file, { readFile = fs.readFileSync } = {}) {
  try { return peVersionInfo(readFile(file))?.productVersion || null; } catch { return null; }
}
