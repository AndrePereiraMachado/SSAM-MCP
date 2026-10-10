# High code como autoria; OutSystems como modelo nativo

Data: 2026-09-06. Estado: investigacao e direcao arquitetural; nao e uma declaracao de cobertura implementada.
Pedido: deixar a LLM trabalhar naturalmente com high code, sem expor a mecanica do Studio; preservar a
comercializacao/incorporacao pela propria OutSystems. A revisao do Dashboard continua separada da entrega
no produto. Nenhuma alteracao desta investigacao foi publicada no Incidents_CS/Incidents_UI.

## Conclusao

A maior mudanca necessaria e na fronteira de autoria e no contrato semantico. Data e Logic ja possuem
compiladores, convencoes e provas uteis. Nao devem ser descartados para criar outro motor C# independente.
A LLM deve escrever a fonte principal uma vez; o Hybrid extrai simbolos, tipos, dependencias, contratos e
operacoes. JSON interno gerado nao deve se tornar um segundo arquivo que a LLM precisa manter sincronizado.

Fluxo recomendado:

```
HTML/CSS + logica cliente tipada       C# de dados e regras
                 \                    /
          frontends com diagnostico na fonte
                         |
       contrato tipado comum + identidades + efeitos
                         |
     planejamento sobre snapshot + adaptador por runtime
                         |
          modelo OutSystems + prova independente
                         |
         merge revisavel + execucao de aceitacao
```

O nucleo nao executa codigo arbitrario durante a analise da fonte. Roslyn permite obter simbolos e atributos
sem instanciar classes ou executar construtores de atributos. Execucao de testes ocorre em um runner separado.

## O que foi checado no codigo

| Area | Evidencia | Implicacao |
|---|---|---|
| HTML atual | HtmlExpander.Root fixa IMobileScreen; Main pressupoe layout; HtmlDelta.ClearScreen apaga/recria apresentacao e logica | Ainda nao e um compilador geral de componentes |
| Reutilizacao existente | binding block aceita block e args; nao oferece contrato completo de slots/eventos | UserInfo funcionando nao comprova composicao geral |
| UI controlada em desenvolvimento | ScreenSpecification/ScreenModel/ScreenRequirements no checkout principal aceitam screens/blocks, inputs, blockEvents, slots e eventos | Reaproveitar essa representacao depois de revisar e integrar; arquivos ainda nao commitados nao equivalem a produto instalado |
| Identidade UI | ScreenModel concilia por nomes e remove elementos ausentes com force; HtmlDelta recria filhos | Renomeacao e evolucao de contrato exigem identidade semantica e verificacao dos consumidores, nao apenas nome |
| Data | SpecExpander declara tipos antes dos atributos; DataDelta/DataRequirements comparam modelo real | Bom backend para uma entrada C#; falta frontend C# |
| Logic | LogicExpander gera nos; LogicRequirements compara grafo, tipos, expressoes e ligacoes | Prova estrutural, nao execucao de C# nem equivalencia comportamental |
| Escopo | Prova com dois handlers Receive em owners diferentes foi recusada no preflight | Tabela de simbolos precisa considerar modulo, owner e assinatura |
| Extensoes | Fontes/contratos do Integration Studio e geracao de stubs dependem do ambiente | XIF e backend distinto de actions visuais; nao presumir toolchain .NET 8/10 do Hybrid igual ao servidor |

Referencias locais: src/Anvil.Core/Kernel/{HtmlExpander,HtmlDelta,ScreenContracts,SpecExpander,DataDelta,
DataRequirements,LogicExpander,LogicRequirements,ModuleSpecification}.cs. A camada ScreenSpecification/Model/
Requirements citada acima foi lida em C:/Users/andre/Anvil, sem sobrescrever o trabalho da outra sessao.

## UI: tela, block e instancia sao conceitos diferentes

Adotar um contrato de componente comum com: identidade estavel, tipo screen/block, inputs tipados e defaults,
eventos com payload tipado, placeholders nomeados, estado por instancia, lifecycle, fontes de dados e arvore UI.
Uma tela acrescenta rota, roles e shell; um block nao deve receber layout de tela automaticamente.

