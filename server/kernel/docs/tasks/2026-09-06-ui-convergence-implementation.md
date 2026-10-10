# Implementação da convergência UI

Objetivo: autoria de telas e blocks com HTML/CSS/JS, componentes nativos reutilizáveis e Dashboard real
por essa entrada. A análise que orienta as etapas está em
`docs/architecture/2026-09-06-ui-convergence-investigation.md`.

## 1. Arquivos e imports de componentes

Implementado:

- `UiSourceBundle` congela arquivos; `UiSourceProgram` separa parsing e resolução de símbolos da emissão.
- Imports HTML nomeados/default, aliases, dependências transitivas e deduplicação da definição nativa.
- Exports com o mesmo nome em arquivos diferentes têm identidades distintas; aliases conservam identidade.
- Componentes importados são resolvidos pela grafia JavaScript, preservando o `<button>` HTML quando há
  um componente `Button`. Telas não alcançadas nos arquivos importados não entram no contrato gerado.
- `propose.uiSource` aceita texto ou `{entry, files}` no mesmo fluxo de quatro ferramentas.
- Todos os arquivos físicos importados entram no recibo. O controlador recusa fontes divergentes da
  revisão congelada antes da primeira escrita e mantém os conteúdos originais durante a retomada.
- Documentação de sintaxe, caminhos, identidades e limites em `docs/UI-HIGH-CODE.md`.

Provas já executadas: 43 testes focados .NET, 10 do protocolo Python, entrega do bundle de três arquivos
no laboratório SS5 e prova de navegador com estados independentes, slots, CSS e 390 px sem overflow.
Artefatos locais: `.local/review/import-deliver.json`, `import-publish.json`, `import-browser/`.
A regressão ampla terminou 639/640; o teste de transporte do worker passou no reteste 4/4 depois de
isolar seu heap do processo de testes. O worker de produto não mudou. Não houve outra rodada ampla após
essa alteração exclusiva do teste. A instalação normal foi confirmada em SS4/SS5, com Core idêntico;
o CLI normal do SS5 entregou `unchanged=true`, 318 checks e três hashes de fonte. Recibo completo:
`docs/proofs/2026-09-06-ui-component-imports.json`. O GUI do SS4 não foi reiniciado.

## 2. Imports de blocks nativos de outros módulos

Implementado para blocks de referências registradas, com provas vivas passadas:

- Imports nomeados/default `outsystems:Modulo/Flow[/Block]`, resolvidos pela assinatura do snapshot.
- Instâncias nativas; nenhuma cópia da definição do produtor. Inputs, defaults, eventos e slots reais.
- Chave global, chave/hash da referência e assinatura entram na prova independente e no checkpoint.
- `OriginalName` público resolve nomes do produtor mesmo quando o Studio renomeia o flow no consumidor.
  A prova viva reproduziu `MainFlow` do produtor como `MainFlow2` no consumidor; não houve ajuste na fonte.
- `NativeImports` no ZZHtmlDashboardReview_UI importa Card e Pagination de OutSystemsUI: callbacks,
  avanço/retorno/última página, viewport 390 px e nenhum erro JavaScript no navegador.
- `SharedComponents` no novo laboratório ZZHtmlImports_UI importa CounterCard de ZZHtmlDashboardReview_UI:
  duas instâncias com estado 2/1, seis eventos recebidos incluindo sequência 3/1/2, CSS do produtor e
  slots do consumidor. Verify zero mensagens e prova no navegador passada.
- A aquisição da referência para esse laboratório foi preparação explícita de manutenção. O frontend
  ainda exige referências registradas; não declarar aquisição automática de dependências.

Recibo: `docs/proofs/2026-09-06-ui-native-module-imports.json`. Regressão ampla 647/647 em 41m28s.
Após os ajustes finais, os focados passaram 51/52: o helper do novo teste de clonagem omitia dois
parâmetros opcionais da API. Helper corrigido; os nove testes de imports passaram no reteste em 27s,
incluindo um produtor clonado e o alias de flow criado automaticamente no consumidor. Não houve outra
rodada ampla após os ajustes finais de OriginalName e diagnóstico.
A instalação normal em SS4/SS5 já recebeu este estágio, com Core idêntico e workers respondendo.
O CLI normal do SS5 confirmou `unchanged=true`, 286 checks e check-delivery aceito no consumidor.
Nenhum GUI foi reiniciado. O caminho de autoridade padrão do cliente foi alinhado aos workers pela
variável de usuário ANVIL_AUTHORITY_DIR; leituras autenticadas foram confirmadas nas portas 4517/4537.

## 3. Estado local em objetos e arrays

Implementado e provado no laboratório `ZZHtmlImports_UI/ValueGallery`:

