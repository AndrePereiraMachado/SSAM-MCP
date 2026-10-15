// Mock data of a prototype (docs/PROTOTIPO-NATIVO.md 2.7). Child side: the store source (mapping.data, a global
// seed-like function, a local JSON read by fetch/XHR, the first localStorage write with that shape) and the plain data
// arrays outside the store. Parent side: collections typed with keys and foreign keys, and the store state after a
// probe (the source result, then the storage writes of the store key).
import vm from 'node:vm';

export const SEED_NAMES = Object.freeze(['seed', 'initialData', 'initialState', 'getInitialState', 'mock', 'mockData']);

function plainRow(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto.constructor?.name !== 'Object') return false;
  return Object.values(value).every(item => item === null || ['string', 'number', 'boolean'].includes(typeof item));
}

export function rowsArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(plainRow);
}

export function storeShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  if (!entries.length || !entries.every(([, item]) => Array.isArray(item) && item.every(plainRow))) return false;
  return entries.some(([, item]) => item.length > 0);
}

const clone = value => JSON.parse(JSON.stringify(value));

// A row whose fields are plain values or lists of plain rows (one level: a pedido with its itens).
function nestedRow(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto.constructor?.name !== 'Object') return false;
  return Object.values(value).every(item => item === null || ['string', 'number', 'boolean'].includes(typeof item) || (Array.isArray(item) && item.every(plainRow)));
}

// An object of row lists where some rows carry lists of rows: the in-memory model of a prototype without persistence.
export function nestedStoreShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  if (!entries.length || !entries.every(([, item]) => Array.isArray(item) && item.every(nestedRow))) return false;
  return entries.some(([, item]) => item.length > 0);
}

// The key of a list of rows, by the rule of typeCollections: Id when unique, else the first unique integer field.
export function rowsKey(rows) {
  const names = [];
  for (const row of rows) for (const name of Object.keys(row)) if (!names.includes(name)) names.push(name);
  const unique = name => rows.every(row => row[name] !== null && row[name] !== undefined) && new Set(rows.map(row => row[name])).size === rows.length;
  if (names.includes('Id') && unique('Id')) return 'Id';
  return names.find(name => rows.every(row => Number.isInteger(row[name])) && unique(name)) ?? null;
}

// Nested lists become child collections <collection><Field> whose rows carry <singular>Id = the parent key (the
// foreign key typeCollections recognizes); a nested list of a collection without a key is dropped.
export function flattenStore(data) {
  const out = {};
  for (const [name, rows] of Object.entries(data ?? {})) {
    const nested = [];
    for (const row of rows) for (const [field, value] of Object.entries(row)) if (Array.isArray(value) && !nested.includes(field)) nested.push(field);
    if (!nested.length) { out[name] = rows; continue; }
    const key = rowsKey(rows.map(row => Object.fromEntries(Object.entries(row).filter(([field]) => !nested.includes(field)))));
    out[name] = rows.map(row => Object.fromEntries(Object.entries(row).filter(([field]) => !nested.includes(field))));
    if (!key) continue;
    const stem = /[^s]s$/.test(name) ? name.slice(0, -1) : name;
    for (const field of nested) {
      const child = name + field[0].toUpperCase() + field.slice(1);
      if (child in data || child in out) continue;
      const items = rows.flatMap(row => Array.isArray(row[field]) ? row[field] : []);
      const fk = items.some(item => (stem + 'Id') in item) ? name + 'Id' : stem + 'Id';
      out[child] = rows.flatMap(row => (Array.isArray(row[field]) ? row[field] : []).map(item => ({ [fk]: row[key], ...item })));
    }
  }
  return out;
}

// The singular of a collection name (pt and en plurals): imoveis -> imovel, pedidos -> pedido, itens -> item, cores -> cor.
export function singularOf(name) {
  const text = String(name);
  if (text.length < 3) return text;
  if (/eis$/i.test(text)) return text.replace(/eis$/i, 'el');
  if (/(us|is|ss)$/i.test(text)) return text;
  if (/ures$/i.test(text)) return text.slice(0, -1);
  for (const [pattern, to] of [[/(o|a)es$/, 'ao'], [/ns$/, 'm'], [/([rz])es$/, '$1'], [/([^s])s$/, '$1']]) if (pattern.test(text)) return text.replace(pattern, to);
  return text;
}

