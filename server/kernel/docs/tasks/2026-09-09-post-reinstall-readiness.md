# SS4 e SS5 recuperados — prontidão operacional

Pedido: reinstalar as duas faixas após formatação, provar capacidades básicas no ambiente pessoal e parar. Concluído no recorte abaixo. Não constitui conclusão dos tradutores nem prova de cobertura universal.

## Instalação e retomada

- Base oficial Service Studio **11.55.87.65162**; cópias novas SS4/SS5 com bridge compilada contra essa versão.
- SS4: `C:\Users\andre\OutSystems\Service Studio 11 - Anvil 4516\Service Studio`; bridge 4516, CDP 9226, worker 4517.
- SS5: `C:\Users\andre\OutSystems\Service Studio 11 - Anvil 4536\Service Studio`; bridge 4536, CDP 9246, worker 4537.
- Atalhos **SS4 - SSAM Hybrid** e **SS5 - SSAM Hybrid** na área de trabalho. Abrem diretamente as cópias prontas.
- Login manual do usuário confirmado no ambiente `personal-2qqw9srv.outsystemscloud.com`. Nenhuma senha recuperada ou registrada por esta tarefa.
- CLI SS4 `.local/cli/anvil.dll`; SS5 `.local/lane-ss5/cli/anvil.dll`. Workers autenticados e o cliente `anvil_cli.run` comprovados nas duas faixas (`via=worker`).
- Para preparar um terminal: `. .local/readiness-20260909/Use-Lane.ps1 ss4` (ou ss5). Só altera ambiente do processo. Para abrir sem atalho: `.local/readiness-20260909/Open-Studio.ps1 -Lane ss4`.
- Não usar reinstalação/build como abertura rotineira. As dependências Roslyn oficiais do Studio foram preservadas; DLLs próprias e Esprima constam no manifesto/deps do runtime.
- Cópias antigas preservadas nos diretórios irmãos `.before-20260909`; CLIs antigos em `.local/readiness-20260909/previous-ss4-cli` e `previous-ss5-cli`.

## Provas realizadas

| Capacidade | Evidência real |
|---|---|
| Data high code | `Recovery.cs`: entidade RecoveryRun, FK para static RecoveryStage com dois valores; default conferido após merge |
| Logic high code | Soma com loop, condicionais/limites e multiplicação decimal; dez casos executados por HTTP |
| Logic nativa | Consulta, condição, criação idempotente e leitura persistida |
| Roles | RecoveryOperator criada; CheckRecoveryOperatorRole retornou false para anônimo |
| Integração | REST consumido ViaCEP retornou SP; cinco endpoints REST de laboratório publicados |
| Timer | RecoveryReadinessTimer executou na publicação, gravou um registro e permaneceu com Count=1 após nova publicação |
| Telas/blocks high code | Recovery.html gerou RecoveryReadiness e RecoveryCounter nativos; dois usos com estados independentes e evento changed |
| Browser E2E | Estado inicial A=0/B=0; dois cliques em A produziram A=2/B=0; clique em B produziu A=2/B=1, último evento=1; layout observado e labels corretos |

Resultado final HTTP: **13/13**. Publicações confirmadas nas duas faixas. `check-delivery` aceitou os três recibos finais, hashes sem alterações.

Tela: https://personal-2qqw9srv.outsystemscloud.com/ZZHtmlImports_UI/RecoveryReadiness

Backend: `ZZBoundaryComposition_CS`; UI: `ZZHtmlImports_UI`. Somente laboratórios pessoais foram alterados, nenhum DCIPS.

## Correções e limites observados

- Primeiro merge perdeu o default da FK Stage; a prova detectou. Recibo falho preservado, tarefa fechada com motivo, reentrega corrigiu. Não foi uma entrega sem retrabalho e a causa geral do merge não foi corrigida nesta tarefa.
- Actions C# públicas geram guarda de autenticação: HTTP anônimo retornou Access denied. Para testar cálculos puros por REST, os dois métodos do laboratório foram declarados **internal**, mantendo a autorização padrão do compilador. Não houve mudança de política global.
- O11 retorna primitivos REST como text/plain; o executor foi ajustado para interpretar números/booleanos e texto corretamente.
- Um diálogo modal pendente impediu um merge; foi cancelado pelo comando close_dialog e a mesma tarefa retomada, sem reiniciar o Studio.
- Não foram provados todos os tipos de integração, todas as operações de roles, telas complexas ou toda a semântica C#. Quando high code não cobrir uma tarefa, usar a entrada nativa/declarativa já disponível e seus gates.
- O script de diagnóstico CDP precisa de websocket-client, ausente no Python recuperado. Bridge, entrega, publicação, worker e navegador foram testados sem depender desse script.

## Artefatos

Tudo em `.local/readiness-20260909/`: fontes Recovery.cs/Recovery.html, backend.json, http-proof.json, worker-ss4.json, worker-ss5.json, manifestos ss4-installed.json/ss5-installed.json e recibos de publicação.

- CSharp final: `service-delivery/deliver/0221ff87e45746879da575e3af869ebe/result.json`.
- Backend: `backend-delivery/deliver/200f2161f0124555a02a9000595917a3/result.json`.
- UI: `ui-delivery/deliver/672e3b9628034cb2905ac1f1951299ce/result.json`.

Desenvolvimento encerrado após esta prontidão, conforme solicitado. Studios disponíveis para o usuário; workers sem trabalho em fila. Não retomar automaticamente a meta antiga de cobertura completa.
