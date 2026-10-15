# Integrações REST e SOAP no SSAM Hybrid

Lane restsoap do pacote `docs/INTEGRACOES-GITSSAM.md`.
Quatro ops de job fazem a integração numa chamada só: `rest`, `rest-consume` (o gerador), `rest-expose` e `soap`.
Não há ferramenta MCP nova. As ops passam pelas entregas de sempre: `o11_deliver`, `studio_deliver`, `o11_job` e `ssam_job`.
O contrato exato de cada op sai de `api --op rest|rest-consume|rest-expose|soap` e do `ssam_discover`.

## O que cada op faz

Cada op é declarativa sobre o que nomeia:
- o que falta é criado;
- o que existe é atualizado no lugar, pela chave (quem chama continua ligado);
- o que a op não nomeia fica como está;
- `remove` apaga o que lista.

Todos os erros dos dados vêm numa recusa só, antes de qualquer mudança.
A recusa traz o código, o lugar (ponteiro JSON) e a correção exata.

### `rest` (REST consumido, O11 e ODC)

```json
{"op":"rest","data":{
  "client":{"name":"ViaCepApi","baseUrl":"https://viacep.com.br"},
  "methods":[{"name":"GetAddressByCep","http":"GET","path":"/ws/{CEP}/json/",
              "inputs":[{"name":"CEP","type":"Text","in":"url"}],
              "response":{"sample":{"cep":"01001-000","uf":"SP"}}}]}}
```

- Só expande para os verbos crus já provados (`rest-consume-get`, `-post`, `-call`, `rest-query-nested`).
- Entrada `in`: `url`, `query`, `header` ou `body`. Query vira `?a={a}` no `URLPath`, como o gerador do Studio.
- Amostra JSON vira estruturas pelo próprio plugin REST (`JsonParser` e `StructureHelper`, por reflexão).
- Um método redeclarado fica com exatamente as entradas e saídas declaradas.
- `openapi {path, sha256, operations}` importa só as operações escolhidas (veja OpenAPI abaixo).
- Credencial nunca vai no modelo: `REST_CREDENTIALS_NOT_IN_MODEL`. No O11 é regra do SSAM (`ssamRule: true`).
  A correção é uma entrada obrigatória `Authorization` em header.
- Códigos: `REST_UNKNOWN_KEYS`, `REST_KEY_INVALID`, `REST_BASEURL_INVALID`, `REST_BASEURL_REQUIRED`, `REST_URLPATH_INVALID`,
  `REST_PATH_PARAM_WITHOUT_INPUT`, `REST_URL_INPUT_UNUSED`, `REST_BODY_ON_GET`, `REST_REQUEST_BODY_COUNT`,
  `REST_RESPONSE_BODY_COUNT`, `REST_HEADER_TYPE`, `REST_SAMPLE_INVALID`, `REST_CLIENT_NO_METHODS`, `REST_NAME_TAKEN`,
  `REST_DUPLICATE_NAME`, `REST_REMOVE_NOT_FOUND`.

### `rest-consume` (gerador de REST consumido, O11 e ODC)

Pedido do dono (13/10/2026): no portão, o modelo gastou 70 a 82% do tempo escrevendo código à mão. Consumir 4 APIs públicas
com service actions levou 6 min e 4 recusas. A solução é por família (qualquer API, qualquer domínio): o modelo escreve só as URLs.

```json
{"op":"rest-consume","data":{"name":"BrasilApi","methods":[
  {"name":"Feriados","url":"https://brasilapi.com.br/api/feriados/v1/{ano=2026}"},
  {"name":"Cep","url":"https://brasilapi.com.br/api/cep/v1/{cep=01001000}"}]}}
```

