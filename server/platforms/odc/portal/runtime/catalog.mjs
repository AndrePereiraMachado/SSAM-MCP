import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { fail } from './errors.mjs';

const defaultDirectory = fileURLToPath(new URL('../catalog/', import.meta.url));

// The published .NET-generated contracts use nullable beside allOf/$ref without
// a sibling type. Express that intent in JSON Schema without altering originals.
function normalizeSchema(value) {
  if (Array.isArray(value)) return value.map(normalizeSchema);
  if (!value || typeof value !== 'object') return value;
  const copy = Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeSchema(entry)]));
  if (ownNullableWithoutType(copy)) {
    const nullable = copy.nullable;
    delete copy.nullable;
    return nullable ? { anyOf: [copy, { type: 'null' }] } : copy;
  }
  return copy;
}
function ownNullableWithoutType(value) { return 'nullable' in value && !('type' in value); }

export function resolveRef(spec, entry) {
  if (!entry?.$ref) return entry;
  if (!entry.$ref.startsWith('#/')) fail('CONTRACT_UNSUPPORTED', 'External schema references are not allowed.');
  let value = spec;
  for (const segment of entry.$ref.slice(2).split('/')) value = value?.[segment.replaceAll('~1', '/').replaceAll('~0', '~')];
  if (!value) fail('CONTRACT_INVALID', 'A local schema reference could not be resolved.');
  return resolveRef(spec, value);
}

export class Catalog {
  constructor(directory = defaultDirectory) {
    this.raw = JSON.parse(fs.readFileSync(path.join(directory, 'catalog.json'), 'utf8'));
    this.apis = new Map();
    this.operations = new Map();
    this.validators = new Map();
    for (const api of this.raw.apis) {
      const bytes = fs.readFileSync(path.join(directory, api.specFile));
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== api.sha256) fail('CONTRACT_INTEGRITY', 'Pinned OpenAPI hash mismatch.');
      const spec = JSON.parse(bytes);
      const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: true, coerceTypes: false });
      addFormats(ajv);
      ajv.addFormat('int32', { type: 'number', validate: n => Number.isInteger(n) && n >= -2147483648 && n <= 2147483647 });
      ajv.addFormat('int64', { type: 'number', validate: Number.isSafeInteger });
      for (const name of ['binary', 'byte']) ajv.addFormat(name, true);
      for (const name of ['double', 'float']) ajv.addFormat(name, { type: 'number', validate: Number.isFinite });
      const rootId = `urn:odc:${api.id}`;
      ajv.addSchema({ $id: rootId, components: normalizeSchema(spec.components ?? {}) });
      const basePath = new URL(api.servers[0].url.replace('ODC_PORTAL_DOMAIN', 'placeholder.invalid')).pathname.replace(/\/$/, '');
      if (!basePath.startsWith('/api/') || basePath.includes('..')) fail('CONTRACT_INVALID', 'Unexpected API base path.');
      this.apis.set(api.id, { ...api, spec, ajv, rootId, basePath });
      for (const operation of api.operations) {
        if (this.operations.has(operation.id)) fail('CONTRACT_INVALID', 'Duplicate operation ID.');
        this.operations.set(operation.id, { ...operation, apiId: api.id });
      }
    }
    if (this.operations.size !== this.raw.operationCount) fail('CONTRACT_INVALID', 'Operation count differs from the pinned inventory.');
  }

  get(id) {
    const operation = this.operations.get(id);
    if (!operation) fail('OPERATION_NOT_FOUND', 'Operation ID is not in the pinned public API catalog.');
    return { operation, api: this.apis.get(operation.apiId) };
  }

  list({ apiId, search = '', readOnly, offset = 0, limit = 30 } = {}) {
    const needle = search.toLowerCase();
    const found = [...this.operations.values()].filter(o => (!apiId || o.apiId === apiId)
      && (readOnly === undefined || o.readOnly === readOnly)
      && [o.id, o.operationId, o.summary, o.description].join(' ').toLowerCase().includes(needle));
    return { total: found.length, offset, limit, operations: found.slice(offset, offset + limit).map(o => ({
      id: o.id, apiId: o.apiId, operationId: o.operationId, method: o.method, path: o.path,
      summary: o.summary, readOnly: o.readOnly, deprecated: o.deprecated,
    })) };
  }

  describe(id) {
    const { operation, api } = this.get(id);
    const definitions = {};
    const seen = new Set();
    const collect = value => {
      if (!value || typeof value !== 'object') return;
      if (value.$ref && !seen.has(value.$ref)) {
        seen.add(value.$ref);
        const target = resolveRef(api.spec, value);
        definitions[value.$ref] = target;
        collect(target);
      }
      for (const child of Object.values(value)) collect(child);
    };
    collect(operation);
    return { ...operation, basePath: api.basePath, source: api.source, sourceCommit: this.raw.sourceCommit,
      referencedDefinitions: definitions,
      requestConvention: 'Use path/query objects with native JSON types. JSON body is native JSON. Binary fields use {$base64, filename?}. Pagination is explicit, one page per invocation.',
    };
  }

  validate(api, schema, value, location) {
    if (!schema) return;
    const key = `${api.id}:${JSON.stringify(schema)}`;
    let validator = this.validators.get(key);
    if (!validator) {
      // Keep refs local to the API document while retaining recursive definitions.
      const qualify = value => {
        if (Array.isArray(value)) return value.map(qualify);
        if (!value || typeof value !== 'object') return value;
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k,
          k === '$ref' && typeof v === 'string' && v.startsWith('#/') ? api.rootId + v : qualify(v)]));
      };
      try { validator = api.ajv.compile(qualify(normalizeSchema(schema))); }
      catch { fail('CONTRACT_INVALID', 'Cannot compile this pinned request schema.', { location }); }
      this.validators.set(key, validator);
    }
    if (!validator(value)) fail('INPUT_INVALID', 'Request does not satisfy the public API schema.', {
      location, issues: validator.errors.slice(0, 12).map(e => ({ path: e.instancePath, rule: e.keyword })),
    });
  }
}
