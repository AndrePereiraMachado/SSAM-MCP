# SSAM distribuível: contrato de runtime e de build

Dono: faixa A (contrato-de-runtime). Fonte das decisões: o plano de implementação da distribuição (`PLANO-IMPLEMENTACAO.md`, §2 e §7.2). Este documento é o contrato que as outras faixas seguem. Mudança aqui é pedido para a faixa A.

## 1. Dois modos, um código

- **Checkout**: o repositório, como hoje. Compila com `dotnet build`, usa `.ssam-workspace.json`, `.local\`, os clones de Studio do operacional. Nada disso muda.
- **Release**: uma pasta instalada em `%USERPROFILE%\.ssam-hybrid\releases\<versão>\`, sem fonte, sem SDK, sem build.
- O modo **nunca** vem de um arquivo nem de variável de ambiente:
  - JavaScript: `RELEASE` de `platforms/odc/facade/release-layout.mjs` vale `true` só quando o esbuild define `SSAM_RELEASE=true` no bundle (faixa O);
  - .NET: o define `SSAM_RELEASE` existe só no build de release (`-p:SsamRelease=true` na staging).
- `release.json` serve só para layout e versão. Apagar o arquivo não transforma um release em checkout e não desliga a licença.

## 2. Layout instalado

```
%USERPROFILE%\.ssam-hybrid\
  .ssam-hybrid-root            marcador (o setup recusa pasta sem ele)
  current.json                 {"release":"2026.10.1"}, troca atômica
  config.json                  portas, authorityDir, corporateHosts, odcFeaturesDir (seção 4)
  bin\node.exe, bin\launch.cjs lançador estável; inicia o node do release
  releases\<versão>\           imutável
    release.json, release.sig.jws, THIRD_PARTY_NOTICES.txt
    runtime\node\node.exe      Node do release (P17)
    runtime\dotnet\            só Microsoft.NETCore.App
    app\loader.cjs, app\*.jsc  fachada MCP em bytecode
    app\data\*.json            dados (catálogo, descoberta, receitas, model-api)
    bin\o11\, bin\odc\, bin\connect\, bin\builder\, bin\debug\, bin\prompt\, bin\sc\
    studio\o11\hook\Anvil.Hook.h1.dll, studio\o11\bridge\b1\, studio\odc\bridge\, studio\odc\client\
    proofs\o11|odc\<ideVersion>\*.result.json
  data\o11\, data\odc\         conexões, pedidos e recibos do hook, diário, snapshots, índices, fricção
  license\                     lease.jws, crl.jws, revoked.jws, state.json, installation.key, refusals.log
  workspace\.claude\           perfil de hooks opcional
  uninstall\<versão>\          desinstalador do Inno
