// ssam_code (owner decision 2026-10-12, docs/TEXTO-SSAM.md "ssam_code"): a module read and written as code, one tool for
// both lanes. Three parts, the same word to read and to write:
//   ddl    tables, static entities, structures, indexes, settings/site properties, variables, timers as SQL DDL (ssam-ddl/1)
//   logic  actions as pseudocode (ssam-flow/1)
//   html   screens and blocks as HTML (ssam-html/1)
// A THIN layer, no engine of its own: read is ssam_map (views ddl, flow, html) with its continuations named as ssam_code;
// write builds the op the kernel already takes (spec + data.ddl, logic + data.flow, html) and hands it to the delivery tool
// of the lane as it is registered on the server (o11_deliver, studio_deliver): the same journal, gates, authorization words,
// single refusal with every problem and patch, and owner rules; never a second delivery path. grammar needs no module: a
// compact card per part with a from-scratch example the kernel accepts on both lanes (tests/ssam-code.test.mjs applies it).

import { mergeNormalizations } from './normalizations.mjs';
import { GENERATORS, generatorCard, ENTITY_ACTIONS_OP, ENTITY_ACTIONS_CARD, entityActionsCall, GENERATE_SCREENS_OP, GENERATE_SCREENS_RULE, offered } from './generators.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { loadFlowReading, expandEditPart } from './flow-edits.mjs';
import { extendDraftSchema, isDraftCall } from './code-draft-schema.mjs';

export const CODE_TOOL = 'ssam_code';
export const CODE_PARTS = ['ddl', 'logic', 'html'];
export const CODE_ACTIONS = ['grammar', 'read', 'write', 'check', 'plan'];
export const CODE_FORMS = { ddl: 'ssam-ddl/1', logic: 'ssam-flow/1', html: 'ssam-html/1' };
// The bounds of the lists of a write: high enough for any module the person writes in one call (2026-10-12: 96 actions and
// 171 ops were refused by a limit of 50 no platform has); they only keep a runaway call out.
export const CODE_LIST_MAX = 1000;
export const CODE_OPS_MAX = 2000;
export const CODE_FILE_MAX_BYTES = 8 * 1024 * 1024;
// The ssam_map view of each part (and back): logic is read by the view "flow".
export const VIEW_OF_PART = { ddl: 'ddl', logic: 'flow', html: 'html' };
const PART_OF_VIEW = { ddl: 'ddl', flow: 'logic', logic: 'logic', html: 'html' };
export const partOfView = view => PART_OF_VIEW[view] ?? null;

// ---- grammar: the from-scratch examples (one module, both lanes; the logic and html examples use the ddl example's data)
export const EXAMPLE_DDL = `/// A customer.
create entity Customer label CustomerName (
  Id Long Integer identifier auto required,
  CustomerName Text(120) required,
  IsActive Boolean required default True
);

/// A visit to a customer.
create entity Visit label VisitTitle (
  Id Long Integer identifier auto required,
  CustomerId Customer Identifier required references Customer on delete Protect,
  VisitStatusId VisitStatus Identifier required references VisitStatus on delete Protect,
  VisitTitle Text(120) required,
  Amount Decimal(18,2) default 0,
  IsDone Boolean required default False,
  CreatedOn Date Time default CurrDateTime()
);
create unique index UQ_Visit_VisitTitle on Visit (VisitTitle);

/// The states of a visit.
create static entity VisitStatus (
  Id Integer identifier required,
  Label Text(50) required,
  Order Integer required
)
values
  Planned (Id = 1, Label = "Planned", Order = 1),
  Visited (Id = 2, Label = "Visited", Order = 2);

/// Totals of the visits of a customer.
type VisitTotals = {
  Total: Integer;
  TotalAmount: Decimal(18,2);
}

/// A visit with the customer's name.
type VisitRow = {
  VisitTitle: Text(120);
  CustomerName: Text(120);
}
`;

// The data a module with a UI flow adds to the example: a client variable with its default (one line, no ';'). A service
// (_CS) module has no client variables, so the service example leaves it out.
export const EXAMPLE_DDL_UI_EXTRA = `/// The visit filter the user typed last, kept in the browser.
client variable LastFilter: Text = "all"
`;
export const EXAMPLE_DDL_UI = EXAMPLE_DDL + '\n' + EXAMPLE_DDL_UI_EXTRA;

export const EXAMPLE_LOGIC = [`/// Marks a visit as done and returns how many visits are done.
server action CompleteVisit
  in VisitId: Visit Identifier
  out CompletedCount: Long Integer
  local TheVisit: Visit
  GetVisit = aggregate FROM Visit WHERE (Visit.Id = VisitId) MAX 1
  if GetVisit.List.Empty:  # Visit exists?
    raise VisitNotFound("Visit not found")
  assign
    TheVisit = GetVisit.List.Current.Visit
    TheVisit.IsDone = True
    TheVisit.VisitStatusId = Entities.VisitStatus.Visited
  UpdateVisit(Source=TheVisit)
  assign CompletedCount = GetVisit.Count
  end
`, `action Visits.Complete
  in VisitId: Visit Identifier
  CompleteVisit(VisitId)
  refresh GetVisits
  end
`, `/// Opens the summary popup.
action Visits.OpenSummary
  assign ShowSummary = True
  end
`, `/// Closes the summary popup.
action Visits.CloseSummary
  assign ShowSummary = False
  end
`, `/// Lists a page of a customer's visits with the customer's name.
server action ListCustomerVisits
  in CustomerId: Customer Identifier
  in StartIndex?: Integer = 0
  in MaxRecords?: Integer = 50
  out Rows: VisitRow List
  out Total: Integer
  GetPage = sql -> Customer, Visit max MaxRecords
    in TheCustomer: Customer Identifier = CustomerId
    in Skip: Integer = StartIndex
    in Take: Integer = If(MaxRecords <= 0, 50, MaxRecords)
    | SELECT {Customer}.*, {Visit}.* FROM {Visit} INNER JOIN {Customer} ON {Customer}.[Id] = {Visit}.[CustomerId] WHERE {Visit}.[CustomerId] = @TheCustomer ORDER BY {Visit}.[CreatedOn] DESC, {Visit}.[Id] OFFSET @Skip ROWS FETCH NEXT @Take ROWS ONLY
  (System).ListAppendAll(List=Rows, SourceList=GetPage.List mapTo { VisitTitle: List_2.VisitTitle, CustomerName: List.CustomerName })
  GetTotal = sql -> VisitTotals max 1
    in TheCustomer: Customer Identifier = CustomerId
    in Minimum: Decimal = 0
    | SELECT COUNT(*), SUM({Visit}.[Amount]) FROM {Visit} WHERE {Visit}.[CustomerId] = @TheCustomer AND {Visit}.[Amount] >= @Minimum
  assign Total = GetTotal.List.Current.VisitTotals.Total
  end
  on exception All Exceptions:
    @{Name="AllExceptions"}
    raise VisitNotFound("Failed to list the visits")
  on exception VisitNotFound abort log:
    @{Name="VisitNotFound"}
    raise VisitNotFound("Visit not found")
`, `/// Lists visits as rows using a whole-list assignment.
server action ListVisitRows
  out Rows: VisitRow List
  GetVisits = aggregate FROM Customer, Visit JOIN Inner Visit~Customer ON Visit.CustomerId = Customer.Id SORT Visit.CreatedOn desc MAX 50
  assign Rows = GetVisits.List mapTo { VisitTitle: Visit.VisitTitle, CustomerName: Customer.CustomerName }
  end
`];

// The ODC reader also prints the join tree's read-only root. The examples declare it as printed; the flow writer
// verifies MasterSource against the tree instead of attempting a non-existent setter.
export function exampleLogicTexts(lane = 'odc') {
  if (lane !== 'odc') return EXAMPLE_LOGIC;
  return EXAMPLE_LOGIC.map(text => text
    .replace(/^(  \w+ = aggregate FROM (\w+), .*)$/gm, '$1\n    @{MasterSource=&"$2"}'));
}

// A popup (modal) from scratch: a Boolean variable shows it, one screen action opens it and one closes it. The events
// inside a popup are at Transition Fade, the platform's default there: the kernel writes it and the reader omits it, so the
// example writes the event as it reads back (CODE_FORMS_EXACT.html['event in a popup']), without the default.
export const EXAMPLE_HTML = `<screen name="Visits" roles="Visitor" actions="Complete, OpenSummary, CloseSummary">
<var name="Filter" type="Text"/>
<var name="ShowSummary" type="Boolean" default="False"/>
<aggregate name="GetVisits" from="Visit" sort="Visit.CreatedOn desc" max="50"/>
<div class="visits">
 <input bind="Filter" class="form-control"/>
 <button class="btn" onclick="OpenSummary">Summary</button>
 <div list="GetVisits.List">
  <div class="visit">
   {{ GetVisits.List.Current.Visit.VisitTitle }}
   <button class="btn btn-primary" onclick="Complete(VisitId = GetVisits.List.Current.Visit.Id)">Complete</button>
  </div>
 </div>
 <popup show="ShowSummary">
  <div class="summary">
   Summary of the visits
   <button class="btn" onclick="CloseSummary">Close</button>
  </div>
 </popup>
</div>
</screen>
`;

// The standard actions of a data model are generated (owner decision 2026-10-13): the op, its three-line card and its write
// live with the other generators (generators.mjs, one mechanism for the work packet), re-exported here under the same names.
export { ENTITY_ACTIONS_OP, ENTITY_ACTIONS_CARD, entityActionsCall };

// The exact one-line forms the readers print and the parsers take, each one in an example above (the tests apply the
// examples from scratch and read them back): what the cards name as "the form", never a paraphrase.
export const CODE_FORMS_EXACT = {
  ddl: {
    'client variable': 'client variable LastFilter: Text = "all"',
    'entity attribute default': 'IsDone Boolean required default False',
    'static record': 'Planned (Id = 1, Label = "Planned", Order = 1)',
  },
  logic: {
    'assign, several': 'assign\n    TheVisit = GetVisit.List.Current.Visit\n    TheVisit.IsDone = True',
    'branch end': 'if GetVisit.List.Empty:  # Visit exists?\n    raise VisitNotFound("Visit not found")',
    'screen action': 'action Visits.OpenSummary\n  assign ShowSummary = True\n  end',
    pagination: 'OFFSET @Skip ROWS FETCH NEXT @Take ROWS ONLY',
    join: 'FROM Customer, Visit JOIN Inner Visit~Customer ON Visit.CustomerId = Customer.Id',
    'sql parameter': 'in TheCustomer: Customer Identifier = CustomerId',
    'sql typed parameter': 'in Minimum: Decimal = 0',
    'sql result': 'GetTotal = sql -> VisitTotals max 1',
    'exception handler': 'on exception VisitNotFound abort log:',
    'exception handler without flags': 'on exception All Exceptions:',
    'list append mapping': '(System).ListAppendAll(List=Rows, SourceList=GetPage.List mapTo { VisitTitle: List_2.VisitTitle, CustomerName: List.CustomerName })',
    'list assignment mapping': 'assign Rows = GetVisits.List mapTo { VisitTitle: Visit.VisitTitle, CustomerName: Customer.CustomerName }',
  },
  html: {
    popup: '<popup show="ShowSummary">',
    'popup variable': '<var name="ShowSummary" type="Boolean" default="False"/>',
    'event in a popup': '<button class="btn" onclick="CloseSummary">Close</button>',
    'event without arguments': '<button class="btn" onclick="OpenSummary">Summary</button>',
  },
};

// What the examples use and no text creates: a user exception (raised by the logic example) and a role (of the screen).
// Raw ops of the same job, before the texts (ssam_code write {ops}).
export const EXAMPLE_SETUP_OPS = [
  { op: 'create', parent: '@espace', type: 'IUserException', name: 'VisitNotFound' },
  { op: 'create', parent: '@espace', type: 'IRole', name: 'Visitor' },
];

// A screen (html) and a screen action need a module with a Reactive or Mobile UI flow: an empty module, or a service
// (_CS) module, has none and refuses them before any change (PREFLIGHT_REFUSED, FLOW_OWNER_UNKNOWN). Its example is the
// data and a server action.
const UI_FLOW_NEEDED = 'a screen, a block and a screen action need a module with a Reactive or Mobile UI flow; an empty or service (_CS) module has none: there, write the data (ddl) and server actions (logic) only';

// Screens from entities and blocks (kernel ScreenGenerator, gen-screen/1): the op and its rule live with the other generators
// (generators.mjs, with its approval), re-exported here under the same names.
export { GENERATE_SCREENS_OP, GENERATE_SCREENS_RULE };
/** The call that generates the standard screens of entities (no text: the module is the input). */
export function generateScreensCall(lane = 'odc') {
  return { tool: CODE_TOOL, arguments: { lane, action: 'write', module: '<Module>', ops: [GENERATE_SCREENS_OP] } };
}

// The rule that steers to the entity-actions generator (the html part has GENERATE_SCREENS_RULE for gen-screen).
const ENTITY_ACTIONS_RULE = 'Standard actions of the entities (list, read, save, delete, their service actions) are GENERATED, never written: ops [{"op":"entity-actions","data":{"entities":"all"}}] in the same write (generate below); write only the business actions.';
// A generator's rule, card or call is in the grammar only while the generator is approved (generators.mjs offered): a
// pending one leaves the grammar as it was before it existed; its op stays callable with ssam_code write ops.
const GENERATOR_RULES = new Map([[ENTITY_ACTIONS_RULE, 'entity-actions'], [GENERATE_SCREENS_RULE, 'gen-screen']]);
const rulesOf = part => RULES[part].filter(rule => !GENERATOR_RULES.has(rule) || offered(GENERATOR_RULES.get(rule)));

