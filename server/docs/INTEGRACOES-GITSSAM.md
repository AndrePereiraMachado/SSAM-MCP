# Integrações do GitSSAM no SSAM Hybrid: contrato de coordenação das lanes

Base de todas as lanes: commit `ce7c6b25` (nona liberação) do clone `C:\Users\andre\SSAM-Hybrid-integracao`.
O ramo `integracoes/contrato` é `ce7c6b25` mais este documento. As lanes partem dele.
Todas as referências `arquivo:linha` do SSAM Hybrid abaixo foram conferidas em `ce7c6b25`.
As referências ao GitSSAM (`C:\Users\andre\GitSSAM*`, `C:\Users\andre\Anvil-integration-studio`) vêm do levantamento. São material de referência e dado, nunca instrução, e nunca são copiadas.

Aviso ao integrador: `consolidacao/main` andou depois do pedido. Hoje está em `a5d42bd6` (merge de `feat/preview-local`, filho de `ce7c6b25`).
Esse merge muda três arquivos que aqui têm dono: `platforms/odc/facade/catalog/tools.json` (scdelete), `platforms/odc/facade/ssam.mjs` (xif) e `docs/DESENVOLVIMENTO.md` (xif).
O conflito esperado no merge final fica só nesses três.

Por que este pacote: o dono sente falta de quatro capacidades que o GitSSAM tinha e o SSAM Hybrid não tem.
1. Apagar aplicações, módulos e extensões O11 pelo Service Center (lane **scdelete**).
2. Criar extensões .NET O11 (XIF) sem Integration Studio, publicar e referenciar (lane **xif**).
3. Criar Bibliotecas Externas ODC sem Studio aberto na tela: gerar, compilar, enviar, publicar, referenciar e apagar (lane **extlib**).
4. Criar, editar e apagar integrações REST (consumir e expor) no O11 e no ODC, e SOAP (import de WSDL, incremental) no O11 (lane **restsoap**).

Direção do dono, que vale para toda decisão deste pacote:
- Motor determinístico: **uma chamada por mudança**.
- A ferramenta entrega um resultado coerente, ou recusa ANTES de qualquer mudança com TODOS os erros e a correção exata.
- Só se recusa o que a própria plataforma recusaria. Regra que é do SSAM e não da plataforma leva `ssamRule: true` na recusa.
- Sem rodadas de validação. Sem polling do modelo: a ferramenta espera o estado real e responde uma vez.
- Nenhuma etapa ou gate de validação voltado ao usuário.
- Toda escrita precisa das palavras do próprio dono nomeando o alvo: palavras do `o11_publish`, concessões permanentes (`ssam_grant`) e palavras do Service Center.
- Apagar exige palavras com o alvo exato e checagem de dependências antes. Consumidores que quebrariam são listados, e o delete é recusado, salvo se as palavras também os nomearem.

Decisões tomadas neste contrato (para não abrir rodada; cada uma muda num ponto só):
- **D1.** O delete O11 continua pela API SOAP do próprio Studio (verbo `sc_api` da bridge), não pelas páginas Factory do GitSSAM. Sem página, não há `LAYOUT_UNKNOWN`. O segredo do Studio (SSO incluído) substitui a senha que fez o SOAP do GitSSAM falhar.
- **D2.** Delete por prefixo: o prefixo, como palavra inteira nas palavras do dono, nomeia todos os alvos que ele casa, até `maxDeletes` (padrão 25, máximo 100). App protegida (lista do GitSSAM) e consumidor externo só passam nomeados por inteiro. Constante única `PREFIX_WORDS_NAME_ALL = true` em `service-center/delete.mjs`. **Nota CX15 (15/10):** D2 vale só DEPOIS da prévia: a seleção por prefixo existe só na prévia, e o prefixo nas palavras do dono dadas depois dela nomeia os alvos congelados no token (nada é resolvido de novo), com a contagem exata de itens (decisão do dono, opção C). Motivo: em 14/10 a frase do pedido, dita antes de qualquer lista, nomeou o prefixo e apagou 7 aplicações (uma que a lista do chat nem mostrava).
- **D3.** Alvo destrutivo nas palavras: palavra inteira, sem caixa e sem acento (`namesWhole`). Vale para todo destrutivo do Service Center, inclusive `db-connection-delete`. A checagem do ambiente corporativo fica como está.
- **D4.** `module-delete`, `extension-delete` e `application-delete` viram aliases do motor de delete. Com palavras, executam na mesma chamada. `execute:false` explícito só planeja. **Nota CX15 (15/10): "com palavras, executam na mesma chamada" CAIU em 14/10.** Todo delete é em duas chamadas: a prévia (sem `confirmationToken`: a lista exata, a contagem, o token, o `operationId`; nada enviado) e a execução (o token e as palavras do dono dadas depois da prévia, com a contagem). Motivo: o incidente de 14/10 (a mesma chamada resolveu o prefixo e apagou; a interrupção não parou o servidor; ninguém mostrou o que foi apagado). Os aliases continuam aliases do motor.
- **D5.** XIF: o modelo sai do motor instalado do Integration Studio, sem login. Stubs e DLLs da plataforma vêm pela bridge O11 com a sessão do Studio. A compilação é Roslyn. A publicação usa a operação que já existe (`UploadAndPublishExtension`). Sem login do Integration Studio e sem arquivo de credencial.
- **D6.** Biblioteca externa ODC: sem login usuário/senha (o Cognito do GitSSAM fica fora). Credencial: sessão do Studio, depois o cofre, depois o prompt privado. Nunca o chat.
- **D7.** Não há gerador C# comum entre xif e extlib. Os alvos diferem (net472 no layout do Integration Studio × net10 com atributos `OSInterface`), os projetos diferem (`Anvil.Xif`, só O11, × `Anvil.Core.Odc`), e um símbolo comum quebraria o isolamento das lanes. O que se compartilha é a forma do spec (I9).
- **D8.** Corpo das actions nas duas lanes: usa os nomes declarados dos parâmetros. O xif aceita também `ss<Nome>`, a convenção do Integration Studio.
- **D9.** Mudança que quebra o contrato público de uma extensão XIF ou de uma biblioteca externa com consumidores é tratada como destrutiva: as palavras nomeiam cada consumidor. É regra do SSAM (`ssamRule: true`).
- **D10.** Ninguém acrescenta continuação em `continuations.mjs`: cada lane escreve `{tool, arguments, why}` no próprio módulo. A scdelete só põe os dois nomes novos em `MCP_TOOLS`.

---

## 1. Regras comuns

### 1.1 Ramo e worktree

Cada lane cria seu worktree a partir do commit deste contrato (git fora do PATH):

```powershell
$git = "C:\Program Files\Microsoft Visual Studio\18\Community\Common7\IDE\CommonExtensions\Microsoft\TeamFoundation\Team Explorer\Git\cmd\git.exe"
& $git -C C:\Users\andre\SSAM-Hybrid-integracao worktree add -b feat/integ-<key> C:\Users\andre\SSAM-Hybrid-integracao-wt\integ-<key> integracoes/contrato
```

| Lane | key | Ramo | Worktree |
|---|---|---|---|
| Apagar no Service Center O11 | scdelete | `feat/integ-scdelete` | `C:\Users\andre\SSAM-Hybrid-integracao-wt\integ-scdelete` |
| Extensões .NET O11 (XIF) | xif | `feat/integ-xif` | `C:\Users\andre\SSAM-Hybrid-integracao-wt\integ-xif` |
| Bibliotecas Externas ODC | extlib | `feat/integ-extlib` | `C:\Users\andre\SSAM-Hybrid-integracao-wt\integ-extlib` |
| REST e SOAP | restsoap | `feat/integ-restsoap` | `C:\Users\andre\SSAM-Hybrid-integracao-wt\integ-restsoap` |

### 1.2 Ambiente de build e teste (por worktree, nunca compartilhado)

```powershell
cd C:\Users\andre\SSAM-Hybrid-integracao-wt\integ-<key>
[Environment]::CurrentDirectory = (Get-Location).Path
$env:ANVIL_WORKER = '0'; $env:ANVIL_ODC_NO_WORKER = '1'; $env:SSAM_NO_WARM = '1'
New-Item -ItemType Directory -Force C:\t\<key> | Out-Null
$env:TEMP = 'C:\t\<key>'; $env:TMP = 'C:\t\<key>'
New-Item -ItemType Directory -Force C:\t\<key>\odc-features | Out-Null
Copy-Item C:\Users\andre\AppData\Local\Temp\anvil-odc-work\odc-features\Features.xml C:\t\<key>\odc-features\
$env:ANVIL_ODC_FEATURES_DIR = 'C:\t\<key>\odc-features'
$env:ANVIL_STUDIO_DIR = 'C:\Program Files\OutSystems\Service Studio 11\Service Studio'
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-dev.ps1 -Yes -NoUserEnv -SkipInstall -SkipMcp -SkipDoctor
```

- **Fixtures OSUI** (gitignored): copiar `outsystems-ui.oml` e `outsystems-ui-web.oml` de `C:\Users\andre\SSAM-Hybrid\kernel\tests\fixtures` para `kernel\tests\fixtures` do worktree. A origem é só lida.
- **node** fora do PATH: `C:\Users\andre\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe`. `dotnet` está no PATH.
- Receitas: `docs/DESENVOLVIMENTO.md` e os `AGENTS.md` (raiz, `kernel/`, `platforms/odc/`).

Suítes:
- O11 kernel: `dotnet test kernel\tests\Anvil.Tests\Anvil.Tests.csproj -c Release [--filter ...]`.
- ODC kernel: `dotnet test kernel\tests\Anvil.Tests.Odc\Anvil.Tests.Odc.csproj -c Release [--filter ...]`.
- Bridge ODC: `dotnet test platforms\odc\studio\bridge\tests\Bridge.Tests.csproj`.
- Fachada: `& $node --test tests\<arquivo>.test.mjs`, rodado em `platforms\odc\facade`.
- Portal ODC: `& $node --test tests\<arquivo>.test.mjs`, rodado em `platforms\odc\portal`.
- Testes da pasta `platforms\odc\tests` (continuations, client-content): `& $node --test tests\<arquivo>.test.mjs` em `platforms\odc`.

Regras de execução:
- Antes de mudar qualquer coisa, rode as suítes da sua lista na base e guarde os nomes que falham. Depois compare. Nunca afirme que uma falha é antiga sem conferir.
- Falha ambiental conhecida: `FunctionCatalogTests.CatalogInRepoMatchesTheStudio`.
- `platforms/odc/tests/continuations.test.mjs` já falha na base: `MCP_TOOLS` tem 80 nomes e o teste exige 79.
- Nunca rode a suíte da fachada enquanto uma suíte de kernel do MESMO worktree grava carimbos de resultado de job.
- **Armadilha de caminho.** O processo começa com o diretório atual em `C:\Users\andre\SSAM-Hybrid`. No PowerShell, `cd`/`Set-Location` NÃO muda o diretório atual do .NET. `[IO.File]`, `[IO.Directory]`, `[IO.Path]::GetFullPath` e qualquer API .NET com caminho RELATIVO resolvem dentro de `C:\Users\andre\SSAM-Hybrid`. Passe sempre caminho ABSOLUTO às APIs .NET, ou rode `[Environment]::CurrentDirectory = (Get-Location).Path` depois do `cd`. Nunca encadeie uma escrita depois de uma leitura que pode ter falhado.

### 1.3 Proibições (todas as lanes)

- Nunca escrever em: `C:\Users\andre\SSAM-Hybrid`, `C:\Users\andre\SSAM-Hybrid-novo`, `C:\Users\andre\SSAM-Hybrid-o11-sso`, `C:\Users\andre\SSAM-Hybrid-servidor` e seus worktrees, `C:\Users\andre\GitSSAM*`, `C:\Users\andre\Anvil*`, `%USERPROFILE%\.ssam`, `%USERPROFILE%\.ssam-hybrid`, nem nos worktrees de outras lanes.
- Nunca ler arquivo de credencial, cofre, cookie, bootstrap ou token (inclusive tudo em `%USERPROFILE%\.ssam` e as pastas de credencial do GitSSAM).
- Nenhuma ação viva:
  - nunca tocar, anexar, injetar ou matar um Studio;
  - nunca chamar ferramentas `mcp__ssam*`;
  - sem worker, sem `ssam connect`, sem `odc attach`;
  - nenhuma chamada HTTP a Service Center, Portal ODC, tenant ou outro serviço da OutSystems;
  - nenhum upload, publish ou delete em ambiente nenhum.
- Testes sintéticos e mínimos, com fakes na fronteira do Studio, do Service Center e do Portal. Nunca commitar dado de cliente, segredo, DLL da plataforma OutSystems ou template baixado de tenant.
- O GitSSAM só se lê. Nunca copiar código Python dele. Nunca usar o cofre de credenciais dele.
- Bridge ODC (`platforms/odc/studio/bridge`): não renomear o assembly nem subir a versão (`v38`). O integrador sobe uma vez, depois do merge.
- Bridge O11 (`kernel/src/Anvil.Bridge`): a mudança só vale no próximo Studio aberto. Todo verbo ou superfície nova tem flag de capacidade e uma recusa clara (ou fallback) para bridge antiga, ANTES de qualquer mudança.
- Sem push. Sem rodada de revisão. Sem etapa de validação voltada ao usuário.

### 1.4 Propriedade de arquivos (estrita)

1. **Cada arquivo existente tem exatamente um dono**, listado na seção 2. A seção 3 resume os compartilhados.
   - Uma lane só escreve os arquivos da sua lista e os arquivos NOVOS que ela cria nos lugares indicados.
   - Quando duas lanes precisam do mesmo arquivo, ele foi dado a uma. A outra usa uma interface da seção 4.
2. **Regras residuais** para arquivo existente não citado:
   - `kernel/src/Anvil.Core/Kernel/**`, `kernel/src/Anvil.Core/Delivery/**`: restsoap, exceto `Kernel/NativeReferenceSnapshot.cs` (extlib).
   - `kernel/src/Anvil.Core/Adapters.SS11/**`: xif (nenhuma mudança prevista).
   - `kernel/src/Anvil.Core.Odc/Adapters.ODC/**`: extlib. A restsoap só cria arquivos NOVOS `Adapters.ODC/OdcRest*.cs`.
   - `kernel/src/Anvil.Bridge/Sc*.cs`: xif. O resto de `kernel/src/Anvil.Bridge/**`: restsoap.
   - `kernel/src/Anvil.Cli/**`: xif. `kernel/src/Anvil.Cli.Odc/**`: extlib.
   - `platforms/odc/facade/service-center/**`: scdelete, exceto o arquivo NOVO `service-center/integration-studio.mjs` (xif).
   - `platforms/odc/portal/**` e `platforms/odc/studio/bridge/**`: extlib.
   - Qualquer outro arquivo existente: sem dono neste pacote. Não edite. Registre a necessidade em `notDone` da resposta final.
