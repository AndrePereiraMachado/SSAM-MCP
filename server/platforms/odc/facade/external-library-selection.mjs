import fs from 'node:fs';
import path from 'node:path';
import {readQualifiedRelease} from './qualified-release-selection.mjs';

// A capability-specific selection never changes the worker or its loaded DLLs.
// An explicit override or an invalid selection must not fall back silently.
export function externalLibrarySelection(root, env = process.env) {
  if (env.SSAM_ODC_EXTERNAL_LIBRARY_CLI !== undefined)
    return {cli:env.SSAM_ODC_EXTERNAL_LIBRARY_CLI,source:'environment'};
  const file=path.join(root,'.local','external-library-selection.json');
  if (!fs.existsSync(file)) return {cli:path.join(root,'.local','lane-odc','cli','anvil-odc.dll'),source:'default'};
  return readQualifiedRelease(file,'ssam-external-library-selection/1','External library');
}