const isPrimitive = item => item === null || ['string', 'number', 'boolean'].includes(typeof item);
const plainObject = value => { if (!value || typeof value !== 'object' || Array.isArray(value)) return false; const proto = Object.getPrototypeOf(value); return proto === null || proto.constructor?.name === 'Object'; };
// A record of a data object: plain values, lists of plain values (the photos of a property) or lists of plain rows.
const recordRow = value => plainObject(value) && Object.values(value).every(item => isPrimitive(item) || (Array.isArray(item) && (item.every(isPrimitive) || item.every(plainRow))));
const isSet = value => value != null && typeof value === 'object' && typeof value.has === 'function' && typeof value.forEach === 'function' && typeof value.add === 'function' && !Array.isArray(value);

// The collections of a data object with several lists of records (window.MoradaData = {imoveis: [...], propostas: [...],
// favoritos: new Set([103, 107]), usuarioAtualId: null, proximoId: {...}}): every member that is a list of records is a
// collection (a list of plain values inside a record becomes its first value plus a child collection <name><Field> of
// <singular>Id + <singular field> rows; a list of rows becomes a child collection as flattenStore does); a Set of plain
// values is a collection of one field (<singular of the collection whose keys it holds>Id, else Id); the counters, the
// scalars and the lists of plain values (the options of a select) stay out. A data object has no functions; it needs at
// least one non-empty list of records. -> {name: rows} | null
export function recordCollections(value) {
  if (!plainObject(value)) return null;
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 100 || entries.some(([, item]) => typeof item === 'function')) return null;
  const out = {};
  const keyOf = rows => rowsKey(rows.map(row => Object.fromEntries(Object.entries(row).filter(([, item]) => !Array.isArray(item)))));
  for (const [name, item] of entries) {
    if (!Array.isArray(item) || !item.length || !item.every(recordRow)) continue;
    const listFields = [];
    for (const row of item) for (const [field, cell] of Object.entries(row)) if (Array.isArray(cell) && !listFields.includes(field)) listFields.push(field);
    // a field of lists of rows leaves the record (its child collection holds it); a field of lists of plain values keeps the
    // first value (what a card shows: the cover photo)
    const rowLists = new Set(listFields.filter(field => item.some(row => Array.isArray(row[field]) && row[field].length && !isPrimitive(row[field][0]))));
    const key = keyOf(item);
    out[name] = item.map(row => Object.fromEntries(Object.entries(row).filter(([field]) => !rowLists.has(field))
      .map(([field, cell]) => [field, Array.isArray(cell) ? (cell.length ? cell[0] : null) : cell])));
    if (!key) continue;
    const fk = singularOf(name) + 'Id';
    for (const field of listFields) {
      const child = name + field[0].toUpperCase() + field.slice(1);
      if (child in value || child in out) continue;
      const rows = item.flatMap(row => (Array.isArray(row[field]) ? row[field] : []).map((cell, index) => (isPrimitive(cell) ? { [fk]: row[key], [singularOf(field)]: cell, ordem: index + 1 } : { [fk]: row[key], ...cell })));
      if (rows.length) out[child] = rows;
    }
  }
  if (!Object.keys(out).length) return null;
  // Sets of plain values: a collection of one field, named after the collection whose keys they hold.
  for (const [name, item] of entries) {
    if (!isSet(item) || name in out) continue;
    const values = []; item.forEach(entry => values.push(entry));
    if (!values.length || !values.every(isPrimitive)) continue;
    const owner = Object.entries(out).find(([, rows]) => { const key = rowsKey(rows); return key && values.every(entry => rows.some(row => row[key] === entry)); });
    const field = owner ? singularOf(owner[0]) + 'Id' : 'Id';
    out[name] = values.map(entry => ({ [field]: entry }));
  }
  return clone(out);
}

// The live value of an in-memory store (child side): the expression read again in the window, flattened.
export function liveStore(page, expression) {
  try {
    const value = vm.runInContext(String(expression), page.context);
    if (storeShape(value)) return clone(value);
    if (nestedStoreShape(value)) return flattenStore(clone(value));
    const records = recordCollections(value);
    if (records) return records;
  } catch { /* gone */ }
  return null;
}

function safeGet(object, key) { try { return object[key]; } catch { return undefined; } }

// --- child side ------------------------------------------------------------------------------------------------------

