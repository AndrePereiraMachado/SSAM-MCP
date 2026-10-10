using OutSystems.Model;
using OutSystems.Model.Data;
using OutSystems.Model.Logic;
using OutSystems.Model.Logic.Nodes;
using ServiceStudio.Model;
using ServiceStudio.Model.API.V1;

namespace Anvil.Core;

public sealed record RecipeOutcome(
    string ActionKey, string HomeEntityKey, string BookingEntityKey, int Nodes, int Assignments, IReadOnlyList<string> Log);

/// <summary>
/// Modelo + action complexa de um app de aluguel de casas de temporada, escritos pelo Model API V1
/// (o mesmo que o Studio expoe aos plugins) num modulo carregado headless. Serve de carga de prova
/// para o merge de 3 vias: 2 entidades (7 + 5 atributos, FK), 2 user exceptions e a server action
/// BookVacationHome com 4 inputs, 2 outputs, 2 locais e um fluxo de 12 nos: aggregate com filtro,
/// if, raise, assign, segundo aggregate, for-each com ciclo, if dentro do ciclo, raise, assign,
/// execute da entity action CreateOrUpdate, assign de saida.
/// </summary>
public sealed record DemoOutcome(
    string BasePath, string OutPath, long Bytes, long LoadMs, long ApplyMs, long VerifyMs, long SaveMs,
    int ObjectsBefore, int ObjectsAfter, ValidationSummary ValidationBefore, ValidationSummary ValidationAfter, bool IsValid, RecipeOutcome Recipe,
    IReadOnlyList<string> Messages);

