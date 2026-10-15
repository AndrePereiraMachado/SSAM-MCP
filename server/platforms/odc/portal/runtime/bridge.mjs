import crypto from 'node:crypto';
import { Catalog } from './catalog.mjs';
import { readConfig } from './config.mjs';
import { OAuthClient } from './auth.mjs';
import { prepareRequest } from './request.mjs';
import { requestBytes, readJson } from './http.mjs';
import { fail, publicError } from './errors.mjs';
import { SEARCH_POSTS } from './effects.mjs';
import { projectForAgent, trustedProjection } from './agent-projection.mjs';

export class OdcBridge {
  constructor({ catalog = new Catalog(), config = readConfig(), fetchImpl = globalThis.fetch, now = Date.now, auth } = {}) {
    this.catalog = catalog;
    this.config = config;
    this.fetch = fetchImpl;
    this.now = now;
    if (auth && (typeof auth.method !== 'string' || !auth.method || ['configured', 'getToken', 'invalidate', 'secrets'].some(name => typeof auth[name] !== 'function')))
      fail('CONFIGURATION_INVALID', 'An internal authentication provider must implement its complete contract.');
    this.auth = auth ?? new OAuthClient(config, fetchImpl, now);
    this.requests = new Map();
    for (const id of config.allowedWriteOperations) {
      if (!catalog.operations.has(id) || catalog.operations.get(id).readOnly) fail('CONFIGURATION_INVALID', 'Write allowlist must contain exact mutation operation IDs from this catalog.');
    }
  }

  status() {
    return { catalog: { apiCount: this.catalog.apis.size, operationCount: this.catalog.operations.size,
      sourceCommit: this.catalog.raw.sourceCommit },
    auth: { configured: this.auth.configured(), method: this.auth.method ?? 'OAuth 2.0 client_credentials', credentialsExposed: false,
      accessVerified: Boolean(this.lastSuccessfulRequest) },
    policy: { readOnlyByDefault: true, allowedWriteOperations: [...this.config.allowedWriteOperations] },
    monitoring: {
      buildAndDeliveryLogs: {
        publicContractAvailable: true, adapterImplemented: true,
        operationIds: [...this.catalog.operations.values()].filter(operation => operation.readOnly && (
          operation.path.endsWith('/log-messages') || ['deployments-api-v1'].includes(operation.apiId) && operation.path.endsWith('/messages')
        )).map(operation => operation.id),
        liveVerified: false,
      },
      runtimeApplicationLogs: { publicContractAvailable: false, backendConnected: false, liveVerified: false },
      distributedTraces: { publicContractAvailable: false, backendConnected: false, liveVerified: false },
    },
    limitations: ['Only documented public contracts are included; this is not every Portal feature.',
      'No automatic pagination or mutation retries. Each invocation handles one request/page.',
      'Business data is returned subject to API client permissions; secrets are redacted, binary responses are summarized.',
      'Catalog and local mock tests do not prove live tenant authorization.'],
    };
  }

  charge(apiId, operation) {
    const now = this.now();
    const keys = [[apiId, apiId === 'environment-configurations-api-v1' ? 10 : 100]];
    if (!operation.readOnly) keys.push([operation.id, 5]);
    for (const [key, limit] of keys) {
      const recent = (this.requests.get(key) ?? []).filter(t => t > now - 60_000);
      this.requests.set(key, recent);
      if (recent.length >= limit) fail('LOCAL_RATE_LIMIT', 'Local request budget exhausted. Wait before retrying.', { retryAfterSeconds: Math.ceil((recent[0] + 60_000 - now) / 1000) });
    }
    for (const [key] of keys) this.requests.get(key).push(now);
  }

  async execute(operationId, input = {}, mode = 'read') {
    return projectForAgent(() => this.executeRaw(operationId, input, mode));
  }

  async executeRaw(operationId, input = {}, mode = 'read') {
    let operation;
    try {
      ({ operation } = this.catalog.get(operationId));
      if (mode !== 'read' && mode !== 'write') fail('INPUT_INVALID', 'Mode must be read or write.');
      // The exact read-only POST searches (effects.mjs) travel as reads, with the read retry on 401.
      if (SEARCH_POSTS.has(operationId)) operation = { ...operation, readOnly: true };
      if (mode === 'read' && !operation.readOnly) fail('WRITE_BLOCKED', 'Mutation is not available through the read tool.');
      if (mode === 'write' && (operation.readOnly || !this.config.allowedWriteOperations.has(operationId))) {
        fail('WRITE_BLOCKED', 'This mutation is not authorized by the external operator policy.');
      }
      const request = prepareRequest(this.catalog, operationId, input, this.config);
      if (!this.auth.configured()) fail('AUTH_NOT_CONFIGURED', 'Configure the portal origin and an authorized API client locally; do not send credentials through tool arguments.');
      if (request.body instanceof FormData) {
        const encoded = new Response(request.body);
        const bytes = Buffer.from(await encoded.arrayBuffer());
        if (bytes.length > this.config.maxRequestBytes) fail('REQUEST_TOO_LARGE', 'Multipart body exceeds the request size limit.');
        request.body = bytes;
        request.headers['content-type'] = encoded.headers.get('content-type');
      }
      let token = await this.auth.getToken();
      this.charge(request.api.id, operation);
      const send = () => requestBytes(this.fetch, request.url, { method: request.method,
        headers: { ...request.headers, authorization: `Bearer ${token}` }, body: request.body }, this.config);
      let response = await send();
      // Reads may be retried exactly once on 401. A mutation is never automatically replayed.
      if (response.status === 401) {
        this.auth.invalidate(token);
        if (operation.readOnly && this.auth.retryReadOnUnauthorized !== false) {
          token = await this.auth.getToken();
          this.charge(request.api.id, operation);
          response = await send();
        }
      }
      let data;
      const contentType = response.headers.get('content-type') ?? '';
      if (!response.bytes.length) data = null;
      else if (/\bjson\b/i.test(contentType)) data = readJson(response.bytes);
      else data = { contentOmitted: true, mediaType: contentType, byteLength: response.bytes.length,
        sha256: crypto.createHash('sha256').update(response.bytes).digest('hex'),
        reason: 'Non-JSON response is not exposed to the model.' };
      if (response.ok) this.lastSuccessfulRequest = this.now();
      return trustedProjection({ ok: response.ok, operationId, status: response.status, data,
        ...(response.status === 429 ? { retryAfter: response.headers.get('retry-after'), automaticRetry: false } : {}),
        ...(!response.ok ? { error: { code: response.status === 401 ? 'API_UNAUTHORIZED' : response.status === 403 ? 'API_FORBIDDEN' : 'API_ERROR',
          message: response.status === 401 ? 'The API rejected the client token.' : response.status === 403 ? 'The API client is not authorized for this operation.' : 'The API returned an unsuccessful response.',
          ...(!operation.readOnly ? { retrySafety: 'Do not retry a mutation until its outcome has been reconciled.' } : {}),
        } } : {}),
      }, this.auth.secrets());
    } catch (error) {
      return trustedProjection({ ok: false, operationId, error: { ...publicError(error),
        ...(!operation?.readOnly && operation ? { retrySafety: 'If a mutation may have been sent, reconcile its outcome before retrying.' } : {}),
      } }, this.auth.secrets());
    }
  }
}