O que uma op escreve, de forma determinística (`kernel/src/Anvil.Core/Kernel/RestConsume.cs` e `Verbs.RestConsume.cs`):
- O cliente REST e seus métodos, pela op `rest` (os mesmos `IRestClient`/`IRestAction`/`IRestStructure` do import do Studio).
- As estruturas de saída do cliente (`<Recurso>Json`), inferidas da amostra.
- Uma estrutura pública por recurso: o espelho, com os mesmos nomes e os aninhados espelhados.
- O mapeamento, atributo a atributo (`Origem mapTo { A: A, R.A: R.A }`).
  - A conversão automática da plataforma deixa algumas formas vazias ("Empty Mapping") nas duas faixas: por isso o gerador nunca depende dela.
  - Registro dois níveis abaixo e lista de registros passam por funções privadas `Map<Estrutura>FromJson` / `Map<Estrutura>ListFromJson`.
  - Nunca For Each, nunca JavaScript.
- Uma service action pública por método, com nome Verbo+Cliente+Objeto (regra N1 do dono):
  - o verbo do próprio método quando o nome começa por um (`ListRepos` do GitHub vira `ListGitHubRepos`);
  - senão o verbo do HTTP: GET `Get`, POST `Send`, PUT `Save`, PATCH `Update`, DELETE `Delete` (`Feriados` da BrasilApi vira `GetBrasilApiFeriados`);
  - `action` sobrepõe o nome.
  - Chama o método e devolve `Result` (`IsResult` quando a resposta é um booleano só).
  - Qualquer falha vira a user exception `errors.exception` (padrão `<Cliente>Error`), com log.
  - Variantes: `expose.serviceActions:false` gera server actions; `expose:false` gera só o cliente.
  - Library ODC: server actions públicas. App ODC com `serviceActions:false`: server actions do próprio app.
- Action que muda dado (todo verbo menos GET; regra AR2 do dono):
  - a entrada pública checa o usuário antes: `if GetUserId() = NullIdentifier()` (ODC: `NullTextIdentifier()`), raise `AccessDenied` (a do módulo, ou criada);
  - depois chama a `<Action>_Impl` privada, onde ficam a chamada ao método e o handler AllExceptions (a checagem nunca fica ao alcance dele);
  - `expose.guard: "none"` tira a checagem (por exemplo, uma action chamada só por timer).
- Booleano leva Is/Has/Can (`fork` vira `IsFork`; o nome no JSON fica). Todo elemento tem descrição, todo assign um label e o If uma pergunta.
  O OutSystems padrões (estágio oml) dá 0 achados nas 15 amostras, nas duas faixas.

URL e entradas:
- `url` absoluta: a parte comum das URLs vira a `baseUrl`. Ou relativa à `baseUrl`.
- `{p}` ou `{p=exemplo}` no caminho: entrada obrigatória.
- `?k=v` na query: entrada opcional com padrão `v`. `?k={p}`: entrada obrigatória.
- `params {p: tipo}` tipa as entradas. Sem ele, o exemplo decide: dígitos são números, `true`/`false` Boolean, `yyyy-MM-dd` Date, o resto Text.
  Um código com zero à esquerda (`01001000`) fica Text.

Tipos da amostra:
- Text, Integer, Long Integer, Decimal, Boolean, Date (`yyyy-MM-dd`) e Date Time (ISO com `T` e segundos).
- Número escrito como texto fica Text.
- `null` e `[]` viram Text e Text List, com aviso `REST_CONSUME_TYPE_GUESSED`.
- Lista de listas fica de fora, com aviso `REST_CONSUME_FIELD_OMITTED`.
- Raiz que não é registro: lista de valores vira `X List`. Um valor só é lido como texto e convertido (número, booleano).
  Objeto vazio ou lista de listas é lido como o texto JSON (`REST_CONSUME_RAW_BODY`).
- Formas iguais viram uma estrutura só.

Amostra:
- O kernel nunca lê a rede. Método GET sem `sample` é recusado com `REST_CONSUME_SAMPLE_MISSING`.
- A fachada (`integration-documents.mjs`) faz um GET por URL antes de tudo, em `o11_deliver`, `studio_deliver`, `o11_job` e `ssam_job`:
  10 s, 2 MB, sem credencial, só JSON, listas cortadas em 20 itens.
  A amostra fica fixada na op, com `sampledFrom {url, status, bytes, sha256}`.
