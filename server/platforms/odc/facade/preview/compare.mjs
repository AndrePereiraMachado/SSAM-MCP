import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Cdp, previewTarget } from '../debug-invoke-browser.mjs';
import { validateRevision, verifyLoadedRevision } from './revisions.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message ?? code), { code }); };
const hash = value => createHash('sha256').update(value).digest('hex');

// Runs read-only in the selected page. No navigation, events, cookies or application callbacks.
export async function observePage({ selectors, scenario }) {
  await Promise.race([document.fonts?.ready, new Promise(resolve => setTimeout(resolve, 3000))]);
  const items = {}; let total = 0;
  for (const { key, selector } of selectors) {
    const matches = [...document.querySelectorAll(selector)];
    if (matches.length > 1000 || (total += matches.length) > 4000) throw new Error('PREVIEW_COMPARISON_TOO_MANY_ELEMENTS');
    items[key] = matches.map(e => {
      const r = e.getBoundingClientRect(), s = getComputedStyle(e);
      return { tag: e.tagName, text: /^(SCRIPT|STYLE)$/.test(e.tagName) ? '' : (e.innerText ?? e.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 10000),
        rect: [r.x, r.y, r.width, r.height], display: s.display, visibility: s.visibility,
        font: s.font, padding: s.padding, margin: s.margin, color: s.color, background: s.backgroundColor,
        whiteSpace: s.whiteSpace, disabled: e.disabled === true || e.getAttribute('aria-disabled') === 'true',
        checked: typeof e.checked === 'boolean' ? e.checked : null,
        focused: e === document.activeElement, containsFocus: e.contains(document.activeElement),
        required: e.required === true, valid: typeof e.validity?.valid === 'boolean' ? e.validity.valid : null,
        role: e.getAttribute('role'), ariaExpanded: e.getAttribute('aria-expanded'), ariaSelected: e.getAttribute('aria-selected'),
        value: ['password', 'hidden'].includes(e.type) ? '[redacted]' : typeof e.value === 'string' ? e.value.slice(0, 2000) : null };
    });
  }
  return { schema: 'ssam-browser-observation/1', scenario, url: location.origin + location.pathname,
    viewport: [innerWidth, innerHeight, devicePixelRatio], locale: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, fonts: document.fonts?.status ?? 'unknown',
    overflow: document.documentElement.scrollWidth > innerWidth, items };
}

