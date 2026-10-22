using System.Collections;
using System.Text.Json.Nodes;
using OutSystems.Model;

namespace Anvil.Core;

public sealed partial class ModelSession
{
    internal static object? UIProperty(object owner, string property)
    {
        // O11's V1 ComboBox.SourceEntity getter casts the singleton anonymous field's parent to a
        // named record. Its public AttributeType is the actual selected entity (also used by Verify).
        if(property=="SourceEntity" && Implements(owner,"IComboBoxWidget"))
        {
            var field=owner.GetType().GetProperty("SourceAttributeParent")?.GetValue(owner);
            return field?.GetType().GetProperty("AttributeType")?.GetValue(field);
        }
        return FindProperty(owner, property)?.GetValue(owner);
    }
    private static IObjectSignature[] UIObjects(object? value) => value is IEnumerable items ? items.Cast<object>().OfType<IObjectSignature>().ToArray() : [];
    private static IObjectSignature[] UIWidgets(object owner)
    {
        // Record widgets expose rows through a logical table collection; those rows are not physical
        // Children of the record widget. Read the same public collections used by their factories.
        // Signature.Widgets enumerates descendants; the mutable ISequence exposes direct children.
        var collections=AllProperties(owner).Where(p=>p.Name is "Widgets" or "Rows" or "Cells" && p.PropertyType.IsGenericType && p.PropertyType.Name.StartsWith("ISequence",StringComparison.Ordinal)).DistinctBy(p=>p.Name).ToArray();
        if(collections.Length>0)return collections.SelectMany(p=>UIObjects(p.GetValue(owner))).Where(w=>Implements(w,"OutSystems.Model.UI.IWidgetSignature")).Distinct().ToArray();
        return owner is IObjectSignature signature?signature.Children.OfType<IObjectSignature>().Where(w=>Implements(w,"OutSystems.Model.UI.IWidgetSignature")).ToArray():[];
    }
    private string UIRef(IObjectSignature node) { var reference = "@" + node.ObjectKey; _handles[reference] = node; return reference; }
    private static bool UIKind(object node, JsonObject shape) => (node as IObjectSignature)?.GetInterface()?.FullName == shape["type"]!.ToString();
    private static JsonObject UIShape(JsonObject declaration, string context) => ScreenSpecification.Shape(context, declaration["type"]!.ToString());
    private IObjectSignature? UINamed(string reference) { try { return Resolve(reference) as IObjectSignature; } catch (KeyNotFoundException) { return null; } }

