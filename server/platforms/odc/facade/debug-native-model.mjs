// Complete, hash-bound model projections shared by the native debugger adapters.
// Reader pages and omitted children are expanded before graph/type decisions.
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const fail = code => { throw new Error('debug_native_model_' + code); };
export const DEBUG_ACTION_KINDS = new Set(['ServerAction', 'ServiceAction', 'ClientAction', 'ScreenAction', 'Preparation',
  'DataAction', 'RestServiceAction', 'RestAPIMethod', 'RestMethod', 'SoapServiceAction', 'SOAPServiceAction', 'Timer', 'Process', 'ProcessFlow']);
const PARAMETER = /^(InputParameter|InputParameterSignature|RestServiceActionInput)$/;
const ATTRIBUTE = /^(Attribute|StructureAttribute|EntityAttribute|StaticEntityAttribute|RecordAttribute|AnonymousStructureAttribute|RestStructureAttribute)$/;
const compactType = value => ({ LongInteger: 'Long Integer', DateTime: 'Date Time', PhoneNumber: 'Phone Number', BinaryData: 'Binary Data' }[value] ?? value);

// O11 ScreenAction.OutputParameters is a native unimplemented convenience
// getter. The actual parameter nodes are read through complete Children.
// Keep the diagnostic; never suppress errors on access checks or flow data.
// A generated Process input exposes Type but its DataType convenience getter
// is unimplemented. Keep the error intact: typeOf/launch contract consumers
// still refuse it, while unrelated actions remain readable in this module.
export const nativeGetterUnavailable = (lane, node, name, error) => lane === 'o11' && error === 'The method or operation is not implemented.' && (
  node.kind === 'ScreenAction' && name === 'OutputParameters' ||
  node.kind === 'InputParameter' && name === 'DataType' && /^[A-Za-z0-9_+]{22}$/.test(node.key ?? '') &&
  /^Process:[^/]+\/ActionSignature:[^/]+\/InputParameter:[^/]+$/.test(node.path ?? '') &&
  new RegExp('^/Processes\\.[A-Za-z0-9_+]{22}/ProcessActions\\.#LaunchProcess/SyntheticInputParameters\\.' + node.key.replaceAll('+', '\\+') + '$').test(node.properties?.Key ?? ''));
// A projected tree is complete only without truncation markers at any depth (reader depth/max/budget cuts): omitted or
// miscounted children, omitted/missing properties, or property errors other than the native getters above.
export function nativeTreeComplete(node, lane, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 32 || node.childrenOmitted || node.children !== undefined && !Array.isArray(node.children) ||
      Number.isInteger(node.childrenTotal) && node.childrenTotal !== (node.children?.length ?? 0) ||
      Object.keys(node.propertiesOmitted ?? {}).length || node.propertiesMissing?.length ||
      Object.entries(node.propertyErrors ?? {}).some(([name, error]) => !nativeGetterUnavailable(lane, node, name, error))) return false;
  return (node.children ?? []).every(child => nativeTreeComplete(child, lane, depth + 1));
}

