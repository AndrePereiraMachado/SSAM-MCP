// node folhaponto-bind.gen.mjs <this folder>  (rewrites folhaponto-bind.capture.json and its bundle; review the diff)
// Generates the FolhaPonto data.bind fixture capture (kernel/tests/Anvil.Tests/Fixtures/prototype/folhaponto-bind.capture.json):
// the two views of V1 (Bater, Espelho) and the DaySheet popup as the JSX capture of lane A is expected to deliver them
// (docs/PROTOTIPO-NATIVO.md 2.10), with the canonical rendering of each state in trees. The inline styles are V1's.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const out = process.argv[2];
const sha = s => createHash('sha256').update(s).digest('hex');
const css = 'html,body{margin:0;padding:0}\nbody{font-family:-apple-system,system-ui,sans-serif;background:#FAFAF6}\n';
const sheetSha = sha(css);
fs.mkdirSync(path.join(out, 'folhaponto-bind.bundle', 'sheets'), { recursive: true });
fs.writeFileSync(path.join(out, 'folhaponto-bind.bundle', 'sheets', sheetSha + '.css'), css);

// a node spec: [tag, style|null, children, extra] or a text
const T = (x, field) => ({ text: x, field });
const E = (tag, style, children = [], extra = {}) => ({ tag, style, children, extra });

// builds the capture node (template form when list specs are given) and the rendered node
function build(spec, k, mode) {
  if (spec.text !== undefined) {
    const n = { k, x: spec.text };
    if (mode === 'template' && spec.field) n.expr = { fmt: 'text', value: { field: spec.field }, prefix: '', suffix: '', locale: null };
    return n;
  }
  const n = { k, t: spec.tag, a: [] };
  if (spec.style) n.a.push(['style', spec.style]);
  for (const [name, value] of spec.extra.attrs ?? []) n.a.push([name, value]);
  if (spec.extra.events && mode === 'template') n.events = spec.extra.events;
  if (spec.extra.list) {
    const { rows, row, collection } = spec.extra.list;
    if (mode === 'template') {
      n.list = { collection, mode: 'self', items: rows.length, filter: null, sort: [], sortBy: null, snapshot: null, key: null, template: build(row(rows[0], true), k + '/*', 'template') };
      n.c = [];
    } else n.c = rows.map((r, i) => build(row(r, false), k + '/' + i, 'render'));
    return n;
  }
  n.c = spec.children.map((c, i) => build(c, k + '/' + i, mode));
  return n;
}

