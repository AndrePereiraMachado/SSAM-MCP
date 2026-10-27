using System.Collections;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using OutSystems.Model;
using OutSystems.Model.Types;

namespace Anvil.Core;

public sealed partial class ModelSession
{
    /// <summary>Read signatures and the actual control-flow graph against declarations, independently of emitted ops.</summary>
    public JsonObject CheckLogicSpecification(JsonObject logic, JsonObject? expectedTypes = null, IEnumerable<(IObjectSignature Node, JsonObject Query, string Path)>? screenQueries = null)
    {
        var checks = new JsonArray(); var differences = new JsonArray(); var summaries = new JsonArray();
        var types = expectedTypes?.DeepClone().AsObject() ?? new JsonObject();
        var typeValues = new Dictionary<string, JsonObject>(StringComparer.OrdinalIgnoreCase);
        var actions = logic["actions"]!.AsArray().OfType<JsonObject>().ToArray();
        var queries = screenQueries?.ToArray() ?? [];
        // Screen queries also resolve symbols. Materialize once and avoid a whole-model scan only when both inputs are empty.
        var symbols = actions.Length == 0 && queries.Length == 0
            ? new Dictionary<string, IObjectSignature[]>(StringComparer.OrdinalIgnoreCase)
            : Descendants().Where(o => TypeResolver.Name(o) != null).GroupBy(o => TypeResolver.Name(o)!, StringComparer.OrdinalIgnoreCase)
                .ToDictionary(group => group.Key, group => group.ToArray(), StringComparer.OrdinalIgnoreCase);
        // The declarations as the compiler read them ('Long Text' is Text, a list record path without its type segment).
        try
        {
            actions = LogicExpander.Normalize(new JsonObject { ["actions"] = new JsonArray(actions.Select(a => a.DeepClone()).ToArray()) })["actions"]!
                .AsArray().OfType<JsonObject>().ToArray();
        }
        catch (Exception) { /* a malformed declaration is compared as written */ }
        foreach (var declaration in actions)
        {
            var name = declaration["name"]!.ToString(); var path = "action/" + name;
            try
            {
                var owner = (IObjectSignature)Resolve(LogicOrder.Owner(declaration)); var declaredKind = LogicOrder.ActionType(declaration);
                var matches = owner.Children.Where(o => ReferenceEquals(o.Parent, owner)
                    && (Implements(o, declaredKind) || LogicOrder.Owner(declaration) == "@espace" && (Implements(o, "IServerAction") || Implements(o, "IServiceAction") || Implements(o, "IClientAction")))
                    && (declaredKind == "IPreparation" || string.Equals(TypeResolver.Name(o), name, StringComparison.OrdinalIgnoreCase))).ToArray();
                Equal(path, "ownedActionCount", J(1), J(matches.Length)); if (matches.Length != 1) continue;
                var action = matches[0]; var kind = LogicOrder.ActionType(declaration);
                Equal(path, "kind", J(true), J(Implements(action, kind)));
                if (FindProperty(action, "Public") != null || declaration.ContainsKey("public"))
                    Equal(path, "Public", J(declaration["public"]?.GetValue<bool>() ?? kind == "IServiceAction"), J(P(action, "Public")));
                if (FindProperty(action, "Function") != null || declaration.ContainsKey("function"))
                    Equal(path, "Function", J(declaration["function"]?.GetValue<bool>() ?? false), J(P(action, "Function")));
                if (declaration["description"] != null) Equal(path, "Description", declaration["description"], J(P(action, "Description")));
                if (kind == "IDataAction")
                {
                    Equal(path, "Fetch", J(declaration["fetch"]?.ToString() ?? "AtStart"), J(P(action, "Fetch")?.ToString()));
                    if (declaration["timeout"] != null) Equal(path, "ServerRequestTimeout", declaration["timeout"], J(P(action, "ServerRequestTimeout")));
                }
                // C18: a record given as fields is a local of the compiler's (LogicExpander.RecordVariables), typed by its entity.
                var records = LogicExpander.RecordVariables(declaration);
                foreach (var (section, type) in new[] { ("inputs", "IInputParameter"), ("outputs", "IOutputParameter"), ("vars", "ILocalVariable") })
                {
                    var declared = declaration[section]?.AsArray().OfType<JsonObject>().ToArray() ?? [];
                    if (section == "vars") declared = [.. declared, .. records.Values.Select(r => new JsonObject { ["name"] = r.Variable, ["type"] = r.Entity })];
                    var actual = action.Children.OfType<IObjectSignature>().Where(o => Implements(o, type)).ToArray();
                    Equal(path + "/" + section, "names", Names(declared.Select(p => p["name"]!.ToString())), Names(actual.Select(o => TypeResolver.Name(o) ?? "")));
                    foreach (var parameter in declared)
                    {
                        var parameterPath = path + "/" + section + "/" + parameter["name"];
                        var found = actual.Where(o => TypeResolver.Name(o) == parameter["name"]!.ToString()).ToArray();
                        if (found.Length != 1) continue;
                        DataType(parameterPath, parameter["type"]!.ToString(), P(found[0], "DataType"));
                        if (section == "inputs") Equal(parameterPath, "IsMandatory", J(parameter["mandatory"]?.GetValue<bool>() ?? true), J(P(found[0], "IsMandatory")));
                        if (FindProperty(found[0], "DefaultValue") != null || parameter.ContainsKey("default")) Expression(parameterPath, "DefaultValue", parameter["default"]?.ToString() ?? "", found[0]);
                        if (parameter["description"] != null) Equal(parameterPath, "Description", parameter["description"], J(P(found[0], "Description")));
                    }
                }
                var graph = ExpectedGraph(declaration, records);
                var actualNodes = action.Children.OfType<IObjectSignature>().Where(o => Implements(o, "IFlowNode") && !Implements(o, "ICommentNode")).ToArray();
                var starts = actualNodes.Where(o => Implements(o, "IStartNode")).ToArray();
                Equal(path, "startCount", J(1), J(starts.Length));
                var bindings = new Dictionary<int, IObjectSignature>(); var used = new Dictionary<string, int>();
                var equivalentEnds = new HashSet<string>();
                if (starts.Length == 1) Visit(graph.Start, starts[0]);
                foreach (var handler in graph.Handlers)
                {
                    var matchesHandler = actualNodes.Where(n => Implements(n, "IExceptionHandlerNode") && TypeResolver.Name(n) == handler.Key).ToArray();
                    Equal(path + "/handler/" + handler.Key, "count", J(1), J(matchesHandler.Length));
                    if (matchesHandler.Length == 1) Visit(handler.Value, matchesHandler[0]);
                }
                foreach (var comment in declaration["comments"]?.AsArray().OfType<JsonObject>() ?? [])
                {
                    var matchesComment = action.Children.Where(n => Implements(n, "OutSystems.Model.Logic.Nodes.ICommentNode") && P(n, "Text")?.ToString() == comment["text"]!.ToString()).ToArray();
                    Equal(path + "/comment/" + comment["text"], "count", J(1), J(matchesComment.Length));
                    if (matchesComment.Length == 1) Equal(path + "/comment", "IsReminder", J(comment["reminder"]?.GetValue<bool>() ?? false), J(P(matchesComment[0], "IsReminder")));
                }
                Equal(path, "reachableNodeCount", J(graph.Nodes.Count), J(bindings.Count));
                Equal(path, "totalFlowNodeCount", J(graph.Nodes.Count + equivalentEnds.Count), J(actualNodes.Length));
                foreach (var unmatched in actualNodes.Where(node => !used.ContainsKey(node.ObjectKey!.ToString()!)))
                    differences.Add(new JsonObject { ["element"] = path, ["property"] = "unmatchedNode", ["actual"] = Get(unmatched) });
                Equal(path, "exceptionHandlers", J(graph.Handlers.Count), J(action.Children.Count(o => Implements(o, "IExceptionHandlerNode"))));
                summaries.Add(new JsonObject { ["name"] = name, ["kind"] = kind, ["nodes"] = actualNodes.Length, ["equivalentEndCopies"] = equivalentEnds.Count,
                    ["nodeKinds"] = new JsonArray(action.Children.Where(o => Implements(o, "IFlowNode")).Select(o => o.GetInterface()?.Name ?? "unknown").Distinct().Order().Select(n => (JsonNode)JsonValue.Create(n)!).ToArray()),
                    ["inputs"] = declaration["inputs"]?.AsArray().Count ?? 0, ["outputs"] = declaration["outputs"]?.AsArray().Count ?? 0 });

                void Visit(int id, IObjectSignature? node)
                {
                    var expected = graph.Nodes[id]; var at = path + "/" + expected.Path;
                    if (node == null) { Equal(at, "reachable", J(true), J(false)); return; }
                    var key = node.ObjectKey!.ToString()!;
                    if (bindings.TryGetValue(id, out var previous))
                    {
                        // Layout may split a shared action return into distinct
                        // Ends. Admit only an actual terminal reached through
                        // this declared terminal edge, never an arbitrary extra
                        // node or a different nonterminal reconvergence.
                        if (expected.Kind == "IEndNode" && previous.ObjectKey!.ToString() != key &&
                            Implements(previous, "OutSystems.Model.Logic.Nodes.IEndNode") &&
                            Implements(node, "OutSystems.Model.Logic.Nodes.IEndNode"))
                        {
                            if (used.TryGetValue(key, out var terminalOwner) && terminalOwner != id)
                            { Equal(at, "distinctStep", J(id), J(terminalOwner)); return; }
                            Equal(at, "IsDisabled", J(false), J(P(node, "IsDisabled")));
                            Equal(at, "terminalConnectorCount", J(0), J(Objects(P(node, "Connectors")).Length));
                            used[key] = id; equivalentEnds.Add(key);
                            return;
                        }
                        Equal(at, "joinTarget", J(previous.ObjectKey!.ToString()), J(key)); return;
                    }
                    if (used.TryGetValue(key, out var other)) { Equal(at, "distinctStep", J(id), J(other)); return; }
                    bindings[id] = node; used[key] = id;
                    Equal(at, "kind", J(true), J(expected.Kind == "IExecuteActionNode" ? Implements(node, "IExecuteServerActionNode") || Implements(node, "IExecuteClientActionNode") : Implements(node, expected.Kind)));
                    Equal(at, "IsDisabled", J(false), J(P(node, "IsDisabled")));
                    var step = expected.Step;
                    if (step != null)
                    {
                        var form = expected.Form;
                        if (step["as"] != null && (form != "node" || LogicNodes.Get(step).Named || step["node"]!.ToString() == "IMessageNode"))
                            Equal(at, "name", step["as"], J(P(node, form is "if" or "foreach" or "while" or "assign" or "switch" || step["node"]?.ToString() == "IMessageNode" ? "Label" : "Name")));
                        if (form == "if") Expression(at, "Condition", step["if"]!.ToString(), node);
                        else if (form == "while") Expression(at, "Condition", step["while"]!.ToString(), node);
                        else if (form == "foreach") { Expression(at, "RecordList", step["foreach"]!.ToString(), node); Expression(at, "StartIndex", step["start"]?.ToString() ?? "", node); Expression(at, "MaximumIterations", step["max"]?.ToString() ?? "", node); }
                        else if (form == "raise")
                        {
                            Reference(at, "Exception", step["raise"]!.ToString(), node, "IUserException", "IUserExceptionSignature");
                            Expression(at, "ExceptionMessage", step["message"]?.ToString() ?? "\"" + step["raise"] + "\"", node);
                        }
                        else if (form == "assign")
                        {
                            var assigned = Objects(P(node, "Assignments")); var wanted = step["assign"]!.AsObject().ToArray();
                            Equal(at, "assignmentCount", J(wanted.Length), J(assigned.Length));
                            for (var i = 0; i < Math.Min(wanted.Length, assigned.Length); i++)
                            { Expression(at + "/assignment/" + i, "Variable", wanted[i].Key, assigned[i]); Expression(at + "/assignment/" + i, "Value", wanted[i].Value!.ToString(), assigned[i]); }
                        }
                        else if (form == "get") Query(node, step, at);
                        else if (form == "switch")
                        {
                            var conditions = Objects(P(node, "Conditions")); var cases = step["switch"]!.AsArray();
                            Equal(at, "caseCount", J(cases.Count), J(conditions.Length));
                            for (var i = 0; i < Math.Min(cases.Count, conditions.Length); i++) Expression(at + "/case/" + i, "Value", cases[i]!["when"]!.ToString(), conditions[i]);
                        }
                        else if (form == "handler")
                        {
                            Reference(at, "Exception", step["exception"]!.ToString(), node, "IUserException", "IException");
                            Equal(at, "AbortTransaction", step["abortTransaction"], J(P(node, "AbortTransaction")));
                            Equal(at, "LogError", step["logError"], J(P(node, "LogError")));
                        }
                        else if (form == "node") NativeNode(node, step, at);

                        else if (form != "return")
                        {
                            var target = form == "call" ? step["call"]!.ToString() : (form == "save" ? "CreateOrUpdate" : char.ToUpperInvariant(form[0]) + form[1..]) + step[form];
                            if (form == "call" && !target.Contains(':') && !target.StartsWith('@') && !target.StartsWith('$')
                                && owner.Children.Any(o => string.Equals(TypeResolver.Name(o), target, StringComparison.OrdinalIgnoreCase)
                                    && (Implements(o, "OutSystems.Model.UI.Mobile.IScreenAction") || Implements(o, "OutSystems.Model.UI.Web.IScreenAction"))))
                                target = LogicOrder.Owner(declaration) + "/" + target;
                            var callee = Reference(at, "Action", target, node, [.. (LogicOrder.IsClient(declaration) ? new[] { "IClientAction", "IClientActionSignature" } : Array.Empty<string>()), "IServerAction", "IServiceAction", "IClientAction", "IServerActionSignature", "IEntityActionSignature", "IActionSignature", "IExtensionActionSignature"]);
                            var calleeKind = callee?.GetInterface()?.Name; var parentKind = callee?.Parent?.GetInterface()?.Name;
                            var mobileScreen = callee != null && Implements(callee, "OutSystems.Model.UI.Mobile.IScreenAction");
                            var webScreen = callee != null && Implements(callee, "OutSystems.Model.UI.Web.IScreenAction");
                            var clientExecution = mobileScreen || calleeKind is "IClientAction" or "IClientActionSignature" || parentKind is "IClientEntity" or "IClientEntitySignature";
                            if (mobileScreen || webScreen)
                                Equal(at, "callOwner", J(owner.ObjectKey?.ToString()), J((callee?.Parent as IObjectSignature)?.ObjectKey?.ToString()));
                            Equal(at, "executionKind", J(clientExecution ? "client" : "server"), J(Implements(node, "IExecuteClientActionNode") ? "client" : "server"));
                            var arguments = form == "call" ? step["args"]?.AsObject() ?? new JsonObject()
                                : new JsonObject { [form == "delete" ? "Id" : "Source"] = form != "delete" && records.TryGetValue(step, out var record)
                                    ? JsonValue.Create(record.Variable) : step[form == "delete" ? "id" : "record"]!.DeepClone() };
                            Arguments(node, arguments, at);
                        }
                    }
                    foreach (var edge in expected.Edges)
                    {
                        var target = edge.Key.StartsWith("case:", StringComparison.Ordinal)
                            ? Objects(P(node, "Conditions")).ElementAtOrDefault(int.Parse(edge.Key[5..])) is { } condition ? P(condition, "Target") as IObjectSignature : null
                            : P(node, edge.Key) as IObjectSignature;
                        Visit(edge.Value, target);
                    }
                }
            }
            catch (Exception ex) { differences.Add(new JsonObject { ["element"] = path, ["property"] = "inspection", ["actual"] = Errors.Text(ex) }); }
        }
        foreach (var (node, query, path) in queries)
        {
            try { Query(node, query, path); }
            catch (Exception ex) { differences.Add(new JsonObject { ["element"] = path, ["property"] = "query inspection", ["actual"] = Errors.Text(ex) }); }
        }
        return new JsonObject { ["accepted"] = differences.Count == 0, ["count"] = checks.Count, ["assertions"] = checks,
            ["differences"] = differences, ["expectedTypes"] = types, ["actionSummary"] = summaries,
            ["scope"] = "Declared action signatures, expressions, call targets and complete control-flow graph; not arbitrary business intent or remote runtime behavior." };

        void Equal(string path, string property, JsonNode? expected, JsonNode? actual)
        {
            var item = new JsonObject { ["element"] = path, ["property"] = property, ["expected"] = expected?.DeepClone() }; checks.Add(item);
            if (!JsonNode.DeepEquals(expected, actual)) { var difference = item.DeepClone().AsObject(); difference["actual"] = actual?.DeepClone(); differences.Add(difference); }
        }
        void Expression(string path, string property, string expected, IObjectSignature node)
            => Equal(path, property, J(ExpressionTokens(expected)), J(ExpressionTokens(ValueText(node, property))));
        // The Value of an assignment or argument with the record mapping O11 keeps beside it (IRecordMappings), read as the flow
        // reader writes it ("Source mapTo { Field: value, ... }"): the mapping is part of the value a declaration writes (ODC
        // keeps it in the expression's own text). The automatic conversion the Studio derives is no mapping and is not read.
        static string ValueText(IObjectSignature node, string property)
        {
            var text = (P(node, property) as IExpression)?.Text ?? "";
            if (property != "Value" || StudioAdapter.Runtime.Mappings is not { } mappings || !mappings.Owns(node)) return text;
            return mappings.Read(node) is { Authored: true, Fields.Count: > 0 } mapping ? Anvil.Reading.FlowMapping.Compose(text, mapping.Fields) ?? text : text;
        }
        void DataType(string path, string name, object? actual)
        {
            if (types[path] == null)
            {
                if (!typeValues.TryGetValue(name, out var value)) typeValues[name] = value = SemanticTypes.Describe(_es, TypeResolver.Resolve(_es, name));
                types[path] = value.DeepClone();
            }
            Equal(path, "DataType", types[path], actual is ITypeSignature type ? SemanticTypes.Describe(_es, type) : J("missing type"));
        }
        IObjectSignature? Reference(string path, string property, string target, IObjectSignature node, params string[] candidates)
        {
            object? resolved = null;
            if (target.Contains('/')) { try { resolved = Resolve(target); } catch (KeyNotFoundException) { } }
            foreach (var candidate in target.Contains(':') ? new[] { target } : candidates.Select(type => type + ":" + target))
            {
                if (resolved != null) break;
                var pieces = candidate.Split(':', 2);
                var named = pieces.Length == 2 ? symbols.GetValueOrDefault(pieces[1]) ?? [] : [];
                var matches = named.Where(o => Implements(o, pieces[0])).ToArray();
                if (matches.Length == 0) matches = named.Where(o => Implements(o, pieces[0] + "Signature")).ToArray();
                if (matches.Length > 1) throw new InvalidOperationException("Ambiguous contract reference " + candidate);
                if (matches.Length == 1) { resolved = matches[0]; break; }
            }
            var wanted = (resolved as IObjectSignature)?.ObjectKey?.ToString();
            Equal(path, property, J(wanted ?? "unresolved " + target), J((P(node, property) as IObjectSignature)?.ObjectKey?.ToString()));
            return resolved as IObjectSignature;
        }
        void Arguments(IObjectSignature node, JsonObject wanted, string at)
        {
            var actual = Objects(P(node, "Arguments"));
            foreach (var argument in actual)
            {
                var name = TypeResolver.Name(P(argument, "Parameter")!);
                Expression(at + "/arg/" + name, "Value", wanted[name ?? ""]?.ToString() ?? "", argument);
            }
            foreach (var name in wanted.Select(p => p.Key)) Equal(at, "argument " + name, J(1), J(actual.Count(a => TypeResolver.Name(P(a, "Parameter")!) == name)));
        }
        void NativeNode(IObjectSignature node, JsonObject step, string at)
        {
            var shape = LogicNodes.Get(step);
            foreach (var (key, value) in LogicNodes.Values(step))
            {
                var kind = shape.Fields[key].Kind;
                if (kind == "expression") Expression(at, key, value!.ToString(), node);
                else if (kind == "dataType") DataType(at + "/" + key, value!.ToString(), P(node, key));
                else if (kind == "reference") Reference(at, key, value!.ToString(), node);
                else if (kind == "enum") Equal(at, key, value, J(P(node, key)?.ToString()));
                else if (kind == "strings") Equal(at, key, Names(value!.AsArray().Select(x => x!.ToString())), Names((P(node, key) as IEnumerable)?.Cast<object>().Select(x => x.ToString()!) ?? []));
                // JavaScript do no: o modelo guarda o que a formatacao escreveu (CodeFormat); o esperado passa pela mesma regra.
                else if (CodeFormat.LanguageOf(key, name => Implements(node, name)) is { } language && value is JsonValue code && code.TryGetValue<string>(out var text))
                    Equal(at, key, J(CodeFormat.Written(language, text)), J(P(node, key) ?? ""));
                else Equal(at, key, value, J(P(node, key) ?? (kind == "text" ? "" : null)));
            }
            if (shape.Arguments) Arguments(node, step["args"]?.AsObject() ?? new JsonObject(), at);
            if (step["node"]!.ToString() != "IJavaScriptNode") return;
            foreach (var (section, property) in new[] { ("inputs", "InputParameters"), ("outputs", "OutputParameters") })
            {
                var actual = Objects(P(node, property)); var declared = step[section]?.AsArray().OfType<JsonObject>().ToArray() ?? [];
                Equal(at, property, Names(declared.Select(p => p["name"]!.ToString())), Names(actual.Select(p => TypeResolver.Name(p) ?? "")));
                foreach (var parameter in declared)
                {
                    var match = actual.SingleOrDefault(p => TypeResolver.Name(p) == parameter["name"]!.ToString()); if (match == null) continue;
                    var path = at + "/" + section + "/" + parameter["name"];
                    DataType(path, parameter["type"]!.ToString(), P(match, "DataType"));
                    if (section == "inputs") Equal(path, "IsMandatory", J(parameter["mandatory"]?.GetValue<bool>() ?? true), J(P(match, "IsMandatory")));
                    Expression(path, "DefaultValue", parameter["default"]?.ToString() ?? "", match);
                    Equal(path, "Description", J(parameter["description"]?.ToString() ?? ""), J(P(match, "Description") ?? ""));
                }
            }
        }
        void Query(IObjectSignature node, JsonObject step, string at)
        {
            Expression(at, "MaxRecords", step["max"]?.ToString() ?? "", node);
            if (step["sql"]?.GetValue<bool>() == true)
            {
                // O Statement guardado e o que a formatacao escreveu (CodeFormat): o esperado passa pela mesma regra.
                Equal(at, "Statement", J(CodeFormat.Written(CodeLanguage.Sql, step["statement"]!.ToString()).Replace("\r\n", "\n")), J(P(node, "Statement")?.ToString()?.Replace("\r\n", "\n")));
                var inputs = Objects(P(node, "InputParameters")); var declared = step["params"]?.AsObject() ?? new JsonObject();
                Equal(at, "parameterNames", Names(declared.Select(p => p.Key)), Names(inputs.Select(TypeResolver.Name)!));
                foreach (var parameter in inputs)
                {
                    var name = TypeResolver.Name(parameter)!;
                    if (declared[name] != null) DataType(at + "/sql/" + name, declared[name]!["type"]!.ToString(), P(parameter, "DataType"));
                    Equal(at + "/sql/" + name, "ExpandInline", J(false), J(P(parameter, "ExpandInline")));
                }
                Arguments(node, new JsonObject(declared.Select(p => KeyValuePair.Create(p.Key, p.Value!["value"]?.DeepClone()))), at);
                var outputs = Objects(P(node, "Outputs")); Equal(at, "outputCount", J(1), J(outputs.Length));
                if (outputs.Length == 1) { Equal(at, "outputName", J("List"), J(TypeResolver.Name(outputs[0]))); DataType(at + "/sql-output", step["get"]!.ToString(), P(outputs[0], "EntityOrStructure")); }
                return;
            }
            Expression(at, "StartIndex", step["start"]?.ToString() ?? "", node);
            var descendants = node.GetAllDescendantsOfType<IObjectSignature>().ToArray();
            var sources = descendants.Where(o => Implements(o, "OutSystems.Model.Logic.Aggregates.Database.IAliasedSource")).ToArray();
            // C18: a repeated entity is a self-join source named <Entity>2 (LogicExpander.SourceNames).
            var declaredSources = LogicExpander.SourceNames(new[] { step["get"]!.ToString() }.Concat(Many(step["sources"])));
            Equal(at, "sourceNames", Names(declaredSources.Select(s => s.Name)), Names(sources.Select(s => TypeResolver.Name(s) ?? "")));
            foreach (var (source, entity) in declaredSources)
            {
                var matched = sources.Where(s => TypeResolver.Name(s) == source).ToArray();
                if (matched.Length == 1) Reference(at + "/source/" + source, "Source", entity, matched[0], "IServerEntity", "IClientEntity", "IStaticEntity", "IEntitySignature");
            }
            var filters = descendants.Where(o => Implements(o, "IFilter")).ToArray(); var where = Many(step["where"]);
            Equal(at, "filters", Names(where.Select(ExpressionTokens)), Names(filters.Select(f => ExpressionTokens((P(f, "Condition") as IExpression)?.Text ?? ""))));
            // The keys as the compiler reads them (LogicExpander.SortKeys): one ISort per key, in order.
            var sorts = descendants.Where(o => Implements(o, "ISort")).ToArray();
            List<LogicExpander.SortKey> keys;
            try { keys = LogicExpander.SortKeys(step["sort"]); } catch (Exception) { keys = []; }
            Equal(at, "sortCount", J(keys.Count), J(sorts.Length));
            for (var k = 0; k < Math.Min(keys.Count, sorts.Length); k++)
            {
                var place = k == 0 ? at : at + "/sort/" + k;
                // A key the set wrote as the Studio writes it (AggregateSortRule: `IdentifierToLongInteger(X)` is X, `If(C, 0, 1)` is
                // C reversed) is required in that form.
                var normal = AggregateSortRule.Normalize(keys[k].Attribute);
                var attribute = normal is { Steps.Count: > 0 } ? normal.Attribute : keys[k].Attribute;
                var direction = normal is { Flip: true } ? AggregateSortRule.Reverse(keys[k].Direction) : keys[k].Direction;
                Expression(place, "Attribute", attribute, sorts[k]); Equal(place, "SortDirection", J(direction), J(P(sorts[k], "SortDirection")?.ToString())); Equal(place, "IsDynamic", J(false), J(P(sorts[k], "IsDynamic")));
            }
            var joins = descendants.Where(o => Implements(o, "IJoin")).ToArray(); var declaredJoins = step["joins"]?.AsArray().OfType<JsonObject>().ToArray() ?? [];
            Equal(at, "joinCount", J(declaredJoins.Length), J(joins.Length));
            for (var i = 0; i < Math.Min(joins.Length, declaredJoins.Length); i++)
            {
                var join = declaredJoins[i]; var location = at + "/join/" + i;
                // The Right join of two sources is written as the Left join with them swapped (LogicExpander.NativeJoin).
                var native = LogicExpander.NativeJoin(join["kind"]!.ToString(), declaredJoins.Length, declaredSources.Count);
                var swapped = native is { Swapped: true };
                Equal(location, "LeftSource", swapped ? join["right"] : join["left"], J(TypeResolver.Name(P(joins[i], "LeftSource")!)));
                Equal(location, "RightSource", swapped ? join["left"] : join["right"], J(TypeResolver.Name(P(joins[i], "RightSource")!)));
                Equal(location, "JoinType", J(native?.Kind ?? join["kind"]!.ToString()), J(P(joins[i], "JoinType")?.ToString())); Expression(location, "Condition", join["condition"]!.ToString(), joins[i]);
            }
            foreach (var (section, nativeKind) in new[] { ("columns", "IGroupByAttribute"), ("columns", ModelApiMetadata.AggregateColumnType), ("calculated", "ICalculatedAttribute") })
            {
                var declaredColumns = (step[section]?.AsArray().OfType<JsonObject>() ?? []).Where(c => section == "calculated" || (c["kind"]!.ToString() == "Group") == (nativeKind == "IGroupByAttribute")).ToArray();
                var actualColumns = descendants.Where(o => Implements(o, nativeKind)).ToArray();
                Equal(at, nativeKind, Names(declaredColumns.Select(c => c["name"]!.ToString())), Names(actualColumns.Select(c => TypeResolver.Name(c) ?? "")));
                foreach (var column in declaredColumns)
                {
                    var actual = actualColumns.SingleOrDefault(c => TypeResolver.Name(c) == column["name"]!.ToString()); if (actual == null) continue;
                    Expression(at + "/column/" + column["name"], section == "calculated" ? "Value" : "Attribute", column[section == "calculated" ? "value" : "attribute"]!.ToString(), actual);
                    if (nativeKind == ModelApiMetadata.AggregateColumnType) Equal(at + "/column/" + column["name"], "AggregationType", column["kind"], J(P(actual, "AggregationType")?.ToString()));
                }
            }
        }
    }
    private static object? P(object value, string property) => FindProperty(value, property)?.GetValue(value);
    private static IObjectSignature[] Objects(object? value) => value is IEnumerable sequence ? sequence.Cast<object>().OfType<IObjectSignature>().ToArray() : [];
    private static JsonNode? J(object? value) => value == null ? null : System.Text.Json.JsonSerializer.SerializeToNode(value);
    private static JsonArray Names(IEnumerable<string> names) => new(names.OrderBy(s => s, StringComparer.Ordinal).Select(s => (JsonNode)JsonValue.Create(s)!).ToArray());
    private static string[] Many(JsonNode? value) => value == null ? [] : value is JsonArray array ? array.Select(n => n!.ToString()).ToArray() : [value.ToString()];
    private static string ExpressionTokens(string text) => string.Join(" ", Regex.Matches(text, "\"(?:\"\"|[^\"])*\"|[A-Za-z_][A-Za-z0-9_]*|[0-9]+(?:\\.[0-9]+)?|<>|<=|>=|[^\\s]").Select(m => m.Value.StartsWith('"') ? m.Value : m.Value.ToLowerInvariant()));
    private sealed record ExpectedNode(string Kind, string Path, string Form, JsonObject? Step, Dictionary<string, int> Edges);
    private static (int Start, Dictionary<int, ExpectedNode> Nodes, Dictionary<string, int> Handlers) ExpectedGraph(JsonObject action,
        IReadOnlyDictionary<JsonObject, (string Variable, string Entity)>? records = null)
    {
        var nodes = new Dictionary<int, ExpectedNode>(); var sequence = 0;
        int New(string kind, string path, string form = "", JsonObject? step = null) { var id = sequence++; nodes[id] = new(kind, path, form, step, new()); return id; }
        var end = New("IEndNode", "end");
        int Segment(JsonArray? body, int next, string path, int? breakTarget = null, int? continueTarget = null)
        {
            if (body == null) return next;
            for (var index = body.Count - 1; index >= 0; index--)
            {
                var step = body[index]!.AsObject(); var form = new[] { "get", "assign", "call", "save", "create", "update", "delete", "if", "foreach", "while", "break", "continue", "return", "raise", "switch", "node" }.Single(step.ContainsKey);
                if (form is "break" or "continue")
                {
                    next = (form == "break" ? breakTarget : continueTarget) ?? throw new ArgumentException(form + " requires an enclosing loop");
                    continue;
                }
                var kind = form switch { "get" => step["sql"]?.GetValue<bool>() == true ? "ISQLNode" : "IAggregateNode", "assign" => "IAssignNode", "if" or "while" => "IIfNode", "foreach" => "IForEachNode", "return" => "IEndNode", "raise" => "IRaiseExceptionNode", "call" => "IExecuteActionNode", "switch" => "ISwitchNode", "node" => step["node"]!.ToString(), _ => "IExecuteActionNode" };
                var at = path + "/" + index; var id = New(kind, at, form, step); var edges = nodes[id].Edges;
                if (form == "if") { edges["TrueTarget"] = Segment(step["then"]?.AsArray(), next, at + "/then", breakTarget, continueTarget); edges["FalseTarget"] = Segment(step["else"]?.AsArray(), next, at + "/else", breakTarget, continueTarget); }
                else if (form == "foreach") { edges["CycleTarget"] = Segment(step["do"]!.AsArray(), id, at + "/do", next, id); edges["Target"] = next; }
                else if (form == "while")
                {
                    var update = Segment(step["next"]?.AsArray(), id, at + "/next", breakTarget, continueTarget);
                    edges["TrueTarget"] = Segment(step["do"]!.AsArray(), update, at + "/do", next, update);
                    edges["FalseTarget"] = next;
                }
                else if (form == "switch")
                {
                    var cases = step["switch"]!.AsArray();
                    for (var i = 0; i < cases.Count; i++) edges["case:" + i] = Segment(cases[i]!["steps"]!.AsArray(), next, at + "/case/" + i, next, continueTarget);
                    edges["OtherwiseTarget"] = Segment(step["otherwise"]?.AsArray(), next, at + "/otherwise", next, continueTarget);
                }
                else if (form is not ("raise" or "return") && !(form == "node" && LogicNodes.Get(step).Terminal)) edges["Target"] = next;
                next = id;
                // C18: the Assign that fills a record given as fields comes right before its entity action.
                if (records != null && records.TryGetValue(step, out var record) && step["record"] is JsonObject fields)
                {
                    var assign = new JsonObject { ["assign"] = new JsonObject(fields.Select(f => KeyValuePair.Create(record.Variable + "." + f.Key, f.Value?.DeepClone()))) };
                    var head = New("IAssignNode", at + "/record", "assign", assign);
                    nodes[head].Edges["Target"] = id;
                    next = head;
                }
            }
            return next;
        }
        var target = Segment(action["steps"]!.AsArray(), end, "steps"); var start = New("IStartNode", "start"); nodes[start].Edges["Target"] = target;
        var handlers = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var handler in action["handlers"]?.AsArray().OfType<JsonObject>() ?? [])
        {
            var name = handler["name"]!.ToString(); var id = New("IExceptionHandlerNode", "handler/" + name, "handler", handler); handlers.Add(name, id);
            nodes[id].Edges["Target"] = Segment(handler["steps"]!.AsArray(), New("IEndNode", "handler/" + name + "/end"), "handler/" + name + "/steps");
        }
        var reachable = new HashSet<int>(); void Walk(int id) { if (reachable.Add(id)) foreach (var edge in nodes[id].Edges.Values) Walk(edge); } Walk(start); foreach (var id in handlers.Values) Walk(id);
        if (nodes.Any(pair => pair.Value.Kind != "IEndNode" && !reachable.Contains(pair.Key))) throw new ArgumentException("Action contract contains unreachable steps");
        return (start, nodes.Where(pair => reachable.Contains(pair.Key)).ToDictionary(pair => pair.Key, pair => pair.Value), handlers);
    }
}