3. **Testes:**
   - Um arquivo de teste existente pertence ao dono da fonte que ele testa. Os principais estão nas listas da seção 2.
   - Testes novos vão em arquivos NOVOS, com os nomes da seção 2.
   - Jobs novos (`kernel/tests/jobs*/`) e fixtures novas (`kernel/tests/fixtures/<pasta nova>/`) são só arquivos novos. Nenhuma lane muda job existente.
4. **Projetos (`.csproj`):**

   | Projeto | Dono | Para quê |
   |---|---|---|
   | `kernel/tests/Anvil.Tests/Anvil.Tests.csproj` | xif | link de `ScIntegrationStudioSoap.cs` e referência a `Anvil.Xif` |
   | `kernel/tests/Anvil.Tests.Odc/Anvil.Tests.Odc.csproj` | restsoap | referência ao plugin REST do ODC, se o teste de OpenAPI precisar |
   | `kernel/src/Anvil.Core/Anvil.Core.csproj` | restsoap | referências de plugin (Private=false), se precisar |
   | `kernel/src/Anvil.Core.Odc/Anvil.Core.Odc.csproj` | restsoap | idem. O código novo da extlib fica em `Adapters.ODC/**`, que o glob já compila (`Anvil.Core.Odc.csproj:28`) |
   | `kernel/src/Anvil.Bridge/Anvil.Bridge.csproj` | restsoap | referências dos plugins REST/SOAP do Studio, se precisar |
   | `kernel/src/Anvil.Cli/Anvil.Cli.csproj` | xif | referência a `Anvil.Xif` |
   | `kernel/src/Anvil.Cli.Odc/Anvil.Cli.Odc.csproj` | extlib | nenhuma mudança prevista |
   | `platforms/odc/studio/bridge/tests/Bridge.Tests.csproj` | extlib | link de `PortalUpload.cs` (como `PortalCore.cs`, `:22`) |
   | `kernel/src/Anvil.Xif/*.csproj`, `kernel/src/Anvil.Xif.Engine/*.csproj` (novos) | xif | projetos novos |

   Lógica pura que outra lane precisa testar fica num arquivo que já compila no projeto de teste dela.
   Exemplo: a validação dos argumentos do `integration_import` (restsoap) fica em `kernel/src/Anvil.Core/Kernel/IntegrationImport.cs`, que `Anvil.Tests` e `Anvil.Bridge` já enxergam por `Anvil.Core`. Nada de link novo no `Anvil.Tests.csproj` para a restsoap.
5. **Overlay de liberação** (`scripts/release/overlay/**.patch`). Fontes deste pacote com patch, que fica obsoleto quando a fonte muda: `Anvil.Bridge/Dispatch.cs`, `Anvil.Bridge/ScProtocol.cs`, `Anvil.Bridge/Anvil.Bridge.csproj`, `Anvil.Cli/Program.cs`, `Anvil.Cli.Odc/Program.cs`, `Kernel/NativeReferenceSnapshot.cs`, `Kernel/Verbs.cs`, `Kernel/CommandSurface.cs`, `Kernel/JobRunner.cs`. **Nenhuma lane escreve `scripts/release/**`.** O integrador roda `scripts/release/stage.mjs capture` e `check` depois do merge.
6. **Compatibilidade de símbolos.** Nenhuma lane remove, renomeia nem muda a assinatura de um membro que outra lane usa. Pode acrescentar overload e parâmetro opcional no fim. Usados por outras lanes neste pacote:
   - `runServiceCenter(argv, deps)`, `serviceCenterTool(argv, deps)` e `journalDefault(env)` de `service-center/index.mjs`;
   - `Resolver`, `guardWrite`, `hostClass` de `service-center/auth.mjs`; `locateStudioBridge` e a classe da bridge de `service-center/bridge.mjs`; `StudioApi`, `field`, `items` de `service-center/studio-api.mjs`;
   - `consumerNames(value, producer)` de `o11-publish.mjs:162` (usado pela scdelete);
   - `namesApp(words, app)` e `wordsFor(...)` de `standing-grants.mjs:35,116`; `namesWhole(words, name)` de `studio-create-app.mjs:42`;
   - `createAccess` e o resto de `lib.mjs`; `OdcAccess` de `portal/runtime/access.mjs` (a extlib só acrescenta);
   - `interpretKernelResult`, `applyKernel`, `deliverKernel` de `kernel-delivery.mjs`;
   - `Delivery.Run(...)` e `DeliveryTask` (chamados por `Anvil.Cli/Program.cs`, da xif); `CommandSurface.Schema/OperationNames` e `JobPreflight.Check` (chamados pelas duas CLIs);
   - `NativeReferenceSnapshot` (usado por `ReferenceRefresher`, `ProducerSignatureCapture`, `JobRunner`); `ScGuard.Write` e `ScApi.Catalog()`.
   - Textos lidos por testes de outra lane ficam como estão:
     - em `Dispatch.cs`, o padrão `"<verbo>" => await` dos verbos `sc_session`, `sc_api`, `sc_web`, `studio_login` (`service-center-studio.test.mjs:888-892`) e o literal `"sc_web:secretRefs"` (`ServiceCenterSecretRefsTests.cs:241`);
     - em `ScProtocol.cs`, os literais `accept is not ("html" or "xlsx" or "binary")` e `SecretNotFound = "SECRET_NOT_FOUND"` (`service-center-studio.test.mjs:891,910`);
     - em `ScOperations.cs`, a forma `IReadOnlyDictionary<string, ScOp<Sc<X>Send>> <Nome>Operations =` e as entradas `["Op"] = ...` com `a.Key/Text/Int/Bool/Raw/Bytes/OneOf/OptionalObjectKey/Date/Path("...")` (o parser de `service-center-studio.test.mjs:848-862`).

### 1.5 Commits

```powershell
$env:GIT_AUTHOR_NAME='Andre Machado'; $env:GIT_AUTHOR_EMAIL='andre_c_machado@hotmail.com'
$env:GIT_COMMITTER_NAME='Andre Machado'; $env:GIT_COMMITTER_EMAIL='andre_c_machado@hotmail.com'
```

- A mensagem termina com uma linha em branco e `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Arquivo de mensagem sem BOM (`New-Object Text.UTF8Encoding($false)`), `git commit -F`.
- Código e comentários em inglês, no estilo do arquivo. Documentos para o dono em pt-BR, frases curtas.

### 1.6 Forma comum das recusas das ferramentas novas

```text
{ ok: false, code: "<CODIGO_AGREGADO>", error: "<uma linha>", problems: Problem[],
  <campos que a próxima chamada precisa>, continuation?: {tool, arguments, why} }
