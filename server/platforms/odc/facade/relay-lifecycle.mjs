// ODC facade and unified server share a process, connected through InMemoryTransport.
// A private per-request correlation keeps the lifetime of real work separate from
// the SDK request's cancellation/timeout. Nothing here is persisted or listed as a tool.
import { randomUUID } from 'node:crypto';

const META = 'ssam/relay-work';
const MANAGED = Symbol('ssam.relayWork');
const works = new Map();
const configured = new WeakSet();

export const managedRelayContext = ctx => ctx?.[MANAGED] === true;

export function configureRelayFacade(server) {
  if (configured.has(server)) return;
  configured.add(server);
  for (const tool of Object.values(server._registeredTools ?? {})) {
    const handler = tool.handler;
    tool.update({ callback: (...params) => {
      const ctx = params.at(-1);
      const work = works.get(ctx?.mcpReq?._meta?.[META]);
      if (!work) return handler(...params);
      const context = { ...ctx, signal: work.signal, [MANAGED]: true,
        mcpReq: { ...ctx.mcpReq, signal: work.signal } };
      // This promise resolves only when the handler/facade wrapper actually finishes.
      work.promise = Promise.resolve().then(() => handler(...params.slice(0, -1), context));
      work.promise.catch(() => {});
      return work.promise;
    } });
  }
}

export async function relayWork(client, params, ctx, options, { write = false } = {}) {
  if (!write) return client.callTool(params, options);
  const token = randomUUID();
  const work = { signal: ctx?.mcpReq?.signal, promise: null };
  works.set(token, work);
  // Cancellation of an SDK wait must never be mistaken for the end of facade work.
  // Explicit stop still reaches the handler through the owned work signal above.
  const { signal: _waitSignal, ...waitOptions } = options ?? {};
  try {
    try { return await client.callTool({ ...params, _meta: { ...params._meta, [META]: token } }, waitOptions); }
    catch (error) {
      // A transport timeout after dispatch does not shorten real work's lifetime.
      if (work.promise) return await work.promise;
      throw error;
    }
  } finally { works.delete(token); }
}
