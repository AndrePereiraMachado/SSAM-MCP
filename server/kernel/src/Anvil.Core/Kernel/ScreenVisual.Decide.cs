using System.Text.Json.Nodes;
using Anvil.Reading;

namespace Anvil.Core;

/// <summary>
/// The markers of the native layout block are derived state, never input (CX17 review 3, M6): the gap marker is the engine's
/// decision on the parent of a link, button or form, made again whenever the element or its parent changes, in every text form
/// (the document form for every widget it compiles, with or without k; the edit forms on a screen of the op). A k keeps what the
/// element had (Visible, JavaScript, JSON), never a marker as its text writes it. And the block reaches a page only through the
/// theme that page shows (review 3, M7): its flow's theme, else the module's default; a theme of another module takes no block,
/// so nothing is marked and the notes say why.
/// </summary>
public static partial class ScreenVisual
{
    /// <summary>An element of a reading (its k) whose markers the engine decided again where it is now: what changed against its
    /// text or its reading, and why (normalized).</summary>
    public const string MarkerDecided = "HTML_MARKER_DECIDED";
    /// <summary>F3 where the theme the page shows does not carry the native layout block (a theme of another module): a link,
    /// button or form in a parent whose column gap is not zero is not marked, and the gap and the runtime's gutter add up.</summary>
    public const string GutterAddsToGap = "GUTTER_ADDS_TO_GAP";

    /// <summary>The theme a page shows (its flow's, else the module's default) as the html op reads it: whether the native
    /// layout block can reach the page (the theme is of this module, so the op writes the block there) and the author CSS of
    /// the chain of this module's themes the page loads (base first; a base of another module ends the chain: its CSS is not in
    /// this capture).</summary>
    public sealed record PageTheme(string? Name, bool Reachable, string? Why, IReadOnlyList<string> Css)
    {
        public static readonly PageTheme None = new(null, false, "the module has no theme", []);
        /// <summary>The ObjectKey of the theme (null: none, or a block whose pages show no theme of this module).</summary>
        public string? Key { get; init; }
        /// <summary>T18: the Theme Editor halves of the chain (the installed base of its token rules).</summary>
        public IReadOnlyList<string> Base { get; init; } = [];
        /// <summary>A block: each theme of the screens that show it (review 4, N1); empty for a screen.</summary>
        public IReadOnlyList<ShownTheme> Shown { get; init; } = [];
        /// <summary>A block that no screen places yet: decided on the theme of its own flow.</summary>
        public bool Unplaced { get; init; }
    }

    /// <summary>The neighbor the runtime's gutter follows (ScreenVisual.Predict: a widget before it in its parent): an element,
    /// a text or an expression; blank text is no widget.</summary>
    public static bool AfterNeighbor(DomNode element)
    {
        var siblings = element.Parent!.Children;
        for (var i = siblings.IndexOf(element) - 1; i >= 0; i--)
            if (siblings[i].IsElement || siblings[i].Unevaluable != null || !string.IsNullOrWhiteSpace(siblings[i].Text)) return true;
        return false;
    }

    /// <summary>The spacing reader of a page: OutSystems UI's layout utilities, the themes the page shows (base first), then
    /// the page's own CSS, in the order of the cascade.</summary>
    public static SpacingReader PageSpacing(PageTheme theme, IEnumerable<string?> page) =>
        new([("OutSystems UI", OutSystemsUiLayoutCss), .. theme.Css.Select(c => ("theme", (string?)c)), .. page.Select(c => ("page", c))]);


    /// <summary>The F3 note of a decision: zeroed (marked), kept (no column gap) or added up (a gap, but no block reaches the
    /// page).</summary>
    public static string GutterCode(GapVerdict decision) =>
        decision.Marked ? GutterZeroedInGap : decision.Spacing.Always.Horizontal ? GutterAddsToGap : GutterKept;

    /// <summary>The words of a gutter note.</summary>
    public static string GutterNote(string code, string kind, string? theme) => code switch
    {
        GutterZeroedInGap => $"a new {kind} in a flex or grid parent whose column gap is not zero (column-gap, or the second value of gap; the rules without a condition, OutSystems UI's gap utilities included) is marked {GapMarker}: the theme's native layout block zeroes the runtime's gutter on it only (gaps: where each gap comes from; conditions: where the parent spaces its items otherwise)",
        GutterAddsToGap => $"a new {kind} in a flex or grid parent whose column gap is not zero is not marked {GapMarker}: the theme the page shows ({theme}) is of another module and carries no native layout block, so the parent's gap and the runtime's gutter (ThemeGrid_MarginGutter) add up (gaps: where each gap comes from)",
        _ => $"a new {kind} after a neighbor in a parent with no column gap (not flex or grid, or column-gap 0: a row gap alone does not space items side by side) keeps the runtime's gutter (ThemeGrid_MarginGutter): it is the only spacing between them (conditions: where the parent spaces its items otherwise)",
    };

    /// <summary>Why the gap marker is or is not on an element, for the note of a decision made again.</summary>
    public static string GapWhy(GapVerdict? decision, PageTheme theme) =>
        decision is not { } d ? "it is the first item of its parent: the runtime gives it no gutter"
        : d.Marked ? $"its parent spaces its items side by side ({d.Spacing.Always.Describe()}): the block zeroes its gutter"
        : d.Spacing.Always.Horizontal ? $"the theme the page shows ({theme.Name}) carries no native layout block: {theme.Why}"
        : $"its parent has no column gap ({d.Spacing.Always.Describe()}): the runtime's gutter is the only spacing";

    /// <summary>The note of the markers decided again on elements of a reading (one per op).</summary>
    public static JsonObject MarkerDecidedNote() => new()
    {
        ["code"] = MarkerDecided, ["count"] = 0, ["items"] = new JsonArray(),
        ["note"] = "an element of the reading (its k) carries the markers of the engine as the engine decides them where it is now, never as its text writes them: the marker follows its parent's space (items: what changed against the text or the reading, and why)",
    };

    /// <summary>One item of that note.</summary>
    public static void AddDecided(JsonObject note, string where, string marker, bool written, string why)
    {
        note["count"] = note["count"]!.GetValue<int>() + 1;
        var items = note["items"]!.AsArray();
        if (items.Count < 20) items.Add($"{where}: {marker} {(written ? "written" : "removed")} ({why})");
    }
}
