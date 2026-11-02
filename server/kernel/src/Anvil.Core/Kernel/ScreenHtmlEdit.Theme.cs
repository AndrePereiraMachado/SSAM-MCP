namespace Anvil.Reading;

// The part of ScreenHtmlEdit that the reading uses (ScreenHtmlModule.cs). Free of the rest of the kernel: the ODC builder
// (platforms/odc/studio/builder) compiles it with ScreenHtmlModule.cs, by file.
public static partial class ScreenHtmlEdit
{
    // C-14: a <style scope="theme"> of a document is a part of the module theme, not the root's own style sheet: the root's own
    // part (no id) or a named part (id). In the canonical form each is a fact of the root: css:theme, css:theme:<id>.
    public static bool IsThemeStyle(ScreenHtml.Node node) =>
        node.Tag == "style" && node.Get("scope") is { } scope && scope.Trim().Equals("theme", StringComparison.OrdinalIgnoreCase);
    public static string ThemeFact(string? id) => id == null ? "css:theme" : "css:theme:" + id;
    public static bool IsThemeFact(string fact) => fact == "css:theme" || fact.StartsWith("css:theme:", StringComparison.Ordinal);
    public static string? ThemeFactId(string fact) => fact.Length > 10 ? fact[10..] : null;
}
