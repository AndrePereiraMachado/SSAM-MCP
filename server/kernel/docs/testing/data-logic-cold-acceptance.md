# Aceitação fria: autoria de Data e Logic em C# para OutSystems nativo

**Estado: desenho de testes. Nenhum cenário deste documento foi executado.**

Esta bateria avalia dois tradutores novos: C# idiomático para entidades, static entities e structures; e C# idiomático para actions nativas OutSystems. Foi desenhada somente a partir de `MANIFESTO.md` e `docs/CONTRATO-MODULO.md`, sem consultar implementação, geradores, receitas, recibos ou conversas anteriores. Os casos positivos são requisitos de aceitação, não uma declaração de capacidades já existentes. Não pressupõem sintaxe de atributos, bibliotecas ou APIs C# ainda não documentadas.

## 1. Como entregar os pedidos a um agente frio

O coordenador entrega a um agente sem histórico apenas o pedido de um caso, sua massa, seus resultados esperados, o módulo de laboratório escolhido, o ambiente/faixa e a documentação pública de uso. Cada caso é autossuficiente; os casos de evolução incluem sua própria instalação inicial. Não fornecer soluções C#, jobs normalizados, nomes de classes internas, grafos prontos ou explicações do autor do tradutor. Não usar módulos ou dados de clientes.

Instrução comum a todos os pedidos:

> Implemente o pedido em C# idiomático usando as entradas públicas de autoria de Data e Logic do SSAM Hybrid. Gere elementos nativos OutSystems, entregue ao Service Studio por merge e apresente as evidências disponíveis. Preserve o significado do pedido. Se algum detalhe não for representável, informe o trecho de fonte e a capacidade ausente antes de alterar a semântica. Não escreva formatos intermediários ou grafos manualmente, não conserte o tradutor e não publique. As chamadas no servidor serão executadas posteriormente em laboratório, após publicação autorizada por seu responsável.

O agente pode consultar o contrato/esquema público vigente e corrigir seu próprio C#. Não pode ler `src/`, scripts geradores, fixtures de solução, recibos de execuções anteriores ou conversas de implementação. Uma particularidade declarativa documentada para mapear persistência, acesso ou metadados é aceitável; precisar descrever Start/End, nós, conectores, identidades, chaves internas, snapshots ou recuperação manual é reprovação de autonomia.

O avaliador usa um módulo Service para dados e lógica de servidor, salvo indicação explícita de outro contexto. Ao comparar identificadores gerados, use referências simbólicas da massa (`A`, `B`), não números de AutoNumber esperados. Datas civis usam `AAAA-MM-DD`; instantes usam UTC; cálculos usam decimal, sem depender da cultura da máquina. Comparações de listas são ordenadas quando houver ordem declarada; nas demais, compare conjuntos com multiplicidade.

## 2. Evidências e veredictos

Registrar separadamente, por caso:

1. **Autoria e diagnóstico:** pedido original, C# submetido, diagnósticos com arquivo/linha ou trecho identificável e correções feitas. Nenhuma semântica pode ser descartada para obter sucesso.
2. **Modelo offline:** elementos nativos, assinaturas, campos, relacionamentos e fluxo correspondem ao pedido; Verify sem erros; avisos novos justificados especificamente; salvar e recarregar preserva o resultado. C# armazenado como texto, uma DLL executada dinamicamente, JavaScript de servidor ou um único invólucro que interprete todo o programa não satisfazem a tradução nativa.
3. **Destino:** merge no módulo correto, consumidores preservados, ausência de erros novos, elementos visíveis/editáveis e diagrama de actions legível, com conexões inequívocas. Verificar a edição reversível em uma cópia descartável. Não aceitar uma prévia como prova de entrega.
4. **Execução no laboratório:** entradas, identidade efetiva, saída, exceção e estado persistido antes/depois. A publicação pertence ao responsável do laboratório; só executar esta fase depois da autorização correspondente. Conferência estrutural ou predicados sintéticos não substituem chamadas reais para regras de negócio, segurança e transações.

O avaliador confere o modelo persistido/recarregado e o destino por uma leitura independente da lista de operações emitidas. Pode inspecionar os elementos nativos no Studio e as provas públicas, sem abrir a implementação do compilador. Não aceitar somente uma contagem de elementos ou a afirmação do agente.

Veredictos: **aprovado** exige todas as evidências pertinentes; **estrutura aprovada, execução pendente** é parcial; **limite diagnosticado** aprova somente um caso negativo cuja recusa era esperada; **reprovado** inclui comportamento errado, omissão, prova incoerente ou dependência de orientação interna. Uma recusa honesta de um caso positivo registra capacidade ausente e mantém aquele contrato positivo não atendido. “Não executado” nunca vira aprovação.

## 3. Contratos positivos de Data

### D01 — Equipamentos itinerantes: relações adiantadas e ciclo