Problem = { code: UPPER_SNAKE, target?: string, path?: string, message: string, fix: string | null, ssamRule?: true }
```

- Todos os problemas de todos os alvos vêm numa recusa só. Nada é reservado e nada é enviado.
- A recusa traz o que a chamada seguinte precisa para ser a execução, e não outra rodada (por exemplo `xifSha256`, `contractDiff`, a lista de consumidores, o plano exato).
- Recusa de job do kernel continua no formato atual do `JobPreflight` (`{op, pointer, code, severity, message, fix, patch}`).
- Incerteza depois do envio: `state: "uncertain"`, nunca reenviada. A mesma chamada repetida reconcilia lendo.

---

## 2. Lanes

### Lane scdelete: apagar no ambiente O11 numa chamada (apps, módulos, extensões)

> Histórico. Desde a CX15 (15/10) o delete é em duas chamadas, prévia e confirmação (notas em D2 e D4 e `docs/OPERACOES-O11.md`, "Apagar no ambiente").

Arquivos que escreve:
- `platforms/odc/facade/service-center/`: `index.mjs`, `studio-api.mjs`, `auth.mjs`, `client.mjs`, `bridge.mjs`, `errors.mjs`, `util.mjs` e o NOVO `delete.mjs`.
- `platforms/odc/facade/`: `o11-operations.mjs`, `o11-environment.mjs`, `studio-write-lock.mjs`, `continuations.mjs` (só `MCP_TOOLS`), `catalog/tools.json`, `guides/o11.md`, `guides/odc.md`.
- `docs/OPERACOES-O11.md`.
- Testes: `platforms/odc/facade/tests/{service-center-studio,service-center-core,service-center-modern,service-center-vault,o11-operations,o11-environment,studio-write-lock,tool-routes,discover-tools}.test.mjs`, o NOVO `service-center-delete.test.mjs`, `tests/fixtures/sc-fake-bridge.mjs`, `tests/fixtures/sc-*` e `tests/fixtures/discover-tool-*.json`.

Estado em `ce7c6b25`:
- `service-center/studio-api.mjs`:
  - `:67-71` WRITES e DESTRUCTIVE;
  - `:242-254` `prepareDelete`: uma linha exata da listagem viva; `GetConsumers` só para eSpace (`:246-249`); erro vira `consumers:'unknown'` e o delete segue; `namedTargets` só com o nome: consumidor nunca bloqueia; extensão nem é conferida;
  - `:255-264` `sendDelete`: um `DeleteModule` com `target`, uma leitura: `confirmed` ou `accepted-unverified`, sem espera;
  - `:320-340` `application-delete`: simulação `DeleteApplication simulate:true` como leitura; `affectedApplications` não entra nas palavras;
  - `:385-408` `extension-publish`: uma leitura do `VersionId` depois do envio; `:235` `observe()` recusa reconciliar um publish de extensão.
- `service-center/auth.mjs:78-90` `guardWrite`: alvo por trecho (`:87`, `includes`). "Orders2" autoriza apagar "Orders".
- `service-center/index.mjs`: `:27` DESTRUCTIVE; `:285-288` executar exige palavras e operationId; `:301-303` `approveFor`; `:91-95` recibos em `.ssam-hybrid`; `:97-115` `capabilities()` diz "not yet validated live".
- `service-center/client.mjs:1199-1222` `runWrite`; `:53` RELEASED (`accepted-unverified` mantém a trava do alvo).
- `service-center/bridge.mjs`: `:78-86` lê o `bridge_manifest` mas não guarda `serviceCenter`; `:123-129` `api()` aceita só `soap`, `server-api` e `sc-rest`.
- `o11-operations.mjs`: `:18-19` `studioWrites`; `:54` executar sem operationId é recusado; `:152-165` `o11_service_center_write`.
- `o11-environment.mjs`: `:38`, `:102-108`, `:142`, `:240-242`: `delete-app` só para ZZ, palavras por `namesWhole` (`:66`), e a CLI `delete-app --confirm` sem simulação nem consumidores (`kernel/src/Anvil.Cli/Program.cs:423-434`).
- Bridge O11: `ScOperations.cs:174-179` `GetConsumers`; `:250-259` `DeleteApplication` (simulação por padrão); `:260-264` `DeleteModule`; `ScProtocol.cs:104-121` `ScGuard.Write` confere `target` só quando ele vem.
- `catalog/tools.json`: `:2688-2712` a ferramenta; `:3135-3187` `module-delete`/`extension-delete`; `:3274-3299` `application-delete` ("prepare first, then execute": duas chamadas); `:4869-4899` `o11_environment` `delete-app` ("ZZ test application").
- `docs/OPERACOES-O11.md:255` ainda cita `%USERPROFILE%\.ssam`; o código usa `.ssam-hybrid`.
- Não existe delete em lote.

O que fazer:
1. **Motor `service-center/delete.mjs`** (assinaturas em I1). Passos:
   1. **Bridge.** `serviceCenterCatalog().soap` precisa conter `ListApplications`, `ListEspaces`, `ListExtensions`, `GetConsumers`, `DeleteApplication` e `DeleteModule`. Senão: `STUDIO_BRIDGE_OUTDATED`, antes de qualquer leitura.
   2. **Alvos**, de UMA leitura de cada listagem. Nome ou chave exatos.
      - Nome que é eSpace e extensão ao mesmo tempo: `TARGET_AMBIGUOUS` (correção: a chave, ou a lista `modules`/`extensions`).
      - Não achado: `TARGET_NOT_FOUND` com até 5 nomes mais próximos.
      - Prefixo: sem caixa, dentro de `prefixKind`. Mais que `maxDeletes`: `DELETE_LIMIT_EXCEEDED` listando todos (correção: prefixo mais estreito ou lista explícita).
      - Protegidas do GitSSAM (`Users`, `System Components`, prefixos `LifeTime`, `OutSystems `, `System `), casadas só por prefixo: `PROTECTED_TARGET` (`ssamRule: true`), salvo se as palavras a nomearem por inteiro.
   3. **Dependências**, só leituras, antes de qualquer mudança.
      - Aplicação: `DeleteApplication simulate:true` dá `deletedModules` e `affectedApplications`. `success:false` é `SIMULATION_REFUSED` com as mensagens do servidor (recusa da plataforma).
      - Módulo e extensão: `GetConsumers(key, '')`, lido com `consumerNames` (`o11-publish.mjs:162`) e ligado à aplicação pela listagem.
      - Consumidor externo = consumidor ou aplicação afetada fora do conjunto. Módulo que vai junto com uma app do conjunto conta como dentro.
      - Erro ou forma ilegível no `GetConsumers`: `DEPENDENCY_CHECK_UNAVAILABLE`. Nunca apagar às cegas.
   4. **Palavras** (`namesWhole`, D3). Nomeiam cada alvo pelo nome (ou o prefixo, D2): senão `WORDS_MUST_NAME`. Nomeiam cada consumidor externo: senão `CONSUMERS_WOULD_BREAK` com `{consumer, application, of}` e a correção ("palavras que também nomeiem: X, Y" ou "inclua-os em modules/applications"). Host corporativo: a regra atual de `confirmHost`. Concessão permanente nunca vale para delete.
   5. **Recusa única**: `{ok:false, code:"DELETE_REFUSED", problems, repeat:{...argumentos exatos da próxima chamada}}`. Nada reservado.
   6. **Execução.** Recibo pai (alvos exatos congelados) e um filho por alvo, com operationId derivado (UUID determinístico de pai + chave). Ordem: consumidores antes de produtores dentro do conjunto; aplicação usa a cascata do servidor. Para cada alvo:
      - relê a listagem logo antes de enviar (regra de deriva do GitSSAM): sumiu = `absent`; mesma chave com outro nome = `CONFLICT`, para;
      - envia UMA vez (`DeleteApplication simulate:false` com `target`=appKey, ou `DeleteModule {moduleKey, moduleKind}` com `target`=moduleKey);
      - espera o estado real com `waitFor` (cerca de 30 s, pausas de 1 a 5 s) até a chave sumir: `confirmed`. No prazo ainda presente: `DELETE_UNCONFIRMED` (`accepted-unverified`, trava mantida);
      - `success:false`: `rejected` com a mensagem do servidor, e os alvos seguintes param.
   7. **Repetição idempotente pelo estado.** Alvo que já sumiu responde `absent` com o último recibo, sem envio. Filho incerto com a trava: a própria chamada lê. Ausente fecha `confirmed`. Presente com a mesma chave e nome permite UM envio novo (regra ABSENT do GitSSAM). Conflito para. O modelo nunca faz polling nem chama `verify`.
2. **Forma da ferramenta.** `o11_service_center_write {action:"delete", host, applications?, modules?, extensions?, prefix?, prefixKind?, maxDeletes?, words, confirmHost?, operationId?, execute?}`.
   - Com `words`, executa. `execute:false` só planeja (`state:"planned"`, nada reservado).
   - Hoje o esquema declara `execute` com `default: false` (`o11-operations.mjs:112`). Tire o padrão, para a ausência do campo ser distinguível de `false`, e prove num teste que uma entrada sem `execute` chega ao handler sem o campo.
   - `operationId` opcional para `delete` e aliases: a ferramenta cria o do pai (`o11-operations.mjs:54` deixa de exigir para eles).
   - `serviceCenterArguments` passa listas como `--target=<kind>:<valor>` repetido, `prefix`/`prefixKind`/`maxDeletes` como flags, e `execute:false` como `--plan-only`.
   - Flags novas em `index.mjs` (`FLAGS`, `parseArgs`): `--target` (acumula), `--prefix`, `--prefix-kind`, `--max-deletes`, a chave `--plan-only` e, para I1, `--expected-version-id`.
   - Resposta única: `{ok, host, auth, action:"delete", state:"confirmed"|"absent"|"refused"|"uncertain"|"planned", operationId, deleted:[{kind,name,key,application}], absent:[...], deletedModules, affectedApplications, consumers:{<alvo>: [nomes]}, receipts}`.
   - Nenhuma descrição de campo novo usa os marcadores "Alone:" ou "Instead of job" (viram modo por presença em `tool-routes.test.mjs:97-111`).
3. **Aliases (D4).** `module-delete` = delete com `modules`, `extension-delete` = com `extensions`, `application-delete` = com `applications`. Sem palavras, só planejam.
4. **`auth.mjs`.** Exporta `namesWhole(words, name)`: palavra inteira, sem caixa, sem acento, espaços do nome casam qualquer sequência de espaços. `guardWrite` usa para os alvos. A checagem do ambiente fica igual. `o11-environment.mjs` passa a usar este.
5. **`bridge.mjs`** (I2): `serviceCenterCatalog()` devolve o `serviceCenter` do `bridge_manifest` (cache junto de `verbs()`); `api()` aceita a superfície `integration-studio`, só leitura (`write:true` nela é `BAD_REQUEST`).
6. **`extension-publish` para a xif** (I1):
   - `--extension <Nome>` e `--expected-version-id <id|none>` opcionais, conferidos no preparo contra `ListExtensions`. Diferente: `{ok:false, code:"EXTENSION_VERSION_CHANGED", observed:{versionId}}`, antes da reserva;
   - o envio espera com `waitFor` até `ListExtensions` mostrar o `extensionVersionId` devolvido: `confirmed`;
   - `observe()` reconcilia um publish incerto lendo o `VersionId` (troca o erro de `studio-api.mjs:235`).
7. **`o11_environment delete-app`** vira uma rota fina para o motor: `runServiceCenter(['delete', '--host=<host>', '--target=application:<app>', '--words=<authorize>'])`. Sai a regra só-ZZ e o caminho da CLI com `--confirm`. A CLI `delete-app` e `Publisher.DeleteApplication` ficam como ferramentas de laboratório.
8. **`studio-write-lock.mjs`**: os predicados de I4, para `delete` e para as ferramentas novas das outras lanes.
9. **`catalog/tools.json`**: rotas de TODOS os nomes vivos novos da seção 5 (os seus e os das outras lanes).
10. **Guias** (`guides/o11.md`, `guides/odc.md`): as linhas de I10. **`continuations.mjs`**: acrescenta `o11_extension` e `odc_external_library` em `MCP_TOOLS`.
11. **`docs/OPERACOES-O11.md`**: seção pt-BR "Apagar no ambiente"; corrige a pasta dos recibos (`.ssam` → `.ssam-hybrid`); registra a divergência do Python original (`kernel/scripts/service_center/studio_api.py`, sem mudança); aponta para o documento da xif. Ajusta o texto de `capabilities()`.

Testes da scdelete:
- Regras novas (falham na base, passam depois), em `service-center-delete.test.mjs` com a `FakeBridge`:
  1. Módulo com consumidor de fora (`GetConsumers` → `[{Name:'Billing'}]`) e palavras só com Orders: `DELETE_REFUSED`/`CONSUMERS_WOULD_BREAK` listando Billing e a correção. Zero `DeleteModule`, nenhum recibo, nenhuma trava.
  2. Mesma chamada com palavras nomeando Orders e Billing: exatamente um `DeleteModule {moduleKey, moduleKind:'eSpace'}` com `target`=chave; `confirmed` quando a listagem mostra a ausência.
  3. `GetConsumers` lança `REMOTE_ERROR`: `DEPENDENCY_CHECK_UNAVAILABLE`, nenhuma escrita.
  4. Extensão: `GetConsumers` com a chave da extensão; consumidores bloqueiam.
  5. Aplicação cuja simulação devolve `affectedApplications:['Sales']`: recusa sem Sales nas palavras; com Sales, um `DeleteApplication simulate:false` com `target`=appKey.
  6. Palavras inteiras: "apagar ZZDemo2" não autoriza ZZDemo (`WORDS_MUST_NAME`); acento e caixa não importam.
  7. Uma chamada: `delete` com palavras e sem operationId cria os ids, apaga e responde uma vez com `operationId`.
  8. Espera limitada: a listagem falsa mostra a chave em 2 leituras e depois não: `confirmed` na mesma chamada. Nunca some: `DELETE_UNCONFIRMED`, trava mantida.
  9. Todos os erros de uma vez: um não achado, um nome eSpace/extensão ambíguo e um módulo bloqueado por consumidor dão três problemas numa recusa, zero escritas.
  10. Prefixo `ZZ`: consumidor dentro do conjunto é isento e vai antes; mais que `maxDeletes` dá `DELETE_LIMIT_EXCEEDED` com todos; `Users` casado por prefixo dá `PROTECTED_TARGET`, salvo nomeado.
  11. Deriva: chave renomeada entre o plano e o envio dá `CONFLICT`, para, nada enviado para ela.
  12. Repetição: alvo já sumido dá `absent` sem escrita; filho incerto lido ausente fecha `confirmed`; presente com a mesma chave permite exatamente um envio novo.
  13. Bridge cujo `serviceCenter.soap` não tem `GetConsumers`: `STUDIO_BRIDGE_OUTDATED` antes de qualquer escrita.
  14. `extension-publish`: `VersionId` aparece na terceira leitura: `confirmed`; `--expected-version-id` diferente: `EXTENSION_VERSION_CHANGED`, zero envios; `verify` de um publish incerto reconcilia lendo.
  15. `bridge.api(host, 'integration-studio', 'Handshake', {})` passa; com `write:true` é `BAD_REQUEST`.
- `o11-environment.test.mjs`: `delete-app` roda o motor (simulação primeiro) e nunca chama a CLI com `--confirm`.
- `service-center-studio.test.mjs`: ajustar os testes de duas chamadas (`:317`, `:444`, `:462`); o teste da lista permitida (`:867`) continua passando para toda operação que o motor envia (se o motor chamar a bridge fora de `studio-api.mjs`, estender `facadeCalls` a `delete.mjs`).
- `studio-write-lock.test.mjs`: casos de I4 (delete com palavras trava; `execute:false` não; `o11_extension` publish/delete travam e read não; `odc_external_library` deploy/discard travam, build/status não).
- `tool-routes.test.mjs` e `discover-tools.test.mjs` com os fixtures: "apagar todas as apps que começam com ZZ" vai para `o11_service_center_write.delete`; "excluir a extensão X" vai para a rota de delete de extensão; os oráculos ficam ≥ 95% (top-1) e ≥ 96% (top-3).
- Suítes existentes: `service-center-*`, `o11-operations`, `o11-environment`, `studio-write-lock`, `tool-routes`, `discover-tools`; em `platforms/odc`, `continuations` (já falha na base pela contagem).

### Lane xif: extensões .NET O11 (XIF) sem Integration Studio

Arquivos que escreve:
- `kernel/src/Anvil.Bridge/`: `ScOperations.cs`, `ScApiHandler.cs`, `ScProtocol.cs` e o NOVO `ScIntegrationStudioSoap.cs` (lógica pura). Residual: os outros `Sc*.cs` (sem mudança prevista).
- Projetos NOVOS `kernel/src/Anvil.Xif/**` (net8) e `kernel/src/Anvil.Xif.Engine/**` (net472, x86, exe).
- `kernel/src/Anvil.Cli/Program.cs`, `kernel/src/Anvil.Cli/Anvil.Cli.csproj`.
- `kernel/tests/Anvil.Tests/Anvil.Tests.csproj`, `ServiceCenterBridgeTests.cs`, `ServiceCenterSecretRefsTests.cs` (residual), os NOVOS `Xif*Tests.cs`; fixtures NOVAS em `kernel/tests/fixtures/xif/**` (sintéticas; assembly falso de plataforma feito por nós).
- `platforms/odc/facade/`: os NOVOS `o11-extension.mjs` e `service-center/integration-studio.mjs`; `o11-publish.mjs`; `ssam.mjs`.
- `platforms/odc/facade/catalog/fragments/C/dotnet-extensions.json` (NOVO).
- Testes: `platforms/odc/facade/tests/o11-publish.test.mjs` e o NOVO `o11-extension.test.mjs`.
- `scripts/setup-dev.ps1`.
- `docs/DESENVOLVIMENTO.md` e o NOVO `kernel/docs/tasks/2026-10-05-o11-xif-headless.md` (pt-BR).

Estado em `ce7c6b25`:
- Publica um `.xif` pronto: `extension-publish` (`studio-api.mjs:385-408`, sha256 preso entre preparo e envio) sobre `UploadAndPublishExtension` (`ScOperations.cs:280-288`), com a sessão do Studio, um envio só, incerteza nunca repetida (`ScOperations.cs:418-459`).
- Apaga extensão: `DeleteModule` com `moduleKind` Extension (`ScOperations.cs:260-264`), mas sem consumidores (`studio-api.mjs:246-249`).
- Leituras: `ListExtensions` (`:170`), `DownloadExtension` (`:240-244`), `GetConsumers` (`:174-179`).
- Referência determinística provada: `anvil signature` (`Anvil.Cli/Program.cs:444-466`) → `.avsig` atestado; `captureProducers` no `ssam_job` (`job-runner.mjs:160-206`); continuação `O11_PRODUCER_CAPTURE` (`continuations.mjs:152`).
- `Delivery/CSharpRuntimeDelivery.cs:27-32` usa arquivo de credencial (não é caminho deste pacote).
- Nada gera nem compila XIF em `ce7c6b25`.

O que fazer:
1. **Projeto `kernel/src/Anvil.Xif` (net8).** Referencia `Anvil.CSharp` (Roslyn 4.8, `Anvil.CSharp.csproj:10`). Assemblies de referência net472 pelo pacote `Microsoft.NETFramework.ReferenceAssemblies.net472` (MIT), copiados para a saída. Nenhuma DLL da OutSystems no repositório. Arquivos:
   - `XifSpec`: o spec de I9 mais `sources`, `references`, `resources` (deploy `Ignore|Binaries|Application|Images`) e `remove`. Todos os erros de uma vez: `XIF_SPEC_INVALID` com `[{path, message, fix}]` (identificador, duplicado sem caixa, colisão primitivo/estrutura, tipo desconhecido, lista de primitivo, referência adiante, função sem exatamente uma saída, action nova sem corpo, caminho de recurso inseguro, arquivo não absoluto, DLL do autor sem fechamento).
   - `XifPackage`: leitura zlib+XML com limites, spec extraído, sha256 dos recursos.
   - `XifSourceMerge`: reescrita Roslyn (assinatura do stub, corpo do spec, resto intacto). D8: nome declarado vira `ss<Nome>` só quando o identificador não resolve para outro símbolo.
   - `XifCompiler`: net472, `LangVersion 7.3`, determinístico. `XIF_COMPILE_FAILED` com `{file,line,col,code,message}`; DLL do autor com nome de DLL da plataforma: `XIF_DEPENDENCY_OVERRIDE`.
   - `XifContractDiff` (quebra: action removida ou renomeada, parâmetro ou atributo removido ou com tipo novo, entrada obrigatória nova, estrutura removida; aditivo: action nova, entrada opcional nova, só corpo) e `XifRefusals`.
2. **Projeto `kernel/src/Anvil.Xif.Engine` (net472, x86).** Reflexão sobre o Integration Studio INSTALADO (`ANVIL_INTEGRATION_STUDIO_DIR`, senão registro/Program Files), protocolo JSON por stdin/stdout, TEMP privado, `Preferences.RunningTests`, sem login e sem rede.
   - Falta o motor ou um membro: `XIF_ENGINE_UNAVAILABLE` com as pastas procuradas e os membros que faltam.
   - Relatórios de erro do `ProjectVerify`: `XIF_VERIFY_FAILED`.
   - Exceção inesperada dentro do motor: `XIF_ENGINE_FAILED` (defeito do SSAM, nunca do spec; acrescentado em 2026-10-06, `kernel/docs/tasks/2026-10-06-xif-motor-construtor.md`).
   - Lógica pura de sondagem (membros esperados) testável com tipos falsos, sem tocar a instalação real.
3. **CLI** (`Anvil.Cli/Program.cs`): `xif check --spec <json>`, `xif read --xif <file>`, `xif build --stage model|final ...`, `xif diff --base <xif> --new <xif>`. Um JSON por comando, como os demais.
4. **Bridge O11** (vale no próximo Studio aberto): superfície `integration-studio` do `sc_api`, SÓ leituras: `Handshake`, `GenerateSourceCodeStubs {file, outFile}`, `GetSourceCodeDependencies {outFile}`, `UploadNeeded {extensionKey, extensionHash}`.
   - Tabela `IntegrationStudioOperations` em `ScOperations.cs`, na forma das outras (1.4.6). `Catalog()` (`:374-378`) lista `integration-studio`. O switch de `Prepare` (`:392-399`) ganha a superfície; a mensagem `surface must be ...` cita as quatro.
   - `ScApiHandler.cs`: SOAP 1.1 em `https://<host>/ServiceCenter/IntegrationStudio.asmx` pela pilha HTTP do próprio Studio, usuário e segredo novo por chamada, redação, um envio.
   - `ScIntegrationStudioSoap.cs`: envelope e leitura puros (zip em bytes, `HEMessage[]`), linkado no `Anvil.Tests.csproj`.
   - A string de capacidade `sc_api:integration-studio` entra em `Dispatch.cs` pela restsoap (I3). Bridge sem ela: `BRIDGE_TOO_OLD` antes de qualquer build (correção: fechar e abrir o Studio pelo atalho "Service Studio (SSAM)"). Sem fallback para login do Integration Studio.
   - **Endurecimento pedido pela scdelete** (`ScProtocol.cs:104-121`): escrita destrutiva do `sc_api` sem `target` é `NOT_ALLOWED`. A fachada já manda `target` (`studio-api.mjs:257,335`).
5. **Ferramenta `o11_extension`** (`o11-extension.mjs`; esquema na seção 5). `publish` numa chamada:
   1. spec (kernel, puro): `XIF_SPEC_INVALID`;
   2. identidade (leituras): `ListExtensions` + `ListEspaces` pelo nome exato. 0 = criar; 1 extensão = editar (base = `DownloadExtension` da versão ativa, chaves preservadas, `VersionId` guardado); variante de caixa ou duplicado = `EXTENSION_AMBIGUOUS`; nome de eSpace = `EXTENSION_NAME_TAKEN`;
   3. capacidade da bridge (`BRIDGE_TOO_OLD`); `Handshake` com a versão do motor instalado (`XIF_ENGINE_INCOMPATIBLE` com o texto do servidor);
   4. modelo (motor) → stubs e dependências (bridge, leitura). Erro do servidor: `XIF_STUBS_REFUSED`. Cache das dependências em `<anvilRoot>/.local/xif-deps/<host>/<versão da plataforma>/<sha256>.zip`, nunca commitado nem empacotado;
   5. merge e compilação (kernel) → final (motor) → releitura do XIF final (chaves, sha da DLL, nenhum caminho de perfil, nenhuma DLL da plataforma embutida);
   6. `UploadNeeded`: versão igual rodando = `state:"already-running"`, nada enviado;
   7. edição: diff de contrato; para cada elemento que quebra, `GetConsumers(extensionKey, elementKey)`. Consumidor não nomeado: `EXTENSION_BREAKS_CONSUMERS` (D9). Falha: `EXTENSION_CONSUMERS_UNKNOWN` (fecha);
   8. autorização: palavras nomeando a extensão (`namesApp`, `standing-grants.mjs:35`) ou concessão `publish` que cobre a extensão. Quebra de contrato nunca por concessão. Faltando: `WORDS_REQUIRED` / `WORDS_MUST_NAME_TARGET` / `CONFIRM_HOST_REQUIRED`, já com `xifSha256`, `contractDiff` e `consumers`;
   9. escrita por I1 (`extension-publish` com `--extension` e `--expected-version-id`, operationId criado aqui). Resposta única: `{state:"created"|"updated"|"already-running"|"uncertain", extensionKey, extensionId, versionId, xifSha256, dllSha256, contractDiff, consumers, continuation}`.
   - `continuation` (D10) = `ssam_job {lane:"o11", job:{ops:[{op:"reference", producer:"<Ext>", elements:["IServerActionSignature:<Action>"]}]}, captureProducers:["<Ext>"]}`, depois `o11_deliver`/`o11_publish`. Nenhum mecanismo novo de referência.
   - `consumers:true`: depois do publish, a cascata de consumidores por uma exportação nova de `o11-publish.mjs` (I11).
   - `read`: `DownloadExtension` da versão ativa → `xif read` → spec completo, chaves, `versionId`, `signatureHash` e consumidores.
   - `delete`: o motor da scdelete por I1 (`--target=extension:<Nome>`). Uma implementação só.
   - `service-center/integration-studio.mjs`: leituras por `new Resolver(host, {session:'studio', prompt:'never', ...}).resolve('api')` e `auth.bridge.api(host, 'integration-studio', op, args)` (I2). Só exportações que já existem.
   - `ssam.mjs`: registra `o11_extension` no bloco `if (o11)` (`ssam.mjs:453-459`), com `runAnvil: o11Runner`.
6. **Descoberta**: `catalog/fragments/C/dotnet-extensions.json` com a capacidade `integration.dotnet-extension-o11` (`lanes:["o11"]`, `route.kind:"operations"`, sem `elements[].native`, `proofs:[]`, `recommends` `reference.producer-import`). Exemplo offline: `ZZHybridXifLab.Add` (I9).
7. **`setup-dev.ps1`**: compila `Anvil.Xif.Engine` (x86) quando há Service Studio. Falha é aviso; a ferramenta responde `XIF_ENGINE_UNAVAILABLE`.
8. **Documentos**: receita e `ANVIL_INTEGRATION_STUDIO_DIR` em `docs/DESENVOLVIMENTO.md`; o documento da tarefa em `kernel/docs/tasks/`.

Testes da xif:
- Regras novas (falham na base, passam depois):
  - `XifSpecTests`: um spec com identificador ruim, action duplicada sem caixa, parâmetro `Text List`, tipo `Foo`, função com duas saídas, action nova sem corpo e recurso `..\x` dá UM `XIF_SPEC_INVALID` com os sete itens e a correção de cada.
  - `XifPackageTests`: XIF zlib sintético vai e volta para o spec (estruturas, actions, chaves de parâmetro, corpos `Mss`, sha256 de recurso); não-zlib, inflate grande demais e sem raiz `Extension` são recusados.
  - `XifSourceMergeTests`: só os corpos do spec mudam; assinatura vem do stub; corpos intocados e membros auxiliares ficam byte a byte; `Result = checked(Left + Right);` vira `ssResult = checked(ssLeft + ssRight);`.
  - `XifCompilerTests`: stubs sintéticos mais um assembly falso de plataforma compilam para net472 duas vezes com o mesmo sha; nome indefinido dá `XIF_COMPILE_FAILED` com `CS0103`; DLL do autor `OutSystems.RuntimeCommon.dll` dá `XIF_DEPENDENCY_OVERRIDE`.
  - `XifContractDiffTests`: quebra × aditivo, como no item 1.
  - `XifEngineProbeTests`: tipos falsos sem `ProjectVerify` dão `XIF_ENGINE_UNAVAILABLE` com o membro; conjunto completo passa; nenhuma instalação real tocada.
  - `ServiceCenterBridgeTests`: superfície `integration-studio` só leitura (sem claim de operationId, sem guarda de escrita), `file` absoluto/existente/≤256 MiB, `outFile` CreateNew, segredo redigido nos erros, envelope com usuário e segredo, leitura devolve zip e `HEMessage`, operação desconhecida `NOT_ALLOWED`, `Catalog()` lista a superfície; escrita destrutiva sem `target` é `NOT_ALLOWED`.
  - `o11-extension.test.mjs` (bridge falsa, kernel falso, `serviceCenter` falso injetado):
    - criar numa chamada: `ListExtensions` vazio → build → `GenerateSourceCodeStubs` → compila → exatamente uma chamada `extension-publish` com `--expected-version-id=none` → `created`;
    - sem palavras: `WORDS_REQUIRED` com `xifSha256` e zero envios;
    - bridge sem `sc_api:integration-studio`: `BRIDGE_TOO_OLD` antes de qualquer chamada ao kernel;
    - duas linhas variantes de caixa: `EXTENSION_AMBIGUOUS`;
    - erro de stub do servidor: `XIF_STUBS_REFUSED`, zero escritas;
    - `UploadNeeded` igual: `already-running`, zero escritas;
    - resposta perdida: `uncertain`; repetir com o mesmo operationId nunca reenvia;
    - `EXTENSION_VERSION_CHANGED` vindo de I1 passa adiante;
    - edição que quebra com consumidor `Orders_CS` não nomeado: `EXTENSION_BREAKS_CONSUMERS`; com o nome, segue; concessão cobre edição aditiva sem palavras e nunca delete nem quebra;
    - acordo com a bridge: toda operação `integration-studio` que a fachada manda está na tabela `IntegrationStudioOperations` de `ScOperations.cs`.
  - `o11-publish.test.mjs`: a exportação nova da cascata publica cada consumidor de um produtor que não é aba do Studio, parando no primeiro incerto.
- Suítes existentes: `Anvil.Tests` com `--filter ServiceCenter|Xif|ProducerSignature|NativeReference`; fachada `o11-publish`, `o11-extension`. `tool-routes` falha só como na seção 5.

### Lane extlib: Bibliotecas Externas ODC

Arquivos que escreve:
- `kernel/src/Anvil.Core.Odc/Adapters.ODC/ExternalLibraries/**` (NOVO) e `Adapters.ODC/OdcReferenceImporter.cs` (residual: `Adapters.ODC/**`, exceto os `OdcRest*.cs` novos da restsoap).
- `kernel/src/Anvil.Core/Kernel/NativeReferenceSnapshot.cs`.
- `kernel/src/Anvil.Cli.Odc/Program.cs`.
- `kernel/tests/Anvil.Tests.Odc/OdcDependencyTests.cs`, o NOVO `OdcExternalLibraryTests.cs`; `kernel/tests/Anvil.Tests/NativeReferenceSnapshotTests.cs`; fixtures NOVAS em `kernel/tests/fixtures/external-library/**`.
- `platforms/odc/studio/bridge/**`: o NOVO `PortalUpload.cs`, `PortalCommands.cs`, `StartupHook.cs`, `ReferenceCommands.cs`, `README.md`, `tests/Bridge.Tests.csproj`, o NOVO `tests/PortalUploadTests.cs`.
- `platforms/odc/portal/**`: `runtime/access.mjs`, `runtime/effects.mjs`, `runtime/portal-routes.mjs`, os NOVOS `runtime/external-library-upload.mjs` e `runtime/external-library.mjs`, `catalog/portal-capabilities.json`, `README.md`, `tests/access.test.mjs`, `tests/bridge-agreement.test.mjs`, o NOVO `tests/external-library.test.mjs`.
- `platforms/odc/facade/`: o NOVO `odc-external-library.mjs`, `mcp.mjs`, `odc-access.mjs`, `kernel-delivery.mjs`.
- `platforms/odc/facade/catalog/fragments/C/references.json` e o NOVO `external-libraries.json`.
- Testes da fachada: `kernel-delivery.test.mjs`, `odc-access.test.mjs`, `mcp.test.mjs` e o NOVO `odc-external-library.test.mjs`.
- `platforms/odc/docs/BIBLIOTECAS-EXTERNAS.md` (NOVO, pt-BR).

Estado em `ce7c6b25`:
- Lacuna declarada `integration.external-libraries-odc` (`catalog/fragments/C/integrations-without-route.json:157-176`). A evidência dela está velha: cita `OdcRuntime.cs:65-66`, mas `OdcRuntime.cs:75-76` já importa assinaturas públicas por `OdcReferenceImporter`. `discovery-capabilities.json:744` (`reference-import-headless`) está velho do mesmo jeito.
- Portal: `effects.mjs:57-60` `OPERATION_STATUS.generation` tem `key:'key'`, mas o POST responde `operationKey` (bug); `effects.mjs:70-77` `TARGET_NAMES` sem o delete de generation-operation; `portal-routes.mjs:50-60` `PORTAL_WRITES` sem a rota de publish; `access.mjs:533-541` `assetDelete` apaga e relê 404, sem checar consumidores.
- Bridge ODC v38: `PortalCommands.cs:306` capacidades (`portal-call`, `portal-session`, `auth-status`, `...:secretRefs`); `StartupHook.cs:102` isenção do watchdog; `:176-182` despacho; `ReferenceCommands.cs:32` recusa produtor que não é eSpace.
- Kernel: `NativeReferenceSnapshot.cs:91-92` forma pública ODC só eSpace; `:165-172` recusa outros tipos sem atestado; `OdcReferenceImporter.cs:15` recusa o que não é assinatura pública ODC e `:35-43` importa por `IESpace.AddDependency(BinarySignatureInformation)`. O enum `ReferenceKind` do O11 NÃO tem `ExternalLibrary` (o catálogo `kernel/catalog/model-api-11.55.69.json` não tem o nome; o do ODC tem, `platforms/odc/docs/model-api/OutSystems.Model.V1.md:4142-4153`).
- `kernel-delivery.mjs:532-544` captura o produtor por `reference-snapshot`.
- Nada gera, compila, envia, publica, aplica tag ou referencia biblioteca externa.

O que fazer:
1. **Kernel** (`Adapters.ODC/ExternalLibraries/`, compilado pelo glob):
   - `ExternalLibrarySpec`: o spec de I9 mais `namespace`, `packages[{name, version}]` (versão exata) e `usings[]`. Todos os erros de uma vez (`EXTERNAL_LIBRARY_SPEC_INVALID`).
   - `ExternalLibraryProject`: projeto determinístico (`net10.0`, SDK `OutSystems.ExternalLibraries.SDK` fixado numa constante, interface `I<Nome>` com `OSInterface/OSAction/OSParameter`, classe, estruturas `OSStructure/OSStructureField`).
   - `ExternalLibraryBuild`: `dotnet publish -c Release -r linux-x64 --self-contained false -p:Deterministic=true` por trás de uma interface de processo, com timeout; diagnósticos `CS`/SDK mapeados para action e linha do spec; zip determinístico (entradas ordenadas, datas fixas); portões: um só `.deps.json`, `.NETCoreApp,Version=v10.0`, limite de tamanho. Códigos `EXTERNAL_LIBRARY_BUILD_FAILED`, `DOTNET_SDK_MISSING`, `NUGET_RESTORE_FAILED`, `PACKAGE_NOT_NET10`, `PACKAGE_TOO_LARGE`.
   - `ExternalLibraryContents`: conteúdo do pacote e da assinatura publicada; diff `Added/Removed/Updated`.
   - CLI `anvil-odc external-library build|contents|diff` (`Anvil.Cli.Odc/Program.cs:79-103`).
2. **Referência a partir de um app** (pelo job `reference` que já existe):
   - `NativeReferenceSnapshot.cs`: aceita a forma v2 sem atestado com `ModuleKind` ExternalLibrary (elementos `action` e `structure`), **comparando pelo nome** (`ModuleKind.ToString() == "ExternalLibrary"`), porque `Kernel/**` também compila contra o Studio O11. Extensão sem atestado continua recusada.
   - `OdcReferenceImporter.cs`: `ModuleKind`/`ModuleType` ExternalLibrary no `BinarySignatureInformation`.
   - `ReferenceCommands.cs`: aceita `ReferenceKind` ExternalLibrary; capacidade `reference-snapshot:external-library` em `PortalCommands.cs:306`.
   - `kernel-delivery.mjs`: bridge antiga que responde "not extensions or external libraries" vira `BRIDGE_UPGRADE_REQUIRED` antes do build (continuação `studio_attach` depois de reabrir o Studio).
3. **Bridge ODC**: verbo `portal-upload <request.json> --tenant <host>` (capacidade `portal-upload`). Regras puras em `PortalUpload.cs`:
   - GET `/uploads` com o cliente da sessão; PUT do arquivo (de `journal/portal/uploads`, sha256 conferido) para a `uploadUrl` com um `HttpClient` NOVO e sem autenticação: só https, porta padrão, sem userinfo, sem redirecionamento, `application/zip`, 600 s;
   - reserva `journal/portal/writes/<uuid>` antes do POST `/generation-operations`;
   - resposta só `{operationKey, bytes, sha256}`; as duas URLs nunca saem.
   - `StartupHook.cs`: despacho e isenção do watchdog como `portal-call`. Sem renomear, sem subir versão.
4. **Portal runtime**:
   - `effects.mjs:59` `key:'operationKey'`; `TARGET_NAMES` ganha `external-library-generation-api-v1:delete:/generation-operations/{operationKey}` com `libraryName` e `filename`.
   - `portal-routes.mjs`: `PORTAL_WRITES['externalLibraries.publishJob'] = { route: ['logic', 'CreateExternalLibraryWizard.createnewrevision', 'logic/CreateExternalLibraryWizard/createnewrevision/ActionExternalLibraryPublishJob'], effect: 'mutation' }`. O `PortalMetadata` resolve versão e apiVersion na hora (sem apiVersion fixo).
   - `access.mjs`: `assetDelete` lê nome e consumidores (`dependency-management` GET `/assets/{assetKey}/consumers`) ANTES da reserva; palavras nomeiam o ativo e cada consumidor, senão `CONSUMERS_WOULD_BREAK`, nada reservado. Ajudas do deploy e a reconciliação de passo incerto.
   - `external-library-upload.mjs`: o enviador pelo API Client do cofre (GET uploads, PUT sem `Authorization`, POST generation), sem devolver URL.
   - `external-library.mjs`: orquestração `deploy`/`status`/`discard`.
5. **Ferramenta `odc_external_library`** (`odc-external-library.mjs`, uma linha em `mcp.mjs`; esquema na seção 5). `deploy` numa chamada:
   1. spec e build no kernel (códigos do item 1);
   2. palavras nomeando a biblioteca (`namesWhole`, `studio-create-app.mjs:42`) ou concessão `publish`: senão `WORDS_MUST_NAME_LIBRARY`; `TENANT_READ_ONLY`; `CORPORATE_TENANT_GUARD`;
   3. os dois planos de credencial antes de qualquer mutação (`resolvePublic`, `resolvePortal`): `WEB_SIGN_IN_REQUIRED` com `odc_portal_login`, ou `CREDENTIAL_PROMPT_OPENED`; `PortalMetadata` da rota de publish (só GETs): `PORTAL_CONTRACT_CHANGED` antes do upload; upload: capacidade `portal-upload` da bridge, senão API Client do cofre, senão `BRIDGE_UPGRADE_REQUIRED`;
   4. leituras: ativo pelo nome exato (novo, biblioteca existente ou `NAME_TAKEN_BY_OTHER_ASSET`); job vivo do mesmo nome: `GENERATION_PENDING` com `jobKey` e a continuação `discard`; biblioteca existente: consumidores e diff contra a assinatura publicada: removido ou alterado com consumidores = `CONSUMERS_WOULD_BREAK` (D9) salvo palavras nomeando cada um; tag usada ou não maior que a mais alta: `TAG_TAKEN` com a próxima livre;
   5. reserva do recibo (identidade `odc-external-library`: tenant, nome, sha256 do pacote; UUIDs derivados `upload`, `publish`, `release`); palavras só como sha256;
   6. upload (nome remoto `<Nome>-<sha16>.zip`); 7. espera da geração dentro da ferramenta (até 600 s, a cada 5 s): `GENERATION_FAILED` com as mensagens; conteúdo diferente do plano: `CONTENTS_DIFFER_FROM_PLAN`, job não publicado;
   8. publish `externalLibraries.publishJob {JobKey}` pela janela do Portal do Studio, senão a conta do cofre; espera `publish` até terminar; `PUBLISH_FAILED` com o log;
   9. tag (PATCH da revisão; padrão: patch seguinte da maior, ou `1.0.0`); 10. releitura: revisão, tag e runtime NET10, senão `RELEASE_READBACK_FAILED`;
   11. resposta única: biblioteca, revisão, tag, runtime, conteúdo, consumidores marcados desatualizados com os passos `studio_refresh_references` e `studio_publish` de cada um, e a continuação do job de referência. Nunca diz que consumidor não precisa republicar.
   - Resposta perdida: `UNCERTAIN`. O mesmo `operationUuid` reconcilia cada passo incerto pela leitura exata (job pelo nome do arquivo, chave do publish, tag) e continua só do estado provado. `AMBIGUOUS` recusa com a evidência.
   - `status`: leitura (ativo, revisões, runtime, consumidores, jobs pendentes). `build`: sem tenant. `discard`: apaga um job pendente (destrutivo; palavras nomeiam a biblioteca).
   - Delete da biblioteca: `odc_asset_delete` endurecido (item 4); `odc-access.mjs:92-93` muda a descrição (palavras nomeiam o ativo e cada consumidor).
6. **`kernel-delivery.mjs` para a restsoap**: o gancho de I6 e a cópia do campo de I7.
7. **Descoberta**:
   - `references.json`: atualiza `reference.import-headless-odc` (o import de módulo público já existe; biblioteca externa passa a ter rota em `reference.external-library-odc`).
   - NOVO `external-libraries.json`: `integration.external-library-odc` e `reference.external-library-odc` (`lanes:["odc"]`, `route.kind:"operations"`, sem `elements[].native`, `proofs:[]`, declarado e não provado ao vivo). Exemplo de I9 (`SSAMTextTools.Reverse`).
   - A entrada velha `integration.external-libraries-odc` sai de `integrations-without-route.json` pela restsoap (I8). Até o merge, as duas coexistem com ids diferentes; o teste da extlib não exige a ausência da velha.
8. **Documento** `platforms/odc/docs/BIBLIOTECAS-EXTERNAS.md` (pt-BR): fluxo, credenciais, SDK .NET 10 e NuGet necessários, limites.

Testes da extlib:
- Regras novas (falham na base, passam depois):
  - fachada `odc-external-library.test.mjs` (fakes de bridge, cofre, prompt e kernel):
    1. spec com identificadores ruins, action duplicada, tipo desconhecido, estrutura não declarada e pacote sem versão: `EXTERNAL_LIBRARY_SPEC_INVALID` com os cinco; zero chamadas a bridge, tenant e kernel;
    2. palavras ausentes ou sem o nome: `WORDS_MUST_NAME_LIBRARY`; tenant corporativo sem `confirmTenant`: `CORPORATE_TENANT_GUARD`; zero envios, nenhum recibo;
    3. janela do Portal sem login: `WEB_SIGN_IN_REQUIRED` com `odc_portal_login`, antes de qualquer `portal-upload`; metadados da rota sem resolver: `PORTAL_CONTRACT_CHANGED` antes do upload;
    4. bridge sem `portal-upload`: com API Client no cofre, o enviador do cofre roda e o PUT não leva `Authorization`; sem ele, `BRIDGE_UPGRADE_REQUIRED`, nada enviado;
    5. biblioteca com consumidores e action removida: `CONSUMERS_WOULD_BREAK`; com palavras nomeando cada um, segue e lista os consumidores como desatualizados;
    6. job vivo do mesmo nome: `GENERATION_PENDING` com `jobKey`; tag usada: `TAG_TAKEN` com a próxima;
    7. caminho feliz: build, upload, duas leituras internas até `ReadyForReview`, `publishJob`, publish `Finished`, PATCH da tag, releitura NET10, uma resposta; a resposta serializada não tem `uploadUrl`, `downloadUrl` nem `amazonaws`;
    8. `GenerationError`: `GENERATION_FAILED`, sem publish; `FinishedWithError`: `PUBLISH_FAILED`, sem PATCH;
    9. resposta do `portal-upload` perdida: `UNCERTAIN`, nunca reenviada; o mesmo `operationUuid` reconcilia pelo nome do arquivo; dois jobs iguais: `AMBIGUOUS`;
  - portal: `assetDelete` de ativo com consumidores e palavras só com o ativo: `CONSUMERS_WOULD_BREAK`, sem reserva, sem DELETE (hoje apaga); `OPERATION_STATUS.generation.key === 'operationKey'`; `TARGET_NAMES` cobre o delete de generation-operation; `routeOf('externalLibraries.publishJob', true)` devolve a rota `logic`; `bridge-agreement` continua passando;
  - `kernel-delivery.test.mjs`: bridge antiga recusando produtor ExternalLibrary dá `BRIDGE_UPGRADE_REQUIRED` antes do build; `data.integration` do resultado do kernel chega ao relatório (I7); o gancho de I6 é chamado quando existe e uma recusa dele para antes do snapshot;
  - kernel: `ExternalLibrarySpec` com todos os problemas; projeto golden (mesmo spec, mesmos bytes; net10 e SDK fixados); build com processo falso: saída com erros `CS` vira problemas por action e linha, `dotnet` ausente vira `DOTNET_SDK_MISSING`; zip determinístico com o mesmo sha duas vezes; `deps.json` v8.0 dá `PACKAGE_NOT_NET10`, dois `deps.json` recusados, pacote grande dá `PACKAGE_TOO_LARGE`; diff `Added/Removed/Updated`;
  - `NativeReferenceSnapshotTests`: aceita o envelope v2 sem atestado de ExternalLibrary com action e structure; continua recusando extensão sem atestado;
  - `OdcDependencyTests`: import de um produtor biblioteca externa sintético num candidato consumidor, só se a sonda headless provar que dá para criar o produtor offline (senão o teste declara o motivo e não finge);
  - `PortalUploadTests`: recusa URL não https, com userinfo ou com redirecionamento, pacote fora de `journal/portal/uploads` e sha256 diferente; o PUT nunca passa pelo handler autenticado (zero chamadas ao host do upload); a reserva é gravada antes do POST; o mesmo UUID duas vezes dá `retry_refused`; a resposta não tem URL.
- Suítes existentes: `Anvil.Tests.Odc` com `--filter OdcDependency|OdcExternalLibrary|OdcJob`; `Anvil.Tests` com `--filter NativeReference`; `Bridge.Tests`; portal `access`, `bridge-agreement`, `contracts`, `security`; fachada `kernel-delivery`, `odc-access`, `mcp`. `tool-routes` falha só como na seção 5.

### Lane restsoap: REST consumir e expor (O11 e ODC) e SOAP (O11)

Arquivos que escreve:
- `kernel/src/Anvil.Core/Kernel/`: `Verbs.cs`, `VerbSurface.cs`, `CommandSurface.cs`, `JobPreflight.cs`, `LogicExpander.cs`, `LogicOrder.cs`, `JobRunner.cs` (se precisar) e os NOVOS `RestExpander.cs`, `RestExposeExpander.cs`, `RestSamples.cs`, `RestOpenApi.cs`, `SoapPlan.cs`, `SoapContract.cs`, `IntegrationImport.cs`. Residual: `Kernel/**` e `Delivery/**`, exceto `NativeReferenceSnapshot.cs`.
- `kernel/src/Anvil.Core/Delivery/Delivery.cs`, `DeliveryTask.cs`.
- `kernel/src/Anvil.Core.Odc/Adapters.ODC/OdcRest*.cs` (só arquivos NOVOS).
- `kernel/src/Anvil.Bridge/Dispatch.cs`, o NOVO `IntegrationImportHandler.cs`, `Anvil.Bridge.csproj`. Residual: `Anvil.Bridge/**` exceto `Sc*.cs`.
- `kernel/src/Anvil.Core/Anvil.Core.csproj`, `kernel/src/Anvil.Core.Odc/Anvil.Core.Odc.csproj`, `kernel/tests/Anvil.Tests.Odc/Anvil.Tests.Odc.csproj`.
- Testes C#: `kernel/tests/Anvil.Tests/VerbSurfaceTests.cs` e os NOVOS `RestSpecTests.cs`, `RestExposeSpecTests.cs`, `SoapPlanTests.cs`, `SoapContractTests.cs`, `DeleteBreaksTests.cs`, `DeliveryIntegrationImportTests.cs`, `IntegrationImportArgsTests.cs`; `kernel/tests/Anvil.Tests.Odc/RestOpenApiImportTests.cs` (NOVO).
- Jobs e fixtures NOVOS: `kernel/tests/jobs/rest-spec-{consume,expose,edit-delete}.json`, `kernel/tests/jobs-odc/rest-spec-{consume,expose}.json`, `kernel/tests/jobs-odc/rest-openapi-import.json`, `kernel/tests/jobs-negative/{rest-spec-invalid-path,rest-delete-consumers,soap-method-not-found}.json`, `kernel/tests/jobs-live/{soap-import-calculator,o11-rest-openapi-import}.json`, `kernel/tests/fixtures/wsdl/**`, `kernel/tests/fixtures/openapi/**` (sintéticos).
- `kernel/AGENTS.md`, `kernel/docs/NAO-DA.md`.
- `platforms/odc/facade/`: `o11-cycle.mjs`, `job-runner.mjs`, `job-guidance.mjs`, `responses.mjs`, o NOVO `integration-documents.mjs`; `catalog.mjs`, `discovery.mjs` e `coverage-inventory.mjs` SÓ nas listas de ops (`catalog.mjs:27`, `discovery.mjs:23`, `coverage-inventory.mjs:310`).
- Catálogo C: `catalog/fragments/C/rest.json`, `catalog/fragments/C/integrations-without-route.json`, `catalog/fragments/C/accounting.json` (gerado), o NOVO `catalog/fragments/C/soap.json`; `docs/catalogo/C/README.md`, `docs/catalogo/C/contabilidade-c.mjs`.
- Testes da fachada: `catalog-c-routes.test.mjs`, `responses.test.mjs`, `pacote-laneE-responses.test.mjs`, `o11-cycle.test.mjs`, `discovery.test.mjs` (só a lista de `:718`) e os NOVOS `integration-documents.test.mjs`, `o11-cycle-integration-delete.test.mjs`, `discovery-integrations.test.mjs`.
- `docs/integracoes-rest-soap.md` (NOVO, pt-BR).

Estado em `ce7c6b25`:
- REST consumir e expor só por verbos crus: `catalog/fragments/C/rest.json:29-711` (consumir) e `:712-1134` (expor); delete de cliente ou método indeterminado (`:615-642`); ODC recusa usuário e senha no modelo (`:1136-1161`).
- SOAP e callbacks são lacunas declaradas: `integrations-without-route.json:79-96` e `:116-136`.
- Kernel: despacho das ops compactas em `Verbs.cs:102-127`; delete recusa com consumidores salvo `force` (`Verbs.cs:802-820`); verbos crus com chaves fechadas em `VerbSurface.cs:22-60`; `api --op` em `CommandSurface.cs:16-26`; `SpecExpander.cs:21-42`.
- Bridge O11 sem verbo de import (`Dispatch.cs:9-23`); entrega em `Delivery.cs:173-191`; padrão de recusa por capacidade em `Delivery.cs:232-238`.
- Fachada: palavras do `o11_deliver` em `o11-cycle.mjs:604-618`; `wordsFor` em `standing-grants.mjs:116-122` (concessões cobrem só deliver e publish, `:23`); o exemplo do discover sai do primeiro job de prova (`discovery.mjs:1942-1966`); `compactDelivery` mantém só `DELIVERY_FIELDS` no sucesso do `studio_deliver` (`responses.mjs:314-348`).

O que fazer:
1. **Três ops compactas de job**, pelos `o11_deliver`, `studio_deliver`, `o11_job` e `ssam_job` atuais. Nenhuma ferramenta MCP nova. Cada op é declarativa sobre o que nomeia: cria o que falta; atualiza no lugar pela chave (chamadores continuam ligados); não toca o que não nomeia; `remove` apaga o que lista. Validação de chaves fechadas e TODOS os erros antes de aplicar qualquer op.
   - `rest` (consumir; O11 e ODC; headless): `client`, `methods`, `structures`, `openapi`, `remove`, `breaks`, como no levantamento. Expansão só pelos verbos crus já provados; amostra JSON vira estruturas pelos `JsonParser.TryParse`/`StructureHelper.SetObjectType` públicos do plugin (por reflexão, regra install-agnostic). Códigos `REST_*` da seção 5. `REST_CREDENTIALS_NOT_IN_MODEL` nas duas faixas (no O11 é regra do SSAM: `ssamRule: true`, correção = entrada de cabeçalho `Authorization` obrigatória).
   - `rest-expose` (O11 e ODC; headless): `service`, `methods` com `action`/`arguments`/`results` como açúcar de passos; corpo pelo `LogicExpander` com o tipo de action novo `rest`. Códigos `REST_EXPOSE_*`.
   - `soap` (só O11; ODC responde `SOAP_LANE_UNSUPPORTED`): `wsdl`, `client`, `service`, `port`, `binding`, `soapVersion`, `methods`, `refresh`, `remove`, `breaks`. Pré-checagem headless em `SoapPlan.cs` (porte do comportamento de `soap_import.py`, não do código); import nativo pela bridge; validação do candidato por `SoapContract.cs` (`SOAP_CONTRACT_TYPE_MISMATCH`), releitura exata dos métodos e delta TrueChange 0.
   - OpenAPI: ODC headless (`GetSwaggerInfo` + `ToImport` + `ISwaggerInfo.Create`, com `restServiceOverride` que recusa toda chamada HTTP). Código que só existe no ODC vai em arquivo NOVO `Adapters.ODC/OdcRest*.cs`; o `Kernel/` o alcança por reflexão ou por um registro estático feito por um `[ModuleInitializer]` desse arquivo novo. Nenhum arquivo existente de `Adapters.ODC` nem `IStudioRuntime` muda. O11: pela bridge.
   - Delete: chave opcional `breaks` no verbo cru; `DELETE_HAS_CONSUMERS` / `CONSUMERS_CHANGED`; método SOAP apagado leva as estruturas que nenhum método restante usa.
2. **Bridge O11, verbo `integration_import`** (`IntegrationImportHandler.cs`), capacidades `integration_import:wsdl` e `integration_import:openapi`.
   - Roda o importador do próprio plugin numa cópia DESTACADA (`ESpace.Load` do snapshot, como `MergeHandler`), com o `PluginWorkspace` emprestado da aba. Nunca toca o módulo aberto.
   - Validação pura dos argumentos (caminhos absolutos, hashes) em `Kernel/IntegrationImport.cs`.
   - `Delivery.cs`: snapshot → `integration_import` → apply do resto no candidato → validação → merge. Bridge antiga: `INTEGRATION_IMPORT_NEEDS_BRIDGE` antes do snapshot. `ssam_job`/`o11_job` sem Studio: `INTEGRATION_IMPORT_NEEDS_STUDIO`.
   - A restsoap NÃO edita `Anvil.Cli/Program.cs` (xif). `Delivery.Run` só ganha parâmetro opcional no fim; o que faltar vem do job fixado.
   - `Dispatch.cs`: o verbo novo, as duas capacidades dele e a string `sc_api:integration-studio` da xif (I3).
3. **Fachada**:
   - `integration-documents.mjs` com `prepareIntegrationJob` (I6): fixa documentos (GET 30 s, 5 MB, `.wso` tenta `?WSDL`, DTD/ENTITY recusados, imports e `$ref` externos, até 32 arquivos) em `<lane .local>/documents/<sha256>`, reescreve a op para `{path, sha256, source}`, e aplica a regra das palavras destrutivas (abaixo).
   - Palavras destrutivas: `remove` das três ops, delete cru de alvo de integração (`IRestClient`, `IRestAction`, `IRestStructure`, `IRestService`, `IRestServiceAction`, `ISOAPClient`, `ISOAPAction`, `ISOAPStructure`), qualquer `breaks`, e mudança de verbo HTTP, caminho ou nome de método exposto existente. As palavras nomeiam cada alvo `Tipo:Nome` e cada entrada de `breaks`: senão `INTEGRATION_DELETE_WORDS`, `DELETE_BREAKS_WORDS`, `INTEGRATION_DELETE_TARGET_FORM` ou `REST_EXPOSE_CONTRACT_WORDS`. Concessão permanente nunca cobre delete.
   - `o11-cycle.mjs` chama `prepareIntegrationJob` antes da captura; `job-runner.mjs` antes do `ssam_job`/`o11_job`; o `studio_deliver` recebe o mesmo pela extlib (I6).
   - `responses.mjs`: `DELIVERY_FIELDS` ganha `integration` (I7).
   - `job-guidance.mjs`: as dicas das ops novas.
4. **Catálogo C** (dono dos fragmentos C existentes, exceto `references.json`):
   - `rest.json`: rotas das ops compactas, contratos `rest.shapes.*`/`rest-expose.shapes.*`, operações de delete, provas de edição O11 e a capacidade `integration.rest-import` (OpenAPI).
   - `soap.json` NOVO: `integration.soap` como capacidade (`lanes:["o11"]`) e `integration.soap-odc` indisponível (`lanes:["odc"]`).
   - `integrations-without-route.json`: sai `integration.soap` e sai `integration.external-libraries-odc` (I8). `integration.rest-callbacks` fica.
   - `contabilidade-c.mjs` e `accounting.json` regenerado (`--check` igual); `catalog-c-routes.test.mjs:88,134` passa a esperar SOAP como capacidade no O11 e indisponível no ODC.
   - `catalog.mjs:27`, `discovery.mjs:23`, `coverage-inventory.mjs:310` e `discovery.test.mjs:718`: `rest`, `rest-expose`, `soap` nas listas de ops.
   - `docs/catalogo/C/README.md`: linhas dos fragmentos novos de todas as lanes (`dotnet-extensions.json`, `external-libraries.json`, `soap.json`).
5. **Documentos**: `docs/integracoes-rest-soap.md`, `kernel/AGENTS.md` (receita das ops), `kernel/docs/NAO-DA.md` (SOAP no ODC, callbacks, fluxo de autenticação).

Testes da restsoap:
- Regras novas (falham na base, passam depois):
  - `RestSpecTests`: `SameSpecSameOps` (o op `rest` do ViaCepApi expande exatamente para os verbos crus de `tests/jobs/rest-consume-get.json`); `AllErrorsBeforeAnyChange` (caminho sem `/`, `{CEP}` sem entrada url, Body em GET e dois Body numa recusa só, OML base intacto); `QueryInputsGoToUrlPath`; `SampleBuildsStructures` (amostra aninhada vira `IRestStructure` com `NameInJSON`; amostra inválida `REST_SAMPLE_INVALID`); `UpdateInPlaceKeepsKey`; `OdcCredentialsRefused`.
  - `RestExposeSpecTests`: cada código `REST_EXPOSE_*` recusado antes de qualquer op; mapeamento válido gera chamada, atribuição e links, módulo válido.
  - `SoapPlanTests` (WSDL sintético): porta SOAP 1.1 única vence; binding resolve para a porta nativa; seletores e seus `*_NOT_FOUND`; `SOAP_METHOD_NOT_FOUND` listando; `UNSAFE_WSDL_XML`; `AMBIGUOUS_SOAP_PORT` com todas as escolhas; `DOCUMENT_SHA256_MISMATCH`; nome do cliente higienizado.
  - `SoapContractTests`: parâmetro complexo tipado Text, ou estrutura de outra chave, dá `SOAP_CONTRACT_TYPE_MISMATCH`; a estrutura exata passa.
  - `DeleteBreaksTests`: método REST com chamador dá `DELETE_HAS_CONSUMERS`; apagar o chamador antes no mesmo job passa; `breaks` igual aos consumidores aceito; diferente dá `CONSUMERS_CHANGED`; método SOAP apagado leva estruturas sem uso.
  - `DeliveryIntegrationImportTests` (bridge falsa, padrão `DeliveryMergeOrderTests`): sem `integration_import:wsdl` recusa `INTEGRATION_IMPORT_NEEDS_BRIDGE` sem `snapshot_module` nem `merge_from_oml`; com ela, a ordem é snapshot, import, apply, merge; contrato falho = recusa sem merge.
  - `IntegrationImportArgsTests`: caminho relativo ou sha256 diferente = não executado.
  - `VerbSurfaceTests`: `rest`, `rest-expose`, `soap` presos ao despacho; delete aceita `breaks`; `api --op rest|rest-expose|soap` existem.
  - `RestOpenApiImportTests` (ODC, fixture sintética): só as operações escolhidas são criadas; `$ref` externo não incluído dá `OPENAPI_NETWORK_REFUSED` com a URI, zero chamadas HTTP.
  - Jobs de suíte novos com `expectValid` e os negativos com a recusa.
  - Fachada: `integration-documents.test.mjs` (WSDL local fixado; `.wso` → `?WSDL` com fetch falso; 5 MB; DTD; esquema não suportado; OpenAPI com `$ref` externo incluído); `o11-cycle-integration-delete.test.mjs` (palavras sem `IRestAction:X` dão `INTEGRATION_DELETE_WORDS` antes de `runAnvil`; concessão sozinha não cobre delete; `breaks` não nomeado; alvo `$alias` dá `INTEGRATION_DELETE_TARGET_FORM`; mudança de caminho exposto sem o nome dá `REST_EXPOSE_CONTRACT_WORDS`); `discovery-integrations.test.mjs` ("importar wsdl soap" no O11 dá `integration.soap`; no ODC, `integration.soap-odc` indisponível; "importar openapi swagger" dá `integration.rest-import`; "apagar metodo rest" mostra o delete com consumidores e palavras); `responses.test.mjs` (`compactDelivery` mantém `integration` no sucesso).
- Suítes existentes: `Anvil.Tests` (`JobTests` com os jobs novos, `VerbSurface`, `Delivery*`); `Anvil.Tests.Odc` com `--filter Rest|Job`; fachada `o11-cycle`, `responses`, `catalog-c-routes`, `discovery*`, `job-runner` (se existir teste), comparando com a base; `node platforms/odc/facade/catalog-check.mjs --front C` sem erro.

---

## 3. Arquivos compartilhados: dono único

| Arquivo ou área | Dono | Os outros usam |
|---|---|---|
| `platforms/odc/facade/catalog/tools.json` e `tests/fixtures/discover-tool-*.json`, `tests/tool-routes.test.mjs`, `tests/discover-tools.test.mjs` | scdelete | seção 5 (rotas de todos os nomes vivos novos) |
| Fragmentos C existentes `rest.json`, `integrations-without-route.json`, `accounting.json` (e `docs/catalogo/C/**`, `catalog-c-routes.test.mjs`) | restsoap | I8 |
| Fragmento C `references.json` | extlib | — |
| Fragmentos C novos `dotnet-extensions.json` / `external-libraries.json` / `soap.json` | xif / extlib / restsoap | ids únicos (I8) |
| `discovery-capabilities*.json`, `catalog/ownership.json`, `catalog/README.md` | integrador (nenhuma lane) | nenhuma lane precisa: as capacidades novas vão em fragmentos |
| `catalog.mjs`, `discovery.mjs`, `coverage-inventory.mjs` | restsoap, só as listas de ops | — |
| `platforms/odc/facade/ssam.mjs` (registro das ferramentas O11) | xif | só a xif registra ferramenta nova no `ssam.mjs` |
| `platforms/odc/facade/mcp.mjs` (registro das ferramentas ODC) | extlib | só a extlib registra ferramenta nova no `mcp.mjs` |
| `platforms/odc/facade/studio-write-lock.mjs` (+ teste) | scdelete | I4 |
| `platforms/odc/facade/continuations.mjs` | scdelete, só `MCP_TOOLS` | D10 |
| `platforms/odc/facade/guides/o11.md`, `guides/odc.md` | scdelete | I10 |
| `platforms/odc/facade/responses.mjs` | restsoap | I7 |
| `platforms/odc/facade/kernel-delivery.mjs` | extlib | I6, I7 |
| `platforms/odc/facade/service-center/**` | scdelete (menos `integration-studio.mjs`, novo, da xif) | I1, I2 |
| `platforms/odc/facade/o11-publish.mjs` | xif | `consumerNames` congelado (1.4.6); I11 |
| `kernel/src/Anvil.Bridge/Dispatch.cs` (lista de capacidades O11) | restsoap | I3: escreve as capacidades de todas as lanes |
| `kernel/src/Anvil.Bridge/Sc*.cs` | xif | endurecimento do `ScGuard` pedido pela scdelete |
| Bridge ODC (`platforms/odc/studio/bridge/**`) | extlib | — |
| `.csproj` de teste e de fonte | tabela 1.4.4 | — |
| `docs/DESENVOLVIMENTO.md` | xif | — |
| `docs/OPERACOES-O11.md` | scdelete | — |
| `kernel/AGENTS.md`, `kernel/docs/NAO-DA.md` | restsoap | — |

---

## 4. Interfaces entre lanes (assinaturas exatas)

Princípio: nenhuma lane compila contra um símbolo que só outra lane cria. As interfaces são exportações que já existem, flags de linha de comando, campos JSON, strings de capacidade e importação dinâmica com injeção. Cada lane programa e testa sozinha, com fakes.

**I1. Service Center para a xif (publish e delete de extensão).** Dono: scdelete. Usuário: xif.

```js
// platforms/odc/facade/service-center/index.mjs: exportação existente, assinatura sem mudança
export async function runServiceCenter(argv /* string[] */, deps = {}) /* -> Promise<object>: nunca lança */
```

Delete (motor novo):

```text
argv = ['delete', '--host=<host>', '--target=extension:<Nome|Chave>', '--words=<palavras do dono>',
        ('--confirm-host=<host>')?, ('--operation-id=<uuid>')?, ('--plan-only')?]
       // --target repete; kinds: application | module | extension; também --prefix=<p> --prefix-kind=<kind> --max-deletes=<n>
