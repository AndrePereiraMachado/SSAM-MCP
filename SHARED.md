# Arquivos compartilhados entre as caixas

Estes 68 arquivos existem em `server/` e em `agent/`, no mesmo caminho relativo dentro de cada caixa.
Hoje as duas cópias são iguais byte a byte. Todas vieram de `servidor/fase4` (`e7b2119b`).

## A regra

- Os dois lados têm de ficar iguais. Mudou um, copie para o outro no mesmo commit.
- Nunca edite só um lado. Uma diferença quebra o build ou o contrato entre servidor e agente.
- O dono de cada grupo está no título da seção. O dono muda primeiro; a outra caixa recebe a cópia.
- Um bump da bridge ODC (hoje v48) mexe nas duas caixas: `Bridge.csproj`, `client/Program.cs` e o `kernel.json` do servidor.
- O `.gitignore` da raiz de cada caixa é o mesmo arquivo do repositório original.

## Por que existem nas duas

- A caixa agent compila a bridge ODC, o cliente ODC, a bridge O11 fina, o `Anvil.RuntimeHook` e o `Anvil.Connect`.
  Esses projetos linkam fontes que o servidor também compila (bridge O11 completa, `query-test`, `Journal`/`Manifest`,
  `NativeMerge*`) e usam os `Directory.Build.*` do kernel.
- A caixa server compila a bridge e o cliente ODC no `setup-dev.ps1`/`build.ps1` e lê a versão da bridge (v48) de
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
| `docs/FASE2-AGENTE.md` | `7be63ab4496b324897794fedd660bb44ec643f775daf6e188d7818dc6e502fcd` |
| `docs/O11-BRIDGE-FINA.md` | `0daa6056614f4dea87c2b43bd5a71e786a80a98d8ea63f2365f66a23f10ee1a2` |
| `docs/PROVAS-AO-VIVO.md` | `fadca36de23c52b2e317543d65c1c57c9ff2b3c28e726bfc86833a20555f4d9e` |
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

## kernel/src/Anvil.Bridge/: fontes da bridge O11 completa que a bridge fina linka (dono: server)

| Arquivo (relativo à caixa) | sha256 (conteúdo com fim de linha LF) |
| --- | --- |
| `kernel/src/Anvil.Bridge/DependenciesDialog.cs` | `ee5b81af93c52d3f47bf4331064aa8cd5f7139f9110aa445824d93eb86daf73e` |
| `kernel/src/Anvil.Bridge/DialogScope.cs` | `3dc818e827d011e9d857ce145cdd3c64fc608a957c170f8be8e2880b91f6bbd5` |
| `kernel/src/Anvil.Bridge/Dialogs.cs` | `7c6907effd7eea6e0b2c8b49c1a0389645fbcb5c38adf9947debd48f3362eaaf` |
| `kernel/src/Anvil.Bridge/MergeRollbackProof.cs` | `cc2dd66af6b3396e369d7d9cd2b4bab1c90610db379921f258a2fbd67aec385a` |
| `kernel/src/Anvil.Bridge/OpenHandler.cs` | `8560ad4fdb57ec31ccb559705c0868c71879c27077c3176814c9de80faa617ae` |
| `kernel/src/Anvil.Bridge/PublishConfirmation.cs` | `62f07585d42dec4c3dc14db4e553a96ec87314526000cff5f3366a7c2f60c3ed` |
| `kernel/src/Anvil.Bridge/PublishHandler.cs` | `27ceca274b1b7e0969ee6bae1fb1e3e7c047977998b9030fb6241f089103f9da` |
| `kernel/src/Anvil.Bridge/PublishLog.cs` | `b9731052c213666a432e5b2fa44ae7d55154432aab661b8b89c03560a80d6db0` |
| `kernel/src/Anvil.Bridge/PublishLogHandler.cs` | `6dba685e646c70729502453c5a9ffcc12ea48379891d8714a3faf340b94cc967` |
| `kernel/src/Anvil.Bridge/Reads.cs` | `e6ddab5b5c68150dcefaec2c9cb317d31ff4e5f0fd84b9b0284182d555669b06` |
| `kernel/src/Anvil.Bridge/RefreshReferencesHandler.cs` | `f4db7a0b27b5aa15c5042c3bfa958b0e0f338cb8d40719aa40966761171e10de` |
| `kernel/src/Anvil.Bridge/ScApiHandler.cs` | `0292a6d482a0106684ac83bede39447d3ffce364a902c992a9e9484521e2fa0c` |
| `kernel/src/Anvil.Bridge/ScIntegrationStudioSoap.cs` | `550bbca8505b1f7a3ee130a821bfcf81f12640f361de9531cdedbfbd90b22f03` |
| `kernel/src/Anvil.Bridge/ScOperations.cs` | `470b056e14192129f57698623ad11192305031c61839a851dca74deee7ecc193` |
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
| `platforms/odc/facade/o11-bridge.mjs` | `3dd01a43b602e8238d5f0570842ac948c30088b6a0f2b357b1499a99c3166346` |
| `platforms/odc/facade/odc-pipe.mjs` | `7e1e43caeb992024f3b85e2d8c45a0633f46c0ccf54523a342dbe27090b8156c` |

