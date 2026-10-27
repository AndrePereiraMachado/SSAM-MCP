// The text route in the work packet (ssam_discover {intent, lane, app, packet:true}; work-packet.mjs, section `text`).
// The owner's re-test of 2026-10-12 (Codex, FolhaPonto_CS): the session started both requests from the packet, which
// carried only the JSON forms of the ops, so it wrote a 6.9 KB spec job and a 23 KB JavaScript builder of a logic job, and
// never the text the module reads and writes (ssam-ddl/1, ssam-flow/1, ssam-html/1). This section makes the packet's FIRST
// answer enough to write the change in its text form, in one round:
//   read      the exact read call (ssam_map view ddl/flow/html over the packet's capture, with its sha256), or the
//             statement that the module has nothing of that kind (or that the change only creates) and the text is
//             written from scratch
//   call      the exact delivery call of the lane (o11_deliver / studio_deliver) with the ops of the text forms, in the
//             order one job takes them (data statements, the user exceptions the texts raise, the screen document, the
//             action texts), the module and the capture's sha256 where an edit needs it
//   forms     per text form: the grammar (one line per construct), the contract slice of the lane index and one compact
//             proven example (text-examples.json, proven by FlowApplyScenarios.ThePacketExamplesApplyInOneJob)
//   rules     the owner's rules for these texts, one line each
// It sizes itself (levels, richest first) and declares the capabilities whose JSON form it replaces (`covers`): the
// packet then keeps those capabilities as a line and their JSON example by reference (work-packet.mjs).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { classifyTextRoute, WIRED } from './text-routes.mjs';
import { traditionalText } from './traditional-text.mjs';
import { ENTITY_ACTIONS_CARD, ENTITY_ACTIONS_OP, offered } from './generators.mjs';

export const TEXT_PACKET_SCHEMA = 'ssam-packet-text/1';
export const TEXT_EXAMPLES_FILE = fileURLToPath(new URL('./text-examples.json', import.meta.url));

const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');

let examplesCache = null;
export function textExamples(file = TEXT_EXAMPLES_FILE) {
  if (file === TEXT_EXAMPLES_FILE && examplesCache) return examplesCache;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  if (file === TEXT_EXAMPLES_FILE) examplesCache = parsed;
  return parsed;
}
const PROVEN_BY = 'kernel/tests/Shared/FlowApplyScenarios.cs ThePacketExamplesApplyInOneJob (O11 and ODC: one job, read back as the text)';

// The form of each route and the pointer of its contract slice in the lane index.
export const FORM_OF = { 'data.ddl': 'ssam-ddl/1', 'logic.flow': 'ssam-flow/1', 'ui.screen-html': 'ssam-html/1', 'ui.screen-html-edit': 'ssam-html/1' };
const POINTER_OF = { 'ssam-ddl/1': 'spec.ddl', 'ssam-flow/1': 'logic.flow', 'ssam-html/1': 'html.document' };
const ORDER = ['ssam-ddl/1', 'ssam-html/1', 'ssam-flow/1'];

// The capabilities whose JSON op a text form writes (their contract and JSON example are redundant beside the text).
const COVERED = {
  'ssam-ddl/1': id => /^data\.(entity|static|structure|client-entity|client-variable|setting)$/.test(id) || id === 'session-variable',
  'ssam-flow/1': id => /^logic\.(flow|server-action|service-action|client-action|screen-action|data-action|aggregate|sql|exception|variable|expression|native-nodes|edit|preparation)$/.test(id),
  'ssam-html/1': id => /^ui\./.test(id) && !/^ui\.(traditional-|script-resource|theme-css|email-popover)/.test(id),
};
export const coveredBy = (forms, id) => forms.find(f => COVERED[f]?.(String(id))) ?? null;