O HTML deve descrever estrutura e slots de forma familiar. Imports, parametros e handlers devem ser derivados
de uma fonte tipada, evitando um manifesto paralelo preenchido manualmente. HTML/CSS com TypeScript e uma
candidata natural; TSX tambem deve ser avaliado pelo custo real de preservar sua semantica. Nao declarar suporte
a React completo, hooks arbitrarios ou JavaScript irrestrito apenas porque o parser aceita essa sintaxe.
A escolha final de sintaxe precisa de uma prova comparativa curta de autoria; nao de outro DSL extenso.

Passagens do compilador: declarar todos os owners/contratos; resolver imports e tipos; declarar estado/actions;
construir arvores; ligar argumentos/eventos/slots; conciliar identidades; validar o modelo resultante. O grafo
de dependencias deve detectar ciclos de composicao sem proibir referencias declaradas adiante.

Cada uso precisa ser IMobileBlockInstanceWidget apontando ao mesmo IMobileBlock. Parametros, event handlers e
conteudo de placeholder pertencem a instancia. Estado local pertence a instancia em runtime. Testar quatro
instancias inclui o risco de compartilhar estado acidentalmente; uma prova de modelo nao resolve esse risco.

## CSS e JavaScript exigem semantica de componente

O prefixo atual .av-<nome> em descendentes nao oferece isolamento completo: regras de um componente pai podem
atingir os filhos, e nomes iguais em modulos distintos podem colidir. Precisamos de escopo por identidade de
componente, regras explicitas para conteudo projetado em slots e uma politica de tema/tokens. CSS nao deve ir
para o tema do consumidor por copia a cada instancia. Avaliar stylesheet nativo do block versus recurso de
modulo, incluindo importacao cross-module e carregamento deduplicado.

Normalizacao de widgets precisa tratar width, margem automatica, wrappers, formularios, labels, foco e tabela.
O browser publicado mostrou interferencia de OSFillParent e ThemeGrid_MarginGutter. O renderizador O11 tambem
altera nomes de custom properties CSS inline; a correcao atual usa propriedades concretas e recusa essa forma
incompativel. E uma limitacao conhecida, nao suporte completo a CSS. Variaveis declaradas no stylesheet sao
um caso diferente. Nao resolver isso espalhando !important, CSS por tela ou mutacoes DOM depois do render.

JS de funcao pura, evento e lifecycle deve ser distinguido. OnInitialize, OnParametersChanged, OnReady,
OnRender e OnDestroy existem no Model API do block. E preciso provar ordem, montagem/desmontagem, limpeza de
listeners/timers/requests e mudanca de input. Um modulo JS global nao substitui estado por instancia.
Bibliotecas que controlam seu proprio DOM so podem entrar por um contrato explicito de integracao; nao por
um fallback silencioso que perde a edicao nativa no Studio.

## Data escrita em C#

Classes/records e atributos C# podem expressar entidades e estruturas; enum pode expressar uma static simples.
Um SDK pequeno deve declarar apenas o que C# nao expressa sozinho: persistencia, comprimento, precisao/escala,
indices, defaults de banco, relacionamentos, comportamento de update e politicas. Reutilizar sintaxes conhecidas
quando a semantica coincide. Nao exigir EF Core nem executar migrations SQL para gerar entidades OutSystems.

Id<Incident> e Id<Category> devem ser distintos no frontend; nao converter todos os identificadores em long
sem verificacao. Referencia nullable, string vazia, Mandatory, NullIdentifier e NullDate nao sao equivalentes
por definicao. Definir uma tabela de conversoes e rejeitar mapeamentos sem preservacao, em vez de adivinhar.
O atributo C# required tambem nao equivale sozinho a validacao de formulario ou restricao de banco.

Static entity pode ter Label, Code, SlaMinutes, ColorHex e Order; um enum sozinho nao contem esse modelo todo.
Para static enriquecida, usar declaracao de registros tipados ou metadados declarativos. Nomes e valores
explicitos do enum precisam de identidade persistente. Nunca mapear pela posicao na lista nem assumir que o
Id autonumerado da static e o valor numerico do enum. Flags e alias numericos requerem politica propria.

