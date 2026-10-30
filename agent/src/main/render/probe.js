// The fixed measurement of the render worker (worker.mjs), run in an isolated world of the rendered document (the page's
// own scripts never run: its CSP is script-src 'none'). It is serialized with Function.prototype.toString, so it uses no
// import and no name from outside its body. It reads geometry and computed styles, never text: per element with a
// data-ssam-key, its box in the document, whether it is visible, which element covers its centre (the topmost element
// there that is neither an ancestor nor a descendant), which clipping ancestor cuts it, how many lines its text takes
// (the distinct line boxes of its text nodes), the length of its text, whether it overflows sideways and the computed
// values of the requested properties; per page, its scroll size and whether it overflows sideways; the font families
// used (the first of each element's list) that did not load or are not installed.
// options: {keys: "all" | [key], properties: [name], maxElements, bodyClasses: [class]}.
export async function measure(options) {
  const doc = document;
  const KEY = /^[A-Za-z0-9_-]{1,80}$/;
  const CLASS = /^[A-Za-z_-][A-Za-z0-9_-]{0,63}$/;
  const TAG = /^[a-z][a-z0-9-]{0,40}$/;
  if (doc.body) for (const name of options.bodyClasses ?? []) doc.body.classList.add(name);
  try { await doc.fonts.ready; } catch { /* no font set */ }
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const round = n => Math.round(n * 100) / 100;
  const viewWidth = doc.documentElement.clientWidth || innerWidth;
  const viewHeight = doc.documentElement.clientHeight || innerHeight;
  const tagOf = node => { const tag = String(node.tagName || '').toLowerCase(); return TAG.test(tag) ? tag : 'element'; };
  const classesOf = node => Array.from(node.classList || []).filter(name => CLASS.test(name)).slice(0, 3);
  // The key of the nearest keyed element that is not around the target, else the tag and classes of the node itself.
  const describe = (node, target) => {
    const keyed = node.closest('[data-ssam-key]');
    const key = keyed ? keyed.getAttribute('data-ssam-key') : null;
    if (keyed && !keyed.contains(target) && KEY.test(key)) return { k: key, tag: tagOf(keyed), classes: classesOf(keyed) };
    return { k: null, tag: tagOf(node), classes: classesOf(node) };
  };
  const wanted = options.keys === 'all' ? null : new Set(options.keys);
  const all = Array.from(doc.querySelectorAll('[data-ssam-key]')).filter(el => KEY.test(el.getAttribute('data-ssam-key')) && (!wanted || wanted.has(el.getAttribute('data-ssam-key'))));
  const items = all.slice(0, options.maxElements);
  const families = new Set();
  const elements = [];
  for (const el of items) {
    const style = getComputedStyle(el);
    let rect = el.getBoundingClientRect();
    const box = [round(rect.left + scrollX), round(rect.top + scrollY), round(rect.width), round(rect.height)];
    const visible = el.getClientRects().length > 0 && rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.visibility !== 'collapse' && Number(style.opacity) > 0;
    let clippedBy = null;
    if (visible) {
      for (let parent = el.parentElement; parent && parent !== doc.documentElement && parent !== doc.body; parent = parent.parentElement) {
        const s = getComputedStyle(parent);
        if (!/hidden|clip|scroll|auto/.test(s.overflowX + ' ' + s.overflowY)) continue;
        const r = parent.getBoundingClientRect();
        if (rect.left < r.left - 0.5 || rect.top < r.top - 0.5 || rect.right > r.right + 0.5 || rect.bottom > r.bottom + 0.5) { clippedBy = describe(parent, el); break; }
      }
    }
    let coveredBy = null;
    if (visible) {
      const cx = rect.left + scrollX + rect.width / 2; const cy = rect.top + scrollY + rect.height / 2;
      if (cx - scrollX < 0 || cy - scrollY < 0 || cx - scrollX >= viewWidth || cy - scrollY >= viewHeight) {
        scrollTo(Math.max(0, cx - viewWidth / 2), Math.max(0, cy - viewHeight / 2));
        rect = el.getBoundingClientRect();
      }
      const x = rect.left + rect.width / 2; const y = rect.top + rect.height / 2;
      if (x >= 0 && y >= 0 && x < viewWidth && y < viewHeight) {
        const top = doc.elementFromPoint(x, y);
        if (top && top !== el && !el.contains(top) && !top.contains(el)) coveredBy = describe(top, el);
      }
    }
    const tops = [];
    const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const range = doc.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.nodeValue || !node.nodeValue.trim()) continue;
      range.selectNodeContents(node);
      for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0 && !tops.some(t => Math.abs(t - r.top) < 2)) tops.push(r.top);
    }
    const styles = {};
    for (const name of options.properties) styles[name] = String(style.getPropertyValue(name)).slice(0, 200);
    const family = String(style.fontFamily || '').split(',')[0].trim().replace(/^["']|["']$/g, '');
    if (family && families.size < 50) families.add(family);
    elements.push({ k: el.getAttribute('data-ssam-key'), box, visible, coveredBy, clippedBy, lines: tops.length,
      textLength: String(el.textContent || '').replace(/\s+/g, ' ').trim().length, overflowX: el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1, styles });
  }
  scrollTo(0, 0);
  const generic = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded',
    'math', 'emoji', 'fangsong', 'inherit', 'initial', 'unset', 'revert', '-apple-system', 'blinkmacsystemfont']);
  const faces = Array.from(doc.fonts || []);
  const canvas = doc.createElement('canvas').getContext('2d');
  const sample = 'mmmmmmmmmmlli1WQ@#';
  const width = font => { canvas.font = '72px ' + font; return canvas.measureText(sample).width; };
  const missing = [];
  for (const family of families) {
    if (generic.has(family.toLowerCase())) continue;
    const defined = faces.filter(face => String(face.family).replace(/^["']|["']$/g, '').toLowerCase() === family.toLowerCase());
    if (defined.length) { if (defined.every(face => face.status === 'error' || face.status === 'unloaded')) missing.push(family.slice(0, 100)); continue; }
    const quoted = '"' + family.replace(/["\\]/g, '') + '"';
    if (width(quoted + ', monospace') === width('monospace') && width(quoted + ', serif') === width('serif')) missing.push(family.slice(0, 100));
  }
  const root = doc.documentElement;
  return { page: { scrollWidth: root.scrollWidth, scrollHeight: root.scrollHeight, overflowX: root.scrollWidth > viewWidth + 1 },
    fonts: { missing }, elements, truncated: all.length > items.length };
}