```

Nunca `%LOCALAPPDATA%`: o app Claude é MSIX e vê um `%LOCALAPPDATA%` próprio. `%USERPROFILE%` é o mesmo para o controlador e para o processo do Studio.

## 3. Raízes e a regra do `USERPROFILE`

A API é a mesma em Node (`release-layout.mjs`) e em C# (`kernel/src/SSAM.Runtime/RuntimeContract.cs`, tipos `internal` no namespace `Ssam.Runtime`).

- **Regra das raízes**: o perfil é a variável `USERPROFILE`; só se ela faltar, `os.homedir()` (Node) ou `Environment.GetFolderPath(SpecialFolder.UserProfile)` (.NET). Motivo medido: no .NET a pasta conhecida ignora a variável. Assim um teste com `USERPROFILE` temporário nunca alcança o perfil real.

| O quê | Release | Checkout (valor de hoje) |
|---|---|---|
| raiz | pasta do release (`SSAM_RELEASE_ROOT`, senão `<node.exe>\..\..`; exige `release.json`) | raiz do repositório |
| perfil | `USERPROFILE`, senão a pasta da conta | igual |
| raiz do usuário | `<perfil>\.ssam-hybrid` | (não usa) |
| dados | `<perfil>\.ssam-hybrid\data` | `<repo>\.local` |
| dados por faixa | `data\o11`, `data\odc` | `kernel\.local` (ss4), `kernel\.local\lane-ss5`, `kernel\.local\lane-odc` |
| licença | `<perfil>\.ssam-hybrid\license` | (não usa) |
| configuração | `<perfil>\.ssam-hybrid\config.json` | (não lê) |
| autoridade | `config.json` `authorityDir`, senão `<perfil>\.anvil\authority` | `ANVIL_AUTHORITY_DIR`, senão `<perfil>\.anvil\authority` |
| dotnet | `<release>\runtime\dotnet\dotnet.exe` | `dotnet` do PATH |
| registro de conexão | `data\<o11\|odc>\connection.json` | `kernel\.local\connections\<ss4\|ss5>.json` |
| dados do kernel (`catalog\`, `docs\mapa\`, `catalog\recipes.json`) | `<release>\app\data`, achada pelo `release.json` acima da pasta do DLL (`JobSources.KernelRoot()` de T, `RepoRoot` das CLIs de W, saída de `compile-runtime-data.mjs` de U); fora de uma pasta de release não há raiz (`KernelRoot()` dá `null`, a CLI dá erro), nunca o diretório corrente | a pasta do `MANIFESTO.md` |

- Em release, `ANVIL_AUTHORITY_DIR` herdada é **ignorada**: nesta máquina o operacional tem a sua autoridade, e o release nunca pode falar com ela. A pasta vem do `config.json` ou do padrão.
- `layoutPath(checkoutRel, releaseRel)` substitui todo caminho que hoje sai de `import.meta.url`. `release-layout.mjs` é o único módulo que lê `import.meta.url` (regra da faixa X). Um caminho sem lugar no release passa `releaseRel = null` e dá erro em release.
- `workspace.mjs`: no checkout, igual a hoje (`.ssam-workspace.json`). Em release, `workspaceRoot` e `anvilRoot` são a pasta do release, e a faixa O11 é `o11Lane` do `release.json` (padrão `ss4`).

## 4. `config.json`

```json
{
  "ports": { "first": 4600, "last": 4619 },
  "authorityDir": "C:\\Users\\<pessoa>\\.ssam-hybrid\\authority",
  "corporateHosts": ["<host>"],
  "odcFeaturesDir": "C:\\Users\\<pessoa>\\AppData\\Local\\OutSystems\\ODC Studio"
}
```

- Sem `config.json`: portas 4516-4535, autoridade `<perfil>\.anvil\authority`, nenhum host corporativo e `Features.xml` em `<perfil>\AppData\Local\OutSystems\ODC Studio`.
- `ports`: exatamente 20 portas, dentro de 1024-65535. `authorityDir`: caminho absoluto. Valor inválido é erro, nunca um padrão silencioso.
- Nesta máquina (operacional presente), o `ssam_setup apply` (J) e o instalador (L) gravam 4600-4619 e `authorityDir = %USERPROFILE%\.ssam-hybrid\authority`.
- Todo campo é lido do arquivo pela regra do `USERPROFILE` (seção 3: `configFile()` no Node, `RuntimeContract.ConfigFile` no C#). `config.json` que não é JSON, ou que não é um objeto, é erro.

| Campo | Dono | Quem lê | Sem o campo | Valor errado |
|---|---|---|---|---|
| `ports` | A | todos (seção 5) | 4516-4535 | erro |
| `authorityDir` | A, F | fachada, CLIs, workers, bridge | `<perfil>\.anvil\authority` | relativo: erro |
| `corporateHosts` | V | bridge O11, a cada escrita do Service Center (`ScGuard.Corporate` de `kernel/src/Anvil.Bridge/ScProtocol.cs`; desde `servidor/fase3` também no checkout e na bridge fina; o overlay só troca o caminho por `RuntimeContract.ConfigFile`) | nenhum host é corporativo na bridge completa; na fina do pacote hospedado, todo host é corporativo | escrita recusada |
| `odcFeaturesDir` | E | kernel ODC (overlay de `kernel/src/Anvil.Core.Odc/Adapters.ODC/OdcFeatures.cs`, `OdcFeatures.CacheDirectory`) | `<perfil>\AppData\Local\OutSystems\ODC Studio` | relativo: erro |

- **`corporateHosts`** (faixa V): lista de nomes de host. Um nome vale também para os subdomínios dele; sem diferença de maiúsculas; espaço e ponto final são ignorados.
  - Sem `config.json` ou sem o campo: nenhum host é corporativo na bridge. A política de hosts da fachada continua valendo, como hoje para todo host que não é o do cliente.
  - `config.json` ilegível, ou campo fora do formato (não é lista de textos): a escrita é recusada com `NOT_ALLOWED` e nada é enviado.
  - O código de release não tem nenhum host de cliente embutido. J (setup) e Q (hosts de Service Center no release) gravam ou usam este mesmo campo.
- **`odcFeaturesDir`** (faixa E): caminho absoluto da pasta que tem o `Features.xml` do ODC Studio (e o `FeaturesOverride.xml`, se houver).
  - Sem o campo, ou texto vazio: `<perfil>\AppData\Local\OutSystems\ODC Studio`, com o perfil pela regra do `USERPROFILE`. Nunca a variável `LOCALAPPDATA` nem `GetFolderPath(LocalApplicationData)`: sob o MSIX do app Claude o `%LOCALAPPDATA%` do processo é outro.
  - Caminho relativo: erro `config.json odcFeaturesDir must be an absolute path`. A mensagem de `Features.xml` ausente aponta para `odcFeaturesDir`.
  - Em release, `ANVIL_ODC_FEATURES_DIR` não é lida (como `ANVIL_AUTHORITY_DIR`).
- Valor que não é texto em `authorityDir` ou `odcFeaturesDir`: hoje o C# o ignora (usa o padrão) e o Node recusa (`authorityDir`). A regra deste contrato é erro; alinhar o C# é pendência das faixas A (`RuntimeContract.cs`) e E (overlay).
- Outros campos (tenant padrão, hosts de Service Center) são das faixas J e Q; registre-os aqui por pedido à faixa A.

## 5. Portas e ambiente dos filhos

- 20 portas: a primeira metade é de bridges O11 (`bridges[0..9]`), a segunda de workers (`workers[0..9]`).
- Porta da bridge O11: em release, a do registro de conexão; sem registro, `bridges[0]`. No checkout, `ANVIL_BRIDGE_PORT`, senão 4536 na faixa ss5 e 4516 nas outras.
- A bridge ODC usa pipe nomeado, não porta.
- Portas dos workers (faixa W): sem `--port`, `anvil serve` escuta em `workers[0]` e `anvil-odc serve` em `workers[1]` (padrão 4526 e 4527; nesta máquina, com 4600-4619, 4610 e 4611). Em release, o `WorkerServer` só escuta na porta 0 (efêmera, a do `read-serve`) ou numa porta de `workers` do contrato (`WorkerServer.ContractPort`); outra porta é recusada antes de escutar.
- Porta da bridge nas CLIs de release: `--bridge-port`/`--port`, senão `RuntimeContract.BridgePort()`. `ANVIL_LANE=ss5` não muda porta nem pasta em release: o release tem uma faixa O11 (`data\o11`).
- `childEnv(base)` (Node) e `RuntimeContract.ChildEnvironment()` (C#) exportam a todo filho, em release:
  `ANVIL_BRIDGE_PORT`, `ANVIL_AUTHORITY_DIR`, `USERPROFILE`, `SSAM_HYBRID_HOME`, `SSAM_DATA_DIR`, `DOTNET_ROOT`.
  No checkout, `childEnv` devolve uma cópia de `base`, sem mudança.
- Um componente .NET filho lê `ANVIL_BRIDGE_PORT` primeiro (`RuntimeContract.BridgePort()`). As raízes ele recalcula do `USERPROFILE` e do `config.json`; `SSAM_HYBRID_HOME` e `SSAM_DATA_DIR` são informativas.
- A fachada Node não lê `ANVIL_BRIDGE_PORT` em release: ela é quem exporta.

### 5.1 CLIs e workers em release (faixa W)

- Pastas: a faixa O11 usa `data\o11` (`reading`, `work`, `access`, `data` do `anvil data`, log do worker); a ODC usa `data\odc`. Nunca `.local`.
- Dados do kernel: `<release>\app\data` (seção 3).
- dotnet de um filho (`access apply`): `<release>\runtime\dotnet\dotnet.exe` (`RuntimeContract.DotnetPath`), nunca o `dotnet` do PATH.
- Credencial: as CLIs de release não leem arquivo de credencial. Uma opção `--…credentials` é recusada antes de qualquer comando. A sessão O11 é o login do Studio; a credencial privada de um host vem do cofre (`SSAM/O11/<host>/ServiceStudio`, seção 11).
- Licença: sem lease, a CLI responde uma linha `{"ok":false,"executed":false,"code":"license_<estado>",…}` com saída 3; um worker responde `executed:false` por pedido (o portão vem depois da autorização; `ping` e `shutdown` passam). No `anvil-odc`, a saída 3 também pode ser transporte da bridge (`transport:true`): leia o `code`.

## 6. Registro de conexão

- Arquivo: `data\o11\connection.json` (release) ou `kernel\.local\connections\<ss4|ss5>.json` (checkout).
- Campos (os de hoje, `studio-connect.mjs`): `ok`, `lane: "o11"`, `anvilLane`, `pid`, `startedUtc`, `studioDir`, `studioVersion`, `authorityDir`, `port`. Em release, D acrescenta `bridgeId`.
- Quem grava: a fachada no connect (D). Quem lê: a fachada (Node), as CLIs e workers (.NET, faixas T e W), o localizador (campo `studioDir`).

## 7. Pedido e recibo do hook O11

- **Checkout**: o hook lê `<hook>.json` ao lado da DLL (`StartupHook.cs:39`), como hoje. Nada muda.
- **Release**: nada é escrito ao lado de DLL nenhuma.
  - pasta: `data\o11\runtime-connect\<pid>-<início>` (`hookExchangeDir(pid, startedUtcMs)` no Node; `RuntimeContract.HookExchangeDir(pid, startedUtcMs)` no C#), com `<início>` = hora de início do processo em milissegundos Unix UTC (`Date.parse(startedUtc)` no Node; `RuntimeContract.StartedUtcMs(process.StartTime)` no C#);
  - pedido: `request-<bridgeId>.json` com `{pid, startedUtc, bridgeId, bridgeDir, port, dataDir, authorityDir}`;
  - recibo: `receipt-<bridgeId>.json` com `{ok, pid, bridgeId, port, at, error?}`;
  - canal de controle por processo: pipe `SSAM-Hook-h1-<pid>` (o pedido de uma bridge nova vai pelo pipe, sem reaplicar o hook).
- B (hook) lê e grava nos dois locais; D (fachada) grava no novo local só atrás de `RELEASE` e lê dos dois.

### 7.1 Protocolo do hook `h1` em release (faixa B)

O que o hook `Anvil.Hook.h1` faz com o pedido (overlays de B em `kernel/tools/Anvil.RuntimeHook`). Os campos do pedido e do recibo são os de cima.

- **Pedido conferido**: o `pid` e o `startedUtc` são deste processo; `bridgeId` = `b<número>` (`^b[1-9][0-9]{0,3}$`); porta válida; `dataDir` e `authorityDir` absolutos; `bridgeDir` = `<release>\studio\o11\bridge\<bridgeId>`, com `<release>` a pasta que tem `release.json` acima dela. Outro lugar é recusado.
- **Manifesto antes de carregar**: o hook abre só para leitura **todo** arquivo da pasta da bridge (com subpastas) e chama `Ssam.Lic.Release.Require(<release>, <todos esses caminhos>)` (faixa M). Arquivo mudado, a mais ou fora do manifesto: recibo `ok:false` com `manifest_mismatch:<caminho>`, `manifest_unlisted:<caminho>` ou `manifest_signature`. Os arquivos ficam abertos (sem escrita, sem apagar) enquanto o Studio vive: o que foi conferido é o que carrega.
- **Carga**: um `AssemblyLoadContext` por bridge (`SSAM-<bridgeId>`): nome que existe na pasta da bridge vem dela; o resto vem do Studio. Depois, `Anvil.Bridge.Server.Start(porta, dataDir, authorityDir)`.
- **Recibo `ok:true`** só quando a bridge responde `bridge_manifest` na porta com o `pid` do Studio e o seu `bridgeId` (espera até 15 s). Senão `ok:false` com o motivo e o caminho do log `<dataDir>\bridge-<porta>.log`. Um `bridgeId` que falhou depois de carregar fica falho naquele processo: use outro id ou reinicie o Studio.
- **Primeira aplicação**: o hook processa os `request-*.json` sem recibo que já estão na pasta de troca. Depois, só pelo canal.
- **Canal de controle** `\\.\pipe\SSAM-Hook-h1-<pid>`: só o usuário atual, primeira instância, um cliente por vez; uma linha JSON de até 64 KB; o cliente tem 10 s para mandar a linha.
  - `{"op":"load","bridgeId":"b2"}` → lê `request-b2.json` da pasta de troca e responde o recibo (o mesmo que grava em `receipt-b2.json`). O mesmo pedido de novo responde sem recarregar.
  - `{"op":"status"}` → `{ok, pid, hookAbi:"h1", initializeCalls, bridges:[{bridgeId, port, bridgeDir, error}]}`.
  - outro `op`: `{ok:false, error}`.
- **Falha fora de um pedido**: uma linha em `hook-errors.log` na pasta de troca. Nada ao lado de DLL nenhuma; o hook não muda variável de ambiente.
- **Bridge de release**:
  - `bridge_manifest` ganhou `pid`, `bridgeId` (nome da pasta; `null` fora de um release), `hookAbi`, `ideVersion`, `retired`;
  - verbos novos: `selftest` (o que está `available` e `unavailable`, com motivo), `retire` (fecha a porta; pedido que ainda chega responde "não executado"), `wait {condition:"no-dialogs", timeout_ms?}`, `dismiss_dialog {title}`, `web_dialogs` (só leitura; nunca clica);
  - log em `<dataDir>\bridge-<porta>.log`, nunca no LocalAppData. `Start(int)` em release usa `data\o11` e a autoridade do contrato.

## 8. `release.json` e `release.sig.jws`

- Schema: `docs/schemas/ssam-release-1.schema.json` (`ssam-release/1`): `schema`, `version`, `builtAt`, `sourceCommit`, `distributable`, `o11Lane` (opcional), `runtimes {node, dotnet}`, `baseline {o11, odc}`, `supported {o11.min, odc.min}`, `bridges {o11 {id, hook, protocolVersion, surface}, odc {id, surface}}`, `kernelSha256 {o11, odc}`, `obfuscated` (opcional), `files [{path, size, sha256, authenticode?}]`.
- Caminhos sempre relativos, com `/`. Nenhum arquivo `OutSystems.*`, `ServiceStudio*`, `StudioToolkit*` ou `Identity.*`.
- `version` é a mesma constante embutida em todo binário .NET (`Ssam.Lic.Build.Release`). Os portões comparam a constante com `minRelease` do lease e da CRL; **nunca** leem `release.json`.
- `distributable: false` quando o build usou as raízes de teste. O gêmeo de teste (`SSAM_LICENSE_TEST`) nunca é empacotado.
- `release.sig.jws` (faixa M): payload `{typ: "ssam-release/1", iat, version, files: [{path, size, sha256}]}`, assinado pelo intermediário `release`. Conferem: o hook `h1` (só os arquivos da bridge, antes de carregar), o `ssam_update install` e o `ssam_doctor`.

## 9. Localizador de Studio

`studio-locate.mjs` (`locateStudio(kind, deps)`) e `StudioLocator.Locate(kind, probe)`. Ordem fixa, vence a primeira pasta válida:

1. variável: `ANVIL_STUDIO_DIR` (O11) ou `ANVIL_ODC_STUDIO_DIR` (ODC);
2. `studioDir` do registro de conexão;
3. pasta de um `ServiceStudio.exe` / `ODCStudio.exe` em execução;
4. `HKLM\...\Uninstall\OutSystems Service Studio 11` (ou `OutSystems ODC Studio`), `InstallLocation` mais `Service Studio` (ou `ODC Studio`), vista 64 e depois 32;
5. o mesmo em `HKCU`;
6. `%ProgramFiles%\OutSystems\Service Studio 11\Service Studio` (ou `...\ODC Studio\ODC Studio`).

Pasta válida: tem `ServiceStudio.Framework.dll` (O11) ou `OutSystems.Model.dll` (ODC). Toda fonte é injetável nos testes. O lister de processo padrão do Node usa a mesma consulta CIM de `lanes.mjs`; código de release pode injetar outro.

No kernel de release (faixa E), os padrões `StudioAssemblies.DefaultDirectory` (O11) e `StudioAssembliesOdc.DefaultDirectory` (ODC) usam `StudioLocator.Locate`, nunca o clone do operacional. O localizador roda só no primeiro `Bind` sem pasta; depois, um `Bind()` sem pasta mantém a pasta ligada, e só uma pasta explícita diferente dá `already bound`. A versão do IDE é a versão de arquivo do `ServiceStudio.Framework.dll`; sem versão é erro.

## 10. Build de release sem mudar o checkout

### 10.1 Regras

- **R1. Checkout intocado.** Nenhum `.cs`, `.csproj`, `.props` ou `.targets` existente fora de `kernel/tests/**` muda. Também não entra `.cs` novo dentro da pasta de um projeto existente (o glob do SDK o compilaria) nem sob um `Compile Include` com curinga de um projeto existente, nem `Directory.Build.*`, `Directory.Packages.props`, `global.json` ou `NuGet.config` novo acima de um projeto existente. Conferido por `platforms/odc/tests/checkout-guard.test.mjs`.
- **R2. JS por constante de bundle.** `.mjs` existente muda no lugar, com o novo comportamento atrás de `RELEASE`. Os testes existentes provam o checkout.
  - **Texto que tem de sumir do bytecode** (nome de cliente, texto só de checkout): o `RELEASE` importado **não basta**. O esbuild dobra o define `SSAM_RELEASE` só na expressão que o lê; um `RELEASE` importado de outro módulo (ou um `const` local) vira `var X=!0; … X ? a : b`, e os dois textos ficam no `.jsc`. Medido pela faixa V com o `esbuild-wasm` 0.25.10 fixado, `define SSAM_RELEASE=true` e `minify`. Nesse caso, escreva o teste **no próprio ponto**, com `/* global SSAM_RELEASE */` no arquivo:
    ```js
    typeof SSAM_RELEASE !== 'undefined' && SSAM_RELEASE === true ? '<texto de release>' : '<texto de checkout>'
    ```
    Exemplo: `platforms/odc/portal/runtime/cognito-login.mjs` (faixa V). No checkout `SSAM_RELEASE` não existe, então o texto é o de hoje.
  - Para **comportamento** (caminhos, portas, ramos de código), o `RELEASE` importado de `release-layout.mjs` continua valendo: os dois ramos podem ficar no bytecode.
  - A varredura `scripts/release/scan-client-content.mjs` (faixa V) reprova o release se um nome de `client-content.json` sobrar em qualquer arquivo, `.jsc` inclusive.
- **R3. Identidade.** `scripts/release/checkout-identity.mjs`: sha256 igual em todo DLL dos projetos de produto, base contra HEAD (seção 10.4).
- **R4. Edição de overlay.** `stage.mjs edit` e `capture` (seção 10.3).
- **R5. `-p:SsamRelease=true` fora da staging.**
  - No checkout ele **não tem efeito**: a linha `Import` que liga o modo release só existe na staging (overlay de `kernel/Directory.Build.targets`). O build é o build normal do checkout, sem `SSAM_RELEASE` e sem nenhum arquivo de release. Não há como sair um binário de release do checkout.
  - Quando `scripts/release/msbuild/SsamRelease.targets` é alcançado fora de uma staging (pelo recuo `-p:CustomAfterMicrosoftCommonTargets=<SsamRelease.targets>`, ou numa cópia sem o marcador), o build **recusa**: falta `.ssam-stage.json` na raiz.
  - Depois que a faixa M entregar, `SSAM.License.targets` recusa também sem `.ssam-woven.json` e sem os arquivos gerados.

### 10.2 Staging e overlays

- `scripts/release/overlay/<caminho>.patch`: patch unificado (`git diff --full-index`) de um arquivo existente. `stage.mjs` confere o blob de origem antes e o blob de destino depois; se o arquivo mudou na base, o overlay está velho e o build falha.
- `scripts/release/overlay/<caminho>` (sem `.patch`): arquivo novo, copiado para `<caminho>`; recusa se o alvo existir.
- O dono do overlay é o dono do arquivo-alvo (`scripts/release/owners.json`).
- `node scripts/release/stage.mjs make --out <pasta> [--rev <commit> | --from-worktree] [--version <v>] [--twin] [--roots <roots.pub.json>]`:
  1. `git archive` (ou cópia do worktree);
  2. overlays;
  3. licença (faixa M), só se existirem `scripts/release/license/weave-spec.json` e `generate.mjs`: compila e roda o tecelão, depois `generate.mjs` (raízes e versão; `--twin` para o gêmeo de teste);
  4. grava `.ssam-stage.json` por último (`schema`, `rev`, `source`, `dirty`, `version`, `twin`, `license`, `overlays`, `createdUtc`).
- `node scripts/release/stage.mjs check [--rev <commit> | --from-worktree]`: todo overlay aplica, sem escrever nada.
- Compilar na staging: `dotnet build -nr:false <staging>\<projeto> -p:SsamRelease=true -p:SSDir=<Service Studio>`.
- `SsamRelease.targets` define `SSAM_RELEASE` e importa, se existirem: `kernel/src/SSAM.License/SSAM.License.targets` (M), `parts/Runtime.targets` (A), `parts/BuilderFeatures.targets` (V), `parts/Determinism.targets` (K).
- `parts/Runtime.targets` liga `kernel/src/SSAM.Runtime/*.cs` em todo projeto C# do build de release (cópia `internal` em cada assembly). Saída: `-p:SsamRuntime=false`.

### 10.3 Editar um overlay (R4)

1. `node scripts/release/stage.mjs edit --lane <X> --out <pasta> [--rev <commit> | --from-worktree]`: staging que é um repositório git descartável, com o commit `pristine` (a revisão como é) e o commit `overlays`. Sem passo de licença.
2. Edite ali como num código normal. Um build comum funciona; para compilar com a licença, capture e rode `make`.
3. `node scripts/release/stage.mjs capture --lane <X> --from <pasta>`: deixa os overlays da faixa X iguais à staging. Arquivo `OV` vira `<caminho>.patch`; arquivo `OV+` é copiado; overlay de arquivo que voltou ao original é apagado. Arquivos de outra faixa, arquivos da faixa que não são overlay e arquivos sem dono só aparecem na lista da resposta (`otherLanes`, `notOverlay`, `unowned`); nada é escrito para eles.

### 10.4 Identidade do checkout

```
node scripts/release/checkout-identity.mjs [--lane <X>] [--base <rev>] [--rev <rev> | --from-worktree] [--ssdir <pasta>] [--odc <pasta>] [--no-cache]
```

- Compila a base (`git merge-base HEAD integracao/distribuicao-base`, ou `--base`) e o HEAD (ou o worktree) na mesma pasta `_dist\identity\<faixa>\src`, build padrão (`Release`, PDB portátil), mesmos `SSDir` e `OdcInstall`.
- Compara o sha256 de todo DLL em `bin\` dos 17 projetos de produto da base (todo `.csproj` fora de `kernel/tests/**`, `kernel/debug/tests-*`, `platforms/odc/studio/bridge/tests`, `kernel/scripts/probes`).
- `SSDir` padrão: `_dist\ref\ServiceStudio-11.55.87` se existir, senão o Service Studio instalado. `OdcInstall`: o ODC Studio instalado. Os dois só são lidos.
- Perfil temporário em `_dist\tmp\<faixa>\identity-profile`, NuGet em `_dist\cache\nuget`, `-nr:false`.
- O resultado da base fica em cache em `_dist\cache\identity\` (chave: base, pasta, pastas dos Studios e o sha256 de `ServiceStudio.Framework.dll` e `OutSystems.Model.dll`, versão do SDK, configuração, lista de projetos).
- Tempo medido (faixa A): primeira vez cerca de 60 s (base 34 s + HEAD 26 s); depois, com cache, cerca de 30 s.

### 10.5 Testes

- Node, por faixa: `node --test platforms/odc/tests/<arquivo>.test.mjs`. `npm test` coleta `platforms/odc/tests`.
- Testes C# de release: `kernel/tests/SSAM.Release.Tests` compila e roda **só no gêmeo de teste** (P18):
  ```
  node scripts/release/stage.mjs make --out <staging> [--rev <commit> | --from-worktree] --twin
  dotnet test <staging>\kernel\tests\SSAM.Release.Tests -p:SsamRelease=true -p:SsamLicenseTest=true -p:SSDir=<Studio> --filter "FullyQualifiedName~SSAM.Release.Tests.<Faixa>."
  ```
  - por quê: com a licença da faixa M na staging (`kernel/src/SSAM.License/SSAM.License.targets`), o `Anvil.Core`, o `Anvil.Core.Odc` e o `Anvil.Authoring` ganham o portão de módulo. No binário real ele recusa o `testhost` do `dotnet test` (`license_not_activated`); só o gêmeo (`SSAM_LICENSE_TEST`) se afasta para ele;
  - recusas: fora da staging ou sem `-p:SsamRelease=true`, o alvo `SsamReleaseTestsNeedStaging`; com a licença de M e sem `-p:SsamLicenseTest=true`, o alvo `SsamReleaseTestsNeedTwin`; staging feita sem `--twin`, o `#error` do `generated\Roots.g.cs` (faixa M);
  - uma pasta por faixa (`A`, `B`, `E`, `F`, `T`, `U`, `W`), namespace `SSAM.Release.Tests.<Faixa>`;
  - referencia todos os projetos de produto; `Anvil.Core`, `Anvil.Bridge`, `Anvil.CSharp` e `Anvil.Authoring` no alias global; os outros com `extern alias`: `odccore`, `anvilcli`, `anvilcliodc`, `connect`, `inject`, `runtimehook`, `startuphook`, `odcbridge`, `odcclient`, `odcbuilder`, `odcapiindex`; os dois depuradores são compilados, não referenciados;
  - quem mexe em variável de ambiente usa `[Collection(EnvironmentCollection.Name)]` e `TempProfile` (`A/TestEnvironment.cs`).
- Ambiente de todo teste e build: `USERPROFILE`, `HOME`, `APPDATA`, `LOCALAPPDATA`, `ANVIL_AUTHORITY_DIR` e `DOTNET_CLI_HOME` temporários; `DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1`, `DOTNET_GENERATE_ASPNET_CERTIFICATE=false`, `DOTNET_NOLOGO=1`; portas só efêmeras.
- `node scripts/release/profile-guard.mjs snapshot --out <arquivo>` antes e `check --in <arquivo>` depois, com o perfil real: acha o perfil real mesmo com as variáveis trocadas; falha se mudar `.ssam-hybrid`, `mcpServers` do Claude, `bridge.key`, `HKCU\Software\SSAM-Hybrid`, `ANVIL_*`/`SSAM_*` de `HKCU\Environment`, desinstalação com "SSAM", ou se um arquivo de `.anvil`/`.ssam` ganhar caminho deste trabalho; avisa o resto.

### 10.6 Donos de arquivo

`scripts/release/owners.json` (`ssam-owners/1`): lista `files[]` com `path`, `lane`, `type` (`OV`, `OV+`, `JS`, `NOVO`, `RES`, `EDIT`) e, quando cabe, `overlay` e `target`; caminho terminado em `/` vale para a pasta inteira. `platforms/odc/tests/owners.test.mjs` confere: nenhum caminho em duas faixas; existentes existem na base; novos não; `RES` e `OV` não mudam no lugar; todo overlay tem dono; **todo arquivo mudado desde a base tem dono**. Arquivo novo fora da lista é pedido à faixa A (`_dist\inbox\A\`).

### 10.7 Dependências JS do publicador

- Só em `scripts/release/package.json` (dono A, por pedido), nunca em `platforms/odc/package.json`. Hoje: `esbuild-wasm` 0.25.10 e `@modelcontextprotocol/client` 2.0.0.
- `scripts/release/pnpm-lock.yaml`: feito pelo pnpm fixado em `scripts/release/runtimes.lock.json` (`tools.pnpm`, 11.28.2, `node <pasta>\package\bin\pnpm.cjs`), `lockfileVersion: '9.0'`. O `integrity` do `esbuild-wasm` no lock é o mesmo do `runtimes.lock.json`.
- Instalação (fora do repositório, com perfil temporário: `USERPROFILE`, `HOME`, `APPDATA`, `LOCALAPPDATA`, `PNPM_HOME`): uma pasta com o `package.json` e o `pnpm-lock.yaml`, e nela
  `node pnpm.cjs install --frozen-lockfile --ignore-scripts --store-dir <cache>\pnpm-store --cache-dir <cache>\pnpm-cache --config.node-linker=hoisted`.
  No `_dist`, a pasta é `_dist\cache\deps\release-<12 primeiros hex do id de blob git do lock>` (a mesma regra de `odc-<…>`; `git hash-object scripts/release/pnpm-lock.yaml`).
- A API JS do `esbuild-wasm` abre um processo `node` pelo `PATH`: ponha a pasta do `node.exe` no `PATH` de quem a chama.
- Lock novo: mude o `package.json`, gere o lock com o mesmo pnpm numa pasta fora do repositório (sem `--frozen-lockfile`) e copie só o `pnpm-lock.yaml`.

## 11. Nomes de alvo do cofre

O Gerenciador de Credenciais do Windows guarda credenciais genéricas com os mesmos nomes de hoje. Só `SSAM.Prompt` (M) grava; o resto só lê.

| Alvo | Quem usa |
|---|---|
| `SSAM/O11/<host>/ServiceStudio` | sessão O11 headless e depurador O11 |
| `SSAM/O11/<host>/ServiceCenter`, `SSAM/O11/<host>/LifeTime` | Service Center e LifeTime (porte .NET, Q) |
| `SSAM/O11/<host>/SiteProperty/<nome>`, `SSAM/O11/<host>/DatabaseConnection/<nome>` | `secretRefs` do Service Center (bridge O11, `ScVault.cs`) |
| `SSAM/ODC3/<host>/APIClient` | token do API Client ODC (D-DONOS-2) |
| `SSAM/ODC3/<host>/Portal` | portal ODC |
| `SSAM/ODC3/<host>/Setting/<nome>`, `SSAM/ODC3/<host>/DB/<nome>` | `secretRefs` do portal ODC (bridge ODC, `PortalVault.cs`) |

Em release, nenhuma CLI lê arquivo de credencial (seção 5.1).

## 12. Exceção D-DONOS-2

O token do API Client ODC continua passando pelo Node: o `SSAM.Prompt` lê o segredo do cofre, sem `pwsh`, e a fachada faz a chamada REST. O token fica no máximo 10 minutos em memória (D-PLANO-8), para a revogação valer no prazo de 1 hora. A alternativa (um relé .NET que faz a chamada REST) fica registrada e não foi feita.

## 13. Limites honestos

1. A ofuscação renomeia tipos e métodos internos, mas não esconde a lógica: corpos e strings decompilam legíveis. O bytecode V8 tira o texto do código e mantém strings e nomes. Catálogo e descoberta vão em JSON legível.
2. O desligamento remoto não é instantâneo e não recolhe o que já foi entregue:
   - quem coopera para em até 1 hora; quem bloqueia a rede, mata a fachada ou apaga `crl.jws`, lápide ou estado usa até `exp + carência` (10 dias com os padrões, 37 com o lease de publicador);
   - revogar não apaga binários, catálogos, provas nem o que a pessoa já gerou;
   - cópias anteriores à licença (pacotes r3/r5, `ssam package`, checkouts e builds de checkout) não podem ser desligadas;
   - quem edita o IL remove os portões ou troca as raízes; um host estranho renomeado como Studio passa pelo portão de módulo;
   - restaurar estado, registro e lease juntos com o relógio congelado mantém o uso offline;
   - clone de VM sem sysprep só é detectado depois, pela cadeia de `seq`;
   - ferramentas só de conhecimento em JS têm portão só na fachada;
   - se a máquina do publicador for comprometida, quem a controla emite e revoga até a rotação pela raiz;
   - bridge ODC: janela entre a conferência do manifesto pelo cliente e a carga pelo runtime.
3. A checagem estática de compatibilidade não vê mudança de comportamento com a mesma assinatura; por isso há `selftest` e provas por versão.
4. Sem certificado de assinatura, o Smart App Control pode bloquear as nossas DLLs e o instalador.
5. Sob MSIX, HKCU, AppData e DPAPI nos filhos do app Claude só a prova viva confirma.
6. Passos fora do MCP, de propósito: rodar o instalador; reconectar o cliente depois de instalar ou atualizar; digitar o código de ativação e credenciais na janela privada; desinstalar por "Aplicativos instalados"; publicar no O11; responder no Studio um diálogo web que a bridge não lê; trazer o zip de update; criar conta O11. No publicador: gerar o release e o instalador.
7. Checkout: o byte a byte vale para os DLLs. Os `.mjs` editados mudam de bytes; o comportamento é protegido pelos testes existentes.

## 14. Conector (`Anvil.Connect`, faixa C)

Quem usa: D (connect), G (ODC), H (depurador), J (`ssam_doctor`, update) e K (build e provas). Sempre `dotnet Anvil.Connect.dll <comando>`; em release, com o `runtime\dotnet`.

- Comandos: `describe <pid>`, `describe --studio <pasta>`, `attach`, `check`, `probes`, `surface`, `verify`. Nenhum verbo de licença (P4). O portão do tecelão de M (`o11-connect-attach`) fica antes do attach (P5); a recusa é `{"ok":false,"error":"license_<estado>: …"}`, saída 1.
- **`describe <pid>`**: aceita `ServiceStudio.exe` e `ODCStudio.exe` de qualquer pasta; decide pela imagem e pelos arquivos-marca, nunca pela pasta; exige coreclr 8+. JSON `{ok, kind:"o11"|"odc", pid, path, studioDir, startedUtc, startedUtcMs, version, ideVersion, runtime, bridgePath, corePath, loaded[], diagnosticsAvailable}`. `startedUtcMs` = `RuntimeContract.StartedUtcMs` (seção 7). `ideVersion`: O11, versão do `ServiceStudio.Framework.dll`; ODC, versão do `ODCStudio.exe`.
- **`describe --studio <pasta>`**: só metadados. JSON `{ok, kind, studioDir, path, version, productVersion, ideVersion, marker, runtime{selfContained, frameworks[]}, deps{file, patched}, legacy[]}`; `legacy` lista o que uma injeção de checkout deixou (`Anvil.*`, `ODC3.*`, `Esprima.dll`, `*.pristine.bak`, `*.before-anvil`).
- **`attach <pid> <startedUtc> <hook.dll> [--check <surface.json>] [--cache <pasta>]`**: só Service Studio (o ODC é anexado pelo cliente de G). Ordem: imagem e marcas, `startedUtc` igual, hook existe, `check` do `surface.json` contra a pasta do processo, portão de licença, `ApplyStartupHookAsync`. Check com FAIL: `{ok:false, code:"incompatible_studio", error, ideVersion, fails[], check}`, saída 1, nada chega ao Studio. Sucesso: `{"ok":true,"hookRequested":true}`.
- **`check (--ours <dll|pasta>… | --surface <surface.json>) --studio <pasta> [--host <modo>] [--runtime <pasta>]… [--ship <pasta>]… [--baseline <pasta>] [--deps <arquivo>] [--resolve <nome>]… [--cache <pasta>] [--json <arquivo>|-] [--no-info]`**: saída 0 sem FAIL, 1 com FAIL, 2 uso errado. Modos:
  - `studio-alc`: bridge O11 no contexto por bridge do hook de B (pasta da bridge, depois o TPA do Studio com a regra de versão). Padrão sem `--host` e sem `--surface`;
  - `studio-tpa-resolver`: bridge ODC com o resolver limitado (`--resolve`);
  - `runtime`: CLIs, builder e depurador (sem `--runtime`, o runtime em que o conector roda);
  - `studio`: attach de checkout; é o modo dos resultados medidos.
  - Arquivo do Studio ilegível que uma referência alcança é FAIL `assembly-unreadable`; arquivo nosso ilegível é erro do comando.
- **`probes --probes <arquivo> --studio <rótulo>=<pasta>… [--json <arquivo>]`** e **`surface --ours <dll|pasta>… --host <modo> [--ship <pasta>]… [--probes <arquivo>] [--resolve <nome>]… --out <surface.json>`**.
- **`surface.json`** (`ssam-surface/1`, escrito por K, lido pelo conector): `{schema, host, subjects:[{file, name, version, sha256}], ship:[pastas], resolve, references:["Nome, Version=…"], probes:[…]}`. Caminhos relativos à pasta do arquivo, sem sair dela. `check --surface` recusa `surface_mismatch: <arquivo>` se um arquivo listado mudou, antes de ler IL. Sonda que não resolve é WARN (`probe-<status>`), nunca FAIL.
- **Cache do `check`** (`--cache <pasta>`; em release, `data\o11\compat-cache` e `data\odc\compat-cache`): um JSON por chave. Chave = build do conector (MVID), modo, `--no-info`, sha256 dos nossos arquivos (ou do `surface.json`), e nome, tamanho e data de todo DLL e `deps.json` das pastas do Studio, base, bridge e runtime. Atualizar o Studio muda a chave; entrada inválida é recalculada.
- **`verify --release <pasta> [--json <arquivo>|-]`**: saída 0/1/2. JSON `{ok, release, version, files{listed, matched, missing[], mismatch[], unlisted[]}, manifest{ok, version, files, error}, authenticode[{path, status, code, declared}], bytecode[{path, ok, error}], errors[]}`. Confere tamanho e sha256 de cada arquivo do `release.json` (arquivo fora da lista e nome proibido da seção 8 são erro), o `release.sig.jws` (`Ssam.Lic.Release.Verify`, versão igual à do `release.json`), o Authenticode de todo `.dll`/`.exe` sem rede (`Invalid` sempre falha; declarado `Valid` e não `Valid` falha) e cada `.jsc` contra o `.len.json` ao lado.
