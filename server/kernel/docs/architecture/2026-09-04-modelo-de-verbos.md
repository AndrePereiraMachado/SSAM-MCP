# Modelo de verbos (2026-09-04)

A API do produto e pequena e fixa. A inteligencia esta no catalogo (gerado do Model API por build do Studio)
e na camada de convencoes (regras com teste). Nenhum verbo cresce com o numero de tipos de elemento.

## Arvore do modelo: escrita (6)

| Verbo | Assinatura | Nota |
|---|---|---|
| Create | (pai, tipo, nome, args?) | pai/tipo validados pelo catalogo (Create* e genericos `CreateNode<T>`/`CreateWidget<T>`); `args` para os Create tipados (`CreateSource(entidade)`, `CreateOutput(structure)`, `CreateIntegration<T>`) |
| Set | (objeto, propriedade, valor) | conversao pelo catalogo: texto vira expressao pelo `SetX` certo; tipo basico/identifier/record/list por mini-linguagem de tipos ("Text", "VacationHome Identifier", "Booking Record List"); referencia resolve por nome; propriedade inexistente = erro (nunca no-op) |
| Link | (de, conector, para) | Target/TrueTarget/FalseTarget/CycleTarget/OtherwiseTarget/Condition; validado pelo catalogo |
| Move | (objeto, antes-de \| depois-de \| inicio \| fim \| posicao) | ISequence.Move*; posicao de no no canvas |
| Duplicate | (objeto[], destino?) | `IObject.Duplicate`: copia subarvore preservando referencias internas; base de "extrair" |
| Delete | (objeto) | recusa se houver usages, salvo `force` |

Pergunta aberta que muda o refactor: reparentar no entre actions existe na API? Se nao, extrair = Duplicate + Delete.

## Arvore do modelo: leitura (5)

| Verbo | Devolve |
|---|---|
| Get | objeto com propriedades (do catalogo), filhos por colecao, chave |
| Find | por nome, tipo, propriedade, escopo; com paginacao |
| Messages | TrueChange com caminho de nomes, id da mensagem, severidade, explicacao do catalogo de mensagens |
| Usages | quem referencia o objeto (referers do modelo), inclusive expressoes |
| Diff | MatchTree entre dois modulos/subarvores, como JSON |

## Modulo (6)

Reference (adicionar, atualizar, remover; por produtor e elemento), Verify, Load, Save, Snapshot, Merge
(preview \| auto \| dialog). Vivem no worker. Um job = sequencia de verbos numa copia + Merge = transacao:
tudo entra ou nada entra, e o Ctrl+Z desfaz o conjunto.

## Adaptador (so o que so o Studio faz)

Rename com religacao (se o Set de Name nao religar sozinho), Replace em expressoes, conversoes, Publish,
Preview. Cada um: verbo no bridge, por build do Studio, com teste.

## Camada de convencoes (ganchos por tipo, com teste)

Id Long Integer AutoNumber e `IdentifierAttribute`; FK = `entity.IdentifierType`; user provider Users em modulo
em branco; static entity com Id/Label/Order/Is_Active; structure de saida publica se a action e publica;
UpdateBehavior Optimized acima de 8 atributos ou com binario; layout um-no-por-celula (1/20 px, Start 3200,800,
passo 1600); Label em If/Assign/ForEach (Name nao persiste no O11). Lista cresce so quando um Verify reclama.

## O que fica de fora de proposito

Nenhum verbo por tipo de elemento. Nenhum verbo que abra dialogo. Nenhum verbo que dependa de UI thread.

Contratos de listas e referencias (passo 15): o diagnostico `Hint Current` consulta o tipo publico do resultado
(data action, parametro ou aggregate, incluindo group by) e lista seus atributos; nao infere wrappers pelo nome.
O `reference` privado ensina a tornar o elemento publico e regenerar o produtor antes de referencia-lo.

Entrega (ADR-011): `deliver` e orquestracao fora do Kernel, com open/snapshot registado/apply/um merge/get_errors since/find.
A bridge verifica proveniencia da base por bytes e chave local; o worker nunca escolhe uma base de entrega por conta propria.
