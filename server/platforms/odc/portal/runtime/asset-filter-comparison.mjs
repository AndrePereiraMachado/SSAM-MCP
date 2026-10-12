// Compare only metadata returned by the same response. This is not a substitute
// for the server filter, permission checks or completeness of the full inventory.
export function assetFilterComparison(operationId, input, output) {
  if (operationId !== 'asset-repository-api-v1:get:/assets' || !output.ok
      || typeof input.query?.['metadata.isDeployable'] !== 'boolean') return null;
  const expected = input.query['metadata.isDeployable'];
  const rows = output.data?.results;
  const mismatches = [];
  let compared = 0, unavailable = 0;
  if (Array.isArray(rows)) for (const row of rows) {
    const value = row?._embedded?.metadata?.isDeployable;
    if (typeof value !== 'boolean') { unavailable++; continue; }
    compared++;
    if (value !== expected) mismatches.push({ assetKey: row.assetKey ?? null, revision: row.revision ?? null, observed: value });
  }
  return { field: 'metadata.isDeployable', requested: expected,
    scope: 'returned-page-metadata', returned: Array.isArray(rows) ? rows.length : null,
    compared, unavailable, mismatches,
    consistent: mismatches.length ? false : Array.isArray(rows) && rows.length > 0 && !unavailable ? true : null,
    fullInventoryVerified: false, nativeResultsPreserved: true };
}
