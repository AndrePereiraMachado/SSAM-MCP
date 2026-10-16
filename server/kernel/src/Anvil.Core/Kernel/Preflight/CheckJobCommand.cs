using System.Diagnostics;
using System.Text.Json.Nodes;
using Anvil.Reading;

namespace Anvil.Core.Preflight;

/// <summary>
/// CX16 (2026-10-15): `check-job` in both CLIs (one line each in Program.cs). Without the new flags it is the preflight of
/// today, field for field (JobPreflight.Check). With them the static check runs beside it (its own copy of the job), in the
/// same answer:
/// <code>check-job --job J [--module-index F] [--producer-index Name=F]... [--ui-catalog F]... [--basis-fresh true|false]</code>
/// F of the module or of a producer is an index file of the store (<c>&lt;sha&gt;.kernel.json</c> or <c>.builder.json</c>),
/// read as itself (never through the store of this assembly); its digest beside it is read too. The answer gains
/// <c>phases: ["preflight","static"]</c>, <c>static: {basis, checked, skipped, elapsedMs}</c>, the static problems (phase
/// static) in problems/warnings/errors, and <c>valid: false</c> when one is an error. A basis that does not read is listed
/// (static.basis.*.error) and its classes skipped, never a refusal.
/// </summary>
public static class CheckJobCommand
{
    public static object Run(string[] args)
    {
        var job = Need(args, "--job");
        var moduleFile = Opt(args, "--module-index");
        var producers = Many(args, "--producer-index");
        var catalogs = Many(args, "--ui-catalog");
        var freshText = Opt(args, "--basis-fresh");
        if (moduleFile == null && producers.Count == 0 && catalogs.Count == 0 && freshText == null) return JobPreflight.Check(job);
        // The static check reads its own copy of the job and its basis beside the preflight (pure, no shared state): the answer
        // is the same, the wall time the longer of the two.
        var lane = MessageExpectations.Lane;
        var staticPart = Task.Run(() => Static(job, lane, moduleFile, producers, catalogs, freshText));
        var result = JobPreflight.Check(job);
        var (basisJson, found, staticMs, opsCount) = staticPart.GetAwaiter().GetResult();
        // Once: what the pure preflight already said (the same op, pointer, code and message).
        var said = new HashSet<string>((result["problems"] as JsonArray ?? []).Concat(result["warnings"] as JsonArray ?? []).OfType<JsonObject>().Select(Key), StringComparer.Ordinal);
        var problems = result["problems"] as JsonArray ?? [];
        var warnings = result["warnings"] as JsonArray ?? [];
        var errors = result["errors"] as JsonArray ?? [];
        var added = 0; var addedWarnings = 0;
        foreach (var p in found.Problems.Where(p => said.Add(Key(p)))) { problems.Add(JobPreflight.PublicProblem(p)); errors.Add(JobPreflight.Text(p)); added++; }
        foreach (var w in found.Warnings.Where(w => said.Add(Key(w)))) { warnings.Add(JobPreflight.PublicProblem(w)); addedWarnings++; }
        result["problems"] = problems; result["warnings"] = warnings; result["errors"] = errors;
        result["valid"] = errors.Count == 0;
        result["phases"] = new JsonArray("preflight", "static");
        var (complete, rest) = Rest(problems, opsCount);
        result["static"] = new JsonObject { ["basis"] = basisJson, ["checked"] = found.Checked, ["skipped"] = found.Skipped,
            ["problems"] = added, ["warnings"] = addedWarnings, ["complete"] = complete, ["rest"] = rest, ["elapsedMs"] = staticMs };
        return result;
    }

    private static string Key(JsonObject p) => p["op"] + "|" + p["pointer"] + "|" + p["code"] + "|" + p["message"];

    /// <summary>CX16 r2 (M3, provisional, the owner's rule "one refusal with everything"): what the apply path (JobRunner: the
    /// base check, the apply of every op it does not refuse whole, the Verify of what applied; one refusal, their union) could
    /// still add to these problems. complete only when it provably adds nothing: the job does not read (the apply refuses it the
    /// same way) or every op is refused whole by its shape (JSON_SHAPE, OP_NOT_OBJECT: JobRunner.RefusedWhole never applies
    /// them, and an op it cannot read has nothing for the base check). Anything else may add an independent problem, so a
    /// caller that stops before the apply only on complete never splits one refusal in two.</summary>
    internal static (bool Complete, JsonArray Left) Rest(JsonArray problems, int? opsCount)
    {
        if (opsCount == null) return (true, []);
        var unreadable = problems.OfType<JsonObject>().Where(p => p["code"]?.ToString() is JobDocument.ShapeCode or "OP_NOT_OBJECT" && p["op"] is JsonValue v && v.TryGetValue<int>(out _))
            .Select(p => p["op"]!.GetValue<int>()).ToHashSet();
        var applied = Enumerable.Range(0, opsCount.Value).Where(i => !unreadable.Contains(i)).ToList();
        if (opsCount.Value > 0 && applied.Count == 0) return (true, []);
        var rest = new JsonArray(new JsonObject { ["phase"] = "base", ["reason"] = "the checks that need the model (callees, paths and @keys of the base, writable properties)" });
        if (applied.Count > 0)
            rest.Add(new JsonObject { ["phase"] = "apply+verify", ["ops"] = new JsonArray(applied.Take(50).Select(i => (JsonNode)i).ToArray()), ["count"] = applied.Count,
                ["reason"] = "the apply runs these ops and the Verify judges what applied" });
        return (false, rest);
    }

