# Regras do OutSystems padrões

São 35 regras de implementação OutSystems e uma regra de produto (P7). A coluna **Checagem** diz quanto a ferramenta
consegue decidir sozinha: automática (o detector decide), parcial (o detector acusa o que consegue ver e o resto vai
para perguntas de revisão) ou manual (só pergunta de revisão). A coluna **Estágios** diz em que estágio há detector
hoje. A coluna **Plataformas** diz onde a regra vale.

Hoje toda detecção lê jobs e OML do O11. Numa execução com `--platform odc`, os estágios job, truechange e oml não
rodam, e cada regra que vale no ODC sai como "não checada no ODC ainda"; a AR1 sai como "não se aplica ao ODC". O
estágio runtime não depende de plataforma. O pré-requisito K0 do estágio truechange (ok, accepted, isValid e nenhuma
policyMessage) é interno: não é regra e não aceita exceção.

| Id | Regra | Checagem | Estágios | Plataformas |
|---|---|---|---|---|
| L1 | Simples e direta. Antes de criar qualquer coisa, pergunte se existe uma forma nativa mais curta: uma função built-in, um list action, um mapping ou um filtro no aggregate. | manual | — | O11 e ODC |
| L2 | Sem variável auxiliar quando dá para calcular direto. Use a expressão no ponto de uso. Crie uma local só quando o valor é reutilizado ou quando deixa o fluxo mais legível. | parcial | job | O11 e ODC |
| L3 | No máximo um If por valor em um Assign. Com mais de um, use um If node no fluxo ou uma client ou server action com nome claro. | automática | job, oml | O11 e ODC |
| L4 | Um Assign por intenção. Um Assign chamado "Aplicar defaults" não deve também limpar erros. | manual | — | O11 e ODC |
| L5 | Sem JavaScript para lógica de negócio. JavaScript só para o que o runtime não oferece, como clipboard ou foco em elemento, sempre isolado e nomeado. | automática | job, truechange, oml | O11 e ODC |
| L6 | Sem JSONSerialize ou JSONDeserialize para passar dados dentro do app. Use estruturas e parâmetros tipados. | parcial | job, oml | O11 e ODC |
| L7 | Sem valores fixos no código. Configuração vai em Site Properties, e domínios fixos vão em Static Entities. | parcial | job | O11 e ODC |
| T1 | List actions em vez de For Each sempre que possível: ListFilter, ListAny, ListAll, ListIndexOf, ListSort, ListDistinct e ListAppendAll. | parcial | job | O11 e ODC |
| T2 | Mapping em vez de For Each com ListAppend. Para converter uma lista de um tipo em outro, use o mapeamento de dados do Assign ou do parâmetro. | parcial | job | O11 e ODC |
| T3 | For Each só quando cada item exige efeito ou uma decisão que os list actions não expressam. Nunca coloque uma chamada ao servidor ou ao banco dentro de um For Each: isso gera N+1 chamadas. | automática | job, oml | O11 e ODC |
| T4 | Valide os filtros de lista em runtime. No ODC, uma condição de ListFilter no client escrita como Lista.Current.X passou no build e falhou em execução. Não se sabe se o O11 tem o mesmo problema. Não confie só na validação do Studio: teste. | parcial | job, oml, runtime | O11 e ODC |
| D1 | Leitura de banco só por Screen Aggregate ou Data Action em Reactive e Mobile. Em Traditional Web, pela Preparation. | parcial (hoje só revisão) | — | O11 e ODC |
| D2 | Filtrar, ordenar e juntar dentro do aggregate, não no client depois. Busque só os atributos usados e defina Max Records. | parcial | job, oml | O11 e ODC |
| D3 | SQL só quando o aggregate não resolve. Sempre com parâmetros, e Expand Inline só com valores validados. | parcial | job, truechange, oml | O11 e ODC |
| D4 | API que preenche a tela vai numa Data Action. API chamada num submit pode ficar na screen action, via uma server action wrapper. | parcial | job | O11 e ODC |
| D5 | Nada de aggregate ou server action dentro de loops. | automática | job, truechange, oml | O11 e ODC |
| S1 | Não use eventos de ciclo de vida para chamar server ou service actions. Isso vale para OnInitialize, OnReady, OnRender, OnParametersChanged e OnAfterFetch. Esses dados vêm de Data Actions ou Aggregates com Fetch at start. | automática | job, truechange, oml | O11 e ODC |
| S2 | Uma client ou screen action faz no máximo uma chamada ao servidor. Quando precisar de várias, crie uma server action que orquestra tudo. Isso dá um round-trip só, uma transação só e um único ponto de tratamento de erro. | automática | job, oml | O11 e ODC |
| S3 | Toda integração externa (REST ou SOAP) fica numa server action wrapper, com tratamento de exceção, timeout adequado e sem logar tokens nem dados pessoais. | parcial | job, oml | O11 e ODC |
| S4 | Tempo limite pensado para a API real. O padrão de 20 s das screen requests nem sempre basta. | parcial | job | O11 e ODC |
| U1 | Não use a propriedade Visible. Controle a visibilidade com If widgets. | automática | job, oml | O11 e ODC |
| U2 | Reutilize primeiro os padrões da library de padrões do app (configurável) e depois o OutSystems UI. Não crie blocks sem necessidade. Prefira uma estrutura simples na própria tela. | parcial (hoje só revisão) | — | O11 e ODC |
| U3 | Nada de lógica pesada em expressões de widget. Calcule no fluxo, uma vez só. | parcial | job | O11 e ODC |
| U4 | CSS no tema ou na library, não inline. Use as classes utilitárias do OutSystems UI. | parcial | job, truechange, oml | O11 e ODC |
| U5 | Blocks se comunicam por parâmetros e eventos, nunca lendo o estado da tela-pai. | manual | — | O11 e ODC |
| N1 | Todo elemento criado tem nome e descrição curtos e significativos: actions, variáveis, parâmetros, widgets relevantes e nodes do fluxo. Actions: verbo + objeto (ValidateAddress, GetOrderOptions). Booleanos: prefixo Is, Has ou Can. If nodes: uma pergunta (Order load succeeded?). Assigns: a intenção (Apply default values). | parcial | job, oml | O11 e ODC |
| N2 | Descrições explicam o porquê, não repetem o nome. | parcial | job, oml | O11 e ODC |
| N3 | Fluxos grandes levam comentários flutuantes marcando cada bloco lógico. Se o fluxo não cabe numa tela, extraia partes para actions com nome próprio. | parcial | job | O11 e ODC |
| N4 | Sem nodes mortos: nada de End órfão, ramo inalcançável ou variável sem uso. Os warnings do TrueChange ficam zerados. | automática | job, truechange, oml | O11 e ODC |
| E1 | Evite locais desnecessárias: poucas, escalares sempre que possível. | parcial | job | O11 e ODC |
| E2 | Client Variables só com tipos básicos, poucas e nunca sensíveis. Session Variables em Traditional Web seguem a mesma regra. | parcial | job, oml | O11 e ODC |
| E3 | Configuração em Site Properties, nunca numa variável com valor padrão fixo. | parcial | job, oml | O11 e ODC |
| AR1 | Respeite o Architecture Canvas (End-user, Core e Foundation): sem referências para cima, sem ciclos. Entidades ficam no Core, expostas como read-only, e a escrita passa por actions. | automática | job, oml | só O11 |
| AR2 | Checagem de role no servidor, não só escondendo botão na UI. Nunca confie no input vindo do client. | parcial | job, truechange, oml | O11 e ODC |
| AR3 | Processos longos vão para Timers ou BPT, nunca numa screen request. | parcial | job, oml | O11 e ODC |
| P7 | Regra de produto. Pontos de entrada automáticos (tools, runners, timers) não gravam entidades protegidas nem chamam actions reservadas a decisão humana, e o código nunca atribui site properties de switch. Configurável em `config.p7`; a checagem de escrita fica desligada enquanto a lista de entidades protegidas estiver vazia. Não aceita exceção. | automática | job, oml | O11 e ODC |

