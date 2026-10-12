// Per-frame category applicability: not applicable to the runtime (or lane),
// empty in the frame-bound model, or not enumerated. categorizeScope lives in
// the client core because its private browser bundle admits one import.
import { categorizeScope } from './debug-native-client-inspection-core.mjs';
export { categorizeScope, odcSessionVariableEvidence } from './debug-native-client-inspection-core.mjs';

// Post-processes a scope result after nativeBoundScopeCoverage. Frame-bound
// metadataCoverage counts decide emptiness; without them a result already
// categorized by the client core is left as observed, and nothing else is
// claimed empty. Native category lists keep only truly not-enumerated entries.
export function withScopeCategories(result, lane, runtime) {
  if (result?.ok !== true || !Array.isArray(result.variables)) return result;
  const coverage = result.metadataCoverage?.runtimeFrameBound === true ? result.metadataCoverage : null;
  if (!coverage && Array.isArray(result.notApplicableToRuntime)) return result;
  const categorized = categorizeScope(lane, runtime, coverage, result.variables);
  return { ...result, ...categorized, unavailableCategories: categorized.notEnumerated,
    ...(Object.hasOwn(result, 'categoriesNotEnumerated') ? { categoriesNotEnumerated: categorized.notEnumerated } : {}) };
}
