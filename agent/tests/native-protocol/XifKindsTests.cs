using System.Text.Json.Nodes;
using Ssam.Agent;
using Xunit;

// o11.xif (F4 of PLANO-11H) in the native core: the engine host comes only from the pack (path and sha256), the Hello lists the kind only
// then, and a request names only files of its own operation folder. No Integration Studio and no engine process.
public class XifKindsTests
{
    private static string Root()
    {
        var root = Path.Combine(Path.GetTempPath(), "ssam-xif-" + Guid.NewGuid().ToString("N")[..8]);
        foreach (var dir in new[] { "odc/snapshots", "odc/journal", "odc/lab", "o11", "inbox", "private" }) Directory.CreateDirectory(Path.Combine(root, dir));
        return root;
    }

    [Fact]
    public void TheEngineHostIsThePacksOrNone()
    {
        var runtime = Root();
        try
        {
            Assert.Null(XifKinds.ResolveEngine(runtime, null));
            Assert.False(new XifKinds(runtime, runtime, null).Available);
            var exe = Path.Combine(runtime, "xif-engine", XifKinds.EngineExe);
            Directory.CreateDirectory(Path.GetDirectoryName(exe)!);
            File.WriteAllText(exe, "engine");
            if (!OperatingSystem.IsWindows()) { Assert.Null(XifKinds.ResolveEngine(runtime, null)); return; }
            Assert.Equal(exe, XifKinds.ResolveEngine(runtime, null));
            Assert.True(new XifKinds(runtime, runtime, null).Available);
            var sha = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(exe)));
            Assert.Equal(exe, XifKinds.ResolveEngine(runtime, new JsonObject { ["xifEngine"] = new JsonObject { ["path"] = "xif-engine/Anvil.Xif.Engine.exe", ["sha256"] = sha } }));
            Assert.Null(XifKinds.ResolveEngine(runtime, new JsonObject { ["xifEngine"] = new JsonObject { ["sha256"] = new string('0', 64) } }));
            Assert.Null(XifKinds.ResolveEngine(runtime, new JsonObject { ["xifEngine"] = new JsonObject { ["path"] = "../x.exe" } }));
        }
        finally { Directory.Delete(runtime, true); }
    }

    [Fact]
    public void ARequestNamesOnlyFilesOfItsOperation()
    {
        var root = Root();
        try
        {
            var kind = new XifKinds(root, null, null);
            const string op = "0123456789abcdef";
            var good = JsonNode.Parse($$"""{"command":"model","operationId":"{{op}}","output":"agent:o11/xif/{{op}}/out/Lib.xif","spec":{"name":"Lib","actions":[]},"references":["agent:o11/xif/{{op}}/in/0/A.dll"]}""")!;
            var (request, output, _) = kind.Prepare(good);
            Assert.Equal(Path.Combine(root, "o11", "xif", op, "out", "Lib.xif"), output);
            Assert.Equal(Path.Combine(root, "o11", "xif", op, "in", "0", "A.dll"), request["references"]![0]!.GetValue<string>());
            var other = JsonNode.Parse($$"""{"command":"model","operationId":"{{op}}","output":"agent:o11/xif/{{op}}/out/Lib.xif","spec":{"name":"Lib","actions":[]},"references":["agent:o11/xif/fedcba9876543210/in/0/A.dll"]}""")!;
            Assert.Equal("PATH_FORBIDDEN", Assert.Throws<AgentFault>(() => kind.Prepare(other)).Code);
            var exe = JsonNode.Parse($$"""{"command":"model","operationId":"{{op}}","output":"agent:o11/xif/{{op}}/out/Lib.xif","spec":{"name":"Lib"},"engine":"C:\\x.exe"}""")!;
            Assert.Equal("PARAMS_INVALID", Assert.Throws<AgentFault>(() => kind.Prepare(exe)).Code);
        }
        finally { Directory.Delete(root, true); }
    }
}