    private void ValidatePublicBlockEvolution(JsonArray owners)
    {
        foreach(var declaration in owners.OfType<JsonObject>().Where(o=>o["type"]?.ToString().EndsWith("Block",StringComparison.Ordinal)==true))
        {
            var current=UINamed(ScreenSpecification.Reference(declaration));
            if(current==null || UIProperty(current,"Public") is not true)continue;
              var at=declaration["name"]!.ToString();
              if(declaration["properties"]?["Public"]?.GetValue<bool>()!=true)
                  throw new InvalidOperationException($"Public block {at}: removing public visibility requires an explicit consumer migration");
            void ParametersCompatible(IObjectSignature parent,IEnumerable<JsonObject> wanted,string owner,bool checkAdded)
            {
                var old=parent.Children.Where(p=>Implements(p,"IInputParameter")).ToArray();var next=wanted.ToArray();
                foreach(var p in old)
                {
                    var name=TypeResolver.Name(p);var same=next.SingleOrDefault(n=>n["name"]!.ToString()==name);
                      if(same==null || UiCatalog.TypeName(UIProperty(p,"DataType"))!=same["type"]!.ToString())
                          throw new InvalidOperationException($"Public block {at}: removing/changing {owner} input {name} requires an explicit consumer migration");
                      if(checkAdded && UIProperty(p,"IsMandatory") is not true && same["mandatory"]?.GetValue<bool>()==true)
                          throw new InvalidOperationException($"Public block {at}: making input {name} required needs an explicit consumer migration");
                }
                if(checkAdded)foreach(var added in next.Where(n=>n["mandatory"]?.GetValue<bool>()==true && old.All(p=>TypeResolver.Name(p)!=n["name"]!.ToString())))
                    throw new InvalidOperationException($"Public block {at}: new required input {added["name"]} would break existing consumers; give it a default or migrate consumers");
            }
            ParametersCompatible(current,ScreenSpecification.Objects(declaration,"inputs"),at,true);
            var events=ScreenSpecification.Objects(declaration,"blockEvents").ToArray();var previous=current.Children.OfType<IObjectSignature>().Where(e=>Implements(e,"IBlockEvent")).ToArray();
            foreach(var ev in previous)
            {
                var next=events.SingleOrDefault(e=>e["name"]!.ToString()==TypeResolver.Name(ev))??throw new InvalidOperationException($"Public block {at}: cannot remove event {TypeResolver.Name(ev)} without migrating consumers");
                  ParametersCompatible(ev,ScreenSpecification.Objects(next,"inputs"),TypeResolver.Name(ev)!,false);
                  if(UIProperty(ev,"IsMandatory") is not true && next["mandatory"]?.GetValue<bool>()==true)
                      throw new InvalidOperationException($"Public block {at}: making event {TypeResolver.Name(ev)} required needs a consumer migration");
                if(ScreenSpecification.Objects(next,"inputs").Count()!=ev.Children.Count(p=>Implements(p,"IInputParameter")))throw new InvalidOperationException($"Public block {at}: event payload changes require a consumer migration");
            }
            if(events.Any(e=>e["mandatory"]?.GetValue<bool>()==true && previous.All(p=>TypeResolver.Name(p)!=e["name"]!.ToString())))throw new InvalidOperationException($"Public block {at}: a new required event requires a consumer migration");
            var slots=new Dictionary<string,string>(StringComparer.Ordinal);
            void Collect(JsonArray widgets,string parent)
            {
                foreach(var widget in widgets.OfType<JsonObject>())
                {
                    var name=widget["name"]!.ToString();var path=parent+"/"+name;
                    if(widget["type"]!.ToString().EndsWith("IPlaceholderWidget",StringComparison.Ordinal))slots[name]=path;
                    if(widget["children"] is JsonArray children)Collect(children,path);
                    foreach(var slot in widget["slots"] as JsonObject??new JsonObject())Collect(slot.Value!.AsArray(),path+"/"+slot.Key);
                }
            }
            Collect(declaration["widgets"]!.AsArray(),"");
            void CheckSlots(IObjectSignature parent,string parentPath)
            {
                foreach(var widget in UIWidgets(parent))
                {
                    var name=TypeResolver.Name(widget);var path=parentPath+"/"+name;
                    if(Implements(widget,"IPlaceholderWidget"))
                    {
                        if(name==null || !slots.TryGetValue(name,out var wanted))throw new InvalidOperationException($"Public block {at}: cannot remove placeholder {name} without migrating consumers");
                        if(wanted!=path)throw new InvalidOperationException($"Public block {at}: moving placeholder {name} requires an explicit consumer migration; delete/create does not preserve its identity");
                    }
                    var shape=ScreenSpecification.Shape(ScreenSpecification.Context(declaration),widget.GetInterface().Name);
                    if(shape["children"]!.GetValue<bool>())CheckSlots(widget,path);
                    var source=UIProperty(widget,"SourceBlock") is IObjectSignature?new JsonObject{["source"]="present"}:new JsonObject();
                    foreach(var slot in UISlots(widget,shape,source))CheckSlots(slot.Value,path+"/"+slot.Key);
                }
            }
            CheckSlots(current,"");
        }
    }

