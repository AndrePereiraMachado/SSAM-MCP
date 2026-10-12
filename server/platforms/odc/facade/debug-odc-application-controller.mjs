// Resolve the published application-controller importer without executing it.
// Declaration discovery is not qualification of module initialization or SDK
// dispatch: imported functions and dynamically installed handlers remain distinct.
import {parse} from 'acorn';
import {createHash} from 'node:crypto';
const fail=reason=>{throw new Error('debug_odc_application_controller_'+reason);};
const name=n=>n?.type==='Identifier'?n.name:n?.type==='Literal'?n.value:null;
export function inspectOdcApplicationController(files,importer,{baseMember='BaseModuleController'}={}){
 if(!['BaseModuleController','BaseController'].includes(baseMember))fail('base');
 if(importer?.resolved!==true||importer.imports?.length!==1)fail('importer');
 const cache=new Map(),trail=[];
 function module(file){
  if(!/^_oschunk-[A-Za-z0-9]+\.js$/.test(file)||typeof files[file]!=='string')fail('source');
  if(cache.has(file))return cache.get(file);
  const source=files[file],ast=parse(source,{ecmaVersion:'latest',sourceType:'module'});
  const result={source,ast,exports:new Map(),imports:new Map(),declarations:new Map()};
  for(const row of ast.body){
   if(row.type==='ImportDeclaration')for(const spec of row.specifiers){
    if(spec.type==='ImportNamespaceSpecifier')continue;
    result.imports.set(spec.local.name,{file:relative(row.source.value),exported:spec.type==='ImportDefaultSpecifier'?'default':name(spec.imported)});
   }
   if(row.type==='ExportNamedDeclaration')for(const spec of row.specifiers)
    result.exports.set(name(spec.exported),row.source?{file:relative(row.source.value),exported:name(spec.local)}:{local:name(spec.local)});
   if(row.type==='ExportDefaultDeclaration')result.exports.set('default',{node:row.declaration});
   const declaration=row.type==='ExportNamedDeclaration'?row.declaration:row;
   if(declaration?.type==='VariableDeclaration')for(const d of declaration.declarations){
    if(d.id.type==='Identifier')result.declarations.set(d.id.name,d.init);
   }
   if(declaration?.type==='ClassDeclaration')result.declarations.set(declaration.id.name,declaration);
  }
  cache.set(file,result);return result;
 }
 function relative(spec){if(typeof spec!=='string'||!/^\.\/_oschunk-[A-Za-z0-9]+\.js$/.test(spec))fail('import');return spec.slice(2);}
 function resolve(file,kind,symbol,active=new Set()){
  const marker=file+':'+kind+':'+symbol;if(active.has(marker))fail('cycle');active.add(marker);trail.push(marker);
  const m=module(file);let node;
  if(kind==='export'){
   const binding=m.exports.get(symbol);if(!binding)fail('export');
   if(binding.file)return resolve(binding.file,'export',binding.exported,active);
   if(binding.local)return resolve(file,'local',binding.local,active);
   node=binding.node;
  }else{
   const binding=m.imports.get(symbol);
   if(binding)return resolve(binding.file,'export',binding.exported,active);
   node=m.declarations.get(symbol);
  }
  if(node?.type==='Identifier')return resolve(file,'local',node.name,active);
  if(!node)fail('declaration');return {file,node,...(kind==='local'?{local:symbol}:{})};
 }
 const entry=resolve(relative(importer.imports[0]),'export','default');
 if(entry.node.type!=='NewExpression'||entry.node.arguments.length||entry.node.callee.type!=='Identifier')fail('instance');
 const controller=resolve(entry.file,'local',entry.node.callee.name),cls=controller.node;
 if(!['ClassExpression','ClassDeclaration'].includes(cls.type)||cls.superClass?.type!=='MemberExpression'||cls.superClass.computed||
  name(cls.superClass.property)!==baseMember||cls.superClass.object.type!=='Identifier')fail('base');
 const base=module(controller.file).imports.get(cls.superClass.object.name);if(!base)fail('base_import');
 const members=cls.body.body;
 if(members.some(m=>m.type!=='MethodDefinition'||m.computed||m.static||typeof name(m.key)!=='string'))fail('members');
 const constructor=members.find(m=>m.kind==='constructor');
 if(constructor){
  const fn=constructor.value,call=fn.body.body[0]?.expression;
  if(fn.params.some(p=>p.type!=='Identifier')||fn.body.body.length!==1||call?.type!=='CallExpression'||call.callee.type!=='Super'||
   call.arguments.length!==fn.params.length||call.arguments.some((a,i)=>a.type!=='Identifier'||a.name!==fn.params[i].name))fail('constructor');
 }
 const dispatch=['onApplicationReadyHandler','onApplicationResumeHandler','onSyncHandler'];
 const handlers=dispatch.map(handler=>({handler,declared:members.some(m=>name(m.key)===handler)}));
 const hash=s=>createHash('sha256').update(s).digest('hex');
 return {schema:'ssam-odc-application-controller/1',controllerChunk:controller.file,
  instanceBinding:entry.local?{file:entry.file,local:entry.local}:null,
  controllerSha256:hash(files[controller.file]),classSha256:hash(files[controller.file].slice(cls.start,cls.end)),
  baseImport:base,baseMember,constructorDelegates:!!constructor||baseMember==='BaseController',handlers,overriddenDispatch:members.filter(m=>['fireApplicationReady','setupOnApplicationResumeListener','setupSyncOnResume','fireApplicationResume'].includes(name(m.key))).map(m=>name(m.key)),
  resolution:trail,sourceHashes:Object.fromEntries([...cache.keys()].map(file=>[file,hash(files[file])])),
  initializationQualified:false,sdkDispatchQualified:false,executionAuthorized:false};
}
