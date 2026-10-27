// The text routes of ssam_discover (B2 of the plan "Texto do SSAM", docs/TEXTO-SSAM.md): an intent that creates or changes
// a screen, the module's data or an action gets, in the first answer, the route of the text form the module reads and writes
// (ssam-html/1, ssam-ddl/1, ssam-flow/1): the read call (ssam_map) and the ready delivery call of the lane (o11_deliver /
// studio_deliver with the html, spec or logic op in its text form), the slots, the owner's rules and the contract card.
//
//   ui.screen-html       a new screen or block: the document form of the html op (<screen>/<block>, B1)
//   ui.screen-html-edit  a change of an existing screen: ssam_map view html, then the html op {screen, basedOn, edit} (C1, C2)
//   data.ddl             entities, attributes, static entities, structures, indexes, variables: ssam_map view ddl, then
//                        the spec op {ddl} with only the statements that change (DL1, DL2)
//   logic.flow           an action's flow: ssam_map view flow, then the logic op {flow:[{text, basedOn}]} (LG1, LG2)
//
// The classifier is separate from the capability scoring and from the tool routes on purpose (the same reason as
// tool-routing.mjs): it keeps the verbs (create vs change), never reads keywords, synonyms or scores of the index, and adds
// one section; the matches, contracts and tools of an answer stay what they were. Pure: no index, no I/O.
import { normalize } from './catalog.mjs';
import { codeCall } from './ssam-code.mjs';
import { hostedContext } from './executor.mjs';
import { codeServedHosted } from './hosted/served.mjs';
const codeGrammar = (lane, part) => ({ tool: 'ssam_code', arguments: { lane, action: 'grammar', part } });

export const TEXT_ROUTE_SCHEMA = 'ssam-text-route/1';

// The cut rule of the plan (section 8): a part is wired in the MCP only when its fixed point closed at 100% on the corpus;
// otherwise it stays a reading. Measured on the junction (docs/TEXTO-SSAM.md): every reading is a fixed point and every
// way back closed its battery, so every route is wired. A route set to false answers its read and no delivery call.
export const WIRED = { 'ui.screen-html': true, 'ui.screen-html-edit': true, 'data.ddl': true, 'logic.flow': true };

// WIRED is a switch, not a label: a route set to false (1) answers in ssam_discover its read and no delivery call, (2) loses the
// ready delivery of its read (ssam_map view html: continuations.edit), and (3) has its write form refused by the deliveries and
// the headless job of this server (o11_deliver, studio_deliver, ssam_job/o11_job: TEXT_FORM_NOT_WIRED, before the kernel runs).
// The write form of each route, as an op of a job carries it (the kernel's rules: ScreenDocument.IsDocumentOp, ScreenHtmlEdit.
// IsEdit, the spec op's ddl, the logic op's flow).
// The space is the kernel's own (.NET \s: \t \n \v \f \r, U+0085 and the separators \p{Z}), never JavaScript's \s, which has no
// U+0085 and takes U+FEFF: with it a document that starts with U+0085 was no text form here and a document in the kernel (the
// re-check of the 24.1 fixes, w1-nel-document). text-routes.test.mjs and ScreenDocumentTests pin both sides to this class.
export const KERNEL_SPACE = '[\\t\\n\\v\\f\\r\\u0085\\p{Z}]';
const DOCUMENT = new RegExp(`^${KERNEL_SPACE}*(?:<!--[\\s\\S]*?-->${KERNEL_SPACE}*)*<(screen|block)(?:${KERNEL_SPACE}|[/>])`, 'u');
const plainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
// The order is the kernel's (ModelSession.Html): a parent is the visual fragment; then the edit of a reading (ScreenHtmlEdit.
// IsEdit), then the document (ScreenDocument.IsDocumentOp); only then data.components. A components key beside an edit or a
// document does not make it another form (the review of rounds 1 and 2: it slipped past a route set to false, and the kernel
// ran the document).
export function textFormOf(op) {
  if (!plainObject(op) || !plainObject(op.data)) return null;
  const data = op.data;
  if (op.op === 'logic' && Object.hasOwn(data, 'flow')) return 'logic.flow';
  if (op.op === 'spec' && Object.hasOwn(data, 'ddl')) return 'data.ddl';
  if (op.op !== 'html' || op.parent != null) return null;
  const document = typeof data.html === 'string' && DOCUMENT.test(data.html);
  if (data.edit != null || data.basedOn != null && (data.screen != null || !document)) return 'ui.screen-html-edit';
  return document ? 'ui.screen-html' : null;
}

// The refusal of a job (or the ops of one) that writes in a text form whose route is not wired, or null. A composite job
// ({jobs:[part, ...]}) is judged in its parts, as the kernel runs them (JobRunner.CollectOps): readPart(spec) answers the job of
// a part (its document); a part it cannot read while a route is off is refused, never passed (the kernel would run it).
export function textFormRefusal(job, wired = WIRED, { readPart } = {}) {
  if (Object.values(wired).every(v => v === true)) return null;
  const problems = [];
  const judge = (document, prefix, at, seen) => {
    if (plainObject(document) && Array.isArray(document.jobs)) {
      document.jobs.forEach((spec, k) => {
        const where = `${prefix}/jobs/${k}`;
        let part = null;
        try { part = typeof spec === 'string' && readPart && !seen.has(spec) ? readPart(spec) : null; } catch { part = null; }
        if (part == null) {
          problems.push({ op: null, pointer: where, code: 'TEXT_FORM_NOT_WIRED', severity: 'error',
            message: `part ${JSON.stringify(spec)} of a composite job is not read here, and a text route is off in this server (${Object.keys(wired).filter(r => wired[r] !== true).join(', ')}): its ops cannot be judged`,
            fix: 'send the ops of the parts in one job ({"ops": [...]}), or the parts one by one' });
          return;
        }
        judge(part, where, String(spec), new Set([...seen, spec]));
      });
      return;
    }
    const array = Array.isArray(document);
    const ops = array ? document : Array.isArray(document?.ops) ? document.ops : [];
    ops.forEach((op, i) => {
      const form = textFormOf(op);
      if (!form || wired[form] === true) return;
      problems.push({ op: i, pointer: (array ? prefix : prefix + '/ops') + '/' + i, code: 'TEXT_FORM_NOT_WIRED', severity: 'error', ...(at ? { part: at } : {}),
        message: `op #${i}${at ? ' of part ' + at : ''} writes ${ROUTES[form].form} (${form}), whose way back is not wired in this server: the text is read, never written`,
        fix: 'write the change with the JSON form of the op (the matches of ssam_discover); ' + ROUTES[form].form + ' stays a reading (ssam_map)' });
    });
  };
  judge(job, '', null, new Set());
  return problems.length ? { ok: false, code: 'TEXT_FORM_NOT_WIRED', error: problems.map(p => p.message).join(' | '), problems } : null;
}

