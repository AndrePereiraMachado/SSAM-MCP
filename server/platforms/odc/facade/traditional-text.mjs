import fs from 'node:fs';
import { traditionalTaskPlan, traditionalResolutionRequest } from './traditional-tasks.mjs';
import { compositionContract } from './traditional-compose.mjs';
import { isTraditionalContext, traditionalComponentRules, traditionalComponentLookups } from './traditional-components.mjs';

export const traditionalInteractionRules = [
  'Traditional Form stores class as an extended attribute (read as ext:class): retain the native Form class when adding your own class, e.g. Form audit-form. The default form width is a theme grid width; use scoped CSS on your form class for a full-width responsive grid and verify the served layout.',
  'Choose an interaction method explicitly: Navigate for a destination screen/external URL; Ajax (Ajax Submit) for an action that stays on the current screen; Submit for native upload/download or a deliberate full submit.',
  'Ajax does not rerun the screen Preparation. Fetch changed data explicitly, assign the bound variables, then Ajax Refresh only the affected named containers. Ajax Refresh is rendering, not a database refresh.',
  'For input/textarea changes use bind="Variable" onchange="ScreenAction(Param = expression)" and declare that screen action in the same job. This binds the native OnChange; refresh the named result region explicitly. Do not emulate it with JavaScript or treat a field change as navigation.',
  'Tabs and open/close modal actions: assign local state, then refresh a persistent outer container enclosing the If (including its false branch). Do not refresh an element that is absent from the DOM.',
  'Use validation=None for navigation, tabs, pagination and modal open/close. Keep server authorization and business validation for every write; client validation is not authorization. Do not validate unrelated required fields to switch tabs.',
  'Native Method lives on ILinkWidget/OnClick (ILinkOnClick), with Ajax|Submit|Navigate; IButtonWidget/OnClick exposes only Destination. Explicit method/validation on a document button emits a native link with Button styling, not a JavaScript emulation.',
  'For existing screens read ssam_map view html and edit with k and basedOn; native @key operations remain available. Preserve destination arguments, caption, position, styles and guards when replacing a button with an ILinkWidget. Keep native upload/download on Submit. Do not convert every action to Ajax mechanically.',
  'Test all three methods through publication and authenticated browser interaction: Ajax updates the intended region without document navigation; Navigate passes the expected inputs; Submit transfers the file. A clean Verify/merge/publish is not browser proof.'
];