// The grammar of each form, one line per construct (the creation a model writes; the reading adds the ids and keys).
const GRAMMAR = {
  'ssam-ddl/1': lane => [
    '/// <description>   the line(s) before an element: its description, whole',
    'create entity <Name> [public] [label <Attr>] (\n  Id Long Integer identifier auto required,\n  <Attr> <Type> [required] [default <value>] [references <Entity> on delete Protect|Delete|Ignore] [label "<text>"] [json "<name>"],\n  ...\n);',
    'create [unique] index <Name> on <Entity> (<Attr>, ...);',
    'create static entity <Name> [public] (\n  Id Integer identifier required,\n  Label Text(50) required,\n  Order Integer required\n)\nvalues\n  <Record> (Id = 1, Label = "<text>", Order = 1),\n  ...;',
    'type <Structure> [public] = {\n  <Field>: <Type> [required];\n}',
    (lane === 'odc' ? 'setting' : 'site property') + ' <Name>: <Type> [read-only] [secret] = <value>   |   client variable <Name>: <Type> = <value>   |   timer <Name> action <ServerAction> schedule "When Published" timeout <minutes>',
    'types: Text(n), Integer, Long Integer, Decimal(p,s), Boolean, Date, Time, Date Time, Email, Phone Number, Binary Data, <Entity> Identifier, <Entity> | <Structure> [List]; values as OutSystems writes them ("text", True, 0, CurrDateTime())',
    'change or delete: send only the statements that change, as read (every line ends in -- @key), with basedOn; drop entity|static entity|index|type|' + (lane === 'odc' ? 'setting' : 'site property') + '|client variable|timer <Name>; -- @key',
  ],
  'ssam-flow/1': () => [
    '/// <description>\nserver action <Name> [public] [function]   (service action / client action <Name>; action <Screen>.<Name>: screen or block action; data action <Screen>.<Name>); no @key: a new action',
    '  in <Name>[?]: <Type> [= <default>]   ("?": optional)  |  out <Name>: <Type>  |  local <Name>: <Type>',
    '  <Node> = aggregate FROM <A>, <B>, <C> JOIN Inner <A>~<B> ON <condition> | Left <B>~<C> ON <condition> WHERE (<condition>) [AND (<condition>)] [SORT <Entity>.<Attr> desc] MAX <n>   (Inner: Only With; Left: With or Without; Full: With; SQL-style JOIN is normalized when unambiguous; an action pages by SQL OFFSET @Skip ROWS FETCH NEXT @Take ROWS ONLY, never START: LOGIC_START_SERVER_IGNORED)',
    '  <Node> = <Action>(<Param>=<value>, ...)   (an action of another module: <Producer>.<Action>(...); a list action: (System).ListAppend(List=L, Element=E))',
    '  assign <Var> = <value>   |   assign  # <label>\n    <Var> = <value>\n    <Var.Field> = <value>',
    '  if <condition>:  # <question>\n    <true branch, indented>\n  <the false branch continues below>',
    '  foreach <List>:\n    <body, indented>\n    next',
    '  switch:  # <question>\n    case <condition>:\n      <branch>\n    otherwise:\n      <branch>',
    '  raise <Exception>("<message>")   |   end   |   -> <Node>  (a jump to a node written elsewhere)',
    '  <Node> = sql -> <Structure> max <n>\n    in <Param>: <Type> [inline] = <value>\n    | SELECT {Entity}.* FROM {Entity} WHERE ...',
    '  on exception <Exception> [abort] [log]:\n    end   (a handler after the main flow; abort = Abort Transaction and log = Log Error, both optional)',
    '  @{Name="AllExceptions"} under on exception All Exceptions; a named user handler keeps its exception name. ODC multi-source aggregates also print @{MasterSource=&"A"}: an assertion of the derived join root.',
    '  assign <Dest> = <Source> mapTo { <Field>: <value>, ... }   (a record mapping, the value relative to the source record)',
    '  (System).ListAppendAll(List=<Dest>, SourceList=<Source> mapTo { <Field>: <value>, ... })   (whole-list mapping instead of a copy-only For Each; assign <Dest> = <Source> mapTo {...} also works)',
    'every branch ends in end, raise, next or a jump; "# label" before the end of the line; a change of an existing action: read it (ssam_map view flow) and send the text edited, with its @ids and its textSha as basedOn',
  ],
  'ssam-html/1': () => [
    '<screen name="<Screen>" [roles="<Role>"] [actions="<A>, <B>"] [data-actions="<D>"]> ... </screen>   or   <block name="<Block>"> ... </block>',
    '<input name type default/> (screen input), <var name type default/>, <aggregate name from="<Entity>" [join="<Other> on <condition>" (a left join)] [where="<condition>"] [sort="<Entity>.<Attr> desc"] max="50"/>; <event name/> in a block; an <input> or <event> without mandatory is optional, mandatory="True" makes it mandatory',
    'content inside the layout block: <Block name="LayoutTopMenu"><slot name="Title">...</slot><slot name="MainContent">...</slot></Block>',
    'widgets: div, form, a, button, input, textarea, select, switch, label, img, i, upload, popup; <div list="<Source>"> repeats with <Source>.Current; <div if="<condition>"> + <div else>; {{ <expression> }}; os-<Property>="<value>"',
    'events: onclick="<Action>(<Param> = <expression>)"; each screen action named in actions="..." is declared by a flow text "action <Screen>.<Name>" in a logic op after the html op',
  ],
};

