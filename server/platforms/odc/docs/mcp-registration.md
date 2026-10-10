# Registrar a fachada como MCP

A fachada `facade\mcp.mjs` serve, num servidor stdio só, as ferramentas `studio_*` (bridge e builder) e
`odc_*` (APIs REST públicas do ODC), mais `hybrid_tenants`. Registrar é configuração persistente do cliente,
feita pelo operador. Nenhum registro é criado automaticamente por este repositório.

Node: `odc.cmd` usa `C:\Users\andre\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe`
quando não há Node no sistema. O registro precisa apontar para um executável Node 22+ e para o caminho absoluto de
`facade\mcp.mjs`. A variável opcional `SSAM_HYBRID_ODC_TENANT` escolhe o tenant das ferramentas `odc_*`; sem ela,
vale `default` de `tenants.json`.

## Claude Code, escopo de projeto (`.mcp.json` na raiz do repositório)

```json
{
  "mcpServers": {
    "ssam-hybrid-odc": {
      "command": "C:\\Users\\andre\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\bin\\node.exe",
      "args": ["C:\\Users\\andre\\SSAM-Hybrid-ODC\\facade\\mcp.mjs"],
      "env": { "SSAM_HYBRID_ODC_TENANT": "personal-nv0s5uly.outsystems.dev" }
    }
  }
}
```

Abrir a pasta no Claude Code passa a oferecer o servidor; o cliente pede aprovação na primeira vez.

## Codex (`~/.codex/config.toml`)

```toml
[mcp_servers.ssam-hybrid-odc]
command = 'C:\Users\andre\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
args = ['C:\Users\andre\SSAM-Hybrid-ODC\facade\mcp.mjs']
```

O registro `mcp_servers.odc3` feito em 15/09 continua a funcionar pelo shim deixado em
`C:\Users\andre\.codex\visualizations\2026\09\07\01a07cb6-1c1f-7df1-8a1a-3ee982251a4b\SSAM-Apps-SS4\ODC-Portal-API\runtime\odc3-host.mjs`;
ele expõe só a pista Portal. Quando este registro novo
estiver ativo, o antigo pode ser removido com `node portal\runtime\register-codex-odc3.mjs remove --codex <caminho>`.

## `ssam`: as duas faixas num servidor só

`facade\ssam.mjs` serve, no mesmo servidor stdio, as ferramentas do ODC (as de `facade\mcp.mjs`, relatadas tal como
são) **e** as da faixa O11 (`context`, `propose`, `continue`, `status` do `scripts\ssam_app.py` do Anvil), mais
`o11_job` (`scripts\run_job.py` sobre um fixture) e `ssam_doctor` (as duas faixas lado a lado). Cada chamada é
repassada à faixa dona, com os gates, o journal e as palavras de autorização dela; a fachada não acrescenta passo
nenhum. Um nome que existisse nas duas faixas ganharia o argumento `lane`; hoje nenhum se repete.

Registre **ou** `ssam-hybrid-odc` (só ODC) **ou** `ssam` (as duas faixas), não os dois: as ferramentas `studio_*`
apareceriam duplicadas. `ANVIL_ROOT` escolhe a raiz do Anvil (padrão `C:\Users\andre\Anvil`) e `ANVIL_LANE` a faixa
do O11: uma escolha explícita (`ss4`|`ss5`) prevalece; sem ela a fachada usa `o11Lane` de `.ssam-workspace.json` da raiz
(hoje `ss4`, a sessão validada) e, sem nenhum dos dois, recusa em vez de assumir (regra única em
`platforms/odc/facade/workspace.mjs`, desde 23/09/2026; o launcher `ssam.cmd` da raiz injeta o mesmo valor). `SSAM_PYTHON`
aponta o interpretador quando não há `python` no PATH.

```json
{
  "mcpServers": {
    "ssam": {
      "command": "C:\\Users\\andre\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\bin\\node.exe",
      "args": ["C:\\Users\\andre\\SSAM-Hybrid-ODC\\facade\\ssam.mjs", "mcp"],
      "env": { "ANVIL_ROOT": "C:\\Users\\andre\\Anvil", "ANVIL_LANE": "ss4",
               "SSAM_HYBRID_ODC_TENANT": "personal-nv0s5uly.outsystems.dev" }
    }
  }
}
```

```toml
[mcp_servers.ssam]
command = 'C:\Users\andre\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
args = ['C:\Users\andre\SSAM-Hybrid-ODC\facade\ssam.mjs', 'mcp']
env = { ANVIL_ROOT = 'C:\Users\andre\Anvil', ANVIL_LANE = 'ss4' }   # ss5 só se essa for a faixa escolhida para a sessão
```

## Verificar

O servidor ODC e o proxy `ssam` expõem `studio_manifest` (candidato externo → manifesto) e `studio_deliver`
(feature C# ou job do kernel → snapshot/build/preview/merge). `ssam_job` continua sendo uma prova headless.
Detalhes e limites: [INTEGRACAO-KERNEL-ENTREGA.md](INTEGRACAO-KERNEL-ENTREGA.md). Um servidor MCP residente
precisa ser reiniciado/reconectado para anunciar os novos schemas e ferramentas.

```powershell
.\odc.cmd mcp            # deve ficar aguardando JSON-RPC no stdin; Ctrl+C para sair
.\ssam.cmd mcp           # idem, com as ferramentas das duas faixas
node --test facade\tests\mcp.test.mjs
node --test facade\tests\lanes.test.mjs
```

O teste liga um cliente real do SDK ao servidor por stdio, lista as ferramentas, lê `hybrid_tenants`,
`odc_status` e `studio_doctor`, e só consulta o Studio se ele estiver aberto com o bridge anexado.
`lanes.test.mjs` monta a linha de comando de cada verbo nas duas faixas sem executar nada, sobe o servidor `ssam` e
confere que as ferramentas das duas faixas estão lá.