- Recusas da amostragem: `REST_CONSUME_TRY_MISSING`, `REST_CONSUME_SAMPLE_FETCH_FAILED`, `REST_CONSUME_SAMPLE_NOT_JSON`, `REST_CONSUME_SAMPLE_TOO_LARGE`.
- POST, PUT, PATCH e DELETE nunca são chamados: `sample` é a resposta, `request` o corpo enviado.

Idempotência e nomes:
- Cada elemento leva na descrição a marca `ssam:rest-consume <Cliente>/<Base> #<hash>`.
- A mesma op de novo não muda nada: `changed:false` e tudo em `unchanged`.
- Amostra mudada atualiza no lugar: mesmas chaves. O que sumiu é apagado depois que as actions foram reescritas.
- Nome que o módulo já usa para outro elemento vai para o próximo livre (`Name2`), listado em `renamed`.
  Estrutura e action podem ter o mesmo nome; duas estruturas, não.
- A exceção de mesmo nome é reaproveitada.

Recibo (`integration` da entrega): `imported`, `updated`, `unchanged`, `removed`, `renamed`, `warnings` e `generated`.
`generated` traz o cliente, a base, a exceção e, por método, o URL Path, os tipos e a assinatura da action. Não é preciso reler o módulo.

#### API autenticada e customizada (mesma op, O11 e ODC)

Pedido do dono (13/10/2026): tudo o que o diálogo Consume REST do Studio e os callbacks REST permitem.
`kernel/src/Anvil.Core/Kernel/RestConsume.Auth.cs`.

```json
{"op":"rest-consume","data":{"name":"Acme","auth":{"type":"bearer"},"headers":{"Accept":"application/json"},
  "settings":{"baseUrl":true},"timeout":20,"correlationHeader":"X-Correlation-Id",
  "errors":{"status":{"404":"AcmeNotFound"}},
  "methods":[{"name":"GetOrder","url":"https://api.acme.example/v1/orders/{id=1}","headers":{"X-Tenant":"{tenant}","X-Version":"2"},
    "optional":["tenant"],"sample":{"id":1,"status":"open"}}]}}
```

Credencial nunca entra no modelo (`REST_CREDENTIALS_NOT_IN_MODEL`):
- O gerador cria as site properties (O11) / settings (ODC) que guardam a credencial: vazias e secretas.
- O `OnBeforeRequest` do cliente lê esses valores em tempo de execução.
- O recibo traz `configure`: nome, se é secreta, o que preencher e onde (Service Center > módulo > Site Properties; ODC Portal > app > Settings).
- O cliente fica com `AuthenticationType` None. A autenticação nativa do cliente guardaria usuário e senha no módulo, por isso não é usada.
- Chave de credencial em `auth` (`token`, `password`, `clientSecret`...) ou header de credencial literal (`Authorization: Bearer x`) é recusado.

`auth.type`:
- `bearer`: `<Cliente>Token`, enviado como `Authorization: Bearer <valor>`.
- `basic`:
  - O11: `<Cliente>Username` e `<Cliente>Password`, as duas secretas. O `OnBeforeRequest` monta o Base64 em tempo de execução com a extensão de
    sistema BinaryData (`TextToBinaryData` em utf-8, depois `BinaryToBase64`), que está em todo ambiente O11.
    A entrega acrescenta ao job `{"op":"reference","producer":"BinaryData","elements":["IServerAction:TextToBinaryData","IServerAction:BinaryToBase64"]}`
    (no fim; a referência congelada entra antes da edição) e o `o11_deliver` captura o BinaryData só leitura.
    Sem a referência: uma recusa `REST_CONSUME_REFERENCE_MISSING` com a op que falta. `ssam_job`: `captureProducers ["BinaryData"]`.
    Provado offline com a captura atestada `tests/fixtures/rest-consume/producers/BinaryData.avsig`.
  - ODC: `<Cliente>BasicCredentials` guarda o Base64 de `user:password` (o usuário preenche o valor já codificado).
    Nenhuma função Base64 nativa (provado) e nenhum produtor ODC equivalente capturado offline.