-> { ok, host, auth, action: "delete", state: "confirmed"|"absent"|"refused"|"uncertain"|"planned", operationId,
     deleted: [{kind, name, key, application}], absent: [...], deletedModules: string[], affectedApplications: string[],
     consumers: {<nome do alvo>: string[]}, receipts: string[],
     code?: "DELETE_REFUSED"|"DELETE_UNCONFIRMED"|"STUDIO_BRIDGE_OUTDATED"|..., problems?: Problem[], repeat?: object }
```

Publish de extensão (ação existente, flags novas):

```text
argv = ['extension-publish', '--host=<host>', '--xif-file=<.xif absoluto>', '--extension=<Nome>',
        '--expected-version-id=<id|none>', ('--application-key=<k>')?, ('--commit-message=<texto>')?,
        '--words=<palavras>', '--operation-id=<uuid>', '--execute', ('--confirm-host=<host>')?]
-> recibo existente { ok, state: "confirmed"|"accepted-unverified"|"rejected"|"uncertain", operationId, extensionId,
     extensionVersionId, messages, ... }   // "confirmed" depois da espera limitada
-> recusa antes da reserva: { ok:false, code:"EXTENSION_VERSION_CHANGED", error, observed:{versionId|null} }
```

- A xif injeta `deps.serviceCenter = (argv, deps) => ...` nos testes. O padrão é `(await import('./service-center/index.mjs')).runServiceCenter`.
- No worktree da xif, o `delete` e as flags novas ainda não existem. Os testes da xif usam o fake. A chamada real vale depois do merge.

**I2. Superfície `integration-studio` no cliente da bridge.** Dono: scdelete (`service-center/bridge.mjs`). Usuário: xif.

```js
await bridge.api(host, 'integration-studio', 'Handshake' | 'GenerateSourceCodeStubs' | 'GetSourceCodeDependencies' | 'UploadNeeded', args)
// só leitura: write:true nessa superfície -> BridgeError('BAD_REQUEST'); resposta { ok:true, result } como as outras superfícies
await bridge.serviceCenterCatalog() // -> { soap: string[], 'server-api': string[], 'sc-rest': string[], 'integration-studio'?: string[], closed: string[] } | null
```

- `args` por operação: `Handshake {version, lastUpgradeVersion}`, `GenerateSourceCodeStubs {file, outFile}`, `GetSourceCodeDependencies {outFile}`, `UploadNeeded {extensionKey, extensionHash}`. Caminhos absolutos. `outFile` não pode existir.
- A xif chega à bridge por `new Resolver(host, {session:'studio', prompt:'never', locate, present: async () => false, running, opener: null}).resolve('api')` (`auth.mjs:167-243`), exportações existentes.

**I3. Strings de capacidade da bridge O11.** Dono: restsoap (`Dispatch.cs:20-23`). Acrescenta, no array `Capabilities`:
- `"integration_import:wsdl"`, `"integration_import:openapi"` (restsoap);
- `"sc_api:integration-studio"` (para a xif).
- E o verbo `"integration_import"` em `Verbs` (`:9-12`) e no `switch` (`"integration_import" => await IntegrationImportHandler.Handle(p)`).
- A fachada lê capacidades por `bridge.capabilities()` (`service-center/bridge.mjs:88`) ou pelo `bridge_manifest`. Antes do merge, a restsoap anuncia uma superfície que só a xif implementa: nada roda ao vivo antes do merge, então não há efeito.

**I4. Trava de escrita do Studio.** Dono: scdelete (`studio-write-lock.mjs:58-83`). Predicados novos ou mudados:

```js
o11_service_center_write: a => ['delete', 'module-delete', 'extension-delete', 'application-delete'].includes(a.action)
  ? a.execute !== false && String(a.words ?? '').trim() !== ''
  : a.execute === true && a.action !== 'verify',
