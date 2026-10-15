using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// The generator `rest-consume` (RestConsume.cs): the pure plan (URLs, types, names, shapes, mappings, every refusal of the
/// data) and, through RestConsumeScenarios, the kernel apply on the O11 blank service module with the public-API samples of
/// tests/fixtures/rest-consume (Verify, read back, idempotence, taken names, update in place).
/// </summary>
public class RestConsumeTests
{
    private static JsonObject Data(string json) => JsonNode.Parse(json)!.AsObject();
    private static List<string> Codes(string json) => RestConsume.Validate(Data(json), "o11").Select(p => p.Code).ToList();

    [Fact]
    public void UrlsGiveTheBaseThePathsAndTheInputs()
    {
        var one = RestConsume.ParseUrl("https://brasilapi.com.br/api/feriados/v1/{ano=2026}", null);
        Assert.Null(one.Problem);
        Assert.Equal("https://brasilapi.com.br", one.Origin);
        var ano = Assert.Single(one.Params);
        Assert.Equal(("ano", "2026", false, true), (ano.Name, ano.Example, ano.Query, ano.Mandatory));
        var query = RestConsume.ParseUrl("https://api.frankfurter.app/latest?from=BRL&to={to=USD}&api-key=x", null);
        Assert.Equal(["from", "to", "api-key"], query.Params.Select(p => p.Name));
        Assert.Equal((true, false, "BRL"), (query.Params[0].Query, query.Params[0].Mandatory, query.Params[0].Default));
        Assert.Equal((true, true, "to"), (query.Params[1].Query, query.Params[1].Mandatory, query.Params[1].OriginalName));
        // One url: its directory is the base; several: their common part, each keeping one segment.
        var (single, paths) = RestConsume.BaseAndPaths(null, [one]);
        Assert.Equal("https://brasilapi.com.br/api/feriados/v1", single);
        Assert.Equal(["{ano=2026}"], paths[0]);
        var ibge = new[] { "https://servicodados.ibge.gov.br/api/v1/localidades/estados", "https://servicodados.ibge.gov.br/api/v1/localidades/estados/{uf}/municipios" }
            .Select(u => RestConsume.ParseUrl(u, null)).ToList();
        var (common, ibgePaths) = RestConsume.BaseAndPaths(null, ibge);
        Assert.Equal("https://servicodados.ibge.gov.br/api/v1/localidades", common);
        Assert.Equal(["estados", "{uf}", "municipios"], ibgePaths[1]);
        Assert.True(RestConsume.ParseUrl("https://other.example/x", "https://api.example/v1").OutsideBase);
        Assert.Equal(["v2", "items"], RestConsume.ParseUrl("https://api.example/v1/v2/items", "https://api.example/v1").Segments);
        Assert.NotNull(RestConsume.ParseUrl("https://a.example/{x", null).Problem);
    }

    [Fact]
    public void TheExampleOfAUrlValueDecidesItsType()
    {
        Assert.Equal("Integer", RestConsume.ExampleType("2026"));
        Assert.Equal("Long Integer", RestConsume.ExampleType("4294967297"));
        Assert.Equal("Decimal", RestConsume.ExampleType("-23.55"));
        Assert.Equal("Boolean", RestConsume.ExampleType("true"));
        Assert.Equal("Date", RestConsume.ExampleType("2026-01-01"));
        Assert.Equal("Text", RestConsume.ExampleType("01001000")); // a code with a leading zero stays text
        Assert.Equal("Text", RestConsume.ExampleType("SP"));
        Assert.Equal("Text", RestConsume.ExampleType(null));
    }

    private static string TypeOf(string sample)
    {
        var shape = RestConsume.Infer(JsonNode.Parse(sample));
        return shape switch
        {
            RestConsume.ScalarShape s => s.Type + (s.Conflict ? "!" : ""),
            RestConsume.ArrayShape { Item: RestConsume.ScalarShape s } => s.Type + (s.Conflict ? "!" : "") + " List",
            RestConsume.ArrayShape { Item: RestConsume.UnknownShape } => "? List",
            RestConsume.UnknownShape => "?",
            _ => shape.GetType().Name,
        };
    }

