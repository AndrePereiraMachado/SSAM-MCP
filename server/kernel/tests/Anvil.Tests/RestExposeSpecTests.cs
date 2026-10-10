using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// The op `rest-expose`: every REST_EXPOSE_* refusal comes before any op (data checks pure, module checks against the
/// action's signature), and a valid mapping becomes one logic action of kind rest whose body is a call and an assign
/// linked from the method's own Start to its own End, a module the Verify accepts.
/// </summary>
public class RestExposeSpecTests
{
    private static readonly string Root = JobRunner.RepoRoot(Directory.GetCurrentDirectory())!;

    private static List<string> Codes(string data) => RestExposeExpander.Validate(JsonNode.Parse(data)!.AsObject()).Select(p => p.Code).ToList();

    private static readonly RestExposeExpander.ActionSignature CepInfoGet = new("IServerAction:CepInfo_Get", "CepInfo_Get",
        [("Cep", "Text", true), ("Detail", "Boolean", false)], [("Info", "CepInfo")]);

    [Fact]
    public void EachDataProblemIsRefusedWithItsCode()
    {
        Assert.Contains("REST_EXPOSE_PATH_PARAM_WITHOUT_URL_INPUT", Codes("""{"service":{"name":"S"},"methods":[{"name":"M","http":"GET","path":"/m/{Id}","inputs":[{"name":"Id","type":"Text","in":"header"}]}]}"""));
        Assert.Contains("REST_EXPOSE_BODY_INPUTS", Codes("""{"service":{"name":"S"},"methods":[{"name":"M","http":"POST","path":"/m","inputs":[{"name":"A","type":"Text","in":"body"},{"name":"B","type":"Text","in":"body"}]}]}"""));
        Assert.Contains("REST_EXPOSE_BODY_ON_GET", Codes("""{"service":{"name":"S"},"methods":[{"name":"M","http":"GET","path":"/m","inputs":[{"name":"A","type":"Text","in":"body"}]}]}"""));
        Assert.Contains("REST_EXPOSE_BODY_OUTPUTS", Codes("""{"service":{"name":"S"},"methods":[{"name":"M","http":"GET","path":"/m","outputs":[{"name":"A","type":"Text"},{"name":"B","type":"Text"}],"steps":[]}]}"""));
        Assert.Contains("REST_EXPOSE_PATH_CONFLICT", Codes("""{"service":{"name":"S"},"methods":[{"name":"A","http":"GET","path":"/x/{Id}","inputs":[{"name":"Id","type":"Text"}]},{"name":"B","http":"GET","path":"/x/{Key}","inputs":[{"name":"Key","type":"Text"}]}]}"""));
        Assert.Contains("REST_EXPOSE_URLPATH_INVALID", Codes("""{"service":{"name":"S"},"methods":[{"name":"M","http":"GET","path":"m/{"}]}"""));
        Assert.Contains("REST_EXPOSE_AUTH_FLOW_UNSUPPORTED", Codes("""{"service":{"name":"S","authentication":"Basic"},"methods":[]}"""));
        Assert.Contains("REST_EXPOSE_UNKNOWN_KEYS", Codes("""{"service":{"name":"S"},"methods":[{"name":"M","verb":"GET"}]}"""));
        Assert.Empty(Codes("""{"service":{"name":"S"},"methods":[{"name":"M","http":"GET","path":"/m/{Id}","inputs":[{"name":"Id","type":"Text"}],"steps":[{"assign":{"Id2":"Id"}}]}]}""").Where(c => c != "REST_EXPOSE_KEY_INVALID"));
    }

    [Fact]
    public void ModuleProblemsAreRefusedBeforeAnyOp()
    {
        RestExposeExpander.ActionSignature? Lookup(string reference) => reference.EndsWith("CepInfo_Get") ? CepInfoGet : null;
        var missing = JsonNode.Parse("""{"service":{"name":"S"},"methods":[{"name":"M","http":"GET","path":"/m","action":"IServerAction:Nope"}]}""")!.AsObject();
        Assert.Equal("REST_EXPOSE_ACTION_NOT_FOUND", Assert.Single(RestExposeExpander.CheckAgainstModule(missing, Lookup, new Dictionary<string, string>())).Code);
        var unmapped = JsonNode.Parse("""{"service":{"name":"S"},"methods":[{"name":"M","http":"GET","path":"/m","outputs":[{"name":"Info","type":"CepInfo"}],"action":"IServerAction:CepInfo_Get"}]}""")!.AsObject();
        Assert.Equal("REST_EXPOSE_ARGUMENT_UNMAPPED", Assert.Single(RestExposeExpander.CheckAgainstModule(unmapped, Lookup, new Dictionary<string, string>())).Code);
        var mismatch = JsonNode.Parse("""{"service":{"name":"S"},"methods":[{"name":"M","http":"GET","path":"/m/{Cep}","inputs":[{"name":"Cep","type":"Integer"}],"outputs":[{"name":"Info","type":"CepInfo"}],"action":"IServerAction:CepInfo_Get"}]}""")!.AsObject();
        Assert.Equal("REST_EXPOSE_TYPE_MISMATCH", Assert.Single(RestExposeExpander.CheckAgainstModule(mismatch, Lookup, new Dictionary<string, string>())).Code);
        var conflict = JsonNode.Parse("""{"service":{"name":"S"},"methods":[{"name":"New","http":"GET","path":"/old/{Id}","inputs":[{"name":"Id","type":"Text"}],"steps":[{"assign":{"Id2":"Id"}}]}]}""")!.AsObject();
        Assert.Equal("REST_EXPOSE_PATH_CONFLICT", Assert.Single(RestExposeExpander.CheckAgainstModule(conflict, Lookup, new Dictionary<string, string> { ["GET /old/{}"] = "Old" })).Code);
        conflict["remove"] = new JsonArray("Old");
        Assert.Empty(RestExposeExpander.CheckAgainstModule(conflict, Lookup, new Dictionary<string, string> { ["GET /old/{}"] = "Old" }));
    }

