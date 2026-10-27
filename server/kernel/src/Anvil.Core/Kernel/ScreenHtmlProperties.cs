using System.Globalization;

namespace Anvil.Reading;

// F2 (read -> edit -> read is a faithful round trip): the one property model of an element of the page, shared by the reading
// (what it writes), the edit (what it accepts and writes) and the verify (how it compares). It is derived from the native model
// of the element itself, never from a list here:
//  * the properties are the ones the Model API lists for its concrete type (ModelReader.PropertiesOf);
//  * the type of fact each one holds is its declared type's (ModelReader.DeclaredFactTypeOf: text, boolean, expression,
//    reference, list, enumeration or number), the same for every node of the type whatever value one holds; only a declared
//    type that says nothing (object) takes the type of the value this node holds (ScreenHtmlModule.FactsOf);
//  * a property is no fact of the page when it is bookkeeping (ModelReader.IsNoise), in ScreenHtml.NotFacts (identity, editor
//    state such as DesignMode, values derived from the structure), binary data, or a pointer to the node's own children (its
//    events, its branches: the structure writes them);
//  * whether an edit can write one is the Model API's (a setter, or an expression whose Text is set: ModelReader.IsWritable),
//    with the reason when it cannot (ReadOnlyReason);
//  * the values a value property takes are the members of its native enumeration (ModelReader.MembersOf);
//  * its default is the installed Studio's (ScreenDefaults, where the element sits): an absent property and a property written
//    at its default are the same value (the EFFECTIVE value), for the reading, the edit and the verify alike.
// What an edit may write on a property is one rule (Refusal), the one EditPlan.CheckProperties applies before anything is
// written and the one the tests hold every fact a reading writes to. F3 (Traditional write coverage) adds kinds to the reading;
// their properties come from this same model.
public sealed partial class ScreenHtmlModule<T>
{
    /// <summary>One property of an element in the reading's terms. <see cref="NotOfThePage"/> is null for a fact of the page and
    /// otherwise says why the page does not keep it (the reading never writes it, an edit may not write it).
    /// <see cref="ReadOnly"/> is null when an edit can write it, else why it cannot.</summary>
    internal sealed record PropertyModel(string Name, char Type, bool Writable, string? NotOfThePage, IReadOnlyList<string>? Members, string? ReadOnly = null);

    /// <summary>The property model of a node of this module (or of one an edit just created): every property its native model
    /// lists, by name. Computed for the node (its pointers to its own children are its structure's), with the types of its
    /// declared properties.</summary>
    internal IReadOnlyDictionary<string, PropertyModel> PropertiesOf(T node)
    {
        var kindName = r.KindOf(node);
        var shape = new Shape { Kind = kindName };
        var children = new HashSet<T>(r.ChildrenOf(node), ReferenceEqualityComparer.Instance);
        FactsOf(node, "widget", "model " + kindName, children, r.ParentOf(node), _ => false, shape, [], out var pointers);
        var model = new Dictionary<string, PropertyModel>(StringComparer.Ordinal);
        foreach (var (name, _) in r.PropertiesOf(node)) {
            if (model.ContainsKey(name)) continue;
            var declared = r.DeclaredFactTypeOf(node, name);
            string? why = ModelReader<T>.IsNoise(name) ? "bookkeeping of the model (the reading never writes it)"
                : ScreenHtml.NotFacts.Contains(name) ? NotFactReason(name)
                : declared == '-' ? "binary data, which the page has no text for (the reading never writes it)"
                : pointers.ContainsKey(name) ? "a part of the element (written as its children or its events, never as an attribute)"
                : null;
            var type = declared is { } d && d != '-' ? d
                : shape.Types.TryGetValue(name, out var t) && t != '?' ? t
                : shape.NullTypes.TryGetValue(name, out var nullType) ? nullType : r.NullFactTypeOf(node, name) ?? 'e';
            var writable = r.IsWritable(node, name) || type == 'e' && why == null;
            model[name] = new PropertyModel(name, type, writable, why, r.MembersOf(node, name), writable ? null : ReadOnlyReason(name, type));
        }
        return model;
    }

    // Why a name of ScreenHtml.NotFacts is no property of the page (the families of that list).
    private static string NotFactReason(string name) => name switch {
        "DesignMode" => "the Studio's design-time preview of the element (which branch or content its canvas shows): editor state, not a property of the page, so the reading never writes it and the running page never reads it",
        "Key" or "ObjectKey" or "GlobalKey" => "the identity of the element (k names it)",
        "HorizontalPosition" or "VerticalPosition" or "ExpandedInWebEditor" => "editor state (the canvas)",
        "Widgets" or "Content" or "Children" or "Placeholders" => "the structure of the element (its children are written inside it)",
        _ => "derived by the platform from other properties or from the structure (the reading never writes it)",
    };

