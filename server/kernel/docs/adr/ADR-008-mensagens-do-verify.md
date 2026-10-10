# ADR-008: Mensagens do Verify e contratos de expectativas

Data: 2026-09-04. Estado: implementado; passo 10 do plano de gaps.

## Decisao

A identidade e a do proprio Studio: ID + ObjectIdentifier.GetObjectKey() + PropertyNames
+ MessageParameters. O adaptador projeta esses campos numa chave JSON inequivoca e em
MessageInfo (ID, tipo, chave, caminho, detalhe). Texto traduzido e caminho nao fazem parte
da identidade. O delta e um conjunto, sem compensar mensagens pelo saldo de contagens.
Duplicatas da mesma identidade nao se tornam mensagens novas.

O runner captura uma lista apos Load e outra apos Apply. Describe e ValidationDetails
usam a lista ja capturada. Erros nunca sao cortados; mensagens novas aparecem antes das
preexistentes dentro de cada severidade. O DTO devolve new, fixed, preexisting, unexpected,
missingExpected e ambiguous. Esse mesmo delta puro sera usado no passo 11 pela bridge.

expectedMessages e uma lista fechada de {id, element, why}. O ID tem de existir no
catalogo; element e um sufixo exato de PathOf com dois ou mais niveis; why nao pode ser
vazio. Cada entrada corresponde a uma mensagem NOVA. Entradas duplicadas, ambiguas e
obsoletas falham; avisos preexistentes nao exigem declaracao. Erros declarados so permitem
aceite quando expectValid=false, para cenarios negativos explicitos. Nada disso permite
merge de um modulo invalido.

O antigo teto numerico e recusado antes de carregar o modelo do job. accepted exige
expectValid (true por omissao) e todas as expectativas satisfeitas. O apply salva o OML
para diagnostico mesmo quando o contrato falha; run_job retorna 1; proof_merge e
proof_cycles verificam accepted e isValid antes de tocar no Studio por merge.
Dependencias job: tambem precisam satisfazer seus proprios contratos.

## Compostos: decisao do dono nesta sessao

Cada parte guarda suas expectativas para seu teste isolado. O composto usa exclusivamente
sua propria lista; nao herda nem proibe as listas das partes. Essa decisao substitui a
recusa prevista no plano original: tickets-01 espera seis configuracoes ainda sem uso,
tickets-02 espera sete mensagens novas de helpers; no app final resta apenas o parametro
BusinessHoursOnly. Herdar essas listas exigiria warnings que as etapas seguintes corrigem.

## Superficie

Nao entram verbos messages/diff dentro de ApplyOne nesta etapa: nao ha prova de que um
Verify durante a transacao seja equivalente ao do fim. O resultado do runner e a superficie
de leitura; a bridge usara o mesmo DTO/delta na etapa seguinte. O gerador de tickets guarda
listas revisadas e deterministicas, sem modo --record. A galeria gera declaracoes dos
avisos observados nos blocos que compoem o job gerado, com motivo e sem incluir os avisos
do fixture.

## Delta do merge (passo 11)

A bridge captura as mensagens do modulo local imediatamente antes e depois de CompareAndMerge,
com leituras na UI thread. O retorno do merge inclui new/fixed/preexisting completos, sem teto,
newErrors e localIsValidAfter. Preview e auto sem diferencas devolvem delta vazio e as mensagens
atuais como preexistentes. O modo dialog continua assincrono (dispatched); seu resultado nao
faz parte da entrega automatica.

O script mostra o detalhe apenas das novas e conserva o total como resumo. Erros novos retornam
exit 8 e impedem publish; o merge fica para revisao, sem undo automatico. Conflitos/cancelamentos
retornam falha; no differences e um no-op valido. Sem contrato de delta (bridge antiga), o script
recusa continuar ate atualizar a bridge. get_errors nao recebe base/since nem arquivos de estado.
