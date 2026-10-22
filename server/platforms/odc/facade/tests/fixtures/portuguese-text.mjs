// Portuguese detector for the English-only guards (owner rule 15/10/2026: every text SSAM emits is English).
// A text is Portuguese when one of its prose words carries a Portuguese accent or is a common Portuguese word that is
// not also English or code. Words inside identifiers (paths, file names, dotted or snake/kebab names, ALL-CAPS codes)
// are not prose and never count: error codes are the contract, file names are names.
// Also extracts the string literals of a JS module (acorn tokens: comments and regular expressions are not literals)
// and of a C# file (own lexer: // and /* */ comments and # directives skipped; "...", @"...", $"..." and raw """).
import fs from 'node:fs';
import { tokenizer } from 'acorn';

const ACCENT = /[ãõçáéíóúâêôàÃÕÇÁÉÍÓÚÂÊÔÀ]/;
// Common Portuguese words that are not English words nor usual code tokens (accent-free spelling, lower case).
export const PORTUGUESE_WORDS = new Set((
  'nao voce voces usuario usuarios tambem entao esta estao estava sao arquivo arquivos pasta pastas faixa faixas recusado recusada '
  + 'recusados recusadas chamada chamadas ferramenta ferramentas peca abra conecte depois ainda agora aqui nada nenhum nenhuma sozinho '
  + 'porque quando onde dono versao padrao padroes sessao rodou rodar mostra ficam fica devem deve precisa isso isto esse essa este '
  + 'esses essas estes estas seus suas seu sua pelo pela pelos pelas uma umas uns dos das aos que foi foram cada outro outra outros '
  + 'outras sem para deste desta neste nesta nesse nessa desse dessa mesmo mesma mesmos mesmas pedido servidor cliente tela telas modulo '
  + 'modulos entidade entidades acao acoes antes sobre entre tudo muito ja tem veja faca fazer feito feita entregue entregues publicado '
  + 'publicada fechada fechado existe obrigatorio obrigatoria corrija leia repita espere feche reconecte reinicie palavras mudou nunca '
  + 'sempre nem assim qual quais quem como apenas enquanto abrir fechar gravar ler escrever publicar publique entregar conferir confira '
  + 'mudanca mudancas alteracao alteracoes mensagem mensagens resultado caminho nome nomes valor valores campo campos linha linhas aviso '
  + 'avisos erro erros recibo tarefa contrato janela pessoa agente numa algo novo novos novas antigo atual envia enviado lido aberto '
  + 'conectado ocupado ocupada pronta copia diferenca estado elemento elementos propriedade usos por com ou ao se nos no na em de do da '
  + 'um os as dele dela tenho gerar ambiente cancelar espera obra motivo proprio propria tente remova falhou etapa '
  + 'integrador compila recompilacao desactualizado registo fuga retidos lixo recolher saida sobrescreve captura assinatura '
  + 'atestada enviar envios conexao conexoes perde lenta equipe processo frio '
  // The words of a credential window (review english-junction F1: 'Guardar a senha' passed the list above).
  + 'gerada regenerar senha senhas guardar salvar credencial credenciais secreto secreta escolha confira informe adicione adicionar responda'
).split(/\s+/));
// Short words that are also English or code ("no", "as", "do", "um", "OS"): they count only within three words of
// another Portuguese word.
const WEAK = new Set('se nos no na em de do da um os as'.split(' '));

const strip = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

