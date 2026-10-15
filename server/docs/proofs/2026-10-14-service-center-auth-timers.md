# Service Center: autenticação, agendas e retorno de Run Now

## Causas corrigidas

O login privado permitia 45 s na requisição ao provedor, mas seu processo e a leitura chamadora eram encerrados em até 29 s. O Service Center agora tem orçamento total de 90 s; o processo privado, até 65 s, sem ultrapassar o orçamento restante. Logins simultâneos da mesma identidade são compartilhados, com jars separados por chamada. Erros de validação/layout deixam de expulsar uma sessão válida do cache. Nenhuma senha, token de identidade ou cookie é persistido por essa mudança.

O texto de regras do time recomendava agendas como `Every day at 03:00`. O setter do Studio aceitava armazenar essa prosa, mas o runtime não a interpretava. Em um caso vivo o Service Center respondeu à ativação sem que o timer deixasse de estar desativado. O compilador DDL agora recusa a agenda antes de gerar a criação; o setter já fazia validação e ganhou regressões explícitas; a ativação no Service Center também recusa o valor inválido antes de qualquer POST. As referências de autoria foram corrigidas.

O Run Now recebia HTTP/AJAX mas não reconhecia uma confirmação; isso aparecia como `SC_LOCAL_FAILURE`. Agora a própria chamada lê a evidência e retorna um outcome explícito. A repetição do UUID consulta o recibo, sem repetir o envio. Evidência de execução e atribuição ao solicitante são campos separados; não há promessa de conclusão bem-sucedida baseada apenas em HTTP 200.

## Validação viva

Ambiente: `personal-2qqw9srv.outsystemscloud.com`, módulo `DCIPS_Jobs` (656). Toda interação remota ocorreu pelas ferramentas `ssam-proto`.

- Login frio com o novo orçamento concluiu com `auth.path=vault-sso`; leituras e escritas posteriores usaram `vault-sso-cache`, sem nova tentativa de senha no fluxo.
- Os seis timers recorrentes foram publicados com 288 horários nativos, de `00:00` a `23:55`, a cada 5 minutos, todos os dias.
- Os cinco diários foram publicados com `01:00`, `02:00`, `03:00`, `03:30` e `04:00`, mantendo seus horários pretendidos.
- Ativação dos 11 confirmada; um Run Now por timer, cada um com UUID próprio. Verificação observou execução para os 11. Não foi reenviado nenhum Run Now.
- Leitura `timers` às `2026-10-14T19:29:58Z`, sem truncamento: todos tinham próxima execução datada (nenhum desativado).
- `ssam_code {action:"check", lane:"o11", part:"ddl"}` recusou `Every day at 03:00` com `TIMER_SCHEDULE_INVALID` no preflight, sem criação/publicação. A checagem foi executada pela ferramenta pública contra o contexto de `DCIPS_Jobs`.

| Timer | Last Run exibido pelo Service Center |
| --- | --- |
| CampaignScheduler | 2026-10-14 19:25:39 |
| FhIntakePurgeExpired | 2026-10-14 19:25:59 |
| MartsDailyRefresh | 2026-10-14 19:26:22 |
| MetricScheduler | 2026-10-14 19:26:40 |
| MilestoneLetterScheduler | 2026-10-14 19:27:02 |
| MissedEngagementScheduler | 2026-10-14 19:27:21 |
| NaraMarkEligibleBatch | 2026-10-14 19:27:21 |
| NotificationScheduler | 2026-10-14 19:27:41 |
| ReportScheduler | 2026-10-14 19:28:03 |
| TrainingExpirationAlerts | 2026-10-14 19:28:03 |
| TrustedHelperExpireStale | 2026-10-14 19:28:21 |

Os horários da tabela são os exibidos pelo Service Center, sem conversão presumida. A evidência comprova execuções observadas e agenda ativa; não identifica causalmente o Run Now frente ao agendador recorrente.

## Regressões

`dotnet test kernel/tests/Anvil.Tests -c Release --filter FullyQualifiedName~TimerScheduleTests`: 27 aprovados, incluindo rejeição DDL antes de criar e preservação de intervalos após salvar/reabrir o modelo nativo.

Na pasta `platforms/odc/facade`, executar:

```text
node --test tests/sc-sso-session-cache.test.mjs tests/sc-identity-vault.test.mjs tests/sc-community-identity.test.mjs tests/read-budget.test.mjs tests/service-center-modern.test.mjs tests/service-center-receipt-resolution.test.mjs tests/pacote-laneF-sc-session.test.mjs
```

Resultado: suíte com 106 testes aprovada; após acrescentar a regressão de UUID ainda em voo, os 12 testes de recibos passaram novamente (107 casos distintos na fachada). Cobertura: login concorrente único, separação de cookies e identidades, expiração real, recusa local sem expulsar sessão, orçamento de login frio, desafios sem repetição, agenda inválida sem reserva/POST, retorno explícito sem confirmação AJAX, reconciliação por execução observada e UUID repetido sem novo POST.
