# SSAM Hybrid-ODC

Entrega de mudanças em apps do OutSystems Developer Cloud por uma LLM, pelo caminho nativo do ODC Studio e pelas
APIs públicas do ODC. É o equivalente, para o ODC, do `SSAM-Interface-Hybrid` da faixa SS4. Este arquivo é o
runbook; `CLAUDE.md` e `AGENTS.md` são o resumo que qualquer sessão lê ao abrir a pasta.

## Estrutura

| Pasta | O que é |
|---|---|
| `facade\` | `odc.mjs`, a entrada única: `doctor`, `attach`, `studio`, `build`, `portal`. `odc.cmd` na raiz a chama |
| `studio\bridge\` | Extensão residente carregada no ODC Studio pelo startup hook oficial do .NET (`StartupHook.cs`) e o cliente (`client\`). Ver "Como o bridge funciona" abaixo |
| `studio\builder\` | Executável headless; uma feature é um arquivo em `studio\builder\features` |
| `studio\shared\` | Journal, Manifest, ModelPath, Authoring |
| `studio\engine\` | Verificação de equivalência e bootstrap de features nativas (origem em `studio\engine\README.md`) |
| `portal\` | MCP e adaptador das APIs REST públicas do ODC: catálogo fixado, OAuth, política de escritas, testes |
| `snapshots\` | Bases capturadas, revisões baixadas, `modules.json` (catálogo reescrito por `assets`) |
| `journal\` | `operations.jsonl`, uma linha por operação das duas pistas; `metrics.ps1` |
| `lab\` | Evidências, uma pasta por tentativa |
| `docs\` | `HANDOFF.md` (mapa das ferramentas, receitas por tarefa, cobertura e plano de implementação), plano e histórico, índice da Model API, ponteiro para o legado |
| `tenants.json` | Tenants conhecidos, origem do Portal e autor do Studio; nenhuma credencial |

Ferramentas: .NET SDK 10 (`dotnet`), Node 22+ (`odc.cmd` usa o Node do runtime do Codex quando não há Node no
sistema) e o ODC Studio instalado. `git` não está instalado nesta máquina.
O builder e o leitor residente carregam os assemblies do ODC Studio instalado; com `ANVIL_ODC_STUDIO_DIR` definida
usam só essa pasta (absoluta, com `OutSystems.Model.dll` e `OutSystems.ModelAPILoader.dll`, senão recusam ao
arrancar), e com `ANVIL_ODC_FEATURES_DIR` o builder lê o `Features.xml` só dessa pasta: a regra do kernel
(`StudioAssembliesOdc`, `OdcFeatures`), sem recurso à instalação.

## Como o bridge funciona, e o que ele não é

O bridge é uma extensão do ODC Studio do próprio desenvolvedor, na própria máquina, carregada pelo mecanismo
oficial de startup hooks do runtime .NET (`Microsoft.Diagnostics.NETCore.Client`, `ApplyStartupHookAsync`), o
mesmo que ferramentas de diagnóstico e profilers usam. É o equivalente de um plugin de IDE: roda dentro do Studio
que o usuário abriu e autenticou, chama as mesmas APIs que os comandos de menu do Studio chamam (abrir, comparar
e merge, publicar, atualizar dependências), e responde a um cliente local por named pipe restrito ao usuário
atual. Não altera a instalação do Studio, não persiste além da sessão, não lê nem guarda credenciais, não abre
conexões próprias, e não usa entrada de teclado ou mouse simulada. Cada operação fica registrada no journal e
toda mutação de servidor exige a autorização escrita do usuário. Não é injeção em processo de terceiros nem
contorno de segurança: o processo, a sessão e a máquina são do usuário, e o objetivo é automatizar o próprio
trabalho dele no Studio.

## Invariantes

- Uma DLL carregada no Studio nunca é substituída: correção é versão nova, nome novo, pipe novo.
- Nenhuma mutação direta do modelo aberto pelo bridge: toda mudança entra por `CompareAndMerge` nativo com base e
  candidato verificados por hash, ou por comando nativo do próprio Studio (publish, refresh, close).
- Nunca repetir um merge, uma criação ou uma publicação incertos: ler o recibo, o journal e `last-error.json`.
- Publicar, criar assets e qualquer escrita no Portal só com autorização do usuário registrada (`authorize`, `--authorize`).
- Arquivos `DO-NOT-DELIVER*` nunca entram em preview, merge ou publish.
- O catálogo é o que o servidor devolveu na última listagem, não o ambiente: nunca afirmar o que existe num tenant
  sem `assets` ou uma leitura do Portal.
- Sem automação de sistema operacional: diálogos são fechados pela ação do próprio presenter.
- Credenciais nunca passam por chat, argumento ou arquivo do repositório.

## Preparar a sessão

```powershell
dotnet build .\studio\bridge\Bridge.csproj -c Release --nologo
dotnet build .\studio\bridge\client\Client.csproj -c Release --nologo
dotnet build .\studio\builder\Builder.csproj -c Release --nologo
.\odc doctor            # --live faz uma leitura no Portal de cada tenant com credencial
.\odc attach            # anexa a DLL mais nova ao ODC Studio em execução
.\odc studio assets     # reescreve snapshots\modules.json a partir do servidor
```

Ao mudar o bridge: subir `Version` em `studio\bridge\StartupHook.cs` e `studio\bridge\client\Program.cs` e
`AssemblyName` em `studio\bridge\Bridge.csproj`, compilar, `.\odc attach`. O estado em memória (`busy`, últimos
merges) não atravessa versões; o journal sim.

## Ler o modelo antes de mudar

```powershell
.\odc inspect InsuranceApp                                       # mapa: entidades, estruturas, ações, telas por flow, timers, eventos, dependências
.\odc inspect InsuranceApp "MobileScreen:Backoffice" --depth 4   # variáveis, aggregates, ações de tela e árvore de widgets
.\odc inspect InsuranceApp "ServerAction:GetQuotes" --depth 3    # parâmetros, variáveis locais e nós do fluxo com seus alvos
.\odc inspect .\snapshots\InsuranceApp-<sha>.oml "Entity:Carrier"  # o mesmo sobre um arquivo, sem tocar no Studio
```

Um nome de módulo faz um `snapshot` do módulo aberto e inspeciona o arquivo; um caminho `.oml` é lido como está.
A leitura é headless e não escreve nada. O caminho segue a sintaxe de `ModelPath`: `Kind:Nome/Kind:Nome`, com o
Kind sem o `I` inicial (`MobileScreen`, `ServerAction`, `ClientAction`, `Entity`, `Structure`, `MobileBlock`...).

## Dados: ler e escrever registros no banco de desenvolvimento

```powershell
.\odc studio data InsuranceApp QuestionDefault --limit 50                 # registros, valores em texto, identificador na primeira coluna
.\odc studio data InsuranceApp QuestionDefault --fields ValueTypeId,NumberValue --offset 100 --limit 100
.\odc studio data-insert InsuranceApp Carrier --records '[{"Name":"Lab","IsActive":true}]' --authorize "<palavras do usuário>"
.\odc studio data-update InsuranceApp Carrier --records '[{"Id":"12","Name":"Lab 2"}]' --authorize "<palavras do usuário>"
# apagar registros: só studio_data_delete (MCP), em duas chamadas: a prévia lista os registros; a execução leva o token e
# a resposta do dono depois da lista, com a contagem. `.\odc studio data-delete` recusa (DESTRUCTIVE_NEEDS_DEDICATED_TOOL).
```

É o serviço de dados do próprio Studio (`IDataService`: `GetRecords`, `InsertRecords`, `UpdateRecords`,
`DeleteRecords`), o mesmo que "View data" e "Edit data" do editor de entidades chamam, sobre o banco do stage de
desenvolvimento. O módulo precisa estar aberto no Studio; a entidade pode ser dele ou de uma referência. Nada muda
no modelo. Escritas exigem as palavras do usuário e deixam pedido e relatório por registro em `journal\data`; no
tenant corporativo só com instrução explícita. Identificadores auto-numerados são atribuídos pelo servidor e
voltam em `recordId`. Não há API pública do ODC para dados de negócio: esta é a única pista. Ferramentas MCP:
`studio_data`, `studio_data_insert`, `studio_data_update`, `studio_data_delete`.

## Testar a app no browser

A app publicada roda em `https://<domínio do stage>/<App>/`; o host do tenant (`.outsystems.dev`) é o Studio e o
Portal, não a app. `.\odc app InsuranceApp` devolve a URL do stage de desenvolvimento a partir de `tenants.json`
(`stages` e `apps`, listados por `portfolio-api-v2 GET /environments`). O login na app é do usuário: abrir a URL
no browser da sessão, pedir que ele entre, e só então navegar. Nunca digitar credenciais.