    // The controller schedules structure before actions and event bindings after actions in the same transaction.
    private JsonNode ScreenTree(JsonObject data)
    {
        ScreenSpecification.Keys(data, ["owners", "phase"], "screen tree operation");
        var owners = data["owners"]!.AsArray(); ScreenSpecification.Validate(owners);
        var phase = data["phase"]?.ToString() ?? "structure";
        if (phase is not ("structure" or "bindings")) throw new ArgumentException("Unknown screen tree phase");
        var changed = 0; var deferredReferences = new List<Action>();
        var declaredNames = new List<(IObjectSignature Node, string Name)>();
        if (phase == "structure")
        {
            // All owners, inputs and events exist before widgets refer to another declared owner/block.
            foreach (var screen in owners.OfType<JsonObject>())
            {
                var context = ScreenSpecification.Context(screen); CheckUIRuntime(context);
                var reference = ScreenSpecification.Reference(screen); var shape = UIShape(screen, context);
                var owner = UINamed(reference);
                if (owner == null)
                {
                    var flowType = context == "mobile" ? "IMobileFlow" : "IWebFlow";
                    var flow = UINamed(flowType + ":" + screen["flow"]) ?? throw new ArgumentException("Screen flow does not exist: " + screen["flow"]);
                    owner = CreateUI(flow, shape["type"]!.ToString(), screen["name"]!.ToString());
                }
                if (TypeResolver.Name(owner.Parent!) != screen["flow"]!.ToString()) throw new ArgumentException("Screen belongs to another flow: " + reference);
                Configure(owner, screen);
                if (screen["roles"] is JsonArray roles) Assign(owner, "Roles", new JsonArray(roles.Select(r => (JsonNode)("IRole:" + r)).ToArray()));
                Parameters(owner, screen, "inputs", "IInputParameter"); Parameters(owner, screen, "vars", "ILocalVariable");
                var events = owner.Children.OfType<IObjectSignature>().Where(o => Implements(o, "IBlockEvent")).ToArray(); var retained = new HashSet<IObjectSignature>();
                foreach (var ev in ScreenSpecification.Objects(screen, "blockEvents"))
                {
                    var found = events.SingleOrDefault(e => TypeResolver.Name(e) == ev["name"]!.ToString()) ?? CreateUI(owner, "IBlockEvent", ev["name"]!.ToString());
                    retained.Add(found); Assign(found, "IsMandatory", ev["mandatory"] ?? JsonValue.Create(false)); Parameters(found, ev, "inputs", "IInputParameter", true);
                }
                foreach (var ev in events.Where(e => !retained.Contains(e))) Remove(ev);
            }
            foreach (var screen in owners.OfType<JsonObject>()) Queries(UINamed(ScreenSpecification.Reference(screen))!, screen);
            // A block's placeholders must exist before constructing its instances. Signatures above
            // are still declared together; only widget trees follow their block dependencies.
            foreach (var screen in ScreenSpecification.DefinitionOrder(owners)) Tree(UINamed(ScreenSpecification.Reference(screen))!, screen["widgets"]!.AsArray(), ScreenSpecification.Context(screen), false);
        }
        else foreach (var screen in owners.OfType<JsonObject>())
        {
            var owner = UINamed(ScreenSpecification.Reference(screen))!; var context = ScreenSpecification.Context(screen);
            Events(owner, screen, UIShape(screen, context)); SourceEvents(owner, screen); Tree(owner, screen["widgets"]!.AsArray(), context, true);
        }
        // Names are unique across the whole owner. Replacement subtrees may temporarily clash
        // with descendants of stale subtrees, so finalize names after deleting every stale tree.
        foreach(var (node,name) in declaredNames)if(TypeResolver.Name(node)!=name)Assign(node,"Name",JsonValue.Create(name));
        foreach (var assignReference in deferredReferences) assignReference();
        return new JsonObject { ["phase"] = phase, ["changes"] = changed };

        void Assign(IObjectSignature node, string property, JsonNode? value)
        {
            ApplyOne(new JsonObject { ["op"] = "set", ["target"] = UIRef(node), ["prop"] = property, ["value"] = value?.DeepClone() }); changed++;
        }
        void Remove(IObjectSignature node) { if (UIProperty(node,"WasDeleted") is true) return; ApplyOne(new JsonObject { ["op"] = "delete", ["target"] = UIRef(node), ["force"] = true }); changed++; }
        IObjectSignature CreateUI(IObjectSignature parent, string type, string name, string? source = null)
        {
            var alias = "$ui." + Guid.NewGuid().ToString("N");
            var op = new JsonObject { ["op"] = "create", ["parent"] = UIRef(parent), ["type"] = type, ["name"] = name, ["as"] = alias };
            if (source != null) { op["source"] = source; op["empty"] = true; }
            ApplyOne(op); changed++; var created = (IObjectSignature)Resolve(alias);
            if (FindProperty(created, "Name")?.CanWrite == true && TypeResolver.Name(created) != name) Assign(created, "Name", JsonValue.Create(name));
            return created;
        }
        void Configure(IObjectSignature node, JsonObject declaration)
        {
            foreach (var (property, value) in declaration["properties"]?.AsObject() ?? new JsonObject())
            {
                var field = FindProperty(node, property);
                if (field != null && typeof(IObjectSignature).IsAssignableFrom(field.PropertyType) && !typeof(IExpression).IsAssignableFrom(field.PropertyType))
                    deferredReferences.Add(() => Assign(node, property, value));
                else Assign(node, property, value);
            }
        }
        void Parameters(IObjectSignature parent, JsonObject declaration, string section, string type, bool eventInput = false)
        {
            var all = parent.Children.OfType<IObjectSignature>().Where(o => Implements(o, type)).ToArray(); var kept = new HashSet<IObjectSignature>();
            foreach (var parameter in ScreenSpecification.Objects(declaration, section))
            {
                var name = parameter["name"]!.ToString(); var existing = all.SingleOrDefault(o => TypeResolver.Name(o) == name) ?? CreateUI(parent, type, name);
                kept.Add(existing); Assign(existing, "DataType", parameter["type"]);
                if (!eventInput)
                {
                    if (section == "inputs") Assign(existing, "IsMandatory", parameter["mandatory"] ?? JsonValue.Create(false));
                    Assign(existing, "DefaultValue", parameter["default"] ?? JsonValue.Create(""));
                    if (parameter["description"] != null) Assign(existing, "Description", parameter["description"]);
                }
            }
            foreach (var stale in all.Where(o => !kept.Contains(o))) Remove(stale);
        }
        void Queries(IObjectSignature owner, JsonObject screen)
        {
            var existing = owner.Children.OfType<IObjectSignature>().Where(o => Implements(o, "IScreenAggregate")).ToArray(); var kept = new HashSet<IObjectSignature>();
            foreach (var declaration in ScreenSpecification.Objects(screen, "queries"))
            {
                var ops = LogicExpander.ExpandScreenQuery(declaration, UIRef(owner), candidates => candidates.FirstOrDefault(c => UINamed(c) != null));
                var found = existing.SingleOrDefault(q => TypeResolver.Name(q) == declaration["as"]!.ToString());
                if (found != null)
                {
                    // Preserve the aggregate identity consumed by refresh nodes and expressions.
                    var queryTypes = new[] { "IAliasedSource", "IJoin", "IFilter", "ISort", "IGroupByAttribute", ModelApiMetadata.AggregateColumnType, "ICalculatedAttribute" };
                    foreach (var child in found.GetAllDescendantsOfType<IObjectSignature>().Where(o => queryTypes.Any(t => Implements(o, t))).Reverse().ToArray()) Remove(child);
                    Register(ops[0]["as"]!.ToString(), found); Assign(found, "MaxRecords", JsonValue.Create("")); Assign(found, "StartIndex", JsonValue.Create("")); if ((UIProperty(found, "IsClientSide") as bool? ?? false) != (declaration["client"]?.GetValue<bool>() ?? false)) throw new ArgumentException("Cannot change client/server kind of an existing screen aggregate: " + declaration["as"]); ops.RemoveAt(0);
                }
                foreach (var op in ops) ApplyOne(op);
                found ??= UINamed(ScreenSpecification.Reference(screen) + "/" + declaration["as"])!; kept.Add(found);
            }
            foreach (var stale in existing.Where(q => !kept.Contains(q))) Remove(stale);
        }
        void SourceEvents(IObjectSignature owner, JsonObject screen)
        {
            var available = owner.Children.OfType<IObjectSignature>().Where(o => Implements(o, "IScreenAggregate") || Implements(o, "IDataAction")).ToArray();
            var bindings = screen["sourceEvents"] as JsonObject ?? new JsonObject();
            foreach (var name in bindings.Select(b => b.Key)) if (!available.Any(s => TypeResolver.Name(s) == name)) throw new ArgumentException("Unknown data source event owner: " + name);
            foreach (var source in available)
            {
                var eventName = TypeResolver.Name(source)!;
                Events(source, new JsonObject { ["events"] = bindings[eventName] == null ? new JsonObject() : new JsonObject { ["OnAfterFetch"] = bindings[eventName]!.DeepClone() } },
                    new JsonObject { ["events"] = new JsonObject { ["OnAfterFetch"] = "" } });
            }
        }
        void Tree(IObjectSignature parent, JsonArray declarations, string context, bool bindings)
        {
            var existing = UIWidgets(parent); var kept = new HashSet<IObjectSignature>();
            foreach (var widget in declarations.OfType<JsonObject>())
            {
                var shape = UIShape(widget, context); var named = shape["named"]!.GetValue<bool>();
                var candidates = existing.Where(w => UIProperty(w,"WasDeleted") is not true && !kept.Contains(w) && UIKind(w, shape) && (!named || TypeResolver.Name(w) == widget["name"]!.ToString())).ToArray();
                if (named && candidates.Length > 1) throw new ArgumentException("Ambiguous widget " + widget["name"]);
                var node = candidates.FirstOrDefault();
                if (node == null)
                {
                    if (bindings) throw new ArgumentException("Missing widget during event binding: " + widget["name"] + " under " + Describe(parent));
                    node = CreateUI(parent, shape["type"]!.ToString(), widget["name"]!.ToString(), widget["source"]?.ToString());
                }
                kept.Add(node);
                if (!bindings)
                {
                    Configure(node, widget);
                    if (widget["source"] != null) Assign(node, "SourceBlock", widget["source"]);
                    Arguments(node, widget["args"] as JsonObject ?? new JsonObject(),widget["source"] is { } source?UINamed(source.ToString()):null);
                    // Variable and SourceBlock setters may auto-name controls. Restore the authored
                    // names together, once names in obsolete subtrees have been released.
                    if(named)declaredNames.Add((node,widget["name"]!.ToString()));
                    var properties = UIObjects(UIProperty(node, "ExtendedProperties")); var attributes = widget["attributes"] as JsonObject ?? new JsonObject();
                    foreach (var property in properties) if (!attributes.ContainsKey(UIAttributeName(property))) Remove(property);
                    foreach (var (name, value) in attributes)
                    {
                        var property = properties.SingleOrDefault(p => UIAttributeName(p) == name) ?? CreateUI(node, "IExtendedProperty", name);
                        Assign(property, "Property", JsonValue.Create(name));
                        Assign(property, "Value", value);
                    }
                    ApplyOne(new JsonObject { ["op"] = "move", ["target"] = UIRef(node), ["last"] = true });
                }
                else Events(node, widget, shape);
                if (shape["children"]!.GetValue<bool>()) Tree(node, widget["children"] as JsonArray ?? new JsonArray(), context, bindings);
                var slots = UISlots(node, shape, widget);
                foreach (var (name, content) in slots) Tree(content, widget["slots"]?[name] as JsonArray ?? new JsonArray(), context, bindings);
                foreach (var slot in widget["slots"]?.AsObject() ?? new JsonObject()) if (!slots.ContainsKey(slot.Key)) throw new ArgumentException("Unknown source block placeholder: " + slot.Key);
            }
            if (!bindings) foreach (var stale in existing.Where(w => !kept.Contains(w))) Remove(stale);
        }
        void Arguments(IObjectSignature node, JsonObject values,IObjectSignature? signature)
        {
            // Changing the destination can leave arguments bound to the former action's parameters.
            // Remove those identities explicitly; clearing their values leaves UnusedArgument objects.
            var parameters=(signature?.Children.Where(p=>Implements(p,"IInputParameter") || Implements(p,"IInputParameterSignature"))??[]).Select(p=>p.GlobalKey?.ToString()).ToHashSet(StringComparer.Ordinal);
            foreach(var argument in node.Children.OfType<IObjectSignature>().Where(c=>Implements(c,"IArgument")).ToArray())
            {
                var parameter=argument.GetType().GetProperty("Parameter")?.GetValue(argument) as IObjectSignature;
                if(parameter==null || !parameters.Contains(parameter.GlobalKey?.ToString()))Remove(argument);
            }
            var arguments = UIObjects(UIProperty(node, "Arguments"));
            foreach (var key in values.Select(v => v.Key)) if (!arguments.Any(a => UIArgumentName(a) == key)) throw new ArgumentException("Unknown UI argument: " + key);
            foreach (var argument in arguments) Assign(argument, "Value", values[UIArgumentName(argument)] ?? JsonValue.Create(""));
        }
        void Events(IObjectSignature node, JsonObject declaration, JsonObject shape)
        {
            var declared = declaration["events"] as JsonObject ?? new JsonObject(); var available = UIEvents(node, shape);
            foreach (var name in declared.Select(e => e.Key)) if (!available.ContainsKey(name)) throw new ArgumentException("Unknown source block event: " + name);
            foreach (var (name, ev) in available)
            {
                var binding = declared[name] as JsonObject;
                Assign(ev, Implements(ev, "OutSystems.Model.UI.IEventHandler") ? "Handler" : "Destination", binding?["destination"]);
                if (binding != null)
                {
                    if (binding["method"] != null) Assign(ev, "Method", binding["method"]);
                    if (binding["transition"] != null) Assign(ev, "Transition", binding["transition"]);
                    if (binding.ContainsKey("validation"))
                    {
                        if(!UIValidationWritable(ev))throw new ArgumentException(name+" does not expose writable IBuiltinEvent.BuiltInValidations in the current native runtime");
                        Assign(ev,"BuiltInValidations",binding["validation"]);
                    }
                }
                Arguments(ev, binding?["args"] as JsonObject ?? new JsonObject(),binding?["destination"] is { } destination?UINamed(destination.ToString()):null);
            }
        }
    }
    private void CheckUIRuntime(string context)
    {
        var runtime = _espace.ESpaceType.ToString();
        if (context == "mobile" ? runtime is not ("CrossDevice" or "Mobile") : runtime is not ("WebResponsive" or "Web"))
            throw new ArgumentException("Screen context " + context + " is not supported by module kind " + runtime);
    }
    private static string UIAttributeName(IObjectSignature property) => UIProperty(property, "Property")?.ToString() ?? TypeResolver.Name(property) ?? "";
    private static string UIArgumentName(IObjectSignature argument) => ArgumentName(argument) ?? TypeResolver.Name(argument) ?? "";
    private static Dictionary<string, IObjectSignature> UISlots(IObjectSignature node, JsonObject shape, JsonObject declaration)
    {
        var result = new Dictionary<string, IObjectSignature>(StringComparer.Ordinal);
        foreach (var slot in shape["slots"]!.AsObject()) if (UIProperty(node, slot.Key) is IObjectSignature content) result.Add(slot.Key, content);
        if (declaration["source"] != null)
            foreach (var child in node.Children.OfType<IObjectSignature>().Where(c => Implements(c, "IPlaceholderContentWidgetSignature"))) result.Add(TypeResolver.Name(child)!, child);
        return result;
    }
    private static bool UIValidationWritable(IObjectSignature ev)
        =>Implements(ev,"OutSystems.Model.UI.Mobile.Events.IBuiltinEvent")
          && FindProperty(ev,"BuiltInValidations") is {CanRead:true,CanWrite:true} property
          && property.PropertyType.FullName=="OutSystems.Model.Enumerations.ValidationBehavior";
    private static Dictionary<string, IObjectSignature> UIEvents(IObjectSignature node, JsonObject shape)
    {
        var result = new Dictionary<string, IObjectSignature>(StringComparer.Ordinal);
        foreach (var ev in shape["events"]!.AsObject()) if (UIProperty(node, ev.Key) is IObjectSignature binding) result.Add(ev.Key, binding);
        foreach (var handler in node.Children.OfType<IObjectSignature>().Where(c => Implements(c, "OutSystems.Model.UI.IEventHandler")))
        {
            var name = UIProperty(handler, "Event") is IObjectSignature ev ? TypeResolver.Name(ev) : TypeResolver.Name(handler);
            if (!string.IsNullOrEmpty(name)) result.TryAdd(name, handler);
        }
        return result;
    }
}