export function compareObservations(reference, candidate, { tolerance = 0, relation = 'equivalent', rowKey, counterKey, selectors = [] } = {}) {
  const differences = [];
  const difference = (key, property, expected, actual) => differences.push({ key, property, expected, actual });
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 10) fail('PREVIEW_COMPARISON_TOLERANCE');
  if (reference?.schema !== 'ssam-browser-observation/1' || candidate?.schema !== reference.schema) fail('PREVIEW_COMPARISON_SCHEMA');
  for (const observed of [reference, candidate]) {
    if (typeof observed.scenario !== 'string' || !observed.scenario || !Array.isArray(observed.viewport) || observed.viewport.length !== 3
      || observed.viewport.some(n => !Number.isFinite(n) || n <= 0) || !observed.items || Array.isArray(observed.items)
      || !Object.keys(observed.items).length || Object.values(observed.items).some(items => !Array.isArray(items)
        || items.some(item => !item || typeof item.text !== 'string' || !Array.isArray(item.rect) || item.rect.length !== 4
          || item.rect.some(n => !Number.isFinite(n)) || item.rect[2] < 0 || item.rect[3] < 0))) fail('PREVIEW_COMPARISON_OBSERVATION_INVALID');
  }
  for (const field of ['scenario', 'locale', 'timezone', 'viewport'])
    if (JSON.stringify(reference[field]) !== JSON.stringify(candidate[field])) difference('$context', field, reference[field], candidate[field]);
  if (reference.fonts !== 'loaded' || candidate.fonts !== 'loaded') difference('$context', 'fonts', 'loaded', [reference.fonts, candidate.fonts]);
  for (const expected of selectors) {
    for (const [side, observed] of [['reference', reference], ['candidate', candidate]]) {
      const items = observed.items[expected.key] ?? [];
      if (expected.count !== undefined && items.length !== expected.count) difference(expected.key, side + '.expectedCount', expected.count, items.length);
      const values = expected.expected?.[side];
      if (values && JSON.stringify(values) !== JSON.stringify(items.map(i => i.value ?? i.text)))
        difference(expected.key, side + '.expectedRecords', values, items.map(i => i.value ?? i.text));
    }
  }
  if (relation === 'pagination') {
    if (!rowKey || !counterKey || !reference.items[rowKey]?.length || !candidate.items[rowKey]?.length
      || !reference.items[counterKey]?.length || !candidate.items[counterKey]?.length) fail('PREVIEW_PAGINATION_EVIDENCE_REQUIRED');
    const values = (snapshot, key) => snapshot.items[key].map(x => x.value ?? x.text);
    if (JSON.stringify(values(reference, counterKey)) === JSON.stringify(values(candidate, counterKey)))
      difference(counterKey, 'transition', 'changed counter', 'unchanged');
    if (JSON.stringify(values(reference, rowKey)) === JSON.stringify(values(candidate, rowKey)))
      difference(rowKey, 'transition', 'changed records', 'same records');
  } else {
    if (relation !== 'equivalent') fail('PREVIEW_COMPARISON_RELATION');
    for (const key of new Set([...Object.keys(reference.items), ...Object.keys(candidate.items)])) {
      const a = reference.items[key] ?? [], b = candidate.items[key] ?? [];
      if ((!a.length || !b.length) && selectors.find(s => s.key === key)?.count !== 0) difference(key, 'coverage', 'selector matches on both pages', [a.length, b.length]);
      if (a.length !== b.length) difference(key, 'count', a.length, b.length);
      for (let i = 0; i < Math.min(a.length, b.length); i++) {
        for (const field of ['text', 'display', 'visibility', 'font', 'padding', 'margin', 'color', 'background', 'whiteSpace', 'disabled', 'checked', 'value', 'focused', 'containsFocus', 'required', 'valid', 'role', 'ariaExpanded', 'ariaSelected'])
          if (a[i][field] !== b[i][field]) difference(`${key}[${i}]`, field, a[i][field], b[i][field]);
        if (a[i].rect.some((n, j) => Math.abs(n - b[i].rect[j]) > tolerance)) difference(`${key}[${i}]`, 'rect', a[i].rect, b[i].rect);
      }
    }
    if (candidate.overflow !== reference.overflow) difference('$page', 'overflow', reference.overflow, candidate.overflow);
  }
  return { passed: differences.length === 0, differences };
}

// PNG decoding uses the browser's own codec in an offscreen canvas, without changing the page.
export async function comparePixels({ reference, candidate }) {
  const decode = async data => createImageBitmap(new Blob([Uint8Array.from(atob(data), c => c.charCodeAt(0))], { type: 'image/png' }));
  const a = await decode(reference), b = await decode(candidate);
  try {
    if (a.width * a.height > 36000000 || b.width * b.height > 36000000) throw new Error('PREVIEW_COMPARISON_IMAGE_SIZE');
    if (a.width !== b.width || a.height !== b.height) return { equal: false, dimensions: [[a.width, a.height], [b.width, b.height]] };
    const canvas = new OffscreenCanvas(a.width, a.height), context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(a, 0, 0); const left = context.getImageData(0, 0, a.width, a.height).data;
    context.clearRect(0, 0, a.width, a.height); context.drawImage(b, 0, 0);
    const right = context.getImageData(0, 0, b.width, b.height).data;
    let different = 0;
    for (let i = 0; i < left.length; i += 4) if (left[i] !== right[i] || left[i + 1] !== right[i + 1] || left[i + 2] !== right[i + 2] || left[i + 3] !== right[i + 3]) different++;
    return { equal: different === 0, differentPixels: different, totalPixels: a.width * a.height, ratio: different / (a.width * a.height) };
  } finally { a.close(); b.close(); }
}

