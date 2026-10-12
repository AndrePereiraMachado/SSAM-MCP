using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Preflight;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Atritos 2, lane F2 (A02, A04): the pure preflight answers every rule at once with the exact fix. Coded refusals are
/// rebased onto the job (I4); actions are keyed by (owner, name) (I5); enums and writable properties are judged before the
/// apply; and the A04 rules (EXPR_UNKNOWN_IDENTIFIER, NAME_COLLISION, FUNCTION_ARITY, OPERAND_TYPES,
/// DB_FUNCTION_IN_AGGREGATE, REQUIRED_ARGUMENT/ARGUMENT_UNKNOWN, MOBILE_BLOCK_WITH_NAVIGATION) each have a case that fires
/// and one that does not. The real cases of the friction report are reproduced with synthetic names.
/// </summary>
public sealed class Pa2F2RulesTests
{
    public Pa2F2RulesTests() { try { StudioAssemblies.Bind(); } catch { /* no Studio: the checked-in catalogs answer */ } }

    private static JsonObject Analyze(string json)
    {
        var job = JsonNode.Parse(json)!;
        return JobPreflight.Analyze(job["ops"]!.AsArray(), job, []);
    }

    private static JsonObject[] Problems(JsonObject result, string code)
        => result["problems"]!.AsArray().OfType<JsonObject>().Where(p => p["code"]!.GetValue<string>() == code).ToArray();

    private static string Logic(string actions, string? spec = null)
        => "{\"ops\":[" + (spec == null ? "" : "{\"op\":\"spec\",\"data\":" + spec + "},") + "{\"op\":\"logic\",\"data\":{\"actions\":[" + actions + "]}}]}";

    // ---- I4: coded refusals rebased -----------------------------------------------------------------------------------------

    [Fact]
    public void ACodedRefusalBecomesItsProblemsRebasedOntoTheJob()
    {
        var problems = new JsonArray(
            JobPreflight.PublicProblem(JobPreflight.Problem(null, "/steps/2", "LOGIC_INVALID", "error", "step one", "fix one")),
            JobPreflight.PublicProblem(JobPreflight.Problem(null, "/actions/0/steps/4/as", "LOGIC_INVALID", "error", "step two", "fix two")),
            JobPreflight.PublicProblem(JobPreflight.Problem(null, "ServerAction:Caller/Execute", "DELETE_HAS_CONSUMERS", "error", "a consumer", "breaks")),
            JobPreflight.PublicProblem(JobPreflight.Problem(null, null, "", "error", "no pointer", null)));
        var fake = new InvalidOperationException("op #3 (logic): wrapped", new KernelRefusalException("LOGIC_INVALID", "three faults", problems));

        // Relative to op.data (LogicExpander.Expand with the op's data).
        var data = CodedProblems.From(fake, 3, "logic", "/ops/3/data")!;
        Assert.Equal(4, data.Count);
        Assert.Equal("/ops/3/data/steps/2", data[0]["pointer"]!.GetValue<string>());
        Assert.Equal("/ops/3/data/actions/0/steps/4/as", data[1]["pointer"]!.GetValue<string>());
        Assert.Equal("ServerAction:Caller/Execute", data[2]["pointer"]!.GetValue<string>());   // a model path is not a JSON pointer
        Assert.Equal("/ops/3/data", data[3]["pointer"]!.GetValue<string>());
        Assert.Equal("LOGIC_INVALID", data[3]["code"]!.GetValue<string>());                    // the exception's code fills an empty one
        Assert.All(data, p => Assert.Equal(3, p["op"]!.GetValue<int>()));

        // The one-action envelope of the preflight: /actions/0 is the action inside the op.
        var envelope = CodedProblems.From(fake, 3, "logic", "/ops/3/data", "/actions/0", "/ops/3/data/actions/7")!;
        Assert.Equal("/ops/3/data/actions/7/steps/4/as", envelope[1]["pointer"]!.GetValue<string>());
        Assert.Equal("/ops/3/data/actions/7", envelope[3]["pointer"]!.GetValue<string>());

        // A composite job has no exact pointer; an exception without problems keeps its one-problem form.
        Assert.Null(CodedProblems.From(fake, 3, "logic", null)![0]["pointer"]);
        Assert.Null(CodedProblems.From(new InvalidOperationException("plain"), 3, "logic", "/ops/3"));
    }

