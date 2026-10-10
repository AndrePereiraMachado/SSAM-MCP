using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Preflight;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// Atritos 2, lane F2 in the ODC kernel (the same Kernel/** sources compiled against the ODC Studio): coded refusals rebased
/// onto the job (I4), actions keyed by (owner, name) (I5), the A04 rules with the ODC lane's roots, the apply that collects
/// every failure (phase "apply", I6) and the kind accepted with or without its I (A27).
/// </summary>
public sealed class Pa2F2OdcTests
{
    private static readonly string Root = FindRoot();

    private static JsonObject Analyze(string json)
    {
        var job = JsonNode.Parse(json)!;
        return JobPreflight.Analyze(job["ops"]!.AsArray(), job, []);
    }

    private static JsonObject[] Problems(JsonObject result, string code)
        => result["problems"]!.AsArray().OfType<JsonObject>().Where(p => p["code"]!.GetValue<string>() == code).ToArray();

    [Fact]
    public void ACodedRefusalIsRebasedOntoTheJobInTheOdcLane()
    {
        Assert.Equal("odc", MessageExpectations.Lane);
        var problems = new JsonArray(JobPreflight.PublicProblem(JobPreflight.Problem(null, "/actions/0/steps/1", "LOGIC_INVALID", "error", "a step", "its fix")));
        var rebased = CodedProblems.From(new KernelRefusalException("LOGIC_INVALID", "one fault", problems), 2, "logic", "/ops/2/data", "/actions/0", "/ops/2/data/actions/3")!;
        Assert.Equal("/ops/2/data/actions/3/steps/1", Assert.Single(rebased)["pointer"]!.GetValue<string>());
    }

    [Fact]
    public void TheSameScreenActionInTwoScreensIsLegalInTheOdcLane()
    {
        static string Screen(string owner) => "{\"name\":\"Voltar\",\"kind\":\"screen\",\"owner\":\"" + owner + "\",\"steps\":[]}";
        var legal = Analyze("{\"ops\":[{\"op\":\"logic\",\"data\":{\"actions\":[" + Screen("IMobileScreen:Quotes") + "," + Screen("IMobileScreen:Options") + "]}}]}");
        Assert.Empty(Problems(legal, "LOGIC_DUPLICATE_ACTION"));
        var twice = Analyze("{\"ops\":[{\"op\":\"logic\",\"data\":{\"actions\":[" + Screen("IMobileScreen:Quotes") + "]}},{\"op\":\"logic\",\"data\":{\"actions\":[" + Screen("IMobileScreen:Quotes") + "]}}]}");
        Assert.Single(Problems(twice, "LOGIC_DUPLICATE_ACTION"));
    }

    [Fact]
    public void TheOdcLaneHasItsOwnRoots()
    {
        // ODC apps have no site properties: Site is an unknown identifier even in server logic.
        var site = Analyze("""{"ops":[{"op":"logic","data":{"actions":[{"name":"Url","outputs":[{"name":"U","type":"Text"}],"steps":[{"assign":{"U":"Site.BaseUrl"}}]}]}}]}""");
        Assert.Contains("Settings", Assert.Single(Problems(site, "EXPR_UNKNOWN_IDENTIFIER"))["fix"]!.GetValue<string>());
        // A parameter named Entities collides with the root; Site is an ordinary name in ODC.
        var roots = Analyze("""{"ops":[{"op":"logic","data":{"actions":[{"name":"Carregar","outputs":[{"name":"Entities","type":"Text"},{"name":"Site","type":"Text"}],"steps":[{"assign":{"Entities":"\"a\"","Site":"\"b\""}}]}]}}]}""");
        var collision = Assert.Single(Problems(roots, "NAME_COLLISION"));
        Assert.Contains("Entities2", collision["message"]!.GetValue<string>());
        // A built-in with the wrong number of arguments, from the ODC Studio's own registry.
        var arity = Analyze("""{"ops":[{"op":"logic","data":{"actions":[{"name":"Buscar","inputs":[{"name":"V","type":"Text"}],"outputs":[{"name":"P","type":"Integer"}],"steps":[{"assign":{"P":"Substr(V)"}}]}]}}]}""");
        if (Builtins.For("odc") != null) Assert.Single(Problems(arity, "FUNCTION_ARITY"));
    }

