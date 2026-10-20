using Anvil.Reading;

namespace Anvil.Core;

/// <summary>
/// The markers of the native layout block are the engine's (CX17 review 2, M4). Every rule of the block needs one
/// (data-ssam-gap, data-ssam-page, data-ssam-rows), so the block reaches only what carries one: the html op writes them by its
/// own rules on the elements it creates (and the prototype importer the rows marker on the List of a table part it creates,
/// round 6 of fix/data-table), and nothing else may. One rule, in one place, that every text form calls (the document
/// form, the edit form and the fragment form): an author's marker is refused, with the patch that removes it (or puts back the
/// one the reading had); an element of a reading keeps the marker it was read with. And what the block reaches is measured,
/// never written by hand: the roots of the module whose widgets carry a marker.
/// </summary>
public static partial class ScreenVisual
{
    /// <summary>The refusal of a marker of the engine written by the author.</summary>
    public const string ReservedMarker = "HTML_RESERVED_MARKER";

    /// <summary>The attributes the native layout block reads (every one of its rules needs one of them).</summary>
    public static readonly IReadOnlyList<string> EngineMarkers = [GapMarker, PageMarker, RowsMarker];

    /// <summary>The marker an attribute of the text writes, or null: HTML reads an attribute name without case, and ext: writes
    /// the attribute as it is.</summary>
    public static string? MarkerOf(string attribute)
    {
        var bare = attribute.StartsWith("ext:", StringComparison.OrdinalIgnoreCase) ? attribute[4..] : attribute;
        foreach (var marker in EngineMarkers) if (marker.Equals(bare, StringComparison.OrdinalIgnoreCase)) return marker;
        return null;
    }

    /// <summary>Whether an element of the text already carries that marker (in any spelling).</summary>
    public static bool CarriesMarker(ScreenHtml.Node node, string marker) => node.Attributes.Any(a => MarkerOf(a.Key) == marker);

    /// <summary>The markers an element of the text writes that are not the reading's: every one on a new element
    /// (<paramref name="read"/> null), and on an element of a reading (its k) the ones it was not read with, by name and value.
    /// <paramref name="block"/>: the element goes into a new block, which never carries the page marker, not even one copied
    /// from a reading (a block goes on pages the op did not create, review 1, A1). Restore: the value the reading had under that
    /// name (the patch puts it back), or null (the patch removes the attribute).</summary>
    public static IEnumerable<(string Attribute, string Value, string? Restore)> AuthorMarkers(ScreenHtml.Node node, ScreenHtml.Node? read, bool block = false)
    {
        foreach (var (name, value) in node.Attributes)
        {
            if (MarkerOf(name) is not { } marker) continue;
            var pageInBlock = block && marker == PageMarker;
            var before = read?.Attributes.FirstOrDefault(a => a.Key == name) is { Key: not null } had ? had.Value : null;
            if (before == value && !pageInBlock) continue;   // the reading's: kept as it was
            yield return (name, value, before != null && !pageInBlock ? before : null);
        }
    }

    /// <summary>The refusal's words for a marker an author wrote.</summary>
    public static string ReservedMarkerMessage(string attribute, string value, bool block, bool read)
    {
        var pageInBlock = block && MarkerOf(attribute) == PageMarker;
        return $"{attribute}=\"{(value.Length > 40 ? value[..40] + "…" : value)}\" is a marker of the engine: the native layout block of the theme reads it, and only the html op writes it, on the elements it creates"
            + (pageInBlock ? "; a block never carries " + PageMarker + " (it goes on pages the op did not create)" : "")
            + (read && !pageInBlock ? " (the reading of this element did not have it with this value)" : "");
    }

    /// <summary>The fix of that refusal.</summary>
    public static string ReservedMarkerFix(string attribute, string? restore)
        => restore != null
            ? $"the patch puts back {attribute}=\"{restore}\", the reading's"
            : $"the patch removes {attribute}; the html op marks the elements it creates by its own rules (normalized lists each mark)";

    // ---- what the block reaches: measured on the markers of the module's roots ---------------------------------------------

    /// <summary>One root of the module the native layout block reaches: the markers its widgets carry, and the blocks it places
    /// that carry the page marker (the :has rule reaches the layout chain of the page that places them).</summary>
    public sealed record ReachedRoot(string Name, IReadOnlyList<string> Markers, IReadOnlyList<string> PageMarkerVia)
    {
        public override string ToString() => Name + " (" + string.Join(", ", Markers.Concat(PageMarkerVia.Select(b => PageMarker + " via the block " + b))) + ")";
    }

    /// <summary>The roots among <paramref name="roots"/> the block can reach: every rule needs a marker on the element it
    /// matches or (the page rule) inside it, so a root is reached only when one of its widgets carries a marker, or when it places
    /// a block of <paramref name="blocks"/> that carries the page marker (at any depth). A sound bound, read on the model: no
    /// root outside it is reached.</summary>
    public static List<ReachedRoot> ReachedRoots<T>(ModelReader<T> reader, IEnumerable<T> roots, IEnumerable<T> blocks) where T : class
    {
        var own = new Dictionary<T, (HashSet<string> Markers, List<T> Placed)>(ReferenceEqualityComparer.Instance);
        (HashSet<string>, List<T>) Read(T root)
        {
            if (own.TryGetValue(root, out var known)) return known;
            return own[root] = MarkersAndBlocks(reader, root);
        }
        var local = new HashSet<T>(blocks, ReferenceEqualityComparer.Instance);
        // The blocks of the module that carry the page marker, themselves or through a block they place.
        var carriesPage = new Dictionary<T, bool>(ReferenceEqualityComparer.Instance);
        bool Page(T block, HashSet<T> path)
        {
            if (carriesPage.TryGetValue(block, out var known)) return known;
            if (!local.Contains(block) || !path.Add(block)) return false;
            var (markers, placed) = Read(block);
            var page = markers.Contains(PageMarker) || placed.Any(b => Page(b, path));
            path.Remove(block);
            return carriesPage[block] = page;
        }
        var reached = new List<ReachedRoot>();
        foreach (var root in roots)
        {
            var (markers, placed) = Read(root);
            var via = placed.Where(b => Page(b, new HashSet<T>(ReferenceEqualityComparer.Instance))).Select(b => reader.NameOf(b)).Distinct(StringComparer.Ordinal).ToList();
            if (markers.Count > 0 || via.Count > 0)
                reached.Add(new ReachedRoot(reader.NameOf(root), EngineMarkers.Where(markers.Contains).ToList(), via));
        }
        return reached;
    }

    private static object? Raw<T>(ModelReader<T> reader, T node, string property) where T : class
    {
        if (reader.PropertyOf(node, property) is not { } read) return null;
        try { return read(); } catch { return null; }
    }
}