    // ---- I5: actions by (owner, name) ---------------------------------------------------------------------------------------

    [Fact]
    public void TheSameScreenActionInTwoScreensIsLegalAndTwiceInOneScreenIsRefused()
    {
        static string Screen(string owner) => "{\"name\":\"NavMeusRestaurantes\",\"kind\":\"screen\",\"owner\":\"" + owner + "\",\"steps\":[]}";
        var legal = Analyze(Logic(Screen("IMobileScreen:Home") + "," + Screen("IMobileScreen:Pedidos")));
        Assert.Empty(Problems(legal, "LOGIC_DUPLICATE_ACTION"));
        Assert.Empty(Problems(legal, "LOGIC_INVALID"));
        var refused = Analyze(Logic(Screen("IMobileScreen:Home") + "," + Screen("IMobileScreen:Home")));
        var duplicate = Assert.Single(Problems(refused, "LOGIC_DUPLICATE_ACTION"));
        Assert.Equal("/ops/0/data/actions/1", duplicate["pointer"]!.GetValue<string>());
        Assert.Contains("IMobileScreen:Home", duplicate["message"]!.GetValue<string>());
    }

    // ---- A02 items 2 and 3: enums and writable properties, before the apply ------------------------------------------------

    [Fact]
    public void AnInvalidEnumIsRefusedInThePreflightInRawOpsAndInWhatASpecExpandsInto()
    {
        var result = Analyze("""
        {"ops":[
          {"op":"create","parent":"@espace","type":"IServerEntity","name":"Pa2Order","as":"$o"},
          {"op":"create","parent":"$o","type":"IEntityAttribute","name":"CustomerId","as":"$c"},
          {"op":"set","target":"$c","prop":"DeleteRule","value":"Cascade"},
          {"op":"spec","data":{"entities":[{"name":"Pa2Item","attributes":[{"name":"OrderId","type":"Long Integer","deleteRule":"Cascade"}]}]}}]}
        """);
        var enums = Problems(result, "ENUM_VALUE_INVALID");
        Assert.Equal(2, enums.Length);
        Assert.Equal("/ops/2/value", enums[0]["pointer"]!.GetValue<string>());
        Assert.Equal("/ops/3/data", enums[1]["pointer"]!.GetValue<string>());
        Assert.All(enums, e => Assert.StartsWith("use one of: ", e["fix"]!.GetValue<string>()));
        Assert.All(enums, e => Assert.Contains("Protect", e["fix"]!.GetValue<string>()));
        Assert.Empty(Problems(Analyze("""{"ops":[{"op":"create","parent":"@espace","type":"IServerEntity","name":"Pa2Order","as":"$o"},{"op":"create","parent":"$o","type":"IEntityAttribute","name":"CustomerId","as":"$c"},{"op":"set","target":"$c","prop":"DeleteRule","value":"Delete"}]}"""), "ENUM_VALUE_INVALID"));
    }

    [Fact]
    public void APropertyTheTypeDoesNotWriteIsRefusedInThePreflightWithTheClosestOnes()
    {
        // The real case: `IScreenAction 'OnInitialize' has no writable property or setter 'Destination'`, once per round at apply.
        var result = Analyze("""{"ops":[{"op":"set","target":"IScreenAction:OnInitialize","prop":"Destination","value":"IMobileScreen:Home"}]}""");
        var problem = Assert.Single(Problems(result, "PROPERTY_NOT_WRITABLE"));
        Assert.Equal("/ops/0/prop", problem["pointer"]!.GetValue<string>());
        Assert.Contains("has no writable property or setter 'Destination'", problem["message"]!.GetValue<string>());
        Assert.StartsWith("write one of: ", problem["fix"]!.GetValue<string>());
        // A property the type writes, and a widget (whose class writes more than its interfaces declare), are not judged.
        Assert.Empty(Problems(Analyze("""{"ops":[{"op":"set","target":"IScreenAction:OnInitialize","prop":"Description","value":"x"}]}"""), "PROPERTY_NOT_WRITABLE"));
        Assert.Empty(Problems(Analyze("""{"ops":[{"op":"create","parent":"$scr","type":"IExpression","as":"$e"},{"op":"set","target":"$e","prop":"Visible","value":"True"}]}"""), "PROPERTY_NOT_WRITABLE"));
    }

