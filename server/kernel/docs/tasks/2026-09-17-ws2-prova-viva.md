# WS2: prova viva do `Adapters.ODC` de sessão (snapshot, merge, publish, refresh)

Estado em 2026-09-17 01:25 UTC: **T1 a T5 provados ao vivo no tenant pessoal `personal-nv0s5uly.outsystems.dev`
(WrightFlood revisão 8, chave `zd+K_z1D9E2+7T74jXyUNQ`); T6 não executado** (sem autorização escrita do usuário).
Nada foi publicado; o módulo aberto ficou como antes (`modified: false`, revisão 8). O corporativo não foi tocado.

## O que existe

| Classe (`src\Anvil.Core.Odc\Adapters.ODC\`) | Bridge | Prova |
|---|---|---|
| `BridgeClientOdc : IBridgeClient` | `dotnet ODC3.Bridge.Client.dll <pid> <comando> [args]`; devolve a linha JSON tal qual (recusa `ok=false` é devolvida, não lançada); só falha de transporte lança `BridgeCallException` (`Executed=false` nada chegou ao bridge, `null` timeout do cliente). `Call(method, JsonObject)` do contrato do kernel: `args` posicionais, restantes chaves `--nome valor`. Pid: `ANVIL_ODC_STUDIO_PID` ou o único `ODCStudio.exe`; raiz: `ANVIL_ODC_ROOT`/`SSAM_HYBRID_ODC_ROOT`/`ODC3_ROOT` ou `C:\Users\andre\SSAM-Hybrid-ODC` | T1 |
| `StudioSessionOdc` | `Snapshot(M)` → `snapshot <M>` (`OdcSnapshot`: caminho, sha, chave, host, autor); `Merge(manifest)` → `check-base`, `preview`, `merge`, parando na primeira recusa e devolvendo o JSON da recusa como está (`OdcMergeOutcome`); `WriteManifest` escreve o `odc3-manifest/1` que o bridge lê (tenant e autor vêm do snapshot); `DeliverJob(M, job, evidência, feature, owners, changes)` = snapshot → `JobRunner.Run` do kernel sobre o snapshot (`ModelHost` + `OdcRuntime`) → manifesto → merge | T2, T5 |
| `PublisherOdc` | `Publish(manifest, autorização)` → `authorize <manifest> publish <texto>` e `publish <manifest> --wait`; texto vazio é recusado antes do bridge; `Status(manifest)` → `publish-status` | T6 não executado |
| `ReferenceServiceOdc` | `Refresh(C, P?)` → `refresh-references <C> [--producer <P>]`, JSON tal qual | T4 |

Jobs: `tests\jobs-live\odc\block-alert.json` (bloco `WF_PinNotFoundBanner` em `WrightFloodComponents`, o desenho de
`lab\42-pin-banner-v4`: painel `role=alert`, ícone `warning-circle` + título, três linhas, dois inputs com placeholders,
botão `Drop pin here` → `HandleDropPinRequested` → `DropPinRequested(Latitude, Longitude)`) e
`block-alert-remove.json` (apaga o bloco; base headless `job:block-alert`).

Driver da prova (evidência, fora do produto): `C:\Users\andre\SSAM-Hybrid-ODC\lab\ws2-prova-viva\driver\` (console
`net8.0` que referencia `Anvil.Core.Odc.csproj` do worktree; comandos `status`, `headless`, `snapshot`, `merge`,
`deliver`, `refresh`, `publish`). O `Anvil.Cli` é o build SS11; a faixa ODC não tem CLI até o integrador ligar um.

## Pré-condições (2026-09-17 01:05)

```powershell
cd C:\Users\andre\SSAM-Hybrid-ODC
.\odc attach                                   # bridge v28 no pid 39872
.\odc studio status sessions                   # [{"loggedIn":true,"host":"personal-nv0s5uly.outsystems.dev"}]
.\odc studio assets personal-nv0s5uly.outsystems.dev   # ok=true, count=59; WrightFlood key zd+K_z1D9E2+7T74jXyUNQ revision 8
.\odc studio open WrightFlood                  # opened=true, openedFrom=PublishedVersion, assetRevision=8, modified=false
```

(Antes disso, às 00:40, o Studio estava só no corporativo: bloqueio registado e resolvido pelo usuário, que abriu o
Studio no pessoal. Com o Studio no corporativo só corri `attach` e `status`, ambos sem efeito no tenant.)

## T1: `status brief` devolve `ok=true` (via `BridgeClientOdc`)

```powershell
cd C:\Users\andre\SSAM-Hybrid-ODC\lab\ws2-prova-viva\driver
dotnet bin\Release\net8.0\Ws2Driver.dll status
```

```json
{ "ok": true, "bridge": "v28", "busy": null, "catalog": { "tenant": "wrightflood.outsystems.dev", "modules": 57, ... },
  "dialogsWithChoices": [], "modalWindows": 0, "modules": [ { "name": "WrightFlood", "modified": false, "mergePending": false } ] }
```

## T5 (e T2): o bloco entra e sai do WrightFlood pessoal pelo kernel + bridge

Terceira tentativa (`lab\ws2-prova-viva\03-block-alert`), depois de duas recusas do gate de equivalência explicadas abaixo:

```powershell
dotnet bin\Release\net8.0\Ws2Driver.dll deliver WrightFlood C:\Users\andre\Anvil-ws2\tests\jobs-live\odc\block-alert.json C:\Users\andre\SSAM-Hybrid-ODC\lab\ws2-prova-viva\03-block-alert block-alert WF_PinNotFoundBanner "Block WF_PinNotFoundBanner in WrightFloodComponents (WS2 live proof): ..."
```

`deliver-result.json`: `delivered: true`, `strictlyEqual: true`, `elapsedMs: 48553`; snapshot base
`47B472A420F75B7894E4B4C8E11FA87D0643D8915B1BA98C862DC50D7D2B4EBA`; kernel `isValid: true`, `accepted: true`, 0 mensagens novas.

```json
check-base: {"ok":true,"module":"WrightFlood","baseSha256":"47B472A4...","baseAgeMinutes":0,"currentMatchesBase":true,"gate":"none","unreferencedProducers":[],"note":"Open module equals the captured base."}
preview:    {"ok":true,"module":"WrightFlood","conflicts":false,"noDifferences":false,"exactCapturedBase":true,"baseSha256":"47B472A4...","candidateSha256":"4B782B901C89795BB8C02BDDB953EF800FDA3051250DACD6D9B894904628B426","unreferencedProducers":[],"publishInvoked":false}
merge:      {"ok":true,"merged":true,"module":"WrightFlood","outcome":"MergeAndPublish","sha256":"247CB38CE5305F7579911291DFC651A31D4BEC0B502E7C3BE3F29EECBE441DE0","afterSnapshot":"...\\03-block-alert\\evidence\\after-merge.oml","strictlyEqual":true,"emptyLayoutProperties":0,"refreshedReferences":[],"developerId":"andre_c_machado@hotmail.com","publishInvoked":false,"completedAt":"2026-09-17T01:19:05.1058643+00:00","otherOpenModules":[]}
```

Job inverso (`lab\ws2-prova-viva\04-block-alert-remove`), base = novo snapshot do módulo aberto (`247CB38C...`):

```json
deliver-result: delivered=true, strictlyEqual=true, elapsedMs=69533, apply isValid=true accepted=true, find depois do delete: {"op":"find","result":[]}
merge: {"ok":true,"merged":true,"module":"WrightFlood","outcome":"MergeAndPublish","sha256":"6D975E50C98F8CE9B121BAC4C770CC7FD1EF0E8337A99586E3D3C99EED4E6B84","strictlyEqual":true,"emptyLayoutProperties":0,"refreshedReferences":[],"developerId":"andre_c_machado@hotmail.com","publishInvoked":false,"completedAt":"2026-09-17T01:20:36.0837872+00:00"}
```

Conferência por inspeção dos `after-merge.oml`: depois do 1.º merge o fluxo `WrightFloodComponents` tem o bloco; depois do
inverso não tem, e o conjunto de 26 blocos é igual ao do snapshot inicial (`Compare-Object` vazio).

Estado ao fim do ciclo: `status brief` → `WrightFlood modified: true, mergePending: false` (dois merges em memória, nada
publicado). Para deixar o módulo como antes do ciclo: `close WrightFlood --discard` (o bridge guardou
`snapshots\WrightFlood-discarded-1655C830...oml`) e `open WrightFlood` → `assetRevision 8, modified: false`; `status brief` final:
`[{"name":"WrightFlood","modified":false,"mergePending":false}]`, sessões só no pessoal.

## T4: `refresh-references WrightFlood --producer <OutSystems UI>`

Primeira chamada com `OutSystemsUI` (nome da dependência) recusada: `The server returned no asset for OutSystemsUI (key )`.
O asset chama-se `OutSystems UI` (com espaço, chave `Kn_hixxDWEm4lMd7mIpycQ` na listagem nativa), como o README do bridge
avisa; pela chave:

```json
{ "ok": true, "module": "WrightFlood", "mode": "library-update", "producer": { "Name": "OutSystems UI", "key": "Kn_hixxDWEm4lMd7mIpycQ", "Revision": 3, ... },
  "answer": { "refreshed": true, "targetRevision": 3 }, "changed": true, "sha256Before": "6D975E50...", "sha256After": "1655C830...",
  "dependenciesBefore": [ "(System) r2", "OutSystemsCharts r10", "OutSystemsMaps r17", "OutSystemsUI r100" ],
  "dependenciesAfter":  [ "(System) r2", "OutSystemsCharts r3", "OutSystemsMaps r2", "OutSystemsUI r3" ],
  "refreshedReferences": [], "differencesOutsideReferences": [], "producerActions": [],
  "dump": "C:\\Users\\andre\\SSAM-Hybrid-ODC\\journal\\refresh-WrightFlood-20260917012149.txt",
  "note": "Only references changed; capture a new snapshot before building the next candidate." }
```

(6,5 s; as revisões mostradas mudam para as do servidor, como o README do bridge descreve para `RefreshSpecificReferencesByKey`.)

## As duas recusas antes do sucesso, e o que ensinaram (para o integrador)

1. `01-block-alert`: `merge` → `ok=false, outcome=uncertain, gate=equivalence`, "Native object differs from the candidate:
   (Object Block) WF_PinNotFoundBanner [ChangedInLocal]"; `native-equivalence.txt` só com `EffectiveMarginLeft`
   (`Auto_0`/`Auto_Gutter`, "Not Visible") em `DropPinButton`, `Title`, `WarningIcon`. Módulo devolvido à base com
   `close --discard` (snapshot `WrightFlood-discarded-7E96EAE9...oml`) e `open`.
2. `02-block-alert`: hipótese errada (`Width = "(fill parent)"` nos containers, como o builder faz); mesma recusa. Discard
   (`WrightFlood-discarded-377B50DB...oml`) e `open`.
3. Causa real, vista no `inspect` da cópia descartada: **no build ODC, `create` com pai `IContainer` cria o widget como irmão
   do container (inserido logo a seguir a ele, logo em ordem inversa), não dentro do `IContent` do container.** O `Panel`
   ficou vazio e `Header/Steps/Fields` e os seus widgets ficaram diretos no bloco. O `screen-basic.json` do WS1 tem o mesmo
   efeito (`Box` vazio; `GreetButton`, `NameInput` e a expressão como irmãos do `Box`), invisível ao teste porque ele só
   valida `isValid`. No SS11 o `IContainer` dos plugins cria dentro do seu conteúdo; no ODC o `IContainer` de
   `ServiceStudio.Plugin.NRWidgets` expõe `CreateWidget` como "criar ao lado". Contorno no job, sem tocar o kernel: pai
   explícito `$container/#IContent` (o seletor `#ITipo` do kernel). Com isso: `strictlyEqual = true` à primeira.
   **É diferença de plataforma para o kernel (WS1/INT)**: `Create` sobre um `IContainer` no ODC devia dirigir-se ao seu
   `Content`, como o `#ITipo` já faz para a legenda do botão.

Evidências: `lab\ws2-prova-viva\01-block-alert\`, `02-block-alert\`, `03-block-alert\`, `04-block-alert-remove\` (cada um com
`manifest.json`, `WrightFlood-candidate.oml`, `deliver-result.json`, `evidence\` do bridge); `headless\` com os resultados
headless dos dois jobs sobre a fixture pessoal r8.

## T6: executado em 2026-09-17 03:08 UTC, com autorização escrita do dono

O dono autorizou em conversa ("pode publicar"), e essas foram as palavras passadas tal qual ao bridge; o integrador não
inventou texto nenhum. Feito pelo **CLI novo da faixa ODC** (`anvil-odc`, `src\Anvil.Cli.Odc`), não pelo driver do lab:

```powershell
# 1. entrega (snapshot -> kernel -> manifesto -> check-base/preview/merge), 29 s
dotnet .local\lane-odc\cli\anvil-odc.dll deliver --module WrightFlood `
  --job tests\jobs-live\odc\block-alert.json `
  --evidence C:\Users\andre\SSAM-Hybrid-ODC\lab\ws2-prova-viva\05-block-alert-publish `
  --feature block-alert --owners WF_PinNotFoundBanner --change "Block WF_PinNotFoundBanner ..."
# 2. publicação (authorize + publish --wait), 73 s
dotnet .local\lane-odc\cli\anvil-odc.dll publish `
  --manifest C:\Users\andre\SSAM-Hybrid-ODC\lab\ws2-prova-viva\05-block-alert-publish\manifest.json `
  --authorization "pode publicar"
```

Antes de publicar, o manifesto foi lido e conferido: `moduleKey zd+K_z1D9E2+7T74jXyUNQ`,
`tenant personal-nv0s5uly.outsystems.dev`. O corporativo não foi tocado.

| Passo | Resultado |
|---|---|
| `deliver` | `delivered=true`, recibo do merge `strictlyEqual=true`, `merged=true`, 29 189 ms |
| `authorize` | `publishAuthorization = "pode publicar [recorded 2026-09-17T03:07:28 by bridge v28]"` |
| `publish --wait` | `ok=true`, `state=CompletedWithSuccessNotOpenedInBrowser`, `serverSeconds=66.2` |
| revisão publicada | **9**, `sha256 1224687C…`, `matchesOpenModule=true`, `strictlyEqual=true`, sem referências a refrescar |

Evidência: `lab\ws2-prova-viva\05-block-alert-publish\` (`manifest.json` com a autorização registada,
`WrightFlood-candidate.oml`, `deliver-result.json`, `evidence\receipt.json`) e
`snapshots\WrightFlood-revision-9.oml` (a revisão baixada do servidor e comparada com o módulo aberto).

**Nota de catálogo, para quem vier depois.** `snapshots\modules.json` tem na raiz o tenant **corporativo**
(`wrightflood.outsystems.dev`, 57 módulos, WrightFlood `y4Yw60HbIUeAR7UbZXTVjA` rev 25, listado 16/09 11:25) e em
`otherTenants` duas secções com 59 módulos e a chave `zd+K_z1D9E2+7T74jXyUNQ` rev 8 — uma rotulada `personal-…`
(listagem de 17/09 03:05) e outra rotulada `wrightflood.outsystems.dev` (listagem de 16/09 19:27, feita com o Studio
já no pessoal: o rótulo é do host da sessão anterior, não do conteúdo). Quem usar esse arquivo para resolver chave de
módulo tem de escolher a secção pelo tenant certo; o caminho seguro, e o que o `deliver` usa, é a chave que o bridge
devolve do módulo **aberto**.
