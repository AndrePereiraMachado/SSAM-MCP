using System.Text.Json.Nodes;
using Anvil.Reading;

namespace Anvil.Core;

/// <summary>
/// The pages a root is shown on (CX17 review 4, N1/N2). A screen shows the theme of its flow, else the module's default. A block
/// has no page of its own: it shows the themes of the screens that place it, directly or through another block. The markers of a
/// block are decided on each of those themes: the native layout block reaches only the pages whose theme is of this module, so a
/// marker is written when one of them spaces the parent side by side, and the pages whose theme is of another module are named in
/// the notes (there the marker has no effect). Two themes of this module that space the parent differently are one refusal: one
/// marker cannot be right on both. A block that no screen places yet is decided on the theme of its own flow, and said.
/// </summary>
public static partial class ScreenVisual
{
    /// <summary>A block shown on pages of themes of this module that space a parent differently (one gap, the other none).</summary>
    public const string BlockPagesDiverge = "HTML_BLOCK_PAGES_DIVERGE";

    /// <summary>One theme a block is shown with, and the screens that show it with that theme.</summary>
    public sealed record ShownTheme(PageTheme Theme, IReadOnlyList<string> Pages);

    /// <summary>The themes a root is decided on: the pages' themes of a block placed on screens, else the theme itself.</summary>
    public static IReadOnlyList<ShownTheme> Each(PageTheme theme) => theme.Shown.Count > 0 ? theme.Shown : [new(theme, [])];

    /// <summary>The theme of a block from the themes of the screens that show it (none: its own flow's, marked unplaced). Reachable
    /// when one of them is of this module; its CSS is the first reachable one's (the one F1 and F8 read).</summary>
    public static PageTheme OfPages(PageTheme own, IReadOnlyList<ShownTheme> shown)
    {
        if (shown.Count == 0) return own with { Unplaced = true };
        var reaching = shown.FirstOrDefault(s => s.Theme.Reachable)?.Theme;
        var foreign = shown.Where(s => !s.Theme.Reachable).ToList();
        return new PageTheme(string.Join(", ", shown.Select(s => s.Theme.Name).Distinct(StringComparer.Ordinal)), reaching != null,
            foreign.Count == 0 ? null : string.Join("; ", foreign.Select(f => "on " + string.Join(", ", f.Pages) + ": " + f.Theme.Why)),
            (reaching ?? shown[0].Theme).Css) { Shown = shown, Key = reaching?.Key };
    }

    /// <summary>The pages of a block whose theme is of another module: no rule of the native layout block reaches them.</summary>
    public static IReadOnlyList<string> PagesWithoutBlock(PageTheme theme) =>
        theme.Shown.Where(s => !s.Theme.Reachable).SelectMany(s => s.Pages).Distinct(StringComparer.Ordinal).ToList();

    /// <summary>F3 on every theme a root is shown with: null when the element has no gutter (the first item of its parent). Marked
    /// when a theme of this module spaces the parent side by side; Diverge says the pages when two themes of this module disagree.
    /// The spacing is the one of a theme that decided it.</summary>
    public sealed record GapVerdict(bool Marked, Spacing Spacing, string? Diverge);

    public static GapVerdict? GapDecision(DomNode element, Func<PageTheme, DomNode, Spacing> spacingOf, PageTheme theme)
    {
        if (element.ParentElement is not { } parent || !AfterNeighbor(element)) return null;
        var each = Each(theme).Select(s => (Shown: s, Spacing: spacingOf(s.Theme, parent))).ToList();
        var reaching = each.Where(x => x.Shown.Theme.Reachable).ToList();
        var marked = reaching.Any(x => x.Spacing.Always.Horizontal);
        string? diverge = null;
        if (marked && reaching.Any(x => !x.Spacing.Always.Horizontal))
            diverge = string.Join("; ", reaching.Select(x => $"{string.Join(", ", x.Shown.Pages)} (theme {x.Shown.Theme.Name}): "
                + (x.Spacing.Always.Horizontal ? "the parent spaces its items side by side, " : "the parent has no column gap, ") + x.Spacing.Always.Describe()));
        var decided = marked ? reaching.First(x => x.Spacing.Always.Horizontal) : each.FirstOrDefault(x => x.Spacing.Always.Horizontal) is { Shown: not null } h ? h : each[0];
        return new GapVerdict(marked, decided.Spacing, diverge);
    }