    // ---- A04 -----------------------------------------------------------------------------------------------------------------

    private const string Restaurants = """{"entities":[{"name":"Restaurante","attributes":[{"name":"Nome","type":"Text"},{"name":"Ativo","type":"Boolean"}]},{"name":"RestauranteHorario","attributes":[{"name":"DiaSemana","type":"Integer"},{"name":"HoraInicio","type":"Time"}]}]}""";

    [Fact]
    public void AnAggregateCurrentWithoutItsSourceIsAnUnknownIdentifierWithTheSourceAsTheFix()
    {
        var wrong = Analyze(Logic("""{"name":"Restaurante_Nome","outputs":[{"name":"Nome","type":"Text"}],"steps":[{"get":"Restaurante","as":"GetRestaurantes","max":1},{"assign":{"Nome":"GetRestaurantes.List.Current.Nome"}}]}""", Restaurants));
        var problem = Assert.Single(Problems(wrong, "EXPR_UNKNOWN_IDENTIFIER"));
        Assert.Equal("/ops/1/data/actions/0/steps/1/assign/Nome", problem["pointer"]!.GetValue<string>());
        Assert.Equal("write GetRestaurantes.List.Current.Restaurante.Nome (an aggregate's Current has one record per source)", problem["fix"]!.GetValue<string>());
        var right = Analyze(Logic("""{"name":"Restaurante_Nome","outputs":[{"name":"Nome","type":"Text"}],"steps":[{"get":"Restaurante","as":"GetRestaurantes","max":1},{"assign":{"Nome":"GetRestaurantes.List.Current.Restaurante.Nome"}}]}""", Restaurants));
        Assert.Empty(Problems(right, "EXPR_UNKNOWN_IDENTIFIER"));
        // An attribute the source does not have.
        var missing = Analyze(Logic("""{"name":"Restaurante_Nome","outputs":[{"name":"Nome","type":"Text"}],"steps":[{"get":"Restaurante","as":"GetRestaurantes","max":1},{"assign":{"Nome":"GetRestaurantes.List.Current.Restaurante.Name"}}]}""", Restaurants));
        Assert.Contains("Nome", Assert.Single(Problems(missing, "EXPR_UNKNOWN_IDENTIFIER"))["fix"]!.GetValue<string>());
    }

    [Fact]
    public void AListOfAnEntityReadsTheAttributesDirectly()
    {
        // The real case: `Horarios.Current.RestauranteHorario.DiaSemana` -> Can't identify 'RestauranteHorario'. The patch is
        // certain, so the engine writes it (lentidao 2026-10-12, JobNormalizer) and lists it instead of refusing.
        var job = JsonNode.Parse(Logic("""{"name":"Horarios_Validar","inputs":[{"name":"Horarios","type":"RestauranteHorario List"}],"outputs":[{"name":"Ok","type":"Boolean"}],"steps":[{"assign":{"Ok":"Horarios.Current.RestauranteHorario.DiaSemana >= 0"}}]}""", Restaurants))!;
        var wrong = JobPreflight.Analyze(job["ops"]!.AsArray(), job, []);
        Assert.Empty(Problems(wrong, "EXPR_UNKNOWN_IDENTIFIER"));
        var normalized = Assert.Single(wrong["normalizations"]!.AsArray().OfType<JsonObject>());
        Assert.Equal("Horarios.Current.DiaSemana >= 0", normalized["to"]!.GetValue<string>());
        Assert.Equal("Horarios.Current.DiaSemana >= 0", job["ops"]![1]!["data"]!["actions"]![0]!["steps"]![0]!["assign"]!["Ok"]!.GetValue<string>());
        var right = Analyze(Logic("""{"name":"Horarios_Validar","inputs":[{"name":"Horarios","type":"RestauranteHorario List"}],"outputs":[{"name":"Ok","type":"Boolean"}],"steps":[{"assign":{"Ok":"Horarios.Current.DiaSemana >= 0"}}]}""", Restaurants));
        Assert.Empty(Problems(right, "EXPR_UNKNOWN_IDENTIFIER"));
    }

