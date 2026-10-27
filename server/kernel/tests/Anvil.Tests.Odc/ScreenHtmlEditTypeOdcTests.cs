using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using OutSystems.Model;
using OutSystems.Model.Enumerations;
using OutSystems.ModelAPILoader;
using ServiceStudio.Framework.ReferencesManager;
using ServiceStudio.Model;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests.Odc;

/// <summary>The ODC mirror of ScreenHtmlEditTypeTests: a local structure Summary and a producer's of the same name, each the type
/// of a new variable an html edit writes before the variable the screen has; each variable reads back with its own type, after
/// the existing one (receipts 092b8162, 645face7, 82bf05af: the type written as the object the plan resolved, and a new
/// variable where the platform creates it). Needs the ODC Studio.</summary>
public class ScreenHtmlEditTypeOdcTests(ITestOutputHelper output)
{
    [Fact]
    public void ALocalStructureAndAProducersOfTheSameNameAreEachTheTypeTheEditNames()
    {
        StudioAssembliesOdc.Bind();
        Homonyms(output);
    }

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static void Homonyms(ITestOutputHelper output)
    {
        var work = Path.Combine(Path.GetTempPath(), "ssam-odc-html-types", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        NativeReferenceSnapshot snapshot;
        using (var producer = Loader.ModelServicesInstance.CreateESpace(SegmentationKind.ReactiveLibrary, "TypesProducer",
                   targetPlatform: PlatformServerVersion.Neo, enableTransactions: true))
        {
            new ModelSession((ESpace)producer).Apply(JsonNode.Parse("""
            [{"op":"create","parent":"@espace","type":"IStructure","name":"Summary","as":"$s"},
             {"op":"set","target":"$s","prop":"Public","value":true},
             {"op":"create","parent":"$s","type":"IStructureAttribute","name":"Code","as":"$code"},
             {"op":"set","target":"$code","prop":"DataType","value":"Integer"}]
            """)!.AsArray());
            producer.Save();
            var info = ReferenceInfo.ConvertToReferenceInfo(producer);
            snapshot = NativeReferenceSnapshot.Create(new NativeReferenceSnapshot {
                FormatVersion = 2, Environment = "lab.test", ModuleKey = info.Key.ToString(),
                ApplicationKey = info.AppKey?.ToString() ?? "", ModuleKind = ReferenceKind.eSpace,
                ModuleType = SegmentationKind.ReactiveLibrary, Name = info.Name,
                // Test-only identity: the fixture is deliberately not published to a tenant.
                SignatureHash = Guid.Parse("ab111111-2222-3333-4444-666666666666"), SignatureBinary = info.SignatureBinary,
                Elements = OdcPublicSignature.Read(info.SignatureBinary).Elements.Select(e => new NativeReferenceElement(e.Kind, e.Name, e.Key)).ToArray()
            });
        }
        var avsig = Path.Combine(work, "producer.avsig"); snapshot.Write(avsig);
        var bindings = new Dictionary<string, string> { ["TypesProducer"] = avsig };
        var basis = Path.Combine(FindRoot(), "tests", "fixtures", "odc", "insurance-reactive-r8.oml");
        // The consumer: its own structure Summary and a variable of the screen; then (another delivery) the producer's Summary.
        var local = Run(host, work, "local", basis, """
            [{"op":"create","parent":"@espace","type":"IStructure","name":"Summary","as":"$s"},
             {"op":"create","parent":"$s","type":"IStructureAttribute","name":"Label","as":"$label"},
             {"op":"set","target":"$label","prop":"DataType","value":"Text"},
             {"op":"create","parent":"IMobileScreen:InvalidPermissions","type":"ILocalVariable","name":"Existing","as":"$v"},
             {"op":"set","target":"$v","prop":"DataType","value":"Text"}]
            """, null);
        var consumer = Run(host, work, "consumer", local, """[{"op":"reference","producer":"TypesProducer","elements":["IStructure:Summary"]}]""", bindings);
        // The name the producer's structure has here (the platform renames an import whose name the module has).
        var names = new[] { "Summary", "Summary2" }
            .SelectMany(n => (host.ReadModel(consumer, "/", new Anvil.Reading.ReadingOptions(Name: n, Max: 10))["entries"] as JsonArray ?? new JsonArray()).OfType<JsonObject>())
            .Where(e => e["kind"]?.ToString() is { } kind && kind.Contains("Structure", StringComparison.Ordinal) && !kind.Contains("Attribute", StringComparison.Ordinal))
            .Select(e => e["kind"] + ":" + e["name"]).ToList();
        output.WriteLine(string.Join(", ", names));
        var reading = host.HtmlRead(File.ReadAllBytes(consumer), "InvalidPermissions");
        var html = reading["documents"]![0]!["html"]!.ToString();
        Assert.Contains("name=\"Existing\" type=\"Text\"/>", html);
        var existing = System.Text.RegularExpressions.Regex.Match(html, "<var k=\"(w\\d+)\" name=\"Existing\"").Groups[1].Value;
        var theirs = names.Select(n => n[(n.IndexOf(':') + 1)..]).FirstOrDefault(n => n != "Summary") ?? "Summary";
        var sha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(consumer))).ToLowerInvariant();
        var edit = new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["screen"] = "InvalidPermissions",
            ["basedOn"] = new JsonObject { ["capture"] = sha, ["html"] = reading["documents"]![0]!["htmlSha256"]!.DeepClone() },
            ["edits"] = new JsonArray(new JsonObject { ["before"] = existing, ["insert"] = "<var name=\"Mine\" type=\"Structure:Summary\"/><var name=\"Theirs\" type=\"" + theirs + "\"/>" }) } };
        var edited = Run(host, work, "edited", consumer, new JsonArray(edit).ToJsonString(), bindings);
        var after = host.HtmlRead(File.ReadAllBytes(edited), "InvalidPermissions")["documents"]![0]!["html"]!.ToString();
        output.WriteLine(after);
        Assert.Matches("name=\"Existing\" type=\"Text\"/>\\s*<var k=\"w\\d+\" name=\"Mine\" type=\"[^\"]*Summary\"/>\\s*<var k=\"w\\d+\" name=\"Theirs\" type=\"[^\"]*" + theirs + "\"/>", after);
        string TypeOf(string name) => host.ReadModel(edited, "/", new Anvil.Reading.ReadingOptions(Kind: "LocalVariable", Name: name, Properties: "DataType", Max: 2))
            ["entries"]!.AsArray().Single()!["properties"]!["DataType"]!.ToString();
        output.WriteLine(TypeOf("Mine") + " | " + TypeOf("Theirs"));
        Assert.NotEqual(TypeOf("Mine"), TypeOf("Theirs"));
    }

    private static string Run(ModelHost host, string work, string name, string from, string ops, Dictionary<string, string>? bindings)
    {
        var job = Path.Combine(work, name + ".json"); var output = Path.Combine(work, name + ".oml");
        File.WriteAllText(job, new JsonObject { ["ops"] = JsonNode.Parse(ops) }.ToJsonString());
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, from, job, output, bindings: bindings))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        return output;
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(ScreenHtmlEditTypeOdcTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
