// Qualify the native constructor path reached by a generated zero-argument
// controller instance. This matches source structure; it never evaluates an
// app expression, calls a constructor or synthesizes runtime values.
import {parse} from 'acorn';import {createHash} from 'node:crypto';
import {createOdcSdkBindingReader} from './debug-odc-native-sdk-binding.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const id=n=>n?.type==='Identifier'?n.name:null;
const member=n=>n?.type==='MemberExpression'&&!n.computed&&n.object.type==='ThisExpression'?'this.'+n.property.name:null;
const fail=reason=>{throw new Error('debug_odc_base_construction_'+reason);};
export function qualifyOdcBaseControllerConstruction(files,application){
 if(!application?.constructorDelegates||!application.instanceBinding||application.overriddenDispatch?.length||application.handlers?.some(h=>h.declared))fail('application');
 const appSource=files[application.controllerChunk];if(typeof appSource!=='string'||hash(appSource)!==application.controllerSha256)fail('source');
 const appAst=parse(appSource,{ecmaVersion:'latest',sourceType:'module'}),matches=[];
 function find(n){if(!n||!n.type)return;if(['ClassExpression','ClassDeclaration'].includes(n.type)&&hash(appSource.slice(n.start,n.end))===application.classSha256)matches.push(n);
  for(const v of Object.values(n))if(Array.isArray(v))v.forEach(find);else if(v&&typeof v==='object')find(v);}
 find(appAst);if(matches.length!==1)fail('application');
 const baseMember=application.baseMember??'BaseModuleController';if(!['BaseModuleController','BaseController'].includes(baseMember))fail('application');
 const plain=baseMember==='BaseController';
 const {file,exported}=application.baseImport,source=files[file],binding=createOdcSdkBindingReader(files)({file:'./'+file,export:exported,member:baseMember});
 const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'}),declarations=new Map();
 for(const row of ast.body){if(row.type==='VariableDeclaration')for(const d of row.declarations)if(id(d.id))declarations.set(d.id.name,d.init);if(row.type==='ClassDeclaration')declarations.set(row.id.name,row);}
 function resolve(symbol){const seen=new Set();let n;while(symbol&&!seen.has(symbol)){seen.add(symbol);n=declarations.get(symbol);if(n?.type!=='Identifier')return n;symbol=n.name;}fail('alias');}
 const module=plain?null:resolve(binding.symbol),base=plain?resolve(binding.symbol):module?.superClass&&resolve(id(module.superClass));
 const classes=plain?[matches[0],base]:[matches[0],module,base],protectedNames=['translationResources','localeChangeHandler','isExecutingJSNode','fireApplicationResumeSingletonCallback'];
 if(classes.some(c=>!['ClassExpression','ClassDeclaration'].includes(c?.type)||c.body.body.some(m=>m.type!=='MethodDefinition'||m.computed||protectedNames.includes(m.key.name)))||base.superClass)fail('class');
 if(matches[0].body.body.some(m=>m.key.name==='fireApplicationResume'))fail('resume_override');
 const ctors=classes.map(c=>c.body.body.find(m=>m.kind==='constructor'));if(ctors.some((c,i)=>!c&&!(plain&&i===0)))fail('constructor');
 if(!plain){
 const native=ctors[1].value;
 if(native.params.length||native.body.body.length!==1||native.body.body[0].type!=='ExpressionStatement')fail('module_constructor');
 const sequence=native.body.body[0].expression;if(sequence.type!=='SequenceExpression'||sequence.expressions.length!==2)fail('module_constructor');
 const [superCall,assignResume]=sequence.expressions;
 if(superCall.type!=='CallExpression'||superCall.callee.type!=='Super'||superCall.arguments.length!==1||superCall.arguments[0].type!=='SpreadElement'||id(superCall.arguments[0].argument)!=='arguments')fail('super');
 const bind=assignResume.right;
 if(assignResume.type!=='AssignmentExpression'||assignResume.operator!=='='||member(assignResume.left)!=='this.fireApplicationResumeSingletonCallback'||
  bind?.type!=='CallExpression'||bind.arguments.length!==1||bind.arguments[0].type!=='ThisExpression'||bind.callee.type!=='MemberExpression'||bind.callee.computed||
  bind.callee.property.name!=='bind'||member(bind.callee.object)!=='this.fireApplicationResume')fail('resume');
 const resumes=module.body.body.filter(m=>!m.static&&m.key.name==='fireApplicationResume');if(resumes.length!==1||resumes[0].kind!=='method')fail('resume');
 }
 const root=ctors.at(-1).value;
 if(root.params.length!==1||!id(root.params[0])||root.body.body.length!==1||root.body.body[0].type!=='IfStatement'||root.body.body[0].alternate)fail('base_constructor');
 const conditional=root.body.body[0],test=conditional.test;
 if(test.type!=='SequenceExpression'||test.expressions.length!==4)fail('base_constructor');
 const [flag,callback,translations,guard]=test.expressions;
 const assign=(n,key)=>n?.type==='AssignmentExpression'&&n.operator==='='&&member(n.left)==='this.'+key;
 const isFalse=n=>n?.type==='Literal'&&n.value===false||n?.type==='UnaryExpression'&&n.operator==='!'&&n.argument.type==='Literal'&&n.argument.value===1;
 if(!assign(flag,'isExecutingJSNode')||!isFalse(flag.right)||!assign(callback,'localeChangeHandler')||callback.right.type!=='ArrowFunctionExpression'||
  !assign(translations,'translationResources')||member(guard)!=='this.translationResources')fail('base_fields');
 const select=translations.right,parameter=root.params[0].name;
 if(select.type!=='ConditionalExpression'||select.test.type!=='BinaryExpression'||select.test.operator!=='!='||id(select.test.left)!==parameter||
  select.test.right.type!=='Literal'||select.test.right.value!==null||id(select.consequent)!==parameter||member(select.alternate)!=='this.translationResources')fail('translations');
 // The source-bound application constructor forwards only its undefined
 // arguments. No class in this chain declares the guarded field. The locale
 // callback and guarded body are therefore deferred on this constructor path.
 return {schema:'ssam-odc-base-controller-construction/1',qualified:true,applicationClassSha256:application.classSha256,
  sdkSha256:binding.chunkSha256,...(!plain?{moduleConstructorSha256:hash(source.slice(ctors[1].start,ctors[1].end))}:{}),
  baseConstructorSha256:hash(source.slice(ctors.at(-1).start,ctors.at(-1).end)),
  effects:['native-instance-fields','deferred-locale-callback',...(!plain?['bound-native-resume-callback']:[])],
  applicationStartupQualified:false,executionAuthorized:false};
}
