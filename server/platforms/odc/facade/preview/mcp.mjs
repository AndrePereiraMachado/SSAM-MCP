import * as z from 'zod/v4';
import { createPreviewManager } from './manager.mjs';
export function registerPreviewTools(server, { workspace, env, preview } = {}) {
  const run = preview ?? createPreviewManager({workspace, env});
  server.registerTool('ssam_preview', {
    title: 'Preview unpublished O11/ODC screens locally',
    description: 'Experimental visual preview, distinct from studio_preview (native merge analysis). list shows prepared profiles and limits; open starts or reuses an isolated local session and returns browser.url to open visibly; status separates source/build from observed rendering; refresh asks the configured watcher to capture again, or rereads the artifact feed of a static profile; stop gracefully stops only this managed session. No publishing, backend writes, real roles, browser cloning or headless browser. O11 renders natively; ODC currently uses an O11-adapted renderer, not general ODC runtime equivalence. Only registered profiles/screens are supported. Never claim live updates when automaticWatching=false. Unknown target: inspect list; profile installation belongs to the integrator, not a shell workaround in an app session.',
    inputSchema: z.object({
      action:z.enum(['list','open','status','refresh','stop']).default('list'),
      lane:z.enum(['o11','odc']).optional(),
      app:z.string().min(1).max(200).optional(),
      screen:z.string().min(1).max(200).optional(),
      tenant:z.string().min(1).max(253).optional(),
      profile:z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/).optional(),
      sessionId:z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/).optional()
    }).strict(),
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}
  }, async args=>{
    const value=await run(args);
    return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value,...(value.ok===false?{isError:true}:{})};
  });
}
