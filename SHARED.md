# Arquivos compartilhados entre as caixas

Estes 76 arquivos existem em `server/` e em `agent/`, no mesmo caminho relativo dentro de cada caixa.
Hoje 75 têm as duas cópias iguais byte a byte. A exceção é `platforms/odc/facade/o11-bridge.mjs`, de propósito (seção
"Diferença de propósito", no fim da seção da fachada). Vieram de `servidor/fase4` (`e7b2119b`) e estão na revisão de
`fase4-24/combinada` (`41e538f0`): o 24º envio (`a415531d`) com `fase4-24/odc1728` (`f912cb7e`, ODC Studio 1.7.28 e bridge
ODC v97), `fase4-24/o11-115592` (Service Studio 11.55.92) e `fase4-24/qualidade` (que não muda nenhum deles), mais a imagem
interina. O 24º acrescentou 8:
`PrivateHttpContext.cs` e `ScHttpHandler.cs` do kernel e 6 fontes novas da bridge ODC (`Portal*.cs`). O `f912cb7e`
mudou 5: `docs/FASE2-AGENTE.md`, `docs/PROVAS-AO-VIVO.md`, `Bridge.csproj`, `StartupHook.cs` e `client/Program.cs`. A linha
combinada mudou de novo 2: `docs/FASE2-AGENTE.md` (Service Studio 11.55.92, a seção 7 da imagem interina) e
`docs/PROVAS-AO-VIVO.md` (Service Studio 11.55.92). O `41e538f0` mudou `docs/FASE2-AGENTE.md` de novo (a faixa desligada
recusa também as ferramentas só do servidor e esvazia os caches dela). A branch `feat/studio-build-identity` (A-M1) mudou
`docs/FASE2-AGENTE.md` de novo (seção 7: identidade do Studio pelo build de 4 números, uma recusa por direção, avisos
`studioBuildDiffers` e `studioNotServed`). A `server/r27-marco-a7` levou às duas caixas o `docs/FASE2-AGENTE.md` da linha
`fase4-26/marco-a7` (`7b14280a`): a classificação das ferramentas do marco-a5 e os textos dos marcos a6 e a7. A
`server/r28-marco-a8` levou às duas caixas o `docs/FASE2-AGENTE.md` e o `docs/O11-BRIDGE-FINA.md` da `fase4-26/marco-a8`
(`52562a86`): o `ssam_code` hospedado e o Manage Dependencies da fina por código.

## A regra

- Os dois lados têm de ficar iguais. Mudou um, copie para o outro no mesmo commit.
- Nunca edite só um lado. Uma diferença quebra o build ou o contrato entre servidor e agente.
- O dono de cada grupo está no título da seção. O dono muda primeiro; a outra caixa recebe a cópia.
- Um bump da bridge ODC (hoje v97) mexe nas duas caixas: `Bridge.csproj`, `StartupHook.cs`, `client/Program.cs` e o
  `kernel.json` do servidor.
- O `.gitignore` da raiz de cada caixa é o mesmo arquivo do repositório original.

## Por que existem nas duas

- A caixa agent compila a bridge ODC, o cliente ODC, a bridge O11 fina, o `Anvil.RuntimeHook` e o `Anvil.Connect`.
  Esses projetos linkam fontes que o servidor também compila (bridge O11 completa, `query-test`, `Journal`/`Manifest`,
  `NativeMerge*`) e usam os `Directory.Build.*` do kernel.
- A bridge fina linka `kernel/src/Anvil.Bridge/ScHttpHandler.cs` (o `sc_http` pela sessão do Studio, 24º). A bridge ODC
  e o `Bridge.Tests` linkam `kernel/src/Anvil.Bridge/PrivateHttpContext.cs` (namespace `Ssam.PrivateTransport`, sem
  tipo do kernel; `public-signature-drift` aceita só esse arquivo do kernel dentro da bridge ODC).
