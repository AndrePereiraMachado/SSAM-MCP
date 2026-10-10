// Quick validation of the comprehensive catalog (T0): the shared descriptor composed with every fragment under
// catalog/fragments/<front>/, the ownership of the pinned inventory, and the accounting per lane and front.
// Pure: no CLI, Studio, reader, worker or network. The authoritative check against the real contracts is the index
// build (`ssam discover "<intent>" --lane odc|o11 --rebuild`), which refuses any pointer/proof/native mismatch.
//
//   node platforms/odc/facade/catalog-check.mjs [--front A|B|C] [--list unaccounted|represented|classified] [--all]
//   node platforms/odc/facade/catalog-check.mjs --fragments <dir>        (another fragments root, e.g. test fixtures)
//   node platforms/odc/facade/catalog-check.mjs --write-ownership        (integrator only: regenerates catalog/ownership.json)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCatalog, buildOwnership, FRAGMENTS_DIR, OWNERSHIP_FILE, FRONTS } from './catalog.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
// The denominator: the inventory reconciled with the installed runtimes (M1, 2026-09-23; ODC 1.7.25.10778, O11
// 11.55.87 = 11.55.69 model API). The phase-1 inventory stays as historical evidence in descoberta-cobertura-fase1.
const RECONCILED = 'docs/evidence/catalogo-abrangente/inventario-reconciliado';
const INVENTORY = RECONCILED + '/inventory.json';
const INVENTORY_NOTE = 'Inventory reconciled with the installed runtimes on 2026-09-23 (M1): ODC model API regenerated from Studio 1.7.25.10778 (was 1.7.24.10718: +10 inventoried types, -2), O11 catalog regenerated from Service Studio 11.55.87.65162 (model API identical to 11.55.69). Keys are version-free (lane:namespace.name).';
const USAGE = 'usage: node platforms/odc/facade/catalog-check.mjs [--front A|B|C] [--list unaccounted|represented|classified] [--all] [--fragments <dir>] | --write-ownership';

function parse(args) {
  const o = { front: null, list: null, all: false, fragments: FRAGMENTS_DIR, writeOwnership: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--front') { o.front = String(args[++i] ?? '').toUpperCase(); if (!FRONTS.includes(o.front)) throw new Error('--front must be A, B or C'); }
    else if (a === '--list') { o.list = args[++i]; if (!['unaccounted', 'represented', 'classified'].includes(o.list)) throw new Error('--list must be unaccounted, represented or classified'); }
    else if (a === '--all') o.all = true;
    else if (a === '--fragments') { o.fragments = path.resolve(process.cwd(), args[++i] ?? ''); if (!fs.existsSync(o.fragments)) throw new Error('--fragments directory not found: ' + o.fragments); }
    else if (a === '--write-ownership') o.writeOwnership = true;
    else throw new Error('unknown option ' + a + '; ' + USAGE);
  }
  if (o.list && !o.front) throw new Error('--list needs --front');
  return o;
}

try {
  const o = parse(process.argv.slice(2));
  if (o.writeOwnership) {
    const inventoryFile = path.join(root, INVENTORY);
    const ownership = buildOwnership({ inventoryFile, inventory: readJson(inventoryFile),
      descriptors: { odc: readJson(path.join(here, 'discovery-capabilities.json')), o11: readJson(path.join(here, 'discovery-capabilities-o11.json')) },
      shared: readJson(path.join(here, 'discovery-capabilities-shared.json')),
      note: INVENTORY_NOTE, reconciliation: fs.existsSync(path.join(root, RECONCILED, 'reconciliation.json')) ? RECONCILED + '/reconciliation.json' : null });
    ownership.inventory.file = INVENTORY;
    fs.mkdirSync(path.dirname(OWNERSHIP_FILE), { recursive: true });
    fs.writeFileSync(OWNERSHIP_FILE, JSON.stringify(ownership, null, 1) + '\n');
    process.stdout.write(JSON.stringify({ ok: true, written: path.relative(root, OWNERSHIP_FILE).replaceAll('\\', '/'), counts: ownership.counts, tools: Object.keys(ownership.tools).length, legacy: { capabilities: Object.keys(ownership.legacy.capabilities).length, unavailable: Object.keys(ownership.legacy.unavailable).length } }, null, 2) + '\n');
  } else {
    const report = checkCatalog({ root, fragmentsDir: o.fragments, front: o.front });
    if (o.list) {
      const ownership = readJson(OWNERSHIP_FILE);
      report.list = { state: o.list, items: listTypes(ownership, report, o) };
    }
    delete report.typeStates;
    if (!o.all && report.warnings.length > 40) { report.warningsOmitted = report.warnings.length - 40; report.warnings = report.warnings.slice(0, 40); }
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (!report.ok) process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(JSON.stringify({ ok: false, error: error.message }) + '\n');
  process.exitCode = 2;
}

// The work list of a front: its types in one accounting state, with family, inventory class and ownership rule.
function listTypes(ownership, report, o) {
  const out = [];
  for (const [key, t] of Object.entries(ownership.types)) {
    if (t.owner !== o.front || (report.typeStates[key] ?? 'unaccounted') !== o.list) continue;
    out.push({ type: key, family: t.family, kindClass: t.kindClass, rule: t.rule });
  }
  delete report.typeStates;
  return out;
}
