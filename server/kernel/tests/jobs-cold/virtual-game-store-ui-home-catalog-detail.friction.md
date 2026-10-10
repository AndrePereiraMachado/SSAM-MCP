# Log de atrito — Home, Catalog e GameDetail

Data: 2026-09-04

## Entrega

- Job: `tests/jobs-cold/virtual-game-store-ui-home-catalog-detail.json`
- Módulo: `Headless_UI`
- Escopo: três telas Reactive (`Home`, `Catalog` e `GameDetail`), cinco Data Actions, seis Screen Actions, navegação, busca, filtros, listas de edições/avaliações e consumo de ações públicas do `Headless_CS`.
- Resultado final do job: `ok=True`, `isValid=True`, `messages=0`, 343 operações.
- Merge final: sem conflitos, TrueChange com 0 erros; 218 warnings preexistentes da galeria `Gallery_Charts`/`Gallery_Maps` do `Headless_UI`.
- Publicação: não realizada.

## Arquivos consultados além do AGENTS.md

- `tests/jobs/screen-list-reactive.json`
- `tests/jobs/screen-search-refresh-reactive.json`
- `tests/jobs/consume-reference-screens.json`
- `tests/jobs-live/consume-headless-cs.json`
- `tests/jobs/data-action-reactive.json`
- `tests/jobs/screen-form-reactive.json`
- `tests/jobs-cold/virtual-game-store-data.json`
- `tests/jobs-cold/virtual-game-store-all-sql-v7.json`
- `.local/producers/Headless_CS.oml` e sua inspeção pelo CLI
- `scripts/run_job.py`
- `scripts/proof_merge.py`
- `scripts/anvil_client.py`
- `scripts/studio_env.py`
- `scripts/open_ss4.ps1`
- `src/Anvil.Bridge/MergeHandler.cs`
- `src/Anvil.Bridge/OpenHandler.cs`
- `src/Anvil.Bridge/WindowsHandler.cs`
- `src/Anvil.Bridge/LoginHandler.cs`

## Execuções até passar

Foram 9 execuções de validação relacionadas ao job, contando um probe separado da referência:

1. Falhou porque o snapshot local do `Headless_CS` estava desatualizado.
2. Repetiu a falha; descobriu-se que o bridge havia salvo o snapshot em outra pasta.
3. Probe confirmou a referência após copiar o snapshot correto.
4. Falhou porque static entities não públicas não podem ser referenciadas diretamente.
5. Falhou porque `GameDetail` ainda não existia quando os destinos de navegação foram configurados.
6. Falhou pelo mesmo requisito de ordem para `Catalog` e seu destino.
7. Falhou porque `IDropdown` não possui a propriedade `Prompt`.
8. Falhou porque listas de Data Action usam `List.Current.<atributo>` diretamente e havia um botão sem destino.
9. Passou com `isValid=True` e zero mensagens, após corrigir aliases das listas, ordem de criação e ação de limpeza de filtros.

O merge foi tentado duas vezes antes de reiniciar o Studio, por erro interno do `MatchTree` (`Matches cannot be set already`); depois da reinicialização foram tratados os diálogos de recuperação/dependências e o merge final passou.

## Dúvidas e lacunas do guia

- O guia não deixa explícita a regra de ordenação para destinos de tela: a tela de destino e seus parâmetros precisam existir antes de configurar links/botões que navegam para ela.
- O guia descreve `List.Current` para aggregates e structures, mas não explicita que uma lista de entidade retornada por Data Action deve usar `Output.Current.Attribute`, sem o invólucro da entidade.
- O fluxo para atualizar o snapshot de um produtor vivo não informa que `snapshot_module` pode resolver caminhos relativos no diretório do processo do Studio; foi necessário usar caminho explícito e copiar o arquivo para `.local/producers`.
- O troubleshooting cita diálogos, mas não documenta como tratar a sequência nativa de recuperação, “Manage Dependencies” e confirmação de atualização durante `open_module`.
- O guia não diferencia claramente dependências públicas de static entities internas; a referência das entidades públicas trouxe as static entities dependentes automaticamente.
