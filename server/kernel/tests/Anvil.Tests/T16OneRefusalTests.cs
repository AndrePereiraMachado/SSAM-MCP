using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Core;
using Anvil.Core.Preflight;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// T16: one refusal carries every problem the job has that can be found without applying it, each with its certain patch when
/// one exists. A create whose name an element of the same type already has under the same parent (the MainFlow of a template
/// app) is a base problem with the patch that uses the existing element, and what depends on it is judged in the same round
/// (it was skipped unjudged behind the apply's NAME_COLLISION); a delete refused for its consumers carries reconnect:true when
/// that removes the step for certain, and never otherwise; the logic texts' scope rules against the screens of the same job
/// (L1-L3) run in every preflight; every fix text of the Verify hints is English. The sweep is generated from the native model:
/// every named element the base has becomes a create that collides, and its patch is accepted the next round.
/// </summary>
public sealed class T16OneRefusalTests(Xunit.Abstractions.ITestOutputHelper log)
{
    private static readonly string Root = JobRunner.RepoRoot(Directory.GetCurrentDirectory())!;
    private static string? _base;

    private static string Work()
    {
        var dir = Path.Combine(Root, ".local", "t16-one-refusal-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }

    // A server action with an input and a three-node flow (Start -> Middle -> End), and a structure with an attribute.
    private const string BaseOps = """
        [{"op":"create","parent":"@espace","type":"IServerAction","name":"T16Existing","as":"$a"},
         {"op":"create","parent":"$a","type":"IInputParameter","name":"Amount","as":"$i"},
         {"op":"set","target":"$i","prop":"DataType","value":"Integer"},
         {"op":"create","parent":"$a","type":"IOutputParameter","name":"Total","as":"$o"},
         {"op":"set","target":"$o","prop":"DataType","value":"Integer"},
         {"op":"create","parent":"$a","type":"IStartNode","as":"$s"},
         {"op":"create","parent":"$a","type":"IAssignNode","name":"Middle","as":"$m"},
         {"op":"create","parent":"$m","type":"IAssignment","as":"$m1"},
         {"op":"set","target":"$m1","prop":"Variable","value":"Total"},
         {"op":"set","target":"$m1","prop":"Value","value":"Amount + 1"},
         {"op":"create","parent":"$a","type":"IEndNode","as":"$e"},
         {"op":"link","from":"$s","to":"$m"},
         {"op":"link","from":"$m","to":"$e"},
         {"op":"create","parent":"@espace","type":"IStructure","name":"T16Shape","as":"$st"},
         {"op":"create","parent":"$st","type":"IStructureAttribute","name":"Code","as":"$sa"},
         {"op":"set","target":"$sa","prop":"DataType","value":"Text"}]
        """;

    private static string Base()
    {
        if (_base != null && File.Exists(_base)) return _base;
        var (result, error, output) = Run(null, BaseOps);
        Assert.True(error == null, error?.ToString());
        Assert.True(result!["accepted"]!.GetValue<bool>(), result.ToJsonString());
        return _base = output;
    }

    private static (JsonNode? Result, Exception? Error, string Output) Run(string? basePath, string ops, bool expectValid = true)
    {
        var dir = Work();
        var job = Path.Combine(dir, "job.json");
        File.WriteAllText(job, new JsonObject { ["base"] = "tests/fixtures/blank-service.oml", ["expectValid"] = expectValid, ["ops"] = JsonNode.Parse(ops) }.ToJsonString());
        var output = Path.Combine(dir, "out.oml");
        try { return (JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "model")), basePath, job, output)), null, output); }
        catch (Exception ex) { return (null, ex, output); }
    }

    private static List<JsonObject> Problems(Exception error) => Errors.FindCoded(error)!.Problems!.OfType<JsonObject>().ToList();
    private static string Show(IEnumerable<JsonObject> list) => new JsonArray(list.Select(p => (JsonNode)p.DeepClone()).ToArray()).ToJsonString();
    private static List<JsonObject> Warnings(Exception error) => error is JobPreflightException refusal ? refusal.Warnings.OfType<JsonObject>().ToList() : [];

    /// <summary>The job with every patch of the problems applied (replace and add of an op or of one key of an op).</summary>
    private static string Patched(string ops, IEnumerable<JsonObject> problems)
    {
        var job = JsonNode.Parse(ops)!.AsArray();
        foreach (var step in problems.Where(p => p["patch"] is JsonArray).SelectMany(p => p["patch"]!.AsArray().OfType<JsonObject>()))
        {
            var segments = step["path"]!.ToString().Split('/');
            Assert.Equal("ops", segments[1]);
            var index = int.Parse(segments[2]);
            if (segments.Length == 3) job[index] = step["value"]!.DeepClone();
            else job[index]!.AsObject()[segments[3]] = step["value"]!.DeepClone();
        }
        return job.ToJsonString();
    }

    // ---- rule 1: a create the base already has ---------------------------------------------------------------------------

    [Fact]
    public void ACreateTheBaseHasIsOneBaseProblemAndWhatItsDependentsFindIsConditionalOnTheChoice()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var ops = """
            [{"op":"create","parent":"@espace","type":"IServerAction","name":"T16Existing","as":"$a"},
             {"op":"create","parent":"$a","type":"IInputParameter","name":"Amount","as":"$x"},
             {"op":"set","target":"$x","prop":"Description","value":"x"},
             {"op":"set","target":"IServerAction:T16Nowhere","prop":"Description","value":"y"}]
            """;
        var (_, error, output) = Run(Base(), ops);
        var problems = Problems(error!);
        var collision = Assert.Single(problems, p => p["code"]!.ToString() == "NAME_COLLISION" && p["phase"]!.ToString() == "base");
        Assert.Equal(0, collision["op"]!.GetValue<int>());
        Assert.Equal("/ops/0/name", collision["pointer"]!.ToString());
        // Offered, never applied for the author (the later ops would write into the existing element): a choice, with its reason.
        Assert.False(collision["patchCertain"]!.GetValue<bool>(), collision.ToJsonString());
        Assert.False(string.IsNullOrEmpty(collision["patchChoice"]?.ToString()));
        Assert.Equal(JobRunner.CreateUsesExisting, collision["patchRule"]!.ToString());
        var patch = collision["patch"]!.AsArray();
        Assert.Equal("""{"op":"get","target":"IServerAction:T16Existing"}""", patch[0]!["value"]!.ToJsonString());
        Assert.Contains(patch, s => s!["path"]!.ToString() == "/ops/1/parent" && s["value"]!.ToString() == "IServerAction:T16Existing");
        Assert.Equal("[1,2]", collision["dependents"]!.ToJsonString());
        // Never proven: the patch is one of two ways out.
        Assert.Null(collision["patchProven"]);
        Assert.DoesNotContain("proven", collision["fix"]!.ToString());
        // Under the patch, op 1 creates an input the existing action already has: conditional on the patch, said under the
        // collision, never a problem of its own; the other name makes it fine.
        var conditional = (collision["conditional"] as JsonArray ?? []).OfType<JsonObject>().ToList();
        Assert.True(conditional.Any(c => c["if"]!.ToString() == JobRunner.UseExisting && c["op"]!.GetValue<int>() == 1 && c["code"]!.ToString() == "NAME_COLLISION"), Show(problems));
        Assert.DoesNotContain(problems, p => p["op"]?.GetValue<int>() is 1 or 2);
        // The independent fault is the job's own.
        Assert.Contains(problems, p => p["code"]!.ToString() == "REFERENCE_UNRESOLVED" && p["op"]!.GetValue<int>() == 3);
        Assert.DoesNotContain(Warnings(error!), w => w["code"]?.ToString() == "APPLY_SKIPPED" && w["message"]!.ToString().Contains("failed op #0"));
        Assert.False(File.Exists(output));
    }

    /// <summary>Review of e10ecacc, R4: dependents that fail only under the patch (the input the existing action has, a second
    /// Start and End in its flow) are conditional on the patch, never problems of the job, and the patch is never called proven;
    /// the other way out (another name) is accepted.</summary>
    [Fact]
    public void DependentsThatFailOnlyUnderThePatchAreConditionalAndTheOtherNameIsAccepted()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var ops = """
            [{"op":"create","parent":"@espace","type":"IServerAction","name":"T16Existing","as":"$a"},
             {"op":"create","parent":"$a","type":"IInputParameter","name":"Amount","as":"$x"},
             {"op":"set","target":"$x","prop":"DataType","value":"Text"},
             {"op":"create","parent":"$a","type":"IStartNode","as":"$s"},
             {"op":"create","parent":"$a","type":"IEndNode","as":"$e"},
             {"op":"link","from":"$s","to":"$e"}]
            """;
        var (_, error, _) = Run(Base(), ops);
        var problems = Problems(error!);
        Assert.True(problems.Count == 1, Show(problems));
        var collision = problems[0];
        Assert.Equal("NAME_COLLISION", collision["code"]!.ToString());
        Assert.Null(collision["patchProven"]);
        Assert.DoesNotContain("proven", collision["fix"]!.ToString());
        var conditional = (collision["conditional"] as JsonArray ?? []).OfType<JsonObject>().ToList();
        Assert.True(conditional.Count > 0, Show(problems));
        Assert.All(conditional, c => Assert.Equal(JobRunner.UseExisting, c["if"]!.ToString()));
        var (renamed, renamedError, _) = Run(Base(), ops.Replace("\"T16Existing\"", "\"T16Other\""));
        Assert.True(renamedError == null, renamedError?.ToString());
        Assert.True(renamed!["accepted"]!.GetValue<bool>());
    }

    [Fact]
    public void ADependentFaultUnderBothChoicesIsTheJobsOwn()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        // An input whose default reads a name nothing declares: wrong whatever the action is.
        var (_, error, _) = Run(Base(), """
            [{"op":"create","parent":"@espace","type":"IServerAction","name":"T16Existing","as":"$a"},
             {"op":"create","parent":"$a","type":"IInputParameter","name":"Extra","as":"$x"},
             {"op":"set","target":"$x","prop":"DataType","value":"Integer"},
             {"op":"set","target":"$x","prop":"DefaultValue","value":"T16NothingNamedSo + 1"}]
            """);
        var problems = Problems(error!);
        var own = problems.Where(p => p["op"]?.GetValue<int>() is 1 or 2 or 3).ToList();
        Assert.True(own.Count > 0, Show(problems));
        Assert.All(own, p => Assert.True(p["bothChoices"]?.GetValue<bool>() == true || p["phase"]?.ToString() is "preflight" or "base", p.ToJsonString()));
    }

    /// <summary>Review of e10ecacc, R2: the job deletes the parent, makes it again and names it by its name (not by alias): the
    /// base's parent is not what the create runs under, so no base collision (the base accepts the job).</summary>
    [Fact]
    public void AParentDeletedAndMadeAgainThenNamedByItsNameIsNoBaseCollision()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var (result, error, _) = Run(Base(), """
            [{"op":"delete","target":"IStructure:T16Shape","force":true},
             {"op":"create","parent":"@espace","type":"IStructure","name":"T16Shape","as":"$st"},
             {"op":"create","parent":"IStructure:T16Shape","type":"IStructureAttribute","name":"Code"},
             {"op":"set","target":"IStructure:T16Shape/Code","prop":"DataType","value":"Text"}]
            """);
        Assert.True(error == null, error == null ? null : Show(Problems(error)));
        Assert.True(result!["accepted"]!.GetValue<bool>(), result.ToJsonString());
    }

    [Fact]
    public void AParentRenamedThenMadeAgainByItsNameIsNoBaseCollision()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var (result, error, _) = Run(Base(), """
            [{"op":"rename","target":"IStructure:T16Shape","name":"T16ShapeOld"},
             {"op":"create","parent":"@espace","type":"IStructure","name":"T16Shape","as":"$st"},
             {"op":"create","parent":"IStructure:T16Shape","type":"IStructureAttribute","name":"Code"},
             {"op":"set","target":"IStructure:T16Shape/Code","prop":"DataType","value":"Text"}]
            """);
        Assert.True(error == null, error == null ? null : Show(Problems(error)));
        Assert.True(result!["accepted"]!.GetValue<bool>(), result.ToJsonString());
    }

    [Fact]
    public void AChildDeletedFirstByItsNameIsNoBaseCollision()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var (result, error, _) = Run(Base(), """
            [{"op":"delete","target":"IStructure:T16Shape/Code","force":true},
             {"op":"create","parent":"IStructure:T16Shape","type":"IStructureAttribute","name":"Code","as":"$c"},
             {"op":"set","target":"$c","prop":"DataType","value":"Text"}]
            """);
        Assert.True(error == null, error == null ? null : Show(Problems(error)));
        Assert.True(result!["accepted"]!.GetValue<bool>(), result.ToJsonString());
    }

    /// <summary>Review of e10ecacc, R3b: the If after the node loops back to it and its condition reads the node's output: that
    /// use is no connector, so reconnect:true is not offered, and the fix never says a patch it does not carry.</summary>
    [Fact]
    public void AnExpressionThatReadsTheNodeIsNoConnectorAndGetsNoReconnectPatch()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var (_, built, loop) = Run(null, """
            [{"op":"create","parent":"@espace","type":"IServerAction","name":"RvCallee","as":"$c"},
             {"op":"create","parent":"$c","type":"IOutputParameter","name":"Out","as":"$co"},
             {"op":"set","target":"$co","prop":"DataType","value":"Integer"},
             {"op":"create","parent":"$c","type":"IStartNode","as":"$cs"},
             {"op":"create","parent":"$c","type":"IEndNode","as":"$ce"},
             {"op":"link","from":"$cs","to":"$ce"},
             {"op":"create","parent":"@espace","type":"IServerAction","name":"RvLoop","as":"$a"},
             {"op":"create","parent":"$a","type":"IStartNode","as":"$s"},
             {"op":"create","parent":"$a","type":"IExecuteServerActionNode","name":"Call","as":"$call"},
             {"op":"set","target":"$call","prop":"Action","value":"IServerAction:RvCallee"},
             {"op":"create","parent":"$a","type":"IIfNode","name":"Again","as":"$if"},
             {"op":"set","target":"$if","prop":"Condition","value":"Call.Out < 3"},
             {"op":"create","parent":"$a","type":"IEndNode","as":"$e"},
             {"op":"link","from":"$s","to":"$call"},
             {"op":"link","from":"$call","to":"$if"},
             {"op":"link","from":"$if","connector":"TrueTarget","to":"$call"},
             {"op":"link","from":"$if","connector":"FalseTarget","to":"$e"}]
            """);
        Assert.True(built == null, built?.ToString());
        var (_, error, _) = Run(loop, """[{"op":"delete","target":"IServerAction:RvLoop/#IExecuteServerActionNode"}]""");
        var problems = Problems(error!).Where(p => p["code"]!.ToString() == "DELETE_HAS_CONSUMERS").ToList();
        Assert.NotEmpty(problems);
        Assert.All(problems, p => {
            Assert.Null(p["patch"]);
            Assert.NotEqual(JobRunner.DeleteReconnects, p["patchRule"]?.ToString());
            Assert.DoesNotContain("the patch", p["fix"]!.ToString());
        });
    }

    [Fact]
    public void ACreateThatAlsoWritesArgumentsOrWhoseAliasATextUsesHasNoPatchAndItsDependentsStaySkipped()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        // An alias also written inside the data of another op: a reference rewrite cannot reach it, so no patch is certain.
        var ops = """
            [{"op":"create","parent":"@espace","type":"IServerAction","name":"T16Existing","as":"$a"},
             {"op":"create","parent":"$a","type":"IInputParameter","name":"Extra","as":"$x"},
             {"op":"set","target":"$x","prop":"Description","value":"named after $a"}]
            """;
        var (_, error, _) = Run(Base(), ops);
        var collisions = Problems(error!).Where(p => p["code"]!.ToString() == "NAME_COLLISION").ToList();
        Assert.True(collisions.Count == 1, Show(Problems(error!)));
        var collision = collisions[0];
        Assert.Equal("base", collision["phase"]!.ToString());
        Assert.Null(collision["patch"]);
        Assert.Contains("no patch", collision["fix"]!.ToString());
        // Never a second NAME_COLLISION of the apply for the same create (the base one stands for it).
        Assert.Single(Problems(error!), p => p["code"]!.ToString() == "NAME_COLLISION");
    }

    [Fact]
    public void ACreateOfANameTheJobDeletesFirstIsNoCollision()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var (result, error, _) = Run(Base(), """
            [{"op":"delete","target":"IStructure:T16Shape","force":true},
             {"op":"create","parent":"@espace","type":"IStructure","name":"T16Shape","as":"$st"},
             {"op":"create","parent":"$st","type":"IStructureAttribute","name":"Code","as":"$sa"},
             {"op":"set","target":"$sa","prop":"DataType","value":"Text"}]
            """);
        if (error != null) Assert.DoesNotContain(Problems(error), p => p["code"]!.ToString() == "NAME_COLLISION" && p["phase"]!.ToString() == "base");
        else Assert.True(result!["accepted"]!.GetValue<bool>(), result.ToJsonString());
    }

    /// <summary>The generated sweep: every named element of the base (read from the native model by a dump, never listed by
    /// hand) that is no widget and no flow node becomes a create of its type and name under its parent, followed by a read of
    /// its alias. Each is refused once, at the base, with a certain patch; the job with the patch applied is accepted in the
    /// next round.</summary>
    [Fact]
    public void EveryNamedElementOfTheBaseCreatedAgainIsRefusedOnceAndItsPatchIsAcceptedNextRound()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var (dumped, dumpError, _) = Run(Base(), """[{"op":"dump","target":"@espace","depth":2}]""");
        Assert.True(dumpError == null, dumpError?.ToString());
        var tree = dumped!["results"]![0]!["result"] as JsonObject;
        Assert.True(tree != null, dumped["results"]!.ToJsonString()[..Math.Min(3000, dumped["results"]!.ToJsonString().Length)]);
        var cases = new List<(string Parent, string Type, string Name)>();
        void Walk(JsonObject node, string parentRef, int depth)
        {
            foreach (var child in (node["children"] as JsonArray ?? []).OfType<JsonObject>())
            {
                var name = child["name"]?.ToString();
                var iface = child["iface"]?.ToString()?.Split('.').Last();
                if (!string.IsNullOrEmpty(name) && iface is { Length: > 1 } && !Regex.IsMatch(iface, "(Widget|Node|Connector|Assignment)$")
                    && (parentRef == "@espace" ? name.StartsWith("T16", StringComparison.Ordinal) : true))
                    cases.Add((parentRef, iface, name));
                if (depth > 1 && child["key"]?.ToString() is { Length: > 0 } key && name?.StartsWith("T16", StringComparison.Ordinal) == true) Walk(child, "@" + key, depth - 1);
            }
        }
        Walk(tree, "@espace", 2);
        // The action, the structure, their inputs, outputs and attributes: at least those the base was built with.
        Assert.True(cases.Count >= 5, string.Join(", ", cases));
        log.WriteLine($"{cases.Count} generated cases: " + string.Join(", ", cases.Select(c => c.Type + ":" + c.Name)));
        foreach (var (parent, type, name) in cases)
        {
            var ops = new JsonArray(
                new JsonObject { ["op"] = "create", ["parent"] = parent, ["type"] = type, ["name"] = name, ["as"] = "$t16" },
                new JsonObject { ["op"] = "get", ["target"] = "$t16" }).ToJsonString();
            var (_, error, _) = Run(Base(), ops);
            Assert.True(error != null, $"{type} {name} under {parent}: accepted, but the base has it");
            Assert.True(Errors.FindCoded(error) != null, $"{type} {name} under {parent}: {error}");
            var problems = Problems(error);
            var collision = Assert.Single(problems, p => p["code"]!.ToString() == "NAME_COLLISION");
            Assert.Equal("base", collision["phase"]!.ToString());
            Assert.True(collision["patch"] is JsonArray { Count: > 0 } && collision["patchRule"]?.ToString() == JobRunner.CreateUsesExisting, $"{type} {name}: {collision.ToJsonString()}");
            Assert.Single(problems);
            var (again, secondError, _) = Run(Base(), Patched(ops, problems));
            Assert.True(secondError == null, $"{type} {name}: the patched job was refused: {secondError}");
            Assert.True(again!["accepted"]!.GetValue<bool>(), again.ToJsonString());
        }
    }

    // ---- rule 5: a delete refused for its consumers ------------------------------------------------------------------------

    [Fact]
    public void ADeleteOfAOneExitStepCarriesReconnectAndThePatchedJobIsAccepted()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var ops = """[{"op":"delete","target":"IServerAction:T16Existing/#IAssignNode"}]""";
        var (_, error, _) = Run(Base(), ops);
        var problems = Problems(error!);
        Assert.True(Errors.FindCoded(error!)!.Code == "DELETE_HAS_CONSUMERS", Show(problems));
        Assert.True(problems.All(p => p["patchRule"] != null), Show(problems));
        Assert.All(problems, p => {
            Assert.Equal("DELETE_HAS_CONSUMERS", p["code"]!.ToString());
            Assert.Equal(JobRunner.DeleteReconnects, p["patchRule"]!.ToString());
            Assert.False(p["patchCertain"]!.GetValue<bool>(), p.ToJsonString());
            Assert.DoesNotContain("the patch", p["fix"]!.ToString());
            Assert.Equal("""[{"op":"add","path":"/ops/0/reconnect","value":true}]""", p["patch"]!.ToJsonString());
        });
        var (again, secondError, _) = Run(Base(), Patched(ops, problems));
        Assert.True(secondError == null, secondError?.ToString());
        Assert.True(again!["accepted"]!.GetValue<bool>(), again.ToJsonString());
    }

    [Fact]
    public void ADeleteWithoutOneExitOrWithOtherConsumersHasNoReconnectPatch()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        // The End node has no exit: reconnect would be refused; the author chooses (the fix says how), never a wrong patch.
        var (_, error, _) = Run(Base(), """[{"op":"delete","target":"IServerAction:T16Existing/#IEndNode"}]""");
        var problems = Problems(error!);
        Assert.Contains(problems, p => p["code"]!.ToString() == "DELETE_HAS_CONSUMERS");
        Assert.All(problems.Where(p => p["code"]!.ToString() == "DELETE_HAS_CONSUMERS"), p => { Assert.Null(p["patch"]); Assert.False(string.IsNullOrEmpty(p["fix"]?.ToString())); });
        // An input read by an expression: its consumer is no connector.
        var (_, input, _) = Run(Base(), """[{"op":"delete","target":"IServerAction:T16Existing/Amount"}]""");
        if (input != null && Errors.FindCoded(input) is { } coded)
            Assert.All((coded.Problems ?? []).OfType<JsonObject>().Where(p => p["code"]?.ToString() == "DELETE_HAS_CONSUMERS"), p => Assert.Null(p["patch"]));
    }

    // ---- rule 3: one problem, once -----------------------------------------------------------------------------------------

    [Fact]
    public void AnUnknownKeyOfTheTextFormIsOneProblemAtItsOwnPlaceNotOnePerPhase()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var (_, error, _) = Run(null, """[{"op":"logic","data":{"flow":["server action T16Flow\n  end\n"],"removes":["x"],"extra":1}}]""");
        var problems = Problems(error!).Where(p => p["code"]!.ToString() == "FLOW_SYNTAX").ToList();
        Assert.True(problems.Count == 2, Show(problems));
        Assert.Contains(problems, p => p["pointer"]!.ToString() == "/ops/0/data/removes");
        Assert.Contains(problems, p => p["pointer"]!.ToString() == "/ops/0/data/extra");
        Assert.DoesNotContain(problems, p => p["pointer"]!.ToString().EndsWith("/data/data", StringComparison.Ordinal));
    }

    // ---- L1-L3 in every preflight ------------------------------------------------------------------------------------------

    private static string Html(string document) => new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = document } }.ToJsonString();
    private static string Logic(string text) => new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray(text) } }.ToJsonString();

    [Fact]
    public void TheScopeRulesOfLogicTextsAgainstTheScreensOfTheJobRunInThePurePreflight()
    {
        var ops = new JsonArray(JsonNode.Parse(Html("<screen name=\"Fleet\" actions=\"Pick\" data-actions=\"LoadBikes\"><input name=\"StationId\" type=\"Long Integer\"/><var name=\"ErrorMessage\" type=\"Text\"/><var name=\"ErrorText\" type=\"Text\"/></screen>")),
            JsonNode.Parse(Logic("data action Fleet.LoadBikes\n  out Total: Integer\n  out ErrorText: Text\n  assign\n    Total = 1\n  end\n  on exception All Exceptions:\n    assign\n      ErrorMessage = \"x\"\n    end\n"
                + "\naction Fleet.Pick\n  in StationId: Long Integer\n  assign ErrorMessage = \"\"\n  end\n")));
        var analysis = JobPreflight.Analyze(ops, new JsonObject { ["ops"] = ops.DeepClone() });
        var problems = analysis["problems"]!.AsArray().OfType<JsonObject>().ToList();
        Assert.False(analysis["valid"]!.GetValue<bool>());
        Assert.Contains(problems, p => p["code"]!.ToString() == "EXPR_UNKNOWN_IDENTIFIER" && p["message"]!.ToString().Contains("ErrorMessage") && p["phase"]!.ToString() == "preflight");
        Assert.Contains(problems, p => p["code"]!.ToString() == "NAME_COLLISION" && p["message"]!.ToString().Contains("output 'ErrorText'"));
        Assert.Contains(problems, p => p["code"]!.ToString() == "NAME_COLLISION" && p["message"]!.ToString().Contains("input 'StationId'"));
        // A job that expects an invalid module asks the Verify: the rules that predict it do not run.
        var invalid = JobPreflight.Analyze(ops, new JsonObject { ["expectValid"] = false, ["ops"] = ops.DeepClone() });
        Assert.DoesNotContain(invalid["problems"]!.AsArray().OfType<JsonObject>(), p => p["code"]!.ToString() == "EXPR_UNKNOWN_IDENTIFIER" && p["message"]!.ToString().Contains("ErrorMessage"));
        // The static check with an index says each of them once more only when it is new (the same op, pointer, code, message).
        var statics = StaticChecks.Run(ops, "/ops", "o11", new StaticBasis(), problems);
        Assert.DoesNotContain(statics.Problems, p => p["code"]!.ToString() is "NAME_COLLISION" or "EXPR_UNKNOWN_IDENTIFIER");
    }

    [Fact]
    public void AJobWhoseLogicFitsItsScreensGetsNoScopeProblem()
    {
        var ops = new JsonArray(JsonNode.Parse(Html("<screen name=\"Fleet\" data-actions=\"LoadBikes\"><var name=\"ErrorMessage\" type=\"Text\"/></screen>")),
            JsonNode.Parse(Logic("data action Fleet.LoadBikes\n  out Total: Integer\n  assign\n    Total = 1\n  end\n")));
        var problems = JobPreflight.Analyze(ops, new JsonObject { ["ops"] = ops.DeepClone() })["problems"]!.AsArray().OfType<JsonObject>();
        Assert.DoesNotContain(problems, p => p["code"]!.ToString() is "NAME_COLLISION" or "EXPR_UNKNOWN_IDENTIFIER");
    }

    // ---- rule 6: every fix text is English ---------------------------------------------------------------------------------

    // Words of Portuguese that never occur in the English of a fix (accents dropped as the catalogs wrote them).
    private static readonly Regex Portuguese = new(@"\b(nao|não|uma|um|ou|que|para|com|sem|da|das|dos|na|nas|nos|ao|aos|pelo|pela|mensagem|elemento|propriedade|obrigatori[oa]|corrigir|preencher|ligar|usar|remover|adicionar|marcar|apagar|criar|definir|trocar|mudar|garantir|verificar|tela|acao|ação|funcao|função|curada|codigo|código|texto|nada|antes|depois|quando|onde|tipo|valor|campo|entidade|atributo|expressao|expressão)\b", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /// <summary>The sweep over every hint and origin of every Verify hints catalog of the kernel and every reason of the patch
    /// certainty rules: English only (the owner's rule: every text SSAM emits).</summary>
    [Fact]
    public void EveryVerifyHintAndEveryPatchReasonIsEnglish()
    {
        var files = Directory.GetFiles(Path.Combine(Root, "catalog"), "verify-hints-*.json");
        Assert.NotEmpty(files);
        var offenders = new List<string>();
        foreach (var file in files)
            foreach (var item in JsonNode.Parse(File.ReadAllText(file))!.AsArray().OfType<JsonObject>())
                foreach (var field in new[] { "hint", "origin" })
                    if (item[field]?.ToString() is { } text && (Portuguese.IsMatch(text) || text.Any(c => "ãõçáéíóúâêô".Contains(char.ToLowerInvariant(c)))))
                        offenders.Add($"{Path.GetFileName(file)} {item["id"]}.{field}: {text}");
        foreach (var (rule, value) in PatchCertainty.Rules)
            if (Portuguese.IsMatch(value.Reason)) offenders.Add($"PatchCertainty {rule}: {value.Reason}");
        Assert.True(offenders.Count == 0, string.Join(Environment.NewLine, offenders));
        // Each catalog entry keeps its id and a hint (the translation dropped nothing).
        foreach (var file in files)
            Assert.All(JsonNode.Parse(File.ReadAllText(file))!.AsArray().OfType<JsonObject>(), item => { Assert.False(string.IsNullOrWhiteSpace(item["id"]?.ToString())); Assert.False(string.IsNullOrWhiteSpace(item["hint"]?.ToString())); });
    }

    [Fact]
    public void TheNewPatchRulesAreChoicesWithTheirReason()
    {
        // Both are offered in the first refusal and proven by its round, and neither is ever applied for the author (auto patch).
        foreach (var rule in new[] { JobRunner.CreateUsesExisting, JobRunner.DeleteReconnects })
        {
            Assert.True(PatchCertainty.Rules.TryGetValue(rule, out var known), rule);
            Assert.False(known!.Certain);
            Assert.False(string.IsNullOrWhiteSpace(known.Reason));
        }
    }
}