// The rule that steers a new screen to the gen-screen generator (text.standard); in the rules only while gen-screen is
// approved (generators.mjs offered), like text.standard and text.generate: a pending generator leaves the text section as it
// was before it existed.
const STANDARD_SCREENS_RULE = 'Standard list/detail/form screens of entities are generated, never written: {"op":"screen","data":{"generate":{"entities":["<Entity>"]}}} (standard below); write a document only for what no standard screen is.';
const rulesOf = form => (RULES[form] ?? []).filter(rule => rule !== STANDARD_SCREENS_RULE || offered('gen-screen'));

// The owner's rules for each form, one line each (the blockers of the 12/10 conference and the padrões rules they apply).
const RULES = {
  'ssam-ddl/1': [
    'N1/N2: a name and a /// description on every entity, attribute, structure and property: why it exists, not its name again.',
    'A new statement has no -- @key; it references entities of this job or of the module by name (<Entity> Identifier ... references <Entity>).',
    'The same -- @key with another name is a rename, never drop and create; an attribute or record left out of a statement sent whole is deleted.',
    'L7: configuration in site properties (settings), fixed domains in static entities, never values written in the logic.',
  ],
  'ssam-flow/1': [
    'N1: actions are verb + object, booleans Is/Has/Can; a /// description on every action; a # label on every if, assign and switch.',
    'QUERY_IN_LOOP (refused): no aggregate or SQL inside a foreach; one query with join before the loop and ListFilter/ListIndexOf inside it.',
    'T1/T2 (refused with the patch): a foreach that only filters, maps or accumulates is a List action (ListFilter, ListAppendAll + mapTo).',
    'L3/L5/L6: at most one If per value in an assign; no JavaScript for logic; no JSONSerialize/JSONDeserialize to pass data inside the app.',
    'A user exception the texts raise is created in the same job, before the logic op: {"op":"create","parent":"@espace","type":"IUserException","name":"<Exception>"}.',
  ],
  'ssam-html/1': [
    STANDARD_SCREENS_RULE,
    'U1: a condition is <div if>/<div else>, never os-Visible; a new Visible, script or foreign iteration (v-for...) is refused with the patch.',
    'D1/D2: data by <aggregate> or a data action (filter, sort, join and max in the aggregate), never JavaScript or JSON.',
    'Reuse the app\'s blocks and the OutSystems UI classes first; a table first, no ornament (no card or icon tiles unless asked).',
    'Several screens: one html op per screen in the same job; navigation between them resolves by name.',
    'Style the runtime box, not the bare tag (api --op html: document.runtime); a visual warning brings its checked patch.',
  ],
  common: [
    'One delivery: a refusal comes ONCE with every problem of every text and the checked patch; apply it as it is (patch + basedOn), never the whole job again.',
    'Publish only with the person\'s own words: publish:true and authorize in the same call, or the publish tool afterwards.',
  ],
};

