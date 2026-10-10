# Autoria HTML/CSS/JS: investigacao tecnica

## Conclusao

Ha fundamento tecnico para HTML/CSS/JS como fonte de autoria. A implementacao deve preservar a composicao HTML/CSS e integrar controles, estado, eventos e chamadas de actions ao runtime OutSystems. Nao e uma conversao automatica irrestrita de qualquer site para widgets nativos.

A investigacao esta concluida para definir a primeira prova vertical. O compilador HTML -> OML ainda nao foi implementado nem instalado. A ampliacao anterior da matriz de telas permanece pausada por orientacao do usuario; seus arquivos em desenvolvimento nao representam capacidades entregues.

## Evidencia coletada

1. Leitura somente de GETs da aplicacao publicada e de seus bundles. O navegador de teste era headless e isolado; nenhuma action de escrita do produto foi acionada. Capturados o DOM, as dependencias e a implementacao de renderizacao dos componentes.
2. Consulta aos descritores AdvancedHtml e Input das DLLs instaladas por decompilacao. Os arquivos decompilados ficam em `%LOCALAPPDATA%/Anvil/investigations/html-authoring`, fora do repositorio. O documento registra conclusoes e nomes de APIs, sem incorporar codigo decompilado ao produto.
3. Uma referencia completa HTML/CSS/JS foi escrita em uma passagem inicial: indicadores, grafico por barras, tabela, filtros, formulario em dialogo, estado vazio e adaptacao mobile. Dados e gravacao sao simulados localmente.
4. Prova browser focal de diferenca de DOM e CSS. Os metodos nativos de renderizacao de Input/Form foram chamados com doubles; em seguida, a estrutura adicional de Input foi reproduzida ao redor do input da pagina local. Isso isola o problema de seletores, mas NAO equivale a montar o controle OutSystems completo ou entregar um OML.

Resultados e hashes: `docs/proofs/2026-09-05-autoria-html-investigacao.json`.
Artefatos locais: `.local/html-authoring-investigation/` (reference.html, capturas desktop/mobile, authoring-probe.cjs, authoring-probe.json, native-render-fragments.json, live-dom.json e bundles consultados). Material do modulo do usuario permanece somente local; nao foi convertido em fixture de produto.

## O que o runtime mostrou

| Aspecto | Observacao | Consequencia para o compilador |
|---|---|---|
| HTML semantico | AdvancedHtmlDescriptor valida a tag e seus filhos; o runtime AdvancedHtml renderiza a tag configurada com seus filhos. | Compilar estrutura semantica para HTML Element nativo, preservando a hierarquia. Tags nao suportadas precisam de diagnostico antes da entrega. |
| Containers | Container renderiza um div com classes e propriedades. | Grid, flex, espacamento e tipografia devem continuar no CSS; nao precisam virar um bloco visual diferente para cada div. |
| Controles | Input renderiza um span.input-text contendo input e a area de validacao. | A estrutura pode quebrar seletores diretos, dimensoes e alinhamento. Precisamos de adaptadores de DOM/CSS por controle, incluindo estados de validacao. |
| Estilos do runtime | fillWithBuiltinProperties acrescenta gridProperties, estilos, atributos e eventos. | Controlar estilos implicitos da plataforma e a precedencia do CSS. Nao presumir que o CSS original prevalece sobre tudo. |
| Formulario | Form renderiza form com noValidate e impede o envio HTML padrao. | Integrar validacao e submit com os eventos/actions da plataforma; copiar um listener de submit nao comprova equivalencia funcional. |
| JavaScript | O bundle publicado contem funcoes de JS nodes com parametros, actions e promises. | Preservar JavaScript como codigo cliente em JS nodes e gerar as ligacoes necessarias. Nao tentar converter cada linha em um widget de logica. |
| Atualizacao da pagina | A renderizacao React depende de props, estado e geracoes do modelo. | Uma alteracao direta no DOM nao vira automaticamente estado do OutSystems. Evitar dois donos do mesmo estado ou da mesma subarvore. |

Na prova focal, `.field > .control` deixou de atingir o input quando o span nativo foi introduzido:

| Variante | Largura | Altura | Raio | Padding |
|---|---:|---:|---:|---|
| HTML original | 930 px | 44 px | 7 px | 10 px 12 px |
| Estrutura nativa, CSS inalterado | 189 px | 27 px | 0 px | 1 px 2 px |
| Estrutura nativa, adaptador CSS | 930 px | 44 px | 7 px | 10 px 12 px |

Busca, estado vazio e inclusao de registro na demonstracao local passaram. Em viewport de 390 px, os indicadores ficaram em duas colunas e nao houve overflow horizontal do documento. A tabela possui area propria de scroll. Isso nao certifica equivalencia visual completa entre uma pagina HTML e um modulo OutSystems.

## Causa concreta no dashboard mostrado pelo usuario

