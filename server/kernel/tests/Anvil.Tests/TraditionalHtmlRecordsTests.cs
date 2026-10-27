using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

public class TraditionalHtmlRecordsTests(ITestOutputHelper output)
{
    [Fact]
    public void RecordViewsCreateReadEditAndNativeMergePreserveDataAndRowCommands()
    {
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(TraditionalHtmlRecordsTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "traditional-html-records", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work); output.WriteLine(work);
        var host = new ModelHost(work);
        string Run(string source, JsonArray ops, string name) {
            var job = Path.Combine(work, name + ".json"); var candidate = Path.Combine(work, name + ".oml");
            File.WriteAllText(job, new JsonObject { ["ops"] = ops }.ToJsonString());
            var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, source, job, candidate))!;
            File.WriteAllText(Path.Combine(work, name + "-result.json"), result.ToJsonString());
            Assert.True(result["accepted"]?.GetValue<bool>() == true, result.ToJsonString());
            var mergeWork = Path.Combine(work, name + "-merge"); Directory.CreateDirectory(mergeWork);
            var plan = new MergePlanner(_ => host).Plan(source, candidate, Path.Combine(mergeWork, "first-pass.oml"));
            File.WriteAllText(Path.Combine(work, name + "-merge-proof.json"), plan.ToJsonString());
            Assert.True(plan["contentPreview"]!["accepted"]!.GetValue<bool>(), plan.ToJsonString());
            return plan["contentPreview"]!["path"]!.ToString();
        }
        var html = """
          <screen name="RecordsAudit" roles="Registered" actions="Choose, Preparation" title="Records audit">
           <var name="Rows" type="AuditRow List"/>
           <var name="Selected" type="Text"/>
           <text id="LiteralBraces">Literal {{</text>
           <table-records id="Records" source="Rows" line-count="5" start-index="0">
            <slot name="HeaderRow"><td>Caption</td><td>Command</td></slot>
            <slot name="DataRow">
             <td>{{ Records.List.Current.Caption }}</td>
             <td><button onclick="Choose(Caption = Records.List.Current.Caption)" method="Ajax" validation="None">Select</button></td>
            </slot>
           </table-records>
           <list-records id="Cards" source="Rows" line-count="5" start-index="0">
            <div>{{ Cards.List.Current.Caption }}</div>
           </list-records>
           <div id="Result">{{ Selected }}</div>
          </screen>
          """;
        var created = Run(Path.Combine(root, "tests/fixtures/traditional-ui.oml"), new JsonArray(
            JsonNode.Parse("""{"op":"spec","data":{"structures":[{"name":"AuditRow","attributes":[{"name":"Caption","type":"Text"}]}]}}"""),
            new JsonObject { ["op"]="html", ["data"]=new JsonObject { ["html"]=html } },
            new JsonObject { ["op"]="logic", ["data"]=new JsonObject { ["flow"]="action RecordsAudit.Choose\n  in Caption: Text\n  assign Selected = Caption\n  node AjaxRefreshNode()\n    @{WidgetOrWebBlock=&\"Result\"}\n  end" } },
            new JsonObject { ["op"]="logic", ["data"]=new JsonObject { ["flow"]="preparation RecordsAudit.Preparation\n  assign Selected = \"Initial\"\n  end" } }), "create");
        var bytes = File.ReadAllBytes(created);
        var document = host.HtmlRead(bytes, "RecordsAudit", withKeys:true)["documents"]![0]!;
        var before = document["html"]!.ToString(); File.WriteAllText(Path.Combine(work,"before.html"),before);
        Assert.DoesNotContain("os-opaque", before);
        Assert.Contains("source=\"Rows\"", before);
        Assert.Contains("Choose(Caption = Records.List.Current.Caption)", before);
        var tree = ScreenHtml.Parse(before);
        var table = ScreenHtmlText.Elements(tree).Single(n => n.Node.Get("id") == "Records").Node;
        var count = table.Attributes.FindIndex(a => a.Key == "line-count");
        Assert.True(count >= 0); table.Attributes[count] = new("line-count", "2");
        var editedHtml = ScreenHtmlText.Write(tree);
        var edited = Run(created, new JsonArray(new JsonObject { ["op"]="html", ["data"]=new JsonObject {
            ["screen"]="RecordsAudit", ["html"]=editedHtml,
            ["basedOn"]=new JsonObject { ["capture"]=Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(), ["html"]=document["htmlSha256"]!.DeepClone() }
        } }),"edit");
        var after = host.HtmlRead(File.ReadAllBytes(edited), "RecordsAudit")["documents"]![0]!["html"]!.ToString();
        File.WriteAllText(Path.Combine(work,"after.html"),after);
        Assert.Equal(ScreenHtmlText.WithoutKeys(editedHtml),ScreenHtmlText.WithoutKeys(after));
        // The reader's canonical form must also be usable as a new document, not
        // only as a keyed edit. Keep bindings/events and change only the root name.
        var cloneHtml = ScreenHtmlText.WithoutKeys(after).Replace("name=\"RecordsAudit\"", "name=\"RecordsClone\"");
        var clone = Run(edited, new JsonArray(
            new JsonObject { ["op"]="html", ["data"]=new JsonObject { ["html"]=cloneHtml } },
            new JsonObject { ["op"]="logic", ["data"]=new JsonObject { ["flow"]="action RecordsClone.Choose\n  in Caption: Text\n  assign Selected = Caption\n  node AjaxRefreshNode()\n    @{WidgetOrWebBlock=&\"Result\"}\n  end" } },
            new JsonObject { ["op"]="logic", ["data"]=new JsonObject { ["flow"]="preparation RecordsClone.Preparation\n  assign Selected = \"Initial\"\n  end" } }),"recreate");
        var cloned = host.HtmlRead(File.ReadAllBytes(clone),"RecordsClone")["documents"]![0]!["html"]!.ToString();
        File.WriteAllText(Path.Combine(work,"recreated.html"),cloned);
        Assert.Equal(cloneHtml,ScreenHtmlText.WithoutKeys(cloned));
    }
}
