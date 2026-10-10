// HTML of the Service Center pages, as the Python adapter read it (kernel/scripts/service_center/http.py): a port of
// CPython 3.12's html.parser.HTMLParser tokenizer (convert_charrefs, RAWTEXT script/style, RCDATA textarea/title,
// tolerant attributes, unescape) feeding the same small tree (Document/Node) with HTML's optional end tags. Scripts
// are data and never evaluated. Then the Web Forms helpers: controls, values, the fields a click posts, buttons,
// __doPostBack/OsAjax events and confirm() texts.
import { ProtocolError } from './errors.mjs';
import { fold, strip, words } from './util.mjs';

// ---- html.unescape
const LATIN1 = ('nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para '
  + 'middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc '
  + 'Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig '
  + 'agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc '
  + 'otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml').split(' ');
const NAMED = ('OElig:338 oelig:339 Scaron:352 scaron:353 Yuml:376 fnof:402 circ:710 tilde:732 ensp:8194 emsp:8195 thinsp:8201 zwnj:8204 '
  + 'zwj:8205 lrm:8206 rlm:8207 ndash:8211 mdash:8212 lsquo:8216 rsquo:8217 sbquo:8218 ldquo:8220 rdquo:8221 bdquo:8222 dagger:8224 '
  + 'Dagger:8225 bull:8226 hellip:8230 permil:8240 prime:8242 Prime:8243 lsaquo:8249 rsaquo:8250 oline:8254 frasl:8260 euro:8364 '
  + 'image:8465 weierp:8472 real:8476 trade:8482 alefsym:8501 larr:8592 uarr:8593 rarr:8594 darr:8595 harr:8596 crarr:8629 lArr:8656 '
  + 'uArr:8657 rArr:8658 dArr:8659 hArr:8660 forall:8704 part:8706 exist:8707 empty:8709 nabla:8711 isin:8712 notin:8713 ni:8715 '
  + 'prod:8719 sum:8721 minus:8722 lowast:8727 radic:8730 prop:8733 infin:8734 ang:8736 and:8743 or:8744 cap:8745 cup:8746 int:8747 '
  + 'there4:8756 sim:8764 cong:8773 asymp:8776 ne:8800 equiv:8801 le:8804 ge:8805 sub:8834 sup:8835 nsub:8836 sube:8838 supe:8839 '
  + 'oplus:8853 otimes:8855 perp:8869 sdot:8901 lceil:8968 rceil:8969 lfloor:8970 rfloor:8971 lang:10216 rang:10217 loz:9674 '
  + 'spades:9824 clubs:9827 hearts:9829 diams:9830 Alpha:913 Beta:914 Gamma:915 Delta:916 Epsilon:917 Zeta:918 Eta:919 Theta:920 '
  + 'Iota:921 Kappa:922 Lambda:923 Mu:924 Nu:925 Xi:926 Omicron:927 Pi:928 Rho:929 Sigma:931 Tau:932 Upsilon:933 Phi:934 Chi:935 '
  + 'Psi:936 Omega:937 alpha:945 beta:946 gamma:947 delta:948 epsilon:949 zeta:950 eta:951 theta:952 iota:953 kappa:954 lambda:955 '
  + 'mu:956 nu:957 xi:958 omicron:959 pi:960 rho:961 sigmaf:962 sigma:963 tau:964 upsilon:965 phi:966 chi:967 psi:968 omega:969 '
  + 'thetasym:977 upsih:978 piv:982 apos:39').split(' ');
const ENTITIES = new Map();
// Names that HTML5 also accepts without the semicolon (the legacy ones).
const LEGACY = { amp: '&', lt: '<', gt: '>', quot: '"', AMP: '&', LT: '<', GT: '>', QUOT: '"', COPY: '©', REG: '®' };
LATIN1.forEach((name, i) => { LEGACY[name] = String.fromCharCode(160 + i); });
for (const [name, value] of Object.entries(LEGACY)) { ENTITIES.set(name, value); ENTITIES.set(name + ';', value); }
for (const item of NAMED) { const [name, code] = item.split(':'); ENTITIES.set(name + ';', String.fromCodePoint(Number(code))); }

