using System.Text;
using System.Text.Json.Nodes;

namespace Anvil.Core;

/// <summary>
/// The two generated blocks around the prototype's verbatim CSS (docs/PROTOTIPO-NATIVO.md, 4.1 and 4.2):
/// <list type="bullet">
/// <item><see cref="UserAgent"/>: the user-agent rules of the tags a widget cannot carry (dialog, main on ODC, custom elements…),
/// from the HTML Living Standard rendering section, all inside :where() (specificity zero) and placed before the prototype,
/// because the user agent loses to the author;</item>
/// <item><see cref="Adapters"/>: the fixed algorithm over the runtime DOM table: an element the runtime adds without a role in the
/// prototype's layout gets display:contents (the wrapper-transparent rewrites handle &gt;, :nth-child and :last-child, which
/// display:contents does not); a class the runtime adds that no property value avoids gets the neutralization of the evidence;
/// the popup backdrop gets the overlay layout plus the declarations of the prototype's dialog::backdrop.</item>
/// </list>
/// The same input gives the same text: rows in table order, each rule once.
/// </summary>
public static class PrototypeAdapters
{
    /// <summary>UA rules per substituted tag. A tag missing here needs none (data and picture stay inline as a span; br, svg,
    /// template and slot have no box to restore).</summary>
    private static readonly (string Tag, string[] Rules)[] UaTable =
    [
        ("dialog", [
            ":where(.ssam-tag-dialog){position:absolute;inset-inline-start:0;inset-inline-end:0;width:fit-content;height:fit-content;margin:auto;border:solid;padding:1em;background-color:Canvas;color:CanvasText}",
            // Every prototype dialog becomes an IPopup, which is modal: the dialog:modal rules apply.
            ":where(.ssam-tag-dialog){position:fixed;overflow:auto;inset-block-start:0;inset-block-end:0;max-width:calc(100% - 6px - 2em);max-height:calc(100% - 6px - 2em)}",
        ]),
        ("main", [":where(.ssam-tag-main){display:block}"]),
        ("search", [":where(.ssam-tag-search){display:block}"]),
        ("menuitem", [":where(.ssam-tag-menuitem){display:inline}"]),
    ];

    /// <summary>The UA block for the substituted tags (lower case), in the order of the table, then custom elements by name.</summary>
    public static (string Css, IReadOnlyList<string> Tags) UserAgent(IEnumerable<string> substitutedTags)
    {
        var tags = substitutedTags.Select(t => t.ToLowerInvariant()).Distinct(StringComparer.Ordinal).ToHashSet(StringComparer.Ordinal);
        var sb = new StringBuilder(); var emitted = new List<string>();
        foreach (var (tag, rules) in UaTable)
        {
            if (!tags.Contains(tag)) continue;
            foreach (var rule in rules) sb.Append(rule).Append('\n');
            emitted.Add(tag);
        }
        // An autonomous custom element is an HTMLElement with no UA rule: inline. Its substitute (a div) is a block.
        foreach (var tag in tags.Where(t => t.Contains('-', StringComparison.Ordinal)).Order(StringComparer.Ordinal))
        {
            sb.Append(":where(.ssam-tag-").Append(tag).Append("){display:inline}\n");
            emitted.Add(tag);
        }
        return (sb.ToString(), emitted);
    }

