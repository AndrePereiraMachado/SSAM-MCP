import {traditionalCatalog} from './traditional-tasks.mjs';

const ident=(v,label)=>{if(typeof v!=='string'||! /^[A-Za-z_]\w*$/.test(v))throw new Error('Invalid '+label);return v;};
const expr=(v,label)=>{if(typeof v!=='string'||!v.trim()||/[\r\n]/.test(v))throw new Error('Resolve '+label);return v;};
const shape=(v,keys,label)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))throw new Error('Invalid fields in '+label);};

export const compositionContract={
  schema:'ssam-traditional-compose/1',
  purpose:'Generate a complete new Traditional screen with catalog components, nested controls, state, data loading and event handlers. Interpret the original request semantically before composing; no keyword gate.',
  screen:{name:'NewScreen',flow:'MainFlow',title:'Screen title'},
  variables:[{name:'Rows',type:'EntityOrStructure List',default:'optional expression'}],
  content:'Recursive nodes: component, container, expression, input, link, table, if. Every node has a unique name. A component has library, component, expression inputs, slots (arrays of nodes), events. Inherited OnNotify and catalog-declared events are distinct native contracts.',
  component:{type:'component',name:'Calendar',library:'OutSystemsUIWeb',component:'DatePicker',inputs:{InputWidgetId:'DateInput.Id'},events:{OnSelect:{action:'DateSelected',arguments:{SelectedDate:'StartDate'}}}},
  controls:{input:{type:'input',name:'NameInput',bind:'Record.Name',mandatory:true},link:{type:'link',name:'Save',caption:'"Save"',action:'Save',method:'Ajax',validation:'Server',arguments:{}},table:{type:'table',name:'ResultsTable',source:'Rows',lineCount:'20',columns:[{header:[],content:[]}]},if:{type:'if',name:'Empty',condition:'Rows.Empty',then:[],else:[]}},
  flows:'Complete ssam-flow/1 text for new business/server and screen actions. Every linked handler must be declared. Data fetching, authorization, validation and success/error branches belong here, not implicit guesses.',
  initial:{action:'LocalListAction',arguments:{Search:'Search'},assign:{Rows:'InitialLoad.Rows',Total:'InitialLoad.Total'}},
  ddl:'optional ssam-ddl/1 text for supporting data types/entities',
  exceptions:['OptionalNamedException'],
  references:[{producer:'Producer',elements:['IServerAction:Action']}],
  acceptance:'Generated is not verified. Deliver once with the actual published producer captures, then validate native model, publication and browser. Existing roots/actions require keyed edits, not this create-only form.'
};

