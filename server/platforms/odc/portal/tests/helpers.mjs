import { resolveRef } from '../runtime/catalog.mjs';
import { readConfig } from '../runtime/config.mjs';

export function testConfig(overrides = {}) {
  return { ...readConfig({ ODC_PORTAL_ORIGIN: 'https://tenant.example.test', ODC_CLIENT_ID: 'mock-client', ODC_CLIENT_SECRET: 'mock-secret-not-real' }), ...overrides };
}

export function mockFetch({ apiHandler, discoveryHandler, tokenHandler } = {}) {
  const calls = [];
  let tokens = 0;
  const fetchImpl = async (url, options = {}) => {
    const request = { url: String(url), ...options };
    calls.push(request);
    if (String(url).endsWith('/identity/.well-known/openid-configuration')) {
      return discoveryHandler ? discoveryHandler(request) : Response.json({
        token_endpoint: 'https://tenant.example.test/identity/connect/token',
        grant_types_supported: ['client_credentials'], token_endpoint_auth_methods_supported: ['client_secret_post'],
      });
    }
    if (String(url).endsWith('/identity/connect/token')) {
      tokens++;
      return tokenHandler ? tokenHandler(request, tokens) : Response.json({ access_token: `mock-access-token-${tokens}`, token_type: 'Bearer', expires_in: 3600 });
    }
    return apiHandler ? apiHandler(request) : Response.json({ items: [], testOnly: true });
  };
  return { fetchImpl, calls, get tokenCount() { return tokens; } };
}

export function sample(spec, input, depth = 0) {
  if (depth > 20) throw new Error('Unexpected required recursion in sample generator');
  const schema = resolveRef(spec, input) ?? {};
  if (schema.example !== undefined) return schema.example;
  if (schema.enum?.length) return schema.enum.find(v => v !== null) ?? null;
  if (schema.default !== undefined) return schema.default;
  if (schema.allOf?.length) {
    const values = schema.allOf.map(s => sample(spec, s, depth + 1));
    return values.every(v => v && typeof v === 'object' && !Array.isArray(v)) ? Object.assign({}, ...values) : values[0];
  }
  if (schema.oneOf?.length || schema.anyOf?.length) return sample(spec, (schema.oneOf ?? schema.anyOf).find(s => s.type !== 'null'), depth + 1);
  if (schema.type === 'object' || schema.properties) return Object.fromEntries((schema.required ?? [])
    .filter(key => !resolveRef(spec, schema.properties?.[key])?.readOnly)
    .map(key => [key, sample(spec, schema.properties?.[key], depth + 1)]));
  if (schema.type === 'array') return Array.from({ length: Math.max(schema.minItems ?? 0, 1) }, () => sample(spec, schema.items, depth + 1));
  if (schema.type === 'boolean') return false;
  if (['integer', 'number'].includes(schema.type)) return Math.max(schema.minimum ?? 1, 1);
  if (schema.format === 'uuid') return '11111111-1111-4111-8111-111111111111';
  if (schema.format === 'date-time') return '2026-09-15T12:00:00Z';
  if (schema.format === 'date') return '2026-09-15';
  if (schema.format === 'email') return 'example@example.test';
  if (schema.format === 'uri') return 'https://example.test';
  return 'x'.repeat(Math.max(schema.minLength ?? 1, 1));
}

export function sampleRequest(api, operation) {
  const input = { path: {}, query: {} };
  for (const p of operation.parameters) if (p.required || p.in === 'path') input[p.in][p.name] = sample(api.spec, p.schema);
  const body = resolveRef(api.spec, operation.requestBody);
  if (body) {
    const media = body.content['application/json'] ?? Object.values(body.content)[0];
    input.contentType = body.content['application/json'] ? 'application/json' : Object.keys(body.content)[0];
    input.body = sample(api.spec, media.schema);
  }
  return input;
}
