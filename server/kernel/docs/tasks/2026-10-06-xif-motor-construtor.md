# Motor XIF: construtor do Aggregator e lock do Integration Studio

Correção da lane `xif` (`o11_extension`). Ramo `feat/xif-engine-fix`, sobre `pacote2/integracao` (`3436d1ec`).

## Defeito

Uma sessão do DCIPS chamou `o11_extension {action:"publish", host:"personal-2qqw9srv.outsystemscloud.com", application:"DCIPS Foundation", expectedVersionId:"none", spec, words}`.
A resposta foi `XIF_VERIFY_FAILED` com "Integration Studio failed: MissingMethodException: Nenhum construtor sem parâmetros foi definido para este objeto".
Integration Studio 11.14.25.134 e Service Studio 11.55.91. Spec de uma action também falhava. Nada foi enviado.

Até o modelo, o fluxo andou ao vivo: Studio conectado, capacidade `sc_api:integration-studio`, `ListExtensions` e `ListEspaces` (superfície `soap`) e `anvil xif check`.
A falha foi no estágio `model`, o primeiro uso real do motor.

## Causas

1. `Host.Open` chamava `Activator.CreateInstance(tipoDoAggregator, true)`.
   Esse `true` não é argumento do construtor: é a sobrecarga `nonPublic`, que pede um construtor sem parâmetros.
   No 11.14 instalado, o único construtor é `Aggregator(bool preventUsingTasks)` (lido por reflexão da instalação).
2. Achado depois da correção 1, sem rede: o estágio `final` e a edição de extensão (`base`) falhavam com `DirectoryNotFoundException`.
   O `ProjectLoad` grava `%TEMP%\Integration Studio\<chave>.lock` e espera a pasta, que o aplicativo Integration Studio cria.
   O TEMP privado que o `XifEngineClient` dá ao motor começa vazio.
3. Por que os testes não pegaram: o `XifEngineProbe` só exigia "algum construtor público" e os testes usavam tipos falsos.
4. Diagnóstico enganoso: `Program.cs` transformava qualquer exceção em `XIF_VERIFY_FAILED` com "revise o spec". O agente culpou o spec.

## Correções

- `R.New(tipo, argumentos...)` no motor: acha o construtor público que aceita exatamente esses argumentos e chama ele.
  O motor não usa mais `Activator`. Sem o construtor, a resposta é `XIF_ENGINE_UNAVAILABLE` com os construtores que existem.
- O Aggregator nasce com `preventUsingTasks = true`: o processo é de uma chamada só e fica sem tarefas em segundo plano.
- `Host.Open` cria `%TEMP%\Integration Studio` antes de abrir ou carregar o projeto.
- `XifEngineProbe` exige a assinatura exata de cada construtor que o motor chama: `.ctor(Boolean)` no Aggregator, `.ctor(String)` no Upgrader, `.ctor(IAggregator)` nos plugins, `.ctor()` em RecordType, Resource e em cada tipo de dado.
  Uma forma diferente aparece como membro faltando (`Aggregator.ctor(Boolean)`), antes de qualquer chamada.
- Código novo `XIF_ENGINE_FAILED`: exceção inesperada dentro do motor.
  A mensagem diz que é defeito do SSAM, não do spec. A resposta traz `stage`, `exception` e `at` (só nomes de métodos, nunca caminhos de arquivo).
  `XIF_VERIFY_FAILED` fica só para relatórios do `ProjectVerify`, caminho inseguro, nome trocado e tipo desconhecido.

## Provas sem rede (Integration Studio 11.14.25.134 desta máquina)

