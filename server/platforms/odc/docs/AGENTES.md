# Agentes nativos e apps agenticos no ODC

A entrada e a mesma do SSAM: linguagem natural em ssam_discover, contrato em ssam_reference e entrega por studio_deliver. A LLM transforma o pedido em declaracoes; o kernel expande essas declaracoes deterministicamente e valida o candidato antes do merge nativo. Nao ha um segundo editor nem um modelo paralelo ao Studio.

## Criar um app

studio_create_app aceita kind agentic e usa template_Agent do tenant autenticado. O asset resultante tem tipo Agent e segmentacao AIAgent. O clone preserva os scaffolds V1/V2 oficiais. O template sozinho ainda contem chamadas dummy: configure agentes e callers antes de considera-lo uma aplicacao pronta.

Use publish:false quando quiser configurar tudo antes da primeira publicacao. A criacao e a publicacao usam os mecanismos de autorizacao e journal existentes; uma resposta incerta exige reconciliacao, nunca repeticao da escrita.

## Autoria

O job aceita op agent, com data:

- Criacao: name, model e as opcional. model identifica a action da conexao de IA importada por reference.
- Edicao: target identifica um IAgent existente. A chave permanece; campos omitidos permanecem. name renomeia o mesmo agente.
- Configuracao: description, messages, maxTokens, temperature, stop, extraBody, callCondition, enableActionCalling, outputFormat e outputFormatDescription.
- inputs: parametros tipados adicionais. Messages ja nasce no agente nativo.
- tools: handlers de actions existentes. Cada argumento escolhe fromAI:true ou value com expressao OutSystems. target edita um handler; sem target, cria outro. Descricoes de ferramentas/argumentos sao os metadados compartilhados da action e de seus parametros.

O contrato completo e gerado pelo proprio kernel: api --op agent. A ferramenta ssam_reference kind api permite consultar esse contrato. Use os verbos comuns para usos, renomeacao e exclusao, com captura atual e chave.

O nodo ICallAgentNode tambem faz parte de logic: properties.Agent e uma referencia IAgent:Nome; args fornece Messages e os demais inputs. O ODC permite esse nodo em server actions, mas nao diretamente em service actions. Para expor o agente, uma service action chama a server action que contem ICallAgentNode. Isso permite compor varios agentes com condicoes, loops, ferramentas de negocio e tratamentos de excecao.

Instrucoes de sistema e contexto sao mensagens criadas pelo caller. O campo description do agente nao substitui uma system message. Memoria tambem e explicita: BuildMessages_V2 carrega o historico e StoreMemory_V2 grava a interacao por SessionId. A aplicacao deve escolher como esse SessionId se vincula ao usuario autorizado; um teste sintetico de sessao nao comprova autenticacao ou segregacao por usuario.

Exemplo completo sobre o template oficial: kernel/tests/jobs-live/odc-agents-example.json. Escolha a conexao real no tenant; o nome de modelo no exemplo e apenas o modelo usado no laboratorio. Saida estruturada e tool calling sao modos separados; o contrato recusa a combinacao explicita.

## Evidencia desta implementacao

Implementacao iniciada na branch feat/odc-agents e retomada na worktree .worktrees/odc-agents-native da raiz unificada, branch codex/odc-agents-native. Base de integracao a5d42bd6, descendente da raiz atual. As fontes operacionais e o checkout historico foram preservados.

Laboratorio Personal: SSAMAgentLab, chave SvmMsLSP70Kzf5VPlBJZsw. App Agent criado pelo template oficial e aberto no Studio. Dois agentes nativos (Assistant e SupportAgent); SupportAgent usa LookupTicket. Service actions AskAssistant e AskSupport usam o fluxo de mensagens e memoria do template.

Revisao 3: publicacao concluida; revisao baixada corresponde exatamente ao modulo aberto. Testes de runtime por endpoint temporario da revisao 4: HTTP 200 com status do chamado SSAM-42; uma segunda chamada na mesma sessao recuperou o nome Aurora e o numero do chamado. O modelo trial retornou rate limit de 3 chamadas/minuto na tentativa seguinte. A tentativa posterior em uma nova sessao recebeu resposta vazia; isolamento entre sessoes nao foi validado. Estes testes nao medem qualidade geral, carga nem permissoes de usuarios reais.

