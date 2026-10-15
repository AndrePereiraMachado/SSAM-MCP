using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// The attribute names of the store's fields (PrototypeFieldNames) and the name map of a leftover Studio rename
/// (PROTOTYPE_NAME_COLLISION), from the FolhaPonto session of 2026-10-12: the field label of a static entity was created next to
/// its built-in Label, the Studio renamed it label2, and the refusal offered mapping.names {label: label2} again and again.
/// </summary>
public class PrototypeFieldNamesTests
{
    private static JsonObject Raw() => new()
    {
        ["schema"] = PrototypeCapture.Schema,
        ["store"] = new JsonObject
        {
            ["collections"] = new JsonArray(
                new JsonObject
                {
                    ["name"] = "Data", ["key"] = "plan", ["mutated"] = false, ["references"] = new JsonArray(),
                    ["fields"] = new JsonArray(Field("id", "Text"), Field("label", "Text"), Field("plan", "Integer")),
                    ["rows"] = new JsonArray(new JsonObject { ["id"] = "in", ["label"] = "Entrada", ["plan"] = 540 }, new JsonObject { ["id"] = "out", ["label"] = "Saída", ["plan"] = 1080 }),
                },
                new JsonObject
                {
                    ["name"] = "Tipos", ["key"] = "Id", ["mutated"] = false, ["references"] = new JsonArray(),
                    ["fields"] = new JsonArray(Field("Id", "Integer"), Field("ORDER", "Integer"), Field("Nome", "Text")),
                    ["rows"] = new JsonArray(new JsonObject { ["Id"] = 1, ["ORDER"] = 2, ["Nome"] = "A" }),
                },
                new JsonObject
                {
                    ["name"] = "Pessoas", ["key"] = "Id", ["mutated"] = true, ["references"] = new JsonArray(new JsonObject { ["field"] = "TipoId", ["collection"] = "Tipos" }),
                    ["fields"] = new JsonArray(Field("Id", "Integer"), Field("Name", "Text"), Field("name", "Text"), Field("LABEL", "Text"), Field("TipoId", "Integer")),
                    ["rows"] = new JsonArray(new JsonObject { ["Id"] = 1, ["Name"] = "Ana", ["name"] = "ana", ["LABEL"] = "x", ["TipoId"] = 1 }),
                }),
        },
        ["views"] = new JsonArray(new JsonObject
        {
            ["key"] = "v", ["name"] = "V", ["root"] = new JsonObject
            {
                ["k"] = "v:v", ["t"] = "div",
                ["c"] = new JsonArray(
                    new JsonObject { ["k"] = "v:v/0", ["x"] = "Entrada", ["expr"] = new JsonObject { ["fmt"] = "text", ["value"] = new JsonObject { ["field"] = "label" } } },
                    new JsonObject { ["k"] = "v:v/1", ["x"] = "ana", ["expr"] = new JsonObject { ["fmt"] = "text", ["value"] = new JsonObject { ["field"] = "name" } } }),
            },
        }),
        ["events"] = new JsonArray(new JsonObject
        {
            ["key"] = "v:click:x", ["selector"] = "button", ["on"] = "click",
            ["effects"] = new JsonArray(new JsonObject { ["kind"] = "update", ["collection"] = "Pessoas", ["fields"] = new JsonObject { ["name"] = new JsonObject { ["lit"] = "b" } } }),
        }),
        ["trees"] = new JsonObject { ["t1"] = new JsonObject { ["k"] = "b", ["t"] = "body", ["a"] = new JsonArray(new JsonArray("label", "kept")) } },
    };

    private static JsonObject Field(string name, string type) => new() { ["name"] = name, ["type"] = type };

