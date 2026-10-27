using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Preflight;
using Anvil.Reading;
using OutSystems.Model;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Linked into both test projects: the T3 review round (Preflight/PagingRules.cs, EntityActionsExpander). Paging that works is
/// never refused, whatever form its page state takes; what a job did not wire is never refused; the generated list keeps every
/// join, never pages by START and counts with the same query.
/// <list type="bullet">
/// <item>Fresh: StartIndex as an expression ((CurrentPage - 1) * MaxRecords), a structure local (Filter.StartIndex), a client
/// variable (Client.PgStart), a load-more list (ListAppendAll of the page), a callee that guards its page size
/// (If(MaxRecords &lt;= 0, 50, MaxRecords)) and a TotalCount filled by OnAfterFetch: one job, accepted.</item>
/// <item>A base made before T3 (built by the verbs alone, as an older SSAM or a hand port left it: a server action that pages by
/// START and a screen bound to it): deleting another screen, describing a screen or that action, changing that aggregate's Max.
/// Records or its sort by a flow text are accepted with HIGH warnings; touching the wiring of the broken screen, or writing the
/// START again, is refused.</item>
/// <item>entity-actions over a base whose list action is the earlier generated (START) form: kept, said why, with the edit that
/// adopts the new text; the item structure with a second reference to the same entity is the generated one.</item>
/// </list>
/// </summary>
public static class PagingWiringScenarios
{
    private static JsonObject Op(string json) => JsonNode.Parse(json)!.AsObject();

    private static IEnumerable<JsonObject> Data(bool legacy)
    {
        yield return Op("""{"op":"spec","data":{"entities":[{"name":"PgItem","attributes":[{"name":"Title","type":"Text","length":50,"mandatory":true}]}],"structures":[{"name":"PgFilterState","attributes":[{"name":"StartIndex","type":"Integer"}]}]}}""");
        string Action(string name, string page) => $$$"""
            {"name":"{{{name}}}","kind":"server","description":"One page of items and their count.",
             "inputs":[{"name":"StartIndex","type":"Integer"},{"name":"MaxRecords","type":"Integer"}],
             "outputs":[{"name":"Rows","type":"PgItem List"},{"name":"Total","type":"Long Integer"}],
             "steps":[{{{page}}},
               {"get":"PgItem","as":"CountItems","max":"1"},
               {"assign":{"Rows":"Page.List","Total":"CountItems.Count"},"as":"Return"}]}
            """;
        const string offset = """{"get":"PgItem","as":"Page","sql":true,"statement":"SELECT {PgItem}.* FROM {PgItem} ORDER BY {PgItem}.[Title], {PgItem}.[Id] OFFSET @Skip ROWS FETCH NEXT @Take ROWS ONLY","params":{"Skip":{"type":"Integer","value":"Max(0, StartIndex)"},"Take":{"type":"Integer","value":"MaxRecords"}}}""";
        const string guarded = """{"get":"PgItem","as":"Page","sql":true,"statement":"SELECT {PgItem}.* FROM {PgItem} ORDER BY {PgItem}.[Title], {PgItem}.[Id] OFFSET @Skip ROWS FETCH NEXT @Take ROWS ONLY","params":{"Skip":{"type":"Integer","value":"Max(0, StartIndex)"},"Take":{"type":"Integer","value":"If(MaxRecords <= 0, 50, MaxRecords)"}}}""";
        const string start = """{"get":"PgItem","as":"Page","sort":"PgItem.Title","max":"MaxRecords","start":"StartIndex"}""";
        var actions = new List<string> { Action("LoadPgItems", offset), Action("LoadPgItemsGuarded", guarded) };
        if (legacy) actions.Add(Action("LoadPgItemsStart", start));
        yield return Op($$$"""{"op":"logic","data":{"actions":[{{{string.Join(",", actions)}}}]}}""");
        yield return Op("""{"op":"create","parent":"@espace","type":"IClientVariable","name":"PgStart","as":"$cv"}""");
        yield return Op("""{"op":"set","target":"$cv","prop":"DataType","value":"Integer"}""");
        yield return Op("""{"op":"set","target":"$cv","prop":"DefaultValue","value":"0"}""");
    }

