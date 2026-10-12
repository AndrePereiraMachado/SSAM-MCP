// Internal Portal transport through an authenticated headless bridge session.
// The resolver requires portal-session:headless and a signed-in status before
// using this adapter. Bridge v44 cannot establish that session; auto may select
// a compatible private profile instead. No cookie/token is extracted from Studio.
import fs from 'node:fs';
import path from 'node:path';
import { PortalMetadata } from './portal-metadata.mjs';
import { PORTAL_READS, checkSecretRefs, pointerValue, routeOf, screenservice, wirePointer } from './portal-routes.mjs';
import { fail, redact } from './errors.mjs';
import { readCheckpoint } from '../../facade/read-budget.mjs';

const SESSION_CODES = new Set(['HEADLESS_AUTH_UNAVAILABLE', 'WEB_SIGN_IN_REQUIRED', 'STUDIO_NOT_SIGNED_IN', 'NOT_ALLOWED', 'HOST_MISMATCH', 'UNCERTAIN', 'BAD_REQUEST', 'REMOTE_ERROR']);

export class StudioPortalBroker {
  // bridge(args) runs one bridge command; requestFile(json) writes it under journal\portal\requests and returns the path.
  constructor({ host, bridge, requestFile }) {
    this.target = 'odc3'; this.host = host; this.origin = 'https://' + host; this.bridge = bridge; this.requestFile = requestFile;
    this.metadata = new PortalMetadata({ origin: this.origin, request: (url, options) => this.request(url, options) });
    this.verifiedOperations = new Set(); this.blockedOperations = new Set();
    this.transport = { origin: this.origin, metadata: this.metadata, request: (url, options) => this.request(url, options) };
  }

  async session(action) {
    readCheckpoint('authentication');
    const answer = await this.bridge(['portal-session', action, '--tenant', this.host]);
    if (answer?.host && String(answer.host).toLowerCase() !== this.host) fail('HOST_MISMATCH', 'The Studio answered for another host.');
    return answer;
  }

  async request(value, { method = 'GET', body, write = false, operationUuid, authorizeSha256, confirmTenant, secretRefs } = {}) {
    readCheckpoint('transport');
    const url = new URL(value);
    if (url.origin !== this.origin || url.username || url.password || url.hash) fail('PORTAL_ORIGIN_DENIED', 'Only the selected tenant origin is reachable through the Studio headless transport.');
    // secretRefs leave this process as vault entry names only; the bridge reads the entry inside the ODC Studio and
    // fills the placeholder right before the page's fetch (CONTRATO.md). Writes only; the pointers given here name the
    // screenservice input and go to the bridge as pointers into the wire body.
    if (secretRefs?.length && !write) fail('INPUT_INVALID', 'secretRefs travel only with a write.');
    const refs = checkSecretRefs(this.host, secretRefs ?? []).map(({ pointer, target, field }) => ({ pointer: wirePointer(pointer), target, field }));
    for (const ref of refs) if (pointerValue(body, ref.pointer) !== '') fail('INPUT_INVALID', 'Each secretRefs pointer must name an existing field of the body holding an empty placeholder: ' + ref.pointer);
    const file = await this.requestFile({ method, path: url.pathname + url.search, ...(body === undefined ? {} : { body }), write,
      ...(write ? { operationUuid, authorizeSha256, confirmTenant } : {}), ...(refs.length ? { secretRefs: refs } : {}) });
    const answer = await this.bridge(['portal-session', 'fetch', file, '--tenant', this.host]);
    if (answer?.outcome === 'gate_refused') fail('STUDIO_BUSY', 'The Studio was busy; nothing was sent.', { gate: answer.gate ?? null });
    if (!answer || answer.ok !== true) {
      const code = SESSION_CODES.has(answer?.code) ? answer.code : 'PORTAL_WINDOW_FAILED';
      // A status means the request reached the Portal: `sent` lets a write tell "refused" from "maybe applied".
      fail(code, code === 'WEB_SIGN_IN_REQUIRED' || code === 'HEADLESS_AUTH_UNAVAILABLE' ? 'The Studio has no authenticated headless Portal session. Use an existing compatible private profile through auth:"auto"; interactive sign-in is not launched.'
        : code === 'UNCERTAIN' ? 'The request may have reached the Portal; reconcile by a read, never resend.' : 'The Studio headless Portal transport refused or failed the request.',
        { ...(typeof answer?.status === 'number' ? { status: answer.status, sent: true } : {}), ...(answer?.gate ? { gate: answer.gate } : {}), ...(answer?.reason ? { reason: answer.reason } : {}) });
    }
    // The bridge answers with the Studio session's host name, compared without case like the bridge does.
    if (answer.host && String(answer.host).toLowerCase() !== this.host) fail('HOST_MISMATCH', 'The Studio answered for another host.');
    if (answer.finalUrl && new URL(answer.finalUrl).origin !== this.origin) fail('HOST_MISMATCH', 'The Portal response left the tenant origin.');
    this.user = answer.user ?? this.user;
    // Bodies above 4 MB (large script bundles) come as a redacted file the bridge wrote under journal\portal\downloads.
    const text = typeof answer.bodyFile === 'string' ? readDownload(answer.bodyFile)
      : typeof answer.text === 'string' ? answer.text : JSON.stringify(answer.body ?? null);
    return { status: answer.status, location: null, text };
  }

  // Same scope checks as the vault broker (odc3-context.mjs), so PortalReadAdapter works over either session.
  async readScreenservice(request) {
    if (request.target !== this.target || request.origin !== this.origin || request.readOnly !== true) fail('PORTAL_ACCESS_DENIED', 'Broker scope does not match.');
    const expected = Object.hasOwn(PORTAL_READS, request.operationId) ? PORTAL_READS[request.operationId] : null;
    if (!expected || expected[0] !== request.module || expected[1] !== request.view || expected[2] !== request.action || expected[3] !== request.discoveryView) fail('PORTAL_ACCESS_DENIED', 'Internal operation is not allowlisted for this action/view.');
    const body = await screenservice(this.transport, { module: request.module, view: request.view, action: request.action, discoveryView: request.discoveryView ?? request.view,
      inputParameters: request.inputParameters, screenVariables: request.screenVariables, clientVariables: request.clientVariables, signal: request.signal });
    return { target: this.target, origin: this.origin, body: redact(body) };
  }

  async callScreenservice({ operationId, write = false, input, secretRefs = [], operationUuid, authorizeSha256, confirmTenant, signal }) {
    const route = routeOf(operationId, write);
    const body = await screenservice(this.transport, { ...route, ...input, signal,
      extra: write ? { write: true, operationUuid, authorizeSha256, confirmTenant, secretRefs } : {} });
    return redact(body);
  }
}

function readDownload(file) {
  const normalized = path.resolve(file);
  if (!/[\\/]journal[\\/]portal[\\/]downloads[\\/][^\\/]+$/i.test(normalized)) fail('PORTAL_WINDOW_FAILED', 'Unexpected body file location.');
  return fs.readFileSync(normalized, 'utf8');
}
