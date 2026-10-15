import fs from 'node:fs';
import { fail } from './errors.mjs';
import { PORTAL_GAPS, PORTAL_READS, PORTAL_WRITES } from './portal-routes.mjs';
import { KNOWLEDGE_FILE_DOWNLOAD } from './knowledge-file-download-plan.mjs';
import { MOBILE_FILE_DOWNLOAD } from './private-mobile-download.mjs';
import { API_CLIENT_VAULT_STATUS } from './api-client-vault-status.mjs';

const source = new URL('../catalog/portal-capabilities.json', import.meta.url);
const kinds = new Set(['public', 'internal', 'gap']);
const STOPWORDS = new Set(['a', 'o', 'as', 'os', 'da', 'de', 'do', 'das', 'dos', 'na', 'no', 'nas', 'nos', 'em', 'um', 'uma', 'e', 'para', 'pra', 'com',
  'the', 'of', 'to', 'in', 'on', 'for', 'and', 'an']);
// Under the facade's 4096-byte answer budget for a tool (answer-size.mjs ANSWER_BUDGETS.other), with room for its envelope.
const PAGE_BUDGET_BYTES = 3600;
const ROW_LIST_MAX = 12;

// Evidence is independent of execution. Registering a description must never
// make an unavailable backend appear authenticated or live-tested.
// tenantAccess: the host registered the tenant-aware tools of the SSAM facade (facade/odc-access.mjs), which run the
// internal routes an entry lists under `access` (portal-routes.mjs) over a supported headless native transport or the vault broker.
export class PortalCapabilities {
  constructor({ catalog, backends = new Map(), evidence, tenantAccess = false } = {}) {
    if (!catalog?.apis || !catalog?.operations) fail('CAPABILITY_CONFIG_INVALID', 'A verified public catalog is required.');
    this.catalog = catalog;
    this.backends = backends;
    this.tenantAccess = tenantAccess === true;
    this.evidence = evidence ?? JSON.parse(fs.readFileSync(source, 'utf8'));
    if (this.evidence.schemaVersion !== 1 || this.evidence.target !== 'odc3') {
      fail('CAPABILITY_CONFIG_INVALID', 'Capability evidence must explicitly target ODC3.');
    }
    if (this.evidence.publicSourceCommit !== catalog.raw.sourceCommit) {
      fail('CAPABILITY_EVIDENCE_STALE', 'Capability evidence and public contracts have different source revisions.');
    }
    this.entries = new Map();
    for (const entry of this.evidence.capabilities) {
      if (!entry.id || this.entries.has(entry.id) || !kinds.has(entry.kind)) {
        fail('CAPABILITY_CONFIG_INVALID', 'Invalid or duplicate capability definition.');
      }
      for (const apiId of entry.publicApiIds ?? []) {
        if (!catalog.apis.has(apiId)) fail('CAPABILITY_CONFIG_INVALID', 'Capability references an unknown public API.');
      }
      if (entry.access) this.checkAccess(entry);
      this.entries.set(entry.id, structuredClone(entry));
    }
  }

  // An entry's internal routes must be the ones portal-routes.mjs runs, its gaps the ones it refuses, and its paths
  // the ones the evidence describes: the inventory never claims a route the runtime does not have.
  checkAccess(entry) {
    const { tools, paths, reads = [], typedReads = [], writes = [], unmapped = [] } = entry.access;
    const known = (list, table) => Array.isArray(list) && list.every(id => Object.hasOwn(table, id));
    if (entry.kind !== 'internal' || !Array.isArray(tools) || !tools.length || !Array.isArray(paths) || !paths.length
      || !paths.every(p => Object.hasOwn(this.evidence.accessPaths ?? {}, p))
      || !known(reads, PORTAL_READS) || !Array.isArray(typedReads) || !typedReads.every(id => [KNOWLEDGE_FILE_DOWNLOAD,MOBILE_FILE_DOWNLOAD,API_CLIENT_VAULT_STATUS].includes(id))
      || !known(writes, PORTAL_WRITES) || !known(unmapped, PORTAL_GAPS)) {
      fail('CAPABILITY_CONFIG_INVALID', 'Capability access does not match the internal route tables: ' + entry.id);
    }
  }

