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
            var sha = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(exe)));
            JsonObject Pin(string? path, string? hash) => new() { ["xifEngine"] = new JsonObject { ["path"] = path, ["sha256"] = hash } };
            if (!OperatingSystem.IsWindows()) { Assert.Null(XifKinds.ResolveEngine(runtime, Pin("xif-engine/Anvil.Xif.Engine.exe", sha))); return; }
            // M1 (F4 review): a file at the usual place without a pin never runs, nor a pin without its sha256.
            Assert.Null(XifKinds.ResolveEngine(runtime, null));
            Assert.False(new XifKinds(runtime, runtime, new JsonObject()).Available);
            Assert.Null(XifKinds.ResolveEngine(runtime, Pin("xif-engine/Anvil.Xif.Engine.exe", null)));
            Assert.Equal((exe, sha), XifKinds.ResolveEngine(runtime, Pin("xif-engine/Anvil.Xif.Engine.exe", sha)));
            Assert.True(new XifKinds(runtime, runtime, Pin("xif-engine/Anvil.Xif.Engine.exe", sha)).Available);
            Assert.Null(XifKinds.ResolveEngine(runtime, Pin("xif-engine/Anvil.Xif.Engine.exe", new string('0', 64))));
            Assert.Null(XifKinds.ResolveEngine(runtime, Pin("../x.exe", sha)));
            // Checked again on the handle the run holds: a file replaced after the start is not run, and while held it cannot be replaced.
            using (var held = XifKinds.OpenIntact(exe, sha))
            {
                Assert.NotNull(held);
                Assert.Throws<IOException>(() => File.WriteAllText(exe, "another program"));
            }
            File.WriteAllText(exe, "another program");
            Assert.Null(XifKinds.OpenIntact(exe, sha));
        }
        finally { Directory.Delete(runtime, true); }
    }

    [Fact]
    public void OperationFoldersOlderThanAnHourAreSweptAndNothingElse()
    {
        var root = Root();
        try
        {
            var xif = Path.Combine(root, "o11", "xif");
            var old = Directory.CreateDirectory(Path.Combine(xif, "aaaaaaaaaaaaaaaa", "out")).Parent!;
            var recent = Directory.CreateDirectory(Path.Combine(xif, "bbbbbbbbbbbbbbbb"));
            var other = Directory.CreateDirectory(Path.Combine(xif, "not-an-operation"));
            Directory.SetLastWriteTimeUtc(old.FullName, DateTime.UtcNow.AddHours(-2));
            Directory.SetLastWriteTimeUtc(other.FullName, DateTime.UtcNow.AddHours(-2));
            new XifKinds(root, null, null).Sweep("cccccccccccccccc");
            Assert.False(old.Exists && Directory.Exists(old.FullName));
            Assert.True(Directory.Exists(recent.FullName));
            Assert.True(Directory.Exists(other.FullName));
        }
        finally { Directory.Delete(root, true); }
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
