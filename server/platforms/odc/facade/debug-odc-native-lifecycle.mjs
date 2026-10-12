// Recognize the original generated event dispatcher without executing it.
// This proves its binding shape, not the effects of the target action or UI mounting.
import { parse } from 'acorn';
import { createHash } from 'node:crypto';
const id = n => n?.type === 'Identifier' ? n.name : null;
const ident = s => typeof s === 'string' && /^[A-Za-z_$][\w$]*$/.test(s);
function shape(n) {
  return JSON.stringify(n, (k, v) => ['start', 'end', 'loc', 'range', 'raw'].includes(k) ? undefined : v);
}
const method = body => parse('class C {' + body + '}', { ecmaVersion: 'latest' }).body[0].body.body[0];
export function nativeLifecycleAbsent(getter) {
  const event = id(getter?.key);
  if (!ident(event) || getter.kind !== 'get' || getter.computed) return false;
  const slot = '_' + event;
  return shape(getter) === shape(method(`get ${event}(){return this.hasOwnProperty(${JSON.stringify(slot)})||(this.${slot}=null),this.${slot}}`));
}
export function nativeLifecycleBinding(getter, action) {
  const event = id(getter?.key);
  if (!ident(event) || !ident(action) || getter.kind !== 'get' || getter.computed) return null;
  const returned = getter.value?.body?.body?.[0]?.argument;
  const directContext = id(returned?.params?.[0]);
  if (ident(directContext)) {
    const expected = method(`get ${event}(){return function(${directContext}){return this.${action}(${directContext});};}`);
    if (shape(getter) === shape(expected)) return { kind: 'direct', handler: event, action, contextPreserved: true };
  }
  const assignment = returned?.expressions?.[0]?.right;
  const fn = assignment?.right, context = id(fn?.params?.[0]);
  const declarations = fn?.body?.body?.[0]?.declarations;
  const controller = id(declarations?.[0]?.id), model = id(declarations?.[1]?.id), ids = id(declarations?.[2]?.id);
  const call = fn?.body?.body?.[1]?.argument, helper = id(call?.callee?.object);
  const work = call?.arguments?.[0], bag = id(work?.body?.body?.[0]?.declarations?.[0]?.id);
  const threadName = work?.body?.body?.[1]?.argument?.expressions?.[1]?.arguments?.[1]?.value;
  const aliases = [context, controller, model, ids, helper, bag];
  if (aliases.some(s => !ident(s)) || new Set(aliases).size !== aliases.length || typeof threadName !== 'string') return null;
  const slot = '_' + event;
  const expected = method(`get ${event}(){return this.hasOwnProperty(${JSON.stringify(slot)})||(this.${slot}=function(${context}){
    var ${controller}=this.controller,${model}=this.model,${ids}=this.idService;
    return ${helper}.tryFinally(function(){var ${bag}={};return ${controller}.pushDebuggerContext(${context}),
      OutSystemsDebugger.setThreadStartName(${context}==null?void 0:${context}.id,${JSON.stringify(threadName)}),
      ${controller}.${action}(${context})},function(){${controller}.popDebuggerContext(${context})})}),this.${slot}}`);
  return shape(getter) === shape(expected)
    ? { kind: 'native-cached-event', handler: event, action, helperLocal: helper, contextPreserved: true }
    : null;
}

// Resolve the wrapper through the actual import/export graph of the pinned SDK.
// Keep this source proof separate from the action's effect qualification.
export function nativeLifecycleHelper(binding, file, chunks, sources, cache = new Map()) {
  if (binding?.kind !== 'native-cached-event') return null;
  const imported = (chunks[file]?.imports ?? []).flatMap(i => i.names.filter(n => n.local === binding.helperLocal)
    .map(n => ({ file: i.specifier.replace(/^\.\//, ''), exported: n.imported })));
  if (imported.length !== 1) return null;
  const target = imported[0], chunk = chunks[target.file], source = sources[target.file];
  if (!chunk || typeof source !== 'string' || !Object.values(chunk.keepNames ?? {}).includes('WidgetIdService')) return null;
  const symbol = chunk.exports?.[target.exported], cacheKey = target.file + ':' + symbol;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const declarations = ast.body.filter(n => n.type === 'VariableDeclaration').flatMap(n => n.declarations).filter(n => id(n.id) === symbol);
  const frozen = declarations[0]?.init;
  if (declarations.length !== 1 || frozen?.type !== 'CallExpression' || id(frozen.callee?.object) !== 'Object' ||
    frozen.callee.computed || id(frozen.callee.property) !== 'freeze' || frozen.arguments.length !== 1 || frozen.arguments[0].type !== 'ObjectExpression') return null;
  const members = frozen.arguments[0].properties.filter(p => p.type === 'Property' && !p.computed && id(p.key) === 'tryFinally');
  const local = id(members[0]?.value), wrappers = ast.body.filter(n => n.type === 'FunctionDeclaration' && id(n.id) === local);
  if (members.length !== 1 || wrappers.length !== 1 || chunk.keepNames?.[local] !== 'tryFinally') return null;
  const wrapper = wrappers[0], params = wrapper.params.map(id), delegate = id(wrapper.body.body[0]?.argument?.callee);
  if (params.length !== 2 || params.some(p => !ident(p)) || params[0] === params[1] || !ident(delegate) ||
    chunk.keepNames?.[delegate] !== 'tryCatchFinally') return null;
  const expected = parse(`function ${local}(${params.join(',')}){return ${delegate}(${params[0]},void 0,${params[1]})}`, { ecmaVersion: 'latest' }).body[0];
  if (shape(wrapper) !== shape(expected)) return null;
  const delegates = ast.body.filter(n => n.type === 'FunctionDeclaration' && id(n.id) === delegate);
  if (delegates.length !== 1) return null;
  const sha = s => createHash('sha256').update(s).digest('hex');
  const proof = { file: target.file, exported: target.exported, namespace: symbol, local, delegate,
    chunkSha256: sha(source), wrapperSha256: sha(source.slice(wrapper.start, wrapper.end)),
    delegateSha256: sha(source.slice(delegates[0].start, delegates[0].end)), sourceBindingOnly: true };
  cache.set(cacheKey, proof); return proof;
}