    [Fact]
    public void AnOutputTheCalleeDoesNotHaveIsAnUnknownIdentifier()
    {
        // The real case: `Can't identify 'List' element` on the output of an Execute Server Action.
        const string callee = """{"name":"Access_Scope","inputs":[{"name":"Id","type":"Integer"}],"outputs":[{"name":"Allowed","type":"Boolean"}],"steps":[{"assign":{"Allowed":"Id > 0"}}]}""";
        var wrong = Analyze(Logic(callee + """,{"name":"Equipment_Search","outputs":[{"name":"Ok","type":"Boolean"}],"steps":[{"call":"Access_Scope","as":"Access","args":{"Id":"1"}},{"assign":{"Ok":"Access.List.Empty"}}]}"""));
        var problem = Assert.Single(Problems(wrong, "EXPR_UNKNOWN_IDENTIFIER"));
        Assert.Contains("Allowed", problem["fix"]!.GetValue<string>());
        var right = Analyze(Logic(callee + """,{"name":"Equipment_Search","outputs":[{"name":"Ok","type":"Boolean"}],"steps":[{"call":"Access_Scope","as":"Access","args":{"Id":"1"}},{"assign":{"Ok":"Access.Allowed"}}]}"""));
        Assert.Empty(Problems(right, "EXPR_UNKNOWN_IDENTIFIER"));
    }

    [Fact]
    public void ServerLogicHasAClosedScopeAndATypeIsNotAValue()
    {
        // The real cases: `RestauranteId` of another action in an argument, `SLADeadlineResult.Value` (a structure, not a value).
        const string spec = """{"structures":[{"name":"SLADeadlineResult","attributes":[{"name":"Value","type":"Date Time"}]}]}""";
        var other = Analyze(Logic("""{"name":"Restaurante_Obter","inputs":[{"name":"RestauranteId","type":"Long Integer"}],"outputs":[{"name":"Ok","type":"Boolean"}],"steps":[{"assign":{"Ok":"RestauranteId > 0"}}]},{"name":"Restaurante_BuscarProximos","outputs":[{"name":"Ok","type":"Boolean"}],"steps":[{"call":"Restaurante_Obter","as":"Horario","args":{"RestauranteId":"RestauranteId"}},{"assign":{"Ok":"Horario.Ok"}}]}"""));
        var unknown = Assert.Single(Problems(other, "EXPR_UNKNOWN_IDENTIFIER"));
        Assert.Equal("/ops/0/data/actions/1/steps/0/args/RestauranteId", unknown["pointer"]!.GetValue<string>());
        var type = Analyze(Logic("""{"name":"SLA_AddBusinessMinutes","outputs":[{"name":"Deadline","type":"Date Time"}],"steps":[{"assign":{"Deadline":"SLADeadlineResult.Value"}}]}""", spec));
        Assert.Contains("a type and not a value", Assert.Single(Problems(type, "EXPR_UNKNOWN_IDENTIFIER"))["message"]!.GetValue<string>());
        // The roots of the language, the exceptions of the handlers and the action's own names are in scope.
        var fine = Analyze(Logic("""{"name":"Notificar","inputs":[{"name":"Id","type":"Long Integer"}],"outputs":[{"name":"Msg","type":"Text"}],"steps":[{"assign":{"Msg":"Site.Nome + Entities.Status.Ativo + IntegerToText(Id)"}}],"handlers":[{"name":"Falha","exception":"AllExceptions","steps":[{"assign":{"Msg":"AllExceptions.ExceptionMessage"}}]}]}"""));
        Assert.Empty(Problems(fine, "EXPR_UNKNOWN_IDENTIFIER"));
    }

