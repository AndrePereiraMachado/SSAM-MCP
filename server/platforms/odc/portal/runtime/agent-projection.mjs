import { redact, redactValues } from './errors.mjs';
import { projectionContext, observeCredentials } from './projection-context.mjs';

// Remote projections redact only after their identity and paging validation.
export function trustedProjection(value, registry) {
  return redact(value, registry);
}

export async function projectForAgent(work, registry) {
  observeCredentials(registry);
  if (projectionContext.getStore()) return work();
  const scope = { registries: new Set(registry ? [registry] : []) };
  const value = await projectionContext.run(scope, work);
  return redactValues(value);
}
