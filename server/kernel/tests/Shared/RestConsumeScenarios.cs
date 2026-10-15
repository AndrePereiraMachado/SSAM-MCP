using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Linked into both test projects: the generator `rest-consume` (RestConsume.cs, Verbs.RestConsume.cs) applied by JobRunner to
/// the lane's blank fixture, offline, with the public-API-shaped samples of tests/fixtures/rest-consume: the 4 APIs of the
/// 2026-10-13 gate (BrasilAPI feriados, Frankfurter latest, IBGE estados and municipios, REST Countries alpha) and other
/// families (parallel arrays and date-times, numbers written as strings, nulls and empty arrays, lists of lists, a POST with
/// a body, a list of texts, a single value, an empty list, an empty object). Each scenario reads the module back with a
/// second job: the same op again finds every element by its marker and changes nothing; find shows no For Each and no
/// JavaScript; a name the module already uses moves to the next free one; a changed sample updates in place (same keys).
/// </summary>
public static class RestConsumeScenarios
{
    private static string Root => Up(Environment.CurrentDirectory) ?? Up(AppContext.BaseDirectory) ?? throw new InvalidOperationException("kernel root (MANIFESTO.md) not found");

    private static string? Up(string? dir)
    {
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir;
    }

    /// <summary>A file of tests/fixtures (e.g. rest-consume/producers/BinaryData.avsig).</summary>
    public static string Fixture(string relative) => Path.Combine(Root, "tests", "fixtures", relative);

    public static JsonNode Sample(string name) => JsonNode.Parse(File.ReadAllText(Path.Combine(Root, "tests", "fixtures", "rest-consume", name + ".json")))!;

    private static JsonObject Op(string name, JsonArray methods, JsonObject? extra = null)
    {
        var data = new JsonObject { ["name"] = name };
        foreach (var (k, v) in extra ?? new JsonObject()) data[k] = v?.DeepClone();
        data["methods"] = methods;
        return new JsonObject { ["op"] = "rest-consume", ["data"] = data };
    }

    private static JsonObject M(string name, string url, string? sample = null, JsonObject? extra = null)
    {
        var m = new JsonObject { ["name"] = name, ["url"] = url };
        if (sample != null) m["sample"] = Sample(sample);
        foreach (var (k, v) in extra ?? new JsonObject()) m[k] = v?.DeepClone();
        return m;
    }

    /// <summary>The 4 APIs of the gate, as a model writes them (plus the samples the facade pins).</summary>
    public static JsonArray GateOps() =>
    [
        Op("BrasilApi", [M("Feriados", "https://brasilapi.com.br/api/feriados/v1/{ano=2026}", "brasilapi-feriados")]),
        Op("Frankfurter", [M("Latest", "https://api.frankfurter.app/latest?from=BRL", "frankfurter-latest")]),
        Op("Ibge", [M("Estados", "https://servicodados.ibge.gov.br/api/v1/localidades/estados", "ibge-estados"),
                    M("Municipios", "https://servicodados.ibge.gov.br/api/v1/localidades/estados/{uf=SP}/municipios", "ibge-municipios")]),
        Op("RestCountries", [M("Alpha", "https://restcountries.com/v3.1/alpha/{codigo=BR}", "restcountries-alpha")]),
    ];

