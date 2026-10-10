# Frente A — desenho dos fragmentos (dados e lógica)

Contrato: `ssam-catalog-contribution/1` (`platforms/odc/facade/catalog/README.md`), interface de controle
`INTERFACE.md` do pacote de coordenação. Este arquivo é a especificação de trabalho da frente A: temas, ids, papéis,
tipos nativos por faixa, substituições de legado e regras de redação. Não é contrato nem esquema novo.

## 1. Fontes de fatos (nesta ordem)

1. Contrato extraído do kernel: `api --op logic|verbs|spec` — idêntico byte a byte nas duas faixas (conferido nos
   índices da base; ponteiros `logic.*`, `verbs.*`, `spec.*`).
2. Matriz de evidência A: `docs/evidence/catalogo-abrangente/A/matrix/a-matrix.json` (gerada por
   `extract-a-matrix.mjs` no mesmo diretório). Por faixa e tipo qualificado: `executed.<verbo>.current|historical`
   (carimbo + ledger/execuções do índice deste checkout), `static.<verbo>.<job>` (texto do job), `negative.<verbo>.<job>`
   (suíte negativa, com `expectError`), `props`. Menção estática ≠ prova; o negativo lista os tipos que o job toca, não
   só o op recusado — leia `expectError` e o job.
3. Jobs das suítes: ODC `kernel/tests/jobs-odc`, `jobs-odc-negative`; O11 `kernel/tests/jobs`, `jobs-negative`. As
   descrições e os `_why` dos jobs registram o que cada op prova.
4. Legado da frente (texto curado, origem): `platforms/odc/facade/discovery-capabilities.json` (ODC) e
   `discovery-capabilities-shared.json` (`data.*`). Modelo de forma shared/2: `data.entity` e `data.structure` no
   descritor partilhado.

## 2. Regras de redação (obrigatórias)

- Forma shared/2 exatamente como `discovery-capabilities-shared.json`; campos só de catálogo: `requires`, `supersedes`.
- `status` por papel/operação/faixa: `applicable` só com job positivo DA FAIXA em `proofs` que executa essa operação
  nesse papel (confira no job); `conditional` com a pré-condição e o negativo/prova; `not-applicable` com negativo ou
  `note` + `alternative`; `undetermined` sem `proofs`. Nunca herdar prova de outro papel ou da outra faixa. Prefira
  jobs com `executed.current` para o papel; jobs só estáticos podem entrar (o motor os mostra como C-suite /
  declared-not-proven, nunca como atuais).
- O motor verifica a prova pelos verbos de cada operação: read=get/dump/find, usages=usages, create=create/spec,
  set=set/link, rename=rename/set, replace=replace, move=move, duplicate=duplicate, delete=delete; declare `verbs`
  na role quando a operação usa outro verbo (ex.: `logic` compacto).
- `observed` só para comportamento lido de volta sem integridade verificada (ex.: delete forçado).
- Texto genérico: sem nomes de aplicações reais nem receitas de tarefas passadas; o `scope` descreve o que a prova
  estabeleceu em termos de papéis ("Assign inserido entre um aggregate e um If de uma action herdada"), e cita o job.
- Não copiar contrato de B/C: vínculo de evento/widget à action é B (`ui.*`), importação/produtor é C
  (`reference.*`). Pré-requisito ainda inexistente vai em `requires: [{id, provider, why}]`; id existente em `depends`.
- `supersedes` só de entradas legadas de A (ownership.json → legacy): `data.client-entity`, `logic.server-action`,
  `logic.aggregate`, `logic.sql`, `logic.service-action`, `logic.client-action`, `logic.screen-action`,
  `logic.data-action`, `logic.native-nodes`, `logic.exception`, `logic.edit`, `refactor.*`, `data.static`,
  `data.structure`, `data.entity`; ausências `session-variable`, `data-action-inputs`.
- Contabilidade (`coverage[]`) para todo tipo de A que nenhum papel representa: `excluded` (assinatura no consumidor,
  interface-base, gerado, não aplicável na faixa — com `reason` e `origin`), `gap` (aplicável sem rota — `reason`,
  `origin`), `undetermined` (`reason` = o que falta saber). `origin` = job, `arquivo:linha`, ponteiro `api --op` ou
  regra do inventário. Metadado não é rota.
- Tamanho: resumos e notas curtos (o orçamento de 12.000 bytes da resposta inclui estes textos).
- Sinônimos: a faixa O11 não tem sinônimos próprios; o que a intenção em português precisa (ação, variável, atribuir,
  chamar...) vem dos fragmentos. Não sequestrar palavras de B/C (tela, widget, evento, REST...).

## 3. Temas e ids (arquivos em `platforms/odc/facade/catalog/fragments/A/`)

