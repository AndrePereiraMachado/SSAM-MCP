using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Core.PreflightRules
{
    /// <summary>A rule by the I1 convention, in the test assembly: refuses an action named Forbidden.</summary>
    public static class PacoteBFakeRule
    {
        public static IEnumerable<JsonObject> Check(JsonArray ops, string lane)
        {
            for (var i = 0; i < ops.Count; i++)
                if (ops[i]?["name"]?.ToString() == "Forbidden")
                    yield return new JsonObject { ["op"] = i, ["pointer"] = $"/ops/{i}/name", ["code"] = "PACOTE_B_FORBIDDEN", ["severity"] = "error",
                        ["message"] = "the name Forbidden is reserved (" + lane + ")", ["fix"] = "\"name\": \"Allowed\"",
                        ["patch"] = new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = $"/ops/{i}/name", ["value"] = "Allowed" }) };
        }
    }

    /// <summary>A rule that fails: it must become a warning, never a refusal.</summary>
    public static class PacoteBThrowingRule
    {
        public static IEnumerable<JsonObject> Check(JsonArray ops, string lane) => throw new InvalidOperationException("rule bug");
    }
}

namespace Anvil.Tests
{
    /// <summary>
    /// Lane B, C20: the whole job is checked before anything is loaded, and every problem comes back in one answer with op,
    /// pointer, code and fix (I2); fragment files are read and checked; literal defaults and public signatures are judged;
    /// the plug-in rules (I1) are discovered and run, and a failing rule is a warning; the names, keys and functions only
    /// the base can answer are refused all at once before the first op; the CLI envelope carries code and problems.
    /// </summary>
    public sealed class PacoteBPreflightTests
    {
        private static readonly string Root = PacoteBPolicyTests.FindRoot();
        private static JsonArray Ops(string json) => JsonNode.Parse(json)!.AsArray();

        [Fact]
        public void ThreeErrorsInDifferentOpsComeBackTogetherWithOpCodeAndFix()
        {
            var job = JsonNode.Parse("""
            {"ops":[
              {"op":"logic","data":{"actions":[{"name":"A","bogus":1,"steps":[]}]}},
              {"op":"set","target":"IEntityAttribute:Amount","prop":"Length","value":"-3"},
              {"op":"logic","data":{"actions":[{"name":"B","inputs":[{"name":"N","type":"Integer","default":"\"5\""}],"outputs":[{"name":"Out","type":"Integer"}],"steps":[{"assign":{"Out":"N"}}]}]}}
            ]}
            """)!;
            var result = JobPreflight.Analyze(job["ops"]!.AsArray(), job, []);
            Assert.False(result["valid"]!.GetValue<bool>());
            var problems = result["problems"]!.AsArray().OfType<JsonObject>().ToArray();
            Assert.Equal(new[] { 0, 1, 2 }, problems.Select(p => p["op"]!.GetValue<int>()).Distinct().Order());
            Assert.All(problems, p =>
            {
                Assert.Matches("^[A-Z0-9_]+$", p["code"]!.GetValue<string>());
                Assert.Equal("error", p["severity"]!.GetValue<string>());
                Assert.False(string.IsNullOrWhiteSpace(p["fix"]?.GetValue<string>()));
                Assert.StartsWith($"/ops/{p["op"]}", p["pointer"]!.GetValue<string>());
            });
            var literal = Assert.Single(problems, p => p["code"]!.GetValue<string>() == "DEFAULT_LITERAL_INVALID");
            Assert.Equal("/ops/2/data/actions/0/inputs/0/default", literal["pointer"]!.GetValue<string>());
            Assert.Equal("5", literal["patch"]![0]!["value"]!.GetValue<string>());
            Assert.All(result["errors"]!.AsArray(), e => Assert.Matches(@"^op #\d+ \([^)]*\) \[[A-Z0-9_]+\]: ", e!.GetValue<string>()));
            // RequireValid throws the coded exception with every problem.
            var refused = Assert.Throws<JobPreflightException>(() => JobPreflight.RequireValid(result));
            Assert.Equal("PREFLIGHT_REFUSED", refused.Code);
            Assert.Equal(problems.Length, refused.Problems.Count);
        }

        [Fact]
        public void AnArrayJobPointsAtItsOwnIndicesAndACompositeHasNoPointer()
        {
            var ops = Ops("""[{"op":"logic","data":{"actions":[{"name":"A","bogus":1,"steps":[]}]}}]""");
            // I4 (atritos 2): the logic compiler points at the key it refuses, under the action.
            Assert.Equal("/0/data/actions/0/bogus", JobPreflight.Analyze(ops, ops, [])["problems"]![0]!["pointer"]!.GetValue<string>());
            Assert.Null(JobPreflight.Analyze(ops, JsonNode.Parse("""{"jobs":["job:a"]}"""), [])["problems"]![0]!["pointer"]);
        }

