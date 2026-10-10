# Casas de Temporada: data model (spec, 2026-09-03)

Reactive O11. Modulos: `Temporada_CS` (entidades, static entities, regras) e `Temporada_UI` (telas).
Sem integracoes externas. Pagamento com dinheiro ficticio numa carteira interna: o Admin credita, o
usuario so gasta. Usuarios vem do modulo Users (User Identifier).

## Static entities

| Static | Records |
|---|---|
| BookingStatus | Pending, Confirmed, Cancelled, Completed |
| TransactionType | Deposit (admin credita), Payment (reserva debita), Refund (cancelamento credita) |
| Amenity | Wifi, Pool, Parking, AirConditioning, Kitchen, PetFriendly, Barbecue, Beachfront |

## Usuarios

Os usuarios sao a entidade de sistema `User` (modulo Users: Id, Name, Username, Email, IsActive, roles,
login e administracao prontos). Todo `UserId`/`GuestId`/`CreatedBy` deste modelo e `User Identifier`.
O que o `User` nao tem fica num perfil 1:1:

| Entidade | Atributos | Regras |
|---|---|---|
| UserProfile | Id (User Identifier, PK = o proprio User), Phone (20), Document (20, CPF), BirthDate (Date), Photo (Binary), Bio (500), CreatedOn | criado no 1o acesso junto com a Wallet; Admin ve todos |

## Entidades

| Entidade | Atributos | Regras |
|---|---|---|
| Wallet | Id, UserId (User Identifier, unico), Balance (Currency), CreatedOn, UpdatedOn | 1 por usuario, criada no 1o acesso; Balance nunca negativo; so muda por WalletTransaction |
| WalletTransaction | Id, WalletId (FK), TypeId (TransactionType), Amount (Currency > 0), BookingId (FK Booking, opcional), CreatedBy (User Identifier), CreatedOn, Description (Text 200) | livro-razao imutavel; Balance = soma(Deposit + Refund) - soma(Payment) |
| VacationHome | Id, Name (100, obrig.), Description (2000), AddressLine (200), City (80), State (2), PostalCode (10), MaxGuests (Int), Bedrooms (Int), Bathrooms (Int), DailyRate (Currency), CleaningFee (Currency), IsActive (Bool, default True), CreatedOn | so Admin cria/edita; inativa nao aparece na busca |
| VacationHomeAmenity | Id, VacationHomeId (FK), AmenityId (Amenity) | juncao N:N; indice unico (VacationHomeId, AmenityId) |
| HomePhoto | Id, VacationHomeId (FK), Image (Binary), Caption (200), IsCover (Bool), SortOrder (Int) | 1 capa por casa |
| HomeUnavailability | Id, VacationHomeId (FK), StartDate, EndDate, Reason (200) | Admin bloqueia datas (manutencao) |
| Booking | Id, VacationHomeId (FK), GuestId (User Identifier), CheckIn (Date), CheckOut (Date), Nights (Int), Guests (Int), DailyRateSnapshot (Currency), CleaningFeeSnapshot (Currency), Total (Currency), StatusId (BookingStatus), CreatedOn, CancelledOn (DateTime), PaymentTransactionId (FK WalletTransaction) | CheckOut > CheckIn; Guests <= MaxGuests; sem sobreposicao com Confirmed/Pending nem com HomeUnavailability; Total = Nights*DailyRate + CleaningFee, congelado no snapshot |
| Review | Id, BookingId (FK, unico), VacationHomeId (FK), GuestId (User Identifier), Rating (Int 1..5), Comment (1000), CreatedOn | so o hospede de uma reserva Completed, 1 por reserva |

Indices: Wallet(UserId) unico; WalletTransaction(WalletId, CreatedOn); Booking(VacationHomeId, CheckIn);
Booking(GuestId); Review(BookingId) unico; VacationHomeAmenity(VacationHomeId, AmenityId) unico.

## Roles

| Role | Pode |
|---|---|
| Admin | CRUD de casas, fotos, comodidades e bloqueios; creditar carteiras; ver todas as reservas |
| Registered (padrao) | buscar casas, ver saldo e extrato, reservar (debita), cancelar (reembolso), avaliar |

## Site properties

`CancellationRefundPercent` (Int, 100), `MinNights` (Int, 1), `MaxAdvanceBookingDays` (Int, 365).

## Actions de negocio (Temporada_CS) - a carga do teste de tempo

| Action | Assinatura | Fluxo |
|---|---|---|
| Wallet_GetOrCreate | (UserId) -> WalletId, Balance | aggregate por UserId; se vazio, cria com 0 (e o UserProfile, se faltar) |
| Wallet_Deposit | (UserId, Amount, Note) -> TransactionId | Admin; Amount > 0; cria Deposit; Balance += Amount |
| Wallet_Debit | (WalletId, Amount, BookingId) -> TransactionId | interna; Balance >= Amount senao exception InsufficientFunds; cria Payment; Balance -= Amount |
| Wallet_Refund | (WalletId, Amount, BookingId) -> TransactionId | interna; cria Refund; Balance += Amount |
| Booking_Quote | (HomeId, CheckIn, CheckOut, Guests) -> Nights, Total, IsAvailable, Reason | valida datas, MinNights, MaxGuests; verifica sobreposicao (Booking + HomeUnavailability); calcula Total |
| Booking_Create | (HomeId, CheckIn, CheckOut, Guests) -> BookingId, Total | Booking_Quote; exception se indisponivel; Wallet_GetOrCreate; Wallet_Debit; cria Booking Confirmed com snapshots e PaymentTransactionId |
| Booking_Cancel | (BookingId) -> RefundAmount | so o hospede ou Admin; so Confirmed e antes do CheckIn; Refund = Total * CancellationRefundPercent/100; Wallet_Refund; status Cancelled, CancelledOn |
| Booking_CompletePastStays | () -> Count | timer diario: Confirmed com CheckOut < hoje -> Completed |
| Home_Search | (City, CheckIn, CheckOut, Guests) -> HomeList | casas ativas, MaxGuests >= Guests, sem sobreposicao no periodo, com capa e media de Rating |
| Review_Create | (BookingId, Rating, Comment) -> ReviewId | so o hospede, reserva Completed, 1 por reserva, Rating 1..5 |

User exceptions: InsufficientFunds, HomeNotAvailable, InvalidDates, NotAllowed.

## Telas (Temporada_UI)

Busca de casas; Detalhe da casa (fotos, comodidades, avaliacoes, cotacao + reservar); Minhas reservas
(cancelar, avaliar); Minha carteira (saldo, extrato); Meu perfil; Admin: Casas (lista + editar, fotos, comodidades,
bloqueios), Carteiras (creditar, com busca por usuario), Usuarios (perfis), Reservas (todas).
