create entity HxHub public (Id Long Integer identifier auto required, Owner User Identifier required, Name Text(100), Budget Decimal, Committed Decimal, Spent Decimal, Capacity Decimal, Used Decimal, Active Boolean, Version Integer);
create entity HxLot public (Id Long Integer identifier auto required, HubId HxHub Identifier required, Code Text(80), Product Text(80), Quantity Decimal, Reserved Decimal, Expiry Date Time, MinTemp Decimal, MaxTemp Decimal, State Integer, Version Integer);
create unique index HxLotCode on HxLot (HubId, Code);
create entity HxDemand public (Id Long Integer identifier auto required, HubId HxHub Identifier required, Product Text(80), Requested Decimal, Allocated Decimal, Delivered Decimal, Priority Integer, Deadline Date Time, State Integer, Version Integer);
create entity HxReservation public (Id Long Integer identifier auto required, DemandId HxDemand Identifier required, LotId HxLot Identifier required, Quantity Decimal, Picked Decimal, Delivered Decimal, State Integer, Version Integer);
create entity HxTrip public (Id Long Integer identifier auto required, HubId HxHub Identifier required, Driver User Identifier, Capacity Decimal, Loaded Decimal, Cost Decimal, Distance Decimal, State Integer, Departed Date Time, Arrived Date Time, Version Integer);
create entity HxCargo public (Id Long Integer identifier auto required, TripId HxTrip Identifier required, ReservationId HxReservation Identifier required, Quantity Decimal, Accepted Decimal, Rejected Decimal, State Integer);
create entity HxDonation public (Id Long Integer identifier auto required, HubId HxHub Identifier required, Donor Text(100), Pledged Decimal, Received Decimal, Refunded Decimal, Restricted Boolean, Purpose Text(100), State Integer, Version Integer);
create entity HxInvoice public (Id Long Integer identifier auto required, HubId HxHub Identifier required, Supplier Text(100), Net Decimal, Tax Decimal, Retained Decimal, Paid Decimal, Credit Decimal, State Integer, Version Integer);
create entity HxRepair public (Id Long Integer identifier auto required, HubId HxHub Identifier required, Asset Text(80), Estimate Decimal, Actual Decimal, Severity Integer, State Integer, Opened Date Time, Due Date Time, Version Integer);
create entity HxJournal public (Id Long Integer identifier auto required, HubId HxHub Identifier required, Category Text(40), RefId Long Integer, Amount Decimal, Note Text(500), At Date Time, Actor User Identifier);
create entity HxReading public (Id Long Integer identifier auto required, LotId HxLot Identifier required, Sequence Integer, Value Decimal, At Date Time, Excursion Boolean);
create unique index HxReadingSequence on HxReading (LotId, Sequence);
type HxMetric public = {Key: Text(100); Count: Long Integer; Amount: Decimal; Other: Decimal;}
type HxItem public = {Key: Text(100); Value: Decimal; Weight: Decimal; Limit: Decimal; Flag: Boolean; Rank: Integer;}
type HxPoint public = {X: Decimal; Y: Decimal; At: Date Time; Flag: Boolean;}
type HxAffected = {Count: Integer;}