## platforms/odc/studio/bridge/: bridge ODC e cliente de attach (dono: agent; o servidor compila e lê a versão)

| Arquivo (relativo à caixa) | sha256 (conteúdo com fim de linha LF) |
| --- | --- |
| `platforms/odc/studio/bridge/AppCreationCommands.cs` | `416c95f5bf1a86476109aa07d4950d12c05c72450a6d860a9dec4924b1341ccf` |
| `platforms/odc/studio/bridge/Bridge.csproj` | `d565c4eefcca0f24072da48e025afff8543bcfb21cd918ec972e793fcea10638` |
| `platforms/odc/studio/bridge/DataCommands.cs` | `2c8eb954b4b1d1ccace550179399a4418f43fee308f3014fe1490a30f4196aa6` |
| `platforms/odc/studio/bridge/MergeDiagnostics.cs` | `8a1d4b6206278e146729c6a3515d0962d0db6b64156dc9cee313dd9adf3b8573` |
| `platforms/odc/studio/bridge/MergeOrderCopy.cs` | `4e7a187554154662f5ffcecf401904eb4b59ef656192f7fa57afc73b13a4d2d9` |
| `platforms/odc/studio/bridge/PortalCommands.cs` | `8faceb8dadaaebb4e0c6e2e6a116b9a84b51ad89ee38ba833831fad5954ca7ea` |
| `platforms/odc/studio/bridge/PortalCore.cs` | `5f5897f93214915ac7d79465b800a91b6c4ea3adb4d99aa7046bcc346c78b0fe` |
| `platforms/odc/studio/bridge/PortalUpload.cs` | `945c40b566a21546ecf36b2a0029d357f465ef8b74e5008b28acb79cfcd55736` |
| `platforms/odc/studio/bridge/PortalVault.cs` | `e65f18ef07194afafd6fc603fa80e267b2d53d8a7f1c6fec5016773131167728` |
| `platforms/odc/studio/bridge/PublicSignatureReader.cs` | `2caccb3e657b84f750af2a1ba2723509b2775c9a4ffbd79f431fba100d6a1567` |
| `platforms/odc/studio/bridge/PublishLogCommands.cs` | `3f2b097bb4837e7f0a3e19a9534f5adb9dec6ec61129b9106133037bf96c8c56` |
| `platforms/odc/studio/bridge/PublishLogCore.cs` | `33b820a24c909f5528e3aaa50d5ac7410ae3721d3e0f819d3c4dd586cf9db730` |
| `platforms/odc/studio/bridge/QueryTestCommands.cs` | `97be6ecf1e5f05c2c047b03852cab69c632e580d187d6e3186932d080fd2906d` |
| `platforms/odc/studio/bridge/README.md` | `8eb1a2995812f8ce5c00529f68f48a561076256757afa115ab669f3feec423d3` |
| `platforms/odc/studio/bridge/ReferenceCommands.cs` | `6e79037711699bfb907b063f9605ffd9566948b0d9587758982d323ab8a7a5b8` |
| `platforms/odc/studio/bridge/SecurityWarningsCopy.cs` | `9994c72f57a32b74fd8ca92299198e44dea11efed1023d5526f72eeb5307b698` |
| `platforms/odc/studio/bridge/StartupHook.cs` | `6709fc26acc926ee7a51bc017aa1993ff04ee844ad6bcc4177d4f1cf178ae8e5` |
| `platforms/odc/studio/bridge/TemplateCache.cs` | `a57ef89f222983393d3249c75d543e6a2fc06aef456340a63272d8f127b3f20c` |
| `platforms/odc/studio/bridge/client/Client.csproj` | `a5b9c2d9640b4df751a052075cd5b2bf9b568b7b2e00f72b160acb9ebdc953f2` |
| `platforms/odc/studio/bridge/client/Program.cs` | `a0a58a3bab0855cc53c513211c4c33309a5362e5763e5e06d8eabc4dd20b5b83` |
| `platforms/odc/studio/bridge/tests/Bridge.Tests.csproj` | `798884de56db09cbbb3fab69ff0de869c7d91f4a2508bec27701e5a9bc252010` |

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
