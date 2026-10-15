using System.Diagnostics;
using System.Text.Json.Nodes;

namespace Anvil.Core;

/// <summary>What the bridge read of one Studio dialog window: an identity stable while the window lives, its type, title,
/// the texts of its visual tree (TextBlock, "[Button] X") and, for a web dialog (DialogWindow), the text of its page
/// (document.body.innerText, read only; null when the page did not answer). Presenter: a modal presenter of the tab's
/// aggregator (Manage Dependencies, merge editor), which is not a window: Type is its kind (DialogPolicy), Title its name.</summary>
public sealed record DialogRead(string Id, string? Type, string? Title, IReadOnlyList<string> Texts, string? WebText, bool Web, bool Presenter = false);

/// <summary>The decision about one dialog an SSAM operation opened: its kind, whether the answer is certain, the answer
/// (close = the window's X, which is OK of an error report and Cancel of a question), the dialog's text as read, its
/// buttons, and, when the answer is not certain, the one question for the person (pt-BR, with the exact text).</summary>
public sealed record DialogDecision(string Kind, bool Certain, string? Answer, string Text, IReadOnlyList<string> Buttons, string? Question, bool Transient = false)
{
    public JsonObject ToJson(DialogRead read) => new()
    {
        ["kind"] = Kind, ["title"] = read.Title, ["type"] = read.Type, ["text"] = Text,
        ["buttons"] = new JsonArray(Buttons.Select(b => (JsonNode)b).ToArray()),
        ["certain"] = Certain, ["answer"] = Answer, ["question"] = Question, ["readable"] = read.WebText != null || !read.Web,
    };
}

/// <summary>
/// Family D (fam-deps, 2026-10-12): a dialog the Studio opens DURING an SSAM operation (apply, merge, publish) is the
/// operation's, never the owner's. The live incident: the Studio's "Unexpected Error" (a web DialogWindow) opened inside
/// merge_from_oml, the bridge saw only its title and the close button ("[Button] Viewbox"), and the merge waited 30 min
/// for the owner to close it. The Studio's own code shows why it opens: an exception that leaves the delegate of a
/// non-nested Command.Execute reaches Runtime.SafeExecute(ExceptionType.InsideCommand), which rolls the command back and
/// shows the crash dialog (CrashExperience.FullyVisible), modal, then swallows the exception (ServiceStudio.Framework,
/// Command.SafeExecute / Runtime.InnerSafeExecute). QuietCommand (Adapters.SS11) keeps SSAM's own exceptions inside its
/// commands; this policy answers whatever dialog still opens.
///
/// Rules, pure: an error report (Unexpected Error) is closed (certain: it asks nothing; the Studio already rolled the
/// command back); the dependencies dialog is closed as Cancel (MB2, the caller refreshes the references); a native message
/// box whose only button is OK/Close is closed; a progress window is transient (never touched); everything else (recovery
/// Open|Discard, sign-in, consent, a question with choices, a web dialog whose page the bridge cannot read) is not certain:
/// the operation answers at once with the exact text and the one question for the person. Only windows that appeared
/// after the operation started are ever decided (OperationDialogLoop); a dialog that was open before is the person's.
/// </summary>
public static class OperationDialogPolicy
{
    public const string UnexpectedError = "UnexpectedError";
    public const string Dependencies = "DependenciesDialog";
    public const string SignIn = "SignIn";
    public const string Consent = "Consent";
    public const string Question = "Question";
    public const string Unreadable = "UnreadableWebDialog";
    /// <summary>A modal presenter of the tab (Manage Dependencies, merge editor) opened during the operation: never answered by
    /// SSAM (it is an editor, not a question), so the operation answers blocked with the question at once.</summary>
    public const string ModalPresenter = "ModalPresenter";
    /// <summary>The bridge capability: merge_from_oml watches the dialogs its operation opens and answers them by this policy.</summary>
    public const string Capability = "merge_from_oml:dialog_watch";

    private static readonly string[] ErrorTitles = ["Unexpected Error", "Unexpected error", "Erro inesperado"];
    private static readonly string[] SignInWords = ["sign in", "sign-in", "log in", "login", "password", "username", "single sign-on"];
    private static readonly string[] ConsentWords = ["accept", "agree", "terms", "consent", "license agreement"];
    private const string DependenciesText = "Incompatible or missing dependencies";
    private static readonly string[] Dismissive = ["OK", "Ok", "Close", "Fechar"];

    /// <summary>The buttons a read shows: "[Button] X" texts (the close glyph "Viewbox" is the window's X, not a choice).</summary>
    public static IReadOnlyList<string> Buttons(DialogRead read)
        => read.Texts.Where(t => t.StartsWith("[Button] ", StringComparison.Ordinal)).Select(t => t[9..].Trim())
            .Where(b => b.Length > 0 && b != "Viewbox").Distinct(StringComparer.Ordinal).ToArray();

