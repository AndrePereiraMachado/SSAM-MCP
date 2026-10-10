# Teste nativo de SQL Query e Aggregate

Estado: implementação isolada, compilação, testes offline e **quatro provas vivas concluídas**.
Integração e ativação no MCP padrão pendentes. Resultados e limites:
[prova O11/ODC de 07/10/2026](proofs/2026-10-07-native-query-test.md).
Ferramenta MCP `ssam_query_test`, faixas `o11` e `odc`, operações `describe`, `run`, `status`, `cancel`.
Esta entrada não torna disponível a operação genérica `sc_api TestQuery`, que continua bloqueada.

## Contrato

1. Obter captura e mapa por `ssam_map`. Escolher um SQL/Aggregate pelo `@key` daquela captura.
2. `describe` recebe `lane`, `source` (OML absoluta), `expectedSourceSha256`, `moduleKey`,
   `environment` (host conectado, sem protocolo) e `query` (`@key`). Retorna parâmetros usados, chaves e tipos.
3. `run` recebe os mesmos campos e `testValues`: todos os valores explícitos, por chave ou nome único;
   `{}` quando não há parâmetros. `operationId` é um UUID novo, gerado pela fachada se omitido.
   O11 exige `o11TenantId` explícito: confirmar o tenant nativo correto, nunca copiar `0` por conveniência.
   ODC admite `pid`; o processo selecionado é devolvido na continuação e deve ser preservado.
4. Usar `status` com a faixa, UUID e processo originais para consultar o resultado. O mesmo UUID nunca
   despacha outra execução. `cancel` encerra a espera do SSAM; devolve `serverCancelled:false`.

Exemplo de descrição (substituir os marcadores com a captura e o alvo reais):

```json
{
  "op": "describe", "lane": "odc",
  "source": "C:\\capturas\\App.oml", "expectedSourceSha256": "<sha256 da captura>",
  "moduleKey": "<chave do modulo>", "environment": "<host conectado>", "query": "@<chave da consulta>"
}
```

O exemplo não é evidência de consulta executada. Não trocar o ambiente para satisfazer uma recusa.
Tenant corporativo continua exigindo instrução explícita do usuário.

## Semântica e limites

- A cópia da OML é carregada separadamente; somente seus Test Values e TestMaxRecords são alterados.
  Nenhum save, merge, publicação, attach, login automático ou diálogo é acionado.
- Usa a sessão autenticada do desenvolvedor no Studio. **Não executa como usuário do app e não valida
  login, roles ou propagação de identidade do app**; essa prova pertence ao debugger e seu contrato.
- O11 usa `ServerCommunicationsProvider.TestQuery` e o leitor nativo `ServiceStudio.Model.QueryResult`.
  ODC usa `DataService.TestQuery(TestQueryArguments)`, com parâmetros nativos por ObjectKey.
  TextLiteral mantém as aspas do Test Value no ODC, conforme TestQuery; não usa a conversão de PreviewData.
- A consulta pode conter alterações não publicadas, mas entidades, atributos, dependências e esquema físico
  necessários precisam existir no ambiente. Não há promessa de executar um módulo nunca publicado.
  Uma recusa de esquema é devolvida; não provoca publicação automática.
- `maxRows`: padrão 100, máximo 500. Resposta: orçamento de 256 KiB, até 256 colunas,
  nomes de coluna até 512 caracteres e células até 8.192. `truncated` registra cortes;
  `possiblyMoreRows` indica que o limite foi atingido, sem afirmar que existem outras linhas.
  `includeSql` é opcional, falso por padrão, até 16.384 caracteres.
- `timeoutSeconds`: 1–120, padrão 30, limita a espera. O serviço nativo é síncrono e não oferece
  cancelamento do servidor comprovado. A execução continua em background; resultado tardio fica em `status`.
  O pipe ODC atende uma chamada por vez: um `cancel` separado pode aguardar a chamada inicial liberar o pipe.
- Test Values suportados: Text/Email/Phone Number, Integer/Long Integer, identificadores numéricos,
  Decimal/Currency, Boolean, Date, Date Time e Time. Números grandes devem ser strings para manter precisão.
  Datas ISO sem timezone. Null, estruturas/listas/binário, identificadores de base textual e expressões
  executáveis não são convertidos implicitamente. SQL só lista parâmetros efetivamente referenciados.
- SQL aceita um subconjunto conservador de SELECT único e funções conhecidas. Recusa DML/DDL,
  SELECT INTO, múltiplas instruções, ExpandInline, CTEs, funções desconhecidas/qualificadas e sintaxe dinâmica.
  Aggregate usa a geração nativa. Isso é uma guarda de escopo, **não uma transação read-only nem sandbox
  do banco**: TestQuery pode fazer preparação interna na plataforma. Não há promessa de rollback universal.
  SQL inválido dentro desse subconjunto retorna o erro nativo; a guarda não substitui o parser do banco.

## Recibos e privacidade

O11: `<authority>/operations/query-tests`. ODC: `<raiz ODC>/journal/query-tests`.
Um recibo é criado antes do despacho e uma reserva por ambiente/módulo impede outro teste enquanto o
resultado está pendente/incerto. Não é promessa de exactly-once no banco: a chamada ao provedor nativo
é feita uma vez por UUID e o próprio provedor mantém seu comportamento nativo de transporte/autenticação.

