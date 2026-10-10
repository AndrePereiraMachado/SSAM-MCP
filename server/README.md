# SSAM Hybrid

Um repositório, um MCP e duas plataformas OutSystems. Abra esta pasta para trabalhar.

```text
facade/             entrada única: ssam e odc, com raízes resolvidas localmente
kernel/             Anvil: núcleo, adaptadores C# O11/ODC, CLIs, scripts e testes
platforms/odc/      bridge ODC, builder, Portal, fachada interna, jobs e evidências locais
docs/               migração e orientação entre os componentes
tests/              integração da raiz unificada
```

Os adaptadores C# permanecem junto do kernel porque compartilham fontes e projetos de compilação.
Os históricos Git originais são ancestrais deste repositório; as referências `source-anvil/*` e `source-odc/*`
também preservam as branches importadas. As alterações locais existentes foram importadas em commits separados.

## Começar

Máquina nova: leia [COMECE-AQUI.md](COMECE-AQUI.md) e rode `scripts\setup-dev.ps1`, que confere as ferramentas,
compila contra os Studios instalados e deixa o MCP pronto.

Com o Service Studio normal já aberto, use `.\ssam connect --lane o11` (ou `--pid <PID>` para selecionar).
A conexão preserva o trabalho em memória e não exige salvar/publicar/reiniciar. Veja
[conexão em runtime e estado da validação](docs/CONEXAO-STUDIO.md).

```powershell
.\ssam doctor
.\odc studio status brief
.\ssam job --lane o11 kernel\tests\jobs\spec-data.json
.\ssam job --lane odc kernel\tests\jobs-odc\data-entity.json
```

A entrada da raiz resolve caminhos CLI relativos a partir do diretório do chamador. No MCP, as ferramentas
mantêm os contratos documentados: jobs de `ssam_job` relativos ao kernel; `studio_deliver` relativo a
`platforms/odc`. Caminhos absolutos funcionam nas duas entradas.

O `.mcp.json` registra `ssam` com `${SSAM_NODE:-...}` e `${SSAM_ROOT:-...}`: sem essas variáveis, valem os caminhos
do checkout original; noutra máquina, `scripts\setup-dev.ps1` as grava. `node scripts/configure-mcp.mjs` ainda
regenera o arquivo com caminhos absolutos desta máquina.
A configuração do cliente precisa usar esta pasta; servidores MCP de uma sessão anterior precisam ser reconectados.

O11: [Manage Dependencies e operações do Service Center](docs/OPERACOES-O11.md) descreve os novos comandos
CLI/MCP, vault, recibos e as limitações de validação viva/SSO. O cliente HTTP ainda precisa dessa homologação.

## Build e testes

Dependências: Node 22+, pnpm, Python, .NET SDK 10, Service Studio e ODC Studio instalados.

```powershell
pnpm --dir platforms/odc install --frozen-lockfile
.\scripts\build.ps1 -NoStart
# SS4: .\scripts\build.ps1 -Lane ss4 -NoStart
pnpm test
dotnet test kernel\tests\Anvil.Tests -c Release
dotnet test kernel\tests\Anvil.Tests.Odc -c Release
```

Os builds das CLIs são sequenciais porque compilam projetos compartilhados. Workers do checkout unificado
usam 14517 (SS4), 14537 (SS5) e 14547 (ODC); bridges dos Studios conservam suas portas/identidades próprias.
A faixa O11 padrão está em `.ssam-workspace.json` (`o11Lane: ss4`, conforme a sessão validada).
Para usar SS5 num comando, defina `$env:ANVIL_LANE='ss5'` (a escolha explícita prevalece sempre). Ao trocar o padrão,
regenere o MCP. Sem `ANVIL_LANE` e sem `o11Lane`, a fachada e a descoberta recusam em vez de assumir uma faixa.

Leitura: [regras da sessão de app](AGENTS.md), [desenvolvimento do SSAM](docs/DESENVOLVIMENTO.md), [guia do kernel](kernel/AGENTS.md),
[guia ODC](platforms/odc/docs/HANDOFF.md), [registro da migração](docs/MIGRACAO.md),
[leitura e referências](docs/USOS-REFERENCIAS.md), [leitura residente e em lote](docs/LEITURA-RAPIDA.md),
[fechamento da validação](docs/FECHAMENTO-REFERENCIAS.md).

Depuração de servidor em processo próprio, nas duas plataformas: [debugger headless](docs/DEBUGGER-HEADLESS.md),
via `ssam debug` ou MCP `ssam_debug`. Veja no guia as provas locais e a validação viva ainda pendente.

## URLs para apps e telas

Use `ssam app <App> [Tela]` / `odc app <App> [Tela]` ou MCP `ssam_app_url`. Entregue sempre o link do app e da tela trabalhada para a LLM e o usuário. Sem tela, o endereço abre a home configurada. Prefira `appLinks` das respostas; se faltar a origem, informe `--environment` ou use a sessão conectada do módulo. Não escolha outro tenant por default. Montar a URL não comprova publicação/interação. Contrato: `docs/URLS-APPS.md` da raiz.