    [Fact]
    public void AKindWithoutItsIIsCompletedInTheOdcLane()
    {
        Assert.Equal("IServerActionSignature", KindNames.Normalize("ServerActionSignature"));
        var found = JobPreflight.BaseReferences(JsonNode.Parse("""[{"op":"set","target":"ClientActionSignature:Pa2Missing","prop":"Description","value":"x"}]""")!.AsArray(), "/ops");
        Assert.Equal("IClientActionSignature:Pa2Missing", Assert.Single(found).Reference);
    }

    [Fact]
    public void TheOdcApplyCollectsEveryFailureInOneRefusal()
    {
        if (!StudioAvailable()) return;
        var dir = Path.Combine(Root, ".local", "lane-odc", "pa2-f2-tests", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(dir);
        var job = Path.Combine(dir, "collect.json");
        File.WriteAllText(job, """
        {"base":"tests/fixtures/odc/blank-mobile.oml","ops":[
          {"op":"spec","data":{"entities":[{"name":"Pa2Cotacao","attributes":[{"name":"Cliente","type":"Text"}]}]}},
          {"op":"logic","data":{"actions":[{"name":"Pa2Somar","inputs":[{"name":"N","type":"Integer"}],"outputs":[{"name":"Out","type":"Integer"}],"steps":[{"assign":{"Out":"N"}}]}]}},
          {"op":"set","target":"IServerAction:Pa2Somar/#IStartNode","prop":"Destination","value":"IServerAction:Pa2Somar"},
          {"op":"set","target":"@espace/Pa2Cotacao/Cliente","prop":"DeleteRule","value":"Cascade"}]}
        """);
        var output = Path.Combine(dir, "collect.oml");
        var error = Assert.ThrowsAny<Exception>(() => JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, job, output));
        var refused = Assert.IsType<JobPreflightException>(error);
        Assert.Equal("PREFLIGHT_REFUSED", refused.Code);
        Assert.Equal(new[] { 2, 3 }, refused.Problems.Select(p => p!["op"]!.GetValue<int>()));
        Assert.All(refused.Problems, p => Assert.Equal("apply", p!["phase"]!.GetValue<string>()));
        Assert.Equal(new[] { "PROPERTY_NOT_WRITABLE", "ENUM_VALUE_INVALID" }, refused.Problems.Select(p => p!["code"]!.GetValue<string>()));
        Assert.False(File.Exists(output));
    }

    /// <summary>No false positive on the repository's ODC jobs: the rules refuse only what the platform refuses.</summary>
    [Fact]
    public void NoNewRuleFiresOnTheRepositoryOdcJobs()
    {
        try { StudioAssembliesOdc.Bind(null); } catch { /* the checked-in catalogs answer */ }
        string[] codes = ["ENUM_VALUE_INVALID", "PROPERTY_NOT_WRITABLE", "ARGUMENT_UNKNOWN", "REQUIRED_ARGUMENT", "EXPR_UNKNOWN_IDENTIFIER",
            "NAME_COLLISION", "FUNCTION_ARITY", "OPERAND_TYPES", "DB_FUNCTION_IN_AGGREGATE", "MOBILE_BLOCK_WITH_NAVIGATION", "LOGIC_DUPLICATE_ACTION", "PREFLIGHT_RULE_FAILED"];
        var found = new List<string>();
        foreach (var folder in new[] { "jobs-odc", Path.Combine("jobs-coverage", "odc"), Path.Combine("jobs-coverage-f2", "odc") })
        {
            var dir = Path.Combine(Root, "tests", folder);
            if (!Directory.Exists(dir)) continue;
            foreach (var file in Directory.GetFiles(dir, "*.json", SearchOption.AllDirectories).OrderBy(f => f, StringComparer.Ordinal))
            {
                JsonNode? job;
                try { job = JsonNode.Parse(File.ReadAllText(file)); } catch { continue; }
                if (job is not (JsonObject or JsonArray) || job is JsonObject o && o["ops"] == null && o["jobs"] == null) continue;
                JsonArray ops;
                try { ops = JobRunner.CollectOps(job, Path.GetDirectoryName(file)!); } catch { continue; }
                var result = JobPreflight.Analyze(ops, job);
                found.AddRange(result["problems"]!.AsArray().Concat(result["warnings"]!.AsArray()).OfType<JsonObject>()
                    .Where(p => codes.Contains(p["code"]!.GetValue<string>())).Select(p => Path.GetFileName(file) + ": " + p["code"] + " " + p["message"]));
            }
        }
        Assert.True(found.Count == 0, string.Join(Environment.NewLine, found));
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(Pa2F2OdcTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