Renomear/remover entidades ou atributos e evolucao de esquema: distinguir mudanca de nome, nova identidade,
backfill, compatibilidade e preservacao dos dados. Nao recriar uma tabela porque a classe mudou de nome.
Gerar revisao da migracao antes da entrega; reutilizar os gates nativos de dados.

## Logic escrita em C#: dois destinos explicitos

1. C# para actions nativas: Roslyn resolve simbolos e operacoes; um subconjunto publicado e testado baixa para
   um contrato tipado de controle/efeitos e depois para os nos existentes. Continua editavel e depuravel como
   action no Studio. Nao e executar o assembly C# dentro do Model API.
2. C# executado como extensao XIF: preservar a implementacao .NET num assembly, gerar o contrato da extensao e
   wrappers nativos quando pertinentes. Adequado a bibliotecas/algoritmos cuja semantica nao cabe no grafo.
   Continua sendo uma extensao; nao equivale a converter o corpo em nos visuais. Sem fallback automatico.

O primeiro frontend deve cobrir regras usuais: parametros/retornos, variaveis, if/switch, loops, chamadas,
listas/records, erros e operacoes de dados reconhecidas. LINQ sobre listas em memoria e LINQ de consulta ao
banco precisam de destinos distintos. Traduzir Where/OrderBy/Skip/Take para query preserva filtros, ordem,
paginacao, total e custo; carregar tudo e filtrar em memoria nao e equivalente operacionalmente.
Reflection, dynamic, threads, Task.Run, filesystem, bibliotecas arbitrarias e async nao podem virar no nativo
por simples correspondencia textual. Diagnosticar o recurso e o destino suportado na linha de origem.

A IR precisa registrar tipo de cada operacao, conversoes, curto-circuito, overflow, arredondamento, igualdade,
mutabilidade e efeitos. C# 3/2 e 3/2m ja produziram 1 e 1.5 na prova. Definir DateTime/timezone, null/defaults,
List<T> versus listas nativas, referencias versus copia de records e tratamento de excecoes. Autorizacao,
transacao e idempotencia sao efeitos contratuais; async remoto nao implica transacao distribuida.

C# no servidor nao resolve client actions: o browser tem outro runtime. Usar autoria cliente tipada apropriada
ou um subconjunto explicitamente traduzido, sem prometer que qualquer .NET roda no cliente.

## Testes: o que cada camada prova

- Teste do codigo fonte: executa a regra pura C# com doubles para relogio/usuario/repositorio; rapido e familiar.
- Teste do compilador: exemplos positivos/negativos, tipos, source maps e equivalencia esperada das operacoes.
- Prova nativa: Verify, reload, identidade, contrato e merge; ler o modelo independentemente dos ops emitidos.
- Teste diferencial: mesmos casos no C# e na action publicada; comparar retorno, erro e efeitos persistidos.
- Teste no browser: layout real, inputs/eventos, loading/erro/vazio, paginas, responsividade e acessibilidade.

O modelo carregado headless nao e o runtime de negocio do servidor. Nao existe evidencia neste checkout de
um runner universal que execute TODAS as actions OutSystems como testes unitarios offline. Nao repetir essa
promessa com base em Verify, grafo ou execucao de C# isolado. SQL, roles, transacoes, extensoes, BPT e UI exigem
provas no runtime pertinente. Fixtures privadas ficam no lab, nunca em modulos do usuario.

## Evidencia executada nesta investigacao

A prova scripts/probes/highcode/native-block.json cria um block publico, input Text obrigatorio, estado local,
evento Integer obrigatorio e Footer. Quatro instancias em duas telas usam argumentos e conteudos diferentes.
HighCodeArchitectureProbeTests passou: Verify sem mensagens, reload, atualizacao interna, merge nativo,
identidades/SourceBlock preservados e valores de argumentos/eventos/slots conferidos. NAO executou o clique
desse block no browser nem provou estado independente em runtime, lifecycle ou consumidores de outro modulo.

