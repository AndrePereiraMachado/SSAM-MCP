import * as z from 'zod/v4';
import { createPreviewManager } from './manager.mjs';
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.object({assets:z.array(z.object({url:z.string().url(),sha256:sha}).strict()).min(1).max(20)}).strict();
const page = z.object({tabId:z.string().min(1),origin:z.string().url(),revision:revision.optional()}).strict();
// The comparison and acceptance inputs (M06 of the proto line), given in one object `compare` and checked whole here before
// anything runs. The listed schema names that object only: its full structure in every listing costs ~3 KB of the hosted
// tool listing (its budget, context-budget-listing.test.mjs), and a malformed input is still refused before the browser is
// read (INPUT_INVALID with the path of each violation).
export const COMPARE_INPUT = z.object({
  reference: page.optional(), candidate: page.optional(),
  contract: z.object({schema:z.literal('ssam-migration-acceptance/1'),
    components:z.array(z.object({id:z.string().min(1),kind:z.string().min(1)}).strict()).min(1).max(500),
    cases:z.array(z.object({id:z.string().min(1),component:z.string().min(1),state:z.string().min(1)}).strict()).max(5000),
    revisions:z.object({reference:sha,candidate:sha}).strict()
  }).strict().optional(),
  evidence: z.array(z.object({scenario:z.string().min(1),receipt:z.object({file:z.string().min(1),sha256:sha}).strict(),
    transition:z.object({file:z.string().min(1),sha256:sha}).strict().optional()
  }).strict()).max(5000).optional(),
  scenario: z.string().min(1).max(200).optional(),
  selectors: z.array(z.object({key:z.string().regex(/^[\w-]{1,80}$/),selector:z.string().min(1).max(500),candidateSelector:z.string().min(1).max(500).optional(),
    count:z.number().int().min(0).max(1000).optional(),expected:z.object({reference:z.array(z.string()).max(1000).optional(),candidate:z.array(z.string()).max(1000).optional()}).strict().optional()
  }).strict()).min(1).max(40).optional(),
  relation: z.enum(['equivalent','pagination']).optional(),
  tolerance: z.number().min(0).max(10).optional(),
  rowKey: z.string().optional(),
  counterKey: z.string().optional(),
}).strict();
// The arguments the manager runs: compare's fields beside the others; every violation of compare, with its path.
export function previewArguments(args) {
  if (args?.compare === undefined) return { args };
  const parsed = COMPARE_INPUT.safeParse(args.compare);
  if (!parsed.success) return { violations: parsed.error.issues.map(issue => ({ path: '/' + ['compare', ...issue.path].join('/'), message: issue.message })) };
  const { compare: _compare, ...rest } = args;
  return { args: { ...rest, ...parsed.data } };
}
export function registerPreviewTools(server, { workspace, env, preview } = {}) {
  const run = preview ?? createPreviewManager({workspace, env});
  server.registerTool('ssam_preview', {
    title: 'Preview unpublished O11/ODC screens locally',
    description: 'Local preview (list/open/status/refresh/stop), migration acceptance; not studio_preview. compare: two open tabs of the verified browser preview by selectors (relation equivalent|pagination); revision manifests check loaded JS by SHA256, not the OML. accept: contract ssam-migration-acceptance/1, evidence by sha256; a missing state/evidence fails. Never navigates, clicks, reads cookies, writes data. Unknown target: list; the integrator installs profiles.',
    inputSchema: z.object({
      action:z.enum(['list','open','status','refresh','stop','compare','accept']).default('list'),
      // {reference, candidate: {tabId, origin, revision?}, scenario, selectors, relation, tolerance, rowKey, counterKey,
      // contract, evidence} of compare and accept: checked by previewArguments (COMPARE_INPUT), listed without a structure.
      compare:z.unknown().optional(),
      lane:z.enum(['o11','odc']).optional(),
      app:z.string().min(1).max(200).optional(),
      screen:z.string().min(1).max(200).optional(),
      tenant:z.string().min(1).max(253).optional(),
      profile:z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/).optional(),
      sessionId:z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/).optional()
    }).strict(),
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}
  }, async input=>{
    const { args, violations } = previewArguments(input);
    const value=violations?{ok:false,code:'INPUT_INVALID',error:'ssam_preview: '+violations.length+' violation(s) of compare; nothing was read',violations}:await run(args);
    return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value,...(value.ok===false?{isError:true}:{})};
  });
}