  status() {
    const count = kind => [...this.entries.values()].filter(entry => entry.kind === kind).length;
    return {
      target: 'odc3', reviewedAt: this.evidence.reviewedAt,
      publicSourceCommit: this.evidence.publicSourceCommit,
      publicApiCount: this.catalog.apis.size, publicOperationCount: this.catalog.operations.size,
      capabilityCount: this.entries.size,
      publicDomains: count('public'), existingInternalAreas: count('internal'), unintegratedAreas: count('gap'),
      internalAreasWithAccess: [...this.entries.values()].filter(entry => entry.access).length,
      tenantAccess: this.tenantAccess,
      liveAccess: 'not_established_by_discovery',
      scope: this.evidence.scope,
      guidance: this.tenantAccess
        ? 'Search by intent, inspect the capability, then run it through the tenant-aware tools its execution names (odc_read/odc_write for public operations, odc_portal_read/odc_portal_write and the typed helpers for internal routes); odc_auth_status shows which session answers each tenant. Unmapped routes are refused with the instruction to capture them. Build/deploy logs differ from runtime logs, trace spans and audit trail.'
        : 'Search by intent, inspect the capability, then use an exact public operation ID or an explicitly registered ODC3 internal backend. Build/deploy logs differ from runtime logs, trace spans and audit trail. GitSSAM evidence is not automatic authorization or current ODC3 proof.',
    };
  }

