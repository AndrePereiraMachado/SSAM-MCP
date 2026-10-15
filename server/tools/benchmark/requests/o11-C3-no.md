[BenchSSAM round=01 case=C3 lane=o11 subagents=no]

Pedido medido da bateria de biblioteca e empréstimos. Destino: módulo O11 BenchSSAM_01_CS.
Faça sem subagentes.
Autorizo criar e alterar somente os elementos pedidos no destino acima. Não publicar. Use as ferramentas SSAM da sessão e as regras do time. Se algum pré-requisito estiver ausente, pare e relate; não o reconstrua dentro do pedido medido.

Capture Now() uma única vez por action; Today é sua data no calendário local do ambiente. Valores monetários são Decimal com duas casas e arredondamento half-up.
Datas e identificadores opcionais usam o nulo da plataforma. Referências obrigatórias devem existir e estar ativas. Toda escrita é atômica; bloqueie registros antes de verificar pré-condições mutáveis. Falha reverte tudo.
Name é Text(200) obrigatório em todas as entidades, inclusive referência legível de Loan, Reservation e Fine: Loan:<CopyId>:<Now>, Reservation:<BookId>:<MemberId>:<Now> e Fine:<LoanId>.
Listas retornam no máximo 50 registros ativos, salvo regra explícita diferente. Desempate sempre por Id ascendente. Registros obrigatórios ausentes ou inativos: exceção BusinessRule com mensagem exata Record not found, salvo mensagem específica.
Implemente somente actions de servidor. Não crie interface, autenticação, integrações ou dados de exemplo. Não publique. Preserve todas as regras, assinaturas e mensagens literais deste pedido.

