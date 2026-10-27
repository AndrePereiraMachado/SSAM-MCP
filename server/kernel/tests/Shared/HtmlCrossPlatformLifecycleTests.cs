using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

// Real installed models, not a synthetic reader: creation, persistence, keyed reparenting,
// data/event preservation and native validation on each committed UI fixture.
public class HtmlCrossPlatformLifecycleTests
{
    public static IEnumerable<object[]> Fixtures()
    {
        if (typeof(ModelHost).Assembly.GetType("Anvil.Core.StudioAssembliesOdc") != null) {
            yield return ["odc/insurance-reactive-r8.oml"];
            yield return ["odc/blank-mobile.oml"];
        } else {
            yield return ["traditional-ui.oml"];
            yield return ["reactive-ui.oml"];
            yield return ["mobile-ui.oml"];
        }
    }

    [Theory]
    [MemberData(nameof(Fixtures))]
    public void CreateReadEditKeepsBindingsEventsConditionsAndCss(string fixture)
    {
        var binder = typeof(ModelHost).Assembly.GetType("Anvil.Core.StudioAssembliesOdc")
            ?? typeof(ModelHost).Assembly.GetType("Anvil.Core.StudioAssemblies")!;
        var bind = binder.GetMethods().First(m => m.Name == "Bind");
        bind.Invoke(null, bind.GetParameters().Select(p => p.HasDefaultValue ? p.DefaultValue : null).ToArray());
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(HtmlCrossPlatformLifecycleTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "html-cross-platform", fixture.Replace('/', '-'), Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        var basis = Path.Combine(root, "tests", "fixtures", fixture);
        var traditional = fixture == "traditional-ui.oml";
        var method = traditional ? " method=\"Submit\"" : "";
        var html = """
            <screen name="HtmlLifecycle" actions="ApplyFilter" roles="Registered">
             <var name="Query" type="Text"/>
             <var name="Shown" type="Boolean" default="True"/>
             <div id="TemporaryWrapper" class="temporary-wrapper">
              <div id="ResultPanel" class="result-panel">
               <input id="QueryInput" bind="Query" onchange="ApplyFilter"/>
               <button id="FilterButton" onclick="ApplyFilter"METHOD>Apply filter</button>
               <div if="Shown"><span>{{ Query }}</span></div><div else>No result</div>
              </div>
             </div>
             <style>.result-panel { padding: 17px; }</style>
            </screen>
            """.Replace("METHOD", method);
        // ODC has its own authentication model; this fixture has no O11 Registered role.
        var odcMobile = fixture == "odc/blank-mobile.oml";
        if (fixture.StartsWith("odc/", StringComparison.Ordinal)) html = html.Replace("roles=\"Registered\"",
            odcMobile ? "roles=\"AppRole:HtmlAuditUser\"" : "roles=\"AppRole:InsuranceApp\"");
        string Run(string source, JsonObject job, string name) {
            var path = Path.Combine(work, name + ".json");
            var target = Path.Combine(work, name + ".oml");
            File.WriteAllText(path, job.ToJsonString());
            var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, source, path, target))!;
            File.WriteAllText(Path.Combine(work, name + "-result.json"), result.ToJsonString());
            Assert.True(result["accepted"]?.GetValue<bool>() == true, work + "\n" + result);
            return target;
        }
        var operations = new JsonArray();
        if (odcMobile) {
            operations.Add(new JsonObject { ["op"] = "create", ["parent"] = "@espace", ["type"] = "IAppRole", ["name"] = "HtmlAuditUser" });
            operations.Add(new JsonObject { ["op"] = "create", ["parent"] = "@espace", ["type"] = "IMobileFlow", ["name"] = "MainFlow" });
        }
        operations.Add(new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } });
        operations.Add(new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = "action HtmlLifecycle.ApplyFilter\n  assign Shown = not Shown\n  end" } });
        var created = Run(basis, new JsonObject { ["ops"] = operations }, "created");
        var bytes = File.ReadAllBytes(created);
        var document = host.HtmlRead(bytes, "HtmlLifecycle", withKeys: true)["documents"]![0]!;
        var before = document["html"]!.ToString();
        var tree = ScreenHtml.Parse(before);
        var wrapper = ScreenHtmlText.Elements(tree).Single(x => x.Node.Get("id") == "TemporaryWrapper").Node;
        var parent = ScreenHtmlText.Elements(tree).Select(x => x.Node).First(n => n.Children.Contains(wrapper));
        var position = parent.Children.IndexOf(wrapper);
        parent.Children.RemoveAt(position);
        parent.Children.InsertRange(position, wrapper.Children);
        var edited = ScreenHtmlText.Write(tree);
        var changed = Run(created, new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject {
            ["screen"] = "HtmlLifecycle", ["html"] = edited,
            ["basedOn"] = new JsonObject { ["capture"] = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(), ["html"] = document["htmlSha256"]!.DeepClone() }
        } }) }, "edited");
        var after = host.HtmlRead(File.ReadAllBytes(changed), "HtmlLifecycle")["documents"]![0]!["html"]!.ToString();
        // The page marker belongs to the engine. When its wrapper is removed,
        // the retained panel becomes the page root and must inherit that marker.
        if (before.Contains("data-ssam-page=\"1\"")) {
            var panel=ScreenHtmlText.Elements(tree).Single(x=>x.Node.Get("id")=="ResultPanel").Node;
            panel.Attributes.Add(new("data-ssam-page","1"));
        }
        Assert.Equal(ScreenHtmlText.WithoutKeys(ScreenHtmlText.Write(tree)), ScreenHtmlText.WithoutKeys(after));
        Assert.Contains("ApplyFilter", after);
        Assert.Contains("bind=\"Query\"", after);
        Assert.Contains("onchange=\"ApplyFilter\"", after);
        Assert.Contains("if=\"Shown\"", after);
        Assert.Contains("padding: 17px", after);
        File.WriteAllText(Path.Combine(work, "before.html"), before);
        File.WriteAllText(Path.Combine(work, "after.html"), after);
        var cloneHtml = ScreenHtmlText.WithoutKeys(after).Replace("name=\"HtmlLifecycle\"", "name=\"HtmlLifecycleClone\"");
        // Internal layout markers are regenerated for a new document, not authored.
        var cloneTree=ScreenHtml.Parse(cloneHtml);
        foreach (var item in ScreenHtmlText.Elements(cloneTree)) item.Node.Attributes.RemoveAll(a=>ScreenVisual.MarkerOf(a.Key)!=null);
        var clone = Run(changed, new JsonObject { ["ops"]=new JsonArray(
            new JsonObject { ["op"]="html", ["data"]=new JsonObject { ["html"]=ScreenHtmlText.Write(cloneTree) } },
            new JsonObject { ["op"]="logic", ["data"]=new JsonObject { ["flow"]="action HtmlLifecycleClone.ApplyFilter\n  assign Shown = not Shown\n  end" } }) }, "recreated");
        var cloneRead = host.HtmlRead(File.ReadAllBytes(clone), "HtmlLifecycleClone")["documents"]![0]!["html"]!.ToString();
        File.WriteAllText(Path.Combine(work,"recreated.html"),cloneRead);
        Assert.Equal(cloneHtml,ScreenHtmlText.WithoutKeys(cloneRead));
        // Both creation and keyed editing must survive the platform's own native merge.
        foreach (var (source, target, name) in new[] { (basis, created, "create"), (created, changed, "edit"), (changed, clone, "recreate") }) {
            var mergeWork = Path.Combine(work, name + "-merge"); Directory.CreateDirectory(mergeWork);
            var plan = new MergePlanner(_ => host).Plan(source, target, Path.Combine(mergeWork, "first-pass.oml"));
            File.WriteAllText(Path.Combine(work, name + "-merge-proof.json"), plan.ToJsonString());
            Assert.True(plan["contentPreviewSupported"]?.GetValue<bool>() == true, plan.ToJsonString());
            Assert.True(plan["contentPreview"]?["accepted"]?.GetValue<bool>() == true, plan.ToJsonString());
            var mergedHtml = host.HtmlRead(File.ReadAllBytes(plan["contentPreview"]!["path"]!.ToString()), name == "recreate" ? "HtmlLifecycleClone" : "HtmlLifecycle")["documents"]![0]!["html"]!.ToString();
            Assert.Equal(ScreenHtmlText.WithoutKeys(name == "create" ? before : name == "edit" ? after : cloneRead), ScreenHtmlText.WithoutKeys(mergedHtml));
        }
    }
}