    /// <summary>A screen paged by a Pagination block. Start: the block's StartIndex (and the aggregate's); Assign: what the
    /// handler assigns from NewStartIndex; Source "aggregate" (a screen aggregate) or "sql" (a server action call, Callee).</summary>
    public sealed record Wiring(string Start, string[]? Locals = null, string Assign = """{"StartIndex":"NewStartIndex"}""", string Source = "aggregate",
        bool AppendAll = false, string Callee = "LoadPgItems", bool CountedAfterFetch = false);

    public static IEnumerable<JsonObject> Screen(string name, Wiring? v)
    {
        var s = "$" + name;
        yield return Op($$$"""{"op":"create","parent":"IMobileFlow:MainFlow","type":"IMobileScreen","name":"{{{name}}}","as":"{{{s}}}"}""");
        yield return Op($$$"""{"op":"set","target":"{{{s}}}/#IMobileBlockInstanceWidget","prop":"SourceBlock","value":"IMobileBlock:LayoutTopMenu"}""");
        if (v == null) yield break;
        var sql = v.Source == "sql";
        var locals = new List<(string, string, string?)> { ("StartIndex", "Integer", "0"), ("MaxRecords", "Integer", "10") };
        foreach (var e in v.Locals ?? []) { var p = e.Split(':'); locals.Add((p[0], p[1], p.Length > 2 ? p[2] : null)); }
        if (sql) { locals.Add(("Rows", "PgItem List", null)); locals.Add(("Total", "Long Integer", null)); }
        else if (v.CountedAfterFetch) locals.Add(("Total", "Long Integer", null));
        foreach (var (variable, type, value) in locals)
        {
            yield return Op($$$"""{"op":"create","parent":"{{{s}}}","type":"ILocalVariable","name":"{{{variable}}}","as":"{{{s}}}{{{variable}}}"}""");
            yield return Op($$$"""{"op":"set","target":"{{{s}}}{{{variable}}}","prop":"DataType","value":"{{{type}}}"}""");
            if (value != null) yield return Op($$$"""{"op":"set","target":"{{{s}}}{{{variable}}}","prop":"DefaultValue","value":"{{{value}}}"}""");
        }
        yield return Op($$$"""{"op":"create","parent":"{{{s}}}","type":"IScreenAggregate","name":"GetItems","as":"{{{s}}}GetItems"}""");
        yield return Op($$$"""{"op":"create","parent":"{{{s}}}GetItems","type":"IAliasedSource","args":{"dataSource":"IServerEntity:PgItem"}}""");
        yield return Op($$$"""{"op":"create","parent":"{{{s}}}GetItems","type":"ISort","as":"{{{s}}}GetItemsSort"}""");
        yield return Op($$$"""{"op":"set","target":"{{{s}}}GetItemsSort","prop":"Attribute","value":"PgItem.Title"}""");
        if (!sql)
        {
            yield return Op($$$"""{"op":"set","target":"{{{s}}}GetItems","prop":"StartIndex","value":"{{{v.Start}}}"}""");
            yield return Op($$$"""{"op":"set","target":"{{{s}}}GetItems","prop":"MaxRecords","value":"MaxRecords"}""");
        }
        var steps = new List<string> { $$$"""{"assign":{{{v.Assign}}},"as":"GoToPage"}""" };
        if (!sql) steps.Add($$$"""{"node":"IRefreshDataNode","as":"RefreshPage","properties":{"DataSource":"IMobileScreen:{{{name}}}/GetItems"}}""");
        else
        {
            steps.Add($$$"""{"call":"{{{v.Callee}}}","as":"LoadPage","args":{"StartIndex":"{{{v.Start}}}","MaxRecords":"MaxRecords"}}""");
            if (v.AppendAll)
            {
                steps.Add("""{"call":"ListAppendAll","as":"AppendPage","args":{"List":"Rows","SourceList":"LoadPage.Rows"}}""");
                steps.Add("""{"assign":{"Total":"LoadPage.Total"},"as":"ShowTotal"}""");
            }
            else steps.Add("""{"assign":{"Rows":"LoadPage.Rows","Total":"LoadPage.Total"},"as":"ShowPage"}""");
        }
        var actions = new List<string> { $$$"""{"name":"PageChanged","kind":"screen","owner":"IMobileScreen:{{{name}}}","description":"Shows the page the pagination asks for.","inputs":[{"name":"NewStartIndex","type":"Integer"}],"steps":[{{{string.Join(",", steps)}}}]}""" };
        if (v.CountedAfterFetch)
            actions.Add($$$"""{"name":"ItemsFetched","kind":"screen","owner":"IMobileScreen:{{{name}}}","description":"Keeps the count of the fetched items.","steps":[{"assign":{"Total":"GetItems.Count"},"as":"KeepCount"}]}""");
        yield return Op($$$"""{"op":"logic","data":{"actions":[{{{string.Join(",", actions)}}}]}}""");
        if (v.CountedAfterFetch)
            yield return Op($$$"""{"op":"set","target":"{{{s}}}GetItems/OnAfterFetch","prop":"Destination","value":"IMobileScreen:{{{name}}}/ItemsFetched"}""");
        var rows = sql ? "Rows" : "GetItems.List";
        var current = rows + ".Current" + (sql ? ".Title" : ".PgItem.Title");
        yield return Op($$$"""{"op":"create","parent":"{{{s}}}/#IMobileBlockInstanceWidget/MainContent","type":"IList","name":"ItemList","as":"{{{s}}}List"}""");
        yield return Op($$$"""{"op":"set","target":"{{{s}}}List","prop":"Source","value":"{{{rows}}}"}""");
        yield return Op($$$"""{"op":"create","parent":"{{{s}}}List","type":"IExpression","as":"{{{s}}}ListText"}""");
        yield return Op($$$"""{"op":"set","target":"{{{s}}}ListText","prop":"Value","value":"{{{current}}}"}""");
        var total = sql || v.CountedAfterFetch ? "Total" : "GetItems.Count";
        yield return Op($$$"""{"op":"create","parent":"{{{s}}}/#IMobileBlockInstanceWidget/MainContent","type":"IMobileBlockInstanceWidget","name":"ItemPagination","source":"IMobileBlock:Pagination","as":"{{{s}}}Pg"}""");
        yield return Op($$$"""{"op":"set","target":"{{{s}}}Pg/StartIndex","prop":"Value","value":"{{{v.Start}}}"}""");
        yield return Op($$$"""{"op":"set","target":"{{{s}}}Pg/MaxRecords","prop":"Value","value":"MaxRecords"}""");
        yield return Op($$$"""{"op":"set","target":"{{{s}}}Pg/TotalCount","prop":"Value","value":"{{{total}}}"}""");
        yield return Op($$$"""{"op":"set","target":"{{{s}}}Pg/OnNavigate","prop":"Handler","value":"IMobileScreen:{{{name}}}/PageChanged"}""");
        yield return Op($$$"""{"op":"set","target":"{{{s}}}Pg/OnNavigate/NewStartIndex","prop":"Value","value":"NewStartIndex"}""");
    }

