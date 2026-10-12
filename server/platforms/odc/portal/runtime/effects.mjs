// Effect of each public operation, beyond the method-derived readOnly flag of the catalog. The six POST searches are
// the only non-GET operations odc_read may send; the list is exact IDs, never a pattern, so a regenerated catalog
// cannot open a mutation through the read tool.
export const SEARCH_POSTS = Object.freeze(new Set([
  'asset-repository-api-v1:post:/assets/search',
  'dependency-management-api-v1:post:/public-elements/search',
  'environment-configurations-api-v1:post:/environments/{environmentKey}/builtin-domains/availability',
  'organization-api-v1:post:/builtin-domains/availability',
  'native-application-orchestration-service-api-v1:post:/build-operations/version-suggestions',
  'native-application-orchestration-service-api-v1:post:/build-operations/native-build-validation',
]));
// POSTs that start a job without changing the tenant's assets or configuration.
const JOBS = new Set([
  'build-operations-api-v1:post:/build-operations/{operationKey}/generated-code',
  'code-quality-api-v1:post:/code-analyses',
  'dependency-management-api-v1:post:/deletion-analyses',
  'dependency-management-api-v1:post:/deployment-analyses',
  'external-library-generation-api-v1:post:/assets/{assetKey}/revisions/{revision}/source-code-download',
]);
const MUTATION_JOBS = new Set([
  'user-access-management-api-v1:post:/users/bulk',
  'deployments-api-v1:post:/deployment-operations',
  'deployments-api-v1:post:/publish-operations',
  'build-operations-api-v1:post:/build-operations',
  'native-application-orchestration-service-api-v1:post:/build-operations',
  'external-library-generation-api-v1:post:/generation-operations',
]);
export const DEPLOY = 'deployments-api-v1:post:/deployment-operations';

// read | search-post | job | mutation-job | mutation | destructive. A deployment whose body says Undeploy removes an
// app from a stage, so it is destructive like a DELETE.
export function effectOf(operation, body) {
  if (SEARCH_POSTS.has(operation.id)) return 'search-post';
  if (operation.readOnly) return 'read';
  if (operation.method === 'DELETE') return 'destructive';
  if (operation.id === DEPLOY && body?.operation === 'Undeploy') return 'destructive';
  if (JOBS.has(operation.id)) return 'job';
  if (MUTATION_JOBS.has(operation.id)) return 'mutation-job';
  return 'mutation';
}
export const readable = operation => operation.readOnly || SEARCH_POSTS.has(operation.id);

// The read that follows each job to a terminal state. key: field of the POST answer that names the operation.
export const OPERATION_STATUS = Object.freeze({
  'bulk-users': { start: 'user-access-management-api-v1:post:/users/bulk', read: 'user-access-management-api-v1:get:/users/bulk/{key}',
    param: 'key', key: 'key', field: 'status', terminal: ['Finished', 'FinishedWithErrors'], failed: ['FinishedWithErrors'] },
  deployment: { start: DEPLOY, read: 'deployments-api-v1:get:/deployment-operations/{operationKey}',
    messages: 'deployments-api-v1:get:/deployment-operations/{operationKey}/messages', param: 'operationKey', key: 'key',
    field: 'status', terminal: ['Finished', 'FinishedWithError'], failed: ['FinishedWithError'] },
  publish: { start: 'deployments-api-v1:post:/publish-operations', read: 'deployments-api-v1:get:/publish-operations/{operationKey}',
    messages: 'deployments-api-v1:get:/publish-operations/{operationKey}/messages', param: 'operationKey', key: 'key',
    field: 'status', terminal: ['Finished', 'FinishedWithError'], failed: ['FinishedWithError'] },
  build: { start: 'build-operations-api-v1:post:/build-operations', read: 'build-operations-api-v1:get:/build-operations/{operationKey}',
    messages: 'build-operations-api-v1:get:/build-operations/{operationKey}/log-messages', param: 'operationKey', key: 'buildKey',
    field: 'status', terminal: ['Finished', 'FinishedWithErrors', 'Deleted', 'ToBeDeleted'], failed: ['FinishedWithErrors'] },
  'native-build': { start: 'native-application-orchestration-service-api-v1:post:/build-operations',
    read: 'native-application-orchestration-service-api-v1:get:/build-operations/{operationKey}',
    messages: 'native-application-orchestration-service-api-v1:get:/build-operations/{operationKey}/log-messages', param: 'operationKey', key: 'key',
    field: 'status', terminal: ['Finished', 'Error'], failed: ['Error'] },
  generation: { start: 'external-library-generation-api-v1:post:/generation-operations',
    read: 'external-library-generation-api-v1:get:/generation-operations/{operationKey}',
    // The POST answers {operationKey} (CreationOperationResponse of the pinned contract), not {key}.
    messages: 'external-library-generation-api-v1:get:/generation-operations/{operationKey}/log-messages', param: 'operationKey', key: 'operationKey',
    field: 'status', terminal: ['GenerationError', 'ReadyForReview', 'DownloadError', 'Completed'], failed: ['GenerationError', 'DownloadError'] },
  'code-analysis': { start: 'code-quality-api-v1:post:/code-analyses', read: 'code-quality-api-v1:get:/code-analyses/{analysisKey}',
    param: 'analysisKey', key: 'analysisKey', field: 'status', terminal: ['Completed', 'Finished', 'Failed', 'Error'], failed: ['Failed', 'Error'] },
  'deletion-analysis': { start: 'dependency-management-api-v1:post:/deletion-analyses', read: 'dependency-management-api-v1:get:/deletion-analyses/{analysisKey}',
    param: 'analysisKey', key: 'analysisKey', field: 'processStatus', terminal: ['Finished', 'Failed'], failed: ['Failed'] },
  'deployment-analysis': { start: 'dependency-management-api-v1:post:/deployment-analyses', read: 'dependency-management-api-v1:get:/deployment-analyses/{analysisKey}',
    param: 'analysisKey', key: 'analysisKey', field: 'processStatus', terminal: ['Finished', 'Failed'], failed: ['Failed'] },
});

// Destructive operations whose target has a readable name: the user's words must name it (or carry its key).
export const TARGET_NAMES = Object.freeze({
  'asset-repository-api-v1:delete:/assets/{assetKey}': { read: 'asset-repository-api-v1:get:/assets/{assetKey}', fields: ['name'] },
  'user-access-management-api-v1:delete:/users/{key}': { read: 'user-access-management-api-v1:get:/users/{key}', fields: ['name', 'email'] },
  'user-access-management-api-v1:delete:/groups/{key}': { read: 'user-access-management-api-v1:get:/groups/{key}', fields: ['name'] },
  'user-access-management-api-v1:delete:/organization-roles/{key}': { read: 'user-access-management-api-v1:get:/organization-roles/{key}', fields: ['name'] },
  'environment-configurations-api-v1:delete:/environments/{environmentKey}/domains/{domainKey}': { read: 'environment-configurations-api-v1:get:/environments/{environmentKey}/domains/{domainKey}', fields: ['name', 'hostname'] },
  'environment-configurations-api-v1:delete:/environments/{environmentKey}/ip-filter-groups/{ipFilterGroupKey}': { read: 'environment-configurations-api-v1:get:/environments/{environmentKey}/ip-filter-groups/{ipFilterGroupKey}', fields: ['name'] },
  // A pending External Library job (odc_external_library discard): the words name its library (or the uploaded file).
  'external-library-generation-api-v1:delete:/generation-operations/{operationKey}': { read: 'external-library-generation-api-v1:get:/generation-operations/{operationKey}', fields: ['libraryName', 'filename'] },
});
