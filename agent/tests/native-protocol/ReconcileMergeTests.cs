using System.Text.Json.Nodes;
using Ssam.Agent;
using Xunit;

// A1 (U1 of the server line): from ODC bridge v106 on a merge may return before the bridge's verification ran, and the server
// asks for reconcile-merge <manifest>, which runs that verification on the merge already in the module. The native core passes
// it like merge (the manifest at a write position), and the hello names it, in the Node agent's order, so the server offers the
// bridges from v106 on only to this agent.
public class ReconcileMergeTests
{
    [Fact]
    public void ReconcileMergeIsAnOdcCommandNextToMerge()
    {
        Assert.Contains("reconcile-merge", StudioKinds.OdcCommands);
        var list = StudioKinds.OdcCommandList;
        Assert.Equal(Array.IndexOf(list, "merge") + 1, Array.IndexOf(list, "reconcile-merge"));
        Assert.Equal(list.Length, StudioKinds.OdcCommands.Count);
        Assert.Equal("0.4.4-native", AgentChannel.AgentVersion);   // 0.4.4-native: integration_import (IntegrationImportTests)
    }

    [Theory]
    [InlineData("agent:odc/lab/j/manifest.json", null)]
    [InlineData("agent:inbox/manifest.json", "PATH_FORBIDDEN")]
    [InlineData("C:\\outside\\manifest.json", "PATH_NOT_AGENT")]
    public void ItsManifestIsAWritePositionLikeMerge(string manifest, string? refusal)
    {
        var root = Directory.CreateTempSubdirectory("ssam-reconcile-").FullName;
        try
        {
            foreach (var dir in new[] { "odc/snapshots", "odc/journal", "odc/lab", "o11", "inbox" }) Directory.CreateDirectory(Path.Combine(root, dir));
            var kinds = new StudioKinds(root, root, new JsonObject { ["lanes"] = new JsonArray("odc"), ["odcBridge"] = "v106" }, () => null);
            string? Code(string command)
            {
                try { kinds.MapOdc(new JsonObject { ["args"] = new JsonArray(command, manifest) }); return null; }
                catch (AgentFault e) { return e.Code; }
                catch (PathRefusal e) { return e.Code; }
            }
            Assert.Equal(refusal, Code("reconcile-merge"));
            Assert.Equal(Code("merge"), Code("reconcile-merge"));
            if (refusal == null)
                Assert.Equal(Path.Combine(root, "odc", "lab", "j", "manifest.json"),
                    kinds.MapOdc(new JsonObject { ["args"] = new JsonArray("reconcile-merge", manifest) })[1]);
        }
        finally { Directory.Delete(root, true); }
    }
}
