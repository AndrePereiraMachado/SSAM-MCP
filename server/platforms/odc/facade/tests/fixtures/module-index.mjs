// A synthetic module index (ssam-module-index/1) as the C# writer lays it out: rows sorted by key (ordinal),
// parentRow as a row index (or -2 - i for ancestors[i]), roles and types by index, `answers` with every name the node
// answers to.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const TYPES = {
  ESpace: ['IESpace', 'OutSystems.Model.IESpace'], MobileFlow: ['IMobileFlow'], MobileScreen: ['IMobileScreen', 'IWebScreen', 'OutSystems.Model.UI.Mobile.IMobileScreen'],
  ServerAction: ['IServerAction', 'IAction'], InputParameter: ['IInputParameter', 'IParameter'], Expression: ['IExpression'],
  AnonymousStructure: ['IAnonymousStructure'], Attribute: ['IAttribute'], LocalVariable: ['ILocalVariable'],
  Aggregate: ['IAggregate'], AddSourceOperation: ['IAddSourceOperation'], DataTable: ['IObject'],
  // O11 widgets: a widget's children hang from its MobileWidget "content" placeholder, which no Children list holds.
  Container: ['IContainer', 'IMobileWidget', 'IWidget'], MobileWidget: ['IMobileWidget', 'IWidget'], AdvancedHtml: ['IAdvancedHtml', 'IWidget'],
  Input: ['IInput', 'IWidget'], CustomProperty: ['ICustomProperty', 'IObject'],
};
export const ROLE_NAMES = ['module', 'flow', 'screen', 'block', 'action', 'actionRef', 'aggregate', 'entity', 'staticEntity', 'structure',
  'attribute', 'parameter', 'variable', 'widget', 'event', 'flowNode', 'expression', 'reference', 'other'];
export const LONG_NAME = 'Action' + 'X'.repeat(84);
// [key, kind, name, parentKey, role, dataType]
export const NODES = [
  ['R0000000000000000000000', 'ESpace', 'Quotes', null, 'module'],
  ['F1111111111111111111111', 'MobileFlow', 'MainFlow', 'R0000000000000000000000', 'flow'],
  ['S3333333333333333333333', 'MobileScreen', 'QuoteList', 'F1111111111111111111111', 'screen'],
  ['S1111111111111111111111', 'MobileScreen', 'Home', 'F1111111111111111111111', 'screen'],
  ['S2222222222222222222222', 'MobileScreen', 'QuoteForm', 'F1111111111111111111111', 'screen'],
  ['V1111111111111111111111', 'LocalVariable', 'Filter', 'S1111111111111111111111', 'variable', 'Text'],
  ['A1111111111111111111111', 'ServerAction', 'GetQuotes', 'R0000000000000000000000', 'action'],
  ['A2222222222222222222222', 'ServerAction', 'GetQuote', 'R0000000000000000000000', 'action'],
  ['A3333333333333333333333', 'ServerAction', LONG_NAME, 'R0000000000000000000000', 'action'],
  ['P1111111111111111111111', 'InputParameter', 'QuoteId', 'A2222222222222222222222', 'parameter', 'Long Integer'],
  ['P2222222222222222222222', 'InputParameter', 'Page', 'A3333333333333333333333', 'parameter', 'Integer'],
  ['A2222222222222222222222.#Value', 'Expression', '', 'A2222222222222222222222', 'expression'],
  ['N1111111111111111111111', 'AnonymousStructure', '', 'R0000000000000000000000', 'structure'],
  ['N1111111111111111111111.#Name', 'Attribute', 'Name', 'N1111111111111111111111', 'attribute', 'Text'],
];

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function writeCapture(dir, text = 'capture ' + Math.random()) {
  const file = path.join(dir, 'capture-' + sha256(text).slice(0, 8) + '.oml');
  fs.writeFileSync(file, text);
  return { file, sha256: sha256(Buffer.from(text)) };
}
// ancestors: [key, kind, name, parentKey] of elements Parent() reaches that no Children list holds (an aggregate's
// DataTable): parents in paths, never rows.
export function moduleIndex({ lane = 'odc', sourceSha256, nodes = NODES, ancestors = [], overrides = {} }) {
  const sorted = [...nodes].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const kinds = [...new Set([...sorted, ...ancestors].map(n => n[1]))];
  const at = new Map([...sorted.map((n, i) => [n[0], i]), ...ancestors.map((a, i) => [a[0], -2 - i])]);
  const parentRef = parent => parent ? at.get(parent) : -1;
  const rows = sorted.map(([key, kind, name, parent, role, dataType]) => [key, kinds.indexOf(kind), name, null, null, parentRef(parent),
    ROLE_NAMES.indexOf(role), dataType ?? null, sorted.filter(n => n[3] === key).length]);
  const count = field => Object.fromEntries([...new Set(sorted.map(field))].map(v => [v, sorted.filter(n => field(n) === v).length]));
  return { schema: 'ssam-module-index/1', extractor: 1, lane, adapter: lane === 'odc' ? 'builder' : 'kernel', sourceSha256, sourceBytes: 42,
    createdAt: '2026-09-30T00:00:00Z', module: { name: 'Quotes', key: 'R0000000000000000000000', kind: 'ESpace' }, complete: true, readErrors: 0, errorSamples: [],
    counts: { elements: rows.length, byKind: count(n => n[1]), byRole: count(n => n[4]) }, roles: ROLE_NAMES,
    types: kinds.map(kind => ({ kind, answers: TYPES[kind], nameProperty: true })), rows,
    ancestors: ancestors.map(([key, kind, name, parent]) => [key, kinds.indexOf(kind), name, parentRef(parent)]), ...overrides };
}
export function storeFile(root, lane, sourceSha256) {
  return path.join(root, 'v1', lane, sourceSha256 + '.' + (lane === 'odc' ? 'builder' : 'kernel') + '.json');
}
export function writeIndex(root, lane, sourceSha256, index = moduleIndex({ lane, sourceSha256 })) {
  const file = storeFile(root, lane, sourceSha256);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof index === 'string' ? index : JSON.stringify(index));
  return file;
}