export function composeTraditionalTask(spec){
  shape(spec,['screen','variables','content','flows','initial','ddl','exceptions','references'],'composition');
  shape(spec.screen,['name','flow','title'],'screen');
  const screen=ident(spec.screen.name,'screen'),flow=ident(spec.screen.flow,'flow');
  if(typeof spec.screen.title!=='string')throw new Error('Screen title required');
  if(typeof spec.flows!=='string')throw new Error('Provide the complete action flows');
  const ops=[],wires=[],names=new Set(),imports=new Map();let count=0;
  const addRef=(producer,element)=>{if(!imports.has(producer))imports.set(producer,new Set());imports.get(producer).add(element);};
  const set=(target,prop,value)=>ops.push({op:'set',target,prop,value});
  const create=(parent,type,name)=>{const as='$compose'+(++count);ops.push({op:'create',parent,type,...(name?{name}:{}),as});return as;};
  const handlers=new Set([...spec.flows.matchAll(new RegExp('^action '+screen+'\\.([A-Za-z_]\\w*)\\b','gm'))].map(m=>m[1]));
  const wire=(target,event,handler,args={},prop='Destination')=>{
    ident(handler,'handler');if(!handlers.has(handler))throw new Error('Missing handler body: '+screen+'.'+handler);
    wires.push({op:'set',target:target+'/'+event,prop,value:'IWebScreen:'+screen+'/IScreenAction:'+handler});
    for(const [p,value]of Object.entries(args)){ident(p,'argument');wires.push({op:'set',target:target+'/'+event+'/'+p,prop:'Value',value:expr(value,p)});}
  };
  for(const r of spec.references??[]){shape(r,['producer','elements'],'reference');ident(r.producer,'producer');for(const e of r.elements??[])addRef(r.producer,e);}
  if(spec.ddl)ops.push({op:'spec',data:{ddl:spec.ddl}});
  for(const e of spec.exceptions??[])create('@espace','IUserException',ident(e,'exception'));
  const root=create('IWebFlow:'+flow,'IWebScreen',screen);
  const title=create(root+'/#IWebBlockInstanceWidget/Title','IExpressionWidget');set(title,'Value',JSON.stringify(spec.screen.title));
  for(const v of spec.variables??[]){shape(v,['name','type','default'],'variable');ident(v.name,'variable');if(names.has(v.name))throw new Error('Duplicate name '+v.name);names.add(v.name);const p=create(root,'ILocalVariable',v.name);set(p,'DataType',expr(v.type,'type'));if(v.default!==undefined)set(p,'DefaultValue',expr(v.default,'default'));}
  function nodes(list,parent,depth=0){
    if(!Array.isArray(list)||depth>24)throw new Error('Invalid content tree');
    for(const n of list){
      if(++count>3000)throw new Error('Composition too large');
      const fields={component:['library','component','inputs','slots','events'],container:['children','class'],expression:['value'],input:['bind','mandatory','maxLength'],link:['caption','action','method','validation','arguments'],table:['source','lineCount','columns'],if:['condition','then','else']}[n.type];
      if(!fields)throw new Error('Unsupported content node '+n.type);shape(n,['type','name',...fields],n.type);
      ident(n.name,'node name');if(names.has(n.name))throw new Error('Duplicate name '+n.name);names.add(n.name);
      if(n.type==='component'){
        const catalog=traditionalCatalog().find(c=>c.library===n.library),block=catalog?.data.Blocks.find(b=>b.Name===n.component&&b.Public);
        if(!block)throw new Error('Unknown public Traditional component '+n.library+'.'+n.component);
        const inputs=n.inputs??{},slots=n.slots??{};
        for(const p of Object.keys(inputs))if(!block.Inputs?.some(i=>i.Name===p))throw new Error('Unknown input '+n.component+'.'+p);
        for(const p of block.Inputs??[])if(p.Mandatory&&p.Default==null&&!Object.hasOwn(inputs,p.Name))throw new Error('Missing input '+n.component+'.'+p.Name);
        for(const s of Object.keys(slots))if(!block.Placeholders?.some(p=>p.Name===s))throw new Error('Unknown placeholder '+n.component+'.'+s);
        addRef(n.library,'IWebBlock:'+n.component);const p=create(parent,'IWebBlockInstanceWidget',n.name);Object.assign(ops.at(-1),{source:'IWebBlock:'+n.component,empty:true});
        for(const[k,v]of Object.entries(inputs))set(p+'/'+k,'Value',expr(v,k));
        for(const[s,children]of Object.entries(slots))nodes(children,p+'/'+s,depth+1);
        for(const e of block.Events??[])if(e.Mandatory&&!Object.hasOwn(n.events??{},e.Name))throw new Error('Missing mandatory event '+n.component+'.'+e.Name);
        for(const[event,binding]of Object.entries(n.events??{})){
          const contract=block.Events?.find(e=>e.Name===event);
          if(event!=='OnNotify'&&!contract)throw new Error('Unsupported Traditional block event '+event);
          const b=typeof binding==='string'?{action:binding}:binding;shape(b,['action','arguments'],'event binding');
          if(contract?.Params?.some(p=>p.Mandatory)&&!Object.keys(b.arguments??{}).length)throw new Error('Bind event parameters for '+event);
          wire(p,event,b.action,b.arguments,event==='OnNotify'?'Destination':'Handler');
        }
      }else if(n.type==='container'){const p=create(parent,'IContainerWidget',n.name);if(n.class)set(p,'StyleClasses',n.class);nodes(n.children??[],p,depth+1);
      }else if(n.type==='expression'){set(create(parent,'IExpressionWidget',n.name),'Value',expr(n.value,'value'));
      }else if(n.type==='input'){const p=create(parent,'IInputWidget',n.name);set(p,'Variable',expr(n.bind,'binding'));if(n.mandatory!==undefined)set(p,'Mandatory',n.mandatory?'True':'False');if(n.maxLength!==undefined){if(!Number.isInteger(n.maxLength)||n.maxLength<1)throw new Error('Invalid maxLength');wires.push({op:'set',target:p,prop:'MaxLength',value:String(n.maxLength)});}
      }else if(n.type==='link'){
        if(!['Ajax','Submit'].includes(n.method))throw new Error('Screen action method must be Ajax or Submit');
        if(!['None','Server','ClientAndServer'].includes(n.validation))throw new Error('Explicit validation mode required');
        const p=create(parent,'ILinkWidget',n.name);set(p,'StyleClasses','Button');set(create(p,'IExpressionWidget'),'Value',expr(n.caption,'caption'));wire(p,'OnClick',n.action,n.arguments);set(p+'/OnClick','Method',n.method);set(p+'/OnClick','Validation',n.validation);
      }else if(n.type==='table'){
        const p=create(parent,'ITableRecordsWidget',n.name);set(p,'SourceRecordList',expr(n.source,'table source'));if(n.lineCount)set(p,'LineCount',expr(n.lineCount,'line count'));
        for(const c of n.columns??[]){shape(c,['header','content'],'column');nodes(c.header,create(p+'/HeaderRow','ICellWidget'),depth+1);nodes(c.content,create(p+'/DataRow','ICellWidget'),depth+1);}
      }else if(n.type==='if'){
        const p=create(parent,'OutSystems.Model.UI.Web.Widgets.IIfWidget',n.name);set(p,'Condition',expr(n.condition,'condition'));nodes(n.then??[],p+'/TrueBranch',depth+1);nodes(n.else??[],p+'/FalseBranch',depth+1);
      }
    }
  }
  nodes(spec.content,root+'/#IWebBlockInstanceWidget/MainContent');
  ops.push({op:'logic',data:{flow:spec.flows}});
  if(spec.initial){
    shape(spec.initial,['action','arguments','assign'],'initial');const initial=spec.initial;ident(initial.action,'initial local action');
    if(!new RegExp('^server action '+initial.action+'\\b','m').test(spec.flows))throw new Error('Declare the initial server action');
    const p=create(root,'IPreparation'),start=create(p,'IStartNode'),call=create(p,'IExecuteServerActionNode','InitialLoad');set(call,'Action','IServerAction:'+initial.action);
    for(const[k,v]of Object.entries(initial.arguments??{}))set(call+'/'+ident(k,'initial argument'),'Value',expr(v,k));
    const a=create(p,'IAssignNode');for(const[k,v]of Object.entries(initial.assign??{})){ident(k,'initial variable');if(!names.has(k))throw new Error('Unknown initial state '+k);const item=create(a,'IAssignment');set(item,'Variable',k);set(item,'Value',expr(v,k));}
    const end=create(p,'IEndNode');for(const[from,to]of [[start,call],[call,a],[a,end]])ops.push({op:'link',from,to});ops.push({op:'layout',target:p});
  }
  ops.push(...wires);
  return {ops:[...[...imports].map(([producer,elements])=>({op:'reference',producer,elements:[...elements]})),...ops]};
}