const INVALID_CHARREFS = { 0x00: '�', 0x0d: '\r', 0x80: '€', 0x81: '\x81', 0x82: '‚', 0x83: 'ƒ', 0x84: '„',
  0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ',
  0x8d: '\x8d', 0x8e: 'Ž', 0x8f: '\x8f', 0x90: '\x90', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”',
  0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ',
  0x9d: '\x9d', 0x9e: 'ž', 0x9f: 'Ÿ' };
const invalidCodepoint = n => (n >= 0x1 && n <= 0x8) || n === 0xb || (n >= 0xe && n <= 0x1f) || (n >= 0x7f && n <= 0x9f)
  || (n >= 0xfdd0 && n <= 0xfdef) || (n & 0xfffe) === 0xfffe;
const CHARREF = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/g;

export function unescape(text) {
  if (!text.includes('&')) return text;
  return text.replace(CHARREF, (whole, s) => {
    if (s[0] === '#') {
      const num = s[1] === 'x' || s[1] === 'X' ? parseInt(s.slice(2).replace(/;$/, ''), 16) : parseInt(s.slice(1).replace(/;$/, ''), 10);
      if (Object.hasOwn(INVALID_CHARREFS, num)) return INVALID_CHARREFS[num];
      if ((num >= 0xd800 && num <= 0xdfff) || num > 0x10ffff) return '�';
      if (invalidCodepoint(num)) return '';
      return String.fromCodePoint(num);
    }
    if (ENTITIES.has(s)) return ENTITIES.get(s);
    for (let x = s.length - 1; x > 1; x--) if (Object.hasOwn(LEGACY, s.slice(0, x))) return LEGACY[s.slice(0, x)] + s.slice(x);
    return '&' + s;
  });
}

// html.escape(text, quote)
export const escape = (text, quote = true) => {
  const out = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return quote ? out.replace(/"/g, '&quot;').replace(/'/g, '&#x27;') : out;
};

// ---- the tokenizer (html/parser.py of CPython 3.12.14)
const STARTTAGOPEN = /<[a-zA-Z]/y;
const ENDTAGOPEN = /<\/[a-zA-Z]/y;
const COMMENTCLOSE = /--!?>/g;
const COMMENTABRUPTCLOSE = /-?>/y;
const TAGFIND = /([a-zA-Z][^\t\n\r\f />]*)(?:[\t\n\r\f ]|\/(?!>))*/y;
const ATTRFIND = /((?<=['"\t\n\r\f /])[^\t\n\r\f />][^\t\n\r\f /=>]*)([\t\n\r\f ]*=[\t\n\r\f ]*('[^']*'|"[^"]*"|(?!['"])[^>\t\n\r\f ]*))?(?:[\t\n\r\f ]|\/(?!>))*/y;
const LOCATETAGEND = /[a-zA-Z][^\t\n\r\f />]*[\t\n\r\f /]*(?:(?<=['"\t\n\r\f /])[^\t\n\r\f />][^\t\n\r\f /=>]*(?:[\t\n\r\f ]*=[\t\n\r\f ]*(?:'[^']*'|"[^"]*"|(?!['"])[^>\t\n\r\f ]*))?[\t\n\r\f /]*)*>?/y;
const RAWTEXT = ['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes'];
const RCDATA = ['textarea', 'title'];
const sticky = (re, text, at) => { re.lastIndex = at; return re.exec(text); };

class Tokenizer {
  constructor(handler) { this.h = handler; this.raw = ''; this.cdata = null; this.escapable = true; this.interesting = null; }
  feed(text) { this.raw += text; this.goahead(false); }
  close() { this.goahead(true); }
  setCdata(tag, escapable) {
    this.cdata = tag; this.escapable = escapable;
    this.interesting = new RegExp(`</${tag}(?=[\\t\\n\\r\\f />])`, 'gi');
  }
  clearCdata() { this.cdata = null; this.escapable = true; this.interesting = null; }
  data(text) { this.h.handleData(this.escapable ? unescape(text) : text); }

