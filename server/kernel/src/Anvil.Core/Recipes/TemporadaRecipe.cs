using OutSystems.Model;
using OutSystems.Model.Data;
using OutSystems.Model.Logic;
using OutSystems.Model.Logic.Nodes;
using OutSystems.Model.Types;
using ServiceStudio.Model;
using ServiceStudio.Model.API.V1;

namespace Anvil.Core;

/// <summary>
/// Spec docs/specs/casas-temporada-data-model.md escrita pelo Model API V1 num modulo Service:
/// 3 static entities com records, 9 entidades, 4 user exceptions, role Admin, 3 site properties,
/// 1 structure, 10 server actions e 1 timer. Carga do teste de tempo E2E (2026-09-03).
/// </summary>
public static class TemporadaRecipe
{
    public static DemoOutcome Run(ModelHost host, string basePath, string outPath, Action<string>? log = null)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var espace = host.Load(File.ReadAllBytes(basePath));
        var loadMs = sw.ElapsedMilliseconds;
        var before = ModelHost.Describe(espace, loadMs);
        log?.Invoke($"base {before.Name} ({before.Kind}): {before.Objects} objects, {before.Validation.Total} messages, load {loadMs} ms");
        var t1 = sw.ElapsedMilliseconds;
        var recipe = Apply(espace, log);
        var applyMs = sw.ElapsedMilliseconds - t1;
        var t2 = sw.ElapsedMilliseconds;
        var after = ModelHost.Describe(espace, 0);
        var verifyMs = sw.ElapsedMilliseconds - t2;
        log?.Invoke($"after: {after.Objects} objects (+{after.Objects - before.Objects}), {after.Validation.Total} messages, isValid={after.IsValid}, apply {applyMs} ms, verify {verifyMs} ms");
        var details = ModelHost.ValidationDetails(espace, 120);
        foreach (var m in details) log?.Invoke("  " + m);
        var t3 = sw.ElapsedMilliseconds;
        var bytes = host.Save(espace);
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outPath))!);
        File.WriteAllBytes(outPath, bytes);
        var saveMs = sw.ElapsedMilliseconds - t3;
        return new DemoOutcome(basePath, outPath, bytes.Length, loadMs, applyMs, verifyMs, saveMs,
            before.Objects, after.Objects, before.Validation, after.Validation, after.IsValid, recipe, details);
    }

    public static RecipeOutcome Apply(ESpace espace, Action<string>? log = null)
    {
        RecipeOutcome? result = null;
        Publisher.Mutate(espace, "SSHeadless: Temporada data model + business actions", e => result = new Builder((IESpace)e, log).Build());
        return result!;
    }

    // =====================================================================================
    private sealed class Builder : ModelBuilder
    {
        public Builder(IESpace es, Action<string>? log) : base(es, log) { }

        // =====================================================================================
        public RecipeOutcome Build()
        {
            var userId = UserIdType();
            L("User Identifier resolved from (System)");

            // ---- static entities ---------------------------------------------------------
            var bookingStatus = StaticEntity("BookingStatus", ("Pending", "Pending"), ("Confirmed", "Confirmed"), ("Cancelled", "Cancelled"), ("Completed", "Completed"));
            var txType = StaticEntity("TransactionType", ("Deposit", "Deposit"), ("Payment", "Payment"), ("Refund", "Refund"));
            var amenity = StaticEntity("Amenity", ("Wifi", "Wi-Fi"), ("Pool", "Pool"), ("Parking", "Parking"), ("AirConditioning", "Air conditioning"),
                ("Kitchen", "Kitchen"), ("PetFriendly", "Pet friendly"), ("Barbecue", "Barbecue"), ("Beachfront", "Beachfront"));

            // ---- entidades ---------------------------------------------------------------
            var profile = es.CreateServerEntity("UserProfile");
            profile.Description = "Perfil 1:1 com o User do sistema";
            EnsureIdentifier(profile, userId, autoNumber: false);
            profile.UpdateBehavior = OutSystems.Model.Enumerations.UpdateEntityBehaviorType.Optimized;
            Attr(profile, "Phone", Text, 20);
            Attr(profile, "Document", Text, 20);
            Attr(profile, "BirthDate", Date);
            Attr(profile, "Photo", Bin);
            Attr(profile, "Bio", Text, 500);
            Attr(profile, "CreatedOn", DateTime_);

            var wallet = Entity("Wallet", "Carteira de dinheiro ficticio, uma por usuario");
            Attr(wallet, "UserId", userId, mandatory: true);
            Attr(wallet, "Balance", Cur, mandatory: true, def: "0");
            Attr(wallet, "CreatedOn", DateTime_);
            Attr(wallet, "UpdatedOn", DateTime_);

            var home = Entity("VacationHome", "Casa de temporada", optimized: true);
            Attr(home, "Name", Text, 100, mandatory: true);
            Attr(home, "Description", Text, 2000);
            Attr(home, "AddressLine", Text, 200);
            Attr(home, "City", Text, 80, mandatory: true);
            Attr(home, "State", Text, 2);
            Attr(home, "PostalCode", Text, 10);
            Attr(home, "MaxGuests", Int, mandatory: true, def: "2");
            Attr(home, "Bedrooms", Int);
            Attr(home, "Bathrooms", Int);
            Attr(home, "DailyRate", Cur, mandatory: true);
            Attr(home, "CleaningFee", Cur, def: "0");
            Attr(home, "IsActive", Bool, def: "True");
            Attr(home, "CreatedOn", DateTime_);

            var homeAmenity = Entity("VacationHomeAmenity", "Comodidades de uma casa (N:N)");
            Attr(homeAmenity, "VacationHomeId", home.IdentifierType, mandatory: true);
            Attr(homeAmenity, "AmenityId", amenity.IdentifierType, mandatory: true);

            var photo = Entity("HomePhoto", "Fotos da casa");
            Attr(photo, "VacationHomeId", home.IdentifierType, mandatory: true);
            Attr(photo, "Image", Bin);
            Attr(photo, "Caption", Text, 200);
            Attr(photo, "IsCover", Bool, def: "False");
            Attr(photo, "SortOrder", Int, def: "0");

            var block = Entity("HomeUnavailability", "Datas bloqueadas pelo Admin");
            Attr(block, "VacationHomeId", home.IdentifierType, mandatory: true);
            Attr(block, "StartDate", Date, mandatory: true);
            Attr(block, "EndDate", Date, mandatory: true);
            Attr(block, "Reason", Text, 200);

            var booking = Entity("Booking", "Reserva", optimized: true);
            Attr(booking, "VacationHomeId", home.IdentifierType, mandatory: true);
            Attr(booking, "GuestId", userId, mandatory: true);
            Attr(booking, "CheckIn", Date, mandatory: true);
            Attr(booking, "CheckOut", Date, mandatory: true);
            Attr(booking, "Nights", Int);
            Attr(booking, "Guests", Int, def: "1");
            Attr(booking, "DailyRateSnapshot", Cur);
            Attr(booking, "CleaningFeeSnapshot", Cur);
            Attr(booking, "Total", Cur);
            Attr(booking, "StatusId", bookingStatus.IdentifierType, mandatory: true);
            Attr(booking, "CreatedOn", DateTime_);
            Attr(booking, "CancelledOn", DateTime_);

            var tx = Entity("WalletTransaction", "Livro-razao da carteira (imutavel)", optimized: true);
            Attr(tx, "WalletId", wallet.IdentifierType, mandatory: true);
            Attr(tx, "TypeId", txType.IdentifierType, mandatory: true);
            Attr(tx, "Amount", Cur, mandatory: true);
            Attr(tx, "BookingId", booking.IdentifierType);
            Attr(tx, "CreatedBy", userId);
            Attr(tx, "CreatedOn", DateTime_);
            Attr(tx, "Description", Text, 200);
            // FK tardia: Booking -> WalletTransaction (as duas se referenciam)
            Attr(booking, "PaymentTransactionId", tx.IdentifierType);

            var review = Entity("Review", "Avaliacao de uma reserva concluida");
            Attr(review, "BookingId", booking.IdentifierType, mandatory: true);
            Attr(review, "VacationHomeId", home.IdentifierType, mandatory: true);
            Attr(review, "GuestId", userId, mandatory: true);
            Attr(review, "Rating", Int, mandatory: true);
            Attr(review, "Comment", Text, 1000);
            Attr(review, "CreatedOn", DateTime_);
            L("entities: UserProfile, Wallet, WalletTransaction, VacationHome, VacationHomeAmenity, HomePhoto, HomeUnavailability, Booking, Review");

            // ---- structure de busca ------------------------------------------------------
            var result = es.CreateStructure("HomeSearchResult");
            result.Description = "Linha da busca de casas";
            result.Public = true;   // saida de action publica tem de ser publica
            foreach (var (n, t, len) in new (string, IBasicType, int?)[] { ("VacationHomeId", home.IdentifierType, null), ("Name", Text, 100), ("City", Text, 80), ("State", Text, 2),
                ("DailyRate", Cur, null), ("CleaningFee", Cur, null), ("MaxGuests", Int, null), ("CoverPhotoId", photo.IdentifierType, null), ("AvgRating", es.DecimalType, null), ("ReviewCount", Int, null) })
            {
                var sa = result.CreateAttribute(n);
                sa.DataType = t;
                if (len != null) sa.Length = len;
            }

            // ---- exceptions, role, site properties --------------------------------------
            var exFunds = es.CreateUserException("InsufficientFunds");
            var exNotAvail = es.CreateUserException("HomeNotAvailable");
            var exDates = es.CreateUserException("InvalidDates");
            var exNotAllowed = es.CreateUserException("NotAllowed");
            var admin = es.CreateRole("Admin");
            admin.Public = true;
            admin.Description = "Gerencia casas, bloqueios e creditos";
            SiteProp("CancellationRefundPercent", Int, "100", "Percentual devolvido no cancelamento");
            SiteProp("MinNights", Int, "1", "Minimo de noites por reserva");
            SiteProp("MaxAdvanceBookingDays", Int, "365", "Antecedencia maxima de uma reserva");
            L("exceptions 4, role Admin, site properties 3, structure HomeSearchResult");

            // ==== ACTIONS =================================================================
            // 1. Wallet_GetOrCreate
            var fGet = Action("Wallet_GetOrCreate", "Carteira do usuario; cria com saldo 0 (e o perfil) no primeiro acesso");
            In(fGet, "UserId", userId);
            Out(fGet, "WalletId", wallet.IdentifierType);
            Out(fGet, "Balance", Cur);
            Local(fGet, "NewWallet", wallet);
            Local(fGet, "NewProfile", profile);
            {
                var g = Agg(fGet, "GetWallet", wallet, "Wallet.UserId = UserId");
                var ifEmpty = If(fGet, "WalletMissing", "GetWallet.List.Empty");
                var found = Assign(fGet, "UseExisting", ColBranch, fGet.Row - 1,
                    ("WalletId", "GetWallet.List.Current.Wallet.Id"), ("Balance", "GetWallet.List.Current.Wallet.Balance"));
                var fill = Assign(fGet, "NewWalletValues",
                    ("NewWallet.UserId", "UserId"), ("NewWallet.Balance", "0"), ("NewWallet.CreatedOn", "CurrDateTime()"), ("NewWallet.UpdatedOn", "CurrDateTime()"));
                var create = Call(fGet, "CreateWallet", wallet.CreateAction, ColMain, null, ("Source", "NewWallet"));
                var gp = Agg(fGet, "GetProfile", profile, "UserProfile.Id = UserId");
                var ifNoProfile = If(fGet, "ProfileMissing", "GetProfile.List.Empty");
                var fillP = Assign(fGet, "NewProfileValues", ColBranch, fGet.Row - 1, ("NewProfile.Id", "UserId"), ("NewProfile.CreatedOn", "CurrDateTime()"));
                var createP = Call(fGet, "CreateProfile", profile.CreateAction, ColBranch, fGet.Row, ("Source", "NewProfile"));
                fGet.Row++;
                var outNew = Assign(fGet, "NewWalletOutputs", ("WalletId", "CreateWallet.Id"), ("Balance", "0"));
                Chain(fGet.Start, g, ifEmpty);
                ifEmpty.TrueTarget = fill; ifEmpty.FalseTarget = found; Next(found, fGet.End);
                Chain(fill, create, gp, ifNoProfile);
                ifNoProfile.TrueTarget = fillP; ifNoProfile.FalseTarget = outNew;
                Chain(fillP, createP, outNew); Next(outNew, fGet.End);
                Flow.Place(fGet.End, ColMain, fGet.Row);
            }

            // 2. Wallet_Deposit (Admin)
            var fDep = Action("Wallet_Deposit", "Admin credita dinheiro ficticio na carteira de um usuario");
            In(fDep, "UserId", userId);
            In(fDep, "Amount", Cur);
            In(fDep, "Note", Text, mandatory: false);
            Out(fDep, "TransactionId", tx.IdentifierType);
            Local(fDep, "Tx", tx);
            Local(fDep, "W", wallet);
            {
                var ifAdmin = If(fDep, "IsAdmin", "CheckAdminRole(GetUserId())");
                var raiseAdmin = Raise(fDep, "RaiseNotAdmin", exNotAllowed, "\"Only administrators can deposit\"", ColBranch, fDep.Row - 1);
                var ifAmount = If(fDep, "AmountIsPositive", "Amount > 0");
                var raiseAmt = Raise(fDep, "RaiseInvalidAmount", exNotAllowed, "\"Amount must be greater than zero\"", ColBranch, fDep.Row - 1);
                var getOrCreate = Call(fDep, "Wallet_GetOrCreate", fGet.Act, ColMain, null, ("UserId", "UserId"));
                var fillTx = Assign(fDep, "TxValues",
                    ("Tx.WalletId", "Wallet_GetOrCreate.WalletId"), ("Tx.TypeId", "Entities.TransactionType.Deposit"), ("Tx.Amount", "Amount"),
                    ("Tx.CreatedBy", "GetUserId()"), ("Tx.CreatedOn", "CurrDateTime()"), ("Tx.Description", "Note"));
                var createTx = Call(fDep, "CreateTransaction", tx.CreateAction, ColMain, null, ("Source", "Tx"));
                var gw = Agg(fDep, "GetWallet", wallet, "Wallet.Id = Wallet_GetOrCreate.WalletId");
                var upd = Assign(fDep, "AddToBalance", ("W", "GetWallet.List.Current.Wallet"), ("W.Balance", "W.Balance + Amount"), ("W.UpdatedOn", "CurrDateTime()"));
                var updW = Call(fDep, "UpdateWallet", wallet.UpdateAction, ColMain, null, ("Source", "W"));
                var outT = Assign(fDep, "SetOutput", ("TransactionId", "CreateTransaction.Id"));
                Next(fDep.Start, ifAdmin); ifAdmin.FalseTarget = raiseAdmin; ifAdmin.TrueTarget = ifAmount;
                ifAmount.FalseTarget = raiseAmt; ifAmount.TrueTarget = getOrCreate;
                Chain(getOrCreate, fillTx, createTx, gw, upd, updW, outT, fDep.End);
                Flow.Place(fDep.End, ColMain, fDep.Row);
            }

            // 3. Wallet_Debit (interna)
            var fDeb = Action("Wallet_Debit", "Debita o pagamento de uma reserva; falha com InsufficientFunds", isPublic: false);
            In(fDeb, "WalletId", wallet.IdentifierType);
            In(fDeb, "Amount", Cur);
            In(fDeb, "BookingId", booking.IdentifierType);
            Out(fDeb, "TransactionId", tx.IdentifierType);
            Local(fDeb, "Tx", tx);
            Local(fDeb, "W", wallet);
            {
                var gw = Agg(fDeb, "GetWallet", wallet, "Wallet.Id = WalletId");
                var ifFunds = If(fDeb, "HasFunds", "GetWallet.List.Current.Wallet.Balance >= Amount");
                var raiseF = Raise(fDeb, "RaiseInsufficientFunds", exFunds, "\"Insufficient funds: balance \" + GetWallet.List.Current.Wallet.Balance + \", required \" + Amount", ColBranch, fDeb.Row - 1);
                var fillTx = Assign(fDeb, "TxValues",
                    ("Tx.WalletId", "WalletId"), ("Tx.TypeId", "Entities.TransactionType.Payment"), ("Tx.Amount", "Amount"), ("Tx.BookingId", "BookingId"),
                    ("Tx.CreatedBy", "GetUserId()"), ("Tx.CreatedOn", "CurrDateTime()"), ("Tx.Description", "\"Payment for booking \" + BookingId"));
                var createTx = Call(fDeb, "CreateTransaction", tx.CreateAction, ColMain, null, ("Source", "Tx"));
                var upd = Assign(fDeb, "SubtractFromBalance", ("W", "GetWallet.List.Current.Wallet"), ("W.Balance", "W.Balance - Amount"), ("W.UpdatedOn", "CurrDateTime()"));
                var updW = Call(fDeb, "UpdateWallet", wallet.UpdateAction, ColMain, null, ("Source", "W"));
                var outT = Assign(fDeb, "SetOutput", ("TransactionId", "CreateTransaction.Id"));
                Chain(fDeb.Start, gw, ifFunds); ifFunds.FalseTarget = raiseF; ifFunds.TrueTarget = fillTx;
                Chain(fillTx, createTx, upd, updW, outT, fDeb.End);
                Flow.Place(fDeb.End, ColMain, fDeb.Row);
            }

            // 4. Wallet_Refund (interna)
            var fRef = Action("Wallet_Refund", "Credita o reembolso de um cancelamento", isPublic: false);
            In(fRef, "WalletId", wallet.IdentifierType);
            In(fRef, "Amount", Cur);
            In(fRef, "BookingId", booking.IdentifierType);
            Out(fRef, "TransactionId", tx.IdentifierType);
            Local(fRef, "Tx", tx);
            Local(fRef, "W", wallet);
            {
                var gw = Agg(fRef, "GetWallet", wallet, "Wallet.Id = WalletId");
                var fillTx = Assign(fRef, "TxValues",
                    ("Tx.WalletId", "WalletId"), ("Tx.TypeId", "Entities.TransactionType.Refund"), ("Tx.Amount", "Amount"), ("Tx.BookingId", "BookingId"),
                    ("Tx.CreatedBy", "GetUserId()"), ("Tx.CreatedOn", "CurrDateTime()"), ("Tx.Description", "\"Refund for booking \" + BookingId"));
                var createTx = Call(fRef, "CreateTransaction", tx.CreateAction, ColMain, null, ("Source", "Tx"));
                var upd = Assign(fRef, "AddToBalance", ("W", "GetWallet.List.Current.Wallet"), ("W.Balance", "W.Balance + Amount"), ("W.UpdatedOn", "CurrDateTime()"));
                var updW = Call(fRef, "UpdateWallet", wallet.UpdateAction, ColMain, null, ("Source", "W"));
                var outT = Assign(fRef, "SetOutput", ("TransactionId", "CreateTransaction.Id"));
                Chain(fRef.Start, gw, fillTx, createTx, upd, updW, outT, fRef.End);
                Flow.Place(fRef.End, ColMain, fRef.Row);
            }

            // 5. Booking_Quote
            var fQuote = Action("Booking_Quote", "Valida datas, capacidade e disponibilidade e calcula o total");
            In(fQuote, "HomeId", home.IdentifierType);
            In(fQuote, "CheckIn", Date);
            In(fQuote, "CheckOut", Date);
            In(fQuote, "Guests", Int);
            Out(fQuote, "Nights", Int);
            Out(fQuote, "Total", Cur);
            Out(fQuote, "IsAvailable", Bool);
            Out(fQuote, "Reason", Text);
            {
                var init = Assign(fQuote, "Init", ("IsAvailable", "True"), ("Reason", "\"\""), ("Nights", "DiffDays(CheckIn, CheckOut)"), ("Total", "0"));
                var ifDates = If(fQuote, "DatesAreValid",
                    "CheckOut > CheckIn and Nights >= Site.MinNights and CheckIn >= CurrDate() and DiffDays(CurrDate(), CheckIn) <= Site.MaxAdvanceBookingDays");
                var badDates = Assign(fQuote, "InvalidDates", ColBranch, fQuote.Row - 1, ("IsAvailable", "False"), ("Reason", "\"Invalid dates\""));
                var gh = Agg(fQuote, "GetHome", home, "VacationHome.Id = HomeId and VacationHome.IsActive");
                var ifHome = If(fQuote, "HomeExists", "GetHome.List.Empty");
                var noHome = Assign(fQuote, "HomeNotFound", ColBranch, fQuote.Row - 1, ("IsAvailable", "False"), ("Reason", "\"Home not found or inactive\""));
                var ifGuests = If(fQuote, "GuestsFit", "Guests <= GetHome.List.Current.VacationHome.MaxGuests and Guests > 0");
                var tooMany = Assign(fQuote, "TooManyGuests", ColBranch, fQuote.Row - 1, ("IsAvailable", "False"), ("Reason", "\"Exceeds the maximum number of guests\""));
                var go = Agg(fQuote, "GetOverlaps", booking,
                    "Booking.VacationHomeId = HomeId and (Booking.StatusId = Entities.BookingStatus.Pending or Booking.StatusId = Entities.BookingStatus.Confirmed) and Booking.CheckIn < CheckOut and Booking.CheckOut > CheckIn");
                var ifOverlap = If(fQuote, "NoOverlap", "GetOverlaps.List.Empty");
                var booked = Assign(fQuote, "AlreadyBooked", ColBranch, fQuote.Row - 1, ("IsAvailable", "False"), ("Reason", "\"Already booked for these dates\""));
                var gb = Agg(fQuote, "GetBlocks", block, "HomeUnavailability.VacationHomeId = HomeId and HomeUnavailability.StartDate < CheckOut and HomeUnavailability.EndDate > CheckIn");
                var ifBlock = If(fQuote, "NotBlocked", "GetBlocks.List.Empty");
                var blocked = Assign(fQuote, "Unavailable", ColBranch, fQuote.Row - 1, ("IsAvailable", "False"), ("Reason", "\"Home unavailable for these dates\""));
                var total = Assign(fQuote, "ComputeTotal", ("Total", "Nights * GetHome.List.Current.VacationHome.DailyRate + GetHome.List.Current.VacationHome.CleaningFee"));
                Chain(fQuote.Start, init, ifDates); ifDates.FalseTarget = badDates; Next(badDates, fQuote.End); ifDates.TrueTarget = gh;
                Chain(gh, ifHome); ifHome.TrueTarget = noHome; Next(noHome, fQuote.End); ifHome.FalseTarget = ifGuests;
                ifGuests.FalseTarget = tooMany; Next(tooMany, fQuote.End); ifGuests.TrueTarget = go;
                Chain(go, ifOverlap); ifOverlap.FalseTarget = booked; Next(booked, fQuote.End); ifOverlap.TrueTarget = gb;
                Chain(gb, ifBlock); ifBlock.FalseTarget = blocked; Next(blocked, fQuote.End); ifBlock.TrueTarget = total;
                Next(total, fQuote.End);
                Flow.Place(fQuote.End, ColMain, fQuote.Row);
            }

            // 6. Booking_Create
            var fCreate = Action("Booking_Create", "Cota, debita a carteira e grava a reserva confirmada");
            In(fCreate, "HomeId", home.IdentifierType);
            In(fCreate, "CheckIn", Date);
            In(fCreate, "CheckOut", Date);
            In(fCreate, "Guests", Int);
            Out(fCreate, "BookingId", booking.IdentifierType);
            Out(fCreate, "Total", Cur);
            Local(fCreate, "NewBooking", booking);
            {
                var quote = Call(fCreate, "Booking_Quote", fQuote.Act, ColMain, null, ("HomeId", "HomeId"), ("CheckIn", "CheckIn"), ("CheckOut", "CheckOut"), ("Guests", "Guests"));
                var ifAvail = If(fCreate, "IsAvailable", "Booking_Quote.IsAvailable");
                var raiseNA = Raise(fCreate, "RaiseNotAvailable", exNotAvail, "Booking_Quote.Reason", ColBranch, fCreate.Row - 1);
                var w = Call(fCreate, "Wallet_GetOrCreate", fGet.Act, ColMain, null, ("UserId", "GetUserId()"));
                var gh = Agg(fCreate, "GetHome", home, "VacationHome.Id = HomeId");
                var fill = Assign(fCreate, "BookingValues",
                    ("NewBooking.VacationHomeId", "HomeId"), ("NewBooking.GuestId", "GetUserId()"), ("NewBooking.CheckIn", "CheckIn"), ("NewBooking.CheckOut", "CheckOut"),
                    ("NewBooking.Nights", "Booking_Quote.Nights"), ("NewBooking.Guests", "Guests"),
                    ("NewBooking.DailyRateSnapshot", "GetHome.List.Current.VacationHome.DailyRate"), ("NewBooking.CleaningFeeSnapshot", "GetHome.List.Current.VacationHome.CleaningFee"),
                    ("NewBooking.Total", "Booking_Quote.Total"), ("NewBooking.StatusId", "Entities.BookingStatus.Confirmed"), ("NewBooking.CreatedOn", "CurrDateTime()"));
                var create = Call(fCreate, "CreateBooking", booking.CreateAction, ColMain, null, ("Source", "NewBooking"));
                var debit = Call(fCreate, "Wallet_Debit", fDeb.Act, ColMain, null, ("WalletId", "Wallet_GetOrCreate.WalletId"), ("Amount", "Booking_Quote.Total"), ("BookingId", "CreateBooking.Id"));
                var link = Assign(fCreate, "LinkPayment", ("NewBooking.Id", "CreateBooking.Id"), ("NewBooking.PaymentTransactionId", "Wallet_Debit.TransactionId"));
                var upd = Call(fCreate, "UpdateBooking", booking.UpdateAction, ColMain, null, ("Source", "NewBooking"));
                var outs = Assign(fCreate, "SetOutputs", ("BookingId", "CreateBooking.Id"), ("Total", "Booking_Quote.Total"));
                Chain(fCreate.Start, quote, ifAvail); ifAvail.FalseTarget = raiseNA; ifAvail.TrueTarget = w;
                Chain(w, gh, fill, create, debit, link, upd, outs, fCreate.End);
                Flow.Place(fCreate.End, ColMain, fCreate.Row);
            }

            // 7. Booking_Cancel
            var fCancel = Action("Booking_Cancel", "Cancela uma reserva confirmada antes do check-in e reembolsa o percentual configurado");
            In(fCancel, "BookingId", booking.IdentifierType);
            Out(fCancel, "RefundAmount", Cur);
            Local(fCancel, "B", booking);
            {
                var gb = Agg(fCancel, "GetBooking", booking, "Booking.Id = BookingId");
                var ifFound = If(fCancel, "BookingExists", "GetBooking.List.Empty");
                var raiseNF = Raise(fCancel, "RaiseNotFound", exNotAllowed, "\"Booking not found\"", ColBranch, fCancel.Row - 1);
                var ifOwner = If(fCancel, "IsGuestOrAdmin", "GetBooking.List.Current.Booking.GuestId = GetUserId() or CheckAdminRole(GetUserId())");
                var raiseOwner = Raise(fCancel, "RaiseNotAllowed", exNotAllowed, "\"Only the guest or an administrator can cancel this booking\"", ColBranch, fCancel.Row - 1);
                var ifStatus = If(fCancel, "CanCancel", "GetBooking.List.Current.Booking.StatusId = Entities.BookingStatus.Confirmed and GetBooking.List.Current.Booking.CheckIn > CurrDate()");
                var raiseSt = Raise(fCancel, "RaiseCannotCancel", exDates, "\"Only confirmed bookings before check-in can be cancelled\"", ColBranch, fCancel.Row - 1);
                var calc = Assign(fCancel, "ComputeRefund", ("RefundAmount", "GetBooking.List.Current.Booking.Total * Site.CancellationRefundPercent / 100"));
                var gw = Agg(fCancel, "GetWallet", wallet, "Wallet.UserId = GetBooking.List.Current.Booking.GuestId");
                var ifRefund = If(fCancel, "HasRefund", "RefundAmount > 0 and not GetWallet.List.Empty");
                var refund = Call(fCancel, "Wallet_Refund", fRef.Act, ColBranch, fCancel.Row - 1, ("WalletId", "GetWallet.List.Current.Wallet.Id"), ("Amount", "RefundAmount"), ("BookingId", "BookingId"));
                var mark = Assign(fCancel, "MarkCancelled", ("B", "GetBooking.List.Current.Booking"), ("B.StatusId", "Entities.BookingStatus.Cancelled"), ("B.CancelledOn", "CurrDateTime()"));
                var upd = Call(fCancel, "UpdateBooking", booking.UpdateAction, ColMain, null, ("Source", "B"));
                Chain(fCancel.Start, gb, ifFound); ifFound.TrueTarget = raiseNF; ifFound.FalseTarget = ifOwner;
                ifOwner.FalseTarget = raiseOwner; ifOwner.TrueTarget = ifStatus;
                ifStatus.FalseTarget = raiseSt; ifStatus.TrueTarget = calc;
                Chain(calc, gw, ifRefund); ifRefund.TrueTarget = refund; Next(refund, mark); ifRefund.FalseTarget = mark;
                Chain(mark, upd, fCancel.End);
                Flow.Place(fCancel.End, ColMain, fCancel.Row);
            }

            // 8. Booking_CompletePastStays (timer)
            var fDone = Action("Booking_CompletePastStays", "Timer diario: reservas confirmadas com check-out passado viram Completed");
            Out(fDone, "Count", Int);
            Local(fDone, "B", booking);
            {
                var init = Assign(fDone, "Init", ("Count", "0"));
                var gp = Agg(fDone, "GetPastStays", booking, "Booking.StatusId = Entities.BookingStatus.Confirmed and Booking.CheckOut < CurrDate()");
                var loop = ForEach(fDone, "ForEachStay", "GetPastStays.List");
                var loopRow = fDone.Row - 1;
                var mark = Assign(fDone, "MarkCompleted", ColBranch, loopRow, ("B", "GetPastStays.List.Current.Booking"), ("B.StatusId", "Entities.BookingStatus.Completed"));
                var upd = Call(fDone, "UpdateBooking", booking.UpdateAction, ColBranch, loopRow + 1, ("Source", "B"));
                var inc = Assign(fDone, "Increment", ColBranch, loopRow + 2, ("Count", "Count + 1"));
                fDone.Row = loopRow + 3;
                Chain(fDone.Start, init, gp, loop);
                loop.CycleTarget = mark; Chain(mark, upd, inc); Next(inc, loop);
                loop.Target = fDone.End;
                Flow.Place(fDone.End, ColMain, fDone.Row);
                var timer = es.CreateTimer("CompletePastStays");
                timer.Action = fDone.Act;
                timer.Description = "Diario, de madrugada";
            }

            // 9. Home_Search (SQL)
            var fSearch = Action("Home_Search", "Casas ativas com capacidade e sem conflito de datas, com capa e media de avaliacao");
            In(fSearch, "City", Text, mandatory: false);
            In(fSearch, "CheckIn", Date);
            In(fSearch, "CheckOut", Date);
            In(fSearch, "Guests", Int);
            {
                var sql = Node<ISQLNode>(fSearch, "SearchHomes");
                sql.Statement = @"SELECT {VacationHome}.[Id], {VacationHome}.[Name], {VacationHome}.[City], {VacationHome}.[State],
       {VacationHome}.[DailyRate], {VacationHome}.[CleaningFee], {VacationHome}.[MaxGuests],
       (SELECT TOP 1 {HomePhoto}.[Id] FROM {HomePhoto} WHERE {HomePhoto}.[VacationHomeId] = {VacationHome}.[Id] ORDER BY {HomePhoto}.[IsCover] DESC, {HomePhoto}.[SortOrder]) AS CoverPhotoId,
       ISNULL((SELECT AVG(CAST({Review}.[Rating] AS DECIMAL(4,2))) FROM {Review} WHERE {Review}.[VacationHomeId] = {VacationHome}.[Id]), 0) AS AvgRating,
       (SELECT COUNT(1) FROM {Review} WHERE {Review}.[VacationHomeId] = {VacationHome}.[Id]) AS ReviewCount
FROM {VacationHome}
WHERE {VacationHome}.[IsActive] = 1
  AND {VacationHome}.[MaxGuests] >= @Guests
  AND (@City = '' OR {VacationHome}.[City] LIKE '%' + @City + '%')
  AND NOT EXISTS (SELECT 1 FROM {Booking}
                  WHERE {Booking}.[VacationHomeId] = {VacationHome}.[Id]
                    AND {Booking}.[StatusId] IN (@Pending, @Confirmed)
                    AND {Booking}.[CheckIn] < @CheckOut AND {Booking}.[CheckOut] > @CheckIn)
  AND NOT EXISTS (SELECT 1 FROM {HomeUnavailability}
                  WHERE {HomeUnavailability}.[VacationHomeId] = {VacationHome}.[Id]
                    AND {HomeUnavailability}.[StartDate] < @CheckOut AND {HomeUnavailability}.[EndDate] > @CheckIn)
ORDER BY {VacationHome}.[Name]";
                foreach (var (pn, pt) in new (string, IBasicType)[] { ("City", Text), ("Guests", Int), ("CheckIn", Date), ("CheckOut", Date), ("Pending", bookingStatus.IdentifierType), ("Confirmed", bookingStatus.IdentifierType) })
                {
                    var p = sql.CreateInputParameter(pn);
                    p.DataType = pt;
                }
                sql.CreateOutput(result, "List");
                var argNames = new List<string>();
                foreach (var arg in sql.Arguments)
                {
                    var an = arg.Parameter?.Name ?? "?";
                    argNames.Add(an);
                    arg.SetValue(an switch { "Pending" => "Entities.BookingStatus.Pending", "Confirmed" => "Entities.BookingStatus.Confirmed", _ => an });
                }
                L($"  SQL arguments: {string.Join(",", argNames)}");
                var outHomes = Out(fSearch, "Homes", sql.Type);
                var set = Assign(fSearch, "SetOutput", ("Homes", "SearchHomes.List"));
                Chain(fSearch.Start, sql, set, fSearch.End);
                Flow.Place(fSearch.End, ColMain, fSearch.Row);
            }

            // 10. Review_Create
            var fRev = Action("Review_Create", "Avaliacao do hospede de uma reserva concluida, uma por reserva");
            In(fRev, "BookingId", booking.IdentifierType);
            In(fRev, "Rating", Int);
            In(fRev, "Comment", Text, mandatory: false);
            Out(fRev, "ReviewId", review.IdentifierType);
            Local(fRev, "R", review);
            {
                var ifRating = If(fRev, "RatingIsValid", "Rating >= 1 and Rating <= 5");
                var raiseR = Raise(fRev, "RaiseInvalidRating", exNotAllowed, "\"Rating must be between 1 and 5\"", ColBranch, fRev.Row - 1);
                var gb = Agg(fRev, "GetBooking", booking, "Booking.Id = BookingId");
                var ifGuest = If(fRev, "IsGuest", "not GetBooking.List.Empty and GetBooking.List.Current.Booking.GuestId = GetUserId()");
                var raiseG = Raise(fRev, "RaiseNotGuest", exNotAllowed, "\"Only the guest of this booking can review it\"", ColBranch, fRev.Row - 1);
                var ifDone = If(fRev, "StayCompleted", "GetBooking.List.Current.Booking.StatusId = Entities.BookingStatus.Completed");
                var raiseD = Raise(fRev, "RaiseNotCompleted", exNotAllowed, "\"Only completed stays can be reviewed\"", ColBranch, fRev.Row - 1);
                var ge = Agg(fRev, "GetExistingReview", review, "Review.BookingId = BookingId");
                var ifDup = If(fRev, "NotReviewedYet", "GetExistingReview.List.Empty");
                var raiseDup = Raise(fRev, "RaiseAlreadyReviewed", exNotAllowed, "\"This booking was already reviewed\"", ColBranch, fRev.Row - 1);
                var fill = Assign(fRev, "ReviewValues",
                    ("R.BookingId", "BookingId"), ("R.VacationHomeId", "GetBooking.List.Current.Booking.VacationHomeId"), ("R.GuestId", "GetUserId()"),
                    ("R.Rating", "Rating"), ("R.Comment", "Comment"), ("R.CreatedOn", "CurrDateTime()"));
                var create = Call(fRev, "CreateReview", review.CreateAction, ColMain, null, ("Source", "R"));
                var outR = Assign(fRev, "SetOutput", ("ReviewId", "CreateReview.Id"));
                Next(fRev.Start, ifRating); ifRating.FalseTarget = raiseR; ifRating.TrueTarget = gb;
                Chain(gb, ifGuest); ifGuest.FalseTarget = raiseG; ifGuest.TrueTarget = ifDone;
                ifDone.FalseTarget = raiseD; ifDone.TrueTarget = ge;
                Chain(ge, ifDup); ifDup.FalseTarget = raiseDup; ifDup.TrueTarget = fill;
                Chain(fill, create, outR, fRev.End);
                Flow.Place(fRev.End, ColMain, fRev.Row);
            }

            foreach (var f in new[] { fGet, fDep, fDeb, fRef, fQuote, fCreate, fCancel, fDone, fSearch, fRev })
            {
                var lo = FlowLayout.Apply(f.Act);
                L($"  layout {lo.Action}: {lo.Rows} rows x {lo.Columns} cols");
            }
            L($"actions {actions}, nodes {nodes}, assignments {assignments}, timer 1");
            return new RecipeOutcome(fCreate.Act.ObjectKey.ToString(), home.ObjectKey.ToString(), booking.ObjectKey.ToString(), nodes, assignments, lines);
        }
    }
}
