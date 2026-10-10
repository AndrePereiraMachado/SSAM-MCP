using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// The op `rest` (consumed REST): it expands only into the raw verbs the suites prove, refuses every problem of its data at
/// once before anything changes, appends query inputs to the URL Path as the Studio's own generator does, turns a JSON
/// sample into structures through the REST plugin, updates an existing method in place (key and callers kept) and never
/// writes a credential into the model.
/// </summary>
public class RestSpecTests
{
    private static readonly string Root = JobRunner.RepoRoot(Directory.GetCurrentDirectory())!;

    private const string ViaCep = """
    {"client":{"name":"ViaCepApi","baseUrl":"https://viacep.com.br"},
     "structures":[{"name":"GetAddressByCepResponse","attributes":[{"name":"cep","type":"Text","json":"cep"},{"name":"logradouro","type":"Text","json":"logradouro"},{"name":"uf","type":"Text","json":"uf"}]}],
     "methods":[{"name":"GetAddressByCep","http":"GET","path":"/ws/{CEP}/json/","inputs":[{"name":"CEP","type":"Text","in":"url"}],"response":{"structure":"GetAddressByCepResponse"}}]}
    """;

    /// <summary>Aliases renamed by order of definition, so two op lists compare by what they do.</summary>
    internal static string Normalized(IEnumerable<JsonObject> ops)
    {
        var names = new Dictionary<string, string>(StringComparer.Ordinal);
        var list = ops.Select(o => o.DeepClone().AsObject()).ToList();
        foreach (var op in list)
            if (op["as"]?.ToString() is { } alias && !names.ContainsKey(alias)) names[alias] = "$a" + names.Count;
        foreach (var op in list)
            foreach (var key in new[] { "as", "parent", "target", "from", "to" })
                if (op[key]?.ToString() is { } value && names.TryGetValue(value, out var renamed)) op[key] = renamed;
        return string.Join("\n", list.Select(o => o.ToJsonString()));
    }

    [Fact]
    public void SameSpecSameOps()
    {
        var proven = JsonNode.Parse(File.ReadAllText(Path.Combine(Root, "tests", "jobs", "rest-consume-get.json")))!["ops"]!.AsArray()
            .OfType<JsonObject>().Where(o => o["op"]!.ToString() is not ("get" or "find" or "dump"));
        var expansion = RestExpander.Expand(JsonNode.Parse(ViaCep)!.AsObject());
        Assert.Equal(Normalized(proven), Normalized(expansion.Ops));
        Assert.Empty(expansion.Samples);
        Assert.Equal(Normalized(expansion.Ops), Normalized(RestExpander.Expand(JsonNode.Parse(ViaCep)!.AsObject()).Ops));
        Assert.Empty(RestExpander.Validate(JsonNode.Parse(ViaCep)!.AsObject(), "o11"));
    }

    private const string Broken = """
    {"client":{"name":"BrokenApi","baseUrl":"https://example.invalid"},
     "structures":[{"name":"Payload","attributes":[{"name":"Id","type":"Integer","json":"id"}]}],
     "methods":[{"name":"NoSlash","http":"GET","path":"ws/json"},
                {"name":"NoInput","http":"GET","path":"/x/{CEP}"},
                {"name":"BodyOnGet","http":"GET","path":"/get","request":{"structure":"Payload"}},
                {"name":"TwoBodies","http":"POST","path":"/post","inputs":[{"name":"Other","type":"Payload","in":"body"}],"request":{"structure":"Payload"}}]}
    """;

    [Fact]
    public void AllErrorsBeforeAnyChange()
    {
        var codes = RestExpander.Validate(JsonNode.Parse(Broken)!.AsObject(), "o11").Select(p => p.Code).ToList();
        foreach (var code in new[] { "REST_URLPATH_INVALID", "REST_PATH_PARAM_WITHOUT_INPUT", "REST_BODY_ON_GET", "REST_REQUEST_BODY_COUNT" }) Assert.Contains(code, codes);
        // The same job through the runner: one refusal with every problem, before the base is loaded; the base is unchanged.
        if (!StudioAvailable()) return;
        var dir = Work("all-errors");
        var basePath = Path.Combine(Root, "tests", "fixtures", "blank-service.oml");
        var before = IntegrationDocuments.Sha256(File.ReadAllBytes(basePath));
        var job = Path.Combine(dir, "rest-broken.json");
        File.WriteAllText(job, $"{{\"base\":\"tests/fixtures/blank-service.oml\",\"ops\":[{{\"op\":\"rest\",\"data\":{Broken}}}]}}");
        var refusal = Assert.Throws<JobPreflightException>(() => JobRunner.Run(new ModelHost(Path.Combine(dir, "model")), null, job, Path.Combine(dir, "out.oml")));
        var problems = refusal.Problems.Select(p => p!["code"]!.ToString()).ToList();
        foreach (var code in new[] { "REST_URLPATH_INVALID", "REST_PATH_PARAM_WITHOUT_INPUT", "REST_BODY_ON_GET", "REST_REQUEST_BODY_COUNT" }) Assert.Contains(code, problems);
        Assert.All(refusal.Problems, p => Assert.StartsWith("/ops/0/data/methods/", p!["pointer"]!.ToString()));
        Assert.False(File.Exists(Path.Combine(dir, "out.oml")));
        Assert.Equal(before, IntegrationDocuments.Sha256(File.ReadAllBytes(basePath)));
    }

