using System.Text.Json.Nodes;
using Anvil.Core.Preflight;
using Xunit;

namespace Anvil.Tests;

/// <summary>The literal-certainty scope reads every op of the job. An op it cannot read (a data.flow that is no text) never
/// becomes the refusal of the html op: the scope is unreadable, the literal is a choice, and the one refusal carries the html
/// problem of its own op next to the problem of the unreadable op.</summary>
public sealed class PatchCertaintyUnreadableJobScopeTests
{
    public static TheoryData<string> UnreadableFlows => new() { "42", "[42]", "{\"text\":1}", "[{\"basedOn\":\"x\"}]" };

    [Theory]
    [MemberData(nameof(UnreadableFlows))]
    public void AnUnreadableOpKeepsTheHtmlProblemOfItsOwnOpAndMakesTheLiteralAChoice(string flow)
    {
        var problems = Problems(Probe("Buscar por nome", flow));
        var html = problems.Where(p => OpOf(p) == 1).ToList();
        Assert.NotEmpty(html);
        Assert.DoesNotContain(html, p => p["code"]?.ToString() == "FLOW_SYNTAX");
        Assert.All(html, p => {
            Assert.Equal("HTML_INVALID", p["code"]?.ToString());
            Assert.Equal("TEXT_LITERAL_CHOICE", p["patchRule"]?.ToString());
            Assert.False(PatchCertainty.IsCertain(p), p.ToJsonString());
        });
        Assert.Contains(problems, p => OpOf(p) == 2);
    }

    [Fact]
    public void TheReviewReproBringsTheHtmlAndTheLogicProblemsOnce()
    {
        var problems = Problems(Probe("Buscar por nome", "42"));
        Assert.Contains(problems, p => p["code"]?.ToString() == "HTML_INVALID" && OpOf(p) == 1);
        Assert.Contains(problems, p => p["code"]?.ToString() == "LOGIC_INVALID" && p["pointer"]?.ToString() == "/ops/2/data/flow");
        Assert.DoesNotContain(problems, p => p["code"]?.ToString() == "FLOW_SYNTAX" && p["pointer"]?.ToString() == "/ops/1");
    }

    [Fact]
    public void WithoutALiteralOnlyTheUnreadableOpIsRefused()
    {
        var problems = Problems(Probe("F0", "42"));
        Assert.DoesNotContain(problems, p => OpOf(p) == 1);
        Assert.Contains(problems, p => p["code"]?.ToString() == "LOGIC_INVALID" && p["pointer"]?.ToString() == "/ops/2/data/flow");
    }

    [Theory]
    [InlineData("{\"op\":\"logic\",\"data\":{\"flow\":42}}", false)]
    [InlineData("{\"op\":\"logic\",\"data\":{\"flow\":[{\"basedOn\":\"x\"}]}}", false)]
    [InlineData("{\"op\":\"spec\",\"data\":[]}", false)]
    [InlineData("{\"op\":\"logic\",\"data\":{\"actions\":[{\"name\":\"Arquivar\",\"steps\":[]}]}}", true)]
    public void TheJobNamesOfTheLiteralScopeAreUnreadableWhenAnOpCannotBeRead(string op, bool readable)
    {
        var method = typeof(Anvil.Core.ModelSession).GetMethod("LiteralJobNames", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic);
        Assert.NotNull(method);
        var names = method!.Invoke(null, [new JsonArray(JsonNode.Parse(op))]);
        Assert.Equal(readable, names != null);
    }

    private static (JsonObject Result, bool Saved) Probe(string placeholder, string flow)
        => PatchCertaintyJobProbe.Run("unreadable-job-scope", PatchCertaintyJobProbe.Flow("FsFlow"),
            PatchCertaintyJobProbe.Screen("FsProbe", "FsFlow", $"<var name='F0' type='Text'/><input bind='F0' placeholder=\"{placeholder}\"/>"),
            new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = JsonNode.Parse(flow) } });

    private static List<JsonObject> Problems((JsonObject Result, bool Saved) run)
    {
        Assert.False(run.Result["accepted"]?.GetValue<bool>() == true, run.Result.ToJsonString());
        Assert.False(run.Saved, "a refusal saves nothing");
        return (run.Result["problems"] as JsonArray ?? []).OfType<JsonObject>().ToList();
    }

    private static int? OpOf(JsonObject problem)
    {
        if (problem["op"] is JsonValue op && op.TryGetValue<int>(out var index)) return index;
        return problem["pointer"]?.ToString() is { } pointer && pointer.StartsWith("/ops/", StringComparison.Ordinal)
            && int.TryParse(pointer[5..].Split('/')[0], out var at) ? at : null;
    }
}