    [Fact]
    public void ANodeNamedLikeARootIsANameCollision()
    {
        // The real case: an aggregate named Site, then `Can't identify 'List'` on Site.List.Empty.
        var site = Analyze(Logic("""{"name":"Equipment_Search","outputs":[{"name":"Ok","type":"Boolean"}],"steps":[{"get":"Equipamento","as":"Site","max":1},{"assign":{"Ok":"not Site.List.Empty"}}]}""", """{"entities":[{"name":"Equipamento","attributes":[{"name":"Nome","type":"Text"}]}]}"""));
        var problem = Assert.Single(Problems(site, "NAME_COLLISION"));
        Assert.Equal("/ops/1/data/actions/0/steps/0/as", problem["pointer"]!.GetValue<string>());
    }

    [Fact]
    public void SiteInClientLogicIsAnUnknownIdentifier()
    {
        var client = Analyze(Logic("""{"name":"Mostrar","kind":"client","outputs":[{"name":"Url","type":"Text"}],"steps":[{"assign":{"Url":"Site.BaseUrl"}}]}"""));
        Assert.Contains("server action", Assert.Single(Problems(client, "EXPR_UNKNOWN_IDENTIFIER"))["fix"]!.GetValue<string>());
        var server = Analyze(Logic("""{"name":"Mostrar","outputs":[{"name":"Url","type":"Text"}],"steps":[{"assign":{"Url":"Site.BaseUrl"}}]}"""));
        Assert.Empty(Problems(server, "EXPR_UNKNOWN_IDENTIFIER"));
    }

    [Fact]
    public void ANameThatCollidesInItsScopeIsRefusedWithTheNameTheStudioWouldGive()
    {
        var duplicate = Analyze(Logic("""{"name":"ObterCardapio","inputs":[{"name":"Categorias","type":"Text"}],"vars":[{"name":"Categorias","type":"Text"}],"steps":[{"assign":{"Categorias":"\"a\""}}]}"""));
        var problem = Assert.Single(Problems(duplicate, "NAME_COLLISION"));
        Assert.Equal("/ops/0/data/actions/0/vars/0/name", problem["pointer"]!.GetValue<string>());
        Assert.Contains("Categorias2", problem["message"]!.GetValue<string>());
        // The real case: a data action output named Site became Site2 (InvalidDataAction_OutputMustBeSet).
        var site = Analyze(Logic("""{"name":"LoadDispatch","outputs":[{"name":"Site","type":"Text"}],"steps":[{"assign":{"Site":"\"x\""}}]}"""));
        Assert.Contains("Site2", Assert.Single(Problems(site, "NAME_COLLISION"))["message"]!.GetValue<string>());
        var distinct = Analyze(Logic("""{"name":"ObterCardapio","inputs":[{"name":"Filtro","type":"Text"}],"vars":[{"name":"Categorias","type":"Text"}],"steps":[{"assign":{"Categorias":"Filtro"}}]}"""));
        Assert.Empty(Problems(distinct, "NAME_COLLISION"));
    }

    [Fact]
    public void ABuiltInCalledWithTheWrongNumberOfArgumentsIsRefusedWithItsSignature()
    {
        // The real case: `Too many arguments specified for function 'Index'`.
        var wrong = Analyze(Logic("""{"name":"Buscar","inputs":[{"name":"V","type":"Text"}],"outputs":[{"name":"P","type":"Integer"}],"steps":[{"assign":{"P":"Index(V, \"a\", 0, False, True, 1)"}}]}"""));
        var problem = Assert.Single(Problems(wrong, "FUNCTION_ARITY"));
        Assert.Contains("passes 6 argument(s)", problem["message"]!.GetValue<string>());
        Assert.Contains("Index(t: Text, search: Text", problem["fix"]!.GetValue<string>());
        Assert.Empty(Problems(Analyze(Logic("""{"name":"Buscar","inputs":[{"name":"V","type":"Text"}],"outputs":[{"name":"P","type":"Integer"}],"steps":[{"assign":{"P":"Index(V, \"a\")"}}]}""")), "FUNCTION_ARITY"));
    }