// The collection a list expression names: window.SCHEDULE -> Schedule, App.tiposBatida -> TiposBatida, else Data.
export function collectionNameOfExpression(expression) {
  const last = String(expression ?? '').trim().replace(/\(\)$/, '').split('.').pop();
  if (!/^[A-Za-z_$][\w$]*$/.test(last ?? '')) return 'Data';
  const word = /^[A-Z0-9_]+$/.test(last) ? last.toLowerCase() : last;
  return word.split('_').filter(Boolean).map(part => part[0].toUpperCase() + part.slice(1)).join('') || 'Data';
}

// The role of a list of rows the page declares and never writes: what a refusal or the receipt says of it (2.7, a
// configuration list is no data model, so taking it as the store is said, never silent).
function roleOf(name, rows) {
  const fields = Object.keys(rows[0] ?? {});
  return 'constant list of ' + rows.length + ' records (' + fields.join(', ') + ') that the scripts declare (' + name + '); no event writes it, so it is configuration of the screens, imported as the static entity ' + collectionNameOfExpression(name);
}

export function discoverStore(page, mapping = {}) {
  const window = page.window;
  const candidates = [];
  // mapping.data "none": no store; the lists stay as rendered (snapshot entities) and the data comes from the module's actions
  if (mapping.data === 'none') return { source: 'none', data: {} };
  if (mapping.data) {
    try {
      const value = vm.runInContext(String(mapping.data), page.context);
      if (storeShape(value)) return { source: 'mapping:' + mapping.data, data: clone(value), live: String(mapping.data) };
      if (nestedStoreShape(value)) return { source: 'mapping:' + mapping.data, data: flattenStore(clone(value)), live: String(mapping.data) };
      if (rowsArray(value)) return { source: 'mapping:' + mapping.data, data: { [collectionNameOfExpression(mapping.data)]: clone(value) } };
      return { source: null, error: 'mapping.data "' + mapping.data + '" is not an object of arrays of plain objects' };
    } catch (error) {
      return { source: null, error: 'mapping.data "' + mapping.data + '" failed: ' + String(error?.message ?? error) };
    }
  }
  const tryCall = (fn, self) => { try { const value = fn.call(self); return storeShape(value) ? value : null; } catch { return null; } };
  for (const name of page.globals) {
    const value = safeGet(window, name);
    if (typeof value === 'function' && SEED_NAMES.includes(name) && value.length === 0) {
      const data = tryCall(value, window);
      if (data) return { source: 'global:' + name + '()', data: clone(data) };
    }
    if (value && typeof value === 'object' && !(value instanceof window.Node)) {
      for (const key of Object.keys(value)) {
        const fn = safeGet(value, key);
        if (typeof fn === 'function' && SEED_NAMES.includes(key) && fn.length === 0) {
          const data = tryCall(fn, value);
          if (data) return { source: 'global:' + name + '.' + key + '()', data: clone(data) };
        }
      }
    }
  }
  for (const { relative, value } of page.jsonFetched) {
    if (storeShape(value)) return { source: 'file:' + relative, data: clone(value) };
    if (rowsArray(value)) return { source: 'file:' + relative, data: { [collectionNameOfFile(relative)]: clone(value) } };
  }
  for (const write of page.log.storage) {
    if (write.op !== 'set') continue;
    try {
      const value = JSON.parse(write.value);
      if (storeShape(value)) return { source: 'storage:' + write.key, data: clone(value), storeKey: write.key };
    } catch { /* not JSON */ }
  }
  // A global object of row lists the scripts change in memory (window.Modelo = {clientes: [...], pedidos: [...]}): the
  // store is that object, read again at every snapshot (live), its nested lists flattened into child collections.
  for (const name of page.globals) {
    const value = safeGet(window, name);
    if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof window.Node) continue;
    if (storeShape(value)) return { source: 'global:' + name, data: clone(value), live: name };
    if (nestedStoreShape(value)) return { source: 'global:' + name, data: flattenStore(clone(value)), live: name };
  }
  // A data object with several lists of records among counters, scalars and Sets (window.MoradaData): its record lists are
  // the collections, each rendered list correlates with its own one (never one collection for the whole store).
  for (const name of page.globals) {
    const value = safeGet(window, name);
    if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof window.Node) continue;
    const data = recordCollections(value);
    if (data) return { source: 'global:' + name, data, live: name };
  }
  // No store: candidates for the refusal (2.7), so that the model never needs to read the scripts; each with its role, so the
  // refusal says what taking it would mean (a constant list is configuration, a function or an object of lists a data model).
  const roles = {};
  const modelRole = 'a data model of the scripts (an object of lists of records): its collections become entities, those the events write regular ones';
  for (const name of page.globals) {
    const value = safeGet(window, name);
    if (rowsArray(value)) { candidates.push('window.' + name); roles['window.' + name] = roleOf('window.' + name, value); }
    else if (typeof value === 'function' && value.length === 0 && !/^[A-Z]/.test(name)) { if (tryCall(value, window)) { candidates.push(name + '()'); roles[name + '()'] = modelRole; } }
    else if (value && typeof value === 'object' && !(value instanceof window.Node)) {
      for (const key of Object.keys(value)) {
        const item = safeGet(value, key);
        if (rowsArray(item)) { candidates.push(name + '.' + key); roles[name + '.' + key] = roleOf(name + '.' + key, item); }
        else if (storeShape(item)) { candidates.push(name + '.' + key); roles[name + '.' + key] = modelRole; }
        else if (typeof item === 'function' && item.length === 0 && tryCall(item, value)) { candidates.push(name + '.' + key + '()'); roles[name + '.' + key + '()'] = modelRole; }
      }
    }
  }
  // Only constant lists of rows the page declares (window.SCHEDULE: the steps of a work day): they are the configuration of
  // the screens, never a data model to guess between. They are taken as static collections, each named by its variable, and
  // the capture says so (configuration, with the role and the alternative "none"); a refusal stays for a real choice.
  if (candidates.length && candidates.every(candidate => /^window\.[A-Za-z_$][\w$]*$/.test(candidate))) {
    const data = {}; const configuration = [];
    for (const candidate of candidates) {
      const rows = safeGet(window, candidate.slice('window.'.length));
      const collection = collectionNameOfExpression(candidate);
      if (collection in data) continue;
      data[collection] = clone(rows);
      configuration.push({ value: candidate, collection, rows: rows.length, role: roleOf(candidate, rows) });
    }
    return { source: 'config:' + candidates.join('+'), data, configuration, candidates };
  }
  return { source: null, candidates, roles };
}

