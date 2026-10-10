using System.IO.Compression;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Xif;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// K1-f of the atritos 3 package (C38). The three spec shapes the DCIPS session had refused (analysis of the atritos, item H):
/// sources given as one object is a list of one, accepted and noted in specNormalized; an unknown field names where it
/// belongs or the closest accepted field; a parameter repeated between inputs and outputs gets its exact free name. And the
/// spec of the catalog route (catalog/fragments/C/dotnet-extensions.json, read from the fragment itself) passes parse and the
/// model and final stages on the installed Integration Studio, offline (pattern of XifInstalledEngineTests).
/// </summary>
public sealed class Pa3K1XifTests
{
    [Fact]
    public void SourcesReferencesAndResourcesAsOneObjectAreAListOfOneWithANote()
    {
        var spec = JsonNode.Parse("""
            { "name": "ZZPa3K1Xif",
              "sources": { "path": "Helper.cs", "text": "namespace OutSystems.NssZZPa3K1Xif { internal static class Helper { } }" },
              "resources": { "path": "Data\\settings.json", "text": "{}", "deploy": "Ignore" },
              "actions": [ { "name": "Ping", "outputs": [ { "name": "Result", "type": "Text" } ], "body": "Result = \"pong\";" } ] }
            """);
        var parsed = XifSpec.Parse(spec);
        Assert.Equal("Helper.cs", Assert.Single(parsed.Sources).Path);
        Assert.Equal("Ignore", Assert.Single(parsed.Resources).Deploy);
        Assert.Equal(new[] { ("sources", "object", "list"), ("resources", "object", "list") }, parsed.Normalized.Select(n => (n.Path, n.From, n.To)));
        // The receipt of `xif check` carries it; the normalized spec has lists.
        var check = XifBuild.Check(spec, null);
        var notes = check["specNormalized"]!.AsArray();
        Assert.Equal("sources", notes[0]!["path"]!.ToString()); Assert.Equal("object", notes[0]!["from"]!.ToString()); Assert.Equal("list", notes[0]!["to"]!.ToString());
        Assert.IsType<JsonArray>(check["spec"]!["sources"]);
        // A list stays a list, without a note.
        Assert.Empty(XifSpec.Parse(JsonNode.Parse("""{ "name": "ZZPa3K1Xif", "actions": [ { "name": "Ping", "body": "return;" } ] }""")).Normalized);
    }

    [Fact]
    public void TheRefusedShapesOfTheDcipsSessionComeWithTheExactFix()
    {
        // The real refused specs (2026-10-07 02:32-02:34Z): sources as text, 'sources' inside an action, 'foo' in a source,
        // and Provider/Filename both inputs and outputs of ScanBuffer.
        var refusal = Assert.Throws<XifRefusal>(() => XifSpec.Parse(JsonNode.Parse("""
            { "name": "ZZPa3K1Util_Ext", "sources": "x",
              "actions": [ { "name": "A", "body": "return;", "sources": "x", "bdy": "x" },
                { "name": "ScanBuffer", "inputs": [ { "name": "Provider", "type": "Text" }, { "name": "Filename", "type": "Text" }, { "name": "ProviderOut", "type": "Text" } ],
                  "outputs": [ { "name": "Provider", "type": "Text" }, { "name": "Filename", "type": "Text" } ], "body": "return;" } ] }
            """)));
        var problems = refusal.Problems.ToList();
        var list = Assert.Single(problems, p => p.Code == "XIF_SPEC_SHAPE" && p.Path == "sources");
        Assert.Contains("\"sources\": [{\"path\":\"Helper.cs\",\"text\":", list.Fix);
        var misplaced = Assert.Single(problems, p => p.Code == "XIF_SPEC_FIELD" && p.Path == "actions[0].sources");
        Assert.Contains("'sources' is a field of the root of the spec", misplaced.Fix);
        var typo = Assert.Single(problems, p => p.Code == "XIF_SPEC_FIELD" && p.Path == "actions[0].bdy");
        Assert.StartsWith("Did you mean 'body'?", typo.Fix);
        // The exact free names: ProviderOut is taken by an input, so the output becomes ProviderOut2; Filename -> FilenameOut.
        var provider = Assert.Single(problems, p => p.Code == "XIF_SPEC_DUPLICATE" && p.Path == "actions[1].outputs[0].name");
        Assert.StartsWith("Rename this one to ProviderOut2 ", provider.Fix);
        var filename = Assert.Single(problems, p => p.Code == "XIF_SPEC_DUPLICATE" && p.Path == "actions[1].outputs[1].name");
        Assert.StartsWith("Rename this one to FilenameOut ", filename.Fix);
        // An unknown field near no accepted one and of no other level is simply removed, with what is accepted there.
        var foo = Assert.Throws<XifRefusal>(() => XifSpec.Parse(JsonNode.Parse("""
            { "name": "ZZPa3K1Util_Ext", "actions": [ { "name": "A", "body": "x" } ], "sources": [ { "foo": "x", "path": "A.cs", "text": "class A {}" } ] }
            """)));
        Assert.StartsWith("Remove it. Accepted here: path, file, text.", Assert.Single(foo.Problems, p => p.Code == "XIF_SPEC_FIELD").Fix);
    }