| Arquivo | Capacidades (supersedes) | Papéis (nativo ODC / O11) |
|---|---|---|
| `logic-actions.json` | `logic.server-action` (=), `logic.service-action` (=), `logic.client-action` (=), `logic.screen-action` (=), `logic.data-action` (=), `logic.preparation` (novo, `lanes:["o11"]`), `logic.variable` (novo) | server action `Logic.IServerAction`; service action `Logic.IServiceAction`; client action `Logic.IClientAction`; screen action `UI.Mobile.IScreenAction` (as duas) + web screen action `UI.Web.IScreenAction` (só O11 aplicável); data action `UI.Mobile.IDataAction`; preparation `UI.Web.IPreparation` (O11); input parameter `IInputParameter`, output parameter `IOutputParameter`, local variable `ILocalVariable`, argument `IArgument` (filho do nó de chamada) |
| `logic-flow.json` | `logic.flow` (supersedes `logic.edit`) | start `Logic.Nodes.IStartNode`, end `IEndNode`, assign node `IAssignNode`, assignment `Logic.IAssignment` (filho), if `IIfNode`, switch `ISwitchNode`, switch condition `Logic.Nodes.ISwitchCondition` (filho), for each `IForEachNode`, execute server action `IExecuteServerActionNode`, execute client action `IExecuteClientActionNode`, comment node `ICommentNode`, comment connector `Logic.Nodes.ICommentConnector` |
| `logic-native-nodes.json` | `logic.native-nodes` (=) | message, destination, download, JSON serialize/deserialize, record list→Excel, Excel→record list, JavaScript, refresh data, ajax refresh, send email (ODC `Logic.Mobile.Nodes.ISendEmailNode`, O11 `Logic.Nodes.ISendEmailNode` — conferir no ledger/jobs), attach file |
| `logic-query.json` | `logic.aggregate` (=), `logic.sql` (=) | aggregate node `Logic.Nodes.IAggregateNode`, screen aggregate `UI.Mobile.IScreenAggregate`, source `Aggregates.Full.IAliasedSource`, filter `IFilter`, sort `ISort`, join `Full.IJoin`, group by `IGroupByAttribute`, aggregated column (ODC `IAggregatedAttribute` / O11 `IAggregateAttribute`), calculated `ICalculatedAttribute`; SQL node `ISQLNode`, SQL input parameter `Logic.ISQLInputParameter`, SQL output `Logic.ISQLOutput` |
| `logic-exception.json` | `logic.exception` (=) | user exception `Logic.IUserException`, raise `IRaiseExceptionNode`, exception handler `IExceptionHandlerNode`, global exception handler action `UI.IOnExceptionAction` |
| `refactor.json` | `refactor.rename`, `refactor.replace`, `refactor.duplicate`, `refactor.move`, `refactor.delete` (=, partilhadas nas duas faixas) | sem papéis próprios: operações transversais; provas por faixa em `platforms.<faixa>`; remetem às famílias |
| `data-types-expressions.json` | `data.client-entity` (=, partilhada se o O11 tiver rota), `logic.expression` (novo) | client entity `Data.IClientEntity`; list literal item `Expressions.IListLiteralItem` (ODC) e contabilidade de tipos/expressões/assinaturas de dados |

Acréscimo após o merge de `dec54be`: `data.client-variable` (novo, em `data-types-expressions.json`; C-002 aceito — C
retira o papel `client variable` de `security.settings-roles` na mesma janela de integração); tipos da classe
`outside-object-root` (nós da árvore de expressão, ligações, sequências, auxiliares de lógica) contabilizados como
`excluded` no fragmento do domínio; ids que só existem numa faixa (`ui.screen`, `ui.email-popover`, `deliver.feature`
no ODC legado) entram em `recommends`/`alternatives` com `lanes: ["odc"]` (B-001) e ficam em `requires` só para o O11.

`=` significa reutilizar o mesmo id com `supersedes: ["<id>"]` (referências de B/C continuam a resolver). `data.entity`,
`data.static`, `data.structure` continuam no descritor partilhado (não reimplementar); o fragmento de dados só contabiliza
os tipos de dados que eles não representam.

## 4. Cenário crítico de composição (aceitação)

"Action que limpa variáveis de tipos diferentes preservando exclusões, chamada num ramo existente" = `logic.variable`
(read: inventário tipado; set DataType/DefaultValue) + `logic.flow` (assign node + assignments; execute action node;
inserção por `link` novo→sucessor e depois predecessor→novo; conector de ramo `TrueTarget`/`FalseTarget`) +
`logic.server-action`/`logic.client-action` (criar a action; `usages`). Provas: inserção de chamada O11
`delete-data-consumers`, inserção de Assign ODC `action-edit-lifecycle` e, desde INT-T2-003 (A-002, carimbados e
atuais), `cat-a-reset-typed-values` nas duas faixas (reposição de 14 tipos em 16 saídas com duas excluídas; chamada
inserida no ramo `TrueTarget` (ODC) / `FalseTarget` (O11) de um If herdado, sucessor ligado primeiro; inventário tipado e
usages lidos), `cat-a-list-clear` (ODC: ListClear pela linguagem compacta) e o negativo `cat-a-link-unknown-connector`
(as duas: conector 'Then' recusado com a lista aceita). Os valores de reposição estão provados headless (Verify aceita o
modelo), não em tempo de execução. Continua sem job: inserir num `CycleTarget` de um ForEach existente; ListClear
compacto no O11 (só contrato unitário C#; a forma crua corre em `tickets-06-sla`).

## 5. Comandos (raiz do checkout; PowerShell)

```powershell
$node = "$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
& $node platforms/odc/facade/catalog-check.mjs --front A            # T0 puro
.\ssam discover "<intenção>" --lane odc --rebuild --budget 12000      # T0 real (build do índice) + T1
.\ssam discover "<intenção>" --lane o11 --rebuild --budget 12000
& $node --test --test-reporter=tap "platforms/odc/facade/tests/catalog-a-*.test.mjs"
```

Proibido: `pnpm/npm install`, `scripts/build.ps1`, `build.py`, `build_odc.py`, workers, `odc attach/doctor`,
`ssam doctor`, `studio_*`, MCP `ssam*`, `--app <Módulo>`, `coverage-inventory.mjs`, `dotnet build/test`, `ssam job`
(nativo só na janela do integrador). Não tocar `C:\Users\andre\SSAM-Hybrid`.
