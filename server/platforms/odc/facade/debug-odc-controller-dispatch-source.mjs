// Resolve method text from pinned native sources for private browser comparison.
// No vendor source is persisted in receipts; matching is not startup qualification.
import {parse} from 'acorn';
import {createOdcSdkBindingReader} from './debug-odc-native-sdk-binding.mjs';
export function readOdcControllerDispatchSource(files,controller){
 const fail=()=>{throw new Error('debug_odc_controller_dispatch_source_unbound');};
 if(controller?.baseMember!=='BaseModuleController'||controller.overriddenDispatch?.length)fail();
 const binding=createOdcSdkBindingReader(files)({file:'./'+controller.baseImport.file,export:controller.baseImport.exported,member:'BaseModuleController'});
 const source=files[binding.file],ast=parse(source,{ecmaVersion:'latest',sourceType:'module'});let cls;
 function visit(n){if(!n||typeof n!=='object')return;if(n.start===binding.start&&n.end===binding.end)cls=n;
  for(const value of Object.values(n))if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value);}
 visit(ast);if(!['ClassExpression','ClassDeclaration'].includes(cls?.type))fail();
 return ['fireApplicationReady','setupOnApplicationResumeListener','setupSyncOnResume','fireApplicationResume'].map(name=>{
  const methods=cls.body.body.filter(m=>!m.computed&&m.key.name===name);
  if(methods.length!==1||methods[0].kind!=='method'||methods[0].static)fail();
  return {name,source:source.slice(methods[0].start,methods[0].end)};
 });
}
