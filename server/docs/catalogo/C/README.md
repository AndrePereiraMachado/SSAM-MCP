# Catálogo abrangente — Frente C (referências, integrações, diagnóstico e operação)

Contrato: `ssam-catalog-contribution/1` (`platforms/odc/facade/catalog/README.md`). Base: `64c3b0d` (M0) sobre a
Fase 3 final `7a10686`, com `claude/catalog-integration` incorporado até `f0a1e3d` (inventário reconciliado, classe
outside-object-root, referências por faixa, kernel INT-T2-002 com C-001, CLIs e resultados distribuídos às 23:34Z) e,
para o fecho D-M2-6, até `8d9ba14` (A integrada). Branch `claude/catalog-c`. Data: 23–24/09/2026. Nada aqui foi executado contra Studio, tenant, Portal ou dados; nenhuma
publicação, login ou escrita externa.

## 1. O que a entrada pública passa a responder

`ssam discover "<intenção>" --lane odc|o11` (MCP `ssam_discover`) devolve, para as famílias da C, a capacidade com a
operação pública exata, o estado por papel × operação × faixa (evidência calculada pelo carimbo da faixa) ou a
ausência declarada com motivo, evidência e alternativa. Fragmentos em `platforms/odc/facade/catalog/fragments/C/`:

| Fragmento | Capacidades | Ausências declaradas | Substitui (legado da C) |
|---|---|---|---|
| `rest.json` | `integration.rest-consume` (op `rest` ou verbos crus), `integration.rest-expose` (op `rest-expose`), `integration.rest-import` (OpenAPI) (ODC+O11) | `integration.rest-credentials-in-model` (ODC) | `logic.rest-consume`, `logic.rest-expose`, `rest-credentials-in-model` |
| `soap.json` | `integration.soap` (op `soap`, O11) | `integration.soap-odc` (ODC) | — |
| `dotnet-extensions.json` (lane xif) | `integration.dotnet-extension-o11` (O11) | — | — |
| `external-libraries.json` (lane extlib) | `integration.external-library-odc`, `reference.external-library-odc` (ODC) | — | — |
| `timers.json` | `timer.schedule` (ODC+O11) | — | `logic.timer` |
| `settings-roles.json` | `security.settings-roles` (ODC+O11) | — | `data.setting` |
| `processes.json` | `process.bpt` (O11) | `process.odc-workflow` (ODC) | `bpt-process` |
| `references.json` | `reference.producer-import` (O11) | `reference.import-headless-odc` (ODC) | `reference-import-headless` |
| `operations.json` | `read.discover`, `read.inspect`, `deliver.job`, `data.records`, `ops.debugger`, `ops.environment`, `diagnostic.troubleshoot` (ODC+O11); `deliver.feature`, `deliver.publish`, `ops.references-refresh`, `ops.studio-session`, `ops.portal` (ODC) | `deliver.publish-o11`, `ops.references-refresh-o11`, `ops.portal-o11` (O11) | `read.inspect`, `deliver.job`, `deliver.feature`, `deliver.publish`, `data.records` |
| `integrations-without-route.json` | — | `ai.agents`, `ai.semantic-search`, `event.global-events` (ODC); `integration.sap`, `ai.agents-o11`, `event.global-events-o11` (O11); `integration.rest-callbacks` (ambas). SOAP saiu para `soap.json`; bibliotecas externas do ODC, para `external-libraries.json` | `agents` |
| `accounting.json` | gerado por `contabilidade-c.mjs` (regras revisáveis; não editar à mão) | — | — |

Todas as 9 capacidades e 4 ausências legadas da C estão substituídas; as referências de outras frentes a
`read.inspect`/`deliver.feature` continuam válidas (mesmo id).

## 2. Contabilidade (inventário reconciliado, sha256 `bf176bc2…`, ODC Studio 1.7.25.10778 / O11 11.55.87; `catalog-check --front C`)

| Faixa | Tipos (elementos) | Representados (papel de capacidade) | Excluídos (com motivo) | Lacuna (aplicável, sem rota) | Indeterminado | Não contabilizados |
|---|---:|---:|---:|---:|---:|---:|
| ODC | 177 | 14 | 93 | 31 | 39 | **0** |
| O11 | 97 | 20 | 29 | 40 | 8 | **0** |