        [Fact]
        public void AFragmentFileIsReadAndCheckedInThePreflight()
        {
            var dir = Path.Combine(Root, ".local", "pacote-b-tests", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(dir);
            var fragment = Path.Combine(dir, "card.html");
            // <table> compiles since the one element table (lane html, 6d85e4d9): two tags outside every list stand for it
            File.WriteAllText(fragment, "<div class=\"card\"><blink>x</blink><marquee>y</marquee></div>");
            var ops = new JsonArray(new JsonObject { ["op"] = "html", ["parent"] = "$box", ["file"] = fragment });
            var result = JobPreflight.Analyze(ops, new JsonObject { ["ops"] = ops.DeepClone() }, []);
            var problem = Assert.Single(result["problems"]!.AsArray())!;
            var message = problem["message"]!.GetValue<string>();
            Assert.Contains("fragment file", message);
            Assert.Contains("<blink>", message);
            Assert.Contains("<marquee>", message); // every tag outside the syntax at once
            Assert.Contains("supported tags", message);
        }

        [Fact]
        public void LiteralDefaultsAndPublicSignaturesAreJudgedWithTheExactFix()
        {
            Assert.Equal("\"Pending\"", JobPreflight.LiteralFix("Text", "Pending"));
            Assert.Equal("True", JobPreflight.LiteralFix("Boolean", "yes"));
            Assert.Equal("#2026-10-05#", JobPreflight.LiteralFix("Date", "2026-10-05"));
            Assert.Null(JobPreflight.LiteralFix("Text", "\"ok\""));
            Assert.Null(JobPreflight.LiteralFix("Integer", "Length(X)"));
            var ops = Ops("""
            [{"op":"spec","data":{"structures":[{"name":"Summary","attributes":[{"name":"Total","type":"Integer"}]}]}},
             {"op":"logic","data":{"actions":[{"name":"GetSummary","public":true,"outputs":[{"name":"Result","type":"Summary"}],"steps":[{"assign":{"Result.Total":"1"}}]}]}}]
            """);
            var problem = Assert.Single(JobPreflight.PublicSignatures(ops, "/ops"));
            Assert.Equal("PUBLIC_SIGNATURE_PRIVATE_TYPE", problem["code"]!.GetValue<string>());
            Assert.Equal("/ops/0/data/structures/0/public", problem["patch"]![0]!["path"]!.GetValue<string>());
        }

        [Fact]
        public void PlugInRulesAreDiscoveredAndRunAndAFailingRuleIsAWarning()
        {
            var discovered = JobPreflight.RulesIn(typeof(PacoteBPreflightTests).Assembly);
            Assert.Contains(typeof(Anvil.Core.PreflightRules.PacoteBFakeRule), discovered);
            Assert.Contains(typeof(Anvil.Core.PreflightRules.PacoteBThrowingRule), discovered);
            var job = JsonNode.Parse("""{"ops":[{"op":"create","parent":"@espace","type":"IServerAction","name":"Forbidden"}]}""")!;
            var ruled = JobPreflight.Analyze(job["ops"]!.AsArray(), job, discovered);
            Assert.False(ruled["valid"]!.GetValue<bool>());
            var problem = Assert.Single(ruled["problems"]!.AsArray())!;
            Assert.Equal("PACOTE_B_FORBIDDEN", problem["code"]!.GetValue<string>());
            Assert.Equal("/ops/0/name", problem["pointer"]!.GetValue<string>());
            Assert.Contains("(o11)", problem["message"]!.GetValue<string>());
            var warning = Assert.Single(ruled["warnings"]!.AsArray())!;
            Assert.Equal("PREFLIGHT_RULE_FAILED", warning["code"]!.GetValue<string>());
            Assert.Equal("warning", warning["severity"]!.GetValue<string>());
            var throwing = JobPreflight.Analyze(job["ops"]!.AsArray(), job, [typeof(Anvil.Core.PreflightRules.PacoteBThrowingRule)]);
            Assert.True(throwing["valid"]!.GetValue<bool>());
            // A rule writes /ops/<i> pointers; an array job gets them (and the patch paths) rebased, a composite job drops both.
            var array = job["ops"]!.DeepClone().AsArray();
            var rebased = Assert.Single(JobPreflight.Analyze(array, array, [typeof(Anvil.Core.PreflightRules.PacoteBFakeRule)])["problems"]!.AsArray())!;
            Assert.Equal("/0/name", rebased["pointer"]!.GetValue<string>());
            Assert.Equal("/0/name", rebased["patch"]![0]!["path"]!.GetValue<string>());
            var composite = Assert.Single(JobPreflight.Analyze(array, JsonNode.Parse("""{"jobs":["job:a"]}"""), [typeof(Anvil.Core.PreflightRules.PacoteBFakeRule)])["problems"]!.AsArray())!;
            Assert.Null(composite["pointer"]);
            Assert.Null(composite["patch"]);
        }

        [Fact]
        public void TheCliEnvelopeCarriesCodeAndProblems()
        {
            var problem = JobPreflight.Problem(1, "/ops/1", "REFERENCE_UNRESOLVED", "error", "IServerAction:X does not resolve", "use one of: IServerAction:Y");
            var wrapped = new InvalidOperationException("op #1 (set Description): refused", JobPreflightException.Of([problem]));
            var envelope = Errors.Envelope("apply", wrapped, 7);
            Assert.False(envelope["ok"]!.GetValue<bool>());
            Assert.Equal("PREFLIGHT_REFUSED", envelope["code"]!.GetValue<string>());
            var published = Assert.Single(envelope["problems"]!.AsArray())!;
            Assert.Equal("REFERENCE_UNRESOLVED", published["code"]!.GetValue<string>());
            Assert.Null(published["_kind"]);
            Assert.False(Errors.Envelope("apply", new InvalidOperationException("plain"), 1).ContainsKey("code"));
        }

        [Fact]
        public void NamesTheJobWritesAreLeftToTheJobAndTheRestIsCheckedAgainstTheBase()
        {
            var ops = Ops("""
            [{"op":"create","parent":"@espace","type":"IServerAction","name":"Made","as":"$m"},
             {"op":"set","target":"IServerAction:Made","prop":"Description","value":"x"},
             {"op":"set","target":"IServerAction:Elsewhere","prop":"Description","value":"plain text, not a reference"},
             {"op":"set","target":"$m","prop":"Description","value":"y"},
             {"op":"link","from":"@AbCd123","to":"@espace"}]
            """);
            var found = JobPreflight.BaseReferences(ops, "/ops");
            Assert.Equal(new[] { "IServerAction:Elsewhere", "@AbCd123" }, found.Select(r => r.Reference));
            Assert.Equal("/ops/2/target", found[0].Pointer);
        }

        [Fact]
        public void UnresolvedReferencesAreAllRefusedBeforeTheFirstOp()
        {
            if (!PacoteBPolicyTests.StudioAvailable()) return;
            var dir = Path.Combine(Root, ".local", "pacote-b-tests", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(dir);
            var job = Path.Combine(dir, "missing.json");
            File.WriteAllText(job, """
            {"base":"blank-service.oml","ops":[
              {"op":"set","target":"IServerAction:PacoteBMissingOne","prop":"Description","value":"x"},
              {"op":"set","target":"IServerEntity:PacoteBMissingTwo","prop":"Description","value":"x"},
              {"op":"delete","target":"IStructure:PacoteBMissingThree"}]}
            """);
            var output = Path.Combine(dir, "missing.oml");
            var error = Assert.ThrowsAny<Exception>(() => JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, job, output));
            var coded = Assert.IsAssignableFrom<JobPreflightException>(Errors.FindCoded(error));
            Assert.Equal(new[] { 0, 1, 2 }, coded.Problems.Select(p => p!["op"]!.GetValue<int>()));
            Assert.All(coded.Problems, p => Assert.Equal("REFERENCE_UNRESOLVED", p!["code"]!.GetValue<string>()));
            Assert.False(File.Exists(output));
            Assert.Equal("PREFLIGHT_REFUSED", Errors.Envelope("apply", error, 1)["code"]!.GetValue<string>());
        }

        [Fact]
        public void AnUnknownFunctionInLogicIsRefusedBeforeTheFirstOp()
        {
            if (!PacoteBPolicyTests.StudioAvailable()) return;
            var dir = Path.Combine(Root, ".local", "pacote-b-tests", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(dir);
            var job = Path.Combine(dir, "function.json");
            File.WriteAllText(job, """
            {"base":"blank-service.oml","ops":[{"op":"logic","data":{"actions":[{"name":"PacoteBTail","public":true,
              "inputs":[{"name":"V","type":"Text"}],"outputs":[{"name":"Out","type":"Text"}],"steps":[{"assign":{"Out":"Right(V, 1)"}}]}]}}]}
            """);
            var error = Assert.ThrowsAny<Exception>(() => JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, job, Path.Combine(dir, "function.oml")));
            var coded = Assert.IsAssignableFrom<JobPreflightException>(Errors.FindCoded(error));
            var problem = Assert.Single(coded.Problems)!;
            Assert.Equal("FUNCTION_UNKNOWN", problem["code"]!.GetValue<string>());
            Assert.Contains("Substr", problem["fix"]!.GetValue<string>());
        }
    }
}
