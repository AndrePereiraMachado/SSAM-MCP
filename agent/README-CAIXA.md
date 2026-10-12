# Caixa agent

Agente do SSAM que roda na máquina do cliente: `agent/ssam-agent.mjs` e `.ps1`, bridge ODC e cliente de attach, bridge
O11 fina, gancho de runtime, conector O11 e a montagem do pacote `ssam-agent.zip` com a varredura de PI.
Cópia de `servidor/fase4` (`e7b2119b`) de `C:\Users\andre\SSAM-Hybrid-servidor`, sem edição, atualizada para
`servidor/fase4-24` (`a415531d`, 24º envio, branch `server/r24`): bridge ODC `v96`, bridge O11 fina com `sc_http`
(`ScHttpHandler.cs`) e agente `0.3.1` (`reference-producers`, `sc_http`, transporte novo e `net.probe`).
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

## Deploy

1. Gere o ZIP como acima. Ele vai ao cliente por canal privado.
2. No cliente: `Expand-Archive`, `ssam-agent.mjs setup --server https://<host> --root C:\SSAM-Agent`,
   `ssam-agent.ps1 start` e `ssam-agent.mjs doctor`. Guia completo em `docs/AGENTE-CLIENTE.md`.
3. Compatibilidade: `odcBridge` e `o11BuiltFor` do `pack.json` têm de bater com o `kernel.json` do servidor.

Os arquivos que também existem em `server/` estão em `../SHARED.md`. Mantenha os dois lados iguais.
`platforms/odc/facade/odc-pipe.mjs` e `o11-bridge.mjs` aqui são só espelho para o teste de deriva.
