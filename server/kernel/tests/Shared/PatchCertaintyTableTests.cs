using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Core;
using Anvil.Core.Preflight;
using Xunit;

namespace Anvil.Tests;

public sealed class PatchCertaintyTableTests
{
    [Fact]
    public void AComposedLiteralPatchUsesTheChoiceRuleWhenAnotherMemberNeedsAChoice()
    {
        var problem = Problem("TEXT_LITERAL_QUOTED");
        problem["patchRules"] = new JsonArray("TEXT_LITERAL_QUOTED", "TEXT_LITERAL_CHOICE");
        PatchCertainty.Publish(problem);
        Assert.False(problem["patchCertain"]!.GetValue<bool>());
        Assert.Equal("TEXT_LITERAL_CHOICE", problem["patchRule"]!.ToString());
    }

    [Fact]
    public void AnExistingActionUsesARecordedBuiltinShadowingChoiceRule()
    {
        Assert.True(PatchCertainty.Rules.TryGetValue("BUILTIN_FUNCTION_SHADOWED", out var rule));
        Assert.False(rule!.Certain);
        Assert.False(string.IsNullOrWhiteSpace(rule.Reason));
    }

    private static JsonArray Patch() => new(new JsonObject { ["op"] = "replace", ["path"] = "/data/html", ["value"] = "corrected" });
    private static JsonObject Problem(string? rule, JsonArray? patch = null) => JobPreflight.Problem(0, "/data/html", "HTML_INVALID", "error", "invalid", "fix", patch ?? Patch(), patchRule: rule);

    [Fact]
    public void EverySourceRuleHasARecordedReason()
    {
        var root = TextRoundTripCorpus.Root()!;
        var source = Path.Combine(root, "kernel", "src", "Anvil.Core", "Kernel");
        var references = new HashSet<string>(StringComparer.Ordinal);
        var patterns = new[] {
            "(?:patchRule|PatchRule)\\s*[:=]\\s*\"([A-Z_]+)\"",
            "\\[\"patchRule\"\\]\\s*=\\s*\"([A-Z_]+)\"",
        };
        foreach (var file in Directory.EnumerateFiles(source, "*.cs", SearchOption.AllDirectories).Where(f => !f.EndsWith("PatchCertainty.cs")))
        {
            foreach (var pattern in patterns)
                foreach (Match match in Regex.Matches(File.ReadAllText(file), pattern)) references.Add(match.Groups[1].Value);
            foreach (var line in File.ReadLines(file))
                if (Regex.Match(line, "(?:patchRule|PatchRule)\\s*[:=]|\\[\"patchRule\"\\]\\s*=") is { Success: true } tag)
                    foreach (Match match in Regex.Matches(line[tag.Index..], "\"([A-Z_]+)\"")) references.Add(match.Groups[1].Value);
            if (file.EndsWith("Verbs.Diagnosis.Patches.cs"))
                foreach (Match match in Regex.Matches(File.ReadAllText(file), "\"([A-Z_]+)\"")) references.Add(match.Groups[1].Value);
            if (file.EndsWith("Verbs.Diagnosis.cs")) {
                var text = File.ReadAllText(file);
                var start = text.IndexOf("private static (string Fix, JsonArray Patch, string PatchRule)? CertainPatch", StringComparison.Ordinal);
                Assert.True(start >= 0, "the builtin patch source must be scanned");
                var next = text.IndexOf("private static", start + 1, StringComparison.Ordinal);
                foreach (Match match in Regex.Matches(text[start..(next < 0 ? text.Length : next)], "\"([A-Z_]+)\"")) references.Add(match.Groups[1].Value);
            }
        }
        Assert.NotEmpty(references);
        foreach (var name in references) Assert.True(PatchCertainty.Rules.ContainsKey(name), "unregistered source rule: " + name);
        Assert.All(PatchCertainty.Rules, pair => Assert.False(string.IsNullOrWhiteSpace(pair.Value.Reason), pair.Key));
        Assert.Equal(12, PatchCertainty.Rules.Count);
    }