O RoslynProbe leu metadados de Incident (Id tipado, Text com comprimento, DateTime nullable e enum), preservou
valores 10/20/30/40, compilou e executou sete casos puros; CS0103 foi devolvido com arquivo/linha/coluna.
Nao implementou C# -> action nativa. A prova usa SDK .NET 10 instalado, fora de src; isso nao define a versao
do produto ou das extensoes. Nao existe PackageReference Roslyn adicionado ao produto.

A prova do Dashboard publicada no lab passou paginas recentes 20+10 e meus incidentes 10+4, busca reiniciando
somente sua pagina, barras/cores renderizadas e largura 390 sem overflow. O script completo ainda registra
falha numa assercao de presenca do link Login no contexto anonimo. Nao declarar toda a prova verde.
A selecao correta da pagina precisou de recorte explicito da lista na action; apenas StartIndex no aggregate
nao recortou o retorno por assignment. A solucao atual consulta um prefixo limitado; para paginas profundas,
um backend de query com OFFSET/keyset e contagem separada precisa ser avaliado e medido.

## Integracao com o Studio sem modificar a instalacao

Hoje scripts/open_studio.ps1 copia Anvil.Bridge/Core para o clone, tools/Anvil.Inject modifica
ServiceStudio.WebViewImplementation.dll e WebViewControl.Avalonia.dll, e o launcher altera deps.json. Isso e
patch persistente de binarios do clone. A instalacao examinada usa .NET 8.0.27.

Ordem preferida: ponto de extensao oficial/integração interna com a OutSystems; se nao disponivel, startup hook
.NET pequeno e explicito, iniciado por launcher do usuario, com nossas bibliotecas fora da instalacao; manter
worker de compilacao separado e protocolo autenticado. DOTNET_STARTUP_HOOKS carrega codigo antes do Main sem
reescrever o executavel. Ainda carrega uma DLL nossa no processo; nao significa ausencia de injecao runtime.
Nao e attach a processo ja aberto e nao se aplica automaticamente ao Integration Studio .NET Framework.

Prova obrigatoria antes de migrar SS4/SS5: hashes de todos os arquivos nativos/deps/runtimeconfig identicos,
startup sem regressao, resolucao de assemblies sem duplicar tipos do host, prontidao do dispatcher, snapshot,
merge, undo, dialogos, autorizacao e desligamento. Configuracao somente no processo iniciado; nao propagar hook
a filhos indevidos. Falha precisa ser recuperavel sem corromper o Studio. CDP e capacidade separada: remover o
patch da bridge nao remove automaticamente o patch de depuracao do WebView. Nao adicionar debugger/profiler
ou detours apenas para trocar patch em disco por uma dependencia mais fragil em memoria.

## Comercializacao e incorporacao

O destino desejado e a propria OutSystems. Isso torna especialmente importante a origem e transferibilidade
do nosso codigo e das dependencias de terceiros. Nao pressupoe autorizacao atual para copiar implementacoes
proprietarias nem permite ignorar obrigacoes de componentes que a OutSystems tambem nao poderia redistribuir.

Avaliar por versao: licenca/SPDX, copyright/notices, dependencias transitivas, patentes quando aplicavel,
redistribuicao, uso comercial e possibilidade de incorporacao sem obrigacao incompatível de abrir o nucleo.
Incluir fontes, fontes tipograficas, icones, templates e ativos de mockups/Figma. Separar dependencias de build,
testes, runtime e aquelas incluidas nos apps gerados. Gerar SBOM e conferir o pacote publicado, nao apenas csproj.

Roslyn tem licenca MIT na fonte consultada, permitindo uso comercial/distribuicao com preservacao dos avisos;
isso e candidato compativel, nao aprovacao automatica de todo SDK/pacote/transitivas. Mono.Cecil 0.11.6 ja esta
no injetor atual e tambem deve entrar no inventario. A implementacao posterior de UI adotou Esprima 3.0.6,
BSD-3-Clause, com licenca incluida no output; decisao e limites no ADR-017. Roslyn continua somente na prova
isolada, sem dependencia nova do produto para C#.
DLLs da OutSystems sao usadas localmente, com Private=false nas referencias de produto; decompilados ficam
fora do repositorio. Evitar copiar codigo decompilado. O destino comprador nao altera direitos por antecipacao.