    /// <summary>The wirings that page correctly, each one screen.</summary>
    public static readonly (string Name, Wiring Wiring)[] Paging =
    [
        ("PgNumber", new Wiring("(CurrentPage - 1) * MaxRecords", ["CurrentPage:Integer:1"], """{"CurrentPage":"NewStartIndex / MaxRecords + 1"}""")),
        ("PgStruct", new Wiring("Filter.StartIndex", ["Filter:PgFilterState"], """{"Filter.StartIndex":"NewStartIndex"}""")),
        ("PgClient", new Wiring("Client.PgStart", null, """{"Client.PgStart":"NewStartIndex"}""")),
        ("PgMore", new Wiring("StartIndex", Source: "sql", AppendAll: true)),
        ("PgGuarded", new Wiring("StartIndex", Source: "sql", Callee: "LoadPgItemsGuarded")),
        ("PgCounted", new Wiring("StartIndex", CountedAfterFetch: true)),
    ];

    private static string Job(string basePath, IEnumerable<JsonObject> ops)
        => new JsonObject { ["base"] = basePath, ["expectValid"] = true, ["ops"] = new JsonArray(ops.Select(o => (JsonNode)o).ToArray()) }.ToJsonString();

    private static JsonNode Run(string dir, string name, string basePath, IEnumerable<JsonObject> ops)
    {
        var path = Path.Combine(dir, name + ".json");
        File.WriteAllText(path, Job(basePath, ops));
        try { return JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, path, Path.Combine(dir, name + ".oml")))!; }
        catch (Exception error)
        {
            File.WriteAllText(Path.Combine(dir, name + ".refusal.txt"), Errors.Text(error) + Environment.NewLine + Errors.FindCoded(error)?.Problems?.ToJsonString());
            throw;
        }
    }

    private static JsonArray Refused(string dir, string name, string basePath, IEnumerable<JsonObject> ops)
    {
        var error = Assert.ThrowsAny<Exception>(() => Run(dir, name, basePath, ops));
        var coded = Errors.FindCoded(error);
        Assert.True(coded?.Problems != null, Errors.Text(error));
        return coded!.Problems!;
    }

    private static JsonArray High(JsonNode result) => result["highWarnings"] as JsonArray ?? new JsonArray();

    private static string Fixture(string fixture)
    {
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(PagingWiringScenarios).Assembly.Location)!)!;
        return Path.IsPathRooted(fixture) ? fixture : File.Exists(Path.Combine(root, fixture)) ? Path.Combine(root, fixture) : Path.Combine(root, "tests", "fixtures", fixture);
    }

    /// <summary>A base as a module made before T3 left it: the ops applied by the verbs alone, inside one command of the Studio,
    /// without the end-of-apply reviews (what an older SSAM or a hand port wrote), saved.</summary>
    public static string LegacyBase(string dir, string fixture, string name, IEnumerable<JsonObject> ops)
    {
        // Under a snapshots folder of the kernel's .local (a capture folder: a job may name it as its base).
        var folder = Path.Combine(dir, "snapshots");
        Directory.CreateDirectory(folder);
        var output = Path.Combine(folder, name + ".oml");
        var host = new ModelHost(Path.Combine(dir, "work-base"));
        var espace = host.Load(File.ReadAllBytes(Fixture(fixture)));
        try
        {
            var session = new ModelSession(espace);
            session.Mutate("legacy base", () => { foreach (var op in ops) session.ApplyOne(op); });
            File.WriteAllBytes(output, host.Save(espace));
        }
        finally { ModelHost.Release(espace); }
        return output;
    }

    private static readonly (string Name, Wiring? Wiring)[] LegacyScreens =
        [("PgNumber", Paging[0].Wiring), ("PgLegacy", new Wiring("StartIndex", Source: "sql", Callee: "LoadPgItemsStart")), ("PgOther", null)];

    private static string Legacy(string dir, string fixture)
        => LegacyBase(dir, fixture, "legacy", Data(legacy: true).Concat(LegacyScreens.SelectMany(x => Screen(x.Name, x.Wiring))));

    // ---- the scenarios ------------------------------------------------------------------------------------------------------

    /// <summary>Every wiring that pages, in one job from zero: accepted, no paging problem, no paging warning.</summary>
    public static void WiringsThatPageAreAccepted(string dir, string fixture)
    {
        Directory.CreateDirectory(dir);
        var result = Run(dir, "t3-wirings", Fixture(fixture), Data(legacy: false).Concat(Paging.SelectMany(x => Screen(x.Name, x.Wiring))));
        Assert.True(result["accepted"]?.GetValue<bool>() ?? false, result.ToJsonString());
        Assert.DoesNotContain(High(result), w => w?["check"]?.ToString() == "paging" || (w?["id"]?.ToString() ?? "").StartsWith("PAGINATION", StringComparison.Ordinal));
    }

    /// <summary>On a base made before T3, edits that do not write the broken paging are accepted, the base's START a HIGH
    /// warning; every one of them was refused by the first T3 cut.</summary>
    public static void EditsThatDoNotWireThePagingAreAccepted(string dir, string fixture)
    {
        var legacy = Legacy(dir, fixture);
        var cases = new (string Name, JsonObject Op, bool StartWarning)[]
        {
            ("delete-other-screen", Op("""{"op":"delete","target":"IMobileScreen:PgOther"}"""), false),
            ("describe-screen", Op("""{"op":"set","target":"IMobileScreen:PgNumber","prop":"Description","value":"Lists the items, a page at a time."}"""), false),
            ("describe-legacy-action", Op("""{"op":"set","target":"IServerAction:LoadPgItemsStart","prop":"Description","value":"One page of items (legacy)."}"""), true),
            ("max-of-legacy-aggregate", Op("""{"op":"set","target":"IServerAction:LoadPgItemsStart/Page","prop":"MaxRecords","value":"If(MaxRecords <= 0, 50, MaxRecords)"}"""), true),
            ("sort-of-legacy-action", SortEdit(dir, legacy), true),
        };
        foreach (var (name, op, startWarning) in cases)
        {
            var result = Run(dir, name, legacy, [op]);
            Assert.True(result["accepted"]?.GetValue<bool>() ?? false, name + ": " + result.ToJsonString());
            if (startWarning) Assert.Contains(High(result), w => (w?["id"]?.ToString() ?? w?["code"]?.ToString()) == PagingRules.StartIgnored);
        }
    }

    /// <summary>On the same base, a job that writes the wiring of the broken screen, or the START again, is refused, naming it.</summary>
    public static void EditsThatWireThePagingAreJudged(string dir, string fixture)
    {
        var legacy = Legacy(dir, fixture);
        var wiring = Refused(dir, "rewire-legacy-screen", legacy, [Op("""{"op":"set","target":"IMobileScreen:PgLegacy/ItemPagination/TotalCount","prop":"Value","value":"Total + 0"}""")]);
        Assert.Contains(wiring.OfType<JsonObject>(), p => p["code"]?.ToString() == PagingRules.SourceUnbound && p["facet"]?.ToString() == "offset" && (p["element"]?.ToString() ?? "").Contains("PgLegacy", StringComparison.Ordinal));
        var start = Refused(dir, "start-again", legacy, [Op("""{"op":"set","target":"IServerAction:LoadPgItemsStart/Page","prop":"StartIndex","value":"Max(0, StartIndex)"}""")]);
        Assert.Contains(start.OfType<JsonObject>(), p => p["code"]?.ToString() == PagingRules.StartIgnored && (p["element"]?.ToString() ?? "").Contains("LoadPgItemsStart", StringComparison.Ordinal));
    }

    /// <summary>The flow text of LoadPgItemsStart as the base reads, with its sort reversed, based on that read.</summary>
    private static JsonObject SortEdit(string dir, string legacy)
    {
        var host = new ModelHost(Path.Combine(dir, "work-read"));
        var espace = host.Load(File.ReadAllBytes(legacy));
        try
        {
            var reader = new KernelModelReader();
            var root = (IObjectSignature)espace;
            var action = reader.ChildrenOf(root).Single(c => reader.NameOf(c) == "LoadPgItemsStart");
            var text = ModuleFlow.Print(ModuleFlow.Extract(root, reader, action, out _)).Text;
            Assert.Contains("SORT PgItem.Title MAX MaxRecords START StartIndex", text);
            var edited = text.Replace("SORT PgItem.Title MAX", "SORT PgItem.Title desc MAX", StringComparison.Ordinal);
            return new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray(edited), ["basedOn"] = ModuleFlow.TextSha(text) } };
        }
        finally { ModelHost.Release(espace); }
    }

    /// <summary>entity-actions over a base whose list action is the earlier generated form (START on a server aggregate) and
    /// whose item structure has a second reference to the same entity: the structure is the generated one (every join kept)
    /// and the list action is kept with the reason and the edit that adopts the generated text; nothing is dropped silently.</summary>
    public static void EntityActionsKeepTheEarlierListWithItsReasonAndEdit(string dir, string fixture)
    {
        var ops = new List<JsonObject>
        {
            Op("""{"op":"spec","data":{"entities":[{"name":"PgTicket","attributes":[{"name":"Title","type":"Text","length":80,"mandatory":true},{"name":"OpenedBy","type":"User Identifier"},{"name":"AssignedTo","type":"User Identifier"}]}],"structures":[{"name":"PgTicketListItem","attributes":[{"name":"PgTicket","type":"PgTicket"},{"name":"User","type":"User"},{"name":"User2","type":"User"}]}]}}"""),
            Op("""{"op":"logic","data":{"actions":[{"name":"GetPgTicketList","kind":"server","description":"Lists tickets a page at a time.","inputs":[{"name":"StartIndex","type":"Integer"},{"name":"MaxRecords","type":"Integer"}],"outputs":[{"name":"List","type":"PgTicketListItem List"},{"name":"TotalCount","type":"Long Integer"}],"steps":[{"get":"PgTicket","as":"ReadPgTicketPage","sort":"PgTicket.Title","max":"MaxRecords","start":"StartIndex"},{"assign":{"TotalCount":"ReadPgTicketPage.Count"},"as":"Return"}]}]}}"""),
        };
        var legacy = LegacyBase(dir, fixture, "legacy-entity-actions", ops);
        var result = Run(dir, "entity-actions-on-legacy", legacy, [Op("""{"op":"entity-actions","data":{"entities":["PgTicket"],"actions":["list"],"expose":{"server":true}}}""")]);
        var entity = FindEntityActions(result);
        Assert.NotNull(entity);
        var list = entity!["kept"]!.AsArray().OfType<JsonObject>().SingleOrDefault(k => k["name"]?.ToString() == "GetPgTicketList");
        Assert.True(list != null, "the earlier list action must be kept and said: " + entity.ToJsonString());
        Assert.Contains("earlier generated form", list!["why"]!.ToString());
        Assert.Contains("LOGIC_START_SERVER_IGNORED", list["why"]!.ToString());
        Assert.NotNull(list["edit"]?["key"]);
        Assert.NotNull(list["edit"]?["basedOn"]);
        Assert.Contains("User2.*", list["generated"]!.ToString());
        Assert.DoesNotContain(entity["kept"]!.AsArray().OfType<JsonObject>(), k => (k["why"]?.ToString() ?? "").Contains("structure", StringComparison.Ordinal));
    }

    private static JsonObject? FindEntityActions(JsonNode? node)
    {
        switch (node)
        {
            case JsonObject o when o["entityActions"] is JsonObject found && found["kept"] is JsonArray: return found;
            case JsonObject o: foreach (var (_, v) in o) if (FindEntityActions(v) is { } f) return f; return null;
            case JsonArray a: foreach (var v in a) if (FindEntityActions(v) is { } f) return f; return null;
            default: return null;
        }
    }

    /// <summary>The review of a job reads its footprint, never the whole module: one written object of a large module.</summary>
    public static void TheReviewReadsTheFootprintOnly(string dir, string fixture)
    {
        var host = new ModelHost(Path.Combine(dir, "work-footprint"));
        var espace = host.Load(File.ReadAllBytes(Fixture(fixture)));
        try
        {
            var module = (IObjectSignature)espace;
            var all = module.GetAllDescendantsOfType<IObjectSignature>().Count();
            var one = module.GetAllDescendantsOfType<IObjectSignature>().First(o => PagingRules.Is(o, "IMobileScreen") || PagingRules.Is(o, "IServerAction"));
            PagingRules.Review(module, [one], _ => false);
            Assert.True(PagingRules.LastReviewRead * 10 < all, $"the review of one written object read {PagingRules.LastReviewRead} of {all} objects");
        }
        finally { ModelHost.Release(espace); }
    }
}
