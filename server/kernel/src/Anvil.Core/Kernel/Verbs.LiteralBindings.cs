using System.Text.Json.Nodes;
using Anvil.Reading;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// T1 "a text value never carries binding syntax or raw markup": the invariant of the candidate after the apply of every job,
/// whatever op wrote it (the fragment op, the screen or block document, the edit form and its edits[], the page form, a set).
/// <list type="bullet">
/// <item>LITERAL_BINDING_REMNANT: no literal-typed value of a page element the job created or wrote (the Text of a Text widget,
/// a caption, any text property) holds {{ ... }} once its HTML entities are decoded, and no string literal of an expression it
/// wrote holds one (a Prompt "{{ ""Search"" }}", an extended property, a Value): the page would show the braces. Each occurrence
/// names the element, its kind, the property, the value, and gives the one fix (the expression or the text the binding stands
/// for).</item>
/// <item>HTML_IN_EXPRESSION: an Expression of a Reactive or ODC page whose value is a constant holding markup shows the markup as
/// text (a Traditional Expression with Escape Content No copied as it is); the fix is the markup written as the page's own
/// elements.</item>
/// </list>
/// Only what the job created (every property) or wrote (the properties a set wrote) is judged: a remnant the module already had is
/// the module's, not this delivery's. The rule of what a remnant is lives in BindingText.
/// </summary>
public sealed partial class ModelSession
{
    // Properties of a page element that are never page text: its identity, documentation, CSS and code.
    private static readonly HashSet<string> NotPageText = new(StringComparer.Ordinal) {
        "Name", "Description", "StyleSheet", "CustomStyle", "JavaScript", "Tag", "Icon", "CustomName", "Label", "Image", "ImageMarkup", "Event", "Property" };

    /// <summary>The problems of the invariant on the candidate (the ops already applied): every remnant and every Expression that
    /// shows markup, one problem each, with the op that wrote it.</summary>
    internal List<JsonObject> LiteralBindingRemnants(string? opsPointer)
    {
        var problems = new List<JsonObject>();
        var reader = new KernelModelReader();
        var seen = new HashSet<(object, string)>(new TargetProperty());
        foreach (var (o, op) in _anchors.ToArray())
        {
            if (o is not IObjectSignature node || node.WasDeleted) continue;
            var created = _creators.ContainsKey(o);
            Judge(node, op, created);
            // What a created element carries as its own parts (its extended properties, the expressions of its events and
            // arguments are judged where they are written): the document form writes them without an op of their own.
            if (created)
                foreach (var part in node.Children.OfType<IObjectSignature>())
                    if (!part.WasDeleted && RemnantKind(part) == "ExtendedProperty" && !_anchors.ContainsKey(part)) Judge(part, op, true);
        }
        return problems;

        void Judge(IObjectSignature node, int op, bool created)
        {
            var kind = RemnantKind(node);
            if (!PageElement(kind)) return;
            IEnumerable<(string Name, Func<object?> Read)> properties;
            try { properties = reader.PropertiesOf(node).ToList(); } catch (Exception) { return; }
            foreach (var (name, read) in properties)
            {
                if (NotPageText.Contains(name) && !(kind == "ExtendedProperty" && name == "Value") || ScreenHtml.NotFacts.Contains(name) || ModelReader<IObjectSignature>.IsNoise(name)) continue;
                if (!created && !_propertyAnchors.ContainsKey((node, name))) continue;
                if (!seen.Add((node, name))) continue;
                object? value;
                try { value = read(); } catch (Exception) { continue; }
                switch (value)
                {
                    case string text when BindingText.HoldsPair(text):
                        problems.Add(Problem(node, kind, name, op, text, literal: true));
                        break;
                    case IExpression expression when expression.Text is { Length: > 0 } source:
                        foreach (var remnant in BindingText.Remnants(source).Distinct(StringComparer.Ordinal))
                            problems.Add(Problem(node, kind, name, op, source, literal: false, remnant));
                        if (kind == "Expression" && name == "Value" && BindingText.Markup(source) is { } markup && !EscapesNothing(node))
                            problems.Add(Markup(node, op, source, markup));
                        break;
                }
            }
        }

        JsonObject Problem(IObjectSignature node, string kind, string property, int op, string value, bool literal, string? remnant = null)
        {
            var element = RemnantDescribe(node, kind);
            var attribute = RemnantAttribute(node, kind, property);
            var fix = literal
                ? "write the text as " + BindingText.TextFixOf(value) + " (a constant binding is its text; a binding that names something is an Expression, {{ X }}); braces the page must show are written &#123; in <text>, or split in an expression ({{ \"{\" + \"{\" }})"
                : "write " + attribute + "='" + BindingText.FixOf(remnant!) + "' (the expression the binding stands for, not its text in a string); braces the page must show are split in the expression ({{ \"{\" + \"{\" }})";
            var problem = JobPreflight.Problem(op, $"{opsPointer ?? "/ops"}/{op}", BindingText.Remnant, "error",
                $"{element}: {property} {(literal ? "is a literal that holds" : "holds a text literal with")} the binding {RemnantClip(remnant ?? value)}: the page would show the braces as text", fix);
            problem["phase"] = "apply";
            problem["element"] = ModelHost.PathOf(node);
            problem["key"] = node.ObjectKey?.ToString();
            problem["kind"] = kind; problem["property"] = property; problem["attribute"] = attribute;
            problem["expected"] = literal ? "a literal without the braces of a binding" : "an expression whose text literals hold no binding";
            problem["actual"] = value;
            problem["next"] = fix;
            return problem;
        }

        JsonObject Markup(IObjectSignature node, int op, string value, string markup)
        {
            var fix = "write the markup as the page's own elements (the html op compiles " + RemnantClip(markup) + " to its widgets), or keep the text without tags; an Expression of a Reactive or ODC page always shows its value as text";
            var problem = JobPreflight.Problem(op, $"{opsPointer ?? "/ops"}/{op}", BindingText.HtmlInExpression, "error",
                $"{RemnantDescribe(node, "Expression")}: its Value is a constant with markup ({RemnantClip(markup)}): the page would show the tags as text (a Traditional Expression with Escape Content No is no Reactive Expression)", fix);
            problem["phase"] = "apply";
            problem["element"] = ModelHost.PathOf(node);
            problem["key"] = node.ObjectKey?.ToString();
            problem["kind"] = "Expression"; problem["property"] = "Value";
            problem["expected"] = "a value the page shows as text, or the markup as elements";
            problem["actual"] = value;
            problem["markup"] = markup;
            problem["next"] = fix;
            return problem;
        }
    }

