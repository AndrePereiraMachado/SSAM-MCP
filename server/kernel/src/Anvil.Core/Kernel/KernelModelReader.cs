using System.Collections.Concurrent;
using Anvil.Reading;
using OutSystems.Model;

namespace Anvil.Core;

// One adapter, compiled against both O11 and ODC. The ODC builder uses its descriptor adapter instead.
public sealed class KernelModelReader : ModelReader<IObjectSignature>
{
    protected override IEnumerable<IObjectSignature> Children(IObjectSignature node) => node.Children.OfType<IObjectSignature>();
    protected override IObjectSignature? Parent(IObjectSignature node) => node.Parent as IObjectSignature;
    protected override string Key(IObjectSignature node) => node.ObjectKey?.ToString() ?? "";
    protected override string Kind(IObjectSignature node) => ModelHost.Kind(node.GetInterface()?.Name ?? node.GetType().Name);
    protected override string Name(IObjectSignature node) => ModelHost.Prop(node, "Name")?.ToString() ?? "";
    protected override string? Label(IObjectSignature node) => ModelHost.Prop(node, "Label")?.ToString();
    // ModelSession.Implements as a set: EntityIndexes.TypeName plus every interface Name and FullName, per concrete type.
    private static readonly ConcurrentDictionary<Type, IReadOnlySet<string>> KindNameSets = new();
    protected override IReadOnlySet<string> KindNames(IObjectSignature node) => KindNameSets.GetOrAdd(node.GetType(), _ =>
        node.GetType().GetInterfaces().SelectMany(i => new[] { i.Name, i.FullName }).Append(EntityIndexes.TypeName(node))
            .OfType<string>().ToHashSet(StringComparer.Ordinal));
    protected override string? Expression(object value) => value is IExpression expression ? expression.Text : null;
    protected override IEnumerable<IObjectSignature> Referrers(IObjectSignature node) =>
        node is ServiceStudio.Model.AbstractObject model ? model.Referers.OfType<IObjectSignature>()
            : throw new InvalidOperationException("Native referrers unavailable for " + Kind(node));
    protected override IEnumerable<(string Name, Func<object?> Read)> Properties(IObjectSignature node) =>
        Readable(node.GetType()).Select(p => (p.Name, (Func<object?>)(() => p.GetValue(node))));
    // One entry per name, so the property Properties lists under a name is fixed per concrete type.
    private static readonly ConcurrentDictionary<(Type Type, string Name), System.Reflection.PropertyInfo?> NamedProperties = new();
    protected override Func<object?>? FindProperty(IObjectSignature node, string name) =>
        NamedProperties.GetOrAdd((node.GetType(), name), key => Readable(key.Type).FirstOrDefault(p => p.Name == key.Name)) is { } property
            ? () => property.GetValue(node) : null;
    protected override char? NullFactType(IObjectSignature node, string name)
    {
        var type = NamedProperties.GetOrAdd((node.GetType(), name), key => Readable(key.Type).FirstOrDefault(p => p.Name == key.Name))?.PropertyType;
        if (type == null) return null;
        if (type == typeof(string)) return 't';
        // An expression is a model object too: it is asked first.
        if (typeof(IExpression).IsAssignableFrom(type)) return 'e';
        if (typeof(IObjectSignature).IsAssignableFrom(type)) return 'r';
        if (type.IsGenericType && typeof(System.Collections.IEnumerable).IsAssignableFrom(type) && type.GetGenericArguments() is [var item]
            && typeof(IObjectSignature).IsAssignableFrom(item) && !typeof(IExpression).IsAssignableFrom(item)) return 'l';
        return null;
    }
    // The installed Studio's defaults of the screen reading for the pages of a UI flow of this module (StudioDefaults: measured
    // once per Studio identity and context: the module and the theme of the flow).
    protected internal override ScreenDefaults? DefaultsOf(IObjectSignature module, IObjectSignature? flow) =>
        module is ServiceStudio.Model.ESpace espace ? StudioDefaults.For(espace, flow) : null;
    // O11 keeps the mapping of an assignment or an argument in its TypeConversion (the platform adapter reads it); ODC keeps
    // it in the expression text, and its adapter has none.
    protected internal override NativeMapping? RecordMapping(IObjectSignature node) => StudioAdapter.Runtime.Mappings?.Read(node);
    protected internal override bool MappingsBeside => StudioAdapter.Runtime.Mappings != null;

