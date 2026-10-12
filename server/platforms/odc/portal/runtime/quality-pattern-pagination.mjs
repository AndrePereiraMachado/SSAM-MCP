import { fail } from './errors.mjs';

export const QUALITY_PATTERNS = 'code-quality-api-v1:get:/patterns';
export const ENVIRONMENT_DOMAINS = 'environment-configurations-api-v1:get:/environments/{environmentKey}/domains';
const MAX_ROWS = 1000;
const contracts = {
  [QUALITY_PATTERNS]: { limitKey: 'Limit', offsetKey: 'Offset', source: 'verified-complete-pattern-catalog', semantics: 'page-number' },
  [ENVIRONMENT_DOMAINS]: { limitKey: 'limit', offsetKey: 'offset', source: 'verified-complete-domain-catalog', semantics: 'ignored' },
};

// Both endpoints contradict their public record-offset contracts. Paginate only
// after a single bounded response proves that the complete catalog is present.
export async function readCatalogPage(operationId, input, send) {
  const contract = contracts[operationId];
  if (!contract) return send(input);
  const { limitKey, offsetKey, source, semantics } = contract;
  const limit = input.query?.[limitKey];
  if (limit === undefined) return send(input);
  const offset = input.query?.[offsetKey] ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(offset) || offset < 0)
    fail('INPUT_INVALID', 'Catalog pagination requires a positive integer limit and nonnegative integer offset.');
  const output = await send({ ...input, query: { ...input.query, [limitKey]: MAX_ROWS, [offsetKey]: 0 } });
  if (!output.ok) return output;
  const { results, page } = output.data ?? {};
  const ids = Array.isArray(results) ? results.map(row => row?.id) : [];
  if (!Array.isArray(results) || !page || !Number.isSafeInteger(page.totalResults)
      || page.totalResults < 0 || page.totalResults > MAX_ROWS
      || page.offset !== 0 || page.count !== results.length || page.totalResults !== results.length
      || (page.totalPages !== undefined && page.totalPages !== (results.length ? 1 : 0))
      || ids.some(id => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== ids.length) {
    fail('PUBLIC_PAGINATION_UNVERIFIED', 'The bounded catalog did not prove completeness and unique identities; no partial page returned.');
  }
  const rows = results.slice(offset, offset + limit);
  return { ...output, data: { ...output.data, results: rows, page: { ...page,
    count: rows.length, limit, offset,
    nextPageOffset: offset + rows.length < results.length ? offset + rows.length : null,
    totalPages: Math.ceil(results.length / limit) } },
    pagination: { source, nativeOffsetSemantics: semantics, sourceCount: results.length, sourceLimit: MAX_ROWS } };
}
export const readQualityPatternPage = (input, send) => readCatalogPage(QUALITY_PATTERNS, input, send);