const RULES = {
  ddl: [
    'Not SQL Server DDL: lower-case keywords, an entity is "create entity" (never CREATE TABLE), the identifier is "Id Long Integer identifier auto required" (never INT PRIMARY KEY), types are OutSystems types (Text(120), never VARCHAR(120)).',
    'One statement per element, each with its own end. Statements that end with ";": create entity X [public] [label Attr] ( Attr Type [identifier] [auto] [required] [references E on delete Protect|Delete|Ignore] [default v] [label "..."], ... ); | create static entity X (...) values Rec (Attr = v, ...), ...; | create [unique] index N on E (A, B); | drop <what> <Name>; -- @key.',
    'A structure ends with its brace, no ";" after it: type S [public] = { F: Type [required] [json "n"]; ... }.',
    'One-line declarations, NO ";" at the end (the line is the statement; a ";" there is read as part of it): client variable V: Type [= default] | site property P: Type [read-only] [= v] (ODC: setting P: Type [= v]) | session variable V: Type [= default] | timer T action A schedule "When Published" [timeout n]. Example: ' + CODE_FORMS_EXACT.ddl['client variable'] + '. A client variable needs a module with a UI flow.',
    'A default is an OutSystems literal or expression up to the end of the line (or the attribute): "text", 0, 1.5, True, CurrDateTime(); a Date default is the literal #2026-01-31# (Date Time: #2026-01-31 08:00:00#), never TextToDate("...") (the Verify takes only a literal there).',
    'Types and values are OutSystems ones: Text(120), Integer, Long Integer, Decimal(18,2), Boolean, Date, Time, Date Time, Currency, Email, Phone Number, Binary Data, <Entity> Identifier, a structure or entity name; True/False, "text", 1.5, CurrDateTime(), Entities.<Static>.<Record>.',
    '/// lines right above an element are its description. Any other property: os:<Property>=<value>.',
    'Writing: send only the statements that change. Each element read keeps its trailing -- @key; a statement without a key is new; the same key with another name is a rename; an attribute or record left out of a statement sent whole is deleted; drop entity|static entity|index|type|site property|setting|client variable|timer <Name>; -- @key deletes.',
    'basedOn: the sourceSha256 of the read; required when a statement carries a -- @key (new statements need no read).',
  ],
  logic: [
    'Header: server action N | service action N | client action N | action <Screen>.N (screen/block action) | data action <Screen>.N | preparation <TraditionalOwner>.Preparation; when read, keep the action @key. Preparation has a fixed name, no input/output parameters, and belongs only to Traditional screens, blocks or emails. public/function apply only to module actions.',
    'One text (or file) may hold several actions: each starts with its /// description and header at column 0, a blank line between; ssam_code splits them.',
    'Then in P[?]: Type [= default], out P: Type, local L: Type; then the flow from Start, in connector order, indented 2 spaces.',
    'Nodes: X = Action(P=v, Q) (call; a module or system action: (System).ListAppend); assign X = v on one line, or the word assign alone and then one X = v per line indented 2 spaces deeper than assign (a line at the depth of assign is the next node: "expected \'(\'"); X = aggregate FROM E [JOIN ...] WHERE (cond) [SORT a desc] [MAX n]; if cond: (true branch indented 2 deeper, false branch continues below); foreach L: ... next; switch: case cond: ... otherwise: ...; raise Exc("message"); message Type: expr; navigate Screen(args); refresh Source; X = sql -> Out max n | SELECT ...; end.',
    'Pagination: a screen pages its own screen aggregate (html <aggregate max="MaxRecords" os-StartIndex="StartIndex">; the Pagination block: StartIndex and MaxRecords the same variables, TotalCount = <Aggregate>.Count, OnNavigate assigns StartIndex = NewStartIndex then refresh <Aggregate>). A server action pages by SQL: ORDER BY a total order, then ' + CODE_FORMS_EXACT.logic.pagination + ' with in Skip: Integer = StartIndex and in Take: Integer = If(MaxRecords <= 0, 50, MaxRecords) (FETCH NEXT 0 is an error), the total from COUNT(*) OVER() of the same query; its row names the outputs List, List_2, ... in the order of sql -> (mapTo { Title: List_2.Title }). START on an aggregate of a server, service, data or client action is refused (LOGIC_START_SERVER_IGNORED): the Studio hides it there and the runtime ignores it, so every page would show the first rows.',
    'JOIN: FROM A, B, C JOIN Inner A~B ON cond | Left B~C ON cond. Inner = Only With, Left = With or Without, Full = With. SQL-style JOIN input is normalized when its left source is unambiguous; conditions stay literal.',
    'SQL parameters: under X = sql -> Structure max n, write one in P: Type = value per line, then | SELECT ... on the following line. Types include Entity Identifier. Example: ' + CODE_FORMS_EXACT.logic['sql parameter'] + '.',
    'Exception handlers follow the main flow: on exception Exception [abort] [log]: then an indented branch. abort (Abort Transaction) and log (Log Error) are optional; the reader orders handlers by exception name. Example: ' + CODE_FORMS_EXACT.logic['exception handler'] + '.',
    'The reader also prints a handler name such as @{Name="AllExceptions"}; keep it as read. ODC additionally prints @{MasterSource=&"A"} under a multi-source aggregate: it asserts the derived join root and is never changed through a read-only setter. The examples below include these properties.',
    'Whole-list mapping replaces a copy-only For Each: (System).ListAppendAll(List=L, SourceList=S mapTo { Field: value }) or assign L = S mapTo { Field: value }; each field value is relative to the source item. Both whole values also work in JSON assign/args.',
    'Every branch ends in end, raise, navigate, next or -> @id, and each of them ENDS it: nothing follows them at that depth, so never "end" after raise or navigate (a line there is "unexpected line"). "  # label" before the id; /// description above; // comment.',
    'Changing an action: send it WHOLE, as read, with the change (every line of the read keeps its @id): a line with its @id keeps its element, a line without @id is new, a line LEFT OUT IS DELETED. A text that leaves out lines of the read (a gap in its @n/@p/@l ids) is refused before the delivery, unless removes:true (or removes:["@n3", ...]) says those deletions are meant. basedOn: the textSha of the read action.',
    'A header without @key creates the action (no read, no basedOn); a screen action needs its screen (' + UI_FLOW_NEEDED + ').',
    'Owner rules: a For Each that only filters, maps or accumulates is refused with the List action as the patch (T1/T2); JavaScript only in an isolated, named client action.',
    'Changing a few lines: write {element, basedOn: its textSha, edits:[{replace:"@n4", with:"..."}, {after:"@n2", insert:"..."}, {before:"@n2", insert:"..."}, {delete:"@n3"}]}. R1: trailing @id (header @key), @id#2 for repeats, or exact line text. R2: column-zero text inherits indentation. R3: replace keeps the id; deeper lines replace the block, otherwise children stay. R4: delete removes the block and its /// description, never the header. R5: after follows the block (deeper insert starts it); before precedes descriptions; inserts keep order. Several actions: also:[{part:"logic", element, basedOn, edits}].',
    ENTITY_ACTIONS_RULE,
  ],
  html: [
    'Needs a UI flow: ' + UI_FLOW_NEEDED + '.',
    GENERATE_SCREENS_RULE,
    'A new screen: <screen name="S" roles="Role" actions="A, B" [data-actions="D"] [title=\'"Title"\']> with <input name type>, <var name type default>, <aggregate name from sort where max> and the widgets; a block: <block name>. An <input name type> (or a block <event name>) without mandatory is optional; mandatory="True" makes it mandatory.',
    'Widgets: div, form, a, button, input, textarea, select, switch, label, img, i icon, popup, placeholder, upload, {{ expr }} (expression), plain text; <x list="Source.List"> repeats x; <div if="cond"> ... <div else> ... is an If; <Block name="B" :Input="expr" @Event="Handler(...)"><slot name="Content">...</slot></Block> is a block instance.',
    'Events: on<event>="Destination(Param = expr, ...)", and with no argument on<event>="Destination" (ssam_code writes "Destination()" so); bind="Variable" on inputs; class="a b" or class="{{ expr }}"; any other authored property: os-<Property>="value"; a property of an event: os-on<event>.<Property>="value" on an element whose on<event> is set.',
    'A popup (modal) is <popup show="Var"> ... </popup>, never a <div if> over the page: Var is a Boolean screen variable (' + CODE_FORMS_EXACT.html['popup variable'] + '), a screen action opens it (assign Var = True) and one closes it (assign Var = False). The Studio gives events inside a popup Transition Fade by default: write the event as read, ' + CODE_FORMS_EXACT.html['event in a popup'] + ', and os-onclick.Transition only for another transition. The example below has one.',
    'A new screen action: a logic text "action <Screen>.A" (no @key) in the same write (also: [{part:"logic", text}]); a data action: "data action <Screen>.D". ssam_code writes a new screen action BEFORE the change of an existing screen (the button names it) and AFTER a new <screen> document (the screen comes first). On a screen read, leave actions="..." as read: the logic text adds the action.',
    'Changing an existing screen: read it (part html, element the screen), then write only the changed elements, each whole with its k, with element the screen and basedOn {capture, html} of the read; a new element has no k; a removed one is left out of its parent. ODC: owners default to the screen (element), the screens of the screen actions and the elements the code names.',
    'Change a few elements of a read screen: edits [{set:"w7",attributes:{...}}, {replace|after|before|into|delete|move:"w7",...}, {find:"exact text",with:"..."}] with element and basedOn {capture, html}; a refused or checked job: basedOn {job, sha256}, element (screen, block, action or ddl) and edits [{find, with}].',
    'Owner rules: a condition is <div if>, never os-Visible; no JavaScript or JSON in the screen; data by aggregate or data action; reuse the module\'s layout block and blocks first.',
  ],
};

const SLOTS = {
  ddl: 'text: the statements (whole module data for a new module; only the changed statements otherwise)',
  logic: 'text: one action text, or a list, each WHOLE as read with the change; one text (or file) may hold several actions: each starts with its /// description and header at column 0, a blank line between; ssam_code splits them. basedOn: the textSha of each read action (one text per action, a list in the same order); removes: true only when lines were left out on purpose',
  html: 'text: the <screen>/<block> document of a new screen, or the changed elements (a list) with element = the screen and basedOn {capture, html}; ODC owners default to the screen, the screens of its actions and the elements named',
};

// The generators of the grammar's generators list (rest-consume) that are approved.
const approvedGenerators = () => GENERATORS.filter(g => offered(g.op));

/** The grammar card of a part (or every part with no part): the syntax rules, a from-scratch example and the calls. */
export function grammarCard(part, lane = 'odc') {
  if (part == null) {
    // What the note names: the approved generators only (both approved: the note as it was).
    const offers = [offered('entity-actions') ? 'generate: the entity actions' : null, approvedGenerators().length ? 'generators: a REST API from its URLs' : null].filter(Boolean);
    return { ok: true, tool: CODE_TOOL, action: 'grammar', lane, parts: CODE_PARTS.map(p => grammarCard(p, lane).card),
      example: { why: 'from scratch on an EMPTY or service (_CS) module (no UI flow): the data and a server action in ONE write; the setup op creates the exception the action raises',
        call: serviceExampleCall(lane) },
      exampleWithUi: { why: 'a module with a Reactive or Mobile UI flow: the data, a screen and its screen action in ONE write; the setup ops create the exception and the role the texts use',
        call: exampleCall(lane) },
      ...(offered('entity-actions') ? { generate: { why: 'the standard actions of every entity, generated from the module (no text to write)', card: ENTITY_ACTIONS_CARD, call: entityActionsCall(lane) } } : {}),
      // Generators: one op writes a whole family (a REST API from its URLs); write them with ops (no text). Approved ones only.
      ...(approvedGenerators().length ? { generators: approvedGenerators().map(g => generatorCard(g, lane)) } : {}),
      note: 'read before write when the module has the element (its @key/@id/k and the basedOn come from the read); a new element needs no read. ' + UI_FLOW_NEEDED + '.'
        + (offers.length ? ' A generator (' + offers.join('; ') + ') writes a whole family in one op: never write by hand what it writes.' : '') };
  }
  const example = part === 'ddl' ? EXAMPLE_DDL : part === 'logic' ? exampleLogicTexts(lane) : EXAMPLE_HTML;
  // R7: the general language the kernel expands into the forms of the grammar (FlowGeneral), one example each.
  const general = part === 'logic' ? {
    why: 'shorter lines the kernel expands into the forms above, each listed in normalizations; the action reads back expanded',
    let: 'let Total = Price * Quantity  (the local, of the type the value has with certainty; else let Total: Decimal = ...)',
    require: 'require Quantity > 0 else VisitNotFound("No quantity")  (if not (...) and raise; also else return, end or -> @id)',
    return: 'return Total = Price * Quantity, IsDone = True  (assigns the outputs, then end)',
    join: 'in a text with let, require or return a branch of if, switch or foreach without end or -> @id goes on after its block',
    copy: 'assign Copy = { ...TheVisit, IsDone: True }  (assign Copy = TheVisit, then an assign of Copy.IsDone = True)',
    sqlBind: '| SELECT ... WHERE {Visit}.[CustomerId] = @CustomerId  (no in line: the input or local of that name; else bind CustomerId = value under the node)',
    record: 'load V: Visit by VisitId locked / update V {IsDone=True} / insert N: Visit {VisitTitle="New"} / delete V  (the entity actions; update and delete need the record loaded locked or inserted in the branch)',
    contract: 'contract Owned: above the action in the same text (its in/load/require lines one level in), then use Owned in the action  (its lines in place, the declarations first)',
  } : null;
  const card = { part, form: CODE_FORMS[part], rules: rulesOf(part), slots: SLOTS[part], example, ...(general ? { general } : {}),
    // The exact forms (each one is in an example the tests apply and read back on both lanes).
    forms: CODE_FORMS_EXACT[part],
    ...(part === 'ddl' ? { exampleWithUi: EXAMPLE_DDL_UI_EXTRA, exampleWithUiWhy: 'what a module with a UI flow adds: a client variable with its default (a service module has none)' } : {}),
    ...(part === 'logic' ? { uses: 'the data of the ddl example and the exception VisitNotFound (setup op); the screen actions Visits.Complete, OpenSummary and CloseSummary need the screen of the html example',
      ...(offered('entity-actions') ? { generate: { why: 'the standard actions of every entity, generated from the module (no text to write)', card: ENTITY_ACTIONS_CARD, call: entityActionsCall(lane) } } : {}),
      ...(approvedGenerators().length ? { generators: approvedGenerators().map(g => ({ ...generatorCard(g, lane), write: { tool: CODE_TOOL, arguments: { lane, action: 'write', module: '<Module>', ops: [JSON.parse(g.example)] } } })) } : {}) } : {}),
    ...(part === 'html' ? { uses: 'the data of the ddl example, the role Visitor (setup op) and the screen actions Complete, OpenSummary and CloseSummary of the logic example', needs: UI_FLOW_NEEDED,
      ...(offered('gen-screen') ? { standardScreens: { why: 'list, detail and form screens of entities: generated from the module, nothing to write', call: generateScreensCall(lane) } } : {}) } : {}),
    read: { tool: CODE_TOOL, arguments: { lane, action: 'read', part, target: '<Module or capture.oml>', ...(part === 'ddl' ? {} : { element: part === 'html' ? '<Screen>' : '<Action>' }) } },
    write: { tool: CODE_TOOL, arguments: { lane, action: 'write', part, module: '<Module>', text: '<code>' } } };
  return { ok: true, tool: CODE_TOOL, action: 'grammar', lane, card,
    example: part === 'html' ? { why: 'a module with a UI flow', call: exampleCall(lane) } : { why: 'any module, also an empty or service (_CS) one', call: serviceExampleCall(lane) } };
}

