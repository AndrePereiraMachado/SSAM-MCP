using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

public class TraditionalHtmlRoundTripTests(ITestOutputHelper output)
{
    [Fact]
    public void CreatedTraditionalScreenReadsAndEditsWithoutLosingNativeBindings()
    {
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(TraditionalHtmlRoundTripTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "traditional-html-roundtrip", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var host = new ModelHost(Path.Combine(work, "model"));
        var source = Path.Combine(work, "created.oml");
        var createJob = JsonNode.Parse(File.ReadAllText(Path.Combine(root, "tests", "jobs", "traditional-html-frontend.json")))!;
        var block = createJob["ops"]![0]!["data"]!;
        block["html"] = block["html"]!.ToString().Replace("<style>", "<input name=\"Caption\" type=\"Text\"/><style>").Replace(">Traditional frontend</div>", ">{{ Caption }}</div>");
        var screen = createJob["ops"]![1]!["data"]!;
        screen["html"] = screen["html"]!.ToString().Replace("<Block name=\"AuditHeader\"/>", "<Block name=\"AuditHeader\" :Caption=\"Name\" onnotify=\"Confirm(Note = Name)\"/>").Replace("onclick=\"Confirm\"", "onclick=\"Confirm(Note = Name)\" method=\"Ajax\"");
        var logic = createJob["ops"]![2]!["data"]!;
        logic["flow"] = logic["flow"]!.ToString().Replace("action FrontendAudit.Confirm\n", "action FrontendAudit.Confirm\n  in Note: Text\n");
        var createFile = Path.Combine(work, "create.json"); File.WriteAllText(createFile, createJob.ToJsonString());
        var create = JsonSerializer.SerializeToNode(JobRunner.Run(host, Path.Combine(root, "tests", "fixtures", "traditional-ui.oml"), createFile, source))!;
        Assert.True(create["accepted"]!.GetValue<bool>(), create.ToJsonString());
        var bytes = File.ReadAllBytes(source);
        var read = host.HtmlRead(bytes, "FrontendAudit", withKeys: true);
        File.WriteAllText(Path.Combine(work, "read.json"), read.ToJsonString());
        output.WriteLine(work);
        var doc = read["documents"]![0]!;
        var html = doc["html"]!.ToString();
        output.WriteLine(html);
        Assert.DoesNotContain("os-opaque", html);
        Assert.Contains("bind=\"Name\"", html);
        Assert.Contains("Confirm", html);
        Assert.Contains(":Caption=\"Name\"", html);
        Assert.Contains("onnotify=\"Confirm(Note = Name)\"", html);
        Assert.DoesNotContain("os-On", html);
        Assert.Contains("class=\"audit-input\"", html);
        html = html.Replace("Type a name to test the native event:", "Name for the audit:");
        html = html.Replace("</screen>", "<div id=\"AddedContent\" class=\"audit-added\">New content {{ Message }}<Block name=\"AuditHeader\" :Caption=\"Message\" onnotify=\"Confirm(Note = Message)\"/><table><tr><td>{{ Name }}</td></tr></table></div></screen>");
        var job = new JsonObject { ["ops"] = new JsonArray(new JsonObject {
            ["op"] = "html", ["data"] = new JsonObject {
                ["screen"] = "FrontendAudit", ["basedOn"] = new JsonObject {
                    ["capture"] = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(),
                    ["html"] = doc["htmlSha256"]!.DeepClone()
                }, ["html"] = html, ["css"] = ".audit-page { color: #125678; }"
            }
        }) };
        var jobFile = Path.Combine(work, "edit.json"); File.WriteAllText(jobFile, job.ToJsonString());
        var target = Path.Combine(work, "edited.oml");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, source, jobFile, target))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        var after = host.HtmlRead(File.ReadAllBytes(target), "FrontendAudit", withKeys: true);
        File.WriteAllText(Path.Combine(work, "after.json"), after.ToJsonString());
        var text = after["documents"]![0]!["html"]!.ToString();
        Assert.Contains("#125678", text);
        Assert.Contains("bind=\"Name\"", text);
        Assert.Contains("Confirm", text);
        Assert.Contains(":Caption=\"Name\"", text);
        Assert.Contains("onnotify=\"Confirm(Note = Name)\"", text);
        Assert.Contains("Name for the audit:", text);
        Assert.Contains("AddedContent", text);
        Assert.Contains("onnotify=\"Confirm(Note = Message)\"", text);
        var oldKeys = doc["keys"]!.AsObject().Select(p => p.Value!.ToString()).ToHashSet();
        var newKeys = after["documents"]![0]!["keys"]!.AsObject().Select(p => p.Value!.ToString()).ToHashSet();
        Assert.True(oldKeys.IsSubsetOf(newKeys), "An HTML edit lost an existing native element key.");
    }
}
