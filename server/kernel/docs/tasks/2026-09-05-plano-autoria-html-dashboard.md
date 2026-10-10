# Plano de implementacao e passagem de contexto: autoria HTML/CSS/JS

## 1. Objetivo e autorizacao

Implementar no SSAM Hybrid a primeira conversao vertical de uma pagina escrita em HTML/CSS/JS para uma tela nativa OutSystems O11, preservando desenho e comportamento. O usuario escolheu explicitamente **Incidents_UI / Dashboard** como alvo real.

O usuario quer que a LLM possa criar a pagina inteira numa primeira geracao, como faz em high code, e futuramente reproduzir mockups/Figma. O preview serve para verificar e corrigir; nao deve ser uma dependencia para montar cada widget. HTML/CSS/JS e a linguagem de autoria. A representacao intermediaria, as peculiaridades dos widgets e os ops pertencem ao Hybrid.

Escopo autorizado: manutencao do compilador/controlador e entrega do Dashboard escolhido. As ferramentas anteriores foram sincronizadas em SS4 e SS5. A primeira conversao ainda NAO existe. Este documento foi solicitado para continuar em outra conta, sem iniciar a implementacao nesta passagem.

Publicacao de **produto** continua sendo feita pelo humano, conforme AGENTS.md. O usuario escolher Incidents_UI autoriza preparar e entregar por merge; nao altera automaticamente essa regra. Preparar tudo, demonstrar a prova em laboratorio quando necessario, entregar o merge e indicar exatamente quando a publicacao humana for o unico passo restante para validar o produto no navegador.

## 2. Leituras e arquivos essenciais

Repositorio: `C:/Users/andre/Anvil`.

Ler nesta ordem, sem carregar todos os exemplos:

1. `C:/Users/andre/.codex/skills/ssam-hybrid/SKILL.md` e as partes de manutencao do AGENTS.md / MANIFESTO.md.
2. Este plano.
3. `docs/tasks/2026-09-05-investigacao-autoria-html.md` — conclusoes tecnicas e limites da prova.
4. `docs/proofs/2026-09-05-autoria-html-investigacao.json` — resultados e hashes.
5. `.local/html-authoring-investigation/reference.html` — pagina de referencia, HTML/CSS/JS escrito integralmente. Capturas: `reference-desktop.png` e `reference-mobile.png`.
6. `.local/html-authoring-investigation/authoring-probe.cjs` e `authoring-probe.json` — experimento browser focal, NAO um conversor de OML.
7. `docs/APP.md`, `docs/CONTRATO-MODULO.md` e `src/Anvil.Core/Delivery/AppSessions.cs` para integrar o caminho existente.

A imagem bonita mostrada ao usuario foi gerada com HTML/CSS/JS no Chrome. **Nao e uma tela convertida para OutSystems.** O usuario ja foi esclarecido sobre isso. Nao apresentar a captura como evidencia de conversao nativa.

Os bundles publicados, DOM coletado e scripts experimentais estao somente em `.local/html-authoring-investigation/`. Os decompilados desta investigacao estao fora do repositorio, em `C:/Users/andre/AppData/Local/Anvil/investigations/html-authoring/`. Pode consultar as DLLs/decompilados para entender mecanismos; a implementacao usa APIs e codigo proprio, sem copiar codigo decompilado para o produto.

## 3. Estado exato para retomar

### Git

Ultimo commit da investigacao: **902e3b0** (`docs: investigate HTML authoring and native rendering fidelity`). O commit anterior de codigo estabilizado e **7923119**, cobertura de actions. O commit que acrescentar este plano sera posterior, somente documental.

**O working tree NAO esta limpo.** Existe uma tentativa ampla de backend de telas, interrompida por orientacao do usuario. Ela NAO esta concluida nem instalada. Nao executar build/install diretamente nesse working tree como se tudo estivesse aprovado.

Arquivos experimentais nossos:

