# OutSystems padrões

Ferramenta do SSAM Hybrid que checa as 35 regras de implementação OutSystems e a regra de produto P7 (lista completa
em [RULES.md](RULES.md)). Ela lê o job, o resultado do TrueChange, o OML e a evidência de runtime, e grava um relatório
JSON com os achados, as perguntas de revisão e a situação de cada regra. É um script Python só com a biblioteca
padrão (Python 3.9 ou mais novo). O estágio oml usa o CLI anvil (`anvil inspect --oml`) e não precisa de Studio
aberto, bridge, login nem worker.

## Quando roda

É uma ferramenta **opcional**: roda só quando o usuário pede. Não faz parte do fluxo de entrega, não é gate
automático de job, deliver ou publicação, e nenhum agente deve abrir rodadas de validação com ela por conta própria.
Quando o usuário pedir, rode o estágio que ele pediu, uma vez, e devolva o relatório.

## Como rodar

```
python kernel\scripts\outsystems_padroes\outsystems_padroes.py --stage <estágio> [opções]
```

| Estágio | O que lê | Precisa de |
|---|---|---|
| `job` | O JSON do job do O11 (`--job`, repetível; job composto é expandido como no JobRunner). | Nada além do job. Roda offline. |
| `truechange` | O envelope do run_job (`--result`) ou o `result.json` do deliver (`--deliver-result`). Inclui o pré-requisito interno K0 (ok, accepted, isValid e nenhuma policyMessage) e a N4, em que todo warning do TrueChange conta. | O arquivo de resultado. |
| `oml` | O OML candidato (`--oml`), lido com `anvil inspect --oml ... --full`, em consultas paralelas, cada uma com a sua pasta `--work`. Leitura incompleta ou propriedade cortada para a ferramenta com exit 2. | O CLI anvil e as DLLs do Service Studio 11 (`ANVIL_STUDIO_DIR`). |
| `runtime` | Os `runtimeTests` de um relatório anterior (`--from-report`) contra a `runtimeEvidence` do `--review`. | O relatório anterior e a revisão. |
| `all` (padrão) | job, truechange e oml com as entradas que existirem; runtime entra quando há `--from-report`. | — |

Exemplos:

```
set PY=python
set T=kernel\scripts\outsystems_padroes\outsystems_padroes.py
%PY% %T% --stage job --job <job.json> --module <Módulo>
%PY% %T% --stage all --job <job.json> --result <out.result.json> --oml <out.oml> --module <Módulo>
%PY% %T% --mode integrador --stage all --job <job.json> --result <r.json> --oml <c.oml> --base-oml <base.oml> --review <rev.json>
%PY% %T% --mode integrador --stage truechange --deliver-result <work>\deliver\<id>\result.json --module <Módulo>
%PY% %T% --stage runtime --from-report <x.padroes.json> --review <rev.json>
%PY% %T% --freeze-exceptions <saída.json> --plan-stage I1 --module <Módulo>
%PY% %T% --platform odc --stage job --job <job.json>
```

Outras opções:

- `--mode autor|integrador`. No modo autor, exceção `proposta` já cobre o achado. No modo integrador só exceção
  `aprovada` vale; o estágio truechange exige `--result` ou `--deliver-result`; o estágio oml exige `--base-oml`
  (usado só para marcar achados preexistentes); exceção inválida, vencida ou sem uso dá exit 1; aviso ou pergunta
  sem resposta dá exit 3.
- `--module` é o módulo avaliado (camada da AR1, site properties esperadas, exceções por módulo). No estágio oml,
  quando não é passado, vem do próprio OML.
- `--plan-stage` é o estágio do plano do projeto (por exemplo I1, I2). O número é o primeiro inteiro do texto. Ele
  filtra as exceções que têm `stages` e as site properties esperadas que têm `fromStage`.
- `--work` (padrão `<kernel>/.local/padroes/work`), `--out` (padrão `<kernel>/.local/padroes/<módulo>.padroes.json`),
  `--cli` (padrão: `OUTSYSTEMS_PADROES_CLI`, senão `<kernel>/.local/cli/anvil.dll`), `--parallel` (consultas
  inspect em paralelo, padrão 4) e `--quiet`.

`<kernel>` é a primeira pasta acima do script que tem `MANIFESTO.md` e `scripts/`; `OUTSYSTEMS_PADROES_KERNEL` troca.

## Plataformas

Todas as regras valem no O11 e no ODC, menos a AR1 (Architecture Canvas), que é só do O11. A detecção, porém, ainda é
só do O11:

