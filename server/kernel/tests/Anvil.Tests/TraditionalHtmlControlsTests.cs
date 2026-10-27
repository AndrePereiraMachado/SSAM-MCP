using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

public class TraditionalHtmlControlsTests(ITestOutputHelper output)
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void DataControlsCreateReadEditAndMergeWithTheirHandlers(bool canonicalTags)
    {
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(TraditionalHtmlControlsTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "traditional-html-controls", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work); output.WriteLine(work);
        var host = new ModelHost(work);
        var html = """
          <screen name="ControlAudit" roles="Registered" actions="Changed">
           <var name="EnabledChoice" type="Boolean" default="True"/>
           <var name="Secret" type="Text"/>
           <var name="Choice" type="Text" default='"A"'/>
           <var name="Person" type="User Identifier"/>
           <var name="Row" type="AuditRow"/>
           <var name="Changes" type="Integer"/>
           <form id="AuditForm" record="Row" editable="True">
            <input id="Check" type="checkbox" bind="EnabledChoice" onchange="Changed" enabled="True"/>
            <input id="SecretInput" type="password" bind="Secret" onchange="Changed" maxlength="60" os-Width="8 col"/>
            <input id="RadioA" type="radio" bind="Choice" value='"A"' onchange="Changed"/>
            <input id="RadioB" type="radio" bind="Choice" value='"B"' onchange="Changed" os-Visible="True" os-MarginLeft="Adaptive"/>
            <select bind="Person" source-entity="IEntitySignature:User" source-attribute="IEntitySignature:User/Name" required="False"/>
            <button onclick="Changed" method="Ajax">Apply</button>
            <div id="ControlResults"><span>{{ Changes }}</span></div>
           </form>
          </screen>
          """;
        if (canonicalTags) html = html.Replace("input id=\"Check\" type=\"checkbox\"", "checkbox-input id=\"Check\"")
            .Replace("input id=\"SecretInput\" type=\"password\"", "password-input id=\"SecretInput\"")
            .Replace("input id=\"RadioA\" type=\"radio\"", "radio-input id=\"RadioA\"")
            .Replace("input id=\"RadioB\" type=\"radio\"", "radio-input id=\"RadioB\"");
        string Run(string source, JsonArray ops, string name) {
            var job = Path.Combine(work, name + ".json"); var candidate = Path.Combine(work, name + ".oml");
            File.WriteAllText(job, new JsonObject { ["ops"] = ops }.ToJsonString());
            var applied = JsonSerializer.SerializeToNode(JobRunner.Run(host, source, job, candidate))!;
            File.WriteAllText(Path.Combine(work, name + "-result.json"), applied.ToJsonString());
            Assert.True(applied["accepted"]?.GetValue<bool>() == true, applied.ToJsonString());
            var mergeWork = Path.Combine(work, name + "-merge"); Directory.CreateDirectory(mergeWork);
            var plan = new MergePlanner(_ => host).Plan(source, candidate, Path.Combine(mergeWork, "first-pass.oml"));
            File.WriteAllText(Path.Combine(work, name + "-merge-proof.json"), plan.ToJsonString());
            Assert.True(plan["contentPreview"]!["accepted"]!.GetValue<bool>(), plan.ToJsonString());
            return plan["contentPreview"]!["path"]!.ToString();
        }
        var created = Run(Path.Combine(root, "tests", "fixtures", "traditional-ui.oml"), new JsonArray(
            JsonNode.Parse("""{"op":"spec","data":{"structures":[{"name":"AuditRow","attributes":[{"name":"Caption","type":"Text"}]}]}}"""),
            new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } },
            new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = "action ControlAudit.Changed\n  assign Changes = Changes + 1\n  node AjaxRefreshNode()\n    @{WidgetOrWebBlock=&\"ControlResults\"}\n  end" } }), "create");
        var bytes = File.ReadAllBytes(created);
        var document = host.HtmlRead(bytes, "ControlAudit", withKeys: true)["documents"]![0]!;
        var before = document["html"]!.ToString(); File.WriteAllText(Path.Combine(work, "before.html"), before);
        Assert.DoesNotContain("os-opaque", before);
        Assert.Contains("radio-input", before); Assert.Contains("bind=\"Choice\"", before);
        Assert.Contains("onchange=\"Changed\"", before);
        var tree = ScreenHtml.Parse(before);
        var radio = ScreenHtmlText.Elements(tree).Single(n => n.Node.Get("id") == "RadioB").Node;
        var classIndex = radio.Attributes.FindIndex(a => a.Key == "class");
        Assert.True(classIndex >= 0); radio.Attributes[classIndex] = new("class", "audit-choice");
        var form = ScreenHtmlText.Elements(tree).Single(n => n.Node.Get("id") == "AuditForm").Node;
        form.Attributes.Add(new("class", "audit-form"));
        var edited = Run(created, new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject {
            ["screen"] = "ControlAudit", ["html"] = ScreenHtmlText.Write(tree),
            ["basedOn"] = new JsonObject { ["capture"] = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(), ["html"] = document["htmlSha256"]!.DeepClone() }
        } }), "edit");
        var after = host.HtmlRead(File.ReadAllBytes(edited), "ControlAudit")["documents"]![0]!["html"]!.ToString();
        File.WriteAllText(Path.Combine(work, "after.html"), after);
        // Traditional Form stores class as an extended attribute; the canonical reader makes that explicit.
        var formClassIndex = form.Attributes.FindIndex(a => a.Key == "class");
        form.Attributes[formClassIndex] = new("ext:class", "audit-form");
        Assert.Equal(ScreenHtmlText.WithoutKeys(ScreenHtmlText.Write(tree)), ScreenHtmlText.WithoutKeys(after));
        var cloneHtml = ScreenHtmlText.WithoutKeys(after).Replace("name=\"ControlAudit\"", "name=\"ControlClone\"");
        var clone = Run(edited, new JsonArray(
            new JsonObject { ["op"]="html", ["data"]=new JsonObject { ["html"]=cloneHtml } },
            new JsonObject { ["op"]="logic", ["data"]=new JsonObject { ["flow"]="action ControlClone.Changed\n  assign Changes = Changes + 1\n  node AjaxRefreshNode()\n    @{WidgetOrWebBlock=&\"ControlResults\"}\n  end" } }),"recreate");
        var cloned = host.HtmlRead(File.ReadAllBytes(clone),"ControlClone")["documents"]![0]!["html"]!.ToString();
        File.WriteAllText(Path.Combine(work,"recreated.html"),cloned);
        Assert.Equal(cloneHtml,ScreenHtmlText.WithoutKeys(cloned));
    }
}
