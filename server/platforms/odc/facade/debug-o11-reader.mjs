// A maintenance-qualified, isolated reader for debugger model projections.
// Existing Studio/reader processes are never replaced or restarted.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { workspaceRoot } from './workspace.mjs';
import { LANES } from './lanes.mjs';
import { kernelReading } from './kernel-reading.mjs';
import { readerGeneration } from './reader-client.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = () => { throw new Error('debug_o11_reader_selection_invalid'); };
const sources = ['kernel/src/Anvil.Core/Kernel/KernelModelReader.cs', 'kernel/src/Anvil.Core/Kernel/ModelReading.cs'];
function contained(root, file) {
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(file));
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
export function selectedO11DebugReader({ root = workspaceRoot, entry = LANES.o11 } = {}) {
  const file = path.join(root, '.local/debugger/o11-reader-selection.json');
  if (!fs.existsSync(file)) return { entry, generation: 'operational', environment: process.env };
  try {
    const selection = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (selection.schema !== 'ssam-o11-debug-reader-selection/1' || selection.lane !== entry.lane ||
        selection.capability !== 'native-process-children-and-reference-collections/1' ||
        !path.isAbsolute(selection.runtimeDir ?? '') || !fs.existsSync(path.join(selection.runtimeDir, 'OutSystems.Model.V1.dll')) ||
        !Array.isArray(selection.sources) || selection.sources.length !== sources.length ||
        !Array.isArray(selection.binaries) || selection.binaries.length < 3) fail();
    const verify = pin => {
      if (!path.isAbsolute(pin?.path ?? '') || !contained(root, pin.path) || !/^[a-f0-9]{64}$/.test(pin.sha256 ?? '') ||
          digest(fs.readFileSync(pin.path)) !== pin.sha256) fail();
    };
    for (const source of sources) {
      const matches = selection.sources.filter(pin => path.resolve(pin.path) === path.resolve(root, source));
      if (matches.length !== 1) fail(); verify(matches[0]);
    }
    for (const pin of selection.binaries) verify(pin);
    const dll = selection.binaries.filter(pin => path.basename(pin.path) === 'anvil.dll');
    if (dll.length !== 1 || !selection.binaries.some(pin => path.basename(pin.path) === 'Anvil.Core.dll')) fail();
    const directory = path.dirname(dll[0].path);
    const actual = fs.readdirSync(directory).filter(name => /\.(dll|json)$/i.test(name)).sort();
    if (selection.binaries.some(pin => path.dirname(pin.path) !== directory) ||
        JSON.stringify(actual) !== JSON.stringify(selection.binaries.map(pin => path.basename(pin.path)).sort())) fail();
    // The same pinned build can project differently after an SDK update, and
    // readers authorized by another authority must keep separate generations.
    const generation = digest(JSON.stringify([selection, readerGeneration(dll[0].path, selection.runtimeDir)]));
    const indexRoot = path.join(root, '.local/debugger/reader-index', generation);
    return { entry: { ...entry, cli: dll[0].path }, generation, runtimeDir: selection.runtimeDir, indexRoot,
      environment: { ...process.env, SSAM_MODULE_INDEX_ROOT: indexRoot } };
  } catch { fail(); }
}

export async function debugO11Reading(args, options = {}) {
  const selected = selectedO11DebugReader(options);
  return kernelReading(selected.entry, [...args, ...(selected.runtimeDir ? ['--ss-dir', selected.runtimeDir] : [])],
    { environment: selected.environment });
}

export async function debugO11Map(input, options = {}) {
  const selected = selectedO11DebugReader(options);
  const { moduleMap } = await import('./module-map.mjs');
  return moduleMap(input, { reader: { entry: selected.entry, ssDir: selected.runtimeDir }, env: selected.environment });
}
