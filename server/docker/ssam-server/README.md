# ssam-server em Docker

O MCP hospedado do SSAM (`ssam serve` sem `--local-studios`) numa imagem Linux que sobe num servidor limpo. Nada do host é montado.

Os Studios entram no build por uma de duas formas, cada uma com o mesmo suporte:

- o instalador oficial;
- um bundle feito a partir de um Studio instalado em qualquer máquina (`studio-bundle.ps1` ou `studio-bundle.sh`).

O resultado é o mesmo nas duas formas. O instalador é o preferido quando está presente.

## O que vai na imagem

- O MCP (Node 24, `facade/ssam.mjs serve`) e o runtime .NET 10.
- O kernel O11 (`anvil.dll`), o kernel ODC (`anvil-odc.dll`) e o builder/leitor ODC (`ODC3.Builder.dll`), cada um compilado num estágio próprio.
- Os kernels são `net8.0` com `RollForward=Major` e rodam no .NET 10, como nos hosts Windows. A imagem não tem .NET 8 de propósito: com ele, o kernel O11 pegaria o 8 e não acharia o `System.Text.Json` 10 que o Service Studio 11.55.91 traz.
- `/studio/o11`: 145 arquivos (125 MB) do Service Studio 11, a lista de `studio-o11.txt`.
- `/studio/odc`: 196 arquivos (cerca de 176 MB) do ODC Studio, a lista de `studio-odc.txt`.
- Em cada pasta, `libe_sqlite3.so` aponta para o `libsqlite3` da distribuição. Os instaladores só trazem o `e_sqlite3.dll` do Windows.
- A imagem contém binários da OutSystems, e o bundle também. Guarde os dois num registro ou armazenamento privado: valem as mesmas condições de licença dos Studios.

### Como as listas foram feitas

- Sementes: as referências de compilação de `Anvil.Core.csproj`, `Anvil.Core.Odc.csproj` e `Builder.csproj`, mais o que o código carrega por caminho ou nome. São os `Plugins/**/ServiceStudio.Plugin.*.dll`, os `OutSystems.Model.Plugin.*.dll`, os `OutSystems.Model.Implementation.*.dll`, o `ServiceStudio.BuiltInBehaviors.dll` e o `OutSystems.ServiceStudio.Encryption.dll`.
- Daí, o fecho das referências de assembly, mais todo assembly da pasta nomeado por uma string literal desses arquivos.
- Fica de fora o que o runtime .NET 10 já tem. Fica dentro a cópia do Studio de um assembly do framework acima do targeting pack net8 (`System.Text.Json` e outros, 10.0), que o `kernel/Directory.Build.targets` usa para compilar.
- Ficam de fora as DLLs nativas de Windows, a UI, o Chromium, o atualizador, os idiomas e o `ODCStudio.exe`. Sem o exe, a versão do IDE vem do `ServiceStudio.Framework.dll`, com o mesmo valor. No Linux, o `FileVersionInfo` não lê exe nativo.
- Prova no Windows: os kernels compilados contra só esses arquivos dão o mesmo resultado que a instalação completa. Foram 6 jobs O11 e 9 ODC, `verify-catalog`, `inspect` e o `list`/`inspect` do builder. No O11, a prova também saiu direto do instalador.
- Para mudar de versão do Studio, refaça as listas com a mesma regra e rode `prova-extracao.ps1`.

## O que NÃO vai na imagem

- Nenhum nome de cliente (regra do dono, 07/10/2026: conteúdo de cliente pode ir, nome de cliente não).
  - Os termos ficam em `docker/ssam-server/client-denylist.json`, que o `.dockerignore` deixa de fora.
  - O `.dockerignore` tira testes, evidências, histórico de trabalho em clientes, as capturas de cliente e a lista do publicador.
  - Os exemplos provados ODC rodam sobre `kernel/tests/fixtures/odc/insurance-reactive-r8.oml`, o fixture da faixa anonimizado pelo próprio kernel (`scripts/anonymize-odc-fixture.mjs`).
  - Guarda: `node --test tests/hosted-image-denylist.test.mjs` em `platforms/odc/facade` lê exatamente o contexto do build (as regras do `.dockerignore`, como o Docker) e falha em qualquer termo. `NeutralOdcFixtureTests` (kernel ODC) lê cada texto do modelo do fixture.
