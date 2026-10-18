// The Studio verdicts of ONE hosted tool call (A1 of the review of studio-build-identity, round 2,
// C:\t\revisoes\studio-build-id\REVISAO.md). The hub judges the Studio installed on disk (Hello, pong), which can lag
// behind the process that runs right after a Studio update, and forever when the pong that carries the change is lost.
// So the AgentExecutor judges, before every ODC Studio call, the process the call goes to (studio.processes {pid,
// version}, studio-identity.mjs) and records here what it found: a refusal (nothing was sent), a build served with a
// warning, and how many Studio calls passed. The gate (hosted/policy.mjs) opens the scope around the handler and puts
// the verdict in the answer. Outside a scope (warm-up, a relay callback) the executor still refuses; nothing is recorded.
import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();
// -> {scope, result}: scope.refused [identity], scope.warned [identity], scope.sent (Studio calls that passed and went out).
export async function withStudioScope(fn) {
  const scope = { refused: [], warned: [], sent: 0 };
  const result = await storage.run(scope, fn);
  return { scope, result };
}
export const studioScope = () => storage.getStore() ?? null;
