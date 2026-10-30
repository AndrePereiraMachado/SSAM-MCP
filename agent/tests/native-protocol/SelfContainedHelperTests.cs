using Ssam.Agent;
using Xunit;

public class SelfContainedHelperTests
{
    [Fact]
    public void AppHostAloneDoesNotRemoveTheRuntimeDependency()
    {
        var dir = Path.Combine(Path.GetTempPath(), "ssam-helper-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            var dll = Path.Combine(dir, "Helper.dll");
            File.WriteAllText(Path.ChangeExtension(dll, ".exe"), "fixture");
            File.WriteAllText(Path.ChangeExtension(dll, ".runtimeconfig.json"), "{\"runtimeOptions\":{\"framework\":{\"name\":\"Microsoft.NETCore.App\"}}}");
            Assert.False(StudioKinds.SelfContainedHelper(dll));
            foreach (var name in new[] { "hostfxr.dll", "hostpolicy.dll", "coreclr.dll" }) File.WriteAllText(Path.Combine(dir, name), "fixture");
            Assert.False(StudioKinds.SelfContainedHelper(dll));
            File.WriteAllText(Path.ChangeExtension(dll, ".runtimeconfig.json"), "{\"runtimeOptions\":{\"includedFrameworks\":[{\"name\":\"Microsoft.NETCore.App\"}]}}");
            Assert.True(StudioKinds.SelfContainedHelper(dll));
            File.Delete(Path.Combine(dir, "hostfxr.dll"));
            Assert.False(StudioKinds.SelfContainedHelper(dll));
        }
        finally { Directory.Delete(dir, true); }
    }
}
