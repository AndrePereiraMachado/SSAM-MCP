# Engine sources

Copiados em 16/09/2026 de `C:\Users\andre\ODC3\src` (o host headless independente, criado em 09/09), sem
alteração de conteúdo, para que o repositório não dependa de caminho absoluto:

- `NativeMergeVerification.cs`: equivalência estrita pós-merge, tolerante só a metadados de grid vazios nos `owners`.
- `NativeFeatureBootstrap.cs`: inicialização do provedor de features do Studio a partir do cache local, para a
  autoria nativa carimbar autor e ferramenta.

Regra: mudanças de engine são feitas com intenção própria, nunca como efeito colateral de uma tarefa de app.
Se um destes arquivos precisar mudar, registrar o motivo aqui e no journal.

Alterações:

- 2026-09-24, `NativeFeatureBootstrap.cs` (decisão D-M3-23, isolamento do runtime ODC da avaliação): o cache de
  features passa a seguir a regra do kernel (`OdcFeatures.CacheDirectory`). Com `ANVIL_ODC_FEATURES_DIR` definida, o
  `Features.xml` (e o `FeaturesOverride.xml`, quando existe) vem só dessa pasta, que tem de ser absoluta e conter o
  `Features.xml`; senão a construção falha, sem recorrer ao cache do Studio instalado. Sem a variável, nada muda
  (`%LocalAppData%\OutSystems\ODC Studio`).
- 2026-10-04, `NativeMergeOrder.cs` (novo) e `NativeMergeVerification.cs` (ordem do merge): o Studio apaga o Default
  Value que marca como só-leitura (atributo de entidade com tipo identificador, parâmetro de entrada obrigatório) quando
  um merge define o tipo do elemento; `NativeMergeOrder` planeia esses defaults (`Anvil.Core.MergeOrder`, do kernel) e o
  bridge faz dois merges nativos no mesmo comando (cópia sem eles, depois o candidato sobre a cópia). A verificação nomeia
  duas classes conhecidas em vez de "uncertain": defaults perdidos (com o job de reparo) e Delete Rule forçada a Ignore
  (com a declaração para o job). Provado headless em `kernel/tests/Anvil.Tests.Odc/OdcMergeOrderTests.cs` e offline em
  `studio/bridge/tests/LostDefaultVerificationTests.cs` com os dumps reais dos labs 24 (QuizLiveWeb) e 02 (Escala Viva).
  2026-10-08: dentro do ODC Studio 1.7.27 a transação de `NativeMergeOrder.Prepare` (cópia do primeiro passe) lança
  NullReferenceException (cliente remoto, bridge v45). Sem mudar o bridge, a fachada calcula a ordem headless
  (`anvil-odc merge-order`, `Anvil.Core.MergePlanner`) e entrega dois merges no mesmo `studio_deliver` (o candidato sem os
  defaults, depois o candidato completo sobre a captura nova): o plano do próprio bridge fica vazio nos dois e o
  `Prepare` retorna antes da transação (`facade/kernel-delivery.mjs`, `tests/merge-order-deferred.test.mjs`).
- 2026-10-07, `NativeMergeVerification.cs` (pacote 3, lane mb, C16 G-1): três reescritas que o ODC Studio faz em todo
  merge viram famílias exatas de linhas do dump.
  - `CustomNameTrio`: instância de bloco criada com nome; o Studio deriva o nome do bloco (`CustomNameIsSuffix` True).
  - `RefreshMaxRecordsRemoved`: refresh de Data Action sem Max. Records; o Studio apaga o valor.
  - `IconConversion`: ícone FontAwesome trocado pelo nome e peso Phosphor. Só é desculpado quando os dois modelos
    provam a troca daquele widget e a tabela do próprio Studio (`IconLibraryProvider` do NRWidgets) diz exatamente isso.
    O widget é o mesmo pelo próprio key (o último segmento do caminho). O merge troca o key dos wrappers acima dele
    (`PlaceholderArguments`, `ChildPlaceholders`), então o caminho inteiro muda (labs 22 e 24).
  - O sufixo ` [Not Visible]` da linha de propriedade faz parte da sintaxe do dump (`Flagged`).
  - Motivo: as 6 entregas MERGE_UNCERTAIN do amigo (labs 18, 21, 22, 24, 30 e 38 de 06/10) caíam só nessas três
    classes. O merge tinha rodado; a resposta dizia "uncertain". Agora o bridge responde `ok:true, merged:true,
    equivalence:"normalized"` com uma nota por elemento. Qualquer outra diferença continua recusada.
  - Provado em `studio/bridge/tests/Pa3MbMergeTests.cs`, com dumps sintéticos das linhas dos labs.
  - Reexecução offline (não commitada) dos 6 merges com os dumps reais, o candidato e a captura seguinte como módulo
    depois do merge: os 6 passam; antes, os 6 eram recusados.
