using System.Text.Json.Nodes;
using System.Text.Json;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public class MergeCoverageTests
{
    public static IEnumerable<object[]> StoredPairs()
    {
        yield return new object[] { "tests/fixtures/reactive-ui.oml", "tests/fixtures/reactive-ui.oml", true };
        var expected = Environment.GetEnvironmentVariable("SSAM_PROOF_EXPECTED");
        var actual = Environment.GetEnvironmentVariable("SSAM_PROOF_ACTUAL");
        if (!string.IsNullOrEmpty(expected) && !string.IsNullOrEmpty(actual))
            yield return new object[] { expected, actual, Environment.GetEnvironmentVariable("SSAM_PROOF_ACCEPTED") == "true" };
    }

    [Theory]
    [MemberData(nameof(StoredPairs))]
    public void StoredMergeHasExpectedFidelity(string expected, string actual, bool accepted)
    {
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(MergeCoverageTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "stored-merge-proof-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var host = new ModelHost(Path.Combine(work, "model"));
        var proof = MergeContentProof.Check(host, Path.GetFullPath(expected, root), Path.GetFullPath(actual, root));
        File.WriteAllText(Path.Combine(work, "proof.json"), proof.ToJsonString());
        Assert.True(proof["accepted"]!.GetValue<bool>() == accepted, work);
    }

    [Theory]
    [InlineData("roles", "set:Roles")]
    [InlineData("order", "ordered:Widgets")]
    [InlineData("binding", "$expression")]
    [InlineData("remove", "$kind")]
    public void ScreenLossesCannotPassContentProof(string mutation, string expectedProperty)
    {
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(MergeCoverageTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "merge-negative-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var host = new ModelHost(Path.Combine(work, "model"));
        var expected = Path.Combine(work, "expected.oml");
        CompileCheck.WriteUnchecked(host, File.ReadAllBytes(Path.Combine(root, "tests", "fixtures", "reactive-ui.oml")), JsonNode.Parse("""
          [{"op":"create","parent":"@espace","type":"IRole","name":"ProofReader"},
           {"op":"create","parent":"IMobileFlow:MainFlow","type":"IMobileScreen","name":"ProofScreen","as":"$screen"},
           {"op":"set","target":"$screen","prop":"Roles","value":["IRole:ProofReader"]},
           {"op":"create","parent":"$screen","type":"ILocalVariable","name":"First","as":"$first"},
           {"op":"set","target":"$first","prop":"DataType","value":"Text"},
           {"op":"create","parent":"$screen","type":"ILocalVariable","name":"Second","as":"$second"},
           {"op":"set","target":"$second","prop":"DataType","value":"Text"},
           {"op":"create","parent":"$screen","type":"IExpression","name":"FirstText","as":"$a"},
           {"op":"set","target":"$a","prop":"Value","value":"First"},
           {"op":"create","parent":"$screen","type":"IExpression","name":"SecondText","as":"$b"},
           {"op":"set","target":"$b","prop":"Value","value":"Second"}]
          """)!.AsArray(), expected);
        var edit = mutation switch {
            "roles" => """{"op":"set","target":"IMobileScreen:ProofScreen","prop":"Roles","value":[]}""",
            "order" => """{"op":"move","target":"IExpression:SecondText","before":"IExpression:FirstText"}""",
            "binding" => """{"op":"set","target":"IExpression:FirstText","prop":"Value","value":"Second"}""",
            "remove" => """{"op":"delete","target":"IExpression:FirstText"}""",
            _ => throw new ArgumentException(mutation)
        };
        var actual = Path.Combine(work, "actual.oml");
        CompileCheck.WriteUnchecked(host, File.ReadAllBytes(expected), new JsonArray(JsonNode.Parse(edit)), actual);
        var proof = MergeContentProof.Check(host, expected, actual);
        File.WriteAllText(Path.Combine(work, "proof.json"), proof.ToJsonString());
        Assert.False(proof["accepted"]!.GetValue<bool>(), work);
        Assert.Contains(proof["differences"]!.AsArray(), d => d!["property"]!.ToString() == expectedProperty);
        Assert.True(MergeContentProof.Check(host, expected, expected)["accepted"]!.GetValue<bool>(), work);
    }

    public static IEnumerable<object[]> Captures()
    {
        foreach (var file in new[] { "blank-service.oml", "traditional-ui.oml", "reactive-ui.oml", "mobile-ui.oml" })
            yield return new object[] { file };
        if (Environment.GetEnvironmentVariable("SSAM_MERGE_CAPTURE") is { Length: > 0 } capture)
            yield return new object[] { capture };
    }

    [Theory]
    [MemberData(nameof(Captures))]
    public void ReloadAndNoChangeMergeAreStable(string file)
    {
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(MergeCoverageTests).Assembly.Location)!)!;
        var source = Path.IsPathRooted(file) ? file : Path.Combine(root, "tests", "fixtures", file);
        var work = Path.Combine(root, ".local", "merge-capture-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var host = new ModelHost(Path.Combine(work, "model"));
        var merged = Path.Combine(work, "merged.oml");
        var bytes = File.ReadAllBytes(source);
        MergeProbe.ThreeWay(host, bytes, bytes, merged);
        var proof = MergeContentProof.Check(host, source, merged);
        File.WriteAllText(Path.Combine(work, "proof.json"), proof.ToJsonString());
        Assert.True(proof["accepted"]!.GetValue<bool>(), work);
    }

    [Theory]
    [InlineData("traditional-ajax-navigation")]
    [InlineData("traditional-html-frontend")]
    [InlineData("screen-crud-traditional")]
    [InlineData("screen-form-reactive")]
    [InlineData("screen-list-reactive")]
    [InlineData("hidden-reference-block")]
    [InlineData("entity-actions")]
    [InlineData("logic-sql-params")]
    [InlineData("rest-spec-expose")]
    [InlineData("rest-spec-consume")]
    [InlineData("email-traditional")]
    [InlineData("process-human-traditional")]
    [InlineData("cat-b-traditional-gallery")]
    [InlineData("screen-spec-cards-mobile")]
    [InlineData("entity-lifecycle")]
    [InlineData("examples/pat-timer-typical")]
    [InlineData("cat-b-screen-replace-delete")]
    [InlineData("flow-layout-decisions")]
    public void NativeJobMatrixRetainsMeasuredContent(string name)
    {
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(MergeCoverageTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "merge-coverage-matrix", name, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var host = new ModelHost(Path.Combine(work, "model"));
        var job = Path.Combine(root, "tests", "jobs", name + ".json");
        var basis = JobRunner.ResolveBase(host, job);
        var candidate = Path.Combine(work, "candidate.oml");
        var applied = JsonSerializer.SerializeToNode(JobRunner.Run(host, basis, job, candidate))!;
        File.WriteAllText(Path.Combine(work, "apply.json"), applied.ToJsonString());
        Assert.True(applied["accepted"]!.GetValue<bool>(), work);
        var merged = Path.Combine(work, "merged.oml");
        var merge = MergeProbe.ThreeWay(host, File.ReadAllBytes(basis), File.ReadAllBytes(candidate), merged);
        File.WriteAllText(Path.Combine(work, "merge.json"), JsonSerializer.Serialize(merge));
        Assert.True(merge.LocalIsValid, work);
        var proof = MergeContentProof.Check(host, candidate, merged);
        File.WriteAllText(Path.Combine(work, "proof.json"), proof.ToJsonString());
        Assert.True(proof["accepted"]!.GetValue<bool>(), work);
    }

    [Fact]
    public void RoleChecksThroughServerSurviveDisposablePreview()
    {
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(MergeCoverageTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "merge-role-loss-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var host = new ModelHost(Path.Combine(work, "model"));
        var job = Path.Combine(root, "tests/jobs/examples/pat-role-check-screen.json");
        var basis = JobRunner.ResolveBase(host, job);
        var candidate = Path.Combine(work, "candidate.oml");
        var applied = JsonSerializer.SerializeToNode(JobRunner.Run(host, basis, job, candidate))!;
        Assert.True(applied["accepted"]!.GetValue<bool>());
        var plan = new MergePlanner(_ => host).Plan(basis, candidate, Path.Combine(work, "first-pass.oml"));
        File.WriteAllText(Path.Combine(work, "plan.json"), plan.ToJsonString());
        var preview = plan["contentPreview"]!;
        Assert.True(preview["accepted"]!.GetValue<bool>(), work);
        Assert.Equal(0, preview["newErrors"]!.GetValue<int>());
        Assert.True(preview["contentProof"]!["accepted"]!.GetValue<bool>(), work);
    }

    [Theory]
    [InlineData("CheckApproverRole")]
    [InlineData("GrantApproverRole")]
    [InlineData("RevokeApproverRole")]
    public void NativeRoleCallFromClientIsRefusedBeforeAFileCanBeDelivered(string roleAction)
    {
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(MergeCoverageTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "role-client-refusal", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        var job = JsonNode.Parse(File.ReadAllText(Path.Combine(root, "tests/jobs/examples/pat-role-check-screen.json")))!;
        var action = job["ops"]!.AsArray().SelectMany(op => op?["data"]?["actions"] as JsonArray ?? new JsonArray())
            .Single(a => a?["name"]?.ToString() == "ApproveOnClick")!;
        action["steps"]![0]!["call"] = roleAction;
        action["steps"]![0]!["args"] = new JsonObject { ["UserId"] = "GetUserId()" };
        var path = Path.Combine(work, "invalid.json");
        File.WriteAllText(path, job.ToJsonString());
        var candidate = Path.Combine(work, "invalid.oml");
        var error = Assert.ThrowsAny<Exception>(() => JobRunner.Run(host, Path.Combine(root, "tests/fixtures/reactive-ui.oml"), path, candidate));
        var refusal = Errors.FindCoded(error);
        Assert.Equal("PREFLIGHT_REFUSED", refusal?.Code);
        Assert.Contains(refusal!.Problems.OfType<JsonObject>(), p => p["code"]?.ToString() == "ROLE_ACTION_REQUIRES_SERVER");
        Assert.False(File.Exists(candidate));
    }

    [Theory]
    [InlineData("WebResponsive", "IWebScreen:Home", 1)]
    [InlineData("WebResponsiveLibrary", "IWebScreen:Home", 1)]
    [InlineData("WebResponsive", "", 0)]
    [InlineData("CrossDevice", "IMobileScreen:Home", 0)]
    [InlineData("Mobile", "IMobileScreen:Home", 0)]
    public void TraditionalDefaultScreenIsRefusedBeforeItCanBeLost(string kind, string target, int count)
    {
        var ops = new JsonArray(new JsonObject { ["op"] = "set", ["target"] = "@espace", ["prop"] = "DefaultScreen", ["value"] = target });
        var problems = Anvil.Core.Preflight.NodeRules.Check(ops, "/ops", Anvil.Core.Preflight.JobFacts.From(ops), kind);
        Assert.Equal(count, problems.Count);
        if (count > 0) {
            Assert.Equal("TRADITIONAL_DEFAULT_SCREEN_NOT_MERGEABLE", problems[0]["code"]!.ToString());
            Assert.Contains("IEntry", problems[0]["fix"]!.ToString());
        }
    }

    [Theory]
    [InlineData("@espace", "Description", "Lost module description")]
    [InlineData("IWebFlow:MainFlow", "Name", "RenamedFlow")]
    public void OrdinaryModelPropertiesAreCompared(string target, string property, string value)
    {
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(MergeCoverageTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "merge-coverage-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var host = new ModelHost(Path.Combine(work, "model"));
        var basis = Path.Combine(root, "tests", "fixtures", "traditional-ui.oml");
        var expected = Path.Combine(work, "expected.oml");
        CompileCheck.WriteUnchecked(host, File.ReadAllBytes(basis), new JsonArray(new JsonObject {
            ["op"] = "set", ["target"] = target, ["prop"] = property, ["value"] = value
        }), expected);
        var proof = MergeContentProof.Check(host, expected, basis);
        File.WriteAllText(Path.Combine(work, "proof.json"), proof.ToJsonString());
        Assert.False(proof["accepted"]!.GetValue<bool>(), work + "\n" + proof);
        Assert.True(MergeContentProof.Check(host, expected, expected)["accepted"]!.GetValue<bool>());
    }
}
