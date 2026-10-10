# Comece aqui

Este guia é para a pessoa que prepara uma máquina Windows nova com o SSAM Hybrid.
Sessão de LLM não precisa dele: ela trabalha só pelo MCP `ssam` (regras no `AGENTS.md`).

O SSAM Hybrid deixa uma LLM (Claude Code, por exemplo) trabalhar em apps OutSystems O11 (Service Studio 11) e ODC
(ODC Studio e APIs públicas), num repositório e num servidor MCP. A LLM lê o modelo, monta a mudança fora do Studio e
entrega por merge nativo, com conferência de hash. O SSAM se conecta ao Studio já aberto e não salva, não publica e não
fecha nada para isso. Publicar e escrever dados sempre exige as suas palavras de autorização.

## Pré-requisitos

| Ferramenta | Versão | Observação |
| --- | --- | --- |
| Windows | 10 ou 11 | O PowerShell 5.1 do Windows basta. |
| Git | recente | Para clonar e atualizar. |
| .NET SDK | 10 | Compila os projetos net8.0 e net10.0 e roda as CLIs. |
| Node.js | 22 ou mais novo | Com corepack, se possível. |
| Python | 3.11 ou mais novo | Um Python de verdade, não o atalho da Microsoft Store. |
| Service Studio 11 | a sua | Opcional. Sem ele, a faixa O11 fica de fora. |
| ODC Studio | a sua | Opcional. Sem ele, a faixa ODC fica de fora. |

O primeiro build baixa pacotes de `nuget.org` e `registry.npmjs.org`. Com proxy, configure-o antes.
O script oferece instalar com `winget` o que faltar (Git, .NET SDK 10, Node.js LTS, Python 3.12) e pergunta antes.
Os Studios vêm do instalador da OutSystems; o script só os encontra pelo registro do Windows.

## O comando

```powershell
git clone https://github.com/AndrePereiraMachado/SSAM-Hybrid.git
cd SSAM-Hybrid
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-dev.ps1
```

`-ExecutionPolicy Bypass` vale só para esse comando. O script pergunta o seu tenant ODC e o host O11, sem valor padrão
(por exemplo `minhaempresa.outsystems.dev` e `minhaempresa.outsystemscloud.com`). Enter deixa em branco.

| Opção | Efeito |
| --- | --- |
| `-DryRun` | Só mostra o que faria. |
| `-Yes` | Não pergunta. Nunca substitui um servidor `ssam` já registrado no Claude Code. |
| `-SkipInstall` | Não instala nada com winget; só confere. |
| `-SkipBuild` | Não compila. |
| `-SkipMcp` | Pula tenant, host e MCP. |
| `-NoUserEnv` | Não grava variáveis de usuário; usa os valores só nesta execução. |
| `-SkipDoctor` | Não roda o doctor no fim. |
| `-OdcTenant`, `-O11Host` | Respostas das duas perguntas. |

Pode rodar de novo quando quiser: o que já está certo fica como está.

## O que o script faz

1. Confere as ferramentas e avisa se o Smart App Control está ligado.
2. Grava variáveis do seu usuário (nunca da máquina): `SSAM_ROOT`, `SSAM_NODE`, `SSAM_PYTHON`, `ANVIL_AUTHORITY_DIR`
   (`%USERPROFILE%\.anvil\authority`), `ANVIL_STUDIO_DIR` e, fora da pasta padrão, `ANVIL_ODC_STUDIO_DIR`. Pergunta antes de trocar um valor.
3. Instala as dependências JavaScript com pnpm e lockfile congelado.
4. Compila contra os Studios instalados, sem worker: CLI O11, CLI ODC, builder, bridge e cliente da bridge ODC.
5. Grava tenant e host em `.ssam-local.json` (fora do Git), confere o `.mcp.json` e, se você quiser, registra o `ssam`
   no escopo de usuário do Claude Code.
6. Roda o doctor. O registro de cada execução fica em `.local\setup\setup-<data>.log`.

O script não abre, não fecha e não altera nenhum Studio, não inicia worker e não grava nada em `HKLM`.

