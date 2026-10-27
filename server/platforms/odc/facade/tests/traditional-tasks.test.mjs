import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {traditionalTaskPlan, traditionalResolutionRequest, traditionalCatalog, bindTraditionalBlock, implementTraditionalTask} from '../traditional-tasks.mjs';
import {packetTextSection} from '../text-packet.mjs';
import {registerSsamReference} from '../ssam-reference.mjs';
import {tempKernel,linked} from './fixtures/o11env-kernel.mjs';

const cases = [
 ['Coloque paginação de 20 por página na lista', ['pagination'], ['List_Navigation']],
 ['Permita ordenar pelo título clicando no cabeçalho', ['sorting'], ['List_SortColumn']],
 ['Mostre uma mensagem quando salvar com sucesso', ['feedback'], ['Feedback_Message']],
 ['Abra um diálogo para editar o cadastro', ['dialog'], ['Modal','ToggleModal']],
 ['Edite dentro do popup RichWidgets', ['legacy-popup'], ['Popup_Editor','LayoutPopup','Popup_Editor_Notify','Popup_Editor_Close']],
 ['Separe os detalhes em abas', ['tabs'], ['Tabs','TabsHeaderItem','TabsContentItem']],
 ['Permita expandir e recolher os detalhes', ['accordion'], ['Accordion','AccordionItem']],
 ['Coloque um calendário para selecionar data', ['date'], ['DatePicker']],
 ['Permita anexar arquivos ao registro', ['upload'], ['FileUpload']],
 ['Inclua pesquisa por nome e filtros', ['search'], ['Search']],
 ['Mostre uma orientação quando não houver resultados e a lista vazia', ['empty'], ['BlankSlate']],
 ['Mostre os indicadores em cartões', ['cards'], ['Card','Columns3']],
 ['Inclua uma dica de ajuda no campo', ['tooltip'], ['Tooltip']],
 ['Organize o formulário em etapas', ['wizard'], ['Wizard','WizardItem']]
];
test('semantic resolution bypasses keyword matching in any language and preserves evidence',()=>{
 for(const original of ['Let people move through results twenty at a time','Muestra veinte registros a la vez','一度に20件ずつ表示してください']){
  const plan=traditionalTaskPlan(original,[{pattern:'pagination',evidence:original}]);
  assert.equal(plan.interpretation.mode,'agent-resolved');
  assert.equal(plan.interpretation.original,original);
  assert.deepEqual(plan.tasks.map(t=>t.id),['pagination']);
  assert.ok(plan.components.some(c=>c.name==='List_Navigation'));
 }
 assert.throws(()=>traditionalTaskPlan('hello',[{pattern:'dialog',evidence:'not in request'}]),/exact excerpt/);
 assert.throws(()=>traditionalTaskPlan('hello',[{pattern:'made-up',evidence:'hello'}]),/Unknown behavior/);
 assert.equal(traditionalResolutionRequest('unknown').status,'needs-semantic-resolution');
 const p=traditionalTaskPlan('Do not add a Modal. Show results in pages',[{pattern:'pagination',evidence:'Show results in pages'}]);
 assert.ok(!p.components.some(c=>c.name==='Modal'),'explicit resolution excludes negated named components');
});

test('dialog compiles official content, open/close actions and Ajax triggers together',()=>{
 const job=implementTraditionalTask(traditionalTaskPlan('modal'),{pattern:'dialog',screen:'Audit',action:'ToggleHelp',parent:'@parent',name:'Help',alias:'$help',title:'"Help"',content:'"Details"',openLabel:'Open',closeLabel:'Close'});
 assert.ok(job.ops.some(o=>o.source==='IWebBlock:Modal'));
 assert.equal(job.ops.filter(o=>o.prop==='Method'&&o.value==='Ajax').length,2);
 assert.equal(job.ops.filter(o=>o.prop==='Validation'&&o.value==='None').length,2);
 assert.match(job.ops.find(o=>o.op==='logic').data.flow,/ToggleModal\(WidgetId=Help.Id, TriggerButtonId=HelpOpen.Id\)/);
 assert.ok(job.ops.some(o=>o.parent==='$help/Footer'));
});

