# Layout de decisions e rotulos de If

O posicionamento anterior resolvia colisoes depois da travessia, sem propagar as novas linhas aos sucessores.
Tambem deslocava todos os End para a mesma coluna. FlowGraphLayout agora separa retornos de ciclos para
ordenacao, processa os predecessores antes dos sucessores, reserva faixas ate a reconvergencia e resolve
colisoes antes de posicionar os proximos nos. O adapter preserva os conectores nativos. Nao ha dependencia nova.

If/while sem nome explicito exibem o predicado em vez de If1/If2. A spec admite label separado do alias.
No C#, o label conserva a condicao original mesmo se a expressao nativa usar temporarios de short circuit.
Relayout de actions existentes substitui somente labels genericos If/While numerados.

Validacao: 37 testes focados aprovados (FlowGraphLayoutTests, LogicSpecTests, LogicConstructionTests,
LogicReplaceTests). Inclui 100 grafos DAG gerados, diamonds aninhados, joins, switch, while, terminais,
labels C#, Verify nativo, recarga e segunda execucao sem movimentos. Job: tests/jobs/flow-layout-decisions.json.

A suite geral foi iniciada e interrompida depois de falhas: fixtures OutSystemsUI/OutSystemsUIWeb ausentes,
catalogo diferente da versao instalada e referencias antigas no guia/jobs. Nao foi declarada verde.
Log preservado em .local/readiness-20260909/flow-suite.log. Os testes focados usam o build final.

Ativacao nos CLIs de SS4/SS5, com backups das DLLs anteriores, manifests flow-installed-ss4.json e
flow-installed-ss5.json em .local/readiness-20260909. Workers autenticados revalidados; Studios nao reiniciados
para instalar esta mudanca. A instancia SS5 foi aberta para inspecao, mas nao havia ambiente conectado.

Limitacao de aceite: inspecao visual nativa nao concluida (controle de janela expirou aguardando aprovacao).
Ainda nao houve entrega desta mudanca a um modulo de produto. O modulo alvo dos flows existentes foi pedido
ao usuario. Nao afirmar que todas as conexoes nativas estao visualmente perfeitas apenas pelos testes geometricos.