const ink = 'rgb(15, 26, 20)', ink3 = 'rgb(123, 133, 126)';
const schedule = [['in', 'Entrada', 540, '08:58', true], ['lunch', 'Saída almoço', 720, '12:00', false], ['back', 'Retorno', 780, '13:00', false], ['out', 'Saída', 1080, '18:00', false]];
const tabs = (view, active) => E('div', 'position: absolute; left: 16px; right: 16px; bottom: 18px; display: flex; gap: 6px;', [
  E('button', `flex: 1 1 0%; border-radius: 18px; background: ${active === 'bater' ? 'rgb(31, 181, 122)' : 'transparent'};`, [T('Bater')], { events: [`${view}:click:tab-bater`] }),
  E('button', `flex: 1 1 0%; border-radius: 18px; background: ${active === 'espelho' ? 'rgb(31, 181, 122)' : 'transparent'};`, [T('Espelho')], { events: [`${view}:click:tab-espelho`] }),
]);
const bater = E('div', 'width: 402px; height: 874px; background: rgb(250, 250, 246); position: relative;', [
  E('div', 'padding: 8px 24px 0px;', [E('div', `font-size: 14px; color: ${ink3};`, [T('Bom dia,')]), E('div', 'font-size: 24px; font-weight: 600;', [T('Carla')])]),
  E('div', 'margin: 18px 16px 0px; border-radius: 28px; color: rgb(255, 255, 255);', [E('div', 'font-size: 12px; text-transform: uppercase;', [T('Trabalhando há')]), E('div', 'font-size: 86px; font-weight: 300;', [T('02:49')])]),
  E('div', 'padding: 14px 16px 0px;', [E('button', 'width: 100%; border-radius: 24px; background: rgb(255, 210, 63);', [
    E('div', 'font-size: 12px; text-transform: uppercase;', [T('Bater ponto')]), E('div', 'font-size: 24px; font-weight: 700;', [T('Saída almoço')]), E('div', 'font-size: 13px;', [T('previsto 12:00')])], { events: ['bater:click:cta'] })]),
  E('div', 'padding: 22px 28px 0px;', [E('div', 'font-size: 11px; text-transform: uppercase;', [T('Hoje · qui, 7 mai')]),
    E('div', 'display: flex; flex-direction: column;', [], { list: { collection: 'Etapas', rows: schedule, row: ([, label, , time, done], tpl) => E('div', 'display: flex; align-items: center; gap: 14px; padding: 12px 0px;', [
      E('div', `width: 10px; height: 10px; border-radius: 50%; background: ${done ? 'rgb(31, 181, 122)' : 'transparent'};`),
      E('div', `flex: 1 1 0%; font-size: 15px; color: ${done ? ink : ink3};`, [T(label, 'Label')]),
      E('div', 'font-size: 16px; font-weight: 700;', [T(time, 'Hora')])]) } })]),
  tabs('bater', 'bater'),
]);
const days = [[1, 'extra'], [2, 'weekend'], [3, 'weekend'], [4, 'ok'], [5, 'extra'], [6, 'extra'], [7, 'today']];
const espelho = E('div', 'width: 402px; height: 874px; background: rgb(250, 250, 246); position: relative;', [
  E('div', 'padding: 8px 24px 0px;', [E('div', `font-size: 14px; color: ${ink3};`, [T('Espelho')]), E('div', 'font-size: 24px; font-weight: 600;', [T('Maio 2026')])]),
  E('div', 'margin: 16px 16px 0px; display: grid; grid-template-columns: 1fr 1fr;', [
    E('div', 'background: rgb(31, 181, 122); padding: 18px;', [E('div', 'font-size: 11px; text-transform: uppercase;', [T('Trabalhadas')]), E('div', 'font-size: 30px; font-weight: 600;', [T('38:00')]), E('div', 'font-size: 11.5px;', [T('de 176:00')])]),
    E('div', 'background: rgb(255, 210, 63); padding: 18px;', [E('div', 'font-size: 11px; text-transform: uppercase;', [T('Saldo')]), E('div', 'font-size: 30px; font-weight: 700;', [T('+06:30')]), E('div', 'font-size: 11.5px;', [T('3 dias extras')])]),
  ]),
  E('div', 'padding: 12px 24px 0px;', [E('button', 'border-radius: 16px; padding: 10px 14px;', [T('Exportar PDF')], { events: ['espelho:click:pdf'] })]),
  E('div', 'padding: 22px 24px 0px; display: grid; grid-template-columns: repeat(7, 1fr);', [], { list: { collection: 'Dias', rows: days, row: ([d, st]) =>
    E('button', 'aspect-ratio: 1 / 1; border: medium; background: transparent;', [E('div', `width: 30px; height: 30px; font-size: 14px; color: ${st === 'weekend' ? ink3 : ink};`, [T(String(d), 'Dia')])],
      { events: ['espelho:click:dia'], attrs: [['data-dia', String(d)]] }) } }),
  tabs('espelho', 'espelho'),
]);
const sheet = E('div', 'position: absolute; inset: 0px; background: rgba(15, 26, 20, 0.45);', [E('div', 'position: absolute; left: 0px; right: 0px; bottom: 0px; background: rgb(250, 250, 246); padding: 14px 24px 30px;', [
  E('div', `font-size: 13px; color: ${ink3};`, [T('sex, 5 de maio')]),
  E('div', 'margin-top: 18px;', [], { list: { collection: 'Batidas', rows: [['Entrada', '08:55'], ['Saída almoço', '12:00'], ['Retorno', '13:00'], ['Saída', '20:00']], row: ([l, t]) =>
    E('div', 'display: flex; gap: 14px; padding: 12px 0px;', [E('div', 'flex: 1 1 0%; font-size: 15px;', [T(l, 'Label')]), E('span', 'font-size: 16px; font-weight: 700;', [T(t, 'Hora')])]) } }),
  E('button', 'margin-top: 18px; width: 100%; border-radius: 16px;', [T('Fechar')], { events: ['day-sheet:click:fechar'] }),
])], { attrs: [['role', 'dialog']] });

const views = [
  { key: 'bater', route: '#bater', template: 'bater', params: [], name: 'Bater', nameSource: 'text', default: true, keepRoot: true, state: {}, root: build(bater, 'v:bater', 'template'), elements: 30 },
  { key: 'espelho', route: '#espelho', template: 'espelho', params: [], name: 'Espelho', nameSource: 'text', default: false, keepRoot: true, state: {}, root: build(espelho, 'v:espelho', 'template'), elements: 30 },
];
const modals = [{ key: 'day-sheet', name: 'DaySheet', container: { tag: 'div', attrs: [['role', 'dialog']], class: null }, openedFrom: [{ view: 'espelho', event: 'espelho:click:dia' }],
  params: [{ name: 'Dia', from: 'data-dia', type: 'Integer' }], root: build(sheet, 'm:day-sheet', 'template'), elements: 12 }];
