// Prototype kinds (docs/PROTOTIPO-NATIVO.md 2.2), decided in this order by the first criterion that holds:
// multi-page, spa-hash, spa-path, spa-sections, spa-state, static.
import { attr, isElement, walk } from './ir.mjs';
import { idsOf, sectionTargets } from './crawl.mjs';

export const KINDS = Object.freeze(['multi-page', 'spa-hash', 'spa-path', 'spa-sections', 'spa-state', 'static']);

function anchors(body) {
  const out = [];
  walk(body, node => { if (isElement(node) && node.t === 'a' && attr(node, 'href') != null) out.push(attr(node, 'href')); });
  return out;
}

// Static criteria (everything except spa-state, which needs click probes).
export function staticKind({ s0, entry, htmlFiles, analysis }) {
  const hrefs = anchors(s0.body);
  const listeners = s0.inspect?.listeners ?? [];
  const pageLinks = hrefs.filter(href => !/^(https?:|mailto:|tel:|#|javascript:)/i.test(href)).map(href => new URL(href, 'http://prototype.ssam/' + entry).pathname.replace(/^\//, '')).filter(target => target !== entry && htmlFiles.includes(target));
  if (htmlFiles.length >= 2 && pageLinks.length) return { kind: 'multi-page', why: 'links to ' + [...new Set(pageLinks)].join(', ') };
  const ids = idsOf(s0.body);
  const hashRoutes = hrefs.filter(href => href.startsWith('#') && href.length > 1 && !ids.has(decodeURIComponent(href.slice(1))));
  const hashListener = listeners.some(item => item.type === 'hashchange') || analysis.signals.hashchange;
  if (hashRoutes.length) return { kind: 'spa-hash', why: 'anchors to #routes that are not element ids' };
  // A hashchange listener whose anchors all name sibling sections (one visible) only switches sections: spa-sections.
  const hashSections = hashListener ? sectionTargets(s0.body) : null;
  if (hashSections) return { kind: 'spa-sections', why: hashSections.items.length + ' sibling sections switched by the hash, one visible', sections: hashSections };
  if (hashListener) return { kind: 'spa-hash', why: 'hashchange listener' };
  const popstate = listeners.some(item => item.type === 'popstate') || analysis.signals.popstate;
  const pathAnchors = hrefs.filter(href => /^\/[^/]/.test(href) && !htmlFiles.includes(href.slice(1)) && !/\.[a-z0-9]+$/i.test(href));
  if ((popstate || analysis.signals.pushState) && (pathAnchors.length || analysis.paths.length)) return { kind: 'spa-path', why: popstate ? 'popstate listener' : 'history.pushState' };
  const sections = sectionTargets(s0.body);
  if (sections) return { kind: 'spa-sections', why: sections.items.length + ' sibling sections, one visible', sections };
  return null;
}