// What the capture holds of the kind a form writes (from its module digest).
function holds(found) {
  const d = found?.ok !== false ? found?.digest : null;
  if (!d) return null;
  const S = Object.fromEntries((d.sections ?? []).map(s => [s.id, s]));
  const count = id => (S[id]?.blocks ?? []).length;
  // Data: entities, static entities and structures (a new module has the template's site properties TenantId and TenantName).
  return { data: count('entities') + count('structures'), actions: (d.actions ?? []).length, screens: count('ui'), name: d.module?.name ?? null, kind: d.module?.kind ?? null };
}
const CREATING = new Set(['create', 'add']);
// The element the intent names exactly in the module, of the kind a form reads (an action for flow, an entity or structure
// for ddl, a screen or block for html), for the read call.
function namedElement(found, intent, form) {
  const d = found?.digest; if (!d) return null;
  const words = new Set(String(intent ?? '').split(/[^A-Za-z0-9_]+/).filter(w => w.length >= 3).map(w => w.toLowerCase()));
  const S = Object.fromEntries((d.sections ?? []).map(s => [s.id, s]));
  const names = form === 'ssam-flow/1' ? (d.actions ?? []).map(a => a.name)
    : form === 'ssam-ddl/1' ? [...(S.entities?.blocks ?? []), ...(S.structures?.blocks ?? []), ...(S.variables?.blocks ?? [])].map(b => b.name)
      : (S.ui?.blocks ?? []).map(b => b.name);
  return names.filter(n => words.has(String(n).toLowerCase()));
}

function readOf(form, { lane, found, intent, creating, has, readings = [] }) {
  const target = found?.ok !== false && found?.file ? found.file : '<Module or capture.oml>';
  const sha = found?.ok !== false && found?.sourceSha256 ? { expectedSourceSha256: found.sourceSha256 } : {};
  const view = form === 'ssam-ddl/1' ? 'ddl' : form === 'ssam-flow/1' ? 'flow' : 'html';
  const named = namedElement(found, intent, form) ?? [];
  const element = named.length ? (form === 'ssam-html/1' ? { screen: named[0] } : { element: named.length === 1 || form !== 'ssam-flow/1' ? named[0] : named.slice(0, 50) })
    : form === 'ssam-html/1' ? { screen: '<Screen>' } : form === 'ssam-flow/1' ? { element: '<Action> or a list of them' } : {};
  const call = { tool: 'ssam_map', arguments: { lane, target, view, ...element, ...sha } };
  const what = { 'ssam-ddl/1': 'entities, static entities or structures', 'ssam-flow/1': 'actions', 'ssam-html/1': 'screens or blocks' }[form];
  const count = { 'ssam-ddl/1': has?.data, 'ssam-flow/1': has?.actions, 'ssam-html/1': has?.screens }[form];
  if (creating && has && count === 0)
    return { read: null, why: (has.name ?? 'the module') + ' has no ' + what + ': write the text from scratch, no read, no @key and no basedOn' };
  const kind = form === 'ssam-flow/1' ? 'flow' : form === 'ssam-html/1' ? 'html' : null;
  if (kind === 'html' && readings.some(r => r.kind === 'html')) return { read: null, why: 'read with this packet: scope.owner holds the screen with its k (when it fits; else needsReading gives the read) and call holds its basedOn', toChange: call };
  if (creating) return { read: null, why: 'a creation needs no read: a text without @key is new; scope names what the texts can reference', toChange: call };
  if (kind && readings.some(r => r.kind === kind)) return { read: null, why: 'read with this packet: scope.owner holds the text (when it fits; else needsReading gives the read) and call holds its basedOn', toChange: call };
  return { read: call, why: 'read once, edit in context: the text with an @key or @id on every element and the basedOn of the delivery' };
}