| Plataforma | O que roda hoje |
|---|---|
| O11 (`--platform o11`, padrão) | Os detectores dos estágios job, truechange e oml (jobs e OML do O11) e o estágio runtime. |
| ODC (`--platform odc`) | Só o estágio runtime. Os estágios job, truechange e oml não rodam: cada regra sai como "não checada no ODC ainda", a AR1 sai como "não se aplica ao ODC" e o exit é 3 sempre que um desses estágios foi pedido. Nada passa calado. |

O relatório traz `ruleStatus`, uma linha por regra com `status`: `checada`, `revisao-manual` (sem detector; fica na
pergunta de revisão), `fora-dos-estagios` (há detector, mas não nos estágios pedidos), `nao-checada-odc` ou
`nao-se-aplica`. A plataforma vem de `--platform`, senão de `config.platform`, senão é o11.

## Saída e códigos

O relatório (esquema `outsystems-padroes/1`) traz `inputs` com sha256, `summary` por regra, `ruleStatus`,
`findings[]` (com `rule`, `severity` erro, aviso, info ou "pendente contrato", `element{path,key,job}`,
`generatedBy`, `preexisting`, `suggestion`, `exception` e `scope`), `manualReview[]`, `runtimeTests[]`,
`staleExceptions[]`, `invalidExceptions[]`, `pendingExceptions[]`, `toolErrors[]`, `notes[]` e `coverage`.

| Exit | Significado |
|---|---|
| 0 | Nenhum achado bloqueante. |
| 1 | Erro sem exceção aplicável, K0 falho ou evidência de runtime com falha. No integrador, também exceção vencida, sem uso ou inválida. |
| 2 | Falha de ferramenta ou de entrada (fail-closed): config ou exceções ilegíveis, CLI ausente, leitura do OML incompleta, entradas inconsistentes (por exemplo `data.outPath` diferente de `--oml`). |
| 3 | Pendência: no integrador, aviso ou pergunta de revisão sem resposta, ou `runtimeTests` incompleto; no estágio runtime, item sem `runtimeEvidence`; no ODC, regras não checadas. |

## Config

A config do projeto é um JSON. Ordem de busca: `--config`, `OUTSYSTEMS_PADROES_CONFIG`,
`<kernel>/.local/padroes/config.json` e, por fim, [config.example.json](config.example.json). Chave ausente usa o
padrão da ferramenta; `modules`, `limits`, `describedKinds`, `timeoutPolicy`, `expectedSiteProperties`, `p7`, `l6`,
`suggestions` e `layerOrder` são mesclados um nível. Nenhum padrão traz nome de projeto ou de cliente.

| Chave | Para quê | Padrão |
|---|---|---|
| `platform` | `o11` ou `odc`. | `o11` |
| `layerOrder`, `modules`, `modulePatterns`, `forbiddenRefs` | AR1: camada de cada módulo e referências proibidas. | Módulos da plataforma em Foundation; sufixos `_CS`/`_CW` Core, `_IS`/`_TH` Foundation, `_UI` End-user. |
| `patternLibrary` | U2: library de padrões do app. Vazio = só o OutSystems UI. Quando preenchida, entra em `libraries`. | vazio |
| `libraries` | U4: módulos onde bloco pode ter StyleSheet. | OutSystemsUI, OutSystemsCharts |
| `timeoutPolicy` | S4: `restTimeoutSeconds` (valor exato), `minSeconds`, `maxSeconds`. TimeoutinSeconds explícito é sempre exigido. | só a exigência de valor explícito |
| `integrationModules` | S3/D4: módulos que podem ter REST. Vazio = sem restrição. | vazio |
| `longRunning`, `asyncStarters` | AR3: processos longos e os starters assíncronos que a tela pode chamar. | vazio |
| `guardActions`, `subjectEntities` | AR2: globs das actions de guarda; expressões das entidades com dado do sujeito. | `Require*`, `Guard_*`, `Auth_Require*`; vazio |
| `p7` | P7: `protectedEntities`, `allowedEntities`, `entryPatterns`, `forbiddenCalls`, `siteSwitches`. A checagem de escrita fica desligada com `protectedEntities` vazia; os switches valem quando listados. | tudo vazio |
| `numericAllowProps`, `literalAllowProps` | L7: listas de permissão de literais. | lista de propriedades de tamanho e timeout; `ISiteProperty.DefaultValue` |
| `expectedSiteProperties` | E3/S3: site properties obrigatórias por módulo, com `isSecret` e `fromStage`. | vazio |
| `verbs`, `extraVerbs`, `booleanPrefixes`, `contractNames` | N1: verbos de início de action, prefixos de booleano e nomes de contrato congelados (saem como "pendente contrato"). | lista de verbos em inglês; Is, Has, Can |
| `describedKinds`, `describedIgnoreNames`, `limits` | N1/N3/E1: tipos que precisam de descrição e limites de passos e de locais. | ver o script |
| `templatePaths`, `anonymousScreens` | Conteúdo do template da plataforma (achado sai como info) e telas que podem ser anônimas. | template Reactive; Login |
| `sensitivePattern`, `l6` | E2 e L6: nomes sensíveis e campos JSON restritos. | padrão de token e senha; vazio |
| `suggestions` | Dica do projeto por regra, acrescentada à sugestão neutra de cada achado. | vazio |
| `approvers`, `exceptionsFile` | Quem pode aprovar exceções e onde fica o arquivo de exceções (relativo à config). | vazio |