Recibos persistem metadados, sem linhas, Test Values, SQL ou erro nativo. O bridge retém os resultados privados
em memória, no máximo 32 operações. A fachada MCP mantém seu mecanismo geral de paginação/arquivamento de
respostas em `.local`; portanto esta regra de recibos não é uma promessa de ausência de dados em todo o cliente.
Após descarte de resultado/reinício do bridge, `resultAvailable:false`;
um estado incompleto no disco é `uncertain`. Não reexecutar para reconstruir linhas perdidas.
ODC usa exclusivamente pipe nesta entrada, mesmo com `SSAM_ODC_PIPE=0`: valores não passam por argumentos
de processo. O log O11 registra somente o tamanho da resposta.

`execution:not-sent` comprova recusa antes da chamada nativa; `native-query` indica que o serviço retornou,
inclusive quando `ok:false` traz erro nativo; `uncertain` não comprova término no banco. Uma exceção após o
despacho ou reinício durante execução mantém a reserva. Não existe nesta versão liberação automática de
reserva incerta: a ausência de resposta não autoriza repetir. `status` em bridge incorreto pode não encontrar
o UUID e também não autoriza replay.

## Integração e cobertura adicional

Worktree `codex/sql-query-test`, base `consolidacao/main` em
`b01cef950e2b1511f6a300200183be17cfdd5b8d`. ODC usa bridge e cliente **v42**, já carregada na prova;
o integrador deve reservar outra versão para código diferente. Nunca substituir DLL carregada.
Não foi alterada a configuração/instalação ativa.
O perfil controlado de app não ganha autorização ou fuga para ferramentas de manutenção com esta entrada;
se o perfil não a expuser, a capacidade deve ser integrada ao contrato correspondente, sem fallback por CLI.

Arquivos principais: `kernel/query-test/` (contrato, preparação nativa, resultados e recibos),
`kernel/src/Anvil.Bridge/QueryTestHandler.cs`, `platforms/odc/studio/bridge/QueryTestCommands.cs`,
`platforms/odc/facade/query-test.mjs`, registro MCP e catálogo de descoberta. O preflight SQL existente
não foi substituído nem flexibilizado.

Roteiro para integração e ampliação. A prova vinculada acima registra exatamente o que foi executado;
não houve comparação por clique manual, nem cobertura de todos os casos negativos/timeout abaixo:

1. Com autorização específica, usar um app existente e esquema já publicado, no ambiente indicado;
   reutilizar o Studio aberto. Integrador disponibiliza a nova versão sem reiniciar/salvar o Studio.
2. Capturar e mapear uma SQL SELECT e um Aggregate de leitura; registrar hash, @key, módulo, host e processo.
3. Descrever cada consulta; executar com valores explícitos e limite pequeno. Comparar nomes/ordem das
   colunas e linhas com o teste nativo manual equivalente, separadamente em O11 e ODC.
4. Cobrir parâmetro Text com aspas, identificador numérico, resultado vazio, erro SQL e esquema ausente
   sem criar entidades/atributos ou publicar. Registrar o código e erro nativos, sem dados sensíveis no repo.
5. Conferir a recusa antes de envio para hash/alvo incorreto, parâmetro ausente e SQL com efeitos.
   Repetir o UUID de uma execução concluída e verificar que o recibo é reutilizado.
6. Se houver uma consulta de leitura já conhecida por demorar, observar timeout e resultado tardio por
   `status`; não introduzir sleep/carga artificial nem encerrar o servidor para simular falha.
7. Registrar separadamente preparação da cópia, envio nativo, resultado, nenhuma publicação e a lacuna
   de validação dos acessos do usuário do app. Mocks e compilação não substituem esses recibos vivos.

## Validação offline

`dotnet test kernel/query-test/tests/QueryTest.Tests.csproj -c Release`: literais, efeitos recusados,
orçamento, vazio/erro, UUID, perda de resposta, reserva concorrente, reinício, timeout/cancel e resultado tardio.
`node --test platforms/odc/facade/tests/query-test.test.mjs platforms/odc/facade/tests/tool-routes.test.mjs`:
transporte simulado, schema, continuação, seleção de processo, descoberta PT/EN e registro real MCP em memória.
Regressão O11: `ServiceCenterBridgeTests|SqlPreflightTests`. Bridges O11/ODC e cliente ODC compilados
contra as instalações locais. Nenhum teste acima envia TestQuery a um servidor.

Resultado em 07/10/2026: **257 testes aprovados** — 24 do contrato/recibo/resultado compartilhado,
199 da regressão O11, 16 de fachada MCP/descoberta e 18 de respostas/pipe. Builds finais:
O11 e ODC sem erros (cinco avisos cada), cliente ODC sem erros/avisos.
Logs locais preservados em `.local/query-test/verification/` do worktree, ignorados pelo Git.
Os testes de transporte são simulados; não comprovam autenticação viva, serialização aceita pelo servidor,
SQL executado no banco ou suporte universal a todos os tipos de Aggregate.

Tempo de plataforma não medido: nenhuma chamada viva foi feita. O retrabalho foi local: restore inicial
do projeto e ajuste de namespaces/tipos às DLLs instaladas. Builds finais levaram cerca de 2,5 s por bridge;
não atribuir esse retrabalho nem os testes locais à latência de TestQuery.