    /// <summary>The visible text of a read, one line: the page text of a web dialog, else the visual texts (no buttons).</summary>
    public static string TextOf(DialogRead read)
    {
        var parts = read.WebText is { Length: > 0 } web ? [web] : read.Texts.Where(t => !t.StartsWith("[Button]", StringComparison.Ordinal)).ToList();
        var text = string.Join(" ", parts.SelectMany(p => p.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)));
        return text.Length > 1500 ? text[..1500] + "..." : text;
    }

    public static DialogDecision Decide(DialogRead read)
    {
        var text = TextOf(read);
        var buttons = Buttons(read);
        var title = (read.Title ?? "").Trim();
        var all = title + " " + text;
        // fam-deps (finding 6): a modal presenter is an editor of the tab, not a window with a question; the watch never closes
        // it, so the operation answers at once instead of waiting for the bound (UiGate.Heavy) with no text.
        if (read.Presenter)
            return new(string.IsNullOrWhiteSpace(read.Type) ? ModalPresenter : read.Type!, false, null, text, buttons,
                Ask(read, text, buttons, "Aplique ou feche esse editor no Studio; depois retome a entrega."));
        var kind = DialogPolicy.ClassifyWindow(read.Title, read.Texts.Concat(read.WebText is { } w ? [w] : []));
        if (kind == DialogPolicy.Progress && buttons.Count == 0) return new(DialogPolicy.Progress, false, null, text, buttons, null, Transient: true);
        if (ErrorTitles.Any(t => title.Equals(t, StringComparison.OrdinalIgnoreCase)) || IsErrorReport(all))
            return new(UnexpectedError, true, "close", text, buttons, null);
        if ((read.Type ?? "").Contains("DialogWindow", StringComparison.Ordinal) && all.Contains(DependenciesText, StringComparison.OrdinalIgnoreCase))
            return new(Dependencies, true, "close", text, buttons, null);
        if (kind == DialogPolicy.Recovery)
            return new(DialogPolicy.Recovery, false, null, text, buttons, Ask(read, text, buttons, "Escolha Open ou Discard no Studio."));
        if (SignInWords.Any(s => Contains(all, s)))
            return new(SignIn, false, null, text, buttons, Ask(read, text, buttons, "Entre no Studio. O SSAM nunca digita senha."));
        if (ConsentWords.Any(s => Contains(all, s)))
            return new(Consent, false, null, text, buttons, Ask(read, text, buttons, "Responda no Studio."));
        if (read.Web && read.WebText == null)
            return new(Unreadable, false, null, text, buttons, Ask(read, text, buttons, "O SSAM não conseguiu ler o texto. Leia e responda no Studio."));
        if (!read.Web && buttons.Count > 0 && buttons.All(b => Dismissive.Contains(b, StringComparer.OrdinalIgnoreCase)))
            return new(DialogPolicy.MessageBox, true, "close", text, buttons, null);
        return new(Question, false, null, text, buttons, Ask(read, text, buttons, buttons.Count > 0 ? "Escolha no Studio: " + string.Join(" | ", buttons) + "." : "Responda no Studio."));
    }

    // An error report of the Studio without its title: the crash page names the error and offers to report it.
    private static bool IsErrorReport(string all)
        => Contains(all, "unexpected error") || (Contains(all, "exception") && (Contains(all, "report") || Contains(all, "stack trace")));

    private static bool Contains(string text, string word) => text.Contains(word, StringComparison.OrdinalIgnoreCase);

    private static string Ask(DialogRead read, string text, IReadOnlyList<string> buttons, string what)
        => "O Studio abriu \"" + (string.IsNullOrWhiteSpace(read.Title) ? "um diálogo" : read.Title!.Trim()) + "\" durante a entrega"
           + (text.Length > 0 ? ": " + (text.Length > 300 ? text[..300] + "..." : text) : "") + ". " + what;

    /// <summary>fam-deps (finding 1): whether a dialog entry an operation closed is an error the Studio reported (its crash
    /// report, or a message box with only OK whose text is an error). The command that raised it was rolled back by the
    /// Studio and the exception swallowed, so the operation's own result can no longer be trusted alone.</summary>
    public static bool IsStudioError(JsonObject? entry)
    {
        var kind = entry?["kind"]?.ToString();
        if (kind == UnexpectedError) return true;
        if (kind != DialogPolicy.MessageBox) return false;
        var all = (entry?["title"]?.ToString() ?? "") + " " + (entry?["text"]?.ToString() ?? "");
        return ErrorWords.Any(w => Contains(all, w));
    }

    private static readonly string[] ErrorWords = ["error", "erro", "exception", "failed", "falhou"];

    /// <summary>The next-step sentence of a blocking dialog of this kind (Dialogs.BlockedBy hints).</summary>
    public static string Hint(string kind) => kind switch
    {
        UnexpectedError => "the Studio's \"Unexpected Error\" report is open: when an SSAM merge opened it, the bridge closes it and records its text in the merge receipt; "
            + "otherwise close it by its title (o11_studio dismiss-dialog) and retry; the Studio already rolled back the command that failed",
        _ => DialogPolicy.Hint(kind),
    };
}