// Traditional has its own native widget model. Do not offer the Reactive grammar or generator.
export function traditionalText({ lane, intent = '', found, route, wired = true, kinds = null }) {
  if (!isTraditionalContext(lane, intent, found, kinds)) return undefined;
  const taskPlan = traditionalTaskPlan(intent);
  const ui = taskPlan || route?.id?.startsWith('ui.') || /\b(frontend|front end|telas?|screens?|pagina|página|blocos?|blocks?|webblock|html|popup|modal|modais|layout|componentes?|components?|app|apps)\b|RichWidgets|Popup_Editor|OutSystemsUIWeb/i.test(intent);
  if (!ui) return undefined;
  const creating = route?.id === 'ui.screen-html' || /\b(criar|crie|create|new|nova|novo|adicionar|adicione|add)\b/i.test(intent);
  if (!wired) return null;
  if (taskPlan) {
    const value = { schema: 'ssam-packet-text/1', id: 'ui.traditional-screen', forms: ['ssam-flow/1'], creating: false,
      use: 'Implement the requested behaviors in the existing or new screen; adding a widget does not mean creating a new screen.',
      taskPlan, composition:compositionContract, semantic:traditionalResolutionRequest(intent).next, rules: [...traditionalComponentRules, ...traditionalInteractionRules],
      components: taskPlan.components.filter(c=>c.kind==='block').map(c=>({tool:'ssam_reference',arguments:{lane:'o11',kind:'ui-block',query:{catalog:c.library,name:c.name}}})),
      call: { tool: 'o11_deliver', arguments: { module: found?.digest?.module?.name ?? '<Module>', job: { ops: ['<bound components, placeholders, native controls and action flows together>'] }, authorize: '<user words or module grant>' } } };
    const short = { ...value, rules: taskPlan.implementation, components: undefined, taskPlan: { ...taskPlan, components: taskPlan.components.map(c => ({library:c.library,name:c.name,kind:c.kind,requiredBindings:c.requiredBindings,limitation:c.limitation})),
      full: {tool:'ssam_reference',arguments:{lane:'o11',kind:'recipe',query:{traditionalTask:intent}}} } };
    const compact = { schema:value.schema,id:value.id,forms:value.forms,creating:false,use:value.use,
      semantic:value.semantic, taskPlan:{schema:taskPlan.schema,tasks:taskPlan.tasks,components:taskPlan.components.map(c=>({library:c.library,name:c.name,kind:c.kind})),missing:taskPlan.missing,full:short.taskPlan.full},
      rule:'Fetch the full task recipe to bind the real screen/query parameters. Deliver components AND behavior together; this plan is not native or browser proof.' };
    return {value, levels:[value,short,compact],covers:[]};
  }
  if (!creating) {
    const value = { schema: 'ssam-packet-text/1', id: 'ui.traditional-screen', forms: ['ssam-html/1', 'ssam-flow/1'], creating: false,
      use: 'Read the Traditional screen with ssam_map view html. Edit complete changed elements with their k and the returned basedOn; deliver HTML and any keyed action flows in one o11_deliver job. Existing components, data and event arguments keep their native identity.',
      read: { tool: 'ssam_map', arguments: { lane: 'o11', target: found?.digest?.module?.name ?? '<Module>', view: 'html', screen: '<ScreenOrBlock>' } },
      composition:compositionContract, semantic:traditionalResolutionRequest(intent).next, rules: [...traditionalComponentRules, ...traditionalInteractionRules],
      components: traditionalComponentLookups,
      example: { op: 'html', data: { screen: '<ScreenOrBlock>', basedOn: '<from ssam_map>', html: '<a k="<existing-k>" onclick="Action(Value = expression)" os-onclick.Method="Ajax">Complete retained children</a>' } },
      refresh: { node: 'IAjaxRefreshNode', properties: { WidgetOrWebBlock: 'IContainerWidget:PersistentContainer', RowNumber: '', AnimationEffect: 'None' } } };
    // Smaller forms for a small packet (8 KB): the read, the edit shape and the method rules first; the cut returns the rest.
    const compact = { schema: value.schema, id: value.id, forms: value.forms, creating: false, use: value.use, read: value.read, example: value.example, refresh: value.refresh,
      rules: traditionalInteractionRules.slice(1, 3) };
    const minimal = { schema: value.schema, id: value.id, forms: value.forms, creating: false, use: value.use, read: value.read };
    return { value, levels: [value, compact, minimal], covers: [] };
  }
  // The proven example job ships with the kernel tests; an install without them answers the grammar alone.
  let example = null;
  try { example = JSON.parse(fs.readFileSync(new URL('../../../kernel/tests/jobs/traditional-ajax-navigation.json', import.meta.url), 'utf8')); } catch { example = null; }
  const value = {
    schema: 'ssam-packet-text/1', id: 'ui.traditional-screen', forms: ['ssam-html/1', 'ssam-flow/1'], creating: true,
    composition:compositionContract, semantic:traditionalResolutionRequest(intent).next,
    use: 'Create Traditional screens and blocks with html documents and server screen actions with flow, together in ONE o11_deliver job.',
    officialStarter: { use: 'For a composed UI, start with the proven Traditional official-block example and reuse the module layout. The interaction example below demonstrates methods only; it is not a finished app design.',
      tool: 'ssam_reference', arguments: { lane: 'o11', kind: 'example', query: { id: 'osui-web-patterns' } } },
    call: { tool: 'o11_deliver', arguments: { module: found?.digest?.module?.name ?? '<Module>', job: { ops: example?.ops ?? '<the html and logic ops of the grammar below>' }, authorize: '<the user\'s own words or existing module grant>' } },
    grammar: ['<screen name="Name" title="Literal" roles="Registered" actions="Save">...</screen> or <block name="Name">...</block>',
      'Direct children: <var name="Name" type="Text"/>; <input name="Parameter" type="Text" mandatory="False"/>; <style>CSS of this root</style>.',
      'Content: div/span, text and {{ expressions }}, input/textarea with bind and onchange="ActionName", button/a with onclick="ActionName" method="Ajax|Submit|Navigate" validation="None|Server|ClientAndServer", table/tr/td, Block name and slot name, div if/else and div list.',
      'Bound records: <table-records id="Records" source="Rows" line-count="10" start-index="0"><slot name="HeaderRow"><td>Label</td></slot><slot name="DataRow"><td>{{ Records.List.Current.Caption }}</td></slot></table-records>; <list-records id="Cards" source="Rows" line-count="10" start-index="0">{{ Cards.List.Current.Caption }}</list-records>. For a structure list, Current exposes attributes directly. Row commands pass the current record identifier in named arguments. Fetch/assign Rows in Preparation and again in Ajax actions when data changes; use RichWidgets.List_Navigation for paging, refresh the table/list and pager together, and avoid applying the page offset twice to already paged data.',
      'Controls: input type="checkbox|password|radio" bind="Variable" onchange="Action"; radio adds value="expression". The reader uses checkbox-input/password-input/radio-input, accepted on creation too. form record="RecordVariable" editable="True"; select bind="IdentifierVariable" source-entity="IEntitySignature:Entity" source-attribute="IEntitySignature:Entity/Label" required="False". This legacy selector has no OnChange contract: use an explicit Ajax button to apply it. Preserve its source references when editing.',
      'action Screen.Save\n  assign Variable = expression\n  end — a logic data.flow op after the documents. Traditional screen actions run on the server.'],
    components: traditionalComponentLookups,
    rules: [...traditionalComponentRules, ...traditionalInteractionRules, 'New documents create roots. To edit an existing root, read ssam_map view html and send complete changed elements with k plus its basedOn. Keep retained children; an omitted child of an edited element is removed. Unknown os-opaque components retain their entire subtree.',
      'To recreate a supported Traditional screen from its read HTML, remove k identities, choose a new root name, and include its owned action/Preparation flow texts without ids in the same job with the new owner. Canonical text/expr, os-* native properties, BasicType declarations and the two table-records tr rows are accepted; derived records os-Type is checked against source. Existing module data, actions and referenced blocks must remain available. This is not a module/dependency clone; unsupported properties or opaque widgets are refused, never dropped.',
      'Canonical form controls retain ext: attributes (literal text or {{ expressions }}), SourceEntity and the SourceAttribute resolved within that entity. div if/else represents the native branches; its id belongs to the If, without an extra wrapper. Constant os-Visible="True" from a reading preserves an always-visible control; conditional visibility must use div if/else. Inline browser code in extended attributes is refused.',
      'No arbitrary HTML, JavaScript, React components or Reactive generator. Unsupported markup is refused rather than discarded.',
      'class/style are literal. onclick="Action(Param = expression)" carries named arguments. Block inputs use :Input="expression", typed events use @Event="Action(Param = expression)", and legacy events use onnotify. Initial data: logic text preparation <Owner>.Preparation, followed by queries/calls/assignments and end. Read it with ssam_map view flow and edit the whole text with its basedOn textSha and ids; creation omits ids. Preparation has no input/output parameters and uses owner variables. Ajax actions must explicitly refresh data; they do not rerun Preparation.',
      'Create a default IEntry only when the module has none; preserve an existing entry. Never set ESpace.DefaultScreen for Traditional navigation.',
      'Publish only with the user\'s authorization. Native validation and merge do not prove server publication.'],
    provenBy: 'kernel/tests/Anvil.Tests/TraditionalAjaxTests.cs; kernel/tests/jobs/traditional-ajax-navigation.json',
  };
  const short = structuredClone(value); delete short.grammar;
  // Smaller forms for a small packet (8 KB): the document grammar and the proven job by its reference, never the whole job;
  // the cut of the text section returns the rest.
  const exampleCall = { tool: 'ssam_reference', arguments: { lane: 'o11', kind: 'example', query: { id: 'traditional-ajax-navigation' } } };
  const call = { tool: 'o11_deliver', arguments: { ...value.call.arguments, job: { ops: '<the html and logic ops of the grammar>' } } };
  const compact = { schema: value.schema, id: value.id, forms: value.forms, creating: true, use: value.use, grammar: value.grammar.slice(0, 3),
    example: exampleCall, call, rules: [value.rules.find(r => r.startsWith('class/style are literal')), traditionalInteractionRules[2]].filter(Boolean) };
  const minimal = { schema: value.schema, id: value.id, forms: value.forms, creating: true, use: value.use, example: exampleCall, call };
  return { value, levels: [value, short, compact, minimal], covers: [] };
}
