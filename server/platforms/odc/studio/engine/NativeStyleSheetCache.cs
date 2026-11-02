using OutSystems.Model;
using ServiceStudio.Hashes;
using ServiceStudio.Model;
using ServiceStudio.Model.Interfaces;
using System.Reflection;

// U1 (bridge v106/v107), ported from the proto's v105 (two published revisions of a customer module, 2026-10-28): a semantic merge
// proof does not prove the compilation caches the Studio serializes and publishes with. A merged stylesheet whose source
// is the candidate's could still carry the hashes of the base, and the server then published the old CSS (82,806 instead
// of 82,815 characters) while the bridge answered ok:true. So, after the merge and again right before the publication:
// the effective, author and generated text of every stylesheet this delivery changed is checked against the candidate,
// and only then are the native caches of the sheet and of its owner invalidated, recursively. Nothing here writes CSS,
// audit dates, keys or any property of the application: a source that differs is a refusal, never repaired from the
// candidate. After a publication, Differences compares the downloaded revision's sources with the submitted module.
internal static class NativeStyleSheetCache
{
    private static readonly MethodInfo InvalidateTree = typeof(AbstractObject).GetMethod("InvalidateHashesRecursively", BindingFlags.Instance | BindingFlags.NonPublic)
        ?? throw new MissingMethodException(typeof(AbstractObject).FullName, "InvalidateHashesRecursively");

    // One refreshed sheet: its key and its General|Compilation|CompilationInterface|Debugger hashes before and after.
    internal sealed record Entry(string Key, string Before, string After);
    // The three texts of a sheet (ThemeCss: effective, author, generated).
    internal sealed record SourceText(string? Effective, string? Author, string? Generated);

    internal static Dictionary<string, SourceText> Capture(ESpace model) => Sheets(model)
        .ToDictionary(pair => pair.Key, pair => Source(pair.Value), StringComparer.Ordinal);

    // The keys of the sheets whose source differs, is missing on one side or is new on the other. Sources, never the native
    // hashes: stale hashes are exactly what this check exists to catch.
    internal static string[] Differences(ESpace actual, IReadOnlyDictionary<string, SourceText> expected)
    {
        var current = Capture(actual);
        return current.Keys.Union(expected.Keys).Where(key =>
            !current.TryGetValue(key, out var source) || !expected.TryGetValue(key, out var target) || source != target)
            .OrderBy(key => key, StringComparer.Ordinal).ToArray();
    }

    // live: the open module after the merge; expected: the candidate; basis: the captured base, or null for a created module
    // (every sheet of the candidate is then the delivery's). Refuses (InvalidOperationException) when a changed sheet is missing
    // from live or its source differs from the candidate's, before anything is invalidated.
    internal static Entry[] Refresh(ESpace live, ESpace expected, ESpace? basis)
    {
        var previous = basis == null ? new Dictionary<string, WebStyleSheet>(StringComparer.Ordinal) : Sheets(basis);
        var actual = Sheets(live);
        var changed = Sheets(expected).Where(pair => !previous.TryGetValue(pair.Key, out var old) || Source(old) != Source(pair.Value))
            .Select(pair => (pair.Key, Sheet: actual.TryGetValue(pair.Key, out var sheet) ? sheet
                : throw new InvalidOperationException("Merged stylesheet missing from the open module: " + pair.Key + "; nothing was published."),
                Expected: Source(pair.Value))).ToArray();
        // The whole set is checked before anything is invalidated: a lost or different source stays a refusal of the merge.
        foreach (var item in changed)
            if (Source(item.Sheet) != item.Expected)
                throw new InvalidOperationException("Merged stylesheet differs from the candidate: " + item.Key + "; nothing was published.");
        if (changed.Length == 0) return [];

        var entries = new List<Entry>();
        ((IESpace)live).TransactionsManager.ExecuteTransaction("SSAM: refresh merged stylesheet caches", (_, _) =>
        {
            foreach (var item in changed)
            {
                if (Source(item.Sheet) != item.Expected)
                    throw new InvalidOperationException("Stylesheet source differs in the native transaction: " + item.Key + "; nothing was published.");
                var before = Hashes(item.Sheet);
                // The owning compilation unit and its descendants, not only the sheet's own cache.
                var unit = item.Sheet.GetParent() ?? item.Sheet;
                InvalidateTree.Invoke(unit, new object[] { HashType.All });
                unit.InvalidateHashes(HashType.All);
                if (item.Sheet.GetParent() is ITopLevelReferenceableElement owner)
                    live.OnTopLevelReferenceableElementChanged(owner, new HashSet<ITopLevelReferenceableElement>());
                if (Source(item.Sheet) != item.Expected)
                    throw new InvalidOperationException("Stylesheet source changed during the cache refresh: " + item.Key + "; nothing was published.");
                entries.Add(new Entry(item.Key, before, Hashes(item.Sheet)));
            }
            return true;
        });
        return entries.ToArray();
    }

    private static Dictionary<string, WebStyleSheet> Sheets(ESpace model) => model.GetAllChildrenOfType<WebStyleSheet>()
        .ToDictionary(sheet => sheet.Key.ToString()!, StringComparer.Ordinal);
    private static SourceText Source(WebStyleSheet sheet) =>
        new(sheet.EffectiveValue, sheet.UserEffectiveValue, sheet.GeneratedEffectiveValue);
    private static string Hashes(WebStyleSheet sheet) => string.Join("|", new[]
        { HashType.General, HashType.Compilation, HashType.CompilationInterface, HashType.Debugger }.Select(sheet.GetHash));
}