export async function compareBrowserPages(args, { workspace, target = previewTarget, connect = Cdp.connect } = {}) {
  if (!path.isAbsolute(workspace ?? '')) fail('PREVIEW_WORKSPACE');
  const { reference, candidate, selectors, scenario, relation = 'equivalent' } = args;
  if (!reference?.tabId || !candidate?.tabId || !scenario || !Array.isArray(selectors) || selectors.length < 1 || selectors.length > 40) fail('PREVIEW_COMPARISON_INPUT');
  if (new Set(selectors.map(x => x.key)).size !== selectors.length || selectors.some(x => !/^[\w-]{1,80}$/.test(x.key) || typeof x.selector !== 'string' || !x.selector || x.selector.length > 500)) fail('PREVIEW_COMPARISON_SELECTORS');
  if (selectors.some(x => (x.candidateSelector !== undefined && (typeof x.candidateSelector !== 'string' || !x.candidateSelector || x.candidateSelector.length > 500))
    || (x.count !== undefined && (!Number.isInteger(x.count) || x.count < 0 || x.count > 1000))
    || (x.expected !== undefined && (!x.expected || typeof x.expected !== 'object' || Object.values(x.expected).some(v => !Array.isArray(v) || v.length > 1000 || v.some(t => typeof t !== 'string')))))) fail('PREVIEW_COMPARISON_SELECTORS');
  for (const side of [reference, candidate]) {
    const origin = new URL(side.origin);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== side.origin || origin.username || origin.password) fail('PREVIEW_COMPARISON_ORIGIN');
    validateRevision(side.revision, side.origin);
  }
  const capture = async side => {
    const cdp = await connect(await target(side.tabId, side.origin));
    try {
      // Chrome may stop painting a background tab. Activate the verified target before observing and capturing it.
      await cdp.send('Page.bringToFront');
      const revision = await verifyLoadedRevision(cdp, side.revision, side.origin);
      const sideSelectors = side === candidate ? selectors.map(s => ({...s, selector:s.candidateSelector ?? s.selector})) : selectors;
      const observed = await cdp.evaluate(observePage, { selectors:sideSelectors, scenario });
      if (new URL(observed.url).origin !== side.origin) fail('PREVIEW_COMPARISON_NAVIGATED');
      if (Buffer.byteLength(JSON.stringify(observed)) > 4000000) fail('PREVIEW_COMPARISON_OBSERVATION_SIZE');
      const png = (await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 30000)).data;
      if (typeof png !== 'string' || png.length > 16000000) fail('PREVIEW_COMPARISON_IMAGE_SIZE');
      return { observed, png, revision };
    } finally { cdp.close(); }
  };
  const left = await capture(reference), right = await capture(candidate);
  const comparison = compareObservations(left.observed, right.observed, args);
  let pixels = null;
  if (relation === 'equivalent') {
    const cdp = await connect(await target(reference.tabId, reference.origin));
    try { pixels = await cdp.evaluate(comparePixels, { reference: left.png, candidate: right.png }, 15000); }
    finally { cdp.close(); }
  }
  const id = randomUUID(), directory = path.join(workspace, '.local', 'preview', 'comparisons', id);
  fs.mkdirSync(directory, { recursive: true });
  const save = (name, bytes) => { const file = path.join(directory, name); fs.writeFileSync(file, bytes, { flag: 'wx' }); return { file, sha256: hash(bytes) }; };
  const evidence = {
    reference: save('reference.json', JSON.stringify(left.observed, null, 2)),
    candidate: save('candidate.json', JSON.stringify(right.observed, null, 2)),
    referenceImage: save('reference.png', Buffer.from(left.png, 'base64')),
    candidateImage: save('candidate.png', Buffer.from(right.png, 'base64')),
  };
  const result = { ok: true, schema: 'ssam-browser-comparison/1', id, scenario, relation,
    passed: comparison.passed && (pixels === null || pixels.equal), ...comparison, pixels, evidence,
    scope: 'Observed selectors and current viewport only. Not proof of unexecuted paths, authorization or the whole migration.',
    writesBusinessData: false, sourceRevisionVerified: left.revision.verified && right.revision.verified,
    revisions: { reference: left.revision, candidate: right.revision }, assertions: selectors, capturedAt: new Date().toISOString() };
  // Do not allow the structural result to overwrite the combined visual verdict.
  result.passed = comparison.passed && (pixels === null || pixels.equal);
  if ((reference.revision && !left.revision.verified) || (candidate.revision && !right.revision.verified)) result.passed = false;
  result.evidence.receipt = save('receipt.json', JSON.stringify(result, null, 2));
  return result;
}