**Pedido independente.** Modele uma cooperativa que empresta equipamentos. `Unidade` possui código obrigatório único de até 12 caracteres, nome de até 100 e `ResponsavelId` opcional para `Pessoa`. `Pessoa` possui nome obrigatório de até 120 e `UnidadeId` obrigatório. `Equipamento` possui série obrigatória única de até 30, unidade obrigatória e custodiante opcional para `Pessoa`. `Emprestimo` liga equipamento e pessoa; contém início obrigatório e fim opcional. Declare `Unidade` antes de `Pessoa` na fonte. Todas as entidades precisam de identidade persistente própria.

**Massa e oráculo.** Criar unidade `LAB-N`, pessoa Ana nessa unidade, atribuir Ana como responsável, equipamento `EQ-001` custodiado por Ana e empréstimo aberto. Recarregar as quatro entidades mantém as referências corretas; concluir o empréstimo registra o fim sem alterar o início. Unidade sem responsável e equipamento sem custodiante são válidos. Pessoa sem unidade deve ser recusada. Referência a pessoa inexistente deve falhar, sem substituição silenciosa. A ordem da fonte e o ciclo opcional não exigem entregas manuais intermediárias.

### D02 — Herbário: enums com valores explícitos e identidade estável

**Pedido independente.** Modele `Amostra` com enum persistido `EtapaAmostra`: `Recebida = 10`, `Catalogada = 40`, `Quarentena = 90`; o padrão é `Recebida`. Use esses membros em parâmetros, retornos e condições de uma action que informa se a amostra pode ser consultada (`Catalogada` somente).

**Massa e oráculo.** Persistir três amostras, uma por etapa. As static entities nativas e suas referências preservam 10, 40 e 90, sem converter para posições 0, 1 e 2. A action retorna falso, verdadeiro, falso. Reordenar a declaração do enum e entregar novamente mantém identidades e registros existentes. Acrescentar `Arquivada = 150` não reescreve os valores antigos. Renomeações e aliases de enum são avaliados separadamente em L02; não inferir migração pelo nome.

### D03 — Laboratório de solo: static entity enriquecida

**Pedido independente.** Cadastre classes fixas de análise com identidade numérica explícita, rótulo para exibição, prazo em dias, taxa decimal e indicador de atividade. Valores: `Rotina` (5, “Rotina”, 3, 12.50, verdadeiro), `Especial` (20, “Análise especial”, 8, 47.25, verdadeiro), `Legada` (80, “Histórica”, 12, 0.00, falso). Uma entidade `PedidoAnalise` referencia a classe. A lista de classes disponíveis usa apenas as ativas, ordenadas por prazo e identidade.

**Massa e oráculo.** Conferir todos os atributos e valores após reload e merge; a consulta devolve 5 e 20. Alterar o prazo de `Especial` para 6 preserva identidade 20 e pedidos que a referenciam. A classe 80 permanece para leitura histórica. Não aceitar uma tabela comum sem registros fixos ou descrições/valores mantidos somente em comentários.

### D04 — Leitura de sensores: nulidade e defaults distinguíveis

**Pedido independente.** Uma `Leitura` tem sequência obrigatória inteira, medição decimal opcional, observação textual opcional, instante de revisão opcional, referência opcional a `Calibracao`, unidade de medida obrigatória com padrão “C” e indicador obrigatório `Validada` com padrão falso. Um DTO `LeituraResumo` deve distinguir ausência de medição de medição zero. A origem usa os tipos anuláveis apropriados de C#.

**Massa e oráculo.** A: medição ausente, observação ausente, revisão ausente, calibração ausente; B: medição 0, observação vazia; C: medição -12.75, observação “ajuste”. Todos recebem “C” e falso quando omitidos. Retornar e persistir A não pode convertê-la indistintamente em B. Default aplica-se à criação sem valor, não sobrescreve valor explícito em atualização. Se o destino não expressar essa distinção, exigir diagnóstico específico e registrar D04 não atendido; representação auxiliar só mediante alteração explícita do contrato pelo dono, nunca decidida silenciosamente pelo agente.

### D05 — Acervo audiovisual: tamanhos, precisão e índices

**Pedido independente.** `Midia` tem organização obrigatória, código obrigatório de até 24 caracteres, título obrigatório de até 180, descrição de até 200000 caracteres e custo decimal. Índice único composto `(OrganizacaoId, Codigo)` e índice não único `(OrganizacaoId, Titulo)` nessa ordem. DTO de relatório contém o código textual “9007199254740993”, sem conversão numérica. Nenhum identificador textual deve perder zeros iniciais.

**Massa e oráculo.** Duas organizações podem usar `0007`; duplicata na mesma organização é recusada. Persistir títulos de 180 caracteres e descrição de 50000 caracteres, ler de volta sem truncar. Título de 181 e código de 25 devem ser recusados antes de perda de conteúdo. Custo 12345.67 conserva o valor decimal; DTO conserva exatamente o identificador grande. Prova do modelo mostra os comprimentos e as duas colunas dos índices na ordem exigida; não basta o nome do índice.

### D06 — Embalagem retornável: records, listas e exposição de tipos

**Pedido independente.** Defina structures `EnderecoEntrega` (cidade e CEP como texto), `ItemRetornavel` (código, quantidade inteira) e `OrdemRetorno` (endereço, lista de itens, observação). Exponha uma action autenticada que recebe e devolve `OrdemRetorno`, acrescentando ao texto da observação “ / conferido”. Não crie entidades persistentes para esses DTOs. Inclua campos e tipos cuja declaração aparece depois do primeiro uso.

