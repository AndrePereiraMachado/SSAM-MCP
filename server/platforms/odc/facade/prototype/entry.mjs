// Which .html page of a prototype folder is the app (docs/PROTOTIPO-NATIVO.md 1.2), when the folder has several pages at its
// root and no index.html. The importer never picks one alone (the refusal names the entry in its patch), but the patch names
// the page that runs the app: the one that loads the most scripts of the folder (a React/Babel app loads its .jsx), then the
// one that loads scripts from the network, then inline code; a page that loads nothing is a static page (a style guide, a
// CSS showcase). VisitaCerta 2026-10-12: 'Visita Certa.html' (seven .jsx) and 'visita-certa-css.html' (a CSS showcase).
//
//   rankEntries(root, pages) -> [{page, local: [file], remote: [url], inline, why}], the app first
import fs from 'node:fs';
import path from 'node:path';

const READ_BYTES = 512 * 1024;
const REMOTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
// a script element that carries data or markup, never code (the seed of a store, an import map, a template)
const DATA_TYPES = /json|importmap|template|x-tmpl|text\/html|text\/plain|text\/x-/i;

function head(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try { const buffer = Buffer.alloc(READ_BYTES); const n = fs.readSync(fd, buffer, 0, buffer.length, 0); return buffer.subarray(0, n).toString('utf8'); }
    finally { fs.closeSync(fd); }
  } catch { return ''; }
}

const attribute = (attrs, name) => {
  const match = new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(attrs);
  return match ? match[1] ?? match[2] ?? match[3] ?? '' : null;
};

const decoded = value => { try { return decodeURI(value); } catch { return value; } };

export function pageScripts(html) {
  const local = [], remote = [];
  let inline = 0;
  const text = String(html ?? '').replace(/<!--[\s\S]*?-->/g, '');
  for (const [, attrs, body] of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const type = (attribute(attrs, 'type') ?? '').trim().toLowerCase();
    if (type && DATA_TYPES.test(type) && !/babel|jsx/.test(type)) continue;
    const src = attribute(attrs, 'src');
    if (src != null && src.trim()) { const value = src.trim(); if (REMOTE.test(value)) remote.push(value); else local.push(decoded(value.replace(/^\.\//, '').split(/[?#]/)[0])); }
    else if (body.trim()) inline++;
  }
  return { local, remote, inline };
}

function describe(fact) {
  const list = files => files.slice(0, 4).join(', ') + (files.length > 4 ? ', …' : '');
  if (fact.local.length) return fact.page + ' loads ' + fact.local.length + ' script(s) of the folder (' + list(fact.local) + '): the app';
  if (fact.remote.length) return fact.page + ' loads ' + fact.remote.length + ' script(s) from the network and none of the folder';
  if (fact.inline) return fact.page + ' has only inline script and loads none of the folder';
  return fact.page + ' loads no script: a static page';
}

export function rankEntries(root, pages) {
  const facts = pages.map((page, order) => ({ page, order, ...pageScripts(head(path.join(root, page))) }));
  const score = fact => fact.local.length * 1000 + fact.remote.length * 10 + Math.min(fact.inline, 9);
  return facts.sort((a, b) => score(b) - score(a) || (a.page === 'index.html' ? -1 : b.page === 'index.html' ? 1 : 0) || a.order - b.order)
    .map(fact => ({ page: fact.page, local: fact.local, remote: fact.remote, inline: fact.inline, why: describe(fact) }));
}
