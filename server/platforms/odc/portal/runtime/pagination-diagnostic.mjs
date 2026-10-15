export const PAGE_FIELDS = Object.freeze(['Limit', 'Offset', 'NextPageOffset', 'TotalPages', 'TotalResults']);
export function pageInteger(value) {
  return (typeof value === 'number' || typeof value === 'string' && /^-?\d+$/.test(value))
    && Number.isSafeInteger(Number(value)) ? Number(value) : null;
}
export function paginationDiagnostic(requested, received, invalidFields) {
  return {
    requested: { limit: pageInteger(requested?.limit), offset: pageInteger(requested?.offset) },
    received: Object.fromEntries(PAGE_FIELDS.map(key => [key, pageInteger(received?.[key])])),
    invalidFields: [...new Set(invalidFields)].filter(key => PAGE_FIELDS.includes(key)),
  };
}
