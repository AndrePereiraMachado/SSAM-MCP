// CX15 r3 (subagent SC, CT-5): the child process of destructive-r3-sc-interrupted.test.mjs. It previews the 4
// applications ZZC A..D and executes them; it DIES (process.exit) during the send of ZZC B, after the server applied it
// (B is gone). argv: <dir>. The listing lives in <dir>\gone.json so the parent reads the same server. Only fakes.
import './isolated-profile.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { Journal } from '../../service-center/client.mjs';
import { runServiceCenter } from '../../service-center/index.mjs';
import { CONFIRM_MIN_AGE_MS } from '../../destructive-operations.mjs';
import { CATALOG, FakeBridge } from './sc-fake-bridge.mjs';
import { fakeClock } from './destructive-flow.mjs';

const dir = process.argv[2];
const PERSONAL = 'personal-0000test.outsystemscloud.com';
const REGISTRY = path.join(import.meta.dirname, 'sc-hosts.json');
const goneFile = path.join(dir, 'gone.json');
const gone = () => { try { return JSON.parse(fs.readFileSync(goneFile, 'utf8')); } catch { return []; } };
const apps = ['A', 'B', 'C', 'D'].map(x => ({ key: 'k-' + x.toLowerCase(), name: 'ZZC ' + x }));
const bridge = new FakeBridge({ serviceCenter: CATALOG, api: {
  ListApplications: () => apps.filter(a => !gone().includes(a.key)).map(a => ({ Key: a.key, Name: a.name })),
  ListEspaces: () => [], ListExtensions: [], GetConsumers: [],
  DeleteApplication: args => {
    if (args.simulate) return { success: true, simulated: true, messages: [], affectedApplications: [], deletedModules: [] };
    fs.writeFileSync(goneFile, JSON.stringify([...gone(), args.appKey]));
    if (args.appKey === 'k-b') { fs.writeFileSync(path.join(dir, 'child-died-at.txt'), 'send of k-b'); process.exit(1); }
    return { success: true, simulated: false, messages: [], affectedApplications: [], deletedModules: [] };
  } } });
const clock = fakeClock();
const deps = { journal: new Journal(path.join(dir, 'receipts')), locate: () => bridge, present: async () => false, running: async () => false, exports: dir, registry: REGISTRY,
  sleep: async () => {}, clock, destructiveRoot: path.join(dir, 'destructive'), backup: async () => ({ files: [] }) };
const preview = await runServiceCenter(['delete', '--prefix=ZZC', '--host=' + PERSONAL], deps);
fs.writeFileSync(path.join(dir, 'preview.json'), JSON.stringify({ token: preview.confirmationToken, operationId: preview.operationId, previewId: preview.previewId }));
clock.advance(CONFIRM_MIN_AGE_MS);
await runServiceCenter(['delete', '--confirmation-token=' + preview.confirmationToken, '--words=sim, apaga os 4 ZZC', '--host=' + PERSONAL], deps);
fs.writeFileSync(path.join(dir, 'child-finished.txt'), 'finished without dying');
