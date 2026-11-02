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

    /// <summary>C-03 (F-FT-09 Fitmaker, 27/10, P0): an event in a row of a List Records was written with the source's Current
    /// (onclick="ChoosePlan(PlanId = Plans.Current.Id)"); at the Ajax postback Plans.Current is the LAST row, so "Choose This Plan"
    /// of the Pro chose the Begginer, the FAQ 3 opened the 5 and a JoinRequest was saved with PlanId 3. The row clicked is the
    /// list widget's (&lt;List&gt;.List.Current): the document writes the event arguments of a row so, naming the list when it
    /// has no id, in the creation form and in the edit form, and says it in the receipt.</summary>
    [Fact]
    public void AnEventInARowReadsTheRowClickedThroughItsListWidget()
    {
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(TraditionalHtmlRecordsTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "traditional-html-records", "rows-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(work); output.WriteLine(work);
        var host = new ModelHost(Path.Combine(work, "model"));
        JsonNode Run(string source, JsonArray ops, string name) {
            var job = Path.Combine(work, name + ".json");
            File.WriteAllText(job, new JsonObject { ["ops"] = ops }.ToJsonString());
            var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, source, job, Path.Combine(work, name + ".oml")))!;
            File.WriteAllText(Path.Combine(work, name + "-result.json"), result.ToJsonString());
            Assert.True(result["accepted"]?.GetValue<bool>() == true, work + "\n" + result);
            return result;
        }
        var html = """
          <screen name="PlansAudit" roles="Registered" actions="ChoosePlan, ToggleFaq, Pick">
           <var name="Plans" type="AuditRow List"/>
           <var name="Faqs" type="AuditRow List"/>
           <var name="Chosen" type="Text"/>
           <var name="Open" type="Integer"/>
           <list-records class="fm-plans-grid" source="Plans" line-separator="None">
            <div class="fm-plan">
             <div class="fm-plan-name">{{ Plans.Current.Caption }}</div>
             <a class="fm-plan-btn" onclick="ChoosePlan(PlanName = Plans.Current.Caption)" method="Ajax">Choose This Plan</a>
             <Block name="RowCard" onnotify="ChoosePlan(PlanName = Plans.Current.Caption)"/>
            </div>
           </list-records>
           <list-records id="FaqList" source="Faqs">
            <a class="fm-faq-q" onclick="ToggleFaq(RowIndex = Faqs.CurrentRowNumber)" method="Ajax">{{ Faqs.Current.Caption }}</a>
            <input bind="Chosen" onchange="Pick(Caption = Faqs.Current.Caption)"/>
           </list-records>
           <table-records id="Grid" source="Plans"><tr><td>Plan</td></tr><tr><td><button onclick="ChoosePlan(PlanName = Plans.Current.Caption)" method="Ajax">Go</button></td></tr></table-records>
           <a id="Outside" onclick="ChoosePlan(PlanName = Plans.Current.Caption)" method="Ajax">Outside</a>
           <div id="Result">{{ Chosen }}</div>
          </screen>
          """;
        var created = Run(Path.Combine(root, "tests/fixtures/traditional-ui.oml"), new JsonArray(
            JsonNode.Parse("""{"op":"spec","data":{"structures":[{"name":"AuditRow","attributes":[{"name":"Caption","type":"Text"}]}]}}"""),
            new JsonObject { ["op"]="html", ["data"]=new JsonObject { ["html"]="<block name=\"RowCard\"><div class=\"card\">card</div></block>" } },
            new JsonObject { ["op"]="html", ["data"]=new JsonObject { ["html"]=html } },
            new JsonObject { ["op"]="logic", ["data"]=new JsonObject { ["flow"]="action PlansAudit.ChoosePlan\n  in PlanName: Text\n  assign Chosen = PlanName\n  end" } },
            new JsonObject { ["op"]="logic", ["data"]=new JsonObject { ["flow"]="action PlansAudit.ToggleFaq\n  in RowIndex: Integer\n  assign Open = RowIndex\n  end" } },
            new JsonObject { ["op"]="logic", ["data"]=new JsonObject { ["flow"]="action PlansAudit.Pick\n  in Caption: Text\n  assign Chosen = Caption\n  end" } }), "create");
        var oml = Path.Combine(work, "create.oml");
        var bytes = File.ReadAllBytes(oml);
        var document = host.HtmlRead(bytes, "PlansAudit", withKeys: true)["documents"]![0]!;
        var read = document["html"]!.ToString();
        File.WriteAllText(Path.Combine(work, "read.html"), read);
        // the list without id has the name its widget got, and every event of its row reads the row through it
        var plans = System.Text.RegularExpressions.Regex.Match(read, "<list-records k=\"[^\"]+\" id=\"([A-Za-z0-9_]+)\"[^>]*source=\"Plans\"").Groups[1].Value;
        Assert.NotEmpty(plans);
        Assert.Equal(2, System.Text.RegularExpressions.Regex.Matches(read, "ChoosePlan\\(PlanName = " + plans + "\\.List\\.Current\\.Caption\\)").Count);
        Assert.Contains("ToggleFaq(RowIndex = FaqList.List.CurrentRowNumber)", read);
        Assert.Contains("Pick(Caption = FaqList.List.Current.Caption)", read);
        Assert.Contains("ChoosePlan(PlanName = Grid.List.Current.Caption)", read);
        // what renders the row keeps its source (it is the row being rendered); outside the list nothing changes
        Assert.Contains("{{ Plans.Current.Caption }}", read);
        Assert.Contains("{{ Faqs.Current.Caption }}", read);
        Assert.Matches("id=\"Outside\" onclick=\"ChoosePlan\\(PlanName = Plans\\.Current\\.Caption\\)\"", read);
        // never in silence: the receipt lists each argument it wrote through the list
        var migration = created["results"]!.AsArray().Select(r => r?["result"]?["migration"]).OfType<JsonObject>().Single();
        var rows = migration["adapted"]!.AsArray().Where(a => a!["to"]!.ToString().Contains(".List.Current")).Select(a => a!["from"] + " -> " + a["to"]).ToList();
        output.WriteLine(string.Join("\n", rows));
        Assert.Contains("Plans.Current.Caption -> " + plans + ".List.Current.Caption", rows);
        Assert.Contains("Faqs.CurrentRowNumber -> FaqList.List.CurrentRowNumber", rows);
        // the edit form: a new link in the row of the list is written through the list too, and the edit reads back as written
        var tree = ScreenHtml.Parse(read);
        var row = ScreenHtmlText.Elements(tree).First(n => n.Node.Get("class") == "fm-plan").Node;
        row.Children.Add(new ScreenHtml.Node { Tag = "a", Attributes = [new("id", "Again"), new("onclick", "ChoosePlan(PlanName = Plans.Current.Caption)"), new("method", "Ajax")], Children = [new ScreenHtml.Node { Text = "Again" }] });
        var edited = Run(oml, new JsonArray(new JsonObject { ["op"]="html", ["data"]=new JsonObject {
            ["screen"]="PlansAudit", ["html"]=ScreenHtmlText.Write(tree),
            ["basedOn"]=new JsonObject { ["capture"]=Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(), ["html"]=document["htmlSha256"]!.DeepClone() }
        } }), "edit");
        Assert.Contains("HTML_LIST_ROW", edited.ToJsonString());
        var after = host.HtmlRead(File.ReadAllBytes(Path.Combine(work, "edit.oml")), "PlansAudit")["documents"]![0]!["html"]!.ToString();
        File.WriteAllText(Path.Combine(work, "after.html"), after);
        Assert.Matches("id=\"Again\" onclick=\"ChoosePlan\\(PlanName = " + plans + "\\.List\\.Current\\.Caption\\)\"", after);
    }

    /// <summary>C-48 (F-FT-29, Jesse Traditional, 27/10): Projects = GetProjects.List in the Preparation, &lt;list-records
    /// source="Projects" line-count="ProjectCount"&gt;, ShowMoreProjects adds 3 to ProjectCount: "View all works" showed 7 of 9
    /// and disappeared. The runtime fetches start-index + line-count + 1 rows of an aggregate a List Records shows (through
    /// its variable too, in a screen action too), and nothing said so. The document (new, and the elements of an edit) warns
    /// with the pattern that shows every row: raise the count first, then query again.</summary>
    [Fact]
    public void AListRecordsWhoseLineCountIsAnExpressionWarnsThatItFetchesOnlyThatManyRows()
    {
        var html = """
          <screen name="Works" actions="ShowMoreProjects">
           <var name="Projects" type="AuditRow List"/>
           <var name="ProjectCount" type="Integer" default="6"/>
           <list-records id="ProjectList" source="Projects" line-count="ProjectCount" line-separator="None">
            <div class="work">{{ ProjectList.List.Current.Caption }}</div>
           </list-records>
           <list-records id="Fixed" source="Projects" line-count="10">{{ Fixed.List.Current.Caption }}</list-records>
          </screen>
          """;
        var ops = new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } },
            new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["screen"] = "Works", ["edit"] = new JsonArray("<div k=\"w9\" list=\"Posts\" line-count=\"PostCount + 0\">{{ Posts.Current.Caption }}</div>") } });
        var found = Anvil.Core.Preflight.HtmlDocumentRules.CheckTraditional(ops, "/ops", "WebResponsive");
        output.WriteLine(string.Join("\n", found.Select(p => p.ToJsonString())));
        var warnings = found.Where(p => p["code"]!.ToString() == "HTML_LIST_RECORDS_LINE_COUNT").ToList();
        Assert.Equal(2, warnings.Count);
        Assert.All(warnings, w => Assert.Equal("warning", w["severity"]!.ToString()));
        Assert.Equal(["/ops/0/data/html", "/ops/1/data/edit/0"], warnings.Select(w => w["pointer"]!.ToString()));
        Assert.Contains("start-index + line-count + 1", warnings[0]["message"]!.ToString());
        Assert.Contains("assign ProjectCount = ProjectCount + N, then run the aggregate again", warnings[0]["fix"]!.ToString());
        // A Reactive module is not judged; a literal line count is no "show more".
        Assert.DoesNotContain(Anvil.Core.Preflight.HtmlDocumentRules.CheckTraditional(ops, "/ops", "CrossDevice"), p => p["code"]!.ToString() == "HTML_LIST_RECORDS_LINE_COUNT");
        Assert.DoesNotContain(warnings, w => w["message"]!.ToString().Contains("\"Fixed\"", StringComparison.Ordinal));

        // The receipt of the creation says it too.
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(TraditionalHtmlRecordsTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "traditional-html-records", "paging-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(work); output.WriteLine(work);
        var job = Path.Combine(work, "job.json");
        File.WriteAllText(job, new JsonObject { ["ops"] = new JsonArray(
            JsonNode.Parse("""{"op":"spec","data":{"structures":[{"name":"AuditRow","attributes":[{"name":"Caption","type":"Text"}]}]}}"""),
            new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } },
            new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = "action Works.ShowMoreProjects\n  assign ProjectCount = ProjectCount + 3\n  end" } }) }.ToJsonString());
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(work, "model")), Path.Combine(root, "tests/fixtures/traditional-ui.oml"), job, Path.Combine(work, "out.oml")))!;
        File.WriteAllText(Path.Combine(work, "result.json"), result.ToJsonString());
        Assert.True(result["accepted"]?.GetValue<bool>() == true, result.ToJsonString());
        var receipt = result["results"]!.AsArray().Select(r => r?["result"]?["warnings"]).OfType<JsonArray>().Single();
        Assert.Equal("HTML_LIST_RECORDS_LINE_COUNT", Assert.Single(receipt)!["code"]!.ToString());
    }
}