| Faixa | Fora das raízes de objeto (`outsideRoot`, C-007) | Excluídos | Lacuna | Indeterminado | Não contabilizados |
|---|---:|---:|---:|---:|---:|
| ODC | 115 | 112 | 0 | 3 | **0** |
| O11 | 44 | 41 | 3 | 0 | **0** |

Mudanças do inventário reconciliado: saem `ICallableAgent`/`ICallableAgentSignature` (removidos no Studio 1.7.25);
entram `IKnowledgeBaseReference` e `ICallAgentManifestNode` (indeterminados, como os demais elementos de agente) e
`IToolReferenceAction` (assinatura). A classe outside-object-root (aplicações/módulos referenciados, extensões,
bibliotecas externas, merge, chaves e endereços, mensagem de Verify, metamodelo e serviços, plugins de modelo,
chunking de base de conhecimento, internos dos plugins REST/SOAP, gatilhos de processo) tem tabela de regras própria
(`OUTSIDE_RULES` em `contabilidade-c.mjs`); só os gatilhos BPT do O11 são lacuna (recurso aplicável sem job). C-001
resolvido: os papéis REST do ODC voltaram a ter tipo nativo e aparecem `proven-current`; ficam duas entradas explícitas
só para registrar a classe corrigida de `IRestAction`/`IRestService` (criados pelo módulo).

Números após a verificação cruzada (dois subagentes, cada um sobre os fragmentos montados a partir da extração do
outro): 30 achados confirmados aplicados (ex.: `IConsumedAction` é base; clientes SOAP/SAP alcançáveis pela fábrica
genérica = lacuna; IA com aplicabilidade indeterminada = indeterminado, não lacuna; árvore de agendamento com
`Interval`/`WhenPublished` graváveis e não testados; `IsSecret` não protege nada no modelo; leituras O11 de
`Site.<Nome>` existem; o O11 reconcilia escrita de dados por recibo `DataReceipt`), 1 achado refutado na conferência
(o catálogo O11 TEM fábricas de callback de processo).

Ferramentas operacionais: 35/35 `represented` pela capacidade que traz o seu contrato (C-005 resolvido). Zero não
contabilizados também por classe (concreto, base, assinatura, indeterminado, fora das raízes).
Denominadores separados; nenhum percentual global. "Representado" = um papel de capacidade nomeia o tipo; não é
prova. Excluído = assinatura referenciada (consumidor não edita), interface-base, gerado (árvore de agendamento
do timer), raiz/mixin abstrato, ativo separado do ODC, ferramenta; cada entrada tem `reason` e `origin`.

A proposta de dono das interfaces fora das raízes (`docs/evidence/catalogo-abrangente/C/noroot-candidates.json`,
pedido C-007) foi resolvida pelo integrador (`4380c47`): ODC 161 = A 45 / B 1 / C 115, O11 62 = A 18 / C 44.

## 3. Diferenças ODC × O11 comprovadas (nunca por nome igual)

- REST: o O11 aceita `Username/Password` do cliente no modelo; o ODC os recusa no Verify. Exposto: o job O11 grava
  `ReceiveIn`/`SendIn`, o ODC não. Manutenção (editar, renomear, usages) provada só no ODC; no O11 fica indeterminada.
- Timer: só o ODC tem `CronSchedule` (5 campos) e a árvore `ScheduleConfiguration` derivada (valores só leitura;
  `Interval`/`WhenPublished` graváveis, não testados); o O11 tem a string `Schedule`. `TimeoutInMinutes` e
  `Priority` existem nas duas faixas, mas nenhum job O11 os grava.
- Dados: o O11 reconcilia escrita por recibo (`DataReceipt`: operationId, `pending`/`completed`, repetição recusada);
  o ODC não tem marcador de início (pedido C-009).