- Alteracoes em `ModuleSpecification.cs`, `ModuleModel.cs`, `LogicOrder.cs`, `LogicExpander.cs`, `LogicRequirements.cs`, `Verbs.cs`, `AppSessions.cs` e `Anvil.Core.csproj`.
- Novos `ScreenSpecification.cs`, `ScreenModel.cs`, `ScreenRequirements.cs`, `ScreenVocabulary.json` em `src/Anvil.Core/Kernel/`.
- `scripts/gen_screen_vocabulary.py`, `gen_screen_coverage.py`, `gen_screen_osui_coverage.py`.
- `tests/Anvil.Tests/ScreenCoverageTests.cs`, `tests/contracts/screen-coverage/` (147 arquivos no momento da passagem), `catalog/ui-plugin-enums-11.55.73.json`, `docs/mapa/screen-osui-inventory.json`.
- Bibliotecas OML locais usadas como produtores em `tests/fixtures/outsystems-ui.oml` e `outsystems-ui-web.oml`; respeitar a politica de fixtures/binarios, sem empacotar essas bibliotecas.

Fingerprint dos arquivos principais: `.local/html-authoring-investigation/handoff-worktree.json`. Os testes amplos foram interrompidos; arquivos com `status: running` e logs antigos NAO constituem prova verde. A existencia do inventario OSUI nao significa cobertura aprovada.

Trabalho de outras sessoes a preservar: alteracoes Hire em AGENTS.md/PROVAS.md, scripts e specs Hire, jobs Incidents em desenvolvimento, arquivos de arranque de outras LLMs, pycache e a exclusao de `tests/jobs/data-contract-incidents.json`. Nao restaurar, apagar, migrar ou commitar esses arquivos por conveniencia.

Recomendacao: implementar em checkout/worktree limpo baseado no HEAD documental, com branch `codex/html-dashboard`. Examinar e reaproveitar seletivamente ideias do experimento pausado; nao transportar todo o experimento automaticamente. Para testes headless em checkout separado, usar diretorios de saida proprios e evitar conectar por engano ao worker residente das faixas (`ANVIL_WORKER=0` quando apropriado). Instalar nas faixas apenas na etapa de integracao.

### Faixas e modulo

Estado lido nesta passagem, sujeito a nova verificacao na retomada:

| Faixa | Bridge / worker / CDP | Modulo ativo | Trabalho aberto |
|---|---|---|---|
| SS4 | 4516 / 4517 / 9226 | Incidents_UI | Incidents_CS e Incidents_UI, ambos sem modificacoes pendentes no momento da leitura |
| SS5 | 4536 / 4537 / 9246 | ZZActionCoverage_UI | Quatro modulos de laboratorio, todos com modificacoes pendentes |

Chave Incidents_UI: `0D3NmEARk0CxZTANvTsZdA`. Chave Incidents_CS: `QnnqNFUBkkSC2CwErHWZMw`.
Ambiente observado: `personal-2qqw9srv.outsystemscloud.com`.

Usar SS4 como faixa de entrega do Dashboard, pois o alvo ja esta aberto ali; confirmar a identidade antes de cada escrita. Atualizar ferramentas em ambas ao concluir. Manter um unico escritor do modulo: duas faixas conectadas ao mesmo ambiente nao representam duas copias independentes do produto publicado.

Instalacoes:
- SS4: `C:/Users/andre/OutSystems/Service Studio 11 - Anvil 4516/Service Studio`; CLI `.local/cli/anvil.dll`.
- SS5: `C:/Users/andre/OutSystems/Service Studio 11 - Anvil 4536/Service Studio`; CLI `.local/lane-ss5/cli/anvil.dll`.

A sincronizacao anterior foi comprovada por hashes iguais de bridge/Core/CLI e DLLs principais. Prova: `.local/screen-contract-dev/both-lanes-baseline-installation.json`.
Os seis modulos foram preservados e comparados pelo MatchTree nativo. Backup: `.local/screen-contract-dev/preserve/`.
**Nao usar esses snapshots antigos como base de uma entrega nova.** Tirar um snapshot atual.

