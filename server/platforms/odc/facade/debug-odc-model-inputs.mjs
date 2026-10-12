// Source-only recognition of generated guarded input copies. Values continue
// through the original model setters, preserving native types and notifications.
import {parse} from 'acorn';
import {createHash} from 'node:crypto';
export function inspectOdcModelInputs(source,fields){
 const fail=code=>{throw Error('debug_odc_model_inputs_'+code);};
 const unsafe=new Set(['__proto__','prototype','constructor']);
 if(typeof source!=='string'||!Array.isArray(fields)||fields.some(f=>typeof f.attribute!=='string'||typeof f.jsonName!=='string'||unsafe.has(f.attribute)||unsafe.has(f.jsonName))||
  new Set(fields.map(f=>f.attribute)).size!==fields.length)fail('fields');
 const ast=parse('class Model{'+source+'}',{ecmaVersion:'latest'}),methods=ast.body[0]?.body?.body;
 if(ast.body.length!==1||methods?.length!==1)fail('method');
 const method=methods[0],fn=method.value;
 if(method.type!=='MethodDefinition'||method.computed||method.static||method.kind!=='method'||method.key.name!=='setInputs'||
  fn.async||fn.generator||fn.params.length!==1||fn.params[0].type!=='Identifier')fail('method');
 const param=fn.params[0].name,copies=[],written=new Set();
 function visit(n,guards){
  if(n?.type==='SequenceExpression'){n.expressions.forEach(e=>visit(e,guards));return;}
  if(n?.type==='LogicalExpression'&&n.operator==='&&'){
   const test=n.left;
   if(test.type!=='BinaryExpression'||test.operator!=='in'||test.left.type!=='Literal'||typeof test.left.value!=='string'||
    unsafe.has(test.left.value)||test.right.type!=='Identifier'||test.right.name!==param)fail('guard');
   visit(n.right,new Set([...guards,test.left.value]));return;
  }
  const target=n?.left,value=n?.right;
  if(n?.type!=='AssignmentExpression'||n.operator!=='='||target.type!=='MemberExpression'||target.computed||
   target.object.type!=='MemberExpression'||target.object.computed||target.object.object.type!=='ThisExpression'||target.object.property.name!=='variables'||
   value.type!=='MemberExpression'||value.computed||value.object.type!=='Identifier'||value.object.name!==param||
   unsafe.has(target.property.name)||unsafe.has(value.property.name)||!guards.has(value.property.name))fail('copy');
  const field=fields.find(f=>f.attribute===target.property.name);
  if(!field||field.jsonName!==value.property.name||written.has(field.attribute))fail('field_binding');
  written.add(field.attribute);copies.push({input:value.property.name,attribute:field.attribute,guards:[...guards]});
 }
 for(const row of fn.body.body){if(row.type!=='ExpressionStatement')fail('body');visit(row.expression,new Set());}
 return {setInputsQualified:true,sourceSha256:createHash('sha256').update(source).digest('hex'),copies,
  effects:['guarded-native-variable-setters'],valuesRead:false,valuesChanged:false,executionAuthorized:false};
}