Pré-requisito: S1, S2, C1 e C2 concluídos. Crie todas e somente as 20 actions da tabela. Reutilize Loan_Checkout já existente. Não altere actions existentes.
| Nome | Entradas | Saídas | Regra exata |
|---|---|---|---|
| Loan_Return | LoanId Loan Identifier | FineAmount Decimal(12,2) | Loan ativo Open/Late e ReturnedOn nulo, senão Loan is not open; bloquear Loan e cópia; ReturnedOn=Today, Status=Returned, cópia Available; multa Max(0,DiffDays(DueOn,Today))*0.75, teto20; upsert Fine por LoanId somente se Amount>0 e não paga/perdoada; preencher campos comuns; retornar multa devida (0 se paga/perdoada); transação única. |
| Loan_Renew | LoanId Loan Identifier | DueOn Date | Loan ativo Open, ReturnedOn nulo e DueOn>=Today; sócio ativo e não suspenso; nenhuma reserva ativa Waiting/Ready do mesmo livro por outro sócio; senão Renewal is not allowed; bloquear Loan e estender DueOn existente em 14 dias; retornar nova data. |
| Loan_MarkLost | LoanId Loan Identifier | Success Boolean | Exigir Loan ativo Open/Late e não devolvido, senão Loan is not open; bloquear Loan e cópia, marcar Loan Lost e cópia Lost, manter ReturnedOn nulo, retornar true; sem multa adicional. |
| Loan_ListOverdue | AsOf Date | Loans List<Loan> | AsOf obrigatório; retornar até50 Loan ativos Open/Late, ReturnedOn nulo e DueOn<AsOf, por DueOn asc, Id asc; não escrever. |
| Reservation_Place | BookId Book Identifier, MemberId Member Identifier | ReservationId Reservation Identifier | Livro e sócio ativos, sócio não suspenso; bloquear sócio; impedir outra reserva ativa Waiting/Ready do par com Reservation already exists; criar Waiting, PlacedOn=Now e campos comuns; retornar Id. |
| Reservation_Cancel | ReservationId Reservation Identifier | Success Boolean | Reserva ativa Waiting/Ready, senão Reservation is not pending; bloquear e marcar Cancelled; retornar true. |
| Reservation_Fulfil | ReservationId Reservation Identifier, CopyId BookCopy Identifier | LoanId Loan Identifier | Reserva ativa Waiting/Ready e cópia do mesmo BookId, senão Reservation cannot be fulfilled; bloquear reserva; executar Loan_Checkout para sócio da reserva e cópia; marcar Fulfilled; retornar LoanId, tudo atomicamente. |
| Fine_Calculate | LoanId Loan Identifier, AsOf Date | Amount Decimal(12,2) | Loan existente ativo, AsOf obrigatório; data final=menor entre ReturnedOn e AsOf quando ReturnedOn existe, senão AsOf; Max(0,DiffDays(DueOn,data final))*0.75 arredondado, teto20; somente cálculo, sem escrita. |
| Fine_Pay | FineId Fine Identifier | Success Boolean | Fine ativa, não paga e não perdoada, senão Fine is not payable; bloquear e definir PaidOn=Now; retornar true. |
| Fine_Waive | FineId Fine Identifier | Success Boolean | Fine ativa, não paga e não perdoada, senão Fine cannot be waived; bloquear e definir Waived=true; preservar Amount e PaidOn; retornar true. |
| Member_Suspend | MemberId Member Identifier, Until Date | Success Boolean | Sócio ativo e Until>=Today, senão Invalid suspension; bloquear e usar maior de Until e suspensão existente; retornar true. |
| Member_Reinstate | MemberId Member Identifier | Success Boolean | Sócio existente ativo; bloquear e limpar SuspendedUntil; não alterar IsActive, empréstimos ou multas; retornar true. |
| Member_CanBorrow | MemberId Member Identifier | CanBorrow Boolean, Reason Text(100) | Sem escrita; primeira falha: inexistente/inativo => false, Member is inactive; suspensão>=Today => false, Member is suspended; Loan ativos Open/Late sem devolução >=MaxLoans => false, Loan limit reached; senão true e Reason vazio. |
| Member_LoanHistory | MemberId Member Identifier | Loans List<Loan> | Sócio existente (inclusive inativo); retornar até50 Loan do sócio inclusive inativos e devolvidos, por LoanedOn desc, Id asc; sem escrita. |
| Book_AvailableCopies | BookId Book Identifier, BranchId Branch Identifier (optional) | Copies List<BookCopy> | Livro ativo; BranchId nulo significa todas, valor informado exige filial ativa; cópias ativas Available correspondentes, por Barcode asc, Id asc, máximo50. |
| Book_Search | Query Text(300) | Books List<Book> | Trim(Query); busca substring sem distinguir maiúsculas em Title ou Isbn ou Name; vazio aceita todos; só ativos, Title asc e Id asc, máximo50; sem escrita. |
| Copy_Transfer | CopyId BookCopy Identifier, BranchId Branch Identifier | Success Boolean | Cópia ativa Available e filial destino ativa, senão Copy cannot be transferred; bloquear cópia e atualizar BranchId; mesmo destino é sucesso sem escrita; retornar true. |
| Copy_SendToRepair | CopyId BookCopy Identifier | Success Boolean | Cópia ativa Available, senão Copy cannot be repaired; bloquear e definir StatusId=Repair; retornar true. |
| Branch_DailySummary | BranchId Branch Identifier, Day Date | Summary BranchDailySummary | Filial ativa e Day obrigatório; considerando a filial atual de cada cópia: contar Loan ativos LoanedOn=Day, ReturnedOn=Day, cópias ativas Available e Loan ativos Open/Late não devolvidos DueOn<Day; sem limite nos counts, sem escrita. |
| Report_TopBooks | From Date, To Date | Books List<TopBook> | From e To obrigatórios e From<=To, senão Invalid date range; agrupar Loan ativos LoanedOn no intervalo inclusivo por BookId da cópia; livros ativos, ordenar LoanCount desc e BookId asc; retornar até10 BookId,Title,LoanCount; sem escrita. |

Critério de pronto: entregue no módulo BenchSSAM_01_CS, 20 actions novas, sem erros. Informe assinaturas, validação e links do app quando disponíveis; não publique.