- `apiKey`: `<Cliente>ApiKey`. `in: header` (padrão, `name` padrão `X-API-Key`) ou `in: query` (`name` padrão `api_key`).
- `oauth2` (client credentials): `tokenUrl` (só https), `scope`, `cacheMinutes` (padrão 50).
  - Gera o cliente `<Cliente>Auth` (POST do corpo form-urlencoded no token endpoint) e a server action privada `Get<Cliente>AccessToken`.
  - A plataforma guarda o token pelo Cache in Minutes da action. `<Cliente>ClientId` e `<Cliente>ClientSecret` (secreta) ficam em settings.
  - O `OnBeforeRequest` chama a action e manda `Authorization: Bearer <token>`.

Customização:
- `headers {Nome: literal}`: o `OnBeforeRequest` manda em toda requisição.
- `methods[].headers {Nome: literal | {entrada} | {entrada=exemplo}}`.
  - Literal: header fixo do método (entrada do método REST que a action sempre preenche).
  - `{entrada}`: entrada da action que vai no header.
- `methods[].optional [entrada]`: entrada de header ou de query (`?k={p}`) que pode ficar vazia (não é enviada). `=v` vira o padrão.
- `correlationHeader`: toda action ganha `CorrelationId` opcional, enviado nesse header.
  O id vem de quem chama nas duas faixas. Nenhuma tem GUID ou número aleatório nativo (provado).
  O11: a extensão Text capturada (15 actions) e o (System) não têm gerador de GUID.
  ODC: o (System) tem a action `GenerateGuid` (chave no modelo do ODC Studio), mas referenciá-la pede a assinatura do System
  capturada ao vivo (`studio_reference_snapshot`); offline não há, então fica como está.
- `settings.baseUrl: true`: `<Cliente>BaseUrl` (padrão a URL do desenho). O `OnBeforeRequest` usa a base desse ambiente.
- `timeout`: segundos de todo método. O `timeout` do método vence.
- `errors.status {"404": "<Exceção>"}`: o `OnAfterResponse` levanta essa exceção. Os handlers das actions a mantêm.
  Qualquer outro status a partir de 400 levanta `<Cliente>Error` com o status e os primeiros 300 caracteres do corpo.
- `callbacks {before|after: {steps, vars}}`: os passos do próprio modelo (os mesmos da op `logic`, validados por ela), depois da receita.
  - `before` vê `Request` e `CustomizedRequest`; `after` vê `Response` e `CustomizedResponse` (por exemplo, transformar a resposta).
  - `HTTPHeader` e `URLQueryParameter` são os do próprio cliente (cada cliente tem os seus; no ODC chamam `HTTPHeader5`...).
  - O texto ssam-flow/1 não endereça callback (a leitura de fluxo lista actions do módulo e de telas).
    Lógica escrita em ssam-flow vai numa server action da mesma entrega, antes desta op, e os `steps` a chamam.

Quem ganha os dois callbacks: cliente com `auth`, `headers`, `settings.baseUrl`, `errors.status` ou `callbacks`.
`timeout` e `correlationHeader` não precisam de callback. Op sem nada disso escreve o mesmo de antes (mesmos hashes).

Regras:
- Callback do cliente que a op não escreveu é recusado (`REST_CONSUME_CALLBACK_NOT_OWN`), nunca substituído.
- Auth que muda ou sai apaga o que a op escreveu para ela e não planeja mais: callbacks, cliente e action de token, settings, entradas de header.
  As exceções ficam (a plataforma não guarda descrição nelas, então não levam marca).
- API autenticada nunca é amostrada (a fachada não manda credencial): dê `sample`.
- Os parâmetros que a plataforma dá a cada callback ganham descrição (regra N1).

