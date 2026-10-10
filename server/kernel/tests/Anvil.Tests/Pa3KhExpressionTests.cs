using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Preflight;
using Anvil.Core.PreflightRules;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Lane kh of the atritos 3 package, C19: EXPR_UNKNOWN_IDENTIFIER follows the type of what an expression reads (the output of
/// a call, of the job, of the base or of a producer's signature; a list of a basic type; the output of a SQL query), and
/// `a mod b` is written with the built-in. Each mechanical fix is an RFC 6902 patch, and ExpressionRewrites applies the same
/// rewrites in place. The real cases of the friction store (ReadSignals.Signals.Current.Value, `mod`) with synthetic names.
/// </summary>
public sealed class Pa3KhExpressionTests
{
    public Pa3KhExpressionTests() { try { StudioAssemblies.Bind(); } catch { /* no Studio: the checked-in catalog answers */ } }

    private static JsonArray Logic(string actions, string? spec = null) => JsonNode.Parse("[" + (spec == null ? "" : "{\"op\":\"spec\",\"data\":" + spec + "},")
        + "{\"op\":\"logic\",\"data\":{\"actions\":[" + actions + "]}}]")!.AsArray();

    private static List<JsonObject> Check(JsonArray ops, IBaseFacts? model = null, string lane = "o11")
        => ExpressionRules.Check(ops, "/ops", lane, JobFacts.From(ops), model);

    private static string? Patched(JsonObject problem) => problem["patch"]?[0]?["value"]?.ToString();
    private static string Json(string expression) => System.Text.Json.JsonSerializer.Serialize(expression)[1..^1];

    /// <summary>A base whose only callee is a producer action (an IActionSignature of the base) with the given outputs.</summary>
    private sealed class ProducerBase(params ParamFact[] outputs) : IBaseFacts
    {
        public IReadOnlyDictionary<string, string>? Attributes(string record) => record.Equals("Signal", StringComparison.OrdinalIgnoreCase)
            ? new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["Name"] = "Text", ["Level"] = "Integer" } : null;
        public bool IsClientEntity(string name) => false;
        public CalleeFact? Callee(string target, JsonObject caller) => target.EndsWith("Signals_Read", StringComparison.Ordinal) ? new CalleeFact(target, [], outputs) : null;
        public bool HasName(string name) => true;
        public bool NamesOnlyTypes(string name) => false;
        public RawExpressionFact? RawExpression(string target, string prop) => null;
        public bool IsFunction(string name) => false;
        public string? ModuleType => "Service";
    }

    private const string Reader = """
        {"name":"Signals_Use","kind":"server","outputs":[{"name":"Out","type":"Text"}],
         "steps":[{"call":"IServerActionSignature:Signals_Read","as":"ReadSignals"},{"assign":{"Out":"EXPR"}}]}
        """;

    [Fact]
    public void CallOutputCurrentOfAProducerOutputResolves()
    {
        // 05:32Z, DCIPS: ReadSignals.Signals.Current.Value on a Text List from a producer's call (111 ExpressionUnknownObject).
        var text = new ProducerBase(new ParamFact("Signals", "Text List", false));
        var value = Assert.Single(Check(Logic(Reader.Replace("EXPR", Json("ReadSignals.Signals.Current.Value + \"!\""))), text));
        Assert.Equal("EXPR_UNKNOWN_IDENTIFIER", value["code"]!.ToString());
        Assert.Equal("/ops/0/data/actions/0/steps/1/assign/Out", value["pointer"]!.ToString());
        Assert.Equal("ReadSignals.Signals.Current + \"!\"", Patched(value));
        Assert.Empty(Check(Logic(Reader.Replace("EXPR", "ReadSignals.Signals.Current")), text));
        // a list of records: the member is an attribute of the record
        var records = new ProducerBase(new ParamFact("Signals", "Signal List", false));
        Assert.Empty(Check(Logic(Reader.Replace("EXPR", "ReadSignals.Signals.Current.Name")), records));
        var typed = Assert.Single(Check(Logic(Reader.Replace("EXPR", "ReadSignals.Signals.Current.Signal.Name")), records));
        Assert.Equal("ReadSignals.Signals.Current.Name", Patched(typed));
        var unknown = Assert.Single(Check(Logic(Reader.Replace("EXPR", "ReadSignals.Signals.Current.Nome")), records));
        Assert.Null(unknown["patch"]);
        Assert.Contains("Name", unknown["fix"]!.ToString());
        // without the base nothing is known about the callee: nothing is said (the Verify judges)
        Assert.Empty(Check(Logic(Reader.Replace("EXPR", "ReadSignals.Signals.Current.Value"))));
    }

    [Fact]
    public void CurrentValueOnATextListIsRewritten()
    {
        var ops = Logic("""
            {"name":"Names_First","kind":"server","inputs":[{"name":"Names","type":"Text List"},{"name":"Ids","type":"Long Integer List"}],"outputs":[{"name":"First","type":"Text"}],
             "steps":[{"assign":{"First":"Names.Current.Value + LongIntegerToText(Ids.Current.Value)"}}]}
            """);
        var problems = Check(ops);
        Assert.Equal(2, problems.Count);
        Assert.Contains(problems, p => Patched(p) == "Names.Current + LongIntegerToText(Ids.Current.Value)");
        // the pass that applies them writes both, in place, and says each
        var rewrites = ExpressionRewrites.Apply(ops, "o11");
        var rewrite = Assert.Single(rewrites);
        Assert.Equal("/ops/0/data/actions/0/steps/0/assign/First", rewrite.Path);
        Assert.Equal("Names.Current + LongIntegerToText(Ids.Current)", rewrite.To);
        Assert.Equal(rewrite.To, ops[0]!["data"]!["actions"]![0]!["steps"]![0]!["assign"]!["First"]!.ToString());
        Assert.Empty(Check(ops));
    }

    [Theory]
    [InlineData("i mod 3", "Mod(i, 3)")]
    [InlineData("i + 1 mod 3", "i + Mod(1, 3)")]
    [InlineData("(i + 1) mod 3 = 0", "Mod((i + 1), 3) = 0")]
    [InlineData("a * b mod c", "Mod(a * b, c)")]
    [InlineData("x mod 2 + 1", "Mod(x, 2) + 1")]
    [InlineData("10000 + ((Base * 7919) mod 90000)", "10000 + (Mod((Base * 7919), 90000))")]
    [InlineData("If(N mod 2 = 0, \"even\", \"odd\")", "If(Mod(N, 2) = 0, \"even\", \"odd\")")]
    [InlineData("List[i mod 3].Name", "List[Mod(i, 3)].Name")]
    public void ModIsRewrittenWithTheBuiltIn(string expression, string written)
        => Assert.Equal(written, ExpressionRewrites.Mod(expression, hasModFunction: true));

    [Fact]
    public void ModWithoutTheBuiltInIsTheTruncatedForm()
    {
        Assert.Equal("(a - Trunc(a / b) * b)", ExpressionRewrites.Mod("a mod b", hasModFunction: false));
        // the function, a text that says mod and a variable named mod are no operator
        Assert.Null(ExpressionRewrites.Mod("Mod(a, b)", true));
        Assert.Null(ExpressionRewrites.Mod("Length(\"a mod b\")", true));
        Assert.Null(ExpressionRewrites.Mod("mod + 1", true));
        Assert.Null(ExpressionRewrites.Mod("Item.mod", true));
    }

    [Fact]
    public void ModInO11LogicIsRefusedWithThePatchThatWritesTheBuiltIn()
    {
        var ops = Logic("""
            {"name":"Codigo_Gerar","kind":"server","inputs":[{"name":"Base","type":"Long Integer"}],"outputs":[{"name":"Codigo","type":"Text"}],
             "steps":[{"assign":{"Codigo":"LongIntegerToText(10000 + ((Base * 7919) mod 90000))"}}]}
            """);
        var problem = Assert.Single(Check(ops));
        Assert.Equal("EXPR_UNKNOWN_IDENTIFIER", problem["code"]!.ToString());
        Assert.Equal("LongIntegerToText(10000 + (Mod((Base * 7919), 90000)))", Patched(problem));
        // ODC: its own rule says it, now with the patch; this rule stays silent there
        Assert.Empty(Check(ops, lane: "odc"));
        var odc = OdcPlatformRules.Check(ops, "odc").Single(p => p["code"]!.ToString() == "ODC_FUNCTION_UNAVAILABLE");
        Assert.Matches(@"LongIntegerToText\(10000 \+ \((Mod\(\(Base \* 7919\), 90000\)|\(\(Base \* 7919\) - Trunc\(\(Base \* 7919\) / 90000\) \* 90000\))\)\)", odc["patch"]![0]!["value"]!.ToString());
        Assert.Contains("rounds half to even", odc["fix"]!.ToString());
    }

    [Fact]
    public void TheFieldOfASqlRecordIsUnderList()
    {
        const string spec = """{"entities":[{"name":"Product","attributes":[{"name":"Name","type":"Text"},{"name":"Price","type":"Currency"}]}]}""";
        const string action = """
            {"name":"Products_Top","kind":"server","outputs":[{"name":"Top","type":"Text"}],
             "steps":[{"get":"Product","sql":true,"as":"Q","statement":"SELECT {Product}.* FROM {Product}"},{"assign":{"Top":"EXPR"}}]}
            """;
        var missing = Assert.Single(Check(Logic(action.Replace("EXPR", "Q.List.Current.Name"), spec)));
        Assert.Equal("Q.List.Current.List.Name", Patched(missing));
        var wrong = Assert.Single(Check(Logic(action.Replace("EXPR", "Q.List.Current.List.Nome"), spec)));
        Assert.Contains("Name", wrong["fix"]!.ToString());
        Assert.Empty(Check(Logic(action.Replace("EXPR", "Q.List.Current.List.Name"), spec)));
        Assert.Empty(Check(Logic(action.Replace("EXPR", "Q.List.Current.Product.Name"), spec)));   // the compiler's own rewrite
    }

    [Fact]
    public void ApplyRewritesModInARawSetToo()
    {
        var ops = JsonNode.Parse("""[{"op":"set","target":"$expr","prop":"Value","value":"Index mod 3"},{"op":"set","target":"$t","prop":"Description","value":"a mod b"}]""")!.AsArray();
        var rewrite = Assert.Single(ExpressionRewrites.Apply(ops, "o11"));
        Assert.Equal("/ops/0/value", rewrite.Path);
        Assert.Equal("Mod(Index, 3)", ops[0]!["value"]!.ToString());
        Assert.Equal("a mod b", ops[1]!["value"]!.ToString());
    }
}
