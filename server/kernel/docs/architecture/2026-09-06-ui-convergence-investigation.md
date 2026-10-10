# Fechamento de telas e blocks: investigação dirigida

Esta investigação usa o compilador instalado, os contratos do repositório, as APIs das DLLs locais
e execução publicada no laboratório SS5. Não habilita imports, arrays ou async no frontend de produto.
Os experimentos usam o contrato interno para testar o destino antes de desenhar a tradução da fonte.
O pedido de produto continua sendo HTML/CSS/JS; esses contratos não serão trabalho adicional da LLM.

## O que foi provado

| Questão | Evidência | Consequência para o compilador |
|---|---|---|
| JavaScript nativo espera uma Promise automaticamente? | Não. Uma Promise sem `$resolve`/`$reject` passa no Verify com IsAsynchronous=False. Os marcadores tornam o nó assíncrono e sobrevivem à recarga. | Emitir o protocolo de conclusão, com exatamente uma resolução/rejeição; aceitar `async` no parser sozinho seria incorreto. |
| Pode chamar uma server action diretamente em `$actions`? | Não. O Verify acusa JavascriptNode_UnknownParam. Uma client action com ExecuteServerAction nativo é aceita. | Gerar wrapper cliente tipado, com referência real à action e suas guardas existentes. Não fabricar endpoints HTTP ou duplicar lógica de servidor. |
| Toda action exposta ao JS retorna Promise? | Não. O callback síncrono Commit executou e retornou valor não thenable. O primeiro experimento registrou `.then is not a function`. | Normalizar retorno e exceção síncrona; testar ambos. |
| Loading pode aparecer antes do retorno? | Sim: Assign nativo antes da espera ficou visível no navegador. Callback nativo posterior atualizou resultado/erro. | Estado precisa ser publicado nos pontos de suspensão, não somente no final de toda a função. |
| É possível evitar resultado obsoleto ou atualização após desmontagem? | Sim no experimento: Object local por instância guarda geração/alive; callbacks conferem antes de Commit. Duas instâncias, resposta antiga, erro/retry e desmontagem/remontagem foram exercitados. | Gerenciar lifetime por instância. A política latest vale para leituras substituíveis explicitamente identificadas; não descartar silenciosamente efeitos de gravação. |
| Estruturas/listas entram diretamente no nó JS? | Não. Parâmetros de estrutura e lista geraram UnsupportedJSNodeInputVariableType/OutputVariableType, mesmo com estrutura pública. | Construir codecs tipados; não expor os objetos internos do framework como se fossem objetos JS comuns. |
| JSON padrão é transporte universal? | Não. A lista nativa preservou IDs 9223372036854775807 e 9007199254740993, mas serializá-los numericamente no cliente lançou NumberOverflowException. | Identificadores/Int64 devem atravessar como texto canônico tipado. `JSON.parse` comum de um número desse tamanho também não é suficiente. |
| Decimal do cliente preserva qualquer precisão de servidor? | Não neste caso: 123456789012345.6789 virou 123456789012345.67 antes da projeção para Text. | Valores exatos devem sair do servidor no formato exato. Converter em string depois da perda não recupera precisão. Não prometer Decimal arbitrário como JS Number. |
| Block externo é referência nativa ou cópia? | Duas instâncias no consumidor Reactive apontaram à mesma referência de block de outro módulo Reactive; atualização do produtor, refresh, reload e merge preservaram as chaves. | Imports de módulo resolvem símbolos/versões reais; não concatenam o HTML de um block publicado no consumidor. Prova cross-module de navegador ainda pendente. |
| Um block Mobile serve automaticamente para Reactive? | Não: InvalidReferenceInReactiveType reproduzido. | Vinculação precisa considerar tipo de módulo e contexto, além de nome/assinatura. |

Nove casos do modelo foram executados e recarregados. O JSON de prova diferencia casos positivos,
negativos esperados, experimento de navegador e recursos ainda não implementados.

## Listas: identidade é requisito semântico

O caso publicado contém uma lista de duas estruturas, IDs 1/2, captions A/B e um block com estado
em cada linha. Substituir a lista por uma nova lista desserializada, em ordem B/A, resetou os dois
blocks. Não equivale ao `key={row.Id}` esperado numa composição high code.

O renderer observado usa a identidade interna de cada item (`idOf`), além de índices em alguns caminhos;
o campo de negócio Id não se torna automaticamente essa identidade. A API IList examinada não expõe
uma propriedade de chave arbitrária. Existe também configuração de runtime PreserveListItemReactKey:
não alterar flags do ambiente como solução do compilador.