    /// <summary>The adapters block and its report (one entry per rule: the widget, the selector, what it does and the status of
    /// the table row it comes from). <paramref name="backdrops"/>: the declarations of the prototype's dialog::backdrop rules with
    /// their enclosing at-rules. <paramref name="roots"/>: the compiled trees; with none, every row of the table counts as used.</summary>
    public static (string Css, JsonArray Report) Adapters(string platform, IReadOnlyDictionary<string, WidgetNode> roots,
        IReadOnlyList<(IReadOnlyList<string> Enclosing, string Declarations)> backdrops)
    {
        var used = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var root in roots.Values) Count(root, used, platform);
        var all = roots.Count == 0;
        var sb = new StringBuilder(); var report = new JsonArray(); var seen = new HashSet<string>(StringComparer.Ordinal);
        void Rule(string widget, string selector, string declarations, string why, RuntimeStatus status)
        {
            var text = selector + "{" + declarations + "}";
            if (!seen.Add(text)) return;
            sb.Append(text).Append('\n');
            report.Add(new JsonObject
            {
                ["widget"] = widget, ["selector"] = selector, ["adapter"] = declarations, ["why"] = why,
                ["count"] = used.GetValueOrDefault(widget), ["status"] = status == RuntimeStatus.Evidence ? "evidence" : "inferred",
            });
        }
        var rows = RuntimeDomTable.Rows(platform);
        // 1. Elements without a role in the prototype's layout: display:contents.
        foreach (var row in rows)
        {
            if (!all && !used.ContainsKey(row.Widget)) continue;
            if (row.Transparent) Rule(row.Widget, ":where(" + RuntimeDomTable.ElementSelector(row) + ")", "display:contents", "runtime element with no counterpart in the prototype", row.Status);
            foreach (var wrapper in row.Wrappers.Where(w => w.Role is "wrapper" or "box"))
                Rule(row.Widget, ":where(" + WrapperSelector(row, wrapper) + ")", "display:contents",
                    wrapper.Role == "box" ? "popup dialog box: the prototype's dialog element carries the box" : "runtime wrapper with no counterpart in the prototype", row.Status);
        }
        // 2. Classes the runtime adds that no property value avoids: the neutralization of the evidence.
        foreach (var row in rows)
        {
            if (!all && !used.ContainsKey(row.Widget)) continue;
            foreach (var cls in row.Classes.Where(c => c.AvoidWith == null && c.Neutralize != null))
            {
                var brace = cls.Neutralize!.IndexOf('{');
                if (brace <= 0 || !cls.Neutralize.EndsWith('}')) continue;
                Rule(row.Widget, cls.Neutralize[..brace], cls.Neutralize[(brace + 1)..^1], "runtime class " + cls.Class + " (" + cls.Evidence + ")", cls.Status);
            }
        }
        // 3. The popup backdrop: the overlay layout, then the prototype's dialog::backdrop declarations, which win on conflict.
        if (all || used.ContainsKey("IPopup") || backdrops.Count > 0)
        {
            var row = RuntimeDomTable.Row(platform, "IPopup")!;
            var (backdrop, _) = RuntimeDomTable.Popup(platform);
            var top = string.Join(";", backdrops.Where(b => b.Enclosing.Count == 0).Select(b => b.Declarations.Trim().TrimEnd(';')).Where(d => d.Length > 0));
            // the popup stands for a modal dialog, which the browser draws in the top layer, over every z-index of the page (a
            // fixed backdrop is its own stacking context: without one of its own, a sticky side menu with z-index 5 painted over
            // it, VisitaCerta 2026-10-12)
            Rule("IPopup", backdrop, "position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center" + (top.Length > 0 ? ";" + top : ""),
                "popup backdrop: overlay layout" + (top.Length > 0 ? " + the prototype's dialog::backdrop" : ""), row.Status);
            foreach (var (enclosing, declarations) in backdrops.Where(b => b.Enclosing.Count > 0))
            {
                var text = new StringBuilder();
                foreach (var e in enclosing) text.Append(e).Append('{');
                text.Append(backdrop).Append('{').Append(declarations.Trim()).Append('}');
                foreach (var _ in enclosing) text.Append('}');
                if (seen.Add(text.ToString()))
                {
                    sb.Append(text).Append('\n');
                    report.Add(new JsonObject { ["widget"] = "IPopup", ["selector"] = backdrop, ["adapter"] = declarations.Trim(), ["why"] = "the prototype's dialog::backdrop inside " + string.Join(" ", enclosing), ["count"] = used.GetValueOrDefault("IPopup"), ["status"] = row.Status == RuntimeStatus.Evidence ? "evidence" : "inferred" });
                }
            }
        }
        return (sb.ToString(), report);
    }

    /// <summary>A wrapper written by itself when it carries attributes or classes, else by what it holds (the checkbox span:
    /// <c>span:has(&gt; input[data-checkbox])</c>), so display:contents never reaches a prototype span.</summary>
    public static string WrapperSelector(RuntimeDomRow row, RuntimeWrapper wrapper) =>
        wrapper.Attributes.Count > 0 || wrapper.Classes.Count > 0 ? wrapper.Selector
            : wrapper.Tag + ":has(> " + RuntimeDomTable.ElementSelector(row) + ")";

    private static void Count(WidgetNode node, Dictionary<string, int> used, string platform)
    {
        var name = RuntimeDomTable.Row(platform, node.W)?.Widget ?? node.W;
        used[name] = used.GetValueOrDefault(name) + 1;
        foreach (var child in node.Children) Count(child, used, platform);
        foreach (var child in node.Else ?? []) Count(child, used, platform);
    }
}
