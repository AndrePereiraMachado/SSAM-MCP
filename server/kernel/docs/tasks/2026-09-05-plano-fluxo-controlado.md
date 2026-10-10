# Plano: fluxo controlado de entrega no SSAM Hybrid

Data: 2026-09-05
Estado: dados e primeiro pacote de cobertura de actions provados no SS5. Aceitacao com LLM e confianca dos hooks pendentes; contratos completos de negocio ainda pendentes.

Investigacao e evidencias: [relatorio tecnico](2026-09-05-investigacao-fluxo-controlado.md).
Foram confirmados dois falsos positivos do verificador (listas e indice), a ausencia de retomada por tarefa
e as entradas que permitem contornar o fluxo. A primeira entrega controlada inclui tambem o isolamento da interface
de app; estado e contrato sem fechar as rotas alternativas ainda nao constituem o tunel solicitado.

## Objetivo e limite

A LLM recebe um pedido, traduz a intencao e corrige diagnosticos. O Hybrid determina quais operacoes podem ocorrer,
executa o ciclo e decide se o pedido original foi cumprido. Uma mudanca de arquivo, nome de job ou lista de checks
nao pode redefinir a tarefa nem obter um sucesso equivalente ao do contrato original.

O produto controla o que aceita, executa e certifica. Nao controla o texto livre da LLM nem comandos externos ao
produto. Para impedir tambem desvios operacionais, o modo de entrega deve expor somente a interface desse fluxo,
com fontes/CLI de manutencao fora das permissoes da sessao de app. Uma skill sozinha nao proporciona esse isolamento.

## 1. Corrigir a base da verificacao

Antes de tornar o percurso obrigatorio, corrigir os verificadores que poderiam bloquear entregas corretas:

- Comparar tipos por significado: primitivo, entidade/structure de origem e composicao de listas, em vez de comparar
  apenas chaves de tipos de lista que podem mudar durante o merge.
- Unificar a leitura de indices entre bridge e headless.
- Registrar o resultado do merge imediatamente, antes dos checks posteriores. Uma falha de conferencia nunca pode
  apagar o fato de que o modulo ja foi alterado.
- Executar e guardar todas as conferencias independentes, mesmo quando um check nominal falhar.

Reusar Delivery, ModelSession, ModelHost e a bridge existentes. Nao criar um segundo mecanismo de entrega.
Aceitacao: listas semanticamente iguais passam; tipos diferentes falham; indices presentes sao encontrados; falha
posterior ao merge conserva a evidencia e informa inequivocamente que houve mutacao.

## 2. Introduzir uma tarefa persistente com contrato fixo

Cada tarefa recebe identidade, faixa, ambiente, chave do modulo, contrato normalizado, revisao da implementacao,
hashes e historico de transicoes. O contrato descreve o resultado pedido; o job e apenas uma implementacao candidata.
Persistir transicoes atomicamente, com exclusao por modulo, para retomada apos queda ou compactacao de contexto.

Estados propostos:

    pedido -> contrato definido -> preparacao -> validacao -> pronto para merge
           -> merge aplicado -> conferencia -> concluido

Erros de preparacao devolvem diagnosticos agregados e aceitam uma correcao da implementacao dentro do mesmo contrato.
Erros posteriores ao merge permitem conferir ou preparar uma correcao incremental, nunca repetir automaticamente a
criacao. Resposta de escrita desconhecida exige reconciliar o estado, sem reenvio automatico. Cancelamento e pausa
sao explicitos e nao significam conclusao.

Aceitacao: repetir uma chamada nao duplica elementos; duas execucoes concorrentes nao competem pelo mesmo modulo;
reiniciar o processo ou perder o contexto nao faz a tarefa esquecer o merge.

## 3. Vincular requisitos a obrigacoes verificaveis

