[BenchSSAM round=01 case=S2 lane=odc subagents=no]

Preparação não medida (measured:false) da bateria de biblioteca e empréstimos. Destino: library ODC BenchSSAM_01.
Faça sem subagentes.
Autorizo criar e alterar somente os elementos pedidos no destino acima. Não publicar. Use as ferramentas SSAM da sessão e as regras do time. Se algum pré-requisito estiver ausente, pare e relate; não o reconstrua dentro do pedido medido.

Capture Now() uma única vez por action; Today é sua data no calendário local do ambiente. Valores monetários são Decimal com duas casas e arredondamento half-up.
Datas e identificadores opcionais usam o nulo da plataforma. Referências obrigatórias devem existir e estar ativas. Toda escrita é atômica; bloqueie registros antes de verificar pré-condições mutáveis. Falha reverte tudo.
Name é Text(200) obrigatório em todas as entidades, inclusive referência legível de Loan, Reservation e Fine: Loan:<CopyId>:<Now>, Reservation:<BookId>:<MemberId>:<Now> e Fine:<LoanId>.
Listas retornam no máximo 50 registros ativos, salvo regra explícita diferente. Desempate sempre por Id ascendente. Registros obrigatórios ausentes ou inativos: exceção BusinessRule com mensagem exata Record not found, salvo mensagem específica.
Implemente somente actions de servidor. Não crie interface, autenticação, integrações ou dados de exemplo. Não publique. Preserve todas as regras, assinaturas e mensagens literais deste pedido.

Pré-requisito: S1 concluído neste destino. Crie apenas Library_CloseDay(AsOf Date (required)) → Summary CloseDaySummary.
1. Capturar Now uma vez; rejeitar AsOf nulo ou futuro com Invalid closing date.
2. Declarar DailyFine Decimal(12,2) = 0.50 em UMA atribuição isolada e FineCap = 20.00. Nenhum outro literal 0.50 no fluxo.
3. Inicializar individualmente os sete campos de Summary com zero; declarar temporários tipados para datas, valores, contadores e registros.
4. Consultar todos os Loan ativos com ReturnedOn nulo e Status Open ou Late, ordenados por Id; sem limite de 50 nesta rotina em lote.
5. Para cada Loan, incrementar LoansScanned; recarregar e bloquear o registro; ignorar se deixou de estar ativo, aberto ou sem devolução.
6. Ler a cópia e o sócio; ignorar o Loan se alguma referência não existir; calcular DaysLate = Max(0, DiffDays(DueOn, AsOf)).
7. Se DaysLate = 0, não alterar status nem multa e avançar para o próximo Loan.
8. Se DaysLate > 0 e Status Open, atribuir Late, persistir e incrementar LoansMarkedLate; Loan já Late não incrementa esse contador.
9. Calcular RawAmount = DaysLate * DailyFine; arredondar para duas casas e limitar Amount a FineCap.
10. Consultar Fine por LoanId, incluindo inativos; a chave LoanId é única para impedir duplicação.
11. Se Fine inexistente, inicializar TODOS os campos (Name Fine:<LoanId>, IsActive true, CreatedOn Now, LoanId, Amount, PaidOn nulo, Waived false), criar e incrementar FinesCreated.
12. Se Fine existente, ativa, não paga, não perdoada e Amount diferente, atualizar somente Amount e incrementar FinesUpdated. Caso contrário não modificar.
13. Somar a Summary.FineTotal o Amount atual somente das multas ativas, não pagas e não perdoadas processadas nesta execução; uma soma por Loan.
14. Após terminar empréstimos, consultar todas as Reservation ativas com Status Ready, ordenadas por Id, sem limite de lote.
15. Para cada reserva, bloquear e reler; considerar PlacedOn como início da janela Ready (o modelo não tem ReadyOn).
16. Se ainda Ready e PlacedOn < DateToDateTime(AddDays(AsOf,-2)), marcar Cancelled, persistir e incrementar ReservationsExpired. Igual ao limite não expira.
17. Consultar todos os Member ativos por Id, sem limite; para cada sócio contar Loan ativos com ReturnedOn nulo, Status Open ou Late e DueOn < AsOf.
18. Se contagem >=3, definir NewUntil=AddDays(AsOf,7); bloquear e reler sócio; se SuspendedUntil nulo ou menor que NewUntil, atualizar e incrementar MembersSuspended.
19. Não reduzir suspensão existente, não suspender sócio inativo, não devolver cópia, não criar empréstimo nem reativar registros.
20. Arredondar FineTotal a duas casas; retornar Summary. Em falha técnica, reverter a execução inteira e propagar a exceção.
21. Manter loops, consultas, guardas, atribuições e persistências explícitos, cerca de 150 linhas de fluxo legível (faixa 130–170); sem comentários vazios ou operações inúteis para inflar tamanho. Documentar contagem no recibo; prioridade à semântica.

Critério de pronto: entregue no módulo BenchSSAM_01, 1 actions novas, sem erros. Informe assinaturas, validação e links do app quando disponíveis; não publique.
