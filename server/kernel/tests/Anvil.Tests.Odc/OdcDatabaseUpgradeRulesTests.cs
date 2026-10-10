using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// The ODC lane of DatabaseUpgradeRules: PostgreSQL accepts multiple cascade paths and cascade cycles, so the data model
/// that SQL Server (O11) refuses is delivered here. The same effective model read with the O11 rules proves the ODC
/// reading sees the cascades (the lane, not a blind reader, is what accepts them). Needs the ODC Studio installed.
/// </summary>
public class OdcDatabaseUpgradeRulesTests
{
    private static readonly string Root = FindRoot();
    private static readonly string Work = Path.Combine(Root, ".local", "lane-odc", "db-upgrade-rules-tests");
    private static readonly string Fixture = Path.Combine(Root, "tests", "fixtures", "odc", "insurance-reactive-r8.oml");

    private const string DiamondSpec = """
        {"op":"spec","data":{"entities":[
          {"name":"DuParent","attributes":[{"name":"Name","type":"Text","length":50}]},
          {"name":"DuMember","attributes":[{"name":"Name","type":"Text","length":50}]},
          {"name":"DuActivity","attributes":[{"name":"ParentId","type":"DuParent Identifier","mandatory":true,"deleteRule":"Delete"},
                                              {"name":"MemberId","type":"DuMember Identifier","mandatory":true,"deleteRule":"Delete"}]},
          {"name":"DuMessage","attributes":[{"name":"ParentId","type":"DuParent Identifier","mandatory":true,"deleteRule":"Delete"},
                                             {"name":"MemberId","type":"DuMember Identifier","deleteRule":"Delete"},
                                             {"name":"ActivityId","type":"DuActivity Identifier","deleteRule":"Delete"},
                                             {"name":"Content","type":"Text","length":200}]}]}}
        """;

    [Fact]
    public void PostgreSqlAcceptsTheCascadePathsThatSqlServerRefuses()
    {
        if (!StudioAvailable()) return;
        Directory.CreateDirectory(Work);
        var job = Path.Combine(Work, "du-diamond.json");
        File.WriteAllText(job, "{\"ops\":[" + DiamondSpec + "]}");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Work), Fixture, job, Path.Combine(Work, "du-diamond.oml")))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString());
        ReadWithBothLanes();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void ReadWithBothLanes()
    {
        var ops = JsonNode.Parse("[" + DiamondSpec + "]")!.AsArray();
        var espace = new ModelHost(Work).Load(File.ReadAllBytes(Fixture));
        try
        {
            var session = new ModelSession(espace);
            session.Apply(ops);
            Assert.Empty(session.DatabaseUpgradeRefusals(ops, "odc"));
            var o11 = session.DatabaseUpgradeRefusals(ops, "o11");
            Assert.Contains("op #0 (spec DuMessage.ActivityId): DuMessage.ActivityId: set Delete Rule to Ignore or Protect", o11[0]);
            Assert.Contains("DuParent reaches DuMessage by two cascade paths", o11[0]);
        }
        finally { ModelHost.Release(espace); }
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(OdcDatabaseUpgradeRulesTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