O job original `tests/jobs/incidents-ui-dashboard.json` pede o arquetipo dashboard com uma lista de indicadores. `ScreenExpander.Dashboard()` emite um CardSectioned e um Counter para cada indicador diretamente em MainContent, sem declarar um grid. Nos jobs operacionais posteriores, os graficos sao acrescentados dentro de Columns2 em MainContent. O JavaScript publicado confirma essa composicao.

Portanto, os cards empilhados e os graficos separados nao demonstram incapacidade de CSS do OutSystems: refletem escolhas feitas na descricao/geracao da tela. Mais testes de existencia dos widgets poderiam certificar exatamente essa composicao inadequada. Esta leitura nao reconstruiu os tempos da sessao nem atribui toda a hora de trabalho a uma unica causa.

## Arquitetura proposta para a primeira implementacao

1. **Fonte unica de autoria:** HTML, CSS e JavaScript normais, mais um manifesto pequeno de bindings tipados para dados, estado, eventos e actions. A LLM produz a pagina completa na primeira passagem; o preview verifica o resultado depois.
2. **Parser e representacao interna:** interpretar HTML, CSS e JS com parsers apropriados; validar elementos, referencias, recursos e capacidades. A representacao interna pertence ao compilador, nao e uma nova linguagem de layout que a LLM precisa escrever.
3. **Preservacao de apresentacao:** manter tags, ordem, classes, atributos de acessibilidade, regras CSS, variaveis e media queries. Usar HTML Element e containers nativos quando forem equivalentes. Usar blocos compostos quando o contrato os pedir ou quando sua equivalencia estiver provada.
4. **Adaptadores de controles:** mapear input, select, textarea, form, button e repeticao de dados para controles/estruturas nativas. Compensar wrappers e estilos da plataforma. Seletores complexos, IDs gerados, foco, validacao e listas dinamicas exigem tratamento explicito; nenhuma aproximacao silenciosa.
5. **JavaScript e bindings:** JS nodes/client actions executam os handlers; wrappers gerados chamam actions declaradas com entradas/saidas tipadas. Montagem e limpeza seguem o ciclo de vida da tela. O estado persistente da UI tem um dono definido. Escritas via innerHTML/replaceChildren em uma subarvore controlada pelo renderer exigem uma estrategia declarada; nao sao automaticamente transpiladas para listas nativas.
6. **Identidade e atualizacoes:** chaves estaveis na fonte, independentes do texto exibido e da posicao, mapeiam elementos para ObjectKeys. O compilador calcula delta sobre o mesmo contrato e preserva identidades/consumidores onde possivel. Mudancas de tipo ou reparenting sem preservacao comprovada retornam diagnostico. O reconciliador por nome que estava em desenvolvimento nao deve ser tratado como solucao completa de identidade.
7. **Entrega existente:** reutilizar snapshot, transacao, Verify, prova independente, merge e recibo do controlador. Erros apontam para a linha/elemento da fonte HTML/CSS/JS; a retomada usa a mesma tarefa e a mesma fonte.
8. **Aceitacao renderizada:** comparar a referencia e o modulo realmente publicado no laboratorio, no mesmo viewport, estado e dados. Medir posicoes/estilos, diferencas visuais e comportamento. Heuristicas e screenshots ajudam, mas nao substituem julgamento de design nem autorizam prometer fidelidade automatica universal.

## Primeira prova vertical, antes de ampliar cobertura

Alvo inicial: uma pagina Reactive nos laboratorios de SS4 e SS5. Faixa do Studio e tipo de modulo sao coisas diferentes; este alvo nao promete ainda cobertura Traditional ou Mobile.

- Fonte HTML/CSS/JS completa, com quatro indicadores em grid, barras dentro do painel, filtros, tabela e formulario agrupado.
- Estado preenchido, vazio, erro e carregamento; envio invalido e valido; navegacao com identificador valido e inexistente.
- Geracao do OML por uma compilacao e um merge; publicacao apenas do laboratorio para medir a pagina real.
- Comparacao desktop/mobile entre referencia e resultado nativo, incluindo o impacto do tema e dos wrappers reais.
- Segunda compilacao da mesma fonte sem duplicacoes; alteracao pontual preservando bindings, estado aplicavel e identidade de elementos sobreviventes.
- Tempos separados de autoria pela LLM, compilacao, Verify, merge, publicacao, renderizacao e retrabalho. A investigacao atual nao fornece um benchmark da futura conversao.
- Importacao Figma/mockup deve terminar na mesma fonte de autoria. A investigacao atual nao testou importacao ou fidelidade a um Figma.

## Estado do ambiente

Nesta investigacao, nao houve build, restart, merge, publicacao ou alteracao de Incidents_CS/Incidents_UI. SS4 e SS5 mantem as alteracoes anteriores ja sincronizadas. A prova de preservacao e igualdade das DLLs dessa sincronizacao esta em `.local/screen-contract-dev/both-lanes-baseline-installation.json` e nas comparacoes dos seis snapshots em `.local/screen-contract-dev/preserve/`.
