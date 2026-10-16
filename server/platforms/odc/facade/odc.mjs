// SSAM Hybrid-ODC command line. One entry for the Studio lane (bridge + builder, C#) and the Portal lane
// (official ODC public REST APIs, Node). `odc mcp` serves the same verbs as MCP tools (facade/mcp.mjs).
//   odc doctor [--live]                      state of everything an LLM needs before working
//   odc attach [--pid n]                     attach the newest bridge DLL to the running ODC Studio
//   odc studio <bridge command...> [--pid n] passthrough to the bridge client
//   odc build <builder arguments...>         passthrough to the builder
//   odc map <capture.oml|Module> [...]       every element of a capture from its module index (module-map.mjs)
//   odc portal status|apis|search|describe|auth-status|read|write|receipt|internal-read|internal-write|internal-routes|login ... [--tenant <host>]
//   odc mcp                                  MCP server over stdio
import { appUrl, attach, builder, createAccess, deliver, doctor, inspect, portalBridge, prepareManifest, studio, headlessDebug, tenantOf, tenants } from './lib.mjs';
import { parseDebugCli } from './debug.mjs';
import { parseAppArguments } from './app-urls.mjs';
import { readCatalog, resolveOpenTarget } from './studio-open.mjs';
import { bridgeCommandRefusal } from './destructive-operations.mjs';

const print = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
const fail = message => { process.stderr.write(JSON.stringify({ ok: false, error: message }) + '\n'); process.exitCode = 1; };
function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return { value: undefined, rest: args };
  if (index + 1 >= args.length || args[index + 1].startsWith('--')) throw new Error('Missing value for ' + name);
  return { value: args[index + 1], rest: [...args.slice(0, index), ...args.slice(index + 2)] };
}
function flag(args, name) { const index = args.indexOf(name); return { present: index >= 0, rest: index < 0 ? args : [...args.slice(0, index), ...args.slice(index + 1)] }; }

// The same tenant-aware access as the MCP tools (portal\runtime\access.mjs): tenant and auth per call, Studio session
// first, then the vault, then the private prompt; writes with the user's words and a new operation UUID, never resent.
const PORTAL_USAGE = 'odc portal status|apis|search <text> [--api id] [--read-only]|describe <operationId>|tenants'
  + ' | auth-status | read <operationId> [--query json] [--path json] [--body json] [--auth auto|studio|api-client]'
  + ' | write <operationId> [--path json] [--body json] --authorize "<user words>" --operation-uuid <uuid> [--confirm-tenant <host>]'
  + ' | receipt <operationUuid> | internal-read <id> [--input json] [--auth auto|studio|portal-credential]'
  + ' | internal-write <id> --input json --authorize "<user words>" --operation-uuid <uuid> | login [--action open|status|close]'
  + ' | internal-routes <module> [--view <screen>] [--match <text>]   [--tenant <host>]'
  + '   (a destructive write or internal-write without --confirmation-token <token> only previews; [--owner-request "<request>"])';
// The same guard as the MCP tools (portal\runtime\destructive-preview.mjs): a destructive write (DELETE, Undeploy, a
// destructive internal route) takes two calls; reads and other writes are unchanged.
async function accessCommand(sub, more, host) {
  const { guardedAccess } = await import('../portal/runtime/destructive-preview.mjs');
  const access = guardedAccess(await createAccess());
  let rest = more; const opt = name => { const o = option(rest, name); rest = o.rest; return o.value; };
  const json = name => { const v = opt(name); return v === undefined ? undefined : JSON.parse(v); };
  const auth = opt('--auth'), authorize = opt('--authorize'), operationUuid = opt('--operation-uuid'), confirmTenant = opt('--confirm-tenant');
  const confirmationToken = opt('--confirmation-token'), ownerRequest = opt('--owner-request');
  const common = { ...(host ? { tenant: host } : {}), ...(auth ? { auth } : {}) };
  const words = { authorize, operationUuid, ...(confirmTenant ? { confirmTenant } : {}), ...(confirmationToken ? { confirmationToken } : {}), ...(ownerRequest ? { ownerRequest } : {}) };
  if (sub === 'auth-status') return access.authStatus(common);
  if (sub === 'login') return access.portalLogin({ ...common, action: opt('--action') ?? 'open' });
  if (sub === 'receipt') return access.receipt({ operationUuid: rest[0] });
  const id = rest[0]; rest = rest.slice(1);
  if (!id) throw new Error(PORTAL_USAGE);
  if (sub === 'internal-read') return access.portalRead({ ...common, operationId: id, input: json('--input') ?? {} });
  if (sub === 'internal-write') return access.portalWrite({ ...common, operationId: id, input: json('--input') ?? {}, ...words });
  // Live-proof capture of an unmapped route (PORTAL_GAPS): action names from the module's own assets, nothing called.
  if (sub === 'internal-routes') return access.portalRoutes({ ...common, module: id, view: opt('--view'), match: opt('--match') });
  const input = Object.fromEntries([['query', json('--query')], ['path', json('--path')], ['body', json('--body')]].filter(([, v]) => v !== undefined));
  return sub === 'read' ? access.read({ ...common, operationId: id, ...input }) : access.write({ ...common, operationId: id, ...input, ...words });
}

