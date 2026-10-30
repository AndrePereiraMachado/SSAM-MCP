// One hosted-only projection for tools that have no hosted implementation, and for tools served hosted only under
// conditions (fase4-28 r2-preview: ssam_render, hosted/screen-render.mjs) while those conditions do not hold. A hidden tool
// is never named: not in the listing, ssam_discover nor ssam_reference (a sentence that names it is dropped, an entry that
// is it is left out).
export const LOCAL_PREVIEWS = new Set(['ssam_preview', 'studio_preview']);
export const CONDITIONAL_TOOLS = new Set(['ssam_render']);
// Without a word on availability, a conditional tool is taken as unavailable (hidden).
export const hiddenTools = (available = []) => new Set([...LOCAL_PREVIEWS, ...[...CONDITIONAL_TOOLS].filter(name => !available.includes(name))]);
const DEFAULT_HIDDEN = hiddenTools();
const patterns = new Map();
const mentionOf = hidden => {
  const key = [...hidden].sort().join('|');
  if (!patterns.has(key)) { const re = new RegExp('\\b(?:' + key + ')\\b'); patterns.set(key, text => re.test(text)); }
  return patterns.get(key);
};

export function hostedDocumentation(value, hidden = DEFAULT_HIDDEN) {
  if (!hidden.size) return value;
  const mentions = mentionOf(hidden);
  if (typeof value === 'string') return mentions(value) ? value.split(/(?<=[.!?])\s+|\n/).filter(sentence => !mentions(sentence)).join(' ') : value;
  if (Array.isArray(value)) return value.filter(item => {
    if (typeof item === 'string') return !mentions(item);
    return ![item?.tool, item?.name, item?.id].some(name => hidden.has(name))
      && !(item?.call?.tool && hidden.has(item.call.tool));
  }).map(item => hostedDocumentation(item, hidden));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !hidden.has(key)).map(([key, item]) => [key, hostedDocumentation(item, hidden)]));
}

// Text items are projected; any other item (an image of ssam_render) passes as it is.
export function withoutHostedPreview(result, hidden = DEFAULT_HIDDEN) {
  if (!result || typeof result !== 'object') return result;
  const out = { ...result };
  if (result.structuredContent) out.structuredContent = hostedDocumentation(result.structuredContent, hidden);
  if (Array.isArray(result.content)) out.content = result.content.map(item => {
    if (item?.type !== 'text') return item;
    try { return { ...item, text: JSON.stringify(hostedDocumentation(JSON.parse(item.text), hidden)) }; }
    catch { return { ...item, text: hostedDocumentation(item.text, hidden) }; }
  });
  return out;
}
