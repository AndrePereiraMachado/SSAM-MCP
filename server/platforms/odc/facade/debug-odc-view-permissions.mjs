// Read the original checkPermissions declaration. References describe required
// roles, never the signed-in user's access or cross-module propagation.
import {parse} from 'acorn';
import {createHash} from 'node:crypto';
import {createOdcSdkBindingReader} from './debug-odc-native-sdk-binding.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const fail=code=>{throw new Error('debug_odc_view_permissions_'+code);};
const prop=n=>n?.type==='MemberExpression'&&!n.computed?n.property.name:null;
export function readOdcViewPermissionDeclaration(source,classStart){
 const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'}),imports=new Map();let cls;
 function walk(n){if(!n||typeof n.type!=='string')return;if(n.start===classStart&&['ClassExpression','ClassDeclaration'].includes(n.type))cls=n;for(const v of Object.values(n))if(Array.isArray(v))v.forEach(walk);else if(v&&typeof v==='object')walk(v);}
 walk(ast);
 for(const row of ast.body)if(row.type==='ImportDeclaration')for(const spec of row.specifiers)if(spec.type==='ImportSpecifier')imports.set(spec.local.name,{file:row.source.value,export:spec.imported.name});
 const matches=cls?.body.body.filter(m=>m.type==='MethodDefinition'&&!m.computed&&m.key.name==='checkPermissions');
 if(matches?.length!==1||!matches[0].static||matches[0].kind!=='method'||matches[0].value.params.length)fail('declaration');
 const method=matches[0],statements=method.value.body.body;
 const result={sourceSha256:hash(source),methodSha256:hash(source.slice(method.start,method.end)),roleReferences:[],permissionsValidated:false};
 if(statements.length===0)return {...result,declarationKind:'empty-own-check'};
 if(statements.length!==1||statements[0].type!=='ExpressionStatement')fail('body');
 const call=statements[0].expression;
 if(call.type!=='CallExpression'||prop(call.callee)!=='ensureUserHasRole'||call.callee.object.type!=='Identifier'||call.arguments.length!==1)fail('call');
 const helper=imports.get(call.callee.object.name),options=call.arguments[0];
 if(!helper||options.type!=='ObjectExpression'||options.properties.length!==1)fail('options');
 const roles=options.properties[0];
 if(roles.type!=='Property'||roles.computed||roles.kind!=='init'||roles.method||roles.key.name!=='roles'||roles.value.type!=='ArrayExpression'||roles.value.elements.length===0)fail('roles');
 result.roleReferences=roles.value.elements.map(role=>{
  const name=prop(role),owner=role?.object?.object;
  if(!name||prop(role.object)!=='roles'||owner?.type!=='Identifier'||!imports.has(owner.name))fail('role_reference');
  return {name,...imports.get(owner.name)};
 });
 if(new Set(result.roleReferences.map(r=>r.file+':'+r.export+':'+r.name)).size!==result.roleReferences.length)fail('duplicate_role');
 return {...result,declarationKind:'native-role-check',helper:{...helper,member:'ensureUserHasRole'}};
}
export function createOdcViewPermissionInspector(files){
 const bind=createOdcSdkBindingReader(files);
 return view=>{
  const source=files[view.chunk];if(typeof source!=='string'||view.controllerSurface?.resolved!==true)fail('source');
  const declaration=readOdcViewPermissionDeclaration(source,view.controllerSurface.classStart);
  if(declaration.declarationKind==='empty-own-check')return {...declaration,nativeRoleHelperBound:false,
   ownPermissionCheckEmpty:true,doesNotProveHostScreenAccess:true,executionAuthorized:false};
  const helper=bind(declaration.helper);
  if(helper.chunkSha256!=='1dbfad22bdf417ed43aa1ac716b3a0b402345f4608efbb4025e0be4acdfeb40d')fail('sdk_unreviewed');
  const canonical=bind({file:declaration.helper.file,export:'x',member:'ensureUserHasRole'});
  if(helper.declarationSha256!==canonical.declarationSha256)fail('helper_binding');
  const roles=declaration.roleReferences.map(r=>{
   if(!/^\.\/_oschunk-[A-Za-z0-9]+\.js$/.test(r.file)||typeof files[r.file.slice(2)]!=='string')fail('role_module');
   return {...r,moduleSha256:hash(files[r.file.slice(2)])};
  });
  return {...declaration,roleReferences:roles,nativeRoleHelperBound:true,ownPermissionCheckEmpty:false,
   helperSha256:helper.declarationSha256,sdkSha256:helper.chunkSha256,
   roleValuesResolved:false,permissionsValidated:false,executionAuthorized:false};
 };
}
