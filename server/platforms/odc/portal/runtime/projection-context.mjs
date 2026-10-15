import { registerCredentials } from './credential-registry.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';

// Nested calls share a boundary; credential values are retained for the process.
export const projectionContext = new AsyncLocalStorage();
export function observeCredentials(registry) {
  registerCredentials(registry);
  if (registry) projectionContext.getStore()?.registries.add(registry);
}