    private const string Valid = """
    {"service":{"name":"CepService"},
     "methods":[{"name":"GetCep","http":"GET","path":"/cep/{Cep}","inputs":[{"name":"Cep","type":"Text","in":"url"}],
                 "outputs":[{"name":"Info","type":"CepInfo"}],"action":"IServerAction:CepInfo_Get"}]}
    """;

    [Fact]
    public void AValidMappingGeneratesTheCallTheAssignAndTheLinks()
    {
        var data = JsonNode.Parse(Valid)!.AsObject();
        Assert.Empty(RestExposeExpander.Validate(data));
        Assert.Empty(RestExposeExpander.CheckAgainstModule(data, _ => CepInfoGet, new Dictionary<string, string>()));
        var expansion = RestExposeExpander.Expand(data, null, new Dictionary<string, string>(), _ => CepInfoGet);
        Assert.Equal("IRestService", expansion.Ops[0]["type"]!.ToString());
        var logic = expansion.Ops.Single(o => o["op"]!.ToString() == "logic")["data"]!.AsObject();
        var action = logic["actions"]![0]!.AsObject();
        Assert.Equal("rest", action["kind"]!.ToString());
        Assert.Equal("IRestService:CepService", action["owner"]!.ToString());
        var steps = action["steps"]!.AsArray();
        Assert.Equal("IServerAction:CepInfo_Get", steps[0]!["call"]!.ToString());
        Assert.Equal("Cep", steps[0]!["args"]!["Cep"]!.ToString());
        Assert.Equal("CepInfo_Get.Info", steps[1]!["assign"]!["Info"]!.ToString());
        var ops = LogicExpander.Expand(logic, c => c.FirstOrDefault());
        Assert.Contains(ops, o => o["op"]!.ToString() == "create" && o["type"]!.ToString() == "IRestServiceAction" && o["parent"]!.ToString() == "IRestService:CepService");
        Assert.Contains(ops, o => o["type"]?.ToString() == "IRestServiceActionInput" && o["name"]!.ToString() == "Cep");
        Assert.Contains(ops, o => o["type"]?.ToString() == "IExecuteServerActionNode");
        Assert.Contains(ops, o => o["type"]?.ToString() == "IAssignNode");
        Assert.Contains(ops, o => o["op"]!.ToString() == "link" && o["from"]!.ToString() == "$GetCep/#IStartNode");
        Assert.Contains(ops, o => o["op"]!.ToString() == "link" && o["to"]!.ToString() == "$GetCep/#IEndNode");
        Assert.DoesNotContain(ops, o => o["type"]?.ToString() is "IStartNode" or "IEndNode");
        Assert.Contains(ops, o => o["prop"]?.ToString() == "URLPath" && o["value"]!.ToString() == "/cep/{Cep}");
    }

    [Fact]
    public void TheValidMappingIsAValidModule()
    {
        if (!StudioAvailable()) return;
        var dir = Path.Combine(Root, ".local", "rest-expose-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var job = Path.Combine(dir, "rest-expose-valid.json");
        File.WriteAllText(job, $$$"""
        {"base":"tests/fixtures/blank-service.oml","expectValid":true,"ops":[
          {"op":"spec","data":{"structures":[{"name":"CepInfo","attributes":[{"name":"Cep","type":"Text"},{"name":"Uf","type":"Text"}]}]}},
          {"op":"logic","data":{"actions":[{"name":"CepInfo_Get","inputs":[{"name":"Cep","type":"Text"}],"outputs":[{"name":"Info","type":"CepInfo"}],
            "steps":[{"assign":{"Info.Cep":"Cep","Info.Uf":"\"SP\""}}]}]}},
          {"op":"rest-expose","data":{{{Valid}}}}]}
        """);
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "model")), null, job, Path.Combine(dir, "out.oml")))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]!.ToJsonString() + result["policyMessages"]);
        Assert.True(result["isValid"]!.GetValue<bool>());
        var report = Assert.Single(result["integration"]!.AsArray())!;
        Assert.Equal("rest-expose", report["op"]!.ToString());
        Assert.True(report["service"]!["created"]!.GetValue<bool>());
        Assert.Contains("IRestServiceAction:GetCep", report["imported"]!.AsArray().Select(i => i!.ToString()));
        // The refusal of the same op with an unmapped mandatory input changes nothing: it comes before its first op.
        var refused = Path.Combine(dir, "rest-expose-refused.json");
        File.WriteAllText(refused, File.ReadAllText(job).Replace("\"inputs\":[{\"name\":\"Cep\",\"type\":\"Text\",\"in\":\"url\"}]", "\"inputs\":[]").Replace("/cep/{Cep}", "/cep"));
        var error = Assert.ThrowsAny<Exception>(() => JobRunner.Run(new ModelHost(Path.Combine(dir, "model2")), null, refused, Path.Combine(dir, "refused.oml")));
        Assert.Contains("REST_EXPOSE_ARGUMENT_UNMAPPED", Errors.FindCoded(error)?.Code + " " + Errors.Text(error));
        Assert.False(File.Exists(Path.Combine(dir, "refused.oml")));
    }

    private static bool StudioAvailable()
    {
        try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; }
    }
}