**Massa e oráculo.** Endereço `Recife`, `05001000`; itens `[CX-A:2, PAL-B:1, CX-A:2]`; observação “coleta”. Saída conserva endereço, ordem e duplicata dos itens e contém “coleta / conferido”. Lista vazia é aceita e continua vazia. Tipos são estruturas/listas nativas nas assinaturas e utilizáveis por consumidor; não JSON em Text. Verificar a diferença entre cópia e alias mutável com G02.

### D07 — Oficina de bicicletas: evolução aditiva com dados reais

**Pedido independente em duas entregas.** Primeiro criar `Bicicleta` com número de quadro obrigatório único, fabricante e ano; semear `Q1/Atlas/2020` e `Q2/Vento/2023`, guardando identidades. Criar consumidor que lê Q1. Depois acrescentar nota opcional até 1000 caracteres, indicador obrigatório `Inspecionada` com default falso e índice não único por fabricante/ano. Aumentar o limite de fabricante de 40 para 100. Conservar nomes, referências e contratos existentes.

**Oráculo.** Após a segunda publicação autorizada no laboratório, ambos os registros, identidades, valores antigos e consumidor permanecem; indicador falso fica definido para registros existentes segundo migração declarada, nota ausente conserva ausência conforme o contrato aprovado. Novo fabricante de 70 caracteres funciona. Repetir exatamente a segunda fonte não duplica elementos, índices ou dados. Fazer também uma edição humana não conflitante na descrição de outro elemento antes do merge e confirmar sua preservação.

### D08 — Arquivo fotográfico: evolução que exige escolha explícita

**Pedido independente.** Criar `Fotografo` com nome até 80 e email opcional; semear nome de 65 caracteres, email ausente e dois emails iguais. Preparar três alterações separadas: reduzir nome para 30; tornar email obrigatório; impor unicidade de email. Não autorizar truncamento, descarte de registros ou preenchimento inventado.

**Oráculo.** Cada mudança precisa apontar a incompatibilidade e solicitar uma política de migração concreta antes de alterar dados. Nenhuma pode ser apresentada como evolução segura só porque o modelo é válido. A recusa ou bloqueio explícito é o resultado positivo deste caso de preservação. Após receber uma política de negócio em nova tarefa, outro teste pode avaliar a migração; este pedido não dá autorização para inventá-la. O laboratório verifica que os dados originais continuam intactos.

## 4. Contratos positivos de Logic

### G01 — Cotação de sementes: parâmetros, decimais, precedência e arredondamento

**Pedido independente.** Uma action autenticada `CotarSementes` recebe quantidade inteira positiva, preço decimal não negativo, desconto decimal entre 0 e 1 e frete decimal não negativo. Retorna structure com bruto, desconto monetário, subtotal e total. Calcule bruto `quantidade * preco`; desconto monetário com duas casas, midpoint afastado de zero; subtotal `bruto - descontoMonetario`; total `subtotal + frete`. Inputs inválidos produzem exceção de negócio antes de qualquer persistência. Use variáveis locais e retorno tipado em C#.

**Massa e oráculo.** `(3, 19.90, 0.15, 7.50)` → `(59.70, 8.96, 50.74, 58.24)`. `(1, 0.05, 0.10, 0)` → desconto 0.01 e total 0.04. Quantidade 0/-1, desconto -0.01/1.01 e frete negativo são recusados. Não substituir decimal por ponto flutuante nem trocar a regra de arredondamento pelo default do destino.

### G02 — Expedição: listas, cópias, parâmetros e escopos

**Pedido independente.** Receba lista de records `{Codigo, Quantidade}`. Faça uma cópia independente, incremente a quantidade do primeiro record da cópia e acrescente `{Codigo:"EXTRA", Quantidade:1}`. Retorne original e cópia. Depois calcule totais por dois blocos irmãos, cada um com sua variável local `subtotal`; acumule em `total`. O programa não deve confundir os dois símbolos com o mesmo nome. Não persistir nada.

**Massa e oráculo.** Entrada `[A:2, B:3]`: original `[A:2, B:3]`, cópia `[A:3, B:3, EXTRA:1]`; blocos somam original e cópia, total 12. Entrada vazia: original vazia, cópia `[EXTRA:1]`, total 1; nenhum acesso ao primeiro item. Verificar que alteração de record da cópia não modifica o record original, não apenas que os contêineres são distintos. A fonte deve escolher explicitamente a semântica de cópia pretendida em C#.

### G03 — Bilheteria científica: composição, referências futuras e chamadas

**Pedido independente.** `CotarGrupo` chama helper privado `CalcularIngresso`, declarado depois na fonte, e action pública autenticada `CalcularTaxa`. Helper recebe idade, retorna 0 para menor de 6, 10 para 6–17 e 20 para 18 ou mais; idade negativa gera exceção. Taxa recebe subtotal e devolve 5 se subtotal for positivo, senão 0. Cotação devolve subtotal, taxa e total; é chamada por um consumidor separado já existente. Helpers com o mesmo nome em outro módulo não podem ser escolhidos acidentalmente.

