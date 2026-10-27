using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public class TraditionalControlsParityTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void FilteredComboKeepsListColumnsSpecialValueAndEventAcrossMerge(bool wrapped)
    {
        var (host, root, work) = Setup();
        var basis = Path.Combine(root, "tests", "fixtures", "traditional-ui.oml");
        var ops = JsonNode.Parse("""
          [{"op":"create","parent":"@espace","type":"IServerEntity","name":"Choice","as":"$entity"},
           {"op":"create","parent":"$entity","type":"IEntityAttribute","name":"Id","as":"$id"},
           {"op":"set","target":"$id","prop":"DataType","value":"Long Integer"},
           {"op":"set","target":"$id","prop":"IsAutoNumber","value":"Yes"},
           {"op":"set","target":"$entity","prop":"IdentifierAttribute","value":"$id"},
           {"op":"create","parent":"$entity","type":"IEntityAttribute","name":"Label","as":"$label"},
           {"op":"set","target":"$label","prop":"DataType","value":"Text"}]
          """)!.AsArray();
        if (wrapped) {
            ops.Add(JsonNode.Parse("""{"op":"create","parent":"@espace","type":"IStructure","name":"ChoiceRow","as":"$row"}"""));
            ops.Add(JsonNode.Parse("""{"op":"create","parent":"$row","type":"IStructureAttribute","name":"Choice","as":"$field"}"""));
            ops.Add(JsonNode.Parse("""{"op":"set","target":"$field","prop":"DataType","value":"Choice"}"""));
        }
        ops.Add(Html("""
            <screen name="FilteredChoicesScreen" actions="Changed">
              <var name="Selected" type="Choice Identifier"/>
              <var name="FilteredChoices" type="ROWTYPE List"/>
              <select id="ChoiceInput" bind="Selected" options="FilteredChoices"
                label="Choice.Label" value="Choice.Id" empty='"All choices"'
                class="dropdown" onchange="Changed"/>
            </screen>
            """.Replace("ROWTYPE", wrapped ? "ChoiceRow" : "Choice")));
        ops.Add(new JsonObject { ["op"]="logic", ["data"]=new JsonObject { ["flow"]="action FilteredChoicesScreen.Changed\n  end" }});
        var candidate = Run(host, basis, work, "create", ops);
        var merged = Path.Combine(work,"merged.oml");
        Assert.True(MergeProbe.ThreeWay(host,File.ReadAllBytes(basis),File.ReadAllBytes(candidate),merged).LocalIsValid);
        var proof = MergeContentProof.Check(host,candidate,merged);
        Assert.True(proof["accepted"]!.GetValue<bool>(),proof.ToJsonString());
        var html = Read(host, merged, "FilteredChoicesScreen");
        Assert.Contains("options=\"FilteredChoices\"",html);
        Assert.Contains("onchange=\"Changed\"",html);
        Assert.Contains("All choices",html);
        Assert.Contains("SourceIdentifierAttribute",html);
        Assert.Contains("\"value\":\"0\"",System.Net.WebUtility.HtmlDecode(html));
        var changed = Run(host, merged, work, "special-options", new JsonArray(
            new JsonObject { ["op"]="set", ["target"]="IWebScreen:FilteredChoicesScreen/**IComboBoxWidget",
                ["prop"]="SpecialOptions", ["value"]="[{\"label\":\"No selection\",\"value\":\"0\"},{\"label\":\"Special\",\"value\":\"-1\"}]" }));
        var after = Read(host, changed, "FilteredChoicesScreen");
        Assert.Contains("No selection", after);
        Assert.Contains("\"value\":\"-1\"", System.Net.WebUtility.HtmlDecode(after));
        Assert.DoesNotContain("All choices", after);
    }

    [Fact]
    public void FormUsesNativeLabelAndUploadWithSubmit()
    {
        var (host, root, work) = Setup();
        var result = Run(host, Path.Combine(root,"tests/fixtures/traditional-ui.oml"), work, "form",
            new JsonArray(
                JsonNode.Parse("""{"op":"create","parent":"@espace","type":"IStructure","name":"FormData","as":"$form"}"""),
                JsonNode.Parse("""{"op":"create","parent":"$form","type":"IStructureAttribute","name":"Title","as":"$title"}"""),
                JsonNode.Parse("""{"op":"set","target":"$title","prop":"DataType","value":"Text"}"""),
                Html("""
              <screen name="NativeFormScreen" actions="Save">
                <var name="Title" type="Text"/>
                <var name="Draft" type="FormData"/>
                <form id="EditForm" class="form" record="Draft">
                  <label for="TitleInput" class="form-label">Title</label>
                  <input id="TitleInput" bind="Title" class="form-control"/>
                  <upload id="Attachment" class="upload"/>
                  <button onclick="Save" method="Submit">Save</button>
                </form>
              </screen>
              """), new JsonObject { ["op"]="logic", ["data"]=new JsonObject { ["flow"]="action NativeFormScreen.Save\n  end" }}));
        var html = Read(host,result,"NativeFormScreen");
        Assert.Contains("<form",html);
        Assert.Contains("Title",html);
        Assert.Contains("<upload",html);
        var method = host.WithSession(result, session => {
            var click = session.Resolve("IWebScreen:NativeFormScreen/**ILinkWidget/OnClick");
            var property = click.GetType().GetInterfaces().SelectMany(t=>t.GetProperties()).First(p=>p.Name=="Method");
            return property.GetValue(click)!.ToString();
        });
        Assert.Equal("Submit",method);
    }

    private static (ModelHost Host, string Root, string Work) Setup()
    {
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(TraditionalControlsParityTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "traditional-controls-parity", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        return (new ModelHost(work),root,work);
    }
    private static JsonObject Html(string text) => new() { ["op"]="html", ["data"]=new JsonObject { ["html"]=text }};
    private static string Read(ModelHost host, string file, string screen) =>
        host.HtmlRead(File.ReadAllBytes(file),screen)["documents"]![0]!["html"]!.ToString();
    private static string Run(ModelHost host, string basis, string work, string name, JsonArray ops)
    {
        var job = Path.Combine(work,name+".json");
        var candidate = Path.Combine(work,name+".oml");
        File.WriteAllText(job,new JsonObject { ["ops"]=ops }.ToJsonString());
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host,basis,job,candidate))!;
        File.WriteAllText(Path.Combine(work,name+"-result.json"),result.ToJsonString());
        Assert.True(result["accepted"]?.GetValue<bool>()==true,work+"\n"+result);
        return candidate;
    }
}
