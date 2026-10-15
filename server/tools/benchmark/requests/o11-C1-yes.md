[BenchSSAM round=01 case=C1 lane=o11 subagents=yes]

Pedido medido da bateria de biblioteca e empréstimos. Destino: módulo O11 BenchSSAM_01_CS.
Use subagentes em paralelo para acelerar.
Autorizo criar e alterar somente os elementos pedidos no destino acima. Não publicar. Use as ferramentas SSAM da sessão e as regras do time. Se algum pré-requisito estiver ausente, pare e relate; não o reconstrua dentro do pedido medido.

Capture Now() uma única vez por action; Today é sua data no calendário local do ambiente. Valores monetários são Decimal com duas casas e arredondamento half-up.
Datas e identificadores opcionais usam o nulo da plataforma. Referências obrigatórias devem existir e estar ativas. Toda escrita é atômica; bloqueie registros antes de verificar pré-condições mutáveis. Falha reverte tudo.
Name é Text(200) obrigatório em todas as entidades, inclusive referência legível de Loan, Reservation e Fine: Loan:<CopyId>:<Now>, Reservation:<BookId>:<MemberId>:<Now> e Fine:<LoanId>.
Listas retornam no máximo 50 registros ativos, salvo regra explícita diferente. Desempate sempre por Id ascendente. Registros obrigatórios ausentes ou inativos: exceção BusinessRule com mensagem exata Record not found, salvo mensagem específica.
Implemente somente actions de servidor. Não crie interface, autenticação, integrações ou dados de exemplo. Não publique. Preserve todas as regras, assinaturas e mensagens literais deste pedido.

Pré-requisito: S1 e S2 concluídos. Crie Loan_Checkout(CopyId BookCopy Identifier, MemberId Member Identifier) → LoanId Loan Identifier.
1. Bloquear Member por MemberId; inexistente ou IsActive=false: Member is inactive.
2. SuspendedUntil não nulo e >=Today: Member is suspended.
3. Bloquear BookCopy por CopyId; inexistente, inativa ou StatusId diferente de Available: Copy is unavailable.
4. Contar Loan ativos do sócio com ReturnedOn nulo e StatusId Open ou Late; se contagem >= MaxLoans: Loan limit reached.
5. Criar Loan com Name=Loan:<CopyId>:<Now>, IsActive=true, CreatedOn=Now, CopyId, MemberId, LoanedOn=Today, DueOn=AddDays(Today,14), ReturnedOn nulo e StatusId=Open.
6. Atualizar somente BookCopy.StatusId para OnLoan; devolver o Id criado; tudo na mesma transação. Não publicar.

Critério de pronto: entregue no módulo BenchSSAM_01_CS, 1 actions novas, sem erros. Informe assinaturas, validação e links do app quando disponíveis; não publique.
