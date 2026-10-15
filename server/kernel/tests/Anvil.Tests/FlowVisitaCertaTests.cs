using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Core;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// The refusals of the owner's 18-action delivery (VisitaCerta_CS, 2026-10-12), as real O11 jobs on the blank service fixture
/// (JobRunner: preflight, apply, Verify): a list of aggregate rows mapped attribute by attribute to a list of an entity of
/// the row is written in the platform's own form and listed (FLOW_MAPPING_PLATFORM: the plain value when the Studio converts
/// a row of one entity by itself, `Rows mapTo { Value: Entity }` when it maps a row of several entities whole); a plain value
/// the Studio maps by itself reads with that mapping and is listed (FLOW_MAPPING_STUDIO); a mapping that says something else
/// stays refused (FLOW_MAPPING_TYPES); every syntax problem of every text comes in one refusal, the certain slips normalized
/// and listed. The pure parts (the parser and the normalizer) are FlowTextNormalizeTests.
/// </summary>
public sealed class FlowVisitaCertaTests
{
    private const string Fixture = "blank-service.oml";

    private const string Spec = """
        {"op":"spec","data":{"entities":[
          {"name":"VcPlace","attributes":[{"name":"Name","type":"Text","length":50},{"name":"City","type":"Text","length":50}]},
          {"name":"VcForecast","attributes":[{"name":"Title","type":"Text","length":50}]},
          {"name":"VcHour","attributes":[{"name":"VcForecastId","type":"VcForecast Identifier"},{"name":"Temp","type":"Decimal"}]}]}}
        """;

    // As the model wrote them: the values read the list's Current, the sort says DESC.
    private const string Places = """
        server action VcPlaces
          out Places: VcPlace List
          Q = aggregate FROM VcPlace WHERE (VcPlace.Name <> "") SORT VcPlace.Name DESC MAX 50
          assign Places = Q.List mapTo { Id: Q.List.Current.VcPlace.Id, Name: Q.List.Current.VcPlace.Name, City: Q.List.Current.VcPlace.City }
          end

        """;

    private const string Join = "Cache = aggregate FROM VcForecast, VcHour JOIN Inner VcForecast~VcHour ON VcHour.VcForecastId = VcForecast.Id WHERE (VcForecast.Title <> \"\") MAX 50";

    private static string Hours(string name, string value) => $"""
        server action {name}
          out Hours: VcHour List
          {Join}
          assign Hours = {value}
          end

        """;

