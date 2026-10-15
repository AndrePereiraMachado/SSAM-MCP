// The content-addressed bundle (docs/PROTOTIPO-NATIVO.md 2.9): <task>\prototype\bundle\capture.json,
// sheets\<sha>.css, assets\<sha>.<ext>. The kernel reads only the bundle (paths relative to capture.json), never source;
// in server or thin-agent mode the bundle travels with the job.
import fs from 'node:fs';
import path from 'node:path';
import { canonical, sha256 } from './ir.mjs';

export function writeBundle(dir, ir, payloads = {}) {
  fs.mkdirSync(path.join(dir, 'sheets'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  // a payload without a bundle file (nothing of it travels) is skipped, never a throw (the VisitaCerta session of 2026-10-12:
  // a remote <link> made path.join(dir, undefined) throw and the answer was an SSAM defect with no way out)
  for (const sheet of payloads.sheets ?? []) {
    if (typeof sheet?.bundle !== 'string' || typeof sheet.text !== 'string') continue;
    const file = path.join(dir, sheet.bundle);
    if (!fs.existsSync(file)) fs.writeFileSync(file, sheet.text, 'utf8');
  }
  for (const asset of payloads.assets ?? []) {
    if (typeof asset?.bundle !== 'string' || asset.data == null) continue;
    const file = path.join(dir, asset.bundle);
    if (!fs.existsSync(file)) fs.writeFileSync(file, asset.data);
  }
  const capturePath = path.join(dir, 'capture.json');
  fs.writeFileSync(capturePath, canonical(ir), 'utf8');
  return capturePath;
}

// Verifies a bundle: every sheet and asset present with the hash the IR records.
export function verifyBundle(capturePath) {
  const dir = path.dirname(capturePath);
  const ir = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
  const problems = [];
  for (const sheet of ir.css?.sheets ?? []) {
    if (!sheet.bundle) continue;
    const file = path.join(dir, sheet.bundle);
    if (!fs.existsSync(file)) { problems.push('missing ' + sheet.bundle); continue; }
    if (sha256(fs.readFileSync(file)) !== sheet.sha256) problems.push('hash of ' + sheet.bundle);
  }
  for (const asset of ir.assets ?? []) {
    const file = path.join(dir, asset.bundle);
    if (!fs.existsSync(file)) { problems.push('missing ' + asset.bundle); continue; }
    if (sha256(fs.readFileSync(file)) !== asset.sha256) problems.push('hash of ' + asset.bundle);
  }
  return { ir, problems };
}
