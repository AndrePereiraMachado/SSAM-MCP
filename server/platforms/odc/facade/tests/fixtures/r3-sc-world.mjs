// CX15 r3 (subagent SC): the synthetic world of the r3 tests of the Service Center engine. A fake bridge whose page and
// API calls are ASYNC and wait on a hook first (so a client's cancellation can arrive in the middle of a read), the page
// deletes (db-connection-delete LegacyERP, solution-delete Billing) and the delete engine (applications ZZC ...), and an
// SDK McpServer with o11_service_center_write and ssam_task over Client + InMemoryTransport. Only fakes and synthetic
// names; no Studio, network or real profile.
import path from 'node:path';
import { McpServer, InMemoryTransport, fromJsonSchema } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { Journal } from '../../service-center/client.mjs';
import { registerO11Operations } from '../../o11-operations.mjs';
import { registerSsamTask } from '../../ssam-task.mjs';
import { readOperation } from '../../destructive-operations.mjs';
import { CATALOG, FakeBridge, SC, fixture, temp } from './sc-fake-bridge.mjs';
import { fakeClock } from './destructive-flow.mjs';

export const HOST = 'test.example.com';
export const PERSONAL = 'personal-0000test.outsystemscloud.com';
export const REGISTRY = path.join(import.meta.dirname, 'sc-hosts.json');
export const tick = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));

// The fake bridge with an awaited hook before every page fetch (world.onWeb(action, options)) and every API call
// (world.onApi(operation, args)).
export class HookBridge extends FakeBridge {
  constructor(options, world) { super(options); this.world = world; }
  async web(host, action, options = {}) {
    if (this.world.onWeb) await this.world.onWeb(action, options);
    return super.web(host, action, options);
  }
  async api(host, surface, operation, args = null, options = {}) {
    if (this.world.onApi) await this.world.onApi(operation, args ?? {});
    return super.api(host, surface, operation, args, options);
  }
}

const SOLUTION_EDIT = `<form method="post" action="Solution_Edit.aspx?SolutionId=5"><input name="wtSolution_Name" value="Billing"><input type="hidden" name="__VIEWSTATE" value="state">
<a href="javascript:__doPostBack('wtDelete','')" onclick="return confirm('Delete Billing?')">Delete</a></form>`;
const SOLUTIONS_AFTER = `<html><body><table><tr><th>Name</th><th>Description</th></tr>
<tr><td><a href="Solution_Edit.aspx?SolutionId=6">Platform</a></td><td></td></tr></table></body></html>`;

// The page deletes: the connection LegacyERP (used by no extension in the fixture page) and the solution Billing.
export const PAGE_DELETES = {
  'db-connection-delete': { target: { connection: 'LegacyERP' }, argv: ['--connection', 'LegacyERP'], edit: `${SC}DatabaseConnection_Edit.aspx?DBConnectionId=3`, name: 'LegacyERP' },
  'solution-delete': { target: { solution: 'Billing' }, argv: ['--solution', 'Billing'], edit: `${SC}Solution_Edit.aspx?SolutionId=5`, name: 'Billing' },
};
export function pageWorld() {
  const w = { dir: temp(), clock: fakeClock(), ids: 0, deleted: [], onWeb: null, onApi: null };
  w.root = path.join(w.dir, 'destructive');
  w.journal = new Journal(path.join(w.dir, 'receipts'));
  w.bridge = new HookBridge({ pages: {
    [`GET ${SC}DatabaseConnections_List.aspx`]: () => (w.deleted.includes('LegacyERP') ? '<table><tr><th>Name</th></tr></table><p>No connections found</p>' : fixture('db-connections.html')),
    [`GET ${SC}DatabaseConnection_Edit.aspx?DBConnectionId=3`]: () => fixture('db-connection-edit.html'),
    [`POST ${SC}DatabaseConnection_Edit.aspx?DBConnectionId=3`]: () => { w.deleted.push('LegacyERP'); return fixture('db-connections.html'); },
    [`GET ${SC}Solutions_List.aspx`]: () => (w.deleted.includes('Billing') ? SOLUTIONS_AFTER : fixture('solutions.html')),
    [`GET ${SC}Solution_Edit.aspx?SolutionId=5`]: () => SOLUTION_EDIT,
    [`POST ${SC}Solution_Edit.aspx?SolutionId=5`]: () => { w.deleted.push('Billing'); return '<p>deleted</p>'; },
  } }, w);
  w.deps = (extra = {}) => ({ journal: w.journal, locate: () => w.bridge, present: async () => false, running: async () => false,
    opener: () => { throw new Error('no prompt in a test'); }, exports: w.dir, registry: REGISTRY, sleep: async () => {}, clock: w.clock, destructiveRoot: w.root,
    previewUuid: () => `00000000-0000-4000-8000-${String(++w.ids).padStart(12, '0')}`, backup: async () => ({ files: [] }), ...extra });
  w.run = (action, argv, extra) => runPage(w, action, argv, extra);
  w.posts = () => w.bridge.posts();
  return w;
}
async function runPage(w, action, argv = [], extra = {}) {
  const { runServiceCenter } = await import('../../service-center/index.mjs');
  return runServiceCenter([action, '--host', HOST, ...PAGE_DELETES[action].argv, '--confirm-host', HOST, ...argv], w.deps(extra));
}

