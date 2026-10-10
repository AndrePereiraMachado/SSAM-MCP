# SSAM Hybrid: estado da cobertura em 2026-09-04 (madrugada, sessao autonoma)

Para alinhar de manha. Tudo abaixo esta provado (Verify valido headless e, onde indicado, merge + publish no SS4)
e registrado em `docs/PROVAS.md`; cada job em `tests/jobs` e um teste xunit (`dotnet test tests/Anvil.Tests`: 42 verdes, 41 s).

## O que uma LLM sem contexto consegue construir hoje (AGENTS.md)

| Area | Provado | Onde |
|---|---|---|
| Data | entidade (Id AutoNumber, FK, mandatory, defaults, Public/ExposeReadOnly), static entity com records, structure, role, site property, client variable, tela restrita a role | smoke-data-logic, static-entity, screen-form-reactive |
| Logic | REST consumido (GET/POST, auth, headers, chamada) e exposto; spec compacta de dados (op spec); server action com inputs/outputs/locais, aggregate (filtro, join Left, sort, group by + count), If, Assign, ForEach (receita), Execute de entity action e de server action com argumentos por nome, Raise, exceptions, SQL/timer/role/site property (receita Temporada), layout automatico sem diagonal | smoke-data-logic, aggregate-full, TemporadaRecipe |
| Process | BPT: Start, Automatic Activity, Human Activity com destino e argumento, End, conectores, layout, Detail; Timer com Action | process-bpt, process-human-traditional |
| Reactive | client action com no JavaScript e Script exigido pela tela; tela com layout do tema, aggregate de tela, input parameter, Form + Inputs ligados (Variable/Mandatory/Prompt), Button OnClick -> screen action -> server action wrapper, List + ListItem com navegacao e argumento, padroes do OutSystems UI (Tabs, Accordion, Card) com handler de evento | screen-reactive, screen-form-reactive, screen-list-reactive, osui-patterns |
| Mobile | mesmos padroes com o Layout do app; local storage (client entity, client action, aggregate client-side) | osui-patterns-mobile, local-storage-mobile |
| Traditional | tela com Preparation, TableRecords (celulas por linha), Inputs, Button -> screen action, link Navigate com argumento e conector do flow, padroes do OutSystemsUIWeb (Columns2, Card, Accordion); email com Send Email | screen-crud-traditional, osui-web-patterns, email-traditional |
| OutSystems UI | catalogo gerado do OML do ambiente: OutSystemsUI 2.28.1 (141 blocos), OutSystemsUIWeb 1.12.8 (112), RichWidgets (55): contrato, placeholders (+ o que nascem com), eventos, static entities, APIs OSUI, CSS/JS, tokens de tema; markdown por bloco com "como criar" e "como ligar um evento" | catalog/ui, docs/ui, `anvil ui-block` |
| Bridge SS4 | login por arquivo (worker thread), open_module (seleciona a aba), snapshot, merge (preview/auto), TrueChange, publish, windows/ui_alive/close_dialog para troubleshooting, dialogo de recuperacao resolvido pelo CDP | scripts/proof_merge.py, scripts/cdp_pages.py |

Apps vivos no ambiente pessoal (publicados pelo laco): Headless_UI (Contacts -> ContactDetail -> Save, Patterns),
HeadlessTrad_UI (ContactsWeb -> ContactDetailWeb, PatternsWeb, ApproveContact, timer), HeadlessMobile_UI (Patterns).
Prova visual no browser fica para voce: o runtime pede login e eu nao digito senhas.

## Numeros (E2E no SS4, sem humano)

| Fluxo | Tempo |
|---|---|
| open_module | 6-9 s |
| job headless (40-90 ops) | 1-2 s de apply (5-6 s de processo com load) |
| merge automatico | 1,4-1,8 s |
| publish (1-Click, pelo Studio) | 10-18 s |
| E2E tipico | 19-36 s |

## Manha de 2026-09-04: galeria, playbook e sessoes frias

- Galeria de widgets gerada do catalogo (`anvil ui-gallery`): 176 blocos de OutSystemsUI/Charts/Maps + 23 nativos, publicados em
  25 telas `Gallery_*` no Headless_UI (docs/ui/gallery-reactive.md).
- AGENTS.md reescrito como playbook por tarefa; GuideTests amarram guia e jobs.
- Sessoes frias rodada 1: 5/5 LLMs sem contexto passaram na primeira execucao (docs/tasks/2026-09-04-sessoes-frias-rodada-1.md);
  rodada 2 em curso com tarefas de outras familias.
- Novos jobs: service-action, data-action-reactive, gallery-native-reactive e os 5 das sessoes frias (53 testes verdes).

## Aberto (por ordem de importancia)

1. ~~Adicionar referencias novas headless~~ RESOLVIDO as 04:20: verbo `reference` (IESpace.RefreshDependencies, publico no
   Model API) com produtor por OML ou `job:<nome>`; provado no fixture (consume-reference) e ao vivo (Headless_UI -> Headless_CS,
   publicado). Investigacao completa em `docs/mapa/2026-09-04-add-references-investigacao.md`.
2. ~~Refatoracao~~ RESOLVIDO as 04:50: verbos `usages`, `rename` (propaga por chave, recusa colisao) e `delete` seguro; provado em refactor-usages. Falta: replace, extract to action (precisa de Runtime proprio, ver investigacao).
3. ~~Diagnostico~~ RESOLVIDO as 05:05: `docs/diagnostics/verify-messages.md` e `catalog/verify-messages-11.55.69.json` com os 468 ids (severidade, texto, objeto, dica), extraidos dos resources do build; AGENTS.md manda consultar ao falhar o Verify.
4. ~~REST~~ RESOLVIDO as 05:50 (consumo GET/POST/Basic Auth/headers, chamada, exposicao: 4 jobs validos; relatorio em docs/mapa/2026-09-04-rest-investigacao.md). Cobertura restante: SOAP,
   Table/If Reactive, CSS/theme edits, images/resources. Feito entretanto: roles em telas, site properties, client variables,
   Dropdown/Checkbox/Switch/TextArea/Icon/Label/ButtonGroup, Table (sem SortAttribute: formato em aberto) e If.
5. Fixtures de ouro e CI (hoje: 4 fixtures de template + 22 jobs = testes); spec language v0 COMECOU: `op: spec` para dados (static, entidades, structures) em tests/jobs/spec-data.json; falta spec de logica e telas.

## Decisoes tomadas sozinho (para validar)

- Verbos ganharam `source` e `empty` no create (block instance nasce com SourceBlock e sem o conteudo de exemplo),
  `set` em propriedades que devolvem expressao (escreve o Text), `$dono/<Propriedade>` (OnClick, OnReady...),
  `$bloco/<Evento>` (handler), `Tipo:Nome` tambem para elementos referenciados, `link` para processos e telas.
- Screen action chama server action wrapper em vez da entity action direta (Security Warning do Verify).
- `publish` existe no bridge para modulos de teste; o produto continua "merge e o humano publica".
- Arquivos grandes do OutSystems UI (CSS de tema, scripts) ficam em `.local/ui` (fora do git); o catalogo JSON e o
  markdown por bloco entram no repo (2,2 MB + 3,7 MB).
