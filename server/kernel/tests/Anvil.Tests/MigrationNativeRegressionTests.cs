using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

public sealed class MigrationNativeRegressionTests
{
    [Theory]
    [InlineData("document")]
    [InlineData("fragment")]
    [InlineData("edit")]
    public void TheSameBindingsPropertiesAndEventsSurviveAllThreeWriteModes(string mode)
    {
        StudioAssemblies.Bind(null);
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(MigrationNativeRegressionTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "migration-native", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        var body = "<label>{{ Title }}</label><input bind='Title' placeholder='{{ Title }}' os-Enabled='Enabled' onchange='Change'/><table><tbody list='Rows' as='Row'><tr><td>{{ Row }}</td></tr></tbody></table><popup show='Enabled'><button onclick='Change'>Save</button></popup>";
        var source = "<screen name='WriteMode' roles='Registered' actions='Change'><var name='Title' type='Text'/><var name='Enabled' type='Boolean'/><var name='Rows' type='Integer List'/><div class='body'>" + (mode == "document" ? body : "") + "</div></screen>";
        var operations = new JsonArray(new JsonObject { ["op"]="html", ["data"]=new JsonObject { ["html"]=source } },
            new JsonObject { ["op"]="logic", ["data"]=new JsonObject { ["flow"]="action WriteMode.Change\n  end\n" } });
        if (mode == "fragment") operations.Add(new JsonObject { ["op"]="html", ["parent"]="IMobileScreen:WriteMode", ["html"]=body });
        var host = new ModelHost(work); var job = Path.Combine(work, "job.json"); var output = Path.Combine(work, "out.oml");
        File.WriteAllText(job, new JsonObject { ["base"]="reactive-ui.oml", ["ops"]=operations }.ToJsonString());
        Assert.True(JsonSerializer.SerializeToNode(JobRunner.Run(host, null, job, output))!["accepted"]!.GetValue<bool>());
        if (mode == "edit")
        {
            var bytes = File.ReadAllBytes(output);
            var reading = host.HtmlRead(bytes, "MobileScreen:WriteMode", withKeys: true);
            var document = reading["documents"]![0]!;
            var tree = ScreenHtml.Parse(document["html"]!.ToString());
            var container = ScreenDocument.Descendants(tree).Single(n => n.Get("class") == "body");
            var editJob = new JsonObject { ["ops"]=new JsonArray(new JsonObject { ["op"]="html", ["data"]=new JsonObject {
                ["screen"]="WriteMode", ["basedOn"]=new JsonObject { ["capture"]=Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant(), ["html"]=document["htmlSha256"]!.DeepClone() },
                ["edits"]=new JsonArray(new JsonObject { ["into"]=container.Get("k"), ["insert"]=body }) } }) };
            var edited = Path.Combine(work, "edited.oml"); File.WriteAllText(job, editJob.ToJsonString());
            var editedResult = JsonSerializer.SerializeToNode(JobRunner.Run(host, output, job, edited))!;
            Assert.True(editedResult["accepted"]!.GetValue<bool>(), editedResult.ToJsonString()); output = edited;
        }
        var html = host.HtmlRead(File.ReadAllBytes(output), "MobileScreen:WriteMode", withKeys:false)["documents"]![0]!["html"]!.ToString();
        Assert.Contains("{{ Title }}", html); Assert.Contains("onchange=\"Change\"", html);
        Assert.Contains("list=\"Rows\"", html); Assert.Contains("show=\"Enabled\"", html);
        Assert.Contains("enabled=\"Enabled\"", html, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ScreenActionBeforeItsDocumentUsesTheDeclaredScreenScope()
    {
        StudioAssemblies.Bind(null);
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(MigrationNativeRegressionTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "migration-native", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        var job = Path.Combine(work, "job.json");
        File.WriteAllText(job, new JsonObject { ["base"] = "reactive-ui.oml", ["ops"] = new JsonArray(
            new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = "action LaterScreen.Choose\n  assign Selected = 42\n  end\n" } },
            new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = "<screen name='LaterScreen' roles='Registered' actions='Choose'><var name='Selected' type='Integer'/><button onclick='Choose'>Choose</button></screen>" } }
        ) }.ToJsonString());
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(work), null, job, Path.Combine(work, "out.oml")))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
    }

    [Fact]
    public void PagingAndAfterFetchStatePassTheNativeVerifier()
    {
        StudioAssemblies.Bind(null);
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(MigrationNativeRegressionTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "migration-native", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var page = MigrationDataRegressionTests.Page();
        page["derived"] = new JsonArray(new JsonObject { ["name"]="Sum", ["source"]="LoadItems", ["output"]="Rows", ["sum"]="Amount" });
        var ops = new JsonArray(
            JsonNode.Parse("""{"op":"spec","data":{"structures":[{"name":"MigrationRow","attributes":[{"name":"Amount","type":"Integer"}]}]}}"""),
            new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = "server action ReadItems\n  in Skip: Integer\n  in Take: Integer\n  out Total: Integer\n  out Rows: MigrationRow List\n  assign Total = 186\n  end\n" } },
            new JsonObject { ["op"] = "html", ["data"] = page });
        var job = Path.Combine(work, "job.json");
        File.WriteAllText(job, new JsonObject { ["base"] = "reactive-ui.oml", ["ops"] = ops }.ToJsonString());
        var host = new ModelHost(work); var output = Path.Combine(work, "out.oml");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, null, job, output))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        var text = host.HtmlRead(File.ReadAllBytes(output), "MobileScreen:MigratedCatalog", withKeys: false)["documents"]![0]!["html"]!.ToString();
        Assert.Contains("ApplyLoadItems", text);
        Assert.Contains("FetchedTotal", text);
    }

    [Fact]
    public void ComponentAdaptersGenerateNativeWidgetsAndExecutableHandlersTogether()
    {
        StudioAssemblies.Bind(null);
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(MigrationNativeRegressionTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "migration-native", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var ops = new JsonArray(
            new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = "server action TrySave\n  out Success: Boolean\n  assign Success = True\n  end\n" } },
            new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = """
                <screen name="MigrationComponents" roles="Registered" data-actions="LoadItems">
                  <var name="File" type="Binary Data"/><var name="Filename" type="Text"/>
                  <button data-popup-open="Editor">Edit</button>
                  <migration-popup id="Editor" show="EditorOpen" save="TrySave()" success="Success" refresh="LoadItems">
                    <migration-upload id="Upload" content="File" filename="Filename" accept="Any" max-bytes="1024" extensions=".txt,.pdf"/>
                    <button data-popup-cancel="Editor">Cancel</button><button data-popup-save="Editor">Save</button>
                  </migration-popup>
                  <migration-tabs id="Tabs" active="ActiveTab"><tab value="0" label="First"><p>First panel</p></tab><tab value="1" label="Second"><p>Second panel</p></tab></migration-tabs>
                  <migration-pager id="Pages" offset="Offset" total="LoadItems.Total" size="25" source="LoadItems"/>
                  <migration-time id="LocalTime" value='"2026-10-23T12:00:00Z"' semantics="client-local" format="HH:mm"/>
                  <migration-download id="Download" content="File" filename="Filename" mime="text/plain">Download</migration-download>
                  <migration-form id="EditForm" submit="TrySave()"><input bind="Filename" required=""/><button data-form-submit="EditForm">Submit</button></migration-form>
                  <migration-accordion id="Details" active="DetailIndex"><item value="2" label="Details"><p>Detail content</p></item></migration-accordion>
                </screen>
                """ } },
            new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = "data action MigrationComponents.LoadItems\n  out Total: Integer\n  assign Total = 186\n  end\n" } });
        var job = Path.Combine(work, "job.json");
        File.WriteAllText(job, new JsonObject { ["base"] = "reactive-ui.oml", ["ops"] = ops }.ToJsonString());
        var host = new ModelHost(work); var output = Path.Combine(work, "out.oml");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, null, job, output))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        var text = host.HtmlRead(File.ReadAllBytes(output), "MobileScreen:MigrationComponents", withKeys: false)["documents"]![0]!["html"]!.ToString();
        Assert.Contains("<popup", text); Assert.Contains("<upload", text);
        Assert.Contains("MigrateEditorSave", text); Assert.Contains("MigratePagesGo", text);
        Assert.Contains("role=\"tabpanel\"", text);
        Assert.DoesNotContain("migration-popup", text);
        Assert.Contains("MigrationComponents_FormatTemporal", text);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void MutualScreenNavigationResolvesBeforeBodiesRegardlessOfDocumentOrder(bool reverse)
    {
        StudioAssemblies.Bind(null);
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(MigrationNativeRegressionTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "migration-native", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var documents = new[] {
            """<screen name="MigrationFirst" roles="Registered" actions="Shared"><var name="FirstValue" type="Integer"/><Block name="LayoutBlank"><slot name="Content"><a onclick="MigrationSecond(ItemId = 42)">Next</a><button onclick="Shared">Set first</button></slot></Block></screen>""",
            """<screen name="MigrationSecond" roles="Registered" actions="Shared"><var name="SecondValue" type="Integer"/><input name="ItemId" type="Integer" mandatory="True"/><Block name="LayoutBlank"><slot name="Content"><a onclick="MigrationFirst">Back</a><span>{{ ItemId }}</span><button onclick="Shared">Set second</button></slot></Block></screen>"""
        };
        if (reverse) Array.Reverse(documents);
        var ops = new JsonArray(documents.Select(html => (JsonNode)new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } }).ToArray());
        ops.Add(new JsonObject { ["op"]="logic", ["data"]=new JsonObject { ["flow"]=new JsonArray("action MigrationFirst.Shared\n  assign FirstValue = 1\n  end\n", "action MigrationSecond.Shared\n  assign SecondValue = 2\n  end\n") } });
        var job = Path.Combine(work, "job.json");
        File.WriteAllText(job, new JsonObject { ["base"] = "reactive-ui.oml", ["ops"] = ops }.ToJsonString());
        var host = new ModelHost(work);
        var output = Path.Combine(work, "out.oml");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, null, job, output))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        var text = host.HtmlRead(File.ReadAllBytes(output), "MobileScreen:MigrationFirst", withKeys: false)["documents"]![0]!["html"]!.ToString();
        Assert.Contains("MigrationSecond(ItemId = 42)", text);
    }

    [Fact]
    public void NavigationSuggestionsDoNotReplaceScreensWithServerActions()
    {
        StudioAssemblies.Bind(null);
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(MigrationNativeRegressionTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "migration-native", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var operations = new JsonArray(
            new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["actions"] = new JsonArray(new JsonObject {
                ["name"] = "GetOperationsDashboard", ["kind"] = "server", ["steps"] = new JsonArray() }) } },
            new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = """
                <screen name="OperationsDashboard" roles="Registered"><Block name="LayoutBlank"><slot name="Content"><p>Dashboard</p></slot></Block></screen>
                """ } },
            new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = """
                <screen name="MigrationNavigation" roles="Registered"><Block name="LayoutBlank"><slot name="Content"><a onclick="OperationsDashboar">Dashboard</a></slot></Block></screen>
                """ } });
        var job = Path.Combine(work, "job.json");
        File.WriteAllText(job, new JsonObject { ["base"] = "reactive-ui.oml", ["ops"] = operations }.ToJsonString());
        var error = Assert.ThrowsAny<Exception>(() => JobRunner.Run(new ModelHost(work), null, job, Path.Combine(work, "out.oml")));
        var problems = Errors.FindCoded(error)?.Problems?.ToJsonString() ?? error.Message;
        Assert.Contains("OperationsDashboard", problems);
        Assert.DoesNotContain("GetOperationsDashboard", problems);
    }

    [Fact]
    public void ForwardBlockReferenceIncludesItsTypedInputsAndPlaceholders()
    {
        StudioAssemblies.Bind(null);
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(MigrationNativeRegressionTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "migration-native", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var documents = new[] {
            """<screen name="MigrationConsumer" roles="Registered"><Block name="LayoutBlank"><slot name="Content"><Block name="MigrationCard" :Title='"Title"'><slot name="Content"><p>Preserved content</p></slot></Block></slot></Block></screen>""",
            """<block name="MigrationCard"><input name="Title" type="Text" mandatory="True"/><div><h2>{{ Title }}</h2><placeholder name="Content"/></div></block>"""
        };
        var job = Path.Combine(work, "job.json");
        File.WriteAllText(job, new JsonObject { ["base"] = "reactive-ui.oml", ["ops"] = new JsonArray(documents.Select(html => (JsonNode)new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } }).ToArray()) }.ToJsonString());
        var host = new ModelHost(work); var output = Path.Combine(work, "out.oml");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, null, job, output))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        var text = host.HtmlRead(File.ReadAllBytes(output), "MobileScreen:MigrationConsumer", withKeys: false)["documents"]![0]!["html"]!.ToString();
        Assert.Contains("Preserved content", text);
        Assert.Contains("MigrationCard", text);
    }

    [Fact]
    public void FragmentPropertiesBindingsEventsAndRowGroupsSurviveNativeCompilation()
    {
        StudioAssemblies.Bind(null);
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(MigrationNativeRegressionTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "migration-native", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var ops = new JsonArray(
            new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = """
                <screen name="MigrationNative" roles="Registered" actions="Refresh">
                <var name="Title" type="Text"/><var name="CanSave" type="Boolean"/>
                <var name="Choice" type="Integer"/><var name="Rows" type="Integer List"/>
                <Block name="LayoutBlank"><slot name="Content"/></Block>
                </screen>
                """ } },
            new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = "action MigrationNative.Refresh\n  end\n" } },
            new JsonObject { ["op"] = "html", ["parent"] = "IMobileScreen:MigrationNative", ["html"] = """
                <div class="migration-case">
                <label for="Search">{{ Title }}</label>
                <input id="Search" bind="Title" placeholder='{{ "Search" }}' os-Enabled="CanSave" required="" onchange="Refresh"/>
                <table><tbody list="Rows" as="Row"><tr><td>{{ Row }}</td></tr></tbody></table>
                <popup show="CanSave" class="editor"><button onclick="Refresh">Salvar</button></popup>
                </div>
                """ });
        var job = Path.Combine(work, "job.json");
        File.WriteAllText(job, new JsonObject { ["base"] = "reactive-ui.oml", ["ops"] = ops }.ToJsonString());
        var host = new ModelHost(work);
        var output = Path.Combine(work, "out.oml");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, null, job, output))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        var text = host.HtmlRead(File.ReadAllBytes(output), "MobileScreen:MigrationNative", withKeys: false)["documents"]![0]!["html"]!.ToString();
        Assert.Contains("onchange=\"Refresh\"", text);
        Assert.Contains("{{ Title }}", text);
        Assert.Contains("list=\"Rows\"", text);
        Assert.Contains("data-ssam-rows", text);
        Assert.Contains("disable-virtualization", text);
        Assert.Contains("<popup", text);
        Assert.Contains("show=\"CanSave\"", text);
        Assert.DoesNotContain("os-Enabled", text);
        Assert.DoesNotContain("&quot;Search&quot;&quot;", text);
    }
}
