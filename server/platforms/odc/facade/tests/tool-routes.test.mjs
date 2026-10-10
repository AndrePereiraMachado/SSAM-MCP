// catalog/tools.json (ssam-tool-routes/1) against the live registry of the ssam MCP server: every tool and every verb
// is routed, no route is stale, every enum is classified, every arguments template fits the live schema, no template
// carries a real secret or authorization, no string sends the model to a shell, and the curated intents of the data
// route to their own tool and verb (oracle). In-process server, listTools only: no Studio, no tool call.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createSsamServer } from '../ssam.mjs';
import { TOOLS_FILE, loadToolRoutes, routeTools } from '../tool-routing.mjs';
import { PORTAL_READS, PORTAL_WRITES } from '../../portal/runtime/portal-routes.mjs';
import { rewriteHints } from '../responses.mjs';
import { frictionTool } from '../../../../facade/friction-boundary.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(fs.readFileSync(TOOLS_FILE, 'utf8'));
// The hook tools of the controlled app profile (context, propose, continue, status) are listed by the ssam server only
// with SSAM_APP_HOOK_TOOLS=1 (I10 of the 2026-10-06 package): their routes stay covered with them listed.
process.env.SSAM_APP_HOOK_TOOLS = '1';

async function liveTools() {
  const server = await createSsamServer();
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'tool-routes-test', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  // ssam_friction is added to tools/list by the stdio launch boundary (facade/friction-boundary.mjs), not by the server.
  try { return [...(await client.listTools()).tools, frictionTool]; } finally { await client.close(); await server.close(); }
}

