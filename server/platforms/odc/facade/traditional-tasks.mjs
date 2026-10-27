import fs from 'node:fs';
import { createHash } from 'node:crypto';

const norm = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const ref = (library, name, kind = 'block') => ({ library, name, kind });
const web = (...names) => names.map(name => ref('OutSystemsUIWeb', name));
const rich = (...names) => names.map(name => ref('RichWidgets', name));
const action = (library, ...names) => names.map(name => ref(library, name, 'action'));

// A task recipe describes the integration, not just a bag of visually similar widgets.
export const taskRecipes = [
  { id: 'pagination', match: /paginacao|paginar|proxima pagina|por pagina|pagination|page size/, components: [...rich('List_Navigation'), ...action('RichWidgets', 'List_Navigation_GetStartIndex', 'List_Navigation_ResetStartIndex')],
    steps: ['Bind ListWidgetId to the named list/table .Id, LineCount to its page size and TotalRowCount to the filtered total, not the current page length.', 'Use GetStartIndex for the list/query offset. OnNotify fetch the requested page and Ajax Refresh list and pager together. Reset the start index when filters change.', 'Choose one paging owner (query or widget); do not apply the same offset twice. Keep deterministic ordering and test first/last/empty pages.'] },
  { id: 'sorting', match: /ordenar|ordenacao|sort(?:ing)?|cabecalho clicavel/, components: [...rich('List_SortColumn'), ...action('RichWidgets', 'List_SortColumn_GetOrderBy')],
    steps: ['Place List_SortColumn in each sortable table header. Column uses the catalog syntax for a fixed allowed entity attribute.', 'OnNotify obtain GetOrderBy for the table, reset paging and fetch the ordered data before refreshing the table and pager.', 'Map permitted columns/directions on the server; never interpolate an arbitrary user string into SQL. Add a stable tie-breaker.'] },
  { id: 'feedback', match: /mensagem|aviso|notificacao|feedback|toast|salvo com sucesso/, components: action('RichWidgets', 'Feedback_Message'),
    steps: ['Call Feedback_Message after the successful business action, with MessageText and the referenced MessageType identifier.', 'Keep errors in the exception/validation path. An error must not show success or dismiss unsaved input; authorization remains on the server.'] },
  { id: 'dialog', match: /dialogo|modal|janela.*editar|popup|pop up/, components: [...web('Modal'), ...action('OutSystemsUIWeb', 'ToggleModal')],
    steps: ['Put title, form and commands in the official placeholders. Use ToggleModal with the instance .Id and TriggerButtonId for focus return; do not invent an IsOpen input.', 'Open/close are same-screen interactions. Save validates and calls the server, then refreshes affected data and closes only on success. Preserve input and show feedback on error.'] },
  { id: 'tabs', match: /\babas?\b|\btabs?\b/, components: web('Tabs', 'TabsHeaderItem', 'TabsContentItem'),
    steps: ['Pair each header with its content inside the catalog placeholders. Preserve the selected tab during data refresh.', 'Choose local tab switching for already loaded content; query lazily only when needed. Test keyboard order and loading/error states.'] },
  { id: 'accordion', match: /sanfona|accordion|expandir|recolher|expansiv/, components: web('Accordion', 'AccordionItem'),
    steps: ['Compose AccordionItem under Accordion using the declared title/content placeholders and inputs. Keep interactive content accessible when expanded and preserve state during refresh.'] },
  { id: 'date', match: /calendario|selecionar data|seletor de data|date picker|datepicker/, components: web('DatePicker'),
    steps: ['Bind the date picker to a named native date input using the actual catalog input, not a guessed event. Preserve locale and date type.', 'Validate date limits on the server; support typing, clearing, keyboard selection and validation feedback.'] },
  { id: 'upload', match: /upload|anexar|enviar arquivos?/, components: web('FileUpload'),
    steps: ['Compose the official FileUpload with the native upload widget as required by the contract; keep the file transfer on Submit.', 'Enforce authorization, file size/type and storage rules on the server. Refresh attachment data after success and expose progress/error states.'] },
  { id: 'search', match: /pesquisa|pesquisar|busca|buscar|filtro|filtrar|\bsearch\b/, components: web('Search'),
    steps: ['Bind the search input to screen state and a parameterized server query. Reset paging when the search changes; preserve other filters and ordering.', 'Fetch before Ajax Refresh; implement empty/error states and avoid a request for every keystroke without debounce.'] },
  { id: 'empty', match: /sem resultados|nenhum resultado|lista vazia|estado vazio|empty state/, components: web('BlankSlate'),
    steps: ['Show BlankSlate only after loading succeeds and the filtered total is zero. Keep loading and error states separate; offer a relevant next action.'] },
  { id: 'cards', match: /\bcards?\b|cartoes|cartao|indicadores/, components: web('Card', 'Columns3'),
    steps: ['Reuse the official layout and responsive columns; put each record/metric in a Card placeholder. Bind actual query results and handle empty/error states.'] },
  { id: 'tooltip', match: /tooltip|dica de ajuda|ajuda ao passar|balao de ajuda/, components: web('Tooltip'),
    steps: ['Populate the tooltip trigger/content placeholders; make the trigger keyboard-focusable. Do not hide required instructions only in hover content.'] },
  { id: 'wizard', match: /wizard|passo a passo|formulario em etapas|assistente de etapas/, components: web('Wizard', 'WizardItem'),
    steps: ['Keep the current step and form state explicitly. Validate the current step before advancing; allow back without discarding data.', 'Persist only at the intended business boundary and enforce final server validation. The visual Wizard alone does not implement navigation.'] }
];

