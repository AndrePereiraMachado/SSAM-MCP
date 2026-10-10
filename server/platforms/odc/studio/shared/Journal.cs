using System.Text;
using System.Text.Json;

// Append-only operations journal shared by builders, bridges and publishers.
// One JSON object per line. It never rewrites, never deletes and never throws:
// journaling must not be able to break a delivery.
internal sealed class Journal {
    public static readonly JsonSerializerOptions Line = new() { WriteIndented = false };
    public static readonly JsonSerializerOptions Pretty = new() { WriteIndented = true };
    private readonly string path;
    public Journal(string path) { this.path = path; }

    public sealed record Entry(
        string ts_start, string ts_end, string session, string tool, string command,
        string? module, string? module_key, string? base_sha256, string? candidate_sha256,
        int? studio_pid, int? attempt, string outcome, string gate, string? evidence_dir, string? note,
        string source = "live", string? feature = null);

    public void Append(Entry entry) {
        try {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            using var stream = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
            using var writer = new StreamWriter(stream, new UTF8Encoding(false));
            writer.WriteLine(JsonSerializer.Serialize(entry, Line));
        } catch { }
    }

    // outcome vocabulary: ok | gate_refused | native_error | uncertain | incomplete
    // "uncertain" means the native operation was already dispatched when the failure happened.
    // "incomplete" (set by the merge, never derived from an exception) means the merge applied and everything but the
    // named default values was proven equal to the candidate: the answer lists each one and its repair.
    public static string Outcome(Exception? error, bool handedOff) =>
        error == null ? "ok" : handedOff ? "uncertain" : error is InvalidOperationException ? "gate_refused" : "native_error";

    // gate vocabulary mirrors the decision table in PLANO-ODC3-SEM-FRICCAO.md.
    public static string Gate(string? message) {
        var text = message ?? "";
        bool Has(params string[] needles) => needles.Any(n => text.Contains(n, StringComparison.OrdinalIgnoreCase));
        if (Has("captured base", "outside the published baseline", "changed after", "predates the merge", "older than", "differs from its captured")) return "base_drift";
        if (Has("Native property differs", "Native object differs", "Unexpected native object addition", "lost or conflicts", "layout metadata", "layout additions", "differs from the complete verified candidate", "New object missing", "differs from the merged receipt")) return "equivalence";
        if (Has("author", "creator")) return "authorship";
        if (Has("provider")) return "provider_state";
        if (Has("Pending merge", "pending state", "pending native merge", "snapshot refused")) return "pending_match";
        if (Has("dialog is open", "did not become idle", "still running", "Studio dialog")) return "studio_busy";
        if (Has("given key", "KeyNotFound", "not present in the dictionary", "No model object matches", "Ambiguous model path")) return "key_not_found";
        if (Has("Module identity", "Expected exactly one open", "patch scope", "key mismatch")) return "scope";
        if (Has("validation error", "validation messages", "diagnostics", "DO-NOT-DELIVER")) return "candidate_validation";
        if (Has("already attempted", "already requested", "never retry")) return "retry_refused";
        return "none";
    }
}