  goahead(end) {
    const raw = this.raw; const n = raw.length; let i = 0;
    while (i < n) {
      let j;
      if (!this.cdata) {
        j = raw.indexOf('<', i);
        if (j < 0) {
          const amp = raw.lastIndexOf('&');
          if (amp >= Math.max(i, n - 34) && !/[\t\n\r\f ;]/.test(raw.slice(amp))) break;
          j = n;
        }
      } else {
        this.interesting.lastIndex = i;
        const match = this.interesting.exec(raw);
        if (match) j = match.index;
        else break;
      }
      if (i < j) this.data(raw.slice(i, j));
      i = j;
      if (i === n) break;
      let k;
      if (sticky(STARTTAGOPEN, raw, i)) k = this.parseStarttag(i);
      else if (raw.startsWith('</', i)) k = this.parseEndtag(i);
      else if (raw.startsWith('<!--', i)) k = this.parseComment(i);
      else if (raw.startsWith('<?', i)) k = this.closeAt(i + 2);
      else if (raw.startsWith('<!', i)) k = this.parseDeclaration(i);
      else if (i + 1 < n || end) { this.h.handleData('<'); k = i + 1; }
      else break;
      if (k < 0) {
        if (!end) break;
        if (raw.startsWith('</', i) && i + 2 === n) this.h.handleData('</');
        k = n; // anything else unterminated at the end is a dropped tag or an ignored comment
      }
      i = k;
    }
    if (end && i < n) { this.data(raw.slice(i)); i = n; }
    this.raw = raw.slice(i);
  }

  closeAt(from) { const gt = this.raw.indexOf('>', from); return gt < 0 ? -1 : gt + 1; }

  parseComment(i) {
    COMMENTCLOSE.lastIndex = i + 4;
    let match = COMMENTCLOSE.exec(this.raw);
    if (!match) { match = sticky(COMMENTABRUPTCLOSE, this.raw, i + 4); if (!match) return -1; }
    return match.index + match[0].length;
  }

  parseDeclaration(i) {
    const raw = this.raw;
    if (raw.startsWith('<![CDATA[', i)) { const j = raw.indexOf(']]>', i + 9); return j < 0 ? -1 : j + 3; }
    if (raw.slice(i, i + 9).toLowerCase() === '<!doctype') return this.closeAt(i + 9);
    if (raw.startsWith('<![', i)) return this.closeAt(i + 3);
    return this.closeAt(i + 2); // bogus comment
  }

  parseStarttag(i) {
    const raw = this.raw;
    const located = sticky(LOCATETAGEND, raw, i + 1);
    const endpos = i + 1 + located[0].length;
    if (raw[endpos - 1] !== '>') return -1;
    const name = sticky(TAGFIND, raw, i + 1);
    let k = i + 1 + name[0].length;
    const tag = name[1].toLowerCase();
    const attrs = [];
    while (k < endpos) {
      const m = sticky(ATTRFIND, raw, k);
      if (!m || !m[0].length) break;
      let value = m[2] ? m[3] : null;
      if (value !== null && value.length >= 2 && ((value[0] === "'" && value.at(-1) === "'") || (value[0] === '"' && value.at(-1) === '"'))) value = value.slice(1, -1);
      if (value) value = unescape(value);
      attrs.push([m[1].toLowerCase(), value]);
      k += m[0].length;
    }
    const tail = strip(raw.slice(k, endpos));
    if (tail !== '>' && tail !== '/>') { this.h.handleData(raw.slice(i, endpos)); return endpos; }
    if (tail.endsWith('/>')) this.h.handleStartendtag(tag, attrs);
    else {
      this.h.handleStarttag(tag, attrs);
      if (RAWTEXT.includes(tag) || tag === 'plaintext') this.setCdata(tag, false);
      else if (RCDATA.includes(tag)) this.setCdata(tag, true);
    }
    return endpos;
  }

