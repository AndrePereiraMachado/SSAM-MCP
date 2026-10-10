using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Atritos 3, lane kl, C27: a raw `set` is judged before the Verify. Plain words are the text they mean (v02b: `Title = Jogo
/// da Velha` was ParserUnexpectedElement after a 14 s build), `Type:Entity/Attribute` is `Entity.Attribute` (lab 32:
/// `IServerEntity:Product/Id` as a Sort), unbalanced quotes are refused with the pointer; a property the element of the base
/// cannot write is refused before the first op, with the others (labs 29: "has no writable property Style", 13 s).
/// </summary>
public sealed class Pa3KlSetTests
{
    private static readonly string Root = PacoteBPolicyTests.FindRoot();

    private static (JsonNode? Result, Exception? Error, string Output) Run(string dir, string name, string job, string? output = null)
    {
        var path = Path.Combine(dir, name + ".json");
        File.WriteAllText(path, job);
        output ??= Path.Combine(dir, name + ".oml");
        try { return (JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, path, output)), null, output); }
        catch (Exception ex) { return (null, ex, output); }
    }

    [Theory]
    [InlineData("Jogo da Velha", "\"Jogo da Velha\"", "plain-words")]
    [InlineData("IServerEntity:Product/Id", "Product.Id", "kind-path")]
    [InlineData("ServerEntity:Product/Name", "Product.Name", "kind-path")]
    [InlineData("\"Jogo da Velha\"", null, null)]
    [InlineData("Product.Name", null, null)]
    [InlineData("Count + 1", null, null)]
    [InlineData("not Done", null, null)]
    [InlineData("Produtos", null, null)]
    public void AnExpressionIsRewrittenOnlyWhenTheRuleIsCertain(string written, string? rewritten, string? rule)
    {
        var (text, which, syntax) = ModelSession.ExpressionRewrite(written);
        Assert.Equal((rewritten, rule), (text, which));
        Assert.Null(syntax);
    }

    [Fact]
    public void UnbalancedQuotesAreASyntaxProblem() => Assert.NotNull(ModelSession.ExpressionRewrite("\"Jogo da Velha").Syntax);

    [Fact]
    public void ARawSetIsJudgedAgainstTheBaseAndRewrittenAtApply()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Path.Combine(Root, ".local", "pa3-kl-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var (built, buildError, basePath) = Run(dir, "base", """
            {"base":"blank-service.oml","ops":[{"op":"logic","data":{"actions":[{"name":"Pa3Greet","inputs":[{"name":"Name","type":"Text","mandatory":false}],"outputs":[{"name":"R","type":"Text"}],"steps":[{"assign":{"R":"Name"}}]}]}}]}
            """, Path.Combine(dir, "work", "base.oml"));
        Assert.True(buildError == null, buildError?.ToString());
        var basePosix = basePath.Replace('\\', '/');
        // Two problems of the base at once, before the first op: a property the input cannot write, unbalanced quotes.
        var (_, error, output) = Run(dir, "refused", $$$"""
            {"base":"{{{basePosix}}}","ops":[
              {"op":"set","target":"IServerAction:Pa3Greet/Name","prop":"Nope","value":"x"},
              {"op":"set","target":"IServerAction:Pa3Greet/Name","prop":"DefaultValue","value":"\"Jogo da Velha"}]}
            """);
        var refused = Assert.IsType<JobPreflightException>(Errors.FindCoded(error!));
        var problems = refused.Problems.OfType<JsonObject>().ToArray();
        Assert.All(problems, p => Assert.Equal("base", p["phase"]!.GetValue<string>()));
        var all = new JsonArray(problems.Select(p => p.DeepClone()).ToArray()).ToJsonString();
        Assert.True(problems.Any(p => p["code"]!.GetValue<string>() == "PROPERTY_NOT_WRITABLE" && p["pointer"]!.GetValue<string>() == "/ops/0/prop"), all);
        Assert.True(problems.Any(p => p["code"]!.GetValue<string>() == "EXPRESSION_SYNTAX" && p["pointer"]!.GetValue<string>() == "/ops/1/value"), all);
        Assert.False(File.Exists(output));
        // Plain words: written as the text they mean, reported.
        var (result, fine, _) = Run(dir, "rewritten", $$$"""
            {"base":"{{{basePosix}}}","ops":[{"op":"set","target":"IServerAction:Pa3Greet/Name","prop":"DefaultValue","value":"Jogo da Velha"}]}
            """);
        Assert.True(fine == null, fine?.ToString());
        Assert.True(result!["isValid"]!.GetValue<bool>(), result["details"]!.ToJsonString());
        var rewrite = Assert.Single(result["expressionRewrites"]!.AsArray())!;
        Assert.Equal("\"Jogo da Velha\"", rewrite["to"]!.GetValue<string>());
        Assert.True(result["dataContract"]!["accepted"]!.GetValue<bool>(), result["dataContract"]!["differences"]!.ToJsonString());
    }
}
