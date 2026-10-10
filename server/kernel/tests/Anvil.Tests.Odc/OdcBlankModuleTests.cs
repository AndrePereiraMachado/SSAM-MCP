using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// `anvil-odc create-blank` (OdcBlankModule): a blank module of a SegmentationKind, created offline by the installed
/// model, is a base `apply` loads. The InsuranceApp fixture is a CrossDevice app, which refuses workflows, agents and
/// the Mobile-only events; the blank fixtures of tests/fixtures/odc are this command's output, and the jobs of
/// tests/jobs-odc over them (mobile-sync-events, workflow-nodes, agent-calls, agent-definition-tools) prove what each
/// kind accepts. blank-crossdevice.oml (SsamNeutralApp) is the neutral CrossDevice base a hosted ssam_job {lane:"odc"}
/// runs on when it names no base (hosted/policy.mjs). Needs the ODC Studio installed; without it the tests return
/// without asserting.
///
/// The fixtures belong to the model of the installed Studio: apply loads with LoadFlags.SkipUpgrades, so an OML saved
/// by an older model keeps its signatures neither loaded nor regenerated, and a `reference` to a producer saved by it
/// fails in the platform's SignatureManager (KeyNotFoundException on the key of the referenced element; seen when the
/// ODC Studio went from 1.7.26 to 1.7.27). After a Studio update, regenerate them from kernel/ (same keys, new bytes):
///   anvil-odc create-blank --kind Mobile --name CovBlankMobile --out tests/fixtures/odc/blank-mobile.oml
///   anvil-odc create-blank --kind BusinessProcess --name CovBlankWorkflow --out tests/fixtures/odc/blank-workflow.oml
///   anvil-odc create-blank --kind AIAgent --name CovBlankAgent --out tests/fixtures/odc/blank-agent.oml --connection ai-model:CovAIModel
///   anvil-odc create-blank --kind AgentDefinition --name CovBlankAgentDefinition --out tests/fixtures/odc/blank-agent-definition.oml
///       --connection ai-model:CovAIModel --connection mcp:CovMCP --connection knowledge-base:CovKnowledge
///   anvil-odc apply --base tests/fixtures/odc/blank-mobile.oml --job tests/jobs-odc/producer-service-event.json --out tests/fixtures/odc/blank-mobile-producer.oml
///   anvil-odc create-blank --kind CrossDevice --name SsamNeutralApp --out tests/fixtures/odc/blank-crossdevice.oml
///       (then refresh its capture sidecar blank-crossdevice.oml.json: moduleKey, sha256, capturedAt)
/// </summary>
public class OdcBlankModuleTests
{
    private static readonly string Root = FindRoot();
    private static readonly string Work = Path.Combine(Root, ".local", "lane-odc", "test-work", "blank");
    private static string Fixture(string name) => Path.Combine(Root, "tests", "fixtures", "odc", name + ".oml");

    [Theory]
    [InlineData("Mobile", "blank-mobile")]
    [InlineData("BusinessProcess", "blank-workflow")]
    [InlineData("AIAgent", "blank-agent")]
    [InlineData("AgentDefinition", "blank-agent-definition")]
    [InlineData("CrossDevice", "blank-crossdevice")]
    public void ABlankModuleOfEachKindIsABaseForApply(string kind, string fixture)
    {
        if (!StudioAvailable()) return;
        var dir = Path.Combine(Work, kind + "-" + Guid.NewGuid().ToString("N")[..8]);
        var host = new ModelHost(dir);
        var first = OdcBlankModule.Create(host, kind, "CovTest" + kind, Path.Combine(dir, "first.oml"));
        var second = OdcBlankModule.Create(host, kind, "CovTest" + kind, Path.Combine(dir, "second.oml"));
        Assert.Equal(kind, first["moduleKind"]!.GetValue<string>());
        Assert.Equal(first["key"]!.GetValue<string>(), first["reloadedKey"]!.GetValue<string>());
        // the identity is derived from kind and name: the same command gives the same module key
        Assert.Equal(first["key"]!.GetValue<string>(), second["key"]!.GetValue<string>());

        // apply takes it as base, as it takes the committed fixture of the same kind
        var job = Path.Combine(dir, "read-module.json");
        File.WriteAllText(job, new JsonObject { ["expectValid"] = first["isValid"]!.GetValue<bool>(), ["ops"] = new JsonArray(new JsonObject { ["op"] = "get", ["target"] = "@espace" }) }.ToJsonString());
        var applied = JsonSerializer.SerializeToNode(JobRunner.Run(host, Path.Combine(dir, "first.oml"), job, Path.Combine(dir, "applied.oml")))!;
        Assert.True(applied["accepted"]!.GetValue<bool>(), applied["policyMessages"]?.ToJsonString());
        Assert.Equal(first["objects"]!.GetValue<int>(), applied["objects"]!.GetValue<int>());
        Assert.Equal(kind, host.Inspect(Fixture(fixture)).Kind);
        var committed = JsonSerializer.SerializeToNode(JobRunner.Run(host, Fixture(fixture), job, Path.Combine(dir, "committed.oml")))!;
        Assert.True(committed["accepted"]!.GetValue<bool>(), committed["policyMessages"]?.ToJsonString());
    }

