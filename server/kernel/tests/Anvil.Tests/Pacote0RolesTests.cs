using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Lane 0, C37 and C11. A screen the html page op creates is born for authenticated users (Registered) unless data.roles says
/// otherwise; an existing screen keeps its roles unless data.roles replaces them; the report says the roles and whether the
/// screen is anonymous (K5). The page form's refusals for literal options, blocks with placeholders and repeated regions
/// carry the fragment form that already compiles them. The model proof is on the Service Studio's own model.
/// </summary>
public sealed class Pacote0RolesTests
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(Pacote0RolesTests).Assembly.Location)!)!;

    // ---- the compiler, over a fake module ---------------------------------------------------------------------------

    private static UiParam Param(string name, string type, bool required = false) => new(name, type, required, null, null);
    private static readonly string[] Known = ["IMobileFlow:MainFlow", "IMobileBlock:LayoutTopMenu", "IMobileBlock:LayoutBlank", "IMobileBlock:Card",
        "IServerEntity:Item", "IRole:Manager"];
    private static string? Resolve(string[] references) => references.FirstOrDefault(Known.Contains);
    private static ScreenContract Contract(string reference)
    {
        var name = reference.Split(':')[1];
        string[] placeholders = name switch { "LayoutTopMenu" => ["Title", "MainContent"], "LayoutBlank" => ["Content"], "Card" => ["Body"], _ => [] };
        UiParam[] inputs = name == "Card" ? [Param("Title", "Text", true)] : [];
        UiEvent[] events = name == "Card" ? [new("OnPick", true, null, [])] : [];
        UiParam[] fields = [Param("Id", "Item Identifier"), Param("Name", "Text")];
        return new(reference, inputs, [], fields, events, placeholders.Select(p => new UiPlaceholder(p, null, p, [])).ToArray(),
            new Dictionary<string, IReadOnlyList<UiParam>>(), new Dictionary<string, IReadOnlyList<string>>());
    }
    private static HtmlCompilation Expand(JsonObject data, JsonObject? existing = null) => HtmlExpander.Expand(data, Resolve, Contract, "Reactive", existing);
    private static JsonObject Page(string html = "<div>x</div>", string? roles = null, string? bindings = null, bool source = false)
    {
        var data = JsonNode.Parse("""{"screen":"Orders","title":"Pedidos","html":""}""")!.AsObject();
        data["html"] = html;
        if (roles != null) data["roles"] = JsonNode.Parse(roles);
        if (bindings != null) data["bindings"] = JsonNode.Parse(bindings);
        if (source) data["source"] = JsonNode.Parse("""{"entity":"Item","as":"GetItems"}""");
        return data;
    }
    private static JsonObject? RolesOp(HtmlCompilation compiled) => compiled.Ops.SingleOrDefault(o => o["op"]?.ToString() == "set" && o["prop"]?.ToString() == "Roles");
    private static string[] Strings(JsonNode? array) => array!.AsArray().Select(r => r!.ToString()).ToArray();

    [Fact]
    public void ANewScreenWithoutRolesIsBornForAuthenticatedUsers()
    {
        var compiled = Expand(Page());
        var roles = RolesOp(compiled) ?? throw new Xunit.Sdk.XunitException("no set Roles: " + string.Join("\n", compiled.Ops.Select(o => o.ToJsonString())));
        Assert.Equal("$html.Orders", roles["target"]!.ToString());
        Assert.Equal(new[] { "IRole:Registered" }, Strings(roles["value"]));
        Assert.Equal(new[] { "Registered" }, Strings(compiled.Report["roles"]));
        Assert.False(compiled.Report["anonymous"]!.GetValue<bool>());
        // The roles land after the screen exists and before its content.
        var screen = compiled.Ops.FindIndex(o => o["type"]?.ToString() == "IMobileScreen");
        Assert.True(screen >= 0 && compiled.Ops.IndexOf(roles) > screen);
    }

    [Fact]
    public void AnExplicitAnonymousPageIsKeptAndReported()
    {
        var compiled = Expand(Page(roles: """["Anonymous"]"""));
        Assert.Equal(new[] { "IRole:Anonymous", "IRole:Registered" }, Strings(RolesOp(compiled)!["value"]));
        Assert.Equal(new[] { "Anonymous", "Registered" }, Strings(compiled.Report["roles"]));
        Assert.True(compiled.Report["anonymous"]!.GetValue<bool>());
    }

    [Fact]
    public void AnExistingScreenKeepsItsRolesUnlessDataRolesReplacesThem()
    {
        var existing = JsonNode.Parse("""{"key":"k","variables":{},"roles":["Registered","Manager"]}""")!.AsObject();
        var kept = Expand(Page(), existing);
        Assert.Null(RolesOp(kept));
        Assert.Equal("update", kept.Report["mode"]!.ToString());
        Assert.Equal(new[] { "Registered", "Manager" }, Strings(kept.Report["roles"]));
        Assert.False(kept.Report["anonymous"]!.GetValue<bool>());

        var replaced = Expand(Page(roles: """["Manager"]"""), existing.DeepClone().AsObject());
        var op = RolesOp(replaced)!;
        Assert.Equal("IMobileScreen:Orders", op["target"]!.ToString());
        Assert.Equal(new[] { "IRole:Manager" }, Strings(op["value"]));
        Assert.Equal(new[] { "Manager" }, Strings(replaced.Report["roles"]));
    }

    [Fact]
    public void RolesTheModuleDoesNotHaveAndMalformedRolesAreRefused()
    {
        Assert.Contains("role 'Auditor' is not a role of the module", Assert.Throws<InvalidOperationException>(() => Expand(Page(roles: """["Auditor"]"""))).Message);
        Assert.Contains("roles must be a nonempty array", Assert.Throws<InvalidOperationException>(() => HtmlExpander.Preflight(Page(roles: "\"Registered\""))).Message);
        Assert.Contains("roles must be a nonempty array", Assert.Throws<InvalidOperationException>(() => Expand(Page(roles: "[]"))).Message);
    }

    // ---- C11: the page form's refusals carry the fragment form that compiles ---------------------------------------------

    /// <summary>The fragment op inside a refusal, proved by the fragment compiler's own preflight.</summary>
    private static JsonObject FragmentOf(string refusal)
    {
        var start = refusal.IndexOf("{\"op\":\"html\"", StringComparison.Ordinal);
        Assert.True(start >= 0, "no fragment op in: " + refusal);
        var end = refusal.IndexOf("} (any widget of the screen", start, StringComparison.Ordinal);
        var op = JsonNode.Parse(refusal[start..(end + 1)])!.AsObject();
        Assert.Equal("IMobileScreen:Orders/#IMobileBlockInstanceWidget/MainContent", op["parent"]!.ToString());
        HtmlVisual.Preflight(op["html"]!.ToString(), op["parent"]!.ToString());
        return op;
    }

    [Fact]
    public void LiteralOptionsAndUnboundSelectsPointAtTheFragmentDropdown()
    {
        var unbound = Assert.Throws<InvalidOperationException>(() => Expand(Page("<select><option>A</option><option>B</option></select>"))).Message;
        Assert.Contains("<select bind='Var' options='List' value='List.Current.X.Id' label='List.Current.X.Label'/>", FragmentOf(unbound)["html"]!.ToString());
        var stray = Assert.Throws<InvalidOperationException>(() => Expand(Page("<div><option>A</option></div>"))).Message;
        Assert.Contains("must not contain literal options", stray);
        Assert.StartsWith("<select bind=", FragmentOf(stray)["html"]!.ToString());
    }

    [Fact]
    public void ABlockWithPlaceholdersOrRequiredEventsPointsAtTheFragmentBlock()
    {
        var refusal = Assert.Throws<InvalidOperationException>(() => Expand(Page("""<div data-av="card"></div>""", bindings: """{"card":{"kind":"block","block":"Card"}}"""))).Message;
        Assert.Contains("Card has placeholders Body and required events OnPick", refusal);
        Assert.Equal("<Block name='Card' :Title='expr' @OnPick='ScreenAction'><slot name='Body'>...</slot></Block>", FragmentOf(refusal)["html"]!.ToString());
    }

    [Fact]
    public void RepeatedRegionsThePageFormRefusesPointAtTheFragmentList()
    {
        var refusal = Assert.Throws<InvalidOperationException>(() => Expand(Page("""<ul data-av="l"><li data-av="f">a</li><li>b</li></ul>""",
            bindings: """{"l":{"kind":"list"},"f":{"kind":"field","field":"Name"}}""", source: true))).Message;
        Assert.Contains("exactly one child element", refusal);
        Assert.Contains("list='Row.X.Items' as='Item'", FragmentOf(refusal)["html"]!.ToString());
    }

    // ---- the model: Service Studio's own roles collection ------------------------------------------------------------

    [Fact]
    public void TheModelKeepsTheRolesTheReportSays()
    {
        if (!StudioAvailable()) return;
        var work = Path.Combine(Path.GetTempPath(), "pacote0-roles", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        string HtmlOp(string screen, string? roles)
        {
            var data = new JsonObject { ["screen"] = screen, ["layout"] = "blank", ["html"] = "<div class=\"p\"><h1>" + screen + "</h1></div>" };
            if (roles != null) data["roles"] = JsonNode.Parse(roles);
            return new JsonObject { ["op"] = "html", ["data"] = data }.ToJsonString();
        }
        JsonObject Run(string name, string? basePath, params string[] ops)
        {
            var job = Path.Combine(work, name + ".json");
            File.WriteAllText(job, "{\"expectValid\":true,\"ops\":[" + string.Join(",", ops) + "]}");
            return JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath ?? Path.Combine(Root, "tests", "fixtures", "reactive-ui.oml"), job, Path.Combine(work, name + ".oml")))!.AsObject();
        }
        JsonObject Report(JsonObject result, int i) => result["results"]!.AsArray()[i]!["result"]!.AsObject();

        var created = Run("create", null, HtmlOp("Pacote0Closed", null), HtmlOp("Pacote0Open", """["Anonymous"]"""));
        Assert.True(created["accepted"]!.GetValue<bool>(), created["details"]?.ToJsonString());
        Assert.Equal(new[] { "Registered" }, Strings(Report(created, 0)["roles"]));
        Assert.True(Report(created, 1)["anonymous"]!.GetValue<bool>());

        // Updates without data.roles read the roles from the model (identity preserved); with data.roles they are replaced.
        var updated = Run("update", Path.Combine(work, "create.oml"),
            HtmlOp("Pacote0Closed", null), HtmlOp("Pacote0Open", null), HtmlOp("Pacote0Open", """["Registered"]"""), HtmlOp("Pacote0Open", null));
        Assert.True(updated["accepted"]!.GetValue<bool>(), updated["details"]?.ToJsonString());
        Assert.Equal(new[] { "Registered" }, Strings(Report(updated, 0)["roles"]));
        Assert.False(Report(updated, 0)["anonymous"]!.GetValue<bool>());
        Assert.Equal(new[] { "Anonymous", "Registered" }, Strings(Report(updated, 1)["roles"]).Order().ToArray());
        Assert.True(Report(updated, 1)["anonymous"]!.GetValue<bool>());
        Assert.Equal("update", Report(updated, 3)["mode"]!.ToString());
        Assert.Equal(new[] { "Registered" }, Strings(Report(updated, 3)["roles"]));
        Assert.False(Report(updated, 3)["anonymous"]!.GetValue<bool>());
    }

    private static bool StudioAvailable() { try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; } }
}