Comecar com dados, onde o contrato ja pode ser preciso: entidades, atributos, tipos, comprimentos, obrigatoriedade,
records e indices. Reusar a spec declarativa existente como contrato normalizado e gerar o job a partir dela, sem
pedir que a LLM escreva uma segunda implementacao livre. A prova le o modulo contra todas as obrigacoes do contrato,
inclusive as omitidas por defeito do compilador, nao apenas contra as operacoes emitidas.

Depois ampliar para as actions do caso Incidents, usando o IR existente:

- assinaturas e retornos, inclusive listas de comentarios/historico;
- roles permitidas, propriedade do incidente e restricoes por entrada/campo;
- grafo de transicoes de status permitido;
- efeitos exigidos: auditoria, historico, comentario, alteracao de status e limites da transacao;
- significado de filtros e metricas, inclusive dia corrente versus janela movel de 24 horas;
- timer, periodicidade e comportamento de marcacao de SLA.

Preferir gerar guardas de autorizacao e efeitos padrao a partir de regras estruturadas, reutilizando a compilacao
existente. Complementar com verificacao do fluxo e testes comportamentais positivos/negativos; procurar palavras
como CheckRole no texto nao comprova autorizacao. Verify continua sendo gate de plataforma, nao prova de negocio.
Capacidade ainda nao suportada vira um bloqueio especifico; nao pode ser substituida silenciosamente por menos escopo.

Decisoes de negocio ausentes ou contraditorias exigem uma pergunta objetiva. Nao pedir nova aprovacao para escolhas
que o usuario ja forneceu. Revisao de requisito precisa de autorizacao do usuario registrada fora dos argumentos
controlados pela LLM; trocar o job nao cria essa autorizacao.

Aceitacao: Requester nao consegue atribuir responsavel nem por CreateIncident; listas nao podem virar contagens;
Today nao pode virar ultimas 24 horas; transicoes e visibilidade respeitam o contrato.

## 4. Substituir a interface normal por uma entrada controlada

A interface de app recebe o pedido/contrato e a implementacao candidata. O controlador executa automaticamente as
etapas permitidas e devolve somente estado, diagnosticos, evidencia e eventual decisao realmente necessaria.
A LLM nao escolhe entre apply, deliver, merge, rename ou um job vazio para contornar uma falha.

- Todas as escritas de entrega passam pelo controlador e ficam vinculadas a tarefa e revisao vigentes.
- A bridge verifica modulo, snapshot e permissao de operacao da tarefa; a restricao nao pode existir so no wrapper.
- Uma nova implementacao nao pode reduzir as obrigacoes originais.
- Um recibo de outra tarefa ou de um job vazio nao pode concluir a tarefa original.
- A manutencao conserva ferramentas de baixo nivel, em modo separado autorizado pelo usuario. Um argumento escrito
  pela propria LLM nao pode converter uma sessao de app em manutencao.

Migrar a entrada atual, aproveitar as implementacoes existentes e retirar as rotas antigas da interface de app.
Evitar manter dois caminhos equivalentes, um novo restrito e outro antigo livre.

Aceitacao: tentar uma operacao fora da etapa falha antes de qualquer mutacao e devolve a etapa correta.

## 5. Recuperar a prova original sem reaplicar

A retomada referencia a tarefa original, seu contrato e o recibo do merge. Pode obter novo snapshot e refazer a
conferencia, preservando o historico. Uma falha real permite produzir um delta de reparacao sob o mesmo contrato.
Sucesso exige todas as obrigacoes aplicaveis aceitas, sem pendencias escondidas.

O comprovante final distingue criacao, verificacao local, merge e validacao de negocio. Uma verificacao sem mutacao
pode ser util, mas nao pode se apresentar como entrega de uma implementacao que nao verificou.

Aceitacao: o caso de indice nao encontrado retoma a conferencia; o caso de lista com chave diferente nao altera o
retorno da action; um job vazio nao transforma a falha anterior em sucesso.

## 6. Testar desvios e medir a experiencia inteira