public static class VacationRentalRecipe
{
    /// <summary>Carrega a base, aplica a receita, verifica e salva o OML "foreign" para o merge.</summary>
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
        var details = ModelHost.ValidationDetails(espace);
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
        Publisher.Mutate(espace, "SSHeadless: vacation rental model + BookVacationHome", e => result = Build((IESpace)e, log));
        return result!;
    }

    private static RecipeOutcome Build(IESpace es, Action<string>? log)
    {
        var lines = new List<string>();
        void L(string s) { lines.Add(s); log?.Invoke(s); }

        // ---- entidades ------------------------------------------------------------------
        var home = es.CreateServerEntity("VacationHome");
        home.Description = "Casa de temporada disponivel para aluguel (criada headless)";
        EnsureIdentifier(home);
        Attr(home, "Name", es.TextType, length: 100, mandatory: true);
        Attr(home, "City", es.TextType, length: 50);
        Attr(home, "DailyRate", es.CurrencyType, mandatory: true);
        Attr(home, "MaxGuests", es.IntegerType);
        Attr(home, "IsActive", es.BooleanType).SetDefaultValue("True");
        var homeId = EnsureIdentifier(home);
        L($"entity VacationHome: {home.Attributes.Count()} attributes, id type {homeId.GetType().Name}");

        var booking = es.CreateServerEntity("Booking");
        booking.Description = "Reserva de uma casa de temporada (criada headless)";
        EnsureIdentifier(booking);
        booking.UpdateBehavior = OutSystems.Model.Enumerations.UpdateEntityBehaviorType.Optimized;   // > 8 atributos: o Studio sugere
        Attr(booking, "VacationHomeId", homeId, mandatory: true);
        Attr(booking, "GuestName", es.TextType, length: 100, mandatory: true);
        Attr(booking, "CheckIn", es.DateType, mandatory: true);
        Attr(booking, "CheckOut", es.DateType, mandatory: true);
        Attr(booking, "Nights", es.IntegerType);
        Attr(booking, "Total", es.CurrencyType);
        Attr(booking, "Status", es.TextType, length: 20).SetDefaultValue("\"Confirmed\"");
        var bookingId = EnsureIdentifier(booking);
        L($"entity Booking: {booking.Attributes.Count()} attributes");

        // ---- excecoes -------------------------------------------------------------------
        var exNotFound = es.CreateUserException("HomeNotFound");
        var exNotAvailable = es.CreateUserException("HomeNotAvailable");

        // ---- action ---------------------------------------------------------------------
        var act = es.CreateServerAction("BookVacationHome");
        act.Public = true;
        Param(act.CreateInputParameter("HomeId"), homeId, mandatory: true);
        Param(act.CreateInputParameter("GuestName"), es.TextType, mandatory: true);
        Param(act.CreateInputParameter("CheckIn"), es.DateType, mandatory: true);
        Param(act.CreateInputParameter("CheckOut"), es.DateType, mandatory: true);
        act.CreateOutputParameter("BookingId").DataType = bookingId;
        act.CreateOutputParameter("Total").DataType = es.CurrencyType;
        act.CreateLocalVariable("NewBooking").DataType = booking;
        act.CreateLocalVariable("Nights").DataType = es.IntegerType;

        var (start, end) = act.AddStartEndNodes();

        var getHome = act.CreateNode<IAggregateNode>("GetVacationHome");
        var q1 = getHome.AsDatabaseAggregate;
        q1.CreateSource(home);
        q1.CreateFilter("VacationHome.Id = HomeId");

        var ifFound = act.CreateNode<IIfNode>("HomeExists");
        ifFound.Label = "HomeExists";
        ifFound.SetCondition("GetVacationHome.List.Empty");

        var raiseNotFound = act.CreateNode<IRaiseExceptionNode>("RaiseHomeNotFound");
        raiseNotFound.Exception = exNotFound;
        raiseNotFound.SetExceptionMessage("\"Vacation home not found: \" + HomeId");

        var calc = act.CreateNode<IAssignNode>("CalculateTotal");
        calc.Label = "CalculateTotal";
        Assign(calc, "Nights", "DiffDays(CheckIn, CheckOut)");
        Assign(calc, "Total", "GetVacationHome.List.Current.VacationHome.DailyRate * Nights");

        var getBookings = act.CreateNode<IAggregateNode>("GetBookings");
        var q2 = getBookings.AsDatabaseAggregate;
        q2.CreateSource(booking);
        q2.CreateFilter("Booking.VacationHomeId = HomeId and Booking.Status <> \"Cancelled\"");

        var loop = act.CreateNode<IForEachNode>("ForEachBooking");
        loop.Label = "ForEachBooking";
        loop.SetRecordList("GetBookings.List");

        var ifOverlap = act.CreateNode<IIfNode>("DatesOverlap");
        ifOverlap.Label = "DatesOverlap";
        ifOverlap.SetCondition("CheckIn < GetBookings.List.Current.Booking.CheckOut and CheckOut > GetBookings.List.Current.Booking.CheckIn");

        var raiseNotAvailable = act.CreateNode<IRaiseExceptionNode>("RaiseHomeNotAvailable");
        raiseNotAvailable.Exception = exNotAvailable;
        raiseNotAvailable.SetExceptionMessage("\"Vacation home is not available between \" + CheckIn + \" and \" + CheckOut");

        var fill = act.CreateNode<IAssignNode>("FillBooking");
        fill.Label = "FillBooking";
        Assign(fill, "NewBooking.VacationHomeId", "HomeId");
        Assign(fill, "NewBooking.GuestName", "GuestName");
        Assign(fill, "NewBooking.CheckIn", "CheckIn");
        Assign(fill, "NewBooking.CheckOut", "CheckOut");
        Assign(fill, "NewBooking.Nights", "Nights");
        Assign(fill, "NewBooking.Total", "Total");
        Assign(fill, "NewBooking.Status", "\"Confirmed\"");

        var create = act.CreateNode<IExecuteServerActionNode>("CreateBooking");
        create.Action = booking.CreateOrUpdateAction;
        var argNames = new List<string>();
        foreach (var arg in create.Arguments)
        {
            var name = ArgName(arg);
            argNames.Add(name);
            if (string.Equals(name, "Source", StringComparison.OrdinalIgnoreCase)) arg.SetValue("NewBooking");
        }
        L($"CreateBooking arguments: {string.Join(", ", argNames)}");

        var setOut = act.CreateNode<IAssignNode>("SetOutputs");
        setOut.Label = "SetOutputs";
        Assign(setOut, "BookingId", "CreateBooking.Id");

        // ---- ligacoes -------------------------------------------------------------------
        start.Target = getHome;
        getHome.Target = ifFound;
        ifFound.TrueTarget = raiseNotFound;
        ifFound.FalseTarget = calc;
        calc.Target = getBookings;
        getBookings.Target = loop;
        loop.CycleTarget = ifOverlap;
        ifOverlap.TrueTarget = raiseNotAvailable;
        ifOverlap.FalseTarget = loop;
        loop.Target = fill;
        fill.Target = create;
        create.Target = setOut;
        setOut.Target = end;

        // ---- posicoes: o canvas do Studio usa unidades de 1/20 px (Start de uma action nova = 3200,800; passo 1600) ----
        const int Unit = 20, ColMain = 160 * Unit, ColBranch = 380 * Unit, ColBranch2 = 600 * Unit, Row0 = 40 * Unit, RowStep = 80 * Unit;
        var column = new IFlowNode[] { start, getHome, ifFound, calc, getBookings, loop, fill, create, setOut, end };
        for (var i = 0; i < column.Length; i++) Place(column[i], ColMain, Row0 + i * RowStep);
        Place(raiseNotFound, ColBranch, Row0 + 2 * RowStep);
        Place(ifOverlap, ColBranch, Row0 + 5 * RowStep);
        Place(raiseNotAvailable, ColBranch2, Row0 + 5 * RowStep);
        L("positions after Place: " + string.Join(", ", column.Select(n => $"{n.GetType().GetProperty("Name")?.GetValue(n)}@{n.HorizontalPosition},{n.VerticalPosition}")));
        var nodes = act.Nodes.Count();
        L($"action BookVacationHome: {nodes} nodes, {act.InputParameters.Count()} inputs, {act.OutputParameters.Count()} outputs, {act.LocalVariables.Count()} locals");
        return new RecipeOutcome(act.ObjectKey.ToString(), home.ObjectKey.ToString(), booking.ObjectKey.ToString(), nodes, 10, lines);
    }

    /// <summary>O Model API cria a entidade sem atributos: o "Id" (Identifier, AutoNumber) e obra do
    /// comando de UI do Studio. Reproduzido aqui, e IdentifierType da entidade devolvido como tipo da FK.</summary>
    private static OutSystems.Model.Types.IBasicType EnsureIdentifier(IServerEntity entity)
    {
        if (entity.IdentifierAttribute != null) return entity.IdentifierType;
        // O Studio cria o Id como Long Integer + AutoNumber; o tipo "<Entidade> Identifier" e derivado dele.
        var id = entity.CreateAttribute("Id");
        id.DataType = entity.GetESpace().LongIntegerType;
        id.IsAutoNumber = OutSystems.Model.Enumerations.AutoNumber.Yes;
        id.IsMandatory = true;
        entity.Attributes.MoveToStart(id);
        entity.IdentifierAttribute = id;
        return entity.IdentifierType;
    }

    private static IEntityAttribute Attr(IServerEntity entity, string name, OutSystems.Model.Types.IBasicType type, int? length = null, bool mandatory = false)
    {
        var a = entity.CreateAttribute(name);
        a.DataType = type;
        if (length != null) a.Length = length;
        a.IsMandatory = mandatory;
        return a;
    }

    private static void Param(IInputParameter p, OutSystems.Model.Types.ITypeSignature type, bool mandatory)
    {
        p.DataType = type;
        p.IsMandatory = mandatory;
    }

    private static void Assign(IAssignNode node, string variable, string value)
    {
        var a = node.CreateAssignment();
        a.SetVariable(variable);
        a.SetValue(value);
    }

    private static void Place(IFlowNode node, int x, int y)
    {
        node.HorizontalPosition = x;
        node.VerticalPosition = y;
    }


    private static string ArgName(IArgument arg) => arg.Parameter?.Name ?? "?";
}