    private static (JsonObject Basis, StaticChecks.Result Found, long Ms, int? OpsCount) Static(string job, string lane, string? moduleFile, List<string> producers, List<string> catalogs, string? freshText)
    {
        var clock = Stopwatch.StartNew();
        var basisJson = new JsonObject();
        ModuleIndex? module = null; JsonObject? digest = null;
        if (moduleFile != null) {
            var entry = new JsonObject { ["file"] = Path.GetFullPath(moduleFile) };
            try {
                module = StaticBasis.ReadIndex(moduleFile);
                digest = StaticBasis.DigestBeside(moduleFile);
                entry["sha256"] = module.SourceSha256; entry["lane"] = module.Lane; entry["adapter"] = module.Adapter; entry["module"] = module.ModuleName;
                entry["digest"] = digest != null;
            } catch (Exception error) { entry["error"] = error.Message; }
            entry["fresh"] = module != null && freshText?.Equals("true", StringComparison.OrdinalIgnoreCase) == true;
            basisJson["module"] = entry;
        }
        var producerBases = new List<ProducerBasis>();
        var producerJson = new JsonArray();
        foreach (var value in producers) {
            var at = value.IndexOf('=');
            var name = at > 0 ? value[..at] : value; var file = at > 0 ? value[(at + 1)..] : "";
            var entry = new JsonObject { ["name"] = name, ["file"] = file.Length > 0 ? Path.GetFullPath(file) : null };
            try {
                var index = StaticBasis.ReadIndex(file);
                producerBases.Add(new ProducerBasis(name, file, index.SourceSha256, index, StaticBasis.DigestBeside(file)));
                entry["sha256"] = index.SourceSha256;
            } catch (Exception error) { entry["error"] = error.Message; }
            producerJson.Add(entry);
        }
        basisJson["producers"] = producerJson;
        var catalogBases = new List<UiCatalogBasis>();
        var catalogJson = new JsonArray();
        foreach (var file in catalogs) {
            var entry = new JsonObject { ["file"] = Path.GetFullPath(file) };
            try {
                var catalog = UiCatalog.ReadJson(file);
                // The version the module imports is in neither its index nor its digest: a catalog says which blocks exist (S1), and
                // what it says of their contracts (S2) is a warning.
                catalogBases.Add(new UiCatalogBasis(file, catalog.Name, catalog.Version, false, catalog));
                entry["library"] = catalog.Name; entry["version"] = catalog.Version; entry["versionMatches"] = false;
                entry["note"] = "the version the module imports is not known here: its problems are warnings";
            } catch (Exception error) { entry["error"] = error.Message; }
            catalogJson.Add(entry);
        }
        basisJson["uiCatalog"] = catalogJson;
        var basis = new StaticBasis { Lane = lane, Module = module, Digest = digest, ModuleFile = moduleFile, Fresh = module != null && freshText?.Equals("true", StringComparison.OrdinalIgnoreCase) == true,
            Producers = producerBases, UiCatalogs = catalogBases };
        StaticChecks.Result found;
        int? opsCount = null;
        try {
            var document = JobDocument.Parse(job);
            var ops = JobRunner.CollectOps(document, Path.GetDirectoryName(Path.GetFullPath(job))!);
            opsCount = ops.Count;
            // M1: a job that expects an invalid module (expectValid false) asks the Verify for that verdict (JobPreflight.Analyze).
            var expectsInvalid = document is JsonObject o && o["expectValid"] is JsonValue v && v.TryGetValue<bool>(out var expected) && !expected;
            found = StaticChecks.Run(ops, JobPreflight.OpsPointer(document), lane, basis, verifyRules: !expectsInvalid);
        } catch (Exception error) {
            // A job the preflight cannot read is its refusal; the static check then judges nothing.
            found = new StaticChecks.Result([], [], [], [new JsonObject { ["class"] = "static", ["reason"] = "the job could not be read: " + error.Message }]);
        }
        return (basisJson, found, clock.ElapsedMilliseconds, opsCount);
    }

    private static string? Opt(string[] args, string name) { var i = Array.IndexOf(args, name); return i >= 0 && i + 1 < args.Length ? args[i + 1] : null; }
    private static string Need(string[] args, string name) => Opt(args, name) ?? throw new ArgumentException("missing " + name);
    private static List<string> Many(string[] args, string name)
    {
        var values = new List<string>();
        for (var i = 0; i + 1 < args.Length; i++) if (args[i] == name) values.Add(args[i + 1]);
        return values;
    }
}
