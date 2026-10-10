using System.Text.Json.Nodes;
using OutSystems.Model;
using OutSystems.Model.Types;

namespace Anvil.Core;

public sealed partial class ModelSession
{
    /// <summary>Walk the native UI tree and bindings against the frozen declaration; never read emitted operations.</summary>
    public JsonObject CheckScreenSpecification(JsonArray screens, JsonObject? expectedTypes = null)
    {
        ScreenSpecification.Validate(screens);
        var assertions = new JsonArray(); var differences = new JsonArray(); var summaries = new JsonArray();
        var types = expectedTypes?.DeepClone().AsObject() ?? new JsonObject();
        foreach (var screen in screens.OfType<JsonObject>())
        {
            var at = "screen/" + screen["name"]; var context = ScreenSpecification.Context(screen);
            try
            {
                CheckUIRuntime(context); var owner = UINamed(ScreenSpecification.Reference(screen));
                Equal(at, "exists", J(true), J(owner != null)); if (owner == null) continue;
                var shape = UIShape(screen, context); Equal(at, "kind", J(true), J(UIKind(owner, shape)));
                Equal(at, "owned", J(true), J(owner.Parent?.Parent == _es)); Equal(at, "flow", screen["flow"], J(TypeResolver.Name(owner.Parent!)));
                Equal(at, "IsDisabled", screen["properties"]?["IsDisabled"] ?? J(false), J(UIProperty(owner, "IsDisabled")));
                Properties(owner, screen, shape, at);
                if (screen["roles"] is JsonArray roles)
                {
                    var expected = roles.Select(r => (IObjectSignature)Resolve("IRole:" + r)).Select(r => r.GlobalKey!.ToString()!).Order();
                    Equal(at, "roles", Strings(expected), Strings(UIObjects(UIProperty(owner, "Roles")).Select(r => r.GlobalKey!.ToString()!).Order()));
                }
                Parameters(owner, screen, "inputs", "IInputParameter", at); Parameters(owner, screen, "vars", "ILocalVariable", at);
                var blockEvents = owner.Children.OfType<IObjectSignature>().Where(o => Implements(o, "IBlockEvent")).ToArray(); var events = ScreenSpecification.Objects(screen, "blockEvents").ToArray();
                Equal(at, "blockEvents", Strings(events.Select(e => e["name"]!.ToString()).Order()), Strings(blockEvents.Select(e => TypeResolver.Name(e)!).Order()));
                foreach (var ev in events)
                {
                    var found = blockEvents.SingleOrDefault(e => TypeResolver.Name(e) == ev["name"]!.ToString()); if (found == null) continue;
                    Equal(at + "/event/" + ev["name"], "mandatory", ev["mandatory"] ?? J(false), J(UIProperty(found, "IsMandatory")));
                    Parameters(found, ev, "inputs", "IInputParameter", at + "/event/" + ev["name"], true);
                }
                var queries = owner.Children.OfType<IObjectSignature>().Where(o => Implements(o, "IScreenAggregate")).ToArray(); var declaredQueries = ScreenSpecification.Objects(screen, "queries").ToArray();
                Equal(at, "queries", Strings(declaredQueries.Select(q => q["as"]!.ToString()).Order()), Strings(queries.Select(q => TypeResolver.Name(q)!).Order()));
                var queryChecks = new List<(IObjectSignature, JsonObject, string)>();
                foreach (var query in declaredQueries)
                {
                    var found = queries.SingleOrDefault(q => TypeResolver.Name(q) == query["as"]!.ToString()); if (found == null) continue;
                    var path = at + "/query/" + query["as"]; Equal(path, "IsClientSide", query["client"] ?? J(false), J(UIProperty(found, "IsClientSide")));
                    queryChecks.Add((found, ScreenSpecification.Query(query), path));
                }
                var queryProof = CheckLogicSpecification(new JsonObject { ["actions"] = new JsonArray() }, types, queryChecks);
                foreach (var item in queryProof["assertions"]!.AsArray()) assertions.Add(item!.DeepClone());
                foreach (var item in queryProof["differences"]!.AsArray()) differences.Add(item!.DeepClone());
                types = queryProof["expectedTypes"]!.DeepClone().AsObject();
                var dataSources = queries.Concat(owner.Children.OfType<IObjectSignature>().Where(o => Implements(o, "IDataAction"))).ToArray();
                foreach (var source in dataSources)
                {
                    var binding = screen["sourceEvents"]?[TypeResolver.Name(source)!];
                    Events(source, new JsonObject { ["events"] = binding == null ? new JsonObject() : new JsonObject { ["OnAfterFetch"] = binding.DeepClone() } },
                        new JsonObject { ["events"] = new JsonObject { ["OnAfterFetch"] = "" } }, at + "/source/" + TypeResolver.Name(source));
                }
                foreach (var name in screen["sourceEvents"]?.AsObject().Select(e => e.Key) ?? []) Equal(at + "/source/" + name, "exists", J(true), J(dataSources.Any(s => TypeResolver.Name(s) == name)));
                Events(owner, screen, shape, at);
                var widgets = new JsonArray(); Tree(owner, screen["widgets"]!.AsArray(), context, at, widgets);
                summaries.Add(new JsonObject { ["name"] = screen["name"]!.DeepClone(), ["type"] = screen["type"]!.DeepClone(), ["widgets"] = widgets, ["roles"] = screen["roles"]?.DeepClone() });
            }
            catch (Exception ex) { Equal(at, "readable", J(true), J(Errors.Text(ex))); }
        }
        return new JsonObject { ["accepted"] = differences.Count == 0, ["count"] = assertions.Count, ["assertions"] = assertions, ["differences"] = differences,
            ["screenSummary"] = summaries, ["expectedTypes"] = types, ["scope"] = "Native UI structure, declared properties, types, ordered widgets, roles and event/data bindings. Browser rendering and remote execution require separate acceptance." };
        void Equal(string at, string property, JsonNode? wanted, JsonNode? actual)
        {
            var item = new JsonObject { ["element"] = at, ["property"] = property, ["expected"] = wanted?.DeepClone() }; assertions.Add(item);
            if (!JsonNode.DeepEquals(wanted, actual)) { var difference = item.DeepClone().AsObject(); difference["actual"] = actual?.DeepClone(); differences.Add(difference); }
        }
        void Expression(string at, string property, string expected, IObjectSignature node)
            => Equal(at, property, J(ExpressionTokens(expected)), J(ExpressionTokens((UIProperty(node, property) as IExpression)?.Text ?? "")));
        void Reference(string at, string property, string? expected, IObjectSignature node)
        {
            var value = expected == null ? null : UINamed(expected);
            if (expected != null && value == null) { Equal(at, property, J(expected), J("unresolved reference")); return; }
            var key = at + "/reference/" + property;
            if (value != null && types[key] == null) types[key] = J(value.GlobalKey?.ToString());
            Equal(at, property, expected == null ? null : types[key], J((UIProperty(node, property) as IObjectSignature)?.GlobalKey?.ToString()));
        }
        void DataType(string at, string expected, IObjectSignature node)
        {
            var key = at + "/DataType"; if (types[key] == null) types[key] = SemanticTypes.Describe(_es, TypeResolver.Resolve(_es, expected));
            Equal(at, "DataType", types[key], UIProperty(node, "DataType") is ITypeSignature type ? SemanticTypes.Describe(_es, type) : null);
        }
        void Properties(IObjectSignature node, JsonObject declaration, JsonObject shape, string at)
        {
            foreach (var (property, value) in declaration["properties"]?.AsObject() ?? new JsonObject())
            {
                var kind = shape["properties"]![property]!["kind"]!.ToString();
                if (kind == "expression") Expression(at, property, value!.ToString(), node);
                else if (kind == "reference") Reference(at, property, value!.ToString(), node);
                // StyleSheet/JavaScript: o modelo guarda o que a formatacao escreveu (CodeFormat); o esperado passa pela mesma regra.
                else if (CodeFormat.LanguageOf(property, name => Implements(node, name)) is { } language && value is JsonValue code && code.TryGetValue<string>(out var text))
                    Equal(at, property, J(CodeFormat.Written(language, text)), J(UIProperty(node, property)));
                else Equal(at, property, value, kind == "enum" ? J(UIProperty(node, property)?.ToString()) : J(UIProperty(node, property)));
            }
        }
        void Parameters(IObjectSignature owner, JsonObject declaration, string section, string type, string at, bool eventInput = false)
        {
            var actual = owner.Children.OfType<IObjectSignature>().Where(o => Implements(o, type)).ToArray(); var expected = ScreenSpecification.Objects(declaration, section).ToArray();
            Equal(at + "/" + section, "names", Strings(expected.Select(p => p["name"]!.ToString()).Order()), Strings(actual.Select(p => TypeResolver.Name(p)!).Order()));
            foreach (var parameter in expected)
            {
                var path = at + "/" + section + "/" + parameter["name"]; var matches = actual.Where(p => TypeResolver.Name(p) == parameter["name"]!.ToString()).ToArray();
                Equal(path, "count", J(1), J(matches.Length)); if (matches.Length != 1) continue;
                var node = matches[0]; DataType(path, parameter["type"]!.ToString(), node);
                if (!eventInput)
                {
                    if (section == "inputs") Equal(path, "IsMandatory", parameter["mandatory"] ?? J(false), J(UIProperty(node, "IsMandatory")));
                    Expression(path, "DefaultValue", parameter["default"]?.ToString() ?? "", node);
                    if (parameter["description"] != null) Equal(path, "Description", parameter["description"], J(UIProperty(node, "Description")));
                }
            }
        }
        void Tree(IObjectSignature parent, JsonArray declarations, string context, string at, JsonArray summary)
        {
            var actual = UIWidgets(parent); Equal(at, "widgetCount", J(declarations.Count), J(actual.Length));
            for (var i = 0; i < Math.Min(actual.Length, declarations.Count); i++)
            {
                var declaration = declarations[i]!.AsObject(); var node = actual[i]; var path = at + "/" + declaration["name"]; var shape = UIShape(declaration, context);
                Equal(path, "kind", J(true), J(UIKind(node, shape)));
                if (shape["named"]!.GetValue<bool>()) Equal(path, "name", declaration["name"], J(TypeResolver.Name(node)));
                Properties(node, declaration, shape, path);
                if (declaration["source"] != null) Reference(path, "SourceBlock", declaration["source"]!.ToString(), node);
                Arguments(node, declaration["args"] as JsonObject ?? new JsonObject(), path);
                var attributes = UIObjects(UIProperty(node, "ExtendedProperties")); var declaredAttributes = declaration["attributes"] as JsonObject ?? new JsonObject();
                Equal(path, "attributes", Strings(declaredAttributes.Select(a => a.Key).Order()), Strings(attributes.Select(UIAttributeName).Order()));
                foreach (var (name, value) in declaredAttributes)
                {
                    var found = attributes.SingleOrDefault(a => UIAttributeName(a) == name); if (found != null) Expression(path + "/attribute/" + name, "Value", value!.ToString(), found);
                }
                Events(node, declaration, shape, path);
                if (shape["children"]!.GetValue<bool>()) Tree(node, declaration["children"] as JsonArray ?? new JsonArray(), context, path, summary);
                var slots = UISlots(node, shape, declaration);
                foreach (var (name, content) in slots) Tree(content, declaration["slots"]?[name] as JsonArray ?? new JsonArray(), context, path + "/slot/" + name, summary);
                foreach (var name in declaration["slots"]?.AsObject().Select(s => s.Key) ?? []) Equal(path + "/slot/" + name, "exists", J(true), J(slots.ContainsKey(name)));
                summary.Add(new JsonObject { ["path"] = path, ["type"] = declaration["type"]!.DeepClone(), ["source"] = declaration["source"]?.DeepClone() });
            }
        }
        void Arguments(IObjectSignature node, JsonObject declaration, string at)
        {
            var actual = UIObjects(UIProperty(node, "Arguments"));
            foreach (var argument in actual) Expression(at + "/arg/" + UIArgumentName(argument), "Value", declaration[UIArgumentName(argument)]?.ToString() ?? "", argument);
            foreach (var name in declaration.Select(a => a.Key)) Equal(at + "/arg/" + name, "count", J(1), J(actual.Count(a => UIArgumentName(a) == name)));
        }
        void Events(IObjectSignature node, JsonObject declaration, JsonObject shape, string at)
        {
            var actual = UIEvents(node, shape); var events = declaration["events"] as JsonObject ?? new JsonObject();
            foreach (var (name, ev) in actual)
            {
                var binding = events[name] as JsonObject; var path = at + "/event/" + name;
                Reference(path, Implements(ev, "OutSystems.Model.UI.IEventHandler") ? "Handler" : "Destination", binding?["destination"]?.ToString(), ev);
                foreach (var (key, property) in new[] { ("method", "Method"), ("transition", "Transition") })
                    if (binding?[key] != null) Equal(path, property, binding[key], J(UIProperty(ev, property)?.ToString()));
                if(binding?.ContainsKey("validation")==true)
                {
                    Equal(path,"validationSupported",J(true),J(UIValidationWritable(ev)));
                    Equal(path,"BuiltInValidations",binding["validation"],J(UIProperty(ev,"BuiltInValidations")?.ToString()));
                }
                Arguments(ev, binding?["args"] as JsonObject ?? new JsonObject(), path);
            }
            foreach (var name in events.Select(e => e.Key)) Equal(at + "/event/" + name, "exists", J(true), J(actual.ContainsKey(name)));
        }
        static JsonArray Strings(IEnumerable<string> values) => new(values.Select(v => (JsonNode)v).ToArray());
    }
}
