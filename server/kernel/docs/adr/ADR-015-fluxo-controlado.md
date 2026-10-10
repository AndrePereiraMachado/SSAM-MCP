# ADR-015: tarefa persistente e entrada controlada de dados

Data: 2026-09-05. Estado: implementado em código; ativação e prova viva registradas no plano de progresso.

## Problema

Uma execução de job não representava a continuidade do pedido. Falhas posteriores ao merge induziam nova criação;
um job vazio podia obter sucesso sem provar os dados anteriores. O verificador também rejeitava listas preservadas
com outra chave local e a busca da bridge não via índices nativos.

## Decisão

Evoluir o mesmo `Delivery`, mantendo compilação headless e merge nativo. A primeira interface controlada cobre dados;
ela não certifica autorização, transações ou lógica de actions.

- `SemanticTypes` compara listas recursivamente e identifica entidades/structures pela origem global.
- `DataRequirements` lê todas as declarações da spec independentemente dos ops emitidos. `DataDelta` reaproveita
  objetos existentes e gera alterações dentro do contrato, usando os verbos e o compilador existentes.
- `DeliveryTask` guarda pedido fixo, baseline, tipos vinculados, artefatos, estado de cada escrita e histórico.
  O checkpoint usa gravação atômica com flush e checksum. O checksum detecta corrupção; a autoridade depende das
  permissões do armazenamento, não de o agente saber calcular um hash.
- `MergeJournal` registra a intenção e o resultado nativo antes do Verify posterior. operationId repetido não
  executa novamente. Perda de resposta exige consulta; ausência de prova permanece resultado desconhecido.
- Uma recusa confirmada antes de entrar no comando nativo permite nova preparação. Falha depois do merge retoma
  a conferência. Uma diferença real de dados pode gerar reparação incremental sob o mesmo contrato, preservando
  a tentativa anterior. A mesma diferença não dispara reparações indefinidamente. Uma entrega já concluída não
  desfaz automaticamente alterações humanas posteriores.
- Reservas por ambiente/chave de módulo sobrevivem à queda de processo. Não expiram autorizando uma escrita
  concorrente. Revisões da mesma tarefa de app conservam o dono da reserva.
- Bridge e worker exigem uma credencial local do controlador, armazenada fora do workspace com ACL do dono.
  Ping/manifesto permanecem úteis para diagnóstico. O escape `allow_foreign_base` foi removido.

## Autoridade do pedido e da chamada

O adaptador Codex recebe o evento real `UserPromptSubmit` e o guarda antes da tradução. A LLM não fornece esse
texto como argumento para substituir a origem. Um `PreToolUse` permitido registra uma autorização de uso único
para tarefa, ferramenta e argumentos exatos. O servidor MCP a consome antes de atender a chamada. Sem hook ativo,
a chamada é recusada; não há fallback para execução livre.

O status devolve contagens, elementos e todos os diagnósticos de falha. As asserções completas e as identidades
semânticas ficam no checkpoint; a resposta não repete a matriz a cada chamada.

A interface tem quatro ferramentas: `context`, `propose_data`, `continue` e `status`. Não expõe job, arquivo de
recibo, base alternativa, CLI de manutenção ou publicação. O worker existente executa a entrega.

A primeira tradução usa a autorização do pedido original e permanece visível no contexto da tarefa. Não há uma
segunda confirmação automática para executar um pedido claro. Alterar requisitos já fixados exige novo input do
usuário e aceitação da proposta concreta via elicitation do cliente; um argumento `approved` da LLM não é aceito.

Isso controla a continuidade depois da tradução. Não prova matematicamente que uma tradução de linguagem natural
incluiu toda intenção humana. A fonte original, o contrato e o escopo ficam explícitos; ambiguidades de negócio
continuam exigindo esclarecimento. O certificado descreve o contrato normalizado de dados, não regras não verificadas.

## Isolamento do cliente

O perfil opcional `ssam-app` desativa shell, execução unificada, apps/plugins externos, browser, computer use,
code mode host e delegação. Mantém leitura apenas e rede de comandos desativada. Os hooks restringem as ferramentas
locais à tarefa atual; a autenticação e as ACLs protegem os executores e o armazenamento.

Na instalação existente do usuário há `sandbox_mode` legado. O Codex dá precedência a essa configuração sobre
perfis nomeados. Por isso o perfil gerado sobrepõe explicitamente `sandbox_mode = "read-only"`, sem alterar o
padrão global. Quando não há configuração legada, o gerador também configura negações de leitura por caminho.

A validação com o Codex 0.153.4 confirmou contexto read-only e bloqueou acesso a um arquivo privado sintético,
escrita no workspace e TCP direto à bridge. A integração hook -> autorização -> MCP preservou o prompt com acentos
e recusou uma segunda chamada sem nova autorização. Não foi uma avaliação com LLM nem uma entrega viva.

Hooks isoladamente não são uma fronteira completa: algumas ferramentas hospedadas/especializadas não passam por
eles. Por isso o perfil também desativa essas capacidades, o sandbox restringe IO e o servidor exige a autorização
exata. Um administrador com acesso ao host continua sendo autoridade de manutenção. Não declarar que qualquer
sessão com PowerShell irrestrito passou a estar confinada.

Referências oficiais: [perfis e precedência](https://learn.chatgpt.com/docs/permissions),
[hooks e cobertura](https://learn.chatgpt.com/docs/hooks),
[configuração de ferramentas](https://learn.chatgpt.com/docs/config-file/config-reference),
[elicitation MCP](https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation).

## Compatibilidade e limites

O CLI de manutenção conserva `deliver --job`; `deliver --spec` usa a conferência independente. `deliver --resume`
retoma a tarefa existente e recusa substituição de alvo/job/checks/produtores. Essas entradas não são ferramentas
da sessão de app. Outros clientes precisam de um adaptador que capture a origem e autorize a chamada antes da
execução; não basta copiar as instruções da skill.

A quebra de compatibilidade da autenticação exige atualizar os clientes Python, o worker e a bridge juntos na
faixa escolhida. A outra faixa é preservada até sua atualização autorizada. Sem bridge compatível, o contexto de
app informa que a faixa não está pronta.

Não há transação atômica entre o comando do Studio e o diário em disco. Uma queda nesse intervalo pode continuar
ambígua; o sistema não promete exactly-once quando não consegue determinar o resultado.