    /// <summary>Every fixture: the gate and the other public-API shapes, with the expose variants.</summary>
    public static JsonArray AllOps()
    {
        var ops = GateOps();
        ops.Add(Op("OpenMeteo", [M("Forecast", "https://api.open-meteo.com/v1/forecast?latitude=-23.55&longitude=-46.63&current=temperature_2m", "openmeteo-forecast")]));
        ops.Add(Op("AwesomeApi", [M("GetLast", "https://economia.awesomeapi.com.br/json/last/{pair=USD-BRL}", "awesomeapi-numbers-as-strings", new JsonObject { ["resource"] = "Cotacao" })]));
        ops.Add(Op("GitHub", [M("ListRepos", "https://api.github.com/orgs/{org=acme}/repos?per_page=30", "github-repos-nulls")]));
        ops.Add(Op("Usgs", [M("Query", "https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minmagnitude={min=4.5}", "geojson-earthquakes")]));
        ops.Add(Op("Placeholder", [
            M("CreatePost", "/posts", "jsonplaceholder-post-response", new JsonObject { ["verb"] = "POST", ["request"] = Sample("jsonplaceholder-post-request") }),
            M("DeletePost", "/posts/{id=1}", null, new JsonObject { ["verb"] = "DELETE" })],
            new JsonObject { ["baseUrl"] = "https://jsonplaceholder.typicode.com" }));
        ops.Add(Op("Shapes", [
            M("Tags", "/tags", "tags-scalar-list"), M("Count", "/count?since={since=2026-01-01}", "count-scalar"),
            M("Nothing", "/nothing", "empty-list"), M("Blank", "/blank", "empty-object")],
            new JsonObject { ["baseUrl"] = "https://shapes.example/api", ["expose"] = new JsonObject { ["serviceActions"] = false }, ["errors"] = new JsonObject { ["exception"] = "ShapesUnavailable" } }));
        ops.Add(Op("ClientOnly", [M("Ping", "https://ping.example/v1/ping", "tags-scalar-list")], new JsonObject { ["expose"] = false }));
        return ops;
    }

