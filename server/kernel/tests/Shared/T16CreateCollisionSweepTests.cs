using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>
/// T16 rule 1, both lanes, on a module with a UI flow (the lane's template: MainFlow and its screens) and an entity: every named
/// element the native model has (read by a dump, never listed by hand) that is no widget and no flow node, created again under
/// its parent with its type and name, is refused once at the base (NAME_COLLISION, the patch that uses the existing element,
/// never certain, never called proven), and the job with that patch applied is accepted the next round; a screen or a block,
/// which the model types as a widget, is named by the Studio and accepted as the apply does. Deleting or renaming the parent
/// first, by its name, is never a base collision (review of e10ecacc, R2).
/// </summary>
public sealed class T16CreateCollisionSweepTests(ITestOutputHelper log)
{
    private static string Lane => typeof(ModelHost).Assembly.GetType("Anvil.Core.StudioAssembliesOdc") != null ? "odc" : "o11";
    private static string Kernel => JobSources.KernelRoot()!;
    // The lane's Reactive app with a UI flow: O11 the template of the suites, ODC the reactive fixture (its blank module has none).
    private static string Fixture => Path.Combine(Kernel, "tests", "fixtures", Lane == "odc" ? Path.Combine("odc", "insurance-reactive-r8.oml") : "reactive-ui.oml");
    private static string? _base;