## Ordem de implementacao e gates de decisao

1. Fechar as provas pendentes do Dashboard e separar recibos de lab/produto. Nao expandir cobertura presumida.
2. Revisar/integrar a camada de contrato UI em desenvolvimento; definir identidades, ownership e source maps.
3. Extrair HtmlExpander para produzir esse contrato. Mesma entrega/controlador; manter compatibilidade legada.
4. Prova vertical de block high code: inputs, eventos, slots, quatro instancias, duas telas e outro modulo;
   update de corpo e assinatura, rename, consumer fora do escopo, undo, lifecycle e CSS aninhado no browser.
5. Frontend C# Data sobre SpecExpander: tipos/ids/nullability/enums enriquecidos; schema diff e prova de dados.
6. Frontend C# Logic com contrato semantico e pequeno SDK; primeiro regras puras, depois dados/efeitos.
7. Runner diferencial C#/action publicada com casos de fronteira; so entao ampliar a linguagem suportada.
8. Backend XIF explicito, toolchain e direitos revisados; provar recursos/dependencias/consumo/publicacao.
9. Provar bootstrap sem patch separadamente. Nao trocar o mecanismo de entrega enquanto redesenha autoria.
10. Avaliar uma LLM sem contexto em tarefas equivalentes: tokens autorados, intervencoes, tempo de escrita,
    compilacao, espera e retrabalho; beleza avaliada na pagina publicada, fidelidade e componentes reais.

Nao estimar prazo final nem declarar suporte universal antes dos gates. Cada capacidade nova substitui uma
limitacao documentada com evidencia; nao adiciona outra rota de recuperacao para a LLM escolher.

## Progresso posterior da implementacao UI

O frontend `HtmlComponents` ja aceita um arquivo HTML com componentes, CSS e JavaScript de modulo, sem
manifesto de bindings separado. Ele produz o mesmo contrato nativo `screens`/`logic`/`data` do controlador.
`deliver --spec arquivo.html` e `propose.uiSource` entram por esse contrato. No laboratorio SS5 foram
publicadas e exercitadas duas definicoes de block, instancias independentes, composicao aninhada, slots
atraves de dois niveis, eventos tipados repetidos e ordenados, ciclo de vida e controles nativos.

Isso ainda nao fecha o gate 4 inteiro: importacao/reuso por outro modulo na entrada high code, migracao de
contratos publicos e convergencia das fontes de dados/paginacao do Dashboard continuam pendentes. A
regressao ampla fechou com 626/626 testes, mais 9/9 do protocolo MCP. O compilador foi instalado em SS4 e
SS5 com DLL identica; a prova viva foi feita no SS5. O SS4 ainda exige reinicio seguro da bridge para
usar a credencial atual. Documentacao precisa da sintaxe e limites: `docs/UI-HIGH-CODE.md`.
Nao iniciar a implementacao Data/Logic como se esses gates ja estivessem fechados.

### Convergencia pendente: dados de tela sem um manifesto paralelo

O recorte inicial nao deve crescer com uma segunda lista manual de bindings. A proxima fronteira precisa
separar parser, vinculacao de simbolos e emissao. Hoje `HtmlComponents.Compile` pode funcionar sem modelo
porque todas as assinaturas dos blocos estao no proprio arquivo. Imports de actions/blocos e tipos de
registros exigem contexto do snapshot real, antes de congelar o contrato final.

Entrada pretendida: imports JavaScript por modulo, assinaturas fornecidas pelo contexto (tambem como
declaracoes TypeScript para leitura pela LLM), estado e funcoes normais. O Hybrid resolve esses imports
contra referencias existentes ou produtores registrados, vincula as assinaturas/chaves/versoes, e gera
o contrato. O autor nao deve repetir manualmente os parametros/outputs ja declarados pelo produtor.
Imports de arquivos HTML precisam entrar no hash do recibo como parte da fonte; importar outro modulo
nao equivale a concatenar uma copia de seu bloco.