A prova separa ordenação nativa da substituição completa da coleção. Para ListSort de uma lista de
estrutura, `By = Id` usa o item da lambda. `By = Items.Current.Id` passou no Verify, mas o código
publicado leu o Current externo, retornando a mesma chave para todos os itens: a lista não ordenou.
O binder deve manter um escopo de item próprio para sort/filter/map, separado de estado e Current de
widgets. A ordenação nativa correta mudou A/B para B/A, mas também resetou os dois blocks neste
ambiente. Portanto ela ainda não resolve o requisito de estado por chave, mesmo preservando IDs internos
em parte do runtime. O comportamento foi registrado separadamente da substituição da lista.

Antes de liberar repetição com estado por chave, provar reconciliação de listas por chave usando
operações que preservem as identidades nativas dos itens sobreviventes. Cobrir inserção, remoção,
reordenação, alteração de conteúdo, lista nova equivalente, duplicatas e troca de página. Não escrever
IDs privados do runtime, não mover DOM depois de renderizar e não guardar estado global por nome de block.
Se o destino não preservar a semântica, o diagnóstico deve indicar o limite; não aceitar `key` decorativo.

## Arquitetura necessária: separar parsing, vinculação e emissão

Hoje `HtmlComponents.Compile(string)` resolve somente símbolos do próprio arquivo. O parser, a escolha
de tipos, a geração de handlers e o contrato nativo estão concentrados na mesma classe. A continuação
deve extrair etapas explícitas, reutilizando o backend de contrato/prova/merge existente:

1. **Fonte e grafo de arquivos.** Parsear HTML/CSS/JS em unidades com arquivo/linha/coluna. Resolver imports
   relativos no bundle, exports/aliases e dependências. Um arquivo importado duas vezes não duplica
   componentes. Rejeitar composição cíclica com o caminho completo; não executar top-level JS no build.
2. **Contexto nativo.** Ler do snapshot/produtores registrados os módulos, tipos, actions, blocks, inputs,
   outputs, eventos e placeholders. Tipagem e seleção usam identidade do produtor/elemento, não apenas
   nomes. Nomes iguais de dois produtores devem continuar distinguíveis. Incompatibilidade ou referência
   desatualizada deve ser detectada antes da mutação.
3. **Programa vinculado e tipado.** Resolver scopes de componente, função, callback, item e import.
   Inferir records/arrays a partir das assinaturas importadas e expressões; permitir anotação JS/JSDoc
   quando um array vazio não fornece informação. Gerar declarações de tipos para orientar a LLM sem
   obrigá-la a repetir o contrato do produtor. Tratar efeitos, valores exatos e identidade como parte do tipo.
4. **Emissão.** Gerar o contrato existente e seus codecs/wrappers, com ownership e nomes reservados por
   identidade. Eventos, lifecycle, estado e requests usam uma implementação compartilhada, não uma
   receita específica do Dashboard. Manter funções puras fora do scheduler de efeitos.
5. **Inspeção independente.** Conferir referências, tipos, árvores, handlers, argumentos e identidade no
   OML após recarga/merge. No navegador, conferir comportamento, estado e layout. Verify não prova ordem
   de resultados, precisão numérica, correta ordenação nem persistência de estado na lista.

O backend atual procura alguns elementos por primeiro nome compatível (`Verbs.Resolve`), e o escopo CSS
de HtmlComponents depende de Name/Kind. Para imports de produtores diferentes, ambos precisam evoluir
para identidade de origem; do contrário pode haver escolha errada de símbolo ou colisão de estilo.
O experimento também encontrou colisão de nome entre um widget Sort e um nó de action Sort: o Studio
renomeou o nó para Sort2 e a prova independente bloqueou a entrega. O alocador de nomes gerados precisa
considerar o namespace efetivo do modelo, não só o scope JavaScript.

## Async: preservar a linguagem sem inventar outro runtime de aplicação

A solução candidata tem um frame local por instância e callbacks nativos de commit. A prova Object
estabelece a passagem de identidade desse frame pelo nó JS, mas ainda não implementa o transformador
de funções. O compilador precisa ligar leituras/escritas das variáveis ao estado corrente, publicar
alterações antes de cada `await` e retomar com lifetime válido. Um closure contendo uma cópia inicial
de todo o estado não basta quando dois eventos se sobrepõem.