    [Fact]
    public void QueryInputsGoToTheUrlPath()
    {
        var data = JsonNode.Parse("""
        {"client":{"name":"FxApi","baseUrl":"https://api.frankfurter.app"},
         "methods":[{"name":"GetLatest","http":"GET","path":"/latest","inputs":[{"name":"from","type":"Text","in":"query"},{"name":"to","type":"Text"}],"response":{"type":"Text"}}]}
        """)!.AsObject();
        Assert.Empty(RestExpander.Validate(data, "o11"));
        var ops = RestExpander.Expand(data).Ops;
        Assert.Contains(ops, o => o["prop"]?.ToString() == "URLPath" && o["value"]!.ToString() == "/latest?from={from}&to={to}");
        foreach (var input in new[] { "from", "to" })
        {
            var alias = ops.Single(o => o["op"]!.ToString() == "create" && o["name"]?.ToString() == input)["as"]!.ToString();
            Assert.Contains(ops, o => o["target"]?.ToString() == alias && o["prop"]!.ToString() == "InputPlacement" && o["value"]!.ToString() == "UrlPlacement");
            Assert.Contains(ops, o => o["target"]?.ToString() == alias && o["prop"]!.ToString() == "IsMandatory" && o["value"]!.GetValue<bool>() == false);
            Assert.Contains(ops, o => o["target"]?.ToString() == alias && o["prop"]!.ToString() == "DefaultValueBehavior" && o["value"]!.ToString() == "DontSend");
        }
        Assert.Contains(ops, o => o["prop"]?.ToString() == "ResponseFormat" && o["value"]!.ToString() == "PlainText");
    }

    [Fact]
    public void AnInvalidSampleIsRefused()
    {
        foreach (var sample in new[] { "\"{not json\"", "42", "{}", "[]" })
        {
            var data = JsonNode.Parse($"{{\"client\":{{\"name\":\"S\",\"baseUrl\":\"https://example.invalid\"}},\"methods\":[{{\"name\":\"M\",\"http\":\"GET\",\"path\":\"/m\",\"response\":{{\"sample\":{sample}}}}}]}}")!.AsObject();
            Assert.Contains(RestExpander.Validate(data, "o11"), p => p.Code == "REST_SAMPLE_INVALID" && p.Path == "/data/methods/0/response/sample");
        }
    }