- A caixa server compila a bridge e o cliente ODC no `setup-dev.ps1`/`build.ps1` e lê a versão da bridge (v97) de
  `client/Program.cs`. O modo local do servidor compila `Anvil.Connect` e `Anvil.RuntimeHook`.
- `platforms/odc/facade/odc-pipe.mjs` e `o11-bridge.mjs` são do servidor. O agente guarda uma cópia só para o teste de
  deriva (`agent/tests/drift.test.mjs`). Nunca são importados pelo agente.
- `scripts/release/client-content.json`: o servidor usa no scrub de evidência; o agente usa na varredura de PI do pacote.
- `platforms/odc/studio/bridge/tests/Bridge.Tests.csproj` foi acrescentado ao servidor porque
  `platforms/odc/tests/public-signature-drift.test.mjs` o lê. Os testes `.cs` da bridge ficam só no agente.
- Os contratos (`docs/FASE2-AGENTE.md`, `docs/O11-BRIDGE-FINA.md`, `docs/PROVAS-AO-VIVO.md`, `docs/DISTRIBUICAO.md`)
  descrevem os dois lados.

## Como conferir

O sha256 abaixo é do conteúdo com CRLF trocado por LF. Assim ele não depende do `core.autocrlf` de quem clona.

```powershell
$root = 'C:\Users\andre\SSAM-MCP'
$lf = { param($f) $b = [IO.File]::ReadAllBytes($f); $t = [Text.Encoding]::GetEncoding(28591).GetString($b).Replace("`r`n", "`n")
  $s = [Security.Cryptography.SHA256]::Create(); -join ($s.ComputeHash([Text.Encoding]::GetEncoding(28591).GetBytes($t)) | ForEach-Object { $_.ToString('x2') }) }