// Every enum of a live input schema, by dotted path (arrays as name[]), depth <= 3.
function enumPaths(schema, prefix = '', out = new Map(), depth = 0) {
  if (!schema || depth > 3) return out;
  for (const [k, p] of Object.entries(schema.properties ?? {})) {
    const at = prefix ? `${prefix}.${k}` : k;
    const values = p.enum ?? p.anyOf?.flatMap(a => a.enum ?? []) ?? [];
    if (values.length) out.set(at, values);
    if (p.properties) enumPaths(p, at, out, depth + 1);
    for (const a of p.anyOf ?? []) if (a.properties) enumPaths(a, at, out, depth + 1);
    if (p.items) { if (p.items.enum) out.set(at + '[]', p.items.enum); enumPaths(p.items, at + '[]', out, depth + 1); }
  }
  return out;
}
const getPath = (obj, p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const routesOf = t => [[null, t], ...Object.entries(t.verbs ?? {})];

test('tools.json routes every live tool and verb of the ssam MCP server, and nothing stale', async t => {
  const compiled = loadToolRoutes();
  assert.deepEqual(compiled.problems, [], 'tools.json compiles without problems');
  const tools = await liveTools();
  const live = new Map(tools.map(x => [x.name, x]));
  const missing = [...live.keys()].filter(n => !data.tools[n]);
  const stale = Object.keys(data.tools).filter(n => !live.has(n));
  assert.deepEqual(missing, [], 'missing route for live tool(s)');
  assert.deepEqual(stale, [], 'stale route for tool(s) the server no longer lists');
  const unclassified = []; const verbProblems = [];
  const nonVerb = (tool, p) => data.nonVerbEnums.some(n => n.path === p && (!n.tool || n.tool === tool));
  for (const [name, tool] of live) {
    const entry = data.tools[name];
    // Lanes: both when the live schema has a lane enum with both lanes; o11_* is O11; studio_/odc_/hybrid_ are ODC.
    const laneEnum = tool.inputSchema.properties?.lane?.enum ?? [];
    if (laneEnum.includes('o11') && laneEnum.includes('odc')) assert.equal(entry.lane, 'both', `${name}: lane enum with both lanes`);
    if (/^o11_/.test(name)) assert.equal(entry.lane, 'o11', name);
    if (/^(studio|odc|hybrid)_/.test(name)) assert.equal(entry.lane, 'odc', name);
    assert.ok(['o11', 'odc', 'both'].includes(entry.lane), `${name}: lane`);
    const enums = enumPaths(tool.inputSchema);
    for (const [p, values] of enums) {
      if (entry.verbParam === p && entry.verbSelector?.split('|').includes('enum')) {
        const verbs = Object.values(entry.verbs).filter(v => v.selector === 'enum').map(v => v.value);
        for (const v of values) if (!verbs.includes(v)) verbProblems.push(`missing verb ${name}.${p}=${v}`);
        for (const v of verbs) if (!values.includes(v)) verbProblems.push(`stale verb ${name}.${p}=${v}`);
      } else if (!nonVerb(name, p)) unclassified.push(`${name}.${p}: declare it as verbParam or nonVerbEnums`);
    }
    if (entry.verbParam && entry.verbSelector === 'enum') assert.ok(enums.has(entry.verbParam), `${name}: verbParam ${entry.verbParam} is a live enum`);
    for (const [key, v] of Object.entries(entry.verbs ?? {})) {
      if (v.selector === 'documented') {
        const allow = name === 'odc_portal_read' ? Object.keys(PORTAL_READS) : name === 'odc_portal_write' ? Object.keys(PORTAL_WRITES) : null;
        if (allow) assert.ok(allow.includes(v.value), `${name}.${key}: in the portal allow-list`);
        else assert.ok(tool.description.includes(v.value), `${name}.${key}: documented verb appears in the live description`);
      }
      if (v.selector === 'presence') assert.ok(tool.inputSchema.properties?.[v.field], `${name}.${key}: presence field ${v.field} exists`);
      if (v.selector === 'example') assert.match(v.value, /^[a-z0-9-]+:(get|post|patch|put|delete):\//, `${name}.${key}: a public operation id`);
    }
    if (name === 'odc_portal_read') assert.deepEqual(Object.keys(entry.verbs).sort(), Object.keys(PORTAL_READS).sort(), 'every allow-listed Portal read is routed');
    if (name === 'odc_portal_write') assert.deepEqual(Object.keys(entry.verbs).sort(), Object.keys(PORTAL_WRITES).sort(), 'every allow-listed Portal write is routed');
  }
  assert.deepEqual(unclassified, [], 'unclassified enum(s)');
  assert.deepEqual(verbProblems, [], 'verbs out of sync with the live enums');
  // Verbs that are not enums, both directions. studio_command: the commands its live description lists ("commands
  // without a dedicated tool (a, b, c)") are exactly its documented verbs. Presence modes (a field whose presence selects
  // the operation): every live field the schema marks as a mode ("Alone: ...", "Instead of job ...") is routed as one or
  // declared in nonVerbModes, the two modes the live text names without that marker stay routed, nothing else is routed
  // as a mode, and each routed field is live and described.
  const commandList = live.get('studio_command').description.match(/commands without a dedicated tool \(([^)]+)\)/)?.[1];
  assert.ok(commandList, 'studio_command description lists its commands');
  const documented = Object.values(data.tools.studio_command.verbs).filter(v => v.selector === 'documented').map(v => v.value).sort();
  assert.deepEqual(documented, commandList.split(/,\s*/).map(s => s.trim()).sort(), 'studio_command documented verbs == the commands of its live description');
  const MODE_MARK = /\b(Alone:|Instead of job\b)/;
  // "taskId of an earlier delivery to resume"; "With reconcile:" in the tool text. ssam_doctor release is marked "Alone:"
  // by its owner (F7b, 2026-10-06), so it is not in UNMARKED. The modes of the 2026-10-05 package
  // (contract section 5): deliver and publish in one call (o11_deliver/studio_deliver publish), the consumers of a published
  // producer (o11_publish consumers), the close with proof of an uncertain task (ssam_task close).
  const UNMARKED = { o11_deliver: ['resume', 'publish'], odc_receipt: ['reconcile'], o11_publish: ['consumers'], ssam_task: ['close'], studio_deliver: ['publish'] };
  // ssam_doctor release (2026-10-06 package, F7b): the doctor reads without it and frees a reservation with it.
  const ABSENCE = { odc_receipt: ['reconcile'], o11_publish: ['consumers'], ssam_task: ['close'], ssam_doctor: ['release'] }; // without the field: the read (or plain publish) mode
  const nonVerbMode = (tool, f) => (data.nonVerbModes ?? []).some(n => n.tool === tool && n.field === f);
  const marked = name => Object.entries(live.get(name)?.inputSchema.properties ?? {}).filter(([, p]) => MODE_MARK.test(p.description ?? '')).map(([k]) => k);
  for (const n of data.nonVerbModes ?? []) assert.ok(marked(n.tool).includes(n.field), `nonVerbModes ${n.tool}.${n.field}: a live field marked as a mode`);
  for (const name of live.keys()) {
    const entry = data.tools[name];
    const routed = Object.values(entry.verbs ?? {}).filter(v => v.selector === 'presence');
    const fields = [...new Set(routed.map(v => v.field))].sort();
    const PRESENCE = [...new Set([...(UNMARKED[name] ?? []), ...marked(name).filter(f => !nonVerbMode(name, f))])].sort();
    assert.deepEqual(fields, PRESENCE, `${name}: presence modes routed (a live mode field is routed or declared in nonVerbModes)`);
    for (const f of PRESENCE) {
      assert.ok(live.get(name).inputSchema.properties?.[f], `${name}: presence field ${f} is live`);
      assert.match(live.get(name).description, new RegExp(`\\b${f}\\b`), `${name}: presence field ${f} is described`);
      const modes = routed.filter(v => v.field === f).map(v => v.value);
      assert.ok(modes.some(v => v !== '<absent>'), `${name}.${f}: the present mode is routed`);
      if (ABSENCE[name]?.includes(f)) assert.ok(modes.includes('<absent>'), `${name}.${f}: the absent mode is routed`);
    }
  }
  const verbCount = Object.values(data.tools).reduce((n, x) => n + Object.keys(x.verbs ?? {}).length, 0);
  t.diagnostic(`${live.size} live tools routed; ${verbCount} verbs (enum, documented, presence and public-operation examples)`);
});

// The effect of each route (tools.json `effect`, read by the model rule of discoverAll) agrees with the live annotations:
// a readOnlyHint tool and all its verbs are 'read'; a tool that is not read-only is 'write' (or 'delivery' for the proof
// and delivery path of a model change) and only its verbs that read are 'read'; a tool without annotations states the
// effect of every verb.
test('the effect of every route agrees with the live readOnlyHint/destructiveHint annotations', async () => {
  const live = new Map((await liveTools()).map(x => [x.name, x]));
  const problems = [];
  const DELIVERY = ['o11_deliver', 'studio_deliver', 'ssam_job', 'o11_job'];
  for (const [name, entry] of Object.entries(data.tools)) {
    const ann = live.get(name)?.annotations ?? {};
    const verbs = Object.entries(entry.verbs ?? {});
    const eff = v => v.effect ?? entry.effect;
    if (!['read', 'write', 'delivery'].includes(entry.effect)) problems.push(`${name}: effect ${entry.effect}`);
    if (DELIVERY.includes(name) !== (entry.effect === 'delivery')) problems.push(`${name}: delivery is exactly ${DELIVERY.join(', ')}`);
    if (ann.readOnlyHint === true) { if (entry.effect !== 'read' || verbs.some(([, v]) => eff(v) !== 'read')) problems.push(`${name}: readOnlyHint, every route must be read`); }
    else if (ann.readOnlyHint === false) { if (entry.effect === 'read') problems.push(`${name}: not read-only, the tool cannot be read`); }
    else if (verbs.length && verbs.some(([, v]) => !v.effect && entry.effect === 'write') && !verbs.some(([, v]) => v.effect)) problems.push(`${name}: no annotations, state the effect of its verbs`);
    if (ann.destructiveHint === true && entry.effect === 'read') problems.push(`${name}: destructiveHint on a read tool`);
    for (const [k, v] of verbs) if (v.effect && !['read', 'write'].includes(v.effect)) problems.push(`${name}.${k}: verb effect ${v.effect}`);
  }
  assert.deepEqual(problems, []);
  // the writes the rule must never offer for a model step are classified as such
  const effectOf = (tool, verb) => data.tools[tool].verbs?.[verb]?.effect ?? data.tools[tool].effect;
  for (const [tool, verb] of [['odc_write', null], ['studio_data_update', null], ['studio_data_insert', null], ['studio_data_delete', null], ['o11_data', 'insert'], ['o11_data', 'delete'], ['o11_service_center_write', 'module-delete'], ['odc_portal_write', null], ['o11_publish', null], ['studio_publish', null], ['odc_deploy', 'Deploy']])
    assert.equal(effectOf(tool, verb), 'write', `${tool}${verb ? '.' + verb : ''}`);
  for (const [tool, verb] of [['o11_data', 'read'], ['studio_data', null], ['odc_read', null], ['odc_portal_read', null], ['o11_service_center_read', 'logs']]) assert.equal(effectOf(tool, verb), 'read', `${tool}${verb ? '.' + verb : ''}`);
});

test('every arguments template fits the live schema and the verb it selects', async () => {
  const tools = new Map((await liveTools()).map(x => [x.name, x]));
  const problems = [];
  const check = (name, at, args, schema) => {
    for (const [k, v] of Object.entries(args ?? {})) {
      const p = schema.properties?.[k];
      if (!p) { problems.push(`${at}: argument ${k} is not in the live schema`); continue; }
      if (v && typeof v === 'object' && !Array.isArray(v) && p.properties) check(name, `${at}.${k}`, v, p);
    }
  };
  for (const [name, entry] of Object.entries(data.tools)) {
    const schema = tools.get(name).inputSchema;
    for (const [verb, src] of routesOf(entry)) {
      const at = verb ? `${name}.${verb}` : name;
      // the route's own template, and the template of each lane that has its own (byLane)
      for (const [where, args] of [[at, src.args ?? entry.args], ...Object.entries(src.byLane ?? {}).filter(([, o]) => o.args).map(([l, o]) => [`${at} byLane.${l}`, o.args])]) {
        check(name, where, args, schema);
        for (const r of schema.required ?? []) if (!(r in (args ?? {}))) problems.push(`${where}: required argument ${r} missing from the template`);
        if (verb && ['enum', 'documented', 'example'].includes(src.selector)) {
          if (getPath(args, src.field) !== src.value) problems.push(`${where}: template ${src.field} must be ${src.value}`);
        }
      }
      if (src.byLane && (src.lane ?? entry.lane) !== 'both') problems.push(`${at}: byLane on a route of one lane`);
      for (const [l, o] of Object.entries(src.byLane ?? {})) if (o.args?.lane && o.args.lane !== l) problems.push(`${at} byLane.${l}: template lane ${o.args.lane}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('no template carries a real authorization, words, uuid or credential, and no string sends the model to a shell', () => {
  const SENSITIVE = /^(authorize|authorization|words|text|operationUuid|operationId|password|token|credential.*|secret.*)$/i;
  const problems = [];
  const walk = (v, at, verbField) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`, verbField));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
      if (SENSITIVE.test(k) && k !== verbField && typeof x === 'string' && !/^<[^>]+>$/.test(x)) problems.push(`${at}.${k} = ${JSON.stringify(x)} is not a <placeholder>`);
      walk(x, `${at}.${k}`, verbField);
    }
  };
  for (const [name, entry] of Object.entries(data.tools)) for (const [verb, src] of routesOf(entry)) walk(src.args ?? {}, verb ? `${name}.${verb}` : name, src.field ?? entry.verbParam);
  assert.deepEqual(problems, []);
  // What an answer can carry (tools and gaps, without the developer cli form) must survive the response shaper; the
  // vocabulary (synonyms, lane words) is never emitted.
  const emitted = JSON.parse(JSON.stringify({ tools: data.tools, gaps: data.gaps }, (k, v) => (k === 'cli' ? undefined : v)));
  const { continuations } = rewriteHints(emitted);
  assert.deepEqual(continuations, [], 'a string of tools.json reads as a shell command');
  assert.doesNotMatch(JSON.stringify(emitted), /python |\.ps1\b|dotnet build|\bssam (job|deliver|inspect|map|discover)\b|\bodc (studio|deliver|build)\b/);
});