    [Fact]
    public void JsonValuesGetTheirTypes()
    {
        Assert.Equal("Integer", TypeOf("1"));
        Assert.Equal("Long Integer", TypeOf("1760367600000"));
        Assert.Equal("Decimal", TypeOf("1.0"));
        Assert.Equal("Boolean", TypeOf("false"));
        Assert.Equal("Date", TypeOf("\"2026-10-13\""));
        Assert.Equal("Date Time", TypeOf("\"2026-10-13T15:00:00Z\""));
        Assert.Equal("Date Time", TypeOf("\"2026-10-13T15:00:00.123-03:00\""));
        Assert.Equal("Text", TypeOf("\"2026-10-13T15:00\""));        // no seconds: the platform's ISO reader is not sure of it
        Assert.Equal("Text", TypeOf("\"2026-10-13 15:00:00\""));     // a space, not a T
        Assert.Equal("Text", TypeOf("\"5.5029\""));                  // a number written as a string stays text
        Assert.Equal("Text", TypeOf("\"2026-13-45\""));              // not a date
        Assert.Equal("Decimal List", TypeOf("[1, 2.5]"));
        Assert.Equal("Long Integer List", TypeOf("[1, 3000000000]"));
        Assert.Equal("Date Time List", TypeOf("[\"2026-01-01\", \"2026-01-01T10:00:00Z\"]"));
        Assert.Equal("Text! List", TypeOf("[1, \"a\"]"));
        Assert.Equal("Integer List", TypeOf("[null, 1]"));
        Assert.Equal("? List", TypeOf("[]"));
        Assert.Equal("?", TypeOf("null"));
    }

    [Fact]
    public void NamesAreOutSystemsNames()
    {
        Assert.Equal("RegiaoImediata", RestConsume.Sanitize("regiao-imediata"));
        Assert.Equal("Municipio", RestConsume.Sanitize("município"));
        Assert.Equal("N2019", RestConsume.Sanitize("2019"));
        Assert.Equal("CreatedAt", RestConsume.Sanitize("created_at"));
        Assert.Equal("CurrentValue", RestConsume.Sanitize("current"));
        Assert.Equal("Field", RestConsume.Sanitize("--"));
        Assert.Equal(50, RestConsume.Sanitize(new string('a', 80)).Length);
        Assert.Equal("Feriados", RestConsume.ResourceOf("GetFeriados"));
        Assert.Equal("Estados", RestConsume.ResourceOf("ListarEstados"));
        Assert.Equal("Feriados", RestConsume.ResourceOf("Feriados"));
        Assert.Equal("Getaway", RestConsume.ResourceOf("Getaway"));
        // N1 of the owner's rules: actions are Verb + Client + Object, booleans Is/Has/Can.
        Assert.Equal("GetBrasilApiFeriados", RestConsume.ActionName("BrasilApi", "Feriados", "GET"));
        Assert.Equal("ListGitHubRepos", RestConsume.ActionName("GitHub", "ListRepos", "GET"));
        Assert.Equal("CreatePlaceholderPost", RestConsume.ActionName("Placeholder", "CreatePost", "POST"));
        Assert.Equal("SendShopOrders", RestConsume.ActionName("Shop", "Orders", "POST"));
        Assert.Equal("SaveShopOrder", RestConsume.ActionName("Shop", "Order", "PUT"));
        Assert.Equal("UpdateShopOrder", RestConsume.ActionName("Shop", "Order", "PATCH"));
        Assert.Equal("DeleteShopOrder", RestConsume.ActionName("Shop", "Order", "DELETE"));
        Assert.Equal("CountShapes", RestConsume.ActionName("Shapes", "Count", "GET"));
        Assert.Equal("GetUsgsQuery", RestConsume.ActionName("Usgs", "Query", "GET"));
        Assert.Equal("GetShopGetaway", RestConsume.ActionName("Shop", "Getaway", "GET"));
        Assert.Equal("IsFork", RestConsume.BooleanName("Fork"));
        Assert.Equal("IsActive", RestConsume.BooleanName("IsActive"));
        Assert.Equal("HasMore", RestConsume.BooleanName("HasMore"));
        Assert.Equal("IsIsland", RestConsume.BooleanName("Island"));
        var repos = RestConsume.Build(Data("""{"name":"GitHub","methods":[{"name":"ListRepos","url":"https://api.github.com/orgs/{org=acme}/repos?all=true","sample":[{"private":false,"fork":true,"has_issues":true,"topics":[]}]}]}"""));
        Assert.Equal(["IsPrivate", "IsFork", "HasIssues", "Topics"], repos.Structures.Single().Attributes.Select(a => a.Name));
        Assert.Equal(["private", "fork", "has_issues", "topics"], repos.Structures.Single().Attributes.Select(a => a.Json));
        Assert.Equal("IsAll", repos.Methods[0].Inputs.Single(i => i.Param.Name == "all").InputName);
        Assert.Equal("\"BRL\"", RestConsume.Literal("Text", "BRL"));
        Assert.Equal("30", RestConsume.Literal("Integer", "30"));
        Assert.Equal("#2026-01-01#", RestConsume.Literal("Date", "2026-01-01"));
        Assert.Equal("True", RestConsume.Literal("Boolean", "true"));
    }

