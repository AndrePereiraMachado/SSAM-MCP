using System.Text.Json.Nodes;

namespace Anvil.Core.Preflight;

/// <summary>
/// motor2 (2026-10-12): what one html op in the document form (data.html starting with &lt;screen&gt; or &lt;block&gt;,
/// ssam-html/1) declares, read from its text with positions (<see cref="HtmlText"/>): the root (screen or block, its name and
/// attributes), the screen actions and data actions it names (actions=, data-actions=), and its data (&lt;input&gt;,
/// &lt;var&gt;, &lt;aggregate&gt;, &lt;event&gt;, the direct children of the root). The rules that need the names of a screen
/// (one scope with its data actions and screen actions) read them here, never by compiling the document.
/// </summary>
public sealed class ScreenDocFacts
{
    /// <summary>A data declaration of the document: its kind (input, var, aggregate, event), name, type, default and element.</summary>
    public sealed record Data(string Kind, string Name, string? Type, HtmlText.Attribute? Default, HtmlText.Element Element);

    public int Op { get; init; }
    public HtmlText Text { get; init; } = null!;
    public HtmlText.Element Root { get; init; } = null!;
    /// <summary>"screen" or "block".</summary>
    public string Kind { get; init; } = "";
    public string Name { get; init; } = "";
    /// <summary>CX16 r2 (A2): the op is the edit of a reading (ScreenHtmlEdit.IsEdit: the whole document with screen and
    /// basedOn), not a new root: the rule of the apply, asked before the text is read as a document. The facts of its text are
    /// the same in both forms.</summary>
    public bool Edit { get; init; }
    public List<Data> Declared { get; } = [];
    public List<string> Actions { get; } = [];
    public List<string> DataActions { get; } = [];

    public IEnumerable<Data> Variables => Declared.Where(d => d.Kind == "var");
    public IEnumerable<Data> Inputs => Declared.Where(d => d.Kind == "input");

    /// <summary>Every name of the root's scope the document declares: its data, its screen actions and its data actions.</summary>
    public IEnumerable<(string Name, string What)> Names()
    {
        foreach (var d in Declared) yield return (d.Name, d.Kind switch { "var" => "variable", "input" => "input", "aggregate" => "aggregate", _ => d.Kind });
        foreach (var a in Actions) yield return (a, "screen action");
        foreach (var a in DataActions) yield return (a, "data action");
    }

    /// <summary>The html of the op, or null when it is not a string.</summary>
    public static string? Html(JsonObject op) => op["data"]?["html"] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    /// <summary>The document of op <paramref name="index"/>, or null when it is not an html op in the document form.</summary>
    public static ScreenDocFacts? Of(JsonObject op, int index)
    {
        if (op["op"]?.ToString() != "html" || op["parent"] != null || Html(op) is not { } html || !HtmlText.IsDocument(html)) return null;
        var text = HtmlText.Parse(html);
        var root = text.Root.Children.FirstOrDefault(e => e.Tag is "screen" or "block");
        if (root == null || root.Get("name") is not { Length: > 0 } name) return null;
        var facts = new ScreenDocFacts { Op = index, Text = text, Root = root, Kind = root.Tag, Name = name, Edit = Anvil.Reading.ScreenHtmlEdit.IsEdit(op) };
        foreach (var child in root.Children)
        {
            var kind = child.Tag.ToLowerInvariant();
            if (kind is not ("var" or "input" or "aggregate" or "event")) continue;
            // An <input> with bind is the Input widget, not a declaration.
            if (kind == "input" && child.Get("bind") != null) continue;
            if (child.Get("name") is not { Length: > 0 } dataName) continue;
            facts.Declared.Add(new Data(kind, dataName, child.Get("type"), child.Find("default"), child));
        }
        facts.Actions.AddRange(List(root.Get("actions")));
        facts.DataActions.AddRange(List(root.Get("data-actions")));
        return facts;
    }

    /// <summary>Every document of the job, in op order.</summary>
    public static List<ScreenDocFacts> All(JsonArray ops)
    {
        var all = new List<ScreenDocFacts>();
        for (var i = 0; i < ops.Count; i++)
            if (ops[i] is JsonObject op && Of(op, i) is { } facts) all.Add(facts);
        return all;
    }

    internal static IEnumerable<string> List(string? value) => (value ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    /// <summary>Whether a logic owner (`IMobileScreen:Home`, `IWebBlock:Card`) names this document's root.</summary>
    public bool Owns(string owner)
    {
        var colon = owner.IndexOf(':');
        if (colon <= 0) return false;
        var kind = owner[..colon]; var name = owner[(colon + 1)..];
        if (!name.Equals(Name, StringComparison.OrdinalIgnoreCase)) return false;
        return Kind == "block" ? kind.EndsWith("Block", StringComparison.Ordinal) : kind.EndsWith("Screen", StringComparison.Ordinal);
    }
}