    /// <summary>The spec object of the route operation of integration.dotnet-extension-o11, as the catalog fragment has it.</summary>
    internal static JsonNode RouteSpec()
    {
        var fragment = Path.Combine(Path.GetDirectoryName(XifCompilerTests.Kernel)!, "platforms", "odc", "facade", "catalog", "fragments", "C", "dotnet-extensions.json");
        var capability = JsonNode.Parse(File.ReadAllText(fragment))!["capabilities"]!.AsArray().Single(c => c!["id"]!.ToString() == "integration.dotnet-extension-o11")!;
        var operation = capability["route"]!["operation"]!.ToString();
        var start = operation.IndexOf("spec:", StringComparison.Ordinal) + "spec:".Length;
        Assert.True(start >= "spec:".Length && operation[start] == '{', "the route names spec:{...}");
        int depth = 0, end = start; var inString = false;
        for (; end < operation.Length; end++)
        {
            var ch = operation[end];
            if (inString) { if (ch == '\\') end++; else if (ch == '"') inString = false; continue; }
            if (ch == '"') inString = true;
            else if (ch == '{') depth++;
            else if (ch == '}' && --depth == 0) break;
        }
        return JsonNode.Parse(operation[start..(end + 1)])!;
    }

    [Fact]
    public void TheCatalogRouteSpecBuildsOnTheInstalledEngine()
    {
        var spec = RouteSpec();
        // The route teaches the three shapes: a structure, an inline source, inputs and outputs without a shared name.
        var parsed = XifSpec.Parse(spec);
        Assert.NotEmpty(parsed.Structures);
        Assert.Contains(parsed.Sources, s => s.Text != null && s.File == null);
        Assert.All(parsed.Actions, a => Assert.Empty(a.Inputs.Select(i => i.Name).Intersect(a.Outputs.Select(o => o.Name), StringComparer.OrdinalIgnoreCase)));
        Assert.Empty(parsed.Normalized);
        var work = Path.Combine(Path.GetTempPath(), "anvil-xif-pa3k1-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(work);
        try
        {
            if (!Installed(work)) return;
            var model = XifBuild.Model(spec, null, Path.Combine(work, "w"));
            Assert.Equal(parsed.Name, model["name"]!.ToString());
            Assert.StartsWith("11.", model["engine"]!["version"]!.ToString());
            var modelDocument = XifPackage.Read(model["xif"]!.ToString());
            Assert.Equal(parsed.Structures.Select(s => s.Name), modelDocument.Structures.Select(s => s.Name));

            // The stubs the environment would generate (the layout of fixtures\xif\stubs) plus a structure file; the fake
            // platform DLL of the fixtures. Nothing is sent.
            var fixtures = XifCompilerTests.Fixtures;
            var structures = Path.Combine(work, "Structures.cs");
            File.WriteAllText(structures, "namespace OutSystems.NssZZHybridXifLab { public struct STPairStructure { public int ssLeft; public int ssRight; } }");
            var stubs = Zip(Path.Combine(work, "stubs.zip"), ("ZZHybridXifLab.cs", Path.Combine(fixtures, "stubs", "ZZHybridXifLab.cs")),
                ("Interface.cs", Path.Combine(fixtures, "stubs", "Interface.cs")), ("Structures.cs", structures));
            var platformDir = Path.Combine(work, "platform"); Directory.CreateDirectory(platformDir);
            var platform = XifCompilerTests.CompileLibrary(platformDir, "OutSystems.HubEdition.RuntimePlatform",
                File.ReadAllText(Path.Combine(fixtures, "fake-platform", "OutSystems.HubEdition.RuntimePlatform.cs")));
            var deps = Zip(Path.Combine(work, "deps.zip"), ("OutSystems.HubEdition.RuntimePlatform.dll", platform));
            var final = XifBuild.Final(spec, model["xif"]!.ToString(), stubs, deps, null, Path.Combine(work, "w"));
            Assert.Equal("final", final["stage"]!.ToString());
            Assert.Equal(model["key"]!.ToString(), final["key"]!.ToString());
            var document = XifPackage.Read(final["xif"]!.ToString());
            Assert.Equal(parsed.Actions.Select(a => a.Name), document.Actions.Select(a => a.Name));
            Assert.Contains(document.Resources, r => r.Filename == "Arith.cs");
            Assert.Equal("Binaries", Assert.Single(document.Resources, r => r.Filename == "OutSystems.NssZZHybridXifLab.dll").CompileAction);
        }
        finally { try { Directory.Delete(work, true); } catch (IOException) { } }
    }

    private static bool Installed(string work)
    {
        if (!XifEngineClient.Candidates().Any(File.Exists)) return false;
        try { return XifEngineClient.Run(new JsonObject { ["command"] = "probe" }, work)["ok"]?.GetValue<bool>() == true; }
        catch (XifRefusal refusal) when (refusal.Code == XifCodes.EngineUnavailable) { return false; }
    }

    private static string Zip(string file, params (string Entry, string Source)[] entries)
    {
        using var archive = ZipFile.Open(file, ZipArchiveMode.Create);
        foreach (var (entry, source) in entries) archive.CreateEntryFromFile(source, entry);
        return file;
    }
}