/** The whole example (data, screen, screen action): a module with a Reactive or Mobile UI flow. */
export function exampleCall(lane = 'odc') {
  return { tool: CODE_TOOL, arguments: { lane, action: 'write', part: 'ddl', module: '<Module>', text: EXAMPLE_DDL_UI, ops: EXAMPLE_SETUP_OPS,
    also: [{ part: 'html', text: EXAMPLE_HTML }, { part: 'logic', text: exampleLogicTexts(lane) }] } };
}
/** The example of an empty or service (_CS) module: the data and the server action (no screen, no role). */
export function serviceExampleCall(lane = 'odc') {
  return { tool: CODE_TOOL, arguments: { lane, action: 'write', part: 'ddl', module: '<Module>', text: EXAMPLE_DDL, ops: [EXAMPLE_SETUP_OPS[0]],
    also: [{ part: 'logic', text: exampleLogicTexts(lane).filter(text => /^server action /m.test(text)) }] } };
}

// The sentence the old write paths carry (o11_deliver, studio_deliver, ssam_job/o11_job).
export const CODE_JOB_TEXT = 'Code forms (ssam_code writes them for you, part ddl|logic|html): {"op":"ddl","data":{"ddl"|"text","basedOn"?}} '
  + '(= spec with data.ddl), {"op":"logic","data":{"text"|"flow"}}, {"op":"html","data":{"html"}}. An op shape with one meaning '
  + '(set {props:{...}}, a raw verb\'s keys inside data, a text beside data, ops beside job) is taken as meant and listed in normalizations. '
  + 'One logic text may hold several actions, each with its /// description and header at column 0, a blank line between: ssam_code splits them.';

// ---- the op shapes of a job with ONE meaning, written in the kernel's form (family 2026-10-12: a model writes the same op
// in several shapes; each one that can mean only one thing is taken as meant and listed, never refused). Applied where a
// job enters a delivery or a proof (job-patch.mjs: o11_deliver, ssam_job/o11_job, the studio_deliver patch; the
// studio_deliver relay for inline jobs), on both lanes; the kernel sees only its own forms.
//   - the ssam_code aliases: {"op":"ddl","data":{"ddl"|"text"}} is spec + data.ddl; logic data.text is data.flow;
//   - a text op with its text beside data instead of in it: spec|ddl {ddl|text}, logic {flow|text}, an html document
//     {html:"<screen ...>"} without parent, an html edit {screen, edit, basedOn};
//   - a raw verb with its keys inside data (the raw verbs take no data): the keys go up;
//   - set {props|properties: {P: v, ...}} is one set per property, in order; set {property} is prop; rename {newName|to}
//     is name; create {kind} is type.
// The raw verbs and the keys each one reads (the kernel's VerbSurface contract): what may go up out of a data object.
const RAW_VERB_KEYS = {
  create: ['parent', 'type', 'name', 'args', 'as', 'source', 'empty'], set: ['target', 'prop', 'value', 'empty'], link: ['from', 'to', 'connector', 'as'],
  move: ['target', 'into', 'first', 'last', 'before', 'after', 'x', 'y'], duplicate: ['target', 'as', 'parent'], delete: ['target', 'force', 'reconnect', 'breaks'],
  rename: ['target', 'name'], replace: ['from', 'to', 'force'], reference: ['producer', 'elements', 'as'], layout: ['target'], get: ['target'],
  find: ['name', 'type', 'max'], dump: ['target', 'depth'], usages: ['target', 'max', 'offset', 'scope', 'includeInternal'],
};
const DOCUMENT_TEXT = /^\s*(?:<!--[\s\S]*?-->\s*)*<(screen|block)[\s/>]/;
const own = (o, k) => Object.hasOwn(o, k) && o[k] !== undefined;
// One op -> {ops: [op, ...], notes: [text]} (the same op object when nothing applies).
function normalizeOp(op) {
  if (!plain(op) || typeof op.op !== 'string') return { ops: [op], notes: [] };
  const notes = [];
  let o = op;
  const data = plain(o.data) ? o.data : null;
  // A raw verb with its own keys in data: they go up (only keys the verb reads, none of them already above).
  const verbKeys = RAW_VERB_KEYS[o.op];
  if (verbKeys && data && Object.keys(data).length && Object.keys(data).every(k => verbKeys.includes(k) || k.startsWith('_')) && !Object.keys(data).some(k => own(o, k))) {
    const { data: _d, ...rest } = o; o = { ...rest, ...data }; notes.push(`${o.op}: its keys (${Object.keys(data).join(', ')}) out of data, where the raw verbs read them`);
  }
  if (o.op === 'ddl' || o.op === 'spec') {
    const d = plain(o.data) ? o.data : {};
    const beside = ['ddl', 'text'].find(k => typeof o[k] === 'string');
    if (o.op === 'ddl' || (beside && d.ddl == null)) {
      const { ddl: topDdl, text: topText, ...rest } = o;
      const { text, ddl, ...dataRest } = d;
      const value = ddl ?? text ?? topDdl ?? topText;
      if (value != null) {
        if (o.op === 'ddl') notes.push('op "ddl" is the spec op with data.ddl');
        if (beside && d.ddl == null && d.text == null) notes.push(`${o.op}: ${beside} beside data is data.ddl`);
        o = { ...rest, op: 'spec', data: { ...dataRest, ddl: value } };
      }
    }
  } else if (o.op === 'logic') {
    const d = plain(o.data) ? o.data : {};
    if (d.flow == null && d.actions == null) {
      const from = d.text != null ? ['data.text', d.text] : o.flow != null ? ['flow beside data', o.flow] : o.text != null ? ['text beside data', o.text] : null;
      if (from) {
        const { flow: _f, text: _t, ...rest } = o; const { text: _dt, ...dataRest } = d;
        o = { ...rest, data: { ...dataRest, flow: Array.isArray(from[1]) ? from[1] : [from[1]] } };
        notes.push(`logic: ${from[0]} is data.flow`);
      }
    }
    const current = plain(o.data) ? o.data : {};
    if (current.flow != null && current.basedOn == null) {
      let changed = false;
      const flow = (Array.isArray(current.flow) ? current.flow : [current.flow]).flatMap((text, i) => {
        const split = typeof text === 'string' ? splitActions(text) : null;
        if (!split) return [text];
        changed = true;
        notes.push(`logic: data.flow/${i} holds ${split.length} actions: ${split.length} texts`);
        return split;
      });
      if (changed) o = { ...o, data: { ...current, flow } };
    }
  } else if (o.op === 'html' && o.parent == null) {
    // The document form (no parent) or the edit form beside data: into data.
    if (o.data == null && typeof o.html === 'string' && DOCUMENT_TEXT.test(o.html) && o.file == null) {
      const { html, ...rest } = o; o = { ...rest, data: { html } }; notes.push('html: a <screen>/<block> document beside data is data.html');
    } else if (o.data == null && typeof o.screen === 'string' && (o.edit != null || o.edits != null)) {
      const { screen, edit, edits, basedOn, ...rest } = o; o = { ...rest, data: { screen, ...(edit != null ? { edit } : {}), ...(edits != null ? { edits } : {}), ...(basedOn != null ? { basedOn } : {}) } }; notes.push(`html: screen, ${[edit != null && 'edit', edits != null && 'edits'].filter(Boolean).join(', ')} and basedOn beside data are data`);
    }
  }
  if (o.op === 'set') {
    if (!own(o, 'prop') && typeof o.property === 'string') { const { property, ...rest } = o; o = { ...rest, prop: property }; notes.push('set: property is prop'); }
    const many = !own(o, 'prop') && !own(o, 'value') && ['props', 'properties'].find(k => plain(o[k]) && Object.keys(o[k]).length);
    if (many) {
      const { [many]: map, ...rest } = o;
      const split = Object.entries(map).map(([prop, value]) => ({ ...rest, prop, value }));
      notes.push(`set: ${many} {${Object.keys(map).join(', ')}} is one set per property`);
      return { ops: split, notes };
    }
  } else if (o.op === 'rename' && !own(o, 'name')) {
    // rename {target, newName|to} and rename {from, to}: the element and its new name (only when both are then there).
    const key = ['newName', 'to'].find(k => typeof o[k] === 'string' && o[k]);
    const target = own(o, 'target') ? null : typeof o.from === 'string' && o.from ? 'from' : null;
    if (key && (own(o, 'target') || target)) {
      const { [key]: name, ...rest } = o;
      if (target) { delete rest.from; rest.target = o.from; }
      o = { ...rest, name }; notes.push(`rename: ${target ? 'from is target, ' : ''}${key} is name`);
    }
  } else if (o.op === 'create' && !own(o, 'type') && typeof o.kind === 'string' && o.kind) {
    const { kind, ...rest } = o; o = { ...rest, type: kind }; notes.push('create: kind is type');
  }
  return { ops: [o], notes };
}
/**
 * {job, changed, normalizations}: the job with every op shape of one meaning written in the kernel's form (arrays, {ops},
 * {jobs} alike); normalizations: [{rule: 'job-op', at, note}] with at the op's pointer in the job as given.
 */
export function normalizeCodeOps(job) {
  let changed = false;
  const normalizations = [];
  const ops = (list, base) => list.flatMap((op, i) => {
    const n = normalizeOp(op);
    if (n.ops.length !== 1 || n.ops[0] !== op) changed = true;
    for (const note of n.notes) normalizations.push({ rule: 'job-op', at: `${base}/${i}`, note });
    return n.ops;
  });
  const walk = (j, base) => {
    if (Array.isArray(j)) return ops(j, base);
    if (!plain(j)) return j;
    let out = j;
    if (Array.isArray(j.ops)) out = { ...out, ops: ops(j.ops, base + '/ops') };
    if (Array.isArray(j.jobs)) out = { ...out, jobs: j.jobs.map((x, i) => walk(x, `${base}/jobs/${i}`)) };
    return out;
  };
  const result = walk(job, '');
  return { job: changed ? result : job, changed, normalizations };
}

// ---- read: ssam_map with the continuations named as ssam_code
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const textOp = op => plain(op) && plain(op.data) && ((op.op === 'spec' && 'ddl' in op.data) || (op.op === 'logic' && 'flow' in op.data) || op.op === 'html');