- O motor XIF das extensões .NET O11. Ele é .NET Framework 4.7.2 x86 e só roda no Windows, e o Integration Studio não entra na imagem.
- Estado. Ficam em volumes:
  - `/data/server`: tokens (só o SHA-256 de cada um), workspaces dos clientes, auditoria e log.
  - `/data/friction`: os atritos.
  - `/data/odc-features`: o cache de features do ODC Studio.
- O `.env`, que o `.dockerignore` deixa fora do contexto.

## Servidor limpo, passo a passo

1. Studios: para cada um, coloque em `docker/installers/` uma de duas entradas (veja `docker/installers/README.md`).
   - O instalador oficial: `ServiceStudio-11.55.92.65269.exe` e `ODCStudio-1.7.28.10850.exe`, as versões dos Studios dos clientes.
   - Ou um bundle feito numa máquina com o Studio instalado: `studio-bundle.ps1 [-Lane o11]` no Windows, `studio-bundle.sh --lane odc|o11` no WSL ou Linux. Gera `odc-studio-1.7.28.10850.tar.gz` (ou `o11-studio-...`) e o `.sha256`. Fixe esse hash em `*_BUNDLE_SHA256`.
   - Hoje o ODC 1.7.28 só entra assim: o instalador dele não se consegue baixar.
   - Outra versão: ajuste `SERVICE_STUDIO_INSTALLER`/`ODC_STUDIO_INSTALLER` e os SHA256 no `.env`.
   - Download no build: `*_URL`, com o SHA256 obrigatório.
2. Configuração: `cp .env.example .env` e preencha `NGROK_DOMAIN` e `NGROK_AUTHTOKEN`.
3. Build: `docker compose build`.
   - O estágio `studio-*` só lê o instalador, nunca o executa: confere o SHA256 e extrai a lista.
   - Sem instalador, o estágio abre o bundle com `studio_bundle.py`. Confere o SHA256 do bundle e cada arquivo contra o `SHA256SUMS` dele, e põe a mesma lista em `/studio/<faixa>`.
   - O leitor padrão é `nsis_extract.py`, que usa só a biblioteca padrão do Python. `STUDIO_EXTRACTOR=7z` usa o 7-Zip da distribuição.
4. Subir: `docker compose up -d`. O `ssam-server` escuta em `127.0.0.1:7310` do host, e o `tunnel` (ngrok) o publica em `https://$NGROK_DOMAIN`.
5. Token de cliente: `docker compose run --rm ssam-admin server-token issue --customer "Nome" --days 30 --lanes "odc,o11"`.
   - O token aparece uma única vez. Listar: `... ssam-admin server-token list`. Revogar: `... server-token revoke --id <id>`.
6. Cache de features do ODC. O modelo ODC consulta o provedor de features (agregados, por exemplo), e o instalador não traz esse cache.
   - Copie o `Features.xml` (e o `FeaturesOverride.xml`, se houver) de `%LocalAppData%\OutSystems\ODC Studio` de uma máquina onde o ODC Studio já entrou no tenant.
   - Comando: `docker compose cp Features.xml ssam-server:/data/odc-features/`.
7. Túnel: o cliente usa `https://$NGROK_DOMAIN/mcp` com o token. A página de inspeção do ngrok fica em `127.0.0.1:4040`.

Sem compose:

```bash
docker buildx build -f docker/ssam-server/Dockerfile --build-context installers=docker/installers -t ssam-server .
docker run --init -d --name ssam-server -p 127.0.0.1:7310:7310 -v ssam-server-state:/data/server -v ssam-friction:/data/friction -v ssam-odc-features:/data/odc-features -e SSAM_PUBLIC_HOST=<domínio do túnel> ssam-server
```