test('references inside tools.json resolve: equivalents, superseded unavailable entries, groups, intents', () => {
  const unavailable = new Set();
  const dir = path.join(here, '..', 'catalog', 'fragments', 'C');
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), (k, v) => { if (v && typeof v === 'object' && typeof v.id === 'string' && (v.reason || v.alternative)) unavailable.add(v.id); return v; });
  const groups = new Set(data.groups.map(g => g.id));
  const problems = [];
  const exists = ref => (ref.gap ? true : !!data.tools[ref.tool] && (!ref.verb || !!data.tools[ref.tool].verbs?.[ref.verb]));
  for (const [name, entry] of Object.entries(data.tools)) {
    if (!groups.has(entry.group)) problems.push(`${name}: unknown group ${entry.group}`);
    if (!entry.when || entry.when.length > 240) problems.push(`${name}: when missing or too long`);
    for (const [verb, src] of routesOf(entry)) {
      const at = verb ? `${name}.${verb}` : name;
      for (const ref of Object.values(src.equivalent ?? {})) if (!exists(ref)) problems.push(`${at}: equivalent ${JSON.stringify(ref)} does not exist`);
      for (const id of src.supersedesUnavailable ?? []) if (!unavailable.has(id)) problems.push(`${at}: supersedes unknown unavailable entry ${id}`);
      const isRoute = verb !== null || !entry.verbs;
      if (isRoute && !(src.triggers?.length)) problems.push(`${at}: a route needs at least one trigger`);
      if (isRoute && !(src.intents?.pt?.length || src.intents?.en?.length)) problems.push(`${at}: a route needs curated intents`);
      for (const tr of src.triggers ?? []) if (!tr.length || tr.length > 4) problems.push(`${at}: trigger of 1-4 terms`);
    }
  }
  assert.deepEqual(problems, []);
});

