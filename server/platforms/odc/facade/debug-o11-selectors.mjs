// Native synthetic action keys observed in the O11 model. Keep the suffixes
// explicit: accepting arbitrary ObjectKey-looking suffixes invents capabilities.
const NAME = '[A-Za-z_][A-Za-z0-9_]{0,120}';
const KEY = '[A-Za-z0-9_+]{22}(?:\\.#(?:Preparation|LaunchProcess))?';
const ELEMENT = new RegExp('^' + KEY + '$');
const ACTION = new RegExp('^(?:(' + NAME + ')\\.)?(@?' + KEY + '|' + NAME + ')$');
const GLOBAL = new RegExp('^[A-Za-z0-9_+]{22}\\*' + KEY + '$');

export function parseO11ActionSelector(value) {
  if (typeof value !== 'string') return null;
  const match = ACTION.exec(value);
  if (!match) return null;
  const token = match[2], key = token.replace(/^@/, '');
  return { module: match[1] ?? null, name: token, key: ELEMENT.test(key) ? key : null,
    explicitKey: token.startsWith('@') || key.includes('.#') };
}
export const isO11ActionSelector = value => parseO11ActionSelector(value) !== null;
export const isO11EntrySelector = value => typeof value === 'string' && value.length > 0 && value.length <= 300 &&
  (!value.includes('#') || isO11ActionSelector(value) || GLOBAL.test(value));
export function o11SelectorMatches(node, selector) {
  const parsed = parseO11ActionSelector(selector);
  if (!parsed || parsed.module && node.module !== parsed.module) return false;
  return parsed.key && node.key === parsed.key || !parsed.explicitKey && node.name === parsed.name;
}
