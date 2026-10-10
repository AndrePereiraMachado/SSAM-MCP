using System.Text.Json.Nodes;

namespace Anvil.Bridge;

/// <summary>
/// C10 (package 3): one view of what blocks the Studio, for wait, status and publish alike. Dialogs.BlockedBy answers per
/// aggregator (its modal presenters) plus every owned window; a Manage Dependencies presenter of another tab or of the second
/// window has no window of its own, so a read of the active tab alone never saw it (LF-04: a publish stuck behind it until
/// its 600 s timeout). Pure, no Studio type: linked into Anvil.Tests (Anvil.Tests.csproj) for its rule tests.
/// </summary>
internal static class DialogScope
{
    public const string BlockedCapability = "publish:blocked_by_dialog";
    public const string DialogsCapability = "list_open_modules:dialogs";
    public const string WindowCapability = "list_open_modules:window";
    public const string Code = "PUBLISH_BLOCKED_BY_DIALOG";

    /// <summary>The dialogs that keep a publication from going on: the references dialog, the merge editor, the recovery
    /// dialog and a web dialog (whose text the bridge cannot read). A message box or a progress window is not one.</summary>
    public static readonly IReadOnlySet<string> PublishBlocking = new HashSet<string>(StringComparer.Ordinal)
        { BridgeKit.ManageDependencies, BridgeKit.MergeEditor, BridgeKit.Recovery, BridgeKit.WebDialog };

