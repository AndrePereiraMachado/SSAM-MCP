# CSV → fila de Approvals e fidelidade das tabelas

O usuário esclareceu que os relatórios do CSV devem entrar em Approvals para decisão humana, e rejeitou a lista adicional “My imported reports”. A criação como rascunho seguida de uma lista própria foi uma interpretação incorreta da solicitação. O legado também contém uma contradição: cria Draft, mas seu texto promete a fila de aprovação, cujo filtro solicita Submitted.

## Alteração entregue no SS4

- `MassCasualty_CreateOneCore` agora resolve o status por Code `submitted` e a etapa por Code `review`. Grava SubmittedOn e preenche a data de submissão também na representação do formulário. A auditoria do lote passa a `CR_BULK_SUBMIT`.
- Autenticação, validação do pedido/linhas, limites, datas, identificação de casos existentes, persistência transacional, retenção e chave de repetição permanecem no fluxo existente. Esta entrega não atribui Approved nem Rejected e não altera as guardas das decisões do supervisor.
- Removidos o contêiner MyImportedReports, a data action GetMyImports e os caminhos de atualização da lista. Não foram apenas escondidos por CSS. O gerador anterior foi retirado para impedir a recriação acidental dessa interface rejeitada. Os jobs históricos permanecem como evidência, não como entrada a reaplicar.
- Resultado com texto de envio para aprovação e botão ligado à tela real CasualtyReportApproval. Cancel volta ao comportamento anterior de sair para o Dashboard; Cases ainda não é uma tela deste módulo.
- Tabelas com padding 8px/12px, cabeçalho 12px/16px e corpo 14px/20px. Células transparentes deixam aparecer o verde do cartão de sucesso.
- Linhas inválidas e suas células recebem `#fef2f2`. A expressão nativa RowStyle existia, mas a classe não aparecia no DOM publicado: o CSS também identifica a presença do elemento nativo de erro `.dcips-mc-danger` na própria linha. O estado acompanha as mensagens efetivamente renderizadas, sem um script paralelo de classificação.
- Branches na tabela ficam como texto simples, conforme o legado. Foco do CSV usa azul escuro.

## Verificação

CS: recibo `fec7deaa19f34ae79946c3bd9cd97e92`, 14 operações, Verify sem mensagens, delivered=true. UI: recibo `3da580ef9e9a4960996041c88acd5ccb`, 16 operações, Verify sem erros novos, delivered=true. Os três warnings de Anonymous Role remanescentes são da tela de aprovação e seguem a política existente.

Preview temporário no Chrome, com a fonte CSS da entrega: linha válida com fundo transparente; linha inválida e todas as seis células em `rgb(254,242,242)`. Alturas medidas 37,33 e 36,89 CSS px, próximas dos 37px medidos no legado. Evidência em `.local/mass-approval-alignment/row-preview.json` e `row-preview.png`. Preview não equivale a publicação.

**Pendente:** publicação humana de CS seguida de UI, seguida de E2E real CSV válido → Submitted → Approvals → decisão disponível. Conferir também os relatórios já gravados como Draft antes desta alteração: eles não foram promovidos diretamente na base nesta entrega, e repetir uma chave antiga pode devolver o recibo anterior. Não declarar esse lote histórico submetido antes de executar e provar sua transição com validação. Nenhum registro existente foi aprovado/rejeitado ou teve seu estado alterado neste trabalho.
