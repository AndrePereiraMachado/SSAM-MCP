using Ssam.Agent;
using Xunit;

public sealed class MacBundleTests
{
    [Theory]
    [InlineData("utf8")]
    [InlineData("utf16le")]
    [InlineData("utf16be")]
    public void ReadsPlistEncodingAndByteOrderMark(string format)
    {
        System.Text.Encoding encoding = format switch {
            "utf16le" => new System.Text.UnicodeEncoding(false, true),
            "utf16be" => new System.Text.UnicodeEncoding(true, true),
            _ => new System.Text.UTF8Encoding(true)
        };
        var xml = $"<?xml version=\"1.0\" encoding=\"{encoding.WebName}\"?><!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\"><plist><dict><key>CFBundleExecutable</key><string>Estúdio</string></dict></plist>";
        var bytes = encoding.GetPreamble().Concat(encoding.GetBytes(xml)).ToArray();
        var document = MacPlatform.ParsePlistXml(bytes);
        Assert.Equal("Estúdio", document.Root!.Element("dict")!.Element("string")!.Value);
    }

    [Theory]
    [InlineData("ServiceStudio.app", "ServiceStudio", "o11")]
    [InlineData("ODC Studio.app", "ODCStudio", "odc")]
    public void RecognizesWrappedStudioAndOnlyItsActualProcess(string name, string entry, string lane)
    {
        var folder = Path.Combine(Path.GetTempPath(), "ssam-bundle-" + Guid.NewGuid().ToString("N"));
        try
        {
            var outer = Path.Combine(folder, name);
            var inner = Path.Combine(outer, "Contents", "Resources", "app", name);
            CreateBundle(outer, entry, false);
            var executable = CreateBundle(inner, entry, true);
            var bundle = MacPlatform.Inspect(outer);
            Assert.NotNull(bundle);
            Assert.Equal(outer, bundle.Root);
            Assert.Equal(executable, bundle.Executable);
            Assert.Equal(lane, bundle.Lane);
            Assert.NotNull(bundle.RuntimeConfig);
            var found = MacPlatform.MatchProcesses([bundle], $"1 {Path.Combine(outer, "Contents", "MacOS", entry)}\n2 {executable}\n3 {Path.Combine(Path.GetDirectoryName(executable)!, "OutSystemsUpdater", "OutSystemsUpdater")}\n4 {executable}-helper");
            Assert.Single(found);
            Assert.Equal(2, StudioKinds.Integer(found[0]!["pid"]));
        }
        finally { Directory.Delete(folder, true); }
    }

    [Fact]
    public void DoesNotAdoptUnrelatedNestedHelper()
    {
        var folder = Path.Combine(Path.GetTempPath(), "ssam-bundle-" + Guid.NewGuid().ToString("N"));
        try
        {
            var outer = Path.Combine(folder, "Wrapper.app");
            CreateBundle(outer, "Wrapper", false);
            CreateBundle(Path.Combine(outer, "Contents", "Resources", "app", "ODC Studio.app"), "ODCStudio", true);
            var diagnostics = new System.Text.Json.Nodes.JsonArray();
            Assert.Null(MacPlatform.InspectWithDiagnostics(outer, diagnostics));
            Assert.Contains(diagnostics, item => StudioKinds.Text(item?["reason"]) == "Managed entry assembly missing; no permitted nested bundle found");
        }
        finally { Directory.Delete(folder, true); }
    }

    private static string CreateBundle(string root, string entry, bool managed)
    {
        var contents = Path.Combine(root, "Contents");
        var bin = Path.Combine(contents, "MacOS");
        Directory.CreateDirectory(bin);
        File.WriteAllText(Path.Combine(contents, "Info.plist"), $"<plist><dict><key>CFBundleExecutable</key><string>{entry}</string><key>CFBundleShortVersionString</key><string>1.2.3</string></dict></plist>", new System.Text.UTF8Encoding(true));
        var executable = Path.Combine(bin, entry);
        File.WriteAllText(executable, "test executable placeholder");
        if (managed)
        {
            File.Copy(typeof(MacBundleTests).Assembly.Location, Path.Combine(bin, entry + ".dll"));
            File.WriteAllText(Path.Combine(bin, entry + ".runtimeconfig.json"), "{\"runtimeOptions\":{}}");
        }
        return executable;
    }
}
