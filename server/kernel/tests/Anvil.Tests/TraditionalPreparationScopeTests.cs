using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

public class TraditionalPreparationScopeTests(ITestOutputHelper output)
{
    [Fact]
    public void PreparationAndScreenActionKeepIndependentCallOutputs()
    {
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(TraditionalPreparationScopeTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "traditional-preparation-scope", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work); output.WriteLine(work);
        var host = new ModelHost(work);
        var basis = Path.Combine(root, "tests/fixtures/traditional-ui.oml");
        var ops = new JsonArray(new JsonObject { ["op"]="logic", ["data"]=new JsonObject {
            ["flow"]="server action ReadCaption\n  in Prefix: Text\n  out Caption: Text\n  assign Caption = Prefix + \" value\"\n  end"
        } });
        foreach (var screen in new[] { "FirstScope", "SecondScope" }) {
            ops.Add(new JsonObject { ["op"]="html", ["data"]=new JsonObject { ["html"]="""
                <screen name="SCREEN" roles="Registered" actions="Reload">
                 <var name="Initial" type="Text"/><var name="Current" type="Text"/>
                 <div>{{ Initial }}</div><div id="Result">{{ Current }}</div>
                 <button onclick="Reload" method="Ajax" validation="None">Reload</button>
                </screen>
                """.Replace("SCREEN",screen) } });
            ops.Add(new JsonObject { ["op"]="logic", ["data"]=new JsonObject {
                ["flow"]=$"action {screen}.Reload\n  Loaded = ReadCaption(Prefix=\"reload\")\n  assign Current = Loaded.Caption\n  node AjaxRefreshNode()\n    @{{WidgetOrWebBlock=&\"Result\"}}\n  end"
            } });
            ops.Add(JsonNode.Parse("""
                {"op":"logic","data":{"actions":[{"name":"Preparation","kind":"preparation","owner":"IWebScreen:SCREEN","steps":[
                  {"call":"ReadCaption","as":"Loaded","args":{"Prefix":"\"initial\""}},
                  {"call":"ReadCaption","as":"Loaded2","args":{"Prefix":"Loaded.Caption"}},
                  {"assign":{"Initial":"Loaded.Caption + \" | \" + Loaded2.Caption + \" | Loaded.Caption\""}}
                ]}]}}
                """.Replace("SCREEN",screen)));
        }
        var job = Path.Combine(work,"job.json"); var candidate = Path.Combine(work,"candidate.oml");
        File.WriteAllText(job,new JsonObject { ["ops"]=ops }.ToJsonString());
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host,basis,job,candidate))!;
        File.WriteAllText(Path.Combine(work,"result.json"),result.ToJsonString());
        var nodes = host.WithSession(candidate, session => string.Join("\n", new[] { "FirstScope", "SecondScope" }.SelectMany(screen =>
            new[] { "Preparation", "Reload" }.SelectMany(action =>
                ((System.Collections.IEnumerable)ModelHost.Prop(session.Resolve($"IWebScreen:{screen}/{action}"),"Nodes")!).Cast<object>()
                .Select(node => $"{screen}/{action}: {ModelHost.Prop(node,"Name")} ({node.GetType().Name})")))));
        File.WriteAllText(Path.Combine(work,"nodes.txt"),nodes); output.WriteLine(nodes);
        Assert.True(result["accepted"]?.GetValue<bool>() == true,result["details"]?.ToJsonString());
        var merged = Path.Combine(work,"merged.oml");
        Assert.True(MergeProbe.ThreeWay(host,File.ReadAllBytes(basis),File.ReadAllBytes(candidate),merged).LocalIsValid);
        var proof = MergeContentProof.Check(host,candidate,merged);
        File.WriteAllText(Path.Combine(work,"proof.json"),proof.ToJsonString());
        Assert.True(proof["accepted"]!.GetValue<bool>(),proof.ToJsonString());
        host.WithSession(merged, session => {
            foreach (var screen in new[] { "FirstScope", "SecondScope" }) {
                string Expression(string path, string property) => ModelHost.Prop(ModelHost.Prop(session.Resolve(path),property)!,"Text")!.ToString()!;
                Assert.Equal("Loaded2.Caption + \" | \" + Loaded3.Caption + \" | Loaded.Caption\"",
                    Expression($"IWebScreen:{screen}/Preparation/Assign1/#IAssignment","Value"));
                Assert.Equal("Loaded2.Caption", Expression($"IWebScreen:{screen}/Preparation/Loaded3/Prefix","Value"));
                Assert.Equal("Loaded.Caption",Expression($"IWebScreen:{screen}/Reload/#IAssignNode/#IAssignment","Value"));
            }
            return true;
        });
        Assert.Contains("LOGIC_NATIVE_CALL_RENAMED",result["normalizations"]!.ToJsonString());
    }
}
