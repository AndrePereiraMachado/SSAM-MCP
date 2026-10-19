using System.Collections.Concurrent;
using System.Diagnostics;
using System.Reflection;
using System.Text.Json.Nodes;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// The direct builder of docs/PROTOTIPO-NATIVO.md section 6: the widgets of an owner created in ONE pass through the Model API with
/// the parent in hand. No reference is resolved by name, no op goes through VerbSurface.Check, Anotar or FootprintScopes: the
/// create method of each (parent type, widget type) and every property accessor are looked up once and cached. Every widget gets
/// the defaults of <see cref="PrototypeWidgetDefaults"/> reset (default children, the default Style, the margins that add classes),
/// then the spec PrototypeWidgets built: name, properties, extended properties, event handler, block arguments.
/// </summary>
public sealed class PrototypeBuilder
{
    private readonly ModelSession.PrototypeAccess _model;
    private readonly string _platform;
    private static readonly ConcurrentDictionary<(Type Parent, string Widget), (MethodInfo Method, Type? Target)> CreateCache = new();
    private static readonly ConcurrentDictionary<(Type Type, string Property), PropertyInfo?> PropertyCache = new();
    private static readonly ConcurrentDictionary<(Type Type, string Method), MethodInfo?> MethodCache = new();
    private readonly Dictionary<string, object> _named = new(StringComparer.Ordinal);
    private readonly List<(object Widget, string Target)> _labels = [];
    public Dictionary<string, string> Keys { get; } = new(StringComparer.Ordinal);
    public int Widgets { get; private set; }
    public int ExtendedProperties { get; private set; }
    public List<JsonObject> Problems { get; } = [];

    internal PrototypeBuilder(ModelSession.PrototypeAccess model, string platform) { _model = model; _platform = platform; }

    /// <summary>Builds the roots of a job under its parent, in order; returns the elapsed milliseconds.</summary>
    public long Build(PrototypeWidgetsJob job, object parent)
    {
        var sw = Stopwatch.StartNew();
        _named.Clear(); _labels.Clear();
        foreach (var root in job.Roots) Widget(parent, root, job.Specs);
        foreach (var (widget, target) in _labels)
            if (_named.TryGetValue(target, out var targetWidget)) SetProperty(widget, "TargetWidget", targetWidget);
        return sw.ElapsedMilliseconds;
    }

    private object Container(object parent)
    {
        // an HTML element keeps its children in Content
        if (Is(parent, "IAdvancedHtml") && Prop(parent, "Content") is { } content) return content;
        return parent;
    }

    private void Widget(object parent, WidgetNode node, IReadOnlyDictionary<WidgetNode, PrototypeWidgetSpec> specs)
    {
        var spec = specs.GetValueOrDefault(node) ?? new PrototypeWidgetSpec();
        object widget;
        try { using (NativePerformanceCapture.Measure("prototype.create")) widget = Create(Container(parent), node.W, spec.Name is { } n && !n.StartsWith('$') ? n : null); }
        catch (Exception ex)
        {
            Problems.Add(new JsonObject { ["k"] = node.K, ["code"] = "CREATE_FAILED", ["message"] = $"{node.W}: {ex.GetBaseException().Message}", ["done"] = "removed" });
            return;
        }
        Widgets++;
        // a wrapper of the runtime (popup, block instance, placeholder) has no element of the prototype: no key, so the measure
        // reads it as the runtime's own element
        if (widget is IObjectSignature sig && sig.ObjectKey != null && node.K != null && node.Role != "wrapper") Keys[sig.ObjectKey.ToString()!] = node.K;
        if (spec.Name is { } name)
        {
            if (name.StartsWith('$')) _model.Register(name, widget);
            else _named[name] = widget;
        }
        using (NativePerformanceCapture.Measure("prototype.reset")) PrototypeWidgetDefaults.Reset(widget, node.W, _platform, Prop, SetProperty, DeleteChild);
        try { Apply(widget, node, spec); }
        catch (Exception ex) { Problems.Add(new JsonObject { ["k"] = node.K, ["code"] = "PROPERTY_FAILED", ["message"] = $"{node.W}: {ex.GetBaseException().Message}", ["done"] = "property removed" }); }
        if (node.W == "IIfWidget")
        {
            var then = Prop(widget, "TrueBranch");
            var otherwise = Prop(widget, "FalseBranch");
            if (then != null) foreach (var child in node.Children) Widget(then, child, specs);
            if (otherwise != null && node.Else != null) foreach (var child in node.Else) Widget(otherwise, child, specs);
            return;
        }
        if (node.W == "ITableRecords")
        {
            // a native Table: its header cells in its HeaderRow, its row cells in its Row (what the Studio created there first removed)
            var header = Prop(widget, "HeaderRow");
            var row = Prop(widget, "Row");
            foreach (var content in new[] { header, row })
                if (content is IObjectSignature holder)
                    foreach (var born in holder.Children.OfType<IObjectSignature>().Where(c => c.GetInterface()?.Name is "IHeaderCell" or "IRowCell").ToList()) born.Delete();
            foreach (var child in node.Children)
                if ((child.W == "IHeaderCell" ? header : row) is { } target) Widget(target, child, specs);
                else Problems.Add(new JsonObject { ["k"] = child.K, ["code"] = "CREATE_FAILED", ["message"] = "the native Table has no " + (child.W == "IHeaderCell" ? "HeaderRow" : "Row"), ["done"] = "removed" });
            return;
        }
        foreach (var child in node.Children) Widget(widget, child, specs);
    }