/// <summary>The Studio's dialog windows as the operation loop sees them. The bridge implements it over Avalonia (UI thread,
/// bounded); the tests fake it. List: the visible dialog windows now, by identity. Read: what the window shows. Close:
/// closes it as decided (true when it is gone).</summary>
public interface IStudioDialogSurface
{
    Task<IReadOnlyList<string>> List();
    Task<DialogRead?> Read(string id);
    Task<bool> Close(string id, DialogDecision decision);
}

/// <summary>How an operation watched by OperationDialogLoop ended: done (its result), blocked (a dialog that needs the
/// person, decided at once) or timed out (the bound passed). Answered: every dialog the loop closed, in order.</summary>
public sealed record DialogLoopOutcome<T>(string State, T? Result, JsonArray Answered, JsonObject? Blocked, long ElapsedMs);

/// <summary>
/// The watch of one SSAM operation (merge_from_oml, refresh_references): while the operation runs, every poll lists the dialog
/// windows; a window that was not open when the operation started is read and decided (OperationDialogPolicy). Certain:
/// closed, and the entry joins Answered before the close (so the operation's own receipt, written when the closed dialog
/// releases it, already carries it). Not certain, or a close that did not take: the loop ends at once (State "blocked")
/// with the dialog and the question, while the operation keeps waiting in the Studio for the person.
/// fam-deps review: (finding 4) a web dialog whose page has no text yet is read again each poll for WebSettle before it can be
/// decided as a question, so the dependencies dialog read before its page loaded is still closed by rule; (finding 5) with
/// <c>pending</c> the loop never ends on a question: it reports the current one (null when none is open) and keeps closing
/// the certain dialogs until the operation ends, the watch the bridge keeps after it answered blocked; (finding 1) when the
/// operation ends, one last pass closes a certain dialog it opened as it ended. Transient windows (progress) are left alone.
/// Pure: no Studio type.
/// </summary>
public static class OperationDialogLoop
{
    /// <summary>How long a web dialog without page text waits for its page before it is decided (finding 4).</summary>
    public static readonly TimeSpan WebSettle = TimeSpan.FromSeconds(10);

    public static async Task<DialogLoopOutcome<T>> Watch<T>(Task<T> operation, IStudioDialogSurface surface, TimeSpan limit, TimeSpan poll,
        Action<JsonObject>? answered = null, ISet<string>? before = null, Action<JsonObject?>? pending = null, TimeSpan? webSettle = null)
    {
        var sw = Stopwatch.StartNew();
        var preexisting = before ?? new HashSet<string>(await DialogSweep.Safe(surface.List, (IReadOnlyList<string>)[]), StringComparer.Ordinal);
        var sweep = new DialogSweep(surface, preexisting, webSettle: webSettle) { OnAnswered = answered };
        JsonObject? waiting = null;
        while (true)
        {
            var remaining = limit - sw.Elapsed;
            if (remaining <= TimeSpan.Zero) return new("timed-out", default, sweep.Answered, null, sw.ElapsedMilliseconds);
            var wait = remaining < poll ? remaining : poll;
            if (await Task.WhenAny(operation, Task.Delay(wait)).ConfigureAwait(false) == operation)
            {
                // Finding 1: a certain dialog the operation opened as it ended (its error report still on screen) is closed too.
                await sweep.Pass(closeOnly: true).ConfigureAwait(false);
                if (waiting != null) pending?.Invoke(null);
                return new("done", await operation.ConfigureAwait(false), sweep.Answered, null, sw.ElapsedMilliseconds);
            }
            var blocked = await sweep.Pass(closeOnly: false).ConfigureAwait(false);
            if (pending == null)
            {
                if (blocked != null) return new("blocked", default, sweep.Answered, blocked, sw.ElapsedMilliseconds);
                continue;
            }
            // Finding 5: the current question, reported when it changes (a new one, or none once the person answered).
            if (!JsonNode.DeepEquals(waiting, blocked)) { waiting = blocked?.DeepClone().AsObject(); pending(blocked?.DeepClone().AsObject()); }
        }
    }
}

