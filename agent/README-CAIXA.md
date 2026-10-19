# Caixa agent

Agente do SSAM que roda na máquina do cliente: `agent/ssam-agent.mjs` e `.ps1`, bridge ODC e cliente de attach, bridge
O11 fina, gancho de runtime, conector O11 e a montagem do pacote `ssam-agent.zip` com a varredura de PI.
Cópia de `servidor/fase4` (`e7b2119b`) de `C:\Users\andre\SSAM-Hybrid-servidor`, sem edição, atualizada para
`fase4-24/odc1728` (`c48074be`, o 24º envio no ODC Studio 1.7.28, branch `server/r24-odc1728`): bridge ODC `v97`
(compilada contra o 1.7.28), bridge O11 fina com `sc_http` (`ScHttpHandler.cs`) e agente `0.3.1` (`reference-producers`,
`sc_http`, transporte novo e `net.probe`).
Na branch `server/r24-qualidade` (`fase4-24/qualidade`, `3262c49f`) só o guia do cliente muda: `docs/AGENTE-CLIENTE.md`
ganha o parágrafo do registro de qualidade (o agente e o pacote não mudam); `01795e52` não muda nada desta caixa; em
`c24d468d` só a seção "Privacidade" do guia muda; `1b2ce8fe` não muda nada desta caixa. Na branch `server/r24-combinada`
(`fase4-24/combinada`, `3d6f232c`): a seção "Privacidade" diz exatamente o que o servidor grava, `docs/FASE2-AGENTE.md` e
`docs/PROVAS-AO-VIVO.md` falam do Service Studio 11.55.92, e `scripts/agent-pack.ps1 -ExpectO11 <versão>` compila a fina
contra a pasta daquele Service Studio (nunca a cópia de faixa) ou para.
Esta pasta guarda os caminhos relativos do repositório antigo: os `.csproj` e os scripts resolvem daqui.

## Compilar e montar o pacote

PowerShell 5.1, a partir desta pasta:

```powershell
$env:TEMP = 'C:\t\ssam-mcp\tmp'; $env:TMP = $env:TEMP
$env:ANVIL_STUDIO_DIR = 'C:\Program Files\OutSystems\Service Studio 11\Service Studio'   # obrigatório aqui
$env:SSAM_NODE = '<node.exe 24>'
dotnet build platforms\odc\studio\bridge\Bridge.csproj -c Release -nologo -v q "-p:OdcInstall=C:\Program Files\OutSystems\ODC Studio\ODC Studio"
dotnet build platforms\odc\studio\bridge\client\Client.csproj -c Release -nologo -v q
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\agent-pack.ps1 -Out <pasta>\ssam-agent.zip -Lanes odc,o11 -NodeLicense <LICENSE do Node>
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\pack-ip-scan.ps1 -Zip <pasta>\ssam-agent.zip
```

## Testar

```powershell
$env:ANVIL_WORKER = '0'; $env:ANVIL_ODC_NO_WORKER = '1'; $env:SSAM_ODC_OFFLINE = '1'
node --test agent/tests/*.test.mjs tests/prova-verbos.test.mjs
dotnet test platforms\odc\studio\bridge\tests\Bridge.Tests.csproj -c Release
```

Em 2026-10-10: 68 de 69 testes node passam; Bridge.Tests 149/149; pacote com 38 arquivos (v48, 11.55.91) e varredura
sem achados. A falha (`drift.test.mjs`, bloco congelado de `o11-wire.mjs`) já existia na revisão original.

Em 2026-10-12 (24º): node 86/86 (o `drift.test.mjs` passa), Bridge.Tests 311/311, e `Bridge.csproj` (`ODC3.Bridge.v96`),
`Client.csproj`, `Anvil.Bridge.Thin`, `Anvil.RuntimeHook` e `Anvil.Connect` compilam a partir desta pasta. O pacote do
24º (`pack-20261012-074714`, 40 entradas, v96, 11.55.91, agente 0.3.1, varredura sem achados) saiu da worktree da
linha, com as mesmas fontes desta caixa (`README.md` da raiz, "Conferência de 2026-10-12").

Em 2026-10-12 (ODC Studio 1.7.28): node 86/86, Bridge.Tests 311/311 contra o 1.7.28, e `Bridge.csproj` compila
`ODC3.Bridge.v97` a partir desta pasta. O pacote v97 (`pack-20261013-003406`, 40 entradas, v97, 11.55.91, varredura sem
achados) saiu da worktree da linha (`README.md` da raiz, "Conferência de 2026-10-12 (ODC Studio 1.7.28)"). Os clientes
no ODC Studio 1.7.28 precisam dele para `refresh-references --producer`; o pacote v96 continua aceito no resto.
Em 2026-10-12 (`server/r24-qualidade`): node 86/86 de novo (só um doc mudou nesta caixa).

## Deploy

1. Gere o ZIP como acima. Ele vai ao cliente por canal privado.
2. No cliente: `Expand-Archive`, `ssam-agent.mjs setup --server https://<host> --root C:\SSAM-Agent`,
   `ssam-agent.ps1 start` e `ssam-agent.mjs doctor`. Guia completo em `docs/AGENTE-CLIENTE.md`.
3. Compatibilidade: `odcBridge` e `o11BuiltFor` do `pack.json` têm de bater com o `kernel.json` do servidor.

