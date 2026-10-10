# Extensões .NET O11 (XIF) sem Integration Studio

Lane `xif` do contrato `docs/INTEGRACOES-GITSSAM.md` (commit `ba3c6d33`). Ramo `feat/integ-xif`.

## Pedido

O GitSSAM criava extensões .NET O11 sem abrir o Integration Studio. O SSAM Hybrid não tinha isso.
Agora tem: uma chamada cria ou edita, publica e responde uma vez. Sem login do Integration Studio. Sem arquivo de credencial.

## Como funciona

`o11_extension {action:"publish", host, spec, words}` faz, nesta ordem:

1. Acha o Studio conectado no `host` (sessão do próprio Studio, SSO incluído). Sem a capacidade `sc_api:integration-studio` na bridge: `BRIDGE_TOO_OLD`, antes de qualquer chamada ao kernel.
2. Identidade pelo nome exato (`ListExtensions` e `ListEspaces`). Nenhuma: criar. Uma extensão: editar, com a versão ativa baixada como base. Variante de caixa ou duplicada: `EXTENSION_AMBIGUOUS`. Nome de módulo: `EXTENSION_NAME_TAKEN`. `expectedVersionId` diferente: `EXTENSION_VERSION_CHANGED`.
3. Spec no kernel (`anvil xif check`): todos os problemas de uma vez em `XIF_SPEC_INVALID`, cada um com caminho e correção.
4. Modelo pelo Integration Studio instalado (`anvil xif build --stage model`, motor `Anvil.Xif.Engine`). Depois o `Handshake` com a versão do motor. Recusa do servidor: `XIF_ENGINE_INCOMPATIBLE`.
5. Stubs e DLLs da plataforma pela bridge (só leitura). Erro do servidor: `XIF_STUBS_REFUSED`. As DLLs ficam em cache por versão da plataforma.
6. Merge dos corpos e compilação Roslyn (.NET Framework 4.7.2, C# 7.3, determinística). XIF final pelo motor, relido e auditado (a DLL é a nossa, nenhuma DLL da plataforma embutida, nenhum caminho de perfil).
7. `UploadNeeded`: a mesma versão já rodando responde `already-running`, nada enviado.
8. Edição que quebra o contrato: `GetConsumers` de cada elemento. Consumidor não nomeado: `EXTENSION_BREAKS_CONSUMERS` (regra do SSAM, D9). Leitura falhou: `EXTENSION_CONSUMERS_UNKNOWN`.
9. Palavras do dono nomeando a extensão, ou concessão `publish` que a cobre. Concessão nunca cobre quebra de contrato nem delete. Faltando: `WORDS_REQUIRED`, `WORDS_MUST_NAME_TARGET` ou `CONFIRM_HOST_REQUIRED`, já com `xifSha256`, `contractDiff` e `consumers`.
10. Um `extension-publish` do Service Center (I1) com `--extension` e `--expected-version-id`. Resposta: `created`, `updated`, `already-running` ou `uncertain`.

Incerto nunca é reenviado. A mesma chamada com o mesmo `operationId` lê o ambiente (`UploadNeeded` do hash gravado) e fecha.
A resposta traz a continuação: `ssam_job` com o job de referência e `captureProducers`, depois `o11_deliver` e `o11_publish` do consumidor.
`consumers:true` publica cada consumidor pela cascata do `o11_publish` (`publishConsumersOf`, I11).

`read {host, extension}`: baixa a versão ativa e devolve spec (com chaves e corpos), `versionId`, `signatureHash` e consumidores.
`delete {host, extension, words}`: vai ao motor de delete do Service Center (lane scdelete). Uma implementação só.

## Peças

- Kernel `kernel/src/Anvil.Xif` (net8): `XifSpec`, `XifPackage`, `XifSourceMerge`, `XifCompiler`, `XifContractDiff`, `XifEngineProbe`, `XifBuild`, `XifEngineClient`.
- Motor `kernel/src/Anvil.Xif.Engine` (net472, x86): reflexão sobre o Integration Studio instalado, JSON por stdin e stdout, sem login e sem rede.
- CLI `anvil xif check|read|build --stage model|final|diff`.
- Bridge O11: superfície `integration-studio` do `sc_api`, só leitura (`ScOperations.cs`, `ScIntegrationStudioSoap.cs`, `ScApiHandler.cs`).
- Endurecimento: escrita destrutiva do `sc_api` sem `target` é `NOT_ALLOWED`.
- Fachada: `o11-extension.mjs`, `service-center/integration-studio.mjs`, `publishConsumersOf` em `o11-publish.mjs`, registro no `ssam.mjs`.
- Descoberta: `integration.dotnet-extension-o11` em `catalog/fragments/C/dotnet-extensions.json` (declarado, sem prova).

## Contrato do IntegrationStudio.asmx

Lido do Integration Studio 11.14 instalado (só metadados):
- SOAPAction `http://ServiceCenter/IntegrationStudio/<Operação>`, corpo `<Operação xmlns="http://www.outsystems.com">`.
- `Handshake {username, password, version, lastUpgradeVersion}` responde `{ok, error, platform, database}`. `version` é o `Config.ProductVersion` (11.14.25.134) e `lastUpgradeVersion` é o `Config.LastUpgradeVersion` (11.0.0.200), nunca a versão do produto de novo (recusado ao vivo em 07/10).
- `GenerateSourceCodeStubs {username, password, extension}` responde `{sourceCodeZip, messages}`.
- `GetSourceCodeDependencies {username, password}` responde `{dependenciesZip, messages}`.
- `UploadNeeded {username, password, ExtensionGUID, ExtensionHash}` responde `{Needs, ExtensionId, equalVersionId, runningVersionId, messages}`.
- `username` e `password` são o usuário do Studio e um segredo novo do login dele por chamada (o id_token no SSO).

## Desvios do contrato

- O POST ao `IntegrationStudio.asmx` usa um `HttpClient` dentro do processo do Studio, não o `IRestService` do Studio. O `IRestService` manda corpo em bytes como `application/octet-stream` e `Accept: application/json`; o ASMX SOAP 1.1 exige `text/xml`.
- A continuação de referência passa `job` como caminho de arquivo (o `ssam_job` só aceita caminho) e devolve o job também em `referenceJob`.
- A spec é checada depois da identidade, porque uma action existente pode vir sem corpo numa edição. O teste exige `BRIDGE_TOO_OLD` antes de qualquer chamada ao kernel; isso vale.
- O `Handshake` vem depois do modelo: a versão do motor sai da resposta do estágio `model`.
- Código novo `XIF_PACKAGE_INVALID` para XIF ilegível e `XIF_MERGE_FAILED` para stubs sem a classe da extensão.

## Testes

- `XifSpecTests`, `XifPackageTests`, `XifSourceMergeTests`, `XifCompilerTests`, `XifContractDiffTests`, `XifEngineProbeTests`.
- `ServiceCenterBridgeTests`: superfície `integration-studio` (só leitura, arquivos, envelope, leitura, segredo redigido, catálogo) e o endurecimento do `target`.
- Fachada: `o11-extension.test.mjs` e `publishConsumersOf` em `o11-publish.test.mjs`.
- Falha isolada esperada: `tool-routes` acusa a rota que falta para `o11_extension` (a lane scdelete escreve a rota).

## Provas ao vivo pendentes (com o dono)

Em 2026-10-06 o primeiro uso real (DCIPS) quebrou no estágio `model`. Correção e provas sem rede em `2026-10-06-xif-motor-construtor.md`.
Os estágios `model` e `final` (criação e edição) agora rodam no Integration Studio 11.14.25.134 instalado, sem rede.

- O `IntegrationStudio.asmx` aceitar o segredo SSO do Studio (`Handshake`, stubs, dependências). É a incógnita crítica.
- O servidor aceitar o XIF salvo pelo motor sem `ActivationCode`.
- Primeiro publish de `ZZHybridXifLab.Add`; consumidor com `captureProducers` devolvendo 42 para 19 + 23.
- `UploadNeeded` num rerun responder `already-running`.
- Pasta e modo de deploy da DLL compilada no XIF final (`Source\NET\Bin\` quando a extensão ainda não tem a DLL).
- Delete da extensão ZZ pelo motor da scdelete.

## Fora daqui

Entidades de banco externo, pilha Java, listas de tipo básico em XIF, login PKCE do Integration Studio, migração XIF para ODC.