async function portalCommand(args) {
  const { value: host, rest } = option(args, '--tenant');
  const [sub, ...more] = rest;
  if (!sub) throw new Error(PORTAL_USAGE);
  if (['read', 'write', 'auth-status', 'login', 'receipt', 'internal-read', 'internal-write', 'internal-routes'].includes(sub)) {
    const output = await accessCommand(sub, more, host);
    print(output);
    if (!output.ok) process.exitCode = 1;
    return;
  }
  const { host: key, tenant } = tenantOf(host);
  const { bridge, credentialAvailable } = await portalBridge(key, tenant, { requireCredential: false });
  if (sub === 'status') { print({ tenant: key, origin: tenant.portalOrigin, credentialAvailable, ...bridge.status() }); return; }
  if (sub === 'apis') { print({ tenant: key, apis: [...bridge.catalog.apis.values()].map(a => ({ id: a.id, title: a.title, version: a.version, operations: a.operations.length })) }); return; }
  if (sub === 'search') {
    const { value: apiId, rest: r1 } = option(more, '--api'); const { present: readOnly, rest: r2 } = flag(r1, '--read-only');
    print(bridge.catalog.list({ search: r2.join(' ') || undefined, apiId, readOnly: readOnly || undefined, offset: 0, limit: 50 })); return;
  }
  if (sub === 'describe') { print(bridge.catalog.describe(more[0])); return; }
  if (sub === 'tenants') { print(tenants()); return; }
  throw new Error('Unknown portal subcommand: ' + sub);
}