let cached;
export function traditionalCatalog() {
  if (cached) return cached;
  cached = [ ['RichWidgets', 'RichWidgets-unversioned.json'], ['OutSystemsUIWeb', 'OutSystemsUIWeb-1.12.8.json'] ].map(([library, file]) => {
    const bytes = fs.readFileSync(new URL('../../../kernel/catalog/ui/' + file, import.meta.url));
    return { library, sha256: createHash('sha256').update(bytes).digest('hex'), file: 'kernel/catalog/ui/' + file, data: JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')) };
  });
  return cached;
}

export function selectedTraditionalTasks(intent) {
  // An explicitly excluded clause is not a request to add its component.
  const positive = positiveIntent(intent);
  if (/\b(sql|aggregate|server action)\b/.test(positive) && !/\b(tela|lista|tabela|frontend|interface|botao|formulario|screen|table|list)\b/.test(positive)) return [];
  const selected = taskRecipes.filter(r => r.match.test(positive));
  if (/popup editor/.test(positive) || (/richwidgets/.test(positive) && /popup|dialogo/.test(positive))) {
    return [...selected.filter(r => r.id !== 'dialog'), { id: 'legacy-popup', components: [...rich('Popup_Editor'), ...web('LayoutPopup'), ...action('RichWidgets', 'Popup_Editor_Notify', 'Popup_Editor_Close')], steps: ['Explicit legacy compatibility request: inspect installed deprecation/device limits before implementing.', 'Use a named Navigate link and LinkOrButtonWidgetId=Link.Id; a separate screen uses LayoutPopup. Notify then Close only on successful save.', 'Handle OnNotify in the parent: fetch/assign data and Ajax Refresh the persistent region. Refresh the link and its Popup_Editor instance together.'] }];
  }
  return selected;
}

function positiveIntent(intent) {
  return String(intent).split(/[,;!]|\.(?:\s|$)|\b(?:mas|porém|but)\b/i).map(norm).filter(c => !/^(?:nao|sem|without|do not)\b/.test(c)).join(' ');
}

export function traditionalTaskPlan(intent, resolution) {
  const tasks = resolution === undefined ? selectedTraditionalTasks(intent) : resolveTraditionalTasks(intent, resolution);
  const catalogs = traditionalCatalog(), wanted = tasks.flatMap(t => t.components);
  const text = ' ' + positiveIntent(intent) + ' ';
  // Exact component names give access to the whole public catalog, including long-tail components.
  for (const c of resolution === undefined ? catalogs : []) for (const b of c.data.Blocks.filter(b => b.Public)) {
    const name = norm(b.Name);
    if (text.includes(' ' + name + ' ')) wanted.push(ref(c.library, b.Name));
  }
  const components = [], missing = [], seen = new Set();
  for (const selection of wanted) {
    const key = selection.library + '.' + selection.name + ':' + selection.kind;
    if (seen.has(key)) continue;
    seen.add(key);
    const c = catalogs.find(c => c.library === selection.library);
    const item = c?.data[selection.kind === 'action' ? 'Actions' : 'Blocks'].find(b => b.Name === selection.name && b.Public);
    if (!item) { missing.push(key); continue; }
    const contract = { inputs: item.Inputs ?? [], outputs: item.Outputs ?? [], events: item.Events ?? [], placeholders: item.Placeholders ?? [] };
    components.push({ ...selection, description: item.Description, contract,
      source: { file: c.file, sha256: c.sha256, status: 'catalog snapshot; verify the installed producer before delivery' },
      dependency: { op: 'reference', producer: selection.library, elements: [(selection.kind === 'action' ? 'IServerAction:' : 'IWebBlock:') + selection.name] },
      authoring: selection.kind === 'block'
        ? { op: 'create', type: 'IWebBlockInstanceWidget', parent: '<verified parent @key or placeholder>', name: '<meaningful instance name>', source: 'IWebBlock:' + selection.name, as: '<unique alias>' }
        : { call: selection.library + '.' + selection.name, form: 'ssam-flow/1', place: '<owning screen action and success/error branch>' },
      requiredBindings: contract.inputs.filter(i => i.Mandatory && i.Default == null).map(i => ({ name: i.Name, type: i.Type, meaning: i.Description })),
      limitation: /deprecated|not supported/i.test(item.Description ?? '') ? item.Description : null });
  }
  if (!tasks.length && !components.length) return null;
  return { schema: 'ssam-traditional-task-plan/1', interpretation: {mode: resolution === undefined ? 'keyword-hints' : 'agent-resolved', original: intent, resolution}, semantic:traditionalResolutionRequest(intent).next, tasks: tasks.map(({id, steps}) => ({id, steps})), components, missing,
    implementation: ['Read the target screen/logic and the installed producer signatures; reuse compatible instances before creating new ones.', 'Resolve every required binding against actual screen/query/row context. Catalog defaults are expressions; preserve their referenced producer entities.', 'Compose the instances, placeholders, native controls, screen actions, dependencies and data refresh in ONE module delivery. A component instance without its behavior does not complete the task.', 'The authoring entries are templates, not a ready-to-run job. Do not send placeholder values. A missing component or unresolved binding is a named gap, never permission to fabricate APIs.'],
    bind: { tool: 'ssam_reference', arguments: { lane: 'o11', kind: 'recipe', query: { traditionalTask: intent, bind: { library: '<selected library>', component: '<selected block>', parent: '<verified parent>', name: '<instance name>', alias: '$component', inputs: {} } } } },
    compile: { tool:'ssam_reference', kind:'recipe', query:'{traditionalTask: original intent, implement: one contract below}',
      contracts:{
        tabs:{pattern:'tabs',parent:'verified parent',name:'instance name',alias:'$tabs',items:[{id:'uniqueTab',title:'title expression',content:'content expression'}]},
        accordion:{pattern:'accordion',parent:'verified parent',name:'instance name',alias:'$accordion',items:[{id:'uniqueSection',title:'title expression',content:'content expression'}]},
        dialog:{pattern:'dialog',screen:'screen name',action:'new toggle handler',parent:'@verified parent or new screen alias placeholder',name:'modal name',alias:'$modal',title:'title expression',content:'body expression',openLabel:'open label',closeLabel:'close label'},
        feedback:{pattern:'feedback',screen:'screen name',action:'new handler name',trigger:'@existing native LinkWidget key',businessCall:{action:'Producer.Action',arguments:{Parameter:'expression'}},message:'OutSystems text expression',messageType:'referenced MessageType identifier expression'},
        pagination:{pattern:'pagination',screen:'screen name',action:'new OnNotify handler name',parent:'@verified container key',name:'pager name',alias:'$pager',listWidgetId:'Table.Id',pageSize:'20',total:'Total',offsetVariable:'StartIndex',query:{action:'Producer.List',arguments:{Start:'StartIndex',Quantity:'20'}},assign:{Rows:'Loaded.Rows',Total:'Loaded.Total'},refreshTarget:'persistent named region containing list and pager'}
      },
      boundaries:['The compiler creates a new handler. Editing an existing action requires its read source/key and merge preconditions, not an implicit overwrite.', 'Pagination uses a query-owned offset, with the widget local offset zero. Initial data loading, filter-reset handlers and containing screen/state must already exist or be included by the author in the same delivery.', 'Dialog implements informational content with open/close and focus return. Tabs/accordion accept content expressions. Nested forms, validation and save flows require native composition in the same module job.', 'Bind referenced producers before delivery: published for normal delivery, or captured OML files for apply-only. Do not publish official libraries to work around a capture failure.', 'Generated jobs are unverified until native validation; binding names and producer signatures must come from the module. Other patterns require the agent to compose the complete native job using their contracts, not stop at a plan or claim completion.'] },
    acceptance: ['Validate initial state, successful interaction, error/empty state and repeated interaction after Ajax refresh.', 'Record separately: planned, authored, native-verified, published and browser-tested. Catalog presence alone proves none of the later stages.'] };
}

// Language interpretation belongs to the calling model, not an ever-growing translated regex.
// Retain its evidence so selection is reviewable; absence of a keyword is never a capability denial.
export function traditionalResolutionRequest(intent) {
  return {schema:'ssam-traditional-resolution/1', original:intent, status:'needs-semantic-resolution',
    instruction:'Interpret the complete user request in its original language, including negation. Select behaviors by meaning, not spelling. Return resolution entries with pattern and an exact evidence excerpt. These are implementation contracts, not limits on what the user may ask. For other behavior use native composition and the public component catalog; do not silently omit it.',
    behaviors:taskRecipes.map(({id,steps})=>({id,meaning:steps})),
    next:{tool:'ssam_reference',arguments:{lane:'o11',kind:'recipe',query:{traditionalTask:intent,resolution:[{pattern:'<behavior id>',evidence:'<exact excerpt from original request>'}]}}}};
}

function resolveTraditionalTasks(intent, resolution) {
  if (!Array.isArray(resolution) || !resolution.length || resolution.length > 30) throw new Error('resolution must contain 1 to 30 behavior selections');
  const result = [], seen = new Set();
  for (const entry of resolution) {
    if (!entry || Object.keys(entry).some(k=>!['pattern','evidence'].includes(k))) throw new Error('Use pattern and evidence in each resolution');
    const task = taskRecipes.find(r=>r.id===entry.pattern) ?? (entry.pattern==='legacy-popup' ? selectedTraditionalTasks('RichWidgets Popup_Editor')[0] : undefined);
    if (!task) throw new Error('Unknown behavior contract: '+entry.pattern+'; use native composition for uncatalogued behavior');
    if (typeof entry.evidence!=='string' || !entry.evidence.trim() || !String(intent).includes(entry.evidence)) throw new Error('Evidence must be an exact excerpt of the original request');
    if (!seen.has(task.id)) result.push(task);
    seen.add(task.id);
  }
  return result;
}

// This is also used to validate the bindings before presenting concrete native ops.
export function bindTraditionalBlock(component, { parent, name, alias, inputs = {} }) {
  if (component.kind !== 'block') throw new Error('Expected a block contract');
  if (![parent, name, alias].every(v => typeof v === 'string' && v && !/[<>]/.test(v))) throw new Error('Resolve parent, name and alias first');
  const allowed = new Set(component.contract.inputs.map(i => i.Name));
  for (const input of Object.keys(inputs)) if (!allowed.has(input)) throw new Error('Unknown input: ' + input);
  for (const input of component.requiredBindings) if (!Object.hasOwn(inputs, input.name) || !String(inputs[input.name]).trim()) throw new Error('Missing binding: ' + input.name);
  return [component.dependency, { ...component.authoring, parent, name, as: alias }, ...Object.entries(inputs).map(([input,value]) => ({op:'set',target:alias+'/'+input,prop:'Value',value}))];
}

function expression(value, label) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value) || /<[^=].*>/.test(value)) throw new Error('Resolve expression: ' + label);
  return value;
}
function identifier(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error('Invalid identifier: ' + label);
  return value;
}
function flowCall(call) {
  if (!call || !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(call.action ?? '')) throw new Error('Resolve the business/query action from its signature');
  const args = Object.entries(call.arguments ?? {}).map(([k,v]) => identifier(k,'argument') + '=' + expression(v,k));
  return call.action + '(' + args.join(', ') + ')';
}