    private static string Scratch()
    {
        var dir = Path.Combine(PacoteBPolicyTests.FindRoot(), ".local", "flow-visitacerta-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir); return dir;
    }

    private static JsonNode Run(string dir, string name, string job, string? basePath = null)
    {
        var path = Path.Combine(dir, name + ".json");
        File.WriteAllText(path, job);
        return JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), basePath, path, Path.Combine(dir, name + ".oml")))!;
    }

    private static (JsonArray Problems, JsonArray? Normalizations) Refused(string dir, string name, string job, string? basePath = null)
    {
        var error = Assert.ThrowsAny<Exception>(() => Run(dir, name, job, basePath));
        var coded = Errors.FindCoded(error);
        Assert.True(coded != null, Errors.Text(error));
        return (coded!.Problems!, Errors.Normalizations(error));
    }

    private static string Text(string dir, string name, string action, bool bare = true)
    {
        var bytes = File.ReadAllBytes(Path.Combine(dir, name + ".oml"));
        var sha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant();
        var entry = new ModelHost(Path.Combine(dir, "work")).BuildFlow(bytes, sha, "o11").Actions.Single(a => a.Name == action);
        Assert.True(entry.FixedPoint, string.Join("\n", entry.Problems));
        return bare ? Regex.Replace(entry.Text, @" @[A-Za-z0-9+/_=-]+$", "", RegexOptions.Multiline) : entry.Text;
    }

    private static string Flow(params string[] texts) => new JsonObject { ["op"] = "logic", ["data"] = new JsonObject {
        ["flow"] = new JsonArray(texts.Select(t => (JsonNode)JsonValue.Create(t)!).ToArray()) } }.ToJsonString();

    private static void Accepted(JsonNode result) =>
        Assert.True(result["accepted"]!.GetValue<bool>() && result["isValid"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString() + result["details"]);

    private static List<string> Rules(JsonNode? normalizations) =>
        (normalizations as JsonArray ?? []).OfType<JsonObject>().Select(n => n["rule"]!.ToString()).ToList();

    private static string Base(string dir)
    {
        Accepted(Run(dir, "vc-base", $$$"""{"base":"{{{Fixture}}}","ops":[{{{Spec}}}]}"""));
        return Path.Combine(dir, "vc-base.oml");
    }

    // The refusal of a delivery under the lock (Delivery.cs) names the part of the contract that refused, with its counts.
    [Fact]
    public void TheValidationVerdictNamesThePartThatRefused()
    {
        var applied = JsonNode.Parse("""
            {"isValid":false,"accepted":false,"expectedValid":true,
             "problems":[{"phase":"verify","code":"ExpressionUnknownObject","severity":"error"},{"phase":"verify","code":"ExpressionUnknownObject","severity":"error"},
                         {"phase":"verify","code":"UnusedVariable","severity":"warning"},{"phase":"apply","code":"X","severity":"error"}],
             "validation":{"new":[],"unexpected":[{"id":"ExpressionUnknownObject"},{"id":"ExpressionUnknownObject"}]}}
            """)!.AsObject();
        Assert.Equal("the Verify of the candidate: 2 errors (ExpressionUnknownObject 2); 2 messages no expectedMessages entry covers",
            Anvil.Core.Delivery.Delivery.ValidationVerdict(applied));
        // Without the kernel's problems the Verify's new errors count; an expectation alone and the data contract are named.
        var fromNew = JsonNode.Parse("""{"isValid":false,"accepted":false,"validation":{"new":[{"type":"Error","id":"E1"},{"type":"Warning","id":"W1"}]}}""")!.AsObject();
        Assert.Equal("the Verify of the candidate: 1 error (E1 1)", Anvil.Core.Delivery.Delivery.ValidationVerdict(fromNew));
        Assert.Equal("1 message no expectedMessages entry covers; the data contract", Anvil.Core.Delivery.Delivery.ValidationVerdict(
            JsonNode.Parse("""{"isValid":true,"accepted":false,"validation":{"unexpected":[{"id":"W1"}]},"dataContract":{"accepted":false}}""")!.AsObject()));
        Assert.Equal("the candidate was not accepted", Anvil.Core.Delivery.Delivery.ValidationVerdict(new JsonObject { ["isValid"] = true, ["accepted"] = false }));
        // Review of 2026-10-12: the refactor proof is named, never "the candidate was not accepted".
        Assert.Equal("the refactor proof (reference sets changed after save/reload)", Anvil.Core.Delivery.Delivery.ValidationVerdict(
            JsonNode.Parse("""{"isValid":true,"accepted":false,"refactorProof":{"accepted":false,"differences":[{}]}}""")!.AsObject()));
        // Re-check of 2026-10-12 (probe K1): invalid only by an error the module already had, never "0 errors".
        Assert.Equal("the module already had 1 error (ExpressionUnknownObject 1), the job added none", Anvil.Core.Delivery.Delivery.ValidationVerdict(
            JsonNode.Parse("""{"isValid":false,"accepted":false,"expectedValid":true,"validation":{"new":[{"type":"Warning","id":"UnusedUserAction"}],"preexisting":[{"type":"Error","id":"ExpressionUnknownObject"},{"type":"Warning","id":"UnusedUserAction"}]}}""")!.AsObject()));
    }

    [Fact]
    public void AListMappingOfEveryAttributeOfOneRecordIsWrittenInThePlatformsFormAndListed()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Scratch();
        var basePath = Base(dir);
        var result = Run(dir, "vc-maps", $$$"""{"ops":[{{{Flow(Places, Hours("VcHours", "Cache.List mapTo { Id: Cache.List.Current.VcHour.Id, VcForecastId: Cache.List.Current.VcHour.VcForecastId, Temp: Cache.List.Current.VcHour.Temp }"), Hours("VcStudio", "Cache.List"))}}}]}""", basePath);
        // The Verify accepts the module and every text reads back as written, in the platform's form where it has one.
        Accepted(result);
        var rules = Rules(result["normalizations"]);
        Assert.Contains(FlowTextEdit.MappingRelative, rules);
        Assert.Contains(FlowTextEdit.SortDirection, rules);
        Assert.Equal(2, rules.Count(r => r == "FLOW_MAPPING_PLATFORM"));
        Assert.Equal(1, rules.Count(r => r == "FLOW_MAPPING_STUDIO"));
        // A row of one entity converts to it by itself: the plain value.
        var places = Text(dir, "vc-maps", "VcPlaces");
        Assert.Contains("  assign Places = Q.List\n", places);
        Assert.Contains("SORT VcPlace.Name desc MAX 50", places);
        // A row of two entities maps the one of the target's type whole, whether the text wrote every attribute or nothing.
        Assert.Contains("  assign Hours = Cache.List mapTo { Value: VcHour }\n", Text(dir, "vc-maps", "VcHours"));
        Assert.Contains("  assign Hours = Cache.List mapTo { Value: VcHour }\n", Text(dir, "vc-maps", "VcStudio"));
    }

    [Fact]
    public void AMappingThatSaysSomethingElseStaysRefusedWithItsReason()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Scratch();
        var basePath = Base(dir);
        // Negative: an attribute left out of a row the Studio converts by itself is not that conversion.
        var partial = Places.Replace(", City: Q.List.Current.VcPlace.City", "");
        var (missing, _) = Refused(dir, "vc-partial", $$$"""{"ops":[{{{Flow(partial)}}}]}""", basePath);
        var problem = Assert.Single(missing.OfType<JsonObject>());
        Assert.Equal("FLOW_MAPPING_TYPES", problem["code"]!.ToString());
        Assert.Contains("by itself", problem["message"]!.ToString());
        // Ambiguity: values from two records of the row are no record whole; the target maps only Value.
        var (mixed, _) = Refused(dir, "vc-mixed", $$$"""{"ops":[{{{Flow(Hours("VcMixed", "Cache.List mapTo { Id: VcHour.Id, VcForecastId: VcForecast.Id, Temp: VcHour.Temp }"))}}}]}""", basePath);
        problem = Assert.Single(mixed.OfType<JsonObject>());
        Assert.Equal("FLOW_MAPPING_TYPES", problem["code"]!.ToString());
        Assert.Contains("its attributes: Value", problem["message"]!.ToString());
    }

    [Fact]
    public void EverySyntaxProblemOfEveryTextComesInOneRefusalAndTheSlipsAreNormalized()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Scratch();
        var basePath = Base(dir);
        // A text whose branch falls through to the end (one reading, normalized), one with two errors and one with one. (A
        // branch that ends on an If followed by the outer If's false branch has two readings: FlowTextNormalizeTests.)
        var falls = """
            server action VcFalls
              in A: Boolean
              out N: Integer
              if A:
                assign # Done
                  N = 2
              end

            """;
        var two = "server action VcTwo\n  out N: Integer\n  assign N = (1\n  X = Call(P=1\n  end\n";
        var one = "server action VcOne\n  out N: Integer\n  assign N = \"abc\n  end\n";
        var (problems, normalizations) = Refused(dir, "vc-syntax", $$$"""{"ops":[{{{Flow(falls, two, one)}}}]}""", basePath);
        var syntax = problems.OfType<JsonObject>().Where(p => p["code"]!.ToString() == "FLOW_SYNTAX").ToList();
        Assert.Equal(3, syntax.Count);
        Assert.Equal(2, syntax.Count(p => p["pointer"]!.ToString() == "/ops/0/data/flow/1"));
        Assert.Equal(1, syntax.Count(p => p["pointer"]!.ToString() == "/ops/0/data/flow/2"));
        Assert.DoesNotContain(syntax, p => p["pointer"]!.ToString() == "/ops/0/data/flow/0");
        var rules = Rules(normalizations);
        Assert.Contains(FlowTextEdit.FallsThrough, rules);
        Assert.Contains(FlowTextEdit.LabelSpacing, rules);
        // The normalized text alone is accepted and reads as normalized.
        var accepted = Run(dir, "vc-falls", $$$"""{"ops":[{{{Flow(falls)}}}]}""", basePath);
        Accepted(accepted);
        var read = Text(dir, "vc-falls", "VcFalls", bare: false);
        // Both branches end (the printer writes an end in each branch, with its id). Junction 24-1-final: the layout engine of 24-1
        // (FlowLayout, "Shared action End nodes are split into equivalent terminal copies") gives each branch its own End, so the
        // two ids differ where tx-visitacerta's writer alone kept the one End the fall-through named.
        Assert.Matches(@"\n    assign N = 2  # Done @n\d+\n    end @n\d+\n  end @n\d+\n", read);
    }
}