const [verb, ...args] = process.argv.slice(2);
try {
  switch (verb) {
    case 'debug': { const result = await headlessDebug(parseDebugCli(args.includes('--lane') ? args : [...args, '--lane', 'odc'])); print(result); if (!result.ok) process.exitCode = 1; break; }
    case 'doctor': { const report = await doctor({ live: flag(args, '--live').present }); print(report); if (!report.ok) process.exitCode = 2; break; }
    case 'attach': { const { value: pid } = option(args, '--pid'); print(await attach(pid)); break; }
    case 'studio': {
      const { value: pid, rest } = option(args, '--pid');
      if (rest.length === 0) throw new Error('odc studio <bridge command...>');
      // CX15: the bridge commands that delete records or call the Portal directly never run through this passthrough
      // (DESTRUCTIVE_BRIDGE_COMMANDS): the refusal names the dedicated tool; nothing reaches the bridge. CX15 r2 (R-A1): the
      // command is read from the whole line the pipe sends (one argument with spaces, "" or " " before it).
      const refused = bridgeCommandRefusal(rest[0], rest.slice(1), { surface: '.\\odc studio' });
      if (refused) { print(refused); process.exitCode = 1; break; }
      if (rest[0] === 'open' && rest[1]) {
        const open = resolveOpenTarget(rest[1], readCatalog());
        if (!open.ok) { print(open); process.exitCode = 1; break; }
        rest[1] = open.target;
      }
      print(await studio(rest, pid)); break;
    }
    case 'build': { const result = await builder(args); print(result); if (!result.ok) process.exitCode = 1; break; }
    case 'inspect': {
      // odc inspect <Module|model.oml> [Kind:Name/Kind:Name] [--depth N] [--max N] [--all] [--full] [--budget N] [--pid n]
      const { value: pid, rest: r0 } = option(args, '--pid'); const { value: depth, rest: r1 } = option(r0, '--depth'); const { value: max, rest: r2 } = option(r1, '--max'); const { present: all, rest: r3 } = flag(r2, '--all'); const { present: full, rest: r4 } = flag(r3, '--full'); const { value: budget, rest: r5 } = option(r4, '--budget');
      const { present: usages, rest: r6 } = flag(r5, '--usages');
      const { present: includeInternal, rest: r7 } = flag(r6, '--include-internal');
      let rest = r7; const query = { usages, includeInternal };
      const cold = flag(rest, '--cold'); rest = cold.rest; query.cold = cold.present;
      const selected = [];
      while (rest.includes('--select')) { const opt = option(rest, '--select'); rest = opt.rest; selected.push(opt.value); }
      if (selected.length) query.select = selected;
      for (const name of ['kind', 'name', 'text', 'offset', 'properties', 'scope', 'expectedSourceSha256']) {
        const opt = option(rest, '--' + name); rest = opt.rest;
        if (opt.value != null) query[name] = opt.value;
      }
      if (rest.length === 0 || rest.length > 2 || rest.some(a => a.startsWith('--'))) throw new Error('odc inspect <Module|model.oml> [Kind:Name/Kind:Name|@key] [--kind K] [--name N] [--text T] [--offset N] [--properties A,B] [--depth N] [--max N] [--full] [--select path ...] [--cold] [--expectedSourceSha256 hash]');
      const result = await inspect({ target: rest[0], path: rest[1], depth, max, all, full, budget, pid, ...query }); print(result); if (!result.ok) process.exitCode = 1; break;
    }
    case 'portal': await portalCommand(args); break;
    case 'manifest': {
      let rest = args; const input = {};
      for (const name of ['base', 'candidate', 'output', 'feature', 'owners', 'changes']) {
        const opt = option(rest, '--' + name); rest = opt.rest;
        if (opt.value != null) input[name] = ['owners', 'changes'].includes(name) ? JSON.parse(opt.value) : opt.value;
      }
      if (rest.length) throw new Error('Unknown manifest arguments: ' + rest.join(' '));
      const result = await prepareManifest(input); print(result); if (!result.ok) process.exitCode = 1; break;
    }
    case 'deliver': {
      // odc deliver <feature> [--module M] [--until snapshot|build|check-base|preview|merge] [--producer oml] [--tenant host] [--pid n]
      const { value: pid, rest: r0 } = option(args, '--pid'); const { value: module, rest: r1 } = option(r0, '--module'); const { value: until, rest: r2 } = option(r1, '--until');
      const { value: producer, rest: r3 } = option(r2, '--producer'); const { value: tenant, rest: r4 } = option(r3, '--tenant');
      const { value: job, rest: r5 } = option(r4, '--job'); const { value: feature, rest: r6 } = option(r5, '--feature');
      const { value: output, rest: r7 } = option(r6, '--output'); const { value: owners, rest: r8 } = option(r7, '--owners'); const { value: changes, rest: r9 } = option(r8, '--changes');
      if (r9.length > 1 || r9.some(s => s.startsWith('--')) || (feature && r9.length)) throw new Error('Unknown or duplicate deliver arguments: ' + r9.join(' '));
      if (!feature && !r9[0]) throw new Error('odc deliver <feature> [--job file.json --module M --owners JSON --changes JSON] [--until snapshot|build|check-base|preview|merge]');
      const result = await deliver({ feature: feature ?? r9[0], module, until: until ?? 'merge', pid, producer, tenant, job, output,
        ...(owners != null ? { owners: JSON.parse(owners) } : {}), ...(changes != null ? { changes: JSON.parse(changes) } : {}) });
      print(result); if (!result.ok) process.exitCode = 1; break;
    }
    case 'app': {
      print(await appUrl(parseAppArguments(args))); break;
    }
    case 'map': {
      // odc map <capture.oml|Module> [--lane odc|o11] [--kind K] [--name N] [--prefix P] [--role R] [--parent @key] [--key @key] [--offset N] [--max N] [--budget <bytes>] [--detail] [--expectedSourceSha256 hash] [--pid n]
      const { moduleMap, parseMapArguments } = await import('./module-map.mjs');
      const result = await moduleMap(parseMapArguments(args)); print(result); if (!result.ok) process.exitCode = 1; break;
    }
    case 'discover': {
      // odc discover <intent words...> [--lane odc|o11] [--app <capture.oml|Module>] [--detail <capability>] [--type <Interface>] [--limit N] [--budget <bytes>] [--rebuild]
      const { parseDiscoverArguments, laneInspect, laneMap } = await import('./discovery.mjs');
      const { discoverAll } = await import('./tool-routing.mjs');
      const input = parseDiscoverArguments(args);
      const result = await discoverAll({ ...input, inspect: laneInspect(input.lane, inspect), map: laneMap(input.lane) });
      print(result); if (!result.ok) process.exitCode = 1; break;
    }
    case 'mcp': { const { runStdio } = await import('./mcp.mjs'); await runStdio(); break; }
    default: fail('Usage: odc doctor [--live] | attach [--pid n] | studio <bridge command...> | build <builder args...> | manifest --base <oml> --candidate <oml> --output <new-dir> --feature <name> --owners <json-array> --changes <json-array> | deliver <feature> [--job <json> --module M --owners <json-array> --changes <json-array>] [--until step] | map <capture.oml|Module> [--kind K] [--name N] [--prefix P] [--role R] [--parent @key] [--offset N] [--max N] [--detail] | inspect <Module|model.oml> [Kind:Name/...] [--depth N] | discover <intent...> [--lane odc|o11] [--app <capture.oml>] [--detail <capability>] [--type <Interface>] [--budget <bytes>] | app <App> [Screen] [--environment <origin>] [--stage s] [--tenant host] | portal status|apis|search|describe|read|write|tenants ... [--tenant <host>] | mcp');
  }
} catch (error) { fail(error.message); }
