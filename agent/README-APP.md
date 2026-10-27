# A app Electron do agente (para o dono)

O candidato Windows agora usa o núcleo Native AOT em `native/Ssam.Agent`. Gere-o com
`npm run native:build -- win-x64` e informe `--native <ssam-agent.exe>` ao build Windows.
O pacote gerado contém apenas o executável, bridges, helpers e metadados; o runtime
permanece na instalação e os dados permanecem na raiz configurada. Situação, comandos
e limitações de homologação: [NUCLEO-NATIVO.md](docs/NUCLEO-NATIVO.md).

O agente de `docs/AGENTE-CLIENTE.md` e `docs/AGENTE-MAC.md` entregue como app de desktop em segundo plano: ícone na
bandeja (Windows) ou na barra de menus (macOS), sem janela até a pessoa abrir o painel, o agente iniciado junto e
mantido no ar, e a app atualizada a partir de um update server do dono. Guia do cliente: `docs/AGENTE-APP.md` (em
inglês, como todo texto que o licenciado lê).

A caixa `agent/` é o projeto Electron, no layout do **electron-vite** (`electron.vite.config.mjs`):

- `src/main/index.mjs`: o processo principal; `src/main/core/` os módulos puros (sync do pacote, settings, estado do
  agente, modelo da tray e do updater, supervisor); `src/main/electron/` a cola com o Electron (utility process, tray,
  janela, updater, log);
- `src/preload/index.mjs`: a ponte `window.ssam` (compilada para CommonJS, `out/preload/index.cjs`, porque o painel
  roda em sandbox);
- `src/renderer/`: o painel, uma app **React** (`src/main.jsx`, `App.jsx`, `components/`, `styles.css`);
- `assets/` e `build/` (ícones), `scripts/build.mjs`, `electron-builder.yml`; o código do agente Node fica em `agent/`,
  as bridges em `kernel/` e `platforms/`, os testes da app em `tests/app/`.

`npm run build` (electron-vite) escreve `out/main`, `out/preload` e `out/renderer`; é isso que entra no asar, com
`assets/` e `build/icon.png`. Este README e o resto da caixa chegam ao cliente só pelo pacote.

Dois comportamentos padrão, pedidos pelo dono em 20/10: a app **abre com o computador, minimizada na bandeja**
(login item do usuário, com `--hidden`; registrado a cada abertura da app instalada; `autostart: false` em
`settings.json` ou o painel desligam) e **uma atualização instala sozinha** 15 s depois de baixada (o agente para
limpo, a app reinicia em silêncio e o agente volta; `updateAutoInstall: false` em `settings.json` faz esperar pelo
botão "Restart to update now" ou pela saída da app).

## O que a app faz e o que não muda

- O código do agente NÃO muda. A app leva o pacote (`resources/pack`, o mesmo `ssam-agent.zip` ou tar.gz de
  `scripts/agent-pack.ps1`, montado com `-NoNode`) e o sincroniza para a pasta do agente (`src/pack-sync.mjs`): o mesmo
  resultado de extrair o pacote novo por cima, sem tocar `private/`, `inbox/`, `odc/` de dados e `o11/`.
- O agente roda como `utilityProcess` do Electron (`src/electron/runtime.mjs`), com a linha de comando de sempre
  (`ssam-agent.mjs run --root <pasta> --log-file <log>`) e as opções `--use-env-proxy` e `--use-system-ca` do Node que o
  Electron traz (44.9.2 = Node 24.22). Nada de node.exe no pacote.
- Parada limpa por `private/agent.stop` (o servidor recebe o DELETE), força depois de 5 s. Códigos 2, 3 e 4 são finais
  (ícone vermelho, notificação, nada reinicia); outro fim reinicia com 5, 10, 20, 40 e 60 s.
- `setup` e `doctor` são as funções do próprio agente, importadas da cópia da pasta (`src/supervisor.mjs`); a
  credencial entra pela entrada padrão do setup, nunca por argumento ou arquivo.
- Painel (`ui/`) isolado (contextIsolation, sandbox, CSP), só fala com o processo principal por `src/preload.cjs`.

## Compilar

Node 24 com npm, na raiz da caixa (`agent/`):