O lowering deve preservar ordem de avaliação, retorno, erro, try/catch/finally, helpers assíncronos e
emissão de eventos; executar testes diferenciais do JS original e do código gerado. Requests de leitura
podem ter política de substituição por chave; comandos de gravação precisam preservar resultado e
efeito, inclusive quando a tela fecha. Invalidar um callback não cancela nem desfaz uma chamada no servidor.

Os wrappers de action devem ser deduplicados pela identidade/assinatura e codec. O experimento usa um
wrapper para duas instâncias e confirma requests reais ao servidor, com atraso artificial na entrega
dos resultados para controlar a ordem. Não mede paralelismo nem latência do servidor.

## Imports pertencem ao fluxo controlado

`DeliveryReceipt.Sources` atualmente encerra a visita ao encontrar `.html`; portanto só o arquivo raiz
seria coberto. `AppSessions` recebe uma string uiSource e congela o contrato antes de ter um programa
vinculado a imports externos. Alterar só o parser deixaria recibos incompletos.

A fonte precisa entrar como bundle de arquivos autorados e ter uma closure de dependências congelada:
conteúdo, hashes, exportações e snapshots de produtores. Esse índice é gerado pelo Hybrid; não é outro
manifesto de bindings que a LLM escreve. Mesmos hashes/símbolos devem alimentar CLI e context/propose/
continue/status. Uma retomada não pode recompilar silenciosamente contra arquivos ou produtores novos.

Edições de fonte após diagnóstico precisam continuar na mesma tarefa, com revisão explícita do contrato
antes da próxima escrita. Durante resultado de merge desconhecido, preservar a tarefa congelada e
resolver o resultado primeiro. Preview/draft não pode virar um segundo caminho de entrega ou bypass.

## O Dashboard exige mais do que os três títulos iniciais

A revisão de `incidents-dashboard.bindings.json` encontrou quatro leituras: métricas, próximos ao SLA,
meus incidentes e recentes; três offsets/totais independentes; filtros de período, prioridade e busca;
links com parâmetros, estado de autenticação e atualização de dados. A fonte nova ainda recusa form,
select/option e não suporta estado composto inicializado por arrays/objetos. Esses são itens concretos
do fechamento, não capacidades implicitamente cobertas pelos testes antigos de widgets nativos.

Ordem de implementação:

1. Extrair o modelo de fonte/símbolos sem alterar o comportamento do componente já provado; adicionar
   imports de arquivos com aliases, deduplicação, source maps e hashes transitivos.
2. Vincular imports nativos e seus tipos no controlador; referências de módulos, incompatibilidades,
   propriedade de CSS e nomes gerados. Provar um mesmo block em dois módulos publicados.
3. Implementar codecs de records/arrays e estados de formulário, incluindo null/datas/IDs/precisão;
   controles select/form, navegação e eventos necessários ao Dashboard usam os widgets nativos.
4. Fechar identidade de listas com provas de mutação/refresh e paginação. Total não é tamanho da página;
   testar vazio, última página, filtro que reinicia só sua lista, ordem estável e retorno com IDs distintos.
5. Implementar lowering async/commit/lifetime e wrappers com os testes semânticos descritos acima.
6. Migrar o Dashboard real para o bundle high code, compondo blocks reutilizáveis. Comparar dados e
   operações com o servidor, estados loading/erro/vazio/login, layout desktop/mobile e ausência de
   regressão nas outras telas. Remover o manifesto legado desse caso somente quando a nova fonte o substitui.
7. Instalar o build final em SS4/SS5, comprovar versões e validar a entrega em cada faixa. O SS4 continua
   dependendo de reinício seguro autorizado para corrigir a credencial da bridge. Nenhum reinício nesta rodada.

Data/Logic high code permanece depois do fechamento UI. Nenhuma biblioteca nova de produto foi adicionada.
Os arquivos decompilados e os assets do runtime usados para investigação ficam fora do repositório.

## Reproduzir e conferir

- `scripts/probes/highcode/ui_interop_probe.py`: nove casos de modelo e recarga; sem publicação.
- `scripts/probes/highcode/ui_reference_probe.py <snapshot-lab-reactive>`: produtor distinto, duas
  instâncias, atualização de referência e merge; os dois módulos permanecem em artefatos privados.
- `scripts/probes/highcode/ui_async_lab.py`: gera apenas a spec do experimento em `.local/review/ui-interop`.
  Entrega/publicação são passos separados e restritos ao ZZHtmlDashboardReview_UI no SS5.
