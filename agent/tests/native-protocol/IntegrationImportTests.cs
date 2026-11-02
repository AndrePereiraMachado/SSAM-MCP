using System.Text.Json.Nodes;
using Ssam.Agent;
using Xunit;

// fase4-28 r4-f3-import (criterion C3): the native core passes integration_import (thin O11 bridge 1.1.0) as the Node agent does:
// in the order of the bridge's manifest, right after refresh_references; base_path, document_path and each dependencies[].path
// are read positions and out_path a write position under agent:o11/, every one an agent path. Anything else is refused before
// the bridge. The hello lists the methods (agent.o11Methods), so the server sends the import only to this agent.
public class IntegrationImportTests
{
    [Fact]
    public void IntegrationImportIsAnO11MethodAfterRefreshReferences()
    {
        var list = StudioKinds.O11MethodList;
        Assert.Contains("integration_import", StudioKinds.O11Methods);
        Assert.Equal(Array.IndexOf(list, "refresh_references") + 1, Array.IndexOf(list, "integration_import"));
        Assert.Equal(list.Length, StudioKinds.O11Methods.Count);
        Assert.Equal(24, list.Length);
    }

    private static JsonObject Request() => new()
    {
        ["kind"] = "wsdl", ["module_key"] = "k1", ["operation_id"] = "op1", ["base_path"] = "agent:o11/snapshots/M.oml", ["base_sha256"] = new string('c', 64),
        ["document_path"] = "agent:o11/imports/aa/service.wsdl", ["document_sha256"] = new string('a', 64),
        ["dependencies"] = new JsonArray(new JsonObject { ["uri"] = "types.xsd", ["path"] = "agent:o11/imports/aa/types.xsd", ["sha256"] = new string('e', 64) }),
        ["client"] = "Calc", ["selection"] = new JsonObject { ["port"] = "CalculatorSoap", ["methods"] = new JsonArray("Add") }, ["out_path"] = "agent:o11/work/import-0.oml",
    };

    [Fact]
    public void ItsPathsAreAgentPathsAndTheCandidateStaysInO11()
    {
        var root = Directory.CreateTempSubdirectory("ssam-import-").FullName;
        try
        {
            foreach (var dir in new[] { "odc/snapshots", "odc/journal", "odc/lab", "o11", "inbox" }) Directory.CreateDirectory(Path.Combine(root, dir));
            var kinds = new StudioKinds(root, root, new JsonObject { ["lanes"] = new JsonArray("o11") }, () => null);
            var mapped = kinds.MapO11("integration_import", Request());
            string Local(string rel) => Path.Combine([root, .. rel["agent:".Length..].Split('/')]);
            Assert.Equal(Local("agent:o11/snapshots/M.oml"), mapped["base_path"]!.ToString());
            Assert.Equal(Local("agent:o11/imports/aa/service.wsdl"), mapped["document_path"]!.ToString());
            Assert.Equal(Local("agent:o11/imports/aa/types.xsd"), mapped["dependencies"]![0]!["path"]!.ToString());
            Assert.Equal("types.xsd", mapped["dependencies"]![0]!["uri"]!.ToString());
            Assert.Equal(Local("agent:o11/work/import-0.oml"), mapped["out_path"]!.ToString());
            Assert.Equal(Request()["selection"]!.ToJsonString(), mapped["selection"]!.ToJsonString());
            string? Code(Action<JsonObject> change)
            {
                var p = Request(); change(p);
                try { kinds.MapO11("integration_import", p); return null; }
                catch (AgentFault e) { return e.Code; }
                catch (PathRefusal e) { return e.Code; }
            }
            Assert.Equal("PATH_NOT_AGENT", Code(p => p["base_path"] = @"C:\outside\base.oml"));
            Assert.Equal("PATH_NOT_AGENT", Code(p => p["document_path"] = "https://example.com/service?wsdl"));
            Assert.Equal("PATH_NOT_AGENT", Code(p => p["dependencies"]![0]!["path"] = @"C:\outside\types.xsd"));
            Assert.Equal("PATH_FORBIDDEN", Code(p => p["out_path"] = "agent:inbox/candidate.oml"));
            Assert.Equal("PATH_NOT_AGENT", Code(p => p.Remove("out_path")));
            Assert.Equal("PARAMS_INVALID", Code(p => p["dependencies"] = "types.xsd"));
            Assert.Equal("PARAMS_INVALID", Code(p => p["dependencies"] = new JsonArray("types.xsd")));
        }
        finally { Directory.Delete(root, true); }
    }
}