**Massa e oráculo.** Idades `[5,6,17,18]` → subtotal 40, taxa 5, total 45; `[2,4]` → 0/0/0. Entrada negativa propaga a exceção correta. Verificar destinos e argumentos nativos, visibilidade do helper e execução do consumidor. Reentregar com taxa 7 preserva assinatura e consumidor e produz total 47. O ambiente fornece a referência pública do produtor e seu nome exato; adquirir dependências ausentes é avaliado em L05.

### G04 — Normalização de etiquetas: texto, Unicode e cultura

**Pedido independente.** `FormatarEtiqueta` recebe código e descrição. Remova espaços somente das extremidades, troque hífens ASCII do código por `/`, preserve maiúsculas, acentos e espaços internos. Retorne código normalizado, descrição, se contém literalmente “frágil” com comparação ordinal sensível a maiúsculas, e a descrição cortada nos primeiros 12 caracteres quando maior. Recuse código vazio após limpeza. Não alterar cultura global.

**Massa e oráculo.** Código `  ab-007  ` e descrição `  Peça frágil A  ` → `ab/007`, `Peça frágil A`, verdadeiro, `Peça frágil A`. Descrição `FRÁGIL` → indicador falso. Descrição `abcdefghijklmn` → corte `abcdefghijkl`. Repetir sob culturas pt-BR e en-US conserva a saída. Códigos só de espaços são recusados. Suporte a grafemas, emoji e normalização Unicode não está presumido: ver L03.

### G05 — Conservação de alimentos: datas, limites e relógio injetado

**Pedido independente.** `CalcularValidade` recebe data civil de fabricação, prazo inteiro não negativo em dias e data civil de referência fornecida pelo chamador de teste; retorna vencimento e vencido quando referência for estritamente posterior ao vencimento. Outra action adiciona 90 minutos a um instante UTC recebido. Não usar relógio real para esses cálculos.

**Massa e oráculo.** Fabricação `2028-02-28`, prazo 2 → `2028-03-01`; referência `2028-03-01` não vencida, `2028-03-02` vencida. `2027-12-31` + 1 → `2028-01-01`. `2028-02-29T23:30:00Z` + 90 min → `2028-03-01T01:00:00Z`. Prazo negativo é recusado. A representação de data civil não ganha hora/fuso implicitamente. Horário civil com transição de fuso pertence a L03.

### G06 — Triagem de caixas: condições e curto-circuito

**Pedido independente.** Classifique uma remessa. Se quantidade for 0, retorne “Vazia”; se quantidade negativa, gere exceção. Somente para quantidade positiva calcule média `pesoTotal / quantidade`; média maior que 10 e conteúdo delicado → “Especial”; média maior que 10 → “Pesada”; demais → “Comum”. Escreva também predicado C# com `quantidade != 0 && pesoTotal / quantidade > 10` e alternativa com `||` que evite acessar item inexistente. O ramo não escolhido não deve ser executado.

**Massa e oráculo.** `(0,0,false)` → Vazia sem divisão por zero; `(2,30,true)` → Especial; `(2,30,false)` → Pesada; `(2,20,true)` → Comum; quantidade -1 → exceção. Lista vazia no predicado alternativo deve ser tratada sem indexação. Usar rastreador privado de avaliação, quando necessário, para provar que a segunda expressão não foi executada; o rastreador não pode permanecer como efeito de negócio inesperado.

### G07 — Separação de encomendas: foreach, for, while, break e continue

**Pedido independente.** `SelecionarVolumes` recebe lista de pesos inteiros e capacidade. Percorra em ordem; ignore pesos 0 com `continue`; peso negativo gera exceção; antes de adicionar um peso que excederia capacidade, encerre com `break`. Retorne pesos selecionados, soma e quantidade de itens examinados. Outra rotina distribui 7 etiquetas em grupos de no máximo 3 usando contador e repetição, retornando `[3,3,1]`. Use `foreach`, `for` e `while` em rotinas com resultado observável, sem traduzir à mão para um grafo.

**Massa e oráculo.** `[0,3,4,5,1]`, capacidade 8 → selecionados `[3,4]`, soma 7, examinados 4. Lista vazia → vazia/0/0. Capacidade 0 e lista `[1]` → vazia/0/1. Entrada `[2,-1,3]` falha; `[2,9,-1]` com capacidade 5 encerra antes do negativo e retorna `[2]`. Incluir loop aninhado que enumera pares de linhas 1–2 e colunas 1–3: exatamente 6 pares ordenados. Não aceitar iteração extra ou confusão entre índices de loops.

### G08 — Roteamento de manutenção: switch e término de ramos

**Pedido independente.** Enum `TipoServico` com `Inspecao=10`, `Reparo=30`, `Urgente=70`. `DeterminarPrazo` usa switch: inspeção retorna 5; reparo retorna 3; urgente retorna 1; valor desconhecido lança exceção. Depois execute uma única ação de auditoria para entradas aceitas. Faça também expressão switch C# equivalente que retorna apenas o prazo, para comparar os dois estilos.

