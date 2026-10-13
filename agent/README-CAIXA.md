# Caixa agent

Agente do SSAM que roda na máquina do cliente: `agent/ssam-agent.mjs` e `.ps1`, bridge ODC e cliente de attach, bridge
O11 fina, gancho de runtime, conector O11 e a montagem do pacote `ssam-agent.zip` com a varredura de PI.
Cópia de `servidor/fase4` (`e7b2119b`) de `C:\Users\andre\SSAM-Hybrid-servidor`, sem edição, atualizada para
`fase4-24/odc1728` (`c48074be`, o 24º envio no ODC Studio 1.7.28, branch `server/r24-odc1728`): bridge ODC `v97`
(compilada contra o 1.7.28), bridge O11 fina com `sc_http` (`ScHttpHandler.cs`) e agente `0.3.1` (`reference-producers`,
`sc_http`, transporte novo e `net.probe`).
Na branch `server/r24-qualidade` (`fase4-24/qualidade`, `3262c49f`) só o guia do cliente muda: `docs/AGENTE-CLIENTE.md`
ganha o parágrafo do registro de qualidade (o agente e o pacote não mudam); `01795e52` não muda nada desta caixa; em
`c24d468d` só a seção "Privacidade" do guia muda; `1b2ce8fe` não muda nada desta caixa.
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