    [Fact]
    public void SampleBuildsStructures()
    {
        if (!StudioAvailable()) return;
        var dir = Work("sample");
        var job = Path.Combine(dir, "rest-sample.json");
        File.WriteAllText(job, """
        {"base":"tests/fixtures/blank-service.oml","expectValid":true,"ops":[
          {"op":"rest","data":{"client":{"name":"SampleApi","baseUrl":"https://example.invalid"},
            "methods":[{"name":"GetPlace","http":"GET","path":"/place/{Id}","inputs":[{"name":"Id","type":"Integer","in":"url"}],
                        "response":{"sample":{"cep":"01001-000","uf":"SP","geo":{"lat":1.5,"lng":2.5},"tags":["a","b"]}}}]}},
          {"op":"dump","target":"IRestClient:SampleApi","depth":2}]}
        """);
        var output = Path.Combine(dir, "out.oml");
        var host = new ModelHost(Path.Combine(dir, "model"));
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, null, job, output))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]!.ToJsonString() + result["policyMessages"]);
        var integration = Assert.Single(result["integration"]!.AsArray())!;
        Assert.Equal("rest", integration["op"]!.ToString());
        Assert.Contains("IRestAction:GetPlace", integration["imported"]!.AsArray().Select(i => i!.ToString()));
        var structures = integration["imported"]!.AsArray().Select(i => i!.ToString()).Where(i => i.StartsWith("IRestStructure:")).ToList();
        Assert.True(structures.Count >= 2, "the nested object becomes its own structure: " + string.Join(", ", structures));
        // NameInJSON of every attribute the plugin created, read back with get on the saved module.
        var dump = result["results"]!.AsArray().Single(r => r!["op"]!.ToString() == "dump")!["result"]!;
        var attributes = dump["children"]!.AsArray().Where(c => c!["type"]!.ToString().Contains("RestStructure"))
            .SelectMany(s => s!["children"]?.AsArray().Select(a => "@" + a!["key"]!.ToString()) ?? []).ToList();
        Assert.NotEmpty(attributes);
        var reads = Path.Combine(dir, "read.json");
        File.WriteAllText(reads, new JsonObject { ["ops"] = new JsonArray(attributes.Select(a => (JsonNode)new JsonObject { ["op"] = "get", ["target"] = a }).ToArray()) }.ToJsonString());
        var read = JsonSerializer.SerializeToNode(JobRunner.Run(host, output, reads, Path.Combine(dir, "read.oml")))!;
        var names = read["results"]!.AsArray().Select(r => r!["result"]!).Select(g => (g["NameInJSON"] ?? g["properties"]?["NameInJSON"])?.ToString()).ToList();
        foreach (var json in new[] { "cep", "uf", "geo", "lat", "lng", "tags" }) Assert.Contains(json, names);
    }

    [Fact]
    public void UpdateInPlaceKeepsTheKeyAndTheCaller()
    {
        if (!StudioAvailable()) return;
        var dir = Work("update");
        var job = Path.Combine(dir, "rest-update.json");
        File.WriteAllText(job, """
        {"base":"job:rest-consume-call","expectValid":true,"ops":[
          {"op":"get","target":"IRestAction:GetAddressByCep"},
          {"op":"rest","data":{"client":{"name":"ViaCepApi"},
            "methods":[{"name":"GetAddressByCep","http":"GET","path":"/ws/{CEP}/json","inputs":[{"name":"CEP","type":"Text","in":"url"},{"name":"callback","type":"Text","in":"query"}],
                        "response":{"structure":"GetAddressByCepResponse"}}]}},
          {"op":"get","target":"IRestAction:GetAddressByCep"},
          {"op":"usages","target":"IRestAction:GetAddressByCep"}]}
        """);
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "model")), null, job, Path.Combine(dir, "out.oml")))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]!.ToJsonString() + result["policyMessages"]);
        var rows = result["results"]!.AsArray();
        var gets = rows.Where(r => r!["op"]!.ToString() == "get").Select(r => r!["result"]!).ToArray();
        Assert.Equal(gets[0]["key"]!.ToString(), gets[1]["key"]!.ToString());
        Assert.Equal("/ws/{CEP}/json?callback={callback}", gets[1]["URLPath"]?.ToString() ?? gets[1]["properties"]?["URLPath"]?.ToString());
        var usages = rows.Single(r => r!["op"]!.ToString() == "usages")!["result"]!;
        Assert.True(usages["real"]!.GetValue<int>() > 0, usages.ToJsonString());
        var report = Assert.Single(result["integration"]!.AsArray())!;
        Assert.Contains("IRestAction:GetAddressByCep", report["updated"]!.AsArray().Select(u => u!.ToString()));
        Assert.False(report["client"]!["created"]!.GetValue<bool>());
    }

    [Fact]
    public void CredentialsNeverGoInTheModel()
    {
        var data = JsonNode.Parse("""{"client":{"name":"Secure","baseUrl":"https://example.invalid","auth":{"type":"Basic","username":"u","password":"p"}},"methods":[{"name":"M","http":"GET","path":"/m"}]}""")!.AsObject();
        var odc = Assert.Single(RestExpander.Validate(data, "odc"), p => p.Code == "REST_CREDENTIALS_NOT_IN_MODEL");
        Assert.False(odc.SsamRule);
        Assert.Contains("Authorization", odc.Fix);
        var o11 = Assert.Single(RestExpander.Validate(data, "o11"), p => p.Code == "REST_CREDENTIALS_NOT_IN_MODEL");
        Assert.True(o11.SsamRule);
        Assert.True(o11.ToJson(0)["ssamRule"]!.GetValue<bool>());
        // In the whole-job preflight the rule keeps ssamRule.
        var preflight = JobPreflight.Analyze(new JsonArray(new JsonObject { ["op"] = "rest", ["data"] = data.DeepClone() }));
        Assert.Contains(preflight["problems"]!.AsArray(), p => p!["code"]!.ToString() == "REST_CREDENTIALS_NOT_IN_MODEL" && p["ssamRule"]?.GetValue<bool>() == true);
    }

    private static string Work(string name)
    {
        var dir = Path.Combine(Root, ".local", "rest-spec-tests", name, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static bool StudioAvailable()
    {
        try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; }
    }
}