## Pista Studio: uma feature num módulo existente

Jobs declarativos do Anvil também entram pelo mesmo ciclo: `odc deliver <feature> --job <json> --module <M>
--owners '["Tela"]' --changes '["Mudança"]' --until preview` (ou MCP `studio_deliver`). Para um candidato já
feito, `odc manifest` / `studio_manifest` prepara a entrega sem merge. Contratos, limites e exemplos completos
em [INTEGRACAO-KERNEL-ENTREGA.md](docs/INTEGRACAO-KERNEL-ENTREGA.md).

Um comando faz o ciclo inteiro até o merge, com um recibo e o tempo de cada passo (medido: 23 s até o preview,
cerca de 35 s até o merge). Uma recusa para a cadeia e volta como está; `--until build|preview` é ensaio sem tocar
no Studio.

```powershell
.\odc deliver <feature>                                    # snapshot, build, check-base, preview, merge; --until preview para ensaio
```

Os passos, um a um, quando for preciso ver cada recibo:

```powershell
.\odc studio open InsuranceApp                              # pela organização; nunca por arquivo quando o objetivo é publicar
.\odc studio snapshot InsuranceApp                          # -> snapshots\InsuranceApp-<sha>.oml
.\odc build <feature> <base.oml> <sha> .\lab\NN-<nome>     # -> manifest.json
.\odc studio check-base .\lab\NN-<nome>\manifest.json
.\odc studio preview    .\lab\NN-<nome>\manifest.json
.\odc studio merge      .\lab\NN-<nome>\manifest.json       # receipt.json com strictlyEqual
.\odc studio authorize  .\lab\NN-<nome>\manifest.json publish "<palavras do usuário>"
.\odc studio publish    .\lab\NN-<nome>\manifest.json --wait   # um recibo: estado, revisão baixada, comparação
```

