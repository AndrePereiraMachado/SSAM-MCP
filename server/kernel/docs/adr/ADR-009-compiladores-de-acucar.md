# ADR-009: Compiladores de specs sobre os verbos

Data: 2026-09-04. Estado: implementacao incremental (passo 12; extensoes nos passos 14 e 19).

## Decisao

spec e logic sao compiladores de JSON para os mesmos verbos; layout/rename/dump continuam
operacoes sobre o modelo dirigidas pela API. Nenhum tipo de elemento ganha um verbo proprio.
A compilacao e pura e deterministica; o adaptador fornece somente a resolucao dos nomes.

logic valida uso antes de devolver os ops: inputs e variaveis sem referencia real, ou outputs
sem atribuicao, sao erros. O scan ignora strings e membros qualificados, e considera filtros,
sort (expressao, nao direcao), max/start, parametros SQL, argumentos, assign, record/id,
condicoes, foreach e mensagens. Entidade e alias no proprio filtro/ordenacao nao contam como
parametro local. Uma lista de output passada a uma chamada pode ser mutada (ListAppend);
nesse caso o Verify continua sendo o juiz de escrita e de uso.

Nao existe escape no JSON/CLI. Um metodo interno acessivel somente ao assembly de testes
produz o caso negativo para medir paridade com o Verify, sem flag global mutavel. O contrato
de mensagens permanece a rede de verificacao para casos que o scan nao consiga distinguir.

Specs frias incompletas passam a falhar na compilacao. Nao se retiram parametros de APIs de
negocio nem se inserem usos ficticios so para satisfazer o scan. O dono deve definir/implementar
a semantica faltante. Jobs por verbos continuam sujeitos ao Verify e a expectedMessages.

## Contrato SQL (passo 13)

No get com sql:true, os @parametros do statement (fora de comentarios e literais SQL)
coincidem com params, sem distinguir maiusculas. @@ segue a regex do Studio e nao e
ignorado. where/sort/start nao sao aceitos nesse modo; max continua MaxRecords.
Statement/params tambem nao podem aparecer num get sem sql:true. O scan e exclusivo da
spec; verbos SQL crus continuam com o Detail do Verify como juiz. Assign de uma expressao
para ela propria (ignorando espacos nas pontas e caixa) falha por nao fazer nada.

Erros de set/link enumeram as formas aceitas pela Model API e sugerem nomes somente desse
conjunto, sem misturar funcoes built-in. Um conector explicitamente desconhecido nao cai
silenciosamente no CreateConnector/Targets padrao.

## Ordem e substituicao de actions (passo 14)

As chamadas entre actions da mesma spec formam um grafo ordenado de forma estavel; ciclos
sao recusados com a cadeia. O resolvedor reconhece as declaracoes antes de aplicar os ops,
e chamadas client usam o no ExecuteClient apropriado. O marcador replace nao altera os
ops gerados pela funcao pura.

No adaptador, nome de action propria existente sem replace e erro (tambem em create).
replace:true exige action existente do mesmo kind e uma definicao completa. Capturam-se
as chaves dos consumidores fora dos corpos substituidos; apagam-se as actions e aplicam-se
os mesmos ops. Ao fim, todas essas chaves devem continuar referindo a nova action, ou a
transacao falha. Em substituicoes multiplas, os consumidores internos aos corpos que serao
reescritos nao precisam conservar chave. Handles de objetos apagados sao invalidados.
Nao ha reconciliacao cirurgica de nodes/parametros nem heranca implicita de flags antigas.

## Telas por arquetipo (passo 19)

screen e o terceiro compilador puro: JSON fechado -> os mesmos create/set/link/delete/layout. O adaptador fornece
somente referencias e contratos publicos do modulo (parametros, atributos, eventos e widgets de placeholders).
Nao ha leitura de catalogo de CSS/JS ou caminho de biblioteca. Contratos NRWidgets de referencia (IListSignature,
IImageSignature) descrevem os defaults; o compilador conserva a List do bloco e retira apenas os widgets de exemplo.
Telas e inputs sao declarados em primeira passada, conteudo/navegacao na segunda. Sources de aggregate e de data action
usam seus tipos reais para formar o caminho de Current. Os arquetipos sao cards/table/detail/form/dashboard em
Reactive/Mobile; Traditional e substituicao automatica de uma tela existente ficam fora desta versao.

A compilacao recusa campos/chaves inexistentes, inputs sem uso e contratos obrigatorios que nao consegue preencher.
Paginacao usa StartIndex/MaxRecords/Count e atualiza o mesmo datasource; action paginada deve receber os indices e
expor o total completo. Formulario liga labels, propaga Mandatory e guarda a chamada de gravacao com Form.Valid.
Nao sao gerados handlers vazios para eventos opcionais, nem usos ficticios para eliminar warnings.
