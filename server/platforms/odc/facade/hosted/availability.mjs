// One hosted-only projection for tools that have no hosted implementation.
export const LOCAL_PREVIEWS = new Set(['ssam_preview', 'studio_preview']);
const mentionsPreview = text => /\b(?:ssam_preview|studio_preview)\b/.test(text);

export function hostedDocumentation(value) {
  if (typeof value === 'string') return mentionsPreview(value) ? value.split(/(?<=[.!?])\s+|\n/).filter(sentence => !mentionsPreview(sentence)).join(' ') : value;
  if (Array.isArray(value)) return value.filter(item => {
    if (typeof item === 'string') return !mentionsPreview(item);
    return ![item?.tool, item?.name, item?.id].some(name => LOCAL_PREVIEWS.has(name))
      && !(item?.call?.tool && LOCAL_PREVIEWS.has(item.call.tool));
  }).map(hostedDocumentation);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !LOCAL_PREVIEWS.has(key)).map(([key, item]) => [key, hostedDocumentation(item)]));
}

export function withoutHostedPreview(result) {
  if (!result || typeof result !== 'object') return result;
  const out = { ...result };
  if (result.structuredContent) out.structuredContent = hostedDocumentation(result.structuredContent);
  if (Array.isArray(result.content)) out.content = result.content.map(item => {
    if (item?.type !== 'text') return item;
    try { return { ...item, text: JSON.stringify(hostedDocumentation(JSON.parse(item.text))) }; }
    catch { return { ...item, text: hostedDocumentation(item.text) }; }
  });
  return out;
}