    private void Apply(object widget, WidgetNode node, PrototypeWidgetSpec spec)
    {
        foreach (var (property, value) in spec.Properties)
        {
            try { using (NativePerformanceCapture.Measure("prototype.property")) Write(widget, node.W, property, value); }
            catch (Exception ex) { Problems.Add(new JsonObject { ["k"] = node.K, ["code"] = "PROPERTY_FAILED", ["property"] = property, ["message"] = ex.GetBaseException().Message, ["done"] = "property removed" }); }
        }
        foreach (var (name, value) in spec.Extended) using (NativePerformanceCapture.Measure("prototype.extended")) Extended(widget, name, value);
        if (spec.TargetWidget != null) _labels.Add((widget, spec.TargetWidget));
        if (spec.Block != null) using (NativePerformanceCapture.Measure("prototype.block")) BlockInstance(widget, node, spec);
        if (spec.Handler != null) using (NativePerformanceCapture.Measure("prototype.handler")) Handler(widget, node, spec.Handler);
    }

    /// <summary>Writes an expression property however this platform keeps it: the Text of a read-only IExpression (O11), a
    /// writable text or parsed ExpressionDefinition (ODC), or its Set&lt;Prop&gt;(text) method.</summary>
    internal static void Expression(object target, string property, string text)
    {
        var pi = FindProperty(target, property);
        if (pi != null && pi.CanWrite)
        {
            var t = Nullable.GetUnderlyingType(pi.PropertyType) ?? pi.PropertyType;
            if (t == typeof(string)) { pi.SetValue(target, text); return; }
            if (t.FullName == "OutSystems.Model.Expressions.ExpressionDefinition") { pi.SetValue(target, t.GetMethod("Parse", BindingFlags.Public | BindingFlags.Static, [typeof(string)])!.Invoke(null, [text])); return; }
            if (pi.GetValue(target) is IExpression writableExpression) { writableExpression.Text = text; return; }
        }
        if (pi != null && pi.GetValue(target) is IExpression expression) { expression.Text = text; return; }
        // a read-only expression not created yet (ODC: ExtendedProperty.Value, Argument.Value are null until the class's own
        // Set<Prop>(string) creates them)
        if (TextSetter(target, property) is { } setter) { setter.Invoke(target, [text]); return; }
        throw new InvalidOperationException($"{target.GetType().Name}.{property} is not an expression this builder can write");
    }

