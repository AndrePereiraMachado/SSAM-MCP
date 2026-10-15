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
/// Impede categorias com o mesmo nome em gravações concorrentes.
create unique index UQ_CategoryName on TicketCategory (Name);
/// Garante um único conteúdo binário por anexo.
create unique index UQ_FileContent on TicketAttachmentContent (AttachmentId);