    [Fact]
    public void OperandsOfKnownIncompatibleTypesAreRefusedWithTheConversion()
    {
        // The real case: `Cannot apply '<' operator to 'Integer Identifier' together with 'Integer'`.
        var identifier = Analyze(Logic("""{"name":"AccessScope_Save","inputs":[{"name":"ScopeTypeId","type":"Integer"}],"outputs":[{"name":"Ok","type":"Boolean"}],"steps":[{"assign":{"Ok":"IntegerToIdentifier(ScopeTypeId) < 1"}}]}"""));
        Assert.Contains("IdentifierToInteger", Assert.Single(Problems(identifier, "OPERAND_TYPES"))["fix"]!.GetValue<string>());
        var unary = Analyze(Logic("""{"name":"Pedido_Anterior","inputs":[{"name":"PedidoId","type":"Pedido Identifier"}],"outputs":[{"name":"N","type":"Integer"}],"steps":[{"assign":{"N":"-PedidoId"}}]}"""));
        Assert.Single(Problems(unary, "OPERAND_TYPES"));
        var text = Analyze(Logic("""{"name":"Dobro","inputs":[{"name":"V","type":"Text"}],"outputs":[{"name":"N","type":"Integer"}],"steps":[{"assign":{"N":"V * 2"}}]}"""));
        Assert.Contains("TextToInteger", Assert.Single(Problems(text, "OPERAND_TYPES"))["fix"]!.GetValue<string>());
        // A Date Time ordered against a Date inside an aggregate: refused (`Cannot apply '>=' operator to 'Date Time' together with 'Date'`).
        const string finance = """{"entities":[{"name":"Lancamento","attributes":[{"name":"CriadoEm","type":"Date Time"}]}]}""";
        var aggregate = Analyze(Logic("""{"name":"Finance_Export","inputs":[{"name":"Desde","type":"Date"}],"outputs":[{"name":"N","type":"Integer"}],"steps":[{"get":"Lancamento","as":"Rows","where":"Lancamento.CriadoEm >= Desde"},{"assign":{"N":"Rows.Count"}}]}""", finance));
        Assert.Contains("DateTimeToDate", Assert.Single(Problems(aggregate, "OPERAND_TYPES"))["fix"]!.GetValue<string>());
        // The valid forms are not judged.
        foreach (var valid in new[] { "IdentifierToInteger(IntegerToIdentifier(ScopeTypeId)) < 1", "ScopeTypeId - 1", "\"n=\" + ScopeTypeId" })
            Assert.Empty(Problems(Analyze(Logic("""{"name":"AccessScope_Save","inputs":[{"name":"ScopeTypeId","type":"Integer"}],"outputs":[{"name":"Ok","type":"Text"}],"steps":[{"assign":{"Ok":"X"}}]}""".Replace("\"X\"", JsonSerializer.Serialize(valid)))), "OPERAND_TYPES"));
        Assert.Empty(Problems(Analyze(Logic("""{"name":"Finance_Export","inputs":[{"name":"Desde","type":"Date Time"}],"outputs":[{"name":"N","type":"Integer"}],"steps":[{"get":"Lancamento","as":"Rows","where":"Lancamento.CriadoEm >= Desde"},{"assign":{"N":"Rows.Count"}}]}""", finance)), "OPERAND_TYPES"));
    }

