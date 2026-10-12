// Original messages provider: allocate its native message dictionary and store
// literal messages. With no translation resources, locale callbacks stay idle.
import {parse} from 'acorn';
import {createHash} from 'node:crypto';
import {createOdcSdkBindingReader} from './debug-odc-native-sdk-binding.mjs';
import {qualifyOdcSdkInitializationPrimitives} from './debug-odc-sdk-initialization-primitives.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const fail=code=>{throw new Error('debug_odc_messages_initialization_'+code);};
const id=n=>n?.type==='Identifier'?n.name:null;
export function inspectOdcMessagesDeclaration(source,exported){
 const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'}),imports=new Map(),values=new Map(),helpers=[];
 let provider,instance,messageCount=0;
 const statements=n=>n.type==='SequenceExpression'?n.expressions:[n];
 for(const row of ast.body){
  if(row.type==='ImportDeclaration'){
   for(const s of row.specifiers){if(s.type!=='ImportSpecifier'||imports.has(s.local.name))fail('import');imports.set(s.local.name,{file:row.source.value,export:s.imported.name});}
   continue;
  }
  if(row.type==='VariableDeclaration'){
   for(const d of row.declarations){
    if(!id(d.id)||values.has(d.id.name)||imports.has(d.id.name))fail('declaration');
    const n=d.init;
    if(n?.type==='Identifier'){
     const value=values.get(n.name);if(!value)fail('alias');values.set(d.id.name,value);continue;
    }
    if(n?.type==='ClassExpression'){
     const base=n.superClass;
     if(provider||base?.type!=='MemberExpression'||base.computed||base.property.name!=='BaseMessagesProvider'||!imports.has(id(base.object)))fail('class');
     if(n.body.body.length!==1||n.body.body[0].kind!=='constructor'||n.body.body[0].type!=='MethodDefinition')fail('class');
     const ctor=n.body.body[0].value;
     if(ctor.params.length>1||ctor.params.some(p=>!id(p))||ctor.body.body.some(s=>s.type!=='ExpressionStatement'))fail('constructor');
     const calls=ctor.body.body.flatMap(s=>statements(s.expression)),first=calls.shift();
     if(first?.type!=='CallExpression'||first.callee.type!=='Super'||first.arguments.length!==ctor.params.length||
      first.arguments.some((a,i)=>id(a)!==id(ctor.params[i])))fail('super');
     const keys=new Set();for(const call of calls){
      const member=call.callee;
      if(call.type!=='CallExpression'||member?.type!=='MemberExpression'||member.computed||member.object.type!=='ThisExpression'||
       member.property.name!=='setMessage'||call.arguments.length!==2||call.arguments.some(a=>a.type!=='Literal'||typeof a.value!=='string'))fail('message');
      const key=call.arguments[0].value;if(keys.has(key)||['__proto__','constructor','prototype'].includes(key))fail('message_key');keys.add(key);
     }
     messageCount=keys.size;provider={kind:'class',binding:{...imports.get(base.object.name),member:'BaseMessagesProvider'},classSha256:hash(source.slice(n.start,n.end))};
     values.set(d.id.name,provider);continue;
    }
    if(n?.type==='NewExpression'&&id(n.callee)&&!n.arguments.length&&values.get(n.callee.name)===provider&&provider&&!instance){
     instance={kind:'instance'};values.set(d.id.name,instance);continue;
    }
    fail('initializer');
   }continue;
  }
  if(row.type==='ExpressionStatement'){
   const call=row.expression;
   if(call.type!=='CallExpression'||!imports.has(id(call.callee))||call.arguments.length!==2||
    values.get(id(call.arguments[0]))!==provider||!provider||call.arguments[1].type!=='Literal'||typeof call.arguments[1].value!=='string')fail('expression');
   helpers.push(imports.get(call.callee.name));continue;
  }
  if(row.type==='ExportNamedDeclaration'&&!row.source&&!row.declaration)continue;
  fail('statement');
 }
 const exports=ast.body.filter(n=>n.type==='ExportNamedDeclaration').flatMap(n=>n.specifiers).filter(s=>s.exported.name===exported);
 if(!provider||!instance||exports.length!==1||values.get(exports[0].local.name)!==instance||!helpers.length)fail('export');
 if(ast.body.some(n=>n.type==='ImportDeclaration'&&n.source.value!==provider.binding.file))fail('additional_import');
 return {sourceSha256:hash(source),provider,helpers,messageCount,translationResourcesSupplied:false,localeCallbackExecuted:false};
}
export function qualifyOdcMessagesInitialization(files,importer){
 if(importer?.resolved!==true||importer.imports?.length!==1||!/^\.\/_oschunk-[A-Za-z0-9]+\.js$/.test(importer.imports[0]))fail('importer');
 const wrapperFile=importer.imports[0].slice(2),wrapper=files[wrapperFile];if(typeof wrapper!=='string')fail('source');
 const ast=parse(wrapper,{ecmaVersion:'latest',sourceType:'module'});
 if(ast.body.some(n=>n.type!=='ImportDeclaration'&&(n.type!=='ExportNamedDeclaration'||n.source||n.declaration)))fail('wrapper');
 const exports=ast.body.filter(n=>n.type==='ExportNamedDeclaration').flatMap(n=>n.specifiers).filter(s=>s.exported.name==='default');
 if(exports.length!==1)fail('wrapper_export');
 const bindings=ast.body.filter(n=>n.type==='ImportDeclaration').flatMap(n=>n.specifiers.filter(s=>s.type==='ImportSpecifier'&&s.local.name===exports[0].local.name).map(s=>({file:n.source.value,export:s.imported.name})));
 if(bindings.length!==1||!/^\.\/_oschunk-[A-Za-z0-9]+\.js$/.test(bindings[0].file))fail('wrapper_binding');
 const file=bindings[0].file.slice(2),declaration=inspectOdcMessagesDeclaration(files[file],bindings[0].export);
 const sdk=createOdcSdkBindingReader(files)(declaration.provider.binding),coreFile=sdk.file;
 if(sdk.chunkSha256!=='1dbfad22bdf417ed43aa1ac716b3a0b402345f4608efbb4025e0be4acdfeb40d'||
  sdk.declarationSha256!=='cffbaa84b3046fa46e13bf7b0b984fcae77b8215cad2c95168650a42ad8474d8')fail('sdk_unreviewed');
 for(const row of ast.body)if(row.type==='ImportDeclaration'&&
  (row.source.value!==bindings[0].file&&!(row.source.value==='./'+coreFile&&!row.specifiers.length)||
   row.source.value===bindings[0].file&&(row.specifiers.length!==1||row.specifiers[0].local.name!==exports[0].local.name)))fail('wrapper_import');
 for(const helper of declaration.helpers){
  if(helper.file!=='./'+coreFile||!qualifyOdcSdkInitializationPrimitives(files,{file:coreFile,helperExport:helper.export,controllerExport:'I'}).naming.qualified)fail('naming');
 }
 return {initializationQualified:true,nativeEffectsQualified:true,wrapperSyntaxQualified:true,pendingNativeEffectKinds:[],
  requiredAlreadyLoadedModules:[coreFile],controller:{sourceHashes:{[file]:declaration.sourceSha256,[wrapperFile]:hash(wrapper)}},
  module:wrapperFile,messageCount:declaration.messageCount,translationResourcesSupplied:false,localeCallbackExecuted:false,
  applicationStartupQualified:false,executionAuthorized:false};
}