// The curated sentences of the data are the oracle (never triggers): each routes to its own tool and verb on its lane
// (on both lanes for tools of both). Thresholds are the measured ones of 2026-10-03 (top-1 96.1%, 95.9% after the verifier round; top-3 96.7% of 1672
// checks; 2026-10-04: top-1 96.1%, top-3 96.8%); the misses are genuine near-duplicates between tools (Service Center applications vs environment
// inventory, the Portal connection list vs one connection, o11_job vs ssam_job).
test('the curated intents of tools.json route to their own tool and verb (oracle)', t => {
  let n = 0, top1 = 0, top3 = 0;
  for (const [name, entry] of Object.entries(data.tools)) for (const [verb, src] of routesOf(entry)) {
    if (verb === null && entry.verbs) continue;
    const lane = src.lane ?? entry.lane;
    for (const s of [...(src.intents?.pt ?? []), ...(src.intents?.en ?? [])]) for (const l of lane === 'both' ? ['odc', 'o11'] : [lane]) {
      n++;
      const r = routeTools({ intent: s, lane: l }).tools;
      const own = x => x.tool === name && (verb === null || x.verb === verb);
      if (r[0] && own(r[0])) top1++;
      if (r.slice(0, 3).some(own)) top3++;
    }
  }
  t.diagnostic(`oracle: ${n} checks, top-1 ${(100 * top1 / n).toFixed(1)}%, top-3 ${(100 * top3 / n).toFixed(1)}%`);
  assert.ok(top1 / n >= 0.95, `oracle top-1 ${top1}/${n}`);
  assert.ok(top3 / n >= 0.96, `oracle top-3 ${top3}/${n}`);
});
