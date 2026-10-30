// Generate the kernel's indexed representation, including native references on call nodes.
// moduleMap resolves these rows with the production resolveElement/usesRich implementation.
import fs from 'node:fs';
import path from 'node:path';
import { writeCapture } from './module-index.mjs';
import { richFile, ROLES, moduleMap } from '../../module-map.mjs';
export function deletionIndex(dir, count = 78, { complete = true } = {}) {
  const capture = writeCapture(dir, 'native deletion index ' + count), env = { ...process.env, SSAM_MODULE_INDEX_ROOT: path.join(dir, 'index') };
  const dependencies = [];
  const nodes = [{ key: 'M', name: 'Sample', kind: 'ESpace', parent: null, refs: [] }];
  for (let i = 0; i < count; i++) {
    const key = 'A' + String(i).padStart(3, '0');
    nodes.push({ key, name: 'Action' + i, kind: 'ServerAction', parent: 'M', refs: [] });
    if (i) {
      const providers = count <= 3 ? [i - 1] : [...new Set([Math.floor((i - 1) / 2), Math.max(0, i - 3)])];
      const refs = providers.map(n => 'A' + String(n).padStart(3, '0'));
      refs.forEach(provider => dependencies.push([key, provider]));
      nodes.push({ key: key + '.call', name: 'Call', kind: 'ExecuteServerActionNode', parent: key, refs });
    }
  }
  if (count > 3) {
    nodes.push({ key: 'S', name: 'Summary', kind: 'MobileScreen', parent: 'M', refs: [] });
    const refs = ['A001', 'A002']; refs.forEach(provider => dependencies.push(['S', provider]));
    nodes.push({ key: 'S.call', name: 'Load', kind: 'ExecuteServerActionNode', parent: 'S', refs });
    nodes.push({ key: 'X', name: 'Outside', kind: 'ServerAction', parent: 'M', refs: ['A000', 'A' + String(count - 1).padStart(3, '0')] });
  }
  nodes.sort((a, b) => a.key.localeCompare(b.key));
  const at = new Map(nodes.map((n, i) => [n.key, i])), kinds = [...new Set(nodes.map(n => n.kind))];
  const rich = { schema: 'ssam-rich-index/1', extractor: 1, lane: 'o11', adapter: 'kernel', sourceSha256: capture.sha256,
    module: { name: 'Sample', key: 'M', kind: 'ESpace' }, complete, readErrors: 0, roles: ROLES, propertyTypes: 'etvra', names: ['Action'], references: [],
    types: kinds.map(kind => ({ kind, answers: ['I' + kind] })),
    rows: nodes.map(n => [n.key, kinds.indexOf(n.kind), n.name, n.parent ? at.get(n.parent) : -1, ROLES.indexOf(n.kind === 'ESpace' ? 'module' : n.kind === 'ServerAction' ? 'action' : n.kind === 'MobileScreen' ? 'screen' : 'flowNode'), [], n.refs.map(key => [at.get(key), 0]), null]) };
  const store = richFile('o11', capture.sha256, env); let reads = 0, calls = 0;
  const map = input => { calls++; return moduleMap({ ...input, target: capture.file }, { env, read: async () => {
    reads++; fs.mkdirSync(path.dirname(store), { recursive: true }); fs.writeFileSync(store, JSON.stringify(rich)); return { rich: { path: store, built: true } };
  } }); };
  return { ...capture, map, dependencies, counts: () => ({ calls, reads }) };
}