    [Fact]
    public void ConnectionsAreBuiltOfflineAndComeBackAsReferences()
    {
        if (!StudioAvailable()) return;
        var dir = Path.Combine(Work, "connections-" + Guid.NewGuid().ToString("N")[..8]);
        var host = new ModelHost(dir);
        var created = OdcBlankModule.Create(host, "AgentDefinition", "CovTestTools", Path.Combine(dir, "tools.oml"),
            ["ai-model:CovTestModel", "mcp:CovTestMcp", "knowledge-base:CovTestKnowledge"]);
        var references = created["references"]!.AsArray().ToDictionary(r => r!["Name"]!.GetValue<string>(), r => r!["Kind"]!.GetValue<string>());
        Assert.Equal("AIModelConnection", references["CovTestModel"]);
        Assert.Equal("MCPConnection", references["CovTestMcp"]);
        Assert.Equal("KnowledgeBase", references["CovTestKnowledge"]);
        Assert.Equal(3, created["connections"]!.AsArray().Count);
        Assert.Throws<ArgumentException>(() => OdcBlankModule.Create(host, "AgentDefinition", "CovTestBad", Path.Combine(dir, "bad.oml"), ["agent:CovTestBad"]));
        Assert.Throws<ArgumentException>(() => OdcBlankModule.Create(host, "7", "CovTestNumeric", Path.Combine(dir, "numeric.oml")));
        Assert.False(File.Exists(Path.Combine(dir, "bad.oml")));
    }

    /// <summary>blank-mobile-producer.oml is producer-service-event.json applied over blank-mobile.oml: the public
    /// elements the workflow and the agent definition reference are the ones the job makes.</summary>
    [Fact]
    public void TheProducerFixtureIsTheProducerJobOverTheBlankMobile()
    {
        if (!StudioAvailable()) return;
        var dir = Path.Combine(Work, "producer-" + Guid.NewGuid().ToString("N")[..8]);
        var host = new ModelHost(dir);
        var job = Path.Combine(Root, "tests", "jobs-odc", "producer-service-event.json");
        var rebuilt = Path.Combine(dir, "producer.oml");
        var applied = JsonSerializer.SerializeToNode(JobRunner.Run(host, null, job, rebuilt))!;
        Assert.True(applied["accepted"]!.GetValue<bool>(), applied["policyMessages"]?.ToJsonString());
        foreach (var oml in new[] { rebuilt, Fixture("blank-mobile-producer") })
            host.WithSession(oml, session =>
            {
                Assert.NotNull(session.Resolve("IServiceAction:CovSService"));
                Assert.Equal("True", session.Get(session.Resolve("IGlobalEvent:CovSEvent"))["properties"]!["Public"]!.GetValue<string>());
                return 0;
            });
    }

    /// <summary>Each blank fixture was saved by the model of the installed Studio (see the class summary for why a
    /// fixture of an older model breaks `reference`, and for the commands that regenerate it).</summary>
    [Fact]
    public void TheBlankFixturesWereSavedByTheInstalledModel()
    {
        if (!StudioAvailable()) return;
        var dir = Path.Combine(Work, "model-" + Guid.NewGuid().ToString("N")[..8]);
        var host = new ModelHost(dir);
        OdcBlankModule.Create(host, "Mobile", "CovTestModel", Path.Combine(dir, "installed.oml"));
        var installed = ModelVersion(host, Path.Combine(dir, "installed.oml"));
        var stale = Directory.GetFiles(Path.Combine(Root, "tests", "fixtures", "odc"), "blank-*.oml").Order(StringComparer.Ordinal)
            .Select(f => (Name: Path.GetFileName(f), Version: ModelVersion(host, f))).Where(f => f.Version != installed)
            .Select(f => f.Name + " (" + f.Version + ")").ToList();
        Assert.True(stale.Count == 0, "saved by another model than the installed one (" + installed + "): " + string.Join(", ", stale)
            + "; regenerate with the commands of the OdcBlankModuleTests summary");
    }

    private static string ModelVersion(ModelHost host, string oml)
        => host.WithSession(oml, session => session.Get(session.Resolve("@espace"))["properties"]!["Version"]!.GetValue<string>());

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(OdcBlankModuleTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