- Role: `create IRole` devolve `IAppRole` no ODC (IRole é base) e `IRole` no O11. Prefixo `Settings.` × `Site.`.
- Processos: BPT provado no O11; no ODC processos são Workflows do Portal (nenhuma rota do modelo).
- Referências: verbo `reference` provado no O11; no ODC indeterminado (declarado indisponível; importação congelada
  lança exceção; atualização viva por `studio_refresh_references` ou feature C# com `AddDependency`).
- Publicação: ODC `studio_authorize` + `studio_publish`; o O11 nunca publica (o humano publica no Service Studio).
- IA, busca semântica e eventos globais não existem no catálogo O11 (11.55.69); SAP só no O11.

## 4. Diagnóstico comum e reconciliação (capacidade `diagnostic.troubleshoot`)

- Resultado: `ok | gate_refused | native_error | uncertain` (a operação nativa já foi entregue ao Studio).
- Gates do bridge ODC: `base_drift, equivalence, authorship, provider_state, pending_match, studio_busy,
  key_not_found, scope, candidate_validation, retry_refused, none` — classificação por substring (heurística,
  declarada como tal).
- Verify do kernel: `validation.{new, fixed, preexisting, unexpected, missingExpected, ambiguous, tolerated}` com
  `{id, type, key, path, detail}` (chave `[msgId, objectKey, [props], [messageParameters]]`, `ModelHost.cs:215-216`;
  caminho de exibição). Fato nativo.
- Portal: `OdcError {code, message, location, issues, status, retryAfterSeconds, retrySafety}`.
- Localização: `Kind:Name`, `$pai/Filho` ou `@key` presos ao `sourceSha256` da captura; sem localização nativa,
  declarar ausência e devolver a melhor evidência (texto, caminho do módulo), sem falsa precisão.
- Hint = causa comprovada (mensagem nativa, recusa de gate, código do Portal) ou hipótese rotulada (classificação
  heurística). Nunca "corrigir" trocando alvo/ambiente, repetindo merge/publicação/criação/atualização/escrita de
  dados incerta, ou desligando validação: resultado incerto se reconcilia pelo recibo (`receipt.json`,
  `last-error.json`, `publish-status.json`, `refresh-*.json`, journal) e a decisão volta ao usuário.
- Limites reais que continuam (C-009, parte do bridge em C#, fora desta campanha): escrita de dados ODC sem
  `operationId` nem marcador de início (o O11 tem `DataReceipt`), recibo do refresh de referências gravado antes da
  última verificação, `studio_open` corta o nome no primeiro espaço. Resolvidos na fachada (`42d33e8`): falha durante o
  merge do caminho feature é `uncertain`; journals guardam gate, estágio, evidência e a captura lida.

## 5. Validação e testes

```powershell
node platforms/odc/facade/catalog-check.mjs --front C                      # T0 puro
node docs/catalogo/C/contabilidade-c.mjs --check                          # contabilidade = regras
.\ssam discover "<intenção>" --lane odc --rebuild --budget 12000          # T0 real (e --lane o11)
node --test --test-reporter=tap "platforms/odc/facade/tests/catalog-c-*.test.mjs"   # T1 da frente
```

Evidências: `docs/evidence/catalogo-abrangente/C/` (saída do T0, matriz T1 de 14 intenções × 2 faixas × 2
orçamentos, sonda nativa ODC dos tipos REST — hoje com candidatos —, candidatos noRoot). A frente não executou teste
nativo (T2): as provas citadas são dos jobs das suítes existentes, com as CLIs e os resultados carimbados distribuídos
pelo integrador (INT-T2-002: ODC 74/74 e O11 61/61 atuais, kernel ODC `60d90d14…`, O11 `cbf2dfa7…`). No O11 só os
jobs de `tests/provenance-o11.json` são carimbados; das provas da C entram `rename-logic-propagation`,
`email-digest-foreach-traditional`, `consume-reference-static` e `hidden-reference-block` — as demais provas O11
aparecem como `declared-not-proven`/C-suite.

## 6. Pendências e dependências

Pedidos em `control/requests/C/` e estado (DECISOES D-M2-4, relatório do integrador): resolvidos C-001 (sonda nativa
ODC dos plugins, kernel `41fdaaa` distribuído), C-003 (`unavailable` preservado no orçamento), C-004 (regressão da
base independente dos fragmentos), C-005 (ferramenta `represented` por `capability`), C-006 (referências e
`requires` por faixa), C-007 (classe outside-object-root), C-008 (seleção), C-009 na fachada; C-002 fechado pelo D-M2-6 (o papel
de client variable saiu de `security.settings-roles`, que aponta para `data.client-variable` de A em `alternatives`;
`logic.server-action` é `depends` de `timer.schedule` e `recommends` de `integration.rest-consume` nas duas faixas, sem
`requires`); abertos: C-009 no bridge (C#) e C-010 (sinônimo `publicacao`
reduzido a `publica` colide com o adjetivo "pública").

Preparação documental do M4 (proposta à integradora, sem autorização de liberação): [PREPARACAO-LIBERACAO.md](PREPARACAO-LIBERACAO.md).
