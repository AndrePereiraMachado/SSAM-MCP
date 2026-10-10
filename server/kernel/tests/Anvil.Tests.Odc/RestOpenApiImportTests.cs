using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// The ODC headless OpenAPI import of the op `rest` (Adapters.ODC/OdcRestOpenApi.cs, registered as RestOpenApi.Importer):
/// over a synthetic document only the chosen operations become methods of the client; an external $ref that is not
/// bundled is OPENAPI_NETWORK_REFUSED naming the URI, refused before the importer runs (zero HTTP calls).
/// </summary>
public class RestOpenApiImportTests
{
    private static readonly string Root = FindRoot();
    private static readonly string Orders = Path.Combine(Root, "tests", "fixtures", "openapi", "orders-3.0.json");
    private static readonly string External = Path.Combine(Root, "tests", "fixtures", "openapi", "orders-external-ref.json");

    [Fact]
    public void TheOdcAdapterRegistersTheImporter()
    {
        if (!StudioAvailable()) return;
        _ = StudioAdapter.Runtime; // loads the ODC adapter assembly's module initializer
        Assert.NotNull(RestOpenApi.Importer);
    }

    [Fact]
    public void OnlyTheChosenOperationsAreCreated()
    {
        if (!StudioAvailable()) return;
        var dir = Work();
        var job = Path.Combine(dir, "openapi.json");
        File.WriteAllText(job, new JsonObject
        {
            ["base"] = "tests/fixtures/odc/insurance-reactive-r8.oml", ["expectValid"] = true, ["expectedMessages"] = new JsonArray(),
            ["ops"] = new JsonArray(
                new JsonObject { ["op"] = "rest", ["data"] = new JsonObject {
                    ["client"] = new JsonObject { ["name"] = "WfOrdersApi" },
                    ["openapi"] = new JsonObject { ["path"] = Orders, ["sha256"] = IntegrationDocuments.Sha256(File.ReadAllBytes(Orders)), ["operations"] = new JsonArray("getOrder", "POST /orders") } } },
                new JsonObject { ["op"] = "find", ["type"] = "IRestAction", ["max"] = 200 }),
        }.ToJsonString());
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "model")), null, job, Path.Combine(dir, "out.oml")))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]!.ToJsonString() + result["policyMessages"]);
        var report = Assert.Single(result["integration"]!.AsArray())!;
        Assert.True(report["imported"]!.AsArray().Select(i => i!.ToString()).SequenceEqual(["getOrder", "createOrder"]), report.ToJsonString());
        Assert.True(report["client"]!["created"]!.GetValue<bool>());
        var methods = result["results"]!.AsArray().Single(r => r!["op"]!.ToString() == "find")!["result"]!.AsArray()
            .Select(m => m!["name"]!.ToString()).Where(n => n.Contains("Order", StringComparison.OrdinalIgnoreCase)).ToList();
        Assert.Equal(2, methods.Count);
        Assert.DoesNotContain(methods, m => m.Contains("delete", StringComparison.OrdinalIgnoreCase) || m.Contains("list", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void AnUnbundledExternalReferenceIsRefusedWithZeroHttpCalls()
    {
        var problems = new List<IntegrationProblem>();
        var plan = RestOpenApi.Plan(JsonNode.Parse($"{{\"path\":{JsonSerializer.Serialize(External)},\"operations\":[\"getOrder\"]}}")!.AsObject(), problems);
        Assert.Null(plan);
        var problem = Assert.Single(problems);
        Assert.Equal("OPENAPI_NETWORK_REFUSED", problem.Code);
        Assert.Contains("https://example.invalid/schemas/order.json", problem.Message);
        Assert.Contains("external", problem.Fix);
        if (!StudioAvailable()) return;
        // Through the runner: refused by the whole-job preflight; the importer is never called.
        _ = StudioAdapter.Runtime;
        var original = RestOpenApi.Importer;
        var calls = 0;
        RestOpenApi.Importer = (espace, request) => { calls++; return original!(espace, request); };
        try
        {
            var dir = Work();
            var job = Path.Combine(dir, "openapi-external.json");
            File.WriteAllText(job, new JsonObject { ["base"] = "tests/fixtures/odc/insurance-reactive-r8.oml", ["ops"] = new JsonArray(new JsonObject { ["op"] = "rest", ["data"] = new JsonObject {
                ["client"] = new JsonObject { ["name"] = "WfExternalApi" },
                ["openapi"] = new JsonObject { ["path"] = External, ["operations"] = new JsonArray("getOrder") } } }) }.ToJsonString());
            var error = Assert.Throws<JobPreflightException>(() => JobRunner.Run(new ModelHost(Path.Combine(dir, "model")), null, job, Path.Combine(dir, "out.oml")));
            Assert.Contains(error.Problems, p => p!["code"]!.ToString() == "OPENAPI_NETWORK_REFUSED");
            Assert.Equal(0, calls);
        }
        finally { RestOpenApi.Importer = original; }
    }

    [Fact]
    public void SoapIsNotAnOdcOperation()
    {
        var preflight = JobPreflight.Analyze(JsonNode.Parse("""[{"op":"soap","data":{"wsdl":"x","methods":["Add"]}}]""")!.AsArray());
        Assert.Contains(preflight["problems"]!.AsArray(), p => p!["code"]!.ToString() == "SOAP_LANE_UNSUPPORTED");
    }

    private static string Work()
    {
        var dir = Path.Combine(Root, ".local", "lane-odc", "rest-openapi-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(RestOpenApiImportTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
