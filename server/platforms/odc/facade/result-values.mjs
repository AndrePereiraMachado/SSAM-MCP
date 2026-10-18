// The `result` values of a delivery, a publication, a closed task and an environment action. They are protocol values
// (callers compare them), English since 15/10/2026 (owner rule: every text SSAM emits is English). The Portuguese values
// the releases before answered ("entregue", "entregue e publicado", "publicado", "fechada", "feito", "nada a atualizar")
// are declared aliases: wherever a result is read back (a task record written by an older release, a reconciled answer)
// resultIs accepts them; no answer serves them again.
export const RESULT = Object.freeze({
  delivered: 'delivered',
  deliveredAndPublished: 'delivered and published',
  published: 'published',
  closed: 'closed',
  done: 'done',
  nothingToUpdate: 'nothing to update',
});
export const RESULT_ALIASES = Object.freeze({
  'entregue': RESULT.delivered,
  'entregue e publicado': RESULT.deliveredAndPublished,
  'publicado': RESULT.published,
  'fechada': RESULT.closed,
  'feito': RESULT.done,
  'nada a atualizar': RESULT.nothingToUpdate,
});
// The English value of a result, the old Portuguese one mapped to it; anything else unchanged.
export const resultValue = value => (typeof value === 'string' && Object.hasOwn(RESULT_ALIASES, value) ? RESULT_ALIASES[value] : value);
// Whether a result (English or its Portuguese alias) is one of the named values: resultIs(v, 'delivered', 'deliveredAndPublished').
export const resultIs = (value, ...names) => names.some(name => resultValue(value) === RESULT[name]);