    private void Write(object widget, string type, string property, string value)
    {
        if (property == "Style" && FindProperty(widget, "Style") == null)
        {
            // a widget without Style keeps its classes in StyleClasses (text) or in the extended property class
            if (FindProperty(widget, "StyleClasses") is { } classes && Prop(widget, "StyleClasses") is IExpression ce) { ce.Text = value; return; }
            Extended(widget, "class", value);
            return;
        }
        if (property == "Image") { SetProperty(widget, "Image", _model.Resolve("IImage:" + value)); return; }
        var pi = FindProperty(widget, property);
        if (pi != null && !pi.CanWrite && pi.GetValue(widget) is IExpression expression) { expression.Text = value; return; }
        if (pi != null && pi.CanWrite)
        {
            var t = Nullable.GetUnderlyingType(pi.PropertyType) ?? pi.PropertyType;
            object? converted = t == typeof(string) ? value
                : t == typeof(bool) ? bool.Parse(value)
                : t == typeof(int) ? int.Parse(value)
                : t.IsEnum ? Enum.Parse(t, value, ignoreCase: true)
                : t.FullName == "OutSystems.Model.Expressions.ExpressionDefinition" ? t.GetMethod("Parse", BindingFlags.Public | BindingFlags.Static, [typeof(string)])!.Invoke(null, [value])
                : throw new InvalidOperationException($"{type}.{property} takes {t.Name}");
            pi.SetValue(widget, converted);
            return;
        }
        if (pi != null && !pi.CanWrite && TextSetter(widget, property) is { } textSetter) { textSetter.Invoke(widget, [value]); return; }
        if (FindMethod(widget, "Set" + property) is { } setter)
        {
            var parameterType = setter.GetParameters()[0].ParameterType;
            object? arg = parameterType == typeof(string) ? value
                : parameterType.FullName == "OutSystems.Model.Expressions.ExpressionDefinition" ? parameterType.GetMethod("Parse", BindingFlags.Public | BindingFlags.Static, [typeof(string)])!.Invoke(null, [value])
                : throw new InvalidOperationException($"{type}.Set{property} takes {parameterType.Name}");
            setter.Invoke(widget, [arg]);
            return;
        }
        throw new InvalidOperationException($"{type} has no property {property}");
    }

    private void Extended(object widget, string name, string value)
    {
        var create = FindMethod(widget, "CreateExtendedProperty") ?? throw new InvalidOperationException("no extended properties on " + widget.GetType().Name);
        var ep = create.Invoke(widget, create.GetParameters().Select(p => p.HasDefaultValue ? p.DefaultValue : null).ToArray())!;
        SetProperty(ep, "Property", name);
        Expression(ep, "Value", value);
        ExtendedProperties++;
    }

    private void BlockInstance(object widget, WidgetNode node, PrototypeWidgetSpec spec)
    {
        var block = _model.Resolve(_model.BlockRef(spec.Block!));
        SetProperty(widget, "SourceBlock", block);
        foreach (var (input, value) in spec.BlockArguments)
            if (Argument(widget, input) is { } argument) Expression(argument, "Value", value);
            else Problems.Add(new JsonObject { ["k"] = node.K, ["code"] = "ARGUMENT_MISSING", ["message"] = $"block instance of {spec.Block} has no input {input}", ["done"] = "argument removed" });
    }

    private object? Argument(object owner, string name)
    {
        if (owner is not IObjectSignature sig) return null;
        foreach (var child in sig.Children)
            if (string.Equals(ModelSession.PrototypeAccess.ArgumentNameOf(child), name, StringComparison.OrdinalIgnoreCase)) return child;
        return null;
    }

