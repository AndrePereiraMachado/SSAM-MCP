# Integration Studio: primeira investigacao das DLLs

## Pedido e escopo

Iniciar para Integration Studio a mesma investigacao feita para Service Studio: identificar as DLLs, modelo, comandos, validacao, codigo, compilacao e publicacao, preparando a cobertura futura do SSAM Hybrid. Esta frente e independente do Dashboard HTML/CSS.

Nesta etapa houve inspecao de arquivos instalados, reflexao somente de metadados, leitura de codigo decompilado e uma prova nativa local de modelo vazio. Nao houve alteracao das DLLs, abertura de GUI, acesso ao ambiente, publicacao ou uso das faixas SS4/SS5. Todos os hashes iniciais dos binarios catalogados permanecem iguais.

## Instalacao encontrada

- Pasta: `C:/Program Files/OutSystems/Integration Studio`.
- Version.txt: 11.14.25.0, revisao `3038d13dd9d3a48221bf11b9e8ec903a0f342913`.
- Executavel/Core/Interface: versao de arquivo/assembly 11.14.25.134.
- CLR declarado: v4.0.30319; executavel configurado para .NET Framework v4.0. Nao presumir que essas DLLs possam ser carregadas diretamente no worker .NET 8 atual.
- Nenhum processo IntegrationStudio estava em execucao no levantamento inicial.
- A instalacao contem `OutSystems.IntegrationStudio.Interface.dll.original`, diferente da DLL atual. Causa nao investigada; preservar ambas e estabelecer a origem do baseline antes de instrumentar a GUI. A presente investigacao nao alterou nenhuma delas.

Inventario com SHA256 e resultados: `docs/proofs/2026-09-05-integration-studio-investigacao.json`.
Arquivos locais de trabalho/decompilacao: `%LOCALAPPDATA%/Anvil/investigations/integration-studio/` (fora do repositorio do produto). Nao copiar decompilado nem binarios proprietarios para o pacote.

## Mapa inicial de mecanismos

| Area | Evidencia nas DLLs | Estado |
|---|---|---|
| Modelo de extensao | Core.Common.Model.Project.Project; technologies, actions, parameters, structures, entity attributes e resources | Tipos/metodos inspecionados |
| API de extensoes | OutSystems.Model.Implementation.Extensions contem implementacoes ModelAPI.V1 e IExtensionServices | Implementacoes concretas principais sao internal; acesso publico precisa ser confirmado pelo service provider da API |
| Coordenacao | Core.Aggregator.IAggregator / Aggregator | Construcao e modelo vazio executados sem GUI |
| Edicao reversivel | Execute(IContext,IUndoableCommand), Undo, Redo; ProjectCommand/TechnologyCommand/ActionCommand/StructureCommand | Mudanca de descricao + undo/redo provada |
| Verificacao | ProjectVerify, ProjectValidator e validadores dos plugins | Modelo vazio sem plugins retornou zero reports; isto NAO comprova validacao de uma extensao real |
| Serializacao | XIF.XML.LoadToXML / LoadToModel; ProjectSave / ProjectLightSave | Light XML de modelo vazio salvo/recarregado; XIF completo ainda nao provado |
| Carregamento XIF | Upgrader e Aggregator.ProjectLoad | Codigo inspecionado; pode criar lock e extrair recursos ao lado do arquivo |
| Plugins | Plugin.Net.Core / Plugin.UserDefined.Core e respectivos Interface | Arquivos encontrados; carga e validacao funcional pendentes |
| Geracao de fontes | ProjectGenerateTemplates / ProjectUpdateSourceCode | Chama geracao de stubs e dependencias no ambiente; nao e inteiramente offline |
| Compilacao C# | Aggregator.ProjectCompile -> Compiler.CompileSolution | Fluxo identificado; toolchain real e execucao pendentes |
| Remoto | WebServicesFacade Handshake, ListExtensions/Versions, Download, UploadNeeded, Upload, Publish | Assinaturas e fluxo inspecionados; nenhuma chamada remota executada |
| Entidades externas | EntityIntrospectionGetServers/GetDatabases/GetTables e classes importadoras | Superficie identificada; cobertura pendente |
| Linha de comando | Launcher modos info, testverify, testpublish; switches xif, xml, appkey, modulename e outros | Parsing inspecionado; comandos nao foram executados |
| Atualizacao de codigo | Compiler.Merge usado por ProjectMergeTemplates | Merge de fontes/templates; nao confundir com merge de tres vias do modelo no Service Studio |

A reflexao .NET Framework encontrou 345 tipos publicos exportados no Core, 15 em Model.Implementation.Extensions e 3 no executavel. E contagem de superficie, nao contagem de capacidades suportadas. Assinaturas completas dos tipos selecionados estao no arquivo local `public-surface.json`.

## Prova executada

Com Windows PowerShell 5.1 em processo separado:

1. Carregar OutSystems.IntegrationStudio.Core.dll e resolver dependencias da propria instalacao.
2. Instanciar Aggregator(preventUsingTasks:true) e ProjectCreateBlank com nome ZZISProbe.
3. Executar ProjectVerify: Verified=true e lista de reports vazia.
4. Executar ProjectCommand.ChangeDescription atraves de contexto de comando; undo restaura o valor anterior e redo restaura a alteracao.
5. Salvar com ProjectLightSave para arquivo XML proprio de laboratorio.
6. Recarregar com XIF.XML.LoadToModel em outro projeto; nome, chave e descricao preservados.

Script original da prova, sem codigo decompilado: `scripts/probes/integration_studio_core.ps1`.

