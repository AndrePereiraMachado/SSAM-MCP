// Deterministic control perturbation (docs/PROTOTIPO-NATIVO.md 2.6): a valid sentinel per control (from type,
// required, minlength/maxlength, min/max/step, pattern and the current value), one invalid value per constraint, and
// the search probes of a text dimension.
import { attr, textOf } from './ir.mjs';
import { ascii } from './names.mjs';

const TEXT_TYPES = new Set(['text', 'search', 'email', 'tel', 'url', 'password', 'textarea', '']);

function numberAttr(node, name) {
  const value = attr(node, name);
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function decimals(step) {
  const text = String(step);
  return text.includes('.') ? text.split('.')[1].length : 0;
}

function round(value, step) {
  const places = decimals(step ?? 1);
  return Number(value.toFixed(places));
}

export function controlInfo(node) {
  const type = node.t === 'input' ? String(attr(node, 'type') ?? 'text').toLowerCase() : node.t;
  const options = node.t === 'select' ? (node.c ?? []).flatMap(child => child.t === 'optgroup' ? child.c ?? [] : [child]).filter(child => child.t === 'option').map(option => ({ value: attr(option, 'value') ?? textOf(option), label: textOf(option) })) : null;
  const current = node.p ? (type === 'checkbox' || type === 'radio' ? Boolean(node.p.ck) : node.p.v) : node.t === 'textarea' ? textOf(node) : attr(node, 'value') ?? '';
  return {
    type, options, current,
    name: attr(node, 'name'), id: attr(node, 'id'),
    required: attr(node, 'required') != null,
    minlength: numberAttr(node, 'minlength'), maxlength: numberAttr(node, 'maxlength'),
    min: numberAttr(node, 'min'), max: numberAttr(node, 'max'),
    step: attr(node, 'step') === 'any' ? null : numberAttr(node, 'step'),
    pattern: attr(node, 'pattern')
  };
}

function fit(text, info) {
  let value = text;
  if (info.minlength != null && value.length < info.minlength) value = value + 'x'.repeat(info.minlength - value.length);
  if (info.maxlength != null && value.length > info.maxlength) value = value.slice(0, info.maxlength);
  return value;
}

// The valid sentinel of a control; in a pre-filled form it always differs from the current value.
export function sentinel(node, { clock } = {}) {
  const info = controlInfo(node);
  const label = info.name ?? info.id ?? 'field';
  switch (info.type) {
    case 'checkbox': return !info.current;
    case 'radio': return true;
    case 'select': {
      const values = info.options.map(option => option.value);
      const at = values.indexOf(String(info.current));
      const next = values.slice(at + 1).find(value => value !== '') ?? values.find(value => value !== '' && value !== String(info.current));
      return next ?? String(info.current);
    }
    case 'email': return fit('ssam@example.test', info);
    case 'number': case 'range': {
      const step = info.step ?? 1;
      const current = info.current === '' ? null : Number(info.current);
      if (current !== null && Number.isFinite(current)) {
        const up = round(current + step, step);
        if (info.max == null || up <= info.max) return String(up);
        const down = round(current - step, step);
        if (info.min == null || down >= info.min) return String(down);
      }
      if (info.min != null) return String(info.min);
      return String(current !== null && Number.isFinite(current) ? current + 1 : 1);
    }
    case 'date': return new Date(clock ?? Date.now()).toISOString().slice(0, 10);
    case 'time': return new Date(clock ?? Date.now()).toISOString().slice(11, 16);
    case 'datetime-local': return new Date(clock ?? Date.now()).toISOString().slice(0, 16);
    case 'url': return fit('https://example.test/ssam', info);
    case 'tel': return fit('5511999990000', info);
    default: {
      let value = fit('SSAM ' + label, info);
      if (value === info.current) value = fit('SSAM ' + label + ' 2', info);
      return value;
    }
  }
}

// One invalid value per constraint, the others valid: [{constraint, value, pred}].
export function invalidValues(node) {
  const info = controlInfo(node);
  const control = info.name ?? info.id;
  const out = [];
  const isText = TEXT_TYPES.has(info.type) || info.type === 'textarea';
  if (info.required && info.type !== 'checkbox') out.push({ constraint: 'required', value: '', pred: { op: 'ne', l: { control }, r: { lit: '' } } });
  if (isText && info.minlength != null && info.minlength > 0) out.push({ constraint: 'minlength', value: 'x'.repeat(info.minlength - 1), pred: { op: 'len-ge', l: { control }, r: { lit: info.minlength } } });
  if (isText && info.maxlength != null) out.push({ constraint: 'maxlength', value: 'x'.repeat(info.maxlength + 1), pred: { op: 'len-le', l: { control }, r: { lit: info.maxlength } } });
  if (info.type === 'number' || info.type === 'range') {
    const step = info.step ?? 1;
    if (info.min != null) out.push({ constraint: 'min', value: String(round(info.min - step, step)), pred: { op: 'ge', l: { control }, r: { lit: info.min } } });
    if (info.max != null) out.push({ constraint: 'max', value: String(round(info.max + step, step)), pred: { op: 'le', l: { control }, r: { lit: info.max } } });
  }
  return out;
}

// Search probes of a text dimension (2.6 item 4): per candidate text field, the first word (lower case, letters) of
// the first row that appears only in that field and selects a strict, non-empty subset of the rows; plus zzzz-ssam.
export function searchWords(rows, fields) {
  const norm = value => ascii(String(value ?? '')).toLowerCase();
  const words = text => norm(text).split(/[^a-z0-9]+/).filter(word => word.length >= 3 && /[a-z]/.test(word));
  const out = [];
  for (const field of fields) {
    const others = fields.filter(item => item !== field);
    let chosen = null;
    for (const row of rows) {
      for (const word of words(row[field])) {
        const inOthers = rows.some(other => others.some(name => norm(other[name]).includes(word)));
        if (inOthers) continue;
        const hits = rows.filter(other => norm(other[field]).includes(word)).length;
        if (hits > 0 && hits < rows.length) { chosen = word; break; }
      }
      if (chosen) break;
    }
    if (chosen) out.push({ field, word: chosen });
  }
  out.push({ field: null, word: 'zzzz-ssam' });
  return out;
}