    private void Handler(object widget, WidgetNode node, PrototypeHandler handler)
    {
        object? target = handler.Screen != null ? _model.Resolve(_model.ScreenRef(handler.Screen)) : handler.Action != null ? _model.Action(handler.Action) : null;
        if (target == null) { Problems.Add(new JsonObject { ["k"] = node.K, ["code"] = "HANDLER_MISSING", ["message"] = $"no {(handler.Screen != null ? "screen " + handler.Screen : "action " + handler.Action)}", ["done"] = "event removed" }); return; }
        object? evt;
        if (handler.Extended)
        {
            var create = FindMethod(widget, "CreateEvent") ?? throw new InvalidOperationException("no events on " + widget.GetType().Name);
            evt = create.Invoke(widget, create.GetParameters().Select(p => p.HasDefaultValue ? p.DefaultValue : null).ToArray());
            SetProperty(evt!, "Event", handler.Event);
            SetProperty(evt!, "Handler", target);
        }
        else
        {
            evt = Prop(widget, handler.Event);
            if (evt == null) { Problems.Add(new JsonObject { ["k"] = node.K, ["code"] = "EVENT_MISSING", ["message"] = $"{node.W} has no {handler.Event}", ["done"] = "event removed" }); return; }
            SetProperty(evt, "Destination", target);
        }
        foreach (var (argument, value) in handler.Arguments)
        {
            if (Argument(evt!, argument) is { } a) Expression(a, "Value", value);
            else Problems.Add(new JsonObject { ["k"] = node.K, ["code"] = "ARGUMENT_MISSING", ["message"] = $"{node.W}.{handler.Event} has no argument {argument}; children: " + string.Join(", ", ((IObjectSignature)evt!).Children.Select(c => c.GetType().Name + ":" + ModelSession.PrototypeAccess.ArgumentNameOf(c))), ["done"] = "argument removed" });
        }
    }

    // ---- reflection, cached ----------------------------------------------------------------------------------------------------

    private object Create(object parent, string type, string? name)
    {
        var key = (parent.GetType(), type);
        if (CreateCache.TryGetValue(key, out var cached)) return Invoke(parent, cached.Method, cached.Target, name);
        Exception? last = null;
        foreach (var (method, generic, target) in _model.FindCreate(parent, type))
        {
            var m = generic ? method.MakeGenericMethod(target) : method;
            try
            {
                var created = Invoke(parent, m, target, name);
                CreateCache[key] = (m, target);
                return created;
            }
            catch (Exception ex) { last = ex; }
        }
        throw new InvalidOperationException($"{parent.GetType().Name} cannot create {type}" + (last != null ? ": " + last.GetBaseException().Message : ""));
    }

    private static object Invoke(object parent, MethodInfo m, Type? target, string? name)
    {
        var ps = m.GetParameters();
        var values = new object?[ps.Length];
        for (var i = 0; i < ps.Length; i++)
        {
            var p = ps[i];
            if (p.Name == "name" && p.ParameterType == typeof(string)) values[i] = name;
            else if (p.ParameterType == typeof(Type)) values[i] = target;
            else if (p.HasDefaultValue) values[i] = p.DefaultValue;
            else values[i] = p.ParameterType.IsValueType ? Activator.CreateInstance(p.ParameterType) : null;
        }
        var created = m.Invoke(parent, values) ?? throw new InvalidOperationException("created nothing");
        if (name != null && ps.All(p => p.Name != "name") && FindProperty(created, "Name") is { CanWrite: true } np) np.SetValue(created, name);
        return created;
    }

    internal static PropertyInfo? FindProperty(object o, string name)
        => PropertyCache.GetOrAdd((o.GetType(), name), k =>
        {
            PropertyInfo? found = null;
            foreach (var p in ModelApiMetadata.Properties(k.Type))
                if (string.Equals(p.Name, k.Property, StringComparison.Ordinal)) { if (p.CanWrite) return p; found ??= p; }
            return found;
        });

    private static readonly ConcurrentDictionary<(Type Type, string Property), MethodInfo?> TextSetterCache = new();

    /// <summary>Set&lt;Prop&gt;(string) of the Model API interface or of the concrete class.</summary>
    private static MethodInfo? TextSetter(object o, string property)
        => TextSetterCache.GetOrAdd((o.GetType(), property), k =>
            ModelApiMetadata.Methods(k.Type).FirstOrDefault(m => m.Name == "Set" + k.Property && m.GetParameters() is [{ ParameterType: var p }] && p == typeof(string))
            ?? k.Type.GetMethod("Set" + k.Property, BindingFlags.Public | BindingFlags.Instance, [typeof(string)]));

    internal static MethodInfo? FindMethod(object o, string name)
        => MethodCache.GetOrAdd((o.GetType(), name), k => ModelApiMetadata.Methods(k.Type).FirstOrDefault(m => m.Name == k.Method && (m.GetParameters().Length == 1 || k.Method.StartsWith("Create", StringComparison.Ordinal))));