Transformar as duas interacoes de Incidents em testes de regressao do percurso, incluindo tentativas de:

- criar novos jobs para escapar de uma falha ou mudar o modulo/faixa;
- remover requisitos, reduzir checks ou substituir listas por contagens;
- repetir criacao apos merge aplicado;
- declarar concluida uma revisao diferente da efetivamente entregue;
- confundir Verify sem erros com autorizacao e regras de negocio corretas;
- interromper e retomar a execucao, inclusive com resultado de escrita incerto.

Rodar avaliacoes com LLM sem contexto, usando tanto o caso conhecido quanto variantes sem uma receita identica.
Medir recebimento ate conferencia final, separando tempo da LLM, ferramentas, espera e retrabalho. Para as seis tabelas,
a meta e 1-2 minutos; a prova local de 97 segundos nao substitui a medicao ao vivo. Metas de actions devem preservar
complexidade, autorizacao e verificacao. Registrar mediana e dispersao em repeticoes, nao apenas a melhor rodada.

## Ordem de entrega

Primeiro: verificadores corretos + estado persistente + retomada, com o contrato de dados de Incidents.
Segundo: bloquear rotas alternativas na interface de app e testar os desvios.
Terceiro: contrato de autorizacao/negocio das actions de Incidents e testes comportamentais.
Quarto: aceitar o percurso completo ao vivo e remover o caminho antigo da experiencia de entrega.

O primeiro marco so esta concluido quando a mesma tarefa sobrevive a uma falha depois do merge, termina usando
seu contrato original e a sessao de app nao consegue executar escritas pelas rotas alternativas. Estado persistente
e contrato, isoladamente, sao incrementos internos; ainda nao fecham o fluxo. O resultado esperado e menos decisoes operacionais para a LLM e menos caminhos publicos,
nao mais instrucoes de comportamento ou novos atalhos.


## Progresso da implementacao

- Correcao dos verificadores: listas comparadas por composicao e identidade global; indices nativos visiveis na
  bridge. Casos de merge headless preservam listas e recusam tipos diferentes.
- O mesmo Delivery agora tem tarefa duravel, pedido fixo, historico, hashes, reserva por ambiente/modulo e retomada.
  O diario da bridge grava o fato do merge antes da verificacao posterior. Resposta incerta exige reconciliacao;
  falha de conferencia nao repete a criacao. Reparacao incremental conserva contrato e tentativas anteriores.
- DataRequirements confere declaracoes independentemente dos ops emitidos. DataDelta reutiliza os objetos do
  snapshot. Foram exercitados campo omitido, texto curto, indice ausente, record errado e reparacao parcial.
- Interface de app com apenas context/propose_data/continue/status. O hook captura a mensagem original do usuario;
  cada chamada exige autorizacao de uso unico para os argumentos exatos. Mudancas de contrato precisam de novo
  input e aceitacao no cliente. A primeira interpretacao usa a autorizacao do pedido claro, sem pergunta redundante.
- Bridge e worker exigem credencial do controlador; armazenamento de autoridade protegido fora do workspace.
  allow_foreign_base foi removido. O perfil opcional ssam-app desativa ferramentas de manutencao e outros conectores,
  usando sandbox read-only. Perfil e skill instalados, sem alterar o perfil padrao nem migrar tarefas em andamento.
- Validacao local: 292/292 testes .NET na copia isolada, 8/8 testes Python do adaptador. O snapshot da suite preservou
  os arquivos versionados e as mudancas desta tarefa; os jobs nao versionados de outras sessoes ficaram fora.
  A remocao de data-contract-incidents.json no workspace foi preservada; o fixture de teste veio do HEAD somente
  na copia de validacao. Veja o escopo e os resultados no comprovante abaixo.
