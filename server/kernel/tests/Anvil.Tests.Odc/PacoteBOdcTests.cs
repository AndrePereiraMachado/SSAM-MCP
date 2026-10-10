using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// Lane B in the ODC kernel (the same Kernel/** sources compiled against the ODC Studio): the preflight answers with
/// structured problems and warnings, the ODC-only lint (an aggregate Count is a Long Integer), the CLI envelope carries
/// code and problems, and the apply carries verdicts, footprint and the sha256 of its output (the receipt the builder reads).
/// </summary>
public sealed class PacoteBOdcTests
{
    private static readonly string Root = FindRoot();

    [Fact]
    public void ACountAssignedToAnIntegerIsAWarningInOdc()
    {
        Assert.Equal("odc", MessageExpectations.Lane);
        var job = JsonNode.Parse("""
        {"ops":[{"op":"logic","data":{"actions":[{"name":"CountOpen","outputs":[{"name":"Total","type":"Integer"}],"steps":[
          {"get":"Task","as":"GetTasks","where":"Task.IsOpen"},{"assign":{"Total":"GetTasks.Count"}}]}]}}]}
        """)!;
        var result = JobPreflight.Analyze(job["ops"]!.AsArray(), job, []);
        Assert.True(result["valid"]!.GetValue<bool>());
        var warning = Assert.Single(result["warnings"]!.AsArray(), w => w!["code"]!.GetValue<string>() == "ODC_COUNT_TO_INTEGER")!;
        Assert.Equal("/ops/0/data/actions/0/steps/1/Total", warning["pointer"]!.GetValue<string>());
        Assert.Contains("Long Integer", warning["fix"]!.GetValue<string>());
        // The same job in the O11 lane has no such warning: the lint knows its lane.
        Assert.DoesNotContain(LogicLint.Check(job["ops"]!.AsArray(), "o11"), w => w["code"]!.GetValue<string>() == "ODC_COUNT_TO_INTEGER");
    }

    [Fact]
    public void ThePreflightRefusalCarriesCodeAndProblemsInTheOdcEnvelope()
    {
        var job = JsonNode.Parse("""{"ops":[{"op":"logic","data":{"actions":[{"name":"A","bogus":1,"steps":[]}]}},{"op":"logic","data":{"actions":[{"name":"B","inputs":[{"name":"F","type":"Boolean","default":"yes"}],"outputs":[{"name":"O","type":"Boolean"}],"steps":[{"assign":{"O":"F"}}]}]}}]}""")!;
        var result = JobPreflight.Analyze(job["ops"]!.AsArray(), job, []);
        var error = Assert.Throws<JobPreflightException>(() => JobPreflight.RequireValid(result));
        var envelope = Errors.Envelope("apply", error, 3);
        Assert.Equal("PREFLIGHT_REFUSED", envelope["code"]!.GetValue<string>());
        Assert.Equal(new[] { 0, 1 }, envelope["problems"]!.AsArray().Select(p => p!["op"]!.GetValue<int>()).Order());
        Assert.Contains(envelope["problems"]!.AsArray(), p => p!["code"]!.GetValue<string>() == "DEFAULT_LITERAL_INVALID" && p["fix"]!.GetValue<string>().Contains("True"));
    }

    [Fact]
    public void TheOdcApplyCarriesVerdictsFootprintAndOutSha256()
    {
        if (!StudioAvailable()) return;
        var dir = Path.Combine(Root, ".local", "lane-odc", "pacote-b-tests", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(dir);
        var job = Path.Combine(dir, "unused.json");
        File.WriteAllText(job, """{"base":"tests/fixtures/odc/blank-mobile.oml","ops":[{"op":"logic","data":{"actions":[{"name":"PacoteBOdcProbe","steps":[]}]}}]}""");
        var output = Path.Combine(dir, "unused.oml");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, job, output))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]!.ToJsonString() + result["details"]);
        Assert.Equal(Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(output))).ToLowerInvariant(), result["outSha256"]!.GetValue<string>());
        Assert.Contains(result["footprint"]!["created"]!.AsArray(), e => e!["name"]?.GetValue<string>() == "PacoteBOdcProbe");
        Assert.All(result["validation"]!["verdicts"]!.AsArray(), v => Assert.NotEqual("unexpected", v!["verdict"]!.GetValue<string>()));
        // The builder's judgement over this very receipt accepts what the kernel judged.
        var receipt = new JsonObject { ["ok"] = true, ["data"] = result.DeepClone() };
        var warnings = result["validation"]!["verdicts"]!.AsArray().Select(v => v!["ownerKey"] + "|" + v["id"] + "|m|d").ToArray();
        var judged = CandidateReceipt.Judge(receipt, Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(output))), warnings);
        Assert.True(judged.Applies);
        Assert.Empty(judged.Refused);
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(PacoteBOdcTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