## 4. O que a investigacao ja confirmou

- O dashboard original veio de `incidents-ui-dashboard.json`, arquetipo dashboard. `ScreenExpander.Dashboard()` cria CardSectioned + Counter em sequencia, diretamente no MainContent, sem grid.
- Jobs operacionais posteriores acrescentam graficos num Columns2 separado. O JavaScript publicado confirma essa composicao. A perda de qualidade ja aparece na descricao/geracao, nao apenas no CSS.
- O HTML Element nativo (AdvancedHtml) preserva tags e filhos aceitos pelo validador da plataforma. Container renderiza div com classes/propriedades.
- Input nativo acrescenta `span.input-text` ao redor do input e da validacao. Na prova focal, `.field > .control` perdeu efeito: **930x44 -> 189x27 px**. Um adaptador CSS restaurou **930x44 px**.
- A prova de CSS usou os metodos de renderizacao com doubles e reproduziu o wrapper no HTML local. Nao montou um controle OutSystems completo, nao compilou OML e nao prova qualquer seletor CSS.
- Form nativo tem `noValidate` e impede o submit HTML padrao. Exige integracao explicita com validacao/eventos/actions.
- JS nodes publicados trabalham com parametros, actions e promises. O codigo JavaScript pode permanecer JavaScript; nao e necessario transpilar cada linha em widgets de logica.
- Estado e renderizacao precisam de um dono. Manipular diretamente uma subarvore gerida pelo renderer pode ser desfeito por uma renderizacao seguinte.
- O experimento pausado verificou alguns percursos nativos de HTML Element, containers, eventos de bloco e data/navigation. Tambem encontrou perdas de rows de Show/Edit Record Traditional apos merge. Nao retomar agora a investigacao de todos esses widgets: o primeiro alvo e o Dashboard Reactive.

## 5. Etapas de implementacao

### Etapa 0 — Preservar e estabelecer a base

1. Ler status git, registrar arquivos compartilhados e escolher o checkout de implementacao.
2. Ler `list_open_modules`, modulo ativo, chave, ambiente, dialogs e worker busy/queued. Nao reiniciar por rotina.
3. Obter snapshot novo do Incidents_UI e registrar hash, erros/avisos existentes e identidade do Dashboard.
4. Registrar referencias, nomes/chaves de elementos, actions da tela, inputs, variaveis, data actions/aggregates, chamadas CS, roles e destinos usados pelo Dashboard.
5. Guardar uma captura do produto atual e um inventario estrutural para comparar alteracoes posteriores.

Saida: baseline atual e lista de elementos que precisam ser preservados. Gate: nenhuma ambiguidade sobre modulo/ambiente/faixa ou outra operacao em andamento.

### Etapa 1 — Fixar o contrato funcional do Dashboard real

1. Inventariar todos os indicadores existentes, seus significados e fontes. Preservar tambem Meus incidentes, mesmo que sua apresentacao passe para o subtitulo de um indicador ou cabecalho de lista.
2. Mapear graficos por status/prioridade, listas de proximos do vencimento e meus incidentes, periodo, refresh, atalhos e navegacao.
3. Para cada binding, registrar action/query real, inputs, outputs, tipos, tratamento de erro e atualizacao necessaria.
4. Definir estados preenchido, vazio, carregando e erro. Zero legitimo nao equivale a erro; datas/identificadores nulos nao devem ser exibidos como registros reais.
5. Preservar autorizacao e comportamento existentes. Lacunas de backend devem ser identificadas; nao alterar Incidents_CS automaticamente para facilitar o layout.

Saida: contrato funcional pequeno, associado aos elementos atuais. Os numeros e registros ficticios de reference.html servem somente como dados de demonstracao, nunca como implementacao do Dashboard.

### Etapa 2 — Especificar a entrada de autoria e os bindings