Provas offline (nenhum runtime alcançável): Verify, compile-check 0, callbacks relidos como texto ssam-flow, ponto fixo (a mesma op não muda nada),
troca de auth, uma recusa com todos os problemas, OutSystems padrões 0 nas duas faixas.
Testes: `tests/Shared/RestConsumeAuthScenarios.cs`. Exemplos: `tests/jobs/rest-consume-auth.json` e `tests/jobs-odc/rest-consume-auth.json`.

Não provado offline: os headers, a credencial e o token realmente enviados (sem runtime); o `Content-Type` do token endpoint, mandado por um
header de entrada; o comportamento do `OnAfterResponse` em cada status na plataforma publicada; settings em library ODC (testado em app).

Onde o modelo acha: `ssam_code grammar` (`generators`), o pacote de `ssam_discover` (`next.generator` e `next.deliver`) e
a capability `integration.rest-consume`. Códigos da op: `api --op rest-consume`.

### `rest-expose` (REST exposto, O11 e ODC)

```json
{"op":"rest-expose","data":{"service":{"name":"CepService"},
  "methods":[{"name":"GetCep","http":"GET","path":"/cep/{Cep}","inputs":[{"name":"Cep","type":"Text","in":"url"}],
              "outputs":[{"name":"Info","type":"CepInfo"}],"action":"IServerAction:CepInfo_Get"}]}}
```

- Cada método é uma action de logic de tipo `rest` (dono `IRestService:<S>`). Start e End são os do próprio método.
- `action` + `arguments` + `results` geram a chamada e a atribuição. Sem `arguments`, as entradas de mesmo nome casam.
- Ou `steps`, na linguagem de logic.
- Códigos: `REST_EXPOSE_URLPATH_INVALID`, `REST_EXPOSE_PATH_PARAM_WITHOUT_URL_INPUT`, `REST_EXPOSE_BODY_INPUTS`,
  `REST_EXPOSE_BODY_ON_GET`, `REST_EXPOSE_BODY_OUTPUTS`, `REST_EXPOSE_PATH_CONFLICT`, `REST_EXPOSE_ACTION_NOT_FOUND`,
  `REST_EXPOSE_ARGUMENT_UNMAPPED`, `REST_EXPOSE_TYPE_MISMATCH`, `REST_EXPOSE_AUTH_FLOW_UNSUPPORTED`.
- Autenticação Basic ou Custom precisa do fluxo OnAuthentication: lacuna declarada.

### `soap` (só O11)

```json
{"op":"soap","data":{"wsdl":"https://servidor/Calculator.asmx?WSDL","port":"CalculatorSoap","methods":["Add","Subtract"]}}
```

- No ODC a op responde `SOAP_LANE_UNSUPPORTED`.
- O kernel escolhe a porta antes de mudar qualquer coisa (comportamento provado no GitSSAM, portado, não copiado):
  - uma porta SOAP 1.1 única vence;
  - `service`, `port`, `binding` e `soapVersion` filtram; cada um tem seu `*_NOT_FOUND` com todas as escolhas;
  - todo método pedido tem de existir na porta (`SOAP_METHOD_NOT_FOUND`, listando o que existe);
  - mais de uma porta possível: `AMBIGUOUS_SOAP_PORT` com cada escolha.
- O cliente leva o nome do serviço, higienizado (letras, dígitos e `_`, até 50).
- O import é o do próprio Studio, pela bridge, numa cópia destacada do módulo (`integration_import`).
  O WSDL vai inteiro; só os métodos pedidos ficam marcados para importar. Métodos que já existem são pulados.
- `refresh` reimporta métodos listados. `remove` apaga métodos e as estruturas que nenhum método restante usa.
- O candidato é conferido antes do merge: cada método uma vez e os tipos exatos do WSDL (`SOAP_CONTRACT_TYPE_MISMATCH`).
- `ssam_job`/`o11_job` sem Studio: `INTEGRATION_IMPORT_NEEDS_STUDIO` (use `o11_deliver`).

## Documentos (WSDL e OpenAPI)

