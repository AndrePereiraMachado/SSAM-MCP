# Log de atrito — virtual-library-data

Data: 2026-09-04

## Arquivos consultados além de `AGENTS.md`

Leitura integral:

- `MANIFESTO.md`
- `tests/jobs/spec-data.json`
- `tests/jobs/smoke-data-logic.json`
- `tests/jobs/tickets-01-data.json`
- `tests/jobs/static-entity.json`

Consultas de trechos com `rg`:

- `docs/architecture/2026-09-04-modelo-de-verbos.md`
- `docs/functions.md`
- `docs/diagnostics/verify-messages.md`
- `docs/PROVAS.md`
- `catalog/functions-11.55.69.json`
- `catalog/model-api-11.55.69.json`
- `catalog/verify-messages-11.55.69.json`
- `src/Anvil.Core/Kernel/SpecExpander.cs`
- `src/Anvil.Core/Kernel/LogicExpander.cs`
- `src/Anvil.Core/Kernel/FunctionCatalog.cs`

## Execuções até passar

1. `dotnet build src/Anvil.Cli -c Release -o .local/cli` — passou, 0 erros.
2. `python scripts/run_job.py tests/jobs-cold/virtual-library-data.json` — `isValid=True`, mas produziu 4 sugestões de escalabilidade (`Entity_SuggestPartialUpdateBehavior_*`) para `Author`, `Book`, `DigitalEdition` e `Review`.
3. Ajustei o job com `UpdateBehavior = Optimized` nessas quatro entidades.
4. Repeti `python scripts/run_job.py tests/jobs-cold/virtual-library-data.json` — `ok=True`, `isValid=True`, 0 mensagens, 792 objetos.

## Dúvidas de domínio deixadas explícitas

- `Loan` representa acesso temporário a uma edição digital; a política de prazo, limite de empréstimos simultâneos e renovação fica para as actions de negócio.
- `DigitalEdition` guarda uma URL de conteúdo, não o binário. Ainda é preciso decidir se o produto usará storage privado, streaming protegido ou integração externa.
- O usuário é o provider `Users` da plataforma, por isso o modelo usa `User Identifier` e não cria uma entidade de usuário local.
- A avaliação aceita qualquer inteiro no modelo; a regra de faixa (por exemplo, 1 a 5) deve ficar em validação de action/tela.

## O que faltou no guia

- Não há uma orientação explícita para declarar unicidade composta em entidades de associação e estado por usuário (`BookAuthor`, `BookCategory`, `ShelfItem`, `ReadingProgress`).
- Não há receita para índices, constraints ou regras de unicidade para ISBN.
- Não há orientação de domínio para limites numéricos (`Rating`, `ProgressPercent`, `PageCount`) nem para URLs/arquivos digitais protegidos.
- O guia explica a criação do modelo e o Verify, mas não define um formato padrão para registrar decisões de domínio e lacunas; este arquivo usa um formato local associado ao job.
