# Conhecimento do time

Regras de trabalho e lições da plataforma aprendidas no uso real do SSAM Hybrid. Valem para qualquer agente (Claude,
Codex ou outro) e para qualquer pessoa do time. Leia antes de gerar ou alterar módulos O11 ou ODC.

## 1. Como trabalhar

- **Validação só quando pedirem.** Testes de comportamento, revisões e conferências no navegador rodam só quando a
  pessoa pede. Não acrescente rodadas de validação por conta própria.
- **Erro volta para o modelo.** Quando uma ferramenta de entrega devolve erros do verificador (TrueChange), ela não
  entrega nada. O modelo corrige o pedido e chama de novo.
- **Sem erro, a resposta é "entregue".** Não descreva o que mudou nem onde: a pessoa confere na plataforma e, se
  precisar, usa o Compare do Studio.
- **Construa sobre a última versão publicada.** Outras pessoas também publicam. Antes de montar uma mudança, baixe a
  versão publicada atual do módulo e use-a como base.
- **Em tarefa de uso, não mexa no produto.** Para criar um app ou library ODC, use `studio_create_app {kind, name,
  authorize}` (clona o template do tenant como o Studio e publica). Para alterar um app, use `ssam_discover`,
  `o11_deliver`/`studio_deliver`, `studio_merge`... Não escreva features C# no builder, não edite o kernel
  nem os arquivos versionados de configuração. Antes de dizer que algo não é possível, pergunte ao `ssam_discover`: ele
  devolve a operação exata. Se a capacidade faltar de verdade, pare e diga o que falta, para virar trabalho do produto.
- **Todo pedido começa no `ssam_discover`.** Ele responde qualquer pedido do SSAM. Para operação (abrir módulo,
  publicar, criar app, dados, Service Center, Portal, debug), devolve em `tools` a ferramenta, o verbo e os argumentos.
  Para mudança de modelo, devolve contrato e exemplo. Não há bloqueio: as outras ferramentas continuam livres.
- **Configuração pessoal fica local.** Tenant, host e autor de cada pessoa vão no `.ssam-local.json` (fora do git),
  gravado pelo setup de desenvolvimento. Nunca faça commit dos seus valores no `tenants.json`.
- **Sem execuções longas.** Nada de fluxos de horas ou de suítes completas repetidas sem necessidade. Prefira o menor
  teste que responde a pergunta e diga antes quanto tempo ele leva.

### Jobs em arquivo: ferramenta Write em UTF-8

Um job grande vai num arquivo gravado com a ferramenta Write, em UTF-8, e a chamada passa o caminho do arquivo.
- Local: o caminho absoluto do arquivo.
- Hospedado: o inbox do agente. Grave em `<pasta do agente>\inbox\<nome>.json` e passe `agent:inbox/<nome>.json`.
- Nunca gere o JSON com heredoc, `echo` ou script: o encoding e as aspas quebram.

### Subagentes: carregar as ferramentas SSAM primeiro

O prompt de um subagente começa carregando as ferramentas SSAM por ToolSearch, numa busca só, antes do primeiro uso
(`select:mcp__<servidor>__ssam_discover,mcp__<servidor>__ssam_map,...`). Sem isso o subagente não vê as ferramentas e
cai para shell ou script.

### Mudança de fachada: quando reconectar o MCP

O servidor MCP recarrega sozinho quando a fachada ou o catálogo mudam: a próxima chamada já usa o código novo, e o
`ssam_doctor` mostra `server.reloadedAt`. Só uma mudança em `facade/launch.mjs` ou `facade/friction-*.mjs` pede reconectar
o MCP (Claude Code: `/mcp` e reconnect). Mudança só de kernel, CLI ou motor XIF não pede nada.

### Vários agentes no mesmo Studio: um módulo por agente

Dê a cada agente um módulo seu. O build de cada entrega roda junto, fora da trava; o merge espera a vez no Studio.
Ninguém espera nem repete à mão: o SSAM faz a fila. Detalhes em `docs/AGENTES-EM-PARALELO.md`.

### expectedMessages: só o que uma recusa pediu

Declare em `expectedMessages` só as mensagens que uma recusa pediu, com o id e o elemento que ela nomeou. Nunca liste
mensagens por precaução: uma expectativa que ninguém pediu esconde um erro novo.

## 2. Padrões de implementação OutSystems

- Todo código gerado segue as 35 regras do OutSystems padrões (lógica, listas, dados, servidor, UI, nomes, estado e
  arquitetura): `ssam_reference {lane:"<lane>", kind:"rules", query:"padroes"}` (arquivo
  `kernel/scripts/outsystems_padroes/RULES.md`). Todas valem para O11 e ODC, menos a AR1 (Architecture Canvas), que é
  só do O11.
