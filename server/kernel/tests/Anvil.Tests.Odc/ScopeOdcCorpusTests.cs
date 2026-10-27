using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Preflight;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// L3c (scope-odc, 2026-10-24): the measurement of the scope phase over real ODC deliveries, the mirror of ScopeCorpusTests.
/// Off unless ANVIL_SCOPE_CORPUS names a manifest ({refused:[{id, job, base, bindings}], accepted:[...]}: the inline job of a
/// delivery of the lab and the snapshot it was built on); ANVIL_SCOPE_REPORT names the folder that receives one report per
/// delivery. ANVIL_SCOPE_MODE=replay runs the job whole (preflight, base and scope, apply, Verify) and keeps the problems
/// with their phase; otherwise the job is only read as JobRunner reads it before its first op. ANVIL_SCOPE_PHASE=off gives
/// the baseline. The comparison with the receipts is made outside.
/// </summary>
public sealed class ScopeOdcCorpusTests
{
    [Fact]
    public void CorpusReport()
    {
        var manifest = Environment.GetEnvironmentVariable("ANVIL_SCOPE_CORPUS");
        var output = Environment.GetEnvironmentVariable("ANVIL_SCOPE_REPORT");
        if (string.IsNullOrEmpty(manifest) || string.IsNullOrEmpty(output)) return;
        StudioAssembliesOdc.Bind(null);
        Directory.CreateDirectory(output);
        var only = Environment.GetEnvironmentVariable("ANVIL_SCOPE_ONLY");
        var entries = JsonNode.Parse(File.ReadAllText(manifest))!.AsObject();
        var host = new ModelHost(Path.Combine(output, "work"));
        foreach (var (group, list) in entries)
            foreach (var entry in list!.AsArray().OfType<JsonObject>())
            {
                var id = entry["id"]!.ToString();
                if (!string.IsNullOrEmpty(only) && !only.Split(',').Any(o => id.StartsWith(o, StringComparison.Ordinal))) continue;
                var report = new JsonObject { ["id"] = id, ["group"] = group, ["module"] = entry["module"]?.ToString() };
                try
                {
                    if (Environment.GetEnvironmentVariable("ANVIL_SCOPE_MODE") == "replay")
                        ScopeCorpus.Replay(host, entry["job"]!.ToString(), entry["base"]!.ToString(),
                            (entry["bindings"] as JsonObject ?? []).ToDictionary(b => b.Key, b => b.Value!.ToString()), Path.Combine(output, "work", id + ".oml"), report);
                    else ScopeCorpus.Measure(host, entry["job"]!.ToString(), entry["base"]!.ToString(), report);
                }
                catch (Exception ex) { report["error"] = Errors.Text(ex); }
                File.WriteAllText(Path.Combine(output, id + ".json"), report.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
            }
    }
}