export function collectionNameOfFile(relative) {
  const base = String(relative).split('/').pop().replace(/\.[^.]+$/, '');
  return base.split(/[^A-Za-z0-9]+/).filter(Boolean).map(part => part[0].toUpperCase() + part.slice(1)).join('') || 'Data';
}

// Plain data arrays reachable from script globals and from objects their functions returned (one level each).
export function dataArrays(page) {
  const window = page.window;
  const out = [], seen = new Set();
  const consider = (name, path, value) => {
    if (!rowsArray(value)) return;
    const text = JSON.stringify(value);
    if (seen.has(text)) return;
    seen.add(text);
    out.push({ name, path, rows: JSON.parse(text) });
  };
  for (const name of page.globals) {
    const value = safeGet(window, name);
    if (value instanceof window.Node || typeof value === 'function') continue;
    consider(name, name, value);
    if (value && typeof value === 'object' && !Array.isArray(value)) for (const key of Object.keys(value).slice(0, 200)) consider(key, name + '.' + key, safeGet(value, key));
  }
  for (const { path, value } of page.returned) for (const key of Object.keys(value).slice(0, 200)) consider(key, path + '().' + key, safeGet(value, key));
  return out;
}

export function documentInfo(page) {
  const document = page.window.document;
  const attributes = element => element ? [...element.attributes].map(attribute => [attribute.name, attribute.value]) : [];
  return {
    title: document.title,
    lang: document.documentElement.getAttribute('lang') ?? '',
    html: attributes(document.documentElement),
    body: attributes(document.body),
    meta: [...document.querySelectorAll('meta[name], meta[property]')].map(meta => ({ name: meta.getAttribute('name') ?? meta.getAttribute('property'), content: meta.getAttribute('content') ?? '' })).filter(meta => meta.name !== 'viewport')
  };
}

function countRules(list) {
  let count = 0;
  for (const rule of list ?? []) { count++; if (rule.cssRules) count += countRules(rule.cssRules); }
  return count;
}