Os arquivos que também existem em `server/` estão em `../SHARED.md`. Mantenha os dois lados iguais.
`platforms/odc/facade/odc-pipe.mjs` e `o11-bridge.mjs` aqui são só espelho para o teste de deriva.

## O próximo pacote (`server/agent-next`, 18/10/2026)

Pedido do dono de 18/10: o cliente hospedado tem o Manage Dependencies por código e os componentes do ambiente no
`ssam_discover`. Plano, resultado e prova ao vivo: `C:\t\agent-pack-next\PLANO.md`, `RESULTADO.md` e `PROVA-AO-VIVO.md`.

- **Fina O11.** Os quatro arquivos de `kernel/src/Anvil.Bridge.Thin` vêm da linha `fase4-26/a8-agent` com os mesmos blobs:
  - `Dispatch.cs` (a capacidade `refresh_references:add`);
  - `ManageDependencies.cs` (novo, a cópia fina do Manage Dependencies do kernel, só com tipos do Studio);
  - `QuietCommand.cs` (novo);
  - `MergeHandler.cs` (o merge de assinaturas dentro do comando, sem `CompareAndMergeCommands.Merge`).
- **Agente.** `0.3.2`: o agente em inglês de `server/english-agent`. As listas e o fio são os do `0.3.1`.
- **Montagem.** `-NoBuild -Prebuilt`, com estes binários:
  - a bridge ODC v97, o cliente ODC, o `Anvil.Connect`, o `Anvil.RuntimeHook.Agent`, o `node.exe` e a `LICENSE`, que
    são os bytes do pacote de 13/10 (`pack-20261013-040746`, conferidos contra o `pack.json` dele);
  - só a fina é compilada, contra o Service Studio 11.55.92.65269 de `C:\Program Files`.
  O script é `C:\t\agent-pack-next\scripts\prep-pack.ps1`.
- **Pacote (rodada 2, depois da revisão `C:\t\revisoes\agent-pack-next\REVISAO.md`).** `pack-20261018-221719`, 41 entradas.
  - `odcBridge` v97, `o11BuiltFor` 11.55.92, `o11Hook` dev.
  - A fina tem sha256 `8a72236b…3b16`, compilada com `DebugType=none`: sem caminho de PDB e sem texto de produto do
    Manage Dependencies.
  - O ZIP tem sha256 `50da9f1b…f73f`.
  - A varredura de PI saiu sem achados e sem exceções.
  - O `pack-20261018-203453` da rodada 1 está superado.
- **Pacote (rodada 3, depois da re-revisão `C:\t\revisoes\agent-pack-next-2\REVISAO.md`).** `pack-20261018-230621`,
  41 entradas.
  - A fina (`30f8612`, a cópia de `45ba64d7` da linha) fecha só o relatório de erro do Studio, o diálogo de
    dependências e a caixa só com OK. Qualquer outra janela fica, e a resposta é pendente com o título.
  - A fina tem sha256 `2cb18ced…98a4`, 492 032 bytes, compilada com `DebugType=none`.
  - O ZIP tem sha256 `50d390e4…e386`. A varredura de PI saiu sem achados e sem exceções.
  - O `pack-20261018-221719` da rodada 2 está superado.
- **Compatibilidade.** O `kernel.json` não muda. O hub aceita o pacote novo e o de 13/10.
## O pacote do macOS (`server/agent-mac`, 19/10/2026)

Pedido do dono de 19/10: instalar no Mac com UM comando, sem decompilar nada. Plano, resultado e roteiro de prova:
`C:\t\agent-mac\PLANO.md`, `RESULTADO.md` e `PROVA-MAC.md`. Guia do cliente: `docs/AGENTE-MAC.md`.

- **Agente.** O mesmo `0.3.2`, com o ramo `darwin` de verdade (o Windows não muda): bundles do Studio por DLL marcador,
  versão de 4 números pelo `ProductVersion` do assembly de entrada (`lib/pe-version.mjs`), attach sem .NET pelo IPC de
  diagnóstico do .NET (`lib/dotnet-ipc.mjs`, `lib/attach-unix.mjs`), pipe Unix da bridge com um comando por vez
  (`lib/odc-pipe-unix.mjs`), caminhos POSIX (`lib/workspace.mjs`), `doctor --json` com as checagens do Mac
  (`lib/mac-doctor.mjs`), `lib/launcher.mjs` + `agent/ssam-agent.sh` e `agent/install.sh` (bash 3.2, sem sudo).
- **Bridges.** As do pack3, sem recompilar (`odcBridge` v97, `o11BuiltFor` 11.55.92, gancho `dev`): o `kernel.json` não muda.
- **Montagem.** `scripts\agent-pack.ps1 -Platform mac -NoBuild -Prebuilt <pasta>`: sem `.exe`, sem cliente ODC, sem
  `Anvil.Connect`; `pack.json` com `platform: darwin`, o pino do Node (`scripts\node-darwin.json`, sha256 do
  `SHASUMS256.txt` oficial) e sem valores nulos; o tar.gz sai de `scripts\tar-gz.mjs` (0755 nos `.sh`) e a árvore lida de
  volta passa pela mesma varredura de PI. Montagem a partir do pack3: `C:\t\agent-mac\scripts\prep-mac.ps1`.
- **Servidor.** `fase4-26/a8-mac` (C26 e os textos com a pasta POSIX do agente). Só entra na próxima imagem, com OK do dono.
