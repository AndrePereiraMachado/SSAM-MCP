// Generators (2026-10-13): one job op writes a whole family of elements, deterministically, for any domain; the model writes
// the data (URLs, the entities), never the code. ONE mechanism names them in the work packet of ssam_discover: generatorFor
// (the generator an intent asks for) gives next.generator (its card, its why) and next.deliver (its op as the job), the
// same way for each one:
// - rest-consume: kernel/src/Anvil.Core/Kernel/RestConsume.cs (contract: ssam_reference {kind:"api", query:{op:"rest-consume"}});
//   also in ssam_code grammar (generators) and in the catalog (integration.rest-consume);
// - entity-actions: the standard actions of the data model (contract: ssam_reference {kind:"api", query:{op:"entity-actions"}});
//   also in ssam_code grammar (generate) and in the text section of a packet that creates actions (text.generate);
// - gen-screen: the op screen with data.generate (kernel ScreenGenerator), the standard list/detail/form screens of entities;
//   in ssam_code grammar (standardScreens) and in the text section of a packet that creates a screen (text.standard).

// ---- approval: the gate of every generator (owner rule 2026-10-13: "a generator only enters if it passes an independent
// BLIND TEST"; 21:10: discover never offers a generator that is not approved, the op called by name still works, and an
// approved generator is offered again). This table is the ONE place where a generator's state is declared, and every offer
// reads it through offered(id): the work packet (next.generator, next.deliver), the text section (text.generate,
// text.standard and the rules that steer to them), the ssam_code grammar (generate, generators, standardScreens and their
// rules) and the catalog composition (catalog.mjs composeCatalog: a fragment entry with "generator": "<id>" leaves the
// composition, or answers with its "withoutGenerator" fields, the text it had before the generator). A pending generator
// answers exactly as before it existed; its op stays callable explicitly (ssam_job, o11_job, o11_deliver, studio_deliver,
// ssam_code write with the op) and ssam_discover asked about it BY NAME describes it with its state (describeGenerator).
// The text an app session reads (AGENTS.md, the served guides) names only approved generators (tests/generators.test.mjs).
// To approve one: state "approved", the reason and the path of the blind test's verdict (and, for entity-actions, its
// AGENTS.md line of c8ca0579 back). States: GENERATOR_STATES.
export const GENERATOR_STATES = Object.freeze(['approved', 'blind-test-pending']);
export const GENERATOR_APPROVAL = Object.freeze({
  'entity-actions': Object.freeze({ op: 'entity-actions', names: Object.freeze(['entity-actions', 'gen-entity']), state: 'blind-test-pending',
    reason: 'failed two independent blind tests (c8ca0579, then ba0afb3d); this release carries c8ca0579/d2b3e085',
    report: 'C:\\t\\prova-gen-entity-2\\VEREDITO.md' }),
  'rest-consume': Object.freeze({ op: 'rest-consume', names: Object.freeze(['rest-consume', 'gen-rest']), state: 'blind-test-pending',
    reason: 'no independent blind test yet (only the author\'s report)',
    report: 'docs/integracoes-rest-soap.md' }),
  'gen-screen': Object.freeze({ op: 'screen', with: 'data.generate', names: Object.freeze(['gen-screen', 'data.generate']), state: 'blind-test-pending',
    reason: 'no independent blind test yet (only the author\'s report)',
    report: 'docs/SSAM-HTML.md' }),
});
let approvalOverride = null;
/** The declared approval of a generator ({op, names, state, reason, report}), or null for an unknown id. */
export function generatorApproval(id) { return (approvalOverride ?? GENERATOR_APPROVAL)[id] ?? null; }
/** Whether discover, the work packet, the text section, the grammar and the catalog may offer the generator. */
export function offered(id) { return generatorApproval(id)?.state === 'approved'; }
/** The generators' states as one line each (a part of the discovery index identity: another state is another index). */
export function approvalIdentity() {
  const table = approvalOverride ?? GENERATOR_APPROVAL;
  return Object.keys(table).sort().map(id => id + '=' + table[id].state).join(';');
}
/** Tests only: run fn with other states ({id: {state}} merged over the table), restored after, even on a throw. */
export async function withGeneratorStates(states, fn) {
  const before = approvalOverride;
  approvalOverride = Object.fromEntries(Object.entries(GENERATOR_APPROVAL).map(([id, a]) => [id, { ...a, ...(states[id] ?? {}) }]));
  try { return await fn(); } finally { approvalOverride = before; }
}

