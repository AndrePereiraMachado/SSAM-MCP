using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Atritos 3, lane kl, C21 (DCIPS, LF-07 and D2): a structure attribute takes length and label (4x "unknown keys length");
/// the values of a spec are written as the literal the Studio stores (25 unquoted texts, 15 "expected true actual True"),
/// reported; a static record text longer than its attribute is refused with the exact fix ("Label &gt; 50", 10x); the same
/// index again is a no-op (3x "duplicates an existing explicit index"); a name longer than 28 characters is written as the
/// Studio keeps it and the data proof expects that name (D2: SignatureAuthenticationMethod).
/// </summary>
public sealed class Pa3KlSpecTests
{
    private static readonly string Root = PacoteBPolicyTests.FindRoot();

    private static JsonNode Run(string name, string job)
    {
        var dir = Path.Combine(Root, ".local", "pa3-kl-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, name + ".json");
        File.WriteAllText(path, job);
        return JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, path, Path.Combine(dir, name + ".oml")))!;
    }

    [Fact]
    public void AStructureAttributeTakesLengthAndLabel()
    {
        var ops = SpecExpander.Expand(JsonNode.Parse("""{"structures":[{"name":"Dto","attributes":[{"name":"Code","type":"Text","length":30,"label":"Codigo"}]}]}""")!.AsObject());
        Assert.Contains(ops, o => o["target"]?.ToString() == "$Dto.Code" && o["prop"]?.ToString() == "Length" && o["value"]!.GetValue<int>() == 30);
        Assert.Contains(ops, o => o["target"]?.ToString() == "$Dto.Code" && o["prop"]?.ToString() == "Label" && o["value"]!.ToString() == "Codigo");
    }

    [Fact]
    public void SpecValuesAreWrittenAsTheLiteralTheStudioStoresAndReported()
    {
        var rewrites = new List<(string Pointer, string From, string To)>();
        var ops = SpecExpander.Expand(JsonNode.Parse("""
            {"static":[{"name":"Flag","attributes":[{"name":"IsOn","type":"Boolean"},{"name":"Code","type":"Text"}],"records":[{"name":"A","IsOn":true,"Code":"Alpha"}]}],
             "entities":[{"name":"Item","attributes":[{"name":"Active","type":"Boolean","default":true},{"name":"Status","type":"Text","default":"Pending"},{"name":"Note","type":"Text","default":"\"ok\""}]}]}
            """)!.AsObject(), rewrites);
        string? Value(string target, string prop) => ops.LastOrDefault(o => o["target"]?.ToString() == target && o["prop"]?.ToString() == prop)?["value"]?.ToString();
        Assert.Equal("True", Value("$Item.Active", "DefaultValue"));
        Assert.Equal("\"Pending\"", Value("$Item.Status", "DefaultValue"));
        Assert.Equal("\"ok\"", Value("$Item.Note", "DefaultValue"));
        Assert.Equal("True", Value("$Flag.A/IsOn", "Value"));
        Assert.Equal("\"Alpha\"", Value("$Flag.A/Code", "Value"));
        Assert.Contains(rewrites, r => r.Pointer == "/entities/0/attributes/0/default" && r.To == "True");
        Assert.Contains(rewrites, r => r.Pointer == "/entities/0/attributes/1/default" && r.From == "Pending" && r.To == "\"Pending\"");
        Assert.Contains(rewrites, r => r.Pointer == "/static/0/records/0/IsOn" && r.To == "True");
        Assert.DoesNotContain(rewrites, r => r.Pointer == "/entities/0/attributes/2/default");
        // The preflight says it as a warning: the spec writes the literal, the job is not refused for it.
        var job = JsonNode.Parse("""{"ops":[{"op":"spec","data":{"entities":[{"name":"Item","attributes":[{"name":"Status","type":"Text","default":"Pending"}]}]}}]}""")!;
        var result = JobPreflight.Analyze(job["ops"]!.AsArray(), job, []);
        Assert.True(result["valid"]!.GetValue<bool>(), result["errors"]!.ToJsonString());
        Assert.Contains(result["warnings"]!.AsArray(), w => w!["code"]!.GetValue<string>() == "DEFAULT_LITERAL_REWRITTEN");
    }

    [Fact]
    public void AStructureAPublicStructureHoldsIsPublicAndASelfReferenceDoesNotCascade()
    {
        // C19 by file (DCIPS Reference_CS: InvalidPublic_AttributeNotPublic; Messaging_CS: BadDeleteRule on a self reference).
        var rewrites = new List<(string Pointer, string From, string To)>();
        var ops = SpecExpander.Expand(JsonNode.Parse("""
            {"structures":[{"name":"Order","public":true,"attributes":[{"name":"Lines","type":"Line List"}]},{"name":"Line","attributes":[{"name":"Tax","type":"Tax"}]},{"name":"Tax","attributes":[{"name":"Rate","type":"Decimal"}]}],
             "entities":[{"name":"Message","attributes":[{"name":"ReplyToId","type":"Message Identifier","deleteRule":"Delete"}]}]}
            """)!.AsObject(), rewrites);
        Assert.Contains(ops, o => o["target"]?.ToString() == "$Line" && o["prop"]?.ToString() == "Public" && o["value"]!.GetValue<bool>());
        Assert.Contains(ops, o => o["target"]?.ToString() == "$Tax" && o["prop"]?.ToString() == "Public" && o["value"]!.GetValue<bool>());
        Assert.Contains(rewrites, r => r.Pointer == "/structures/1/public" && r.To == "true");
        Assert.Equal("Protect", ops.Single(o => o["target"]?.ToString() == "$Message.ReplyToId" && o["prop"]?.ToString() == "DeleteRule")["value"]!.ToString());
        Assert.Contains(rewrites, r => r.Pointer == "/entities/0/attributes/0/deleteRule" && r.From == "Delete" && r.To == "Protect");
    }

    [Fact]
    public void AStaticRecordTextLongerThanItsAttributeIsRefusedWithTheExactFix()
    {
        var label = new string('L', 51);
        var job = JsonNode.Parse($$$"""
            {"ops":[{"op":"spec","data":{"static":[{"name":"Kind","attributes":[{"name":"Code","type":"Text","length":5}],
              "records":[{"name":"A","label":"{{{label}}}","Code":"ABCDEFG"},{"name":"B","Code":"OK"}]}]}}]}
            """)!;
        var problems = JobPreflight.Analyze(job["ops"]!.AsArray(), job, [])["problems"]!.AsArray().OfType<JsonObject>()
            .Where(p => p["code"]!.GetValue<string>() == "SPEC_VALUE_TOO_LONG").ToArray();
        Assert.Equal(["/ops/0/data/static/0/records/0/Code", "/ops/0/data/static/0/records/0/label"], problems.Select(p => p["pointer"]!.GetValue<string>()).Order(StringComparer.Ordinal));
        var code = problems.Single(p => p["pointer"]!.GetValue<string>().EndsWith("/Code", StringComparison.Ordinal));
        Assert.Contains("\"length\": 7", code["fix"]!.GetValue<string>());
        Assert.Equal(new string('L', 50), problems.Single(p => p["pointer"]!.GetValue<string>().EndsWith("/label", StringComparison.Ordinal))["patch"]![0]!["value"]!.GetValue<string>());
    }

    [Fact]
    public void TheSameIndexAgainIsANoOpReported()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var result = Run("index-noop", """
            {"base":"blank-service.oml","ops":[
              {"op":"spec","data":{"entities":[{"name":"Pa3Ix","attributes":[{"name":"Code","type":"Text"}],"indexes":[{"name":"IX_Code","attributes":["Code"]}]}]}},
              {"op":"create","parent":"IServerEntity:Pa3Ix","type":"EntityIndex","name":"IX_Code_Again","args":{"attributes":["$Pa3Ix.Code"]}}]}
            """);
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]!.ToJsonString() + result["dataContract"]!.ToJsonString());
        var noOp = Assert.Single(result["indexNoOps"]!.AsArray())!;
        Assert.Equal("IX_Code_Again", noOp["from"]!.GetValue<string>());
        Assert.Equal("IX_Code", noOp["to"]!.GetValue<string>());
    }

    [Fact]
    public void ALongNameIsTruncatedAsTheStudioDoesAndTheDataProofExpectsIt()
    {
        Assert.Equal("SignatureAuthenticationMetho", NameTruncation.Truncate("SignatureAuthenticationMethod", []));
        Assert.Equal("SignatureAuthenticationMeth2", NameTruncation.Truncate("SignatureAuthenticationMethodABC", ["SignatureAuthenticationMetho"]));
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var result = Run("long-names", """
            {"base":"blank-service.oml","ops":[
              {"op":"spec","data":{"entities":[{"name":"Pa3Long","attributes":[{"name":"SignatureAuthenticationMethodXYZ","type":"Text"},{"name":"SignatureAuthenticationMethodABC","type":"Text"}],
                "indexes":[{"name":"IX_Pa3Long_SignatureAuthenticationMethod","attributes":["SignatureAuthenticationMethodXYZ"]}]}]}}]}
            """);
        Assert.True(result["dataContract"]!["accepted"]!.GetValue<bool>(), result["dataContract"]!["differences"]!.ToJsonString());
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]!.ToJsonString());
        var truncations = result["nameTruncations"]!.AsArray().OfType<JsonObject>().ToDictionary(t => t["from"]!.GetValue<string>(), t => t["to"]!.GetValue<string>());
        Assert.Equal("SignatureAuthenticationMetho", truncations["SignatureAuthenticationMethodXYZ"]);
        Assert.Equal("SignatureAuthenticationMeth2", truncations["SignatureAuthenticationMethodABC"]);
        Assert.Equal("IX_Pa3Long_SignatureAuthenti", truncations["IX_Pa3Long_SignatureAuthenticationMethod"]);
    }
}
