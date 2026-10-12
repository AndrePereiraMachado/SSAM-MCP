# Registro de qualidade do servidor hospedado (`ssam-quality/1`)

Para melhorar o SSAM com o uso real, o servidor hospedado grava, de cada cliente, só códigos, contagens e tempos. O registro
responde às cinco perguntas do dono:

1. **O motivo de cada recusa**: os códigos dos problemas que vieram e quantos de cada (por exemplo, 12
   `EXPR_UNKNOWN_IDENTIFIER`, 3 `EXPRESSION_SYNTAX`, 1 `FUNCTION_UNKNOWN`), em que fase e quantos já vinham com a correção
   pronta (`problems`).
2. **As correções automáticas do motor**, contadas por regra (`norm.byRule`, por exemplo `SORT_KEYS_SPLIT`). Uma expressão
   que duas regras mudaram (o kernel junta as duas com `+`) conta nas duas; por isso a soma de `byRule` pode passar de
   `norm.n`, que conta as expressões.
3. **O tempo de cada fase da entrega**: fila, captura, compilação, Studio, verificação, publicação, ambiente,
   transferência e o próprio servidor (`t`, `agent`, `kernel`).
4. **A sequência de chamadas de cada sessão MCP**: a ordem de cada chamada, quanto tempo ficou parado desde a resposta
   anterior (`gapMs`: o modelo pensando, o cliente MCP e a rede) e quantas estavam em andamento ao mesmo tempo (`inFlight`).
5. **A visão do conjunto**: toda linha leva o token e o rótulo do cliente; o painel soma por cliente e de todos os clientes.

## Onde fica

- `<pasta do servidor>/quality-AAAAMMDD.jsonl` (dia UTC), ao lado de `audit-AAAAMMDD.jsonl`, com permissão 0600. Em Docker,
  `/data/server`; a rotação, a retenção (`QUALITY_KEEP_DAYS`) e o backup são os da auditoria.
- Uma linha por chamada de ferramenta (gravada no mesmo instante da linha da auditoria) e uma por sessão MCP aberta e
  fechada (com a família do cliente MCP: `claude-code`, `codex`, `cursor`... nunca o nome nem a versão).
- Só o modo hospedado grava (`ssam serve` sem `--local-studios`). `--local-studios` e o stdio (`ssam mcp`) não gravam nada.
- Desligar: `SSAM_QUALITY=0` no ambiente do servidor (no Docker, no `.env`), lido uma vez na partida. O log do servidor diz
  `{"event":"quality","on":true|false}`. Uma gravação que falha nunca muda a resposta nem a auditoria: o log registra
  `{"event":"quality-failed","stage":...,"error":<código>}` no máximo uma vez por minuto.

## O que nunca entra

A linha é montada a partir de uma lista fechada de campos (desenho do registro, seção 2.5, "A lista permitida"); não existe
campo para conteúdo. Nunca entram: nomes de módulo, tela, action, entidade, atributo, estrutura, site property ou role;
`@key`s e chaves de elementos; o job, as operações, os patches, o conteúdo de `basedOn` e hashes de job; expressões, SQL, CSS
e HTML; a mensagem, a correção, o ponteiro, o elemento e o caminho de um problema; os itens das normalizações (`path`,
`from`, `to`); o detalhe dos avisos; caminhos de arquivo e nomes `ws:`/`agent:`; endereços de tenant, ambiente ou app e
nomes de host; IPs; o nome e a versão do cliente MCP; o id da sessão (só um hash curto); texto livre de qualquer tipo.
Um código com cara de nome (`GetColaboradorAtual`) só fica quando é um id de verificação dos catálogos do kernel
(`kernel/catalog/verify-*.json`); senão vira `NATIVE_UNLISTED`.
A forma `UPPER_SNAKE` também não basta (achado de privacidade de 2026-10-12: um nome de tabela do cliente, como
`OSUSR_K3X_FOLHA`, chegava como código). O código da linha, os códigos dos problemas e as regras das normalizações só
ficam quando estão nos registros do contrato, gerados das fontes do produto: `CODES` e `RULES` (as regras do
`JobNormalizer` do kernel). `CODES` tem:

- toda string `UPPER_SNAKE` da fachada, do portal, da bridge e do builder ODC, do lançador, do agente, de `kernel/src` e
  de `kernel/query-test` (os códigos do `ssam_query_test`, compilados nas duas bridges);