// The op of a form in the delivery call, as a creation writes it or as an edit of the read does. R4 (2026-10-24, the lab:
// the capture sha256 was sent where the flow's textSha goes): with the readings of the owner (module-map.mjs ownerReadings)
// every basedOn is the value itself, in its place; without them the placeholder says which value and of which read.
export const FLOW_BASED_ON = '<action.textSha of ssam_map view flow: 16 hex, never the capture sourceSha256>';
export const HTML_BASED_ON = '<htmlSha256 of ssam_map view html>';
function opOf(form, { creating, found, readings = [] }) {
  const sha = found?.ok !== false && found?.sourceSha256 ? found.sourceSha256 : '<sourceSha256 of the read>';
  if (form === 'ssam-ddl/1') return { op: 'spec', data: creating ? { ddl: '<the new statements, without -- @key>' } : { basedOn: sha, ddl: '<only the statements that change, as read, with their -- @key; new ones without a key>' } };
  const flows = readings.filter(r => r.kind === 'flow');
  if (form === 'ssam-flow/1') return { op: 'logic', data: { flow: creating ? ['<one ssam-flow/1 text per action, its header without @key>']
    : flows.length ? flows.map(r => ({ text: '<scope.owner text of ' + r.name + ', edited, every line with its @id>', basedOn: r.textSha }))
      : [{ text: '<the text read, edited, with its @ids>', basedOn: FLOW_BASED_ON }] } };
  // An existing screen read with the packet is edited by k, even when the rest of the change creates (a new attribute shown).
  const html = readings.find(r => r.kind === 'html');
  return creating && !html ? { op: 'html', data: { html: '<screen name="<Screen>">...</screen>' } }
    : { op: 'html', data: { screen: html?.screen ?? '<Screen>', basedOn: html?.basedOn ?? { capture: sha, html: HTML_BASED_ON }, edit: ['<the changed element, whole, with its k (scope.owner.widgets)>'] } };
}

/**
 * The packet's text section for an intent, or null when the intent names no text route.
 * input: {lane, intent, found (the packet's module digest answer, or null), slice (pointer -> contract node of the lane
 * index), route (classifyTextRoute's answer, computed when absent)}.
 * Returns {value, covers (forms), levels (smaller forms of value, richest first)}.
 */
