import { wordsGiven } from './destructive-operations.mjs';
import fs from 'node:fs';
import * as z from 'zod/v4';
import { debugSchema, sessionIdSchema } from './debug.mjs';
import { DIAGNOSTICS_RULE } from './debug-guidance.mjs';
import { legacyNotice, legacyPrefix } from './debug-adapter-registry.mjs';

// Legacy one-shot surface (req 17): not interactive, not counted in the debugger matrix.
const LEGACY = legacyPrefix('ssam_debug_invoke');

const pointer = z.string().regex(/^(?:\/(?:[A-Za-z0-9_.-]|~[01])+)+$/).max(500);
const uuid = z.uuid();
const targetAction = z.object({
  snapshot: z.string().max(2000), expectedSourceSha256: z.string().regex(/^[A-Fa-f0-9]{64}$/),
  actionKey: z.string().regex(/^[A-Za-z0-9_+]{22}$/),
}).strict();
export const invokeSchema = z.object({
  op: z.enum(['prepare', 'run', 'status', 'forget']), lane: z.literal('odc').default('odc'),
  planId: uuid.optional(), operationId: uuid.optional(), tabId: z.string().regex(/^[A-Fa-f0-9]{32}$/).optional(),
  requestFile: z.string().max(2000).optional(),
  sourcePlanId: uuid.optional(),
  origin: z.url().optional(), snapshot: z.string().max(2000).optional(),
  expectedSourceSha256: z.string().regex(/^[A-Fa-f0-9]{64}$/).optional(),
  actionKey: z.string().regex(/^[A-Za-z0-9_+]{22}$/).optional(),
  target: targetAction.optional(),
  entryPath: z.string().regex(/^\/[A-Za-z0-9_\/-]+$/).max(500).optional(),
  inputPaths: z.array(pointer).max(100).default([]), outputPaths: z.array(pointer).max(20).default([]),
  inputs: z.record(pointer, z.json()).default({}), reload: z.boolean().default(false),
  authorization: z.string().min(1).max(2000).optional(), timeoutSeconds: z.number().int().min(1).max(90).default(30),
  sessionId: sessionIdSchema.optional(), debug: debugSchema.optional(),
}).strict().superRefine((v, raw) => {
  const ctx = { addIssue: issue => raw.addIssue({ ...issue, message: LEGACY + issue.message }) };
  const need = name => { if (!v[name]) ctx.addIssue({ code: 'custom', path: [name], message: name + ' is required for ' + v.op }); };
  // CX15 r7 (M-1): the authorization (a run, a reload) is the owner's words (wordsGiven), never a marker, template or sha256.
  if (v.authorization !== undefined && !wordsGiven(v.authorization)) ctx.addIssue({ code: 'custom', path: ['authorization'], message: 'WORDS_REQUIRED: the owner\'s own words, never a marker, a <template> or a sha256 of the server' });
  if (v.op === 'prepare') {
    for (const name of ['origin', 'snapshot', 'expectedSourceSha256', 'actionKey']) need(name);
    if ([v.tabId, v.requestFile, v.sourcePlanId].filter(Boolean).length !== 1) ctx.addIssue({ code: 'custom', path: ['requestFile'], message: 'Choose a private native request file, an existing sourcePlanId, or isolated-browser bootstrap tabId' });
    if (v.reload) need('authorization');
    if (v.origin) { const u = new URL(v.origin); if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) ctx.addIssue({ code: 'custom', path: ['origin'], message: 'Exact HTTPS origin required' }); }
  } else if (v.op === 'status') need('operationId');
  else need('planId');
  if (v.op === 'run') {
    need('operationId'); need('authorization');
    if (!!v.debug === !!v.sessionId) ctx.addIssue({ code: 'custom', path: ['debug'], message: 'Choose a new debug start configuration or an existing sessionId' });
    if (v.debug && (v.debug.op !== 'start' || v.debug.lane !== 'odc' || !v.debug.autoContinue)) ctx.addIssue({ code: 'custom', path: ['debug'], message: 'Invocation creates an ODC autoContinue session; use sessionId for manual stepping' });
    if (v.debug && v.debug.seconds < v.timeoutSeconds + 30) ctx.addIssue({ code: 'custom', path: ['debug'], message: 'New debugger lifetime must exceed invocation timeout by 30 seconds' });
  }
});
export function parseInvokeCli(args) {
  const [op, flag, file, ...extra] = args;
  if (!op || flag !== '--request' || !file || extra.length) throw new Error('Usage (legacy, not interactive): ssam debug invoke prepare|run|status|forget --request <json-file>; interactive debugging uses ssam debug server|client --stdio');
  const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (data.op && data.op !== op) throw new Error('invoke_operation_mismatch');
  return invokeSchema.parse({ ...data, op });
}
export function registerInvokeTools(server, execute, wrap) {
  server.registerTool('ssam_debug_invoke', {
    title: 'LEGACY: invoke an existing ODC entry and observe internal actions headlessly',
    description: DIAGNOSTICS_RULE + ' ' + legacyNotice('ssam_debug_invoke') + ' HEADLESS HTTP invocation in a separate worker for an existing ODC screenservices entry, without browser execution, app edits or publication. prepare binds an action key to a hash-checked OML and an observed native request envelope: requestFile is a CURRENT-USER-ONLY private JSON file outside the repository, sourcePlanId reuses an existing envelope, and tabId is optional authorized browser bootstrap. Secrets NEVER belong in tool arguments, chat or receipts. run uses the app user entered in the English native sign-in window of ssam_debug start; an existing sessionId must already hold an unexpired signed-in app user. Captured cookies, Authorization and CSRF values are discarded before send and replaced privately by that session\'s native runtime bearer. A missing, expired, differently bound or rejected sign-in prevents the POST; there is no fallback to the captured identity. Windows CurrentUser DPAPI protects private records. target optionally binds an internal ServerAction/ServiceAction/DataAction in another capture of the same tenant; targetActionObserved requires stack evidence. Inputs belong to the existing caller; this is not arbitrary ServerAction invocation. inputPaths/outputPaths are JSON pointers with observed wire types. run requires planId, stable operationId UUID, inputs, user authorization, and debug (new ODC autoContinue session) or sessionId. run returns immediately; status reports selected filtered outputs, events and cleanup. Reusing operationId reads its receipt and NEVER sends again. Lost responses remain uncertain without retry. Created debug sessions are stopped; supplied sessions remain caller-owned. A 200 response alone does not prove business success or a breakpoint. forget removes only inactive private request data; receipts remain. Native sign-in and caller execution require live validation; the live identity combination is unproven. ODC only; there is no O11 invocation.',
    inputSchema: invokeSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, wrap(execute));
}