- Literais JS inferem estruturas e listas nativas deduplicadas; records/arrays aninhados, incluindo
  arrays de primitivos, são transportados por codecs gerados e nós JSON nativos.
- Inicialização ocorre antes do `onInitialize` autorado. `map`, spread, alterações de campos e lista
  vazia após inferência funcionam em duas instâncias independentes do mesmo block.
- Codec recusa perda de precisão de IDs numéricos, campos inválidos, tipos divergentes, getters,
  símbolos e arrays esparsos. Renderização recebe valores imutáveis; atribuição nativa só ocorre
  depois de todos os valores compostos passarem pela desserialização.
- Valores sem mudança conservam a instância nativa; isso não implementa identidade por chave para
  itens alterados, reordenados ou paginados.
- Prova publicada: IDs grandes exatos como texto, estado independente, arrays aninhados/vazios,
  viewport 390 px sem overflow e zero erros JavaScript. O teste do JS realmente emitido recusou
  16 valores inválidos. Houve 404 transitório logo após a primeira publicação; a rota ficou disponível
  sem mudança de código. A prova final do navegador passou após a segunda publicação.
- 60 testes focados passaram antes do endurecimento final dos codecs; os oito testes de valores
  passaram após esse ajuste. Regressão completa 657/657 em 46m13s. Integrado e instalado nos
  compiladores/workers SS4/SS5, Core SHA256 idêntico. Leitura autenticada aceita em ambas as faixas.

Entrega final desta rodada: `7d2034f74a254b8a84d187f5d9bacfa6`, 17.039 s, zero mensagens.
Publicação no lab: 9.977 s. Artefatos: `.local/review/value-deliver.json`, `value-publish.json`,
`value-browser/`. O worker normal do SS5 confirmou `unchanged=true`, 703 verificações e recibo aceito na entrega
`ad224ff2a5ea4d7683e42d383e5080cd`. Recibo durável: `docs/proofs/2026-09-06-ui-structured-values.json`.
Não confundir esse laboratório com a migração do Dashboard de produto.

## Etapas restantes

2. Completar o contexto de módulos: descoberta de assinaturas no fluxo controlado, aquisição de
   dependências ausentes e imports de actions/tipos. A parte de blocks registrados está descrita acima.
3. Completar tipos/codecs em inputs/eventos/imports, anotações para inicializadores vazios, precisão,
   datas/null, controles de formulário/select e navegação. Estado local inferido está descrito acima.
   `ToObject` é uma conversão nativa disponível e transportou uma lista nativa para JS no experimento de
   identidade; isso não estabelece ainda uma API de objetos JS comuns nem a conversão de escrita inversa.
4. Identidade de listas e paginação, com teste de atualização de itens sobreviventes e estado dos blocks.
   O experimento adicional observou IDs internos `10_0/10_1` virando `10_2/10_3` após ListSort. Mesmo com
   PreserveListItemReactKey=true apenas num navegador isolado, os blocks resetaram. Nenhuma configuração
   do servidor foi alterada. Não substituir essa lacuna por escrita em campos privados ou ajustes de DOM.
   A leitura do runtime confirmou que o ListSort público limpa/repopula a lista; a rotina imutável interna
   que preserva IDs não é a rotina chamada por ele. A implementação precisa de uma operação suportada de
   reconciliação/ordenação com identidade, não só de uma propriedade `key` adicionada ao HTML.
   A prova complementar `ui-list-identity-protocol.json` isolou as duas condições: o protocolo exportado
   de lista mantém IDs e, com PreserveListItemReactKey ativo antes da montagem, estados 2/1 acompanham
   a reordenação como 1/2 e voltam a 2/1. O modo padrão ainda reseta. Isso não foi incorporado ao frontend:
   falta um contrato suportado de renderização por lista e os testes de atualização/inserção/remoção/páginas.
5. Lowering async: estado visível antes de await, sincronização entre handlers, erros/finally, lifecycle e
   wrappers tipados/deduplicados. A prova de runtime não equivale à implementação do transformador de JS.
6. Migrar o Dashboard de produto, com dados reais e os quatro fluxos de leitura, três paginações, filtros,
   estados de erro/vazio/login, navegação e composição de blocks. Retirar o manifesto legado desse caso.
7. Provar e instalar as capacidades finais em SS4/SS5. O usuário autorizou o reinício do SS4, executado
   após preservar o DCIPS_Migration_PoC_CS. O módulo foi reaberto no ambiente EC2 original e a leitura
   autenticada da bridge passou. Nada foi publicado. Atualizar CLI/worker não exige reiniciar o GUI.

Data/Logic high code permanece posterior ao fechamento da UI. Nenhuma etapa acima autoriza declarar
suporte universal a HTML/JavaScript, cobertura total de telas ou o Dashboard já migrado.
