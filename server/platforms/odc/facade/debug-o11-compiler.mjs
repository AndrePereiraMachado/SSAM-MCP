// Select an isolated, qualified model compiler without replacing loaded assemblies.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { workspaceRoot } from './workspace.mjs';
import { fingerprintO11Publisher, fingerprintO11PublisherPackage } from './debug-o11-publisher.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = () => { throw new Error('debug_o11_compiler_selection_invalid'); };
export async function selectedO11Compiler(studioDir, fallback, { root = workspaceRoot,
  fingerprint = fingerprintO11Publisher, packageFingerprint = fingerprintO11PublisherPackage } = {}) {
  const selectionPath = path.join(root, '.local/debugger/o11-compiler-selection.json');
  if (!fs.existsSync(selectionPath)) return fallback;
  try {
    const read = record => {
      const file = fs.realpathSync(record.path), local = fs.realpathSync(path.join(root, '.local')) + path.sep;
      if (!file.startsWith(local) || hash(fs.readFileSync(file)) !== record.sha256) fail();
      return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    };
    const selection = JSON.parse(fs.readFileSync(selectionPath, 'utf8'));
    if (selection.schema !== 'ssam-o11-compiler-selection/1' || selection.capability !== 'apply') fail();
    const inputs = await fingerprint(studioDir, { root });
    const bundle = await packageFingerprint(selection.package.assemblyPath, { root });
    if (JSON.stringify(inputs) !== JSON.stringify(selection.inputs) ||
        JSON.stringify(bundle) !== JSON.stringify(selection.package)) fail();
    const proof = read(selection.nativeApply);
    if (proof.ok !== true || proof.command !== 'apply' || proof.data?.accepted !== true ||
        proof.data?.isValid !== true || proof.data?.dataContract?.accepted !== true) fail();
    // Bind both the native output and its receipt to the qualified compiler manifest.
    const candidate = fs.realpathSync(selection.candidate.path);
    if (!candidate.startsWith(fs.realpathSync(path.join(root, '.local')) + path.sep) ||
        path.resolve(proof.data.outPath) !== candidate ||
        hash(fs.readFileSync(candidate)) !== selection.candidate.sha256) fail();
    return bundle.assemblyPath;
  } catch { fail(); }
}