test('tabs pair unique DataTab keys and accordion authors actual content',()=>{
 for(const pattern of ['tabs','accordion']){
  const input={pattern,parent:'@p',name:'Sections',alias:'$sections',items:[{id:'One',title:'"One"',content:'Summary'},{id:'Two',title:'"Two"',content:'Details'}]};
  const job=implementTraditionalTask(traditionalTaskPlan(pattern),input);
  assert.ok(job.ops.some(o=>o.value==='Summary'));
  assert.ok(job.ops.some(o=>o.value==='Details'));
  if(pattern==='tabs')assert.equal(job.ops.filter(o=>o.target?.endsWith('/DataTab')&&o.value==='"One"').length,2);
  assert.throws(()=>implementTraditionalTask(traditionalTaskPlan(pattern),{...input,items:[input.items[0],input.items[0]]}),/Duplicate/);
 }
});
for(const [intent,ids,names] of cases) test('task: '+intent,()=>{
 const p=traditionalTaskPlan(intent);
 assert.deepEqual(p.tasks.map(t=>t.id),ids);
 for(const name of names)assert.ok(p.components.some(c=>c.name===name),name);
 assert.deepEqual(p.missing,[]);
 assert.ok(p.tasks.every(t=>t.steps.length>0));
 const packet=packetTextSection({lane:'o11',intent,found:{digest:{module:{name:'Requests_TW',kind:'WebResponsive'}}}}).value;
 assert.deepEqual(packet.taskPlan.tasks,p.tasks);
 assert.equal(packet.creating,false,'adding widgets must not fabricate a new screen');
});

test('pagination behavior compiles query offset, fetch, state assignment, render and OnNotify in order',()=>{
 const plan=traditionalTaskPlan('coloque paginação');
 const input={pattern:'pagination',screen:'Orders',action:'PageChanged',parent:'@region',name:'Pager',alias:'$pager',listWidgetId:'Table.Id',pageSize:'20',total:'Total',offsetVariable:'StartIndex',query:{action:'OrdersCS.ListOrders',arguments:{Start:'StartIndex',Quantity:'20'}},assign:{Rows:'Loaded.Rows',Total:'Loaded.Total'},refreshTarget:'Results'};
 const job=implementTraditionalTask(plan,input), flow=job.ops.find(o=>o.op==='logic').data.flow;
 const fragments=['List_Navigation_GetStartIndex','assign StartIndex = Page.StartIndex','Loaded = OrdersCS.ListOrders(Start=StartIndex, Quantity=20)','assign Rows = Loaded.Rows','assign Total = Loaded.Total','AjaxRefreshNode'];
 let last=-1;for(const f of fragments){const at=flow.indexOf(f);assert.ok(at>last,f);last=at;}
 assert.deepEqual(job.ops.at(-1),{op:'set',target:'$pager/OnNotify',prop:'Destination',value:'IWebScreen:Orders/IScreenAction:PageChanged'});
 assert.throws(()=>implementTraditionalTask(plan,{...input,query:{...input.query,arguments:{Quantity:'20'}}}),/offsetVariable/);
});

test('success feedback compiles after business call and wires the Ajax trigger, never before the save',()=>{
 const job=implementTraditionalTask(traditionalTaskPlan('mostre mensagem ao salvar'),{pattern:'feedback',screen:'Order',action:'SaveWithFeedback',trigger:'@save',businessCall:{action:'OrdersCS.Save',arguments:{Id:'OrderId'}},message:'"Saved"',messageType:'Entities.MessageType.Success'});
 const flow=job.ops.find(o=>o.op==='logic').data.flow;
 assert.ok(flow.indexOf('OrdersCS.Save')<flow.indexOf('RichWidgets.Feedback_Message'));
 assert.equal(job.ops.at(-1).value,'Ajax');
 assert.ok(job.ops.some(o=>o.prop==='Destination'&&o.value.endsWith(':SaveWithFeedback')));
 assert.throws(()=>implementTraditionalTask(traditionalTaskPlan('crie abas'),{pattern:'tabs',screen:'S',action:'A'}),/Unknown task binding/);
});

test('combined request retains behaviors and their dependency/binding contracts',()=>{
 const p=traditionalTaskPlan('Inclua paginação, permita ordenar e mostre mensagem ao salvar');
 assert.deepEqual(p.tasks.map(t=>t.id),['pagination','sorting','feedback']);
 const pager=p.components.find(c=>c.name==='List_Navigation');
 const ops=bindTraditionalBlock(pager,{parent:'@listParent',name:'Pager',alias:'$pager',inputs:{ListWidgetId:'RequestsTable.Id',LineCount:'20',TotalRowCount:'TotalFiltrado'}});
 assert.deepEqual(ops[0],{op:'reference',producer:'RichWidgets',elements:['IWebBlock:List_Navigation']});
 assert.equal(ops[1].source,'IWebBlock:List_Navigation');
 assert.equal(ops.find(o=>o.target==='$pager/TotalRowCount').value,'TotalFiltrado');
 assert.match(p.tasks[0].steps.join(' '),/not the current page length/);
 assert.match(p.tasks[1].steps.join(' '),/never interpolate an arbitrary user string/);
 assert.match(p.tasks[2].steps.join(' '),/must not show success/);
});

