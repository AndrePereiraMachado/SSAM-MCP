import * as z from 'zod/v4';
import fs from 'node:fs';
import path from 'node:path';
import { DIAGNOSTICS_RULE } from './debug-guidance.mjs';
export const debugOperations = ['start', 'watch', 'status', 'stop', 'variables', 'continue', 'step-over', 'step-into', 'step-out'];
const key = z.string().regex(/^[A-Za-z0-9_+]{22}$/);
const variablePath = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.\[\]]{0,499}$/);
export const sessionIdSchema = z.string().regex(/^[a-f0-9]{32}$/);
// Published identity only. The native SSO bearer is obtained privately from the selected Studio.
export const o11AuthSchema = z.object({
  applicationKey: key,
  publishedVersionId: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  publishedProof: z.object({
    path: z.string().min(1).max(2000).refine(value => path.isAbsolute(value), 'Absolute inventory proof path required'),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
}).strict();
// Tracer (kernel/debug/shared TraceOptions): every pause is dumped and stepped at once; trace.jsonl holds the map.
export const traceSchema = z.object({
  mode: z.enum(['step', 'breakpoints']).default('step'), steps: z.number().int().min(1).max(2000).default(200),
  depth: z.number().int().min(0).max(4).default(2), fullValues: z.boolean().default(false),
  focusFunctionKey: key.optional(), requireFunctionKey: key.optional(),
  scopes: z.record(key, z.array(variablePath).max(60)).default({}),
}).strict();
export const debugSchema = z.object({
  op: z.enum(debugOperations), lane: z.enum(['odc', 'o11']).optional(), sessionId: sessionIdSchema.optional(),
  tenant: z.string().max(200).optional(), module: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,198}$/).optional(),
  moduleKey: key.optional(), runtimeUrl: z.url().optional(), nodeKeys: z.array(key).min(1).max(200).optional(), trace: traceSchema.optional(),
  credentials: z.string().max(2000).optional(), seconds: z.number().int().min(1).max(600).default(120),
  o11Auth: o11AuthSchema.optional(),
  pauseSeconds: z.number().int().min(1).max(30).default(5), autoContinue: z.boolean().default(true),
  paths: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_.\[\]]{0,499}$/)).max(30).default([]),
  frame: z.number().int().min(0).max(100).default(0), depth: z.number().int().min(0).max(4).default(1),
  threadId: z.string().min(1).max(200).optional(), eventId: z.string().regex(/^\d+$/).optional(),
}).strict().superRefine((v, ctx) => {
  const need = field => { if (!v[field]) ctx.addIssue({ code: 'custom', path: [field], message: `${field} is required for ${v.op}` }); };
  if (['start', 'watch'].includes(v.op)) {
    for (const field of ['lane', 'module', 'moduleKey', 'runtimeUrl', 'nodeKeys']) need(field);
    if (v.lane === 'odc') need('tenant');
    if (v.sessionId) ctx.addIssue({ code: 'custom', path: ['sessionId'], message: `${v.op} creates its own sessionId; never repeat an uncertain start` });
    if (v.nodeKeys && new Set(v.nodeKeys).size !== v.nodeKeys.length) ctx.addIssue({ code: 'custom', path: ['nodeKeys'], message: 'Duplicate breakpoints' });
    if (v.nodeKeys && v.nodeKeys.length > 20 && !v.trace && v.op !== 'watch') ctx.addIssue({ code: 'custom', path: ['nodeKeys'], message: 'More than 20 breakpoints only for a trace window' });
    if (v.op === 'watch' && !v.autoContinue) ctx.addIssue({ code: 'custom', path: ['autoContinue'], message: 'watch requires automatic tracing; use start for manual stepping' });
    if (v.runtimeUrl) { const u = new URL(v.runtimeUrl); if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) ctx.addIssue({ code: 'custom', path: ['runtimeUrl'], message: 'HTTPS application URL without credentials, query or fragment required' }); }
  } else need('sessionId');
  if (v.o11Auth) {
    if (!['start', 'watch'].includes(v.op) || v.lane !== 'o11') ctx.addIssue({ code: 'custom', path: ['o11Auth'], message: 'o11Auth applies only to O11 start or watch' });
    if (v.credentials) ctx.addIssue({ code: 'custom', path: ['credentials'], message: 'Choose native SSO or legacy developer credentials' });
    if (v.runtimeUrl && v.module) {
      let url; try { url = new URL(v.runtimeUrl); } catch { }
      if (url?.port || ![ '/' + v.module, '/' + v.module + '/' ].includes(url?.pathname)) ctx.addIssue({ code: 'custom', path: ['runtimeUrl'], message: 'O11 native SSO currently requires entry app and target module to be the same on HTTPS port 443' });
    }
  }
  if (['variables', 'continue', 'step-over', 'step-into', 'step-out'].includes(v.op)) { need('threadId'); need('eventId'); }
  if (v.op === 'variables' && v.paths.length === 0) ctx.addIssue({ code: 'custom', path: ['paths'], message: 'Specify local variable paths' });
});
export function parseDebugCli(args) {
  const [op, ...rest] = args; const input = { op };
  const names = { '--lane': 'lane', '--session': 'sessionId', '--tenant': 'tenant', '--module': 'module', '--module-key': 'moduleKey', '--runtime-url': 'runtimeUrl', '--node-keys': 'nodeKeys', '--credentials': 'credentials', '--o11-auth': 'o11Auth', '--seconds': 'seconds', '--pause-seconds': 'pauseSeconds', '--paths': 'paths', '--frame': 'frame', '--depth': 'depth', '--thread-id': 'threadId', '--event-id': 'eventId' };
  for (let i = 0; i < rest.length; i++) {
    if (['--auto-continue', '--manual'].includes(rest[i])) {
      if ('autoContinue' in input) throw new Error('Choose either automatic capture or manual stepping');
      input.autoContinue = rest[i] === '--auto-continue'; continue;
    }
    const name = names[rest[i]], value = rest[++i];
    if (!name || value == null || value.startsWith('--') || name in input) throw new Error('Invalid debugger option');
    if (name === 'o11Auth') {
      try {
        if (fs.statSync(value).size > 16384) throw new Error();
        const bytes = fs.readFileSync(value); if (bytes.length > 16384) throw new Error();
        input[name] = o11AuthSchema.parse(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')));
      } catch { throw new Error('debug_o11_auth_file_invalid'); }
    } else input[name] = ['nodeKeys', 'paths'].includes(name) ? value.split(',') : ['seconds', 'pauseSeconds', 'frame', 'depth'].includes(name) ? Number(value) : value;
  }
  return debugSchema.parse(input);
}
export function registerDebugTools(server, execute, wrap) {
  server.registerTool('ssam_debug', {
    title: 'Debug O11 or ODC headlessly',
    description: DIAGNOSTICS_RULE + ' Headless SERVER debugger in a separate process; with legacy authentication neither Studio must be open. O11 native SSO requires the currently connected Service Studio of this SSAM lane. Start or watch opens an English native App User Sign In window for O11 and ODC with Username and masked Password. Enter app credentials only in this private window; they are bound to this app/runtime/producer/session, encrypted with Windows CurrentUser DPAPI, and erased on stop or expiry. ODC app login currently supports built-in Cognito in us-east-1. O11 captures credentials for the original Users.User_Login; connection alone does not authenticate an app request. This tool never invokes an action: running one with chosen inputs is ssam_debug_run with execution=native-entry (both lanes: the code picks the nearest public entry of the published app deterministically and publishes nothing; its REST wrapper path is legacy) or ssam_debug_invoke (an existing ODC entry). Developer/debugger authentication is separate: ODC requires tenant and private API Client; O11 native SSO uses optional o11Auth metadata {applicationKey, publishedVersionId, publishedProof:{path,sha256}} and a fresh published inventory (at most 15 minutes old) for the exact runtime host/module/application/version; CLI --o11-auth reads that metadata from a JSON file. Entry app and target module must currently be the same. The selected Studio PID and process start are pinned internally; the bearer never appears in tool arguments, files or responses and goes only to private worker stdin. Uncertain token exchange retains its operation receipt and target lock; inspect them instead of retrying. Without o11Auth, the explicit legacy path uses a private developer credentials file or SSAM_O11_* environment and has no native SSO publication binding. Never supply secrets in tool arguments. Start and watch require lane, published producer module/moduleKey, HTTPS runtimeUrl of the entry app, and required nodeKeys (start: 1-20 without trace, 1-200 with trace; watch: 1-200). watch enables automatic trace and waits for external use of the app; it never invokes an action. Its default trace is step, 200 node visits, depth 2 and fullValues=false; MCP may supply the existing trace object. watch is implemented and validated offline; a live watch proof is still pending. Once the visit budget is reached the worker only continues requests until stop or expiry. The direct debugger CLI has no trace flag. Obtain keys by inspecting the published snapshot. start/watch returns sessionId and safe appUser status; watch status also reports automaticInvocation=false and userRequestIsolationProved=false. A private app login does not establish the identity of an externally triggered request. Action keys, ccid and debugger UserName do not prove isolation from other users; request ownership is qualified only on offline synthetic fixtures and is refused in production and on ODC. status returns stack, frame, threadId and exact string eventId. variables reads specified local paths; continue/step consume that stop even on timeout: never retry uncertain execution. autoContinue defaults to true; watch requires true, while start permits false for manual stepping. Pauses expire after pauseSeconds (default 5), sessions after seconds (default 120, maximum 600). End with stop and confirm stopped. Existing Studio breakpoints are never changed. No model edits/publication. Values filtered; secrets and arbitrary text withheld. Connection success does not prove a breakpoint fired, request identity was applied, or a business action succeeded. Browser client-side debugging is outside this tool.',
    inputSchema: debugSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, wrap(execute));
}
