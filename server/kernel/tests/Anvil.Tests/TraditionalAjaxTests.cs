using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public class TraditionalAjaxTests
{
    [Fact]
    public void RefreshFindsOnlyTheOwnersPreparationAggregate()
    {
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(TraditionalAjaxTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "traditional-ajax-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var host = new ModelHost(Path.Combine(work, "model"));
        var ops = new JsonArray();
        foreach (var name in new[] { "FirstList", "SecondList" }) {
            ops.Add(new JsonObject { ["op"] = "create", ["parent"] = "IWebFlow:MainFlow", ["type"] = "IWebScreen", ["name"] = name });
            ops.Add(JsonNode.Parse("""{"op":"logic","data":{"actions":[{"name":"Preparation","kind":"preparation","owner":"IWebScreen:SCREEN","steps":[{"get":"User","as":"Registros","where":"User.Id = GetUserId()","max":"20"}]}]}}""".Replace("SCREEN", name)));
            ops.Add(new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = $"action {name}.Reload\n  refresh Registros\n  end" } });
        }
        var job = Path.Combine(work, "job.json");
        File.WriteAllText(job, new JsonObject { ["ops"] = ops }.ToJsonString());
        var candidate = Path.Combine(work, "candidate.oml");
        var applied = JsonSerializer.SerializeToNode(JobRunner.Run(host, Path.Combine(root, "tests", "fixtures", "traditional-ui.oml"), job, candidate))!;
        Assert.True(applied["accepted"]!.GetValue<bool>(), applied.ToJsonString());
        var merged = Path.Combine(work, "merged.oml");
        MergeProbe.ThreeWay(host, File.ReadAllBytes(Path.Combine(root, "tests", "fixtures", "traditional-ui.oml")), File.ReadAllBytes(candidate), merged);
        Assert.True(MergeContentProof.Check(host, candidate, merged)["accepted"]!.GetValue<bool>());
        foreach (var name in new[] { "FirstList", "SecondList" }) {
            File.WriteAllText(job, """{"ops":[{"op":"get","target":"IWebScreen:SCREEN/Reload/#IRefreshDataNode"},{"op":"get","target":"IWebScreen:SCREEN/Preparation/Registros"}]}""".Replace("SCREEN", name));
            var read = JsonSerializer.SerializeToNode(JobRunner.Run(host, merged, job, Path.Combine(work, "read.oml")))!;
            Assert.Equal("@" + read["results"]![1]!["result"]!["key"], read["results"]![0]!["result"]!["properties"]!["DataSource"]!.ToString());
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void MethodsAndRefreshSurviveMergeAndTamperingIsDetected(bool textExample)
    {
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(TraditionalAjaxTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "traditional-ajax-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var host = new ModelHost(Path.Combine(work, "model"));
        var basis = Path.Combine(root, "tests", "fixtures", "traditional-ui.oml");
        var job = Path.Combine(work, "job.json");
        File.WriteAllText(job, """
        {"ops":[
          {"op":"html","data":{"html":"<screen name=\"AjaxAudit\" actions=\"Toggle\"><var name=\"Shown\" type=\"Boolean\"/><div id=\"Result\"><div if=\"Shown\">Visible</div><div else>Hidden</div></div><button id=\"ToggleLink\" onclick=\"Toggle\" method=\"Ajax\" validation=\"None\">Toggle</button><a id=\"SubmitLink\" onclick=\"Toggle\" method=\"Submit\">Submit</a><a id=\"NavigationLink\" onclick=\"AjaxAudit\" method=\"Navigate\">Go</a></screen>"}},
          {"op":"logic","data":{"actions":[{"name":"Toggle","kind":"screen","owner":"IWebScreen:AjaxAudit","steps":[{"assign":{"Shown":"not Shown"}},{"node":"IAjaxRefreshNode","properties":{"WidgetOrWebBlock":"IContainerWidget:Result","RowNumber":"","AnimationEffect":"None"}}]}]}}
        ]}
        """);
        if (textExample) File.Copy(Path.Combine(root, "tests", "jobs", "traditional-ajax-navigation.json"), job, true);
        var candidate = Path.Combine(work, "candidate.oml");
        var applied = JsonSerializer.SerializeToNode(JobRunner.Run(host, basis, job, candidate))!;
        File.WriteAllText(Path.Combine(work, "apply.json"), applied.ToJsonString());
        Assert.True(applied["accepted"]!.GetValue<bool>(), work + "\n" + applied);
        var merged = Path.Combine(work, "merged.oml");
        var merge = MergeProbe.ThreeWay(host, File.ReadAllBytes(basis), File.ReadAllBytes(candidate), merged);
        Assert.True(merge.LocalIsValid);
        var proof = MergeContentProof.Check(host, candidate, merged);
        File.WriteAllText(Path.Combine(work, "proof.json"), proof.ToJsonString());
        Assert.True(proof["accepted"]!.GetValue<bool>(), work + "\n" + proof);
        var readJob = Path.Combine(work, "read.json");
        File.WriteAllText(readJob, """
        {"ops":[{"op":"get","target":"ILinkWidget:ToggleLink/OnClick"},{"op":"get","target":"ILinkWidget:SubmitLink/OnClick"},{"op":"get","target":"ILinkWidget:NavigationLink/OnClick"},{"op":"get","target":"IWebScreen:AjaxAudit/Toggle/#IAjaxRefreshNode"},{"op":"get","target":"IContainerWidget:Result"}]}
        """);
        var read = JsonSerializer.SerializeToNode(JobRunner.Run(host, merged, readJob, Path.Combine(work, "read.oml")))!;
        File.WriteAllText(Path.Combine(work, "read-result.json"), read.ToJsonString());
        var results = read["results"]!.AsArray();
        Assert.Equal("Ajax", results[0]!["result"]!["properties"]!["Method"]!.ToString());
        Assert.Equal("None", results[0]!["result"]!["properties"]!["Validation"]!.ToString());
        Assert.Equal("Submit", results[1]!["result"]!["properties"]!["Method"]!.ToString());
        Assert.Equal("Navigate", results[2]!["result"]!["properties"]!["Method"]!.ToString());
        Assert.Equal("@" + results[4]!["result"]!["key"], results[3]!["result"]!["properties"]!["WidgetOrWebBlock"]!.ToString());
        foreach (var change in new[] {
            "{\"op\":\"set\",\"target\":\"ILinkWidget:ToggleLink/OnClick\",\"prop\":\"Method\",\"value\":\"Submit\"}",
            "{\"op\":\"set\",\"target\":\"IWebScreen:AjaxAudit/Toggle/#IAjaxRefreshNode\",\"prop\":\"WidgetOrWebBlock\",\"value\":\"ILinkWidget:ToggleLink\"}"
        }) {
            var tampered = Path.Combine(work, "tampered.oml");
            CompileCheck.WriteUnchecked(host, File.ReadAllBytes(merged), JsonNode.Parse("[" + change + "]")!.AsArray(), tampered);
            Assert.False(MergeContentProof.Check(host, candidate, tampered)["accepted"]!.GetValue<bool>());
        }
    }

    [Theory]
    [InlineData("<a onclick=\"Go\" method=\"Navigate\">Bad</a>")]
    [InlineData("<a onclick=\"Rejected\" method=\"Ajax\">Bad</a>")]
    [InlineData("<a onclick=\"Go\" method=\"Unknown\">Bad</a>")]
    [InlineData("<a method=\"Ajax\">Bad</a>")]
    public void InvalidMethodDoesNotProduceAModule(string content)
    {
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(TraditionalAjaxTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "traditional-ajax-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var job = Path.Combine(work, "job.json");
        File.WriteAllText(job, new JsonObject { ["ops"] = new JsonArray(
            new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = "<screen name=\"Rejected\" actions=\"Go\">" + content + "</screen>" } },
            new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = "action Rejected.Go\n  end" } }) }.ToJsonString());
        var output = Path.Combine(work, "output.oml");
        Assert.ThrowsAny<Exception>(() => JobRunner.Run(new ModelHost(Path.Combine(work, "model")), Path.Combine(root, "tests", "fixtures", "traditional-ui.oml"), job, output));
        Assert.False(File.Exists(output));
    }
}