    [Fact]
    public void AFunctionTheDatabaseDoesNotRunCannotReceiveAnAggregateAttribute()
    {
        // The real case: `'CheckSS360TechnicianRole' function cannot be executed in the database, so it can't receive any
        // attributes from the aggregate as parameter`.
        const string scope = """{"entities":[{"name":"Escopo","attributes":[{"name":"UsuarioId","type":"Long Integer"},{"name":"Valor","type":"Decimal"}]}]}""";
        static string Get(string where) => """{"name":"Demo_Grant","outputs":[{"name":"N","type":"Long Integer"}],"steps":[{"get":"Escopo","as":"Scopes","where":WHERE},{"assign":{"N":"Scopes.Count"}}]}""".Replace("WHERE", JsonSerializer.Serialize(where));
        var role = Analyze(Logic(Get("CheckPa2TechnicianRole(Escopo.UsuarioId)"), scope));
        var problem = Assert.Single(Problems(role, "DB_FUNCTION_IN_AGGREGATE"));
        Assert.Equal("/ops/1/data/actions/0/steps/0/where", problem["pointer"]!.GetValue<string>());
        Assert.Contains("before the get", problem["fix"]!.GetValue<string>());
        Assert.Single(Problems(Analyze(Logic(Get("FormatDecimal(Escopo.Valor, 2, \".\", \",\") = \"1.00\""), scope)), "DB_FUNCTION_IN_AGGREGATE"));
        // A column of the aggregate by its name is an attribute of the aggregate too (the real case: a calculated column).
        var calculated = Analyze(Logic("""{"name":"SLA_Recipients","outputs":[{"name":"N","type":"Long Integer"}],"steps":[{"get":"Escopo","as":"Recipients","columns":[{"name":"RecipientId","kind":"Group","attribute":"Escopo.UsuarioId"}],"calculated":[{"name":"IsStaff","value":"CheckPa2AdminRole(RecipientId)"}]},{"assign":{"N":"Recipients.Count"}}]}""", scope));
        Assert.Equal("/ops/1/data/actions/0/steps/0/calculated/0/value", Assert.Single(Problems(calculated, "DB_FUNCTION_IN_AGGREGATE"))["pointer"]!.GetValue<string>());
        // The role check of a variable, and a built-in the database runs, are fine.
        Assert.Empty(Problems(Analyze(Logic(Get("Escopo.UsuarioId = 1 and CheckPa2TechnicianRole(GetUserId())"), scope)), "DB_FUNCTION_IN_AGGREGATE"));
        Assert.Empty(Problems(Analyze(Logic(Get("Trim(Escopo.Valor) <> \"\""), scope)), "DB_FUNCTION_IN_AGGREGATE"));
    }

    [Fact]
    public void TheArgsOfACallAreCheckedAgainstTheCalleeSignature()
    {
        // The real case: `IExecuteServerActionNode 'In1_Precos' has no child 'Cesta.RestauranteId'`, one per round at apply.
        const string callee = """{"name":"Precos_Calcular","inputs":[{"name":"RestauranteId","type":"Long Integer"},{"name":"Cupom","type":"Text","mandatory":false}],"outputs":[{"name":"Total","type":"Decimal"}],"steps":[{"assign":{"Total":"RestauranteId + 0.0"}}]}""";
        var wrong = Analyze(Logic(callee + """,{"name":"Cesta_Fechar","inputs":[{"name":"Id","type":"Long Integer"}],"outputs":[{"name":"T","type":"Decimal"}],"steps":[{"call":"Precos_Calcular","as":"In1_Precos","args":{"Cesta.RestauranteId":"Id"}},{"assign":{"T":"In1_Precos.Total"}}]}"""));
        var unknown = Assert.Single(Problems(wrong, "ARGUMENT_UNKNOWN"));
        Assert.Equal("/ops/0/data/actions/1/steps/0/args/Cesta.RestauranteId", unknown["pointer"]!.GetValue<string>());
        Assert.Contains("RestauranteId", unknown["fix"]!.GetValue<string>());
        var required = Assert.Single(Problems(wrong, "REQUIRED_ARGUMENT"));
        Assert.Equal("/ops/0/data/actions/1/steps/0", required["pointer"]!.GetValue<string>());
        Assert.Contains("\"RestauranteId\"", required["fix"]!.GetValue<string>());
        var right = Analyze(Logic(callee + """,{"name":"Cesta_Fechar","inputs":[{"name":"Id","type":"Long Integer"}],"outputs":[{"name":"T","type":"Decimal"}],"steps":[{"call":"Precos_Calcular","as":"In1_Precos","args":{"RestauranteId":"Id"}},{"assign":{"T":"In1_Precos.Total"}}]}"""));
        Assert.Empty(Problems(right, "ARGUMENT_UNKNOWN"));
        Assert.Empty(Problems(right, "REQUIRED_ARGUMENT"));
    }

    private sealed class FakeBase(string moduleType) : IBaseFacts
    {
        public IReadOnlyDictionary<string, string>? Attributes(string record) => null;
        public bool IsClientEntity(string name) => false;
        public CalleeFact? Callee(string target, JsonObject caller) => null;
        public bool HasName(string name) => true;
        public bool NamesOnlyTypes(string name) => false;
        public RawExpressionFact? RawExpression(string target, string prop) => null;
        public bool IsFunction(string name) => false;
        public string? ModuleType => moduleType;
    }

