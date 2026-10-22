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
- **Rodada 2 (depois da revisão `C:\t\revisoes\agent-mac\REVISAO.md`).** Agente `0.3.3` (o servidor só mostra e registra a
  versão; no Windows é o mesmo agente do `0.3.2`).
  - `uninstall` nunca apaga através de link (lstat componente a componente a partir da raiz real) e tira de `private/` só
    o que o registro do setup lista (`private/installed.json`); `install.sh` e o `setup` recusam `/`, o próprio `$HOME`,
    pastas de sistema, `~/Library` e pasta com conteúdo que não seja do pacote (M1, M2).
  - O gancho O11 só recebe a hora de leitores que acertaram os microssegundos em processos do próprio agente
    (`calibrateReaders`); sem nenhum, recusa antes de tocar o Studio (M4).
  - B1 a B7 e B9: pipe Unix sem corrida no fim do prazo, pacote do Mac com LF em qualquer checkout, grafia exata da raiz
    em caminho absoluto, `--credential-file` fora de pastas guardadas com lembrete de apagar, doctor com Studio fechado,
    Node gravado em `private/node` e conferido, `runtimeconfig.json` ilegível para o attach.
  - Pacote `pack-20261019-072205` (`C:\t\agent-mac\pack2`, sha256 `ea3e459c…d4b7`), mesmos binários do pack3, varredura
    de PI sem achados. O pacote da rodada 1 (`C:\t\agent-mac\pack`) fica como está.
## A app Electron do agente (`server/agent-electron`, 20/10/2026)

Pedido do dono de 20/10: o agente como app Electron em segundo plano no Windows e no macOS, com ícone na bandeja, e
ligado a um update server. A caixa `agent/` é o projeto Electron (`package.json`, `src/`, `ui/`, `electron-builder.yml` na raiz; o código do
  agente continua em `agent/`, as bridges em `kernel/` e `platforms/`). README do dono: `README-APP.md`; guia do
  cliente: `docs/AGENTE-APP.md`.

- **Feita com electron-vite e React** (20/10, pedido do dono): `src/main` (principal), `src/preload`, `src/renderer`
  (painel React); `npm run dev` e `npm run build`. Abre com o computador minimizada na bandeja e instala as
  atualizações sozinha (`README-APP.md`).
- **O agente não muda.** A app leva o pacote de `scripts\agent-pack.ps1` (montado com `-NoNode`; no macOS,
  `-Platform mac`) em `resources/pack` e o sincroniza para a pasta do agente (`src/pack-sync.mjs`: o mesmo que
  extrair o pacote novo por cima, sem tocar `private/`, `inbox/`, `odc/` de dados e `o11/`). O agente roda como
  `utilityProcess` do Electron 44 (Node 24.22, com `--use-env-proxy` e `--use-system-ca`), com a linha de comando do
  `.ps1`/`.sh`; parada limpa por `private/agent.stop`; códigos 2, 3 e 4 finais, outros reiniciam com atraso crescente.
- **Update server.** electron-updater com provider `generic`: uma pasta estática por HTTPS com `latest.yml`,
  `latest-mac.yml`, instaladores e blockmaps: `https://dist.ssam.pro/u/ssam-agent` (o `publish` do build, 20/10); `--update-url`
  ou o painel trocam.
  No macOS a atualização automática exige app assinada e notarizada.
- **Provado no Windows (20/10):** `tests/app` 14/14 (sync, setup, conectar, parar limpo com DELETE no hub, credencial
  recusada sem reinício, reinício após kill, doctor, ZIP, inglês); prova ao vivo da app de checkout e da app
  empacotada (`dist/win-unpacked`) contra o hub falso, painel guiado por CDP: setup, pacote `pack-20261020-193613`
  (45 arquivos, v97, 11.55.92, montado de `C:\t\agent-mac\round2\pack3-win` com `-NoBuild -Prebuilt -NoNode`),
  conectado, parar, iniciar, sair com parada limpa. Instalador NSIS `ssam-agent-app-0.1.0-setup.exe` (103 MB) com
  `latest.yml` apontando para `https://dist.ssam.pro/u/ssam-agent`. O DMG e o ZIP do macOS saem do workflow
  `.github/workflows/agent-app-mac.yml` (macos-latest, manual, pacote mac como asset de um Release; `README-APP.md`);
  sem os secrets de assinatura e notarização o DMG sai sem assinatura e o updater não atualiza no macOS.