// each state as the capture renders it: the body, the view's mount (and the open popup) inside it
const body = (...c) => ({ k: 'b', t: 'body', a: [], c });
const te = body(build(espelho, 'v:espelho', 'render')); const ts = body(build(espelho, 'v:espelho', 'render'), build(sheet, 'm:day-sheet', 'render'));
const trees = { tb: body(build(bater, 'v:bater', 'render')), te, ts };
const ev = (key, view, effects = [], extra = {}) => ({ key, view, on: 'click', selector: 'button', params: [], effects, when: null, handler: 'v1-app.jsx:1', compiled: effects.length > 0, ...extra });
const ir = {
  schema: 'ssam-prototype-capture/1', clock: '2026-05-07T11:47:00Z', tz: 'UTC', engine: { name: 'jsdom', version: '30.1.1', node: 'fixture' },
  source: { root: 'C:\\fixture\\folhaponto', entry: 'Folha de Ponto.html', files: [], vendor: [] },
  kind: 'spa-hash', app: { prefix: 'FolhaPonto', title: 'Folha de Ponto · V1', lang: 'pt-BR' },
  document: { html: [['lang', 'pt-BR']], body: [], meta: [] },
  css: { sheets: [{ path: 'styles.css', bundle: `folhaponto-bind.bundle/sheets/${sheetSha}.css`, order: 0, origin: 'file', page: null, bytes: Buffer.byteLength(css), sha256: sheetSha, rules: 2, imports: [], urls: [] }] },
  assets: [], icons: { library: null, defaultStrokeWidth: 2, tag: 'span', set: {} }, dimensions: [],
  store: { source: 'mapping:window.SCHEDULE', collections: [
    { name: 'Etapas', key: 'Id', mutated: false, references: [], fields: [{ name: 'Id', type: 'Text', length: 50 }, { name: 'Label', type: 'Text', length: 50 }, { name: 'Plan', type: 'Integer' }, { name: 'Hora', type: 'Text', length: 50 }],
      rows: schedule.map(([id, label, plan, hora]) => ({ Id: id, Label: label, Plan: plan, Hora: hora })) },
    { name: 'Dias', key: 'Dia', mutated: false, references: [], fields: [{ name: 'Dia', type: 'Integer' }, { name: 'Status', type: 'Text', length: 50 }], rows: days.map(([d, s]) => ({ Dia: d, Status: s })) },
    { name: 'Batidas', key: 'Label', mutated: false, references: [], fields: [{ name: 'Label', type: 'Text', length: 50 }, { name: 'Hora', type: 'Text', length: 50 }],
      rows: [['Entrada', '08:55'], ['Saída almoço', '12:00'], ['Retorno', '13:00'], ['Saída', '20:00']].map(([l, h]) => ({ Label: l, Hora: h })) },
  ] },
  shell: null, views, modals,
  events: [
    ev('bater:click:cta', 'bater'), ev('bater:click:tab-bater', 'bater'), ev('bater:click:tab-espelho', 'bater'),
    ev('espelho:click:tab-bater', 'espelho'), ev('espelho:click:tab-espelho', 'espelho'), ev('espelho:click:pdf', 'espelho'),
    ev('espelho:click:dia', 'espelho', [{ kind: 'openPopup', modal: 'day-sheet', inputs: { Dia: { param: 'Dia' } } }], { params: [{ name: 'Dia', from: 'data-dia', type: 'Integer' }] }),
    ev('day-sheet:click:fechar', null, [{ kind: 'closePopup', modal: 'day-sheet' }], { modal: 'day-sheet', view: undefined }),
  ],
  explored: [{ id: 'v:bater@canonical', view: 'bater', assign: {}, tree: 'tb' }, { id: 'v:espelho@canonical', view: 'espelho', assign: {}, tree: 'te' },
    { id: 'm:day-sheet@canonical', view: 'espelho', modal: 'day-sheet', assign: {}, tree: 'ts' }],
  trees, problems: [], warnings: [], outOfScope: [{ what: 'setInterval', where: 'v1-app.jsx:20', why: 'sem timer de cliente nativo sem JS' }], targetGuarded: [],
  stats: { elements: 72, views: 2, modals: 1, icons: 0, iconInstances: 0, events: 8, probes: 0 }, timings: {},
};
fs.writeFileSync(path.join(out, 'folhaponto-bind.capture.json'), JSON.stringify(ir, null, 1));
console.log('written', path.join(out, 'folhaponto-bind.capture.json'));
