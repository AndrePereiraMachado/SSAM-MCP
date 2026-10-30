// The screen.render request table, the same for the Node agent (render-request.mjs) and the native core
// (check-render-request): rows {label, request, expected: 'ok' | RENDER_REQUEST_INVALID | RENDER_DOCUMENT_REFUSED}.
import { createHash } from 'node:crypto';

const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');
const MiB = 1024 * 1024;
export const HTML = '<!doctype html><html><head></head><body><div class="screen" data-ssam-key="a1">See https://example.com/help or //wiki</div>'
  + '<form class="form"><input data-ssam-key="b2" type="text"></form><img data-ssam-key="c3" src="data:image/png;base64,AAAA"></body></html>';
export const CSS = '.screen{white-space:normal} .x{background:url(data:image/png;base64,AAAA)} @import "local.css";';
const doc = (html, id = 's1', styles = ['osui']) => ({ id, sha256: sha(html), html, styles });
const style = (css, id = 'osui') => ({ id, sha256: sha(css), css });
export function baseRequest() {
  return { schema: 'ssam-render-request/1', styles: [style(CSS)], documents: [doc(HTML)],
    viewports: [{ name: 'desktop', width: 1366, height: 768, bodyClasses: ['desktop'] }, { name: 'tablet', width: 768, height: 1024, bodyClasses: ['tablet', 'portrait'] }],
    probes: { keys: 'all', properties: ['white-space', 'width', 'margin-left'], maxElements: 1500 }, image: null, timeoutMs: 60000 };
}
const withHtml = html => ({ documents: [doc(`<!doctype html><html><body>${html}</body></html>`)] });
const withCss = css => ({ styles: [style(css)] });