o11_extension: a => a.action === 'publish' || (a.action === 'delete' && String(a.words ?? '').trim() !== ''),
odc_external_library: a => a.action === 'deploy' || a.action === 'discard',
```

- `studio-write-lock.test.mjs:87-90` exige um caso por entrada: a scdelete acrescenta os casos.
- Antes do merge, as ferramentas novas das outras lanes simplesmente não travam (inerte).

**I5. Rotas de ferramenta.** Dono: scdelete (`catalog/tools.json`). Escreve as rotas de TODOS os nomes vivos da seção 5, com os modelos de argumento dali. As lanes produtoras não tocam `tools.json`.

**I6. Preparação de job de integração no `studio_deliver`.** Dono da função: restsoap. Chamador: extlib (`kernel-delivery.mjs`).

```js
// platforms/odc/facade/integration-documents.mjs (restsoap, NOVO)
export async function prepareIntegrationJob(jobFile, { lane /* 'o11'|'odc' */, words = '', localRoot, fetchImpl = globalThis.fetch } = {})
// -> { ok: true, job: string /* o próprio jobFile quando nada muda, senão a cópia fixada */, changed: boolean,
//      documents: [{ source, path, sha256, bytes }] }
// -> { ok: false, code, error, problems: Problem[], continuation? }   // nada capturado, nada enviado
```

- Chamada da extlib em `deliverKernel`, logo depois de ler o job (`kernel-delivery.mjs:423-425`) e antes do snapshot. `job` passa de `const` a `let`:

```js
const prepare = deps.prepareIntegrationJob ?? (await import('./integration-documents.mjs').catch(() => null))?.prepareIntegrationJob;
if (prepare) {
  const prepared = await prepare(job, { lane: 'odc', words: authorize ?? '', localRoot: path.join(root, '.local') });
  if (!prepared.ok) { refuse('documents', prepared); return report; }
  job = prepared.job;
}
```

- Sem o módulo (worktree da extlib), nada muda. Os testes injetam `deps.prepareIntegrationJob`.
- `o11-cycle.mjs` e `job-runner.mjs` (restsoap) chamam a mesma função com `lane: 'o11'`.

**I7. Campo `integration` das entregas.** Produtor: restsoap (kernel). Leitores: restsoap (`o11-cycle.mjs`, `responses.mjs`) e extlib (`kernel-delivery.mjs`).

```text
KI  data.integration : IntegrationReport[]      // no JSON da CLI (apply e deliver), ausente quando o job não tem op de integração
    IntegrationReport = { op: "rest"|"rest-expose"|"soap", client?: {name, key, created: boolean}, service?: {name, key, created: boolean},
                          imported: string[], skipped: string[], updated: string[], removed: string[],
                          consumersBroken: [{path, kind}], warnings: string[],
                          document?: {source, sha256}, selection?: {service, port, binding, soapVersion} }
