using System.Diagnostics;
using System.Text.Json;
using ServiceStudio.Model;

namespace Anvil.Core;

public sealed record ScanRow(
    string File, string? Name, string? Kind, string? Key, long Bytes, int Objects, bool IsValid, int Messages, int Errors, int Warnings,
    IReadOnlyDictionary<string, int> TopObjectTypes, int References, long LoadMs, long VerifyMs,
    bool? RoundTripOk, long? SaveMs, int? ReloadObjects, string? Error);

/// <summary>
/// "Leitor de tudo": carrega cada OML de uma pasta pelo runtime headless, verifica (o mesmo Verify do Studio),
/// opcionalmente faz o round-trip save/reload, e grava uma linha JSON por modulo (incremental, sobrevive a
/// crash). E a coluna "ler" do mapa de capacidades provada com corpus real, sem escrever um caso de teste a mao.
/// </summary>
public static class CorpusScan
{
    public static object Run(ModelHost host, string dir, string outFile, bool roundTrip, Action<string>? log = null, string? filter = null, int max = int.MaxValue)
    {
        var files = Directory.EnumerateFiles(dir, "*.oml", SearchOption.AllDirectories)
            .Where(f => string.IsNullOrEmpty(filter) || Path.GetFileName(f).Contains(filter, StringComparison.OrdinalIgnoreCase))
            .OrderBy(f => f, StringComparer.OrdinalIgnoreCase).Take(max).ToList();
        var done = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (File.Exists(outFile))
            foreach (var line in File.ReadLines(outFile))
                try { var r = JsonSerializer.Deserialize<ScanRow>(line); if (r != null) done.Add(r.File); } catch { }
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outFile))!);
        using var writer = new StreamWriter(outFile, append: true);
        var sw = Stopwatch.StartNew();
        int ok = 0, invalid = 0, failed = 0, skipped = 0, n = 0;
        long objects = 0;
        foreach (var f in files)
        {
            n++;
            var rel = Path.GetFileName(f);
            if (done.Contains(rel)) { skipped++; continue; }
            ScanRow row;
            ESpace? espace = null;
            try
            {
                var bytes = File.ReadAllBytes(f);
                var t0 = sw.ElapsedMilliseconds;
                espace = host.Load(bytes);
                var loadMs = sw.ElapsedMilliseconds - t0;
                var snap = ModelHost.Describe(espace, loadMs);
                bool? rt = null; long? saveMs = null; int? reloadObjects = null;
                if (roundTrip)
                {
                    var t1 = sw.ElapsedMilliseconds;
                    var saved = host.Save(espace);
                    saveMs = sw.ElapsedMilliseconds - t1;
                    var again = host.Load(saved);
                    var snap2 = ModelHost.Describe(again, 0);
                    reloadObjects = snap2.Objects;
                    rt = snap2.Key == snap.Key && snap2.Objects == snap.Objects && snap2.Validation.Total == snap.Validation.Total;
                    Close(again);
                }
                var errors = snap.Validation.ByType.Where(k => k.Key.Contains("Error")).Sum(k => k.Value);
                var warnings = snap.Validation.ByType.Where(k => k.Key.Contains("Warning")).Sum(k => k.Value);
                row = new ScanRow(rel, snap.Name, snap.Kind, snap.Key, bytes.Length, snap.Objects, snap.IsValid, snap.Validation.Total, errors, warnings,
                    snap.TopObjectTypes, snap.References.Count, loadMs, snap.VerifyMs, rt, saveMs, reloadObjects, null);
                objects += snap.Objects;
                if (snap.IsValid) ok++; else invalid++;
            }
            catch (Exception ex)
            {
                failed++;
                row = new ScanRow(rel, null, null, null, new FileInfo(f).Length, 0, false, 0, 0, 0, new Dictionary<string, int>(), 0, 0, 0, null, null, null, ex.GetType().Name + ": " + ex.Message);
            }
            finally { if (espace != null) Close(espace); }
            writer.WriteLine(JsonSerializer.Serialize(row));
            writer.Flush();
            if (n % 25 == 0 || n == files.Count)
                log?.Invoke($"{n}/{files.Count}: ok {ok}, invalid {invalid}, failed {failed}, skipped {skipped}, {objects:N0} objects, {sw.Elapsed.TotalSeconds:F0} s");
            if (n % 50 == 0) { GC.Collect(); GC.WaitForPendingFinalizers(); }
        }
        return new { dir, outFile, files = files.Count, ok, invalid, failed, skipped, objects, elapsedMs = sw.ElapsedMilliseconds };
    }

    private static void Close(ESpace espace)
    {
        try { ((OutSystems.Model.IESpace)espace).Close(); } catch { }
    }
}
