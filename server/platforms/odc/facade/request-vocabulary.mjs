// Input vocabulary of the user's requests (Portuguese and English), matched by app-kinds.mjs and tool-routing.mjs and never
// emitted: only word tables live here (english-only-answers.test.mjs declares this file, and only this file, as vocabulary).

// ---- app kinds (app-kinds.mjs kindMentions): the kind words, the nouns a kind word qualifies, the direction words of a
// migration's target, the migration verbs, the clause and coordination words.
export const KIND_WORDS = {
  traditional: 'traditional tradicional tradicionais webresponsive',
  reactive: 'reactive reativa reativo reativas reativos crossdevice',
  mobile: 'mobile movel moveis celular smartphone phone android ios',
};
export const DIRECTION_WORDS = 'to into para pra em como as';
export const OBJECT_NOUNS = 'app apps aplicativo aplicativos aplicacao aplicacoes application applications module modules modulo modulos screen screens tela telas page pages '
  + 'pagina paginas form forms formulario formularios web block blocks bloco blocos widget widgets combobox dropdown layout frontend portal ui flow flows fluxo fluxos';
export const MIGRATION_WORDS = 'migrate migrating migration migrar migre migracao port porting portar porte convert converting conversion converter converta conversao '
  + 'transformar transforme rewrite reescrever';
export const CLAUSE_WORDS = 'and e then depois also tambem';
export const COORDINATION_WORDS = 'and e or ou as well a an the o um uma also tambem';

// ---- questions about SSAM's own records (tool-routing.mjs questionOf): the record nouns by class, and every other word a
// question may hold (question and read words, articles, prepositions, time words). A request with any other word is a
// build request.
export const RECORD_CLASSES = {
  friction: 'friction frictions friccao friccoes fricoes failure failures falha falhas error errors erro erros',
  receipt: 'receipt receipts recibo recibos journal journals result json',
  task: 'task tasks tarefa tarefas job jobs',
  history: 'history historico historicos operation operations operacao operacoes',
  status: 'delivery deliveries entrega entregas publish publication publications publicacao publicacoes build builds merge merges deploy deploys deployment deployments '
    + 'session sessao ssam',
};
export const STATUS_WORDS = 'status estado situacao andamento progress progresso';
export const QUESTION_WORDS = 'what which when did does do was were is are has have how show list see view read get check tell track follow monitor ver veja listar liste '
  + 'mostrar mostre ler leia consultar consulte verificar verifique acompanhar acompanhe conferir confira qual quais quando como esta estao me my minha meu minhas meus '
  + 'mine i the a an of in for from on at this that these those its it desta deste dessa desse da do das dos de na no nas nos em o os as um uma last latest recent recentes '
  + 'ultima ultimo ultimas ultimos previous anterior today hoje so far ate agora now all todas todos ja finished finish done feito feita happened aconteceu changed mudou '
  + 'sent mandei enviei registered registradas registrados recorded automatically automaticamente module modulo by por per com with que foi foram houve already yet still '
  + 'long longa longas longo longos terminou there any';
// The nouns after which a name is the name of an SSAM record or module ("module Orders", "task 1a2b").
export const NAME_LEADS = 'module modulo task tarefa job delivery entrega';