A fachada (`platforms/odc/facade/integration-documents.mjs`) fixa os documentos antes de tudo:
- URL ou caminho absoluto é lido uma vez: GET de 30 s, até 5 MB.
- Página `.wso` tenta o `?WSDL` dela.
- DTD ou ENTITY é recusado (`UNSAFE_WSDL_XML`).
- Imports de xsd/wsdl e `$ref` externos do OpenAPI vêm junto, até 32 arquivos.
- Tudo fica em `<.local da faixa>/documents/<sha256>/`, com os nomes relativos.
- A op é reescrita para `{path, sha256, source}`. Uma retomada lê os mesmos bytes.
- O kernel nunca busca nada na rede. URL sem fixar: `DOCUMENT_NOT_PINNED`.

## OpenAPI

- ODC: headless no kernel, pelo importador do plugin (`Adapters.ODC/OdcRestOpenApi.cs`).
  Cliente novo: `CreateRestClientFromSwagger` com o documento reduzido às operações escolhidas e um serviço HTTP que recusa tudo.
  O plugin pede o favicon do host da API: a resposta é 404, local, sem rede.
  Cliente existente: `GetSwaggerInfo`, `ToImport` nas escolhidas, `ISwaggerInfo.Create`; só para documento sem `$ref` externo.
- O11: o importador precisa do workspace do Studio. Roda na bridge (`integration_import:openapi`) pelo `o11_deliver`.
- `$ref` externo sem arquivo junto: `OPENAPI_NETWORK_REFUSED` (URL) ou `OPENAPI_EXTERNAL_REF_MISSING` (arquivo), com a URI.

## Apagar e consumidores

- O delete cru ganhou `breaks`.
- Com chamadores: `DELETE_HAS_CONSUMERS`, com o caminho de cada um.
- Correções: apagar ou reescrever os chamadores antes, no mesmo job; ou listar os caminhos exatos em `breaks`.
- `breaks` diferente dos consumidores reais: `CONSUMERS_CHANGED`. Nada é apagado.

## Palavras do dono

Na fachada, antes de qualquer captura ou envio:
- `remove` das três ops, delete cru de elemento de integração e qualquer `breaks` precisam das palavras do dono
  nomeando cada alvo e cada consumidor (palavra inteira). Senão: `INTEGRATION_DELETE_WORDS` ou `DELETE_BREAKS_WORDS`.
- O alvo se escreve `Tipo:Nome`. Alias ou chave: `INTEGRATION_DELETE_TARGET_FORM`.
- Mudar verbo, caminho ou nome de método exposto que já existe: as palavras nomeiam o método (`REST_EXPOSE_CONTRACT_WORDS`).
- Concessão permanente nunca cobre delete.
- `o11_job`/`ssam_job` não escrevem no Studio: só fixam documentos.

## Bridge O11

- Verbo `integration_import`, capacidades `integration_import:wsdl` e `integration_import:openapi`.
- Os argumentos são conferidos antes (`Kernel/IntegrationImport.cs`): caminhos absolutos e sha256 iguais.
- Bridge antiga: `INTEGRATION_IMPORT_NEEDS_BRIDGE` antes do snapshot. Nada é capturado nem mesclado.
  A bridge nova carrega no próximo Service Studio aberto pelo atalho "Service Studio (SSAM)".
- Ordem da entrega: snapshot, import, apply do job no candidato, validação, um merge com o snapshot como base.

## Resposta

A entrega responde `integration` (contrato I7): para cada op, `client`/`service`, `imported`, `skipped`, `updated`,
`removed`, `consumersBroken`, `warnings`, `document` e, no SOAP, `selection` (porta, binding, versão).

## Provas ao vivo pendentes

- Import SOAP de dois métodos com tipos complexos, depois incremental, depois rerun sem mudança.
- `integration_import` numa cópia destacada, com o módulo aberto intacto até o merge.
- OpenAPI no O11 pela bridge e no ODC headless, publicados.
- REST consumido (ViaCEP) e exposto (GET 200, verbo errado 405, delete e 404).
- Bridge antiga recusando antes de mudar.