    /// <summary>The union of every aggregator's BlockedBy: presenter entries tagged with their module, window entries once
    /// (each aggregator's read repeats the same windows).</summary>
    public static JsonArray Union(IEnumerable<(string? Module, JsonArray BlockedBy)> perAggregator)
    {
        var union = new JsonArray();
        var windows = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (module, blockedBy) in perAggregator)
            foreach (var entry in blockedBy.OfType<JsonObject>())
            {
                if (entry["source"]?.ToString() == "window")
                {
                    if (!windows.Add(entry["type"] + "|" + entry["title"] + "|" + entry["contentKind"])) continue;
                    union.Add(entry.DeepClone());
                    continue;
                }
                var tagged = entry.DeepClone().AsObject();
                tagged["module"] = module;
                union.Add(tagged);
            }
        return union;
    }

    /// <summary>The entries of one module's own presenters (its pendingDialogs in list_open_modules).</summary>
    public static JsonArray Presenters(JsonArray blockedBy) =>
        new(blockedBy.OfType<JsonObject>().Where(e => e["source"]?.ToString() != "window").Select(e => (JsonNode)e.DeepClone()).ToArray());

    /// <summary>The dialogs of the union that are not the active module's own presenters (get_active_module.otherDialogs).</summary>
    public static JsonArray Others(JsonArray union, string? activeModule) =>
        new(union.OfType<JsonObject>().Where(e => e["source"]?.ToString() == "window" || !string.Equals(e["module"]?.ToString(), activeModule, StringComparison.OrdinalIgnoreCase))
            .Select(e => (JsonNode)e.DeepClone()).ToArray());

    /// <summary>The rule of OpenHandler for the publication: a blocking dialog present in three reads in a row ends the wait
    /// with the dialogs of the last read; a read without one starts the count again. A null read (not read this time) keeps
    /// the count.</summary>
    public sealed class Streak
    {
        private int count;
        public JsonArray? Observe(JsonArray? read)
        {
            if (read == null) return null;
            var blocking = new JsonArray(read.OfType<JsonObject>().Where(e => PublishBlocking.Contains(e["kind"]?.ToString() ?? "")).Select(e => (JsonNode)e.DeepClone()).ToArray());
            count = blocking.Count > 0 ? count + 1 : 0;
            return count >= 3 ? blocking : null;
        }
    }

    /// <summary>The answer of a publication stopped by a dialog: published:false, the dialogs, and the outcome: not-started when
    /// no server process of this publication was seen (nothing reached the server), else uncertain (it may still finish).</summary>
    public static JsonObject PublishBlocked(string module, JsonArray blockedBy, bool processStarted, JsonArray dialogsSeen, long elapsedMs) => new()
    {
        ["module"] = module, ["published"] = false, ["code"] = Code, ["outcome"] = processStarted ? "uncertain" : "not-started",
        ["blockedBy"] = blockedBy, ["dialogsSeen"] = dialogsSeen, ["elapsedMs"] = elapsedMs,
        ["error"] = "publish: '" + module + "' is blocked by " + DialogsLabel(blockedBy)
            + (processStarted ? "; the publication had started and may still finish: read publish_log before any new attempt" : "; nothing was published"),
    };

    private static string DialogsLabel(JsonArray blockedBy) =>
        string.Join("; ", blockedBy.OfType<JsonObject>().Select(e => e["kind"] + (e["module"] is { } m ? " of " + m : "") + (e["title"] is { } t && t.ToString().Length > 0 ? " (" + t + ")" : "")));

    // ---- MB2 (owner rule 2026-10-07): the Studio's dialog "Incompatible or missing dependencies found" never stops a call.
    // It is a web DialogWindow (Manage Dependencies | Cancel) the Studio shows when a producer of the module changed. The
    // bridge closes it as Cancel (Close() of that window, never Manage Dependencies, which opens the blocking presenter);
    // the caller then runs the Studio's own Refresh References (refresh_references {module_key}) for every producer of the
    // module and goes on. Every other dialog still goes to the person. Callers ask for it (answer_dependencies:true on
    // open_module and publish, or the verb answer_dependencies_dialog) only when the bridge offers this capability.

    public const string DependenciesCapability = "dialogs:dependencies_auto";
    public const string DependenciesVerb = "answer_dependencies_dialog";
    public const string DependenciesKind = "DependenciesDialog";
    /// <summary>The text that names the dialog, in its title or in its web page.</summary>
    public const string DependenciesText = "Incompatible or missing dependencies";

    /// <summary>True only for the dependencies dialog: a DialogWindow whose title or web text says "Incompatible or missing
    /// dependencies". A recovery dialog, a sign-in page or any other web dialog is never one, whatever buttons it has.</summary>
    public static bool IsDependenciesDialog(string? type, string? title, string? text) =>
        (type ?? "").Contains("DialogWindow", StringComparison.Ordinal)
        && ((title ?? "").Contains(DependenciesText, StringComparison.OrdinalIgnoreCase) || (text ?? "").Contains(DependenciesText, StringComparison.OrdinalIgnoreCase));

    /// <summary>The visible dialogs to close as Cancel, by index: the dependencies dialogs, and only the one titled
    /// <paramref name="title"/> when a title is given (the release dismiss_dialog).</summary>
    public static IReadOnlyList<int> DependenciesToClose(IReadOnlyList<(string? Type, string? Title, string? Text)> dialogs, string? title = null) =>
        dialogs.Select((d, i) => (d, i))
            .Where(x => IsDependenciesDialog(x.d.Type, x.d.Title, x.d.Text)
                && (title == null || string.Equals(x.d.Title?.Trim(), title.Trim(), StringComparison.OrdinalIgnoreCase)))
            .Select(x => x.i).ToList();

    /// <summary>One answered dialog, as the answers and the delivery receipt list it.</summary>
    public static JsonObject Answered(string? title, string? text) => new()
    {
        ["kind"] = DependenciesKind, ["title"] = string.IsNullOrWhiteSpace(title) ? null : title, ["answer"] = "Cancel",
        ["text"] = text == null ? null : Clip(string.Join(" ", text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)), 300),
    };

    /// <summary>A dialog read worth asking the WebView about: a web window of the read (the bridge cannot see its text in
    /// the visual tree, so ClassifyWindow names it WebDialog or, by its title, ManageDependencies).</summary>
    public static bool MayBeDependencies(JsonArray? read) =>
        read != null && read.OfType<JsonObject>().Any(e => e["source"]?.ToString() == "window" && e["contentKind"]?.ToString() == "web");

    /// <summary>How long a publication whose command ended is watched, after the answer, for a server process before it
    /// counts as cancelled (the process of a publication may show a moment after its command returns).</summary>
    public static readonly TimeSpan DependenciesSettle = TimeSpan.FromSeconds(3);

    /// <summary>What a publication does after the bridge closed the dependencies dialog. The Studio's Cancel also cancels the
    /// 1-Click Publish that showed it: a command that ended, with no server process of this publication seen for
    /// DependenciesSettle after the answer, reached nothing ("not-started": the caller refreshes the references and publishes
    /// again in the same call). A process seen is followed as before ("follow"); anything else waits ("wait").</summary>
    public static string AfterDependenciesAnswer(bool commandCompleted, bool processSeen, TimeSpan sinceAnswer) =>
        processSeen ? "follow" : commandCompleted && sinceAnswer >= DependenciesSettle ? "not-started" : "wait";

    /// <summary>The answer of a publication the dependencies dialog cancelled: published:false, nothing reached the server,
    /// the dialog answered, the next step (refresh_references, then publish again).</summary>
    public static JsonObject PublishCancelledByDependencies(string module, JsonArray answered, JsonArray dialogsSeen, long elapsedMs) => new()
    {
        ["module"] = module, ["published"] = false, ["code"] = Code, ["outcome"] = "not-started",
        ["blockedBy"] = new JsonArray(answered.OfType<JsonObject>().Select(a => (JsonNode)new JsonObject
            { ["kind"] = BridgeKit.ManageDependencies, ["title"] = a["title"]?.DeepClone(), ["source"] = "window", ["module"] = module }).ToArray()),
        ["dependenciesDialog"] = new JsonObject { ["answered"] = answered.DeepClone(), ["next"] = "refresh_references" },
        ["dialogsSeen"] = dialogsSeen, ["elapsedMs"] = elapsedMs,
        ["error"] = "publish: '" + module + "' showed the dependencies dialog; the bridge answered it (Cancel) and nothing was published: "
            + "refresh the references (refresh_references) and publish again",
    };

    private static string Clip(string text, int max) => text.Length > max ? text[..max] + "..." : text;
}
