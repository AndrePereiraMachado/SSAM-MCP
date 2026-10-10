using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// Atritos 3, lane kl, in the ODC kernel (the lane of Davi's labs): C01 (the Verify ids found from the running kernel with the
/// job and the current directory outside any repository), C08 (set AnonymousAccess true declares the family of its screen),
/// C17 (Refresh Data of a Data Action without Max. Records; a FontAwesome name written as the conversion table of the Studio
/// says; a reference to the system entity User gets Delete Rule Ignore) and C27 (Style on a placeholder is StyleClasses).
/// </summary>
public sealed class Pa3KlOdcTests
{
    private static readonly string Root = FindRoot();
    private const string Fixture = "tests/fixtures/odc/wrightflood-personal-r8.oml";

    private static (JsonNode? Result, Exception? Error) Run(string name, string job)
    {
        var dir = Path.Combine(Root, ".local", "pa3-kl-odc-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, name + ".json");
        File.WriteAllText(path, job);
        try { return (JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, path, Path.Combine(dir, name + ".oml"))), null); }
        catch (Exception ex) { return (null, ex); }
    }

    private static string Screen(string name) => $$"""
        {"op":"create","parent":"IMobileFlow:MainFlow","type":"IMobileScreen","name":"{{name}}","as":"$scr"},
        {"op":"set","target":"$scr/#IMobileBlockInstanceWidget","prop":"SourceBlock","value":"IMobileBlock:LayoutTopMenu"}
        """;

    [Fact]
    public void ExpectedMessagesResolveWithCwdAndJobOutsideTheRepository()
    {
        Assert.Equal("odc", MessageExpectations.Lane);
        var dir = Path.Combine(Path.GetTempPath(), "pa3kl-odc-outside", Guid.NewGuid().ToString("N"), "odc", ".local", "jobs", "inline");
        Directory.CreateDirectory(dir);
        var job = Path.Combine(dir, "lab26.json");
        File.WriteAllText(job, """{"ops":[],"expectedMessages":[{"id":"ServerActionInScreenAccessibleByEveryone","all":true,"why":"lab 26: the screens are public on purpose"}]}""");
        var bad = Path.Combine(dir, "bad.json");
        File.WriteAllText(bad, """{"ops":[],"expectedMessages":[{"id":"LdapFilterInjection","element":"X","why":"an O11-only id"}]}""");
        var cwd = Directory.GetCurrentDirectory();
        try
        {
            Directory.SetCurrentDirectory(Path.GetDirectoryName(Path.GetDirectoryName(Path.GetDirectoryName(dir)))!);
            JobRunner.ValidateJob(job);
            Assert.Equal("ServerActionInScreenAccessibleByEveryone", Assert.Single(MessageExpectations.Read(JsonNode.Parse(File.ReadAllText(job))!, job)).Id);
            var check = JobPreflight.Check(bad);
            Assert.Contains(check["problems"]!.AsArray(), p => p!["code"]!.GetValue<string>() == "EXPECTED_MESSAGES_INVALID" && p["pointer"]!.GetValue<string>() == "/expectedMessages/0/id");
        }
        finally { Directory.SetCurrentDirectory(cwd); }
    }

    [Fact]
    public void SetAnonymousAccessTrueDeclaresTheFamilyOfItsScreen()
    {
        if (!StudioAvailable()) return;
        var (result, error) = Run("anonymous", "{\"base\":\"" + Fixture + "\",\"ops\":[" + Screen("Pa3Produtos") + """
            ,{"op":"logic","data":{"actions":[
               {"name":"Pa3ListProducts","outputs":[{"name":"N","type":"Integer"}],"steps":[{"assign":{"N":"1"}}]},
               {"name":"Pa3Load","kind":"screen","owner":"IMobileScreen:Pa3Produtos","steps":[{"call":"Pa3ListProducts","as":"List"}]}]}}
            ,{"op":"create","parent":"$scr/#IMobileBlockInstanceWidget/MainContent","type":"IButton","name":"BtnLoad","as":"$btn"}
            ,{"op":"set","target":"$btn/OnClick","prop":"Destination","value":"IMobileScreen:Pa3Produtos/Pa3Load"}
            ,{"op":"set","target":"IMobileScreen:Pa3Produtos","prop":"AnonymousAccess","value":true}]}
            """);
        Assert.True(error == null, error?.ToString());
        var verdicts = result!["validation"]!["verdicts"]!.AsArray().OfType<JsonObject>().Where(v => v["id"]!.GetValue<string>() == "ServerActionInScreenAccessibleByEveryone").ToArray();
        Assert.NotEmpty(verdicts);
        Assert.All(verdicts, v => Assert.Equal("anonymous-declared-by-job", v["reason"]!.GetValue<string>()));
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]!.ToJsonString());
        var exposure = Assert.Single(result["anonymousExposure"]!.AsArray())!;
        Assert.Equal("Pa3Produtos", exposure["screen"]!.GetValue<string>());
    }

    [Fact]
    public void TheRefreshOfADataActionLeavesMaxRecordsEmpty()
    {
        if (!StudioAvailable()) return;
        var (result, error) = Run("refresh", "{\"base\":\"" + Fixture + "\",\"ops\":[" + Screen("Pa3Kpis") + """
            ,{"op":"logic","data":{"actions":[
               {"name":"GetKpis","kind":"data","owner":"IMobileScreen:Pa3Kpis","fetch":"OnDemand","outputs":[{"name":"Total","type":"Integer"}],"steps":[{"assign":{"Total":"1"}}]},
               {"name":"Reload","kind":"screen","owner":"IMobileScreen:Pa3Kpis","steps":[{"node":"IRefreshDataNode","as":"RefreshKpis","properties":{"DataSource":"IMobileScreen:Pa3Kpis/GetKpis"}}]}]}}
            ,{"op":"get","target":"IMobileScreen:Pa3Kpis/Reload/**IRefreshDataNode"}]}
            """);
        Assert.True(error == null, error?.ToString());
        var refresh = result!["results"]!.AsArray().Last()!["result"]!["properties"]!.AsObject();
        Assert.True(refresh.ContainsKey("MaxRecords"), refresh.ToJsonString());
        Assert.True(string.IsNullOrEmpty(refresh["MaxRecords"]?.ToString()), refresh.ToJsonString());
    }

    [Fact]
    public void AFontAwesomeNameIsWrittenAsTheConversionTableSays()
    {
        if (!StudioAvailable()) return;
        var table = new IconCatalog.IconTable("Phosphor2.0", new HashSet<string> { "shopping-cart", "shopping-cart-simple", "x", "star" },
            new Dictionary<string, (string, string?)> { ["cart-plus"] = ("shopping-cart", "fill"), ["times"] = ("x", "") });
        IconCatalog.Override = table;
        try
        {
            var (result, error) = Run("icons", "{\"base\":\"" + Fixture + "\",\"ops\":[" + Screen("Pa3Icons") + """
                ,{"op":"create","parent":"$scr/#IMobileBlockInstanceWidget/MainContent","type":"IIcon","name":"Cart","as":"$cart"}
                ,{"op":"set","target":"$cart","prop":"Icon","value":"cart-plus"}
                ,{"op":"set","target":"$cart","prop":"Weight","value":"regular"}
                ,{"op":"get","target":"$cart"}]}
                """);
            Assert.True(error == null, error?.ToString());
            var icon = result!["results"]!.AsArray().Last()!["result"]!["properties"]!;
            Assert.Equal("shopping-cart", icon["Icon"]!.ToString());
            Assert.Equal("fill", icon["Weight"]!.ToString());
            Assert.Contains(result["iconConversions"]!.AsArray(), c => c!["from"]!.GetValue<string>() == "cart-plus" && c["to"]!.GetValue<string>() == "shopping-cart/fill");
            // The html-visual `<i>` arrives as the same two sets (Icon, then Weight): the same rule applies.
            var (html, htmlError) = Run("icons-html", "{\"base\":\"" + Fixture + "\",\"ops\":[" + Screen("Pa3IconsHtml") + """
                ,{"op":"html","parent":"$scr/#IMobileBlockInstanceWidget/MainContent","html":"<i icon=\"cart-plus\" weight=\"regular\"></i>"}
                ,{"op":"get","target":"$scr/#IMobileBlockInstanceWidget/MainContent/**IIcon[1]"}]}
                """);
            Assert.True(htmlError == null, htmlError?.ToString());
            var htmlIcon = html!["results"]!.AsArray().Last()!["result"]!["properties"]!;
            Assert.Equal("shopping-cart", htmlIcon["Icon"]!.ToString());
            Assert.Equal("fill", htmlIcon["Weight"]!.ToString());
            var (_, unknown) = Run("icon-unknown", "{\"base\":\"" + Fixture + "\",\"ops\":[" + Screen("Pa3Icons2") + """
                ,{"op":"create","parent":"$scr/#IMobileBlockInstanceWidget/MainContent","type":"IIcon","name":"Odd","as":"$odd"}
                ,{"op":"set","target":"$odd","prop":"Icon","value":"nao-existe"}]}
                """);
            var coded = Errors.FindCoded(Assert.IsAssignableFrom<Exception>(unknown))!;
            Assert.True(coded.Problems!.Any(p => p!["code"]!.GetValue<string>() == "ICON_UNKNOWN" && p["pointer"]?.GetValue<string>() == "/ops/3/value"), coded.Code + " " + coded.Problems!.ToJsonString());
        }
        finally { IconCatalog.Override = null; }
    }

    [Fact]
    public void TheConversionTableIsReadFromTheInstalledStudio()
    {
        if (!StudioAvailable()) return;
        var table = IconCatalog.Current;
        Assert.NotNull(table);
        Assert.Equal("Phosphor2.0", table!.Library);
        Assert.Equal(("shopping-cart", "fill"), table.Conversion["cart-plus"]);
        Assert.Contains("x", table.Active);
    }

    [Fact]
    public void AReferenceToUserGetsDeleteRuleIgnoreAndProtectIsRefusedWithThePatch()
    {
        var job = JsonNode.Parse("""{"ops":[{"op":"spec","data":{"entities":[{"name":"Pa3Cart","attributes":[{"name":"UserId","type":"User Identifier","deleteRule":"Protect"}]}]}}]}""")!;
        var forced = Assert.Single(JobPreflight.Analyze(job["ops"]!.AsArray(), job)["problems"]!.AsArray(), p => p!["code"]!.GetValue<string>() == "ODC_DELETE_RULE_FORCED")!;
        Assert.Equal("/ops/0/data/entities/0/attributes/0/deleteRule", forced["pointer"]!.GetValue<string>());
        Assert.Equal("Ignore", forced["patch"]![0]!["value"]!.GetValue<string>());
        if (!StudioAvailable()) return;
        var (result, error) = Run("user-reference", "{\"base\":\"" + Fixture + "\",\"ops\":["
            + """{"op":"spec","data":{"entities":[{"name":"Pa3Cart","attributes":[{"name":"UserId","type":"User Identifier"}]}]}},{"op":"get","target":"$Pa3Cart.UserId"}]}""");
        Assert.True(error == null, error?.ToString());
        Assert.Equal("Ignore", result!["results"]!.AsArray().Last()!["result"]!["properties"]!["DeleteRule"]!.ToString());
        Assert.Contains(result["notes"]!.AsArray(), n => n!["code"]!.GetValue<string>() == "ODC_DELETE_RULE_IGNORE");
        Assert.True(result["dataContract"]!["accepted"]!.GetValue<bool>(), result["dataContract"]!["differences"]!.ToJsonString());
    }

    [Fact]
    public void AScreenTitleWrittenAsPlainWordsIsTheTextItMeans()
    {
        if (!StudioAvailable()) return;
        // v02b / labs 01 to 04: `set $scr Title Jogo da Velha` was ParserUnexpectedElement after the build.
        var (result, error) = Run("title", "{\"base\":\"" + Fixture + "\",\"ops\":[" + Screen("Pa3Velha")
            + """,{"op":"set","target":"$scr","prop":"Title","value":"Jogo da Velha"}]}""");
        Assert.True(error == null, error?.ToString());
        Assert.True(result!["isValid"]!.GetValue<bool>(), result["details"]!.ToJsonString());
        Assert.Contains(result["expressionRewrites"]!.AsArray(), r => r!["to"]!.GetValue<string>() == "\"Jogo da Velha\"");
    }

    [Fact]
    public void StyleOnAPlaceholderIsWrittenToItsStyleClasses()
    {
        if (!StudioAvailable()) return;
        var (result, error) = Run("placeholder-style", "{\"base\":\"" + Fixture + "\",\"ops\":["
            + """{"op":"create","parent":"IMobileFlow:MainFlow","type":"IMobileBlock","name":"Pa3Shell","as":"$blk"},{"op":"create","parent":"$blk","type":"IPlaceholderWidget","name":"Content","as":"$ph"},{"op":"set","target":"$ph","prop":"Style","value":"\"shell-content\""}]}""");
        Assert.True(error == null, error?.ToString());
        Assert.Contains(result!["notes"]!.AsArray(), n => n!["code"]!.GetValue<string>() == "SET_PROPERTY_MAPPED" && n["message"]!.GetValue<string>().Contains("StyleClasses"));
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(Pa3KlOdcTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
