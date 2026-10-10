using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Atritos 3, lane kl, B3 of C02 (by file): the footprint of a job comes from what its ops named and created, never from two
/// full sweeps of the module (3 to 6 s per delivery on the 2.9 MB module of the friend's labs). For every job of tests/jobs
/// the footprint of the scopes equals the footprint of the full sweep (sets of created, changed and screens), and the
/// JSON keeps its shape (created, createdTotal, changed, changedTotal, screens, screensTotal: the builder reads the totals).
/// </summary>
public sealed class Pa3KlFootprintTests
{
    private static readonly string Root = PacoteBPolicyTests.FindRoot();
    private static readonly string Work = Path.Combine(Root, ".local", "pa3-kl-footprint");

    public static IEnumerable<object[]> Jobs() => JobTests.Jobs();

    [Theory]
    [MemberData(nameof(Jobs))]
    public void TheFootprintOfTheScopesEqualsTheFullSweep(string jobName)
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var audit = new List<string>();
        ModelSession.FootprintAudit.Value = audit;
        try
        {
            Directory.CreateDirectory(Work);
            var result = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Work), null, Path.Combine(Root, "tests", "jobs", jobName + ".json"),
                Path.Combine(Work, jobName + ".oml")))!.AsObject();
            Assert.True(audit.Count == 0, jobName + ": " + string.Join(Environment.NewLine, audit.Take(40)));
            var footprint = result["footprint"]!.AsObject();
            Assert.Equal(["created", "createdTotal", "changed", "changedTotal", "screens", "screensTotal"], footprint.Select(p => p.Key));
        }
        finally { ModelSession.FootprintAudit.Value = null; }
    }

    [Fact]
    public void AnOpCreatesWhatItNamesAndThePlatformAddsUnderIt()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        // A new input of an existing action gives each call an argument (the platform writes it under the call node): the
        // scopes find it as the sweep does, and the call's action is counted as changed only when an op wrote it.
        var dir = Path.Combine(Work, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var baseJob = Path.Combine(dir, "base.json");
        File.WriteAllText(baseJob, """
            {"base":"blank-service.oml","ops":[{"op":"logic","data":{"actions":[
              {"name":"Pa3Callee","outputs":[{"name":"R","type":"Text"}],"steps":[{"assign":{"R":"\"x\""}}]},
              {"name":"Pa3Caller","outputs":[{"name":"R","type":"Text"}],"steps":[{"call":"Pa3Callee","as":"Callee"},{"assign":{"R":"Callee.R"}}]}]}}]}
            """);
        var basePath = Path.Combine(dir, "work", "base.oml"); // a capture folder: a base the job may name
        JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, baseJob, basePath);
        var job = Path.Combine(dir, "job.json");
        File.WriteAllText(job, "{\"base\":\"" + basePath.Replace('\\', '/') + "\",\"ops\":["
            + """{"op":"create","parent":"IServerAction:Pa3Callee","type":"IInputParameter","name":"Extra","as":"$extra"},{"op":"set","target":"$extra","prop":"DataType","value":"Text"},{"op":"set","target":"$extra","prop":"IsMandatory","value":false}]}""");
        var audit = new List<string>();
        ModelSession.FootprintAudit.Value = audit;
        try
        {
            var result = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, job, Path.Combine(dir, "out.oml")))!.AsObject();
            Assert.True(audit.Count == 0, string.Join(Environment.NewLine, audit));
            var created = result["footprint"]!["created"]!.AsArray().Select(c => c!["name"]?.ToString()).ToArray();
            Assert.Contains("Extra", created);
        }
        finally { ModelSession.FootprintAudit.Value = null; }
    }
}
