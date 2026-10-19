using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Preflight;
using Xunit;

namespace Anvil.Tests;

public sealed class VerifySourcePatchTests
{
    [Theory]
    [InlineData("Open(Id=Rows.Current.Id)", "Id", "Rows.Current.Id")]
    [InlineData("Open(Id = Rows.Current.Id)", "Id", "Rows.Current.Id")]
    [InlineData("Open( Id\t=\tRows.Current.Id )", "Id", "Rows.Current.Id ")]
    [InlineData("Open(Flag=If(Value = 1, True, False))", "Flag", "If(Value = 1, True, False)")]
    public void NamedEventArgumentsDoNotBecomeEqualityExpressions(string call, string parameter, string value)
    {
        Assert.True(ScreenDocument.ParseCall(call, out var destination, out var arguments));
        Assert.Equal("Open", destination);
        var argument = Assert.Single(arguments);
        Assert.Equal(parameter, argument.Param);
        Assert.Equal(value, argument.Value);
    }

    [Fact]
    public void AParenthesizedEqualityRemainsAPositionalArgument()
    {
        Assert.True(ScreenDocument.ParseCall("Open((Value = 1))", out _, out var arguments));
        var argument = Assert.Single(arguments);
        Assert.Null(argument.Param);
        Assert.Equal("(Value = 1)", argument.Value);
    }

    [Fact]
    public void ASuccessfulPatchRoundReportsItsVerifyEvenWhenItAddsNoProblem()
    {
        var problem = new JsonObject { ["code"] = "HTML_INVALID", ["op"] = 0, ["phase"] = "apply", ["message"] = "a literal is required" };
        var refusal = new JobPreflightException("original refusal", new JsonArray(problem)) {
            VerifyRan = false, VerifyReason = "initial apply was incomplete", Phases = ["preflight", "base", "apply"] };
        var originalNote = JobNormalizer.Entry("ORIGINAL_NORMALIZATION", "/ops/0/data/ddl", "before", "after", "original");
        Errors.AttachNormalizations(refusal, new JsonArray(originalNote));
        var flags = System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance;
        var probeType = typeof(JobRunner).GetNestedType("Probe", System.Reflection.BindingFlags.NonPublic)!;
        var probe = Activator.CreateInstance(probeType, true)!;
        probeType.GetField("Execution", flags)!.SetValue(probe, new JsonObject { ["verifyRan"] = true,
            ["phases"] = new JsonArray("preflight", "base", "apply", "verify") });
        probeType.GetField("OpsPointer", flags)!.SetValue(probe, "/ops");
        probeType.GetField("Original", flags)!.SetValue(probe, new JsonArray { null, null, null,
            new JsonObject { ["data"] = new JsonObject { ["flow"] = new JsonArray("dropped", "kept") } } });
        probeType.GetField("Texts", flags)!.SetValue(probe, new Dictionary<int, List<(int Original, bool Changed, string Text, string? Before)>> {
            [3] = [(1, false, "kept", "kept")] });
        probeType.GetField("Normalizations", flags)!.SetValue(probe, new JsonArray(originalNote.DeepClone(),
            JobNormalizer.Entry("LATE_NORMALIZATION", "/ops/3/data/flow/0/text", "raw", "normalized", "round only")));
        var merge = typeof(JobRunner).GetMethod("Merge", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)!;
        var merged = Assert.IsType<JobPreflightException>(merge.Invoke(null, [refusal, refusal, new List<JsonObject> { problem }, probe, "/ops", null]));
        Assert.Equal("original refusal", merged.Message);
        Assert.True(merged.VerifyRan);
        Assert.Null(merged.VerifyReason);
        Assert.Equal(new[] { "preflight", "base", "apply", "verify" }, merged.Phases);
        Assert.Single(merged.Problems);
        var notes = Errors.Normalizations(merged)!;
        Assert.Equal(2, notes.Count);
        Assert.Null(notes[0]!["afterPatch"]);
        Assert.Equal("/ops/3/data/flow/1/text", notes[1]!["path"]!.ToString());
        Assert.True(notes[1]!["afterPatch"]!.GetValue<bool>());
    }

    [Fact]
    public void MissingArgumentsAreInsertedAtTheParsedCallAndKeepNestedExpressionsAndLabels()
    {
        const string flow = "client action Check\n  Probe = ReadValue(Name=Trim(\"x)y\"))  # Keep\n  end\n";
        var one = VerifySourceEdits.AddFlowArgument(flow, "Probe", "ReadValue", "Reset", "False");
        Assert.Equal(flow.Replace("))  #", "), Reset=False)  #"), one);
        var two = VerifySourceEdits.AddFlowArgument(one!, "Probe", "ReadValue", "Count", "0");
        Assert.Contains("ReadValue(Count=0, Name=Trim(\"x)y\"), Reset=False)  # Keep", two);
        Assert.Null(VerifySourceEdits.AddFlowArgument(two!, "Probe", "ReadValue", "Reset", "False"));
    }

