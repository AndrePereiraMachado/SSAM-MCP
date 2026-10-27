using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Preflight;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Linked into both test projects: T3, paging that does not page (Preflight/PagingRules.cs), decided on the candidate model by
/// ModelSession.Apply, the same on O11 and ODC. Every case is built from zero on the lane's fixture through JobRunner (spec,
/// raw ops, logic), so the native model decides what each element is:
/// <list type="bullet">
/// <item>the battery: one screen paged by a screen aggregate and one paged by a server action whose SQL has OFFSET, applied,
/// Verified and saved without a problem (the T3 battery result);</item>
/// <item>the sweep: every paging pattern of the OutSystems UI catalog of the lane (a block with an input StartIndex and an event
/// with NewStartIndex) crossed with every list widget (List, Table), every source (screen aggregate, server action SQL) and every
/// wiring of the verdict table, one screen per case, in ONE job: the refusal carries every problem of every broken screen at
/// once, each with the facet the table expects, and no problem for a correct screen.</item>
/// </list>
/// </summary>
public static class PagingRulesScenarios
{
    /// <summary>A wiring of the verdict table: what is broken, and the finding it must give (null: none).</summary>
    public sealed record Wiring(string Name, string? Code, string? Facet, string Source = "both");

    public static readonly Wiring[] Table =
    [
        new("ok", null, null),
        new("start-constant", PagingRules.SourceUnbound, "start"),
        new("max-without-start", PagingRules.SourceUnbound, "offset", "aggregate"),
        new("max-differs", PagingRules.SourceUnbound, "maxRecords"),
        new("count-other-source", PagingRules.SourceUnbound, "totalCount"),
        new("no-handler", PagingRules.SourceUnbound, "handler"),
        new("no-assign", PagingRules.SourceUnbound, "assign"),
        new("no-refresh", PagingRules.SourceUnbound, "refresh", "aggregate"),
        new("no-call", PagingRules.SourceUnbound, "offset", "sql"),
        new("list-other-source", PagingRules.SourceUnbound, "list"),
        new("sql-without-offset", PagingRules.SourceUnbound, "offset", "sql"),
        new("server-aggregate-start", PagingRules.SourceUnbound, "offset", "sql"),
    ];

    public static readonly string[] Lists = ["IList", "ITableRecords"];
    public static readonly string[] Sources = ["aggregate", "sql"];