  parseEndtag(i) {
    const raw = this.raw;
    if (raw.indexOf('>', i + 2) < 0) return -1;
    if (!sticky(ENDTAGOPEN, raw, i)) return raw[i + 2] === '>' ? i + 3 : this.closeAt(i + 2);
    const located = sticky(LOCATETAGEND, raw, i + 2);
    const j = i + 2 + located[0].length;
    if (raw[j - 1] !== '>') return -1;
    const tag = sticky(TAGFIND, raw, i + 2)[1].toLowerCase();
    this.h.handleEndtag(tag);
    this.clearCdata();
    return j;
  }
}

// ---- the tree
export class Node {
  constructor(tag, attrs = new Map(), parent = null) { this.tag = tag; this.attrs = attrs; this.children = []; this.parent = parent; }
  // attrs.get(name, default): an attribute written without a value is null, as Python's None.
  attr(name, fallback = undefined) { return this.attrs.has(name) ? this.attrs.get(name) : fallback; }
  has(name) { return this.attrs.has(name); }
  *walk(tags) {
    for (const c of this.children) {
      if (!(c instanceof Node)) continue;
      if (!tags.length || tags.includes(c.tag)) yield c;
      yield* c.walk(tags);
    }
  }
  all(...tags) { return [...this.walk(tags)]; }
  first(...tags) { for (const n of this.walk(tags)) return n; return null; }
  get text() {
    if (this.tag === 'script' || this.tag === 'style' || this.tag === 'input') return '';
    return words(this.children.map(c => (c instanceof Node ? c.text : c)).join(' ')).join(' ');
  }
  get readable() {
    if (this.tag === 'script' || this.tag === 'style' || this.tag === 'input') return '';
    if (this.tag === 'br') return '\n';
    const inner = this.children.map(c => (c instanceof Node ? c.readable : c)).join('');
    return ['div', 'p', 'tr', 'pre', 'li', 'h1', 'h2', 'h3'].includes(this.tag) ? '\n' + inner + '\n' : inner;
  }
  ancestor(tag) { let n = this.parent; while (n && n.tag !== tag) n = n.parent; return n; }
}
// Attribute helpers that read like the Python they replace.
export const attr = (node, name, fallback = '') => node.attr(name, fallback);
export const lower = value => String(value ?? '').toLowerCase();
export const classes = node => words(node.attr('class', '') ?? '');

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'wbr']);
export const isVoid = tag => VOID.has(tag);
// HTML's optional table/cell/option end tags, common in older SC versions.
const OPTIONAL = { tr: ['tr'], td: ['td', 'th'], th: ['td', 'th'], option: ['option'], li: ['li'] };

export class Document {
  constructor(html) {
    this.root = new Node('document');
    this.current = this.root;
    const tokenizer = new Tokenizer(this);
    tokenizer.feed(String(html));
    tokenizer.close();
  }
  handleStarttag(tag, attrs) {
    if ((OPTIONAL[tag] ?? []).includes(this.current.tag)) this.current = this.current.parent;
    const n = new Node(tag, new Map(attrs), this.current);
    this.current.children.push(n);
    if (!VOID.has(tag)) this.current = n;
  }
  handleStartendtag(tag, attrs) { this.handleStarttag(tag, attrs); if (!VOID.has(tag)) this.handleEndtag(tag); }
  handleEndtag(tag) {
    let n = this.current;
    while (n !== this.root && n.tag !== tag) n = n.parent;
    if (n !== this.root) this.current = n.parent;
  }
  handleData(data) { this.current.children.push(data); }

  all(...tags) { return this.root.all(...tags); }
  first(...tags) { return this.root.first(...tags); }
  login() { return this.all('input').some(n => lower(n.attr('type', '')) === 'password'); }
  // Modern Service Center labels carry for='' (matrix rule 4): only a real id pairs a label with its control.
  label(node) {
    const id = node.attr('id');
    const found = this.all('label').filter(n => n.attr('for') && n.attr('for') === id).map(n => n.text);
    return found.join(' ') || node.attr('aria-label') || node.attr('title') || '';
  }
  // The page's own content: div.sc-content-main of the modern Service Center (never the sidebar with Recent Items, the
  // licensee line or the Apply Settings alert); the whole document on pages without it.
  content() {
    const found = this.all('div').filter(n => classes(n).includes('sc-content-main'));
    return found.length === 1 ? found[0] : this.root;
  }
}