Revisao 5: removido SSAMRuntimeProbe e publicado o fluxo declarativo AskSupportDeclarative -> AskSupportDeclarativeTask -> SupportAgent. Validacao sem mensagens novas, merge nativo estritamente equivalente e publicacao concluida em 28,2 s no servidor. A revisao publicada coincide com o modulo aberto. Evidencias locais em .local/agents-final-delivery/evidence; a bridge v44 foi anexada sem substituir DLL carregada.

A importacao inicial mostrou hashes derivados recalculados pela plataforma. A verificacao reconhece apenas CompatibilitySignatureHash/FullSignatureHash nao visiveis, em signatures referenciadas sem outras alteracoes; diferencias reais continuam recusadas. reconcile-merge revalida um merge nativo ja retornado, com base/candidato vinculados ao journal, sem executar outro merge. A bridge tambem deixou de fechar automaticamente janelas vazias ou pelo botao generico da barra de titulo.

Testes reproduziveis: OdcAgentTests (API nativa, multiplos agentes, ferramentas, edicao, recarga e factory agentic), AgentExpanderTests (contrato fechado e determinismo), studio-create-app.test.mjs e NativeMergeVerificationTests. A descoberta diferencia provas de jobs do catalogo e testes C#/evidencia viva; nao inventa um selo de job para a prova de laboratorio.

## Uso por linguagem natural

Pedidos como "criar um app agentico no ODC" selecionam studio_create_app com kind agentic. "Listar templates de app agentico" seleciona a consulta de templates Agent, sem confundir com a lista de apps existentes. "Criar um agente com ferramentas e memoria" segue a capacidade de autoria ai.agents.

Um pedido completo pode declarar dois agentes (triagem e revisao), suas instrucoes, o modelo existente, ferramentas de consulta e a memoria por sessao. A LLM compoe as declaracoes agent e logic; o mesmo pipeline de candidato, validacao e merge entrega os elementos nativos. Dados de negocio, permissoes e chamadas externas continuam exigindo seus proprios contratos e testes.

## Limites

- Importa conexoes de modelos de IA existentes. Criacao de credenciais, provedores, MCP remoto, A2A e knowledge bases segue seus contratos separados; nao foi validada por esta entrega.
- Agent Editor manifests sao diferentes dos agentes nativos IAgent do Studio.
- Avaliacoes, guardrails, observabilidade e promocoes entre stages usam as ferramentas ODC existentes e precisam de validacao especifica por app.
- A aprovacao do compilador nao prova a qualidade das respostas. Configure testes de negocio e tratamento de falhas/limites do provedor.
- O MCP ssam-novo foi configurado para esta copia qualificada, com workers locais 18517/18537/18547. A conexao ja aberta no Codex precisa de Restart para carregar a versao; o Studio pode permanecer aberto. Nenhuma fonte operacional anterior ou DLL carregada foi substituida. Esta copia agora e alvo de execucao: futuras alteracoes devem usar outra worktree.


## Fechamento da validacao (2026-10-06)

- ODC: suite completa com 227 testes aprovados; apos a separacao do nodo ODC/O11, 11 testes de agentes aprovados e 142 jobs de prova aprovados, com hashes do binario atual.
- O11: suite completa com 1850 aprovacoes e 10 falhas iniciais. As 10 foram corrigidas e aprovadas em reteste direcionado (expectativas de contrato, exclusao do nodo ODC e fixtures oficiais locais). Nao foi uma segunda execucao integral sem falhas. Os 95 jobs finais de proveniencia passaram.
- Bridge: 130 testes aprovados. Roteamento: 7 aprovados. Catalogo estatico: 3 aprovados.
- JavaScript: execucao ampla com 1395 casos: 1354 aprovados, 4 falhas, 5 skips e 32 TODOs preexistentes. As quatro falhas foram resolvidas com atualizacao das referencias de evidencia e das expectativas de descoberta/expansao; os cinco retestes direcionados passaram, incluindo 216 comparacoes com a baseline.
- Inventario de capacidades regenerado em .local/agents-coverage; contabilidade C conferida sem divergencias.
- Teste final pelo protocolo MCP real: 80 ferramentas listadas, kind agentic no schema de studio_create_app e descoberta de criacao de app e de ai.agents aprovadas. Evidencia em .local/agents-mcp-final.json.
- Configuracao global: somente o destino de ssam-novo foi alterado. Os demais servidores e o ambiente configurado foram preservados. Recibo em .local/agents-activation/receipt.json. O teste prova o novo servidor; a conexao preexistente depende de Restart no Codex.
