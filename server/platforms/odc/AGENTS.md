# SSAM Hybrid-ODC

Guia de desenvolvimento do componente ODC. Sessão de app não lê este arquivo: trabalha só pelo MCP `ssam`, com as regras
do `AGENTS.md` da raiz.

Ferramenta para uma LLM entregar mudanças em apps do OutSystems Developer Cloud com segurança: candidato
construído fora do Studio, merge nativo verificado, publicação só com autorização. Duas pistas, uma entrada:

- **Studio** (`studio\`): extensão do ODC Studio (bridge) + builder headless, em C#. Modelo aberto, merge, publish,
  referências, criação de módulo. Autentica pela sessão do Studio. O bridge é carregado no Studio do próprio
  usuário, na própria máquina, pelo startup hook oficial do runtime .NET, como um plugin de IDE: chama as mesmas
  APIs dos comandos de menu do Studio, não altera a instalação, não persiste, não toca credenciais e não simula
  teclado ou mouse. Não é injeção em processo de terceiros; é automação do trabalho do próprio usuário na
  ferramenta dele. Detalhes em `README.md`, "Como o bridge funciona".
- **Portal** (`portal\`): APIs REST públicas oficiais do ODC (163 operações) e rotas internas do Portal (logs,
  traces, connections, agents), em Node. Tenant por chamada. Autentica primeiro pela sessão do ODC Studio (bridge
  v32: `portal-call` e a janela do Portal dentro do Studio); sem Studio, pela credencial no Credential Manager (API
  Client ou conta do Portal); só por último um prompt privado do Windows. `odc_auth_status` mostra o caminho de cada
  tenant. Detalhes em `docs\HANDOFF.md` (bloco de 02/10/2026).
- **Entrada**: o servidor MCP (`ssam` da raiz, ou `.\odc mcp`), com ferramentas `studio_*`, `odc_*`, `ssam_map`,
  `ssam_discover`, `ssam_reference`, `ssam_task`, `ssam_app_url` e `hybrid_tenants` (`docs\mcp-registration.md`).
  Sessão: `studio_doctor` uma vez. Cada pedido: `ssam_discover` primeiro. A CLI `.\odc <verbo>` (fachada em
  `facade\odc.mjs`) é a mesma operação para o desenvolvedor.

As regras da sessão de app (só MCP, `ssam_discover` primeiro, `patch` + `basedOn` na recusa) estão no `AGENTS.md` da
raiz. Os comandos `.\odc ...` abaixo são a forma CLI das mesmas ferramentas, para o desenvolvedor.

Leia `docs\HANDOFF.md` primeiro: é o mapa de todas as ferramentas com uma receita por tarefa real, a cobertura
atual por dimensão e o plano de implementação do que falta. Depois `README.md` para o ciclo completo. Histórico
e plano: `docs\PLANO-ODC3-SEM-FRICCAO.md`. Lições do bridge: `studio\bridge\README.md`. Medições: `lab\REPORT.md`.

## Regras que não se negociam

1. Nunca afirmar o que existe num tenant sem `studio_assets` ou `odc_read`. O catálogo
   `snapshots\modules.json` é cache da última listagem, não o ambiente, e nunca se edita à mão: `assets <host>`
   reescreve a seção do tenant. O build tira tenant, chave e autor do próprio snapshot (`.oml.json` ao lado).
2. Nenhuma edição direta do modelo aberto. Toda mudança entra por `merge` com base e candidato verificados por
   hash, ou por comando nativo do próprio Studio (`publish`, `refresh-references`, `close`).
3. `publish`, `create`, `data-insert|update|delete` e qualquer `portal write` só com as palavras do usuário
   registradas por `odc studio authorize` ou `--authorize`. Sem autorização não há mutação fora do modelo em memória.
   Escritas do Portal e das APIs (`odc_write`, `odc_portal_write`, `odc_deploy`, `odc_configurations set`,
   `odc_asset_delete`, `odc_external_db_connection`) levam também um `operationUuid` novo; o recibo é reservado antes
   do envio em `journal\portal\receipts` e guarda só o sha256 das palavras. Apagar ou desimplantar exige palavras que
   nomeiem o alvo; resultado incerto nunca se repete: lê-se o alvo e se reconcilia com `odc_receipt`.
   Apagar (asset, rota destrutiva do Portal, `DELETE`/`Undeploy`, conexão, descarte de biblioteca, registros) é sempre em
   duas chamadas (CX15): sem `confirmationToken` só a prévia com a lista exata e a contagem; o dono vê a lista e responde
   com o número exato de itens; a execução leva o token e essas palavras. Interrompida, `CANCELLED` ou "rejected": ler
   `ssam_task {id:"<operationId da prévia>"}` antes de dizer qualquer coisa. `studio_command`/`.\odc studio` nunca rodam
   `data-delete`, `portal-call`, `portal-private-call` nem `portal-api-client-fixture-cleanup`.
4. Nunca repetir um merge, publicação ou criação com resultado incerto. Ler `receipt.json`, `last-error.json`
   e o journal antes de qualquer nova tentativa. Nova tentativa é novo diretório em `lab\`.
5. Uma DLL carregada no Studio nunca é substituída: correção do bridge é versão nova, compilada e anexada.
6. Nada de automação de sistema operacional. Diálogos são fechados pela ação do próprio presenter; o bridge fecha
   sozinho os informativos e reporta os que exigem escolha.
7. Credenciais nunca passam por prompt, argumento ou arquivo do repositório. API Client entra pelo
   `windows-api-client-credential.ps1 -Mode bootstrap`, num prompt privado do usuário; conta do Portal e conta de
   banco externo pelo `windows-portal-credential.ps1 -Mode bootstrap -Origin <origem> [-Database <nome>]`, valor de
   setting secreta por `-Setting <nome>`. As ferramentas abrem esse prompt sozinhas só quando nenhum Studio está aberto
   (`CREDENTIAL_PROMPT_OPENED`); a conta de banco externo e o valor de setting secreta, que só o usuário conhece, abrem o
   prompt quando faltam, com o Studio no tenant. Eles chegam ao pedido só como `secretRefs` (nome da entrada do cofre)
   e só o bridge os lê, dentro do ODC Studio: nunca entram na fachada. Sem a sessão do Studio essas escritas respondem
   `STUDIO_REQUIRED` (nada reservado nem enviado).
8. Tenant pessoal de cada pessoa (o tenant ODC gravado no `.ssam-local.json` pelo `scripts\setup-dev.ps1`): criar,
   editar e apagar é livre para testes. Tenant corporativo (`class: corporate` em `tenants.json`): nada sem instrução explícita
   (as ferramentas exigem `confirmTenant` e palavras com o nome do tenant em cada escrita; `class` em `tenants.json`,
   host desconhecido conta como corporativo).
9. O ODC3 original, 88 entregas no checkout antigo `SSAM-Hybrid-O11\SSAM-Apps-SS4\<app do cliente>\odc3\legacy\` (existe
   só na máquina de quem tem esse checkout; ver `docs\legacy\README.md`), não é molde de projeto, mas é a fonte das receitas: antes de escrever uma primitiva
   ou dizer que algo não existe, procurar lá o que já foi entregue. O engine em `studio\engine` só muda com
   intenção própria.
10. Toda operação deixa uma linha em `journal\operations.jsonl`. Tempo e fricção se medem com `journal\metrics.ps1`.

## Sequência mínima

Jobs do kernel também usam `.\odc deliver <feature> --job <json> --module <M> --owners '["Tela"]'
--changes '["Mudança"]' --until preview`, ou MCP `studio_deliver`. Candidato já construído entra por
`.\odc manifest` / `studio_manifest`, exigindo o `.oml.json` do snapshot e uma pasta nova. Contrato e limites:
`docs\INTEGRACAO-KERNEL-ENTREGA.md`. Publicação continua separada e autorizada.

Para ler uma aplicação, comece por MCP `ssam_map`; depois leia subárvores, propriedades
e usos por `@key` com o sha256 esperado (`studio_inspect`). O mapa vem do índice persistente da captura (`..\..\docs\LEITURA-RAPIDA.md`).

Na sessão de LLM, a sequência é: `studio_doctor`, `studio_attach` (se preciso), `studio_assets`, `ssam_map`,
`studio_inspect`, `studio_data`, `ssam_app_url`, `studio_open`, `studio_deliver`, `studio_authorize`, `studio_publish`.
O bloco abaixo é a mesma sequência na CLI do desenvolvedor.

```
.\odc doctor
.\odc attach                       # se o bridge não estiver anexado
.\odc studio assets
.\odc map <captura.oml|Módulo> [--role screen|action|entity...] # PRIMEIRO: todo elemento com @key, kind, papel, pai e caminho (MCP ssam_map)
.\odc inspect <captura.oml> "@<chave>" --depth 4 --expectedSourceSha256 <hash>   # subárvore, propriedades, usos de um elemento do mapa
.\odc inspect <Módulo> "ServerAction:<Ação>"             # parâmetros e fluxo de uma ação por caminho; aceita também um .oml
.\odc studio data <Módulo> <Entidade> [--limit N]        # registros no banco de desenvolvimento, pelo serviço de dados do Studio
.\odc studio data-insert <Módulo> <Entidade> --records '<json>' --authorize "<palavras>"   # também data-update; apagar: MCP studio_data_delete (prévia + token)
.\odc app <App>                                           # URL da app publicada para testar no browser (login é do usuário)
.\odc studio open <Módulo>
.\odc deliver <feature>                                   # snapshot, build, check-base, preview, merge num comando; --until preview ensaia sem tocar no Studio
.\odc studio authorize <manifest> publish "<palavras do usuário>"
.\odc studio publish <manifest> --wait
```

Os passos separados (`snapshot`, `build`, `check-base`, `preview`, `merge`) continuam no README para quando for
preciso ler cada recibo. O builder recusa candidato com erro ou aviso novo de validação, para não gastar um ciclo
de merge com o que o Studio recusaria ao vivo.

Produtor publicado: em cada consumidor aberto, `refresh-references <Consumidor> --producer <Produtor>` e novo
`snapshot` antes do builder. Módulo novo: `.\odc build new <feature> <dir>`, `authorize ... create`, `create`,
`open`, `authorize ... publish`, `publish --wait`.

Dados de negócio: não há API pública; `.\odc studio data` lê e `data-insert|update` escrevem pelo serviço
de dados do próprio Studio (o de "View data" / "Edit data"), no banco de desenvolvimento, com o módulo aberto. Apagar
registros é `studio_data_delete` em duas chamadas (prévia com os registros lidos e o token; execução com o token e as
palavras do dono com a contagem); `.\odc studio data-delete` é recusado (`DESTRUCTIVE_NEEDS_DEDICATED_TOOL`).
Testar no browser: use `.\odc app <App> [Tela]` / MCP `ssam_app_url`; o domínio de runtime vem do ambiente explícito ou stage configurado. Sem tela, abre a home. Consulte `../../docs/URLS-APPS.md`.