    [Fact]
    public void EveryDataProblemHasItsCode()
    {
        Assert.Contains("REST_CONSUME_NO_METHODS", Codes("""{"name":"A","methods":[]}"""));
        Assert.Contains("REST_CONSUME_KEY_INVALID", Codes("""{"name":"A b","methods":[{"name":"M","url":"https://a.example/x","sample":{"a":1}}]}"""));
        Assert.Contains("REST_CONSUME_UNKNOWN_KEYS", Codes("""{"name":"A","methods":[{"name":"M","url":"https://a.example/x","sample":{"a":1},"http":"GET"}]}"""));
        Assert.Contains("REST_CONSUME_URL_INVALID", Codes("""{"name":"A","methods":[{"name":"M","url":"ftp://a.example/x","sample":{"a":1}}]}"""));
        Assert.Contains("REST_CONSUME_URL_INVALID", Codes("""{"name":"A","methods":[{"name":"M","url":"/x","sample":{"a":1}}]}"""));
        Assert.Contains("REST_CONSUME_HOSTS_DIFFER", Codes("""{"name":"A","methods":[{"name":"M","url":"https://a.example/x","sample":{"a":1}},{"name":"N","url":"https://b.example/y","sample":{"a":1}}]}"""));
        Assert.Contains("REST_CONSUME_URL_OUTSIDE_BASE", Codes("""{"name":"A","baseUrl":"https://a.example/v1","methods":[{"name":"M","url":"https://b.example/x","sample":{"a":1}}]}"""));
        Assert.Contains("REST_CONSUME_PARAM_TYPE", Codes("""{"name":"A","methods":[{"name":"M","url":"https://a.example/{id}","params":{"id":"Customer"},"sample":{"a":1}}]}"""));
        Assert.Contains("REST_CONSUME_DUPLICATE_NAME", Codes("""{"name":"A","methods":[{"name":"M","url":"https://a.example/x","sample":{"a":1}},{"name":"m","url":"https://a.example/y","sample":{"a":1}}]}"""));
        Assert.Contains("REST_CONSUME_SAMPLE_MISSING", Codes("""{"name":"A","methods":[{"name":"M","url":"https://a.example/x"}]}"""));
        Assert.Contains("REST_CONSUME_SAMPLE_INVALID", Codes("""{"name":"A","methods":[{"name":"M","url":"https://a.example/x","sample":"{not json"}]}"""));
        Assert.Contains("REST_CONSUME_BODY_ON_GET", Codes("""{"name":"A","methods":[{"name":"M","url":"https://a.example/x","sample":{"a":1},"request":{"b":1}}]}"""));
        // A POST/PUT/PATCH/DELETE needs no sample (no response body); a GET does.
        Assert.Empty(Codes("""{"name":"A","methods":[{"name":"M","verb":"DELETE","url":"https://a.example/x/{id=1}"}]}"""));
        Assert.Empty(Codes("""{"name":"A","methods":[{"name":"M","url":"https://a.example/x","sample":[]}]}"""));
    }