    public static JsonNode Run(string dir, string name, JsonArray ops, string fixture, string? basePath = null, IReadOnlyDictionary<string, string>? bindings = null)
    {
        var job = new JsonObject { ["base"] = fixture, ["expectValid"] = true, ["ops"] = ops.DeepClone() };
        var path = Path.Combine(dir, name + ".json");
        File.WriteAllText(path, job.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        return JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "work-" + name)), basePath, path, Path.Combine(dir, name + ".oml"), null, bindings))!;
    }

    private static List<JsonObject> Reports(JsonNode result) => result["integration"]!.AsArray().OfType<JsonObject>().ToList();

    private static void Valid(JsonNode result)
    {
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]!.ToJsonString());
        Assert.True(result["isValid"]!.GetValue<bool>(), result["details"]!.ToJsonString());
        // Nothing new the Verify calls an error (a setup op's own warning, an unused action, may be new).
        Assert.DoesNotContain(result["validation"]!["new"]!.AsArray().OfType<JsonObject>(), m => m["type"]?.ToString() == "Error");
    }

    private static JsonArray Found(JsonNode result, int op) => result["results"]![op]!["result"]!.AsArray();

    private static string Signature(JsonNode result, string action)
        => Reports(result).SelectMany(r => r["generated"]!["methods"]!.AsArray()).OfType<JsonObject>()
            .Single(m => m["action"]?["name"]?.ToString() == action)["action"]!["signature"]!.ToString();

    /// <summary>Every fixture applies in one job, the Verify accepts it, and the second run of the same ops changes nothing.</summary>
    public static void EveryFixtureAppliesVerifiesAndReadsBack(string dir, string fixture)
    {
        var first = Run(dir, "rc-all", AllOps(), fixture);
        Valid(first);
        var reports = Reports(first);
        Assert.Equal(11, reports.Count);
        Assert.All(reports, r => Assert.True(r["changed"]!.GetValue<bool>()));
        Assert.DoesNotContain(reports.SelectMany(r => r["warnings"]!.AsArray()).OfType<JsonObject>(), w => w["code"]!.ToString() == "REST_CONSUME_MAPPING");
        // The signatures the receipt lists (so the model never reads the module back).
        Assert.Equal("GetBrasilApiFeriados(Ano: Integer) -> Result: FeriadosItem List", Signature(first, "GetBrasilApiFeriados"));
        Assert.Equal("GetFrankfurterLatest(From: Text? = \"BRL\") -> Result: Latest", Signature(first, "GetFrankfurterLatest"));
        Assert.Equal("GetIbgeMunicipios(Uf: Text) -> Result: MunicipiosItem List", Signature(first, "GetIbgeMunicipios"));
        Assert.Equal("GetRestCountriesAlpha(Codigo: Text) -> Result: AlphaItem List", Signature(first, "GetRestCountriesAlpha"));
        Assert.Equal("GetAwesomeApiLast(Pair: Text) -> Result: Cotacao", Signature(first, "GetAwesomeApiLast"));
        Assert.Equal("CreatePlaceholderPost(Request: CreatePostRequest) -> Result: CreatePost", Signature(first, "CreatePlaceholderPost"));
        Assert.Equal("CountShapes(Since: Date) -> Result: Integer", Signature(first, "CountShapes"));
        Assert.Equal("server", Reports(first).Single(r => r["client"]!["name"]!.ToString() == "Shapes")["generated"]!["actionKind"]!.ToString());
        Assert.Null(Reports(first).Single(r => r["client"]!["name"]!.ToString() == "ClientOnly")["generated"]!["actionKind"]);
        var warnings = reports.SelectMany(r => r["warnings"]!.AsArray()).OfType<JsonObject>().Select(w => w["code"]!.ToString()).ToList();
        Assert.Contains("REST_CONSUME_TYPE_GUESSED", warnings);   // nulls and empty lists
        Assert.Contains("REST_CONSUME_RAW_BODY", warnings);        // the empty object
        // Read back: the same ops again change nothing; no For Each, no JavaScript; every action and public structure is there.
        var again = AllOps();
        var at = again.Count;
        foreach (var type in new[] { "IForEachNode", "IJavaScriptNode", "IServiceAction", "IRestClient", "IUserException" })
            again.Add(new JsonObject { ["op"] = "find", ["type"] = type, ["max"] = 500 });
        var second = Run(dir, "rc-all-again", again, fixture, Path.Combine(dir, "rc-all.oml"));
        Valid(second);
        Assert.All(Reports(second), r => Assert.False(r["changed"]!.GetValue<bool>(), r.ToJsonString()));
        Assert.All(Reports(second), r => Assert.Empty(r["imported"]!.AsArray()));
        Assert.All(Reports(second), r => Assert.Empty(r["updated"]!.AsArray()));
        Assert.Equal(first["objects"]!.GetValue<int>(), second["objects"]!.GetValue<int>());
        Assert.Empty(Found(second, at));
        Assert.Empty(Found(second, at + 1));
        Assert.Equal(11, Found(second, at + 2).Count);     // 16 methods: Shapes' 4 are public server actions, ClientOnly has no action
        Assert.Equal(11, Found(second, at + 3).Count);     // 11 clients
        Assert.Equal(11, Found(second, at + 4).Count);     // one exception per client with actions, and AccessDenied
    }

    /// <summary>The gate's 4 APIs alone (what the before/after measure compares): one job, Verify clean.</summary>
    public static void TheGateAppliesInOneJob(string dir, string fixture)
    {
        var result = Run(dir, "rc-gate", GateOps(), fixture);
        Valid(result);
        Assert.Equal(4, Reports(result).Count);
        Assert.Equal(5, Reports(result).Sum(r => r["generated"]!["methods"]!.AsArray().Count));
    }

    /// <summary>A name the module already uses for something it did not write takes the next free one; the rerun finds it.</summary>
    public static void ATakenNameMovesOnAndTheRerunFindsIt(string dir, string fixture)
    {
        var setup = new JsonArray(
            JsonNode.Parse("""{"op":"spec","data":{"structures":[{"name":"FeriadosItem","public":true,"attributes":[{"name":"Other","type":"Text"}]}]}}"""),
            JsonNode.Parse("""{"op":"logic","data":{"actions":[{"name":"GetBrasilApiFeriados","kind":"server","outputs":[{"name":"X","type":"Integer"}],"steps":[{"assign":{"X":"1"}}]}]}}"""),
            JsonNode.Parse("""{"op":"create","parent":"@espace","type":"IUserException","name":"BrasilApiError"}"""),
            GateOps()[0]!.DeepClone());
        var first = Run(dir, "rc-taken", setup, fixture);
        Valid(first);
        var report = Reports(first).Single();
        var renamed = report["renamed"]!.AsArray().OfType<JsonObject>().ToDictionary(r => r["wanted"]!.ToString(), r => r["name"]!.ToString());
        Assert.Equal("FeriadosItem2", renamed["FeriadosItem"]);
        Assert.Equal("GetBrasilApiFeriados2", renamed["GetBrasilApiFeriados"]);
        Assert.Equal("BrasilApiError", report["generated"]!["exception"]!.ToString()); // an exception of that name is reused
        Assert.Contains("IUserException:BrasilApiError", report["unchanged"]!.AsArray().Select(n => n!.ToString()));
        var second = Run(dir, "rc-taken-again", [GateOps()[0]!.DeepClone()], fixture, Path.Combine(dir, "rc-taken.oml"));
        Valid(second);
        var again = Reports(second).Single();
        Assert.False(again["changed"]!.GetValue<bool>(), again.ToJsonString());
        Assert.Null(again["renamed"]);
        Assert.Equal("GetBrasilApiFeriados2(Ano: Integer) -> Result: FeriadosItem2 List", Signature(second, "GetBrasilApiFeriados2"));
    }

    /// <summary>A changed sample updates the client, the public structure and the action in place: same keys, Verify clean.</summary>
    public static void AChangedSampleUpdatesInPlace(string dir, string fixture)
    {
        static JsonArray Ops(JsonNode sample) => [Op("Fx", [new JsonObject { ["name"] = "Latest", ["url"] = "https://api.frankfurter.app/latest?from=BRL", ["sample"] = sample }])];
        var a = JsonNode.Parse("""{"amount":1,"base":"BRL","date":"2026-10-13","rates":{"USD":0.19,"EUR":0.17}}""")!;
        var b = JsonNode.Parse("""{"amount":1,"base":"BRL","date":"2026-10-13","rates":{"USD":0.19,"JPY":31.5},"source":"ECB"}""")!;
        JsonArray Keys(JsonArray ops) { ops.Add(new JsonObject { ["op"] = "find", ["name"] = "GetFxLatest" }); ops.Add(new JsonObject { ["op"] = "find", ["name"] = "Latest", ["type"] = "IStructure" }); return ops; }
        var first = Run(dir, "rc-change-a", Keys(Ops(a)), fixture);
        Valid(first);
        var second = Run(dir, "rc-change-b", Keys(Ops(b)), fixture, Path.Combine(dir, "rc-change-a.oml"));
        Valid(second);
        var report = Reports(second).Single();
        Assert.True(report["changed"]!.GetValue<bool>());
        var updated = report["updated"]!.AsArray().Select(n => n!.ToString()).ToList();
        Assert.Contains("IStructure:Latest", updated);
        Assert.Contains("IServiceAction:GetFxLatest", updated);
        Assert.Contains("IStructure:LatestRates", updated);
        string Key(JsonNode result, int op) => Found(result, op).Single()!["key"]!.ToString();
        Assert.Equal(Key(first, 1), Key(second, 1));
        Assert.Equal(Key(first, 2), Key(second, 2));
        Assert.Equal(report["client"]!["key"]!.ToString(), Reports(first).Single()["client"]!["key"]!.ToString());
    }

    /// <summary>Every problem of the data in one refusal, before anything is written.</summary>
    public static void EveryDataProblemIsOneRefusal(string dir, string fixture)
    {
        var ops = new JsonArray(JsonNode.Parse("""
            {"op":"rest-consume","data":{"name":"Bad Name","methods":[
              {"name":"NoSample","url":"https://a.example/x"},
              {"name":"BadUrl","url":"ftp://a.example/x","sample":{"a":1}},
              {"name":"Post","verb":"GET","url":"https://a.example/y","sample":{"a":1},"request":{"b":1},"colour":"red"}]}}
            """));
        var error = Assert.ThrowsAny<Exception>(() => Run(dir, "rc-refused", ops, fixture));
        var codes = (Errors.FindCoded(error)?.Problems ?? new JsonArray()).OfType<JsonObject>().Select(p => p["code"]!.ToString()).ToList();
        Assert.True(codes.Count > 0, Errors.Text(error));
        foreach (var code in new[] { "REST_CONSUME_KEY_INVALID", "REST_CONSUME_SAMPLE_MISSING", "REST_CONSUME_URL_INVALID", "REST_CONSUME_BODY_ON_GET", "REST_CONSUME_UNKNOWN_KEYS" })
            Assert.Contains(code, codes);
        Assert.False(File.Exists(Path.Combine(dir, "rc-refused.oml")));
    }
}