- Codex 0.153.4 carregou o perfil; a prova do sandbox recusou leitura privada, escrita no workspace e TCP direto
  a bridge. A integracao manual hook -> host -> MCP preservou o prompt com acentos e recusou reutilizar a autorizacao.
  Isso nao foi uma avaliacao com LLM nem significa que o usuario ja confiou nos hooks.
- SS5 atualizado: bridge autenticada e controlador/worker funcionando. Depois da autorizacao explicita do usuario,
  o laboratorio ZZDataContract / ZZDataContract_CS foi criado em 31,049 s, com publicacao apenas do modulo vazio.
- Prova viva pelo adaptador MCP: seis tabelas entregues em um merge, 365 verificacoes, zero erros/mensagens novos.
  Controller: 8,941 s; chamada continue: 9,474 s; fixture de operador, com contrato preparado: 11,887 s. Isso nao mede
  interpretacao ou conversa real com LLM. Cada entidade e cada um dos seis indices pedidos existem uma unica vez.
- Falhas injetadas depois de merges nativos reais: interrupcao de Verify e perda de resposta. As duas tarefas foram
  retomadas pelo CLI em outro processo sem repetir apply/merge. O diario reconciliou unknown -> applied. Os testes
  alteraram e restauraram somente a descricao de Category. Depois, a tarefa original de app retomou a conferencia
  em 1,023 s no controlador, conservando um unico merge e o contrato original.
- A prova encontrou resposta excessiva do MCP: 79.407 caracteres de evidencias completas. A projecao agora devolve
  1.586 caracteres nesse caso (-98%), conservando todos os diagnosticos de falha e a prova completa no checkpoint.
  A suite apos a correcao passou com 294/294 .NET e 8/8 Python. O controlador/worker do SS5 recebeu essa correcao;
  a bridge nativa e o modulo aberto foram preservados. Nenhuma alteracao no SS4.
- As tabelas e os merges de teste nao foram publicados. O modulo esta aberto e modificado no SS5. A prova com hooks
  e MCP foi conduzida por fixture de operador; nao simulou confianca do usuario nem uma conversa real com LLM.

Comprovante: [fluxo-controlado.json](../proofs/2026-09-05-fluxo-controlado.json).
Decisao: [ADR-015](../adr/ADR-015-fluxo-controlado.md). Uso: [APP.md](../APP.md).

Prova viva: [fluxo-controlado-live.json](../proofs/2026-09-05-fluxo-controlado-live.json).

### O que falta para aceitar o primeiro marco

1. O usuario revisar os hooks pelo /hooks do Codex no perfil ssam-app. A confianca depende do usuario; nao foi
   automatizada. A autorizacao para o laboratorio foi recebida e executada, e ja nao e um bloqueio.
2. Avaliar uma conversa real com LLM no perfil restrito, incluindo tentativas de desvio e tempo de interpretacao.
   O controlador, a retomada, o protocolo e o sandbox foram provados, mas ainda nao ha mediana nem dispersao do
   percurso completo pedido -> contrato -> entrega. Os 8,941 s da prova viva partem de contrato preparado.

O controlador de dados passou na prova viva. O marco completo continua pendente de aceitacao no cliente com LLM.
A ampliacao de actions registrada abaixo cobre declaracoes e politicas estruturadas. O contrato completo de
transicoes e efeitos das actions de Incidents ainda nao foi implementado nem certificado. A traducao inicial de linguagem natural continua sujeita a omissoes e ambiguidades:
a prova cobre o contrato normalizado visivel.

## Ampliação de cobertura: actions

- Contrato agora aceita dados, roles, exceptions e logic na mesma tarefa. `propose` substitui `propose_data`; a
  preparação é escolhida pelo controlador e as tarefas antigas de dados mantêm sua identidade.
- Políticas de autenticação, roles, parâmetros e propriedade de registros são expandidas para a lógica existente.
  Conferência independente de assinatura, tipos de listas, expressões, chamadas, filtros, SQL e grafo completo.