// Concrete behavior compilation stays separate from natural-language selection: the agent must bind
// the actual screen, query signature and state read from the module. No entity/field names are guessed.
export function implementTraditionalTask(plan, input) {
  if (!input || !plan.tasks.some(t => t.id === input.pattern)) throw new Error('Pattern is not selected by the task');
  if (input.pattern === 'dialog') return implementDialog(plan,input);
  if (['tabs','accordion'].includes(input.pattern)) return implementSections(plan,input);
  const allowed = input.pattern === 'feedback'
    ? ['pattern','screen','action','trigger','businessCall','message','messageType']
    : ['pattern','screen','action','parent','name','alias','listWidgetId','pageSize','total','offsetVariable','query','assign','refreshTarget'];
  for (const key of Object.keys(input)) if(!allowed.includes(key)) throw new Error('Unknown task binding: '+key);
  const screen = identifier(input.screen,'screen'), name = identifier(input.action,'screen action');
  const ops = [], imports = new Map();
  const addImport = (producer,element) => { if(!imports.has(producer)) imports.set(producer,new Set()); imports.get(producer).add(element); };
  const importCall = call => { const names=call.action.split('.'); if(names.length===2) addImport(names[0],'IServerAction:'+names[1]); };
  let lines = [`action ${screen}.${name}`];
  if (input.pattern === 'feedback') {
    const call = flowCall(input.businessCall); importCall(input.businessCall);
    addImport('RichWidgets','IServerAction:Feedback_Message');
    lines.push('  Saved = '+call, '  RichWidgets.Feedback_Message(MessageText='+expression(input.message,'message')+', MessageType='+expression(input.messageType,'messageType')+')','  end');
    const trigger=expression(input.trigger,'trigger');
    if(!trigger.startsWith('@')) throw new Error('Use the existing native LinkWidget @key for trigger');
  } else if (input.pattern === 'pagination') {
    const pager = plan.components.find(c=>c.name==='List_Navigation'&&c.kind==='block');
    const offset = identifier(input.offsetVariable,'offsetVariable');
    if (!Object.values(input.query?.arguments ?? {}).includes(offset)) throw new Error('The query must receive offsetVariable; do not paginate only the markup');
    if (!Object.values(input.query?.arguments ?? {}).includes(input.pageSize)) throw new Error('The query must receive pageSize');
    const query = flowCall(input.query); importCall(input.query);
    const componentOps = bindTraditionalBlock(pager,{parent:input.parent,name:input.name,alias:input.alias,inputs:{ListWidgetId:expression(input.listWidgetId,'listWidgetId'),LineCount:expression(input.pageSize,'pageSize'),TotalRowCount:expression(input.total,'total')}});
    ops.push(...componentOps);
    addImport('RichWidgets','IServerAction:List_Navigation_GetStartIndex');
    lines.push('  Page = RichWidgets.List_Navigation_GetStartIndex(ListWidgetId='+input.listWidgetId+')','  assign '+offset+' = Page.StartIndex','  Loaded = '+query);
    const bindings=Object.entries(input.assign ?? {});
    if (!bindings.length) throw new Error('Bind the query outputs to the displayed list and total');
    for(const [target,value] of bindings){
      if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(target)) throw new Error('Invalid assignment target');
      lines.push('  assign '+target+' = '+expression(value,target));
    }
    const refresh=expression(input.refreshTarget,'refreshTarget');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(refresh)) throw new Error('Use the named persistent region for refreshTarget');
    lines.push('  node AjaxRefreshNode()','    @{WidgetOrWebBlock=&"'+refresh+'"}','  end');
    // Resolve the destination after logic has created the action.
    ops.push({op:'logic',data:{flow:lines.join('\n')+'\n'}});
    ops.push({op:'set',target:input.alias+'/OnNotify',prop:'Destination',value:'IWebScreen:'+screen+'/IScreenAction:'+name});
  } else throw new Error('Concrete compiler not available for '+input.pattern+'; follow the task integration plan and report missing bindings');
  const dependencies=[...imports].map(([producer,elements])=>({op:'reference',producer,elements:[...elements]}));
  if(input.pattern==='feedback')ops.push({op:'logic',data:{flow:lines.join('\n')+'\n'}},
    {op:'set',target:input.trigger+'/OnClick',prop:'Destination',value:'IWebScreen:'+screen+'/IScreenAction:'+name},
    {op:'set',target:input.trigger+'/OnClick',prop:'Method',value:'Ajax'});
  return {ops:[...dependencies,...ops]};
}

