# Log de atrito — game-set-publishers-sql

Data: 2026-09-04

## Arquivos consultados além de `AGENTS.md`

Leitura integral ou de trechos relevantes:

- `src/Anvil.Core/Recipes/TemporadaRecipe.cs`
- `src/Anvil.Core/Kernel/ModelBuilder.cs`
- `scripts/proof_merge.py`
- `scripts/anvil_cli.py`
- `docs/architecture/2026-09-04-modelo-de-verbos.md`
- `docs/mapa/criar-blank-service.md`
- `catalog/model-api-11.55.69.json`

## Execuções até passar

1. Primeira execução: falhou ao criar o output SQL porque `ISQLOutput` recebeu `IServerEntity:GamePublisher`; a propriedade exige o nome do tipo de registro (`GamePublisher`).
2. Segunda execução: `ok=True`, `isValid=True`, 49 ops e 42 warnings herdados das actions anteriores; confirmou `Game_SetPublishers` e `DeleteExistingPublishers`.
3. Merge isolado: `python scripts/proof_merge.py --module Headless_CS --job tests/jobs-cold/game-set-publishers-sql.json --checks Game_SetPublishers,DeleteExistingPublishers --flow Game_SetPublishers` — sem conflitos, 0 sobreposições, TrueChange com 0 erros e 42 warnings herdados.

## Decisões

- A action foi substituída por delete + recriação porque os verbos atuais não oferecem edição declarativa da subárvore do fluxo.
- O contrato permanece igual: `GameId`, `PublisherIds` e `Success`.
- O delete antigo em loop foi substituído por `DELETE FROM {GamePublisher} WHERE {GamePublisher}.[GameId] = @GameId` em um único `ISQLNode`.
- O loop de inserção foi preservado para criar os vínculos selecionados.
- `brokenConsumers=0`; nenhuma outra action dependia de `Game_SetPublishers`.
- Nenhuma publicação foi executada.

## O que faltou no guia

- Não há receita de SQL destrutivo em lote com `ISQLInputParameter`, argumento `@Nome` e `ISQLOutput` obrigatório.
- Não está documentado que `ISQLOutput` recebe `GamePublisher`, e não `IServerEntity:GamePublisher`.
- Não há orientação explícita para substituir apenas a subárvore de uma action mantendo o contrato e o nome quando o verbo não edita o corpo existente.
