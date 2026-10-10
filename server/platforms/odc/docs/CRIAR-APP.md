# Criar app ou library no ODC (`studio_create_app`)

Uma chamada cria o app como o "Create app" do ODC Studio cria: modelo, upload, abrir e publicar.

```
studio_create_app {action:"templates", kind:"reactive"}                      # leitura: templates do tenant
studio_create_app {kind:"reactive", name:"ZZ Criar Web", authorize:"<palavras do usuário que citam o app>"}
studio_create_app {kind:"library", name:"ZZCriarLib", publish:false, authorize:"..."}
```

Campos de `create`: `kind` (`reactive`, `mobile`, `library`, `mobile-library`), `name` (nome do app, pode ter espaço),
`module?`, `description?`, `color?` (#RRGGBB, padrão #2E86C1), `icon?` (PNG absoluto), `template?` (`web`,
`mobile-ui`, `outsystems-ui`) ou `templateKey?`, `publish?` (padrão true), `tenant?`, `pid?`.

## Como funciona

| passo | onde | o quê |
|---|---|---|
| sessão | bridge `auth-status` | o tenant pedido ou a única sessão; tenant corporativo só nomeado na chamada e nas palavras |
| template (apps) | bridge `template-download` | `TemplatesService.GetESpaceForApplicationTemplate`, o que o Studio clona |
| modelo | kernel `anvil-odc create-app` | app: `ESpace.Clone` do template com nome, cor, descrição, sem imagem, e `ChangeESpacePrimaryColor` (tema com o nome do módulo e a cor). Library: `ESpace.Create` com user provider "Users". Zero erros, ou nada sai |
| upload | bridge `create-app` | `appName` do candidato livre no tenant, depois os portões do `create` e `CreateAsset` |
| abrir | bridge `open <chave>` | do servidor, com o vínculo que o Publish exige |
| publicar | bridge `publish --wait` | revisão 1, comparada com o módulo aberto |