  // Every word of the search must appear in the id, title or keywords; articles and prepositions ("release da lib",
  // "liberar a biblioteca") never filter.
  matching({ search = '', kind, offset = 0, limit = 30 } = {}) {
    if (typeof search !== 'string' || search.length > 500 || (kind !== undefined && !kinds.has(kind))
      || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      fail('INPUT_INVALID', 'Invalid capability search or pagination.');
    }
    const normalize = value => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
    const words = normalize(search).split(/[\s,;:!?()"']+/).filter(word => word && !STOPWORDS.has(word));
    return [...this.entries.values()].filter(entry => (!kind || entry.kind === kind)
      && words.every(word => normalize([entry.id, entry.title, entry.keywords].join(' ')).includes(word)));
  }

  // The answer of odc_portal_capabilities: compact rows (id, title, kind, implementation, tools, reads, writes) of the
  // matching capabilities, as many as fit the byte budget (the facade's 4 KB answer budget never moves the list out), and
  // the next offset. `id` answers the full detail of one capability (the same as odc_describe_capability).
  page({ search, query, kind, id, offset = 0, limit = 30, budgetBytes = PAGE_BUDGET_BYTES } = {}) {
    if (id !== undefined) return this.describe(id);
    if (query !== undefined && search !== undefined && query !== search) fail('INPUT_INVALID', 'Pass search or query, not both.');
    const text = query ?? search ?? '';
    const entries = this.matching({ search: text, kind, offset, limit });
    const size = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
    const answer = { total: entries.length, offset, returned: 0, capabilities: [],
      detail: 'odc_portal_capabilities {id} or odc_describe_capability {capabilityId}: full evidence, input contracts and limitations.' };
    for (const entry of entries.slice(offset, offset + limit)) {
      const row = this.row(entry);
      if (answer.capabilities.length && size(answer) + size(row) + 160 > budgetBytes) break;
      answer.capabilities.push(row); answer.returned++;
    }
    const next = offset + answer.returned;
    if (next < entries.length) {
      answer.nextOffset = next;
      answer.continuation = { tool: 'odc_portal_capabilities', arguments: { ...(text ? { search: text } : {}), ...(kind ? { kind } : {}), offset: next, limit },
        why: 'More capabilities match; this page holds what fits the answer budget.' };
    }
    return answer;
  }

  row(entry) {
    const cap = (list, key) => list.length > ROW_LIST_MAX ? { [key]: list.slice(0, ROW_LIST_MAX), [key + 'Total']: list.length } : list.length ? { [key]: list } : {};
    const access = entry.access;
    const tools = access?.tools ?? (entry.kind === 'public' ? ['odc_read', 'odc_write'] : []);
    return { id: entry.id, title: entry.title, kind: entry.kind, implementation: entry.implementation, ...(tools.length ? { tools } : {}),
      ...(access ? { ...cap([...(access.reads ?? []), ...(access.typedReads ?? [])], 'reads'), ...cap(access.writes ?? [], 'writes') } : {}) };
  }

  list({ search = '', kind, offset = 0, limit = 30 } = {}) {
    const entries = this.matching({ search, kind, offset, limit });
    return { total: entries.length, offset, limit, capabilities: entries.slice(offset, offset + limit).map(entry => ({
      id: entry.id, title: entry.title, kind: entry.kind, publicCoverage: entry.publicCoverage,
      implementation: entry.implementation, execution: this.execution(entry, { brief: true }),
    })) };
  }

  describe(id) {
    const entry = this.entries.get(id);
    if (!entry) fail('CAPABILITY_NOT_FOUND', 'Capability ID is not in the reviewed ODC3 inventory.');
    const publicApis = (entry.publicApiIds ?? []).map(apiId => {
      const api = this.catalog.apis.get(apiId);
      return { id: apiId, title: api.title, source: api.source,
        operations: api.operations.map(operation => ({ id: operation.id, method: operation.method, path: operation.path,
          summary: operation.summary, readOnly: operation.readOnly })) };
    });
    return { ...structuredClone(entry), target: 'odc3', publicApis, execution: this.execution(entry) };
  }

  execution(entry, { brief = false } = {}) {
    if (entry.kind === 'public') return this.tenantAccess ? {
      route: 'public_contract', implemented: true, tools: ['odc_read', 'odc_write'], authentication: 'studio_session_then_vault_api_client',
      liveVerified: false, nextStep: 'Search/describe an exact operation, then odc_read or odc_write {tenant, operationId}: the ODC Studio session on the tenant first, then the vault API Client, missing credentials refuse without a prompt. Writes need the user\'s words and a new operationUuid.',
    } : {
      route: 'public_contract', implemented: true, authentication: 'operator_configured_api_client',
      liveVerified: false, nextStep: 'Search/describe an exact operation and check connection/write-policy status. Discovery does not contact or authenticate the tenant.',
    };
    const backend = this.backends.get(entry.id);
    if (backend && backend.target === 'odc3' && typeof backend.execute === 'function') return {
      route: 'registered_internal_backend', implemented: true,
      // Never accept caller-provided text claiming authentication or proof.
      authentication: backend.authenticated === true ? 'host_reports_authenticated' : 'host_session_required',
      liveVerified: false,
      nextStep: 'Use the host backend with an explicit target and tenant; internal compatibility and permissions are checked per call.',
    };
    if (entry.access) {
      const { tools, paths, reads = [], typedReads = [], writes = [], unmapped = [], secrets } = entry.access;
      const routes = brief ? { reads: reads.length, writes: writes.length, ...(unmapped.length ? { unmapped } : {}) }
        : { reads, writes, ...(unmapped.length ? { unmapped: unmapped.map(id => ({ id, code: 'PORTAL_ROUTE_UNMAPPED', instruction: PORTAL_GAPS[id] })) } : {}),
          ...(secrets ? { secrets } : {}) };
      if (typedReads.length) routes.typedReads = brief ? typedReads.length : typedReads;
      if (this.tenantAccess) return {
        route: 'tenant_access', implemented: true, tools,
        paths: brief ? paths : paths.map(path => ({ path, how: this.evidence.accessPaths[path] })),
        authentication: 'native_headless_then_compatible_saved_profile', liveVerified: false, ...routes,
        nextStep: 'odc_auth_status {tenant} shows which session answers; odc_portal_login {tenant} authenticates without UI; native headless SSO requires bridge support, otherwise a compatible stored profile is required; then ' + tools.join(', ')
          + ' with the operation IDs above. Writes need the user\'s words and a new operationUuid; internal contracts can change.',
      };
      return {
        route: 'unavailable', implemented: false, authentication: 'not_connected', liveVerified: false, code: 'PORTAL_BACKEND_NOT_CONNECTED', ...routes,
        nextStep: 'Implemented by the tenant-aware tools of the SSAM facade (' + tools.join(', ') + ') over a supported headless native transport or the vault broker; this server does not register them. Use the ssam or ssam-hybrid-odc MCP.',
      };
    }
    return {
      route: 'unavailable', implemented: false, authentication: 'not_connected', liveVerified: false,
      code: entry.kind === 'internal' ? 'PORTAL_BACKEND_NOT_CONNECTED' : 'CAPABILITY_NOT_IMPLEMENTED',
      nextStep: entry.kind === 'internal'
        ? entry.localAdapter
          ? 'An offline-tested read adapter exists locally, but requires a registered ODC3-scoped host and managed Portal-session broker. Do not substitute Studio Bearer or infer live access from historical ODC1 tests.'
          : 'An implementation exists in GitSSAM but needs an ODC3-scoped host adapter and managed Portal session. Do not substitute Studio Bearer, scan credential files, or claim success from historical ODC1 tests.'
        : 'This area requires additional mapping or a separately authorized external connector; no arbitrary URL fallback is provided.',
    };
  }
}