    // The review of round 2 (round trip, high): an attribute renamed in the Studio onto the name of an input a field value of a
    // mapping reads (SrcRow.Note renamed Prefix, `Src mapTo { Key: Prefix + Code }`) left the value bound to the input, and the
    // reading printed the same text, said a fixed point, and an edit of it would read the attribute. Both lanes keep the mapping
    // in the value's ValueTypeConversion (AttributesMappings: TargetValue the attribute, SourceValue the expression with its
    // references, measured 2026-10-12 on Service Studio 11 and ODC Studio): a field whose expression refers to a parameter or a
    // variable that has the name of an attribute of the source is said here, and the flow reader makes that node opaque.
    protected internal override IReadOnlyList<string>? MappingCaptures(IObjectSignature node)
    {
        object? Prop(object? o, string name) { if (o == null) return null; try { return ModelHost.Prop(o, name); } catch (Exception) { return null; } }
        if (Prop(node, "ValueTypeConversion") is not { } conversion || Prop(conversion, "AttributesMappings") is not System.Collections.IEnumerable listed) return null;
        var mappings = listed.Cast<object>().ToList();
        List<string>? found = null;
        HashSet<string>? attributes = null;
        foreach (var mapping in mappings) {
            if (Prop(Prop(mapping, "SourceValue"), "Value") is not IExpression value || Prop(value, "ReferedObjects") is not System.Collections.IEnumerable referred) continue;
            foreach (var element in referred.OfType<IObjectSignature>().Distinct()) {
                var kind = Kind(element);
                // An input, an output or a local of the action, a variable or an input of its screen: the names a field value reads bare
                // (a client or session variable, a site property is read through its own prefix).
                if (!(kind is "InputParameter" or "OutputParameter" or "LocalVariable" || kind.EndsWith("InputParameter", StringComparison.Ordinal))) continue;
                attributes ??= SourceAttributes(conversion, mappings, Prop) ?? [];
                var name = Name(element);
                if (!attributes.Contains(name)) continue;
                var field = Prop(Prop(mapping, "TargetValue"), "Value") is IExpression target ? target.Text : "?";
                (found ??= []).Add("mapping field " + field + ": " + value.Text + " reads the " + kind + " " + name + ", and the source of the mapping has an attribute " + name
                    + " (renamed onto that name after the value was written): read again, the text would read the attribute");
            }
        }
        return found;
    }

    // The attribute names of the record a mapping converts from: the record its conversion refers to that is not the record of
    // its target attributes. Null when the conversion does not say.
    private HashSet<string>? SourceAttributes(object conversion, List<object> mappings, Func<object?, string, object?> prop)
    {
        IObjectSignature? target = null;
        foreach (var mapping in mappings)
            if (prop(prop(mapping, "TargetValue"), "Value") is { } targetValue && prop(targetValue, "ReferedObjects") is System.Collections.IEnumerable refs
                && refs.OfType<IObjectSignature>().FirstOrDefault(r => Kind(r).EndsWith("Attribute", StringComparison.Ordinal)) is { } attribute) { target = Parent(attribute); break; }
        if (prop(conversion, "ReferedObjects") is not System.Collections.IEnumerable referred) return null;
        var records = referred.OfType<IObjectSignature>().Distinct().Where(r => Children(r).Any(c => Kind(c).EndsWith("Attribute", StringComparison.Ordinal))).ToList();
        var source = records.Where(r => !ReferenceEquals(r, target)).ToList();
        return source.Count == 1 ? Children(source[0]).Where(c => Kind(c).EndsWith("Attribute", StringComparison.Ordinal)).Select(Name).ToHashSet(StringComparer.OrdinalIgnoreCase) : null;
    }
    // Both Model APIs keep entity indexes on the entity (EntityIndexes); O11 lists none of them as a child.
    protected internal override IReadOnlyList<(string Name, bool Unique, bool Auto, string[] Attributes)>? Indexes(IObjectSignature node) =>
        node is ServiceStudio.Model.Entity { IsStaticEntity: false } entity
            ? entity.EntityIndices.Select(i => (i.Name, i.Unique, i.AutoGenerated, i.IndexAttributes.Select(a => a.Attribute?.Name ?? "?").ToArray())).ToList()
            : null;
    // The index elements of a server entity (O11 lists none as a child; ODC does, and answers null here).
    protected internal override IReadOnlyList<IObjectSignature>? IndexNodes(IObjectSignature node) =>
        node is ServiceStudio.Model.Entity { IsStaticEntity: false } entity && Indexes(node) is { Count: > 0 } && !Children(node).Any(c => Kind(c) == "EntityIndex")
            ? entity.EntityIndices.OfType<IObjectSignature>().ToList() : null;
    protected override bool Writable(IObjectSignature node, string property) =>
        NamedProperties.GetOrAdd((node.GetType(), property), key => Readable(key.Type).FirstOrDefault(p => p.Name == key.Name)) is { CanWrite: true };
    private static IEnumerable<System.Reflection.PropertyInfo> Readable(Type type) =>
        ModelApiMetadata.Properties(type).Where(p => p.GetIndexParameters().Length == 0)
            .GroupBy(p => p.Name).Select(g => g.OrderByDescending(p => p.CanWrite).First());
}