- `scripts/probes/highcode/ui_async_browser.cjs <url-lab> <pasta>`: requests nativos, async, precisão e
  identidade de listas. `ok` significa experimento executado; os campos `exact` e
  `stateFollowsBusinessKey` registram limitações, não são convertidos em sucesso de capacidade.
- Recibo durável e números finais: `docs/proofs/2026-09-06-ui-directed-investigation.json`.

O código do compilador não foi alterado nesta rodada; a suíte anterior 626/626 não foi reexecutada nem
usada como prova dos recursos novos. O resultado desta investigação é a arquitetura e as fronteiras
comprovadas para implementar o frontend, não uma alegação de cobertura completa de telas e blocks.

## Complemento: duas identidades diferentes na ordenação

Prova posterior no laboratório ZZHtmlImports_UI/ListIdentityProtocol, em
`docs/proofs/2026-09-06-ui-list-identity-protocol.json`:

- `IList` não expõe uma expressão de chave no Model API observado.
- `ListSort` normal reconstrói a coleção e atribui IDs novos aos itens.
- O protocolo exportado pelo runtime (`ImmutableBase.getData`, `ImmutableListWithTracking.sort`,
  `writePropagate` e um cache novo) ordenou preservando os IDs internos. O experimento chama métodos;
  não escreve campos privados, não modifica o DOM e não copia código do runtime para o produto.
- Preservar os IDs ainda não basta no ambiente observado: `IteratorPlaceholderContent` usa o ID no
  fragmento exterior, mas o wrapper interior usa a posição quando `PreserveListItemReactKey=false`.
- Com a flag ativa **antes de montar os itens usados pelo teste**, e com ordenação que conserva IDs,
  os estados 2/1 acompanham A/B → B/A → A/B como 2/1 → 1/2 → 2/1. O ListSort normal continua zerando
  os estados, mesmo com a flag ativa. As duas condições são necessárias nessa prova.
- Ativar a flag só depois de acumular estado troca o formato das chaves na primeira atualização e
  produz uma falsa conclusão sobre a ordenação. O script agora reinicializa os itens antes da medição.

A flag foi alterada somente dentro de um navegador isolado, encerrado depois da prova. Nenhuma
configuração do servidor foi alterada. Métodos exportados não equivalem automaticamente a uma API
pública suportada. O compilador ainda não usa esse protocolo: falta definir um contrato de renderização
por lista, validar a compatibilidade do adapter e provar inserção, remoção, atualização, recarga e páginas.
Não promover esse experimento a suporte de `key` com alteração global de configuração em tempo de execução.

## Complemento: atualização e reconciliação do conteúdo da lista

`scripts/probes/highcode/ui_list_reconcile_browser.cjs` executou um candidato limitado em objetos
tipados do runtime do laboratório. O candidato constrói uma coleção imutável antes do commit: valida
chaves, atualiza itens existentes por `set`, remove ausentes, acrescenta novos e ordena pela posição
pedida. Todos esses passos usam métodos exportados; não há acesso de escrita a campos privados.

A primeira execução revelou um terceiro aspecto: `writePropagate(data, new ListCache())` atualiza
o conteúdo subjacente, mas o wrapper que já leu os itens continua com seu próprio cache antigo.
Assim, `idOf` mostrava a ordem nova enquanto `getItem` ainda retornava o conteúdo anterior. Isso não
é uma base segura para reconciliação. O candidato corrigido chama `getCache().invalidate()` pelo
protocolo exportado e propaga esse cache ao concluir. A prova passou para:

- Atualização do conteúdo sem mudança de ID, reordenação, inserção e remoção.
- Lista nova equivalente, sem substituição dos IDs sobreviventes.
- Recusa de chave duplicada antes da mutação, mantendo a lista anterior intacta.
- Páginas sobrepostas: item sobrevivente conserva ID; item removido e reintroduzido recebe ID novo.
- Lista vazia e preenchimento posterior, sem ressuscitar identidades removidas.

Recibo: `docs/proofs/2026-09-06-ui-list-reconciliation-protocol.json`. Nenhuma configuração de ambiente
foi alterada. A prova usa objetos tipados locais no navegador e não comprova estado de widgets nem
uma API suportada. A condição do renderer descrita acima continua pendente. O frontend não recebeu
esse candidato; adquirir um contrato estável de renderização continua sendo requisito para `key`.