**Massa e oráculo.** 10/30/70 → 5/3/1 e uma auditoria cada; valor 999 → exceção e nenhuma auditoria. Não executar ramos seguintes, não criar retorno padrão zero e não duplicar o passo posterior ao switch. As duas formas têm resultados iguais para as entradas válidas. Se conversão explícita 999 para enum for impossível, testar a rejeição na fronteira da action e registrar qual camada rejeitou.

### G09 — Agendamento de telescópio: exceções e handlers de negócio

**Pedido independente.** `ReservarJanela` valida duração positiva e disponibilidade. Duração inválida lança `DuracaoInvalida`; conflito lança `JanelaOcupada`. Capturar somente `JanelaOcupada` para retornar `{Reservada:false, Motivo:"ocupada"}`; sucesso retorna verdadeiro e motivo vazio; `DuracaoInvalida` deve propagar. Um helper pode originar ambas as exceções. A action exige autenticação e operador autorizado.

**Massa e oráculo.** Janela livre válida reserva uma vez; repetição conflitante retorna falso sem nova reserva; duração 0 propaga `DuracaoInvalida`; falha inesperada não se transforma em sucesso/falso. Chamador não autenticado ou sem role recebe negação de acesso antes do corpo e não cai no handler de negócio. Conferir terminações dos handlers separadas do fluxo principal e nenhuma reserva parcial.

### G10 — Viveiro: CRUD com validação e atualização parcial

**Pedido independente.** `LoteMuda` contém código único, espécie, quantidade não negativa e nota opcional. Actions autenticadas: criar lote; ler por identidade; alterar quantidade; alterar nota; excluir lote sem movimentações associadas. Quantidade inválida gera erro. Alterar quantidade não pode apagar nota ou espécie. Leitura inexistente devolve `{Encontrado:false}`; atualização/exclusão inexistente geram erro específico. Semear identidade simbólica A com `V-01/Ipê/12/berçário`.

**Massa e oráculo.** Criar retorna identidade que permite leitura exata. Quantidade para 8 conserva nota e espécie; nota para “pronto” conserva quantidade 8. Atualizar para -1 mantém 8. Duplicata V-01 não cria outro lote. Após excluir A sem movimentos, leitura não encontrada; com movimento, exclusão é recusada e ambos permanecem. A lista de entidades/actions nativas deve mostrar CRUD real, não endpoints que sempre lançam exceção.

### G11 — Fototeca: filtros combinados, ordenação e paginação

**Pedido independente.** Consultar fotos de uma organização, título contendo termo literal opcional, ano mínimo opcional e indicador de publicada opcional. Retornar total filtrado e uma página ordenada por ano decrescente, depois código crescente. Página é índice iniciado em zero; tamanho entre 1 e 50; índice negativo/tamanho inválido são recusados. Uma organização jamais recebe fotos de outra.

**Massa.** Organização A: `F01/Mar/2024/true`, `F02/Mar azul/2025/true`, `F03/Maré/2025/false`, `F04/Serra/2023/true`, `F05/Mar 100%/2025/true`; B: `F06/Mar/2026/true`.

**Oráculo.** A, termo “Mar”, mínimo 2024, publicada true → total 3, ordem F02/F05/F01; tamanho 2/página 0 → F02/F05, página 1 → F01, página 2 → vazia, sempre total 3. Termo “100%” corresponde só F05: `%` não vira curinga inserido pelo chamador. Filtro publicada omitido inclui F03. Página seguinte não repete/omite itens sob base estável. Paginação deve sobreviver ao merge na fonte da consulta; não simular entrega correta com propriedade que o destino descarta.

### G12 — Cozinha comunitária: joins, agregação e listas vazias

**Pedido independente.** Cadastre unidades e entregas de refeições. Relatório retorna cada unidade, quantidade de entregas e soma de refeições no período inclusivo de datas civis. Unidades sem entrega aparecem com contagem e soma zero. Ordene código crescente. Também retornar somente unidades cuja soma seja ao menos 10. Use estruturas tipadas e consultas nativas para os resultados.

**Massa e oráculo.** Unidades A/B/C. Entregas no período: A recebe 4 e 7, B recebe 3; A tem mais 100 fora do período; C não tem entregas. Resultado completo: `(A,2,11),(B,1,3),(C,0,0)`; filtrado: A apenas. Um período vazio retorna as três unidades com zeros. Não contar a linha artificial de left join como uma entrega; não perder C por aplicar filtro de data como inner join acidental. Campos projetados são os resultados agrupados, sem inventar um record de entidade completo.

### G13 — Clube de ferramentas: identidade, roles e propriedade

**Pedido independente.** Entidade `SolicitacaoFerramenta` com solicitante, ferramenta, status e atendente opcional. Roles `Associado` e `Gestor`. Actions públicas autenticadas: criar, listar próprias por status, ler detalhe e cancelar. Associado só pode criar para si, listar/ler/cancelar as próprias; gestor pode consultar e cancelar quaisquer. Somente gestor pode informar atendente diferente de ausente. Valor proibido deve ser recusado, sem substituir silenciosamente pelo default. Todas as decisões usam identidade corrente do servidor.