## Exceções

O arquivo vem de `--exceptions` ou de `config.exceptionsFile`; sem nenhum dos dois, nenhuma exceção se aplica.

```json
{"schema": "outsystems-padroes-excecoes/1",
 "exceptions": [{"id": "EX-01", "rule": "L6", "module": "Exemplo_CS",
   "element": {"objectKey": "<ObjectKey do OML, quando houver>",
               "path": [["ServerAction", "ParseResponse"], ["JSONDeserializeNode", "DecodeBody"]]},
   "match": "suffix",
   "reason": "JSON externo da API.",
   "evidence": "onde a decisão foi registrada",
   "status": "proposta",
   "approval": null,
   "expires": "AAAA-MM-DD",
   "stages": ["I2"]}]}
```

- **Elemento.** O casamento é por `objectKey` quando houver; senão, pelo caminho em pares (Kind, Nome): `suffix`
  (padrão, pelo menos 2 níveis), `exact` ou `pattern` (globs, exige `maxMatches`). `rules` aceita uma lista no lugar
  de `rule`. Elemento vazio nunca se aplica e sai em `pendingExceptions`.
- **Aprovação.** `status` é `proposta` ou `aprovada`. `aprovada` exige `approval` = `{"by", "at", "message"}`, com
  `by` em `config.approvers`, a data e a hora UTC e o texto literal da mensagem de quem aprovou. Quem escreve o código
  nunca edita `status` nem `approval`; quem aprova grava, ou o integrador transcreve a mensagem literal a pedido de
  quem aprovou. Aprovador fora de `approvers` ou `aprovada` sem `message` torna a exceção inválida.
- **Aplicação.** No modo autor, `proposta` e `aprovada` cobrem o achado; no integrador, só `aprovada`. Exceção
  vencida (`expires` no passado) não se aplica. Exceção que não cobriu nenhum achado num estágio que leu o elemento
  vira `staleExceptions`. P7 e K0 não aceitam exceção.
- **Congelamento por estágio.** `--freeze-exceptions <saída> --plan-stage <estágio> --module <Módulo>` grava a cópia
  com só os registros que valem ali e o sha256 da fonte. Passe a cópia em `--exceptions`; cópia de outro estágio ou
  de outro módulo dá exit 2. O formato antigo `o11-padroes-excecoes/1` também é aceito.

## Revisão (`--review`)

```json
{"answers": [{"questionId": "<id do achado aviso ou da pergunta>", "answer": "...", "reviewer": "..."}],
 "runtimeEvidence": [{"testId": "...", "result": "pass|fail", "test": "E2E-...", "evidence": "..."}]}
```

## Testes

```
python -m unittest discover -s kernel/scripts/outsystems_padroes/tests -v
```

Cada `tests/casos/<nome>.expect.json` vira um teste (exit esperado, achados que precisam e que não podem aparecer,
situação das regras). Os casos dos estágios job, truechange e runtime e os casos de ODC rodam offline. Os casos do
estágio oml precisam do CLI anvil e dos OMLs gerados a partir dos jobs compostos (`o-composite-service.json`,
`o-composite-reactive.json`, `positive-conforming.json`); sem eles o caso sai pulado, com o motivo.

- `OUTSYSTEMS_PADROES_CLI`: anvil.dll de origem. O teste copia a pasta do CLI para uma pasta temporária e roda a cópia.
- `OUTSYSTEMS_PADROES_NEG_OML`: pasta com os OMLs e os `.result.json` dos casos (padrão `<kernel>/.local/padroes/neg-oml`).
- `ANVIL_STUDIO_DIR`: DLLs do Service Studio 11, só leitura (padrão: a instalação padrão, se existir).
- O teste fixa `ANVIL_WORKER=0` e `ANVIL_ODC_NO_WORKER=1`; nenhum worker é iniciado.

## Planejado

- Ferramenta MCP na orquestração unificada, com o mesmo contrato de entrada e o mesmo relatório.
- Porte para fora do Python, com a mesma semântica e os mesmos casos de teste.
- Detectores para o ODC, para que as regras deixem de sair como "não checada no ODC ainda".