    // Why the Model API lets no edit write a property: what it is and where the text writes it instead.
    private static string ReadOnlyReason(string name, char type) => name switch {
        "Events" => "the element's HTML events, written as on<event> attributes (html:on<event> when the element has a native event of that name)",
        "ExtendedProperties" => "the element's extended properties, written as their own attributes (ext:<name> when the name is taken)",
        "Arguments" => "the inputs of the block instance, written as :<Input> attributes",
        "EventHandlers" => "the handlers of the block's events, written as @<Event> attributes",
        "PlaceholdersContent" => "the slots of the block instance, written as its <slot> children",
        "BreakpointPropertyOverrides" => "the Studio's debugger breakpoints on the element (editor state)",
        "Definition" => "the definition the element was made from (its kind and, for an instance, its block: the tag and name=)",
        _ when type == 'l' => "a collection of the element's parts, written as its children or its own attributes, never as os-" + name,
        _ => "computed by the platform (the Model API has no setter for it)",
    };

    /// <summary>The one rule of what an edit may write on a property (EditPlan.CheckProperties; the tests hold every fact a
    /// reading writes to it): null when it may, else the refusal code, the reason and what the property takes.</summary>
    internal static (string Code, string Why, string? Takes)? Refusal(IReadOnlyDictionary<string, PropertyModel> model, string property, string fact, bool listsEveryProperty)
    {
        if (fact.Length < 2 || fact[1] != ':') return null;
        var text = fact[2..];
        if (!model.TryGetValue(property, out var p))
            return listsEveryProperty && !model.Keys.Any(n => string.Equals(n, property, StringComparison.OrdinalIgnoreCase))
                ? (ScreenHtmlEdit.PropertyNotKept, "no property " + property, null) : null;
        if (p.NotOfThePage != null) return (ScreenHtmlEdit.PropertyNotKept, property + " is not a property of the page: " + p.NotOfThePage, null);
        if (!p.Writable) return (ScreenHtmlEdit.PropertyNotKept, property + " has no setter in the Model API: " + p.ReadOnly, null);
        if (p.Members is { Count: > 0 } members && fact[0] is 'v' or 'e' && !members.Contains(text, StringComparer.Ordinal))
            return (ScreenHtmlEdit.PropertyValue, property + " takes one member of its enumeration", string.Join(", ", members));
        if (p.Type == 'b' && fact[0] is 'b' or 'e' && text is not ("True" or "False"))
            return (ScreenHtmlEdit.PropertyValue, property + " is a boolean", "True, False");
        return null;
    }

    /// <summary>The node of an element k of a reading of this module (null when the reading has no such k).</summary>
    internal T? NodeOf(ScreenHtmlDocument reading, string k)
    {
        var objectKey = reading.Keys.FirstOrDefault(p => p.Key == k).Value;
        if (objectKey == null || reading.State is not ReadingState state) return null;
        for (var i = 0; i < nodes.Count; i++)
            if ((root[i] == state.Root || i == state.Root) && key[i] == objectKey) return nodes[i];
        return null;
    }

    /// <summary>The node of this module with that ObjectKey (null: none), whatever the reading writes it as (an element, a run).</summary>
    internal T? NodeByKey(string objectKey)
    {
        for (var i = 0; i < nodes.Count; i++) if (key[i] == objectKey) return nodes[i];
        return null;
    }

    /// <summary>Whether the reader of this module lists every property of a node's type (ModelReader.ListsEveryProperty).</summary>
    internal bool ListsEveryProperty => r.ListsEveryProperty;

    /// <summary>The effective value of a fact of an element (type:text): the fact, or the default of its property where the element
    /// sits when it is absent. Two facts are the same value when their effective values are equal, whatever their type letter.</summary>
    internal static string? EffectiveText(ScreenDefaults defaults, string kind, string property, string? fact, char type, bool inPopup = false) =>
        fact is { Length: >= 2 } && fact[1] == ':' ? fact[2..] : fact ?? defaults.DefaultOf(kind, property, type, inPopup);

    internal static string Plural(int n, string one) => n.ToString(CultureInfo.InvariantCulture) + " " + one + (n == 1 ? "" : "s");
}