    [Fact]
    public void ACallWithoutArgumentsAndASystemQualifiedCallAreBothLocated()
    {
        const string flow = "server action Check\n  Probe = (System).ReadValue()\n  end\n";
        Assert.Contains("ReadValue(Reset=False)", VerifySourceEdits.AddFlowArgument(flow, "Probe", "ReadValue", "Reset", "False"));
    }

    [Fact]
    public void MultipleMatchingCallsHaveNoCertainSourcePatch()
    {
        const string flow = "client action Check\n  First = ReadValue()\n  Second = ReadValue()\n  end\n";
        Assert.Null(VerifySourceEdits.AddFlowArgument(flow, "", "ReadValue", "Reset", "False"));
    }

    [Fact]
    public void AListValueIsQualifiedOnlyInItsOwnExpressionSpans()
    {
        const string html = "<screen name='S'><div list='Orders'><button onclick='Open(OrderId=OrderId)' title='OrderId'>{{ OrderId }}</button>"
            + "<div list='Other'><span>{{ OrderId }}</span></div><span>{{ \"OrderId\" }}</span></div><p>{{ OrderId }}</p></screen>";
        var patched = VerifySourceEdits.QualifyListValue(html, "Orders", "OrderId", "Id");
        Assert.NotNull(patched);
        Assert.Contains("Open(OrderId=Orders.Current.Id)", patched);
        Assert.Contains("title='OrderId'>{{ Orders.Current.Id }}", patched);
        Assert.Contains("list='Other'><span>{{ OrderId }}", patched);
        Assert.Contains("{{ \"OrderId\" }}", patched);
        Assert.Contains("<p>{{ OrderId }}</p>", patched);
        Assert.Null(VerifySourceEdits.QualifyListValue("<div list='Orders'/><div list='Orders'/>", "Orders", "OrderId", "Id"));
    }

    [Theory]
    [InlineData("Boolean", "False")]
    [InlineData("Text", "\"\"")]
    [InlineData("Long Integer", "0")]
    [InlineData("Order Identifier", "NullIdentifier()")]
    [InlineData("UnknownRecord", null)]
    public void OnlyKnownTypeDefaultsAreOffered(string type, string? expected)
        => Assert.Equal(expected, VerifySourceEdits.TypeDefault(type));