- Reproduzido com o motor antigo: o mesmo `MissingMethodException`.
- Com o motor novo, o estágio `model` passa nos specs do DCIPS: `DCIPS_Files_Ext` mínimo e completo e `DCIPS_Util_Ext` (3 actions, corpos longos), entre 0,4 e 0,9 s cada.
- `anvil xif build --stage model` pelo CLI, com o kernel relendo o XIF: cerca de 0,6 s.
- Spec de laboratório com estrutura, `Pair List`, `Pair`, função, recurso de texto e DLL de autor (`Bin\`, `Binaries`): passa.
- O XIF modelo sai com `ActivationCode=""` e sem caminho de perfil.

## Testes

- `XifEngineProbeTests`: construtor de outra forma é membro faltando (Aggregator sem `(Boolean)`, plugin sem `(IAggregator)`, tipo de dado sem `()`); o motor não usa `Activator`.
- `XifInstalledEngineTests` (rodam só onde há motor e Integration Studio; senão retornam cedo):
  - `model` e `final` reais com os stubs e a DLL falsa de plataforma das fixtures; o XIF final tem a nossa DLL e não a da plataforma;
  - edição: `model` e `final` com `base`, chave mantida, contrato aditivo, actions `Add` e `Multiply`;
  - exceção inesperada dentro do motor responde `XIF_ENGINE_FAILED`, estágio `model`, sem caminho de arquivo nos frames.
- Com o motor antigo (`ANVIL_XIF_ENGINE` apontando para ele), os dois testes do motor instalado falham com o erro da produção.
- Filtro `FullyQualifiedName~Anvil.Tests.Xif`: 24 de 24.

## Perguntas do pedido

- **`sources` só aceita arquivo?** Não. O kernel aceita `sources: [{path:"Helpers.cs", text:"..."}]` (C# inline) ou `{path, file}` (arquivo absoluto), um dos dois (`XifSpec.Content`).
  O arquivo entra em `Source\NET\` e compila junto com os stubs, então os corpos podem chamar classes auxiliares. Função local no corpo não é obrigatória.
  O esquema da ferramenta só dizia `sources?`, sem a forma; agora a descrição e o catálogo mostram.
- **NuGet e DLLs de terceiros?** Sim, como arquivo: `references: ["C:\\...\\BCrypt.Net-Next.dll"]` com caminho absoluto de DLL .NET Framework (pegue a pasta `lib\net4x` do pacote).
  Vão para `Bin\` do XIF como `Binaries` e entram na compilação. Cada assembly que essas DLLs usam precisa estar na lista, ou ser do .NET Framework ou da plataforma (`XIF_SPEC_REFERENCE_CLOSURE`).
  Nome de pacote NuGet não é resolvido. DLL com nome de DLL da plataforma é recusada (`XIF_DEPENDENCY_OVERRIDE`). DLL nativa (não .NET) é recusada (`XIF_SPEC_REFERENCE`).

## Handshake (07/10, depois do 13º envio)

Ao vivo, o modelo passou e o servidor recusou o `Handshake`:
"This version of Integration Studio (11.14.25.134) is not compatible with the selected Platform Server (11.42.1.47790)".

- Causa: a fachada mandava a versão do produto nos dois campos (`handshake(version, version)`).
- O Integration Studio de verdade (`WebServicesFacade.Handshake`, lido no IL do 11.14.25.134) manda `Config.ProductVersion` (11.14.25.134) e depois `Config.LastUpgradeVersion` (11.0.0.200), ambos `System.Version` por `VersionString`.
- Correção: o motor informa `studio.lastUpgradeVersion` lido do `Config` instalado; a fachada manda os dois. Sem ele, `XIF_ENGINE_UNAVAILABLE` antes de qualquer envio. O `XifEngineProbe` exige `Config.ProductVersion` e `Config.LastUpgradeVersion`.
- Conferido no mesmo IL, sem divergência: `GenerateSourceCodeStubs` (bytes do XIF modelo), `GetSourceCodeDependencies` (só usuário e segredo), `UploadNeeded` (`ExtensionGUID` = chave no formato "DB"; a bridge já converte com `Keys.ToDb`) e `Download` (chave "DB").
- Diferença que fica: o Integration Studio publica por `Upload` + `Publish(versionId)` do `IntegrationStudio.asmx`; o SSAM usa `UploadAndPublishExtension` do Service Center (contrato I1).

## Publicação ao vivo (07/10): DLL não implantada e edição travada

Depois do Handshake, a DCIPS criou 4 extensões ("created": Files v153, Util v154, Crypto v155, Pdf v156). Dois defeitos apareceram (ssam_friction 649300c1 e 722dafb1).

1. **A DLL não era implantada.** Todo consumidor falhava no 1-Click Publish com `CS0006 Metadata file 'bin\OutSystems.NssDCIPS_Crypto_Ext.dll' could not be found`.
   - O motor gravava a DLL em `\Source\NET\Bin\` com `CompileAction=Ignore`.
   - Um XIF real do Integration Studio (`Vogais.xif`, 11.14.25.134) a grava no mesmo lugar com `CompileAction=Binaries`, o único modo que a plataforma implanta.
   - Correção: o motor grava `Binaries`, inclusive quando a extensão já tem o recurso. A auditoria do XIF final recusa uma DLL própria que não seja `Binaries`, antes de qualquer envio.
2. **Toda edição falhava com `XIF_ENGINE_FAILED`** (`IOException` em `Host.Model`, `base\<Ext>.xif` em uso por outro processo).
   - A fachada baixa o base para `<work>\base\<Ext>.xif`, e o motor copiava o arquivo para esse mesmo caminho.
   - Correção: a cópia vai para `<work>\model-base\`.

O hash: `Aggregator.ProjectSave` chama `XifUtils.CalculateExtensionHash`, um MD5 do elemento `Extension` inteiro, com os recursos, sem `Hash`, `Generation`, `LastModifiedUTC`, `Version` e `DirectUpgradeFrom`. Republicar com o mesmo spec uma extensão criada antes da correção muda o hash só pela troca de `Ignore` para `Binaries`, e o `UploadNeeded` pede o envio. O teste com o Integration Studio instalado prova isso.

## Ainda ao vivo (com o dono)

A próxima chamada real passa do modelo e chega ao `IntegrationStudio.asmx`:
- `Handshake`, `GenerateSourceCodeStubs` e `GetSourceCodeDependencies` com o segredo da sessão do Studio (SSO). É a incógnita crítica.
- O servidor aceitar o XIF salvo pelo motor sem `ActivationCode`.
- Primeiro publish, consumidor referenciando a extensão, `UploadNeeded` num rerun e o delete da extensão de teste.
