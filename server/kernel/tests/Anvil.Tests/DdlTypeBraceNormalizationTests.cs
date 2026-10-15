using System.Text.Json.Nodes;
using Anvil.Core.Preflight;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

public sealed class DdlTypeBraceNormalizationTests
{
    [Theory]
    [InlineData("o11")]
    [InlineData("odc")]
    public void ValidFieldsEndBeforeTheNextDocumentedTypeAndAtEndOfText(string lane)
    {
        const string text = "type First public = {\n  Value: Text;\n\n/// Next type.\ntype Second = {\n  Amount: Integer;\n";
        var entries = new List<JsonObject>();
        var normalized = DdlTypeBraceNormalization.Normalize(text, lane, "/ops/0/data/ddl", entries);
        Assert.NotNull(normalized);
        Assert.Equal(2, entries.Count);
        Assert.All(entries, e => Assert.Equal(DdlTypeBraceNormalization.Rule, e["rule"]!.ToString()));
        var doc = DdlParser.Parse(normalized!, lane);
        Assert.Equal(["First", "Second"], doc.Elements.Select(e => e.Name));
        Assert.Equal("Next type.", doc.Elements[1].Props["Description"]);
        Assert.Null(DdlTypeBraceNormalization.Normalize(normalized!, lane, "/ops/0/data/ddl", []));
    }

    [Fact]
    public void AClosedTypeAndAnInvalidFieldAreNotReinterpreted()
    {
        foreach (var text in new[] { "type Fine = { Value: Text; }", "type Broken = {\n  Value Text;\n", "type Broken = {\n  Value: Text;\n  mystery\n" })
        {
            var entries = new List<JsonObject>();
            Assert.Null(DdlTypeBraceNormalization.Normalize(text, "o11", "/ops/0/data/ddl", entries));
            Assert.Empty(entries);
        }
    }

    [Fact]
    public void ABraceInsideATextOrAFieldDescriptionDoesNotCloseTheType()
    {
        const string text = "type Described = {\n  /// The value.\n  Value: Text default \"}\";\n";
        var normalized = DdlTypeBraceNormalization.Normalize(text, "o11", "/ops/0/data/ddl", []);
        Assert.NotNull(normalized);
        var field = Assert.Single(Assert.Single(DdlParser.Parse(normalized!).Elements).Children);
        Assert.Equal("The value.", field.Props["Description"]);
        Assert.Equal("\"}\"", field.Props["DefaultValue"]);
    }

    [Fact]
    public void TheNormalizerRunsBeforeDdlAndDependentTypeChecks()
    {
        var ops = new JsonArray(new JsonObject { ["op"] = "spec", ["data"] = new JsonObject { ["ddl"] = "type Shape = {\n  Value: Text;\n" } });
        var done = JobNormalizer.Pure(ops, "/ops", "o11");
        Assert.Single(done, n => n["rule"]!.ToString() == DdlTypeBraceNormalization.Rule);
        Assert.Single(DdlParser.Parse(ops[0]!["data"]!["ddl"]!.ToString()).Elements);
    }

    [Fact]
    public void TheCapturedBlockTypesAllParseInOneNormalizationPass()
    {
        const string path = @"C:\t\codex\caso-blocks\254e6398-322e-44b5-be89-524c6204a54b.json";
        if (!File.Exists(path)) return;
        var job = JsonNode.Parse(File.ReadAllText(path))!;
        var source = job["ops"]![0]!["data"]!["ddl"]!.ToString();
        var done = new List<JsonObject>();
        var normalized = DdlTypeBraceNormalization.Normalize(source, "o11", "/ops/0/data/ddl", done);
        Assert.NotNull(normalized);
        var doc = DdlParser.Parse(normalized!);
        Assert.Equal(10, doc.Elements.Count);
        Assert.Equal(doc.Elements.Count, done.Count);
        Assert.Equal(done.Count, done.Select(e => e["from"]!.ToString()).Distinct().Count());
    }
}
