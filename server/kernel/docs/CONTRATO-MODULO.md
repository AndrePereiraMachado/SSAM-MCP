# Contrato de módulo no fluxo controlado

A ferramenta `propose` recebe `module`, `lane`, `environment` e uma ou mais seções: `data`, `roles`, `exceptions`,
`logic`. `expectedMessages` mantém o contrato de avisos. Não aceita `ops`, `job`, `base`, `checks`, `replace` ou uma
aprovação fornecida pela LLM. `context` devolve o esquema gerado pelo código vigente.

`data` usa a spec de dados existente. `logic.actions` usa a spec de lógica existente, com a política `access`
adicional. O controlador expande a política e escolhe quais actions criar ou substituir, preservando consumidores.
Actions que já correspondem ao contrato não são recriadas.

## Políticas de acesso

Toda server action pública e toda service action exige `access.authenticated: true`. Actions privadas podem ser
helpers internos. Client actions não fornecem um certificado de autorização no servidor. Entradas anônimas ainda
não são aceitas por esse contrato controlado.

Exemplo de restrição de parâmetro:

```json
"access": {
  "authenticated": true,
  "roles": ["Administrator", "Requester"],
  "inputs": {
    "AssigneeId": {"roles": ["Administrator"], "default": "NullIdentifier()"}
  }
}
```

O Requester só pode enviar o valor padrão declarado; um responsável diferente é recusado antes do corpo da action.
O controlador não troca silenciosamente o valor enviado. Os defaults aceitos são literais, registros estáticos,
`NullIdentifier()` ou `GetUserId()`; não podem depender de um parâmetro controlado pelo chamador.

Exemplo de visibilidade por proprietário:

```json
"access": {
  "authenticated": true,
  "roles": ["Administrator", "Requester"],
  "readScopes": [
    {"query": "ReadIncidents", "ownerAttribute": "ReporterId", "exceptRoles": ["Administrator"]}
  ]
}
```

`ReadIncidents` deve identificar exatamente um aggregate da action. O filtro adicional exige que o proprietário
seja `GetUserId()`, ou que o usuário tenha uma role de exceção. Preserva os outros filtros. A aplicação automática
de escopo a SQL ainda é recusada; ela não vira um filtro aproximado.

As roles mencionadas devem estar declaradas na seção `roles`, por exemplo `[{"name":"Administrator"},
{"name":"Requester"}]`. As verificações usam a identidade corrente do servidor. A exception privada
`HybridAccessDenied` é garantida pelo controlador quando houver políticas de acesso.

## Nós e contextos de actions

O contrato declara `kind: server | service | client`. Actions de tela usam `kind: screen` e `owner`, por exemplo
`IMobileScreen:Details` ou `IWebBlock:Editor`. Preparações usam `kind: preparation`, `name: Preparation` e um
owner `IWebScreen`, `IWebBlock` ou `IWebEmail`. O owner deve existir no snapshot; esta ampliação não cria a UI
nem permite editar objetos arbitrários por `owner`. Uma action por nome no mesmo contrato continua sendo exigida.

Além de get/SQL, assign, call, CRUD, if, foreach e raise, a lógica aceita:

- `switch: [{when, steps}]`, com `otherwise` e ramos na ordem declarada.
- `handlers: [{name, exception, abortTransaction, logError, steps}]` na action. Handlers que terminam em End recebem um End próprio, separado do fluxo principal.
  Em actions autenticadas, só pode capturar exceptions de negócio declaradas; não pode engolir a guarda de acesso.
- `comments: [{text, reminder}]`. O texto declarado é conferido; comentários automáticos do Studio não são nós executáveis.
- `node`, `as` e `properties` para os outros widgets nativos. A lista de nós, propriedades, tipos e enums é fechada
  e vem de `context`. `Target`, `Parent`, chaves e outros campos operacionais não são aceitos.

Exemplo de JSON sem verbos crus:

```json
{"node":"IJSONSerializeNode","as":"Encode","properties":{
  "Data":"Items","DateFormat":"ISO","SerializeDefaultValues":true
}}
```

JavaScript também declara `inputs`, `outputs` e `args` no nó. A conferência lê o código e as assinaturas que ficaram
no modelo. Excel importa usando `Import` como lista e exporta usando `Export` como Binary Data: não existem
os sufixos `Import.List` ou `Export.BinaryData`. `AttributeSelection` é um conjunto de nomes relativos ao tipo;
o Model API não preserva a ordem dessa coleção. A ordem dos atributos do tipo continua sendo a do tipo declarado.

Operações de lista usam `call`: ListAppend, ListAppendAll, ListInsert, ListRemove, ListClear, ListDuplicate,
ListFilter, ListSort, ListAll, ListAny e ListIndexOf. No cliente, escolhe a assinatura nativa de cliente. Actions
referenciadas continuam sendo identificadas por tipo e identidade, não apenas por um nome coincidente.

Aggregates aceitam `sources` adicionais, `joins: [{left,right,kind,condition}]`,
`columns: [{name,attribute,kind}]` (Group, Count, Sum, Max, Min, Avg) e `calculated: [{name,value}]`.
Com agrupamento, o resultado contém as colunas de agrupamento/agregação. Colunas calculadas da fonte não se
transformam automaticamente em colunas projetadas do agrupamento. SQL não aceita esses campos de aggregate.

## Restrições provadas do runtime

- Service Action só em módulo Service. Client Action só nos contextos aceitos pelo Studio.
- Download usa uma screen action Traditional. Em client action Reactive/Mobile o nó nativo é recusado.
- Message é provado em cliente Reactive/Mobile; não é o widget de feedback de uma screen action Traditional.
- Refresh Data recebe a fonte e MaxRecords. `StartIndex` não vazio é recusado porque o merge nativo o descarta;
  declare a paginação na fonte do aggregate.
- Entidade local pública é recusada pelo contrato porque o merge deste build remove Public. Use a entidade local
  privada e estruturas públicas para dados que atravessam o contrato da action.
- Decision Outcome pertence a uma decisão BPT. Não é um widget de server/service/client action comum.

## O que a conferência prova

Confere quantidade e tipos de parâmetros, listas por significado, variáveis, expressões, destinos e argumentos
de chamadas, filtros, ordenação, parâmetros e saída SQL, atribuições, branches, ciclos e conexões. Detecta nós
executáveis extras, desabilitados ou desconectados. A prova distingue comentários dos nós executáveis; posicionamento visual não muda a semântica.
Omissão ou troca de um passo declarado falha mesmo quando o Verify não reporta erros.

Também confere as guardas geradas. As evidências completas ficam no checkpoint; o MCP recebe resumo, contagens e
todos os diagnósticos de falha. Erro após merge retoma a mesma tarefa. Reparação real substitui somente as actions
divergentes e mantém o contrato original.

## Limites

A prova cobre a declaração normalizada. Não descobre toda omissão na interpretação inicial nem deduz regras
faltantes de transição de status, prioridade, SLA ou auditoria. A ordem de um `CommitTransaction` é conferida quando
declarada, mas isso não prova a atomicidade de chamadas remotas ou o comportamento do banco em execução.

Os testes de política percorrem predicados do módulo compilado com identidades sintéticas. A prova viva atual
valida merge e estrutura, sem publicar nem executar as actions no servidor. Esses níveis estão separados no
[comprovante](proofs/2026-09-05-cobertura-actions.json).