    [Fact]
    public void SamplesBecomeStructuresDeduplicatedByShape()
    {
        var data = Data("""{"name":"Ibge","methods":[{"name":"Estados","url":"https://h.example/estados","sample":[]},{"name":"Municipios","url":"https://h.example/estados/{uf=SP}/municipios","sample":[]}]}""");
        data["methods"]![0]!["sample"] = RestConsumeScenarios.Sample("ibge-estados");
        data["methods"]![1]!["sample"] = RestConsumeScenarios.Sample("ibge-municipios");
        var plan = RestConsume.Build(data);
        var names = plan.Structures.Select(s => s.Base).ToList();
        // estados[].regiao and the UF.regiao of the municipios are one structure; the UF of the two paths of a municipio too,
        // and the UF is the shape of an estado.
        Assert.Equal(["EstadosRegiao", "EstadosItem", "MunicipiosMicrorregiaoMesorregiao", "MunicipiosMicrorregiao", "MunicipiosRegiaoImediata", "MunicipiosItem"], names);
        var municipio = plan.Structures.Single(s => s.Base == "MunicipiosItem");
        Assert.Equal(["Id", "Nome", "Microrregiao", "RegiaoImediata"], municipio.Attributes.Select(a => a.Name));
        Assert.Equal("regiao-imediata", municipio.Attributes[3].Json);
        var meso = plan.Structures.Single(s => s.Base == "MunicipiosMicrorregiaoMesorregiao");
        Assert.Same(plan.Structures.Single(s => s.Base == "EstadosItem"), meso.Attributes.Single(a => a.Name == "UF").Structure);
        Assert.Equal(RestConsume.Body.RecordList, plan.Methods[1].Response);
        Assert.Equal("/estados/{uf}/municipios", plan.Methods[1].Path);
        Assert.Equal("GetIbgeMunicipios", plan.Methods[1].Action);
    }

    [Fact]
    public void MappingsNameEveryAttributeAndGoThroughFunctionsWhereThePlatformNeedsOne()
    {
        var data = Data("""{"name":"Ibge","methods":[{"name":"Municipios","url":"https://h.example/m","sample":[]},{"name":"Posts","verb":"POST","url":"https://h.example/p","request":[{"t":"x","tags":[{"k":1}]}],"sample":{"id":1}}]}""");
        data["methods"]![0]!["sample"] = RestConsumeScenarios.Sample("ibge-municipios");
        var plan = RestConsume.Build(data);
        var names = new RestConsume.Names { Client = "Ibge", Exception = "IbgeError" };
        foreach (var s in plan.Structures) { names.Public[s.Id] = s.Base; names.ClientStructures[s.Id] = s.Base + "Json"; }
        foreach (var m in plan.Methods) { names.Methods[m.Name] = m.Name; names.Actions[m.Name] = m.Action; if (RestConsume.Guarded(plan, m, m.Name)) names.Impls[m.Name] = m.Action + "_Impl"; }
        var functions = RestConsume.MapFunctions(plan);
        foreach (var (s, toClient, list) in functions) names.Functions[RestConsume.FunctionKey(s, toClient, list)] = RestConsume.FunctionBase(s, toClient, list);
        // A record two levels down is one value through its record function; one level down is attribute by attribute.
        Assert.Contains(functions, f => f.Structure.Base == "MunicipiosMicrorregiaoMesorregiao" && !f.ToClient && !f.List);
        Assert.Contains(functions, f => f.Structure.Base == "MunicipiosMicrorregiaoMesorregiaoUFRegiao" && !f.ToClient && !f.List);
        Assert.Equal(3, functions.Count);
        // A list of records inside a request item goes through its list function, toward the client.
        Assert.Contains(functions, f => f.Structure.Base == "PostsRequestTags" && f.ToClient && f.List);
        var (action, hash, _, _) = Assert.Single(RestConsume.Action(plan, plan.Methods[0], names));
        var source = action["steps"]![1]!["args"]!["SourceList"]!.ToString();
        Assert.StartsWith("Municipios.Response mapTo { Id: Id, Nome: Nome, Microrregiao.Id: Microrregiao.Id, Microrregiao.Nome: Microrregiao.Nome, Microrregiao.Mesorregiao: MapMunicipiosMicrorregiaoMesorregiaoFromJson(Microrregiao.Mesorregiao)", source);
        Assert.Equal("IbgeError", action["handlers"]![0]!["steps"]![0]!["raise"]!.ToString());
        Assert.True(action["handlers"]![0]!["logError"]!.GetValue<bool>());
        Assert.Matches("ssam:rest-consume Ibge/GetIbgeMunicipios #" + hash, action["description"]!.ToString());
        // The same data, the same ops (deterministic): the hash is the identity of what is written.
        Assert.Equal(hash, RestConsume.Action(RestConsume.Build(data), RestConsume.Build(data).Methods[0], names)[0].Hash);
        // A POST changes data (AR2): the public entry checks the signed-in user, then calls the private _Impl, which calls
        // the method and holds the AllExceptions handler (the check is never inside its reach).
        var post = RestConsume.Action(plan, plan.Methods[1], names);
        Assert.Equal(["SendIbgePosts", "SendIbgePosts_Impl"], post.Select(p => p.Declaration["name"]!.ToString()));
        var (entry, impl) = (post[0].Declaration, post[1].Declaration);
        Assert.Equal(("service", true, "server", false), (entry["kind"]!.ToString(), entry["public"]!.GetValue<bool>(), impl["kind"]!.ToString(), impl["public"]!.GetValue<bool>()));
        Assert.Equal("GetUserId() = NullIdentifier()", entry["steps"]![0]!["if"]!.ToString());
        Assert.Equal("Is the caller anonymous?", entry["steps"]![0]!["label"]!.ToString());
        Assert.Equal("AccessDenied", entry["steps"]![0]!["then"]![0]!["raise"]!.ToString());
        Assert.Equal("SendIbgePosts_Impl", entry["steps"]![1]!["call"]!.ToString());
        Assert.Null(entry["handlers"]);
        Assert.Equal("RequestBody", impl["steps"]![1]!["args"]!["Request"]!.ToString());
        Assert.Contains("Tags: MapPostsRequestTagsListToJson(Tags)", impl["steps"]![0]!["args"]!["SourceList"]!.ToString());
        Assert.Equal("Return the response", impl["steps"]![2]!["label"]!.ToString());
        Assert.DoesNotContain(action.ToJsonString(), "foreach");
    }