export function cssSheets(page) {
  page.fillStyles?.();
  const document = page.window.document;
  const out = [];
  for (const [order, element] of [...document.querySelectorAll('style, link[rel~="stylesheet"]')].entries()) {
    if (element.localName === 'link') { out.push({ order, external: element.getAttribute('href'), media: element.getAttribute('media') || null }); continue; }
    let rules = 0, imports = 0;
    try { rules = countRules(element.sheet?.cssRules); imports = [...(element.sheet?.cssRules ?? [])].filter(rule => rule.type === 3).length; } catch { /* unreadable */ }
    out.push({ order, href: element.getAttribute('data-ssam-href'), runtime: page.styleSeen.get(element) !== 'initial', text: element.getAttribute('data-ssam-href') ? null : element.textContent, rules, imports });
  }
  return out;
}

// --- parent side -----------------------------------------------------------------------------------------------------

const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const TEXT_LENGTHS = [50, 120, 250, 2000];

function fieldType(values) {
  const present = values.filter(value => value !== null && value !== undefined);
  if (!present.length) return { type: 'Text', length: 50 };
  if (present.every(value => typeof value === 'boolean')) return { type: 'Boolean' };
  if (present.every(value => typeof value === 'number')) return present.every(Number.isInteger) ? { type: 'Integer' } : { type: 'Decimal' };
  if (present.every(value => typeof value === 'string' && ISO.test(value)) && present.some(value => value.length >= 10)) return { type: 'DateTime' };
  const longest = Math.max(...present.map(value => String(value).length));
  return { type: 'Text', length: TEXT_LENGTHS.find(length => length >= longest) ?? longest };
}

function collectionFor(field, names) {
  const match = String(field).match(/^(.+)Id$/);
  if (!match) return null;
  const stem = match[1];
  return names.find(name => name === stem) ?? names.find(name => name === stem + 's') ?? names.find(name => name.toLowerCase() === stem.toLowerCase())
    // a plural the s rule misses (imovelId -> imoveis)
    ?? names.find(name => singularOf(name).toLowerCase() === stem.toLowerCase()) ?? null;
}

// Collections typed: fields (union of keys in first-row order), key, foreign keys.
export function typeCollections(data) {
  const names = Object.keys(data);
  const collections = names.map(name => {
    const rows = data[name];
    const fieldNames = [];
    for (const row of rows) for (const key of Object.keys(row)) if (!fieldNames.includes(key)) fieldNames.push(key);
    const fields = fieldNames.map(field => ({ name: field, ...fieldType(rows.map(row => row[field])) }));
    const unique = field => new Set(rows.map(row => row[field])).size === rows.length && rows.every(row => row[field] !== null && row[field] !== undefined);
    let key = null;
    if (fieldNames.includes('Id') && unique('Id')) key = 'Id';
    else key = fields.find(field => field.type === 'Integer' && unique(field.name))?.name ?? null;
    return { name, key: key ?? '#', fields, references: [], rows: clone(rows) };
  });
  for (const collection of collections) {
    for (const field of collection.fields) {
      // the key of a collection of one field (a Set of keys: the favorites) is the reference it holds
      if (field.name === collection.key && collection.fields.length > 1) continue;
      const target = collectionFor(field.name, names.filter(name => name !== collection.name));
      if (!target) continue;
      const other = collections.find(item => item.name === target);
      if (!other || other.key === '#') continue;
      const keys = new Set(other.rows.map(row => row[other.key]));
      const values = collection.rows.map(row => row[field.name]).filter(value => value !== null && value !== undefined);
      if (values.length && values.every(value => keys.has(value))) collection.references.push({ field: field.name, collection: target });
    }
  }
  return collections;
}

// The store state seen by a probe: the last storage write of the store key, else the initial data.
export function storeState(initial, storage, storeKey) {
  if (!storeKey) return initial;
  const value = storage?.[storeKey];
  if (value == null) return initial;
  try { const parsed = JSON.parse(value); return storeShape(parsed) || Object.keys(parsed).length ? parsed : initial; } catch { return initial; }
}

// The storage key whose JSON value has the store's collections (the prototype's persistence of the store).
export function findStoreKey(initial, storages) {
  const names = Object.keys(initial ?? {}).sort().join(',');
  for (const storage of storages) {
    for (const [key, value] of Object.entries(storage ?? {})) {
      try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object' && Object.keys(parsed).sort().join(',') === names) return key; } catch { /* not JSON */ }
    }
  }
  return null;
}
