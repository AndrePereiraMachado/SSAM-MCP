// Child process of hosted-code-env-switch.test.mjs: the state a hosted server starts with under the SSAM_HOSTED_SSAM_CODE of
// this process's environment (read once, at the first read of the hosted catalog). One ssam_code call through the gate (a
// grammar: served, it runs on the server; off, the gate refuses it before anything runs) and the hosted paragraph and rules
// of a session. Prints one JSON line. A fake link and context: no hub, no agent, no Studio. Synthetic values only.
import './isolated-profile.mjs';
import os from 'node:os';
import { wrapHostedTool, hostedTools } from '../../hosted/policy.mjs';
import { codeServedHosted, codeSwitchState } from '../../hosted/served.mjs';
import { hostedInstructions } from '../../ssam.mjs';
import { fakeAgentLink, hostedDirs, cleanupHostedDirs } from './fake-agent-link.mjs';

const dirs = hostedDirs(os.tmpdir());
try {
  const link = fakeAgentLink({ agentRoot: dirs.agentRoot });
  const executor = { id: 'fake-executor', hosted: true, quota: { full: () => false }, o11Connection: () => ({ pid: 6001 }), async call() { return {}; } };
  const context = { id: 'ctx-env', hosted: true, tokenId: 'tok_env', customer: 'Env', lanes: ['odc', 'o11'], workspace: dirs.workspace, agent: link, executor, close: async () => {} };
  let ran = 0;
  const gated = wrapHostedTool('ssam_code', { inputSchema: {} }, async () => { ran++; return { content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true } }; },
    { context, link, lanes: context.lanes, run: (ctx, fn) => fn() });
  const answer = (await gated({ lane: 'odc', action: 'grammar', part: 'ddl' }, { requestId: 1 })).structuredContent ?? {};
  const instructions = hostedInstructions({ context: { agent: { info: () => ({ agentRoot: 'C:\\Users\\someone\\SSAM-agent' }) } } });
  process.stdout.write(JSON.stringify({ state: codeSwitchState(), served: codeServedHosted(), cls: hostedTools().ssam_code?.class ?? null,
    answer: { ok: answer.ok ?? null, code: answer.code ?? null, cause: answer.cause ?? null, continuation: answer.continuation ?? null, error: answer.error ?? null }, ran, instructions }) + '\n');
} finally { cleanupHostedDirs(); }