1. Adotar HTML, CSS e JS como fonte canonica. Pode haver arquivos separados para desenvolvimento e um payload serializado equivalente no perfil MCP.
2. Definir uma convencao pequena de bindings para estado, dados, eventos, chamadas e elementos/componentes existentes. A LLM continua escrevendo HTML/CSS/JS; nao escreve a arvore de ops do Studio.
3. Definir chaves estaveis de fonte, independentes de indice e texto exibido. Associar cada chave ao elemento nativo e a sua localizacao no codigo-fonte.
4. Tratar o contrato de bindings como fechado e tipado. HTML e CSS mantem expressividade; capacidades sem traducao comprovada geram diagnostico preciso.
5. Congelar HTML/CSS/JS, bindings e recursos por hash no contrato de entrega. Manter pedido original e regras de imutabilidade/retomada do controlador. Nao abrir uma permissao para substituir silenciosamente a fonte de uma tarefa ja aceita.
6. Registrar a sintaxe nova como proposta de API; nao documentar comandos que ainda nao existem como disponiveis.

Saida: exemplo real de fonte do Dashboard + formato de bindings + regras de identidade. Gate: e possivel expressar o Dashboard inteiro sem especificar parents/placeholders/ops de baixo nivel.

### Etapa 3 — Parser, validacao e representacao intermediaria

1. Usar parsers apropriados para HTML/CSS/JS; regex nao e parser de uma linguagem inteira.
2. Produzir arvore interna com tags, atributos, texto, ordem, regras CSS, eventos, bindings, chaves e posicoes na fonte.
3. Validar referencias a dados/actions, tipos, duplicacoes, recursos e construcoes nao suportadas antes da mutacao nativa.
4. Resolver forward references dentro da pagina antes de emitir ligacoes.
5. Manter determinismo: mesmos inputs e capacidades produzem o mesmo plano sem criar nomes novos a cada tentativa.

Saida: IR interna e diagnosticos com arquivo/linha/elemento. Gate: a LLM consegue corrigir a fonte sem investigar o Model API.

### Etapa 4 — Compilar apresentacao preservando a estrutura

1. Mapear tags semanticas para HTML Element nativo e divs equivalentes para Container quando apropriado.
2. Preservar ordem, aninhamento, classes, acessibilidade, tipografia, grid/flex, espacamentos, variaveis CSS e media queries.
3. Levar CSS para o mecanismo de stylesheet da tela com escopo e precedencia definidos; neutralizar propriedades implicitas de grid do Studio que conflitem com a fonte.
4. Integrar graficos e demais componentes existentes por bindings/adaptadores declarados. Preservar sua semantica; uma imagem ou contador com nome de grafico nao substitui um grafico funcional.
5. Criar a pagina completa em uma compilacao/transacao. Os elementos devem continuar identificaveis e editaveis no Studio.
6. Verificar tags, estilos e estrutura novamente apos save/reload e merge, independentemente dos ops emitidos.

Saida: apresentacao do Dashboard compilada em OML descartavel. Gate: estrutura nativa correta, Verify sem erros novos e estilo preservado no caminho de compilacao.

### Etapa 5 — Adaptadores de controles e JavaScript

1. Implementar somente os adaptadores exigidos pelo Dashboard: inputs de filtro, datas, selects, botoes, links, repeticoes/tabelas e componentes de grafico utilizados.
2. Para cada adaptador, documentar DOM nativo, wrappers, classes implicitas, seletores afetados, IDs, foco e validacao. Testar com o controle real, nao apenas com o wrapper simulado.
3. Mapear labels e referencias a IDs para elementos nativos corretos; manter um mapa estavel para JS/CSS, inclusive em elementos repetidos.
4. Compilar handlers JS para client actions/JS nodes com parametros/saidas tipados. Gerar wrappers para actions reais e preservar promises, erros e loading.
5. Ligar montagem e limpeza aos eventos de ciclo de vida. Impedir listeners duplicados apos refresh/navegacao e liberar timers/subscricoes criados pela pagina.
6. Definir como o estado JS se integra ao estado OutSystems. Atualizacoes precisam chegar ao modelo/renderizador; alteracoes DOM arbitrarias nao podem ser aceitas silenciosamente como bindings persistentes.
7. Tratar insercoes/remocoes dinamicas de HTML, scripts externos e manipulacao de subarvores do renderer como capacidades explicitas. Nao prometer suporte irrestrito antes de provar.