// A continuation of ssam_map (views ddl, flow, html) or of a delivery carrying one text op, as the ssam_code call that does
// the same; any other call is kept.
export function codeCall(call) {
  if (!plain(call) || typeof call.tool !== 'string' || !plain(call.arguments)) return call;
  const a = call.arguments;
  if (call.tool === 'ssam_map' && partOfView(a.view)) {
    const { view, screen, ...rest } = a;
    const part = partOfView(view);
    return { ...call, tool: CODE_TOOL, arguments: { ...rest, action: 'read', part, ...(screen != null ? { element: screen } : {}) } };
  }
  if ((call.tool === 'o11_deliver' || call.tool === 'studio_deliver') && plain(a.job) && Array.isArray(a.job.ops) && a.job.ops.length === 1 && textOp(a.job.ops[0])) {
    const op = a.job.ops[0];
    const { job, ...rest } = a;
    const lane = call.tool === 'o11_deliver' ? 'o11' : 'odc';
    if (op.op === 'spec') return { ...call, tool: CODE_TOOL, arguments: { lane, ...rest, action: 'write', part: 'ddl', text: op.data.ddl, ...(op.data.basedOn ? { basedOn: op.data.basedOn } : {}) } };
    if (op.op === 'logic') {
      const flows = Array.isArray(op.data.flow) ? op.data.flow : [op.data.flow];
      const texts = flows.map(f => (plain(f) ? f.text : f)); const bases = flows.map(f => (plain(f) ? f.basedOn ?? null : null));
      return { ...call, tool: CODE_TOOL, arguments: { lane, ...rest, action: 'write', part: 'logic', text: texts.length === 1 ? texts[0] : texts,
        ...(bases.some(Boolean) ? { basedOn: bases.length === 1 ? bases[0] : bases } : {}) } };
    }
    if (op.data.edits != null) return { ...call, tool: CODE_TOOL, arguments: { lane, ...rest, action: 'write', part: 'html', element: op.data.screen, basedOn: op.data.basedOn, edits: op.data.edits } };
    if (op.data.edit != null) return { ...call, tool: CODE_TOOL, arguments: { lane, ...rest, action: 'write', part: 'html', element: op.data.screen, text: op.data.edit, basedOn: op.data.basedOn } };
    return { ...call, tool: CODE_TOOL, arguments: { lane, ...rest, action: 'write', part: 'html', text: op.data.html } };
  }
  return call;
}
function rewriteCalls(value, depth = 0) {
  if (depth > 6 || value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => rewriteCalls(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = rewriteCalls(v, depth + 1);
  return typeof out.tool === 'string' && plain(out.arguments) ? codeCall(out) : out;
}

// An empty part (a new module): an empty document and the grammar, never an error.
function emptyOf(part, answer) {
  if (!answer || answer.ok === false) return false;
  // ddl: no entity, static entity or structure of its own (the platform's own variables may be there).
  if (part === 'ddl') return answer.page === 1 && (answer.pages ?? 1) <= 1 && typeof answer.text === 'string' && !/^\s*(create (static )?entity|type)\s/m.test(answer.text);
  if (Array.isArray(answer.entries) && answer.count === 0) return true;
  if (Array.isArray(answer.screens) && answer.screens.length === 0) return true;
  return false;
}
const NOT_FOUND = /no (action|screen|block|element|entity)|not found|unknown|matches no|names no/i;

// The smallest budget of one element of a list read (a page of a screen or a data block).
const LIST_ELEMENT_BUDGET = 4000;

/**
 * read: the part as text through ssam_map; map(input) is moduleMap (deps of tests: a fake). A list of elements of part
 * html or ddl (ssam_map reads one screen or block, one data element, at a time; the logic view takes a list itself) has one
 * meaning: each one read, in order, with its share of the budget, in one answer {elements: [...]}, listed in normalizations.
 */
export async function codeRead(input, { map }) {
  if (Array.isArray(input.element) && input.part !== 'logic') {
    const list = [...new Set(input.element.map(String))];
    if (list.length === 1) return codeRead({ ...input, element: list[0] }, { map });
    const share = input.budgetBytes != null ? Math.max(LIST_ELEMENT_BUDGET, Math.floor(input.budgetBytes / list.length)) : undefined;
    const elements = [];
    for (const element of list) elements.push({ element, ...(await codeRead({ ...input, element, ...(share != null ? { budgetBytes: share } : {}) }, { map })) });
    return { ok: elements.every(e => e.ok !== false), tool: CODE_TOOL, part: input.part, form: CODE_FORMS[input.part], elements,
      normalizations: [{ rule: 'read-element-list', at: '/element', note: `${list.length} elements of part ${input.part} read one by one in this answer` + (share != null ? `, ${share} bytes each` : '') }],
      continuations: { grammar: { tool: CODE_TOOL, arguments: { lane: input.lane, action: 'grammar', part: input.part }, why: 'the syntax and a from-scratch example of ' + CODE_FORMS[input.part] } } };
  }
  const part = input.part;
  const view = VIEW_OF_PART[part];
  const element = input.element;
  const mapInput = { lane: input.lane, target: input.target ?? input.module, view,
    ...(element != null ? (part === 'html' ? { screen: element } : { element }) : {}),
    ...(input.page != null ? { page: input.page } : {}), ...(input.budgetBytes != null ? { budgetBytes: input.budgetBytes } : {}),
    // The list of the actions pages by offset and max (its continuations.next); includeDetail as ssam_map takes it.
    ...(input.offset != null ? { offset: input.offset } : {}), ...(input.max != null ? { max: input.max } : {}),
    ...(input.includeDetail != null ? { includeDetail: input.includeDetail } : {}),
    ...(input.expectedSourceSha256 != null ? { expectedSourceSha256: input.expectedSourceSha256 } : {}),
    ...(input.keys != null && part === 'html' ? { keys: input.keys } : {}), ...(input.pid != null ? { pid: input.pid } : {}) };
  const answer = await map(mapInput);
  const grammar = { tool: CODE_TOOL, arguments: { lane: input.lane, action: 'grammar', part }, why: 'the syntax and a from-scratch example of ' + CODE_FORMS[part] };
  const value = rewriteCalls(answer);
  if (plain(value)) {
    value.tool = CODE_TOOL; value.part = part; value.form = CODE_FORMS[part];
    if (emptyOf(part, answer)) {
      value.empty = true;
      if (part === 'ddl' && typeof value.text !== 'string') value.text = '';
      value.note = 'this module has no ' + (part === 'ddl' ? 'data' : part === 'logic' ? 'action' : 'screen or block') + ' yet: write it from scratch (grammar has the syntax and an example)';
      value.continuations = { ...(value.continuations ?? {}), grammar };
    } else if (value.ok === false && element != null && NOT_FOUND.test(String(value.error ?? ''))) {
      value.continuations = { ...(value.continuations ?? {}), grammar, write: { tool: CODE_TOOL, arguments: { lane: input.lane, action: 'write', part, module: input.target ?? input.module ?? '<Module>', text: '<the new ' + part + ' text, without keys>' }, why: 'a new element is written without a read' } };
    } else value.continuations = { ...(value.continuations ?? {}), grammar };
    if (part === 'logic' && value.action?.textSha) value.continuations.edit = { tool: CODE_TOOL,
      arguments: { lane: input.lane, action: 'write', part: 'logic', module: input.target ?? input.module, element: value.action.name,
        basedOn: value.action.textSha, edits: [{ replace: '@n1', with: '<the changed line>' }] },
      why: 'change only some lines: each edit names a line of this read by its @id' };
  }
  return value;
}

// ---- write: the op of the part, delivered by the lane's delivery tool
// CX16: edits by exact text of the texts of a refused or checked job (basedOn {job, sha256}) become a JSON Patch over it.
import { jobTextEdits } from './html-edits.mjs';
const isJobBase = b => plain(b) && ((typeof b.job === 'string' && typeof b.sha256 === 'string') || typeof b.taskId === 'string');
const lines = t => String(t ?? '');
const textList = text => (Array.isArray(text) ? text : [text]).map(lines);

// The header of an action text: {name, owner (the screen of a screen or data action, else null), key (null when new)}.
const HEADER = /^[ \t]*(server action|service action|client action|data action|action|preparation)[ \t]+((?:[\w/]+\.)?)([A-Za-z_]\w*)([^\n]*)$/m;
export function headerOf(text) {
  const m = HEADER.exec(lines(text));
  if (!m) return null;
  const owner = m[2] ? m[2].slice(0, -1).split('/').pop() : null;
  const last = m[4].trim().split(/\s+/).filter(Boolean).at(-1) ?? '';
  const key = last.startsWith('@') && !/^@[a-z]\d+$/.test(last) && last !== '@start' ? last.slice(1) : null;
  return { kind: m[1], owner: /^(action|data action|preparation)$/.test(m[1]) ? owner : null, name: m[3], key };
}

// A changed action is sent whole: the read numbers the parameters (@p), locals (@l) and nodes (@n) of an action from 1 in
// print order (FlowPrint.Id), and a line left out is deleted (FlowMerge). A text of an action read (a header with its
// @key) whose ids leave a gap below the highest one it carries left lines out: the ids it lacks, or [] (owner session
// 2026-10-12: header + the changed line + end deleted the aggregate and the if, "accepted").
export function missingIdsOf(text) {
  const header = headerOf(text);
  if (!header?.key) return [];
  const seen = { n: new Set(), p: new Set(), l: new Set() };
  for (const m of lines(text).matchAll(/(?:^|[\s(,>])@([npl])(\d+)\b/g)) seen[m[1]].add(Number(m[2]));
  const missing = [];
  for (const [prefix, set] of Object.entries(seen)) {
    const max = Math.max(0, ...set);
    for (let i = 1; i < max; i++) if (!set.has(i)) missing.push('@' + prefix + i);
  }
  return missing;
}

// on<event>="X()" (and a block's @Event="X()"): the event of an action without arguments is on<event>="X" in ssam-html/1;
// the edit refuses the parentheses (HTML_SCRIPT) where a new document takes them, so ssam_code writes both as the reader does.
export const normalizeEvents = text => lines(text).replace(/(\s(?:on[a-z]+|@[A-Za-z_]\w*)=")\s*([A-Za-z_][\w.]*)\s*\(\s*\)\s*"/g, '$1$2"');

// Words of SQL Server DDL the ssam-ddl/1 reader never writes: refused before the delivery with the form it takes (the kernel
// answers them with "unknown statement ''" or "create what?", which says nothing to a model that never saw the grammar).
const SQL_HINTS = [
  [/^\s*create\s+table\b/i, 'create table: an entity is "create entity <Name> ( ... );"'],
  [/^\s*(CREATE|DROP|ALTER)\b/, 'upper-case keyword: ssam-ddl/1 keywords are lower case (create entity, drop entity)'],
  [/^\s*alter\s+table\b/i, 'alter table: send the entity statement whole (an attribute left out is deleted), or drop <what> <Name>'],
  [/\bprimary\s+key\b/i, 'PRIMARY KEY: the identifier is "Id Long Integer identifier auto required"'],
  [/\bnot\s+null\b/i, 'NOT NULL: an attribute is "required"'],
  // A SQL type in the type position of an attribute, all lower or all upper case ("Money" may be a structure's name).
  [/^\s*[A-Za-z_]\w*\s+(?:(?:n?varchar|nchar|bigint|smallint|tinyint|int|bit|datetime2?|float|money|uniqueidentifier)|(?:N?VARCHAR|NCHAR|BIGINT|SMALLINT|TINYINT|INT|BIT|DATETIME2?|FLOAT|MONEY|UNIQUEIDENTIFIER))\b/, 'SQL type: OutSystems types are Text(120), Integer, Long Integer, Decimal(18,2), Boolean, Date Time, Currency'],
  [/\bauto_increment\b|\bidentity\s*\(/i, 'AUTO_INCREMENT/IDENTITY(): the identifier is "Id Long Integer identifier auto required"'],
];
export function sqlHintsOf(text) {
  const out = [];
  lines(text).split('\n').forEach((raw, i) => {
    const line = raw.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    if (/^\s*(\/\/\/|--)/.test(line)) return;
    const body = line.replace(/\s--\s.*$/, '');
    for (const [re, hint] of SQL_HINTS) if (re.test(body)) { out.push({ line: i + 1, text: raw.trim().slice(0, 120), fix: hint }); break; }
  });
  return out;
}

/** The ops of one text part, or {error}. */
export function opsOfPart({ part, text, basedOn, element, removes, edits, jobText }) {
  // CX16: edits over basedOn {job, sha256} are a correction of that job (writeCall makes them a patch first); edits of a
  // read screen or block are the kernel's html op as they are (flow-edits.mjs checked their shape).
  if (jobText) return { error: 'edits over basedOn {job, sha256} correct that job: give that basedOn to the write itself, with element and edits [{find, with}]' };
  if (!CODE_PARTS.includes(part)) return { error: `part must be one of ${CODE_PARTS.join(', ')}` };
  if (part === 'html' && edits != null && text == null) return !element ? { error: 'edits of a screen need element (the screen or block read)' }
    : plain(basedOn) && typeof basedOn.capture === 'string' && typeof basedOn.html === 'string' ? { op: { op: 'html', data: { screen: element, basedOn, edits } } }
      : { error: 'basedOn of html edits is {capture, html} as the read returned them' };
  if (text == null || (Array.isArray(text) ? !text.length : !String(text).trim())) return { error: `write needs text (the ${CODE_FORMS[part]} code)` };
  if (part === 'ddl') {
    if (Array.isArray(text)) return { error: 'part ddl takes one text with every statement' };
    const sql = sqlHintsOf(text);
    if (sql.length) return { error: 'ssam-ddl/1 is OutSystems DDL, not SQL Server DDL: ' + sql.slice(0, 6).map(h => `line ${h.line} (${h.text}): ${h.fix}`).join('; '), hints: sql };
    return { op: { op: 'spec', data: { ...(typeof basedOn === 'string' ? { basedOn } : {}), ddl: lines(text) } } };
  }
  if (part === 'logic') {
    const texts = textList(text);
    const bases = Array.isArray(basedOn) ? basedOn : basedOn != null ? [basedOn] : [];
    if (bases.length && bases.length !== texts.length) return { error: 'basedOn of logic is one textSha per text, in the same order (null for a new action)' };
    // A gap is refused unless the deletions are meant: removes:true, or the list of the ids left out on purpose.
    const meant = removes === true ? null : new Set(Array.isArray(removes) ? removes.map(r => '@' + String(r).replace(/^@/, '')) : []);
    const gaps = texts.map(t => ({ action: headerOf(t)?.name ?? '?', missing: missingIdsOf(t).filter(id => meant && !meant.has(id)) })).filter(g => g.missing.length);
    if (gaps.length) return { error: 'a changed action is sent WHOLE, as read, with the change: a line left out is deleted. '
      + gaps.map(g => `${g.action} leaves out ${g.missing.join(', ')} of the read`).join('; ')
      + '. Send every line of the read (with its @id) plus your change; only when those lines are meant to be deleted, add removes: true (or removes: [the ids]).', gaps };
    return { op: { op: 'logic', data: { flow: texts.map((t, i) => (bases[i] ? { text: t, basedOn: bases[i] } : t)) } } };
  }
  const document = !Array.isArray(text) && /^\s*(?:<!--[\s\S]*?-->\s*)*<(screen|block)[\s/>]/.test(text);
  if (document && basedOn == null) return { op: { op: 'html', data: { html: normalizeEvents(text) } } };
  if (!element) return { error: 'changing a screen needs element (the screen read) and basedOn {capture, html} of the read; a new screen is a <screen> document without basedOn' };
  if (!plain(basedOn)) return { error: 'basedOn of html is {capture, html} as the read returned them' };
  return { op: { op: 'html', data: { screen: element, basedOn, edit: textList(text).map(normalizeEvents) } } };
}

// The element names a text creates or changes (owners of an ODC delivery).
export function namesOf(part, text) {
  const all = textList(text).join('\n');
  const found = part === 'ddl'
    ? [...all.matchAll(/^\s*(?:create (?:static )?entity|type|site property|setting|client variable|session variable|timer|drop (?:entity|static entity|type|site property|setting|client variable|timer))\s+([A-Za-z_][\w]*)/gm)].map(m => m[1])
    : part === 'logic'
      ? [...all.matchAll(/^(?:server action|service action|client action|data action|action|preparation)\s+(?:[\w/]+\.)?([A-Za-z_][\w]*)/gm)].map(m => m[1])
      : [...all.matchAll(/<(?:screen|block)\s[^>]*?name="([^"]+)"/g)].map(m => m[1]);
  return [...new Set(found)];
}
// The owners of an ODC delivery for one part: the names the text creates or changes, the screen of an html edit and the
// screen of each screen or data action. The bridge tolerates the layout metadata the Studio adds only on a screen or block
// that is an owner (NativeMergeVerification); a screen left out made a merge "uncertain", never repeated.
export function ownersOf(part, text, element) {
  const screens = part === 'logic' ? textList(text).flatMap(t => splitActions(t) ?? [t]).map(t => headerOf(t)?.owner).filter(Boolean) : [];
  // The screen by its name ("MainFlow/Visitas", "MobileScreen:Visitas" -> Visitas); a @key stays as it was given.
  const edited = part === 'html' && typeof element === 'string' && element ? [element.startsWith('@') ? element : element.split(/[/:]/).pop()] : [];
  return [...new Set([...edited, ...screens, ...namesOf(part, text)])];
}
// The parts of a job a refused write ran (its basedOn.job): what the correction of an ODC write owns and changes.
function partsOfJob(job) {
  const ops = Array.isArray(job) ? job : Array.isArray(job?.ops) ? job.ops : [];
  return ops.filter(plain).flatMap(op => {
    const d = plain(op.data) ? op.data : {};
    if (op.op === 'spec' && typeof d.ddl === 'string') return [{ part: 'ddl', text: d.ddl }];
    if (op.op === 'logic' && d.flow != null) return [{ part: 'logic', text: (Array.isArray(d.flow) ? d.flow : [d.flow]).map(f => (plain(f) ? f.text ?? '' : f)) }];
    if (op.op === 'html' && typeof d.html === 'string') return [{ part: 'html', text: d.html }];
    if (op.op === 'html' && typeof d.screen === 'string') return [{ part: 'html', text: [], element: d.screen }];
    return [];
  });
}
const declaredOpNames = ops => ops.filter(plain).flatMap(op => [
  ...(op.op === 'create' && typeof op.name === 'string' ? [op.name] : []),
  ...(Array.isArray(op.data?.actions) ? op.data.actions.map(a => a?.name).filter(n => typeof n === 'string') : []),
]);
function namesOfOps(ops) {
  const normalized = normalizeCodeOps(ops).job;
  return [...declaredOpNames(normalized), ...partsOfJob(normalized).flatMap(p => namesOf(p.part, p.text))];
}
function ownersOfOps(ops) {
  const normalized = normalizeCodeOps(ops).job;
  return [...declaredOpNames(normalized), ...partsOfJob(normalized).flatMap(p => ownersOf(p.part, p.text, p.element))];
}
const readJobFile = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));

// Delivery options each lane's tool takes, passed through as they are.
const O11_OPTIONS = ['checks', 'until', 'producers', 'captureProducers', 'expectedEnvironment', 'closePrevious', 'publish', 'authorize', 'resume'];
const ODC_OPTIONS = ['feature', 'owners', 'changes', 'output', 'until', 'publish', 'authorize', 'producer', 'producers', 'tenant', 'pid'];

// An html edit of an existing screen in this write (by screen name), or null.
const isHtmlEdit = p => p?.part === 'html' && (p.edits != null || Array.isArray(p.text) || p.basedOn != null || !DOCUMENT_TEXT.test(lines(p.text)));
// A new screen or data action (a header without @key, "action <Screen>.X" / "data action <Screen>.X").
const newScreenAction = t => { const h = headerOf(t); return !!h && h.owner != null && h.key == null; };

// ---- the part of a text by its form, and several documents in one text (call shapes of one meaning, 2026-10-12)
// The leading description and comment lines of a text (///, //, --, <!-- -->) say nothing of its form.
const withoutLeadingComments = t => lines(t).replace(/^(?:\s*(?:\/\/\/?[^\n]*|--[^\n]*|<!--[\s\S]*?-->)\s*\n)*/, '');
const DDL_START = /^\s*(?:create\s+(?:unique\s+)?(?:static\s+|client\s+)?(?:entity|index|table)\b|type\s+[A-Za-z_]\w*(?:\s+public)?\s*=|site\s+property\s|setting\s|client\s+variable\s|session\s+variable\s|timer\s|drop\s|alter\s+table\b)/i;
/** The part a text is written in by its form: markup is html, an action header is logic, a data statement is ddl; null otherwise. */
export function formOfText(text) {
  const t = withoutLeadingComments(text);
  if (!t.trim()) return null;
  if (/^\s*</.test(t)) return 'html';
  if (HEADER.test(t.split('\n').find(l => l.trim()) ?? '')) return 'logic';
  if (DDL_START.test(t)) return 'ddl';
  return null;
}
/** The one part of a text or list of texts (every text in the same form), or null. */
export function partOfText(text) {
  const forms = new Set(textList(text).filter(t => t.trim()).map(formOfText));
  return forms.size === 1 && !forms.has(null) ? [...forms][0] : null;
}
// The end of the element that opens at `at` (a root <screen ...> or <block ...>): the index after its closing tag, or -1.
// Quoted attribute values and comments are skipped; the same tag nested inside counts.
function documentEnd(s, at, tag) {
  let depth = 0, i = at;
  while (i < s.length) {
    if (s.startsWith('<!--', i)) { const e = s.indexOf('-->', i + 4); if (e < 0) return -1; i = e + 3; continue; }
    if (s[i] !== '<') { i++; continue; }
    const close = s.startsWith('</' + tag, i) && /[\s>]/.test(s[i + 2 + tag.length] ?? '');
    const open = !close && s.startsWith('<' + tag, i) && /[\s/>]/.test(s[i + 1 + tag.length] ?? '');
    if (!open && !close) { i++; continue; }
    // To the end of the tag, past quoted values.
    let j = i + 1, quote = null;
    for (; j < s.length; j++) { const c = s[j]; if (quote) { if (c === quote) quote = null; } else if (c === '"' || c === "'") quote = c; else if (c === '>') break; }
    if (j >= s.length) return -1;
    if (open && s[j - 1] !== '/') depth++;
    else if (close) depth--;
    i = j + 1;
    if (depth === 0) return i;
  }
  return -1;
}
/** The documents of a text that holds two or more <screen>/<block> documents one after the other; null otherwise. */
export function splitDocuments(text) {
  const s = lines(text);
  const out = []; let at = 0;
  const start = /(\s*(?:<!--[\s\S]*?-->\s*)*)<(screen|block)(?=[\s/>])/y;
  while (s.slice(at).trim()) {
    start.lastIndex = at;
    const m = start.exec(s);
    if (!m) return null;
    const end = documentEnd(s, at + m[1].length, m[2]);
    if (end < 0) return null;
    out.push(s.slice(at, end).replace(/^\s*\n/, '')); at = end;
  }
  return out.length >= 2 ? out.map(d => d.trim() + '\n') : null;
}

// Only column-zero headers start an action. The description (including blank lines before the header) belongs below.
const ACTION_HEAD = /^(?:server action|service action|client action|data action|action|preparation)[ \t]+\S/;
export function splitActions(text, { preserveWhitespace = false } = {}) {
  const source = lines(text).replace(/\r\n/g, '\n');
  const ls = source.split('\n');
  const starts = [];
  ls.forEach((line, i) => {
    if (!ACTION_HEAD.test(line)) return;
    let start = i;
    while (start > 0 && (/^\/\/\/( |$)/.test(ls[start - 1]) || !ls[start - 1].trim())) start--;
    while (!ls[start].trim()) start++;
    starts.push(start);
  });
  if (starts.length < 2) return null;
  // Reader exports put an extra newline after each action; retain those separators when checking a lossless round trip.
  // Writes use the canonical action texts below (the same bytes as separate per-action inputs).
  if (preserveWhitespace) {
    const offsets = []; let offset = 0;
    for (const line of ls) { offsets.push(offset); offset += line.length + 1; }
    return starts.map((start, i) => source.slice(i ? offsets[start] : 0, starts[i + 1] == null ? source.length : offsets[starts[i + 1]]));
  }
  return starts.map((start, i) => ls.slice(i ? start : 0, starts[i + 1] ?? ls.length).join('\n').replace(/^\s*\n/, '').trimEnd() + '\n');
}

const CODE_FILE_PARTS = { '.ddl': 'ddl', '.sql': 'ddl', '.flow': 'logic', '.logic': 'logic', '.html': 'html', '.htm': 'html', '.txt': null, '.json': 'ops' };
/** Read every file before delivery, collecting all independent input problems with its original file index. */
export function readCodeFiles(files) {
  const parts = [], problems = [], notes = [];
  if (files == null) return { parts, problems, notes };
  if (!Array.isArray(files) || !files.length || files.length > CODE_LIST_MAX) {
    problems.push({ at: 'files', error: `files must be a list of 1 to ${CODE_LIST_MAX} absolute paths` });
    return { parts, problems, notes };
  }
  files.forEach((file, i) => {
    const at = `files/${i}`;
    const problem = error => problems.push({ at, error });
    const absolute = typeof file === 'string' && path.isAbsolute(file);
    if (!absolute) problem('file path must be absolute');
    const ext = typeof file === 'string' ? path.extname(file).toLowerCase() : '';
    const known = Object.hasOwn(CODE_FILE_PARTS, ext);
    if (!known) problem(`unsupported file extension: ${ext || '(none)'}`);
    // Never read a relative path or an unrecognized file type.
    if (!absolute || !known) return;
    let text;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) { problem('path is not a file'); return; }
      if (stat.size > CODE_FILE_MAX_BYTES) { problem(`file exceeds ${CODE_FILE_MAX_BYTES} bytes`); return; }
      text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    } catch (error) { problem(`cannot read file: ${error.code ?? error.message}`); return; }
    if (!text.trim()) { problem('file is empty'); return; }
    let part = CODE_FILE_PARTS[ext];
    if (part === 'ops') {
      let value;
      try { value = JSON.parse(text); } catch { problem('file is not valid JSON'); return; }
      const ops = Array.isArray(value) ? value : plain(value) ? value.ops : null;
      if (!Array.isArray(ops) || !ops.every(op => plain(op) && typeof op.op === 'string' && op.op.trim())) {
        problem('JSON must be a list of job ops or {ops:[...]}, each with an op name'); return;
      }
      parts.push({ part, ops, at });
    } else {
      const form = partOfText(text);
      if (part == null) part = form;
      else if (form != null && form !== part) { problem(`${ext} declares part ${part}, but the text is ${form}`); return; }
      if (part == null) { problem('cannot determine the part of the text (.txt needs ddl, logic or html)'); return; }
      parts.push({ part, text, at });
    }
    const count = part === 'logic' ? (splitActions(text)?.length ?? 1) : null;
    notes.push({ rule: 'files', at: '/' + at, note: `${path.basename(file)}: part ${part}${count ? `, ${count} actions` : ''}` });
  });
  return { parts, problems, notes };
}
// The block names a document defines and instantiates (<block name="X"> / <Block name="X">).
const blockDefined = t => /^\s*(?:<!--[\s\S]*?-->\s*)*<block\s[^>]*?\bname="([^"]+)"/.exec(lines(t))?.[1]?.toLowerCase() ?? null;
const blocksUsed = t => [...lines(t).matchAll(/<Block\s[^>]*?\bname="([^"]+)"/g)].map(m => m[1].toLowerCase());
// The actions a timer statement of a data text names (timer T action A ...).
const timerActions = t => [...lines(t).matchAll(/^\s*timer\s+[A-Za-z_]\w*\b[^\n]*?\baction\s+([A-Za-z_]\w*)/gm)].map(m => m[1].toLowerCase());
// Whether a data text drops something (a drop statement), and whether it has any other statement (a create, a type, a keyed
// statement that may add to an element): the statements start a line, comments aside.
const ddlStatements = t => lines(t).split('\n').map(l => l.replace(/--.*$/, '').trim()).filter(l => l && !/^[),;]/.test(l));
const dropsOf = t => ddlStatements(t).some(l => /^drop\s/i.test(l));
const othersOf = t => ddlStatements(t).some(l => /^(?:create|type|site\s+property|setting|client\s+variable|session\s+variable|timer|alter)\b/i.test(l));
// The part words a model writes for each part (one meaning each).
export const PART_SYNONYMS = { ddl: ['ddl', 'data', 'sql', 'schema', 'database', 'db', 'entity', 'entities', 'table', 'tables', 'ssam-ddl', 'ssam-ddl/1'],
  logic: ['logic', 'flow', 'flows', 'pseudocode', 'actions', 'ssam-flow', 'ssam-flow/1'],
  html: ['html', 'screen', 'screens', 'ui', 'page', 'pages', 'block', 'blocks', 'ssam-html', 'ssam-html/1'] };
