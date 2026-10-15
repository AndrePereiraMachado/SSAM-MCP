/// The states of a ticket.
create static entity TicketState public (
  Id Integer identifier required,
  Label Text(50) required,
  Order Integer required
)
values
  Open (Id = 1, Label = "Open", Order = 1),
  Closed (Id = 2, Label = "Closed", Order = 2);

/// A customer of the help desk; deleting it is refused while its tickets exist.
create entity Customer public label Name active IsActive (
  Id Long Integer identifier auto required,
  Name Text(120) required,
  Email Email(250) required,
  IsActive Boolean required default True,
  CreatedBy User Identifier references User on delete Ignore
);
create unique index UX_Customer_Email on Customer (Email);

/// A ticket opened by a customer; two references to the same entity (opened by, assigned to), a reference named after its
/// entity, a reference to itself and a date range filter on its index.
create entity Ticket public label Title (
  Id Long Integer identifier auto required,
  Title Text(200) required,
  CustomerId Customer Identifier required references Customer on delete Protect,
  TicketState TicketState Identifier required references TicketState on delete Protect,
  ParentTicketId Ticket Identifier references Ticket on delete Protect,
  OpenedBy User Identifier required references User on delete Ignore,
  AssignedTo User Identifier references User on delete Ignore,
  OpenedOn Date Time required default CurrDateTime(),
  DueDate Date,
  Notes Text(2000)
);
create index IX_Ticket_OpenedOn on Ticket (OpenedOn);
create unique index UX_Ticket_Customer_Title on Ticket (CustomerId, Title);

/// A comment of a ticket, deleted with it.
create entity TicketComment (
  Id Long Integer identifier auto required,
  TicketId Ticket Identifier required references Ticket on delete Delete,
  Body Text(1000) required,
  CreatedBy User Identifier references User on delete Ignore
);

/// A tag with a natural key (a text identifier, no auto number).
create entity Tag public label Code (
  Code Text(30) identifier required,
  Description Text(200)
);