Saida: filtros, atualizacao e navegacao funcionais. A criacao de incidente da demonstracao HTML nao amplia o escopo: no Dashboard real, Novo incidente navega para o fluxo existente; nao alterar outras telas ou criar registros de negocio para testar.

### Etapa 6 — Delta, identidade e prova independente

1. Mapear chaves estaveis da fonte para ObjectKeys a partir do snapshot e do manifesto de geracao.
2. Atualizar propriedades e conteudo de elementos sobreviventes, preservando consumidores e bindings.
3. Definir regras para inclusao, remocao, reordenacao e mudanca de parent/tipo. Operacoes sem preservacao comprovada precisam de diagnostico; nao apagar/recriar a tela inteira por padrao.
4. Provar a declaracao lendo o modelo: estrutura, propriedades, bindings, destinos, argumentos, roles e identidade pertinente.
5. Testar idempotencia: segunda compilacao da mesma fonte nao duplica elementos e nao gera merge desnecessario.
6. Testar mudanca pontual e retomada apos falha, mantendo taskId/contrato e sem repetir escrita de resultado desconhecido.
7. Mutacoes negativas devem continuar validas no Verify e mesmo assim reprovar a prova declarativa/visual quando violarem a fonte.

Saida: candidato apto a entrega pelo controlador existente.

### Etapa 7 — Integrar ao fluxo controlado

1. Integrar o frontend HTML ao contrato de modulo e ao caminho existente `context/propose/continue/status`.
2. O controlador assume compilacao, diagnostico, snapshot, prova, merge unico e retomada. O perfil de app nao ganha shell, arquivos internos ou comandos alternativos de recuperacao.
3. Context deve informar capacidades/bindings relevantes sem despejar todo o catalogo de widgets em cada chamada.
4. Receitas antigas continuam compativeis; nao migrar tarefas de outras sessoes nem alterar contratos legados em andamento.
5. O recibo deve distinguir compilacao/merge de aceitacao visual/funcional e indicar a versao exata da fonte.
6. Atualizar skill/APP/contrato apenas com comportamento realmente implementado.

Saida: uma entrada de autoria utilisavel por uma LLM sem contexto, com erros que apontam para sua fonte.

### Etapa 8 — Prova visual e funcional completa

Comparar a fonte HTML e a pagina OutSystems com o mesmo viewport, fontes e dados/estado. Usar dados controlados em laboratorio e fazer uma leitura funcional adicional com os dados reais do produto.

Cenarios minimos:

- Desktop e viewport mobile: indicadores organizados, graficos dentro dos paineis, filtros compactos, tabela com comportamento responsivo definido e ausencia de overflow involuntario.
- Preenchido, vazio, carregando e erro, visualmente distintos.
- Busca e filtros isolados/combinados; limpar filtros; atualizar dados; periodo e datas nulas.
- Navegacao para incidentes e detalhes com parametros corretos; acesso direto sem identificador valido tratado pelo fluxo existente.
- Duas montagens/navegacoes consecutivas, sem duplicacao de listeners; comportamento apos rerender.
- Teclado, labels, foco e mensagens pertinentes aos controles usados.
- Segunda geracao identica e uma alteracao localizada sem duplicacoes nem quebra de consumidores.

Fixar criterios de comparacao antes de avaliar: geometria, estilos importantes, screenshots e interacoes. Registrar tolerancias justificadas e diferencas conhecidas. Nao baixar o criterio para aprovar o resultado nem tratar uma unica medida de pixel como prova de toda a pagina.

Gate: equivalencia visual e funcional demonstrada no navegador para os cenarios definidos. Verify verde sozinho nao e suficiente.