export const canonicalPart = word => (typeof word !== 'string' ? null : Object.entries(PART_SYNONYMS).find(([, ws]) => ws.includes(word.trim().toLowerCase()))?.[0] ?? null);

/**
 * The parts of a write in the order the delivery needs them (one meaning: the order of the parts in a call never carries
 * the person's intent, the dependencies do): the data first (unless a timer of it names an action this write creates),
 * then new blocks (a block another one uses first), then new screens, then the actions and the screen edits as given.
 * Returns {parts, moved}.
 */
export function orderParts(parts) {
  // Integration 24-1 familias (review): removal goes the other way of creation. A data text that only drops goes after the
  // parts that change its consumers (the action rewritten without Foo.Bar, the screen edit that stops showing it): before
  // them, the delete still sees those consumers (DELETE_HAS_CONSUMERS) and the order the model wrote would have passed. A
  // data text that drops and also creates or changes has two places (its creations first, its drops last): two readings, so
  // the write keeps the order it was given (nothing is moved).
  const ddl = parts.filter(p => p.part === 'ddl').map(p => ({ p, drops: dropsOf(p.text), other: othersOf(p.text) }));
  if (ddl.some(d => d.drops && d.other)) return { parts, moved: false };
  const dropsOnly = new Set(ddl.filter(d => d.drops).map(d => d.p));
  const newActions = new Set(parts.filter(p => p.part === 'logic').flatMap(p => textList(p.text).map(headerOf).filter(h => h && h.key == null).map(h => h.name.toLowerCase())));
  const rank = p => (p.part === 'ddl' ? (dropsOnly.has(p) ? 4 : timerActions(p.text).some(a => newActions.has(a)) ? 3 : 0)
    : p.part === 'html' && !isHtmlEdit(p) ? (blockDefined(p.text) ? 1 : 2) : p.part === 'ops' ? 2.5 : 3);
  const ranked = parts.map((p, i) => ({ p, i, r: rank(p) })).sort((a, b) => a.r - b.r || a.i - b.i);
  // Blocks: one that another block of this write instantiates goes first.
  const blocks = ranked.filter(x => x.r === 1);
  const done = new Set(); const sortedBlocks = [];
  while (blocks.length) {
    const defined = new Set(blocks.map(x => blockDefined(x.p.text)));
    const ready = blocks.findIndex(x => blocksUsed(x.p.text).every(b => !defined.has(b) || b === blockDefined(x.p.text) || done.has(b)));
    const [next] = blocks.splice(ready < 0 ? 0 : ready, 1);
    sortedBlocks.push(next); done.add(blockDefined(next.p.text));
  }
  const ordered = [...ranked.filter(x => x.r === 0), ...sortedBlocks, ...ranked.filter(x => x.r > 1)];
  return { parts: ordered.map(x => x.p), moved: ordered.some((x, i) => x.i !== i) };
}

