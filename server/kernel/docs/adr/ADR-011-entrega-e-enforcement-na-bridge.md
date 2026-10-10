# ADR-011: Entrega unica e proveniencia na bridge

Data: 2026-09-04. Estado: aceito e provado no SS5 (passo 18).

## Decisao

A bridge regista snapshots da sessao por ID, chave de modulo, hash SHA256 dos bytes e mensagens do Verify.
O caminho pode mudar; os bytes e a chave nao. Base ausente, alterada ou pertencente a outro modulo e recusada
antes do MatchTree. Foreign com chave distinta do modulo local tambem e recusado. A prova headless mostrou
que o MatchTree sozinho aceitava essa mistura (196 objetos, valido, sem conflitos), logo o bloqueio e necessario.
get_errors since usa o ID para comparar mensagens com o mesmo modulo; IDs nao atravessam sessoes ou modulos.
allow_foreign_base e a excecao explicita para provas de merge inverso, nao e exposta por deliver, e nao dispensa
a identidade do foreign. Loads de diagnostico sao libertados mesmo quando a validacao da identidade falha.

Delivery vive fora do Kernel; BridgeClient e o adaptador local TCP JSON-lines. A sequencia e open, active,
snapshot, JobRunner(snapshot), merge auto uma vez, get_errors since e find. O CLI e o worker usam a mesma
funcao. Nao ha base alternativa, preview anterior, publicacao ou undo automatico. Snapshot sem registro (bridge
antiga), mudanca do modulo ativo ou contrato invalido interrompem antes do merge. Erros/avisos inesperados
pos-merge e checks ausentes devolvem delivered:false, preservando o resultado para revisao e Ctrl+Z.

A entrega sem diferencas e um sucesso explicito (unchanged:true, merged:false). Nao se inventa um merge para
satisfazer um booleano. O resultado e os artefatos ficam numa pasta unica por tentativa, incluindo falhas.
proof_merge.py apenas chama deliver; login, leitura de flow e publish explicito continuam conveniencias de
prova, sem duplicar a orquestracao principal. Publish nunca e parametro do comando deliver.

## Provas

14 testes offline: proveniencia por bytes, sessao/modulo, identidade do foreign e 11 cenarios completos com
bridge TCP simulada (sucesso, no-op, dialogo, troca de modulo, bridge antiga, apply invalido, conflitos, erro,
aviso inesperado e check ausente). Suite 199/199; Python 11/11.
No SS5, tickets-all entrou no Headless_CS em 27.596 ms, com uma unica linha merge_from_oml no log, zero erros
novos e o unico aviso declarado BusinessHoursOnly. Ticket/Ticket_Create/TicketStatus encontrados, sem publicar.
Snapshot registado do Davitest_UI recusado no Headless_CS; foreign de outra chave recusado antes do MatchTree.
No-op: 3.265 ms, zero novas, um aviso preexistente, delivered:true/unchanged:true.
