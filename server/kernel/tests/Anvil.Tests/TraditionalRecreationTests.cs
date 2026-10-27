using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>B1 over the Traditional fixture: every Web screen of tests/fixtures/traditional-ui.oml is read as ssam-html/1 and
/// compiled again by the document form in the loaded copy (ScreenRecreationProof, the recreation's move of its actions and
/// Preparation, its os-opaque widgets moved by k): the text read again equals the text read before and the Verify gains no
/// error. A screen that does not come back the same is listed with its cause; the known causes are those below.</summary>
public class TraditionalRecreationTests(ITestOutputHelper output)
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(TraditionalRecreationTests).Assembly.Location)!)!;
    // Causes the fixture is known to keep (a widget the language has no row for and the document cannot create).
    private static readonly Dictionary<string, string> Known = new(StringComparer.Ordinal) { };

    [Fact]
    public void EveryWebScreenOfTheTraditionalFixtureIsCompiledAgainByTheDocumentFormAndComesBackTheSame()
    {
        StudioAssemblies.Bind();
        var work = Path.Combine(Root, ".local", "traditional-recreation", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var host = new ModelHost(Path.Combine(work, "model"));
        var bytes = File.ReadAllBytes(Path.Combine(Root, "tests", "fixtures", "traditional-ui.oml"));
        var report = ScreenRecreationProof.Run(host, bytes, verify: true, log: output.WriteLine);
        File.WriteAllText(Path.Combine(work, "recreation.json"), report.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
        output.WriteLine(work);
        var rows = report["rows"]!.AsArray().Select(r => r!.AsObject()).ToList();
        Assert.NotEmpty(rows);
        Assert.All(rows, row => Assert.Equal("WebScreen", row["kind"]!.ToString()));
        var problems = new List<string>();
        foreach (var row in rows)
        {
            var outcome = row["outcome"]!.ToString();
            var name = row["root"]!.ToString();
            if (outcome == "same") { if (Known.ContainsKey(name)) output.WriteLine("NOTE: " + name + " comes back the same now; its known cause can leave the list"); continue; }
            var detail = outcome + " " + (row["code"]?.ToString() ?? "") + " " + (row["message"]?.ToString() ?? row["problems"]?.ToJsonString() ?? row["differences"]?.ToJsonString() ?? row["verify"]?.ToJsonString() ?? row["error"]?.ToString() ?? "");
            if (Known.TryGetValue(name, out var cause)) output.WriteLine("known: " + name + ": " + cause);
            else problems.Add(name + ": " + detail);
        }
        output.WriteLine("outcomes: " + report["outcomes"]!.ToJsonString());
        Assert.True(problems.Count == 0, string.Join(Environment.NewLine, problems));
    }
}
