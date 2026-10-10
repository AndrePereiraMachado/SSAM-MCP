# ADR-014: Prova de dados e fonte da entrega

Data: 2026-09-05

## Problema

A criacao de seis entidades no Incidents demorou 631 s, apesar de os comandos somarem 36,8 s. Sete tentativas
repetiram erros de ordem, IDs estaticos e valores de enum. O job foi alterado depois do ultimo merge, e a resposta
final declarou texto longo que nao estava no artefato entregue (os dois campos tinham Length 50).

## Decisao

- Expandir uma spec de dados em duas fases: tipos/identificadores e depois campos/records. Isso permite FKs
  adiantadas e circulares dentro da mesma spec, mantendo um job e um merge.
- Validar declaracoes, enum conhecidos, Length e IDs estaticos explicitos antes do runtime. Catalogo lido de arquivo,
  sem carregar um modulo. Tipos externos ainda nao conhecidos sao informados em unresolvedTypes e conferidos na
  base antes de mutar quando nao ha importacao de produtores pendente. Nao fingir que uma checagem de sintaxe prova
  elementos de uma base viva ou de um produtor que ainda sera importado.
- Expor enums na consulta api e listar os valores aceitos nos erros de conversao. Long Text e uma convencao da spec:
  Text com Length 2000000 quando nao especificado; server entity usa Optimized se nao houver outra escolha explicita.
  O esquema aceita indices e configuracao dos atributos padrao das static entities.
- Registrar as propriedades de dados escritas pelo job e conferir o modelo antes de salvar. Depois do merge,
  tirar um novo snapshot e comparar essas mesmas propriedades por chaves estaveis: existencia, nomes, tipos,
  comprimentos, obrigatoriedade, valores estaticos e indices. Falhas sao dataProof.differences e impedem sucesso.
- Guardar hashes do job, partes, produtores job: e bindings explicitos, alem dos OMLs base, foreign e entregue.
  Recusar mudancas de fonte durante a operacao. check-delivery verifica o recibo bem-sucedido e seus hashes antes
  da confirmacao final; ele nao reinterpreta o pedido nem observa edicoes manuais posteriores no Studio.

## Limites e compatibilidade

Nao ha rollback automatico de um merge ja aplicado; um desvio mantem delivered=false e o artefato para revisao.
A prova cobre as declaracoes do job, nao garante que uma LLM traduziu toda a linguagem natural corretamente. Por isso
ha uma regressao independente com os campos do pedido e uma avaliacao de LLM com contexto novo. O ganho esperado e
no percurso completo; nao usar tempo do motor como substituto do tempo total de uma sessao.

O suporte nativo a EntityIndex ja existia no workspace e entra como dependencia da prova de indices. Nenhum novo
verbo de mutacao foi adicionado. check-delivery e uma consulta local ao comprovante.

## Validacao

DataContractTests cobre referencia circular, erros independentes, texto longo, valores estaticos, save/reload,
modificacao de comprimento, fonte alterada, artefato alterado e falha do conteudo apos merge simulado.
A regressao data-contract-incidents e uma spec com quatro entidades, dois catalogos, nove records e seis indices.
A suite na copia isolada passou com 261 testes; os tres jobs antigos de Incidents da sessao auditada ficaram intactos
fora dessa copia. Resultados de aceitação e prova viva sao registrados separadamente em docs/proofs.

A avaliacao final com contexto novo concluiu definicao e conferencia local em 96,982 s. O runner passou a salvar
.result.json e dataSummary para remover a captura por segunda aplicacao. A prova viva aguarda autorizacao especifica
para o laboratorio, apos bloqueio da revisao automatica; nao foi executada nem declarada concluida.