function implementDialog(plan,input) {
  const allowed=['pattern','screen','action','parent','name','alias','title','content','openLabel','closeLabel'];
  for(const key of Object.keys(input))if(!allowed.includes(key))throw new Error('Unknown task binding: '+key);
  const screen=identifier(input.screen,'screen'), handler=identifier(input.action,'action');
  const name=identifier(input.name,'name'), alias=input.alias;
  if(typeof alias!=='string'||!/^\$[A-Za-z_]\w*$/.test(alias))throw new Error('Use a unique $alias');
  for(const key of ['openLabel','closeLabel'])if(typeof input[key]!=='string'||!input[key].trim())throw new Error('Resolve '+key);
  const component=plan.components.find(c=>c.name==='Modal'&&c.library==='OutSystemsUIWeb');
  const ops=bindTraditionalBlock(component,{parent:input.parent,name,alias});
  ops[1].empty=true;
  const text=(parent,value,as)=>ops.push({op:'create',parent,type:'IExpressionWidget',as},{op:'set',target:as,prop:'Value',value});
  text(alias+'/Title',expression(input.title,'title'),alias+'Title');
  text(alias+'/Content',expression(input.content,'content'),alias+'Content');
  const link=(parent,name,as,label)=>{
    ops.push({op:'create',parent,type:'ILinkWidget',name,as});
    text(as,JSON.stringify(label),as+'Text');
    ops.push({op:'set',target:as,prop:'StyleClasses',value:'Button'},
      {op:'set',target:as+'/OnClick',prop:'Destination',value:'IWebScreen:'+screen+'/IScreenAction:'+handler},
      {op:'set',target:as+'/OnClick',prop:'Method',value:'Ajax'},
      {op:'set',target:as+'/OnClick',prop:'Validation',value:'None'});
  };
  ops.push({op:'reference',producer:'OutSystemsUIWeb',elements:['IServerAction:ToggleModal']},
    {op:'logic',data:{flow:`action ${screen}.${handler}\n  OutSystemsUIWeb.ToggleModal(WidgetId=${name}.Id, TriggerButtonId=${name}Open.Id)\n  end\n`}});
  link(input.parent,name+'Open',alias+'Open',input.openLabel);
  link(alias+'/Footer',name+'Close',alias+'Close',input.closeLabel);
  return {ops};
}

