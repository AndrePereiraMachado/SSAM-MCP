# Inserção de registros pela função Edit Data do Service Studio

## Resultado

O Service Studio possui um caminho próprio para ler e alterar registros no
ambiente autenticado. Não exige acesso direto ao SQL Server nem a criação de
uma action de importação dentro do módulo da aplicação.

A existência do mecanismo foi confirmada no decompilado disponível e novamente
na DLL `OutSystems.Communication.dll` da instalação SS4, componente versão
`11.5.0.64880`. Nenhuma chamada de escrita foi executada nesta investigação.

## Fluxo identificado

1. O editor de dados reúne as alterações e separa INSERT_BULK, UPDATE_BULK e
   DELETE_BULK.
2. Usa `ServerCommunicationsProvider.InsertRecords`, `GetRecords`, `UpdateRecords`
   ou `DeleteRecords`.
3. O provider fornece a sessão `LoginInfo` e a opção HTTPS do ambiente ao serviço.
4. `OutSystems.Communication.RESTServices.EditData.AbstractEditDataAPIRestClient`
   faz requisições autenticadas por HTTP. Inserção usa POST; atualização usa PATCH.

O método de inserção recebe chave do módulo, chave da entidade, uma coleção de
`EntityRecordInfo` e tenant opcional. `EntityRecordInfo` contém `id` e
`attributes`; cada `EntityAttributeInfo` contém `key` e `value`.

A resposta usa `EditDataOperationReport`: `recordId`, `clientRecordId`, `status`
e `errorMessage`. O próprio editor correlaciona IDs temporários com os IDs
retornados em operações bem-sucedidas. Isso fornece o mecanismo necessário para
manter o mapa de IDs durante a migração. A resposta individual por registro
não deve ser interpretada como garantia de transação atômica para todo o lote.

## Condições de uso observadas

`DataSetEditDataUtils` verifica login ativo, as flags de cliente
`PGE_EditData_GA` e `DataSetEditorNewSelectionBehavior`, e a propriedade de
servidor `EditDataV4=true`.

O editor restringe entidades cliente, referências, estáticas e certas entidades
sintéticas/multitenant. A edição de atributos AutoNumber não é disponibilizada.
Os formatos declarados são `yyyy-MM-dd HH:mm:ss`, `yyyy-MM-dd` e `HH:mm:ss`.
As permissões do ambiente continuam sendo verificadas pelo servidor; a
investigação não autoriza contornar flags ou respostas de acesso negado.

## Limite da prova atual e próxima etapa

Foi comprovada a implementação nas DLLs, não uma inserção no ambiente EC2.
O próximo teste deve consultar a capacidade e ler dados usando a sessão do
Studio. Depois, a carga pode usar os retornos por registro para correlacionar
os IDs e conferir cada tabela. Não foi encontrada exposição desse mecanismo
na bridge Anvil atual durante esta busca.

Trata-se de API do cliente interno do Studio; não é a Model API de autoria OML
nem uma promessa de compatibilidade de API pública externa.

## Fontes locais

- Decompilado existente fora do produto:
  `C:/Users/andre/GitSSAM/.ssam/local/native-dll-decompile/source/`.
- `ServiceStudio.Framework`: `DataSetEditDataUtils`, aproximadamente linha 835363.
- `ServiceStudio.ServerCommunications`: implementação de InsertRecords,
  aproximadamente linha 3083.
- `ServiceStudio.Presenter`: operação INSERT_BULK, aproximadamente linha 175151.
- `OutSystems.Communication`: cliente REST, aproximadamente linha 4237; DTOs,
  aproximadamente linhas 4797–4955.
- Confirmação na DLL instalada, fora do repositório:
  `C:/Users/andre/AppData/Local/Anvil/investigations/entity-data/EditDataClient.cs`.

Este documento contém conclusões e nomes de APIs; não incorpora implementação
decompilada nem binários proprietários ao produto.

## Validação no ambiente EC2

O probe local `.local/dcips-edit-data/` usa as DLLs instaladas sem copiá-las e
as credenciais locais correspondentes ao host EC2, sem expor seus valores.
O handshake nativo foi aceito. `GetProperties` autenticado informou servidor
`11.42.0.47752` e `EditDataV4=True`.

A tentativa de `GetRecords` em `CasualtyAssistanceCenter` não concluiu:
`RemoteCertificateNameMismatch`. O certificado apresentado cobre
`*.decisionpointcorp.com`, enquanto a conexão usa o hostname EC2. É necessário
identificar o nome DNS correto desse mesmo ambiente. Não foram feitas chamadas
de inserção e a permissão específica do endpoint ainda não foi comprovada.

O probe inicializa as configurações padrão do SDK para permitir sua execução
isolada; não altera flags do Studio ou do servidor. A inspeção do certificado
não enviou credenciais nem requisição HTTP. Evidência resumida em
`.local/dcips-edit-data/capability-result.json`.


## Leitura confirmada com certificado fixado

Em 2026-09-06, apos autorizacao explicita da excecao de hostname, o probe isolado obteve HTTP 200 no OAuth e no GetRecords da entidade CasualtyAssistanceCenter do DCIPS_Migration_PoC_CS. A entidade retornou zero registros. O transporte restringe o destino ao EC2 informado, fixa o SHA256 do certificado apresentado, exige cadeia e validade temporal corretas e desabilita redirects. Nenhuma escrita foi tentada; permissao de insercao ainda nao foi provada. Evidencia local: `.local/dcips-edit-data/capability-result.json`.