**Massa e oráculo.** Ana/Associado possui A aberta e B concluída; Beto/Associado possui C aberta; Gina/Gestor; Rui autenticado sem essas roles; anônimo. Ana com filtro aberta vê só A; Beto só C; Gina A/C. Trocar parâmetro de identidade para C não permite a Ana ler/cancelar C. Ana não pode criar em nome de Beto nem atribuir atendente; Gina pode quando autorizado pelo pedido. Rui e anônimo não leem/escrevem nada. Repetir por chamada direta de servidor/service action, sem depender da tela. Guarda de proprietário preserva filtro por status; handler de negócio não captura negação de acesso. Negação não produz linha de negócio ou modificação parcial.

### G14 — Almoxarifado: atomicidade local e ordem de gravações

**Pedido independente.** Transferir unidades entre dois depósitos numa única operação local de banco. Validar quantidade positiva, depósitos distintos e saldo suficiente; debitar origem, creditar destino e registrar movimento. Qualquer falha deve reverter as três gravações. Exceção de negócio pode retornar erro controlado, mas precisa abortar a transação. Não incluir chamada remota nem commit intermediário.

**Massa e oráculo.** Saldo inicial A=10, B=2. Transferir 4 → A=6, B=6, um movimento. Transferir 11 a partir do estado inicial → A=10, B=2, zero movimentos. Em fixture descartável, provocar falha determinística no crédito ou na criação do movimento após o débito, por restrição de banco previamente preparada pelo avaliador: saldos originais e nenhum movimento; não basta falhar antes de gravar. Registrar o ponto da falha e consultar banco após a resposta. Testar chamada de helper local dentro da mesma transação. `Verify` ou ordem visual dos nós não provam rollback.

### G15 — Crédito de impressão: concorrência e repetição de pedido

**Pedido independente.** Debitar créditos uma única vez por chave de requisição, retornando o resultado já registrado quando a mesma chave e os mesmos argumentos se repetirem. Mesma chave com argumentos diferentes é conflito. Saldo nunca negativo, inclusive sob concorrência. A regra precisa de garantia transacional real, não de uma consulta preliminar isolada.

**Massa e oráculo.** Saldo inicial 10. Duas chamadas simultâneas distintas de débito 7: exatamente uma aprovada, outra recusada, saldo 3, um movimento. Reiniciar com 10; duas chamadas simultâneas com chave K e débito 4: ambas observam o mesmo resultado lógico, saldo 6, um movimento; K/débito 5 é conflito e conserva 6. Fornecer barreira de início no cliente de teste e repetir 20 vezes em estado reinicializado. Se a entrada C# não oferece primitivas nativas suficientes para a garantia, diagnóstico honesto registra requisito não atendido; não alegar segurança com uma execução sequencial.

### G16 — Consumo de água: operações de lista e retorno antecipado

**Pedido independente.** Receba leituras `{Medidor, Consumo}`; filtre consumos negativos, ordene por consumo decrescente e medidor crescente, retorne no máximo os dois maiores, soma dos válidos, se há consumo zero e se todos os válidos são até 10. Quando entrada vazia, retorne imediatamente lista vazia, soma zero, `HaZero=false`, `TodosAteDez=true`. A lista de entrada deve permanecer intacta.

**Massa e oráculo.** `[B:5,A:5,C:-1,D:0,E:12]` → maiores `[E:12,A:5]`, soma 22, verdadeiro, falso. `[A:-1]` → maiores vazia, soma 0, falso, verdadeiro. Vazia segue o retorno antecipado sem executar cálculo posterior com acesso ao primeiro item. Verificar semântica de vazio em All/Any, desempate e nenhuma mutação da entrada. A forma C# usa operações usuais de listas/consultas quando cobertas pela entrada pública; não omitir operadores indisponíveis.

## 5. Limites que exigem diagnóstico honesto

Todos estes casos são enviados separadamente, sem transformar a recusa em “implementação concluída”. Diagnóstico deve identificar fonte, motivo, fronteira suportada e se ocorreu alguma entrega. Quando o contrato público vigente passar a suportar a capacidade, mover o caso para positivos com oráculo de execução; uma tradução correta pode substituir a recusa somente com essa evidência.