    [Fact]
    public void RootsThatAreNotRecordsAreReadAsTheyCome()
    {
        var plan = RestConsume.Build(Data("""
            {"name":"S","baseUrl":"https://s.example","methods":[
              {"name":"Tags","url":"/t","sample":["a","b"]},{"name":"Count","url":"/c","sample":42},
              {"name":"None","url":"/n","sample":[]},{"name":"Blank","url":"/b","sample":{}},{"name":"Grid","url":"/g","sample":[[1,2],[3,4]]},
              {"name":"Drop","verb":"DELETE","url":"/d/{id=1}"}]}
            """));
        Assert.Equal([RestConsume.Body.ScalarList, RestConsume.Body.Scalar, RestConsume.Body.ScalarList, RestConsume.Body.Raw, RestConsume.Body.Raw, RestConsume.Body.None],
            plan.Methods.Select(m => m.Response));
        Assert.Equal(["REST_CONSUME_TYPE_GUESSED", "REST_CONSUME_RAW_BODY", "REST_CONSUME_RAW_BODY"], plan.Warnings.Select(w => w["code"]!.ToString()));
        var names = new RestConsume.Names { Client = "S", Exception = "SError" };
        foreach (var m in plan.Methods) { names.Methods[m.Name] = m.Name; names.Actions[m.Name] = m.Action; }
        var count = RestConsume.Action(plan, plan.Methods[1], names)[0].Declaration;
        Assert.Equal("CountS", count["name"]!.ToString());
        Assert.Equal("Integer", count["outputs"]![0]!["type"]!.ToString());
        Assert.Equal("TextToInteger(Trim(Count.Response))", count["steps"]![1]!["assign"]!["Result"]!.ToString());
        var rest = RestConsume.RestData(plan, names);
        Assert.Equal("Text", rest["methods"]![1]!["outputs"]![0]!["type"]!.ToString()); // a JSON value is read as text
        Assert.Null(rest["methods"]![5]!["outputs"]);
    }

    [Fact]
    public void TheSchemaListsTheOpAndItsCodes()
    {
        var schema = CommandSurface.Schema("rest-consume");
        Assert.Equal("rest-consume", schema["op"]!.ToString());
        Assert.Contains("REST_CONSUME_SAMPLE_MISSING", schema["codes"]!.AsArray().Select(c => c!.ToString()));
        Assert.Contains("rest-consume", CommandSurface.OperationNames);
        Assert.Contains("oauth2", schema["authTypes"]!.AsArray().Select(c => c!.ToString()));
        Assert.Contains("REST_CREDENTIALS_NOT_IN_MODEL", schema["codes"]!.AsArray().Select(c => c!.ToString()));
    }