export function packetTextSection({ lane, intent, found = null, readings = [], slice = () => undefined, route = classifyTextRoute(intent), examples = textExamples(), kinds = null } = {}) {
  const traditional = traditionalText({ lane, intent, found, route, wired: WIRED['ui.screen-html'], kinds });
  if (traditional !== undefined) return traditional;
  if (!route) return null;
  const primary = FORM_OF[route.id];
  if (!primary || WIRED[route.id] !== true) return null;
  // A screen document is written whole (a creation); the other forms create with the verbs that create.
  const creating = route.id === 'ui.screen-html' || CREATING.has(route.verb) || route.verb == null;
  // New actions carry their data (structures, site properties, the entities they read): the data text rides along, as the
  // owner's actions of 2026-10-12 needed (3 structures and 2 site properties beside 9 actions, in one job).
  const companions = route.id === 'logic.flow' && creating ? ['data.ddl'] : [];
  const forms = [...new Set([primary, ...[...(route.also ?? []), ...companions].map(id => FORM_OF[id]).filter(Boolean)])].filter(f => WIRED[Object.keys(FORM_OF).find(k => FORM_OF[k] === f)] !== false)
    .sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  const has = holds(found);
  const name = has?.name ?? '<Module>';
  // Each form of the job: its read, grammar, contract slice, example and rules.
  const parts = {};
  const ops = [];
  const editing = [];
  for (const form of forms) {
    const own = form === primary;
    // A companion form is a creation (the data the actions carry), except the edit of an existing screen the change shows
    // something in (route.also ui.screen-html-edit).
    const make = own ? creating : !(form === 'ssam-html/1' && (route.also ?? []).includes('ui.screen-html-edit'));
    if (!make) editing.push(form);
    const { read, why, toChange } = readOf(form, { lane, found, intent, creating: make, has, readings });
    const ex = examples?.examples?.[form] ?? null;
    const exampleText = ex ? (ex[lane] ?? ex.text ?? null) : null;
    const node = slice(POINTER_OF[form]);
    parts[form] = {
      read, readWhy: why, ...(toChange ? { readToChange: toChange } : {}),
      grammar: GRAMMAR[form](lane),
      ...(node != null ? { contract: { pointer: POINTER_OF[form], card: node } } : {}),
      ...(exampleText ? { example: { text: exampleText, ...(ex.exceptions?.length ? { exceptions: ex.exceptions } : {}), ...(ex.actions?.length ? { actions: ex.actions } : {}), provenBy: PROVEN_BY } } : {}),
      rules: rulesOf(form),
    };
    if (form === 'ssam-flow/1' && make) ops.push({ op: 'create', parent: '@espace', type: 'IUserException', name: '<each user exception the texts raise and the module lacks>' });
    ops.push(opOf(form, { creating: make, found, readings }));
  }
  // Data statements first, then the exceptions, the screen document and the action texts (one job takes them in order).
  const rank = op => (op.op === 'spec' ? 0 : op.op === 'create' ? 1 : op.op === 'html' ? 2 : 3);
  ops.sort((a, b) => rank(a) - rank(b));
  const job = { ops };
  const call = lane === 'o11'
    ? { tool: 'o11_deliver', arguments: { module: name, job, authorize: '<the user\'s own words, or none with a standing grant>' } }
    : { tool: 'studio_deliver', arguments: { feature: '<Feature>', module: name, job, owners: ['<Owner>'], changes: ['<Change>'] } };
  // gen-screen/1: new screens of the standard kinds (list, detail, form of an entity) are one op, generated from the module.
  const standard = primary === 'ssam-html/1' && creating && offered('gen-screen') ? {
    use: 'the list, detail and form screens of entities (table with paging, search, filters, sort and states; detail table; typed form; delete with confirmation; the module\'s blocks): generated, nothing to write',
    call: lane === 'o11'
      ? { tool: 'o11_deliver', arguments: { module: name, job: { ops: [{ op: 'screen', data: { generate: { entities: ['<Entity>', '<Entity2>'] } } }] }, authorize: '<the user\'s own words, or none with a standing grant>' } }
      : { tool: 'studio_deliver', arguments: { feature: '<Feature>', module: name, job: { ops: [{ op: 'screen', data: { generate: { entities: ['<Entity>', '<Entity2>'] } } }] }, owners: ['<Owner>'], changes: ['<Change>'] } },
  } : null;
  const value = {
    schema: TEXT_PACKET_SCHEMA, id: route.id, forms, creating, ...(creating && editing.length ? { editing } : {}),
    use: 'Write this change in its text form' + (forms.length > 1 ? 's' : '') + ' (' + forms.join(' + ') + '): every op of call goes into the ONE job of next.deliver, the JSON ops only for what no text covers; '
      + (creating ? 'a creation needs no read' : 'read once, then deliver'),
    ...(standard ? { standard } : {}),
    call,
    ...Object.fromEntries(forms.map(f => [f, parts[f]])),
    // New actions: the standard ones of the entities are generated (op entity-actions, first in the job), never written.
    ...(primary === 'ssam-flow/1' && creating && offered('entity-actions') ? { generate: { op: ENTITY_ACTIONS_OP, card: ENTITY_ACTIONS_CARD } } : {}),
    rules: RULES.common,
    why: route.why,
  };
  // Levels from the richest down: whole; without the contract slices (their pointers stay); without the grammar of the
  // companion forms; the call, the reads and the examples alone.
  const strip = (v, fn) => { const out = structuredClone(v); for (const f of forms) fn(out[f], f); return out; };
  const levels = [
    value,
    strip(value, p => { if (p.contract) p.contract = { pointer: p.contract.pointer, expand: `ssam_discover {lane:"${lane}", expand:"contract:${p.contract.pointer}"}` }; }),
    strip(value, (p, f) => { if (p.contract) p.contract = { pointer: p.contract.pointer }; if (f !== primary) delete p.grammar; }),
    strip(value, p => { delete p.contract; delete p.grammar; delete p.rules; }),
  ];
  // Each level smaller than the one before (a short contract card is smaller than its expansion: that level goes).
  const kept = levels.filter((l, i) => i === 0 || bytes(l) < Math.min(...levels.slice(0, i).map(bytes)));
  return { value, levels: kept, covers: forms };
}
export const textLevelBytes = levels => levels.map(bytes);