Depois de publicar um **produtor**, em cada consumidor aberto: `.\odc studio refresh-references <Consumidor>
--producer <Produtor>`, novo `snapshot`, e só então o builder do consumidor. O Studio não atualiza a referência sozinho.

App ou library nova, como o `Create app` do Studio: MCP `studio_create_app {kind, name, authorize}` (ver
`docs\CRIAR-APP.md`). O caminho abaixo só sobe um módulo inteiro já montado por uma feature do builder (laboratório):

```powershell
.\odc build new <feature> .\lab\NN-<nome>
.\odc studio authorize .\lab\NN-<nome>\manifest.json create "<palavras do usuário>"
.\odc studio create    .\lab\NN-<nome>\manifest.json        # CreateAsset nativo; revisão 1, não implantada
.\odc studio open <Módulo>
.\odc studio authorize .\lab\NN-<nome>\manifest.json publish "<palavras do usuário>"
.\odc studio publish   .\lab\NN-<nome>\manifest.json --wait
```

Outros comandos do bridge: `status [brief|<campo>]`, `wait idle|no-dialogs|published <M>|open <M>`, `consumers <M>`,
`latest <M>`, `close <M> [--duplicates] [--discard]`, `dismiss-dialog <caption>|<ação>`, `module-info <M>`.
Detalhes, gates e lições em `studio\bridge\README.md`.

