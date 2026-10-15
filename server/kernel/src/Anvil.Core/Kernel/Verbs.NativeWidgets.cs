using System.Text.Json.Nodes;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// A theme with no base theme does not load OutSystems UI, and the platform's own widgets still render elements that only it
/// styles (the owner's session of 2026-10-12: every click of a Button adds a span.btn-animation, the ripple, that the runtime
/// removes when its animation ends; with no rule it never animates, never goes, and in a flex button with gap each one widened
/// the button). Every theme of the module that a job writes (created, its base theme or its style sheet set: the set verb, the
/// prototype importer) and that ends the job with no base theme carries, once, the CSS of those elements, between its markers:
/// out of the flow and animated, so it leaves as it does with OutSystems UI. Listed in the receipt (normalized).
/// </summary>
public sealed partial class ModelSession
{
    internal const string NativeWidgetsBegin = "/* ssam:native-widgets */", NativeWidgetsEnd = "/* /ssam:native-widgets */";

    /// <summary>The CSS of the elements the platform's widgets render and only OutSystems UI styles: the ripple span of a Button
    /// (out of the flow, never a flex item, and animated so the runtime removes it at its animationend).</summary>
    internal const string NativeWidgetsCss = NativeWidgetsBegin + "\n"
        + ".btn-animation{position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;animation:ssam-btn-animation 1ms}\n"
        + "@keyframes ssam-btn-animation{from{opacity:0}to{opacity:0}}\n"
        + NativeWidgetsEnd;

    private readonly HashSet<object> _themesWritten = new(ReferenceEqualityComparer.Instance);

    /// <summary>A theme this job wrote (created, base theme or style sheet set): checked at the end of the job.</summary>
    internal void ThemeWritten(object target)
    {
        if (Implements(target, "IMobileTheme") || Implements(target, "ITheme") && !Implements(target, "IWebTheme")) _themesWritten.Add(target);
    }

    /// <summary>Every theme the job wrote that has no base theme gets the native widgets' CSS once (its markers say it is there).</summary>
    private void NativeWidgetCss()
    {
        foreach (var theme in _themesWritten.ToList())
        {
            try
            {
                if (theme is IObjectSignature { WasDeleted: true } || PrototypeBuilder.Prop(theme, "BaseTheme") != null) continue;
                var sheet = ThemeCss.Of(theme);
                var author = sheet != null ? ThemeCss.Author(sheet) : PrototypeBuilder.Prop(theme, "StyleSheet") as string ?? "";
                if (author.Contains(NativeWidgetsBegin, StringComparison.Ordinal)) continue;
                var css = (author.TrimEnd().Length > 0 ? author.TrimEnd() + "\n\n" : "") + NativeWidgetsCss + "\n";
                if (sheet != null) ThemeCss.WriteAuthor(sheet, css); else FindProperty(theme, "StyleSheet")!.SetValue(theme, css);
                Report("normalized", new JsonObject
                {
                    ["code"] = "THEME_NATIVE_WIDGETS", ["theme"] = TypeResolver.Name(theme),
                    ["note"] = "the theme has no base theme (no OutSystems UI): it carries the CSS of the elements the platform's widgets render (the ripple span of a Button, out of the flow and animated so the runtime removes it)",
                });
            }
            catch (Exception error) { Note("THEME_NATIVE_WIDGETS", $"{TypeResolver.Name(theme)}: the native widgets' CSS could not be written: {Unwrap(error)}"); }
        }
        _themesWritten.Clear();
    }
}
