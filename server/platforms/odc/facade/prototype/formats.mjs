// The closed format table (docs/PROTOTIPO-NATIVO.md 2.8). Each row has one OutSystems expression (compile lane);
// here each row only formats and explains: slot(item) = prefix + T(value) + suffix with prefix/suffix constant over the
// items. A new transformation enters only as a row of this table, with a test.
const CURRENCY_BY_REGION = { BR: 'BRL', US: 'USD', GB: 'GBP', PT: 'EUR', ES: 'EUR', FR: 'EUR', DE: 'EUR', IT: 'EUR', NL: 'EUR', IE: 'EUR', MX: 'MXN', AR: 'ARS', CL: 'CLP', CO: 'COP', CA: 'CAD', AU: 'AUD', JP: 'JPY', IN: 'INR', CH: 'CHF' };

export const DATE_OPTIONS = Object.freeze([
  { day: '2-digit', month: 'short', year: 'numeric' },
  { day: '2-digit', month: '2-digit', year: 'numeric' },
  { day: 'numeric', month: 'long', year: 'numeric' },
  { day: 'numeric', month: 'short', year: 'numeric' },
  { day: '2-digit', month: 'short' },
  { dateStyle: 'short' }, { dateStyle: 'medium' }, { dateStyle: 'long' }
]);

function currencyCodes(locale) {
  const region = String(locale).split('-')[1]?.toUpperCase();
  const first = CURRENCY_BY_REGION[region];
  return [...new Set([first, 'BRL', 'USD', 'EUR', 'GBP'].filter(Boolean))];
}

function isoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const FORMATTERS = new Map();
function formatter(kind, locale, options) {
  const key = kind + '|' + locale + '|' + JSON.stringify(options);
  if (!FORMATTERS.has(key)) FORMATTERS.set(key, kind === 'number' ? new Intl.NumberFormat(locale, options) : new Intl.DateTimeFormat(locale, options));
  return FORMATTERS.get(key);
}