### Etapa 9 — Testes, instalacao e entrega

1. Rodar os testes focados durante o desenvolvimento. Ao concluir as mudancas de C#/bridge/worker, executar a suite obrigatoria antes do commit; corrigir as regressoes pertinentes.
2. Nao retomar a matriz experimental de 147 arquivos como pre-condicao desta prova. Ela continua pendente e nao pode ser contada como aprovada. Reaproveitar apenas casos relevantes, revisados.
3. Preparar build candidato isolado. Antes de instalar, verificar worker ocioso, modulos abertos, dialogs e modificacoes pendentes.
4. Atualizar ferramentas em SS4 e SS5 com preservacao de trabalho, verificacao de versoes/hashes, protocolo autenticado e worker correto por faixa. Nao publicar nem fechar modulos sujos como atalho.
5. Entregar Incidents_UI/Dashboard pela faixa SS4 a partir de snapshot atual, com um merge e provas do alvo. Preservar outras telas, chamadas e referencias fora do escopo.
6. SS5 valida o mesmo build em laboratorio. Nao fazer dois merges concorrentes de Incidents_UI para demonstrar duas faixas.
7. Validar recibo/check-delivery e conferir o estado apos merge. Para a pagina publicada do produto, a publicacao humana e o passo final previsto; depois validar no navegador a versao correta.
8. Registrar tempos separados: autoria LLM, compilacao, Verify, merge, publicacao, renderizacao e retrabalho. Nao atribuir toda a latencia a um unico componente nem prometer o tempo de conversao a partir da prova HTML local.
9. Documentar evidencia e limites e commitar somente os arquivos desta implementacao.

## 6. Definicao de pronto do primeiro marco

- A LLM consegue expressar o Dashboard completo em HTML/CSS/JS e bindings pequenos.
- O Hybrid converte a fonte para elementos nativos e preserva a composicao.
- O Dashboard usa dados/actions reais e mantem suas funcionalidades, permissoes e estados.
- A pagina realmente renderizada em OutSystems passa na comparacao visual e nos testes funcionais definidos.
- Atualizacao localizada/idempotente e retomada estao demonstradas.
- Ferramentas instaladas e verificadas em SS4 e SS5, com um unico escritor do produto.
- Evidencias distinguem preview HTML, OML gerado, merge no Studio e versao publicada.

Este marco NAO equivale a conversao geral de qualquer site, importador Figma concluido ou cobertura total de todos os widgets/runtimes. Mockup/Figma sera uma entrada adicional para a mesma fonte HTML/CSS/JS depois que o percurso acima estiver comprovado.

## 7. Roteiro da primeira sessao na outra conta

1. Ler este plano e a investigacao, conferir git e estado das faixas somente por leitura.
2. Proteger o working tree compartilhado e preparar checkout limpo para manutencao.
3. Tirar snapshot atual do Dashboard e construir o inventario funcional/bindings (etapas 0 e 1).
4. Fixar a forma da fonte e a identidade dos elementos; reaproveitar a referencia HTML como desenho, adaptando-a ao contrato real.
5. Implementar e provar um percurso vertical do Dashboard. Investigar apenas os obstaculos concretos desse percurso; nao voltar a uma pesquisa ampla de todos os widgets.
6. Manter o usuario informado sobre o que foi realmente convertido/instalado e o que continua sendo apenas referencia.

## 8. Estado da implementacao (2026-09-05, sessao de continuacao)

Feito e provado headless (commit 806c510 e o seguinte), sem tocar nas faixas:

- Compilador `html` completo para o Dashboard: `HtmlSource.cs`/`CssSource.cs` (parsers), `HtmlExpander.cs` (esquema fechado da
  secao 3.5 do AGENTS.md: vars, sources com todas as saidas, search/filters, derived, scripts, bindings) e `HtmlDelta.cs`
  (tela existente: limpeza da apresentacao/logica regenerada, variaveis mantidas por nome+tipo, poda por usages, CSS escopado
  instalado em `ITheme.StyleSheet` do tema padrao do modulo). `anvil merge-probe` prova o merge de 3 vias headless.