## O que a detecção procura hoje (O11)

| Regra | Sinais |
|---|---|
| L1 | Só revisão: pergunta se built-in, list action, mapping ou filtro de aggregate substitui algum trecho. |
| L2 | Local escrita uma vez e pouco lida (aviso). |
| L3 | Mais de um `If(` no valor de um Assign. |
| L4 | Só revisão. |
| L5 | Nó JavaScript, Script, `html.scripts`, atributo `on*`, JavaScript no módulo ou no bloco, warning `JavascriptInjection`. |
| L6 | Nó JSON (só passa com exceção do próprio elemento), Text com nome `*Json`, campos de `config.l6`. |
| L7 | Literal de URL, host ou e-mail; texto comparado com `=` ou `<>` (aviso); número fora de `numericAllowProps` (aviso); site property secreta com DefaultValue. |
| T1 | Corpo de ForEach que parece list action (aviso); `html.derived`. |
| T2 | ListAppend de `*.Current.*` dentro de ForEach (aviso). |
| T3 | Igual à D5. |
| T4 | Cada list action vira item de `runtimeTests` com a condição; o estágio runtime cobra a evidência do E2E. |
| D1 | Sem detector hoje; pergunta de revisão. |
| D2 | Aggregate sem Max Records, `get` sem `max`, ListFilter ou ListSort no cliente sobre aggregate, `html.derived`. Atributos usados ficam na revisão. |
| D3 | Todo nó SQL precisa de exceção com o motivo; ExpandInline fora de token T-SQL literal; `sp_executesql` ou `EXEC()`; warnings `SQLInjection` e `SQL_ExpandInlineNotValidated`. |
| D4 | REST fora de `config.integrationModules`; REST chamado direto da tela. |
| D5 | Consulta ou chamada ao servidor dentro de laço ou de ciclo do fluxo (Tarjan); warning `EntityActionInsideLoop`. |
| S1 | Evento de ciclo de vida que chega ao servidor; warnings `ClientActionWithServerRequestsOnLifecycleEvent` e `SelfRefreshingAggregate`. |
| S2 | Mais de uma chamada ao servidor no mesmo caminho, inclusive por client actions chamadas; binding `call` da op html. |
| S3 | REST fora dos módulos de integração; site property que parece segredo sem IsSecret. |
| S4 | Método REST sem `TimeoutinSeconds` ou fora de `config.timeoutPolicy`. |
| U1 | Visible fora de vazio e `True`; atributo `hidden`; binding `visible`. |
| U2 | Sem detector hoje; a pergunta de revisão cita `config.patternLibrary` quando preenchida. |
| U3 | Expressão de binding que chama função client. |
| U4 | Atributo `style`, CustomStyle (aviso), StyleSheet de tela, StyleSheet de bloco fora de `config.libraries`, warning `InvalidCSSStyle`. |
| U5 | Só revisão. |
| N1 | Descrição vazia, Label genérico, If que não é pergunta, action que não começa por verbo, booleano sem Is, Has ou Can. |
| N2 | Descrição curta, igual ao nome, só com as palavras do nome, ou com marcador. |
| N3 | Fluxo acima de `limits.commentAt` passos sem comentário; acima de `limits.extractAt` (aviso). |
| N4 | Todo warning do TrueChange (base e novos), End órfão, nó inalcançável, nó desativado. |
| E1 | Mais locais que `limits.maxLocals`; local lista ou record (aviso). |
| E2 | Toda client variable (exige exceção), tipo não básico, nome sensível. |
| E3 | Local com default literal nunca atribuída; site property esperada ausente (`config.expectedSiteProperties`). |
| AR1 | Camadas (`config.modules`, `modulePatterns`, `forbiddenRefs`); entidade ou static fora do Core; entidade pública sem ExposeReadOnly. |
| AR2 | Tela sem Roles ou com Anonymous; escrita ou leitura de dado do sujeito sem guarda antes; AllExceptions sobre a guarda; `GetUserId()` vindo do cliente. Fachada pública que só repassa ao próprio `<Nome>_Impl` herda a verificação do `_Impl`. |
| AR3 | Tela que chega a `config.longRunning` ou a REST; timer sem TimeoutInMinutes (aviso). |
| P7 | Escrita em `config.p7.protectedEntities` (menos `allowedEntities`) a partir de `config.p7.entryPatterns`; chamada a `config.p7.forbiddenCalls`; assign de `config.p7.siteSwitches`. |