// The delete engine: applications ZZC A.. (modules: {<letter>: number of eSpaces}, extensions: {<letter>: number}; none by
// default), the same fake bridge with hooks.
export function engineWorld({ names = ['A', 'B', 'C', 'D'], prefix = 'ZZC', modules = {}, extensions = {} } = {}) {
  const w = { dir: temp(), clock: fakeClock(), ids: 0, onWeb: null, onApi: null, events: [],
    apps: names.map(x => ({ key: 'k-' + x.toLowerCase(), name: `${prefix} ${x}`,
      espaces: Array.from({ length: modules[x] ?? 0 }, (_, m) => ({ Key: `m-${x.toLowerCase()}-${m}`, Name: `${prefix}${x}_M${m + 1}`, ApplicationKey: 'k-' + x.toLowerCase() })),
      extensions: Array.from({ length: extensions[x] ?? 0 }, (_, m) => ({ Key: `x-${x.toLowerCase()}-${m}`, Name: `${prefix}${x}Ext${m + 1}`, ApplicationKey: 'k-' + x.toLowerCase() })) })) };
  w.root = path.join(w.dir, 'destructive');
  w.journal = new Journal(path.join(w.dir, 'receipts'));
  w.bridge = new HookBridge({ serviceCenter: CATALOG, api: {
    ListApplications: () => w.apps.filter(a => !a.gone).map(a => ({ Key: a.key, Name: a.name })),
    ListEspaces: () => w.apps.filter(a => !a.gone).flatMap(a => a.espaces), ListExtensions: () => w.apps.filter(a => !a.gone).flatMap(a => a.extensions), GetConsumers: [],
    DeleteApplication: args => {
      if (args.simulate) return { success: true, simulated: true, messages: [], affectedApplications: [], deletedModules: [] };
      for (const a of w.apps) if (a.key === args.appKey) a.gone = true;
      w.events.push('send ' + args.appKey);
      return { success: true, simulated: false, messages: [], affectedApplications: [], deletedModules: [] };
    } } }, w);
  w.deps = (extra = {}) => ({ journal: w.journal, locate: () => w.bridge, present: async () => false, running: async () => false, exports: w.dir, registry: REGISTRY,
    sleep: async () => {}, clock: w.clock, destructiveRoot: w.root, previewUuid: () => `00000000-0000-4000-8000-${String(++w.ids).padStart(12, '0')}`,
    backup: async () => ({ files: [] }), ...extra });
  w.sends = () => w.bridge.calls.filter(c => c[0] === 'api' && c[4]).map(c => c[3].appKey);
  return w;
}

// o11_service_center_write and ssam_task on an SDK McpServer, through Client + InMemoryTransport.
export async function mcp(w) {
  const server = new McpServer({ name: 'cx15r3-sc', version: '1.0.0' });
  registerO11Operations(server, fromJsonSchema, { serviceCenter: w.deps() });
  registerSsamTask(server, { destructiveRoot: w.root, tasksDir: path.join(w.dir, 'tasks') });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cx15r3-sc-client', version: '1.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const valueOf = reply => reply.structuredContent ?? JSON.parse(reply.content[0].text);
  return {
    call: async (name, args, options) => valueOf(await client.callTool({ name, arguments: args }, options)),
    close: async () => { await client.close(); await server.close(); },
  };
}

// The handlers of o11_service_center_write and ssam_task, called directly (as the incident replay calls them).
export function tools(w, extra = {}) {
  const registered = {};
  const server = { registerTool: (name, config, handler) => { registered[name] = { config, handler }; } };
  registerO11Operations(server, schema => schema, { serviceCenter: w.deps(extra) });
  registerSsamTask(server, { destructiveRoot: w.root, tasksDir: path.join(w.dir, 'tasks') });
  return {
    registered,
    call: async (input, ctx = {}) => { const wire = (await registered.o11_service_center_write.handler(input, ctx)).structuredContent; return { ...(wire.result ?? {}), wire }; },
    task: async args => (await registered.ssam_task.handler(args, {})).structuredContent,
  };
}

// The execution goes on in the server after the client cancelled: wait until its record is no longer running.
export async function settled(id, root, { tries = 150 } = {}) {
  for (let i = 0; i < tries; i++) { const r = readOperation(id, { root }); if (r && r.state !== 'running') return r; await tick(20); }
  return readOperation(id, { root });
}
