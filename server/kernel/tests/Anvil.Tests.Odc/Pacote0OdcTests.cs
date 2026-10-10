using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// Lane 0, C37 in the ODC lane. ODC has no Registered or Anonymous role (IRole:Registered does not resolve in an ODC app):
/// a screen opens to everyone through AnonymousAccess and its Roles collection holds app roles (a new screen gets the app's
/// own role, measured on the InsuranceApp fixture). So the shared page compiler gives a new screen AnonymousAccess off
/// (authenticated users), turns it on only for data.roles ["Anonymous"], replaces the app roles only when data.roles names
/// them, and the report reads the access back from the ODC Studio's model.
/// </summary>
public class Pacote0OdcTests
{
    private static readonly string Root = FindRoot();
    private static readonly string Fixture = Path.Combine(Root, "tests", "fixtures", "odc", "insurance-reactive-r8.oml");

    // ---- the compiler in the ODC assembly ------------------------------------------------------------------------------

    private static readonly string[] Known = ["IMobileFlow:MainFlow", "IMobileBlock:LayoutBlank", "IRole:Underwriter"];
    private static ScreenContract Contract(string reference) => new(reference, [], [], [], [],
        reference.EndsWith("LayoutBlank", StringComparison.Ordinal) ? [new UiPlaceholder("Content", null, "Content", [])] : [],
        new Dictionary<string, IReadOnlyList<UiParam>>(), new Dictionary<string, IReadOnlyList<string>>());
    private static HtmlCompilation Expand(string? roles, JsonObject? existing = null)
    {
        var data = new JsonObject { ["screen"] = "Orders", ["layout"] = "blank", ["html"] = "<div>x</div>" };
        if (roles != null) data["roles"] = JsonNode.Parse(roles);
        return HtmlExpander.Expand(data, names => names.FirstOrDefault(Known.Contains), Contract, "Reactive", existing);
    }
    private static JsonObject? SetOf(HtmlCompilation compiled, string prop) => compiled.Ops.SingleOrDefault(o => o["op"]?.ToString() == "set" && o["prop"]?.ToString() == prop);

    [Fact]
    public void ANewOdcScreenIsForAuthenticatedUsersThroughAnonymousAccessNotARole()
    {
        var compiled = Expand(null);
        Assert.False(SetOf(compiled, "AnonymousAccess")!["value"]!.GetValue<bool>());
        Assert.Null(SetOf(compiled, "Roles"));   // the app role the model gives a new screen stays
        Assert.Equal(new[] { "Registered" }, compiled.Report["roles"]!.AsArray().Select(r => r!.ToString()).ToArray());
        Assert.False(compiled.Report["anonymous"]!.GetValue<bool>());

        var open = Expand("""["Anonymous"]""");
        Assert.True(SetOf(open, "AnonymousAccess")!["value"]!.GetValue<bool>());
        Assert.True(open.Report["anonymous"]!.GetValue<bool>());

        var named = Expand("""["Underwriter"]""");
        Assert.False(SetOf(named, "AnonymousAccess")!["value"]!.GetValue<bool>());
        Assert.Equal(new[] { "IRole:Underwriter" }, SetOf(named, "Roles")!["value"]!.AsArray().Select(r => r!.ToString()).ToArray());

        var existing = JsonNode.Parse("""{"key":"k","variables":{},"roles":["InsuranceApp"],"anonymous":true}""")!.AsObject();
        var kept = Expand(null, existing);
        Assert.Null(SetOf(kept, "AnonymousAccess")); Assert.Null(SetOf(kept, "Roles"));
        Assert.True(kept.Report["anonymous"]!.GetValue<bool>());
        Assert.Equal(new[] { "Anonymous", "Registered", "InsuranceApp" }, kept.Report["roles"]!.AsArray().Select(r => r!.ToString()).ToArray());
    }

    // ---- the ODC Studio's own model -------------------------------------------------------------------------------------

    [Fact]
    public void TheOdcModelKeepsTheAccessTheReportSays()
    {
        if (!StudioAvailable()) return;
        var work = Path.Combine(Path.GetTempPath(), "pacote0-odc-roles", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        string HtmlOp(string screen, string? roles)
        {
            var data = new JsonObject { ["screen"] = screen, ["layout"] = "blank", ["html"] = "<div class=\"p\"><h1>" + screen + "</h1></div>" };
            if (roles != null) data["roles"] = JsonNode.Parse(roles);
            return new JsonObject { ["op"] = "html", ["data"] = data }.ToJsonString();
        }
        JsonObject Run(string name, string basePath, params string[] ops)
        {
            var job = Path.Combine(work, name + ".json");
            File.WriteAllText(job, "{\"expectValid\":true,\"ops\":[" + string.Join(",", ops) + "]}");
            return JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, job, Path.Combine(work, name + ".oml")))!.AsObject();
        }
        JsonObject Report(JsonObject result, int i) => result["results"]!.AsArray()[i]!["result"]!.AsObject();
        string[] Roles(JsonObject report) => report["roles"]!.AsArray().Select(r => r!.ToString()).ToArray();

        var created = Run("create", Fixture, HtmlOp("Pacote0Closed", null), HtmlOp("Pacote0Open", """["Anonymous"]"""));
        Assert.True(created["accepted"]!.GetValue<bool>(), created["details"]?.ToJsonString());
        Assert.False(Report(created, 0)["anonymous"]!.GetValue<bool>());
        Assert.True(Report(created, 1)["anonymous"]!.GetValue<bool>());

        // Updates without data.roles read the access from the model; with data.roles naming an app role it is replaced.
        var updated = Run("update", Path.Combine(work, "create.oml"),
            HtmlOp("Pacote0Closed", null), HtmlOp("Pacote0Open", null), HtmlOp("Pacote0Open", """["WFCSAdministrator"]"""), HtmlOp("Pacote0Open", null));
        Assert.True(updated["accepted"]!.GetValue<bool>(), updated["details"]?.ToJsonString());
        Assert.Equal("update", Report(updated, 0)["mode"]!.ToString());
        Assert.False(Report(updated, 0)["anonymous"]!.GetValue<bool>());
        Assert.Contains("Registered", Roles(Report(updated, 0)));
        Assert.True(Report(updated, 1)["anonymous"]!.GetValue<bool>());
        Assert.Contains("Anonymous", Roles(Report(updated, 1)));
        Assert.False(Report(updated, 3)["anonymous"]!.GetValue<bool>());
        Assert.Equal(new[] { "Registered", "WFCSAdministrator" }, Roles(Report(updated, 3)));
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(Pacote0OdcTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