export class Page { constructor(url, doc) { this.url = url; this.doc = doc; } }

// ---- Web Forms
export const controls = form => form.all('input', 'select', 'textarea', 'button').filter(n => n.attr('name') && !n.has('disabled'));

export function controlValue(n) {
  // Preserve whitespace of Text/Long Text properties.
  if (n.tag === 'textarea') return n.children.filter(c => typeof c === 'string').join('');
  if (n.tag === 'select') {
    const options = n.all('option');
    const chosen = options.find(o => o.has('selected')) ?? options[0] ?? null;
    return chosen ? chosen.attr('value', chosen.text) : '';
  }
  if (['checkbox', 'radio'].includes(lower(n.attr('type', ''))) && !n.has('value')) return 'on'; // a checked box without a value
  return n.attr('value', '') || '';
}

// RFC 6901 pointer of one form field (secretRefs address fields of sc_web's form object).
export const jsonPointer = name => '/' + name.replace(/~/g, '~0').replace(/\//g, '~1');

// {field name: {target, field}} -> the contract's secretRefs entries. Only vault target names travel; the value is read
// inside the Studio process right before the send.
export function secretRefs(secrets) {
  const refs = [];
  for (const [name, ref] of Object.entries(secrets ?? {})) {
    if (!['password', 'username'].includes(ref?.field)
        || !/^SSAM\/O11\/[a-z0-9.-]+\/(?:DatabaseConnection|SiteProperty)\/[A-Za-z0-9_.-]{1,100}$/.test(ref?.target ?? ''))
      throw new ProtocolError('A secret reference names a same-host DatabaseConnection or SiteProperty vault entry and password or username');
    refs.push({ pointer: jsonPointer(name), target: ref.target, field: ref.field });
  }
  return refs;
}

export function formFields(form, clicked = null) {
  const pairs = [];
  for (const n of controls(form)) {
    const kind = lower(n.attr('type', n.tag === 'button' ? 'submit' : 'text'));
    if (['submit', 'button', 'image', 'reset'].includes(kind) && n !== clicked) continue;
    if (['checkbox', 'radio'].includes(kind) && !n.has('checked')) continue;
    pairs.push([n.attr('name'), controlValue(n)]);
  }
  return pairs;
}

export const caption = n => n.attr('value', '') || n.text;

export function button(page, names) {
  const wanted = names.map(fold);
  const found = page.doc.all('input', 'button').filter(n => ['submit', 'button'].includes(lower(n.attr('type', n.tag === 'button' ? 'submit' : '')))
    && wanted.includes(fold(strip(caption(n)))) && !n.has('disabled'));
  if (found.length !== 1) throw new ProtocolError('Expected one available control: ' + names.join('/'));
  if (lower(found[0].attr('type', '')) === 'button') throw new ProtocolError('This version requires an unsupported JavaScript form action');
  return found[0];
}

// The Web Forms event of a __doPostBack link, or of an OsAjax link (its control name).
export function postbackTarget(link) {
  const source = ((link.attr('href', '') ?? '') + '\n' + (link.attr('onclick', '') ?? '')).replaceAll('&#39;', "'");
  let match = /__doPostBack\('([^']*)','([^']*)'\)/.exec(source);
  if (match) return { kind: 'postback', target: match[1], argument: match[2] };
  match = /OsAjax\([^,]*,\s*'([^']*)'\s*,\s*'([^']*)'/.exec(source);
  if (match) return { kind: 'osajax', target: match[2], argument: '' };
  return null;
}

export function confirmText(node) {
  const match = /confirm\('((?:\\'|[^'])*)'\)/s.exec(node.attr('onclick', '') ?? '');
  const raw = match ? match[1] : '';
  return raw.replaceAll('\\x27', "'").replaceAll("\\'", "'").replaceAll('\\n', '\n').replaceAll('\\r', '');
}
