// Anonymize an ODC capture with the kernel's own machinery: the same module, every client name replaced by a neutral
// one. The terms and the replacements come from docker/ssam-server/client-denylist.json (never shipped); nothing here
// names a client.
//
//   node scripts/anonymize-odc-fixture.mjs --base <capture.oml> --out <neutral.oml> --work <empty folder>
//        [--cli kernel/.local/lane-odc/cli/anvil-odc.dll] [--rounds 3]
//
// Each round: the kernel reader (anvil-odc inspect --text <term>, paged) lists every element whose own properties hold a
// term; each finding becomes one job op over the element's @key: `rename` for a name (the kernel rewrites every
// reference and expression that cites it), `set` for a text property (Description, Label, JavaScript...) and `set` of
// the owner property for an expression (the reader keys an expression as <owner>.#<Property>Expression). anvil-odc apply
// runs the job headless (preflight, Verify, contract of messages) and writes the next OML; the next round reads it again.
// The run stops when a search finds nothing, and fails when a round finds the same leftovers twice.
// The result is the anonymized OML plus <out>.json, the sidecar (module, key, sha256, dependencies), with no tenant,
// developer or local path: those name the publisher, not the module.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback; };
const base = path.resolve(arg('--base') ?? fail('--base is required'));
const out = path.resolve(arg('--out') ?? fail('--out is required'));
const work = path.resolve(arg('--work') ?? fail('--work is required'));
const cli = path.resolve(arg('--cli', path.join(root, 'kernel', '.local', 'lane-odc', 'cli', 'anvil-odc.dll')));
const rounds = Number(arg('--rounds', '4'));
function fail(message) { console.error(message); process.exit(2); }
if (fs.existsSync(out)) fail('the output already exists: ' + out);
fs.mkdirSync(work, { recursive: true });

const denylist = JSON.parse(fs.readFileSync(path.join(root, 'docker', 'ssam-server', 'client-denylist.json'), 'utf8'));
const terms = denylist.terms.map(t => new RegExp(t.pattern, 'i'));
const searches = [...new Set(denylist.terms.map(t => t.search))];
const replacements = denylist.replacements.map(([p, r]) => [new RegExp(p, 'g'), r]);
const named = text => typeof text === 'string' && terms.some(re => re.test(text));
const neutral = text => replacements.reduce((s, [re, r]) => s.replace(re, r), text);

// Properties the reader derives from something else (the name, the owner, a reference, a collection): never written.
const DERIVED = new Set(['DisplayName', 'OwnerESpace', 'GlobalKey', 'Object', 'TransactionsManager', 'Descriptor', 'ObjectKey', 'Key',
  'Referrers', 'CollectionDescriptor', 'ReadableIdentifier', 'RuntimePath', 'DisplayValue', 'Expression', 'ExpandedText', 'Root',
  'ExpandedRoot', 'ApplicableCssClasses', 'UserStyleSheet', 'Type', 'DataType', 'ElementType', 'ListElementType', 'Nodes', 'Path', 'FullName']);