function implementSections(plan,input) {
  const allowed=['pattern','parent','name','alias','items'];
  for(const key of Object.keys(input))if(!allowed.includes(key))throw new Error('Unknown task binding: '+key);
  identifier(input.name,'name');
  if(typeof input.alias!=='string'||!/^\$[A-Za-z_]\w*$/.test(input.alias))throw new Error('Use a unique $alias');
  if(!Array.isArray(input.items)||!input.items.length||input.items.length>50)throw new Error('Provide 1 to 50 sections');
  const ids=new Set(), ops=[], isTabs=input.pattern==='tabs';
  const block=(type,parent,name,alias,inputs={})=>{
    const component=plan.components.find(c=>c.name===type&&c.library==='OutSystemsUIWeb');
    const bound=bindTraditionalBlock(component,{parent,name,alias,inputs});bound[1].empty=true;ops.push(...bound);
  };
  const text=(parent,value,as)=>ops.push({op:'create',parent,type:'IExpressionWidget',as},{op:'set',target:as,prop:'Value',value:expression(value,parent)});
  block(isTabs?'Tabs':'Accordion',input.parent,input.name,input.alias);
  for(const item of input.items){
    if(!item||Object.keys(item).some(k=>!['id','title','content'].includes(k)))throw new Error('Use id, title and content per section');
    identifier(item.id,'section id');if(ids.has(item.id))throw new Error('Duplicate section id: '+item.id);ids.add(item.id);
    const alias=input.alias+item.id, name=input.name+item.id;
    if(isTabs){
      block('TabsHeaderItem',input.alias+'/Tabs_Header',name+'Header',alias+'Header',{DataTab:JSON.stringify(item.id)});
      block('TabsContentItem',input.alias+'/Tabs_Content',name+'Content',alias+'Content',{DataTab:JSON.stringify(item.id)});
      text(alias+'Header/Title',item.title,alias+'Title');text(alias+'Content/Content',item.content,alias+'Body');
    }else{
      block('AccordionItem',input.alias+'/Content',name,alias);
      text(alias+'/Title',item.title,alias+'Title');text(alias+'/Content',item.content,alias+'Body');
    }
  }
  return {ops};
}
