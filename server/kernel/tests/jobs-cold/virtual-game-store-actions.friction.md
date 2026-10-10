# Log de atrito — virtual-game-store-actions

Data: 2026-09-04

## Arquivos consultados além de `AGENTS.md`

Leitura integral:

- `MANIFESTO.md`
- `tests/jobs/spec-data.json`
- `tests/jobs/smoke-data-logic.json`
- `tests/jobs/tickets-01-data.json`
- `tests/jobs/static-entity.json`
- `tests/jobs/logic-spec-services.json`
- `src/Anvil.Core/Kernel/LogicExpander.cs`
- `scripts/run_job.py`
- `scripts/proof_merge.py`
- `scripts/anvil_cli.py`
- `docs/PROVAS.md`

Consultas de trechos com `rg`:

- `docs/architecture/2026-09-04-modelo-de-verbos.md`
- `docs/functions.md`
- `docs/diagnostics/verify-messages.md`
- `catalog/functions-11.55.69.json`
- `catalog/model-api-11.55.69.json`
- `catalog/verify-messages-11.55.69.json`

## Execuções até passar

1. Primeira tentativa do job: falhou antes da aplicação porque `job:virtual-game-store-data` não é resolvido pelo runner quando o job dependente está em `tests/jobs-cold`; o runner procura apenas em `tests/jobs`.
2. Segunda tentativa: após trocar a base para `.local/jobs/virtual-game-store-data.oml`, a compilação falhou por quatro actions com dois nós `SetOutput` no mesmo ramo (`Cart_GetOrCreate`, `Cart_AddItem`, `Payment_HandleWebhook`, `ReviewVote_Set`).
3. Terceira tentativa: os fluxos foram corrigidos e o Verify encontrou incompatibilidades de tipos em datas e aliases de aggregates renomeados pelo Studio.
4. Quarta tentativa: `isValid=True`, mas com 42 warnings `UnusedElement` para parâmetros de paginação, filtros opcionais, notas e payloads que não têm campos correspondentes no modelo ou exigem joins/validação de integração ainda não modelados na `logic spec`.
5. Merge: `python scripts/proof_merge.py --module Headless_CS --job tests/jobs-cold/virtual-game-store-actions.json --checks Game_Create,Checkout_CreateOrder,Payment_HandleWebhook,License_GrantForOrder,Catalog_GetPublishedGame --flow ""` — sem conflitos, TrueChange com 0 erros e 42 warnings esperados; contagem confirmada de 68 Server Actions e 5 Service Actions.

## Decisões e dúvidas

- As actions não são cascas: as principais operações de criação, atualização, consulta, transição, persistência, `ForEach`, pagamento, licença, wishlist, avaliação, promoção e expiração têm passos de negócio.
- O job usa `.local/jobs/virtual-game-store-data.oml` como base porque o runner atual não localiza dependências `job:` em `tests/jobs-cold`; o modelo de dados já foi entregue anteriormente no `Headless_CS`.
- A criação de pedido ainda precisa de uma evolução para copiar todos os itens e snapshots do carrinho dentro de um `ForEach` com joins de edição/jogo.
- A validação criptográfica de assinatura de webhook e a aplicação de descontos exigem integração/ações auxiliares que não existem no catálogo atual.
- `Game_SetDevelopers`, `Game_SetPublishers`, `Game_SetGenres` e `Game_SetPlatforms` usam `ForEach` para substituir associações; a expressão de item corrente em listas de parâmetros precisa de confirmação no Studio real.
- Nenhuma publicação foi executada.

## O que faltou no guia

- O guia documenta `logic`, mas não mostra um exemplo de implementação completa das 73 actions de um domínio nem como dividir ações dependentes em múltiplas operações `logic`.
- Não há orientação para joins dentro de uma `logic spec` nem para paginação (`Page`, `PageSize`, `Limit`) em aggregates gerados.
- Não há contrato para validação de payload/assinatura de webhooks, idempotência de pagamentos ou cópia transacional de itens de carrinho para pedido.
- O guia diz que `job:` procura na pasta do job, mas `scripts/run_job.py` procura apenas em `tests/jobs`; foi necessário usar uma base OML explícita.