export function createNativeModelReader({ base, lane, inspect, map, readExternal, allowImportedTargets = false, limit = 50000 }) {
  const cache = new Map(), signatures = new Map(), types = new Map();
  let nodesRead = 0;
  const guard = () => {
    if (createHash('sha256').update(fs.readFileSync(base.file)).digest('hex') !== base.sha256.toLowerCase()) fail('source_changed');
  };
  async function query(options) {
    guard(); const answer = await inspect({ target: base.file, expectedSourceSha256: base.sha256, budget: 200000, full: true, max: 500, ...options });
    if (answer?.ok === false) throw new Error('debug_native_model_read_failed: ' + (answer.error ?? 'reader refused the projection'));
    const value = answer.out ? JSON.parse(fs.readFileSync(answer.out, 'utf8').replace(/^\uFEFF/, '')) : answer;
    if (value.sourceSha256 && value.sourceSha256.toLowerCase() !== base.sha256.toLowerCase()) fail('source_changed');
    if (value.referenceReadErrors || value.propertyReadErrors || value.complete === false || value.searchComplete === false) fail('projection_incomplete');
    return value;
  }
  async function pages(read) {
    const rows = []; let offset = 0;
    do {
      const page = await read(offset);
      if (!Array.isArray(page.entries) || page.ok === false || page.searchComplete === false || page.index?.complete === false) fail('projection_incomplete');
      rows.push(...page.entries); if (rows.length > limit) fail('size_limit');
      if (page.nextOffset == null) {
        if (Number.isInteger(page.count) && rows.length !== page.count) fail('pagination_incomplete');
        return rows;
      }
      if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset) fail('pagination_invalid');
      offset = page.nextOffset;
    } while (true);
  }
  const mapped = options => pages(async offset => {
    guard();
    const page = await map({ lane, target: base.file, expectedSourceSha256: base.sha256, max: 500, budgetBytes: 200000, includeDetail: true, ...options, offset });
    guard();
    if (page.sourceSha256 && page.sourceSha256.toLowerCase() !== base.sha256.toLowerCase()) fail('source_changed');
    return page;
  });
  function remember(node) {
    const blockingErrors = Object.entries(node?.propertyErrors ?? {}).filter(([name, error]) => !nativeGetterUnavailable(lane, node, name, error));
    if (!node?.key || !Array.isArray(node.children) || blockingErrors.length || Object.keys(node.propertiesOmitted ?? {}).length || node.propertiesMissing?.length) fail('projection_incomplete');
    const previous = cache.get(node.key);
    if (!previous || (node.children?.length ?? 0) > (previous.children?.length ?? 0)) {
      cache.set(node.key, node); if (node.path) cache.set(node.path, node);
    }
    for (const child of node.children) remember(child);
    return cache.get(node.key);
  }
  async function shallow(selector) {
    guard(); const key = selector.replace(/^@/, '');
    const known = cache.get(key);
    if (known && !known.childrenOmitted) return known;
    const node = remember((await query({ path: selector, depth: 2 })).tree);
    nodesRead++; if (nodesRead > limit) fail('size_limit');
    if (node.childrenOmitted) {
      const children = await mapped({ parent: '@' + node.key });
      if (children.length !== node.childrenTotal) fail('children_incomplete');
      const expanded = [];
      for (const child of children) expanded.push(await shallow('@' + child.key));
      node.children = expanded; node.childrenOmitted = 0;
    }
    return node;
  }
  async function tree(selector, depth = 0, seen = new Set()) {
    if (depth > 32) fail('tree_depth_limit');
    const node = await shallow(selector);
    if (seen.has(node.key)) fail('tree_cycle'); seen.add(node.key);
    const children = [];
    for (const child of node.children) children.push(await tree('@' + child.key, depth + 1, seen));
    seen.delete(node.key); node.children = children; return node;
  }
  async function typeOf(ref, ancestry = []) {
    if (!ref?.key) fail('type_unresolved');
    if (types.has(ref.key)) return types.get(ref.key);
    if (ancestry.includes(ref.key) || ancestry.length > 12) fail('recursive_type');
    if (ref.kind === 'BasicType') return { dataType: compactType(ref.label ?? ref.name ?? ref.path?.split(':').at(-1)) };
    if (ref.kind === 'IdentifierType') return { dataType: 'Identifier', identifierKey: ref.key };
    const node = await shallow('@' + ref.key), chain = [...ancestry, ref.key];
    let result;
    if (node.kind === 'ListType') {
      const element = node.propertyReferences?.ElementType ?? node.propertyReferences?.DataType;
      const schema = await typeOf(element, chain);
      result = { dataType: 'RecordList', complexType: schema.complexType, elementType: schema };
    } else {
      const fields = [];
      for (const child of node.children.filter(c => ATTRIBUTE.test(c.kind))) {
        const schema = await typeOf(child.propertyReferences?.DataType, chain);
        fields.push({ name: child.name || child.properties.Name, mandatory: child.properties?.IsMandatory === 'True', ...schema });
      }
      if (!fields.length) fail('record_type_unresolved');
      result = { dataType: 'Record', complexType: fields };
    }
    types.set(ref.key, result); return result;
  }
  async function inputs(selector) {
    const node = await shallow(selector); if (signatures.has(node.key)) return signatures.get(node.key);
    const rows = [];
    for (const p of node.children.filter(c => PARAMETER.test(c.kind))) rows.push({ key: p.key, name: p.name || p.properties.Name,
      mandatory: p.properties.IsMandatory === 'True', defaultValue: p.properties.DefaultValue ?? null, ...await typeOf(p.propertyReferences?.DataType) });
    signatures.set(node.key, rows); return rows;
  }
  let functionUses;
  async function nativeFunctionUses() {
    guard();
    if (!readExternal) return new Map();
    if (!functionUses) functionUses = (async () => {
      const byConsumer = new Map();
      // Resolve native references, not names parsed from expression text.
      // Direct usage excludes references to parameters or other descendants.
      for (const kind of ['ClientAction', 'ClientActionSignature', 'ServerAction', 'ServerActionSignature']) {
        for (const entry of await mapped({ kind })) {
          if (entry.kind !== kind) continue;
          const target = await shallow('@' + entry.key);
          if (target.properties?.Function !== 'True') continue;
          const uses = await pages(offset => query({ path: '@' + target.key, usages: true, scope: 'direct', depth: 0, offset }));
          for (const use of uses) {
            if (use.target?.key !== target.key || !use.consumer?.key || use.relation !== 'direct') fail('function_usage_invalid');
            const refs = byConsumer.get(use.consumer.key) ?? new Map();
            refs.set(target.key, { key: target.key, kind: target.kind, path: target.path });
            byConsumer.set(use.consumer.key, refs);
          }
        }
      }
      return byConsumer;
    })();
    return functionUses;
  }
  async function closure(selector, context = { seen: new Set() }) {
    const calls = [], queue = [selector], seen = context.seen, functionReferences = await nativeFunctionUses();
    while (queue.length) {
      const action = await tree(queue.shift()), identity = base.sha256 + ':' + action.key;
      if (seen.has(identity)) continue;
      seen.add(identity); if (seen.size > 2000) fail('closure_limit');
      const visit = async node => {
        const direct = node.propertyReferences?.Action;
        const references = new Map(functionReferences.get(node.key) ?? []);
        if (direct) references.set(direct.key, direct);
        for (const ref of references.values()) {
          const external = /^Reference:/.test(ref.path ?? node.properties?.Action ?? '');
          const local = !external && DEBUG_ACTION_KINDS.has(ref.kind);
          const call = { kind: node.kind, action: node.properties?.Action ?? ref.path, actionKey: ref.key, actionKind: ref.kind, external, bodyRead: local };
          calls.push(call);
          if (local && !seen.has(base.sha256 + ':' + ref.key)) queue.push('@' + ref.key);
          if (external && readExternal) {
            const referencePath = (ref.path ?? '').split('/')[0];
            const signature = await shallow('@' + ref.key), reference = await shallow(referencePath);
            // Imported signatures and a downloaded library body are model evidence.
            // Preserve their exact binding separately from live frames/user context.
            if (lane === 'odc') call.reference = { consumerSourceSha256: base.sha256.toLowerCase(),
              moduleKey: reference.properties?.ModuleKey ?? null, moduleType: reference.properties?.ModuleType ?? null,
              revision: reference.properties?.Revision ?? null, originalActionKey: signature.properties?.OriginalKey ?? null };
            const producer = await readExternal({ signature, reference });
            if (producer) {
              call.producer = producer.source;
              try {
                const nested = await producer.reader.closure('@' + producer.key, context);
                call.bodyRead = true;
                calls.push(...nested.map(c => ({ ...c, producer: c.producer ?? producer.source })));
              } catch (error) {
                if (!/^debug_native_model_read_failed: System modules cannot be loaded with the Model API\.$/.test(error.message ?? '')) throw error;
                call.bodyUnavailable = 'system-model-unavailable';
              }
            }
          }
        }
        if (!references.size && /Email|Timer|Process|SQL|JavaScript/.test(node.kind)) calls.push({ kind: node.kind });
        for (const c of node.children) await visit(c);
      };
      await visit(action);
    }
    return calls;
  }
  return {
    async: true, tree, inputs, closure,
    list: async kind => {
      if (typeof kind !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(kind)) fail('kind_invalid');
      const entries = await mapped({ kind });
      if (entries.some(entry => typeof entry.path !== 'string' || typeof entry.kind !== 'string')) fail('projection_incomplete');
      return entries.filter(entry => entry.kind === kind && !/(?:^|\/)Reference:/.test(entry.path));
    },
    // Service apps have no client bundle. Infer its presence from complete
    // local model projections, never a failed HTTP fetch or imported signature.
    hasClientRuntime: async () => {
      for (const kind of ['MobileScreen', 'MobileBlock', 'ClientAction']) {
        const entries = await mapped({ kind });
        if (entries.some(entry => typeof entry.path !== 'string' || typeof entry.kind !== 'string')) fail('projection_incomplete');
        if (entries.some(entry => entry.kind === kind && !/(?:^|\/)Reference:/.test(entry.path))) return true;
      }
      return false;
    },
    properties: selector => shallow(selector),
    usages: key => pages(offset => query({ path: '@' + key, usages: true, scope: 'direct', depth: 0, offset })),
    argumentsOf: async selector => (await shallow(selector)).children.filter(c => c.kind === 'Argument').map(a => ({
      parameter: a.propertyReferences?.Parameter?.key, parameterName: a.propertyReferences?.Parameter?.name,
      value: a.properties?.Value ?? '' })),
    resolveTarget: async selector => {
      let node;
      if (/^@[A-Za-z0-9_+]{22}$/.test(selector)) node = await shallow(selector);
      else if (selector.includes(':')) node = await shallow(selector);
      else {
        const matches = (await mapped({ name: selector })).filter(e => DEBUG_ACTION_KINDS.has(e.kind) ||
          allowImportedTargets && lane === 'odc' && /^(ServerActionSignature|ServiceActionSignature)$/.test(e.kind) && /^Reference:[^/]+\//.test(e.path));
        if (matches.length > 1) fail('action_ambiguous_use_key');
        // A valid action name can also have 22 key-compatible characters.
        // Explicit @keys are authoritative; plain selectors resolve names first.
        if (!matches.length && !/^[A-Za-z0-9_+]{22}$/.test(selector)) return null;
        node = await shallow('@' + (matches[0]?.key ?? selector));
      }
      const imported = allowImportedTargets && lane === 'odc' && /^(ServerActionSignature|ServiceActionSignature)$/.test(node.kind) && /^Reference:[^/]+\//.test(node.path);
      if (!DEBUG_ACTION_KINDS.has(node.kind) && !imported) fail('target_not_action');
      return { key: node.key, name: node.name || node.properties.Name, kind: node.kind, path: node.path,
        ...(imported ? { importedSignature: { signature: node, reference: await shallow(node.path.split('/')[0]) } } : {}),
        inputs: await inputs('@' + node.key), closureCalls: await closure('@' + node.key) };
    },
  };
}
