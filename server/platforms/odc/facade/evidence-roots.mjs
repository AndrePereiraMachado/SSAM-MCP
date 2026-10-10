// The one registry of the folders an SSAM answer can name (A21 of the 2026-10-06 package, interface I12). ssam_evidence
// reads JSON/JSONL only under these roots; a path the server itself returned must always pass (the friction report found
// OUTSIDE_ROOTS for the reservation file the doctor names and for .local\preview\<plan>). A folder that a new answer
// names is added here, and the path contract test (pa2-f7a-evidence.test.mjs) checks every path-naming function.
//
//   <anvil>/.local                        the O11 lane: reading, reference, work (task result.json and receipts), jobs,
//                                         environment/<action>/<time> (o11_environment), answers (pageAnswer), lane-ss5
//   <odc>/.local, journal, lab, snapshots the ODC lane
//   <workspace>/.local/debugger           the headless debugger's manifests, receipts and traces
//   <workspace>/.local/preview            the local preview plans and profiles
//   <workspace>/.local/friction           the friction queue (and SSAM_FRICTION_DIR when set)
//   <workspace>/.local/module-index       the module index of ssam_map (or SSAM_MODULE_INDEX_ROOT)
//   <authority>/reservations              the module reservations of O11 deliveries (and their real MSIX copies)
// Read only: nothing here creates a folder.
import fs from 'node:fs';
import path from 'node:path';
import { anvilRoot, odcRoot, workspaceRoot } from './workspace.mjs';
import { authorityDir, userEnvironmentValue } from './o11-lane.mjs';

const nonEmpty = value => typeof value === 'string' && value.trim() !== '';

// The real copies of a folder under %LOCALAPPDATA% that a packaged (MSIX) process sees under its own package
// (%LOCALAPPDATA%\Packages\<family>\LocalCache\Local\<relative>), as moduleReservations (ssam.mjs) lists them.
function packagedCopies(directory, env) {
  const local = env.LOCALAPPDATA;
  if (!nonEmpty(local)) return [];
  const relative = path.relative(local, directory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return [];
  const packages = path.join(local, 'Packages');
  let families = [];
  try { families = fs.readdirSync(packages, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { return []; }
  return families.map(family => path.join(packages, family, 'LocalCache', 'Local', relative)).filter(dir => fs.existsSync(dir));
}

export function ssamPathRoots({ anvil = anvilRoot, odc = odcRoot, workspace = workspaceRoot, env = process.env, readUserEnvironment = userEnvironmentValue } = {}) {
  const roots = [
    path.join(anvil, '.local'), path.join(anvil, '.local', 'answers'),
    path.join(odc, '.local'), path.join(odc, 'journal'), path.join(odc, 'lab'), path.join(odc, 'snapshots'),
    path.join(workspace, '.local', 'debugger'), path.join(workspace, '.local', 'preview'),
    path.join(workspace, '.local', 'friction'), path.join(workspace, '.local', 'module-index'),
  ];
  if (nonEmpty(env.SSAM_FRICTION_DIR)) roots.push(path.resolve(env.SSAM_FRICTION_DIR));
  if (nonEmpty(env.SSAM_MODULE_INDEX_ROOT)) roots.push(path.resolve(env.SSAM_MODULE_INDEX_ROOT));
  let authority = null;
  try { authority = authorityDir({ env, readUserEnvironment }); } catch { authority = null; }
  if (nonEmpty(authority)) {
    const reservations = path.join(authority, 'reservations');
    roots.push(reservations, ...packagedCopies(reservations, env));
  }
  const seen = new Set();
  return roots.map(r => path.resolve(r)).filter(r => { const key = process.platform === 'win32' ? r.toLowerCase() : r; if (seen.has(key)) return false; seen.add(key); return true; });
}