    internal static object? Prop(object o, string name)
    {
        var pi = FindProperty(o, name);
        if (pi != null) { try { return pi.GetValue(o); } catch { return null; } }
        var concrete = o.GetType().GetProperty(name, BindingFlags.Public | BindingFlags.Instance);
        try { return concrete?.GetValue(o); } catch { return null; }
    }

    internal static void SetProperty(object o, string name, object? value)
    {
        var pi = FindProperty(o, name);
        if (pi is { CanWrite: true }) { pi.SetValue(o, value); return; }
        var concrete = o.GetType().GetProperty(name, BindingFlags.Public | BindingFlags.Instance);
        if (concrete is { CanWrite: true }) { concrete.SetValue(o, value); return; }
        if (pi != null && !pi.CanWrite && pi.GetValue(o) is IExpression e && value is string text) { e.Text = text; return; }
        throw new InvalidOperationException($"{o.GetType().Name}.{name} is not writable");
    }

    private static void DeleteChild(object child) { if (child is IObjectSignature s) s.Delete(); }

    /// <summary>A structural read-back of built roots (widget type, name, tag, style, extended properties, event and children):
    /// what the compile lane's own tests check against the specs, and the stand-in for PrototypeSeams.Render in them. The css lane's
    /// renderer is the one that produces the runtime DOM.</summary>
    public static JsonObject ReadBack(PrototypeRenderRequest request)
    {
        var result = new JsonObject { ["schema"] = "ssam-prototype-readback/1", ["platform"] = request.Platform };
        var roots = new JsonObject();
        foreach (var (key, root) in request.Roots.OrderBy(r => r.Key, StringComparer.Ordinal)) roots[key] = ReadNode(root, 0);
        result["roots"] = roots;
        return result;
    }

    private static JsonObject ReadNode(IObjectSignature o, int depth)
    {
        var node = new JsonObject { ["type"] = o.GetInterface()?.Name ?? o.GetType().Name };
        if (TypeResolver.Name(o) is { Length: > 0 } name) node["name"] = name;
        if (Prop(o, "Tag") is string tag && tag.Length > 0) node["tag"] = tag;
        if (Prop(o, "Style") is IExpression style && style.Text.Length > 0) node["style"] = style.Text;
        if (Prop(o, "Text") is string text) node["text"] = text;
        if (Prop(o, "Value") is IExpression value && value.Text.Length > 0) node["value"] = value.Text;
        if (Prop(o, "Condition") is IExpression condition) node["condition"] = condition.Text;
        if (Prop(o, "Source") is IExpression source && source.Text.Length > 0) node["source"] = source.Text;
        var extended = new JsonArray();
        var children = new JsonArray();
        if (depth > 60) return node;
        foreach (var child in o.Children.OfType<IObjectSignature>())
        {
            var type = child.GetInterface()?.Name ?? "";
            if (type == "IExtendedProperty")
                extended.Add(new JsonArray(Prop(child, "Property") as string ?? "", (Prop(child, "Value") as IExpression)?.Text ?? ""));
            else if (type is "IEvent" or "IExtendedEvent" || child.GetType().Name == "ExtendedEvent")
                node["event"] = (Prop(child, "Event") as string) + ":" + TypeResolver.Name(Prop(child, "Handler"));
            else if (child is OutSystems.Model.UI.IWidget || type is "IContent" or "IIfBranchWidget" or "IPlaceholderContentWidget")
                children.Add(ReadNode(child, depth + 1));
        }
        foreach (var branch in new[] { "TrueBranch", "FalseBranch" })
            if (Prop(o, branch) is IObjectSignature b && !o.Children.Contains(b)) children.Add(ReadNode(b, depth + 1));
        if (Prop(o, "OnClick") is IObjectSignature click && Prop(click, "Destination") is { } destination) node["onClick"] = TypeResolver.Name(destination);
        if (extended.Count > 0) node["extended"] = extended;
        if (children.Count > 0) node["children"] = children;
        return node;
    }

    private static bool Is(object o, string interfaceName) => o.GetType().GetInterfaces().Any(i => i.Name == interfaceName);
}
