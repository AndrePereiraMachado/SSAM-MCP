# Log de atrito — virtual-game-store-all-sql

Data: 2026-09-04

## Arquivos consultados além de `AGENTS.md`

- `src/Anvil.Core/Kernel/LogicExpander.cs`
- `src/Anvil.Core/Kernel/ModelBuilder.cs`
- `src/Anvil.Core/Recipes/TemporadaRecipe.cs`
- `scripts/run_job.py`
- `scripts/proof_merge.py`
- `scripts/anvil_cli.py`
- `tests/jobs-cold/virtual-game-store-actions.json`
- `docs/architecture/2026-09-04-modelo-de-verbos.md`
- `docs/mapa/criar-blank-service.md`
- `catalog/model-api-11.55.69.json`

## Execuções até passar

1. Primeira geração: falhou porque o runner não resolve `job:virtual-game-store-data` em `tests/jobs-cold`; troquei a base para o OML local já produzido.
2. Segunda geração: falhou porque as fachadas foram deletadas como `IServerAction`; corrigi os cinco alvos para `IServiceAction`.
3. Terceira geração: falhou porque parâmetros SQL de static entity usavam o tipo inválido `Identifier` e a conversão confundia inputs com nomes de colunas.
4. Quarta geração: falhou porque os resultados SQL eram consumidos com `<consulta>.List.Current.<Entidade>`; o output SQL precisa ser `List` e os registros precisam ser carregados em variáveis locais.
5. Quinta geração: falhou apenas por colisão de aliases `LoadSqlRecord1` dentro de `ForEach`; renomeei aliases auxiliares duplicados.
6. Sexta execução: `ok=True`, `isValid=True`, 79 ops, 5.060 objetos, 42 warnings herdados das actions anteriores e `find IAggregateNode = []`.
7. Merge final: `python scripts/proof_merge.py --module Headless_CS --job tests/jobs-cold/virtual-game-store-all-sql-v5.json --checks Game_Search,Game_SetPublishers,Cart_Get,License_ValidateAccess,Catalog_SearchPublishedGames --flow ""` — sem conflitos, 68 Server Actions, 5 Service Actions, TrueChange 0 erros.

## Decisões

- Todas as leituras declaradas originalmente como `get` na `logic spec` passaram a gerar `ISQLNode` com `SELECT` parametrizado.
- `Game_SetPublishers` preserva o `DELETE` em lote e a inserção dos novos vínculos.
- O output SQL foi padronizado como `List`, seguindo a receita de SQL do repositório.
- Os registros SQL usados em expressões são copiados para variáveis locais antes de acessar seus atributos.
- As actions foram recriadas em uma única transação para atualizar também as referências das cinco Service Actions.
- Nenhuma publicação foi executada.

## O que faltou no guia

- A `logic spec` não documentava suporte a SQL como variante do passo `get`; foi necessário ampliar `LogicExpander` com `sql`, `statement` e `params`.
- Não havia orientação sobre o formato de `ISQLOutput` (`List`) nem sobre acesso a atributos de registros retornados por SQL.
- Não havia receita para converter automaticamente filtros OutSystems em SQL parametrizado, incluindo static entities e expressões de usuário.
- Não havia instrução para preservar referências de Service Actions ao recriar actions internas em uma transação.
