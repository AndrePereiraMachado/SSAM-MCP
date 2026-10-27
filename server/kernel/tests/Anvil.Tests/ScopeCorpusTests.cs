using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Preflight;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// R1 (escopo-kernel, 2026-10-24): the measurement of the scope phase over real deliveries. Off unless ANVIL_SCOPE_CORPUS
/// names a manifest ({refused:[{id, job, base}], accepted:[...]}: the inline job of a delivery and the base.oml of its
/// attempt); ANVIL_SCOPE_REPORT names the folder that receives one report per delivery (the problems of the preflight and of
/// the base phase, scope included, with the time of each phase). Nothing is applied: the base is loaded, the job normalized
/// and checked as JobRunner does before its first op. The comparison with the receipts is made outside (the numbers of the
/// report of the front).
/// </summary>
public sealed class ScopeCorpusTests
{
    public ScopeCorpusTests() { try { StudioAssemblies.Bind(); } catch { /* no Studio: the corpus does not run */ } }

    [Fact]
    public void CorpusReport()
    {
        var manifest = Environment.GetEnvironmentVariable("ANVIL_SCOPE_CORPUS");
        var output = Environment.GetEnvironmentVariable("ANVIL_SCOPE_REPORT");
        if (string.IsNullOrEmpty(manifest) || string.IsNullOrEmpty(output)) return;
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