// fmt -> text, or undefined when the row does not apply to the value.
export function formatValue(fmt, value, { tz = 'UTC' } = {}) {
  const [kind, ...rest] = String(fmt).split(':');
  const number = typeof value === 'number' ? value : null;
  switch (kind) {
    case 'text': return value === null || value === undefined ? '' : typeof value === 'object' ? undefined : String(value);
    case 'integer': return Number.isInteger(number) ? String(number) : undefined;
    case 'decimal': {
      if (number === null) return undefined;
      const [digits, locale] = [Number(rest[0]), rest.slice(1).join(':')];
      return formatter('number', locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(number);
    }
    case 'currency': {
      if (number === null) return undefined;
      const [locale, code] = [rest[0], rest[1]];
      return formatter('number', locale, { style: 'currency', currency: code }).format(number);
    }
    case 'date': {
      const date = isoDate(value);
      if (!date) return undefined;
      const locale = rest[0];
      const options = JSON.parse(rest.slice(1).join(':'));
      return formatter('date', locale, { ...options, timeZone: tz }).format(date);
    }
    case 'time': {
      const date = isoDate(value);
      if (!date) return undefined;
      return formatter('date', rest[0], { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(date);
    }
    case 'pad': {
      if (!Number.isInteger(number)) return undefined;
      return String(number).padStart(Number(rest[0]), rest.slice(1).join(':') || '0');
    }
    case 'substr-after': {
      if (typeof value !== 'string') return undefined;
      const sep = rest.join(':');
      const index = value.indexOf(sep);
      return index < 0 ? undefined : value.slice(index + sep.length);
    }
    case 'substr-before': {
      if (typeof value !== 'string') return undefined;
      const sep = rest.join(':');
      const index = value.indexOf(sep);
      return index < 0 ? undefined : value.slice(0, index);
    }
    default: return undefined;
  }
}

// Candidate formats for a value, in table order.
export function candidateFormats(value, { locale = 'en-US', slot = '' } = {}) {
  const out = [];
  if (typeof value === 'string') {
    out.push('text');
    if (isoDate(value)) {
      for (const options of DATE_OPTIONS) out.push('date:' + locale + ':' + JSON.stringify(options));
      out.push('time:' + locale);
    }
  } else if (typeof value === 'number') {
    if (Number.isInteger(value)) out.push('integer');
    out.push('currency:' + locale + ':' + currencyCodes(locale)[0]);
    for (const code of currencyCodes(locale).slice(1)) out.push('currency:' + locale + ':' + code);
    for (const digits of [2, 1, 0, 3]) out.push('decimal:' + digits + ':' + locale);
    if (Number.isInteger(value)) for (const n of [3, 4, 5, 6, 2]) out.push('pad:' + n + ':0');
    out.push('text');
  } else if (typeof value === 'boolean') {
    out.push('text');
  }
  return out;
}

// Every (prefix, suffix) with slot = prefix + core + suffix.
function splits(slot, core) {
  const out = [];
  if (core === '') return out;
  let index = slot.indexOf(core);
  while (index >= 0) { out.push([slot.slice(0, index), slot.slice(index + core.length)]); index = slot.indexOf(core, index + 1); }
  return out;
}

// The core of a slot sits on word boundaries: the prefix ends and the suffix starts with a non-alphanumeric character
// (or is empty), unless the core itself starts/ends with one. "Adicion|a|r" is never an explanation.
const ALNUM = /[\p{L}\p{N}]/u;
function bounded(prefix, core, suffix) {
  if (!core) return false;
  const before = prefix.slice(-1), after = suffix.slice(0, 1);
  const okBefore = !before || !ALNUM.test(before) || !ALNUM.test(core[0]);
  const okAfter = !after || !ALNUM.test(after) || !ALNUM.test(core[core.length - 1]);
  return okBefore && okAfter;
}

// A format explains a group when every slot is prefix + T(value) + suffix with the same prefix and suffix.
export function explainGroup(slots, values, { locale = 'en-US', tz = 'UTC', formats = null } = {}) {
  if (!slots.length || slots.length !== values.length) return null;
  const list = formats ?? candidateFormats(values.find(value => value !== null && value !== undefined), { locale, slot: slots[0] });
  for (const fmt of list) {
    const cores = values.map(value => formatValue(fmt, value, { tz }));
    if (cores.some(core => core === undefined || core === '')) continue;
    let options = splits(slots[0], cores[0]).filter(([prefix, suffix]) => bounded(prefix, cores[0], suffix));
    for (let i = 1; i < slots.length && options.length; i++) options = options.filter(([prefix, suffix]) => slots[i] === prefix + cores[i] + suffix);
    if (options.length) {
      // Prefer the longest prefix (the core sits as late as possible) for determinism.
      const [prefix, suffix] = options.sort((a, b) => b[0].length - a[0].length)[0];
      return { fmt, prefix, suffix };
    }
  }
  return null;
}

// substr-after / substr-before separators (2.8): the separator appears in every correlated row (>= 2 rows), starts with
// a structural character (#?&/|;:,@= for after; any non-alphanumeric for before) and the cores vary between rows.
export function substrFormats(slots, values) {
  if (values.length < 2 || !values.every(value => typeof value === 'string')) return [];
  const out = [];
  const preceding = [];
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    let found = null;
    for (let start = 1; start < value.length; start++) {
      const core = value.slice(start);
      if (slots[i].endsWith(core) || slots[i].includes(core)) { found = value.slice(0, start); break; }
    }
    if (found === null) { preceding.length = 0; break; }
    preceding.push(found);
  }
  if (preceding.length === values.length) {
    let common = preceding[0];
    for (const text of preceding) { while (common && !text.endsWith(common)) common = common.slice(1); }
    let cut = -1;
    for (let i = common.length - 1; i >= 0; i--) if ('#?&/|;:,@'.includes(common[i])) { cut = i; break; }
    if (cut >= 0) {
      const sep = common.slice(cut);
      const cores = values.map(value => value.slice(value.indexOf(sep) + sep.length));
      if (values.every(value => value.indexOf(sep) >= 0) && new Set(cores).size > 1) out.push('substr-after:' + sep);
    }
  }
  const following = [];
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    let found = null;
    for (let end = value.length - 1; end > 0; end--) {
      const core = value.slice(0, end);
      if (slots[i].includes(core)) { found = value.slice(end); break; }
    }
    if (found === null) { following.length = 0; break; }
    following.push(found);
  }
  if (following.length === values.length) {
    let common = following[0];
    for (const text of following) { while (common && !text.startsWith(common)) common = common.slice(0, -1); }
    let end = 0;
    while (end < common.length && !/[A-Za-z0-9]/.test(common[end])) end++;
    if (end > 0) {
      const sep = common.slice(0, end);
      const cores = values.map(value => value.slice(0, value.indexOf(sep)));
      if (values.every(value => value.indexOf(sep) > 0) && new Set(cores).size > 1) out.push('substr-before:' + sep);
    }
  }
  return out;
}

// A text of two or three fields with the same literals around them in every item ("{Bairro}, {Cidade} · {Tipo}"): each
// field in a format of the table, on word boundaries, the literals taken from the first item and checked on every other.
// columns: [{values}] (one value per item; a column that is constant or empty somewhere takes no part).
// -> {parts: [{column, fmt, prefix, suffix}]} (prefix: the literal before the part; suffix: only the trailing literal of
// the last part) | null. The most explained wins (the least literal text), then the fewest parts, then the column order.
export function explainConcat(texts, columns, { locale = 'en-US', tz = 'UTC', maxParts = 3 } = {}) {
  if (texts.length < 2 || new Set(texts).size < 2 || texts.some(text => typeof text !== 'string')) return null;
  const first = texts[0];
  const hits = [];
  columns.forEach((column, index) => {
    const values = column.values;
    if (values.length !== texts.length || values.some(value => value === null || value === undefined || value === '' || typeof value === 'boolean' || typeof value === 'object')) return;
    if (new Set(values.map(String)).size < 2) return;
    for (const fmt of candidateFormats(values[0], { locale, slot: first })) {
      const cores = values.map(value => formatValue(fmt, value, { tz }));
      if (cores.some(core => core === undefined || core === '')) continue;
      for (let at = first.indexOf(cores[0]); at >= 0; at = first.indexOf(cores[0], at + 1))
        if (bounded(first.slice(0, at), cores[0], first.slice(at + cores[0].length))) hits.push({ column: index, fmt, cores, start: at, end: at + cores[0].length });
    }
  });
  if (hits.length < 2 || hits.length > 32) return null;
  hits.sort((a, b) => (a.start - b.start) || (a.end - b.end) || (a.column - b.column));
  const found = [];
  const check = combo => {
    const literals = [first.slice(0, combo[0].start)];
    for (let i = 1; i < combo.length; i++) literals.push(first.slice(combo[i - 1].end, combo[i].start));
    literals.push(first.slice(combo[combo.length - 1].end));
    for (let row = 1; row < texts.length; row++) {
      let text = literals[0];
      for (let i = 0; i < combo.length; i++) text += combo[i].cores[row] + literals[i + 1];
      if (text !== texts[row]) return null;
    }
    return literals;
  };
  const extend = (combo, from) => {
    if (combo.length >= 2) { const literals = check(combo); if (literals) found.push({ combo: [...combo], literals }); }
    if (combo.length === maxParts) return;
    for (let i = from; i < hits.length; i++) {
      const hit = hits[i];
      if (combo.length && hit.start < combo[combo.length - 1].end) continue;
      if (combo.some(item => item.column === hit.column)) continue;
      combo.push(hit); extend(combo, i + 1); combo.pop();
    }
  };
  extend([], 0);
  if (!found.length) return null;
  const literal = item => item.literals.join('').length;
  found.sort((a, b) => (literal(a) - literal(b)) || (a.combo.length - b.combo.length));
  const best = found[0];
  return { parts: best.combo.map((hit, i) => ({ column: hit.column, fmt: hit.fmt, prefix: best.literals[i], suffix: i === best.combo.length - 1 ? best.literals[i + 1] : '' })) };
}

// A count with its noun in the singular for 1 and in the plural otherwise ("1 vaga" / "2 vagas"): an integer column whose
// items split in two literal templates, one exactly the items where it is 1. -> {column, one: {prefix, suffix}, other:
// {prefix, suffix}} | null (the first column in order).
export function explainCount(texts, columns) {
  if (texts.length < 2 || new Set(texts).size < 2) return null;
  for (const [index, column] of columns.entries()) {
    const values = column.values;
    if (values.length !== texts.length || !values.every(value => Number.isInteger(value)) || new Set(values).size < 2) continue;
    const templates = [];
    for (let row = 0; row < texts.length; row++) {
      const core = String(values[row]);
      const options = splits(texts[row], core).filter(([prefix, suffix]) => bounded(prefix, core, suffix)).sort((a, b) => b[0].length - a[0].length);
      if (!options.length) break;
      templates.push(options[0]);
    }
    if (templates.length !== texts.length) continue;
    const key = ([prefix, suffix]) => prefix + '\u0000' + suffix;
    const ones = templates.filter((_, row) => values[row] === 1), others = templates.filter((_, row) => values[row] !== 1);
    if (!ones.length || !others.length || new Set(ones.map(key)).size !== 1 || new Set(others.map(key)).size !== 1 || key(ones[0]) === key(others[0])) continue;
    return { column: index, one: { prefix: ones[0][0], suffix: ones[0][1] }, other: { prefix: others[0][0], suffix: others[0][1] } };
  }
  return null;
}

// Explains slots by a field value: the table rows, then substr-after/substr-before.
export function explainSlots(slots, values, options = {}) {
  const direct = explainGroup(slots, values, options);
  if (direct) return direct;
  const extra = substrFormats(slots, values);
  if (extra.length) return explainGroup(slots, values, { ...options, formats: extra });
  return null;
}