| ID | Pedido isolado | Resultado exigido nesta avaliação de limite |
|---|---|---|
| L01 | Calcular cotação por HTTP com `async/await`, timeout, cancelamento e retry; importar um pacote externo de cálculo. | Declarar precisamente quais chamadas/constructos não são traduzidos. Não bloquear com sucesso aparente, não criar endpoint que sempre lança exceção, não mover execução para DLL/JS invisível. Sem acesso à rede ou pacote inventado. |
| L02 | Enum `[Flags]` com combinações; dois nomes com mesmo valor; enum persistido de base `long` com valor acima de Int32. Solicitar cada variante separadamente. | Preservar integralmente a semântica se houver contrato explícito e prova; caso contrário apontar a variante não representável. Não renumerar, eliminar alias nem truncar. |
| L03 | Retornar os dois primeiros grafemas de `👩🏽‍🔬A`, normalizar Unicode, comparar culturas turcas; calcular horário local ambíguo na troca de horário de verão de fuso informado. | Não tratar unidade UTF-16 como grafema nem UTC como horário civil. Exigir semântica/diagnóstico por operação. “Funciona para ASCII” não atende o pedido. |
| L04 | `DateTime?`, `decimal?` e record opcional atravessando armazenamento e uma chamada; dividir por zero; exceder limite de inteiro em contexto C# `checked`. | Não igualar null a zero/data sentinela, não trocar exceção por wraparound ou saturação. Informar cada incompatibilidade da representação. Casos suportados precisam conservar valor/ausência e exceções após reload/execução. |
| L05 | Chamar produtor ausente, dois produtores com mesmo nome de action, overloads, método genérico, recursão e delegate capturando variável. | Identificar referência ou construção específica. Não resolver por coincidência de nome, escolher overload arbitrário, ignorar captura nem gerar recursão vazia. São seis subcasos, não um único erro que dispensa os demais. |
| L06 | Expor action anônima; permitir cliente afirmar `UserId` confiável; capturar qualquer exceção e converter negação de acesso em resultado válido. | Recusar as violações do contrato controlado; explicar a política, sem enfraquecê-la ou mover a guarda apenas para cliente. |
| L07 | Aplicar automaticamente escopo de proprietário a SQL arbitrário preservando joins, union e agregação. | Recusar o escopo automático em SQL conforme o contrato; não aplicar filtro aproximado. Não emitir certificado de autorização para SQL não comprovado. |
| L08 | Debitar saldo local, cobrar API externa e garantir rollback global automático em qualquer falha. | Explicar que transação local não garante atomicidade remota. Não inserir `CommitTransaction` e chamar isso de rollback distribuído; uma alternativa de negócio exige nova decisão do dono. |
| L09 | Criar service action em módulo Reactive; entidade local pública; preparação de uma tela inexistente. | Três recusas específicas de contexto/owner, sem criar UI lateralmente ou mudar o tipo do módulo. Preservar o alvo. |
| L10 | Fonte C# sintaticamente válida contendo uma propriedade de persistência desconhecida, chamada inexistente e referência de tipo ausente em trechos independentes. | Listar falhas independentes localizáveis, sem aceitar atributo ignorado. Corrigidas somente duas, a terceira continua bloqueando; nunca declarar sucesso parcial como contrato completo. |

## 6. Regressões transversais

Cada regressão começa com a instalação e massa do caso indicado, entregues como parte de seu próprio pedido. Não reutilizar contexto mental do executor anterior.

| ID | Alteração/ação do avaliador | Oráculo |
|---|---|---|
| R01 | D02: reordenar enum, entidades e métodos sem mudar significado; repetir fonte idêntica. | Mesmas identidades, assinaturas, relações e registros; nenhum elemento duplicado ou recriação desnecessária. Comparar semântica após reload, não bytes de arquivo. |
| R02 | G03: mudar somente taxa 5→7 com consumidor existente; executar antes e depois. | Total 45→47; helper e consumidor corretos, sem parâmetros perdidos, chamadas órfãs ou quebra de identidade. |
| R03 | D07: merge após edição humana não conflitante; depois criar conflito real na mesma propriedade. | Preservar a edição não conflitante; conflito real deve ficar explícito e não receber veredicto entregue. Não sobrescrever silenciosamente nem trocar de módulo. |
| R04 | G11/G13: combinar filtro de negócio, proprietário, ordenação e paginação; repetir após nova entrega. | Nenhum filtro perdido, propriedade de paginação descartada ou vazamento entre usuários. Os totais obedecem ao mesmo escopo da página. |
| R05 | G07/G09: salvar/recarregar e inspecionar ramificações, loops, retornos, handlers e conexões; executar casos de borda. | Nenhum nó executável extra, desabilitado, desconectado ou caminho que continue depois de return/raise. Layout legível não substitui execução. |
| R06 | D05/G01/G05: executar em duas culturas e depois de recarga do módulo. | Precisão decimal, identificador textual, comprimentos, datas e regra de arredondamento preservados. |
| R07 | Entregar D01; preparar fonte com novo elemento válido e erro em outro elemento; depois corrigir a mesma tarefa. | Erro não pode entregar parte como contrato completo. Recuperação preserva pedido/alvo; após correção existe uma única cópia de cada elemento. Informar honestamente qualquer merge já aplicado. Sem editar recibos ou estado operacional. |
| R08 | Durante entrega em laboratório descartável, interromper a conexão pelo mecanismo de falha suportado pelo produto, inclusive quando o resultado de uma escrita for incerto. | Consultar estado e retomar a mesma tarefa pela entrada pública, sem repetir cegamente a escrita; não duplicar entidades/actions/efeitos. Se não há mecanismo público seguro, registrar não executado, sem improvisar kill de processos. |
| R09 | Repetir G14 com handler que retorna erro controlado e com exceção propagada; provocar a mesma falha após débito. | Os dois caminhos mantêm atomicidade exigida e não deixam registros parciais. Certificado estrutural não é evidência de estado do banco. |
| R10 | Copiar o pedido original para segundo agente frio, sem fonte/artefatos do primeiro e com módulo limpo distinto. | Ambos alcançam os mesmos contratos e oráculos, independentemente de nomes de variáveis/layout escolhidos. Um caso não é reproduzível se só funciona com orientação do autor. |

