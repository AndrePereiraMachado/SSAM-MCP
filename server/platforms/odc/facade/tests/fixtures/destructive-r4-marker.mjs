// CX15 r4 (the family "the owner's authorization words in clear"): one synthetic marker inside the owner's words, and the
// scans that must find it 0 times (answers, files under a folder, any value).
import fs from 'node:fs';
import path from 'node:path';

export const MARK = 'ZZMARCADOR-R4-c41d7e';
// Synthetic owner's words (they name the synthetic targets the tests use, so a guard that checks the naming accepts them).
export const ownerWords = (...names) => `sim, pode seguir com ${names.join(', ')} ${MARK}`;
export const count = (text, mark = MARK) => String(text ?? '').split(mark).length - 1;
export const inValue = (value, mark = MARK) => count(JSON.stringify(value ?? null), mark);
export function filesUnder(dir) {
  const out = [];
  const walk = d => { let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else out.push(f); } };
  walk(dir);
  return out;
}
// Every file under the folders whose bytes (as UTF-8 and as UTF-16LE, the bridge's .NET side) contain the marker.
export function filesWithMark(dirs, mark = MARK) {
  const utf16 = Buffer.from(mark, 'utf16le');
  return dirs.flatMap(d => filesUnder(d)).filter(f => { let b; try { b = fs.readFileSync(f); } catch { return false; } return b.includes(Buffer.from(mark, 'utf8')) || b.includes(utf16); });
}
