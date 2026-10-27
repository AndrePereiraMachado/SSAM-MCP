using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using OutSystems.Model;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests.Odc;

/// <summary>ODC Studio 1.7.29 (model 13.1451) adds to a module it loads the list types of its new system records (Agent*), beside
/// the ones the module keeps: the fixture insurance-reactive-r8 keeps one Text List, and 1.7.29 gives it a second list type of
/// Text with the same name (1.7.28 gives none). A list type is the list of its element, so on every ODC Studio the kernel's
/// names answer one type: the document's type="Text List" (and ListType:Text List) compiles, the reading of a screen whose
/// variable is a Text List writes the name and decodes back to it, and the type text of every op (TypeResolver) gives the
/// platform's own list of Text, creating nothing. Needs the ODC Studio.</summary>
public sealed class ListTypeNamesOdcTests(ITestOutputHelper output)
{
    private const string Fixture = "tests/fixtures/odc/insurance-reactive-r8.oml";

    private const string Document = "<screen name=\"ListNames\" actions=\"Go\">\n<var name=\"Rows\" type=\"Text List\"/>\n"
        + "<var name=\"Kinds\" type=\"ListType:Text List\"/>\n<button onclick=\"Go\">Go</button>\n"
        + "<div list=\"Rows\"><p>{{ Rows.Current }}</p></div>\n</screen>";

    [Fact]
    public void TextListIsOneTypeInTheDocumentTheReadingAndTheTypeTextOnEveryOdcStudio()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no ODC Studio: skipped."); return; }
        var root = FindRoot();
        var dir = Path.Combine(root, ".local", "lane-odc", "list-type-names", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var host = new ModelHost(Path.Combine(dir, "work"));
        var fixture = File.ReadAllBytes(Path.Combine(root, Fixture));

        // The type text: one list of Text whatever the Studio gives the module, the platform's own, and nothing is created.
        var es = (IESpace)(object)host.Load(fixture);
        try
        {
            var lists = es.ListTypes.Where(l => TypeResolver.Name(l) == "Text List").ToList();
            output.WriteLine($"list types named Text List: {lists.Count}");
            Assert.NotEmpty(lists);
            Assert.All(lists, l => Assert.Same(es.TextType, l.ElementType));
            var count = es.ListTypes.Count();
            var resolved = TypeResolver.Resolve(es, "Text List");
            Assert.Same(resolved, TypeResolver.Resolve(es, "text list"));
            Assert.Same(es.GetOrCreateListType(es.TextType), resolved);
            Assert.Equal(count, es.ListTypes.Count());
        }
        finally { ModelHost.Release((ServiceStudio.Model.ESpace)(object)es); }

        // The reading of a screen of the module whose variable is a Text List names it, and decodes back to the model.
        var gallery = host.HtmlRead(fixture, "MobileScreen:WF_ComponentGallery", withKeys: false)["documents"]![0]!["html"]!.ToString();
        Assert.Contains("name=\"ConditionStatements\" type=\"Text List\"", gallery);

        // The document names it both ways and compiles; its reading says Text List and is the fixed point.
        var job = Path.Combine(dir, "job.json");
        File.WriteAllText(job, new JsonObject
        {
            ["base"] = Fixture,
            ["expectedMessages"] = new JsonArray(new JsonObject { ["id"] = "AnonymousAccess_NoPermissions", ["all"] = true, ["why"] = "a test screen without a role" }),
            ["ops"] = new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = Document } },
                new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray("action ListNames.Go\n  end\n") } }),
        }.ToJsonString());
        var outPath = Path.Combine(dir, "out.oml");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, null, job, outPath))!.AsObject();
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]?.ToJsonString() ?? result.ToJsonString());
        var built = File.ReadAllBytes(outPath);
        var text = host.HtmlRead(built, "MobileScreen:ListNames", withKeys: false)["documents"]![0]!["html"]!.ToString();
        output.WriteLine(text);
        Assert.Contains("name=\"Rows\" type=\"Text List\"", text);
        Assert.Contains("name=\"Kinds\" type=\"Text List\"", text);
        var check = host.HtmlCheck(built)["documents"]!.AsArray().Single(d => d!["root"]!.ToString() == "ListNames")!;
        Assert.Equal(0, check["ops"]!.GetValue<int>());
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(ListTypeNamesOdcTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }
}
