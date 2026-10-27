using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// The numbered native call of a JSON logic action (Verbs.LogicNames.cs, review of 3ab12209, finding 2). The rewrite of the
/// references to a call the platform numbered is the Traditional rule only (a node of another flow of the same screen or
/// block has the name: Preparation and screen actions share one naming scope). When an element of the call's scope holds
/// the name (a variable, input or widget of its screen, an element of the module), the JSON form refuses it like the text
/// form, FLOW_NODE_NAME_TAKEN naming both, never rewritten. A rewrite of a node's name never touches a call of a function
/// of that name. Real jobs through JobRunner on the O11 fixtures; the ODC lane runs the shared scenario in CompositionOdcTests.
/// </summary>
public sealed class NativeCallLogicNamesTests
{
    private static string Dir(string area)
    {
        var dir = Path.Combine(PacoteBPolicyTests.FindRoot(), ".local", "native-call-names", area, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static string Job(string dir, string fixture, JsonArray ops)
    {
        var path = Path.Combine(dir, "job.json");
        File.WriteAllText(path, new JsonObject { ["base"] = fixture, ["ops"] = ops }.ToJsonString());
        return path;
    }

    private static List<JsonObject> Refused(string dir, string job)
    {
        var error = Assert.ThrowsAny<Exception>(() => JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, job, Path.ChangeExtension(job, ".oml")));
        var coded = Errors.FindCoded(error);
        Assert.True(coded != null, Errors.Text(error));
        return (coded!.Problems ?? new JsonArray()).OfType<JsonObject>().Where(p => p["severity"]?.ToString() != "warning").ToList();
    }

    private const string ReadName = "client action ReadName\n  out Name: Text\n  assign Name = \"x\"\n  end";

    // The reviewer's two repros on the Reactive fixture: the screen Login has the variable Username, and a screen action
    // calls ReadName naming the call Username. The JSON form wrote Username2 and rewrote Username.Name to Username2.Name.
    [Theory]
    [InlineData("json")]
    [InlineData("text")]
    public void ACallNamedLikeAScreenVariableIsRefusedOnBothForms(string form)
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Dir("repro-" + form);
        var probe = form == "json"
            ? JsonNode.Parse("""
                {"op":"logic","data":{"actions":[{"name":"ProbeAct","kind":"screen","owner":"IMobileScreen:Login","steps":[
                  {"call":"ReadName","as":"Username"},
                  {"assign":{"Password":"Username.Name"}}]}]}}
                """)!
            : new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = "action Login.ProbeAct\n  Username = ReadName()\n  assign Password = Username.Name\n  end" } };
        var problems = Refused(dir, Job(dir, "reactive-ui.oml", [new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = ReadName } }, probe]));
        var context = string.Join("\n", problems.Select(p => p.ToJsonString()));
        var taken = problems.SingleOrDefault(p => p["code"]?.ToString() == "FLOW_NODE_NAME_TAKEN");
        Assert.True(taken != null, context);
        Assert.Equal(("Username", "Username2"), (taken!["node"]!.ToString(), taken["given"]!.ToString()));
        Assert.Contains("LocalVariable Username of Login", taken["holder"]!.ToString());
        Assert.Equal(form == "json" ? "/ops/1/data/actions/0/steps/0/as" : "/ops/1/data/flow", taken["pointer"]!.ToString());
        Assert.DoesNotContain("LOGIC_NATIVE_CALL_RENAMED", context);
    }

    // The same rule for a variable and a widget of the screen, on the JSON and the text form (the shared scenario, also run
    // on the ODC lane).
    [Fact]
    public void ACallNamedLikeItsScopeIsRefusedOnTheJsonAndTheTextForm()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        CompositionScenarios.ACallNamedLikeItsScopeIsRefusedOnTheJsonAndTheTextForm(Dir("scope"), "reactive-ui.oml", "o11");
    }

    // The Traditional case the rename was written for still renames (TraditionalPreparationScopeTests has the cascade
    // Loaded -> Loaded2 -> Loaded3), and the rewrite leaves a call of a built-in function of the node's name alone: the
    // Preparation call Index is numbered Index2 (the screen action Reload has a node Index); Index.Caption reads Index2,
    // Index("abc", "b") stays the built-in function.
    [Fact]
    public void TheTraditionalRenameLeavesACallOfAFunctionOfThatNameAlone()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        StudioAssemblies.Bind();
        var dir = Dir("traditional-call");
        var ops = new JsonArray(
            new JsonObject { ["op"] = "logic", ["data"] = new JsonObject {
                ["flow"] = "server action ReadCaption\n  in Prefix: Text\n  out Caption: Text\n  assign Caption = Prefix + \" value\"\n  end" } },
            new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = """
                <screen name="GuardScope" roles="Registered" actions="Reload">
                 <var name="Initial" type="Text"/><var name="Current" type="Text"/>
                 <div>{{ Initial }}</div><div id="Result">{{ Current }}</div>
                 <button onclick="Reload" method="Ajax" validation="None">Reload</button>
                </screen>
                """ } },
            new JsonObject { ["op"] = "logic", ["data"] = new JsonObject {
                ["flow"] = "action GuardScope.Reload\n  Index = ReadCaption(Prefix=\"reload\")\n  assign Current = Index.Caption\n  node AjaxRefreshNode()\n    @{WidgetOrWebBlock=&\"Result\"}\n  end" } },
            JsonNode.Parse("""
                {"op":"logic","data":{"actions":[{"name":"Preparation","kind":"preparation","owner":"IWebScreen:GuardScope","steps":[
                  {"call":"ReadCaption","as":"Index","args":{"Prefix":"\"initial\""}},
                  {"assign":{"Initial":"Index.Caption + IntegerToText(Index(\"abc\", \"b\"))"}}]}]}}
                """));
        var job = Job(dir, "traditional-ui.oml", ops);
        var host = new ModelHost(Path.Combine(dir, "work"));
        var candidate = Path.ChangeExtension(job, ".oml");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, null, job, candidate))!;
        Assert.True(result["accepted"]?.GetValue<bool>() == true, result["details"]?.ToJsonString());
        Assert.Contains("LOGIC_NATIVE_CALL_RENAMED", result["normalizations"]!.ToJsonString());
        host.WithSession(candidate, session => {
            Assert.Equal("Index2.Caption + IntegerToText(Index(\"abc\", \"b\"))",
                ModelHost.Prop(ModelHost.Prop(session.Resolve("IWebScreen:GuardScope/Preparation/Assign1/#IAssignment"), "Value")!, "Text")!.ToString());
            Assert.Equal("Index.Caption", ModelHost.Prop(ModelHost.Prop(session.Resolve("IWebScreen:GuardScope/Reload/#IAssignNode/#IAssignment"), "Value")!, "Text")!.ToString());
            return true;
        });
    }

    // The rewrite itself, on both forms: the JSON form's (FlowEdits.RenamedNode outside fields) and the text form's
    // (FlowExactness.AdoptNodeNames): the node's references follow, a call of a function of that name, a field name and a
    // text literal never do.
    [Fact]
    public void ARewriteOfANodeNameNeverTouchesACallOfAFunctionOfThatName()
    {
        Assert.Equal("Got2.Value + Got(1) + Got (2) + Length(\"Got.Value\")",
            FlowEdits.RenamedNode("Got.Value + Got(1) + Got (2) + Length(\"Got.Value\")", "Got", "Got2", outsideFields: true));
        Assert.Equal("{ Got: Got2.Value }", FlowEdits.RenamedNode("{ Got: Got.Value }", "Got", "Got2", outsideFields: true));
        Assert.Equal("Other.Got + Got2.Value", FlowEdits.RenamedNode("Other.Got + got.Value", "Got", "Got2"));
        const string text = "/// Doubles.\nserver action CmpX @A1\n  out Total: Integer @p2\n  Got = CmpOne() @n1\n  assign Total = Got.Value + Got(2) @n5\n  end @n4\n";
        var expected = ModuleFlow.Read(text);
        var read = ModuleFlow.Read(text.Replace("Got = CmpOne()", "Got2 = CmpOne()").Replace("Got.Value", "Got2.Value"));
        var adopted = Assert.Single(FlowExactness.AdoptNodeNames(expected, read, _ => null));
        Assert.Equal(("Got", "Got2"), (adopted.Asked, adopted.Given));
        Assert.Contains("Got2.Value + Got(2)", expected.Canon());
        Assert.DoesNotContain("Got2(2)", expected.Canon());
    }
}
