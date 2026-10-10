# Integrações REST e SOAP no SSAM Hybrid

Lane restsoap do pacote `docs/INTEGRACOES-GITSSAM.md`.
Três ops novas de job fazem a integração numa chamada só: `rest`, `rest-expose` e `soap`.
Não há ferramenta MCP nova. As ops passam pelas entregas de sempre: `o11_deliver`, `studio_deliver`, `o11_job` e `ssam_job`.
O contrato exato de cada op sai de `api --op rest|rest-expose|soap` e do `ssam_discover`.

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