## Extensões .NET O11 (XIF) no servidor hospedado

- `o11_extension` é recusado antes de rodar qualquer coisa com:
  - `code: "HOSTED_UNAVAILABLE"`;
  - `cause: "XIF_ENGINE_WINDOWS_ONLY"`;
  - o motivo;
  - a continuação `ssam_discover {intent: "reference an existing .NET extension (XIF) from an O11 module", lane: "o11"}`.
- O cliente constrói e publica a extensão na própria máquina Windows, pelo Integration Studio ou pelo `o11_extension` de um SSAM instalado lá. Depois, referencia a extensão aqui (`ssam_job` com op `reference`, depois `o11_deliver`).
- Teste: `platforms/odc/facade/tests/hosted-tools.test.mjs`.

## Provas

- `prova-extracao.ps1` (Windows, com `C:\t\tools\7zip\7z.exe`):
  - extrai os dois instaladores em `C:\t\dist-b\extract` com o 7-Zip e com o `nsis_extract.py`;
  - confere a lista de cada faixa;
  - compara os bytes dos dois leitores entre si e com o Studio instalado da mesma versão.
- `prova-linux.sh` (WSL Ubuntu 24.04):
  - instala o Docker Engine;
  - faz o build e sobe só o `ssam-server` (projeto `ssam-prova`);
  - confere a saúde;
  - roda chamadas offline de cada kernel dentro do container;
  - emite um token pelo `ssam-admin` e chama por `/mcp`, por faixa, `ssam_reference` e `ssam_discover`, mais a recusa de `o11_extension`;
  - revoga o token.

## Situação (2026-10-07)

- Provado no Windows:
  - O leitor NSIS reproduz byte a byte os 1138 arquivos do Service Studio 11.55.91 instalado.
  - O O11 sai do instalador pelo `nsis_extract.py`, compila e dá os mesmos resultados.
  - As listas O11 e ODC (1.7.27) dão os mesmos resultados que as instalações completas.
  - O `studio-extract.sh` passa num sh POSIX.
- Ainda não provado: o build Docker, o Linux (SQLite e caminhos dentro das bibliotecas da OutSystems) e o leitor 7z. É isso que `prova-linux.sh` e `prova-extracao.ps1` cobrem.
- Bundle, provado no Windows:
  - o `studio-bundle.ps1` empacotou o ODC 1.7.27 instalado, e o `studio-extract.sh` o abriu como no Docker;
  - `anvil-odc` e o builder, compilados contra o resultado, repetem os resultados da instalação completa;
  - um arquivo alterado no bundle para o build (código de saída 3), e também param um SHA256 errado e um bundle da faixa errada;
  - o `studio-bundle.sh` gerou o bundle O11, que sai idêntico ao instalado.
- O ODC precisa de 1.7.27 ou mais novo: o kernel ODC não compila contra o 1.7.23 (`MobileSplashScreen`). O instalador 1.7.27 não se consegue baixar, então o ODC entra pelo bundle.

## Situação (2026-10-12): ODC Studio 1.7.28

- O ODC Studio dos clientes e o do dono se atualizaram sozinhos para 1.7.28.10850. O hub recusa um Studio cujos três
  primeiros números não são os do `kernel.json` (`STUDIO_VERSION_MISMATCH`), então o servidor passa para 1.7.28.
- Bundle: `studio-bundle.ps1` sobre o 1.7.28.10850 instalado. Os 196 arquivos de `studio-odc.txt` existem nele, e as
  referências de assembly desses arquivos não pedem nenhum outro arquivo da pasta do Studio (fora o runtime .NET
  compartilhado). Nenhum plugin novo (`OutSystems.Model.Plugin.*.dll`, `Plugins/**/ServiceStudio.Plugin.*.dll`).
  A lista não muda.
- `kernel.json` do servidor: `{"o11":"11.55.91","odc":"1.7.28","odcBridge":"v97","odcBridgeAccepted":["v96","v48","v45"]}`
  (`docs/SERVIDOR-FASE4.md`, "ODC Studio 1.7.28").