/** The delivery call of a write: {tool, arguments, normalizations?} for o11_deliver / studio_deliver, or {refusal}. deps.readJob reads a job file. */
export function writeCall(input, { readJob = readJobFile, readReading = loadFlowReading, origins: includeOrigins = false } = {}) {
  const lane = input.lane === 'o11' ? 'o11' : 'odc';
  const module = input.module ?? input.target;
  const tool = lane === 'o11' ? 'o11_deliver' : 'studio_deliver';
  const refuse = (error, extra = {}) => ({ refusal: { ok: false, code: 'INPUT_INVALID', tool: CODE_TOOL, error, ...extra,
    continuation: { tool: CODE_TOOL, arguments: { lane, action: 'grammar', ...(canonicalPart(input.part) ? { part: canonicalPart(input.part) } : {}) }, why: 'the syntax and a from-scratch example' } } });
  const normalizations = [];
  const note = (rule, at, text) => normalizations.push({ rule, at, note: text });
  const origins = [];
  const sourceOf = (at, op) => {
    const fileIndex = /^files\/(\d+)$/.exec(at)?.[1];
    const source = { at, ...(fileIndex != null ? { file: input.files[Number(fileIndex)] } : {}) };
    if (Array.isArray(op?.data?.flow)) {
      source.actions = op.data.flow.flatMap(t => splitActions(t) ?? [t]).map(t => headerOf(t)?.name ?? null);
      source.flows = source.actions.map(action => ({ at: source.at, ...(source.file ? { file: source.file } : {}), ...(action ? { action } : {}) }));
    }
    return source;
  };
  const withNotes = call => ({ ...call, ...(normalizations.length ? { normalizations } : {}), ...(includeOrigins ? { origins } : {}) });
  if (!module || typeof module !== 'string') return refuse('write needs module (the module open in the Studio of the lane, or its app name)');
  if (lane === 'o11' && input.until != null && !['apply', 'merge'].includes(input.until)) return refuse('until on o11 is apply or merge');
  if (lane === 'odc' && input.until === 'apply') return refuse('until on odc is snapshot, build, check-base, preview or merge');
  const options = {};
  for (const k of lane === 'o11' ? O11_OPTIONS : ODC_OPTIONS) if (input[k] !== undefined) options[k] = input[k];
  // CX16 (html-edits.mjs): edits of the texts of the job of basedOn {job, sha256} are one refusal, or this write as a patch
  // generated over that job (the patch route below), with what each edit changed in normalizations.
  const textEdits = jobTextEdits(input);
  if (textEdits) return textEdits.problems ? refuse(textEdits.error, { problems: textEdits.problems }) : (call => (call.refusal ? call : { ...call, normalizations: [...textEdits.notes, ...(call.normalizations ?? [])] }))(writeCall(textEdits.input, { readJob, readReading, origins: includeOrigins }));
  // A correction of a refused write: patch (and/or a partial job) over basedOn {job, sha256} of the refusal.
  const jobBase = isJobBase(input.basedOn) ? input.basedOn : null;
  const hasEdits = input.edits != null || Array.isArray(input.also) && input.also.some(p => p?.edits != null);
  // R1 (loop-correcao): fix "apply" over the nextBasedOn of a refused write: the delivery applies the refusal's own patches.
  if (input.fix === 'apply' && !jobBase) return refuse('fix "apply" goes with basedOn {job, sha256}: the nextBasedOn of the refused write');
  if (input.fix === 'apply' && lane === 'o11') return { tool, arguments: { module, ...options, fix: 'apply', basedOn: jobBase, ...(Array.isArray(input.patch) ? { patch: input.patch } : {}) } };
  if ((input.patch != null || input.fix === 'apply') && !hasEdits) {
    if (input.files != null) return refuse('files cannot be used with patch: a correction is patch + basedOn', { problems: [{ at: 'files', error: 'files cannot be used with patch' }] });
    if (!jobBase) return refuse('patch goes with basedOn {job, sha256} (the nextBasedOn of the refused write) or {taskId}');
    if (lane === 'o11') return { tool, arguments: { module, ...options, patch: input.patch, basedOn: jobBase, ...(options.until == null ? { until: 'merge' } : {}) } };
    // ODC: studio_deliver needs owners and changes: those of the refused write (its job), unless given.
    let base = [];
    if ((!options.owners || !options.changes) && typeof jobBase.job === 'string') { try { base = partsOfJob(readJob(jobBase.job)); } catch { base = []; } }
    const owners = options.owners ?? [...new Set(base.flatMap(p => ownersOf(p.part, p.text, p.element)))];
    const changes = options.changes ?? base.map(p => `${p.part} corrected as ${CODE_FORMS[p.part]}` + (namesOf(p.part, p.text).length ? ': ' + namesOf(p.part, p.text).join(', ') : p.element ? ': ' + p.element : ''));
    if (!owners.length || !changes.length) return refuse('a correction on odc needs owners and changes: give them as the refused write had them (owners: [the screens, actions and entities written], changes: [what changes]); the job of basedOn could not be read');
    const parts = [...new Set(base.map(p => p.part))];
    return { tool, arguments: { module, feature: options.feature ?? 'ssam_code ' + (canonicalPart(input.part) ?? (parts.join('+') || 'code')) + ' (correction)', owners, changes,
      ...Object.fromEntries(Object.entries(options).filter(([k]) => !['feature', 'owners', 'changes'].includes(k))), ...(input.patch != null ? { patch: input.patch } : {}), ...(input.fix === 'apply' ? { fix: 'apply' } : {}), basedOn: jobBase } };
  }
  const problems = [];
  if (input.patch != null && hasEdits) problems.push({ at: 'patch', error: 'patch and edits cannot be combined: correct the refused job with patch, or edit a read action with its textSha' });
  const ops = [];
  if (input.ops != null) {
    if (!Array.isArray(input.ops)) problems.push({ at: 'ops', error: 'ops is a list of job ops placed before the code' });
    else { ops.push(...input.ops); if (includeOrigins) origins.push(...input.ops.map(op => sourceOf('ops', op))); }
  }
  const files = readCodeFiles(input.files);
  problems.push(...files.problems);
  normalizations.push(...files.notes);
  const hasText = p => p != null && p.text != null && (Array.isArray(p.text) ? p.text.some(t => String(t ?? '').trim()) : String(p.text).trim() !== '');
  const given = [{ part: input.part, text: input.text, edits: input.edits, basedOn: jobBase && input.edits == null ? undefined : input.basedOn, element: input.element, removes: input.removes, at: 'text' },
    ...(Array.isArray(input.also) ? input.also.map((p, i) => ({ ...p, at: `also/${i}` })) : []), ...files.parts];
  for (let i = 0; i < given.length; i++) {
    const p = given[i];
    if (p.edits != null) {
      const expanded = expandEditPart({ ...p, module }, lane, { readReading });
      problems.push(...expanded.problems); normalizations.push(...expanded.notes); given[i] = expanded.part;
    } else if (p.at.startsWith('also/') && !hasText(p)) problems.push({ at: p.at, error: `${p.at}: text or edits` });
  }
  // No text at all, only ops (or only other parts in also): the ops (and those parts) are the delivery; a part named
  // without a text says nothing to deliver.
  if (!hasText(given[0]) && given[0]?.edits == null) {
    if (ops.length || given.length > 1 || problems.length) {
      given.shift();
      if (!given.length && ops.length) note('write-ops-alone', '/ops', `no text: the ${ops.length} op(s) are the job` + (input.part != null ? ` (part ${input.part} names no text)` : ''));
    } else if (canonicalPart(given[0]?.part) == null) return refuse('write needs text (the code of a part: ddl, logic or html) or ops');
  }
  let parts = [];
  const partPath = at => (at === 'text' ? '/part' : '/' + at + '/part');
  for (const p of given) {
    if (!p) continue;
    if (p.part === 'ops') { parts.push(p); continue; }
    let part = canonicalPart(p.part);
    if (p.part != null && part && part !== p.part) note('part-synonym', partPath(p.at), `"${p.part}" is part ${part}`);
    if (part == null && p.part != null) { problems.push({ at: p.at, error: `part "${p.part}" is none of ddl, logic, html` }); continue; }
    if (part == null && hasText(p)) {
      part = partOfText(p.text);
      if (part) note('part-from-text', partPath(p.at), `the text is ${CODE_FORMS[part]} by its form: part ${part}`);
      else { problems.push({ at: p.at, error: 'part: the text is not ddl (create entity ..., type X = {...}, client variable ...), logic (an action header) or html (markup) by its form, or mixes them; give part: ddl, logic or html' }); continue; }
    }
    if (part === 'logic') {
      const texts = textList(p.text);
      const bases = Array.isArray(p.basedOn) ? p.basedOn : p.basedOn != null ? [p.basedOn] : [];
      let changed = false;
      const expanded = texts.flatMap((text, i) => {
        const split = splitActions(text);
        if (!split) return [{ text, base: bases[i] ?? null }];
        changed = true;
        if (bases[i] != null) problems.push({ at: p.at, error: `text ${i + 1} holds ${split.length} actions and one basedOn: send one text per action, each with its textSha` });
        note('logic-split', '/' + p.at, `text ${i + 1} holds ${split.length} actions: ${split.length} texts`);
        return split.map(text => ({ text, base: null }));
      });
      if (changed) {
        if (bases.length && bases.length !== texts.length) problems.push({ at: p.at, error: 'basedOn of logic is one textSha per text, in the same order (null for a new action)' });
        parts.push({ ...p, part, text: expanded.map(x => x.text), basedOn: bases.length ? expanded.map(x => x.base) : undefined });
        continue;
      }
    }
    // A list of <screen>/<block> documents (or several documents in one text) without basedOn: each one a new document.
    if (part === 'html' && p.basedOn == null) {
      const list = Array.isArray(p.text) ? p.text.map(lines) : null;
      const docs = list && list.length > 1 && list.every(t => DOCUMENT_TEXT.test(t)) ? list.flatMap(t => splitDocuments(t) ?? [t])
        : list && list.length === 1 && DOCUMENT_TEXT.test(list[0]) ? splitDocuments(list[0]) ?? [list[0]]
          : !list ? splitDocuments(p.text) : null;
      if (docs) {
        if (docs.length > 1) note('html-document-list', '/' + p.at, `${docs.length} <screen>/<block> documents, each one a new screen or block`);
        else if (list) note('html-document-list', '/' + p.at, 'a list with one <screen>/<block> document is that document');
        for (const d of docs) parts.push({ ...p, part, text: d });
        continue;
      }
    }
    parts.push({ ...p, part });
  }
  for (const p of parts) {
    if (p.part === 'ops') continue;
    const r = opsOfPart(p); if (r.error) problems.push({ at: p.at, error: r.error, ...(r.gaps ? { gaps: r.gaps } : {}), ...(r.hints ? { hints: r.hints } : {}) });
  }
  if (problems.length) return refuse(problems.map(p => p.at + ': ' + p.error).join(' | '), { problems, ...(normalizations.length ? { normalizations } : {}) });
  const sorted = orderParts(parts);
  if (sorted.moved) note('parts-order', '/also', 'written as ' + sorted.parts.map(p => p.part + (p.part === 'html' ? (isHtmlEdit(p) ? ' edit' : ' document') : '')).join(', ')
    + ': the data first, then new blocks and screens, then the actions and the screen edits, then a data text that only drops');
  parts = sorted.parts;
  // A new screen action and the change of its screen in one write: the action first, so the button that names it
  // resolves (HTML_NAME_UNKNOWN otherwise); the edit then rebases over the screen the action changed. A new <screen>
  // document keeps its place before its actions (the screen must exist first).
  const editedScreens = parts.filter(isHtmlEdit).map(p => String(p.element ?? ''));
  // The screen of an edit by name ("Espelho", "MainFlow/Espelho", "MobileScreen:Espelho"); a @key matches any screen.
  const screenName = e => e.split(/[/:]/).pop().toLowerCase();
  const editsScreen = owner => editedScreens.some(e => e.startsWith('@') || screenName(e) === owner.toLowerCase());
  const early = [];
  const ordered = parts.map(p => {
    if (!editedScreens.length || p?.part !== 'logic') return p;
    const bases = Array.isArray(p.basedOn) ? p.basedOn : p.basedOn != null ? [p.basedOn] : [];
    const pairs = textList(p.text).map((t, i) => ({ t, b: bases[i] ?? null, first: newScreenAction(t) && editsScreen(headerOf(t).owner) }));
    if (!pairs.some(x => x.first)) return p;
    early.push({ ...p, text: pairs.filter(x => x.first).map(x => x.t), basedOn: undefined });
    const rest = pairs.filter(x => !x.first);
    return rest.length ? { ...p, text: rest.map(x => x.t), basedOn: bases.length ? rest.map(x => x.b) : undefined } : null;
  });
  const built = [];
  const builtOrigins = [];
  const append = (op, at) => { built.push(op); if (includeOrigins) builtOrigins.push(sourceOf(at, op)); };
  for (const p of ordered) {
    if (!p) continue;
    if (early.length && isHtmlEdit(p)) { for (const e of early.splice(0)) append(opsOfPart(e).op, e.at); }
    if (p.part === 'ops') { for (const op of p.ops) append(op, p.at); continue; }
    append(opsOfPart(p).op, p.at);
  }
  ops.push(...built);
  if (includeOrigins) origins.push(...builtOrigins);
  // Actions from different files may call one another: the kernel orders their creation within a single flow op.
  const flowOnly = op => op?.op === 'logic' && plain(op.data) && Object.keys(op.data).length === 1 && Array.isArray(op.data.flow);
  let merged = 0;
  for (let i = 1; i < ops.length;) {
    if (flowOnly(ops[i - 1]) && flowOnly(ops[i])) {
      ops[i - 1] = { ...ops[i - 1], data: { flow: [...ops[i - 1].data.flow, ...ops[i].data.flow] } };
      if (includeOrigins) {
        origins[i - 1] = { ...origins[i - 1], actions: [...origins[i - 1].actions, ...origins[i].actions], flows: [...origins[i - 1].flows, ...origins[i].flows] };
        origins.splice(i, 1);
      }
      ops.splice(i, 1); merged++;
    } else i++;
  }
  if (merged) note('logic-merge', '/ops', `${merged} adjacent logic flow op(s) merged, preserving group and text order`);
  const partNamesOf = p => p.part === 'ops' ? namesOfOps(p.ops) : namesOf(p.part, p.text);
  const partOwnersOf = p => p.part === 'ops' ? ownersOfOps(p.ops) : ownersOf(p.part, p.text, p.element);
  const names = [...new Set(parts.flatMap(partNamesOf))];
  const owners = [...new Set(parts.flatMap(partOwnersOf))];
  const job = { ops };
  if (lane === 'o11') return withNotes({ tool, arguments: { module, job, until: 'merge', ...options, ...(jobBase ? { basedOn: jobBase } : {}) } });
  const partNames = [...new Set(parts.map(p => p.part))];
  return withNotes({ tool, arguments: { module, job,
    feature: options.feature ?? ('ssam_code ' + (partNames.join('+') || 'ops') + (names.length ? ': ' + names.slice(0, 4).join(', ') : '')),
    owners: options.owners ?? (owners.length ? owners : [module]),
    changes: options.changes ?? (parts.length ? parts.map(p => (p.part === 'ops' ? `${p.ops.length} job op(s)` : `${p.part} written as ${CODE_FORMS[p.part]}`) + (partOwnersOf(p).length ? ': ' + partOwnersOf(p).join(', ') : ''))
      : [`${ops.length} job op(s)`]),
    ...Object.fromEntries(Object.entries(options).filter(([k]) => !['feature', 'owners', 'changes'].includes(k))),
    ...(jobBase ? { basedOn: jobBase } : {}) } });
}

