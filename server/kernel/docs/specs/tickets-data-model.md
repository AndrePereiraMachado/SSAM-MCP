# Tickets: data model (help desk interno), 2026-09-04

Convencoes O11: Id Long Integer AutoNumber em toda entidade, FK = `<Entidade> Identifier`, listas fixas em static entities, sem deletes
fisicos de historico. Vive num modulo Service (`Headless_CS` na prova), entidades publicas e read-only para os modulos de UI.
Gerado por `scripts/gen_tickets.py` (job `tests/jobs/tickets-01-data.json`, op `spec`).

## Static entities

| Static | Records | Uso |
|---|---|---|
| TicketStatus | New, Open, Pending, Resolved, Closed, Cancelled | ciclo de vida; Order = sequencia |
| TicketPriority | Low, Medium, High, Urgent | SLA e ordenacao |
| TicketType | Incident, Request, Question, Problem | roteamento e relatorios |
| TicketChannel | Portal, Email, Phone, Chat, API | origem |
| TicketEventType | Created, Updated, StatusChanged, Assigned, PriorityChanged, CommentAdded, AttachmentAdded, Escalated, Reopened, Merged | historico auditavel |
| SlaTarget | FirstResponse, Resolution | tipo de prazo |

## Entidades

| Entidade | Atributos | Notas |
|---|---|---|
| Team | Name (100, obrig.), Description, Email, IsActive (default True), ManagerId (User) | filas de atendimento |
| TeamMember | TeamId (obrig.), UserId (obrig.), IsLead, JoinedOn | unico (TeamId, UserId) |
| Category | Name (100, obrig.), ParentCategoryId, DefaultTeamId, DefaultPriorityId, IsActive | arvore ate 3 niveis; roteamento |
| SlaPolicy | Name, PriorityId (obrig.), TargetId (obrig.), Minutes (obrig.), BusinessHoursOnly, IsActive | uma ativa por (prioridade, alvo) |
| Ticket | Number (20, obrig., unico "TCK-000123"), Subject (200, obrig.), Description (2000), StatusId (default New), PriorityId (default Medium), TypeId (obrig.), ChannelId, CategoryId, TeamId, AssigneeId, RequesterId (obrig.), CreatedOn (obrig.), CreatedBy, UpdatedOn, FirstResponseDueOn, ResolutionDueOn, FirstRespondedOn, ResolvedOn, ClosedOn, IsEscalated, SatisfactionScore, ParentTicketId | 23 atributos; UpdateBehavior Optimized |
| TicketComment | TicketId (obrig.), AuthorId (obrig.), Body (4000, obrig.), IsInternal, CreatedOn, EditedOn | nunca apagar; marcar editado |
| TicketAttachment | TicketId (obrig.), CommentId, FileName (255), MimeType (100), SizeBytes, Content (Binary), UploadedById, UploadedOn | binario isolado |
| TicketEvent | TicketId (obrig.), EventTypeId (obrig.), ActorId, OccurredOn (obrig.), FromValue (200), ToValue (200), Note (500) | trilha de auditoria |
| TicketWatcher | TicketId (obrig.), UserId (obrig.), AddedOn | unico (TicketId, UserId) |
| Tag | Name (50, obrig.), Color (20), IsActive | |
| TicketTag | TicketId (obrig.), TagId (obrig.) | N:N, unico no par |
| CannedResponse | Title (100, obrig.), Body (4000), TeamId, IsActive | respostas prontas |
| Notification | UserId (obrig.), TicketId, Title (200), Body (1000), CreatedOn, ReadOn, SentOn, ChannelId | caixa in-app; despacho por timer |
| TicketSlaBreach | TicketId (obrig.), TargetId (obrig.), DueOn, BreachedOn, NotifiedOn | materializa o atraso |

Structures: TimelineItem (Kind, OccurredOn, ActorId, Text, IsInternal), DashboardMetrics (OpenCount, PendingCount, ResolvedCount,
ClosedCount, UrgentCount, SlaBreaches, AvgFirstResponseMinutes, AvgResolutionMinutes, Backlog).
Site properties: MaxAttachmentMB (10), BlockedExtensions (".exe,.bat,.cmd,.js"), AutoCloseDays (7), ReminderDays (3),
DefaultFirstResponseMinutes (480), DefaultResolutionMinutes (2880). Exceptions: NotFound, NotAllowed, InvalidTransition,
ValidationFailed. Roles: Agent, Manager.

## Tamanho

14 entidades, 6 static, 101 atributos (+18 das static, 30 records), 36 FKs (10 para User, 10 para static), 1 binario.
Indices explicitos (Number e Tag.Name unicos; pares unicos; Ticket por status e equipa, assignee e status, requester, prazo)
ficam por criar: a criacao de indices ainda nao esta nos verbos (interface ausente do catalogo).

## Regras que o modelo carrega

Status so por static e toda transicao gera TicketEvent; ResolvedOn/ClosedOn preenchem-se na transicao; prazos de SLA calculados
na criacao e recalculados ao mudar prioridade; timer varre prazos vencidos e escreve TicketSlaBreach; assignee tem de ser membro
da equipa; Number gerado a partir do Id; merge fecha o filho com ParentTicketId e move comentarios, anexos e watchers.