- os códigos que o produto compõe em tempo de execução a partir de uma palavra das próprias fontes, cada um pela regra de
  quem o compõe: `<FERRAMENTA>_FAILED` de cada ferramenta hospedada, `<PASSO>_FAILED` de cada passo, `<VERBO>_INVALID` de
  cada verbo e operação do kernel e `OP_INVALID` (o problema genérico do preflight, `JobPreflight.cs`), `<OP>_REFUSED` das
  operações de integração (`rest`, `rest-expose`, `soap`), o código que o formatador de respostas dá a cada palavra de
  `failed`, `stage` e `gate` das fontes (`<PALAVRA>_FAILED`; um gate `snake_case` em maiúsculas) e `PUBLISH_<GATE>` de cada
  gate (a publicação recusada).

Fora da lista, o valor vira `CODE_UNLISTED` ou `RULE_UNLISTED` e é contado, nunca escrito. `RPC_<número>` fica pela forma
(só dígitos). O `op` só fica quando está nos valores das próprias ferramentas (`OPS`). O gravador e o leitor do painel aplicam
as mesmas listas. A auditoria (`audit-*.jsonl`) usa o mesmo registro para o código de erro.
O texto de uma resposta nunca vira código: a regra que transformava `debug_<x>` em `DEBUG_<X>` vale só nas respostas do
depurador (`ssam_debug*`, que o servidor hospedado não serve); em `odc_read` ou qualquer outra ferramenta, um nome
`debug_folha_pagamento` citado por um erro do banco fica no texto, e a recusa recebe o código da ferramenta
(`ODC_READ_FAILED`).
O verbo de uma chamada ao agente (o comando do pipe do ODC Studio, o método da ponte O11) só fica quando está na lista
fechada que o próprio agente aplica (`AGENT_VERBS` do contrato, cópia de `ODC_COMMANDS` e `O11_METHODS` de
`agent/lib/kinds.mjs`); a forma de verbo não basta. O `command` de `studio_command` é texto do modelo: fora da lista, a
chamada fica só com o tipo (`odc.pipe`), no registro, no painel e no `server.log` (eventos `agent-call` e `relay-*`); a
operação de `environment_session` no log segue a lista do kernel (`ENVIRONMENT_OPERATIONS` de `agent-hub.mjs`).

## O contrato e os testes

- `platforms/odc/facade/quality-line.mjs`: o contrato (sanitizador, limite de 4096 bytes por linha, catálogo dos ids
  nativos, os registros `CODES` e `RULES`), cópia idêntica da que o painel usa para ler; o teste de paridade confere o
  sha256.
- `platforms/odc/scripts/quality-registry.mjs`: gera o bloco dos registros a partir das fontes. Um código ou uma regra nova
  no produto (uma constante, um verbo, uma operação de integração, um `stage` ou um `gate`) faz `quality-registry.test.mjs`
  falhar até rodar `node platforms/odc/scripts/quality-registry.mjs --write`; depois, o sha256 novo vai para o teste de
  paridade, e o contrato e as fixtures vão para as cópias do painel. O mesmo teste falha quando um fonte C# compilado nas
  bridges, no kernel ou no builder ODC (os `<Compile Include>`, os itens padrão e as referências de projeto) ou o arquivo
  que registra uma ferramenta hospedada fica fora das pastas lidas pelo gerador.
- `quality-record.mjs` (monta a linha, sem I/O), `quality-meter.mjs` (contexto da chamada e atribuição do tempo das
  chamadas ao agente e das execuções do kernel), `quality-recorder.mjs` (grava).
- Testes: `tests/quality-line.test.mjs`, `quality-record.test.mjs`, `quality-meter.test.mjs`,
  `quality-registry.test.mjs` (deriva dos registros contra as fontes, as famílias compostas, a cobertura das pastas e as
  sentinelas de uma constante, um verbo, um `stage` ou um `gate` novo),
  `http-server-quality.test.mjs` (inclusive uma resposta hostil cujos nomes, caminhos e expressões nunca chegam ao arquivo)
  e o teste de `onCallSettled` em `agent-hub.test.mjs` (com um `command` livre com forma de verbo, que não chega à linha
  nem ao log), mais os testes de deriva das listas fechadas contra `agent/lib/kinds.mjs` e o kernel
  (`EnvironmentOperations.Names`). Os exemplos ficam em `tests/fixtures/quality/`.

## Onde o dono lê

No painel do dono, aba **Qualidade**: os códigos de erro mais comuns, os problemas das recusas por código, as correções
automáticas por regra, as fases da entrega por ferramenta, as voltas até entregar e o que mais gera voltas, por cliente
ou de todos os clientes, com exportação CSV e JSON.