// ---- what a delivered text removed (the kernel's apply results): every node, parameter or local an action text left out
// and every screen element an html edit left out of its parent. Read by the delivery answers (o11-cycle deliveryFields,
// kernel-delivery) so a deletion is never silent.
export function removedOf(results) {
  const out = [];
  for (const r of Array.isArray(results) ? results : []) {
    if (r?.op === 'logic' && Array.isArray(r.result?.flow)) {
      // An action this write created (new, or the shell of a new screen it filled) had nothing of the person's to remove:
      // the nodes of its shell are not a deletion (owner session 2026-10-12: 96 "removed" @n1, one per new action).
      for (const f of r.result.flow) if (Array.isArray(f?.deleted) && f.deleted.length && f.new !== true && f.filledShell !== true)
        out.push({ part: 'logic', action: f.owner ? `${f.owner}.${f.action}` : f.action, deleted: f.deleted.map(String) });
    } else if (r?.op === 'html' && Array.isArray(r.result?.ops)) {
      const deleted = r.result.ops.filter(o => o?.op === 'delete' && o.k).map(o => o.k + (o.kind ? ' (' + o.kind + ')' : ''));
      if (deleted.length) out.push({ part: 'html', screen: r.result.screen ?? r.result.root ?? null, deleted });
    }
  }
  return out;
}

// ---- the tool
export const CODE_DESCRIPTION = 'Read and write an OutSystems module AS CODE, both lanes (O11 and ODC), with the SAME word for reading and '
  + 'writing: part "ddl" = the data as SQL DDL (entities, static entities with records, structures as type X = {...}, indexes, '
  + 'site properties/settings, client variables, timers; ssam-ddl/1), part "logic" = actions as pseudocode (server/client/screen/data '
  + 'actions with aggregates, if, assign, raise...; ssam-flow/1), part "html" = screens and blocks as HTML (ssam-html/1). '
  + 'action "grammar" {part?}: the syntax and a from-scratch example (needs no module; start here for an EMPTY module or new elements; '
  + 'it is not SQL Server DDL: create entity, not CREATE TABLE). '
  + 'action "read" {target, part, element?, page?, offset?}: the part as code with an @key/@id/k on every element, its basedOn '
  + '(sourceSha256, textSha, {capture, html}) and the ready write in continuations; an empty module reads as an empty document. '
  + 'action "check" {module, files|text|also|ops, base?}: checks the same write job on the newest capture, without Studio or merge, safely in parallel. '
  + 'action "plan" {module, items, shared?, ops?, workers?}: for six or more elements, splits work into balanced parallel batches with prompt files, context and checks. '
  + 'action "write" {module, part?, text?, edits?, files?, basedOn?, element?, also?, ops?}: delivers the code through the lane\'s own delivery '
  + '(o11_deliver / studio_deliver: one call, validated before any change, journal, gates and authorization words; publish:true '
  + 'with the user\'s words in authorize publishes after a clean merge). What to send: ddl, only the statements that change; '
  + 'logic, each changed action WHOLE as read with the change (a line left out is DELETED; a text with a gap in its ids is '
  + 'refused unless removes:true); html, only the changed elements of a screen, each whole with its k. Without a key a statement, '
  + 'action or element is new; with its key it is changed in place. also [{part, text, basedOn?}] writes other parts in the same '
  + 'delivery. logic: edits:[...] with element and basedOn changes only the lines named by their @id (the rest of the read is kept). html: edits:[{set|replace|delete|after|before|into|move:k,...},{find,with}] with element and basedOn {capture, html} changes only those elements; a refused or checked job: basedOn {job, sha256}, element and edits [{find, with}]. A new screen action ("action <Screen>.X") goes before the change of its screen and after a new <screen> document '
  + '(ssam_code orders them); ops are raw job ops before the code (a role, an exception). A screen and a screen action need a '
  + 'module with a UI flow. With subagents, each writes its own UTF-8 file; ONE write with files:[absolute paths] sends all parts, never copying their text. A text or file may hold several actions: ssam_code splits them. An empty or _CS '
  + 'module takes data and server actions. The answer names what the write removed '
  + '(removed). A refusal comes ONCE with every problem and the checked patches: correct with patch + basedOn {job, sha256} '
  + '(its nextBasedOn), never the whole text again. A call shape with one meaning is taken as meant and listed in '
  + 'normalizations, never refused: part from the form of the text, a list of <screen> documents in text (each a new screen), '
  + 'html/ddl/logic/code as the text field, screen as element, also items as plain texts, ops alone, the parts in the order the '
  + 'delivery needs (data, new blocks and screens, actions, screen edits), a list of screens to read. ssam_map views '
  + 'ddl/flow/html and the job ops spec+ddl, logic+flow, html are the same engine under their old names.';

// A refused write in the words of ssam_code: the syntax refusals of a text (DDL_*, FLOW_*, HTML_*, SPEC_SYNTAX) gain the
// grammar continuation, the old read paths they name become ssam_code read, and the hints the kernel's words lack.
const TEXT_CODE = /^(DDL_|FLOW_|HTML_|SPEC_|LOGIC_)/;
const OLD_READS = [
  [/ssam_map\s*\{?\s*view\s*[:=]?\s*\\?"?ddl\\?"?(?:\s*\})?/gi, 'ssam_code read (part ddl)'],
  [/ssam_map\s*\{?\s*view\s*[:=]?\s*\\?"?(?:flow|logic)\\?"?(?:\s*\})?/gi, 'ssam_code read (part logic)'],
  [/ssam_map\s*\{?\s*view\s*[:=]?\s*\\?"?html\\?"?(?:\s*\})?/gi, 'ssam_code read (part html)'],
  [/docs\/TEXTO-LOGICA\.md/g, 'ssam_code grammar (part logic)'],
  [/docs\/TEXTO-(?:DADOS|DDL)\.md/g, 'ssam_code grammar (part ddl)'],
  [/docs\/TEXTO-(?:TELAS|HTML)\.md/g, 'ssam_code grammar (part html)'],
];
const WORD_HINTS = [
  [/create what\?/i, ' (a table is an entity: create entity <Name> ( ... );)'],
  [/unknown statement ''/i, ' (statements are lower case: create entity, create static entity, type, create index)'],
  [/unknown attribute clause ''/i, ' (an attribute is "Name Type [identifier] [auto] [required] [default v]"; the identifier is "Id Long Integer identifier auto required")'],
];
function inCodeWords(value, depth = 0) {
  if (typeof value === 'string') {
    let s = value;
    for (const [re, to] of OLD_READS) s = s.replace(re, to);
    for (const [re, hint] of WORD_HINTS) if (re.test(s) && !s.includes(hint.trim())) s = s.replace(re, m => m + hint);
    return s;
  }
  if (depth > 6 || value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => inCodeWords(v, depth + 1));
  // Paths, hashes and calls stay as they are; only the words a model reads are rewritten.
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, ['error', 'message', 'fix', 'problems', 'refusal', 'why', 'hint', 'note', 'details', 'diagnostics', 'validationErrors'].includes(k) || typeof k === 'string' && /^\d+$/.test(k) ? inCodeWords(v, depth + 1) : v]));
}
const codesOf = value => [value?.code, ...(Array.isArray(value?.problems) ? value.problems.map(p => p?.code) : [])].filter(c => typeof c === 'string');
/** A delivery's answer to a ssam_code write, in the words of ssam_code (pure; the value of the MCP result). */
export function codeAnswer(value, { lane, part }) {
  if (!plain(value) || value.ok !== false) return value;
  const textual = codesOf(value).some(c => TEXT_CODE.test(c)) || /ssam-(ddl|flow|html)\/1|line \d+( col \d+)?:/i.test(String(value.error ?? ''));
  if (!textual) return value;
  const out = inCodeWords(value);
  const grammar = { tool: CODE_TOOL, arguments: { lane, action: 'grammar', ...(part ? { part } : {}) }, why: 'the syntax and a from-scratch example of ' + (CODE_FORMS[part] ?? 'the code') };
  out.continuations = { ...(plain(out.continuations) ? out.continuations : {}), grammar };
  return out;
}