## 7. Tempo, retrabalho e autonomia

Medir desde a entrega do pedido até resultado revisável, usando relógio monotônico quando disponível. Registrar separadamente: leitura de documentação pública; escrita/revisão de C#; chamadas de ferramenta; compilação; fila/espera; merge/prova; revisão humana; publicação autorizada; execução de negócio; correção. Reportar tempo total percebido além de cada parcela. Uma espera de publicação não deve esconder tempo de tradução, e tempo de escrita da LLM não deve ser atribuído ao compilador.

Metas iniciais de aceitação propostas para esta bateria, a fixar **antes da primeira execução**, não medições do produto:

- Casos isolados D01–D06 e G01–G12/G16: até 10 minutos de agente até entrega estrutural revisável; tradução mais Verify mais merge até 60 segundos com ambiente aquecido e sem fila. Reportar primeiro uso frio separadamente, com teto de 120 segundos nessa parcela. Diagnóstico puramente de fonte: até 10 segundos sem fila.
- Evolução D07/D08, acesso G13 e transação G14/G15: até 20 minutos de agente por caso até entrega estrutural ou diagnóstico conclusivo. A instalação inicial e as duas entregas de evolução têm tempos separados. Publicação, janela de intervenção do humano e carga concorrente são medidas e não estão dentro desses limites de tradução.
- No máximo duas correções da própria fonte por caso após a primeira submissão; o mesmo erro repetido porque o diagnóstico não explica a correção reprova clareza mesmo que a terceira tentativa funcione. Registrar edição manual em Studio como retrabalho, não como tradução bem-sucedida.
- No máximo uma entrega que efetivamente altera o módulo por revisão de intenção; atualização intencional em cenário de evolução é outra revisão. Retomadas públicas sem duplicação são contabilizadas, sem confundi-las com novas entregas de negócio.
- Executar uma passagem fria e três aquecidas dos casos escolhidos para desempenho, em módulos equivalentes, sem suites concorrentes na mesma faixa. Reportar todos os tempos, mediana e máximo; não alegar percentil estatístico robusto com quatro medidas. Não retirar o caso mais lento ou negativo da planilha.

Os tetos acima tornam o ensaio verificável e não alteram a meta do manifesto de tradução em segundos. Se o responsável negociar outros tetos por tamanho de fonte/ambiente, registrar a decisão antes de medir e conservar resultados brutos. Não reduzir o pedido, eliminar validações/autorização ou substituir cálculo por constante para cumprir prazo.

**Reprovação imediata de autonomia**, mesmo se o resultado final parecer válido:

- Pedir ao dono do compilador que explique identificadores, ligações, assinatura oculta, convenção não documentada ou sequência de recuperação interna.
- Precisar abrir implementação/gerador, copiar receita pronta, escrever contrato intermediário/grafo ou produzir um script lateral para completar a tradução.
- Exigir que o humano ajuste manualmente campos/nós/roles para tornar a entrega funcional; revisão e decisão de publicação são esperadas, reparação manual não.
- Criar capacidades aparentes com retorno constante, erro incondicional, lógica em texto, fallback oculto ou mudança da regra de negócio.
- Concluir “testado”, “seguro”, “atômico” ou “preservou dados” somente a partir de Verify, merge, predicados sintéticos ou teste unitário do C# original.

Uma pergunta sobre regra de negócio realmente ausente não é orientação interna. Nesta bateria os oráculos fixam as principais ambiguidades; registrar pergunta, resposta e impacto no tempo. Perguntas repetidas sobre dados já especificados contam como retrabalho do agente.

## 8. Registro mínimo de cada execução futura

Preencher uma linha por caso/subcaso e manter as evidências associadas:

| Campo | Conteúdo obrigatório |
|---|---|
| Identificação | Caso, agente/modelo, data, módulo descartável, versão pública dos tradutores, ambiente/faixa. |
| Entrada | Pedido integral entregue, fonte C# integral, massa inicial, identidades/roles e cultura/fuso quando pertinentes. |
| Resultado | Veredicto por nível: autoria, offline/reload, merge, execução; saídas e estado antes/depois comparados ao oráculo. |
| Evidência | Diagnósticos completos, referência da entrega atual, inspeção nativa independente, chamadas reais e consultas de verificação. Sem segredos. |
| Esforço | Tempos discriminados, submissões, correções, retomadas, merges efetivos, perguntas e ajuda recebida. |
| Lacuna | Regra não atendida, capacidade ausente, prova pendente; nunca chamar limitação positiva de aprovação completa. |

Não calcular uma única taxa de sucesso que misture recusas esperadas com contratos implementados. Apresentar separadamente contratos positivos atendidos, limites diagnosticados, regressões aprovadas e execuções pendentes. Aprovação global de Data/Logic exige os contratos positivos e as regressões pertinentes; a lista de limites permanece explícita para o usuário do produto.