    /// <summary>The paging patterns of the lane's OutSystems UI catalog: every block with an input StartIndex and an event with
    /// the parameter NewStartIndex (derived from the catalog, never listed by hand).</summary>
    public static List<string> CatalogPagers(string lane)
    {
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(PagingRulesScenarios).Assembly.Location)!)!;
        var catalog = JsonNode.Parse(File.ReadAllText(Path.Combine(root, "..", "platforms", "odc", "facade", "outsystems-ui", "catalog.json")))!;
        // The libraries of the lane's Reactive and Mobile app types (appTypes.<type>.library).
        var libraries = catalog["appTypes"]!.AsObject().Where(t => t.Value?["lane"]?.ToString() == lane && (t.Key.EndsWith("-reactive", StringComparison.Ordinal) || t.Key.EndsWith("-mobile", StringComparison.Ordinal)))
            .Select(t => t.Value!["library"]!.ToString()).ToHashSet(StringComparer.Ordinal);
        return catalog["libraries"]!.AsArray().OfType<JsonObject>()
            .Where(l => libraries.Contains(l["id"]?.ToString() ?? ""))
            .SelectMany(l => l["patterns"]!.AsArray().OfType<JsonObject>())
            .Where(p => p["inputs"] is JsonArray inputs && inputs.Any(i => i?["name"]?.ToString() == "StartIndex")
                && p["events"] is JsonArray events && events.Any(e => e?["params"] is JsonArray ps && ps.Any(x => x!.ToString().StartsWith("NewStartIndex", StringComparison.Ordinal))))
            .Select(p => p["name"]!.ToString()).Distinct().Order(StringComparer.Ordinal).ToList();
    }

    // ---- the job ------------------------------------------------------------------------------------------------------------

    private static JsonObject Op(string json) => JsonNode.Parse(json)!.AsObject();

    /// <summary>The data and the server actions every screen of a job shares: PgItem, and three server actions that page by an
    /// SQL with OFFSET, by an SQL without it, and by an aggregate with START (which the runtime ignores).</summary>
    private static IEnumerable<JsonObject> Shared(bool withBroken)
    {
        yield return Op("""{"op":"spec","data":{"entities":[{"name":"PgItem","attributes":[{"name":"Title","type":"Text","length":50,"mandatory":true}]}]}}""");
        string Action(string name, string page) => $$$"""
            {"name":"{{{name}}}","kind":"server","description":"One page of items and their count.",
             "inputs":[{"name":"StartIndex","type":"Integer"},{"name":"MaxRecords","type":"Integer"}],
             "outputs":[{"name":"Rows","type":"PgItem List"},{"name":"Total","type":"Long Integer"}],
             "steps":[{{{page}}},
               {"get":"PgItem","as":"CountItems","max":"1"},
               {"assign":{"Rows":"Page.List","Total":"CountItems.Count"},"as":"Return"}]}
            """;
        const string offset = """{"get":"PgItem","as":"Page","sql":true,"statement":"SELECT {PgItem}.* FROM {PgItem} ORDER BY {PgItem}.[Title] OFFSET @Skip ROWS FETCH NEXT @Take ROWS ONLY","params":{"Skip":{"type":"Integer","value":"StartIndex"},"Take":{"type":"Integer","value":"MaxRecords"}}}""";
        const string noOffset = """{"get":"PgItem","as":"Page","sql":true,"statement":"SELECT {PgItem}.* FROM {PgItem} WHERE @Skip >= 0 AND @Take > 0 ORDER BY {PgItem}.[Title]","params":{"Skip":{"type":"Integer","value":"StartIndex"},"Take":{"type":"Integer","value":"MaxRecords"}}}""";
        const string start = """{"get":"PgItem","as":"Page","sort":"PgItem.Title","max":"MaxRecords","start":"StartIndex"}""";
        var actions = new List<string> { Action("LoadPgItems", offset) };
        if (withBroken) { actions.Add(Action("LoadPgItemsNoOffset", noOffset)); actions.Add(Action("LoadPgItemsStart", start)); }
        yield return Op($$$"""{"op":"logic","data":{"actions":[{{{string.Join(",", actions)}}}]}}""");
    }

    /// <summary>The ops of one paged screen: its variables, its source, its handler, its list and the paging block, wired as
    /// <paramref name="w"/> says.</summary>
    public static IEnumerable<JsonObject> Screen(string name, string pager, string list, string source, Wiring w)
    {
        var s = "$" + name;
        var sql = source == "sql";
        yield return Op($$$"""{"op":"create","parent":"IMobileFlow:MainFlow","type":"IMobileScreen","name":"{{{name}}}","as":"{{{s}}}"}""");
        yield return Op($$$"""{"op":"set","target":"{{{s}}}/#IMobileBlockInstanceWidget","prop":"SourceBlock","value":"IMobileBlock:LayoutTopMenu"}""");
        foreach (var (variable, type, value) in new[] { ("StartIndex", "Integer", "0"), ("MaxRecords", "Integer", "10") })
        {
            yield return Op($$$"""{"op":"create","parent":"{{{s}}}","type":"ILocalVariable","name":"{{{variable}}}","as":"{{{s}}}{{{variable}}}"}""");
            yield return Op($$$"""{"op":"set","target":"{{{s}}}{{{variable}}}","prop":"DataType","value":"{{{type}}}"}""");
            yield return Op($$$"""{"op":"set","target":"{{{s}}}{{{variable}}}","prop":"DefaultValue","value":"{{{value}}}"}""");
        }
        if (sql)
            foreach (var (variable, type) in new[] { ("Rows", "PgItem List"), ("Total", "Long Integer") })
            {
                yield return Op($$$"""{"op":"create","parent":"{{{s}}}","type":"ILocalVariable","name":"{{{variable}}}","as":"{{{s}}}{{{variable}}}"}""");
                yield return Op($$$"""{"op":"set","target":"{{{s}}}{{{variable}}}","prop":"DataType","value":"{{{type}}}"}""");
            }
        // The paged screen aggregate (the aggregate source) and another one (the "other source" of the broken wirings).
        foreach (var aggregate in new[] { "GetItems", "GetOther" })
        {
            yield return Op($$$"""{"op":"create","parent":"{{{s}}}","type":"IScreenAggregate","name":"{{{aggregate}}}","as":"{{{s}}}{{{aggregate}}}"}""");
            yield return Op($$$"""{"op":"create","parent":"{{{s}}}{{{aggregate}}}","type":"IAliasedSource","args":{"dataSource":"IServerEntity:PgItem"}}""");
            yield return Op($$$"""{"op":"create","parent":"{{{s}}}{{{aggregate}}}","type":"ISort","as":"{{{s}}}{{{aggregate}}}Sort"}""");
            yield return Op($$$"""{"op":"set","target":"{{{s}}}{{{aggregate}}}Sort","prop":"Attribute","value":"PgItem.Title"}""");
        }
        if (!sql)
        {
            if (w.Name != "max-without-start") yield return Op($$$"""{"op":"set","target":"{{{s}}}GetItems","prop":"StartIndex","value":"StartIndex"}""");
            yield return Op($$$"""{"op":"set","target":"{{{s}}}GetItems","prop":"MaxRecords","value":"{{{(w.Name == "max-differs" ? "25" : "MaxRecords")}}}"}""");
        }
        // The handler of OnNavigate.
        var steps = new List<string>();
        if (w.Name != "no-assign") steps.Add("""{"assign":{"StartIndex":"NewStartIndex"},"as":"GoToPage"}""");
        if (!sql && w.Name != "no-refresh") steps.Add($$$"""{"node":"IRefreshDataNode","as":"RefreshPage","properties":{"DataSource":"IMobileScreen:{{{name}}}/GetItems"}}""");
        if (sql && w.Name != "no-call")
        {
            var callee = w.Name switch { "sql-without-offset" => "LoadPgItemsNoOffset", "server-aggregate-start" => "LoadPgItemsStart", _ => "LoadPgItems" };
            steps.Add($$$"""{"call":"{{{callee}}}","as":"LoadPage","args":{"StartIndex":"StartIndex","MaxRecords":"{{{(w.Name == "max-differs" ? "25" : "MaxRecords")}}}"}}""");
            steps.Add("""{"assign":{"Rows":"LoadPage.Rows","Total":"LoadPage.Total"},"as":"ShowPage"}""");
        }
        if (steps.Count == 0) steps.Add("""{"assign":{"MaxRecords":"MaxRecords"},"as":"Nothing"}""");
        yield return Op($$$"""{"op":"logic","data":{"actions":[{"name":"PageChanged","kind":"screen","owner":"IMobileScreen:{{{name}}}","description":"Shows the page the pagination asks for.","inputs":[{"name":"NewStartIndex","type":"Integer"}],"steps":[{{{string.Join(",", steps)}}}]}]}}""");
        // The list.
        var rows = w.Name == "list-other-source" ? "GetOther.List" : sql ? "Rows" : "GetItems.List";
        var current = rows + ".Current" + (sql && w.Name != "list-other-source" ? ".Title" : ".PgItem.Title");
        if (list == "IList")
        {
            yield return Op($$$"""{"op":"create","parent":"{{{s}}}/#IMobileBlockInstanceWidget/MainContent","type":"IList","name":"ItemList","as":"{{{s}}}List"}""");
            yield return Op($$$"""{"op":"set","target":"{{{s}}}List","prop":"Source","value":"{{{rows}}}"}""");
            yield return Op($$$"""{"op":"create","parent":"{{{s}}}List","type":"IExpression","as":"{{{s}}}ListText"}""");
            yield return Op($$$"""{"op":"set","target":"{{{s}}}ListText","prop":"Value","value":"{{{current}}}"}""");
        }
        else
        {
            yield return Op($$$"""{"op":"create","parent":"{{{s}}}/#IMobileBlockInstanceWidget/MainContent","type":"ITableRecords","name":"ItemTable","as":"{{{s}}}List","empty":true}""");
            yield return Op($$$"""{"op":"set","target":"{{{s}}}List","prop":"Source","value":"{{{rows}}}"}""");
            yield return Op($$$"""{"op":"create","parent":"{{{s}}}List/HeaderRow","type":"IHeaderCell","name":"TitleHeader","as":"{{{s}}}H"}""");
            yield return Op($$$"""{"op":"create","parent":"{{{s}}}H","type":"IExpression","as":"{{{s}}}HText"}""");
            yield return Op($$$"""{"op":"set","target":"{{{s}}}HText","prop":"Value","value":"\"Title\""}""");
            yield return Op($$$"""{"op":"create","parent":"{{{s}}}List/Row","type":"IRowCell","name":"TitleCell","as":"{{{s}}}C"}""");
            yield return Op($$$"""{"op":"create","parent":"{{{s}}}C","type":"IExpression","as":"{{{s}}}CText"}""");
            yield return Op($$$"""{"op":"set","target":"{{{s}}}CText","prop":"Value","value":"{{{current}}}"}""");
        }
        // The paging block.
        var total = w.Name == "count-other-source" ? "GetOther.Count" : sql ? "Total" : "GetItems.Count";
        yield return Op($$$"""{"op":"create","parent":"{{{s}}}/#IMobileBlockInstanceWidget/MainContent","type":"IMobileBlockInstanceWidget","name":"ItemPagination","source":"IMobileBlock:{{{pager}}}","as":"{{{s}}}Pg"}""");
        yield return Op($$$"""{"op":"set","target":"{{{s}}}Pg/StartIndex","prop":"Value","value":"{{{(w.Name == "start-constant" ? "0" : "StartIndex")}}}"}""");
        yield return Op($$$"""{"op":"set","target":"{{{s}}}Pg/MaxRecords","prop":"Value","value":"MaxRecords"}""");
        yield return Op($$$"""{"op":"set","target":"{{{s}}}Pg/TotalCount","prop":"Value","value":"{{{total}}}"}""");
        if (w.Name != "no-handler")
        {
            yield return Op($$$"""{"op":"set","target":"{{{s}}}Pg/OnNavigate","prop":"Handler","value":"IMobileScreen:{{{name}}}/PageChanged"}""");
            yield return Op($$$"""{"op":"set","target":"{{{s}}}Pg/OnNavigate/NewStartIndex","prop":"Value","value":"NewStartIndex"}""");
        }
    }

    private static string Job(string fixture, IEnumerable<JsonObject> ops, bool expectValid = true)
        => new JsonObject { ["base"] = fixture, ["expectValid"] = expectValid, ["ops"] = new JsonArray(ops.Select(o => (JsonNode)o).ToArray()) }.ToJsonString();

    private static JsonNode Run(string dir, string name, string job)
    {
        var path = Path.Combine(dir, name + ".json");
        File.WriteAllText(path, job);
        return JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, path, Path.Combine(dir, name + ".oml")))!;
    }

    // ---- the scenarios ------------------------------------------------------------------------------------------------------

    /// <summary>The T3 battery: a small paged screen from zero (screen aggregate) and one paged by a server action SQL with
    /// OFFSET, on the lane's fixture: applied, Verified, saved; the rule finds nothing in the saved module either.</summary>
    public static JsonObject BatteryBuildsPagedScreensFromZero(string dir, string fixture, string lane)
    {
        Directory.CreateDirectory(dir);
        var pager = CatalogPagers(lane).First();
        var ops = Shared(withBroken: false).Concat(Screen("PgAggregate", pager, "IList", "aggregate", Table[0])).Concat(Screen("PgServer", pager, "ITableRecords", "sql", Table[0]));
        var result = Run(dir, "t3-battery", Job(fixture, ops));
        Assert.True(result["accepted"]?.GetValue<bool>() ?? false, result.ToJsonString());
        var saved = Path.Combine(dir, "t3-battery.oml");
        var findings = Findings(dir, saved);
        Assert.Empty(findings);
        var evidence = new JsonObject
        {
            ["family"] = "T3", ["lane"] = lane, ["fixture"] = Path.GetFileName(fixture), ["pager"] = pager, ["accepted"] = true,
            ["verify"] = result["validation"]?.DeepClone(), ["screens"] = new JsonArray("PgAggregate (screen aggregate, List)", "PgServer (server action SQL OFFSET, Table)"),
            ["findings"] = findings.Count, ["remoteRuntime"] = false,
        };
        File.WriteAllText(Path.Combine(dir, "t3-battery.evidence.json"), evidence.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        return evidence;
    }

    /// <summary>The rule over a saved module, as the CLI would run it (every finding the module's).</summary>
    public static List<PagingRules.Finding> Findings(string dir, string oml)
    {
        var host = new ModelHost(Path.Combine(dir, "work"));
        var espace = host.Load(File.ReadAllBytes(oml));
        try { return PagingRules.Run((OutSystems.Model.IObjectSignature)espace); }
        finally { ModelHost.Release(espace); }
    }

    /// <summary>The sweep: pagers of the catalog x lists x sources x the verdict table, one screen per case, one job. The
    /// refusal names every broken screen with the facet the table expects, at once; a correct screen has no problem.</summary>
    public static JsonObject SweepRefusesEveryBrokenWiringAtOnce(string dir, string fixture, string lane)
    {
        Directory.CreateDirectory(dir);
        var pagers = CatalogPagers(lane);
        Assert.NotEmpty(pagers);
        var cases = new List<(string Screen, Wiring Wiring)>();
        var ops = new List<JsonObject>(Shared(withBroken: true));
        var n = 0;
        foreach (var pager in pagers)
            foreach (var list in Lists)
                foreach (var source in Sources)
                    foreach (var w in Table.Where(t => t.Source == "both" || t.Source == source))
                    {
                        var screen = $"Pg{++n:00}";
                        cases.Add((screen, w));
                        ops.AddRange(Screen(screen, pager, list, source, w));
                    }
        var error = Assert.ThrowsAny<Exception>(() => Run(dir, "t3-sweep", Job(fixture, ops, expectValid: true)));
        var coded = Errors.FindCoded(error);
        Assert.True(coded?.Problems != null, Errors.Text(error));
        File.WriteAllText(Path.Combine(dir, "t3-sweep.all-problems.json"), coded!.Problems!.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        var problems = coded!.Problems!.OfType<JsonObject>().Where(p => p["check"]?.ToString() == "paging").ToList();
        File.WriteAllText(Path.Combine(dir, "t3-sweep.refusal.json"), new JsonArray(problems.Select(p => (JsonNode)p.DeepClone()).ToArray()).ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        var table = new JsonArray();
        foreach (var (screen, w) in cases)
        {
            var mine = problems.Where(p => (p["message"]?.ToString() ?? "").Contains("screen " + screen + ":", StringComparison.Ordinal)
                || (p["element"]?.ToString() ?? "").Split('/').Contains(screen)).ToList();
            var facets = mine.Where(p => p["code"]?.ToString() == PagingRules.SourceUnbound).Select(p => p["facet"]?.ToString()).ToList();
            table.Add(new JsonObject { ["screen"] = screen, ["wiring"] = w.Name, ["expected"] = w.Facet, ["found"] = new JsonArray(facets.Select(f => (JsonNode?)f).ToArray()) });
            if (w.Facet == null) Assert.True(facets.Count == 0, $"{screen} ({w.Name}) is correct but got {string.Join(", ", facets)}");
            else Assert.True(facets.Contains(w.Facet), $"{screen} ({w.Name}) expected facet {w.Facet}, found [{string.Join(", ", facets)}]");
            foreach (var p in mine)
            {
                Assert.False(string.IsNullOrWhiteSpace(p["fix"]?.ToString()), "every problem has its fix: " + p.ToJsonString());
                Assert.False(string.IsNullOrWhiteSpace(p["element"]?.ToString()), "every problem names its element: " + p.ToJsonString());
            }
        }
        // The aggregate START in a server action is refused on its own, once, naming the aggregate.
        Assert.Contains(problems, p => p["code"]?.ToString() == PagingRules.StartIgnored && (p["element"]?.ToString() ?? "").Contains("LoadPgItemsStart", StringComparison.Ordinal));
        File.WriteAllText(Path.Combine(dir, "t3-sweep.table.json"), table.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        return new JsonObject { ["cases"] = cases.Count, ["pagers"] = new JsonArray(pagers.Select(p => (JsonNode)p).ToArray()), ["problems"] = problems.Count };
    }
}