/**
 * Registers ssam_code. deps: {fromJsonSchema, map(input) -> moduleMap answer, deliver(tool, args, ctx) -> MCP result}.
 * deliver runs the registered handler of o11_deliver / studio_deliver on this server (the same path as calling them).
 */
export const planHint = (lane, module = '<Module>') => ({ when: '≥ 6 elements', call: { tool: CODE_TOOL, arguments: { lane, action: 'plan', module, items: '<one per element: kind, name, intent, signature>' } } });

function writtenElements(input) {
  const fileParts = readCodeFiles(input.files).parts;
  const ops = [...(Array.isArray(input.ops) ? input.ops : []), ...fileParts.filter(p => p.part === 'ops').flatMap(p => p.ops)];
  const parts = [{ part: input.part, text: input.text, basedOn: input.basedOn }, ...(Array.isArray(input.also) ? input.also : []), ...fileParts,
    ...ops.flatMap(op => op?.op === 'logic' && op.data?.flow ? [{ part: 'logic', text: op.data.flow, basedOn: op.data.basedOn }]
      : op?.op === 'html' && op.data?.html ? [{ part: 'html', text: op.data.html, basedOn: op.data.basedOn }] : [])];
  return parts.reduce((n, p) => n + (Array.isArray(p?.text) ? p.text : [p?.text]).reduce((m, t) => {
    if (typeof t !== 'string') return m;
    const part = canonicalPart(p?.part) ?? partOfText(t);
    if (p?.basedOn != null) return m;
    return m + (part === 'logic' ? (splitActions(t) ?? [t]).filter(a => headerOf(a) && !headerOf(a).key).length
      : part === 'html' ? (splitDocuments(t) ?? [t]).filter(a => /^\s*(?:<!--[\s\S]*?-->\s*)*<(?:screen|block)\b/.test(a) && !/^\s*(?:<!--[\s\S]*?-->\s*)*<(?:screen|block)\b[^>]*\bk\s*=/.test(a)).length : 0);
  }, 0), 0);
}

// write (feat/ssam-code-hosted): the deps of writeCall a server gives each write ({readReading, readJob}, or a function of
// the call that returns them): the read of an action an edit expands and the job file a correction reads.
export function registerSsamCode(server, { fromJsonSchema, map, deliver, check, plan, lanes = ['o11', 'odc'], write = null, drafts = {} } = {}) {
  const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value && value.ok === false ? { isError: true } : {}) });
  // The lists of a write carry the person's code: no limit of this tool cuts them (the delivery takes any number of texts
  // and ops in one job); the bounds below only keep a runaway call out.
  const text = { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: CODE_LIST_MAX }] };
  const edits = { type: 'array', minItems: 1, maxItems: 500, items: { type: 'object' }, description: 'write logic: line edits of ONE read action (element + basedOn = its textSha) instead of its whole text: {replace:"@n4", with:"..."}, {after:"@n2"|before:"@n2", insert:"..."}, {delete:"@n3"}; the header by its @key, a line without id by its exact text, "@n10#2" the 2nd line with @n10. html (basedOn {capture, html}): {set:k,attributes}, {replace|delete|after|before|into|move:k}, {find, with}; a job (basedOn {job, sha256}): {find, with}' };
  const schema = { type: 'object', additionalProperties: false, required: ['lane', 'action'], properties: {
    lane: { type: 'string', enum: lanes, description: 'o11 or odc.' },
    action: { type: 'string', enum: CODE_ACTIONS, description: 'grammar: syntax and a from-scratch example; read: the part as code; write: deliver the code; check: validate offline on the newest capture; plan: divide work into parallel batches with prompt files and checks.' },
    items: { type: 'array', maxItems: 200, items: { type: 'object', additionalProperties: false, required: ['kind', 'name', 'intent'], properties: { kind: { type: 'string', enum: ['action', 'screen', 'block', 'data'] }, name: { type: 'string', minLength: 1 }, intent: { type: 'string' }, signature: { type: 'string' }, calls: { type: 'array', items: { type: 'string' } } } }, description: 'plan only: one item per element to create or change.' },
    shared: { type: 'array', items: { type: 'string' }, description: 'plan only: absolute paths of shared .ddl/.json files already written.' },
    workers: { type: 'integer', minimum: 1, maximum: 8, description: 'plan only: number of parallel batches.' },
    stubs: { type: 'array', items: { type: 'string' }, description: 'check only: absolute .flow/.html paths with signatures of other batches.' },
    base: { type: 'string', description: 'check only: existing absolute .oml path overriding the newest capture.' },
    part: { type: 'string', enum: CODE_PARTS, description: 'ddl (data as SQL DDL), logic (actions as pseudocode), html (screens as HTML). Required for read; write takes it from the form of the text when left out; grammar without it gives every part.' },
    target: { type: 'string', minLength: 1, description: 'read: the module open in the Studio of the lane, or a capture .oml path.' },
    module: { type: 'string', minLength: 1, description: 'write: the module open in the Studio of the lane (or its app name); read takes it as target.' },
    element: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 200 }], description: 'read: one entity/structure (ddl), action or list of actions (logic), screen or block (html); a list of screens or data elements is read one by one in one answer; write html: the screen changed.' },
    page: { type: 'integer', minimum: 1, description: 'read: the page of a long answer (continuations.next names it).' },
    offset: { type: 'integer', minimum: 0, description: 'read logic without element: the first action of the list page (continuations.next names it).' },
    max: { type: 'integer', minimum: 1, maximum: 500, description: 'read logic without element: actions per list page.' },
    includeDetail: { type: 'boolean', description: 'read: as ssam_map includeDetail (detail rows in a list).' },
    removes: { anyOf: [{ type: 'boolean' }, { type: 'array', items: { type: 'string', minLength: 2 }, minItems: 1, maxItems: 200 }], description: 'write logic: the lines of the read left out ON PURPOSE are deleted (true, or their ids "@n3"); without it a text with a gap in its ids is refused.' },
    text: { ...text, description: 'write: the code. ddl: the statements; logic: one action text or a list; html: a <screen>/<block> document, or the changed elements (with element and basedOn).' },
    files: { type: 'array', minItems: 1, maxItems: CODE_LIST_MAX, items: { type: 'string', minLength: 1 }, description: 'write: absolute paths of UTF-8 files with the code subagents wrote: .flow/.logic/.txt (one or more actions), .ddl/.sql, .html/.htm, .json (job ops); one delivery with every part, ordered as the delivery needs; a refusal names each problem by files/<i>' },
    basedOn: { anyOf: [{ type: 'string' }, { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'null' }] } }, { type: 'object' }], description: 'write: what the read returned (ddl: sourceSha256; logic: textSha, one per text; html: {capture, html}); or, to correct a refused write, {job, sha256} (its nextBasedOn) with patch.' },
    edits,
    also: { type: 'array', maxItems: 100, items: { type: 'object', additionalProperties: false, properties: {
      part: { type: 'string', enum: CODE_PARTS }, text, edits, basedOn: { anyOf: [{ type: 'string' }, { type: 'array' }, { type: 'object' }] }, element: { type: 'string' },
      removes: { anyOf: [{ type: 'boolean' }, { type: 'array', items: { type: 'string' } }] } } },
      description: 'write: other parts in the same delivery (part taken from the form of the text when left out); ssam_code orders them as the delivery needs: the data first, new blocks and screens, then the actions (a new screen action before the change of its screen) and the screen edits.' },
    ops: { type: 'array', maxItems: CODE_OPS_MAX, items: { type: 'object' }, description: 'write: raw job ops before the code (e.g. {"op":"create","parent":"@espace","type":"IRole","name":"X"}); alone (no text) they are the job.' },
    patch: { anyOf: [{ type: 'array', maxItems: 500, items: { type: 'object' } }, { type: 'string', enum: ['verified'] }], description: 'write: JSON Patch over the job of basedOn {job, sha256}, as a refusal returned it; or "verified": every verified patch of that refusal (its verifiedPatch.call).' },
    // fix (R1): sent as a refusal's fixCall gives it; listed without a text (the listing budget).
    fix: { type: 'string', const: 'apply' },
    publish: { type: 'boolean', description: 'write: true also publishes after a clean merge, with authorize or the standing grant.' },
    authorize: { type: 'string', description: 'write: the user\'s own words, verbatim.' },
    until: { type: 'string', enum: ['apply', 'snapshot', 'build', 'check-base', 'preview', 'merge'], description: 'write: stop before the merge, only when the person asks (o11: apply; odc: snapshot, build, check-base, preview).' },
    checks: { type: 'array', items: { type: 'string' }, description: 'write o11: element names that must exist after the merge.' },
    producers: { anyOf: [{ type: 'string' }, { type: 'object' }], description: 'write o11: producer bindings, as o11_deliver.' },
    captureProducers: { type: 'array', items: { type: 'string' }, description: 'write o11: producers captured read-only first.' },
    expectedEnvironment: { type: 'string', description: 'write o11: bare host the Studio must be on.' },
    closePrevious: { type: 'string', description: 'write o11: taskId of a refused delivery to close first.' },
    feature: { type: 'string', description: 'write odc: the feature name (default from the code).' },
    owners: { type: 'array', items: { type: 'string' }, description: 'write odc: owner elements (default: the names the code creates or changes).' },
    changes: { type: 'array', items: { type: 'string' }, description: 'write odc: what changes (default from the code).' },
    tenant: { type: 'string', description: 'write odc: tenant host.' },
    pid: { type: 'integer', minimum: 1, description: 'ODC Studio process id.' },
    budgetBytes: { type: 'integer', minimum: 2000, maximum: 1048576, description: 'read: byte budget of the answer.' },
    expectedSourceSha256: { type: 'string', description: 'read: refuse if the capture differs from this hash.' },
    keys: { type: 'boolean', description: 'read html: also the k -> ObjectKey table inline.' },
  } };
  extendDraftSchema(schema); // R2 (code-draft-schema.mjs): actions draft and part, and the draft parameter
  server.registerTool(CODE_TOOL, {
    title: CODE_TOOL, description: CODE_DESCRIPTION, inputSchema: fromJsonSchema(schema),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (input = {}, ctx) => {
    try {
      const lane = input.lane === 'o11' ? 'o11' : 'odc';
      // R2 (code-draft.mjs): a draft opened, its status, a part added, or the write of a draft (one delivery).
      if (isDraftCall(input)) return reply(await (await import('./code-draft.mjs')).draftAction({ ...input, lane }, ctx, { deliver, check, ...drafts }));
      if ((input.stubs != null && input.action !== 'check') || (['items', 'shared', 'workers'].some(k => input[k] != null) && input.action !== 'plan')) return reply({ ok: false, code: 'INPUT_INVALID', error: 'stubs is only allowed for check; items, shared and workers are only allowed for plan' });
      if (input.action === 'check') return reply(await check({ ...input, lane }));
      if (input.base != null) return reply({ ok: false, code: 'INPUT_INVALID', error: 'base is only allowed for check' });
      if (input.action === 'plan') return reply(await plan({ ...input, lane }));
      if (input.action === 'grammar') return reply({ ...grammarCard(input.part ?? null, lane), plan: planHint(lane) });
      if (input.action === 'read' && !CODE_PARTS.includes(input.part)) return reply({ ok: false, code: 'INPUT_INVALID', tool: CODE_TOOL, error: `read needs part: ${CODE_PARTS.join(', ')}`,
        continuation: { tool: CODE_TOOL, arguments: { lane, action: 'grammar' }, why: 'the parts, their syntax and examples' } });
      if (input.action === 'read') {
        if (!(input.target ?? input.module)) return reply({ ok: false, code: 'INPUT_INVALID', tool: CODE_TOOL, error: 'read needs target (the open module or a capture .oml)' });
        return reply(await codeRead({ ...input, lane }, { map }));
      }
      const writeDeps = (typeof write === 'function' ? write() : write) ?? {};
      const call = writeCall({ ...input, lane }, Object.fromEntries(Object.entries(writeDeps).filter(([k, v]) => ['readReading', 'readJob'].includes(k) && typeof v === 'function')));
      const { PLAN_MIN_ITEMS } = await import('./code-plan.mjs');
      const jobParts = (call.arguments?.job?.ops ?? []).flatMap(op => op?.op === 'logic' && op.data?.flow
        ? [{ part: 'logic', text: op.data.flow, basedOn: op.data.basedOn }]
        : op?.op === 'html' && op.data?.html ? [{ part: 'html', text: op.data.html, basedOn: op.data.basedOn }] : []);
      const count = Math.max(writtenElements(input), writtenElements({ also: jobParts }));
      const hint = count >= PLAN_MIN_ITEMS ? planHint(lane, input.module) : null;
      if (call.refusal) return reply({ ...call.refusal, ...(hint ? { plan: hint } : {}) });
      const result = await deliver(call.tool, call.arguments, ctx);
      // A refusal of the text in the words of ssam_code (grammar continuation, ssam_code read); anything else as it came.
      let value = result?.structuredContent;
      if (value == null && typeof result?.content?.[0]?.text === 'string') { try { value = JSON.parse(result.content[0].text); } catch { value = null; } }
      let answered = value != null ? codeAnswer(value, { lane, part: canonicalPart(input.part) ?? partOfText(input.text) ?? undefined }) : value;
      if (hint && plain(answered)) answered = { ...answered, plan: hint };
      // What the write took as meant (writeCall) goes with the answer, before what the delivery normalized in the job.
      if (call.normalizations?.length && plain(answered)) answered = { ...answered, normalizations: mergeNormalizations(answered.normalizations, call.normalizations) };
      return answered !== value ? { ...result, content: [{ type: 'text', text: JSON.stringify(answered) }], structuredContent: answered } : result;
    } catch (error) { return reply({ ok: false, tool: CODE_TOOL, error: String(error?.message ?? error) }); }
  });
}