const NAME = new Set(['Name', 'Identifier']);
const reference = value => /^\[.*\]$/s.test(value) || /^[A-Z][A-Za-z]+(Signature)?:[^\s"]/.test(value) && !/\s{2}/.test(value) && !value.includes('"');

function dotnet(args) {
  return execFileSync('dotnet', [cli, ...args], { cwd: work, encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1' } });
}
function search(oml, text) {
  const entries = [];
  for (let offset = 0; ; offset += 500) {
    const data = JSON.parse(dotnet(['inspect', '--oml', oml, '--text', text, '--max', '500', '--offset', String(offset), '--depth', '0', '--full'])).data;
    entries.push(...data.entries);
    if (!data.truncated || data.nextOffset == null) break;
  }
  return entries;
}

// The ops of one round, and the findings no op covers (reported).
function plan(oml) {
  const byKey = new Map();
  for (const text of searches) for (const e of search(oml, text)) byKey.set(e.key, e);
  const ops = []; const left = [];
  for (const e of byKey.values()) {
    const props = Object.entries(e.properties ?? {}).filter(([k, v]) => typeof v === 'string' && !DERIVED.has(k) && named(v));
    const expression = /^(.+)\.#([A-Za-z]+)Expression$/.exec(e.key);
    // The module's app name (AppName, which the reader does not list) shows as the ESpace's DisplayName: written apart.
    if (e.kind === 'ESpace' && named(e.properties?.DisplayName)) {
      left.push(`ESpace ${e.key}: AppName (DisplayName)`);
      ops.push({ op: 'set', target: '@' + e.key, prop: 'AppName', value: neutral(e.properties.DisplayName) });
    }
    // A text search matches inside words and derived properties too: only an own property naming a client is a finding.
    if (props.length || (expression && named(e.properties?.Text))) left.push(`${e.kind} ${e.key}: ${props.map(([k]) => k).join(', ') || 'Text'}`);
    if (expression && /Expression$/.test(e.kind) && named(e.properties?.Text)) {
      // A custom property's expression (Url of an Image, Value of an Expression widget) is written through its widget,
      // which the search finds as well (its Url or Value property); the owner key of the custom property does not resolve.
      if (!/\/CustomProperty:[^/]+\/[^/]+$/.test(e.path ?? '')) ops.push({ op: 'set', target: '@' + expression[1], prop: expression[2], value: neutral(e.properties.Text) });
      continue;
    }
    for (const [k, v] of props) {
      if (/\u2026$/.test(v)) fail(`the reader cut ${e.kind} ${e.key} ${k} (${v.length} chars); it must be read whole (--full)`);
      if (e.key.includes('.#')) continue;   // a derived signature (the check/grant actions of a role): follows its owner
      if (NAME.has(k)) ops.push({ op: 'rename', target: '@' + e.key, name: neutral(v) });
      else if (reference(v)) continue;   // a reference or a collection: follows the rename of what it names
      else if (e.kind === 'Expression' && k === 'Text') continue;
      else ops.push({ op: 'set', target: '@' + e.key, prop: k === 'Value' && e.kind === 'Expression' ? 'Value' : k, value: neutral(v) });
    }
  }
  // Renames first, outermost (shortest path) first: a later op still finds its element by key.
  const order = op => (op.op === 'rename' ? 0 : 1);
  ops.sort((a, b) => order(a) - order(b));
  return { ops: dedupe(ops), found: left.length, searched: byKey.size, left };
}
const dedupe = ops => [...new Map(ops.map(op => [JSON.stringify(op), op])).values()];

let current = base; let previous = null;
for (let round = 1; round <= rounds; round++) {
  const { ops, found, searched, left } = plan(current);
  console.error(`round ${round}: ${found} elements name a client (${searched} found by the searches), ${ops.length} ops`);
  if (!ops.length) {
    if (found) fail(`round ${round}: ${found} elements still name a client and no op covers them:\n` + left.slice(0, 40).join('\n'));
    break;
  }
  const signature = JSON.stringify(ops);
  if (signature === previous) fail(`round ${round}: the same ${ops.length} ops again; the kernel did not take them:\n` + JSON.stringify(ops.slice(0, 20), null, 1));
  previous = signature;
  const job = path.join(work, `anonymize-round-${round}.json`);
  fs.writeFileSync(job, JSON.stringify({ description: `Anonymization round ${round}`, ops }, null, 1));
  const next = path.join(work, `round-${round}.oml`);
  let result;
  try { result = JSON.parse(dotnet(['apply', '--job', job, '--base', current, '--out', next])); }
  catch (error) { fail(`round ${round}: apply failed\n${error.stdout ?? ''}\n${error.stderr ?? error.message}`); }
  if (result.ok !== true || result.data?.accepted !== true) fail(`round ${round}: apply not accepted\n${JSON.stringify(result.data ?? result, null, 1).slice(0, 4000)}`);
  console.error(`round ${round}: applied, isValid=${result.data.isValid}`);
  current = next;
}
if (current === base) fail('nothing to anonymize');
const last = plan(current);
if (last.found) fail(`${last.found} elements still name a client after the last round:\n` + last.left.slice(0, 40).join('\n'));

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.copyFileSync(current, out);
const inspect = JSON.parse(dotnet(['inspect', '--oml', out])).data;
const bytes = fs.readFileSync(out);
// The sidecar of the neutral blank fixtures (blank-crossdevice.oml.json): no tenant, a neutral developer.
const sidecar = { ok: true, module: inspect.name ?? inspect.Name, moduleKey: inspect.key ?? inspect.Key ?? null, kind: inspect.kind ?? inspect.Kind ?? null,
  sha256: crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase(),
  createdBy: `scripts/anonymize-odc-fixture.mjs (kernel rename/set ops over a capture of sha256 ${crypto.createHash('sha256').update(fs.readFileSync(base)).digest('hex').toUpperCase()})`,
  capturedAt: null, developerId: 'anvil@ssam-hybrid.local', host: null, modified: false };
const original = base + '.json';
if (fs.existsSync(original)) { const o = JSON.parse(fs.readFileSync(original, 'utf8').replace(/^﻿/, '')); if (o.moduleKey) sidecar.moduleKey = o.moduleKey; sidecar.capturedAt = o.capturedAt ?? null; if (o.dependencies) sidecar.dependencies = o.dependencies; }
fs.writeFileSync(out + '.json', JSON.stringify(sidecar, null, 2) + '\n');
console.log(JSON.stringify({ out, sha256: sidecar.sha256, module: sidecar.module, bytes: bytes.length }));