export function renderRows() {
  const base = baseRequest();
  const rows = [
    ['the base request', {}, 'ok'],
    ['only the required fields', { styles: undefined, probes: undefined, image: undefined, timeoutMs: undefined, documents: [doc(HTML, 's1', [])] }, 'ok'],
    ['an image', { image: { format: 'jpeg', quality: 70, maxEdge: 1568, fullPage: true } }, 'ok'],
    ['keys by list', { probes: { keys: ['a1', 'b2'], properties: [], maxElements: 3000 } }, 'ok'],
    ['three viewports', { viewports: [{ name: 'desktop', width: 2560, height: 4096 }, { name: 'tablet', width: 768, height: 1024 }, { name: 'phone', width: 320, height: 480, bodyClasses: ['phone', 'portrait'] }] }, 'ok'],
    ['eight documents', { documents: Array.from({ length: 8 }, (_, i) => doc(HTML, 's' + i)) }, 'ok'],
    ['a URL in the text of the screen', withHtml('<p data-ssam-key="t">Go to http://example.com or file:///x</p>'), 'ok'],
    ['a relative link', withHtml('<a href="#top" data-ssam-key="t">top</a><a href="page2">next</a>'), 'ok'],
    ['an attribute named like a URL that is not one', withHtml('<div data-src="https://x" title="//x">x</div>'), 'ok'],
    ['an online word in the text', withHtml('<p>Turn online=yes</p>'), 'ok'],
    ['schema', { schema: 'ssam-render-request/2' }, 'RENDER_REQUEST_INVALID'],
    ['an unknown field', { extra: true }, 'RENDER_REQUEST_INVALID'],
    ['no document', { documents: [] }, 'RENDER_REQUEST_INVALID'],
    ['nine documents', { documents: Array.from({ length: 9 }, (_, i) => doc(HTML, 's' + i)) }, 'RENDER_REQUEST_INVALID'],
    ['documents not a list', { documents: { s1: doc(HTML) } }, 'RENDER_REQUEST_INVALID'],
    ['a duplicated document id', { documents: [doc(HTML), doc(HTML)] }, 'RENDER_REQUEST_INVALID'],
    ['an upper-case document id', { documents: [doc(HTML, 'S1')] }, 'RENDER_REQUEST_INVALID'],
    ['a document without its sha256', { documents: [{ ...doc(HTML), sha256: sha('other') }] }, 'RENDER_REQUEST_INVALID'],
    ['an unknown document field', { documents: [{ ...doc(HTML), text: 'x' }] }, 'RENDER_REQUEST_INVALID'],
    ['a document above 4 MiB', { documents: [doc('<p>' + 'a'.repeat(4 * MiB) + '</p>')] }, 'RENDER_REQUEST_INVALID'],
    ['a document of exactly 4 MiB', { documents: [doc('a'.repeat(4 * MiB))] }, 'ok'],
    ['a style unknown to the request', { documents: [doc(HTML, 's1', ['theme'])] }, 'RENDER_REQUEST_INVALID'],
    ['seventeen styles', { styles: Array.from({ length: 17 }, (_, i) => style(CSS, 'st' + i)) }, 'RENDER_REQUEST_INVALID'],
    ['a style above 2 MiB', { styles: [style('a{}' + ' '.repeat(2 * MiB))] }, 'RENDER_REQUEST_INVALID'],
    ['a style without its sha256', { styles: [{ ...style(CSS), sha256: sha('x') }] }, 'RENDER_REQUEST_INVALID'],
    ['a duplicated style id', { styles: [style(CSS), style(CSS)] }, 'RENDER_REQUEST_INVALID'],
    ['a package above 12 MiB', { documents: [doc('a'.repeat(4 * MiB), 's1', []), doc('b'.repeat(4 * MiB), 's2', []), doc('c'.repeat(4 * MiB), 's3', [])] }, 'RENDER_REQUEST_INVALID'],
    ['no viewport', { viewports: [] }, 'RENDER_REQUEST_INVALID'],
    ['four viewports', { viewports: ['a', 'b', 'c', 'd'].map(name => ({ name, width: 800, height: 600 })) }, 'RENDER_REQUEST_INVALID'],
    ['a duplicated viewport', { viewports: [{ name: 'a', width: 800, height: 600 }, { name: 'a', width: 900, height: 600 }] }, 'RENDER_REQUEST_INVALID'],
    ['too narrow', { viewports: [{ name: 'a', width: 319, height: 600 }] }, 'RENDER_REQUEST_INVALID'],
    ['too high', { viewports: [{ name: 'a', width: 800, height: 4097 }] }, 'RENDER_REQUEST_INVALID'],
    ['a fractional width', { viewports: [{ name: 'a', width: 800.5, height: 600 }] }, 'RENDER_REQUEST_INVALID'],
    ['nine body classes', { viewports: [{ name: 'a', width: 800, height: 600, bodyClasses: Array.from({ length: 9 }, (_, i) => 'c' + i) }] }, 'RENDER_REQUEST_INVALID'],
    ['a body class with a space', { viewports: [{ name: 'a', width: 800, height: 600, bodyClasses: ['a b'] }] }, 'RENDER_REQUEST_INVALID'],
    ['an unknown viewport field', { viewports: [{ name: 'a', width: 800, height: 600, scale: 2 }] }, 'RENDER_REQUEST_INVALID'],
    ['401 keys', { probes: { keys: Array.from({ length: 401 }, (_, i) => 'k' + i) } }, 'RENDER_REQUEST_INVALID'],
    ['a key with @', { probes: { keys: ['@a1'] } }, 'RENDER_REQUEST_INVALID'],
    ['keys neither all nor a list', { probes: { keys: 'some' } }, 'RENDER_REQUEST_INVALID'],
    ['an unknown property', { probes: { properties: ['content'] } }, 'RENDER_REQUEST_INVALID'],
    ['a duplicated property', { probes: { properties: ['width', 'width'] } }, 'RENDER_REQUEST_INVALID'],
    ['25 properties', { probes: { properties: ['display', 'position', 'visibility', 'opacity', 'white-space', 'overflow', 'overflow-x', 'overflow-y', 'width', 'height',
      'min-width', 'max-width', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
      'font-size', 'font-family', 'line-height', 'text-overflow', 'z-index'] } }, 'RENDER_REQUEST_INVALID'],
    ['maxElements 3001', { probes: { maxElements: 3001 } }, 'RENDER_REQUEST_INVALID'],
    ['maxElements 0', { probes: { maxElements: 0 } }, 'RENDER_REQUEST_INVALID'],
    ['an unknown probes field', { probes: { verdict: 'x' } }, 'RENDER_REQUEST_INVALID'],
    ['a PNG image', { image: { format: 'png', quality: 70, maxEdge: 800, fullPage: false } }, 'RENDER_REQUEST_INVALID'],
    ['quality 39', { image: { format: 'jpeg', quality: 39, maxEdge: 800, fullPage: false } }, 'RENDER_REQUEST_INVALID'],
    ['maxEdge 1921', { image: { format: 'jpeg', quality: 70, maxEdge: 1921, fullPage: false } }, 'RENDER_REQUEST_INVALID'],
    ['an image without fullPage', { image: { format: 'jpeg', quality: 70, maxEdge: 800 } }, 'RENDER_REQUEST_INVALID'],
    ['image true', { image: true }, 'RENDER_REQUEST_INVALID'],
    ['timeoutMs 4999', { timeoutMs: 4999 }, 'RENDER_REQUEST_INVALID'],
    ['timeoutMs 90001', { timeoutMs: 90001 }, 'RENDER_REQUEST_INVALID'],
    ['a script', withHtml('<script>alert(1)</script>'), 'RENDER_DOCUMENT_REFUSED'],
    ['a SCRIPT in capitals', withHtml('<SCRIPT src="a.js"></SCRIPT>'), 'RENDER_DOCUMENT_REFUSED'],
    ['an iframe', withHtml('<iframe src="about:blank"></iframe>'), 'RENDER_DOCUMENT_REFUSED'],
    ['a frameset', withHtml('<frameset><frame src="a"></frameset>'), 'RENDER_DOCUMENT_REFUSED'],
    ['an object', withHtml('<object data="a"></object>'), 'RENDER_DOCUMENT_REFUSED'],
    ['an embed', withHtml('<embed src="a">'), 'RENDER_DOCUMENT_REFUSED'],
    ['a link', withHtml('<link rel="stylesheet" href="a.css">'), 'RENDER_DOCUMENT_REFUSED'],
    ['a base', withHtml('<base href="/">'), 'RENDER_DOCUMENT_REFUSED'],
    ['a meta refresh', withHtml('<meta http-equiv="refresh" content="0;url=x">'), 'RENDER_DOCUMENT_REFUSED'],
    ['an onclick', withHtml('<div onclick="x()">x</div>'), 'RENDER_DOCUMENT_REFUSED'],
    ['an onerror after a slash', withHtml('<img/onerror=x src=a>'), 'RENDER_DOCUMENT_REFUSED'],
    ['an onload in capitals after a quoted value', withHtml('<svg width="1"ONLOAD="x"></svg>'), 'RENDER_DOCUMENT_REFUSED'],
    ['an on attribute after a quoted >', withHtml('<img alt=">" onerror="x" src="a">'), 'RENDER_DOCUMENT_REFUSED'],
    ['srcdoc', withHtml('<div srcdoc="x"></div>'), 'RENDER_DOCUMENT_REFUSED'],
    ['a javascript: link', withHtml('<a href="javascript:x()">x</a>'), 'RENDER_DOCUMENT_REFUSED'],
    ['a javascript: link with a tab', withHtml('<a href="java\tscript:x()">x</a>'), 'RENDER_DOCUMENT_REFUSED'],
    ['a vbscript: link', withHtml('<a href="VBScript:x">x</a>'), 'RENDER_DOCUMENT_REFUSED'],
    ['an http image', withHtml('<img src="http://127.0.0.1/a.png">'), 'RENDER_DOCUMENT_REFUSED'],
    ['an https image in capitals', withHtml('<IMG SRC=" HTTPS://x/a.png">'), 'RENDER_DOCUMENT_REFUSED'],
    ['a protocol-relative image', withHtml('<img src="//x/a.png">'), 'RENDER_DOCUMENT_REFUSED'],
    ['a UNC image', withHtml('<img src="\\\\server\\a.png">'), 'RENDER_DOCUMENT_REFUSED'],
    ['a file: link', withHtml('<a href="file:///C:/x">x</a>'), 'RENDER_DOCUMENT_REFUSED'],
    ['an ftp poster', withHtml('<video poster="ftp://x/a.png"></video>'), 'RENDER_DOCUMENT_REFUSED'],
    ['a srcset with an outside address', withHtml('<img srcset="a.png 1x, https://x/b.png 2x">'), 'RENDER_DOCUMENT_REFUSED'],
    ['a form action outside', withHtml('<form action="https://x/post"></form>'), 'RENDER_DOCUMENT_REFUSED'],
    ['a style attribute url()', withHtml('<div style="background:url( \'http://x/a.png\')">x</div>'), 'RENDER_DOCUMENT_REFUSED'],
    ['a style element url()', withHtml('<style>.a{background:URL(https://x/a.png)}</style>'), 'RENDER_DOCUMENT_REFUSED'],
    ['a style element @import', withHtml('<style>@import url(//x/a.css);</style>'), 'RENDER_DOCUMENT_REFUSED'],
    ['a style element @import of a string', withHtml("<style>@import 'https://x/a.css';</style>"), 'RENDER_DOCUMENT_REFUSED'],
    ['a style sheet url()', withCss('.a{background:url("file:///C:/a.png")}'), 'RENDER_DOCUMENT_REFUSED'],
    ['a style sheet @import', withCss('@import "http://x/a.css";'), 'RENDER_DOCUMENT_REFUSED'],
    ['a style sheet that ends the style element', withCss('.a{}</style><p>x'), 'RENDER_DOCUMENT_REFUSED'],
    ['a style sheet with javascript:', withCss('.a{background:url(javascript:x)}'), 'RENDER_DOCUMENT_REFUSED'],
    // CSS read as tokens (R3-A rule): escapes decoded before names, image functions, custom properties, entities.
    ['an escaped url(', withCss('.a{background:u\\72l(https://x/a.png)}'), 'RENDER_DOCUMENT_REFUSED'],
    ['an escaped address in a url string', withCss('.a{background:url("\\68ttps://x/a.png")}'), 'RENDER_DOCUMENT_REFUSED'],
    ['an escaped address in an unquoted url', withCss('.a{background:url(\\68ttps://x/a.png)}'), 'RENDER_DOCUMENT_REFUSED'],
    ['image-set with an outside string', withCss('.a{background:image-set("https://x/a.png" 1x)}'), 'RENDER_DOCUMENT_REFUSED'],
    ['-webkit-image-set with //', withCss(".a{background:-webkit-image-set('//x/a.png' 1x)}"), 'RENDER_DOCUMENT_REFUSED'],
    ['cross-fade with an outside string', withCss('.a{background:cross-fade("http://x/a.png", "#b" 50%)}'), 'RENDER_DOCUMENT_REFUSED'],
    ['src() with a file string', withCss('@font-face{font-family:F;src:src("file:///C:/f.woff")}'), 'RENDER_DOCUMENT_REFUSED'],
    ['an escaped @import', withCss('@\\69mport "http://x/a.css";'), 'RENDER_DOCUMENT_REFUSED'],
    ['@import with a comment and capitals', withCss('@IMPORT/**/ URL( "//x/a.css" );'), 'RENDER_DOCUMENT_REFUSED'],
    ['a custom property string with an address', withCss('.a{--bg:"https://x/a.png"}.b{background:url(var(--bg))}'), 'RENDER_DOCUMENT_REFUSED'],
    ['an escaped identifier in a custom property is not a URL', withCss('.a{--bg:h\\74tps\\3a //x/a.png}'), 'ok'],
    ['a url of another scheme', withCss('.a{background:url(ftp2:x)}'), 'RENDER_DOCUMENT_REFUSED'],
    ['a data: url that is not an image', withCss('.a{background:url("data:text/html,x")}'), 'RENDER_DOCUMENT_REFUSED'],
    ['an escaped url( in a style attribute', withHtml('<div style="background:u\\72l(https://x/a.png)">x</div>'), 'RENDER_DOCUMENT_REFUSED'],
    ['an entity in a style attribute', withHtml('<div style="background:url(&quot;h&#116;tps://x/a.png&quot;)">x</div>'), 'RENDER_DOCUMENT_REFUSED'],
    ['an entity in an img src', withHtml('<img src="&#104;ttp://x/a.png">'), 'RENDER_DOCUMENT_REFUSED'],
    ['an entity javascript: link', withHtml('<a href="java&#115;cript:x()">x</a>'), 'RENDER_DOCUMENT_REFUSED'],
    ['image-set in a style element', withHtml('<style>.a{background:image-set(url("https://x/a.png") 1x)}</style>'), 'RENDER_DOCUMENT_REFUSED'],
    ['url(#id) and image data: stay', withCss('.a{background:url(#g)}.b{background:url("data:image/svg+xml;utf8,<svg/>")}.c{mask:image-set("#m" 1x)}'), 'ok'],
    ['text with an address in content stays', withCss('.a::after{content:"https://x/help"}.b{--label:"see the guide";--n:12px}'), 'ok'],
    ['a relative @import stays', withCss('@import "local.css"; .a{background:url(img/a.png)}'), 'ok'],
    ['url broken by a comment is not a url', withCss('.a{background:ur/**/l(https://x/a.png)}'), 'ok'],
    // The context decides (R3-A, rounds 5-6): declaration values and @import, never selectors nor @namespace; content and
    // quotes text stays unless inside a URL or image function. Each declaration also goes as a style attribute.
    ...[
      ['a var() fallback in background-image', 'background-image:var(--m,"https://e.example/x.png")', 'RENDER_DOCUMENT_REFUSED'],
      ['a var() fallback in border-image-source', 'border-image-source:var(--m,"//e.example/x.png")', 'RENDER_DOCUMENT_REFUSED'],
      ['an address as a font-family string', 'font-family:"https://e.example/f"', 'RENDER_DOCUMENT_REFUSED'],
      ['an escaped address as a font-family string', 'font-family:"\\68ttps://e.example/f"', 'RENDER_DOCUMENT_REFUSED'],
      ['a file address as a mask string', 'mask:"file:///C:/x"', 'RENDER_DOCUMENT_REFUSED'],
      ['an address after a content declaration', 'content:"x";background:"//e.example/y"', 'RENDER_DOCUMENT_REFUSED'],
      ['content with image-set and a var() fallback', 'content:image-set(var(--m,"https://evil.test/c.png") 1x)', 'RENDER_DOCUMENT_REFUSED'],
      ['content with -webkit-image-set and //', 'content:-webkit-image-set(var(--m,"//evil.test/c.png") 1x)', 'RENDER_DOCUMENT_REFUSED'],
      ['an address as content text', 'content:"https://e.example/x"', 'ok'],
      ['an address in a content var() fallback (not the direct value)', 'content:var(--q,"https://e.example")', 'RENDER_DOCUMENT_REFUSED'],
      ['content with counter() and //', 'content:counter(c,"//")', 'ok'],
      ['quotes with slashes', 'quotes:"//" "//"', 'ok'],
      ['grid-template-areas', 'grid-template-areas:"a b" "c d"', 'ok'],
      ['font-family names', 'font-family:"Open Sans","Segoe UI",sans-serif', 'ok'],
      ['content with attr() and its fallback', 'content:attr(data-href, "https://e.example")', 'ok'],
      ['content with counters()', 'content:counters(item, ".") " "', 'ok'],
    ].flatMap(([label, declaration, expected]) => [[label, withCss('.a{' + declaration + '}'), expected],
      [label + ' (style attribute)', withHtml("<div style='" + declaration + "'>x</div>"), expected]]),
    // Every declaration by its shape at any depth: each container nested in each other up to depth 3.
    ...nestingRows(),
    ['@property initial-value with an address', withCss('@property --p{syntax:"*";inherits:false;initial-value:"https://e.example/x.png"}'), 'RENDER_DOCUMENT_REFUSED'],
    ['a selector with an address stays', withCss('.a[href^="https://"]{color:red} .b[title="//x"]{color:blue} a:not([href^="http:"]){color:green}'), 'ok'],
    ['@namespace stays', withCss('@namespace svg url(http://www.w3.org/2000/svg); @namespace html "http://www.w3.org/1999/xhtml"; svg|rect{fill:red}'), 'ok'],
    ['@font-face with local() and a data font', withCss('@font-face{font-family:"Brand";src:local("Brand Sans"),local(BrandSans),url("data:image/svg+xml,x")}'), 'ok'],
    ['@font-face with an outside src', withCss('@font-face{font-family:"Brand";src:local("Brand"),url("https://e.example/f.woff2") format("woff2")}'), 'RENDER_DOCUMENT_REFUSED'],
    ['@counter-style', withCss('@counter-style thumbs{system:cyclic;symbols:"\\1F44D" "*";suffix:" "}ol{list-style:thumbs}'), 'ok'],
    ['@media and @supports blocks', withCss('@media (min-width:768px){.a[data-x="//y"]{color:red}.b{background:url("#g")}}@supports (display:grid){.c{grid-template-areas:"a"}}'), 'ok'],
    ['a url only in a comment', withCss('/* url(https://e.example/x.png) "https://e.example" */ .a{color:red}'), 'ok'],
    ['url("#x") and image data:', withCss('.a{background:url("#x")}.b{background:url("data:image/png;base64,AA")}'), 'ok'],
    ['an outside string in a nested @media rule', withCss('@media print{.a{background-image:var(--m,"https://e.example/x.png")}}'), 'RENDER_DOCUMENT_REFUSED'],
  ];
  return rows.map(([label, change, expected]) => {
    const request = { ...base, ...change };
    for (const [key, value] of Object.entries(change)) {
      if (value === undefined) delete request[key];
      else if (key === 'probes' && value && typeof value === 'object' && !Array.isArray(value)) request.probes = { ...base.probes, ...value };
    }
    if (change.styles && !change.documents) request.documents = base.documents.map(d => ({ ...d, styles: [change.styles[0]?.id ?? 'osui'].filter(id => change.styles.some(s => s.id === id)) }));
    return { label, request, expected };
  });
}

// Containers nested in each other (depth 1 to 3) around a declaration that must be refused and around a selector that
// must stay: the reader finds declarations by their shape, never by a list of containers.
export function nestingRows() {
  const containers = ['@media screen', '@supports (display:grid)', '@layer x', '@container (min-width:1px)', '@scope (.s)', '@starting-style',
    '@unknown-rule foo', '.nested', '&:hover'];
  const chains = [];
  for (const a of containers) { chains.push([a]); for (const b of containers) { chains.push([a, b]); for (const c of containers) chains.push([a, b, c]); } }
  const wrap = (chain, inner) => chain.reduceRight((body, container) => `${container}{${body}}`, inner);
  return chains.flatMap(chain => [
    ['nested ' + chain.join(' > ') + ': an outside var() fallback', withCss(wrap(chain, '.x{background-image:var(--m,"https://e.example/x.png")}')), 'RENDER_DOCUMENT_REFUSED'],
    ['nested ' + chain.join(' > ') + ': a selector with an address', withCss(wrap(chain, '.x[href^="https://"]:hover{color:red;content:"https://e.example"}')), 'ok']]);
}