- Server/service/client, todas as formas de passos atuais de logic, casos de enfraquecimento de autorização,
  lista trocada por contagem, ordem de commit alterada e limite de ciclo alterado têm prova de regressão.
- Dez cenários percorrem guardas compiladas com identidades sintéticas. Reparação substitui só a action divergente;
  lista e contrato sobreviveram ao merge headless. Isso não é execução das actions no servidor.
- SS5: Coverage_CheckAssignee, Coverage_ListMine e Coverage_ReadCollections entregues no laboratório em um merge,
  217 verificações, zero mensagens novas, 6,625 s no controlador (contrato preparado). Retomada sem recriar/merge
  adicional e tarefa anterior de dados passaram. 323/323 .NET e 8/8 Python verdes. Perfil e skill atualizados.
- Nenhuma publicação das actions, nenhuma alteração nos módulos Incidents do usuário ou no SS4.

Evidências e limites: [cobertura-actions.json](../proofs/2026-09-05-cobertura-actions.json),
[ADR-016](../adr/ADR-016-contrato-actions.md) e [contrato de módulo](../CONTRATO-MODULO.md).

Próximo pacote: contratos próprios para transições e efeitos obrigatórios de negócio, incluindo o caso Incidents,
e testes em execução no servidor. Telas, integrações, timers/processos, conversa real com LLM e ativação no SS4
continuam fora da cobertura completa. Os números de testes não são uma porcentagem de cobertura total.


## Critério corrigido: matriz completa de widgets de action

O usuário recusou a amostra de três actions. Ela não é o gate de aceite. O escopo passou a exigir todos os nós
concretos de lógica aplicáveis a server/service/client actions, incluindo os contextos de tela, bloco e email,
além de tipos, parâmetros, variáveis, listas, estruturas/listas de estruturas e chamadas internas/remotas.

Concluído para a cobertura estrutural/nativa solicitada:

- 408/408 testes .NET e 8/8 Python; 67 contratos de matriz (63 positivos e 4 rejeições de contexto), mais
  3 negativos específicos para Decision Outcome fora de BPT. Os casos positivos exigem recarga, merge,
  idempotência e rejeição de uma alteração que ainda é válida para Verify. Actions de tela/bloco também são reparadas.
- 26 widgets concretos conferidos contra o catálogo extraído novamente das DLLs do SS5; 20 padrões de tipos,
  parâmetros/variáveis e as 11 operações de lista. O mapa falha se faltar um widget ou um caso aprovado.
- Prova viva pelo MCP: 46 actions em quatro módulos do laboratório (16 Service, 12 Reactive, 13 Mobile, 5 Traditional),
  3.978 verificações, zero mensagens novas, um merge por contrato. As quatro retomadas mantiveram tarefa/operação,
  sem segundo merge. Todos os recibos passaram no check-delivery.
- Soma das entregas no controlador: 37,057 s; chamadas MCP continue: 39,414 s. Contratos já preparados; não inclui
  interpretação pela LLM, montagem das fixtures nem publicação inicial dos módulos vazios.
- Módulos do laboratório: ZZDataContract_CS, ZZActionCoverage_UI, ZZActionCoverage_M e ZZActionCoverage_Web.
  As UIs receberam antes fixtures com handlers vazios conectados; o contrato controlado criou/substituiu os corpos.
  Somente os módulos iniciais foram publicados. Os corpos das actions não foram publicados nem executados.
- Instalação final no SS5, worker 44872, bridge mantida aberta. Skill validada; perfil mantém quatro ferramentas.
  SS4 e módulos Incidents do usuário preservados. Confiança de hooks/conversa real com LLM não foram simuladas.

Mapa gerado: [action-coverage.md](../mapa/action-coverage.md). Recibos e limites:
[cobertura-actions.json](../proofs/2026-09-05-cobertura-actions.json). Não há novos verbos nem outro motor de entrega.
A cobertura estrutural dos widgets não é certificação de execução funcional ou de regras de negócio.