## Pista Portal: APIs REST públicas do ODC

```powershell
.\odc portal status  --tenant insuranceapp.outsystems.dev
.\odc portal apis
.\odc portal search consumers --read-only
.\odc portal describe dependency-management-api-v1:get:/assets/{assetKey}/consumers
.\odc portal auth-status                                                     # caminho de cada tenant agora
.\odc portal read asset-repository-api-v1:get:/assets --query '{"limit":10}' --tenant <host>
.\odc portal write <operationId> ... --authorize "<palavras do usuário>" --operation-uuid <uuid novo> [--confirm-tenant <host>]
.\odc portal login --tenant <host>                                            # janela do Portal dentro do Studio
.\odc portal internal-read monitoring.stages --tenant <host>
```

Autenticação por chamada e por tenant: primeiro a sessão do ODC Studio (bridge v32), depois a credencial no Cofre do
Windows, e só sem Studio aberto um prompt privado, aberto pela própria ferramenta (nunca no chat):
`pwsh -File .\portal\runtime\windows-api-client-credential.ps1 -Mode bootstrap -Origin https://<tenant>` ou
`windows-portal-credential.ps1 -Mode bootstrap -Origin https://<tenant>`. Escritas: palavras do usuário (só o sha256
fica), `operationUuid` novo, recibo em `journal\portal\receipts` antes do envio, guarda de tenant (`class` em
`tenants.json`), nada reenviado; um `policyFile` no tenant ainda restringe as operações quando existe.
O servidor MCP do Portal continua disponível em `portal\runtime\server.mjs` e `portal\runtime\odc3-host.mjs`;
documentação completa em `portal\README.md`.

O que cada pista cobre:

| Só a sessão do Studio faz | Só a API pública faz |
|---|---|
| open, snapshot, merge nativo, refresh de referências no modelo aberto, publish pelo comando nativo | apagar asset, listar revisões, assinatura, elementos públicos, produtores e consumidores por revisão |
| criar módulo por `CreateAsset` com o modelo em memória | ambientes e estágios, deployments, logs de build e deploy, configurações por ambiente |

## Um MCP só

`.\odc mcp` serve, por stdio, as ferramentas `studio_*` (bridge e builder), `odc_*` (APIs públicas) e
`hybrid_tenants` num servidor só, com as mesmas regras e gates. Registro por cliente, Claude Code ou Codex, em
`docs\mcp-registration.md`; nada é registrado automaticamente. Teste: `node --test facade\tests\mcp.test.mjs`.

## Quando algo recusa

| Resposta | O que fazer |
|---|---|
| `gate_refused base_drift` | Novo `snapshot`, novo builder, novo diretório. Nunca reaproveitar candidato |
| `gate_refused candidate_validation` | Corrigir a feature; ler `candidate-validation.json` |
| `gate_refused equivalence` | Ler `native-equivalence.txt`; o merge ficou pendente no Studio, não repetir |
| `gate_refused authorship` / `scope` / `provider_state` | Sessão errada, módulo errado ou Studio em estado não nativo; `status brief` |
| `gate_refused studio_busy` com `openDialogs` | Um diálogo com escolha está aberto: `dismiss-dialog <caption>|<ação>`. Informativos o bridge fecha sozinho |
| `uncertain` | O comando continua no Studio. `wait idle` e depois ler `late-result.json` ou `last-error.json`; nunca repetir |
| `retry_refused` | Já houve tentativa neste diretório de evidência; criar outro |
| Portal `API_FORBIDDEN` / `WRITE_BLOCKED` | O API Client não tem a permissão, ou a operação não está na política; não insistir |