// The part reader of a composite job file, as JobRunner.ResolveJobFile resolves a part: "job:<name>" is <name>.json beside the
// job (the kernel also looks in its roots; a part found only there is not read here, so it is refused while a route is off),
// any other spec a path beside the job or absolute.
export function partReader(jobFile, fsModule, pathModule) {
  const dir = pathModule.dirname(jobFile);
  return spec => {
    const file = spec.startsWith('job:') ? pathModule.join(dir, spec.slice(4) + '.json') : pathModule.isAbsolute(spec) ? spec : pathModule.join(dir, spec);
    if (!fsModule.existsSync(file)) return null;
    return JSON.parse(fsModule.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  };
}

// ---- lexicon (accent-free, lower case; a phrase is matched on whole words in order)
const words = list => list.split(/\s*,\s*/).filter(Boolean);
const UI_CONTAINERS = words('tela, telas, ecra, ecras, pagina, paginas, page, pages, screen, screens, bloco, blocos, block, blocks, webblock, popup, popups, '
  + 'modal, formulario, formularios, form, forms, dashboard, dashboards, painel, prototipo, prototipos, prototype, prototypes, mockup, mockups, maquete');
const UI_PARTS = words('botao, botoes, button, buttons, link, links, input, inputs, dropdown, dropdowns, combo, combobox, select, checkbox, checkboxes, '
  + 'switch, radio, textarea, label, labels, rotulo, rotulos, icone, icones, icon, icons, imagem, imagens, image, images, container, containers, card, cards, '
  + 'tabela, tabelas, table, tables, grid, lista, listas, list, lists, coluna, colunas, column, columns, css, estilo, estilos, style, styles, stylesheet, '
  + 'classe, classes, class, cor, cores, color, colors, colour, margem, margens, margin, margins, padding, fonte, font, alinhamento, espacamento, spacing, '
  + 'cabecalho, header, rodape, footer, menu, menus, titulo, title, html, widget, widgets, toast, filtro, filtros, filter, filters, busca, search, '
  + 'paginacao, pagination, aba, abas, tab, tabs, campo, campos, field, fields, layout, tema, theme, onclick, clique, click, navegacao, navigation, '
  + 'sidebar, navbar, breadcrumb, tooltip, badge, avatar, spinner, carrossel, carousel, grafico, chart, upload, conexao, conexoes, connection, connections, '
  + 'espaco, espacos, space, gap, aviso, avisos, negrito, bold, italico, italic, sublinhado, underline');
const DATA_CONTAINERS = words('entidade estatica, entidades estaticas, static entity, static entities, entidade, entidades, entity, entities, estrutura, '
  + 'estruturas, structure, structures, struct, estatica, estaticas, modelo de dados, data model, banco de dados, database, site property, site properties, '
  + 'client variable, client variables, variavel de cliente, variaveis de cliente, session variable, session variables, variavel de sessao, setting, settings, timer, timers');
// The length of a text attribute ("pra 1000 caracteres") names the data too.
const DATA_PARTS = words('atributo, atributos, attribute, attributes, indice, indices, index, indexes, unique, fk, foreign key, chave estrangeira, '
  + 'caracteres, caractere, characters, chars, obrigatorio, obrigatoria, obrigatorios, obrigatorias, mandatory, opcional, opcionais, optional, '
  + 'relacionamento, relacionamentos, relationship, relationships, registros da estatica, records of the static');
const LOGIC_CONTAINERS = words('server action, server actions, service action, service actions, client action, client actions, screen action, screen actions, '
  + 'data action, data actions, action server, action, actions, acao, acoes, logica, logic, fluxo, fluxos, flow, flows, funcao, function, rotina');
const LOGIC_PARTS = words('node, nodes, if, ifs, assign, assigns, foreach, for each, loop, raise, excecao, excecoes, exception, exceptions, exception handler, '
  + 'handler, tratador, chamada, chamadas, call, calls, conector, connector, sql, javascript, logmessage, parametro de entrada, parametro, parametros, '
  + 'input parameter, parameter, parameters, variavel local, variaveis locais, local variable, local variables, variavel, variaveis, variable, variables, '
  + 'condicao, condition, checagem, check, implementacao, implementation, ramo, branch, passo, step, end, return, '
  + 'devolver, devolve, devolva, retornar, retorna, retorne, returns');
// Objects that are not a text of this plan: a role, a module or app, a reference, a process, an integration, an agent.
const FOREIGN_OBJECTS = words('role, roles, papel, papeis, modulo, modulos, module, modules, aplicacao, aplicativo, app, apps, application, referencia, '
  + 'referencias, reference, references, dependencia, dependencias, dependency, dependencies, processo, process, bpt, agente, agent, conexao mcp, '
  + 'integracao, integration, api, rest, soap, wsdl, web service, tenant, ambiente, environment, extensao, extensoes, extension, extensions, dotnet, '
  + 'biblioteca externa, external library');
// Words that name an element of a screen OR of an action (an aggregate, a query, a message): only the container decides
// ("um aggregate na tela Pedidos", "a message in the Save action"); without one the request is not precise enough.
const AMBIGUOUS = words('aggregate, aggregates, agregado, agregados, consulta, consultas, query, queries, mensagem, mensagens, message, messages');
// The runtime around the module (an environment, a published app, a Service Center or Portal value, a database
// connection, a link, a debugger session): the operation tools answer it, never a text of the module.
const RUNTIME = /\b(debug|debugar|depurar|depure|service center|ambiente|environment|producao|production|stage|qa|dev database|development database|banco externo|external database|conexao de banco|database connection|breakpoint|snapshot|inspecionar|inspect|link|url|endereco|address|lifetime|portal|publicada|publicado|published|tenant)\b/;
// A site property, setting or timer changed without a word of its definition is its runtime value (Service Center, Portal).
const VALUE_HOLDERS = new Set(words('site property, site properties, setting, settings, timer, timers'));
const DEFINITION = /\b(tipo|type|default|padrao|descricao|description|nome|name|publica|public|secret|secreta|obrigatorio|mandatory|agendamento|schedule|prioridade|priority|timeout|action|acao)\b/;

const CREATE = new Set(words('criar, crie, cria, criando, crio, criem, fazer, faca, faz, montar, monte, construir, construa, gerar, gere, desenhar, desenhe, '
  + 'implementar, implemente, create, creating, build, make, generate, design, implement, new'));
// A prototype or a mockup imported or converted is a new screen (its import op is turned off, prototype-disabled.mjs): these
// verbs create only in a request that names one ("importar dados de um CSV" stays outside the texts).
const PROTOTYPE_WORDS = new Set(words('prototipo, prototipos, prototype, prototypes, mockup, mockups, maquete'));
const IMPORT = new Set(words('importar, importe, importa, converter, converta, converte, transformar, transforme, transforma, import, convert, transform, turn'));
const ADD = new Set(words('adicionar, adicione, adiciona, incluir, inclua, inclui, acrescentar, acrescente, acrescenta, inserir, insira, colocar, coloque, coloca, '
  + 'add, insert, include, put, append'));
const EDIT = new Set(words('alterar, altere, altera, mudar, mude, muda, corrigir, corrija, corrige, ajustar, ajuste, ajusta, editar, edite, edita, trocar, '
  + 'troque, troca, modificar, modifique, modifica, atualizar, atualize, atualiza, mexer, consertar, conserte, arrumar, arrume, melhorar, melhore, deixar, '
  + 'deixe, deixa, tirar, tire, religar, religue, restaurar, restaure, reescrever, reescreva, mostrar, mostre, exibir, exiba, '
  + 'esconder, esconda, ocultar, oculte, tornar, torne, torna, aumentar, aumente, aumenta, diminuir, diminua, diminui, reduzir, reduza, reduz, change, edit, modify, update, adjust, tweak, '
  + 'fix, move, reorder, relink, restore, rewrite, show, hide, display, increase, decrease, set'));
// "preciso de uma tela", "I need a screen": a new thing, unless another verb follows ("preciso corrigir a tela").
const NEED = new Set(words('preciso, precisamos, precisa, quero, queremos, need, needs, want, wants'));
const RENAME = new Set(words('renomear, renomeie, renomeia, rename'));
const MOVE = new Set(words('mover, mova, move, reordenar, reordene, reorder'));
// A read is ssam_map's own request; a text route is for writing.
const READ = new Set(words('ver, veja, vejo, listar, liste, ler, leia, consultar, consulte, olhar, see, view, read, list, inspecionar, inspect'));
// An operation on the running app or the Studio (open, test, run, publish, connect, debug): the tools answer it; in a mixed
// request ("abrir o módulo e criar a entidade") only the model clause gets a text route.
const OTHER = new Set(words('abrir, abra, abre, open, acessar, acesse, access, testar, teste, test, executar, execute, run, rodar, rode, disparar, dispare, '
  + 'publicar, publique, publica, publish, deploy, conectar, conecte, connect, debugar, depurar, debug'));
const DELETE = new Set(words('apagar, apague, apaga, excluir, exclua, exclui, deletar, delete, drop, remover, remova, remove, eliminar, elimine'));
// Adjectives of a new thing said without a verb ("uma tela nova", "a new screen").
const NEW_WORDS = new Set(words('nova, novo, novas, novos, new'));
const PURPOSE = new Set(words('cadastro, cadastros, listagem, listagens, detalhe, detalhes, detail, details, login, dashboard, perfil, profile, checkout, '
  + 'carrinho, catalogo, relatorio, report, home, inicio, busca, pesquisa'));
const PROBLEMS = words('sem css, sem estilo, quebrada, quebrado, desalinhado, desalinhada, desalinhados, errado, errada, bug, nao aparece, nao aparecem, '
  + 'feio, feia, broken, misaligned, wrong, missing');
// "a" is left out: in Portuguese it is the article far more often than the preposition ("criar a tela Pedidos").
const LOCATIVES = new Set(words('na, no, nas, nos, em, da, do, das, dos, dentro, numa, num, ao, entre, between, in, on, to, into, inside, within, of, from, at, onto'));
const SKIP = new Set(words('o, a, os, as, um, uma, uns, umas, the, an, my, meu, minha, nosso, nossa, este, esta, esse, essa, that, this, existente, existing, atual, current, '
  + 'de, do, da'));
// Requests outside these texts (each with its own capability or tool): Traditional Web, copies, records of data, a move to
// another module, a repoint. A prototype or a mockup is no longer one of them: its import is turned off
// (prototype-disabled.mjs), and its screens are written with the html op, the route of ui.screen-html.
const EXCLUDED = [/\b(tradicional|traditional|table records|web screen)\b/,
  /\b(duplicar|duplique|duplicate|copiar|copie|copia|copy|clonar|clone)\b/, /\b(reapontar|repoint|redirect|redirecionar|substituir|replace)\b/,
  /\b(outro modulo|another module|other module)\b/];
// Rows of data (records inserted, updated or deleted in a database) are not the model, unless they are the records of a
// static entity.
const ROWS = /\b(registros|registro|registos|records|record|linhas|rows|dados de teste|test data|de teste|de exemplo)\b/;
const STATIC = /\b(estatica|estaticas|static)\b/;
const CLAUSE_BREAKS = new Set(words('e, and, then, depois, entao, also, tambem'));
const FIELDS = new Set(words('campo, campos, field, fields'));
// A table said without a screen (no screen, form or block, no other part of one) is a table of the database, an entity:
// "crie as tabelas propostas no módulo _CS" (the owner's re-test of 2026-10-12 read it as a screen table, or as nothing).
const TABLES = new Set(words('tabela, tabelas, table, tables'));

const TERMS = [];
for (const [family, kind, list] of [['ui', 'container', UI_CONTAINERS], ['ui', 'part', UI_PARTS], ['data', 'container', DATA_CONTAINERS], ['data', 'part', DATA_PARTS],
  ['logic', 'container', LOGIC_CONTAINERS], ['logic', 'part', LOGIC_PARTS], ['any', 'part', AMBIGUOUS], ['foreign', 'container', FOREIGN_OBJECTS]]) for (const term of list) TERMS.push({ family, kind, term, parts: term.split(' ') });
TERMS.sort((a, b) => b.parts.length - a.parts.length); // the longest phrase first: "server action" before "action"

// Names the owner writes that look like the words of a family (the conferência of 2026-10-12): the attribute "Acao" read as
// "ação" (an action), "Texto" or "Titulo" as a part of a screen, CalcularMediaAvaliacoes not read at all. A name is a token
// that stands for an element, never a family word:
//  - a capitalized word, not the first, written without the accent its word takes ("Acao", "Funcao", "Logica");
//  - a capitalized part word, not the first ("o Texto da Nota", "o Titulo"): the containers keep their capital ("Server Action");
//  - a capitalized word followed by "obrigatório", "opcional" ("make Action mandatory");
//  - an action's name, a CamelCase word that starts with a verb (CalcularMediaAvaliacoes, GetQuoteTotal): an action.
const NAME = '_name_';
const ACCENTED = new Set(words('acao, acoes, funcao, funcoes, logica, logicas, excecao, excecoes, condicao, condicoes, variavel, variaveis, parametro, parametros, '
  + 'pagina, paginas, ecra, ecras, estatica, estaticas, indice, indices, botao, botoes, icone, icones, rotulo, rotulos, cabecalho, rodape, titulo, '
  + 'descricao, padrao, relatorio, catalogo, formulario, formularios, grafico, conexao, conexoes, implementacao, navegacao, paginacao, espacamento, '
  + 'alinhamento, espaco, espacos, negrito, italico, metodo, metodos, codigo, numero, usuario, cotacao'));
const PART_TERMS = new Set([...UI_PARTS, ...DATA_PARTS, ...LOGIC_PARTS, ...AMBIGUOUS].filter(t => !t.includes(' ')));
const REQUIRED = new Set(words('obrigatorio, obrigatoria, obrigatorios, obrigatorias, mandatory, required, opcional, opcionais, optional'));
const ACTION_NAME = new RegExp('^(?:' + ['Calcular', 'Recalcular', 'Registrar', 'Obter', 'Buscar', 'Salvar', 'Criar', 'Atualizar', 'Validar', 'Enviar', 'Gerar',
  'Listar', 'Carregar', 'Excluir', 'Remover', 'Aprovar', 'Rejeitar', 'Processar', 'Importar', 'Exportar', 'Sincronizar', 'Converter', 'Formatar', 'Verificar',
  'Checar', 'Contar', 'Somar', 'Filtrar', 'Ordenar', 'Montar', 'Preparar', 'Inicializar', 'Alterar', 'Definir', 'Gravar', 'Consultar', 'Pesquisar',
  'Incluir', 'Adicionar', 'Cancelar', 'Confirmar', 'Finalizar', 'Notificar', 'Agendar', 'Pagar', 'Avaliar', 'Aplicar', 'Limpar', 'Decidir', 'Trocar',
  'Get', 'Set', 'Create', 'Update', 'Delete', 'Calculate', 'Compute', 'Register', 'Save', 'Send', 'Validate', 'Load', 'Fetch', 'Process', 'Check', 'Count',
  'Sum', 'Filter', 'Sort', 'Build', 'Prepare', 'Init', 'Initialize', 'Remove', 'Cancel', 'Confirm', 'Approve', 'Reject', 'Notify', 'Apply', 'Parse',
  'Generate', 'Find', 'Search', 'Insert', 'Upsert', 'Refresh', 'Reset', 'Submit', 'Import', 'Export', 'Sync', 'Convert', 'Format'].join('|') + ')[A-Z0-9][A-Za-z0-9_]*$');

// Tokens (accent-free) with the clause each belongs to: a comma, a semicolon or a conjunction starts a new clause.
function lexOf(intent) {
  const raw = String(intent ?? '').split(/\s+/).filter(Boolean);
  const toks = []; const clauses = []; const capitals = []; let clause = 0;
  for (const [n, w] of raw.entries()) {
    const bare = w.normalize('NFC').toLowerCase().replace(/^["'“‘(]+|["'”’).,;:!?]+$/g, '');
    const word = w.normalize('NFC').replace(/^["'“‘(]+|["'”’).,;:!?]+$/g, '');
    // The flow node "nó" loses its accent in normalize() and would read as the preposition "no" (tool-routing.mjs).
    if (bare === 'nó' || bare === 'nós') { toks.push('node'); clauses.push(clause); capitals.push(false); }
    else if (n > 0 && ACTION_NAME.test(word) && !/[^\x00-\x7F]/.test(word)) { toks.push('action'); clauses.push(clause); capitals.push(false); }
    else {
      let first = true;
      for (const t of normalize(w).split(/[^a-z0-9_]+/)) if (t) {
        if (CLAUSE_BREAKS.has(t)) clause++;
        const capital = first && n > 0 && /^[A-Z]/.test(word);
        // Written without the accent its word takes, or a part word with a capital: the name of an element.
        const name = capital && (ACCENTED.has(t) && word.normalize('NFD') === word.normalize('NFC') && !/[^\x00-\x7F]/.test(word) || PART_TERMS.has(t));
        toks.push(name ? NAME : t); clauses.push(clause); capitals.push(capital); first = false;
      }
    }
    if (/[,;]["'”’)]*$/.test(w)) clause++;
  }
  // A capitalized word right before "obrigatório" or "opcional" names the attribute it qualifies.
  for (let i = 0; i + 1 < toks.length; i++) if (capitals[i] && REQUIRED.has(toks[i + 1])) toks[i] = NAME;
  return { toks, clauses };
}

// Every family mention, longest phrase first, one per position.
function mentionsOf(toks) {
  const taken = new Array(toks.length).fill(false); const out = [];
  for (const m of TERMS) for (let i = 0; i + m.parts.length <= toks.length; i++) {
    if (m.parts.every((p, k) => toks[i + k] === p && !taken[i + k])) { for (let k = 0; k < m.parts.length; k++) taken[i + k] = true; out.push({ ...m, pos: i, end: i + m.parts.length }); }
  }
  return out.sort((a, b) => a.pos - b.pos);
}
const verbKind = t => (RENAME.has(t) ? 'rename' : DELETE.has(t) ? 'delete' : MOVE.has(t) ? 'move' : CREATE.has(t) ? 'create' : ADD.has(t) ? 'add'
  : EDIT.has(t) ? 'edit' : READ.has(t) ? 'read' : NEED.has(t) ? 'need' : OTHER.has(t) ? 'other' : null);
// A mention right after a locative (up to three filler or name words between: "na tela", "on the Home screen").
function afterLocative(toks, m) {
  for (let k = m.pos - 1, seen = 0; k >= 0 && seen <= 3; k--, seen++) {
    if (LOCATIVES.has(toks[k])) return true;
    if (verbKind(toks[k])) return false;
  }
  return false;
}
const routeOfFamily = (family, mode) => (family === 'ui' ? (mode === 'create' ? 'ui.screen-html' : 'ui.screen-html-edit') : family === 'data' ? 'data.ddl' : family === 'logic' ? 'logic.flow' : null);

/**
 * The text route an intent names, or null. Deterministic: the same words give the same route.
 * @returns {{id: string, family: string, verb: string|null, object: string|null, container: string|null, also: string[], why: string[]}|null}
 */
export function classifyTextRoute(intent) {
  const { toks, clauses } = lexOf(intent);
  if (!toks.length) return null;
  const text = ' ' + toks.join(' ') + ' ';
  if (EXCLUDED.some(re => re.test(text))) return null;
  const all = mentionsOf(toks);
  const mentions = all.filter(m => m.family !== 'foreign');
  if (!mentions.length) return null;
  // Rows of data are no text of the module; in a request that creates or changes actions they are what the actions do
  // ("registro idempotente com lock colaborador", the owner's re-test of 2026-10-12): decided below, once the object is known.
  const rows = ROWS.test(text) && !STATIC.test(text);
  // The words of one clause, for the runtime check: "criar a entidade ... e publicar no QA" keeps its model clause.
  // The word right after an element noun is its name ("estrutura Endereco", "tela Home"): it never says a runtime word.
  const named = new Set(all.map(m => m.end));
  const clauseText = c => ' ' + toks.filter((_, i) => clauses[i] === c && !named.has(i)).join(' ') + ' ';
  // A need word stands for "create" only when no other verb comes before its object ("preciso corrigir a tela": corrigir).
  const imported = toks.some(t => PROTOTYPE_WORDS.has(t));
  const rawVerbs = toks.map((t, i) => ({ i, kind: verbKind(t) ?? (imported && IMPORT.has(t) ? 'create' : null), t })).filter(v => v.kind);
  const verbs = rawVerbs.filter((v, n) => v.kind !== 'need' || !rawVerbs.slice(n + 1).some(w => w.kind !== 'need' && w.i <= v.i + 3)).map(v => (v.kind === 'need' ? { ...v, kind: 'create' } : v));
  const firstAfter = (pos, list = all) => list.find(m => m.pos > pos) ?? null;
  const why = [];
  const containers = all.filter(m => m.kind === 'container' && afterLocative(toks, m));
  const anyContainer = containers.find(m => m.family !== 'foreign') ?? null;
  let family = null; let verb = null; let object = null; let mode = null;
  if (!verbs.length) {
    // No verb: a screen said with "nova"/"new" or with its purpose ("tela de cadastro de clientes") is a new screen; a screen
    // or a part of one said with a problem ("ta tudo sem css", "a tela de pedidos está desalinhada") is a correction.
    // Anything else is not named precisely enough.
    if (RUNTIME.test(text) || rows) return null;
    const screen = mentions.find(m => m.family === 'ui' && m.kind === 'container');
    const problem = PROBLEMS.find(p => text.includes(' ' + p + ' '));
    const part = mentions.find(m => m.family === 'ui');
    if (!screen && part && problem) { family = 'ui'; mode = 'edit'; why.push(part.term, problem); }
    else if (!screen) return null;
    else if (problem) { family = 'ui'; mode = 'edit'; why.push(screen.term, problem); }
    else if (toks.some(t => NEW_WORDS.has(t)) || toks.slice(screen.end, screen.end + 3).some(t => PURPOSE.has(t))) { family = 'ui'; mode = 'create'; why.push(screen.term); object = screen; }
    else return null;
  } else {
    // The lead verb: the first one that acts on a mention after it; an operation verb never leads (its tool answers).
    const lead = verbs.find(v => v.kind !== 'other' && firstAfter(v.i));
    if (!lead) return null;
    verb = lead.kind; why.push(lead.t);
    if (verb === 'read') return null;
    object = firstAfter(lead.i);
    if (!object) return null;
    if (object.family === 'foreign') return null; // "criar um role", "adicionar referência ao módulo", "criar um processo BPT"
    if (RUNTIME.test(clauseText(clauses[object.pos]))) return null; // a value in an environment, a link, a debugger session
    // A field without a screen (no screen, form or block named, no other part of one) is an attribute of the data:
    // "adiciona o campo Observacao na QuoteAudit".
    if (object.family === 'ui' && FIELDS.has(object.term) && !all.some(m => m.family === 'ui' && (m.kind === 'container' || !FIELDS.has(m.term))))
      object = { ...object, family: 'data' };
    // A table without a screen, form or block (and no other part of one) is an entity of the data, a container of its own.
    if (object.family === 'ui' && TABLES.has(object.term) && !all.some(m => m.family === 'ui' && m.pos !== object.pos && (m.kind === 'container' || !TABLES.has(m.term) && !FIELDS.has(m.term))))
      object = { ...object, family: 'data', kind: 'container' };
    // The container: the element itself when it is one, else the container after a locative (its own family first).
    const own = object.kind === 'container' && !afterLocative(toks, object);
    if (rows && !(own && object.family === 'logic')) return null;
    const container = own ? object : (containers.find(m => m.family === object.family && m.kind === 'container') ?? containers[0] ?? object);
    // A part of something outside these texts ("a cor da aplicação") is not a text of the module.
    if (container.family === 'foreign') return null;
    family = container.family === 'any' ? null : container.family;
    if (!family) return null; // an aggregate or a message without the screen or action it belongs to
    why.push(object.term); if (container !== object) why.push(container.term);
    // A screen, block or action itself renamed, moved or deleted is a refactoring (refactor.* keep the consumers); data
    // renamed, moved into a folder or dropped is a statement of the data text.
    if (['rename', 'delete', 'move'].includes(verb) && own && family !== 'data') return null;
    if (family === 'ui') mode = (verb === 'create' || verb === 'add') && own ? 'create' : 'edit';
    // A text without @key creates the action (a screen or data action names its owner: action Home.Save); a user exception
    // comes from its own op: not from this route.
    if (family === 'logic' && (verb === 'create' || verb === 'add') && /^(exception|exceptions|excecao|excecoes)$/.test(object.term)) return null;
    // A site property, setting or timer changed without a word of its definition is its value at runtime.
    if (family === 'data' && VALUE_HOLDERS.has(object.term) && !['create', 'add', 'rename', 'delete'].includes(verb) && !DEFINITION.test(text.replace(' ' + object.term + ' ', ' '))) return null;
  }
  const id = routeOfFamily(family, mode);
  if (!id) return null;
  // The other texts the intent also writes: a family named as the object of another verb ("criar a entidade e a action que
  // grava"), or, without a verb, every container it names ("tela de listagem: static entity PolicyStatus, entidade Policy...").
  const also = new Set();
  for (const v of verbs) { const m = firstAfter(v.i, mentions); if (m && m.family !== family && ['ui', 'data', 'logic'].includes(m.family) && m.kind === 'container' && !afterLocative(toks, m)) also.add(m.family); }
  if (!verbs.length) for (const m of mentions) if (m.family !== family && ['data', 'logic'].includes(m.family) && m.kind === 'container' && !afterLocative(toks, m)) also.add(m.family);
  // The data the actions carry, named anywhere in the request ("criar server actions com ... estruturas DTO", the owner's
  // re-test of 2026-10-12): its statements go in the same job, before the texts of the actions.
  if (family === 'logic') for (const m of mentions) if (m.family === 'data' && m.kind === 'container' && !afterLocative(toks, m)) also.add('data');
  const alsoIds = [...also].map(f => routeOfFamily(f, 'create')).filter(x => x && x !== id);
  // R4 (2026-10-24): a later verb that acts on an existing screen named after a locative ("adicionar o atributo Desconto na
  // entidade Pedido e mostrar na tela PedidoLista") also edits that screen: its ssam-html/1 edit rides in the same job.
  const leadAt = verbs.find(v => v.kind !== 'other' && firstAfter(v.i))?.i ?? -1;
  if (family !== 'ui') for (const v of verbs) {
    if (v.i <= leadAt || !['edit', 'add', 'create'].includes(v.kind)) continue;
    const m = firstAfter(v.i, mentions);
    if (m && m.family === 'ui' && m.kind === 'container' && afterLocative(toks, m) && !alsoIds.includes('ui.screen-html-edit')) { alsoIds.push('ui.screen-html-edit'); why.push(v.t, m.term); }
  }
  return { id, family, verb, object: object?.term ?? null, container: anyContainer?.term ?? null, also: alsoIds, why: [...new Set(why)] };
}

// ---- the section of the answer, per route and lane
const DELIVER = { o11: 'o11_deliver', odc: 'studio_deliver' };
function deliverCall(lane, op, { feature, owners, changes }) {
  return lane === 'o11'
    ? { tool: DELIVER.o11, arguments: { module: '<Module>', job: { ops: [op] } } }
    : { tool: DELIVER.odc, arguments: { feature, module: '<Module>', job: { ops: [op] }, owners, changes } };
}
// The basedOn placeholders of this section keep their bytes (the C07 sections of the first answer take the room the route
// leaves at the default budget: pacote-laneE-discover); the work packet, sized by levels, says which value of which read
// in full (text-packet.mjs FLOW_BASED_ON) and puts the value itself when it read the owner. A capture the answer read
// replaces CAPTURE_BASED_ON with its sourceSha256 (withCapture).
const FLOW_READ_BASED_ON = '<textSha of the read>';
const HTML_READ_BASED_ON = '<htmlSha256 of the read>';
export const CAPTURE_BASED_ON = '<sourceSha256 of the read>';
const mapCall = (lane, extra) => ({ tool: 'ssam_map', arguments: { lane, target: '<Module or capture.oml>', ...extra } });
const COMMON_RULES = [
  'One delivery: a refusal comes ONCE with every problem and the checked patch; apply the patch as it is (patch + basedOn), never the whole job again.',
  'Publish only with the person\'s own words: publish:true and authorize in the same call, or the publish tool afterwards.',
];
const ROUTES = {
  'ui.screen-html': {
    title: 'New screen or block written as ssam-html/1 (the document form of the html op)',
    form: 'ssam-html/1', pointer: 'html.document',
    read: lane => ({ tool: 'ssam_discover', arguments: { lane, intent: '<the request>', app: '<Module>', packet: true } }),
    readWhy: 'the UI work packet: entities and attributes with types, actions with signatures, screens with inputs, blocks with their contract, the team rules; to copy a layout, ssam_map {view:"html", screen:"<an existing screen>"}',
    op: () => ({ op: 'html', data: { html: '<screen name="<Screen>" roles="<Role>" actions="<ScreenAction>"><var name="<Var>" type="Text"/><aggregate name="Get<Entity>" from="<Entity>" sort="<Entity>.<Attribute>" max="50"/><Block name="<Layout>"><slot name="MainContent">...</slot></Block></screen>' } }),
    names: { feature: '<Screen>', owners: ['<Screen>'], changes: ['<Screen> created'] },
    slots: { Screen: 'the new screen (or <block name> for a block)', Layout: 'the layout block of the module (LayoutTopMenu, LayoutBase...)', Entity: 'an entity of the module or of a referenced producer; a new one is a spec op before the html op in the same job', ScreenAction: 'each screen action named in actions="..." is declared by a logic op of the same job (kind screen, owner IMobileScreen:<Screen>)' },
    rules: ['Write the screen as ssam_map view html reads one: the same tags, attributes, names and os-<Property>; data by <aggregate> or a data action (filter, sort, join and max in the aggregate), never JavaScript or JSON.',
      'U1: a condition is <div if>/<div else>, never os-Visible; a new Visible, script or foreign iteration (v-for...) is refused with the patch.',
      'Reuse the app\'s blocks and the OutSystems UI classes first; a table first, no ornament (no card or icon tiles unless asked).',
      'CSS: a <style> of the document is that screen\'s style sheet, as written (or data.css); CSS several screens share goes once in <style scope="theme">. A line of text with bindings ("Hoje · {{ X }}") is one Expression; a class without a rule comes back as a warning.',
      'Several screens: one html op per screen in the same job; navigation between them resolves by name.'],
  },
  'ui.screen-html-edit': {
    title: 'Change of an existing screen or block through its ssam-html/1 reading (read, edit only what changes)',
    form: 'ssam-html/1', pointer: 'html.document',
    read: lane => mapCall(lane, { view: 'html', screen: '<Screen>' }),
    readWhy: 'the screen as ssam-html/1 with k on every element and basedOn; its continuations.edit is this delivery, ready',
    op: () => ({ op: 'html', data: { screen: '<Screen>', basedOn: { capture: CAPTURE_BASED_ON, html: HTML_READ_BASED_ON }, edit: ['<the changed element, whole, with its k>'] } }),
    names: { feature: '<Screen> (change)', owners: ['<Screen>'], changes: ['<what changes in the screen>'] },
    slots: { Screen: 'the screen or block read (name, Kind:Name or @key)', edit: 'only the elements that changed, each whole with its k (an If with its <div else>; the <style> alone); a new element has no k; a removed one is left out of its parent; an element with its k under another parent moves there' },
    rules: ['Read once, edit in context: two calls (the read and this delivery); never resend the whole screen to change one element.',
      'Everything not sent keeps its ObjectKey; the answer brings the next basedOn for a second correction.',
      'An existing Visible, ForEach or JavaScript is kept and listed; a new one is refused with the patch (an If, a List action, a named client action).'],
  },
  'data.ddl': {
    title: 'Data of the module (entities, attributes, static entities, structures, indexes, variables, timers) as ssam-ddl/1 text',
    form: 'ssam-ddl/1', pointer: 'spec.ddl',
    read: lane => mapCall(lane, { view: 'ddl', element: '<Entity>' }),
    readWhy: 'the data text with an -- @key on every element (without element: every block, in pages); new elements need no read, changes do',
    op: () => ({ op: 'spec', data: { basedOn: CAPTURE_BASED_ON, ddl: '<only the statements that change, as read, with their -- @key; new ones without a key>' } }),
    names: { feature: '<Entity>', owners: ['<Entity>'], changes: ['<what changes in the data>'] },
    slots: { ddl: 'create entity / create static entity ... values / type X = {...} / create unique index / site property / client variable / timer, OutSystems types and values (Text(120), Order Identifier, "New"); drop <what> <Name>; -- @key deletes' },
    rules: ['The same @key with another name is a rename (never delete and create); a statement without a key is new; an attribute or record left out of a statement sent whole is deleted.',
      'Never create an entity implicitly: a name that does not exist is refused with the nearest one.',
      'A delete of an element in use is refused with its uses (DELETE_HAS_CONSUMERS); renaming keeps the type (typeKept).',
      'Static entity: Id Integer identifier required (never auto, no index); a record may leave out Id, Label and Order: next id, its name, its position.'],
  },
  'logic.flow': {
    title: 'An action\'s flow as ssam-flow/1 text (read the action whole, send the edited text)',
    form: 'ssam-flow/1', pointer: 'logic.flow',
    read: lane => mapCall(lane, { view: 'flow', element: '<Action>' }),
    readWhy: 'the action whole with an @id on every node, parameter and local, fixedPoint and textSha (a list in element reads several actions); a new action needs no read',
    op: () => ({ op: 'logic', data: { flow: [{ text: '<the edited ssam-flow/1 text, with the @ids of the read>', basedOn: FLOW_READ_BASED_ON }] } }),
    names: { feature: '<Action>', owners: ['<Action>'], changes: ['<what changes in the action>'] },
    slots: { text: 'a line with its @id keeps its element; a line without @id is new; a removed line is a removed element; a header without @key creates the action (no basedOn): server action Name, action <Screen>.Name, data action <Screen>.Name', Action: 'the action (@key, Flow/Screen/Action or its name)' },
    rules: ['Send each changed action WHOLE as read, with the change: a line left out is deleted (a gap in the @ids is refused unless removes:true); the kernel then writes only what changed (set, create, link, delete, rename, move) and the action read again must be the text.',
      'T1/T2: a foreach that only filters, maps or accumulates is refused with the List action as the patch; a new JavaScript only in an isolated, named client action.',
      'A new screen, block or data action names its owner (action <Screen>.Name); a screen created in the same job comes first (its html op before this op).'],
  },
};
export const TEXT_ROUTE_IDS = Object.keys(ROUTES);

/**
 * The section for an intent on a lane: {schema, id, title, wired, form, read, call, slots, rules, contract, also, why}, or null.
 * `slice(pointer)` returns the contract node of the lane index (contractSlice), or undefined.
 */
export function textRouteSection(intent, lane, { slice = () => undefined, cardBytes = 4096, capture = null } = {}) {
  const route = classifyTextRoute(intent);
  if (!route) return null;
  return sectionOf(route, lane, { slice, cardBytes, capture });
}
// capture {file, sourceSha256}: the capture the answer read (discover with app); its file and hash take the place of the
// placeholders of the read and of every basedOn that is the capture's (ddl, the capture of an html edit). A flow's textSha
// comes only from its read (the work packet reads it).
function withCapture(value, capture) {
  if (!capture?.file || !/^[a-f0-9]{64}$/.test(String(capture.sourceSha256 ?? ''))) return value;
  const walk = v => Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) =>
    [k, k === 'target' && x === '<Module or capture.oml>' ? capture.file : x === CAPTURE_BASED_ON ? capture.sourceSha256 : walk(x)])) : v;
  const out = walk(value);
  if (out?.tool === 'ssam_map' && out.arguments && !out.arguments.expectedSourceSha256) out.arguments = { ...out.arguments, expectedSourceSha256: capture.sourceSha256 };
  return out;
}
export function sectionOf(route, lane, { slice = () => undefined, cardBytes = 4096, wired = WIRED[route.id] === true, capture = null } = {}) {
  const r = ROUTES[route.id];
  const card = contractCard(slice(r.pointer), cardBytes);
  const read = withCapture(r.read(lane), capture);
  const call = wired ? withCapture(deliverCall(lane, r.op(), r.names), capture) : null;
  return {
    schema: TEXT_ROUTE_SCHEMA, id: route.id, title: r.title, wired, form: r.form,
    read, readWhy: r.readWhy,
    call,
    // The same read and delivery as ONE tool with one word for both (ssam_code, ssam-code.mjs): what a model calls.
    // a7 (review B1, the family of K1): while ssam_code is unavailable on the hosted server (hosted/tools.json), a hosted
    // route names only the read and the delivery call of its lane (read, call), never the code form. a8: served hosted, the
    // code form is there too (hosted/served.mjs).
    ...(wired && (!hostedContext() || codeServedHosted()) ? { code: { read: route.id === 'ui.screen-html' ? codeGrammar(lane, 'html') : codeCall(read), write: codeCall(call) } } : {}),
    ...(wired ? {} : { note: 'only reading: the way back of this text is not wired in the MCP (the cut rule of the plan: its fixed point did not close at 100%); write with the JSON op of the matches' }),
    slots: r.slots, rules: [...r.rules, ...COMMON_RULES],
    contract: card ? { pointer: r.pointer, card } : { pointer: r.pointer, expand: `ssam_discover {lane:"${lane}", expand:"contract:${r.pointer}"}` },
    ...(route.also.length ? { also: route.also } : {}),
    why: route.why,
  };
}
// The contract slice as a card within cardBytes: a string as it is (cut at a word), an object key by key in its order
// while it fits, the keys left out named with the expansion that returns them.
function contractCard(node, cardBytes) {
  if (node == null) return null;
  const size = v => Buffer.byteLength(JSON.stringify(v), 'utf8');
  if (typeof node === 'string') return size(node) <= cardBytes ? node : node.slice(0, Math.max(0, cardBytes - 64)).replace(/\s+\S*$/, '') + ' ...';
  if (typeof node !== 'object' || Array.isArray(node)) return size(node) <= cardBytes ? node : null;
  if (node.expand && node.keys) return null; // already reduced to its keys by contractSlice
  const out = {}; const left = [];
  for (const [k, v] of Object.entries(node)) { if (size({ ...out, [k]: v }) <= cardBytes - 96) out[k] = v; else left.push(k); }
  if (left.length) out.omitted = left;
  return Object.keys(out).length ? out : null;
}

// The forms of the section from the richest down: whole; without the card (its pointer and expansion); the call alone
// (id, wired, read, call, why). The call is the part an answer never loses while it fits.
export function sectionLevels(section) {
  if (!section) return [];
  if (!section.contract?.card) {
    const minimal = { schema: section.schema, id: section.id, wired: section.wired, read: section.read, call: section.call, why: section.why,
      note: 'reduced by budget: slots, rules and the contract come with a larger budgetBytes' };
    return [section, minimal];
  }
  const { card: _card, ...pointer } = section.contract ?? {};
  const lean = { ...section, contract: { ...pointer, expand: `ssam_discover {expand:"contract:${section.contract?.pointer}"}` } };
  const minimal = { schema: section.schema, id: section.id, wired: section.wired, read: section.read, call: section.call, why: section.why,
    note: 'reduced by budget: slots, rules and the contract card come with a larger budgetBytes' };
  return [section, lean, minimal];
}