/// <summary>
/// One sweep of the Studio's dialog windows for an operation, kept across polls: what was decided is not read again, a web
/// dialog without page text gets WebSettle to load it (finding 4), and a dialog left to the person stays the question while
/// it is open. Accept: which certain decisions this operation closes (null: every one; publish and the pre-checks close only
/// the Studio's error reports, ErrorReportsOnly, and leave every other dialog to their own rules). Pure: no Studio type.
/// </summary>
public sealed class DialogSweep(IStudioDialogSurface surface, ISet<string>? skip = null, Func<DialogDecision, bool>? accept = null, TimeSpan? webSettle = null)
{
    private readonly ISet<string> skip = skip ?? new HashSet<string>(StringComparer.Ordinal);
    private readonly HashSet<string> decided = new(StringComparer.Ordinal);
    private readonly Dictionary<string, long> firstSeen = new(StringComparer.Ordinal);
    private readonly Dictionary<string, JsonObject> waiting = new(StringComparer.Ordinal);
    private readonly TimeSpan settle = webSettle ?? OperationDialogLoop.WebSettle;
    private readonly Stopwatch clock = Stopwatch.StartNew();

    /// <summary>Every dialog this sweep closed (or tried to close), in order, each with closed.</summary>
    public JsonArray Answered { get; } = new();
    /// <summary>Hears each entry before its window is closed (the receipt's copy).</summary>
    public Action<JsonObject>? OnAnswered { get; init; }

    /// <summary>The Studio's error reports only: what any SSAM verb closes by itself (they ask nothing, the Studio already
    /// rolled back the command that raised them).</summary>
    public static bool ErrorReportsOnly(DialogDecision decision) => decision.Kind == OperationDialogPolicy.UnexpectedError;

    /// <summary>One pass: closes each certain dialog that appeared and returns the dialog that needs the person (the first one
    /// open), or null. closeOnly: a dialog that is not certain is left as it is and not reported.</summary>
    public async Task<JsonObject?> Pass(bool closeOnly)
    {
        var ids = await Safe(surface.List, (IReadOnlyList<string>)[]).ConfigureAwait(false);
        foreach (var gone in waiting.Keys.Where(k => !ids.Contains(k, StringComparer.Ordinal)).ToList()) waiting.Remove(gone);
        JsonObject? blocked = null;
        foreach (var id in ids)
        {
            if (waiting.TryGetValue(id, out var still)) { if (!closeOnly) blocked ??= still; continue; }
            if (skip.Contains(id) || decided.Contains(id)) continue;
            var read = await Safe(() => surface.Read(id), null).ConfigureAwait(false);
            if (read == null) continue;   // gone between the list and the read
            var decision = OperationDialogPolicy.Decide(read);
            if (decision.Transient) continue;
            if (!firstSeen.TryGetValue(id, out var first)) firstSeen[id] = first = clock.ElapsedMilliseconds;
            // Finding 4: a web dialog read before its page loaded (no text) is read again on the next poll, up to WebSettle.
            if (!decision.Certain && read.Web && string.IsNullOrWhiteSpace(read.WebText) && clock.ElapsedMilliseconds - first < settle.TotalMilliseconds)
                continue;
            var entry = decision.ToJson(read);
            entry["seenAtMs"] = clock.ElapsedMilliseconds;
            if (!decision.Certain)
            {
                if (closeOnly) continue;
                entry["answer"] = null;
                waiting[id] = entry; blocked ??= entry;
                continue;
            }
            decided.Add(id);
            if (accept != null && !accept(decision)) continue;   // certain, but not this operation's to close
            // The receipt's copy joins before the close: the operation the closed dialog releases writes it at once.
            Answered.Add(entry); OnAnswered?.Invoke(entry.DeepClone().AsObject());
            var closed = await Safe(() => surface.Close(id, decision), false).ConfigureAwait(false);
            entry["closed"] = closed;
            if (!closed && !closeOnly)
            {
                var unclosed = entry.DeepClone().AsObject();
                unclosed["answer"] = null;
                unclosed["question"] = "O Studio abriu \"" + (read.Title ?? "um diálogo") + "\" durante a entrega e o SSAM não conseguiu fechá-lo. Feche-o no Studio.";
                waiting[id] = unclosed; blocked ??= unclosed;
            }
        }
        return blocked;
    }

    internal static async Task<TR> Safe<TR>(Func<Task<TR>> f, TR fallback)
    {
        try { return await f().ConfigureAwait(false); }
        catch (Exception) { return fallback; }
    }
}