// The standard actions of a data model are generated from the module, never written by hand (owner decision 2026-10-13: the
// release gate spent 70-82% of its time writing them): the kernel op entity-actions in ops, before the texts of the
// business actions, in the same write. Three lines a model reads once; the contract is api --op entity-actions.
export const ENTITY_ACTIONS_OP = { op: 'entity-actions', data: { entities: 'all', owner: { attribute: '<User Identifier attribute, or leave owner out>' }, expose: { server: true, service: true } } };
export const ENTITY_ACTIONS_CARD = [
  'ops: [' + JSON.stringify(ENTITY_ACTIONS_OP) + ']  (entities: "all" or [names]; actions, list {filters, sort, paging, pageSize, joins, search}, softDelete, validations, errors, names, language: en|pt)',
  'writes, per server entity, Get<E>List (joins to its references, filters, search, sort, Max Records/Start Index paging), Get<E>ById, Save<E> (required, lengths, references, unique keys, owner, typed errors) and Remove<E> (owner, records that still reference it), plus a service action each; an action of the same name is never overwritten (kept)',
  'write by hand ONLY the business actions (logic texts in the same write, after it; they may call the generated ones: Get<E>ById(Id) -> <E>Record, Save<E>(<E>Record) -> Id, Remove<E>(Id), Get<E>List(...) -> List, TotalCount); contract and signatures: ssam_reference {kind:"api", query:{op:"entity-actions"}}',
];
export function entityActionsCall(lane = 'odc') {
  return { tool: 'ssam_code', arguments: { lane, action: 'write', module: '<Module>', ops: [ENTITY_ACTIONS_OP], part: 'logic', text: ['<only the business action texts, if any>'] } };
}

export const REST_CONSUME_EXAMPLE = Object.freeze({ op: 'rest-consume', data: { name: 'BrasilApi', methods: [
  { name: 'Feriados', url: 'https://brasilapi.com.br/api/feriados/v1/{ano=2026}' },
  { name: 'Cep', url: 'https://brasilapi.com.br/api/cep/v1/{cep=01001000}' }] } });

export const GENERATORS = Object.freeze([{
  op: 'rest-consume',
  matches: intent => consumesRest(intent),
  why: 'a generator writes all of this in one op (client, structures, public structures, mapping, service actions, exception): write only the URLs, never these elements by hand',
  when: 'consume any REST/JSON API (one op per host): it writes the REST client and methods, the response structures, a public structure per resource, '
    + 'the mapping and a public service action per method, Verb+Client+Object (GetBrasilApiFeriados), that raises <Client>Error, logged, on any failure (one that changes data checks the signed-in user first). Write only the URLs.',
  // The card: three lines a model copies.
  example: [
    '{"op":"rest-consume","data":{"name":"BrasilApi","methods":[',
    '  {"name":"Feriados","url":"https://brasilapi.com.br/api/feriados/v1/{ano=2026}"},',
    '  {"name":"Cep","url":"https://brasilapi.com.br/api/cep/v1/{cep=01001000}"}]}}'].join('\n'),
  rules: [
    'url: absolute (the common part of the urls is the client\'s base) or relative to baseUrl; {p=example} is a path input; ?k=v an optional query input with default v, ?k={p} a mandatory one',
    'no sample: the delivery GETs each GET url once (10 s, 2 MB, no credentials) and types everything from the answer; offline, give "sample": <the JSON response>; POST/PUT/PATCH: "verb" and "request": <the JSON body>',
    'optional: resource (the public structure name), action (the action name), params {p: type}, timeout, errors {exception}, expose {serviceActions:false} (public server actions), expose:false (client only)',
    'idempotent: the same op again changes nothing; a changed sample updates in place (same keys); the receipt lists every element and each action\'s signature: no read back',
    'authenticated API: auth {type: bearer|basic|apiKey (in, name)|oauth2 (tokenUrl, scope)}, never a credential in the op: the generator creates the empty secret site properties/settings '
      + '(basic on O11: user and password, encoded at runtime by BinaryData, whose reference the delivery adds), '
      + 'OnBeforeRequest sends them and the receipt\'s configure says what the user fills where; also headers {Name: literal}, methods[].headers {Name: literal|{input}}, '
      + 'optional [input], correlationHeader, settings {baseUrl:true}, timeout, errors {status: {"404": "<Exception>"}}, callbacks {before|after: {steps}}; give "sample" (never sampled)',
  ],
  contract: { tool: 'ssam_reference', arguments: { kind: 'api', query: { op: 'rest-consume' } }, why: 'the closed keys, the type rules and the codes' },
}]);