- A conferência automática dessas regras é opcional e roda só quando alguém pedir.
- Regra de escopo: implemente todos os critérios de aceite. Quando dois requisitos se contradizem diretamente, não
  implemente nenhum dos dois, registre o conflito como pendência e implemente o resto.

## 3. Lições da plataforma

### Acesso a dados: uma consulta com join, nunca consulta dentro de laço

Decisão do dono (2026-10-09), regra do kernel nas duas faixas. Busque os dados relacionados de uma vez, antes do laço, e
procure a linha por chave dentro dele:

```json
{"get":"Order","as":"GetOrdersWithLines","sources":["OrderLine"],
 "joins":[{"left":"Order","right":"OrderLine","kind":"With or Without","condition":"OrderLine.OrderId = Order.Id"}],
 "where":"Order.CustomerId = CustomerId"}
```

Quando o aggregate não expressa a consulta, um SQL só, com IN ou JOIN pela chave da lista:

```sql
SELECT {OrderLine}.* FROM {OrderLine} WHERE {OrderLine}.[OrderId] IN (@OrderIds)   -- @OrderIds com Expand Inline
```

Dentro do laço, `ListFilter(GetOrdersWithLines.List, OrderLine.OrderId = GetOrders.List.Current.Order.Id)` (ou
`ListIndexOf`) no lugar de outro aggregate.

- **QUERY_IN_LOOP (recusa)**: um Aggregate ou Execute SQL no corpo de um ForEach, ou num ciclo de If/Assign que volta a
  um nó anterior, que o job criou ou mudou, é recusado no apply, junto com as outras falhas (uma recusa só). A resposta
  traz o op, o laço, a consulta, a correção e, quando dá para derivar (ForEach sobre outro aggregate do fluxo com FK entre
  as entidades), o trecho de ops pronto em `suggestion`. Laço e consulta antigos, num fluxo que o job tocou sem mexer
  neles, viram aviso HIGH (`legacy: true`), nunca recusa.
- Escape explícito, só quando a consulta precisa mesmo rodar por item: `"allowQueryInLoop": {"why": "<15+ caracteres>"}`
  no op que cria a consulta. É aceito e fica no recibo (`QUERY_IN_LOOP_ALLOWED` em `highWarnings`), nunca em silêncio.
- **AGGREGATES_MERGEABLE (aviso HIGH)**: dois ou mais aggregates no mesmo fluxo ou na mesma tela, sobre a mesma entidade
  ou entidades ligadas por atributo de referência, usados juntos. O aviso nomeia os aggregates, a relação
  (`Entidade.Atributo -> Entidade`) e sugere o aggregate único (fontes + join + filtros). A03: não bloqueia, mas vem
  primeiro em `warnings` e também em `highWarnings`, na resposta compacta de `studio_deliver`, `o11_deliver`,
  `ssam_job` e `o11_job`. Em telas diferentes não conta.

### Protótipo aprovado: portar 1:1

Quando a pessoa aprovou um protótipo (HTML e CSS), ele é portado 1:1: a op `html` com a marcação do protótipo e o
`<style>` dele no tema do módulo. Não troque o protótipo por padrões do OutSystems UI. Nada está pronto sem o link do app
(`ssam_app_url`).

### CSS: reset escopado com :where()

O reset de CSS de um protótipo vai escopado com `:where(.<classe da tela>)`, que tem especificidade zero. Nunca escreva
seletor de elemento (`button`, `a`, `input`) por cima das classes do OutSystems UI: ele vence o tema e quebra os widgets.

### Lista: refresh parcial sem recarregar a tela

Para mudar uma linha da lista sem recarregar a tela inteira:
- a server action grava e devolve, nas saídas, a linha nova e o resumo (totais, contagens);
- a client action faz `Assign` em `<Lista>[<índice>]` com a linha devolvida e copia o resumo das saídas para as variáveis
  da tela;
- não chame o refresh do aggregate nem da Data Action da lista inteira.
O contrato dos passos `call` e `assign` é o da capability `logic.flow`:
`ssam_discover {intent:"atribuição de variável no fluxo de lógica", lane}`.

### O11: republicar os consumidores depois do produtor

Um módulo consumidor continua rodando o código do produtor contra o qual foi publicado, mesmo sem mudança de
assinatura. Depois de publicar um produtor, republique cada consumidor na ordem de dependência e só então teste.
Sem isso, a lógica nova parece "quebrada" na tela.

Timers com Schedule "When Published" podem não rodar logo depois da publicação. Para cargas iniciais (seed), prefira
rodar sob demanda.

