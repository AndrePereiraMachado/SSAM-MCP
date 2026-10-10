# Instaladores e bundles dos Studios

Coloque aqui, para cada Studio, uma de duas entradas antes de `docker compose build`. Nada desta pasta vai para o Git (`.gitignore`) nem para o contexto principal da imagem (`.dockerignore`).

1. **O instalador oficial.** Se estiver presente, é o preferido.
2. **Um bundle do Studio**, feito a partir de um Studio INSTALADO em qualquer máquina. Serve quando o instalador daquela versão não se consegue baixar, como hoje o ODC Studio 1.7.27.

| Studio | Instalador (padrão) | Bundle (padrão) |
|---|---|---|
| Service Studio 11 | `ServiceStudio-11.55.91.65258.exe`, SHA256 fixado `10047d31a03adbbe6bd3a07c9de0506eeba3420e7031e51846607ee3fcde136c` | `o11-studio-11.55.91.65258.tar.gz` |
| ODC Studio | `ODCStudio-1.7.27.10846.exe`, sem SHA256 ainda | `odc-studio-1.7.27.10846.tar.gz` |

- Os build args são `SERVICE_STUDIO_INSTALLER`/`_BUNDLE` e `ODC_STUDIO_INSTALLER`/`_BUNDLE`, cada um com o seu `_SHA256`. Use outra pasta com `STUDIO_INSTALLERS_DIR`.
- Instalador: o build só o lê, nunca o executa.
- Bundle: o build confere o SHA256 fixado, ou senão o arquivo `.sha256` ao lado. Depois confere cada arquivo contra o `SHA256SUMS` do bundle. Um arquivo alterado para o build.
- Nas duas entradas a imagem fica com o mesmo resultado: só os arquivos de `docker/ssam-server/studio-<faixa>.txt`.
- O Service Studio tem de ser a mesma versão dos Studios dos clientes. O ODC Studio tem de ser 1.7.27 ou mais novo, porque o kernel ODC não compila contra o 1.7.23.

## Fazer um bundle

Numa máquina com o Studio instalado (só leitura da pasta do Studio):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File docker\ssam-server\studio-bundle.ps1              # ODC, pasta padrão
powershell -NoProfile -ExecutionPolicy Bypass -File docker\ssam-server\studio-bundle.ps1 -Lane o11    # Service Studio 11
```

```sh
sh docker/ssam-server/studio-bundle.sh --lane odc --studio "/mnt/c/Program Files/OutSystems/ODC Studio/ODC Studio"
```

- Cada comando grava `<faixa>-studio-<versão>.tar.gz` e o `.sha256` nesta pasta.
- Fixe o SHA256 impresso em `ODC_STUDIO_BUNDLE_SHA256` (ou `SERVICE_STUDIO_BUNDLE_SHA256`) no `.env`.
- O bundle contém binários da OutSystems, como a imagem. Guarde e transfira os dois só em lugar privado: as mesmas condições de licença dos Studios valem para eles.