const fold = text => String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const CONSUME = /\b(rest|api|apis|endpoint|endpoints|webservice|web service|json|http)\b/;
const EXPOSE = /\b(expor|exponha|exposto|exposta|expose|exposed|publicar endpoint|publish endpoint|rest-expose)\b/;
const SOAP = /\b(soap|wsdl)\b/;

/** An http(s) URL, or REST/API words that are not about exposing one. */
function consumesRest(intent) {
  const text = fold(intent);
  if (!text) return false;
  if (SOAP.test(text) && !/https?:\/\//.test(text)) return false;
  const url = /https?:\/\/[^\s"'<>]+/.test(String(intent));
  if (!url && !CONSUME.test(text)) return false;
  // "integre estes REST e exponha service actions" consumes; only an intent about exposing the module's own API does not.
  return !(EXPOSE.test(text) && !url && !/\b(service actions?|consum|integr|chamar|call)\w*/.test(text));
}

// The standard actions of entities: CRUD, "actions padrão"/"standard actions", or actions of at least two of list, read,
// save and remove for the entities (three of them without the word entity). One business action is not this.
const CRUD = /\bcrud\b/;
const STANDARD = /\b(?:actions?|acoes|acao) (?:padrao|padroes|standard|basicas?)\b|\bstandard actions?\b/;
const ACTIONS = /\b(?:actions?|acoes|acao)\b/;
const ENTITIES = /\b(?:entidades?|entity|entities|modelo de dados|data model)\b/;
const CRUD_VERBS = [/\b(?:listar|list)\b/, /\b(?:obter|get|ler|read)\b/, /\b(?:salvar|save|gravar|upsert)\b/, /\b(?:excluir|remover|remove|delete|apagar|deletar)\b/];
function standardActions(intent) {
  const text = fold(intent);
  if (!text) return false;
  if (CRUD.test(text) || STANDARD.test(text)) return true;
  if (!ACTIONS.test(text)) return false;
  const verbs = CRUD_VERBS.filter(verb => verb.test(text)).length;
  return verbs >= 3 || (verbs >= 2 && ENTITIES.test(text));
}

// The standard actions of the entities, generated from the module (op entity-actions; the business action texts go in the
// same job, after it): a generator of the work packet like rest-consume (ssam_code grammar shows it as generate).
export const ENTITY_ACTIONS_GENERATOR = Object.freeze({
  op: 'entity-actions',
  matches: intent => standardActions(intent),
  why: 'a generator writes the standard actions of every entity in one op (list, by id, save, remove, a service action each): write by hand only the business actions, in the same job',
  when: 'the standard actions of the entities (CRUD): generated from the module\'s data model, never written by hand',
  example: JSON.stringify(ENTITY_ACTIONS_OP),
  rules: ENTITY_ACTIONS_CARD.slice(1),
  contract: { tool: 'ssam_reference', arguments: { kind: 'api', query: { op: 'entity-actions' } }, why: 'the closed keys, the names and the signatures of the generated actions' },
});
// Every generator the work packet names, in the order generatorFor tries them.
export const PACKET_GENERATORS = Object.freeze([...GENERATORS, ENTITY_ACTIONS_GENERATOR]);

/** The generator an intent asks for: the consumption of a REST API (an http(s) URL, or REST/API words that are not about
 * exposing one), else the standard actions of the entities (CRUD); null when none. Only an approved generator is offered:
 * a pending one leaves the intent to the route it had before the generator existed. */
export function generatorFor(intent) {
  return PACKET_GENERATORS.find(generator => offered(generator.op) && generator.matches(intent)) ?? null;
}

// Screens from entities and blocks (kernel ScreenGenerator, gen-screen/1): the standard list, detail and form screens of any
// entity are generated from the module (its data model, actions and blocks), never written by hand. One op, three lines.
// ssam-code.mjs re-exports these under the same names; the offers read offered('gen-screen').
export const GENERATE_SCREENS_OP = { op: 'screen', data: { generate: { entities: ['<Entity>', '<Entity2>', '<Entity3>'] } } };
export const GENERATE_SCREENS_RULE = 'Standard screens of entities (a list as a table with paging, search, filters, sort, loading/error/empty states; a detail as a table; '
  + 'a form typed from the attributes with dropdowns and validations; delete with a confirmation; the module\'s blocks reused or created once) are NOT written: '
  + 'one op generates them, ' + JSON.stringify(GENERATE_SCREENS_OP) + ' (write with ops only; the receipt lists every screen, action and block it created; '
  + 'the same request again is NO_CHANGE). Then change only what differs, by the edit of the screen\'s reading.';

// ---- a generator asked about BY NAME (its op or its branch name: "entity-actions", "rest-consume", "gen-screen"...):
// ssam_discover describes it with its state, approved or not; nothing else names a pending one.
/** The ids of the generators an intent names literally, in the table's order. */
export function namedGenerators(intent) {
  const text = fold(intent);
  if (!text) return [];
  const table = approvalOverride ?? GENERATOR_APPROVAL;
  return Object.keys(table).filter(id => table[id].names.some(name => new RegExp('(^|[^a-z0-9.-])' + name.replace(/[.]/g, '\\.') + '($|[^a-z0-9-])').test(text)));
}
/** The generator a job uses (its ops, or the ops of its sub-jobs): an op entity-actions or rest-consume, or op screen with
 * data.generate; null when none. A suite job is a proof of its generator, so it follows the generator's state. */
export function generatorOfJob(job) {
  const table = approvalOverride ?? GENERATOR_APPROVAL;
  const visit = node => {
    if (!node || typeof node !== 'object') return null;
    for (const op of Array.isArray(node.ops) ? node.ops : []) {
      const id = op && typeof op === 'object' ? Object.keys(table).find(key => op.op === table[key].op && (table[key].with !== 'data.generate' || op.data?.generate != null)) : null;
      if (id) return id;
    }
    for (const sub of Array.isArray(node.jobs) ? node.jobs : []) { const id = visit(sub); if (id) return id; }
    return null;
  };
  return visit(job);
}
/** Whether a job may be listed unasked (related jobs, example and recipe search): it uses no generator, an approved one,
 * or one the request names literally (a pending generator stays reachable by name, never steered to). */
export function jobOffered(job, request = '') { return generatorShown(generatorOfJob(job), request); }
/** Whether something tied to generator id (null: none) may be shown for a request: approved, or named by the request. */
export function generatorShown(id, request = '') { return !id || offered(id) || namedGenerators(request).includes(id); }
/** What ssam_discover says of a generator asked about by name: its op, state, reason and report, its contract and the
 * explicit call (the op stays callable by name whatever its state). */
export function describeGenerator(id, lane = 'odc') {
  const a = generatorApproval(id);
  if (!a) return null;
  const pending = a.state !== 'approved';
  const op = id === 'gen-screen' ? GENERATE_SCREENS_OP : id === 'entity-actions' ? ENTITY_ACTIONS_OP : structuredClone(REST_CONSUME_EXAMPLE);
  return { id, op: a.op, ...(a.with ? { with: a.with } : {}), state: a.state, reason: a.reason, report: a.report,
    use: pending ? 'not offered by ssam_discover until an independent blind test approves it; callable explicitly with its op (ssam_job, ' + (lane === 'o11' ? 'o11_job, o11_deliver' : 'studio_deliver') + ', ssam_code write ops)'
      : 'approved: ssam_discover offers it for the intents of its family',
    contract: { tool: 'ssam_reference', arguments: { lane, kind: 'api', query: { op: a.op } } },
    call: { tool: 'ssam_code', arguments: { lane, action: 'write', module: '<Module>', ops: [op] } } };
}

/** The delivery of a generator's example on a lane: the ops are the job (the same delivery as any job). */
export function generatorCall(generator, lane, module = '<Module>') {
  const op = generator.op === 'rest-consume' ? structuredClone(REST_CONSUME_EXAMPLE) : JSON.parse(generator.example);
  const odc = generator.op === 'rest-consume'
    ? { feature: 'REST ' + op.data.name, owners: [op.data.name], changes: ['consume ' + op.data.name] }
    : { feature: 'Standard actions', owners: ['<each entity>'], changes: ['the standard actions of the entities'] };
  return lane === 'o11'
    ? { tool: 'o11_deliver', arguments: { module, job: { ops: [op] }, authorize: '<the user\'s own words, or none with a standing grant>' } }
    : { tool: 'studio_deliver', arguments: { feature: odc.feature, module, job: { ops: [op] }, owners: odc.owners, changes: odc.changes } };
}

/** The card as the tools show it. */
export function generatorCard(generator, lane, module) {
  return { op: generator.op, when: generator.when, example: generator.example, rules: generator.rules,
    contract: { ...generator.contract, arguments: { lane, ...generator.contract.arguments } }, deliver: generatorCall(generator, lane, module) };
}