Select-String -Path "$root\SHARED.md" -Pattern '^\| `([^`]+)` \| `([0-9a-f]{64})`' | ForEach-Object {
  $p = $_.Matches[0].Groups[1].Value; $h = $_.Matches[0].Groups[2].Value
  foreach ($box in 'server', 'agent') { if ((& $lf (Join-Path "$root\$box" $p)) -ne $h) { "DIFERENTE: $box/$p" } }
}
```

Sem saída, está tudo igual.

## Raiz da caixa (dono: server)

| Arquivo (relativo à caixa) | sha256 (conteúdo com fim de linha LF) |
| --- | --- |
| `.gitignore` | `73bdcfd6d3d914b5e9654b4df9a3c6598c29eb631801082053ae53793850e934` |

## docs/: contratos dos dois lados (dono: server)

| Arquivo (relativo à caixa) | sha256 (conteúdo com fim de linha LF) |
| --- | --- |
| `docs/DISTRIBUICAO.md` | `bc87ebe53ef2230f89d4ceb1162e5e84b9eecc0e2563e93905eccb78fbc9d5b1` |
| `docs/FASE2-AGENTE.md` | `17f99b6a0f27392c5bd94874e7143307f82ae72ce2935f1a1a8a673ba66ff992` |
| `docs/O11-BRIDGE-FINA.md` | `5300a92480c3f0393d2adb217321ed06cfb888f5da5f19f71225a86515362a3b` |
| `docs/PROVAS-AO-VIVO.md` | `b66c259ac7cb293fbc7c7165794885ac6462598a2e65e2753c85f3646d99979a` |
| `docs/exemplos/mcp-cliente-hospedado.json` | `cabbe38805716878f03def98527dd5234b2dcfd9187df8c773305f80d8d6fa28` |

## kernel/: MSBuild comum (dono: server)

| Arquivo (relativo à caixa) | sha256 (conteúdo com fim de linha LF) |
| --- | --- |
| `kernel/Directory.Build.props` | `0097115abbca48378e154de14ccaeb1d0c58d57cabf85ee99cbf96705d2cf9eb` |
| `kernel/Directory.Build.targets` | `55e9750d530260c1683da8f7ab50de84c31e823c8d3c8bc0988e62257d6e2f02` |

## kernel/query-test/: teste de consulta nativo, linkado na bridge ODC e na bridge O11 completa (dono: server)

| Arquivo (relativo à caixa) | sha256 (conteúdo com fim de linha LF) |
| --- | --- |
| `kernel/query-test/NativeQueryTest.cs` | `89e2889b8a6c05380124c98239a1b4bb16eed266f031466444b76e06b4f39177` |
| `kernel/query-test/QueryTestContract.cs` | `a778e457aba47971224e4a48e1a7c2ea69541a3bd8dc246527cb147218bdf7f3` |
| `kernel/query-test/QueryTestOutput.cs` | `a9bb3f539accf807984d6798355ae648642568d43950b2ec01ff51784568eebf` |
| `kernel/query-test/QueryTestRunner.cs` | `b9f96ac09f1aeb20493843df77a6ff6f4a59d26e485de0f603922fcfd464844c` |

## kernel/src/Anvil.Bridge/: fontes da bridge O11 completa que a bridge fina linka, e `PrivateHttpContext.cs`, que a bridge ODC linka (dono: server)

| Arquivo (relativo à caixa) | sha256 (conteúdo com fim de linha LF) |
| --- | --- |
| `kernel/src/Anvil.Bridge/DependenciesDialog.cs` | `ee5b81af93c52d3f47bf4331064aa8cd5f7139f9110aa445824d93eb86daf73e` |
| `kernel/src/Anvil.Bridge/DialogScope.cs` | `3dc818e827d011e9d857ce145cdd3c64fc608a957c170f8be8e2880b91f6bbd5` |
| `kernel/src/Anvil.Bridge/Dialogs.cs` | `7c6907effd7eea6e0b2c8b49c1a0389645fbcb5c38adf9947debd48f3362eaaf` |
| `kernel/src/Anvil.Bridge/MergeRollbackProof.cs` | `11651e36eb2e05c8a9f032950dd18cc7e58a9002a7bfffaddcc5796055b8d20d` |
| `kernel/src/Anvil.Bridge/OpenHandler.cs` | `26bc3e02bbe6bca03527278e4277b06c287f7079dfea7c5b34869a85819a469f` |
| `kernel/src/Anvil.Bridge/PrivateHttpContext.cs` | `73785bbd6483074d865848ef9bc4f13423aabc7d371d8931e2936ffe85fdbca8` |
| `kernel/src/Anvil.Bridge/PublishConfirmation.cs` | `62f07585d42dec4c3dc14db4e553a96ec87314526000cff5f3366a7c2f60c3ed` |
| `kernel/src/Anvil.Bridge/PublishHandler.cs` | `27ceca274b1b7e0969ee6bae1fb1e3e7c047977998b9030fb6241f089103f9da` |
| `kernel/src/Anvil.Bridge/PublishLog.cs` | `b9731052c213666a432e5b2fa44ae7d55154432aab661b8b89c03560a80d6db0` |
| `kernel/src/Anvil.Bridge/PublishLogHandler.cs` | `6dba685e646c70729502453c5a9ffcc12ea48379891d8714a3faf340b94cc967` |
| `kernel/src/Anvil.Bridge/Reads.cs` | `0fd3d953a478a56136325e334b8353452664919422da0f24d7fbc1901f06a9fe` |
| `kernel/src/Anvil.Bridge/RefreshReferencesHandler.cs` | `f4db7a0b27b5aa15c5042c3bfa958b0e0f338cb8d40719aa40966761171e10de` |
| `kernel/src/Anvil.Bridge/ScApiHandler.cs` | `3f1f5d82ce7009126a0e4505e49d32b909f26229b29b975adf4e962d8f302030` |
| `kernel/src/Anvil.Bridge/ScHttpHandler.cs` | `af80b58a7b66ffad01e4673046b7a5ffaa225aa1888f5100125cc4e912e0eed5` |
| `kernel/src/Anvil.Bridge/ScIntegrationStudioSoap.cs` | `529221d4197302f71546f39fb0a29f56866405df4575c40127b05a1eabd777d1` |
| `kernel/src/Anvil.Bridge/ScOperations.cs` | `dfd7748207278a3c4316d3b33987ecf222e1b7ce6a675927572efc465ba2123e` |
| `kernel/src/Anvil.Bridge/ScVault.cs` | `848674096673731f6a5fc4b7f22a76049e58a5cf0076e78cfe958ef8e0055017` |
| `kernel/src/Anvil.Bridge/ScWebHandler.cs` | `b1b3539bafec9be50328fe979b45a306c106572cc2711d62eefb49792e8cb3dc` |
| `kernel/src/Anvil.Bridge/SilentModeLease.cs` | `01562c42aae26032ddbb0e24b9fbd27d450bd93ecc3d68ec6d336c41321e828c` |
| `kernel/src/Anvil.Bridge/Studio.cs` | `69a5f05e9a2f6ddbda2b7d340570bf8e360c5ea8a36ea03dc62c377c34ce463b` |
| `kernel/src/Anvil.Bridge/Ui.cs` | `9b7db0e3f88fbfee99654ee7508c919980e2fd5103e976d2e166ca25877a62b4` |
| `kernel/src/Anvil.Bridge/UiGate.cs` | `9f27a9df6f5f46131869e62ec843b680a27ac9993d77972f57fcb314ae9cc494` |
| `kernel/src/Anvil.Bridge/WindowsHandler.cs` | `786b52c76c50ff6928bd0dbf1834bc80b0956baf2944ef7d780cbde54ac8b704` |

## kernel/tools/: gancho de runtime e conector O11 (dono: server; o agente compila)

| Arquivo (relativo à caixa) | sha256 (conteúdo com fim de linha LF) |
| --- | --- |
| `kernel/tools/Anvil.Connect/Anvil.Connect.csproj` | `fff68f5541026f0bf72ed2c2ad8ec052c0f848582cd201d4a66fd2b52bf300c4` |
| `kernel/tools/Anvil.Connect/Program.cs` | `4724a2b9d2db9403ec1fcac9d494dd4557e1a2975c8d6132a5598aaf98e81579` |
| `kernel/tools/Anvil.RuntimeHook/Anvil.RuntimeHook.csproj` | `12985a174dc55d6f519f2205bf7b35d0123d6d7dfa7fe3fe34f2f3028ba30604` |
| `kernel/tools/Anvil.RuntimeHook/StartupHook.cs` | `25ee60643b6abfd282139c84e50b68148e7181f050e653742fac1869f9666835` |

## platforms/odc/facade/: originais congelados do servidor, no agente só para o teste de deriva (dono: server)

| Arquivo (relativo à caixa) | sha256 (conteúdo com fim de linha LF) |
| --- | --- |
| `platforms/odc/facade/odc-pipe.mjs` | `7e1e43caeb992024f3b85e2d8c45a0633f46c0ccf54523a342dbe27090b8156c` |

Diferença de propósito desde `server/r26-marco-a6` (decisão D5 do dono, 15/10/2026): `o11-bridge.mjs` não é igual nas
duas caixas, e a checagem acima não o lista.

- `server/`: o da linha `fase4-26/marco-a6` (`75c8940c`), com os mesmos bytes na `fase4-26/marco-a7` (`7b14280a`). A CX14
  reescreveu o `bridgeRequest` (chamada vigiada com sondas, só local) e, no hospedado, o manifesto da bridge vai pelo agente
  (`executor.call('o11.bridge')`).
- `agent/`: o do pacote atual (`C:\t\pack-comb\ssam-agent.zip`, linha `b58be727`). É o arquivo que tem o bloco congelado de
  `agent/lib/o11-wire.mjs`, e o `agent/tests/drift.test.mjs` desta caixa compara com ele. A linha guarda o mesmo arquivo em
  `agent/tests/fixtures/o11-bridge.pack.mjs`, com o sha256 fixado no teste dela. O zip não muda.
- Um pacote novo com a CX14 no agente volta a igualar as duas caixas e põe a linha de novo na tabela.

| Caixa | Arquivo | sha256 (conteúdo com fim de linha LF) |
| --- | --- | --- |
| server | `platforms/odc/facade/o11-bridge.mjs` | `568e406edb4dc24e812a33bc06049a3d320008590a9f5ee9f399beb75eee88a9` |
| agent | `platforms/odc/facade/o11-bridge.mjs` | `3dd01a43b602e8238d5f0570842ac948c30088b6a0f2b357b1499a99c3166346` |

## platforms/odc/studio/bridge/: bridge ODC e cliente de attach (dono: agent; o servidor compila e lê a versão)

| Arquivo (relativo à caixa) | sha256 (conteúdo com fim de linha LF) |
| --- | --- |
| `platforms/odc/studio/bridge/AppCreationCommands.cs` | `416c95f5bf1a86476109aa07d4950d12c05c72450a6d860a9dec4924b1341ccf` |
| `platforms/odc/studio/bridge/Bridge.csproj` | `3b228be57045a7a2777b9a0a2baf371c5e77c01ef119ff5ce8d4f0ed203a80ed` |
| `platforms/odc/studio/bridge/DataCommands.cs` | `2c8eb954b4b1d1ccace550179399a4418f43fee308f3014fe1490a30f4196aa6` |
| `platforms/odc/studio/bridge/MergeDiagnostics.cs` | `8a1d4b6206278e146729c6a3515d0962d0db6b64156dc9cee313dd9adf3b8573` |
| `platforms/odc/studio/bridge/MergeOrderCopy.cs` | `4e7a187554154662f5ffcecf401904eb4b59ef656192f7fa57afc73b13a4d2d9` |
| `platforms/odc/studio/bridge/PortalApiClientCleanup.cs` | `8e16426f6382149808da6cf169ab9d3e3e3bfc516b8a055467e0a6532728fd48` |
| `platforms/odc/studio/bridge/PortalApiClientSecret.cs` | `2bf23662976750d82ee96ca742cfd8efb3c7ea5428e5af8c2050208243f8d959` |
| `platforms/odc/studio/bridge/PortalCommands.cs` | `242b2e5a79eb00a78e49da9dee2b0dc42511ca3484422f7cac3a63fc7c6656c5` |
| `platforms/odc/studio/bridge/PortalCore.cs` | `8ad3ed73d9d362d55cd5266fc63742fbb8b395ae4296e4662286399965b4697a` |
| `platforms/odc/studio/bridge/PortalKnowledgeDownload.cs` | `198d3aff0965210d288e5ca17d3f19335a49856311a060813ceeecf25ceeedba` |
| `platforms/odc/studio/bridge/PortalMobileDownload.cs` | `14f22439e5addfb29f90292ed5c8a25a0f45ce1edd8576097a0bb73f2708fb7c` |
| `platforms/odc/studio/bridge/PortalMobileUpload.cs` | `c94e420a777d52017cfa963c1f8170213d7e045f472b7d5b388a8aa72955e695` |
| `platforms/odc/studio/bridge/PortalPrivateHttp.cs` | `71d15be9b8394ddbd87ad084f264a2fdcefb157ef57021ca42caf54bc49c89a2` |
| `platforms/odc/studio/bridge/PortalUpload.cs` | `945c40b566a21546ecf36b2a0029d357f465ef8b74e5008b28acb79cfcd55736` |
| `platforms/odc/studio/bridge/PortalVault.cs` | `e8780ab773dab88a75b48737b7aa29047d29aa7394206662400b4a4c652ecf7c` |
| `platforms/odc/studio/bridge/PublicSignatureReader.cs` | `2caccb3e657b84f750af2a1ba2723509b2775c9a4ffbd79f431fba100d6a1567` |
| `platforms/odc/studio/bridge/PublishLogCommands.cs` | `3f2b097bb4837e7f0a3e19a9534f5adb9dec6ec61129b9106133037bf96c8c56` |
| `platforms/odc/studio/bridge/PublishLogCore.cs` | `33b820a24c909f5528e3aaa50d5ac7410ae3721d3e0f819d3c4dd586cf9db730` |
| `platforms/odc/studio/bridge/QueryTestCommands.cs` | `97be6ecf1e5f05c2c047b03852cab69c632e580d187d6e3186932d080fd2906d` |
| `platforms/odc/studio/bridge/README.md` | `722510d95bca5db8cced9ed3560f8dbb31dd2681c17c9514f01bd7a332efef9b` |
| `platforms/odc/studio/bridge/ReferenceCommands.cs` | `615e55dec013036b12270e55ec8eea2a723cce753eb367cd232884b65adf9db0` |
| `platforms/odc/studio/bridge/SecurityWarningsCopy.cs` | `9994c72f57a32b74fd8ca92299198e44dea11efed1023d5526f72eeb5307b698` |
| `platforms/odc/studio/bridge/StartupHook.cs` | `3c90b44f10511f06b9f369ff4b2499fa54b57a030563a4d2e582a3337a748b0b` |
| `platforms/odc/studio/bridge/TemplateCache.cs` | `a57ef89f222983393d3249c75d543e6a2fc06aef456340a63272d8f127b3f20c` |
| `platforms/odc/studio/bridge/client/Client.csproj` | `a5b9c2d9640b4df751a052075cd5b2bf9b568b7b2e00f72b160acb9ebdc953f2` |
| `platforms/odc/studio/bridge/client/Program.cs` | `371ac5aff49a07d71b307252b6305165f9bf258c678e9ffdc20e7e5190482f87` |
| `platforms/odc/studio/bridge/tests/Bridge.Tests.csproj` | `2f27778179dacdba7026cb7fea8fa46cfdf79e53cec590833ddaf303062c9696` |

## platforms/odc/studio/ e platforms/odc/.gitattributes: fontes que a bridge ODC linka e regras de build e eol (dono: server)

| Arquivo (relativo à caixa) | sha256 (conteúdo com fim de linha LF) |
| --- | --- |
| `platforms/odc/.gitattributes` | `42ad2a28561758a7608b535db5a1c9e24c9c0191d9722db1fc6c68f93ff9a7da` |
| `platforms/odc/studio/Directory.Build.targets` | `25f4affcacc403e7b7121f8433a410a98268c4c93ddc404b7e5609fbc503c6be` |
| `platforms/odc/studio/engine/NativeMergeOrder.cs` | `3ec32ca130504f0375a12704b58123e88539fc0472dd8174945430ac10c7e127` |
| `platforms/odc/studio/engine/NativeMergeVerification.cs` | `b7b797836070709672c57d3bdeb0ebed8571e06c4dfba172b9a5a0ab7ce4aede` |
| `platforms/odc/studio/engine/README.md` | `deac74bba0552f9a6779ce764732431d965b365ac7f5abd551cbc654d3ce9a69` |
| `platforms/odc/studio/shared/Journal.cs` | `e0cc116aec478a3092b9e31c04f470b6d5a47f7af72974234a3d7fa93586185e` |
| `platforms/odc/studio/shared/Manifest.cs` | `bcc45f95c3b541739dad91211be17df8d2dfe1f59398ed579d5672f095b3788b` |

## scripts/release/client-content.json: lista de padrões de cliente (dono: server, linha do publicador)

| Arquivo (relativo à caixa) | sha256 (conteúdo com fim de linha LF) |
| --- | --- |
| `scripts/release/client-content.json` | `7160794a2c584cb90f310cb86878fbd573b5677da85fb25d1fc5df1895615ec4` |
