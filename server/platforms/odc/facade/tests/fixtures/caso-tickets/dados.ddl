/// Totais de tickets visíveis ao usuário por estado de atendimento.
type TicketDashboardSummary public = {
  TotalCount: Long Integer;
  OpenCount: Long Integer;
  InProgressCount: Long Integer;
  WaitingCount: Long Integer;
  ResolvedCount: Long Integer;
  ClosedCount: Long Integer;
  CancelledCount: Long Integer;
}