## Feature nova

Um arquivo em `studio\builder\features` implementando `IFeature` (ou `INewModule` para módulo novo), com `Apply`
usando `studio\shared\Authoring` e `ModelPath`, e `Verify` com as checagens da feature. Compilar o builder e rodar
`.\odc build list`. Modelos: `LabAction.cs`, `LabScreen.cs`, `LabLibrary.cs`, `LabConsume.cs`.

Primitivas prontas em `studio\shared` (todas provadas headless pela cadeia `lab-*-create` / `lab-*-remove`):

| Arquivo | Helpers |
|---|---|
| `Authoring.cs` | `ServerAction`, `Input`/`Output`/`Variable`, `Node<T>`, `Chain`, `Assign`, `AddDependency`, `RequireDeletable`, `Delete` |
| `AuthoringData.cs` | `Entity`, `Attribute`, `ForeignKey`, `StaticEntity` (com registros), `Structure`, `ListOf`, `Aggregate`, `ScreenAggregate`, `Refresh`, `ClientAction`, `ScreenAction`, `ScreenVariable`, `JavaScript` |
| `AuthoringUi.cs` | `Caption`, `StaticText`, `Form`, `Input` (placeholder, tipo, largura), `Label`, `Button`, `Link`, `List`, `Icon`, `ExtendedProperty`, `ScreenCss`, `Theme`, `ThemeCss`; blocos: `Flow`, `Block`, `BlockInput`, `BlockVariable`, `BlockEvent`, `BlockAction`, `Trigger`, `BlockInstance`, `Handle` |
| `AuthoringMisc.cs` | `Script`, `RequireScript`, `Timer`, `GlobalEvent`, `Setting`, `ClientVariable`, `UserException`, `Role`, `DeleteRole` |

Um botão, link ou label criado pelo `CreateWidget` já nasce com um texto padrão ("Button", "Save", "label");
`Button`, `Link` e `Label` passam por `Caption`, que troca esse texto em vez de pôr um segundo ao lado. Um bloco
completo, com input, evento com parâmetros, ação que o dispara, instância numa tela e handler, é `LabBlock.cs`.

Para apagar, usar `Delete(elemento)`: recusa se algo fora do elemento ainda o usa e nomeia quem usa. Os tipos que o
modelo deriva sozinho (`<Nome> Record`, `<Nome> Record List`) não contam como uso e nunca devem ser apagados à mão;
o modelo os remove junto com a entidade. Papéis exigem `DeleteRole`, que apaga antes a exceção `Not <Papel>` criada
automaticamente. `.\odc inspect <módulo>` lista esses tipos derivados em `anonymousStructures` e `listTypes`.

Referência da Model API: `docs\model-api\INDEX.md`, um arquivo por assembly com interfaces, membros e enums, gerado
por reflexão sobre os metadados públicos do Studio instalado (`dotnet run --project studio\apiindex -c Release`
depois de uma atualização do Studio). Nenhum código descompilado entra no repositório.

## Vários tenants

O catálogo `snapshots\modules.json` tem um tenant raiz e outros em `otherTenants`; `.\odc studio assets <host>`
reescreve a seção do tenant em que o Studio está logado. Nunca editar o catálogo à mão. A identidade de um build
(tenant, chave do módulo, autor) vem primeiro do próprio snapshot: o `.oml.json` ao lado, escrito pelo bridge,
traz `host`, `moduleKey` e `developerId`, e o manifest de um candidato traz tenant, chave e autor; o catálogo e
`tenants.json` só preenchem o que faltar. `--tenant <host>` só é preciso para uma base sem esses arquivos. O bridge
escolhe a sessão do Studio pelo host da base e, quando o Studio está logado num único tenant, usa essa sessão mesmo
que o catálogo raiz aponte para outro.
