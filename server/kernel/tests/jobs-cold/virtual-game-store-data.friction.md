# Log de atrito — virtual-game-store-data

Data: 2026-09-04

## Arquivos consultados além de `AGENTS.md`

Leitura integral:

- `MANIFESTO.md`
- `tests/jobs/spec-data.json`
- `tests/jobs/smoke-data-logic.json`
- `tests/jobs/tickets-01-data.json`
- `tests/jobs/static-entity.json`
- `docs/PROVAS.md`

Consultas de trechos com `rg`:

- `docs/architecture/2026-09-04-modelo-de-verbos.md`
- `docs/functions.md`
- `docs/diagnostics/verify-messages.md`
- `catalog/functions-11.55.69.json`
- `catalog/model-api-11.55.69.json`
- `catalog/verify-messages-11.55.69.json`
- `src/Anvil.Core/Kernel/SpecExpander.cs`
- `src/Anvil.Core/Kernel/LogicExpander.cs`
- `src/Anvil.Core/Kernel/FunctionCatalog.cs`

## Execuções até passar

1. `python scripts/run_job.py tests/jobs-cold/virtual-game-store-data.json` — passou na primeira execução: `ok=True`, `isValid=True`, 28 operações, 1.885 objetos e 0 mensagens.
2. `python scripts/proof_merge.py --module Headless_CS --job tests/jobs-cold/virtual-game-store-data.json --checks Game,GameEdition,Order,License --flow ""` — merge sem conflitos, TrueChange com 0 erros e 0 warnings; os quatro elementos principais foram encontrados.

## Atritos e decisões

- Antes desta tarefa foi criado um rascunho de biblioteca virtual por uma interpretação prematura; ele não foi usado no merge. O job entregue nesta tarefa é o modelo correto de loja de videogames.
- O modelo usa `User Identifier` em vez de uma entidade de usuário local, aproveitando o provider `Users` da plataforma.
- `Game` representa a obra; `GameEdition` representa o produto vendável por plataforma e edição.
- `OrderItem` guarda snapshots de nome, SKU, plataforma e valores para preservar o histórico comercial.
- `License` só deve ser criada por action após pagamento aprovado; isso é uma regra de negócio futura, não uma validação estrutural do modelo.
- O modelo não armazena dados de cartão, apenas token e identificador do provedor de pagamento.

## O que faltou no guia

- Não há orientação explícita para constraints de unicidade em SKU, slug, `OrderNumber` e associações N:N.
- Não há receita para limites de domínio como `Rating` de 1 a 5, percentual de desconto ou valores monetários não negativos.
- Não há orientação para versionamento, expiração e segurança de URLs de download/licenças digitais.
- O guia não define como documentar decisões de domínio; este log usa um arquivo Markdown ao lado do job.