Para registros e listas, a fronteira JavaScript/native precisa de conversores tipados. A prova atual da
fila de eventos ja demonstra JSONDeserialize + estruturas nativas, mas nao prova listas arbitrarias:
estrutura, entidade, lista de entidade e record agregado possuem formatos distintos. Datas, Identifier,
Long Integer, Decimal, Null e campos de referencias precisam de regras explicitas e testes de ida/volta.
Nao serializar escalares com JSONSerialize, que exige Record/Record List. Nao usar Number para IDs acima
da precisao segura do JavaScript; o tipo de transporte precisa preservar o valor.

Repeticao de uma lista deve emitir o widget nativo e o escopo de item/indice tipado, preservando a ordem.
Paginacao precisa testar TotalCount separado do tamanho da pagina, limite final, pagina vazia, mudanca de
filtro que volta a primeira pagina e identidade estavel dos registros. O experimento anterior mostrou
que configurar StartIndex num aggregate e depois atribuir a lista inteira nao garante o corte esperado.
O lowering deve representar o corte efetivo e a prova deve executar duas paginas com IDs distintos.

O Model API expoe `IJavaScriptNode.IsAsynchronous` somente para leitura, e o parser nativo acompanha
referencias `$actions`. Isso e uma pista para a interoperabilidade, nao prova de suporte a `async` na
linguagem nova. Apenas embrulhar um handler async e gravar o estado ao final esconderia `loading=true`
durante a espera e permitiria respostas antigas sobrescreverem filtros novos. Antes de aceitar async:

1. Provar o protocolo de conclusao/erro do JavaScript nativo e chamadas a actions com referencias reais.
2. Definir os pontos de commit do estado antes/depois da espera, com semantica observavel no navegador.
3. Provar erro, retry, duas respostas fora de ordem e desmontagem do bloco durante a chamada.
4. Manter as guardas no servidor. Anonymous tolerado pelo gate nao transforma leitura protegida em publica.
5. Compilar o Dashboard existente por essa entrada, incluindo as listas paginadas, e comparar os resultados
   com o servidor e o comportamento visual. So entao retirar a dependencia do manifesto legado nesse caso.

Movimento de placeholders tambem precisa de prova propria: o metodo instalado
`ModelExtensions.ConvertToKindAndMoveToParent` usa `ObjectCloner.MoveObject`, que clona/reassocia referencias
e marca uma substituicao. Nao e prova de conservacao da chave publica. A investigacao fica fora do repo;
`NativeUiMoveProbeTests` verifica o comportamento do runtime instalado antes de usar essa operacao no
reconciliador. Nao implementar reparent por escrita de campos privados ou tratar delete/create como move.
Resultado da prova: a conversao para o mesmo tipo nao encontrou uma conversao permitida; a chamada direta
de MoveObject recusou o placeholder com `Clone not allowed`. O teste confirmou a chave e os quatro
consumidores locais preservados apos a recusa. O reconciliador bloqueia a mudanca de pai de placeholders
publicos; isso permanece uma capacidade pendente, sem alegacao de suporte por outro modulo.

## Fontes primarias consultadas

- Microsoft, modelo do compilador Roslyn: https://learn.microsoft.com/en-us/dotnet/csharp/roslyn-sdk/compiler-api-model
- Licenca Roslyn: https://github.com/dotnet/roslyn/blob/main/License.txt
- Runtime .NET, startup hooks: https://github.com/dotnet/runtime/blob/main/docs/design/features/host-startup-hook.md
- OutSystems, codigo de extensoes: https://github.com/OutSystems/docs-product/blob/master/src/integration-with-systems/integration-studio/extension-life-cycle/extension-code.md
- OutSystems, Verify de extensoes: https://github.com/OutSystems/docs-product/blob/master/src/integration-with-systems/integration-studio/extension-life-cycle/extension-verify.md

A documentacao de extensoes descreve metodos C# e sincronizacao de assinaturas/templates. Nao descreve
transpilacao arbitraria de C# para actions visuais. A proposta de IR/frontends acima e inferencia arquitetural
nossa, apoiada nas provas e limites registrados, nao uma capacidade prometida pela OutSystems.