    private static string RemnantKind(IObjectSignature node) => ModelHost.Kind(node.GetInterface()?.Name ?? node.GetType().Name);

    // The elements of a page: its widgets (every kind of the reading and the Traditional ones) and their extended properties.
    private static bool PageElement(string kind) =>
        ScreenHtml.WidgetTags.ContainsKey(kind) || ScreenHtml.OpaqueKinds.Contains(kind) || kind is "AdvancedHtml" or "List" or "ExtendedProperty" or "Gallery"
        || kind.EndsWith("Widget", StringComparison.Ordinal);

    // A Traditional Expression with Escape Content No renders its markup: no problem there.
    private static bool EscapesNothing(IObjectSignature node) => ModelHost.Prop(node, "EscapeContent") is false;

    private static string RemnantDescribe(IObjectSignature node, string kind)
    {
        var name = TypeResolver.Name(node);
        var owner = node.Parent is IObjectSignature parent && RemnantKind(parent) == "ExtendedProperty" ? parent : node;
        var where = ModelHost.PathOf(owner);
        return kind + (name is { Length: > 0 } ? " '" + name + "'" : "") + (where is { Length: > 0 } ? " at " + where : "");
    }

    // The attribute of the text forms that writes a property (the fix names it): placeholder for Prompt, the extended property's name.
    private static string RemnantAttribute(IObjectSignature node, string kind, string property) => (kind, property) switch
    {
        ("ExtendedProperty", "Value") => ModelHost.Prop(node, "Property")?.ToString() is { Length: > 0 } attribute ? attribute : "the attribute",
        (_, "Prompt") => "placeholder",
        (_, "Style" or "StyleClasses") => "class",
        (_, "Text") or ("TextWidget", "Value") => "the text",
        _ => "os-" + property,
    };

    private static string RemnantClip(string text) => text.Length <= 120 ? text : text[..117] + "...";
}