    private static string Work()
    {
        var dir = Path.Combine(Kernel, ".local", "t16-sweep", Lane, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static (JsonNode? Result, Exception? Error) Run(string? basePath, string ops, string? output = null)
    {
        var dir = Work();
        var job = Path.Combine(dir, "job.json");
        File.WriteAllText(job, new JsonObject { ["base"] = Fixture, ["expectValid"] = true, ["ops"] = JsonNode.Parse(ops) }.ToJsonString());
        try { return (JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "model")), basePath, job, output ?? Path.Combine(dir, "out.oml"))), null); }
        catch (Exception ex) { return (null, ex); }
    }

    // The template plus an entity with an attribute.
    private static string Base()
    {
        if (_base != null && File.Exists(_base)) return _base;
        var output = Path.Combine(Work(), "base.oml");
        var (result, error) = Run(null, """[{"op":"spec","data":{"entities":[{"name":"T16Order","attributes":[{"name":"Code","type":"Text","length":50}]}]}}]""", output);
        Assert.True(error == null, error?.ToString());
        Assert.True(result!["accepted"]!.GetValue<bool>(), result.ToJsonString());
        return _base = output;
    }

    private static List<JsonObject> Problems(Exception error) => Errors.FindCoded(error)!.Problems!.OfType<JsonObject>().ToList();
    private static string Show(IEnumerable<JsonObject> list) => new JsonArray(list.Select(p => (JsonNode)p.DeepClone()).ToArray()).ToJsonString();

    private static string Patched(string ops, IEnumerable<JsonObject> problems)
    {
        var job = JsonNode.Parse(ops)!.AsArray();
        foreach (var step in problems.Where(p => p["patch"] is JsonArray).SelectMany(p => p["patch"]!.AsArray().OfType<JsonObject>()))
        {
            var segments = step["path"]!.ToString().Split('/');
            var index = int.Parse(segments[2]);
            if (segments.Length == 3) job[index] = step["value"]!.DeepClone();
            else job[index]!.AsObject()[segments[3]] = step["value"]!.DeepClone();
        }
        return job.ToJsonString();
    }

    // Kinds of the model a job writes with a raw create: never a widget, a flow node, a connector or what the platform derives.
    private static readonly Regex Skipped = new("(Widget|Node|Connector|Assignment|ListType|AnonymousStructure|Reference|Signature|Theme|Image|Resource|Type|Exception)$|^I(Basic|System)", RegexOptions.Compiled);

    [Fact]
    public void EveryNamedElementOfAModuleWithAUIFlowCreatedAgainIsRefusedOnceAndItsPatchIsAcceptedNextRound()
    {
        var (dumped, dumpError) = Run(Base(), """[{"op":"dump","target":"@espace","depth":3}]""");
        Assert.True(dumpError == null, dumpError?.ToString());
        var tree = dumped!["results"]![0]!["result"] as JsonObject;
        Assert.NotNull(tree);
        var cases = new List<(string Parent, string Type, string Name)>();
        var perKind = new Dictionary<string, int>(StringComparer.Ordinal);
        string? t16Order = null;
        void Walk(JsonObject node, string parentRef, int depth)
        {
            foreach (var child in (node["children"] as JsonArray ?? []).OfType<JsonObject>())
            {
                var name = child["name"]?.ToString();
                var iface = child["iface"]?.ToString()?.Split('.').Last();
                var key = child["key"]?.ToString();
                if (string.IsNullOrEmpty(name) || iface is not { Length: > 1 } || key is not { Length: > 0 } || Skipped.IsMatch(iface)) continue;
                if (perKind.GetValueOrDefault(iface) < (Lane == "odc" ? 2 : 3) || name == "MainFlow" || name.StartsWith("T16", StringComparison.Ordinal) || parentRef == t16Order) { perKind[iface] = perKind.GetValueOrDefault(iface) + 1; cases.Add((parentRef, iface, name)); }
                if (iface == "IServerEntity" && name == "T16Order") t16Order = "@" + key;
                if (depth > 1 && (iface is "IMobileFlow" or "IMobileScreen" or "IWebFlow" or "IWebScreen" || iface == "IServerEntity" && name == "T16Order")) Walk(child, "@" + key, depth - 1);
            }
        }
        Walk(tree!, "@espace", 3);
        log.WriteLine($"{Lane}: {cases.Count} generated cases: " + string.Join(", ", cases.Select(c => c.Type + ":" + c.Name)));
        // The UI flow of the template, a screen of it, the entity and its attribute: at least those.
        var listed = string.Join(", ", cases.Select(c => c.Type + ":" + c.Name)) + " | top: "
            + string.Join(", ", (tree!["children"] as JsonArray ?? []).OfType<JsonObject>().Select(c => c["iface"]?.ToString()?.Split('.').Last() + ":" + c["name"] + ":" + c["type"]).Take(80));
        Assert.True(cases.Any(c => c.Type == "IMobileFlow" && c.Name == "MainFlow"), listed);
        Assert.Contains(cases, c => c.Type == "IMobileScreen");
        Assert.Contains(cases, c => c.Type == "IServerEntity" && c.Name == "T16Order");
        Assert.Contains(cases, c => c.Name == "Code" && c.Type.Contains("Attribute"));
        var judged = new List<string>(); var freely = new List<string>();
        foreach (var (parent, type, name) in cases)
        {
            var ops = new JsonArray(
                new JsonObject { ["op"] = "create", ["parent"] = parent, ["type"] = type, ["name"] = name, ["as"] = "$t16" },
                new JsonObject { ["op"] = "get", ["target"] = "$t16" }).ToJsonString();
            var (created, error) = Run(Base(), ops);
            if (error == null)
            {
                // A kind the model names freely (a screen, a block, an external site: widgets of the model): the apply keeps the
                // Studio's name (Verbs.Create) and the base check agrees, no base collision; never a collision the base missed.
                Assert.NotEqual(name, created!["results"]![0]!["result"]!["name"]!.ToString());
                Assert.False(Judged(type), $"{type} {name}: accepted under the Studio's name, but this kind is judged");
                freely.Add(type + ":" + name);
                continue;
            }
            judged.Add(type + ":" + name);
            Assert.DoesNotContain(Errors.FindCoded(error)?.Problems?.OfType<JsonObject>() ?? [], p => p["code"]?.ToString() == "NAME_COLLISION" && p["phase"]?.ToString() == "apply");
            Assert.True(error != null && Errors.FindCoded(error) != null, $"{type} {name} under {parent}: {error?.ToString() ?? "accepted, but the base has it"}");
            var problems = Problems(error!);
            var collision = Assert.Single(problems, p => p["code"]!.ToString() == "NAME_COLLISION");
            Assert.True(problems.Count == 1, $"{type} {name}: {Show(problems)}");
            Assert.Equal("base", collision["phase"]!.ToString());
            Assert.Equal(JobRunner.CreateUsesExisting, collision["patchRule"]?.ToString());
            Assert.False(collision["patchCertain"]!.GetValue<bool>());
            Assert.DoesNotContain("proven", collision["fix"]!.ToString());
            Assert.Null(collision["patchProven"]);
            var (again, second) = Run(Base(), Patched(ops, problems));
            Assert.True(second == null, $"{type} {name}: the patched job was refused: {second}");
            Assert.True(again!["accepted"]!.GetValue<bool>(), again.ToJsonString());
        }
        log.WriteLine($"{Lane}: judged at the base {judged.Count}: {string.Join(", ", judged)}; named by the Studio {freely.Count}: {string.Join(", ", freely)}");
        Assert.Contains("IMobileFlow:MainFlow", judged);
        Assert.Contains("IServerEntity:T16Order", judged);
    }

    // The kinds this sweep must see judged at the base (never named freely by the Studio).
    private static bool Judged(string type) => type is "IMobileFlow" or "IServerEntity" or "IEntityAttribute" or "IStructure" or "IStructureAttribute" or "IServerAction" or "IRole";

    [Theory]
    [InlineData("delete")]
    [InlineData("rename")]
    public void AParentTheJobDeletesOrRenamesFirstAndNamesAgainByItsNameIsNoBaseCollision(string first)
    {
        // The entity goes (or takes another name) and a new one takes its name; its attribute is created under it by name.
        var change = first == "delete" ? """{"op":"delete","target":"IServerEntity:T16Order","force":true}"""
            : """{"op":"rename","target":"IServerEntity:T16Order","name":"T16OrderOld"}""";
        var (result, error) = Run(Base(), "[" + change + """
            ,{"op":"spec","data":{"entities":[{"name":"T16Order","attributes":[{"name":"Total","type":"Integer"}]}]}},
             {"op":"create","parent":"IServerEntity:T16Order","type":"IEntityAttribute","name":"Code","as":"$c"},
             {"op":"set","target":"$c","prop":"DataType","value":"Text"}]
            """);
        if (error != null)
            Assert.DoesNotContain(Errors.FindCoded(error)?.Problems?.OfType<JsonObject>() ?? [], p => p["code"]?.ToString() == "NAME_COLLISION" && p["phase"]?.ToString() == "base");
        else Assert.True(result!["accepted"]!.GetValue<bool>(), result.ToJsonString());
    }

    [Fact]
    public void AChildTheJobDeletesFirstByNameIsNoBaseCollision()
    {
        var (result, error) = Run(Base(), """
            [{"op":"delete","target":"IServerEntity:T16Order/Code","force":true},
             {"op":"create","parent":"IServerEntity:T16Order","type":"IEntityAttribute","name":"Code","as":"$c"},
             {"op":"set","target":"$c","prop":"DataType","value":"Text"}]
            """);
        Assert.True(error == null, error?.ToString());
        Assert.True(result!["accepted"]!.GetValue<bool>(), result.ToJsonString());
    }
}
