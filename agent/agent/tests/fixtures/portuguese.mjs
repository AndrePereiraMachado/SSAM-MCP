// Portuguese in a text, for the English-only guard (english.test.mjs; owner rule of 2026-10-15: every text SSAM shows a
// licensee is English only). A finding is a token with an accented Latin letter (U+00C0..U+00FF without the signs x and
// /) or a token that is a common Portuguese word. Tokens split at white space, quotes, brackets and the operators of code
// ( ) { } [ ] , ; + = < > | ! ? * &, so a word glued to code ("Error('cancelado')") is still a token; dots, slashes,
// backslashes, colons, hyphens and underscores stay inside a token, so paths, URLs, domains and identifiers are one token
// ("example.com", "C:\SSAM-Agent", "docs/FASE2-AGENTE.md"). Letters are compared without case.
// The words are the ones Portuguese prose cannot avoid (articles, prepositions, pronouns, common verbs) and the nouns of
// the agent's own messages. None is an English word or an English abbreviation: "a", "e", "o", "do", "no", "so", "as",
// "me", "sim", "ate", "sob", "pare" and "grave" are left out for that reason.
const WORDS = `
  nao voce esta estava estao este estes estas isso isto essa esse esses pelo pela pelos pelas para com sem uma umas uns
  um dos das nos nas aos ao na em de da ou que se ja mais ainda antes depois quando tambem aqui agora sempre nunca cada
  todo toda todos todas tudo seu sua seus suas ele ela eles elas nada nenhum nenhuma outro outra outros outras mesmo mesma
  foi ser sao tem pode deve precisa falta faltam rode rodar veja peca pasta pastas arquivo arquivos servidor agente
  credencial erro falha aviso parado rodando conectado iniciado configurado configuracao versao porta pacote dados raiz
  sessao unica usuario maquina endereco invalido invalida cancelado alterado instalado encontrado conferidos apague mova
  estado desde ultima parada codigo conexao segundo plano processo opcao argumento inesperado desconhecida valor uso
  guia cliente dono passo proximo fique ficam fica entre sobre lista chave abra feche ligue extraia troque
  acrescente gravada gravado mostra mostrar mostrada quem onde porque
`.trim().split(/\s+/);
export const PORTUGUESE_WORDS = new Set(WORDS);
const ACCENTED = /[\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u00FF]/u;
const SPLIT = /[\s'"`(){}[\],;+=<>|!?*&]+/u;
const EDGES = /^[^\p{L}]+|[^\p{L}]+$/gu;

// [{line, token, text}] of a text; allow: exact substrings taken out before the scan (each one justified where it is
// passed).
export function portugueseIn(text, { allow = [] } = {}) {
  const findings = [];
  String(text).split(/\r?\n/).forEach((raw, index) => {
    let line = raw;
    for (const entry of allow) line = line.split(entry).join(' ');
    for (const piece of line.split(SPLIT)) {
      const token = piece.replace(EDGES, '').toLowerCase();
      if (token && (ACCENTED.test(token) || PORTUGUESE_WORDS.has(token))) findings.push({ line: index + 1, token, text: raw.trim().slice(0, 160) });
    }
  });
  return findings;
}

// One readable line per finding, for an assertion message.
export const describe = (where, findings) => findings.map(f => `${where}:${f.line} "${f.token}" in: ${f.text}`).join('\n');
