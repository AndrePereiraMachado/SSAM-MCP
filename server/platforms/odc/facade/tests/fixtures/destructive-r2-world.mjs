// CX15 r2 (I, C4, C5): a Service Center whose state lives in a JSON file, shared by the test process and a child process
// (two executors of the same token, as a real Service Center is shared), and the engine deps over it. Fakes only.
import fs from 'node:fs';
import path from 'node:path';
import { Journal } from '../../service-center/client.mjs';
import { storeBackup } from '../../destructive-operations.mjs';
import { CATALOG, FakeBridge } from './sc-fake-bridge.mjs';

export const HOST = 'personal-0000test.outsystemscloud.com';
export const REGISTRY = path.join(import.meta.dirname, 'sc-hosts.json');
const readState = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeState = (file, s) => fs.writeFileSync(file, JSON.stringify(s, null, 2));

export function initServer(file, names = ['ZZ A', 'ZZ B', 'ZZ C']) {
  const apps = names.map((name, i) => ({ key: 'a-' + (i + 1), name }));
  writeState(file, { apps, espaces: apps.map((a, i) => ({ key: 'm-' + (i + 1), name: a.name.replace(/\W+/g, '') + '_CS', app: a.key })), events: [] });
}
export const serverEvents = file => readState(file).events;
export const serverLeft = file => readState(file).apps.filter(a => !a.gone).map(a => a.name);

export function fileBridge(file, who) {
  const rows = list => list.filter(r => !r.gone).map(r => ({ Key: r.key, Name: r.name, ApplicationKey: r.app ?? null }));
  return new FakeBridge({ serviceCenter: CATALOG, api: {
    ListApplications: () => readState(file).apps.filter(a => !a.gone).map(a => ({ Key: a.key, Name: a.name })),
    ListEspaces: () => rows(readState(file).espaces), ListExtensions: () => [], GetConsumers: () => [],
    DeleteApplication: args => {
      const s = readState(file);
      if (args.simulate) return { success: true, simulated: true, messages: [], affectedApplications: [], deletedModules: s.espaces.filter(m => m.app === args.appKey).map(m => m.name) };
      s.events.push(`DeleteApplication ${args.appKey} by ${who}`);
      for (const a of s.apps) if (a.key === args.appKey) a.gone = true;
      for (const m of s.espaces) if (m.app === args.appKey) m.gone = true;
      writeState(file, s);
      return { success: true, simulated: false, messages: [], affectedApplications: [], deletedModules: [] };
    },
    DeleteModule: () => ({ success: true, message: null }),
  } });
}
// A backup that writes one synthetic OML per module; hook(item) runs before it answers.
export function fakeBackup(dir, root, who, hook = null) {
  return async (item, { operationId }) => {
    const files = [];
    for (const module of item.modules ?? []) {
      const source = path.join(dir, `${who}-${module}.oml`); fs.writeFileSync(source, 'PK synthetic ' + module);
      files.push({ ...storeBackup({ operationId, name: `${who}-${module}.oml`, source, root }), module });
    }
    if (hook) await hook(item);
    return { files };
  };
}
export function deps({ dir, serverFile, who, clock, hook = null }) {
  const root = path.join(dir, 'destructive');
  return { journal: new Journal(path.join(dir, 'receipts')), locate: () => fileBridge(serverFile, who), present: async () => false, running: async () => false,
    opener: () => { throw new Error('no prompt'); }, exports: dir, registry: REGISTRY, sleep: async () => {}, clock, destructiveRoot: root, backup: fakeBackup(dir, root, who, hook) };
}
