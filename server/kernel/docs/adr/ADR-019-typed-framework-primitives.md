# ADR-019 — Primitivas tipadas e referências por identidade

## Decisão e limite

O tradutor pode usar primitivas pequenas, tipadas e de autoria do produto para operações do framework sem equivalente nativo fiel. O programa de negócio continua sendo traduzido para actions, estruturas e nós editáveis do OutSystems. Uma primitiva não recebe código, nome de método arbitrário, assembly do autor nem um programa serializado para executar.

A primeira investigação é `System.String.CompareOrdinal`: as comparações textuais nativas usadas após agrupamento não preservaram a ordenação solicitada em C#. Os catálogos de expressões e das extensões padrão Text/BinaryData consultados não ofereceram essa comparação. O protótipo de laboratório contém uma função com dois inputs Text e um output Integer; seu corpo chama diretamente `System.String.CompareOrdinal`.

O protótipo não estabelece ainda um pacote de runtime de produção. O frontend já emite requisitos semânticos tipados, e o controlador adquire a revisão registrada, confere o artefato publicado e congela as dependências da tarefa. A distribuição/instalação desse registro e do pacote final ainda está pendente. A LLM não recebe a tarefa de publicar extensões, descobrir chaves ou escrever bindings. A ordenação implícita por cultura é outro contrato e não pode ser silenciosamente convertida em ordinal.

## Uma importação pelo núcleo existente

O controlador congela a assinatura pública do produtor em um snapshot `.avsig`, com origem, chave do produtor, hash da assinatura e identidades originais dos elementos. A op existente `reference` recebe esse artefato pelo binding de produtor da entrega. O recibo mantém seu hash; a entrega recusa uma assinatura de outro ambiente antes de tirar o snapshot do destino.

O comando nativo de atualização de referências abre sua própria transação. Por isso as referências congeladas são preparadas no modelo descartável antes da transação de edição de negócio, e precisam preceder os demais ops. O baseline é capturado antes da preparação; avisos novos não se tornam preexistentes. Tudo passa pelo Verify, prova, salvamento e merge comuns. Uma falha de preparação não grava o resultado nem altera a base.

Uma referência é reconhecida pela chave do produtor, e cada elemento pela chave original. A atualização preserva o nome local da referência e os aliases das actions. A ligação interna `Tipo:@chaveDoProdutor/chaveOriginalDoElemento` permite que o compilador e o leitor independente de provas resolvam o mesmo destino após recarga, sem depender de nomes ou handles transitórios. O formato é interno, não uma obrigação de autoria high code.

## Requisitos e retomada da mesma entrega

`FrameworkIntrinsic` descreve a operação e seus parâmetros/retorno. A ligação substitui somente destinos
semânticos de chamadas geradas, preservando fonte e source map; não percorre valores do programa como comandos.
`FrozenFrameworkDependencies` conserva a escolha do controlador e cópias dos artefatos na própria tarefa.
A seleção passa por um estado de congelamento persistido antes do lock: interrupções retomam a mesma escolha,
sem consultar novamente um registro que pode ter mudado. Fonte, alvo ou artefatos divergentes são recusados.

A aquisição confere a extensão/revisão ativa antes e depois de ler o XIF e a assinatura. O download usa a chave
no formato DB exigido pelo SDK e recusa artefato vazio. Hash de interface sozinho não comprova bytes executáveis;
o XIF é conferido contra a revisão aprovada. Essas duas leituras do catálogo não oferecem atomicidade contra
publicações concorrentes: a gestão do runtime distribuído ainda precisa de um contrato operacional próprio.

O planejador e a prova independente recebem o mesmo lock; a prova verifica produtor, identidade original,
assinatura e ABI no modelo gerado/recarregado. O fluxo sem requisitos permanece no controlador anterior.

## Evidência em 2026-09-07

- Protótipo `ZZHighCodePrimitives`, extensão 106, versão publicada 112. O XIF contém a DLL gerada do próprio protótipo; não inclui DLLs do Studio ou bibliotecas de terceiros. O build usa o framework já instalado. A avaliação do pacote distribuível final continua pendente.
- Importação offline: criação, repetição, aliases, atualização de hash e recarga passaram; produtor conflitante, elemento ausente, chave original falsa, referência tardia e edição inválida foram rejeitados preservando a base. Regressões estão em `NativeReferenceImportTests` e `NativeReferenceSnapshotTests`.
- A assinatura em `tests/contracts/native-reference/` contém somente metadados da extensão de teste de nossa autoria, com ambiente substituído por `fixture.invalid`. Não contém código executável.
- Endpoint autenticado no `ZZHighCodeLab_CS`, publicação 4951: **400/404** comparações HTTP passaram. Os 400 casos de Unicode válido passaram; quatro entradas com surrogates isolados divergiram. Os resultados são compatíveis com substituição por U+FFFD no transporte, mas a localização exata da transformação ainda precisa de prova. Não redefinir esses quatro casos como aprovados.
- A fonte C# original já foi entregue com aquisição automática pelo controlador: recibo `ac87581e619f45d5861bbdb4eade467a`, 32.677 verificações independentes aceitas no laboratório pessoal. O lock conserva fonte, requisitos, ambiente, módulo, SHA-256 do XIF, assinatura e identidade/ABI da action; retomadas reutilizam essa decisão. A execução HTTP integrada passou **480/480** na publicação 4957, incluindo os oito casos que falhavam na 4948, com fontes/oráculos intactos. Essa prova não certifica os tipos/operações ainda ausentes nem resolve os quatro casos separados de transporte de surrogates.

Artefatos locais: `.local/data-logic-translator/ordinal-primitive/`; entrega `643cce1e391543d0a464a9e4c5ce3552`; oráculo independente em `scripts/probes/highcode/ordinal_primitive_lab.py`.

O CLI isolado atual foi inventariado com notices conferidos e sem DLLs do Studio identificadas. O registro de runtime continua no laboratório; as faixas padrão ainda não contêm o novo compilador e não há provisionador/instalador do registro no caminho de produto. O wrapper gerado do protótipo conserva metadados de empresa do template: o pacote próprio final precisa definir sua identidade. Isso não é uma certificação jurídica do pacote final, que ainda não foi montado.
