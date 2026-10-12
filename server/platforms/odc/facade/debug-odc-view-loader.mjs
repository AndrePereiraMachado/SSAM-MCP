// Bind the bootstrap to the reviewed native router/ScreenLoader. The platform
// permission gate is retained; this does not assert that a user passed it.
import {parse} from 'acorn';
import {createOdcSdkBindingReader} from './debug-odc-native-sdk-binding.mjs';
import {qualifyOdcBootstrapRoutes} from './debug-odc-bootstrap-routes.mjs';
const reviewedUi='c9565f2d4c2afd26a125afc65f1174e43703d235d4e76035da3fff6185299bca';
const reviewedCore='1dbfad22bdf417ed43aa1ac716b3a0b402345f4608efbb4025e0be4acdfeb40d';
export function inspectOdcNativeViewLoader(files,bootstrapFile){
 const fail=code=>{throw new Error('debug_odc_view_loader_'+code);};
 if(typeof files?.[bootstrapFile]!=='string')fail('source');
 const ast=parse(files[bootstrapFile],{ecmaVersion:'latest',sourceType:'module'}),imports=new Map(),declarations=new Map(),calls=[],parents=new Map();
 for(const row of ast.body){
  if(row.type==='ImportDeclaration')for(const spec of row.specifiers)if(spec.type==='ImportSpecifier')imports.set(spec.local.name,{file:row.source.value,export:spec.imported.name});
  if(row.type==='VariableDeclaration')for(const d of row.declarations)if(d.id.type==='Identifier')declarations.set(d.id.name,d.init);
 }
 function visit(n,parent){if(!n||typeof n!=='object')return;if(parent)parents.set(n,parent);
  if(n.type==='CallExpression'&&n.callee.type==='MemberExpression'&&!n.callee.computed&&n.callee.property.name==='load'&&n.callee.object.type==='Identifier')calls.push(n);
  for(const value of Object.values(n))if(Array.isArray(value))value.forEach(v=>visit(v,n));else if(value&&typeof value==='object')visit(value,n);
 }
 visit(ast);if(calls.length!==1)fail('ambiguous');
 const call=calls[0],imported=imports.get(call.callee.object.name),options=call.arguments[1];
 if(!imported||call.arguments.length!==2||options?.type!=='ObjectExpression'||options.properties.length!==2)fail('call');
 const values=new Map();for(const prop of options.properties){
  if(prop.type!=='Property'||prop.computed||prop.kind!=='init'||prop.method||prop.value.type!=='Identifier'||values.has(prop.key.name))fail('options');
  values.set(prop.key.name,prop.value.name);
 }
 if(!values.has('staticScreenRoutes')||!values.has('staticSplashRoute'))fail('options');
 const routes=declarations.get(values.get('staticScreenRoutes')),splash=declarations.get(values.get('staticSplashRoute'));
 if(routes?.type!=='ArrayExpression'||!routes.elements.length||splash?.type!=='Literal'||splash.value!==null)fail('routes');
 const runtime=call.arguments[0];
 if(runtime?.type!=='MemberExpression'||runtime.computed||runtime.object.type!=='Identifier'||runtime.property.name!=='default'||!imports.has(runtime.object.name))fail('application');
 const protectedNames=new Set([call.callee.object.name,runtime.object.name,...values.values()]);
 function declares(n){if(!n||typeof n!=='object')return false;
  if(n.type==='VariableDeclarator'){const names=[];function identifiers(p){if(p?.type==='Identifier')names.push(p.name);else if(p&&typeof p==='object')for(const v of Object.values(p))if(Array.isArray(v))v.forEach(identifiers);else if(v&&typeof v==='object')identifiers(v);}identifiers(n.id);if(names.some(name=>protectedNames.has(name)))return true;}
  return Object.values(n).some(v=>Array.isArray(v)?v.some(declares):v&&typeof v==='object'&&declares(v));
 }
 for(let owner=parents.get(call);owner&&owner.type!=='Program';owner=parents.get(owner)){
  if(['FunctionExpression','ArrowFunctionExpression','FunctionDeclaration'].includes(owner.type)&&
   (owner.params.some(p=>p.type!=='Identifier'||protectedNames.has(p.name))||declares(owner.body)))fail('shadowed_binding');
 }
 const bind=createOdcSdkBindingReader(files),loader=bind({...imported,member:'load'});
 if(loader.chunkSha256!==reviewedUi)fail('runtime_unreviewed');
 const canonicalLoader=bind({file:imported.file,export:'g',member:'load'});
 if(loader.declarationSha256!==canonicalLoader.declarationSha256)fail('loader_binding');
 const importedApplication=imports.get(runtime.object.name);
 const application=bind({...importedApplication,member:'default'});
 if(application.chunkSha256!==reviewedCore||application.declarationKind!=='NewExpression')fail('application_unreviewed');
 const canonicalApplication=bind({file:importedApplication.file,export:'E',member:'default'});
 if(application.declarationSha256!==canonicalApplication.declarationSha256)fail('application_binding');
 const routeQualification=qualifyOdcBootstrapRoutes(files,bootstrapFile,values.get('staticScreenRoutes'));
 return {schema:'ssam-odc-native-view-loader/1',nativeLoaderBound:true,file:loader.file,export:loader.export,
  declarationSha256:loader.declarationSha256,chunkSha256:loader.chunkSha256,
  loaderOverridesPresent:false,nativePermissionGatePreserved:true,permissionCheckValidated:false,
  nativeApplicationBound:true,application:{file:application.file,export:application.export,
   instanceSha256:application.declarationSha256,chunkSha256:application.chunkSha256},
  routeCount:routes.elements.length,splashRoutePresent:false,
  routeQualification,
  pending:['generated-view-initialization','render-expressions','authenticated-permission-result','native-hook-completion'],
  applicationStartupQualified:false,executionAuthorized:false};
}