    /// <summary>The words of that refusal, and its fix.</summary>
    public static string DivergeMessage(string kind, string root, string pages) =>
        $"a {kind} of the block {root} after a neighbor: the pages that show the block space its parent differently ({pages}); one marker of the native layout block cannot be right on both (zeroed gutter where there is no gap: the items touch; kept where there is one: the gap and the gutter add up)";
    public const string DivergeFix = "give the parent its space in the block's own <style> (it goes with the block to every page), or the same rule in the theme of every page that shows it";

    /// <summary>The note of a marker in a block shown on pages without the native layout block, or placed on no screen yet:
    /// said in the note that says the marker (never a gutter zeroed without saying where it is not).</summary>
    public static void Caveat(JsonObject note, PageTheme theme)
    {
        var without = PagesWithoutBlock(theme);
        if (without.Count > 0 && note["pagesWithoutBlock"] == null)
        {
            note["pagesWithoutBlock"] = new JsonArray(without.Select(p => (JsonNode)p).ToArray());
            note["note"] = note["note"] + $"; except on {string.Join(", ", without)} (pagesWithoutBlock): those pages show a theme of another module, no rule of the native layout block reaches them and the marker has no effect there (a parent's gap and the runtime's gutter add up)";
        }
        else if (theme.Unplaced && note["unplaced"] == null)
        {
            note["unplaced"] = true;
            note["note"] = note["note"] + $"; no screen places this block yet: decided on the theme of its own flow ({theme.Name}); an html op that places it on a page whose theme is of another module names the block and says its markers have no effect there";
        }
    }

    // ---- the pages of a block, read on the model -----------------------------------------------------------------------------

    /// <summary>The markers of the engine a root's widgets carry and the blocks it places directly (one walk of its widgets).</summary>
    public static (HashSet<string> Markers, List<T> Placed) MarkersAndBlocks<T>(ModelReader<T> reader, T root) where T : class
    {
        var markers = new HashSet<string>(StringComparer.Ordinal);
        var placed = new List<T>();
        var pending = new Stack<T>();
        pending.Push(root);
        while (pending.TryPop(out var node))
            foreach (var child in reader.ChildrenOf(node))
            {
                var kind = reader.KindOf(child);
                if (kind == "ExtendedProperty")
                {
                    if (Raw(reader, child, "Property") is string property && MarkerOf(property) is { } marker) markers.Add(marker);
                    continue;
                }
                if (!reader.IsKind(child, "Widget") && kind is not ("PlaceholderContentWidget" or "IfBranchWidget")) continue;
                if (kind.Contains("BlockInstance", StringComparison.Ordinal) && Raw(reader, child, "SourceBlock") is T source) placed.Add(source);
                pending.Push(child);
            }
        return (markers, placed);
    }

    /// <summary>The placements of the module's roots, read once: what each root carries and places.</summary>
    public sealed class Placements<T>(ModelReader<T> reader) where T : class
    {
        private readonly Dictionary<T, (HashSet<string> Markers, List<T> Placed)> read = new(ReferenceEqualityComparer.Instance);
        public (HashSet<string> Markers, List<T> Placed) Of(T root) => read.TryGetValue(root, out var known) ? known : read[root] = MarkersAndBlocks(reader, root);

        /// <summary>Every block a root places, at any depth (each once, the root itself never).</summary>
        public List<T> BlocksUnder(T root)
        {
            var seen = new HashSet<T>(ReferenceEqualityComparer.Instance) { root };
            var found = new List<T>();
            var pending = new Stack<T>(Of(root).Placed);
            while (pending.TryPop(out var block))
            {
                if (!seen.Add(block)) continue;
                found.Add(block);
                foreach (var next in Of(block).Placed) pending.Push(next);
            }
            return found;
        }

        /// <summary>The screens among <paramref name="screens"/> that show the block, directly or through another block.</summary>
        public List<T> PagesShowing(IEnumerable<T> screens, T block) =>
            screens.Where(s => BlocksUnder(s).Any(b => ReferenceEquals(b, block))).ToList();

        /// <summary>The blocks a root places, at any depth, that carry a marker of the engine, with their markers.</summary>
        public List<(string Name, IReadOnlyList<string> Markers)> MarkedBlocksUnder(T root) =>
            BlocksUnder(root).Select(b => (reader.NameOf(b), (IReadOnlyList<string>)EngineMarkers.Where(Of(b).Markers.Contains).ToList())).Where(x => x.Item2.Count > 0).ToList();
    }
}