    [Fact]
    public void AnAuthenticatedOpPlansItsSettingsHeadersAndCallbacksWithoutACredential()
    {
        var data = Data("""
            {"name":"Acme","auth":{"type":"apiKey","in":"query"},"headers":{"Accept":"application/json"},"correlationHeader":"X-Correlation-Id","timeout":15,
             "methods":[{"name":"GetOrder","url":"https://api.acme.example/v1/orders/{id=1}?expand={expand=items}","headers":{"X-Tenant":"{tenant}","X-Version":"2"},
               "optional":["tenant","expand"],"sample":{"id":1}}]}
            """);
        Assert.Empty(RestConsume.Validate(data, "o11"));
        var plan = RestConsume.Build(data);
        Assert.True(RestConsume.HasCallbacks(plan));
        Assert.Equal(("query", "api_key", 15), (plan.ApiKeyIn, plan.ApiKeyName, plan.Timeout));
        var setting = Assert.Single(plan.Settings);
        Assert.Equal(("AcmeApiKey", true, ""), (setting.Base, setting.Secret, setting.Default));
        var m = plan.Methods[0];
        Assert.Equal(["Id", "Expand", "Tenant", "CorrelationId"], m.Inputs.Select(i => i.InputName));
        var expand = m.Inputs[1].Param;
        Assert.Equal((true, false, "items"), (expand.Query, expand.Mandatory, expand.Default));
        var tenant = m.Inputs[2].Param;
        Assert.Equal((true, false, "X-Tenant"), (tenant.Header, tenant.Mandatory, tenant.OriginalName));
        Assert.Equal(("X-Correlation-Id", false), (m.Inputs[3].Param.OriginalName, m.Inputs[3].Param.Mandatory));
        Assert.Equal([("XVersion", "X-Version", "2")], m.Fixed);
        // A plain op plans nothing of this: no callback, no setting, no header input (it writes what it wrote before).
        var plain = RestConsume.Build(Data("""{"name":"Fx","methods":[{"name":"Latest","url":"https://api.frankfurter.app/latest?from=BRL","sample":{"amount":1}}]}"""));
        Assert.False(RestConsume.HasCallbacks(plain));
        Assert.Empty(plain.Settings);
        Assert.DoesNotContain(plain.Methods[0].Inputs, i => i.Param.Header);
        // A credential in the data is refused, with the settings the generator creates instead.
        var codes = Codes("""{"name":"X","auth":{"type":"bearer","token":"abc"},"headers":{"Authorization":"Bearer abc"},"methods":[{"name":"A","url":"https://x.example/a","sample":{"a":1}}]}""");
        Assert.Equal(2, codes.Count(c => c == "REST_CREDENTIALS_NOT_IN_MODEL"));
    }

    private static bool StudioAvailable()
    {
        try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; }
    }

    private static void Run(Action<string, string> scenario)
    {
        if (!StudioAvailable()) return;
        var root = JobRunner.RepoRoot(Directory.GetCurrentDirectory())!;
        var dir = Path.Combine(root, ".local", "rest-consume-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        scenario(dir, "tests/fixtures/blank-service.oml");
    }

    [Fact] public void EveryFixtureAppliesVerifiesAndReadsBack() => Run(RestConsumeScenarios.EveryFixtureAppliesVerifiesAndReadsBack);
    [Fact] public void TheGateAppliesInOneJob() => Run(RestConsumeScenarios.TheGateAppliesInOneJob);
    [Fact] public void ATakenNameMovesOnAndTheRerunFindsIt() => Run(RestConsumeScenarios.ATakenNameMovesOnAndTheRerunFindsIt);
    [Fact] public void AChangedSampleUpdatesInPlace() => Run(RestConsumeScenarios.AChangedSampleUpdatesInPlace);
    [Fact] public void EveryDataProblemIsOneRefusal() => Run(RestConsumeScenarios.EveryDataProblemIsOneRefusal);
    [Fact] public void EveryAuthModeAppliesVerifiesAndReadsBack() => Run(RestConsumeAuthScenarios.EveryAuthModeAppliesVerifiesAndReadsBack);
    [Fact] public void AnAuthThatChangesRemovesWhatItNoLongerNeeds() => Run(RestConsumeAuthScenarios.AnAuthThatChangesRemovesWhatItNoLongerNeeds);
    [Fact] public void EveryAuthProblemIsOneRefusal() => Run(RestConsumeAuthScenarios.EveryAuthProblemIsOneRefusal);
    [Fact] public void ACallbackTheOpDidNotWriteIsRefused() => Run(RestConsumeAuthScenarios.ACallbackTheOpDidNotWriteIsRefused);
    [Fact] public void BasicAuthNeedsBinaryDataOnO11() => Run(RestConsumeAuthScenarios.BasicAuthNeedsBinaryDataOnO11);
}