// Prose words of a text with their position; identifiers are dropped.
function proseWords(text) {
  const clean = text.replace(/https?:\/\/\S+/g, ' ').replace(/`([^`\n]*)`/g, (_, code) => {
    // A single code token is an identifier/accepted alias. Multiword generated examples remain prose.
    // Typed product placeholders are checked explicitly by portugueseIn before this step.
    return /^\S+$/.test(code) ? ' ' : code;
  });
  const words = [];
  for (const m of clean.matchAll(/[\p{L}\p{N}_]+(?:-[\p{L}\p{N}_]+)*/gu)) {
    const run = m[0], before = clean[m.index - 1] ?? ' ', after = clean[m.index + run.length] ?? ' ', next = clean[m.index + run.length + 1] ?? ' ';
    // Identifier context: a path, file name, dotted, snake, camel or ALL-CAPS name, a name with digits.
    if (/[./\\@_$#:]/.test(before) || /[\\/_@]/.test(after) || (after === '.' && /[\p{L}\p{N}]/u.test(next))) continue;
    if (/_/.test(run) || /\d/.test(run) || /[a-z][A-Z]/.test(run) || (/^[A-Z][A-Z-]+$/.test(run) && run.length > 1)) continue;
    for (const w of run.split('-')) if (w) words.push(w);
  }
  return words;
}

// null when the text reads as English; otherwise {words, sample} with the Portuguese words found.
export function portugueseIn(text) {
  if (typeof text !== 'string' || text.length < 2) return null;
  // Product placeholders are prose even when they resemble typed identifiers.
  const placeholders = text.match(/\bI?Tipo:(?:Nome|Name|@producerKey\/elementKey)|<Tipo>Signature/g) ?? [];
  if (placeholders.length) return { words: placeholders, sample: placeholders.join(' ') };
  // Explicit generated deletion examples are product prose, even when quoted as code.
  const examples = [...text.matchAll(/(?:e\.g\.\s*["'`]|`)([^`"'\n]+)/g)].map(m => m[1]);
  if (examples.some(example => /\bapagar\s/i.test(example))) return { words: ['apagar'], sample: examples.join(' ') };
  const words = proseWords(text);
  const found = [];
  words.forEach((w, k) => {
    if (ACCENT.test(w)) { found.push({ k, w, strong: true }); return; }
    const low = strip(w.toLowerCase());
    if (PORTUGUESE_WORDS.has(low)) found.push({ k, w, strong: !WEAK.has(low) });
  });
  const kept = found.filter(f => f.strong || found.some(g => g.strong && Math.abs(g.k - f.k) <= 3));
  if (!kept.length) return null;
  return { words: kept.map(f => f.w), sample: words.slice(Math.max(0, kept[0].k - 3), kept[0].k + 7).join(' ') };
}

// ---------- JS literals ----------
export function jsLiterals(source) {
  const out = [];
  let tokens;
  try {
    tokens = [...tokenizer(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, locations: true,
      allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true, allowImportExportEverywhere: true })];
  } catch (error) { throw new Error('acorn could not tokenize: ' + error.message); }
  const stack = [];
  const templates = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i], label = t.type.label;
    if (label === '`') {
      const top = templates[templates.length - 1];
      if (top && top.depth === stack.length) { templates.pop(); out.push({ line: top.line, text: top.parts.join('{}') }); }
      else templates.push({ parts: [], line: t.loc.start.line, depth: stack.length });
      continue;
    }
    if (label === 'template' || label === 'invalidTemplate') { const top = templates[templates.length - 1]; if (top) top.parts.push(t.value ?? ''); continue; }
    if (label === '(' || label === '{' || label === '${' || label === '[') { stack.push(label); continue; }
    if (label === ')' || label === '}' || label === ']') { stack.pop(); continue; }
    if (label === 'string' && typeof t.value === 'string') {
      // An object key is a name, not a text.
      const n = tokens[i + 1], p = tokens[i - 1];
      if (n?.type.label === ':' && (p?.type.label === '{' || p?.type.label === ',')) continue;
      // import/export specifiers are module paths.
      if (p?.type.label === 'from' || p?.type.keyword === 'import' || (p?.type.label === 'name' && p.value === 'from')) continue;
      out.push({ line: t.loc.start.line, text: t.value });
    }
  }
  return out;
}