## Conectar

Abra um terminal novo (para ler as variáveis gravadas) e, se o Claude Code já estava aberto, reabra-o.
Abra o Service Studio e/ou o ODC Studio normalmente e faça login.

No Claude Code, aberto na pasta do repositório, aprove o servidor `ssam` do `.mcp.json`. Recuse `ssam-headless-selected`
e `ssam-functional`: só existem no checkout operacional original. Na conversa, `ssam_doctor` mostra o estado e
`ssam_connect` anexa os Studios abertos, sem salvar, publicar ou reiniciar nada.

Pelo terminal, o mesmo: `.\ssam connect --lane o11` ou `--lane odc` (com mais de um Studio, `--pid <PID>`), depois
`.\ssam doctor`. Detalhes em `docs\CONEXAO-STUDIO.md`.

### Portal ODC (opcional)

As ferramentas `odc_*` usam um API Client do ODC guardado no Gerenciador de Credenciais do Windows. Para guardar o seu,
rode e responda no prompt privado que abrir:

```powershell
powershell -File platforms\odc\portal\runtime\windows-api-client-credential.ps1 -Mode bootstrap -Origin https://minhaempresa.outsystems.dev
```

Nenhuma credencial vai para o repositório, para o chat ou para um argumento de linha de comando.

## Problemas comuns

**O Windows bloqueia as DLLs (Smart App Control).** O attach falha com `0x800711C7` ou `0xc0e90002`; o Visualizador de
Eventos mostra CodeIntegrity 3033 ou 3077. As DLLs recém-compiladas não têm assinatura. O caminho assinado está em
`docs\CONEXAO-ODC-ASSINADA.md` e exige um certificado público de assinatura de código. Desligar o Smart App Control é
decisão sua ou da TI (só volta reinstalando o Windows). O script não muda política de segurança.

**Um Studio não aparece.** O script procura `OutSystems Service Studio 11` e `OutSystems ODC Studio` em `HKLM` e
`HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall` (`InstallLocation`). Fora do comum, aponte
`ANVIL_STUDIO_DIR` ou `ANVIL_ODC_STUDIO_DIR` para a pasta do executável.

**Python da Microsoft Store** (`Python was not found`, código 9009). É o atalho em `%LOCALAPPDATA%\Microsoft\WindowsApps`.
Instale um Python (`winget install Python.Python.3.12`) ou aponte `SSAM_PYTHON`; o atalho sai em Configurações,
Aplicativos, Aliases de execução de aplicativo.

**Build falha com CS1705** (`System.Text.Json, Version=10.0.0.0` maior que a referenciada). O Studio traz bibliotecas
mais novas que o SDK para net8.0. A correção está em `kernel\Directory.Build.targets` e
`platforms\odc\studio\Directory.Build.targets`: confira se existem e se o checkout está atualizado.

**Uma DLL está em uso (MSB3027).** Um worker deste checkout roda com a DLL antiga. Pare-o
(`python kernel\scripts\anvil_worker.py stop` e `python kernel\scripts\odc_worker.py stop`) e rode o script de novo.

**O servidor MCP não sobe no Claude Code.** Abra um terminal novo e reinicie o Claude Code, para ler `SSAM_NODE` e
`SSAM_ROOT`; confira com `claude mcp list`. Com `-NoUserEnv` as variáveis não foram gravadas: rode sem essa opção.

**O tenant está errado.** Vem de `.ssam-local.json`. Rode o script com `-OdcTenant <seu tenant>` ou edite o arquivo.
`SSAM_HYBRID_ODC_TENANT` no ambiente tem prioridade.

## Onde ler mais

- `README.md`: visão geral; `AGENTS.md`: regras da sessão de app;
- `docs\DESENVOLVIMENTO.md`: toolchain, build, testes e guias dos componentes, para quem desenvolve o SSAM;
- `docs\CONEXAO-STUDIO.md` e `docs\CONEXAO-ODC-ASSINADA.md`: conexão com o Studio e runtime ODC assinado.