Reproducao (nao usar pwsh/.NET moderno para esta prova):

```powershell
& 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' -NoProfile `
  -File 'C:/Users/andre/Anvil/scripts/probes/integration_studio_core.ps1' `
  -OutputPath "$env:LOCALAPPDATA/Anvil/investigations/integration-studio/repeat/result.json"
```

**Limite deliberado:** zero technologies e nenhum plugin nessa prova. Resultado verde de modelo vazio nao demonstra actions, structures, parameters, references, DLLs de implementacao ou validacao da extensao inteira. ProjectLightSave produz XML, nao um XIF empacotado completo. Compilacao, publicacao e consumo nao foram executados.

O XIF oficial instalado Mtadados.xif foi descomprimido apenas em memoria para inspecao: zlib -> XML Extension, 16 resources, uma action e duas technologies. Isso e evidencia desse arquivo; nao assumir o mesmo esquema/versionamento de todo XIF, nem usar edicao XML manual como mecanismo de producao sem a API/prova nativa.

## Descobertas que afetam a arquitetura

1. **Separar runtime/processo.** Um host de Integration Studio em .NET Framework e a primeira opcao a provar; comunicar com o controlador por contrato simples e tipado. Nao carregar assemblies homonimos de versoes distintas junto com o worker Service Studio sem avaliar compatibilidade.
2. **Separar verificacao de geracao/compilacao/publicacao.** O modo testverify chama verificacao, mas quando ha codigo .NET ou forceCodeAddition tambem faz login e atualizacao de fontes/compilacao. Portanto nao tratar esse modo como leitura pura nem executa-lo sobre a unica copia de uma extensao.
3. **Geracao depende do ambiente.** Compiler.Compile solicita GenerateSourceCodeStubs e GetSourceCodeDependencies. Antes de executar essa fase, confirmar autenticacao, permissao e versao do ambiente; armazenar artefatos de prova sem segredos.
4. **Diretorios de saida sao descartaveis.** Compiler.Compile apaga o conteudo do outputPath antes de gerar stubs. Um futuro adapter deve validar o caminho absoluto e restringi-lo ao diretorio exclusivo daquela corrida. Nao passar o repositorio, a instalacao ou fontes do usuario como outputPath.
5. **Publicacao tem fases distintas.** UploadNeeded, Upload e Publish sao separadas. O recibo precisa guardar identidade/hash/versionId e distinguir upload aceito, versao publicada e resultado desconhecido; nao repetir upload/publicacao cegamente.
6. **Entrega no editor ainda e uma questao aberta.** Ha comandos reversiveis no Core, mas ainda nao encontramos/provamos um equivalente ao merge de tres vias do Service Studio. Compiler.Merge aqui trata templates/fontes. Decidir entrega pelo XIF, reabertura, comparacao ou adapter do editor somente apos prova de preservacao de trabalho nao salvo.
7. **Credenciais nao vao para argumentos CLI.** O parser aceita password, mas argumentos de processo nao sao o canal a adotar. Reutilizar a autoridade/controlador e um canal de credencial protegido; corrigir portabilidade MSIX de maneira explicita, sem reutilizar workarounds bloqueados.
8. **Adapter pequeno, sem copiar a GUI.** A superficie de comandos/modelo deve sustentar uma especificacao de extensao e diagnosticos. A LLM nao deve escolher chamadas internas arbitrarias ou procurar DLLs durante uma entrega de app.

## Proximas provas, em ordem

1. Estabelecer baseline da instalacao e dos plugins; inventario de assemblies, versoes, dependencias e arquitetura de processo. Comparar a Interface atual com sua copia original antes de instrumentacao.
2. Carregar plugins Core em um host descartavel sem interface grafica. Confirmar que todos os validadores pertinentes estao ativos. O host deve recusar certificar tecnologias cujo plugin nao foi carregado.
3. Criar uma extensao real de laboratorio com actions, inputs/outputs, tipos simples, structures, structure lists, recursos e referencias. Provar validacao positiva e erros deliberados por tipo/nome/referencia invalidos.
4. Salvar XIF completo e recarregar preservando identidades, contratos, recursos e codigo. Validar hashes dos recursos e preservacao de corpos ao mudar uma assinatura.
5. Provar geracao/atualizacao de fontes em diretorio exclusivo, com dependencias obtidas do ambiente por autenticacao autorizada. Identificar SDK/toolchain exigidos; compilar implementacao C# real e capturar diagnosticos.
6. Publicar apenas uma extensao de laboratorio; registrar upload/versionId/resultado. Confirmar autenticacao e resultado sem alterar configuracoes do ambiente por iniciativa propria.
7. Referenciar a extensao em modulo consumidor de laboratorio e executar suas actions. Esse e o primeiro marco funcional completo; compilar nao basta.
8. Provar segunda entrega, idempotencia, alteracao compativel/incompativel, preservacao de consumidores e retomada apos falha.
9. Somente entao integrar o fluxo ao Hybrid, cobrindo o ciclo fechado de intencao, plano, execucao, prova e recibo. Registrar limites de cada capacidade sem inflar cobertura a partir de metodos encontrados.

## Coordenacao com o Dashboard

Este inicio alterou somente documentacao/prova e adicionou um script isolado. Nao modificou src/, CLI, bridge, worker, modulos Incidents ou instalacoes. A implementacao futura deve usar worktree/saidas proprios. Combinar alteracoes comuns de autoridade/controlador com a frente HTML e usar extensao/modulo consumidor dedicados. Nenhuma faixa foi reservada por esta investigacao.
