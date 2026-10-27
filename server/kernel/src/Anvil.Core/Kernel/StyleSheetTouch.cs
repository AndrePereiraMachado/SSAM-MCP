using System.Collections.Concurrent;
using System.Diagnostics;
using System.Reflection;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using OutSystems.Model;
using ServiceStudio.Model;

namespace Anvil.Core;

/// <summary>F1 (2026-10-22): a publication takes the stylesheet of a block or a screen only when a widget of that element
/// changes (receipts of 2026-10-22, O11 Traditional and ODC). The rule runs on the candidate, after every op of the job has
/// resolved (any target form, widgets an html or screen op created, deleted or rebuilt included): every block or screen whose
/// effective StyleSheet differs from the base, and none of whose widgets the job created or changed (the session's own
/// footprint), gets one change of one of its widgets that renders the same and means the same, written through the
/// session's own set:
/// <list type="bullet">
/// <item>a reactive Style Classes is an expression, read as the kernel's get shows it (the expression's text): any form
/// (a literal, a class expression, concatenations, indexing with brackets) becomes <c>X + ""</c>, the same Text; a value an
/// earlier touch left (<c>X + ""</c>) goes back to <c>X</c>;</item>
/// <item>a Traditional Web Style is the literal text of its class names: one trailing space is toggled.</item>
/// </list>
/// The touch never leaves the candidate invalid: when the Verify of the candidate has any error the base did not have, every
/// touch is put back and the Verify runs again (the report says so per element). A theme has no widget.
/// Cost: none for a job that writes no stylesheet (<see cref="Writes"/>, a scan of the ops); otherwise one walk of the
/// module's blocks, screens and themes before and after the ops, one walk of each changed element, one read per touched
/// widget and one write for all of them; a second Verify only when a touch is put back.
/// The report (<c>styleSheets</c> of the apply result) lists every element whose stylesheet changed: key, kind, name, flow,
/// flavor, the stylesheet of the base and of the candidate, and the touch or the reason there is none.</summary>
public sealed class StyleSheetTouch
{
    private static readonly ConcurrentDictionary<Type, (string? Kind, string Flavor)> Kinds = new();
    private static readonly ConcurrentDictionary<Type, bool> Styled = new();
    // A serialized op escapes '<' as \u003C: both spellings of a style block count.
    private static readonly Regex StyleText = new(@"(<|\\u003c)style|stylesheet|""css""", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    private readonly Dictionary<string, string>? _before;
    private readonly List<(string Widget, string Original, JsonObject Entry)> _touched = [];
    public JsonArray Report { get; } = new();
    /// <summary>The time the rule spent in this job (capture, apply and, when it happened, the revert).</summary>
    public long ElapsedMs => _clock.ElapsedMilliseconds;
    private readonly Stopwatch _clock = new();

    private StyleSheetTouch(Dictionary<string, string>? before) => _before = before;

    /// <summary>Whether a job may write a stylesheet: a set of StyleSheet, a css op, or an op that carries CSS (an html, screen or
    /// prototype op with a style block, a StyleSheet or css). A job that does not pays nothing.</summary>
    public static bool Writes(JsonArray ops) => ops.OfType<JsonObject>().Any(op => op["op"]?.ToString() switch
    {
        "set" => string.Equals(op["prop"]?.ToString(), "StyleSheet", StringComparison.OrdinalIgnoreCase),
        // T18: the keyed css edit op writes through the same path (ThemeCss.WriteAuthor), so it is touched and proven the same.
        CssEdits.Op => true,
        "html" or "screen" or "prototype" or "spec" or "replace" => StyleText.IsMatch(op.ToJsonString()),
        _ => false,
    });

    /// <summary>The effective stylesheet of every block, screen and theme before the job (nothing when the job writes none).</summary>
    public static StyleSheetTouch Capture(ESpace espace, JsonArray ops)
    {
        if (!Writes(ops)) return new StyleSheetTouch(null);
        var touch = new StyleSheetTouch(new Dictionary<string, string>(StringComparer.Ordinal));
        touch._clock.Start();
        try { foreach (var (o, kind, _) in Elements(espace)) if (o.ObjectKey?.ToString() is { } key) touch._before![key] = Css(o); }
        catch { /* a module the walk cannot read: no touch, no report */ }
        touch._clock.Stop();
        return touch;
    }

    /// <summary>After the ops: one touch per changed element that needs it.</summary>
    public JsonArray Apply(ModelSession session, ESpace espace, Action<string>? log)
    {
        if (_before == null || _before.Count == 0) return Report;
        _clock.Start();
        try { Touch(session, espace, log); }
        catch (Exception ex) { log?.Invoke("  stylesheet touch skipped: " + ex.GetBaseException().Message); }
        finally { _clock.Stop(); }
        return Report;
    }

    private void Touch(ModelSession session, ESpace espace, Action<string>? log)
    {
        var changed = new List<(IObjectSignature Element, string Kind, string Flavor, string Was, string Css)>();
        foreach (var (o, kind, flavor) in Elements(espace))
            if (o.ObjectKey?.ToString() is { } key && _before!.TryGetValue(key, out var was) && Css(o) is var css && css != was) changed.Add((o, kind, flavor, was, css));
        if (changed.Count == 0) return;
        // What the job created or changed (the session's footprint over its scopes, no sweep of the module).
        var footprint = session.Footprint().Footprint;
        var written = new HashSet<string>(footprint.Created.Concat(footprint.Changed), StringComparer.Ordinal);
        var writes = new List<(string Key, string Value, string Original, JsonObject Entry)>();
        foreach (var (element, kind, flavor, was, css) in changed)
        {
            var key = element.ObjectKey!.ToString()!;
            var entry = new JsonObject { ["key"] = key, ["kind"] = kind, ["name"] = TypeResolver.Name(element) ?? key, ["flow"] = FlowOf(element),
                ["flavor"] = flavor, ["baseStyleSheet"] = was, ["styleSheet"] = css };
            Report.Add(entry);
            if (kind == "theme") { entry["touch"] = null; entry["reason"] = "a theme has no widget to change"; continue; }
            var widgets = element.GetAllDescendantsOfType<IObjectSignature>().Where(w => w.ObjectKey != null && !w.WasDeleted && HasStyle(w.GetType())).ToList();
            if (widgets.Any(w => written.Contains(w.ObjectKey!.ToString()!))) { entry["touch"] = null; entry["reason"] = "the job changes a widget of this element"; continue; }
            var ordered = widgets.Where(w => Is(w, "Container")).Concat(widgets.Where(w => !Is(w, "Container") && !Is(w, "BlockInstance"))).ToList();
            (IObjectSignature Widget, string Style)? chosen = null;
            foreach (var w in ordered.Take(8))
                if (StyleOf(session, w) is { } style) { chosen = (w, style); break; }
            if (chosen is not { } pick) { entry["touch"] = null; entry["reason"] = "the element has no widget whose Style can be read"; continue; }
            var value = flavor == "traditional" ? LiteralToggle(pick.Style) : ExpressionToggle(pick.Style);
            writes.Add((pick.Widget.ObjectKey!.ToString()!, value, pick.Style, entry));
            entry["touch"] = new JsonObject { ["key"] = pick.Widget.ObjectKey!.ToString(), ["name"] = TypeResolver.Name(pick.Widget), ["prop"] = "Style", ["value"] = value, ["from"] = pick.Style };
            entry["reason"] = null;
        }
        if (writes.Count == 0) return;
        foreach (var (key, value, original, entry) in Write(session, espace, writes.Select(w => (w.Key, w.Value, w.Entry)).ToList(), log))
            _touched.Add((key, original, entry));
    }

    /// <summary>After the Verify: when the candidate has any error the base did not have and something was touched, every
    /// touch is put back (the Verify must run again: true). The touch never leaves the candidate invalid.</summary>
    public bool RevertOnNewErrors(IReadOnlyList<MessageInfo> before, IReadOnlyList<MessageInfo> after, ModelSession session, ESpace espace, Action<string>? log)
    {
        if (_touched.Count == 0) return false;
        var old = before.Select(m => m.Key).ToHashSet(StringComparer.Ordinal);
        var first = after.FirstOrDefault(m => m.Type.Contains("Error", StringComparison.OrdinalIgnoreCase) && !old.Contains(m.Key));
        if (first == null) return false;
        _clock.Start();
        try
        {
            Write(session, espace, _touched.Select(t => (t.Widget, t.Original, t.Entry)).ToList(), log);
            foreach (var (_, original, entry) in _touched)
            {
                entry["reverted"] = new JsonObject { ["value"] = entry["touch"]?["value"]?.DeepClone(), ["because"] = first.Id + ": " + first.Detail };
                entry["touch"] = null;
                entry["reason"] = "the Verify of the candidate had a new error; the widget was put back";
            }
            _touched.Clear();
        }
        finally { _clock.Stop(); }
        return true;
    }

    /// <summary>The writes through the session's own set, in one model transaction; the ones that applied.</summary>
    private static List<(string Key, string Value, string Original, JsonObject Entry)> Write(ModelSession session, ESpace espace, List<(string Key, string Value, JsonObject Entry)> writes, Action<string>? log)
    {
        var applied = new List<(string Key, string Value, string Original, JsonObject Entry)>();
        StudioAdapter.Runtime.Mutate(espace, "Anvil: stylesheet touch", _ =>
        {
            foreach (var (key, value, entry) in writes)
            {
                var original = entry["touch"]?["from"]?.ToString() ?? "";
                try { session.ApplyOne(new JsonObject { ["op"] = "set", ["target"] = "@" + key, ["prop"] = "Style", ["value"] = value }); applied.Add((key, value, original, entry)); }
                catch (Exception ex)
                {
                    var error = ex.GetBaseException().Message;
                    log?.Invoke("  stylesheet touch of @" + key + " not written: " + error);
                    entry["touch"] = null; entry["reason"] = "the widget could not be written: " + error;
                }
            }
        });
        return applied;
    }

    /// <summary>The module's default theme by name (the reactive runtime names the module's stylesheet files by it).</summary>
    public static string? ThemeName(ESpace espace)
    {
        foreach (var name in new[] { "Theme", "DefaultTheme" })
            foreach (var p in ((object)espace).GetType().GetInterfaces().SelectMany(i => i.GetProperties()).Where(p => p.Name == name && p.GetIndexParameters().Length == 0))
                try { if (TypeResolver.Name(p.GetValue(espace)) is { Length: > 0 } theme) return theme; } catch { }
        return null;
    }

    public static string LiteralToggle(string style) => style.EndsWith(' ') ? style[..^1] : style + " ";
    /// <summary>The same Text for any expression form: <c>X + ""</c> (string concatenation binds loosest among the Text
    /// operators, so <c>X</c> is evaluated whole), or the suffix removed when an earlier touch left it.</summary>
    public static string ExpressionToggle(string style)
    {
        var text = style.Trim();
        if (text.Length == 0) return "\"\"";
        return text.EndsWith(" + \"\"", StringComparison.Ordinal) ? (text[..^5].TrimEnd() is { Length: > 0 } rest ? rest : "\"\"") : text + " + \"\"";
    }

    /// <summary>The Style of a widget as the kernel's get shows it (and its set takes it back): the expression's text for
    /// a reactive widget, the class text for a Traditional one; null when it cannot be read as text.</summary>
    private static string? StyleOf(ModelSession session, IObjectSignature widget)
    {
        try { return session.Get(widget)["properties"]?["Style"] is JsonValue v && v.TryGetValue<string>(out var text) ? text : ""; }
        catch { return null; }
    }

    private static string Css(IObjectSignature o) => ThemeCss.Of(o)?.EffectiveValue ?? "";

    private static IEnumerable<(IObjectSignature Element, string Kind, string Flavor)> Elements(ESpace espace)
    {
        foreach (var o in ((IESpace)(object)espace).GetAllDescendantsOfType<IObjectSignature>())
        {
            var (kind, flavor) = Kinds.GetOrAdd(o.GetType(), Classify);
            if (kind != null && !o.WasDeleted) yield return (o, kind, flavor);
        }
    }

    // Reactive (O11 Reactive and Mobile, ODC) first: an O11 mobile screen implements the web screen interface too.
    private static (string? Kind, string Flavor) Classify(Type type)
    {
        var names = type.GetInterfaces().Select(i => i.Name).ToHashSet(StringComparer.Ordinal);
        var reactive = names.Overlaps(["IMobileBlock", "IMobileScreen", "IMobileTheme"]) || !names.Overlaps(["IWebBlock", "IWebScreen", "IWebTheme"]);
        var kind = names.Overlaps(["IWebBlock", "IMobileBlock"]) ? "block" : names.Overlaps(["IWebScreen", "IMobileScreen"]) ? "screen"
            : names.Overlaps(["IWebTheme", "IMobileTheme", "ITheme"]) ? "theme" : null;
        if (kind != null && ThemeCssOf(type) == false) kind = null;
        return (kind, reactive ? "reactive" : "traditional");
    }
    private static bool? ThemeCssOf(Type type) => type.GetProperties().Any(p => p.Name == "StyleSheet" && typeof(AbstractStyleSheet).IsAssignableFrom(p.PropertyType));

    private static bool HasStyle(Type type) => Styled.GetOrAdd(type, t => t.GetInterfaces().SelectMany(i => i.GetProperties()).Any(p => p.Name == "Style" && p.GetIndexParameters().Length == 0));
    private static bool Is(object o, string part) => o.GetType().GetInterfaces().Any(i => i.Name.Contains(part, StringComparison.Ordinal));

    private static string? FlowOf(object o)
    {
        var p = ParentOf(o);
        for (var depth = 0; p != null && depth < 64; depth++, p = ParentOf(p))
            if (p.GetType().GetInterfaces().Any(i => i.Name.EndsWith("Flow", StringComparison.Ordinal))) return TypeResolver.Name(p);
        return null;
    }
    private static object? ParentOf(object o) { try { return o.GetType().GetProperty("Parent")?.GetValue(o); } catch { return null; } }
}
