// The text/babel and text/jsx scripts of a prototype (docs/PROTOTIPO-NATIVO.md 2.1, 2.3 source 4) compiled for the static
// scan in the facade process, never in the capture child: with the Babel standalone build the page itself loads, evaluated
// once per build in a context of its own with no window (Babel then registers no script-tag runner). The output keeps the
// source lines (retainLines), so the static analysis (routes, branches, handler sites) names the lines of the .jsx as
// babel:<file>:<line>, the name the runtime gives the code Babel evaluates there.
//
// The prototype is untrusted content and a vm context is no security boundary: only a Babel the SSAM can vouch for runs in
// this process (trustedBabel): the @babel/standalone package itself on an allowlisted CDN (its URL, fetched by the facade
// into the content-addressed cache, or pinned there), or a copy whose sha256 is one of the pinned builds. Any other "Babel" (a
// babel.min.js of the prototype folder, a package of another name) never runs here: the static scan of the .jsx is skipped
// and said (PrototypeBabelUntrusted); the page still renders in the sandboxed child as always.
import vm from 'node:vm';
import { createHash } from 'node:crypto';

const loaded = new Map();
const sha256 = text => createHash('sha256').update(text).digest('hex');

// sha256 of @babel/standalone builds known to the SSAM (7.29.0 babel.min.js, as unpkg serves it).
export const PINNED_BABEL = Object.freeze(new Set(['2623a9e22809915ce789b4461154e277ddce520d5a4320c14d44332a5d0dcea0']));
const PACKAGE_URL = /^https:\/\/(?:unpkg\.com\/@babel\/standalone@[0-9][0-9A-Za-z.+-]*|cdn\.jsdelivr\.net\/npm\/@babel\/standalone@[0-9][0-9A-Za-z.+-]*|cdnjs\.cloudflare\.com\/ajax\/libs\/babel-standalone\/[0-9][0-9A-Za-z.+-]*)\/babel(?:\.min)?\.js$/;

// vendor: {url, sha256, from: cache|download|folder|mapping|local, text}. -> true when this process may run it.
export function trustedBabel(vendor) {
  if (!vendor || typeof vendor.text !== 'string') return false;
  const hash = vendor.sha256 ?? sha256(vendor.text);
  if (PINNED_BABEL.has(hash)) return true;
  return typeof vendor.url === 'string' && PACKAGE_URL.test(vendor.url) && (vendor.from === 'cache' || vendor.from === 'download');
}

export function loadBabel(text) {
  if (typeof text !== 'string' || !text) return null;
  const key = sha256(text);
  if (loaded.has(key)) return loaded.get(key);
  let babel = null;
  try {
    const context = vm.createContext({ console: { log() {}, warn() {}, error() {} } });
    vm.runInContext(text, context, { filename: 'babel-standalone.js', timeout: 20000 });
    babel = context.Babel && typeof context.Babel.transform === 'function' ? context.Babel : null;
  } catch { babel = null; }
  loaded.set(key, babel);
  return babel;
}

// vendor: the Babel the page loads (trustedBabel decides whether it runs here). sources: [{file, text, line?}] (line: where an
// inline script starts in the page). -> {sources: [{file: 'babel:<file>', text}], warnings}
export function compileBabelSources(vendor, sources) {
  const warnings = [];
  if (!sources?.length) return { sources: [], warnings };
  const files = sources.map(item => item.file);
  if (!vendor) return { sources: [], warnings: [{ code: 'PrototypeBabelUnavailable', message: 'the text/babel scripts were not read statically: the page loads no Babel standalone build', files }] };
  if (!trustedBabel(vendor)) return { sources: [], warnings: [{ code: 'PrototypeBabelUntrusted', message: 'the text/babel scripts were not read statically: the Babel the page loads (' + (vendor.url ?? 'a file of the prototype folder') + ') is not the @babel/standalone package nor a pinned build, and the facade never runs prototype code; the page still renders in the sandboxed child', files }] };
  const babel = loadBabel(vendor.text);
  if (!babel) return { sources: [], warnings: [{ code: 'PrototypeBabelUnavailable', message: 'the Babel the page loads could not be evaluated', files }] };
  const out = [];
  for (const source of sources) {
    try {
      const result = babel.transform(source.text, { presets: ['react'], retainLines: true, compact: false, comments: false, filename: source.file, sourceType: 'script', babelrc: false, configFile: false });
      const pad = source.line > 1 ? '\n'.repeat(source.line - 1) : '';
      out.push({ file: 'babel:' + source.file, text: pad + result.code });
    } catch (error) {
      warnings.push({ code: 'PrototypeBabelSyntax', where: 'babel:' + source.file, message: String(error?.message ?? error).split('\n')[0].slice(0, 300) });
    }
  }
  return { sources: out, warnings };
}
