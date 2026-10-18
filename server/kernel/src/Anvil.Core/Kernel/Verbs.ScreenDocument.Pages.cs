using System.Text.Json.Nodes;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// CX17 review 4, N1/N2: the themes a root of the html op is decided on, read on the model every time (never remembered from an
/// earlier op: a theme changed since, or a page that places the block since, is decided again). A screen shows the theme of its
/// flow, else the module's default (PageThemeOf). A block shows the themes of the screens that place it, directly or through
/// another block (ScreenVisual.OfPages); a block that no screen places yet is decided on its own flow's theme, and said.
/// </summary>
public sealed partial class ModelSession
{
    /// <summary>The theme a screen or a block is decided on (see the type).</summary>
    internal ScreenVisual.PageTheme RootThemeOf(IObjectSignature? root)
    {
        var own = PageThemeOf(root?.Parent as IObjectSignature);
        if (root == null || !Implements(root, "IMobileBlock")) return own;
        try
        {
            var placements = new ScreenVisual.Placements<IObjectSignature>(new KernelModelReader());
            var pages = placements.PagesShowing(ModuleRoots().Where(r => Implements(r, "IMobileScreen")), root);
            var shown = pages.Select(p => (Page: TypeResolver.Name(p) ?? "", Theme: PageThemeOf(p.Parent as IObjectSignature)))
                .GroupBy(x => (x.Theme.Key ?? x.Theme.Name ?? "", x.Theme.Reachable))
                .Select(g => new ScreenVisual.ShownTheme(g.First().Theme, g.Select(x => x.Page).Distinct(StringComparer.Ordinal).ToList()))
                .ToList();
            return ScreenVisual.OfPages(own, shown);
        }
        catch (Exception error) { return own with { Why = (own.Why ?? "") + " (the pages that show the block could not be read: " + Unwrap(error) + ")" }; }
    }

    /// <summary>The blocks a screen places, at any depth, that carry markers of the engine (empty for a block).</summary>
    internal List<(string Name, IReadOnlyList<string> Markers)> MarkedBlocksOn(IObjectSignature root)
    {
        if (!Implements(root, "IMobileScreen")) return [];
        try { return new ScreenVisual.Placements<IObjectSignature>(new KernelModelReader()).MarkedBlocksUnder(root); }
        catch (Exception) { return []; }
    }

    /// <summary>The native layout block in every theme a written root is shown with (InstallNativeLayout, once per theme of this
    /// module; a theme of another module said with the marked blocks the page places, or with the pages of the block).</summary>
    internal List<JsonObject> InstallNativeLayouts(IObjectSignature written)
    {
        var theme = RootThemeOf(written);
        var blocks = MarkedBlocksOn(written);
        var notes = new List<JsonObject>();
        foreach (var shown in ScreenVisual.Each(theme))
            if (InstallNativeLayout(written, shown.Theme, shown.Pages, blocks) is { } note) notes.Add(note);
        return notes;
    }
}