```powershell
npm ci
npm test                       # node --test tests/app/*.test.mjs (usa agent/tests/fixtures: hub falso, raiz, inglês)
npm run dev                    # electron-vite dev: a app com o painel React servido pelo Vite (hot reload)
npm run build                  # electron-vite build: src/ -> out/ (o scripts/build.mjs faz isso antes do instalador)
npm run icons                  # regrava build/icon.png e assets/tray/*.png (já versionados)
node scripts/build.mjs --platform win --pack <ssam-agent.zip>
node scripts/build.mjs --platform mac --pack <ssam-agent-mac.tar.gz>     # só num Mac
```

Sem `--update-url`, o build publica para o update server do dono, `https://dist.ssam.pro/u/ssam-agent` (o `publish`
de `electron-builder.yml`); `--update-url` ou `SSAM_UPDATE_URL` trocam, por exemplo para um teste local.

- O pacote: `scripts\agent-pack.ps1 ... -NoNode` (Windows) ou `-Platform mac` (macOS). O script de build extrai o
  pacote em `pack/`, confere cada sha256 do `pack.json` e recusa um pacote com `agent/node/` ou da outra plataforma.
  `--pack-only` para depois disso; `--no-updates` gera uma app que nunca se atualiza (sem `publish`).
- A URL do update server vai para `resources/app-update.yml` (o electron-updater lê de lá). `SSAM_UPDATE_URL` no
  ambiente vale como `--update-url`.
- Saída em `dist/`: Windows `ssam-agent-app-<versão>-setup.exe`, `.blockmap` e `latest.yml`; macOS `.dmg`, `.zip`,
  `.blockmap` e `latest-mac.yml` (arm64 e x64).
- Um instalador Windows sem assinatura instala (SmartScreen avisa) e atualiza. **No macOS a atualização automática só
  funciona com a app assinada (Developer ID) e notarizada**: `CSC_LINK`/`CSC_KEY_PASSWORD` e as variáveis de notarização
  do electron-builder no build. Sem isso o DMG serve para instalar à mão e a app diz "Updates are off" ou falha na
  instalação do update.

## O update server: `https://dist.ssam.pro/u/ssam-agent`

A configuração do updater (a do dono, 20/10/2026) é o `publish` de `electron-builder.yml`:

```yaml
publish:
  provider: generic
  url: https://dist.ssam.pro/u/ssam-agent
  channel: latest
```

É uma pasta estática servida por HTTPS: `https://dist.ssam.pro/u/ssam-agent/` tem de responder, como arquivos
estáticos, `latest.yml`, `latest-mac.yml`, os instaladores e os `.blockmap` deles. Publicar uma versão:

1. Suba `version` em `package.json` (semver; o updater só instala uma versão maior).
2. Monte o pacote do agente daquela versão e rode o build de cada plataforma (sem `--update-url`: a URL acima).
3. Copie `dist/` para a pasta servida em `/u/ssam-agent`, mantendo os nomes: `latest.yml`, `ssam-agent-app-<v>-setup.exe`
   e `.exe.blockmap` (Windows); `latest-mac.yml`, os `.zip` e `.zip.blockmap` e os `.dmg` (macOS). O `latest*.yml` tem o
   sha512 de cada arquivo; a app recusa um arquivo que não bata. `builder-debug.yml` não precisa ir.
4. A app instalada pergunta ao servidor 20 s depois de abrir e a cada 6 h (`updateCheckHours` em `settings.json` da
   app), baixa em segundo plano e instala quando a pessoa escolhe "Restart to update" (o agente para limpo antes) ou ao
   sair da app.

Um jeito de hospedar `dist.ssam.pro` no Coolify (Traefik): um serviço de arquivos estáticos (a imagem `nginx:alpine`
ou `caddy` com um volume montado na pasta que tem `u/ssam-agent/`) com o domínio `dist.ssam.pro`; o Traefik do Coolify
cuida do TLS. Nada do servidor SSAM precisa mudar: o update server é só HTTP estático, e a app fala com ele à parte do
canal do agente. Conferência rápida: `curl -I https://dist.ssam.pro/u/ssam-agent/latest.yml` responde 200.

Para testar em casa: `SSAM_UPDATE_URL=http://127.0.0.1:<porta>/` (só loopback aceita http) e uma pasta servida por
`npx serve` ou `python -m http.server`; num checkout (`npm start`), o electron-updater só confere com um
`dev-app-update.yml` ao lado do `package.json`.

## A build do macOS pelo GitHub Actions

O electron-builder só gera o DMG e o ZIP do updater num macOS. O workflow `.github/workflows/agent-app-mac.yml`
(`macos-latest`, disparo manual) faz isso a partir do pacote mac de `scripts\agent-pack.ps1 -Platform mac`:

1. Envie a branch: `git push origin server/agent-electron`.
2. Ponha o pacote mac num Release do repositório (rascunho ou pré-release serve), tag `agent-pack-mac`, com o asset
   `ssam-agent-mac.tar.gz` (o da rodada 2 está em `C:\t\agent-mac\pack2\`, `pack-20261019-072205`, 33 arquivos):
   `gh release create agent-pack-mac C:\t\agent-mac\pack2\ssam-agent-mac.tar.gz --prerelease --title "macOS agent pack" --notes "pack-20261019-072205"`
   (ou pela página Releases; para outro pacote, suba o asset de novo com `gh release upload agent-pack-mac <arquivo> --clobber`).
3. Em Actions, "Agent app (macOS build)", Run workflow, branch `server/agent-electron` (os campos já vêm com o tag,
   o nome do asset e `https://dist.ssam.pro/u/ssam-agent`).
4. O workflow publica a build na release **`app-v<versão>`** (pré-release; um build novo da mesma versão substitui os
   arquivos): `ssam-agent-app-<v>-mac-arm64.dmg`, `-x64.dmg`, os `.zip`, os `.blockmap` e `latest-mac.yml`. Os mesmos
   arquivos ficam no artefato `ssam-agent-app-mac` da execução. Copie tudo para `https://dist.ssam.pro/u/ssam-agent/`
   ao lado dos arquivos do Windows. A release `agent-pack-mac` é só a ENTRADA (o pacote do agente), não a app.

**Escolha do dono (20/10/2026): o DMG sai sem assinatura.** Sem o secret `CSC_LINK`, o workflow roda o electron-builder
com `CSC_IDENTITY_AUTO_DISCOVERY=false` e nada é assinado; não há passo de assinatura a configurar. Num Mac, a app abre
com o contorno do Gatekeeper (botão direito no `SSAM Agent.app`, Abrir, uma vez) e NÃO se atualiza sozinha: cada
versão nova vai à mão, pelo DMG. Assinatura e notarização só acontecem quando os secrets existirem no repositório: `CSC_LINK` (o certificado Developer
ID Application como `.p12` em base64) e `CSC_KEY_PASSWORD`; `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` e
`APPLE_TEAM_ID` (notarização; o workflow passa `--notarize` ao build). **Sem eles o DMG sai sem assinatura: o Gatekeeper
avisa ao abrir (botão direito, Abrir) e o electron-updater NÃO instala atualizações no macOS**; a app serve, mas
cada versão nova vai à mão. O `npm test` roda no runner antes do build (no macOS a raiz do teste fica numa pasta
oculta da home, porque o setup do agente recusa `/var/folders`).

## Pastas da app e do agente

- A app: `%LOCALAPPDATA%\Programs\ssam-agent-app` (NSIS por usuário, sem administrador) ou `/Applications/SSAM Agent.app`.
- Dados da app (`settings.json`: pasta do agente, autostart, update server; `app.log`): `app.getPath('userData')`,
  `%APPDATA%\ssam-agent-app` ou `~/Library/Application Support/ssam-agent-app`.
- A pasta do agente: a dos guias (`%USERPROFILE%\SSAM-Agent`, `~/SSAM-Agent`), escolhida no painel; as regras do
  `setup` do agente valem (sem espaço, fora de `%LOCALAPPDATA%`, no Mac fora das pastas guardadas).

## Testes e prova

- `tests/pack-sync.test.mjs`, `tests/models.test.mjs`, `tests/zip.test.mjs`: módulos puros.
- `tests/supervisor.test.mjs`: processos node de verdade contra o hub falso dos testes do agente: sync, setup, conectar,
  segundo start, parada limpa (DELETE no hub), credencial recusada (código 2, sem reinício), reinício depois de um kill,
  doctor em JSON.
- `tests/english.test.mjs`: nenhum texto em português em `src/`, `ui/`, `scripts/`, na configuração do build e em
  `docs/AGENTE-APP.md`.
- Prova ao vivo no Windows (20/10/2026): `electron .` com um hub falso, painel guiado por CDP: setup pelo painel,
  pacote sincronizado (45 arquivos), agente 0.3.3 como utility process com as duas opções do Node, conectado, parar e
  iniciar de novo, sair da app com parada limpa (o hub viu um DELETE por hello). Instalador NSIS gerado em `dist/`.
