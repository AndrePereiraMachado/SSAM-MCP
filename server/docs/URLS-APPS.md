# URLs de apps e telas

Use **`ssam app <App> [Tela]`** ou MCP **`ssam_app_url`**. A URL faz parte da resposta oficial da ferramenta; não é necessário descobrir o endereço pelo botão View app.

```powershell
.\ssam app SSAMDLV2CanaryODC1 Stage1BindingProbe
.\ssam app SSAMDLV2CanaryODC1
.\odc app SSAMDLV2CanaryODC1 --screen Stage1BindingProbe --tenant personal-nv0s5uly.outsystems.dev
.\ssam app MinhaApp MinhaTela --environment https://runtime.exemplo.com
```

MCP, sem precisar de Studio ou credencial quando o ambiente é explícito:

```json
{"app":"SSAMDLV2CanaryODC1","screen":"Stage1BindingProbe","environment":"https://personal-nv0s5uly-dev.outsystems.app"}
```

| Campo retornado | Uso |
| --- | --- |
| `url` | Tela solicitada, ou home quando não há tela |
| `appUrl`, `homeUrl` | `ambiente/App/`; o runtime abre a tela configurada como home |
| `screenUrl` | `ambiente/App/Tela`, ou null quando não foi solicitada |
| `environment`, `source` | Origem usada e se veio do argumento explícito ou configuração do stage |

Sem `environment`/`--environment` nem `tenant`/`--tenant`, consulta o ambiente conectado do módulo; para app que não está aberto, exige uma única sessão autenticada. Ambiguidade é informada, sem escolher o tenant default do Portal.

As duas faixas (20/10/2026, relatos 365814c3 e 3cf11056): `lane`/`--lane o11|odc` nomeia o Studio do app. Sem `lane`, responde o Studio em que o app está aberto; aberto nos dois, recusa pedindo `lane`; aberto em nenhum, responde o único Studio conectado. No O11 o ambiente é o host do módulo (`https://<host>/<Módulo>/<Tela>`) e uma tela de módulo Traditional Web termina em `.aspx` (`screenKind: traditional`, lido do digest da captura; `unknown` quando a captura não pôde ser lida, e aí a resposta diz que a forma `.aspx` existe). `laneSelection` diz se a faixa veio do argumento (`explicit`), do módulo aberto (`connected-module`) ou do único Studio conectado (`connected-studio`). `--stage` usa o nome exato configurado, sem distinguir maiúsculas; não infere domínio por substring. Um domínio personalizado pode ser passado diretamente em `environment`.

O domínio Development pessoal `personal-nv0s5uly-dev.outsystems.app` foi confirmado no Portal como Built-in, Active e Default e registrado em `platforms/odc/tenants.json`. O host de exemplo anterior com `www` falhou no certificado; a configuração foi corrigida a partir da listagem oficial. A revisão 6 abriu a tela e a home nesse domínio e passou nos três cliques de J4; recibos em `.local/f-closure/integration/j4-browser-proof.json` e `j4-home-proof.json`. Não se adiciona `www` automaticamente a outros ambientes; os domínios já configurados por stage são preservados.
As instruções iniciais dos servidores MCP anunciam essa ferramenta a cada nova conexão. Status inclui links por módulo, e snapshot, leitura, preview, merge, publicação e entrega incluem `appLinks` quando existe identidade suficiente do alvo. Leituras de telas acrescentam até 32 URLs das telas realmente encontradas e contam as omitidas; blocks/actions não viram rotas. Captura local só aproveita metadados laterais com SHA-256 correspondente. Quando a origem é desconhecida, a resposta indica `available=false` e como obtê-la explicitamente. Respostas compactas de diagnóstico da estabilização preservam o link principal.

LLMs devem apresentar o link do app e, ao trabalhar numa tela, o link da tela. A montagem é local e não abre navegador, publica ou autentica. `publicationVerified=false` e `browserVerified=false` distinguem um endereço montado da prova de publicação/interação. O comando não determina por leitura qual é o nome da home: usa o endereço do app, que deixa essa decisão ao runtime.

Alterações da fachada entram em novos processos CLI/MCP. Um servidor MCP já carregado continua com sua versão até a reconexão; não é reiniciado automaticamente, e nenhuma DLL do Studio precisa ser alterada.