// ---------- C# literals ----------
export function csLiterals(src) {
  const out = [];
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  const lineOf = pos => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= pos) lo = m; else hi = m - 1; } return lo + 1; };
  const n = src.length;
  const skipChar = j => { j++; while (j < n && src[j] !== "'") { if (src[j] === '\\') j++; if (src[j] === '\n') return j; j++; } return j + 1; };
  function readString(start) {
    let j = start, verbatim = false, interp = false;
    while (src[j] === '@' || src[j] === '$') { if (src[j] === '@') verbatim = true; else interp = true; j++; }
    if (src.startsWith('"""', j)) {
      let q = 0; while (src[j + q] === '"') q++;
      const k = src.indexOf('"'.repeat(q), j + q);
      return { end: k < 0 ? n : k + q, text: src.slice(j + q, k < 0 ? n : k) };
    }
    j++;
    let text = '', depth = 0;
    while (j < n) {
      const c = src[j];
      if (depth === 0) {
        if (verbatim) { if (c === '"') { if (src[j + 1] === '"') { text += '"'; j += 2; continue; } j++; break; } }
        else { if (c === '\\') { text += src.slice(j, j + 2); j += 2; continue; } if (c === '"') { j++; break; } if (c === '\n') break; }
        if (interp && c === '{') { if (src[j + 1] === '{') { text += '{'; j += 2; continue; } depth = 1; text += '{}'; j++; continue; }
        if (interp && c === '}' && src[j + 1] === '}') { text += '}'; j += 2; continue; }
        text += c; j++;
      } else {
        if (c === '"' || ((c === '@' || c === '$') && /["@$]/.test(src[j + 1] ?? ''))) {
          const r = readString(j); out.push({ line: lineOf(j), text: r.text }); j = r.end; continue;
        }
        if (c === "'") { j = skipChar(j); continue; }
        if (c === '{') depth++; else if (c === '}') depth--;
        j++;
      }
    }
    return { end: j, text: text.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\') };
  }
  let i = 0, lineStart = true;
  while (i < n) {
    const c = src[i];
    if (c === '\n') { lineStart = true; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (lineStart && c === '#') { const k = src.indexOf('\n', i); i = k < 0 ? n : k; continue; }
    lineStart = false;
    if (c === '/' && src[i + 1] === '/') { const k = src.indexOf('\n', i); i = k < 0 ? n : k; continue; }
    if (c === '/' && src[i + 1] === '*') { const k = src.indexOf('*/', i + 2); i = k < 0 ? n : k + 2; continue; }
    if (c === '"' || ((c === '@' || c === '$') && /["@$]/.test(src[i + 1] ?? ''))) {
      const at = i, r = readString(i); out.push({ line: lineOf(at), text: r.text }); i = r.end; continue;
    }
    if (c === "'") { i = skipChar(i); continue; }
    if (/[A-Za-z_0-9]/.test(c)) { while (i < n && /[A-Za-z0-9_]/.test(src[i])) i++; continue; }
    i++;
  }
  return out;
}

// Portuguese literals of one file: [{line, text, words}].
export function portugueseLiterals(file) {
  const src = fs.readFileSync(file, 'utf8');
  const literals = file.endsWith('.cs') ? csLiterals(src) : jsLiterals(src);
  const hits = [];
  for (const { line, text } of literals) { const pt = portugueseIn(text); if (pt) hits.push({ line, text, words: pt.words }); }
  return hits;
}

// Every string of a listed tool: name, title, description, and inside its schemas descriptions, titles, enums, defaults.
export function toolStrings(tool) {
  const out = [];
  const put = (field, value) => { if (typeof value === 'string') out.push({ field, value }); };
  put('name', tool.name); put('title', tool.title); put('description', tool.description); put('annotations.title', tool.annotations?.title);
  const walk = (node, at) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, at + '[' + i + ']')); return; }
    for (const [key, value] of Object.entries(node)) {
      const here = at + '.' + key;
      if (['description', 'title', 'default', 'const'].includes(key) && typeof value === 'string') put(here, value);
      else if (key === 'enum' && Array.isArray(value)) value.forEach((v, i) => put(here + '[' + i + ']', v));
      else if (key === 'examples' && Array.isArray(value)) value.forEach((v, i) => typeof v === 'string' ? put(here + '[' + i + ']', v) : walk(v, here + '[' + i + ']'));
      else if (key === 'properties' && value && typeof value === 'object') for (const [prop, child] of Object.entries(value)) { put(here + '.' + prop + '<key>', prop); walk(child, here + '.' + prop); }
      else walk(value, here);
    }
  };
  walk(tool.inputSchema, 'inputSchema');
  walk(tool.outputSchema, 'outputSchema');
  return out;
}