- Referencia completa `tests/html/incidents-dashboard.html` + `.bindings.json`: desenho da referencia com o comportamento do
  Dashboard atual (periodo com DatePickers e refresh, 5 indicadores, cards com navegacao filtrada a IncidentList, barras por
  status com maximo derivado, prioridades com cor por rotulo e aviso near-due, recentes com busca/prioridade, proximos do
  vencimento com contagem JS, meus incidentes, usuario logado, novo incidente).
- Provas: HtmlSpecTests 32/32; `html-dashboard-reactive.json` e `html-dashboard-update.json` com Verify 0 erros; HtmlDeltaTests
  (chaves da tela e das variaveis iguais apos a segunda compilacao, um bloco no tema, sem duplicatas, merge sem conflito);
  ensaio headless no Incidents_UI real (OML pos-merge 17:40 + produtor Incidents_CS): update, Verify 0 erros, CSS no tema
  Incidents_UI, merge-probe 17.125 objetos sem conflito. Comprovante: `docs/proofs/2026-09-05-autoria-html-compilador.json`.
- Descobertas do modulo real: `IncidentList` nao tem `OnlyOpen`; no JavaScript nao aceita lista de estrutura; `id` reservado.

Feito em 2026-09-05 (sessao de continuacao, SS4 aberto desta sessao): CLI da faixa reconstruido do HEAD limpo, snapshot atual do Incidents_CS
como produtor e `deliver` do Incidents_UI (tarefa 62f8fc59: snapshot C0D041E0, update, um merge auto sem conflitos, 6/6 checks, newErrors 0,
check-delivery aceito). Os 4 avisos CustomObjectWarning (Anonymous Role) sao tolerados pelo gate por regra do dono.

Pendente (trabalho, nao conclusao):

1. SS5: instalar o mesmo build ao abrir a faixa (CLI ja copiado em .local/lane-ss5/cli); nao fazer segundo merge do Incidents_UI.
1b. (feito no SS4) Instalar o build nas faixas SS4 e SS5 (`python scripts/build.py` em cada faixa; exige parar/subir o worker, autenticado).
2. Snapshot atual do Incidents_CS como produtor e entrega pela SS4:
   `dotnet .local/cli/anvil.dll deliver --module Incidents_UI --job tests/jobs-live/html-dashboard-incidents.json --producer Incidents_CS=<snapshot Incidents_CS.oml> --checks Dashboard,Page,LoadDashboard,LoadRecent,PeriodStart,Recent`
   (um merge; `check-delivery` no recibo; SS5 valida o mesmo build em laboratorio, sem segundo merge do Incidents_UI).
3. Publicacao pelo humano e comparacao no navegador (etapa 8): mesmo viewport (desktop e 390 px), mesmos dados; cenarios
   preenchido/vazio/carregando/erro, busca e filtro, periodo, navegacao dos cards, duas montagens sem listeners duplicados,
   teclado/labels. Registrar tolerancias e diferencas conhecidas (wrappers do Input/DatePicker, tema base do OutSystemsUI).
4. Fora deste marco: forms/dialog, imagens, delta com mudanca de tipo/reparenting de widgets preservando chaves de widget, Figma.

Bloqueio de acesso ao controlador (problema separado de portabilidade): nesta conta o desktop Claude roda como app MSIX e
enxerga um `%LOCALAPPDATA%` virtualizado (`Packages/Claude_.../LocalCache`); a `bridge.key` e os bridges vivos estao no cache do
pacote Codex (`Packages/OpenAI.Codex_.../LocalCache/Local/Anvil`). Chamadas autenticadas (snapshot, inspect via worker, deliver,
restart do worker) devem sair da sessao Codex `ssam-app`; contornos foram descartados por decisao do dono. Tudo o que nao depende
da bridge roda a frio com `ANVIL_WORKER=0` e `dotnet test`.
