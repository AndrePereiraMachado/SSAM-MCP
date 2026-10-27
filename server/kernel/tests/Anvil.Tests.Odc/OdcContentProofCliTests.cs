using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// R6: the ODC kernel CLI's content-proof verb, run as the facade runs it (reproveContentPreview: `dotnet anvil-odc.dll
/// content-proof --expected candidate --actual merged`, the {ok, command, data} envelope, data the proof with the sha256 of
/// both files), over the headless incident pair of OdcContentProofCanonTests: the merged module is accepted, and the
/// merged module with a node deleted is refused with the diff. Runs the CLI built in this checkout
/// (kernel/.local/lane-odc/cli, scripts/setup-dev.ps1; SSAM_ODC_CLI overrides); without it the test returns without
/// asserting, and a CLI built before the verb fails (rebuild it).
/// </summary>
public class OdcContentProofCliTests
{
    private static string Root { get { var d = Path.GetDirectoryName(typeof(OdcContentProofCliTests).Assembly.Location); while (d != null && !File.Exists(Path.Combine(d, "MANIFESTO.md"))) d = Path.GetDirectoryName(d); return d!; } }

    [Fact]
    public void TheCliVerbProvesThePairTheFacadeHandsIt()
    {
        var cli = Environment.GetEnvironmentVariable("SSAM_ODC_CLI") is { Length: > 0 } given ? given : Path.Combine(Root, ".local", "lane-odc", "cli", "anvil-odc.dll");
        if (!File.Exists(cli)) return;
        StudioAssembliesOdc.Bind();
        Run(cli);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Run(string cli)
    {
        var (work, host, candidate, merged) = OdcContentProofCanonTests.FlowRebindPair();
        var lost = OdcContentProofCanonTests.LostNode(host, work, merged);
        static string Sha(string file) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file))).ToLowerInvariant();
        JsonObject Proof(string actual)
        {
            var start = new ProcessStartInfo("dotnet") { RedirectStandardError = true, RedirectStandardOutput = true, UseShellExecute = false, CreateNoWindow = true,
                WorkingDirectory = Path.GetDirectoryName(cli)! };
            foreach (var a in new[] { cli, "content-proof", "--expected", candidate, "--actual", actual, "--work", Path.Combine(work, "cli-work") }) start.ArgumentList.Add(a);
            start.Environment["ANVIL_WORKER"] = "0"; start.Environment["ANVIL_ODC_NO_WORKER"] = "1";
            using var process = Process.Start(start)!;
            var stderr = process.StandardError.ReadToEndAsync();
            var stdout = process.StandardOutput.ReadToEnd();
            process.WaitForExit();
            Assert.False(stderr.Result.Contains("unknown command: content-proof", StringComparison.Ordinal), "the CLI at " + cli + " predates content-proof: rebuild it (scripts/setup-dev.ps1)");
            Assert.True(process.ExitCode == 0, "exit " + process.ExitCode + ": " + stderr.Result);
            var envelope = JsonNode.Parse(stdout.TrimStart('﻿'))!.AsObject();
            Assert.True(envelope["ok"]!.GetValue<bool>()); Assert.Equal("content-proof", envelope["command"]!.ToString());
            var data = envelope["data"]!.AsObject();
            // What reproveContentPreview binds: the schema, the differences list and the sha256 of both files.
            Assert.Equal("ssam-merge-content-proof/1", data["schema"]!.ToString());
            Assert.NotNull(data["differences"] as JsonArray);
            Assert.Equal(Sha(candidate), data["inputs"]!["expected"]!["sha256"]!.ToString());
            Assert.Equal(Sha(actual), data["inputs"]!["actual"]!["sha256"]!.ToString());
            return data;
        }
        // integ/proto-into-product: the verb is the candidate's (merge-identity: an element is named by its place, never by a local
        // key), so the proof has no firstDifferences/summary of the proto's R6 canon; what it proves is the same: the pair the
        // native merge only re-identifies is accepted, and the merged module without the node is refused, naming the node.
        var same = Proof(merged);
        Assert.True(same["accepted"]!.GetValue<bool>(), same["differences"]!.ToJsonString());
        Assert.Empty(same["differences"]!.AsArray());
        var loss = Proof(lost);
        Assert.False(loss["accepted"]!.GetValue<bool>());
        Assert.Contains(loss["differences"]!.AsArray(), d => (d!["element"]?.ToString() ?? d["address"]?.ToString() ?? "").Contains("AssignNode", StringComparison.Ordinal));
    }
}