- Uma autorização cobre criar e publicar (como o botão do Studio). As palavras precisam citar o app.
- Diário: `kernel\.local\lane-odc\journal\studio_create_app.jsonl` (só o sha256 das palavras).
- Evidência: `kernel\.local\lane-odc\create-app\<UTC>\` (OML, recibos, manifesto).
- Resposta perdida depois do upload = `uncertain`, nunca repetida: leia `studio_assets`.
- `studio_create` continua só para subir um módulo inteiro já montado (laboratório).
- Apagar app é do usuário, no ODC Portal.

## Prova offline (2026-10-04, ODC Studio 1.7.27)

- Library e Mobile Library: 0 erros e 0 avisos (o aviso `ImplicitSelfUserProvider` do módulo em branco some), só `(System)`.
- Reactive com `wrightflood-personal-r8.oml` no lugar do template: 0 erros, nenhum aviso novo, chave nova, nome do
  módulo derivado do nome do app ("ZZ Criar Web" -> `ZZCriarWeb`), tema renomeado, mesmas telas, blocos, flows e referências.
- Cor: com um tema sem CSS próprio (template novo), a cor vai para os valores do tema e o CSS é gerado
  (caminho do theme editor). Um tema com CSS próprio sem o marcador `/*primary-color*/` fica com a cor dele,
  como no Studio; o recibo diz isso em `notes`.
- Testes: `kernel\tests\Anvil.Tests.Odc\OdcAppFactoryTests.cs`, `platforms\odc\facade\tests\studio-create-app.test.mjs`.

## Templates do tenant são módulos de sistema (falha real de 2026-10-05, corrigida)

- `Template Web App` (chave `Wrm0V2ZyskqM7KobRok75w` = `Constants.Template_Reactive`) e `Template_MobileApp`
  (`Y53h6e8fQ0CFeiQPTNo+Pw` = `Constants.MobileUI_Template_Phone`) estão em `Constants.ReadonlyESpaces`. O Model API
  recusa carregá-los ("System modules cannot be loaded with the Model API. Consider using the Clone method instead.",
  `CheckOpenPermissions`); o Studio só os clona. O kernel nunca carrega o template: identidade e tipo vêm do cabeçalho
  do OML, conteúdo e avisos-base de um clone simples. O app é um clone com chave nova, deixa de ser módulo de sistema.
- Um clone recém-criado só se valida dentro de uma transação (o clone liga o model lock); fora dela não mostra mensagem
  nenhuma. Template e app são validados do mesmo jeito.
- `Template_MobileApp` exige o model plugin `MobileUI` (1.5.0.0 hoje), binário do tenant, e todo app clonado dele também.
  O Studio o baixa (`IModelPluginProvider`, `AssetManagementService.GetAssetBinary` pela sessão) para o cache
  `<PluginsDirectory>\MobileUI-<versão>.xif` ao abrir um app que o usa, e apaga do cache o que ficou 60 dias sem acesso.
  - bridge `template-download`: devolve `pluginsDirectory` (o `PluginsDirectory` do próprio Studio) e `modelPlugins`
    (os plugins que o template exige, cada um baixado para o cache pela sessão quando falta: `cached`, `fetched`, `error`).
  - fachada: plugin que o Studio não conseguiu pôr no cache = `MODEL_PLUGIN_MISSING` antes do kernel; senão passa
    `--plugins-dir <pluginsDirectory>` ao kernel. Bridge antigo (sem esses campos): o kernel usa a pasta padrão.
  - kernel (`OdcModelPlugins`): responde `ModelServices.ResolveModelPlugin` lendo primeiro `--plugins-dir`, depois
    `ANVIL_ODC_PLUGINS_DIR` ou `%LocalAppData%\OutSystems\ODC Studio\Plugins`. Plugin que não carrega =
    `OdcModelPluginMissingException`, uma linha com plugin, pastas e o que fazer (abrir um app Mobile UI no Studio uma
    vez); nada é gravado. A fachada traduz em `MODEL_PLUGIN_MISSING`, continuação `studio_assets`.
  - depois da criação: o mesmo resolvedor está no kernel (inspect, jobs) e no `ODC3.Builder` (leitor de `ssam_map` e
    `studio_inspect`, `manifest`, features). Sem ele `ssam_map` do app Mobile criado falhava com
    `MissingRequiredModelPluginsException` (reproduzido offline). Worker `anvil-odc` ou leitor residente já rodando
    continuam com o binário velho até reiniciar.
- `MODEL_REFUSED` diz que o template foi baixado e que o passo que falhou é o modelo (`failedStep: "model"`). Recusa do
  kernel é determinística: `repeat:false`, sem doctor-e-repita. Só "o kernel não respondeu" manda ao `ssam_doctor`.
- Prova offline com os templates reais baixados do tenant pessoal (sem enviar nada): Reactive e Mobile com 0 erros, nenhum
  aviso novo (os 19 `InvalidResourceURL_Offline` do Mobile já estão no template), chave nova, tema renomeado com a cor.
  Para repetir: `ANVIL_ODC_TEMPLATES_DIR=<platforms\odc\snapshots\templates>` e o teste `TheTenantsRealTemplatesBecomeApps`.

## Falta provar ao vivo

O upload, o open e o publish de um app vindo de template (library já foi ao vivo pelo mesmo `CreateAsset`), o template
`outsystems-ui` (Phone, nunca baixado) e o download do model plugin pelo bridge numa máquina sem o cache (o código segue o
provedor decompilado do Studio; se falhar, a resposta é `MODEL_PLUGIN_MISSING` com o erro do Studio, antes do kernel). Roteiro com o usuário, tenant pessoal, nomes `ZZ`: `templates`; library
`ZZCriarLib`; reactive `ZZ Criar Web`; mobile `ZZCriarMobile`; conferir no Studio e nos links; o usuário apaga os três no Portal.