### ODC: o que o Studio recusa e o preflight já recusa antes da entrega

O preflight do kernel (regra `OdcPlatformRules`, 05/10/2026) recusa no job, com a correção exata, o que o ODC Studio
recusou na sessão do QuizLive (04/10):
- **Service Action do próprio app** chamada por um fluxo do app (`ODC_SERVICE_ACTION_SAME_APP`): a lógica vai numa Server
  Action, e a Service Action fica só como a API que outros apps chamam. Não gere Service Actions nem actions `Core_`
  que a pessoa não pediu.
- **`GenerateGuid()` e o operador `mod`** não existem no ODC (`ODC_FUNCTION_UNAVAILABLE`): derive o código de dados (o
  último Id) e escreva `x mod n` como `x - DecimalToInteger(x / n) * n`.
- **`Count` de aggregate é Long Integer** (`ODC_COUNT_IS_LONG`): atribuído a Integer, use
  `LongIntegerToInteger(GetX.Count)` (o problema traz o patch) ou declare a variável como Long Integer.

### O11: agenda de timer em texto

O `Schedule` do timer O11 é texto, como o Service Studio grava: `Every 60 minutes`, `Every day at 00:00`,
`Every Monday at 00:05` (provado por `kernel/tests/jobs/pacote-laneE-timer-schedule.json`). O ODC usa `CronSchedule` de
cinco campos.

### ODC (client) e O11 (server): lambda de list action só com atributo direto

Nos argumentos de lambda de list actions, escreva os atributos do elemento diretamente: `Condition` de ListFilter,
ListIndexOf, ListAny e ListAll, e `By` de ListSort. Exemplos: `IsActive`, `Amount`, `Code = "X"`.

- **ODC, client actions:** `<Lista>.Current.Atributo` passa no build, mas o runtime nunca avança o Current. O ListSort
  não ordena, e o ListFilter compara todas as linhas com a mesma linha.
- **O11, server ListSort:** o mesmo defeito. Todos os elementos ficam com a mesma chave, e a ordenação instável
  embaralha a lista. Use os atributos do item da lambda; se precisar de desempate, monte uma chave de texto única e de
  largura fixa.
- No server, ListFilter, ListIndexOf e ListAny com `.Current` funcionam, nos dois.
- O ODC não tem ListSort de servidor, só o de client.
- `CurrentRowNumber` dentro da condição de um ListFilter de client não é confiável.

O kernel e o verificador do Studio aceitam as duas formas. Só um teste em execução pega o erro.

### O11: entidade com "Changed Attributes" não grava cópia velha

Com Update Behavior = Changed Attributes, o Update grava só os atributos atribuídos depois da leitura. Se você lê um
registro, chama algo que muda essa linha no banco e depois faz Update da cópia lida para "restaurar", nada é gravado.

Para restaurar: guarde o valor numa local, leia a linha DE NOVO depois do efeito colateral, atribua o valor guardado e
então faça o Update.

### O11: nunca redeclare uma action pública existente

Redeclarar uma action pública que já existe (mesmo nome e assinatura) dentro de uma op `logic` gera uma chave nova
para ela. Os consumidores se ligam por chave, então a publicação do consumidor trava, e o Studio mostra
"Incompatible or missing dependencies found".

- **Detectar:** compare as chaves dos elementos públicos entre a versão publicada e a OML nova
  (`ssam_map {lane:"o11", target:"<OML>", kind:"ServiceAction"}` nas duas), ou rode
  `o11_environment {action:"refresh-refs", module:"<consumidor>"}` sem publicar e veja os erros (`validation`).
- **Religar o consumidor:** `reference` dos elementos com chave nova; `set @<chamada> Action
  "IServiceAction:@<chave do módulo produtor>/<chave nova>"` (remapeia argumentos por nome); `delete` das assinaturas
  velhas; `set Name` de volta ao nome do produtor. Confira com `o11_deliver {until:"apply"}` (valida sem merge) e
  `o11_inspect {path:"@<chave>"}`.

### Merge direto de OML pela ponte

Quando as OMLs já estão prontas e a pessoa só quer colocá-las nos módulos abertos, use a ponte direto, módulo por
módulo: `open_module`, depois `snapshot_module` (registra a base) e depois `merge_from_oml` com `mode=auto`, a
snapshot como base e a chave do módulo. Leva de 2 a 11 segundos por módulo.

Use o `deliver` completo, que refaz o job e valida antes do merge, só quando a pessoa quer a integração com
conferência. Antes de um merge direto, confirme que o módulo aberto ainda é a base da OML: com base velha, o merge
desfaz mudanças mais novas.