```

- extlib: `interpretKernelResult` (`kernel-delivery.mjs:61-74`) acrescenta `...(Array.isArray(result.data?.integration) ? { integration: result.data.integration } : {})`, e o relatório do `deliverKernel` copia `integration` (no máximo 10, mais `integrationTotal`).
- restsoap: `responses.mjs:314` `DELIVERY_FIELDS` ganha `'integration'` e `'integrationTotal'`; o `o11_deliver` responde o mesmo campo.

**I8. Ids do catálogo C.** Ids novos, únicos no catálogo composto:
- xif: `integration.dotnet-extension-o11`;
- extlib: `integration.external-library-odc`, `reference.external-library-odc`;
- restsoap: `integration.soap` (passa de ausência a capacidade, com o mesmo id), `integration.soap-odc`, `integration.rest-import`.
- A restsoap remove de `integrations-without-route.json` as entradas `integration.soap` (`:79-96`) e `integration.external-libraries-odc` (`:157-176`).
- Fragmento da xif e da extlib: sem `elements[].platforms.<faixa>.native`, para não mudar a contabilidade (`accounting.json` continua batendo com `contabilidade-c.mjs --check`). `depends`/`recommends` só com ids que já existem na base (por exemplo `reference.producer-import`). Nenhum status `applicable` sem job de prova.
- Textos livres (`alternative`, `guidance`) podem citar ids de outra lane; campos que o `catalog-check` valida (`depends`, `recommends`, `alternatives`, `capability`) não.
- `tools.json` não usa `supersedesUnavailable` com ids que somem (`integration.soap`, `integration.external-libraries-odc`).

**I9. Forma comum do spec (xif e extlib).** As duas ferramentas recebem `spec` (objeto) ou `specFile` (JSON absoluto):

```text
spec = { name: Identificador, description?,
         structures?: [{ name, description?, attributes: [{ name, type, mandatory?, length?, decimals?, default?, description? }] }],
         actions: [{ name, description?, isFunction? /* só O11 */,
                     inputs?:  [{ name, type, mandatory?, default?, description? }],
                     outputs?: [{ name, type, description? }],
                     body: "<instruções C#>" }],
         // só xif: sources?, references?, resources?: [{path, file|text, deploy: Ignore|Binaries|Application|Images}], remove?
         // só extlib: namespace?, packages?: [{name, version}], usings?: string[] }
tipos: Text, Integer, LongInteger | "Long Integer", Decimal, Boolean, Date, DateTime | "Date Time", Time, Currency, Email,
       PhoneNumber | "Phone Number", BinaryData | "Binary Data", Object (só O11), "<Estrutura>", "<T> List"
       (O11: só "<Estrutura> List"; ODC: qualquer T)
corpo: usa os nomes declarados (D8); o xif aceita também ss<Nome>
```

- Exemplo xif (offline até a prova ao vivo): `{name:"ZZHybridXifLab", actions:[{name:"Add", inputs:[{name:"Left",type:"Integer"},{name:"Right",type:"Integer"}], outputs:[{name:"Result",type:"Integer"}], body:"Result = checked(Left + Right);"}]}`.
- Exemplo extlib: `{name:"SSAMTextTools", actions:[{name:"Reverse", inputs:[{name:"Text",type:"Text"}], outputs:[{name:"Result",type:"Text"}], body:"Result = new string(Text.Reverse().ToArray());"}]}`.

**I10. Linhas dos guias.** Dono: scdelete. Texto em inglês, como o resto dos guias:
- `guides/o11.md`:
  - "`o11_service_center_write {action:"delete", host, applications|modules|extensions|prefix, words}`: one call; checks consumers and the server's own simulation first; answers deleted/absent, or DELETE_REFUSED with every problem and its fix. module-delete, extension-delete and application-delete are the same call."
  - "`o11_extension {action:"read"|"publish"|"delete", host, extension, spec}`: a .NET extension without Integration Studio, built here and published through the Studio's session; read first to get the current spec; publish answers created/updated/already-running."
  - "Job ops `rest`, `rest-expose` and `soap` (O11 only) through o11_deliver; the contracts come from ssam_discover."
  - Em `o11_environment`, `delete-app` deixa de dizer "ZZ only" e passa a dizer que usa o mesmo motor.
- `guides/odc.md`:
  - "`odc_external_library {action:"build"|"deploy"|"status"|"discard", spec, authorize, operationUuid}`: generates, builds, uploads, publishes and tags an External Library in one call; references go through the existing reference job."
  - "`odc_asset_delete`: the words name the asset and every consumer."
  - "Job ops `rest` and `rest-expose` (and `rest` with `openapi`) through studio_deliver."

**I11. Cascata de consumidores de um produtor que não é aba.** Dono: xif (`o11-publish.mjs`).

```js
export async function publishConsumersOf({ producer /* {name, key, environment} */, words, authorization = null, message, timeoutSeconds },
                                        deps = {}) // -> { ok, consumers: [{module, outcome, code?}], code?, error?, continuation? }
```

- Mesma regra de `publishConsumers` (`o11-publish.mjs:272-305`): para no primeiro incerto, nada repetido.

---

## 5. Nomes vivos novos, rotas e falhas isoladas esperadas

`tools.json` tem um dono só (scdelete). `tool-routes.test.mjs` exige rota para todo nome vivo e nenhuma rota obsoleta (`:46-54`). As lanes produtoras anunciam aqui os nomes. A scdelete escreve exatamente estas rotas.

| Nome vivo | Tipo | Lane | Rota (escrita pela scdelete) |
|---|---|---|---|
| `o11_service_center_write.action = delete` | valor novo de enum | scdelete | verbo `delete`, `effect: write`. args `{action:"delete", host:"<env-host>", applications:["<App>"], words:"<user's words naming App and every consumer>"}`. next: "one call; answers deleted/absent or DELETE_REFUSED with problems[] and the fix; never prepare first" |
| `o11_service_center_write` campos `applications`, `modules`, `extensions` (string[]), `prefix`, `maxDeletes` | argumentos | scdelete | sem rota própria |
| `o11_service_center_write.prefixKind` (`application`/`module`/`extension`) | enum que não escolhe operação | scdelete | `nonVerbEnums` `{tool:"o11_service_center_write", path:"prefixKind"}` |
| `module-delete`, `extension-delete`, `application-delete` | verbos existentes | scdelete | `next` e `preconditions` passam a uma chamada (`tools.json:3135-3187`, `:3274-3299`) |
| `o11_environment.delete-app` | comportamento | scdelete | `when`/`preconditions` sem "ZZ only"; simulação e consumidores; palavras nomeiam a app e os consumidores (`tools.json:4869-4899`) |
| `o11_extension` | ferramenta nova; `action` enum `read`/`publish`/`delete` | xif | `lane:"o11"`, `group:"ambiente"`, `kind:"operations"`, `effect:"write"`, `verbParam:"action"`, `verbSelector:"enum"`. Verbos: `read` (`effect:read`, args `{action:"read", host:"<env-host>", extension:"<Extension>"}`); `publish` (`effect:write`, args `{action:"publish", host:"<env-host>", spec:{name:"<Extension>"}, words:"<user's words naming the extension>"}`); `delete` (`effect:write`, args `{action:"delete", host:"<env-host>", extension:"<Extension>", words:"<user's words naming the extension and every consumer>"}`). `nonVerbEnums` `{tool:"o11_extension", path:"spec.resources[].deploy"}`. `explains` com as palavras de action e estrutura, para o `modelGuard` não vetar "criar uma extensão com a action Somar" |
| `odc_external_library` | ferramenta nova; `action` enum `build`/`deploy`/`status`/`discard` | extlib | `lane:"odc"`, `group:"publicacao"`, `kind:"portal"`, `effect:"write"`. Verbos: `build` e `status` (`effect:read`), `deploy` e `discard` (`effect:write`). args de `deploy`: `{action:"deploy", spec:{name:"<Library>"}, authorize:"<user's words naming the library>", operationUuid:"<new uuid>"}`. `auth` já é coberto por `nonVerbEnums` `:auth` |
| `odc_portal_write` verbo documentado `externalLibraries.publishJob` | entrada nova de `PORTAL_WRITES` | extlib | verbo `selector:"documented"`, `value:"externalLibraries.publishJob"`, `effect:write` (`tool-routes.test.mjs:84` exige os verbos iguais a `PORTAL_WRITES`) |
| `odc_asset_delete` | comportamento | extlib | `preconditions`: palavras nomeiam o ativo e cada consumidor; sai "consider a deletion analysis first" |
| `o11_deliver`/`studio_deliver` campo de resposta `integration` | resposta | restsoap | nenhuma rota |
| Ops de job `rest`, `rest-expose`, `soap`; chave `breaks` no delete cru | contrato do kernel (`api --op`) | restsoap | nenhuma rota em `tools.json`; descoberta pelos fragmentos C |
| Capacidades da bridge O11 `integration_import:wsdl`, `integration_import:openapi`, `sc_api:integration-studio`; verbo `integration_import` | bridge | restsoap (I3) | — |
| Superfície `integration-studio` do `sc_api` | bridge | xif | — |
| Verbo `portal-upload`; capacidades `portal-upload` e `reference-snapshot:external-library` | bridge ODC | extlib | — |
| CLI `anvil xif check|read|build|diff`; `anvil-odc external-library build|contents|diff` | kernel | xif / extlib | — |

Esquemas de entrada que a scdelete confere nos modelos (as lanes produtoras mantêm estes nomes):

```text
o11_extension         required [action, host]; action, host, extension, spec, specFile, application, applicationKey, commitMessage,
                      consumers (boolean), expectedVersionId, words, operationId, confirmHost
                      annotations { readOnlyHint:false, destructiveHint:true, idempotentHint:false, openWorldHint:true }
odc_external_library  required [action]; action, spec, specFile, releaseTag, releaseNotes, library, jobKey, tenant,
                      auth (auto|studio|api-client), pid, authorize, operationUuid, confirmTenant
                      annotations { readOnlyHint:false, destructiveHint:true, idempotentHint:false, openWorldHint:true }
o11_service_center_write  campos novos: applications, modules, extensions (string[]), prefix, prefixKind, maxDeletes (1..100)
```

Nenhuma descrição de campo novo usa "Alone:" nem "Instead of job".

Códigos novos (referência rápida):
- scdelete: `DELETE_REFUSED`, `CONSUMERS_WOULD_BREAK`, `WORDS_MUST_NAME`, `DEPENDENCY_CHECK_UNAVAILABLE`, `SIMULATION_REFUSED`, `TARGET_NOT_FOUND`, `TARGET_AMBIGUOUS`, `DELETE_LIMIT_EXCEEDED`, `PROTECTED_TARGET`, `DELETE_UNCONFIRMED`, `CONFLICT`, `EXTENSION_VERSION_CHANGED`; estado `absent`, `planned`.
- xif: `XIF_SPEC_INVALID`, `EXTENSION_AMBIGUOUS`, `EXTENSION_NAME_TAKEN`, `EXTENSION_NOT_FOUND`, `BRIDGE_TOO_OLD`, `XIF_ENGINE_UNAVAILABLE`, `XIF_ENGINE_INCOMPATIBLE`, `XIF_ENGINE_FAILED`, `XIF_VERIFY_FAILED`, `XIF_STUBS_REFUSED`, `XIF_DEPENDENCY_OVERRIDE`, `XIF_COMPILE_FAILED`, `EXTENSION_BREAKS_CONSUMERS`, `EXTENSION_CONSUMERS_UNKNOWN`, `WORDS_REQUIRED`, `WORDS_MUST_NAME_TARGET`, `CONFIRM_HOST_REQUIRED`; estados `created`, `updated`, `already-running`, `uncertain`.
- extlib: `EXTERNAL_LIBRARY_SPEC_INVALID`, `EXTERNAL_LIBRARY_BUILD_FAILED`, `DOTNET_SDK_MISSING`, `NUGET_RESTORE_FAILED`, `PACKAGE_NOT_NET10`, `PACKAGE_TOO_LARGE`, `WORDS_MUST_NAME_LIBRARY`, `NAME_TAKEN_BY_OTHER_ASSET`, `GENERATION_PENDING`, `TAG_TAKEN`, `CONSUMERS_WOULD_BREAK`, `BRIDGE_UPGRADE_REQUIRED`, `GENERATION_FAILED`, `CONTENTS_DIFFER_FROM_PLAN`, `PUBLISH_FAILED`, `RELEASE_READBACK_FAILED` (e os reaproveitados `UNCERTAIN`, `PORTAL_CONTRACT_CHANGED`, `WEB_SIGN_IN_REQUIRED`, `CREDENTIAL_PROMPT_OPENED`).
- restsoap: os `REST_*`, `REST_EXPOSE_*`, `OPENAPI_*`, `DOCUMENT_SHA256_MISMATCH`, os de SOAP do levantamento (`WSDL_REQUIRED`, `UNSAFE_WSDL_XML`, `INVALID_WSDL_XML`, `INVALID_WSDL_ROOT`, `WSDL_HAS_NO_SOAP_PORTS`, `SERVICE_NOT_FOUND`, `PORT_NOT_FOUND`, `BINDING_NOT_FOUND`, `SOAP_VERSION_NOT_FOUND`, `SOAP_METHOD_NOT_FOUND`, `AMBIGUOUS_SOAP_PORT`, `SOAP_METHODS_REQUIRED`, `WSDL_TOO_LARGE`, `SOAP_CLIENT_PORT_MISMATCH`, `SOAP_CONTRACT_TYPE_MISMATCH`, `SOAP_LANE_UNSUPPORTED`), `INTEGRATION_IMPORT_NEEDS_BRIDGE`, `INTEGRATION_IMPORT_NEEDS_STUDIO`, `INTEGRATION_IMPORTER_NOT_FOUND`, `DELETE_HAS_CONSUMERS`, `CONSUMERS_CHANGED`; na fachada `INTEGRATION_DELETE_WORDS`, `DELETE_BREAKS_WORDS`, `INTEGRATION_DELETE_TARGET_FORM`, `REST_EXPOSE_CONTRACT_WORDS`, `UNSUPPORTED_DOCUMENT_SCHEME`, `DOCUMENT_TOO_LARGE`.

Falhas isoladas esperadas de `platforms/odc/facade/tests/tool-routes.test.mjs` em cada worktree (qualquer outra falha nele é regressão):

| Worktree | Teste | Falha esperada |
|---|---|---|
| scdelete | "tools.json routes every live tool..." | `stale route for tool(s) the server no longer lists`: `['o11_extension', 'odc_external_library']` |
| scdelete | "every arguments template fits the live schema..." | erro de tipo ao ler `inputSchema` de `o11_extension` e `odc_external_library` (rotas sem ferramenta viva) |
| xif | "tools.json routes every live tool..." | `missing route for live tool(s)`: `['o11_extension']` |
| extlib | "tools.json routes every live tool..." | `missing route for live tool(s)`: `['odc_external_library']` (o mesmo teste também acusaria `odc_portal_write` sem o verbo `externalLibraries.publishJob`) |
| restsoap | — | nenhuma |

- Os outros testes de `tool-routes` (efeito, segredo nos modelos, referências, oráculo) passam em todos os worktrees. A scdelete põe `effect` em cada verbo das rotas novas.
- Depois do merge das quatro lanes, `tool-routes` fica verde.
- `platforms/odc/tests/continuations.test.mjs` continua falhando só pela contagem de `MCP_TOOLS` (já falha na base).
- Uma lane que precise de outro nome vivo não listado não o cria neste pacote: registra em `notDone`.

---

## 6. Fora de escopo

- **Qualquer ação viva**: Studio, Service Center, Portal, tenant, upload, publish ou delete em ambiente. As provas ao vivo ficam para a sessão com o dono (seção 7).
- **Liberação**: subir versão da bridge ODC, overlay de liberação (`scripts/release/**`), troca da CLI no `SSAM-Hybrid-novo`, `ssam warm`.
- **Push**, em qualquer ramo.
- Regerar `catalog/ownership.json` e tirar a entrada velha `reference-import-headless` de `discovery-capabilities.json:744`: integrador.
- Atualizar o Python original do Service Center (`kernel/scripts/service_center/studio_api.py`, `kernel/tests/test_service_center_studio.py`): fica como divergência documentada.
- Caminho de páginas Factory (postback WebForms) do GitSSAM e o cofre de credenciais do GitSSAM (D1).
- Login PKCE do Integration Studio (`xifpub`) e o escritor de XIF nativo do kernel: depois de uma prova ao vivo.
- Extensão com entidades de banco externo, pilha Java, listas de primitivo em XIF.
- Migração XIF → ODC (`xif_migration*` do GitSSAM) e modo "source" de biblioteca externa.
- SOAP no ODC (fica `integration.soap-odc` indisponível), callbacks REST e fluxo de autenticação de REST exposto.
- Login Cognito usuário/senha do Portal ODC (D6).

---

## 7. Integração

1. **Ordem sugerida de merge:** scdelete → xif → extlib → restsoap. Os arquivos são disjuntos; a ordem só facilita a leitura.
2. **Funciona só depois do merge** (fica inerte em cada worktree isolado):
   - delete e flags novas do Service Center (scdelete) → `o11_extension` publish/delete (xif), por I1;
   - superfície `integration-studio` no cliente da bridge (scdelete) e capacidade em `Dispatch.cs` (restsoap) → leituras do Integration Studio (xif), por I2 e I3;
   - `prepareIntegrationJob` (restsoap) → `studio_deliver` (extlib), por I6;
   - `data.integration` (restsoap) → relatório ODC (extlib) → `compactDelivery` (restsoap), por I7;
   - rotas, trava e guias (scdelete) ↔ ferramentas novas (xif, extlib), por I4, I5 e I10;
   - remoção das ausências velhas (restsoap) ↔ capacidades novas (extlib), por I8.
3. **Depois do merge, o integrador:**
   - roda as suítes completas, em sequência e nunca a fachada junto de uma suíte de kernel: `Anvil.Tests`, `Anvil.Tests.Odc`, `Bridge.Tests`, a fachada inteira, o portal e `platforms/odc/tests`;
   - confere `tool-routes` verde e `catalog-check --front C` sem erro;
   - faz o merge de `consolidacao/main` (`a5d42bd6`, preview-local): conflitos só em `tools.json`, `ssam.mjs` e `docs/DESENVOLVIMENTO.md`;
   - roda `scripts/release/stage.mjs capture` e `check` (patches de `Dispatch.cs`, `ScProtocol.cs`, `Anvil.Bridge.csproj`, `Anvil.Cli/Program.cs`, `Anvil.Cli.Odc/Program.cs`, `NativeReferenceSnapshot.cs`, `Verbs.cs`, `CommandSurface.cs` e `JobRunner.cs` se mudou);
   - sobe a versão da bridge ODC uma vez (v38 → v39: a extlib mudou `StartupHook.cs`, `PortalCommands.cs` e `ReferenceCommands.cs`);
   - compila a bridge O11 e as CLIs com o `setup-dev`, inclusive `Anvil.Xif.Engine`;
   - tira a entrada velha `reference-import-headless` (`discovery-capabilities.json:744`) e regera `ownership.json` se o `catalog-check` pedir;
   - reconstrói o índice do discover.
4. **Provas ao vivo com o dono** (fora deste pacote; cada uma troca o exemplo offline do discover pelo recibo redigido):
   - scdelete: `DeleteApplication simulate:true` e `simulate:false` pelo Studio no `personal-2qqw9srv` numa app ZZ (forma de `affectedApplications`, segundos até sumir da listagem); `DeleteModule` eSpace e Extension; `GetConsumers` para chave de extensão; se a plataforma recusa apagar com consumidores; lote de 3 apps ZZ por prefixo.
   - xif: o `IntegrationStudio.asmx` aceitar o segredo SSO do Studio (`Handshake`, stubs, dependências, só leitura: a incógnita crítica); primeiro publish `ZZHybridXifLab.Add`; XIF salvo pelo motor sem `ActivationCode` aceito; consumidor com `captureProducers` devolvendo 42 para 19+23; `UploadNeeded` num rerun; delete da extensão ZZ.
   - extlib: token do Studio na API de bibliotecas (GET `/uploads`); PUT pré-assinado a partir da bridge; rota interna de publish pela janela do Portal; tag e releitura NET10; formato da assinatura de ExternalLibrary; import nativo e chamada em runtime; delete com consumidores.
   - restsoap: import SOAP com 2 métodos complexos, incremental e rerun sem mudança; `integration_import` numa cópia destacada; OpenAPI no O11 pela bridge e no ODC headless; REST consumido (ViaCEP) e exposto (GET 200, verbo errado 405, delete → 404); bridge antiga recusando antes de mudar.