    [Fact]
    public void AFieldLabelOrOrderOfAStaticEntityInAnyCaseIsItsBuiltInAttributeAndACaseTwinGetsTheNextFreeName()
    {
        var result = PrototypeFieldNames.Canonicalize(Raw(), null, "FolhaDePonto");
        // label (static Data) is the built-in Label, ORDER (static Tipos) the built-in Order, name (twin of Name) name2; LABEL of a
        // regular entity keeps its name (a regular entity has no built-ins)
        Assert.Equal(new Dictionary<string, string> { ["label"] = "Label", ["ORDER"] = "Order", ["name"] = "name2" }, result.Map.OrderBy(p => p.Key).ToDictionary());
        var collections = PrototypeCapture.Objects(result.Ir["store"]!["collections"]);
        Assert.Equal(["id", "Label", "plan"], PrototypeCapture.Objects(collections[0]["fields"]).Select(f => f["name"]!.ToString()));
        Assert.Equal("Entrada", collections[0]["rows"]![0]!["Label"]!.ToString());
        Assert.Equal(["Id", "Name", "name2", "LABEL", "TipoId"], PrototypeCapture.Objects(collections[2]["fields"]).Select(f => f["name"]!.ToString()));
        Assert.Equal("ana", collections[2]["rows"]![0]!["name2"]!.ToString());
        // every reference goes through the map: the value of a view, the field map of an effect; the explored trees never
        var root = result.Ir["views"]![0]!["root"]!;
        Assert.Equal("Label", root["c"]![0]!["expr"]!["value"]!["field"]!.ToString());
        Assert.Equal("name2", root["c"]![1]!["expr"]!["value"]!["field"]!.ToString());
        Assert.True(result.Ir["events"]![0]!["effects"]![0]!["fields"]!.AsObject().ContainsKey("name2"));
        Assert.Equal("click", result.Ir["events"]![0]!["on"]!.ToString());
        Assert.Equal("label", result.Ir["trees"]!["t1"]!["a"]![0]![0]!.ToString());
        // the receipt says why
        Assert.Contains(result.Renamed.OfType<JsonObject>(), r => r["field"]!.ToString() == "label" && r["name"]!.ToString() == "Label" && r["why"]!.ToString().Contains("built-in"));
        Assert.Contains(result.Renamed.OfType<JsonObject>(), r => r["field"]!.ToString() == "name" && r["name"]!.ToString() == "name2");
        // the capture as written is untouched (its hash is the facade's)
        Assert.Equal("label", Raw()["store"]!["collections"]![0]!["fields"]![1]!["name"]!.ToString());
    }

    [Fact]
    public void MappingNamesOfAnEntityFieldGivesTheAttributeAndAKeyNamedOrderOfAStaticEntityIsNoBuiltIn()
    {
        // "<Entity>/<field>" by the collection, its entity stem or the prefixed entity name (with the planner's number)
        foreach (var owner in new[] { "Data", "data", "FolhaDePontoData", "FolhaDePontoData2" })
        {
            var names = new JsonObject { [owner + "/id"] = "Codigo" };
            var result = PrototypeFieldNames.Canonicalize(Raw(), names, "FolhaDePonto");
            Assert.True(result.Map.TryGetValue("id", out var to) && to == "Codigo", owner + ": " + string.Join(",", result.Map));
        }
        // a static entity whose key is called order: the key is its own attribute (Order2), the built-in Order stays
        var raw = Raw();
        var tipos = raw["store"]!["collections"]![1]!.AsObject();
        tipos["key"] = "ORDER";
        var keyed = PrototypeFieldNames.Canonicalize(raw, null, "P");
        Assert.Equal("ORDER2", keyed.Map["ORDER"]);
        Assert.Equal("ORDER2", PrototypeCapture.Objects(keyed.Ir["store"]!["collections"]).ElementAt(1)["key"]!.ToString());
    }