    [Fact]
    public void RequiredInputDefaultsProduceOneCombinedPatchForTheFlowItem()
    {
        try { StudioAssemblies.Bind(); } catch { return; }
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(VerifySourcePatchTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "verify-source-patch-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var job = JsonNode.Parse("""
            {"base":"blank-service.oml","expectValid":true,"autoPatch":false,"ops":[
              {"op":"logic","data":{"actions":[{"name":"ReadValue","inputs":[{"name":"Reset","type":"Boolean","default":"False"},{"name":"Count","type":"Integer","default":"0"}],"outputs":[{"name":"Result","type":"Boolean"}],"steps":[{"assign":{"Result":"Reset and Count > 0"}}]}]}},
              {"op":"logic","data":{"flow":"server action CheckValue public\n  Probe = ReadValue()\n  end\n"}}
            ]}
            """)!.AsObject();
        var file = Path.Combine(work, "job.json");
        File.WriteAllText(file, job.ToJsonString());
        JsonObject? result = null;
        IReadOnlyList<JsonObject> problems;
        try
        {
            result = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(work, "first")), null, file, Path.Combine(work, "first.oml")))!.AsObject();
            problems = result["problems"]!.AsArray().OfType<JsonObject>().ToList();
        }
        catch (Exception error)
        {
            problems = (Errors.FindCoded(error)?.Problems ?? new JsonArray()).OfType<JsonObject>().ToList();
        }
        var required = problems.Where(p => p["code"]?.ToString() == "ArgumentRequiredExpression").ToList();
        File.WriteAllText(Path.Combine(work, "problems.json"), new JsonArray(problems.Select(p => p.DeepClone()).ToArray()).ToJsonString());
        Assert.Equal(2, required.Count);
        Assert.All(required, p => Assert.True(p["patch"] is JsonArray, p.ToJsonString()));
        var patches = required.Select(p => p["patch"]![0]!.AsObject()).ToList();
        Assert.All(patches, p => Assert.Equal("/ops/1/data/flow", p["path"]!.ToString()));
        Assert.Equal(patches[0]["value"]!.ToString(), patches[1]["value"]!.ToString());
        var fixedFlow = patches[0]["value"]!.ToString();
        Assert.Contains("Reset=False", fixedFlow);
        Assert.Contains("Count=0", fixedFlow);
        job["ops"]![1]!["data"]!["flow"] = fixedFlow;
        File.WriteAllText(file, job.ToJsonString());
        result = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(work, "fixed")), null, file, Path.Combine(work, "fixed.oml")))!.AsObject();
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
    }

    [Fact]
    public void APlaceholderPatchRevealsTheDependentFlowVerifyInTheSameRefusal()
    {
        try { StudioAssemblies.Bind(); } catch { return; }
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(VerifySourcePatchTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "verify-source-patch-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var job = JsonNode.Parse("""
            {"base":"reactive-ui.oml","expectValid":true,"autoPatch":false,"ops":[
              {"op":"logic","data":{"actions":[{"name":"ReadFlag","kind":"client","inputs":[{"name":"Reset","type":"Boolean","default":"False"}],"outputs":[{"name":"Result","type":"Boolean"}],"steps":[{"assign":{"Result":"Reset"}}]}]}},
              {"op":"html","data":{"html":"<screen name=\"PatchProbe\" roles=\"Registered\"><var name=\"TextValue\" type=\"Text\"/><input bind=\"TextValue\" placeholder=\"Search for a value\"/></screen>"}},
              {"op":"logic","data":{"flow":"action PatchProbe.LoadFlag\n  Read = ReadFlag()\n  end\n"}}
            ]}
            """)!.AsObject();
        var path = Path.Combine(work, "job.json");
        File.WriteAllText(path, job.ToJsonString());
        List<JsonObject> problems;
        try
        {
            var result = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(work), null, path, Path.Combine(work, "out.oml")))!;
            problems = result["problems"]!.AsArray().OfType<JsonObject>().ToList();
        }
        catch (Exception error) { problems = (Errors.FindCoded(error)?.Problems ?? new JsonArray()).OfType<JsonObject>().ToList(); }
        File.WriteAllText(Path.Combine(work, "problems.json"), new JsonArray(problems.Select(p => p.DeepClone()).ToArray()).ToJsonString());
        Assert.Contains(problems, p => p["code"]?.ToString() == "HTML_INVALID" && p["patch"] is JsonArray);
        var required = Assert.Single(problems, p => p["code"]?.ToString() == "ArgumentRequiredExpression");
        Assert.True(required["afterPatch"]?.GetValue<bool>() == true, required.ToJsonString());
        Assert.Contains("Reset=False", required["patch"]![0]!["value"]!.ToString());
    }

    [Fact]
    public void CompactNamedEventArgumentsKeepTheirValuesThroughTheComposedDocument()
    {
        try { StudioAssemblies.Bind(); } catch { return; }
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(VerifySourcePatchTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "verify-source-patch-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var job = JsonNode.Parse("""
            {"base":"reactive-ui.oml","expectValid":true,"autoPatch":false,"ops":[
              {"op":"spec","data":{"ddl":"type RowValue = { Id: Long Integer; }"}},
              {"op":"html","data":{"html":"<screen name=\"ListProbe\" roles=\"Registered\"><var name=\"Rows\" type=\"RowValue List\"/><var name=\"Query\" type=\"Text\"/><div list=\"Rows\"><button onclick=\"SelectRow(Id=Rows.Current.Id)\">Pick</button></div><input bind=\"Query\" placeholder=\"Search for a row\"/></screen>"}},
              {"op":"logic","data":{"flow":"action ListProbe.SelectRow\n  in Id: Long Integer\n  end\n"}}
            ]}
            """)!.AsObject();
        var path = Path.Combine(work, "job.json");
        File.WriteAllText(path, job.ToJsonString());
        List<JsonObject> problems;
        try
        {
            var result = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(work), null, path, Path.Combine(work, "out.oml")))!;
            problems = result["problems"]!.AsArray().OfType<JsonObject>().ToList();
        }
        catch (Exception error) { problems = (Errors.FindCoded(error)?.Problems ?? new JsonArray()).OfType<JsonObject>().ToList(); }
        File.WriteAllText(Path.Combine(work, "problems.json"), new JsonArray(problems.Select(p => p.DeepClone()).ToArray()).ToJsonString());
        Assert.Contains(problems, p => p["code"]?.ToString() == "HTML_INVALID" && p["patch"] is JsonArray);
        Assert.DoesNotContain(problems, p => p["code"]?.ToString() == "ExpressionUnknownObject");
        Assert.DoesNotContain(problems, p => p["code"]?.ToString() == "HTML_NAME_UNKNOWN");
    }
}