test('all public blocks can be requested by name without exposing private blocks',()=>{
 for(const c of traditionalCatalog())for(const b of c.data.Blocks.filter(b=>b.Public)){
   const p=traditionalTaskPlan('Use '+c.library+'.'+b.Name);
   assert.ok(p?.components.some(x=>x.library===c.library&&x.name===b.Name),c.library+'.'+b.Name);
 }
 assert.equal(traditionalTaskPlan('Use RichWidgets.jQueryComponents'),null);
});

test('negation, unsupported requests and ODC do not silently select a Traditional substitute',()=>{
 const p=traditionalTaskPlan('Sem popup, coloque paginação');
 assert.deepEqual(p.tasks.map(t=>t.id),['pagination']);
 assert.ok(!p.components.some(c=>c.name==='Popup_Editor'||c.name==='Modal'));
 assert.equal(traditionalTaskPlan('Não use RichWidgets.Popup_Editor'),null);
 assert.equal(traditionalTaskPlan('otimize uma consulta SQL'),null);
  assert.equal(traditionalTaskPlan('ordenar resultados na consulta SQL'),null);
 assert.equal(packetTextSection({lane:'odc',intent:'editar popup Traditional'}),null);
});

test('binding refuses missing/unknown inputs instead of fabricating defaults',()=>{
 const c=traditionalTaskPlan('coloque paginação').components[0];
 const args={parent:'@parent',name:'Pager',alias:'$pager',inputs:{}};
 assert.throws(()=>bindTraditionalBlock(c,args),/Missing binding: ListWidgetId/);
 assert.throws(()=>bindTraditionalBlock(c,{...args,inputs:{IsOpen:'True'}}),/Unknown input/);
 assert.throws(()=>bindTraditionalBlock(c,{...args,parent:'<guess>'}),/Resolve parent/);
});

test('public reference tool turns the task into concrete native ops and keeps integration outstanding',async t=>{
 const kernel=tempKernel({cli:false});
 const mcp=await linked(registerSsamReference,{root:kernel.root,env:kernel.env});
 t.after(async()=>{await mcp.close();kernel.cleanup();});
 const query={traditionalTask:'Coloque paginação',bind:{library:'RichWidgets',component:'List_Navigation',parent:'@parent',name:'Pager',alias:'$pager',inputs:{ListWidgetId:'Table.Id',LineCount:'20',TotalRowCount:'Total'}}};
 const r=await mcp.call('ssam_reference',{lane:'o11',kind:'recipe',query});
 assert.equal(r.ok,true);assert.equal(r.job.ops.length,5);assert.equal(r.verified,false);
 assert.equal(r.remaining[0].id,'pagination');
 assert.equal((await mcp.call('ssam_reference',{lane:'odc',kind:'recipe',query})).code,'TRADITIONAL_NOT_IN_LANE');
 assert.equal((await mcp.call('ssam_reference',{lane:'o11',kind:'recipe',query:{...query,bind:{...query.bind,component:'Modal'}}})).code,'COMPONENT_NOT_SELECTED');
 const original='別の層で説明を表示してください';
 const unknown=await mcp.call('ssam_reference',{lane:'o11',kind:'recipe',query:{traditionalTask:original}});
 assert.equal(unknown.ok,true);assert.equal(unknown.data.status,'needs-semantic-resolution');
 const implemented=await mcp.call('ssam_reference',{lane:'o11',kind:'recipe',query:{traditionalTask:original,resolution:[{pattern:'dialog',evidence:original}],implement:{pattern:'dialog',screen:'Audit',action:'Toggle',parent:'@parent',name:'Help',alias:'$help',title:'"Title"',content:'"Body"',openLabel:'Open',closeLabel:'Close'}}});
 assert.equal(implemented.ok,true);assert.equal(implemented.verified,false);
 assert.ok(implemented.job.ops.some(o=>o.source==='IWebBlock:Modal'));
});