    [Fact]
    public void ACaptureWithAStaticFieldLabelBuildsNoSecondLabelAttributeAndItsValuesGoToTheBuiltIn()
    {
        if (!PrototypeFakes.Studio()) return;
        StaticLabel();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void StaticLabel()
    {
        var dir = Directory.CreateTempSubdirectory("ssam-fieldnames-").FullName;
        try
        {
            CopyDirectory(Path.Combine(PrototypeFakes.Fixtures, "minimal.bundle"), Path.Combine(dir, "minimal.bundle"));
            var ir = JsonNode.Parse(File.ReadAllText(PrototypeFakes.Minimal))!.AsObject();
            // the static Categoria gets a field LABEL (upper case) with its own values; Tarefa (regular) a twin titulo of Titulo
            var categoria = PrototypeCapture.Objects(ir["store"]!["collections"]).First(c => c["name"]!.ToString() == "Categoria");
            categoria["fields"]!.AsArray().Add(Field("LABEL", "Text"));
            foreach (var row in categoria["rows"]!.AsArray().OfType<JsonObject>()) row["LABEL"] = "Rótulo " + row["Nome"];
            var tarefa = PrototypeCapture.Objects(ir["store"]!["collections"]).First(c => c["name"]!.ToString() == "Tarefa");
            tarefa["fields"]!.AsArray().Add(Field("titulo", "Text"));
            foreach (var row in tarefa["rows"]!.AsArray().OfType<JsonObject>()) row["titulo"] = "t";
            var capture = Path.Combine(dir, "minimal.capture.json");
            File.WriteAllText(capture, ir.ToJsonString());
            var (plan, loaded) = PrototypeFakes.Plan(capture);
            Assert.Empty(plan.Problems);
            var ops = PrototypeFakes.Ops(plan).ToList();
            var entity = ops.Single(o => o["op"]?.ToString() == "create" && o["type"]?.ToString() == "IStaticEntity" && o["name"]?.ToString() == "Categoria")["as"]!.ToString();
            var attributes = ops.Where(o => o["op"]?.ToString() == "create" && o["type"]?.ToString() == "IEntityAttribute" && o["parent"]?.ToString() == entity).Select(o => o["name"]!.ToString()).ToList();
            Assert.Single(attributes, a => string.Equals(a, "Label", StringComparison.OrdinalIgnoreCase));
            Assert.Contains(ops, o => o["op"]?.ToString() == "set" && o["target"]?.ToString()?.EndsWith("/Label", StringComparison.Ordinal) == true && o["value"]?.ToString() == "\"Rótulo Casa\"");
            var tarefaRef = ops.Single(o => o["op"]?.ToString() == "create" && o["type"]?.ToString() == "IServerEntity" && o["name"]?.ToString() == "Tarefa")["as"]!.ToString();
            Assert.Contains(ops, o => o["op"]?.ToString() == "create" && o["type"]?.ToString() == "IEntityAttribute" && o["parent"]?.ToString() == tarefaRef && o["name"]?.ToString() == "titulo2");
            Assert.Equal("titulo2", loaded.AttributeMap["titulo"]);
            // the receipt lists both and gives the seed the attribute of the twin
            var renamed = plan.Report["renamed"]!.AsArray().OfType<JsonObject>().Where(r => r["kind"]?.ToString() == "attribute").Select(r => r["field"] + "->" + r["name"]).ToList();
            Assert.Contains("LABEL->Label", renamed); Assert.Contains("titulo->titulo2", renamed);
            var seedOf = plan.Report["data"]!["entities"]!.AsArray().OfType<JsonObject>().Single(e => e["name"]!.ToString() == "Tarefa");
            Assert.Equal("titulo2", seedOf["attributes"]!["titulo"]!.ToString());
        }
        finally { Directory.Delete(dir, true); }
    }

    [Fact]
    public void ACollisionPatchIsOfferedOnlyWhenThePlanMadeAgainWithItNoLongerGeneratesTheName()
    {
        if (!PrototypeFakes.Studio()) return;
        Revalidated();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Revalidated()
    {
        var module = PrototypeModule.Empty("o11", "Haiku_UI");
        var capture = PrototypeFakes.Load(PrototypeFakes.FarmaVirtual);
        var theme = new InvalidOperationException("create IMobileTheme 'FarmaVirtualTheme' under ESpace 'Haiku_UI': ...");
        theme.Data[ModelSession.NameCollisionData] = new JsonObject { ["type"] = "IMobileTheme", ["name"] = "FarmaVirtualTheme", ["actual"] = "FarmaVirtualTheme2", ["parentType"] = "IESpace", ["parentName"] = "Haiku_UI" }.ToJsonString();
        var generated = new JsonObject { ["op"] = "create", ["parent"] = "@espace", ["type"] = "IMobileTheme", ["name"] = "FarmaVirtualTheme", ["as"] = "$p.theme" };
        var problem = ModelSession.PrototypeCollisionProblem(theme, capture.Data, "theme")!;
        // the map makes the planner use another theme name: verified, the patch stands
        Assert.Null(ModelSession.PrototypeCollisionUnresolved(problem, capture, generated, module, PrototypeFakes.Seams));
        // the call already carried the map (the loop of 2026-10-12): no patch, an SSAM defect
        var looped = PrototypeFakes.Load(PrototypeFakes.FarmaVirtual, new JsonObject { ["mapping"] = new JsonObject { ["names"] = new JsonObject { ["FarmaVirtualTheme"] = "FarmaVirtualTheme2" } } });
        var again = ModelSession.PrototypeCollisionProblem(theme, looped.Data, "theme")!;
        var why = ModelSession.PrototypeCollisionUnresolved(again, looped, generated, module, PrototypeFakes.Seams);
        Assert.NotNull(why); Assert.Contains("already maps", why);
        var without = ModelSession.PrototypeCollisionWithoutPatch(again, why!);
        Assert.Null(without["patch"]); Assert.True(without["ssamDefect"]!.GetValue<bool>()); Assert.True(without["unresolved"]!.GetValue<bool>());
        // a map the plan does not read (an owner it never builds) leaves the name generated: unresolved too
        var stray = new InvalidOperationException("create IEntityAttribute 'Nome' under IStaticEntity 'Nada': ...");
        stray.Data[ModelSession.NameCollisionData] = new JsonObject { ["type"] = "IEntityAttribute", ["name"] = "Nome", ["actual"] = "Nome2", ["parentType"] = "IStaticEntity", ["parentName"] = "Nada" }.ToJsonString();
        var strayProblem = ModelSession.PrototypeCollisionProblem(stray, capture.Data, "spec")!;
        Assert.Equal("/mapping/names/Nada~1Nome", strayProblem["pointer"]!.ToString());
        var plan = PrototypeExpander.Plan(capture, module, PrototypeFakes.Seams);
        var attribute = PrototypeFakes.Ops(plan).First(o => o["op"]?.ToString() == "create" && o["type"]?.ToString() == "IEntityAttribute" && o["name"]?.ToString() == "Nome");
        var strayWhy = ModelSession.PrototypeCollisionUnresolved(strayProblem, capture, attribute, module, PrototypeFakes.Seams);
        Assert.NotNull(strayWhy); Assert.Contains("still generates", strayWhy);
    }

    [Fact]
    public void EveryCollisionThePlanCarriesComesInOneRefusalWithTheVerifiedNameMapAndNoneForAnOwnerWithoutName()
    {
        if (!PrototypeFakes.Studio()) return;
        Planned();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Planned()
    {
        var module = PrototypeModule.Empty("o11", "Haiku_UI");
        var (clean, capture) = PrototypeFakes.Plan(PrototypeFakes.FarmaVirtual);
        // the importer's own plans never carry one (the field names and the member scopes reserve every name first)
        Assert.Empty(ModelSession.PrototypeDuplicateCreates(clean));
        Assert.Empty(ModelSession.PrototypePlannedCollisions(clean, capture, module, PrototypeFakes.Seams));
        var entity = clean.EntityCollections.First(p => p.Value == "Categoria").Key;
        var plan = new PrototypePlan { Capture = capture, Platform = "o11" };
        foreach (var (k, v) in clean.EntityCollections) plan.EntityCollections[k] = v;
        plan.Steps.Add(new PrototypeStep("spec", "spec", Ops:
        [
            PrototypePlanner.Create("$p.ent.Categoria", "IEntityAttribute", "Nome", "$a1"), PrototypePlanner.Create("$p.ent.Categoria", "IEntityAttribute", "NOME", "$a2"),
            PrototypePlanner.Create("$p.unknown", "ILocalVariable", "Total", "$l1"), PrototypePlanner.Create("$p.unknown", "ILocalVariable", "total", "$l2"),
            PrototypePlanner.Create("$p.ent.Categoria", "IRecord", "Nome", "$r1"),
        ]));
        var problems = ModelSession.PrototypePlannedCollisions(plan, capture, module, PrototypeFakes.Seams);
        Assert.Equal(2, problems.Count);
        Assert.Equal("[{\"op\":\"add\",\"path\":\"/mapping\",\"value\":{\"names\":{\"" + entity + "/NOME\":\"NOME2\"}}}]", problems[0]["patch"]!.ToJsonString());
        Assert.Null(problems[1]["patch"]);
        Assert.True(problems[1]["ssamDefect"]!.GetValue<bool>());
        Assert.Contains("no name map resolves it", problems[1]["message"]!.ToString());
    }

    private static void CopyDirectory(string from, string to)
    {
        Directory.CreateDirectory(to);
        foreach (var file in Directory.GetFiles(from)) File.Copy(file, Path.Combine(to, Path.GetFileName(file)));
        foreach (var sub in Directory.GetDirectories(from)) CopyDirectory(sub, Path.Combine(to, Path.GetFileName(sub)));
    }
}
