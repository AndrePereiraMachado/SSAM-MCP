// Portuguese in a text, for the English-only guards of the server box (owner rule of 2026-10-15: every text SSAM shows a
// licensee is English only): agent-reconnecting-english.test.mjs and hosted-answers-english.test.mjs. The same detector
// as the agent box guard (agent/agent/tests/fixtures/portuguese.mjs), with the words of the hosted answers added. A
// finding is a token with an accented Latin letter (U+00C0..U+00FF without the signs x and /) or a token that is a common
// Portuguese word. Tokens split at white space, quotes, brackets and the operators of code ( ) { } [ ] , ; + = < > | ! ? *
// &; dots, slashes, backslashes, colons, hyphens and underscores stay inside a token, so paths, URLs, domains and
// identifiers are one token. Letters are compared without case. None of the words is an English word or abbreviation
// ("a", "e", "o", "do", "no", "so", "as", "me", "sim", "ate", "sob", "pare" and "grave" are left out for that reason).
// The detector is a floor: a Portuguese word without an accent that is not in the list passes.
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
  repita chamada sozinho reconecta janela conferir contato
  rede teste envio envios subida subidas saida saidas travou travaram chegou chegaram lenta perde boas bons
  apagar revogar conceder concessoes papeis aplicativo ambiente faixa conta conecte passe mande recusada lido
  enviado reservado rodou importador gerador portao
`.trim().split(/\s+/);
export const PORTUGUESE_WORDS = new Set(WORDS);
const ACCENTED = /[À-ÖØ-öø-ÿ]/u;
const SPLIT = /[\s'"`(){}[\],;+=<>|!?*&]+/u;
const EDGES = /^[^\p{L}]+|[^\p{L}]+$/gu;

// The Portuguese tokens of a text.
export function portuguese(text) {
  return String(text).split(SPLIT).map(piece => piece.replace(EDGES, '').toLowerCase())
    .filter(token => token && (ACCENTED.test(token) || PORTUGUESE_WORDS.has(token)));
}

// A bilingual line: an English sentence, " / ", then another sentence (the form the owner's rule of 2026-10-15 forbids).
export const BILINGUAL = /[.!?:)]\s+\/\s+\p{Lu}/u;