    [Theory]
    [InlineData("TEXT_LITERAL_QUOTED", true)]
    [InlineData("REQUIRED_ARGUMENT_DEFAULT", true)]
    [InlineData("BUILTIN_FUNCTION_RENAMED", true)]
    [InlineData("BUILTIN_FUNCTION_NEAREST", false)]
    [InlineData("BUILTIN_FUNCTION_SHADOWED", false)]
    [InlineData("TEXT_LITERAL_CHOICE", false)]
    [InlineData("REQUIRED_ARGUMENT_TYPE_DEFAULT", false)]
    [InlineData("ACTION_RENAMED_FREE_NAME", false)]
    [InlineData("NEAREST_NAME", false)]
    [InlineData("LIST_ITEM_QUALIFIED", false)]
    [InlineData("FLOW_TEXT_READING", false)]
    [InlineData("OWNER_RULE_REWRITE", false)]
    [InlineData("NEW_UNCLASSIFIED_RULE", false)]
    [InlineData(null, false)]
    public void OnlyRegisteredSingleReadingRulesAreCertain(string? rule, bool expected)
    {
        var published = JobPreflight.PublicProblem(Problem(rule));
        Assert.Equal(expected, PatchCertainty.IsCertain(published));
        Assert.Equal(expected, published["patchCertain"]!.GetValue<bool>());
        if (expected) Assert.Null(published["patchChoice"]);
        else Assert.False(string.IsNullOrWhiteSpace(published["patchChoice"]!.ToString()));
    }

    [Fact]
    public void APatchAndAnUnambiguousReadingAreBothRequired()
    {
        var problem = Problem("TEXT_LITERAL_QUOTED", new JsonArray());
        problem["patchCertain"] = true;
        Assert.False(PatchCertainty.IsCertain(problem));
        problem["patch"] = Patch();
        problem["candidates"] = new JsonArray("first", "second");
        Assert.False(PatchCertainty.IsCertain(problem));
    }

    [Theory]
    [InlineData("REQUIRED_ARGUMENT_DEFAULT", true)]
    [InlineData("REQUIRED_ARGUMENT_TYPE_DEFAULT", false)]
    [InlineData("OWNER_RULE_REWRITE", false)]
    [InlineData("", false)]
    public void AWholeSourcePatchIsCertainOnlyWhenEveryMemberIsCertain(string second, bool expected)
    {
        var problem = Problem("TEXT_LITERAL_QUOTED");
        problem["patchRules"] = PatchCertainty.Members([problem, Problem(second)]);
        Assert.Equal(expected, PatchCertainty.IsCertain(problem));
        Assert.Equal(expected, JobPreflight.PublicProblem(problem)["patchCertain"]!.GetValue<bool>());
    }

    [Fact]
    public void RebasePreservesCertaintyMetadataAndRemovingItsPatchRecalculatesIt()
    {
        var problem = JobPreflight.PublicProblem(Problem("TEXT_LITERAL_QUOTED"));
        problem["patchRules"] = new JsonArray("TEXT_LITERAL_QUOTED", "REQUIRED_ARGUMENT_DEFAULT");
        var error = new KernelRefusalException("HTML_INVALID", "invalid", new JsonArray(problem));
        var rebased = Assert.Single(CodedProblems.From(error, 3, "html", "/ops/3")!);
        Assert.Equal("/ops/3/data/html", rebased["patch"]![0]!["path"]!.ToString());
        Assert.Equal("TEXT_LITERAL_QUOTED", rebased["patchRule"]!.ToString());
        Assert.Equal(2, rebased["patchRules"]!.AsArray().Count);
        Assert.True(rebased["patchCertain"]!.GetValue<bool>());
        var withoutPointer = Assert.Single(CodedProblems.From(error, 3, "html", null)!);
        Assert.Null(withoutPointer["patch"]);
        Assert.False(withoutPointer["patchCertain"]!.GetValue<bool>());
    }
}
