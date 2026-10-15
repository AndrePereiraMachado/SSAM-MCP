# Leitura do request/response histórico de integração O11

## Alteração

Adicionada a action pública `integration-log-detail` a `o11_service_center_read`, ao parser e ao catálogo do discover.
A chamada recebe `host`, `requestKey`, `logAction` (nome exato) e `moduleId` opcional.

A leitura correlaciona três fontes: Request Log sob o RequestKey solicitado, exportação nativa de integrações
e a linha da listagem com módulo, ação, tipo e instante correspondentes. Não usa a configuração atual
do módulo para deduzir o que foi gravado no passado. Reaplica os filtros em cada leitura; seleções
persistidas de outras chamadas não mudam silenciosamente o escopo.

Somente um link de detalhe de leitura observado na linha exata pode ser seguido. Origem externa,
rotas arbitrárias, controles com scripts, identidade divergente e ambiguidades são recusados.
O parser de detalhe exige Request Key, Action, Module e Time of Log antes dos campos Request/Response.
Headers de autenticação, cookies e campos secretos JSON, XML e formulário/query são mascarados.
Nenhuma integração REST/SOAP é reexecutada e nenhuma configuração de logging é alterada.

## Resultados determinísticos

- `available`: campos Request e Response lidos do detalhe e vinculados ao evento.
- `not-exposed`: linha nativa exata sem controle de request/response. Não prova que o payload não foi gravado.
- `not-recorded`: detalhe exato com mensagem explícita de ausência de gravação.
- `permission-denied`: acesso negado pela plataforma.
- `event-not-found`, `ambiguous-event`, `incomplete-list`, `identity-unverified` ou detalhe não suportado:
  não há payload suficiente para responder com segurança; valores permanecem `null`.

## Validação real em 14/10/2026

Ambiente `personal-2qqw9srv.outsystemscloud.com`; módulo histórico `DemoLATAM_IS`, ID 629.
RequestKey `a21c2707-3ca1-4d6c-9e46-bcb72f672d24`.

| Ação | Instante exibido pelo SC | Resultado da nova ferramenta |
| --- | --- | --- |
| ViaCEP.FetchAddress | 2026-10-14 03:57:15 | SC_INTEGRATION_PAYLOAD_NOT_EXPOSED |
| OpenMeteo.FetchForecast | 2026-10-14 03:57:16 | SC_INTEGRATION_PAYLOAD_NOT_EXPOSED |
| Geocoding.FetchCoordinates | 2026-10-14 03:57:15 | SC_INTEGRATION_PAYLOAD_NOT_EXPOSED |

As três respostas confirmaram uma linha correspondente e zero controles de detalhe, retornando
request/response `null`, `recordingStatus:unknown` e `replayed:false`. A inspeção anterior do
módulo retornou Permission denied, mas isso não foi confundido com prova de ausência de gravação.

Não houve prova viva de extração de um corpo disponível: os três eventos reais não expõem o detalhe.
O caminho `available` é coberto por fixtures sintéticas de página, com identidade completa.
Após a correção, a consulta às integrações do módulo 629 retornou `SC_PERMISSION_DENIED`,
em vez do erro anterior `LAYOUT_UNKNOWN`.

## Testes

`platforms/odc/facade/tests/sc-integration-payload.test.mjs` cobre identidade exata, duplicatas,
ausência de link, payload vazio gravado, ausência explícita de gravação, cabeçalhos/JSON/XML/query
secretos, links externos ou destrutivos, script recusado, permission denied, execução do leitor
pela rota pública e ausência de reexecução remota. `discover-tools.test.mjs` cobre descoberta da action.

Resultados: 8 testes específicos aprovados; 126 regressões de Service Center aprovadas; teste
direcionado da descoberta aprovado. A rodada ampla teve 185/186 aprovados; a única falha foi a
preexistente classificação dos enums `patch` em studio_deliver, ssam_code, o11_job e ssam_job,
sem relação com a nova action. Sintaxe dos módulos e `git diff --check` sem erros.
