// Deterministic names for the prototype capture (docs/PROTOTIPO-NATIVO.md 2.3, 2.4, 2.5, 3.5).
// Every name is ASCII PascalCase derived from the user's own words (routes, titles, ids, README); nothing is invented.

import { singularOf } from './store.mjs';

export function ascii(value) {
  return String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// "meus-pedidos" -> "MeusPedidos", "Detalhes do produto" -> "DetalhesDoProduto", "successId" -> "SuccessId".
export function pascal(value) {
  const words = ascii(value).split(/[^A-Za-z0-9]+/).filter(Boolean);
  const name = words.map(word => word[0].toUpperCase() + word.slice(1)).join('');
  return /^[0-9]/.test(name) ? 'N' + name : name;
}

export function slug(value) {
  return ascii(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Modal type: the title slug without digits and '#' ("Atualizar pedido #1004" -> "atualizar-pedido").
export function modalSlug(title) {
  return slug(String(title ?? '').replace(/[#0-9]/g, ' '));
}

export function modalName(title) {
  return pascal(String(title ?? '').replace(/[#0-9]/g, ' '));
}

// Prefix (1.2): the <title> up to the first separator, in PascalCase ASCII; otherwise the folder name.
export function prefixFrom(title, folder) {
  const head = String(title ?? '').split(/[|\-–—:]/)[0].trim();
  const fromTitle = pascal(head);
  if (/^[A-Za-z][A-Za-z0-9]*$/.test(fromTitle)) return fromTitle;
  const fromFolder = pascal(folder);
  return /^[A-Za-z][A-Za-z0-9]*$/.test(fromFolder) ? fromFolder : 'Prototype';
}

export function language(lang) {
  return /^pt\b/i.test(String(lang ?? '')) ? 'pt' : 'en';
}

const WORDS = {
  pt: { notice: 'Aviso', noticeError: 'AvisoErro', close: 'Fechar', changed: 'Alterada', current: 'Atual' },
  en: { notice: 'Notice', noticeError: 'NoticeError', close: 'Close', changed: 'Changed', current: 'Current' }
};

export function words(lang) { return WORDS[language(lang)]; }

export function changedEvent(dimensionName, lang) { return dimensionName + words(lang).changed; }

// OutSystems system entities have fixed names; a prototype collection named after one keeps the platform word.
const SYSTEM_SINGULAR = { users: { pt: 'Usuario', en: 'User' }, user: { pt: 'Usuario', en: 'User' } };

export function singular(collection, lang) {
  const known = SYSTEM_SINGULAR[String(collection).toLowerCase()];
  if (known) return known[language(lang)];
  return entityStem(collection);
}

// The entity a collection becomes: every word of it in the singular, PascalCase (usuarios -> Usuario, imoveisFotos ->
// ImovelFoto), the same rule as the kernel's PrototypeNames.EntityStem.
export function entityStem(collection) {
  const words = ascii(collection).match(/[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])/g) ?? [];
  if (!words.length) return pascal(collection);
  return words.map(word => { const one = singularOf(word); return one[0].toUpperCase() + one.slice(1); }).join('');
}

// Record shown by the shell, selected by a dimension (2.5): "<Singular><Atual|Current>" (Users -> UsuarioAtual).
export function recordInputName(collection, lang) {
  const w = words(lang);
  const base = singular(collection, lang);
  return language(lang) === 'pt' ? base + w.current : w.current + base;
}

// Aggregate value shown by the shell (2.5): the collection without a trailing "Item(s)" (line items are named after
// their header) followed by the aggregated field (CarrinhoItem.Quantidade -> CarrinhoQuantidade).
export function aggregateInputName(collection, field, op) {
  const stem = String(collection).replace(/Items?$/, '') || String(collection);
  return stem + (op === 'count' ? 'Quantidade' : field);
}

export function uniqueName(base, taken) {
  let name = base, n = 2;
  while (taken.has(name)) name = base + n++;
  taken.add(name);
  return name;
}

function escapeRegExp(text) { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// README route table (2.3 source 3): a line with a name cell ^[A-Z][A-Za-z0-9]*$ and "<entry>#<route>" (or "<entry>/<path>").
export function readmeRoutes(text, entry) {
  const routes = [];
  if (!text) return routes;
  const entryName = String(entry).split('/').pop();
  const pattern = new RegExp('(?:^|[\\s(`|])' + escapeRegExp(entryName) + '(#[^\\s|`)]*|/[^\\s|`)]+)');
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(pattern);
    if (!match) continue;
    const cells = line.split('|').map(cell => cell.trim().replace(/^`|`$/g, ''));
    const name = cells.find(cell => /^[A-Z][A-Za-z0-9]*$/.test(cell));
    if (!name) continue;
    const target = match[1];
    routes.push({ name, route: target.startsWith('#') ? target.slice(1) : target });
  }
  return routes;
}
