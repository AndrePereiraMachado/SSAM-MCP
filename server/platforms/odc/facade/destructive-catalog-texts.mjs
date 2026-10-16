// CX15 r3 (CT-8): the two-call texts of the destructive routes of catalog/tools.json are GENERATED when the catalog is
// loaded, from the texts of destructive-operations.mjs (one source; none is copied by hand into the JSON). The JSON holds a
// marker where the text goes ({{destructive.twoCalls}}, or {{destructive.twoCalls.odc}} for an ODC route, whose execution
// also takes the preview's operationId as operationUuid); compileToolRoutes (tool-routing.mjs) expands every marker before
// it compiles, so the routes, compiled.data and every answer of ssam_discover carry the very sentences of the tool
// descriptions: the two calls, the exact list with its count, the owner's reply that states the number AND names the
// targets, the rule of the words (WORDS_RULE) and the step after an interruption or a local failure (AFTER_INTERRUPTION:
// CANCELLED, SC_LOCAL_FAILURE, 'rejected' -> ssam_task). An unknown marker is a problem of the catalog, never served as is.
import { DESTRUCTIVE_SUFFIX, ODC_EXECUTION_UUID } from './destructive-operations.mjs';

export const CATALOG_TWO_CALLS = DESTRUCTIVE_SUFFIX;
export const CATALOG_TWO_CALLS_ODC = `${DESTRUCTIVE_SUFFIX} ${ODC_EXECUTION_UUID}`;
export const CATALOG_TEXT_MARKERS = Object.freeze({
  '{{destructive.twoCalls}}': CATALOG_TWO_CALLS,
  '{{destructive.twoCalls.odc}}': CATALOG_TWO_CALLS_ODC,
});
// The generated texts, longest first: a served text that carries one is never cut (tool-routing.mjs levelItems).
export const GENERATED_TEXTS = Object.freeze(Object.values(CATALOG_TEXT_MARKERS).sort((a, b) => b.length - a.length));
const MARKER = /\{\{[^{}]*\}\}/g;

// A copy of data whose strings (tools, their verbs and byLane texts, gaps) carry the generated texts in place of their
// markers. generated: where a marker was expanded ({at: 'tool[.verb][.byLane.<lane>]', field}); problems: unknown markers.
export function expandCatalogTexts(data) {
  const generated = []; const problems = [];
  const expand = (value, at, field) => {
    if (typeof value === 'string') {
      if (!value.includes('{{')) return value;
      return value.replace(MARKER, marker => {
        const text = CATALOG_TEXT_MARKERS[marker];
        if (text === undefined) { problems.push(`${at} ${field}: unknown text marker ${marker}`); return marker; }
        generated.push({ at, field, marker });
        return text;
      });
    }
    if (Array.isArray(value)) return value.map((v, i) => expand(v, at, `${field}[${i}]`));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v, at, field ? `${field}.${k}` : k)]));
    return value;
  };
  const route = (src, at) => {
    const out = { ...src };
    for (const [k, v] of Object.entries(src ?? {})) {
      if (k === 'verbs' && v && typeof v === 'object') out.verbs = Object.fromEntries(Object.entries(v).map(([verb, x]) => [verb, route(x, `${at}.${verb}`)]));
      else if (k === 'byLane' && v && typeof v === 'object') out.byLane = Object.fromEntries(Object.entries(v).map(([lane, x]) => [lane, expand(x, `${at}.byLane.${lane}`, '')]));
      else out[k] = expand(v, at, k);
    }
    return out;
  };
  if (!data || typeof data !== 'object') return { data, generated, problems };
  const out = { ...data };
  if (data.tools && typeof data.tools === 'object') out.tools = Object.fromEntries(Object.entries(data.tools).map(([tool, t]) => [tool, route(t, tool)]));
  if (Array.isArray(data.gaps)) out.gaps = data.gaps.map(g => expand(g, 'gap ' + (g?.id ?? '?'), ''));
  return { data: out, generated, problems };
}

// Whether a served text carries a generated two-call text (kept whole by the answer's full level).
export const carriesGeneratedText = value => typeof value === 'string' && GENERATED_TEXTS.some(t => value.includes(t));