    [Fact]
    public void ABlockThatNavigatesInAMobileAppIsRefusedWithTheBlockEventAsTheFix()
    {
        var ops = JsonNode.Parse(Logic("""{"name":"IrParaPedidos","kind":"screen","owner":"IMobileBlock:Menu","steps":[{"node":"IDestinationNode","properties":{"Destination":"IMobileScreen:Pedidos"}}]}"""))!["ops"]!.AsArray();
        var job = JobFacts.From(ops);
        var problem = Assert.Single(MobileRules.Check(ops, "/ops", job, new FakeBase("Mobile")));
        Assert.Equal("MOBILE_BLOCK_WITH_NAVIGATION", problem["code"]!.GetValue<string>());
        Assert.Equal("/ops/0/data/actions/0/steps/0", problem["pointer"]!.GetValue<string>());
        Assert.Contains("event", problem["fix"]!.GetValue<string>());
        Assert.Empty(MobileRules.Check(ops, "/ops", job, new FakeBase("CrossDevice")));   // a Reactive Web block may navigate
        Assert.Empty(MobileRules.Check(ops, "/ops", job, null));                           // without the base the type is unknown
    }

    private static readonly string[] NewCodes = ["ENUM_VALUE_INVALID", "PROPERTY_NOT_WRITABLE", "ARGUMENT_UNKNOWN", "REQUIRED_ARGUMENT", "EXPR_UNKNOWN_IDENTIFIER",
        "NAME_COLLISION", "FUNCTION_ARITY", "OPERAND_TYPES", "DB_FUNCTION_IN_AGGREGATE", "MOBILE_BLOCK_WITH_NAVIGATION", "LOGIC_DUPLICATE_ACTION", "PREFLIGHT_RULE_FAILED"];

    /// <summary>No false positive on the repository's O11 jobs (the suites, the live jobs, the tested coverage): the rules
    /// refuse only what the platform refuses.</summary>
    [Theory]
    [InlineData("jobs")]
    [InlineData("jobs-live")]
    [InlineData("jobs-coverage")]
    [InlineData("jobs-coverage-f2")]
    public void NoNewRuleFiresOnTheRepositoryJobs(string folder)
    {
        var dir = Path.Combine(PacoteBPolicyTests.FindRoot(), "tests", folder);
        if (!Directory.Exists(dir)) return;
        var found = new List<string>();
        foreach (var file in Directory.GetFiles(dir, "*.json", SearchOption.AllDirectories).OrderBy(f => f, StringComparer.Ordinal))
        {
            if (file.Contains(Path.DirectorySeparatorChar + "odc" + Path.DirectorySeparatorChar)) continue;
            JsonNode? job;
            try { job = JsonNode.Parse(File.ReadAllText(file)); } catch { continue; }
            if (job is JsonObject o && (o["ops"] == null && o["jobs"] == null || o["base"]?.ToString().Contains("odc", StringComparison.OrdinalIgnoreCase) == true)) continue;
            if (job is not (JsonObject or JsonArray)) continue;
            JsonArray ops;
            try { ops = JobRunner.CollectOps(job, Path.GetDirectoryName(file)!); } catch { continue; }
            var result = JobPreflight.Analyze(ops, job);
            found.AddRange(result["problems"]!.AsArray().Concat(result["warnings"]!.AsArray()).OfType<JsonObject>()
                .Where(p => NewCodes.Contains(p["code"]!.GetValue<string>())).Select(p => Path.GetFileName(file) + ": " + p["code"] + " " + p["message"]));
        }
        Assert.True(found.Count == 0, string.Join(Environment.NewLine, found));
    }

    [Fact]
    public void AJobThatExpectsAnInvalidModuleAsksTheVerifyInsteadOfTheRules()
    {
        var json = Logic("""{"name":"Buscar","inputs":[{"name":"V","type":"Text"}],"outputs":[{"name":"P","type":"Integer"}],"steps":[{"assign":{"P":"Index(V, \"a\", 0, False, True, 1)"}}]}""");
        Assert.Single(Problems(Analyze(json), "FUNCTION_ARITY"));
        Assert.Empty(Problems(Analyze(json.Replace("{\"ops\":", "{\"expectValid\":false,\"ops\":")), "FUNCTION_ARITY"));
    }
}
