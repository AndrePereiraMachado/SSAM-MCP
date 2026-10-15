using System.Text.Json.Nodes;

namespace Anvil.Core;

/// <summary>
/// The events of the capture as native logic (docs/PROTOTIPO-NATIVO.md 3.4): pure navigation is the OnClick of the widget (no
/// action); any other event is a screen action of its owner, named verb + object (N1), with the effects of table 3.4 in order:
/// Assign for dimensions, popups and toasts (one Assign each, L4), Refresh Data of the aggregates the event changes, the
/// Destination at the end; every event that changes data calls exactly one server action (S2), built once per event with entity
/// actions for single-record effects, one portable parameterized Advanced SQL per set effect (PrototypeSql) and a User Exception
/// with the exact message per validation (caught by a handler of the screen action that writes it where the prototype shows it).
/// A state-dependent event is an If over the predicate that separates its cases. Never JavaScript, JSON, Visible or ForEach, and
/// no server call in a lifecycle event (OnInitialize only assigns).
/// </summary>
internal sealed class PrototypeLogic
{
    private readonly PrototypePlanner _p;
    private readonly PrototypeCapture _ir;
    private readonly Dictionary<string, ServerAction> _server = new(StringComparer.Ordinal);
    private readonly HashSet<string> _serverNames = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, (string Type, string? Collection)> _controlTypes = new(StringComparer.Ordinal);
    private readonly JsonObject _byEffect = new();
    private readonly JsonArray _notCompiled = [];
    private readonly JsonArray _targetGuarded = [];
    /// <summary>The events compiled somewhere (an event of the shell compiles once per screen; it counts once).</summary>
    private readonly HashSet<string> _compiled = new(StringComparer.Ordinal);
    private readonly JsonArray _untriggered = [];

    /// <summary>The event keys some node of the owner's trees names (its view or modal, its popups, the shell regions).</summary>
    private HashSet<string> Triggered(PrototypeOwner owner)
    {
        var keys = new HashSet<string>(StringComparer.Ordinal);
        void Add(JsonNode? tree) { foreach (var k in PrototypeCapture.EventsOf(tree)) keys.Add(k); }
        if (owner.Kind == "screen")
        {
            Add(_ir.View(owner.View!)?["root"]);
            foreach (var popup in owner.Popups.Values.Where(p => p.Block == null)) Add(_ir.Modal(popup.Modal)?["root"]);
        }
        else if (owner.Modal != null) Add(_ir.Modal(owner.Modal)?["root"]);
        else if (_ir.Shell != null)
        {
            Add(_ir.Shell["root"]);
            foreach (var n in PrototypeCapture.Objects(_ir.Shell["after"])) Add(n);
            foreach (var e in PrototypeCapture.Objects(_ir.Shell["events"])) if (e["from"]?.ToString() is { } from) keys.Add(from);
        }
        // a form's submit is run by its submit button; a close-modal of a popup by its buttons
        return keys;
    }
    private int _sql;
    private int _screenActions;

    internal sealed class ServerAction
    {
        public required string Name { get; init; }
        public required string EventKey { get; init; }
        public List<(string Name, string Type, JsonNode Source)> Inputs { get; } = [];
        public List<(string Name, string Type)> Outputs { get; } = [];
        public Dictionary<string, string> Inserted { get; } = new(StringComparer.Ordinal);
        public Dictionary<string, string> Updated { get; } = new(StringComparer.Ordinal);
        public HashSet<string> Writes { get; } = new(StringComparer.Ordinal);
        public bool Raises { get; set; }
        public JsonObject Declaration { get; set; } = new();
        public string Ref => (Existing ? "" : "") + Name;
        public bool Existing { get; set; }
        public List<JsonObject> Vars { get; } = [];
        public string? Mapped { get; set; }
        private readonly HashSet<string> _nodes = new(StringComparer.OrdinalIgnoreCase);
        /// <summary>A node name unique in the action (the second Update of a record in another branch is ...2).</summary>
        public string Node(string wanted)
        {
            var name = wanted;
            for (var n = 2; !_nodes.Add(name); n++) name = wanted + n;
            return name;
        }
    }

    public PrototypeLogic(PrototypePlanner planner)
    {
        _p = planner; _ir = planner.Capture;
        foreach (var e in PrototypeCapture.Effects) _byEffect[e] = 0;
    }

    private string Verb(string effect) => PrototypeNames.Verb(effect, _p.Pt);

    public void Compile()
    {
        ControlTypes();
        foreach (var e in _ir.Events)
        {
            var key = e["key"]!.ToString();
            foreach (var effect in PrototypePlanner.Effects(e)) _byEffect[effect["kind"]!.ToString()] = _byEffect[effect["kind"]!.ToString()]!.GetValue<int>() + 1;
            if (Mapped(e) is { } existing) { _server[key] = new ServerAction { Name = existing, EventKey = key, Mapped = existing }; continue; }
            if (PrototypePlanner.Effects(e).Any(x => PrototypeCapture.DataEffects.Contains(x["kind"]!.ToString())))
                _server[key] = Server(e);
        }
        foreach (var owner in _p.Owners) Owner(owner);
        // the listeners the capture excluded by their target guard (the click on a modal's backdrop, 2.4)
        foreach (var guarded in PrototypeCapture.Objects(_ir.Json["targetGuarded"])) _targetGuarded.Add(guarded.DeepClone());
        _p.PlanResult.Report["events"] = new JsonObject
        {
            ["total"] = _ir.Events.Count, ["compiled"] = _compiled.Count, ["byEffect"] = _byEffect.DeepClone(),
            ["notCompiled"] = _notCompiled, ["targetGuarded"] = _targetGuarded, ["untriggered"] = _untriggered,
        };
        _p.PlanResult.Report["logic"] = new JsonObject { ["serverActions"] = _server.Values.Count(s => s.Mapped == null), ["sql"] = _sql, ["screenActions"] = _screenActions };
    }

    /// <summary>mapping.events binds an event to an existing action instead of the inferred one ("checkout-form:submit").</summary>
    private string? Mapped(JsonObject e)
    {
        if (_ir.Mapping["events"] is not JsonObject events) return null;
        var key = e["key"]!.ToString();
        var parts = key.Split(':');
        var shortKey = parts.Length >= 3 ? parts[^1] + ":" + parts[^2] : key;
        foreach (var (name, value) in events)
            if (name == key || name == shortKey) return value?["action"]?.ToString();
        return null;
    }

    private void ControlTypes()
    {
        void Walk(JsonObject? n, string? collection)
        {
            if (n == null) return;
            if (n["control"] is JsonObject control)
            {
                if (control["field"]?.ToString() is { } field && collection != null)
                    _controlTypes[field] = (_p.Data.ByCollection(collection) is { } entity && entity.Fields.FirstOrDefault(x => x.Name == field) is { } f
                        ? _p.Data.FieldDataType(entity, f) : _p.FieldType(collection, field) ?? "Text", collection);
                else if (control["var"]?.ToString() is { } v)
                    _controlTypes[v] = (control["dimension"]?.ToString() is { } d ? _p.DimType(d) : control["kind"]?.ToString() == "checkbox" ? "Boolean" : "Text", null);
            }
            foreach (var c in n["c"] as JsonArray ?? []) Walk(c as JsonObject, collection);
            Walk(n["list"]?["template"] as JsonObject, n["list"]?["collection"]?.ToString() ?? collection);
        }
        foreach (var v in _ir.Views) Walk(v["root"] as JsonObject, null);
        foreach (var m in _ir.Modals) Walk(m["root"] as JsonObject, m["record"]?["collection"]?.ToString());
        if (_ir.Shell != null) Walk(_ir.Shell["root"] as JsonObject, null);
    }

    // ---- server actions -------------------------------------------------------------------------------------------------------

    private static IEnumerable<(JsonObject? When, JsonArray Effects)> Branches(JsonObject e)
    {
        foreach (var c in e["cases"] as JsonArray ?? []) if (c is JsonObject co) yield return (co["when"] as JsonObject, co["effects"] as JsonArray ?? []);
        yield return (null, e["effects"] as JsonArray ?? []);
    }

    private static bool HasData(JsonArray effects) => effects.OfType<JsonObject>().Any(x => PrototypeCapture.DataEffects.Contains(x["kind"]!.ToString()));

    private ServerAction Server(JsonObject e)
    {
        var key = e["key"]!.ToString();
        var first = PrototypePlanner.Effects(e).First(x => PrototypeCapture.DataEffects.Contains(x["kind"]!.ToString()));
        var obj = ObjectOf(first);
        var wanted = Verb(first["kind"]!.ToString()) + obj;
        if (_serverNames.Contains(wanted)) wanted += PrototypeNames.Pascal(key.Split(':').Last());
        var name = _p.Name("action", wanted, "server action");
        for (var n = 2; !_serverNames.Add(name); n++) name = _p.Name("action", wanted + n, "server action");
        var sa = new ServerAction { Name = name, EventKey = key, Existing = _p.Existing("action", name) != null };
        var scope = ServerScope(sa, e);
        var steps = new JsonArray();
        var dataBranches = Branches(e).Where(b => HasData(b.Effects)).ToList();
        if (dataBranches.Count == 1 && dataBranches[0].When == null || dataBranches.Count == 1)
            foreach (var step in DataSteps(sa, dataBranches[0].Effects, scope)) steps.Add(step);
        else
        {
            // several branches change data: the same If inside the server action, one call from the screen (S2)
            JsonArray? tail = null;
            JsonObject? root = null; JsonObject? current = null;
            foreach (var (when, effects) in Branches(e))
            {
                var data = new JsonArray(DataSteps(sa, effects, scope).Select(s => (JsonNode)s).ToArray());
                if (when == null) { if (current != null) current["else"] = data; else tail = data; break; }
                var branch = new JsonObject { ["if"] = PrototypeExpr.Pred(when, scope), ["label"] = Question(when), ["then"] = data };
                if (current == null) root = branch; else current["else"] = new JsonArray(branch);
                current = branch;
            }
            if (root != null) steps.Add(root);
            else if (tail != null) foreach (var s in tail) steps.Add(s!.DeepClone());
        }
        var description = $"Effects of the prototype event {key} (handler {e["handler"]}): {string.Join(", ", PrototypePlanner.Effects(e).Select(x => x["kind"]!.ToString()).Distinct())}.";
        sa.Declaration = new JsonObject
        {
            ["name"] = name, ["kind"] = "server", ["description"] = _p.Describe(description),
            ["inputs"] = new JsonArray(sa.Inputs.Select(i => (JsonNode)new JsonObject { ["name"] = i.Name, ["type"] = i.Type }).ToArray()),
            ["outputs"] = new JsonArray(sa.Outputs.Select(o => (JsonNode)new JsonObject { ["name"] = o.Name, ["type"] = o.Type }).ToArray()),
            ["vars"] = new JsonArray(sa.Vars.Select(v => (JsonNode)v.DeepClone()).ToArray()),
            ["steps"] = steps,
        };
        if (sa.Existing) sa.Declaration["replace"] = true;
        return sa;
    }

    private string ObjectOf(JsonObject effect)
    {
        var kind = effect["kind"]!.ToString();
        // the object of an action name is the record's singular in PascalCase (AlternarFavorito, not Alternarfavoritos)
        var raw = effect["collection"]?.ToString() ?? effect["target"]?.ToString() ?? "";
        var collection = raw.Length > 0 ? PrototypeNames.EntityStem(raw) : "";
        return kind switch
        {
            "toggle" or "increment" => collection + effect["field"],
            "navigate" => _p.PlanResult.Screens.GetValueOrDefault(effect["view"]?.ToString() ?? "") ?? "Tela",
            "openPopup" or "closePopup" => _ir.Modal(effect["modal"]?.ToString() ?? "")?["name"]?.ToString() ?? "Popup",
            "setDimension" => _ir.Dimension(effect["dimension"]?.ToString() ?? "")?["name"]?.ToString() ?? "Valor",
            "toast" => _p.Pt ? "Aviso" : "Notice",
            "validate" => _p.Pt ? "Formulario" : "Form",
            "call" => effect["action"]?.ToString() ?? "Acao",
            _ => collection,
        };
    }

    private string Question(JsonObject when) => _p.Pt ? "Condicao?" : "Condition?";

    /// <summary>The scope of a server action: every value it cannot read itself becomes an input, typed, with the value the
    /// caller passes (translated later in the caller's scope).</summary>
    private PrototypeScope ServerScope(ServerAction sa, JsonObject e, Func<string, string?, string>? field = null)
    {
        string Input(string name, string type, JsonNode source)
        {
            if (!sa.Inputs.Any(i => i.Name == name)) sa.Inputs.Add((name, type, source));
            return name;
        }
        var parameters = PrototypeCapture.Objects(e["params"]);
        return new PrototypeScope
        {
            Param = name => Input(name, parameters.FirstOrDefault(p => p["name"]?.ToString() == name)?["type"]?.ToString() ?? "Integer", new JsonObject { ["param"] = name }),
            ParamType = name => parameters.FirstOrDefault(p => p["name"]?.ToString() == name)?["type"]?.ToString() ?? "Integer",
            Dim = key => Input(_ir.Dimension(key)?["name"]?.ToString() ?? PrototypeNames.Pascal(key), _p.DimType(key), new JsonObject { ["dim"] = key }),
            DimType = key => _p.DimType(key),
            Control = name => Input(name, _controlTypes.TryGetValue(name, out var t) ? NativeControlType(t) : "Text", new JsonObject { ["control"] = name }),
            ControlType = name => _controlTypes.TryGetValue(name, out var t) ? t.Type : "Text",
            Field = field ?? ((f, via) => Input(f, FieldInputType(e, f), new JsonObject { ["field"] = f })),
            // in the server action a record field is the input that carries it: an identifier input, or an Integer key
            FieldType = (f, via) => FieldInputType(e, f) is var t && t.EndsWith(" Identifier", StringComparison.Ordinal) ? "Identifier" : FieldInputTypeRaw(e, f) == "Identifier" ? "Integer" : FieldInputTypeRaw(e, f),
            Inserted = collection => collection + "Id",
            Record = (record, f, via) => Input(f, FieldInputType(e, f), new JsonObject { ["record"] = record, ["field"] = f }),
            RecordType = (record, f, via) => FieldInputType(e, f) is var rt && rt.EndsWith(" Identifier", StringComparison.Ordinal) ? "Identifier" : FieldInputTypeRaw(e, f) == "Identifier" ? "Integer" : FieldInputTypeRaw(e, f),
            Input = name => Input(name, name == "View" ? "Text" : "Text", new JsonObject { ["input"] = name }),
        };
    }

    private string NativeControlType((string Type, string? Collection) t) => t.Type switch { "DateTime" => "Date Time", var x => x };

    private string? FieldInputTypeRaw(JsonObject e, string field)
    {
        var collection = e["modal"]?.ToString() is { } m ? _ir.Modal(m)?["record"]?["collection"]?.ToString() : null;
        return collection != null ? _p.FieldType(collection, field) : null;
    }

    private string FieldInputType(JsonObject e, string field)
    {
        var raw = FieldInputTypeRaw(e, field);
        if (raw == null) return "Integer";
        var collection = _ir.Modal(e["modal"]!.ToString())!["record"]!["collection"]!.ToString();
        var entity = _p.Data.ByCollection(collection);
        var f = entity?.Fields.FirstOrDefault(x => x.Name == field);
        return entity != null && f != null ? _p.Data.FieldDataType(entity, f) : PrototypeDataModel.NativeType(raw);
    }

    private IEnumerable<JsonObject> DataSteps(ServerAction sa, JsonArray effects, PrototypeScope scope)
    {
        foreach (var effect in effects.OfType<JsonObject>())
        {
            var kind = effect["kind"]!.ToString();
            switch (kind)
            {
                case "validate":
                    foreach (var step in Validate(sa, effect, scope)) yield return step;
                    break;
                case "toggle" when effect["keys"] is JsonObject && effect["field"] == null:
                    foreach (var step in ToggleMember(sa, effect, scope)) yield return step;
                    break;
                case "toggle":
                case "increment":
                case "update":
                    foreach (var step in Update(sa, effect, scope, kind)) yield return step;
                    break;
                case "remove":
                {
                    var c = effect["collection"]!.ToString();
                    sa.Writes.Add(c);
                    yield return new JsonObject { ["delete"] = _p.EntityName(c), ["as"] = sa.Node((_p.Pt ? "Remover" : "Remove") + c), ["id"] = IdArgument(effect["key"], scope) };
                    break;
                }
                case "insert":
                    foreach (var step in Insert(sa, effect, scope)) yield return step;
                    break;
                case "upsert":
                    foreach (var step in Upsert(sa, effect, scope)) yield return step;
                    break;
                case "insertFrom":
                case "updateFrom":
                case "removeWhere":
                {
                    var sql = PrototypeSql.Statement(_p, effect, scope, sa.Inserted);
                    sa.Writes.Add(effect["target"]!.ToString());
                    _sql++;
                    var parameters = new JsonObject();
                    foreach (var (name, (type, value)) in sql.Parameters) parameters[name] = new JsonObject { ["type"] = type, ["value"] = value };
                    yield return new JsonObject { ["get"] = _p.EntityName(effect["target"]!.ToString()), ["sql"] = true, ["as"] = sql.Name, ["statement"] = sql.Text, ["params"] = parameters };
                    break;
                }
            }
        }
    }

    private IEnumerable<JsonObject> Validate(ServerAction sa, JsonObject effect, PrototypeScope scope)
    {
        foreach (var rule in PrototypeCapture.Objects(effect["rules"]))
        {
            sa.Raises = true;
            var label = (rule["control"]?.ToString() ?? (_p.Pt ? "Valor" : "Value")) + (_p.Pt ? " invalido?" : " invalid?");
            yield return new JsonObject
            {
                ["if"] = PrototypeExpr.Pred(rule["when"], scope), ["label"] = label,
                ["then"] = new JsonArray(new JsonObject { ["raise"] = _p.ExceptionName, ["message"] = PrototypeExpr.Quote(rule["message"]?.ToString() ?? "") }),
            };
        }
    }

    private string RecordVar(ServerAction sa, string entity)
    {
        var name = entity + "Registro";
        if (!sa.Vars.Any(v => v["name"]?.ToString() == name)) sa.Vars.Add(new JsonObject { ["name"] = name, ["type"] = entity });
        return name;
    }

    /// <summary>A field of the record an effect works on, read in the server action (a joined record by its foreign key is read
    /// with the entity's Get action).</summary>
    private (List<JsonObject> Reads, Func<string, string?, string> Field) RecordFields(ServerAction sa, string collection, string recordExpr, JsonObject effect)
    {
        var reads = new List<JsonObject>();
        var known = new Dictionary<string, string>(StringComparer.Ordinal);
        string Field(string f, string? via)
        {
            if (via == null) return $"{recordExpr}.{f}";
            if (!known.TryGetValue(via, out var node))
            {
                var target = _p.JoinedCollection(collection, via) ?? throw new PrototypeExpressionException($"{collection}.{via} is not a foreign key");
                node = sa.Node("Obter" + target);
                known[via] = node;
                known[via + "@entity"] = _p.EntityName(target);
                reads.Add(new JsonObject { ["call"] = "Get" + _p.EntityName(target), ["as"] = node, ["args"] = new JsonObject { ["Id"] = $"{recordExpr}.{via}" } });
            }
            return $"{node}.Record.{known[via + "@entity"]}.{f}";
        }
        // pre-scan so the reads come before the assignment that uses them
        void Scan(JsonNode? n)
        {
            switch (n)
            {
                case JsonObject o:
                    if (o["field"]?.ToString() is { } f && o["via"]?.ToString() is { } v && o["record"] == null) Field(f, v);
                    foreach (var (_, x) in o) Scan(x);
                    break;
                case JsonArray a: foreach (var x in a) Scan(x); break;
            }
        }
        Scan(effect["max"]); Scan(effect["min"]); Scan(effect["delta"]); Scan(effect["validate"]);
        return (reads, Field);
    }

    private IEnumerable<JsonObject> Update(ServerAction sa, JsonObject effect, PrototypeScope scope, string kind)
    {
        var c = effect["collection"]!.ToString();
        var entity = _p.EntityName(c);
        sa.Writes.Add(c);
        var get = sa.Node("Obter" + c + "ParaAlterar");
        var record = RecordVar(sa, entity);
        yield return new JsonObject { ["call"] = $"Get{entity}ForUpdate", ["as"] = get, ["args"] = new JsonObject { ["Id"] = IdArgument(effect["key"], scope) } };
        var current = $"{get}.Record.{entity}";
        var (reads, field) = RecordFields(sa, c, current, effect);
        foreach (var r in reads) yield return r;
        var recordScope = new PrototypeScope
        {
            Param = scope.Param, ParamType = scope.ParamType, Dim = scope.Dim, DimType = scope.DimType, Control = scope.Control, ControlType = scope.ControlType,
            Inserted = scope.Inserted, Input = scope.Input, Record = scope.Record, RecordType = scope.RecordType,
            Field = field, FieldType = (f, via) => _p.FieldType(via != null ? _p.JoinedCollection(c, via) : c, f),
        };
        var assign = new JsonObject { [record] = current };
        if (kind == "toggle")
        {
            var f = effect["field"]!.ToString();
            assign[$"{record}.{f}"] = $"not {current}.{f}";
            if (!sa.Outputs.Any(o => o.Name == f)) { sa.Outputs.Add((f, "Boolean")); sa.Updated[f] = f; }
        }
        else if (kind == "increment")
        {
            var f = effect["field"]!.ToString();
            var value = $"{current}.{f} + {PrototypeExpr.Val(effect["delta"], scope)}";
            if (effect["max"] != null) value = $"Min({PrototypeExpr.Val(effect["max"], recordScope)}, {value})";
            if (effect["min"] != null) value = $"Max({PrototypeExpr.Val(effect["min"], recordScope)}, {value})";
            assign[$"{record}.{f}"] = value;
        }
        else
            foreach (var (f, v) in effect["fields"] as JsonObject ?? [])
                assign[$"{record}.{f}"] = ToField(c, f, v, recordScope);
        yield return new JsonObject { ["assign"] = assign, ["as"] = sa.Node((_p.Pt ? "Alterar" : "Change") + c) };
        if (kind == "toggle")
        {
            var f = effect["field"]!.ToString();
            yield return new JsonObject { ["assign"] = new JsonObject { [f] = $"{record}.{f}" }, ["as"] = sa.Node((_p.Pt ? "Devolver" : "Return") + f) };
        }
        yield return new JsonObject { ["update"] = entity, ["as"] = sa.Node((_p.Pt ? "Atualizar" : "Update") + c), ["record"] = record };
    }

    private IEnumerable<JsonObject> NewKey(ServerAction sa, string c, string record, JsonObject effect)
    {
        var entity = _p.EntityName(c);
        var max = sa.Node((_p.Pt ? "Maior" : "Max") + c);
        var key = KeyOf(c);
        yield return new JsonObject { ["get"] = entity, ["as"] = max, ["columns"] = new JsonArray(new JsonObject { ["name"] = "MaiorId", ["kind"] = "Max", ["attribute"] = $"{entity}.{key}" }) };
        // the key is the entity's identifier (Integer, no AutoNumber): the next integer after the largest one
        var next = $"IdentifierToInteger({max}.List.Current.MaiorId) + 1";
        if (effect["keyMin"] is JsonValue keyMin && keyMin.TryGetValue<int>(out var min)) next = $"Max({min}, {next})";
        yield return new JsonObject { ["assign"] = new JsonObject { [$"{record}.{key}"] = $"IntegerToIdentifier({next})" }, ["as"] = sa.Node((_p.Pt ? "NovaChave" : "NewKey") + c) };
    }

    private IEnumerable<JsonObject> Insert(ServerAction sa, JsonObject effect, PrototypeScope scope)
    {
        var c = effect["collection"]!.ToString();
        var entity = _p.EntityName(c);
        sa.Writes.Add(c);
        var record = RecordVar(sa, entity);
        foreach (var step in NewKey(sa, c, record, effect)) yield return step;
        var assign = new JsonObject();
        var sums = new List<JsonObject>();
        foreach (var (f, v) in effect["fields"] as JsonObject ?? [])
        {
            if (v is JsonObject o && o["sum"] is JsonObject sum)
            {
                // a sum of a filtered collection (one join by foreign key): an aggregate with a Sum column
                var source = sum["collection"]!.ToString();
                var sourceEntity = _p.EntityName(source);
                var node = sa.Node((_p.Pt ? "Soma" : "Sum") + f);
                var joins = new JsonArray(); var sources = new JsonArray();
                var aggScope = new PrototypeScope
                {
                    Param = scope.Param, ParamType = scope.ParamType, Dim = scope.Dim, DimType = scope.DimType, Control = scope.Control, ControlType = scope.ControlType, Input = scope.Input,
                    Field = (field, via) =>
                    {
                        if (via == null) return $"{sourceEntity}.{field}";
                        var joinedCollection = _p.JoinedCollection(source, via) ?? throw new PrototypeExpressionException($"{source}.{via} is not a foreign key");
                        var target = _p.EntityName(joinedCollection);
                        if (!sources.Any(s => s?.ToString() == target))
                        {
                            sources.Add(target);
                            joins.Add(new JsonObject { ["left"] = sourceEntity, ["right"] = target, ["kind"] = "inner", ["condition"] = $"{sourceEntity}.{via} = {target}.{KeyOf(joinedCollection)}" });
                        }
                        return $"{target}.{field}";
                    },
                    FieldType = (field, via) => _p.FieldType(via != null ? _p.JoinedCollection(source, via) : source, field),
                };
                var column = sum["field"] is JsonValue fv ? $"{sourceEntity}.{fv}" : PrototypeExpr.Val(sum["field"], aggScope);
                var step = new JsonObject { ["get"] = sourceEntity, ["as"] = node };
                // An aggregated column names one attribute (CompileCheck: AGGREGATE_COLUMN_NOT_ATTRIBUTE): a computed value, such as
                // Quantidade * Preco, is a calculated column aggregated by name (the published form: AGG Total=Sum(TotalRow)).
                if (AggregateSortRule.Plain(column) == null)
                {
                    step["calculated"] = new JsonArray(new JsonObject { ["name"] = "TotalRow", ["value"] = column });
                    column = "TotalRow";
                }
                step["columns"] = new JsonArray(new JsonObject { ["name"] = "Total", ["kind"] = "Sum", ["attribute"] = column });
                if (sources.Count > 0) { step["sources"] = sources; step["joins"] = joins; }
                if (sum["where"] is JsonObject where) step["where"] = PrototypeExpr.Pred(where, aggScope);
                sums.Add(step);
                assign[$"{record}.{f}"] = $"{node}.List.Current.Total";
            }
            else assign[$"{record}.{f}"] = ToField(c, f, v, scope);
        }
        foreach (var s in sums) yield return s;
        yield return new JsonObject { ["assign"] = assign, ["as"] = sa.Node((_p.Pt ? "Preencher" : "Fill") + c) };
        yield return new JsonObject { ["create"] = entity, ["as"] = sa.Node((_p.Pt ? "Criar" : "Create") + c), ["record"] = record };
        var output = c + "Id";
        if (!sa.Outputs.Any(o => o.Name == output)) sa.Outputs.Add((output, "Integer"));
        sa.Inserted[c] = output;
        yield return new JsonObject { ["assign"] = new JsonObject { [output] = $"IdentifierToInteger({record}.{KeyOf(c)})" }, ["as"] = sa.Node((_p.Pt ? "Devolver" : "Return") + output) };
    }

    private IEnumerable<JsonObject> Upsert(ServerAction sa, JsonObject effect, PrototypeScope scope)
    {
        var c = effect["collection"]!.ToString();
        var entity = _p.EntityName(c);
        sa.Writes.Add(c);
        var record = RecordVar(sa, entity);
        var field = effect["field"]!.ToString();
        var keys = effect["keys"] as JsonObject ?? [];
        var existing = sa.Node((_p.Pt ? "Existente" : "Existing") + c);
        var where = string.Join(" and ", keys.Select(k => (_p.FieldType(c, k.Key) == "Identifier" && PrototypeExpr.TypeOf(k.Value, scope) != "Identifier" ? $"IdentifierToInteger({entity}.{k.Key})" : $"{entity}.{k.Key}") + " = " + PrototypeExpr.Val(k.Value, scope)));
        yield return new JsonObject { ["get"] = entity, ["as"] = existing, ["where"] = where, ["max"] = 1 };
        var delta = PrototypeExpr.Val(effect["delta"], scope);
        // new item: key, fields, validations with the existing quantity 0
        var insert = new JsonArray();
        foreach (var step in ValidateUpsert(sa, effect, scope, c, existing, isNew: true)) insert.Add(step);
        foreach (var step in NewKey(sa, c, record, effect)) insert.Add(step);
        var fill = new JsonObject();
        foreach (var (k, v) in keys) fill[$"{record}.{k}"] = ToField(c, k, v, scope);
        fill[$"{record}.{field}"] = delta;
        foreach (var (f, v) in effect["fields"] as JsonObject ?? []) fill[$"{record}.{f}"] = ToField(c, f, v, scope);
        insert.Add(new JsonObject { ["assign"] = fill, ["as"] = sa.Node((_p.Pt ? "Preencher" : "Fill") + c) });
        insert.Add(new JsonObject { ["create"] = entity, ["as"] = sa.Node((_p.Pt ? "Criar" : "Create") + c), ["record"] = record });
        // existing item: increment
        var update = new JsonArray();
        foreach (var step in ValidateUpsert(sa, effect, scope, c, existing, isNew: false)) update.Add(step);
        var get = sa.Node("Obter" + c + "ParaAlterar");
        update.Add(new JsonObject { ["call"] = $"Get{entity}ForUpdate", ["as"] = get, ["args"] = new JsonObject { ["Id"] = $"{existing}.List.Current.{entity}.{KeyOf(c)}" } });
        update.Add(new JsonObject { ["assign"] = new JsonObject { [record] = $"{get}.Record.{entity}", [$"{record}.{field}"] = $"{get}.Record.{entity}.{field} + {delta}" }, ["as"] = sa.Node((_p.Pt ? "Somar" : "Add") + field) });
        update.Add(new JsonObject { ["update"] = entity, ["as"] = sa.Node((_p.Pt ? "Atualizar" : "Update") + c), ["record"] = record });
        yield return new JsonObject { ["if"] = $"{existing}.List.Empty", ["label"] = _p.Pt ? "Item novo?" : "New item?", ["then"] = insert, ["else"] = update };
    }

    /// <summary>A membership that one click adds or removes (the favorite of a property): the record of the collection with
    /// these keys is deleted when it exists, else created with them; one server action, the aggregates that read it refreshed.</summary>
    private IEnumerable<JsonObject> ToggleMember(ServerAction sa, JsonObject effect, PrototypeScope scope)
    {
        var c = effect["collection"]!.ToString();
        var entity = _p.EntityName(c);
        sa.Writes.Add(c);
        var record = RecordVar(sa, entity);
        var keys = effect["keys"] as JsonObject ?? [];
        var existing = sa.Node((_p.Pt ? "Existente" : "Existing") + c);
        var where = string.Join(" and ", keys.Select(k => (_p.FieldType(c, k.Key) == "Identifier" && PrototypeExpr.TypeOf(k.Value, scope) != "Identifier" ? $"IdentifierToInteger({entity}.{k.Key})" : $"{entity}.{k.Key}") + " = " + PrototypeExpr.Val(k.Value, scope)));
        yield return new JsonObject { ["get"] = entity, ["as"] = existing, ["where"] = where, ["max"] = 1 };
        var key = KeyOf(c);
        var insert = new JsonArray();
        // the key comes from the keys when the collection is keyed by them (a Set of properties), else the next one
        if (!keys.ContainsKey(key)) foreach (var step in NewKey(sa, c, record, effect)) insert.Add(step);
        var fill = new JsonObject();
        foreach (var (k, v) in keys) fill[$"{record}.{k}"] = ToField(c, k, v, scope);
        insert.Add(new JsonObject { ["assign"] = fill, ["as"] = sa.Node((_p.Pt ? "Preencher" : "Fill") + c) });
        insert.Add(new JsonObject { ["create"] = entity, ["as"] = sa.Node((_p.Pt ? "Criar" : "Create") + c), ["record"] = record });
        var delete = new JsonArray(new JsonObject { ["delete"] = entity, ["as"] = sa.Node((_p.Pt ? "Remover" : "Remove") + c), ["id"] = $"{existing}.List.Current.{entity}.{key}" });
        yield return new JsonObject { ["if"] = $"{existing}.List.Empty", ["label"] = _p.Pt ? "Ainda nao existe?" : "Not there yet?", ["then"] = insert, ["else"] = delete };
    }

    private IEnumerable<JsonObject> ValidateUpsert(ServerAction sa, JsonObject effect, PrototypeScope scope, string c, string existing, bool isNew)
    {
        var entity = _p.EntityName(c);
        var rules = PrototypeCapture.Objects(effect["validate"]);
        if (rules.Count == 0) yield break;
        // fields of the joined record (Produto.Estoque through ProdutoId) are read with the entity's Get
        var keyOf = effect["keys"] as JsonObject ?? [];
        var reads = new Dictionary<string, string>(StringComparer.Ordinal);
        var readSteps = new List<JsonObject>();
        var ruleScope = new PrototypeScope
        {
            Param = scope.Param, ParamType = scope.ParamType, Dim = scope.Dim, DimType = scope.DimType, Control = scope.Control, ControlType = scope.ControlType, Input = scope.Input,
            Existing = f => isNew ? "0" : $"{existing}.List.Current.{entity}.{f}",
            Field = (f, via) =>
            {
                if (via == null) return isNew ? (keyOf[f] is JsonNode kv ? PrototypeExpr.Val(kv, scope) : "0") : $"{existing}.List.Current.{entity}.{f}";
                if (!reads.TryGetValue(via, out var node))
                {
                    var target = _p.JoinedCollection(c, via) ?? throw new PrototypeExpressionException($"{c}.{via} is not a foreign key");
                    node = sa.Node("Obter" + target + (isNew ? "" : "Existente"));
                    reads[via] = node;
                    reads[via + "@entity"] = _p.EntityName(target);
                    var id = keyOf[via] is JsonNode k ? IdArgument(k, scope) : $"{existing}.List.Current.{entity}.{via}";
                    readSteps.Add(new JsonObject { ["call"] = "Get" + _p.EntityName(target), ["as"] = node, ["args"] = new JsonObject { ["Id"] = id } });
                }
                return $"{node}.Record.{reads[via + "@entity"]}.{f}";
            },
        };
        var checks = new List<JsonObject>();
        foreach (var rule in rules)
        {
            sa.Raises = true;
            checks.Add(new JsonObject
            {
                ["if"] = PrototypeExpr.Pred(rule["when"], ruleScope), ["label"] = _p.Pt ? "Estoque insuficiente?" : "Insufficient?",
                ["then"] = new JsonArray(new JsonObject { ["raise"] = _p.ExceptionName, ["message"] = PrototypeExpr.Quote(rule["message"]?.ToString() ?? "") }),
            });
        }
        foreach (var r in readSteps) yield return r;
        foreach (var check in checks) yield return check;
    }

    // ---- owners: bindings, screen actions, block actions -------------------------------------------------------------------

    private void Owner(PrototypeOwner owner)
    {
        if (owner.Kind == "screen") Initialize(owner);
        else if (owner.Modal == null) FollowInputs(owner);
        // a modal block without a record whose control edits a global dimension reads its Client Variable when it starts
        // (one with a record resets on the record's arrival instead, ModalBlockReset)
        else if (owner.Inputs.Count == 0) Initialize(owner);
        foreach (var agg in owner.Aggregates.Values.Where(a => a.SortBy != null)) Sorter(owner, agg);
        var triggered = Triggered(owner);
        foreach (var key in owner.EventKeys.OrderBy(k => k, StringComparer.Ordinal))
        {
            var e = _ir.Event(key);
            if (e == null) continue;
            if (!triggered.Contains(key))
            {
                // no node of this owner's trees runs it (the canonical state of the view hides its trigger)
                _untriggered.Add(new JsonObject { ["event"] = key, ["owner"] = owner.Name });
                continue;
            }
            if (!PrototypePlanner.Effects(e).Any())
            {
                // the capture kept the event without any effect (the page changed outside the closed class): no action
                var why = (e["notCompiled"] as JsonArray)?.OfType<JsonObject>().FirstOrDefault()?["why"]?.ToString() ?? "the capture explained no effect";
                _notCompiled.Add(new JsonObject { ["event"] = key, ["owner"] = owner.Name, ["handler"] = e["handler"]?.ToString(), ["why"] = why });
                continue;
            }
            try { Bind(owner, e); }
            catch (PrototypeExpressionException ex) { _notCompiled.Add(new JsonObject { ["event"] = key, ["owner"] = owner.Name, ["handler"] = e["handler"]?.ToString(), ["why"] = ex.Message }); }
        }
        // the screen handles the shell's block events and the events of its modal blocks
        if (owner.Kind == "screen")
        {
            if (_p.Shell is { } shell) BlockHandlers(owner, shell, null);
            foreach (var popup in owner.Popups.Values.Where(p => p.Block != null))
                if (_p.ModalBlockOwner(popup.Modal) is { } block) BlockHandlers(owner, block, popup);
        }
        // the modal block reacts to a record change: the dimensions the opening event resets (only Assign, S1)
        if (owner.Kind == "block" && owner.Modal != null) ModalBlockReset(owner);
    }

    /// <summary>The name of a new screen action of the owner: the generated one when it is free in the owner and no client action
    /// of the module or of its references has it (the Studio would rename it and every reference of the plan would read the
    /// other element), else the next free one; the rename is reported with what held the name.</summary>
    private string ActionName(PrototypeOwner owner, string wanted)
    {
        var holder = _p.MemberHolder(owner, wanted, action: true);
        var name = owner.ActionNames.Free(wanted, 0);
        if (holder != null) _p.MemberRenamed(owner, "screen action", wanted, name, holder);
        return name;
    }

    private void Initialize(PrototypeOwner owner)
    {
        if (owner.Initialize.Count == 0) return;
        var name = ActionName(owner, _p.Pt ? "Inicializar" : "Initialize");
        var assign = new JsonObject();
        foreach (var (local, value) in owner.Initialize) assign[local] = value;
        owner.Actions.Add(Screen(owner, name, $"OnInitialize of {owner.Name}: the global dimensions from their Client Variables.", [],
            [new JsonObject { ["assign"] = assign, ["as"] = _p.Pt ? "LerVariaveis" : "ReadVariables" }]));
        owner.Wiring.Add(PrototypePlanner.Set(owner.Ref + "/OnInitialize", "Destination", owner.Ref + "/" + name));
    }

    /// <summary>The shell's controls edit local copies of its inputs: the copies follow the inputs when the block starts and when
    /// a screen passes new values (only Assign; no server call in a lifecycle event).</summary>
    private void FollowInputs(PrototypeOwner owner)
    {
        if (owner.Initialize.Count == 0) return;
        var name = ActionName(owner, _p.Pt ? "AcompanharEntradas" : "FollowInputs");
        var assign = new JsonObject();
        foreach (var (local, value) in owner.Initialize) assign[local] = value;
        owner.Actions.Add(Screen(owner, name, $"OnInitialize and OnParametersChanged of {owner.Name}: the controls show the values the screen passes.", [],
            [new JsonObject { ["assign"] = assign, ["as"] = _p.Pt ? "CopiarEntradas" : "CopyInputs" }]));
        owner.Wiring.Add(PrototypePlanner.Set(owner.Ref + "/OnInitialize", "Destination", owner.Ref + "/" + name));
        owner.Wiring.Add(PrototypePlanner.Set(owner.Ref + "/OnParametersChanged", "Destination", owner.Ref + "/" + name));
    }

    private JsonObject Screen(PrototypeOwner owner, string name, string description, IEnumerable<JsonObject> inputs, IEnumerable<JsonObject> steps, JsonArray? handlers = null)
    {
        _screenActions++;
        var declaration = new JsonObject
        {
            ["name"] = name, ["kind"] = "screen", ["owner"] = (owner.Kind == "screen" ? "IMobileScreen:" : "IMobileBlock:") + owner.Name,
            ["description"] = description, ["inputs"] = new JsonArray(inputs.Select(i => (JsonNode)i.DeepClone()).ToArray()),
            ["steps"] = new JsonArray(steps.Select(s => (JsonNode)s).ToArray()),
        };
        if (handlers is { Count: > 0 }) declaration["handlers"] = handlers;
        return declaration;
    }

    /// <summary>Ordenar&lt;Lista&gt;: a Switch with one ListSort per observed value (bare attribute, never List.Current); the default
    /// order is the aggregate's own. Called on OnAfterFetch and when the dimension changes.</summary>
    private void Sorter(PrototypeOwner owner, PrototypeAggregate agg)
    {
        var sortBy = agg.SortBy!;
        var dim = sortBy["dimension"]?.ToString() ?? "";
        if (!owner.DimLocals.TryGetValue(dim, out var local)) return;
        var name = ActionName(owner, (_p.Pt ? "Ordenar" : "Sort") + agg.Name);
        var cases = new JsonArray();
        foreach (var c in PrototypeCapture.Objects(sortBy["cases"]))
            cases.Add(new JsonObject
            {
                ["when"] = $"{local} = {PrototypeExpr.Literal(c["value"], _p.DimType(dim))}",
                ["steps"] = new JsonArray(new JsonObject { ["call"] = "IClientActionSignature:ListSort", ["as"] = "Ordenar" + PrototypeNames.Pascal(c["value"]!.ToString()),
                    ["args"] = new JsonObject { ["List"] = agg.Name + ".List", ["By"] = $"{agg.Entity}.{c["field"]}", ["Ascending"] = c["dir"]?.ToString() == "desc" ? "False" : "True" } }),
            });
        if (cases.Count == 0) return;
        owner.Actions.Add(Screen(owner, name, $"Orders the list {agg.ListName} by the dimension {dim} (the prototype sorts the rendered list).", [],
            [new JsonObject { ["switch"] = cases, ["as"] = _p.Pt ? "Ordem" : "Order", ["otherwise"] = new JsonArray() }]));
        agg.AfterFetch = name;
        owner.Wiring.Add(PrototypePlanner.Set(agg.Alias + "/OnAfterFetch", "Destination", owner.Ref + "/" + name));
    }

    private bool PureNavigation(JsonObject e)
        => (e["cases"] as JsonArray ?? []).Count == 0 && e["effects"] is JsonArray effects && effects.Count == 1 && effects[0]?["kind"]?.ToString() == "navigate";

    /// <summary>Whether a trigger of the event is an element whose click is an extended onclick (anything but a button or a link):
    /// the tag of its selector, and the tags of the capture nodes that carry the event.</summary>
    private bool NeedsHandlerAction(JsonObject e)
    {
        var key = e["key"]!.ToString();
        // a submit goes on the form's button (an IButton, whose OnClick takes the destination); only clicks are asked
        if (!key.Contains(":click:", StringComparison.Ordinal)) return false;
        var tags = new HashSet<string>(StringComparer.Ordinal);
        var lead = System.Text.RegularExpressions.Regex.Match(e["selector"]?.ToString() ?? "", "^[A-Za-z][A-Za-z0-9-]*").Value.ToLowerInvariant();
        if (lead.Length > 0) tags.Add(lead);
        void Visit(JsonNode? n)
        {
            if (n is not JsonObject o) return;
            if (o["events"] is JsonArray events && events.Any(x => x?.ToString() == key) && o["t"]?.ToString() is { } t) tags.Add(t.ToLowerInvariant());
            foreach (var child in o["c"] as JsonArray ?? []) Visit(child);
            if (o["list"]?["template"] is JsonObject template) Visit(template);
        }
        foreach (var view in _ir.Views) Visit(view["root"]);
        Visit(_ir.Shell?["root"]);
        foreach (var modal in _ir.Modals) Visit(modal["root"]);
        return tags.Any(t => t is not ("a" or "button"));
    }

    /// <summary>The event at one owner: a navigation binding, or a screen action (and, in a block, the trigger of its block event).</summary>
    private void Bind(PrototypeOwner owner, JsonObject e)
    {
        var key = e["key"]!.ToString();
        var parameters = PrototypeCapture.Objects(e["params"]);
        if (PureNavigation(e))
        {
            var nav = (JsonObject)e["effects"]![0]!;
            var screen = _p.PlanResult.Screens.GetValueOrDefault(nav["view"]?.ToString() ?? "");
            // a div, li or span that navigates gets the extended onclick of an HTML element, whose handler is an action, never a
            // screen (VisitaCerta 2026-10-12: the side menu items of the shell, EventHandlerRequiredAction): an action of the owner
            // (screen or block) that only goes to the screen; a button or a link keeps the destination on its own OnClick
            if (screen != null && NeedsHandlerAction(e))
            {
                var navScope = ActionScope(owner, e, null);
                var destination = new JsonObject { ["node"] = "IDestinationNode", ["as"] = (_p.Pt ? "IrPara" : "GoTo") + screen, ["properties"] = new JsonObject { ["Destination"] = "IMobileScreen:" + screen } };
                var args = new JsonObject();
                foreach (var (param, val) in nav["params"] as JsonObject ?? []) args[param] = PrototypeExpr.Val(val, navScope);
                if (args.Count > 0) destination["args"] = args;
                var action = ActionName(owner, (_p.Pt ? "IrPara" : "GoTo") + screen);
                owner.Actions.Add(Screen(owner, action, $"Event {key} of the prototype: goes to the screen {screen} (handler {e["handler"]}).", [], [destination]));
                owner.Bindings[key] = new PrototypeEventBinding(key, null, action, []);
                _compiled.Add(key);
                return;
            }
            owner.Bindings[key] = new PrototypeEventBinding(key, screen, null, [], nav["params"] as JsonObject is { } np ? np.ToDictionary(p => p.Key, p => p.Value!.DeepClone()) : null);
            _compiled.Add(key);
            return;
        }
        if (owner.Kind == "block")
        {
            BlockEvent(owner, e);
            return;
        }
        // the parameters the effects read (a data-id the event does not use is no input of its action)
        var read = ParamsIn(e).ToHashSet(StringComparer.Ordinal);
        parameters = parameters.Where(p => read.Contains(p["name"]!.ToString())).ToList();
        // a screen: the whole event; a control the owner cannot read (an input of a list row bound to its record) arrives as a
        // parameter whose argument is the control's own variable
        var implicitControls = ControlsIn(e).Where(c => !Readable(owner, e, c)).Distinct(StringComparer.Ordinal).ToList();
        if (implicitControls.Count > 0)
        {
            var extended = new List<JsonObject>(parameters);
            foreach (var c in implicitControls)
                extended.Add(new JsonObject { ["name"] = c, ["from"] = "@control", ["type"] = _controlTypes.TryGetValue(c, out var ct) ? ct.Type : "Text" });
            e = e.DeepClone().AsObject();
            e["params"] = new JsonArray(extended.Select(x => (JsonNode)x.DeepClone()).ToArray());
            parameters = extended;
        }
        // an event parameter never takes the name of an input or local of the owner (the Studio would rename it)
        var renames = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var p in parameters)
            if (p["name"]?.ToString() is { } pn && owner.LocalNames.Taken(pn)) renames[pn] = pn + (_p.Pt ? "Evento" : "Event");
        if (renames.Count > 0)
            parameters = parameters.Select(p => renames.TryGetValue(p["name"]!.ToString(), out var final) ? Renamed(p, final) : p).ToList();
        var scope = ActionScope(owner, e, null, renames);
        if (implicitControls.Count > 0)
        {
            var baseControl = scope.Control!;
            scope = new PrototypeScope
            {
                Dim = scope.Dim, DimType = scope.DimType, Input = scope.Input, View = scope.View, Record = scope.Record, RecordType = scope.RecordType, Count = scope.Count, Sum = scope.Sum,
                Local = scope.Local, First = scope.First, FieldType = scope.FieldType, ControlType = scope.ControlType, Field = scope.Field, Param = scope.Param,
                ParamType = scope.ParamType, Inserted = scope.Inserted, Updated = scope.Updated,
                Control = c => implicitControls.Contains(c) ? c : baseControl(c),
            };
        }
        var (name, declaration) = ScreenAction(owner, e, scope, parameters.Select(Param), null);
        _compiled.Add(key);
        if (declaration["steps"] is JsonArray { Count: 0 } && declaration["handlers"] == null)
        {
            // nothing to do natively: the control is bound to the value and the screen re-renders by itself
            _screenActions--;
            return;
        }
        owner.Actions.Add(declaration);
        owner.Bindings[key] = new PrototypeEventBinding(key, null, name, parameters);
    }

    private static IEnumerable<string> ParamsIn(JsonNode? n)
    {
        switch (n)
        {
            case JsonObject o:
                if (o["param"] is JsonValue p && p.TryGetValue<string>(out var name)) yield return name;
                foreach (var (k, v) in o) if (k is not ("param" or "params")) foreach (var x in ParamsIn(v)) yield return x;
                break;
            case JsonArray a: foreach (var v in a) foreach (var x in ParamsIn(v)) yield return x; break;
        }
    }

    private static IEnumerable<string> ControlsIn(JsonNode? n)
    {
        switch (n)
        {
            case JsonObject o:
                if (o["control"] is JsonValue c && c.TryGetValue<string>(out var name)) yield return name;
                foreach (var (k, v) in o) if (k != "control") foreach (var x in ControlsIn(v)) yield return x;
                break;
            case JsonArray a: foreach (var v in a) foreach (var x in ControlsIn(v)) yield return x; break;
        }
    }

    private bool Readable(PrototypeOwner owner, JsonObject e, string control)
    {
        if (owner.Controls.ContainsKey(control)) return true;
        var dim = _ir.Dimensions.FirstOrDefault(d => d["name"]?.ToString() == control)?["key"]?.ToString();
        if (dim != null && owner.DimLocals.ContainsKey(dim)) return true;
        if (e["modal"]?.ToString() is { } m && owner.Popups.TryGetValue(m, out var popup) && popup.Block == null && (popup.List != null || popup.Record != null || popup.NewRecord != null)) return true;
        return owner.Kind == "block" && owner.Modal != null;
    }

    private static JsonObject Param(JsonObject p) => new() { ["name"] = p["name"]!.ToString(), ["type"] = p["type"]?.ToString() ?? "Integer" };

    /// <summary>A value written into a field: an integer into a key or foreign key becomes the entity identifier.</summary>
    private string ToField(string collection, string field, JsonNode? value, PrototypeScope scope)
    {
        var fieldType = _p.FieldType(collection, field);
        if (fieldType == "Identifier")
        {
            var id = PrototypeExpr.Val(value, scope);
            return PrototypeExpr.TypeOf(value, scope) != "Identifier" ? $"IntegerToIdentifier({id})" : id;
        }
        // a literal is written in the attribute's own type: the date the prototype keeps as text ("2026-10-12") into a Date Time
        // attribute is #2026-10-12 00:00:00#, never a Text the Verify refuses (VisitaCerta 2026-10-12, ExpressionInvalidExpressionType)
        if (value is JsonObject o && o.ContainsKey("lit") && fieldType is "Text" or "Integer" or "Decimal" or "Boolean" or "DateTime")
            return PrototypeExpr.Literal(o["lit"], fieldType);
        return PrototypeExpr.Convert(PrototypeExpr.Val(value, scope), PrototypeExpr.TypeOf(value, scope), fieldType);
    }

    /// <summary>The Id argument of an entity action (an identifier) from a value that may be an integer.</summary>
    private static string IdArgument(JsonNode? value, PrototypeScope scope)
    {
        var text = PrototypeExpr.Val(value, scope);
        return PrototypeExpr.TypeOf(value, scope) == "Identifier" ? text : $"IntegerToIdentifier({text})";
    }

    /// <summary>A value passed to a server input: an identifier into an Integer input is its integer, an integer into an
    /// identifier input becomes the identifier.</summary>
    private static string ToInput(string inputType, JsonNode source, PrototypeScope scope)
    {
        var text = PrototypeExpr.Val(source, scope);
        var type = PrototypeExpr.TypeOf(source, scope);
        if (type == "Identifier" && !inputType.EndsWith(" Identifier", StringComparison.Ordinal)) return $"IdentifierToInteger({text})";
        if (type != "Identifier" && inputType.EndsWith(" Identifier", StringComparison.Ordinal)) return $"IntegerToIdentifier({text})";
        return text;
    }

    /// <summary>The identifier attribute of a collection's entity: its key (Id, or numero when the prototype keys orders by number).</summary>
    private string KeyOf(string collection) => _p.Data.ByCollection(collection)?.Key ?? "Id";

    private static JsonObject Renamed(JsonObject p, string name)
    {
        var copy = p.DeepClone().AsObject();
        copy["name"] = name;
        return copy;
    }

    /// <summary>The screen action of an event: the branches, the one server call, the refreshes, the client effects in order,
    /// the handler of the validation exception and the Destination at the end.</summary>
    private (string Name, JsonObject Declaration) ScreenAction(PrototypeOwner owner, JsonObject e, PrototypeScope scope, IEnumerable<JsonObject> inputs, PrototypePopup? blockPopup)
    {
        var key = e["key"]!.ToString();
        var effects = PrototypePlanner.Effects(e).ToList();
        var first = effects.FirstOrDefault(x => PrototypeCapture.DataEffects.Contains(x["kind"]!.ToString())) ?? effects.FirstOrDefault(x => x["kind"]?.ToString() != "validate") ?? effects[0];
        var wanted = first["kind"]?.ToString() == "toast" && first["close"]?.GetValue<bool>() == true ? (_p.Pt ? "FecharAviso" : "CloseNotice") : Verb(first["kind"]!.ToString()) + ObjectOf(first);
        var name = ActionName(owner, wanted);
        if (name != wanted) { owner.ActionNames.Claim(name); }
        _server.TryGetValue(key, out var server);
        var branches = Branches(e).ToList();
        var dataBranches = branches.Count(b => HasData(b.Effects));
        var hoist = server != null && dataBranches >= 2;
        var steps = new JsonArray();
        var handlers = new JsonArray();
        if (server != null && (server.Raises || server.Mapped != null))
            handlers.Add(Handler(owner, e, server));
        if (hoist) foreach (var s in Call(owner, e, server!, scope)) steps.Add(s);
        var navigate = new List<JsonObject>();
        JsonObject? root = null; JsonObject? current = null;
        foreach (var (when, branchEffects) in branches)
        {
            var body = new JsonArray(Client(owner, e, branchEffects, scope, server, called: hoist, blockPopup).Select(s => (JsonNode)s).ToArray());
            if (when == null)
            {
                if (current != null) current["else"] = body;
                else foreach (var s in body) steps.Add(s!.DeepClone());
                break;
            }
            var branch = new JsonObject { ["if"] = PrototypeExpr.Pred(when, scope), ["label"] = Question(when), ["then"] = body };
            if (current == null) { root = branch; steps.Add(branch); }
            else current["else"] = new JsonArray(branch);
            current = branch;
        }
        if (root != null && current != null && current["else"] == null) current["else"] = new JsonArray();
        var description = $"Event {key} of the prototype (handler {e["handler"]}): {string.Join(", ", effects.Select(x => x["kind"]!.ToString()).Distinct())}.";
        return (name, Screen(owner, name, description, inputs, steps.OfType<JsonObject>().Select(s => s.DeepClone().AsObject()), handlers));
    }

    private JsonObject Handler(PrototypeOwner owner, JsonObject e, ServerAction server)
    {
        // the validation message goes where the prototype shows it: the error element of the form, else an error toast
        var validate = PrototypePlanner.Effects(e).FirstOrDefault(x => x["kind"]?.ToString() == "validate");
        var target = validate?["target"]?["local"]?.ToString();
        var handlerName = _p.Pt ? "ErroDeValidacao" : "ValidationError";
        var assign = new JsonObject();
        if (target != null && owner.Controls.TryGetValue(target, out var local)) assign[local.Local] = handlerName + ".ExceptionMessage";
        else if (owner.DimLocals.TryGetValue("@aviso", out var aviso))
        {
            assign[aviso] = handlerName + ".ExceptionMessage";
            assign[owner.DimLocals["@avisoErro"]] = "True";
        }
        return new JsonObject
        {
            ["name"] = handlerName, ["exception"] = server.Mapped != null ? "AllExceptions" : _p.ExceptionName, ["abortTransaction"] = true, ["logError"] = false,
            ["steps"] = assign.Count > 0 ? new JsonArray(new JsonObject { ["assign"] = assign, ["as"] = _p.Pt ? "MostrarErro" : "ShowError" }) : new JsonArray(),
        };
    }

    /// <summary>The call of the event's server action, then Refresh Data of every aggregate of the owner that reads what it wrote.</summary>
    private IEnumerable<JsonObject> Call(PrototypeOwner owner, JsonObject e, ServerAction server, PrototypeScope scope)
    {
        var args = new JsonObject();
        foreach (var (name, type, source) in server.Inputs)
            args[name] = ToInput(type, source, scope);
        // the server action by its kind: a screen action of the same name (verb + object) would shadow it in client logic
        yield return new JsonObject { ["call"] = (server.Mapped != null ? "" : "IServerAction:") + server.Name, ["as"] = server.Name, ["args"] = args };
        foreach (var refresh in Refreshes(owner, server.Mapped != null ? null : server.Writes)) yield return refresh;
    }

    private IEnumerable<JsonObject> Refreshes(PrototypeOwner owner, IReadOnlySet<string>? writes)
    {
        foreach (var agg in owner.Aggregates.Values.Where(a => writes == null || a.Reads.Overlaps(writes)).OrderBy(a => a.Name, StringComparer.Ordinal))
            yield return new JsonObject { ["node"] = "IRefreshDataNode", ["properties"] = new JsonObject { ["DataSource"] = agg.Alias } };
    }

    private IEnumerable<JsonObject> RefreshesFor(PrototypeOwner owner, string local)
    {
        var token = new System.Text.RegularExpressions.Regex(@"(?<![\w.])" + System.Text.RegularExpressions.Regex.Escape(local) + @"(?![\w])");
        foreach (var agg in owner.Aggregates.Values.Where(a => a.Filters.Any(f => token.IsMatch(f))).OrderBy(a => a.Name, StringComparer.Ordinal))
            yield return new JsonObject { ["node"] = "IRefreshDataNode", ["properties"] = new JsonObject { ["DataSource"] = agg.Alias } };
    }

    /// <summary>The client effects of one branch, in order (the server call where its first data effect is).</summary>
    private List<JsonObject> Client(PrototypeOwner owner, JsonObject e, JsonArray effects, PrototypeScope scope, ServerAction? server, bool called, PrototypePopup? blockPopup)
    {
        var steps = new List<JsonObject>();
        var assign = new JsonObject();
        var refreshed = new HashSet<string>(StringComparer.Ordinal);
        JsonObject? destination = null;
        void Flush()
        {
            if (assign.Count == 0) return;
            steps.Add(new JsonObject { ["assign"] = assign.DeepClone(), ["as"] = _p.Pt ? "Definir" : "Set" });
            assign.Clear();
        }
        void Refresh(IEnumerable<JsonObject> nodes)
        {
            foreach (var n in nodes)
                if (refreshed.Add(n["properties"]!["DataSource"]!.ToString())) steps.Add(n);
        }
        foreach (var effect in effects.OfType<JsonObject>())
        {
            var kind = effect["kind"]!.ToString();
            if (PrototypeCapture.DataEffects.Contains(kind) || kind == "validate")
            {
                if (!called && server != null)
                {
                    Flush();
                    var call = Call(owner, e, server, scope).ToList();
                    steps.Add(call[0]);
                    Refresh(call.Skip(1));
                    called = true;
                }
                continue;
            }
            switch (kind)
            {
                case "setDimension":
                {
                    var dim = effect["dimension"]!.ToString();
                    if (!owner.DimLocals.TryGetValue(dim, out var local)) break;   // a dimension of a modal block: its own reset
                    var value = effect["value"];
                    var text = PrototypeExpr.Val(value, scope);
                    if (effect["max"] != null) text = $"Min({PrototypeExpr.Val(effect["max"], scope)}, {text})";
                    if (effect["min"] != null) text = $"Max({PrototypeExpr.Val(effect["min"], scope)}, {text})";
                    // the control bound to the dimension already holds the value (Assign X = X is refused): no assignment
                    if (text != local) assign[local] = text;
                    if (_ir.Dimension(dim)?["scope"]?.ToString() == "global") assign["Client." + _p.CvName(dim)] = local == text ? local : text;
                    Flush();
                    if (owner.Aggregates.Values.FirstOrDefault(a => a.SortBy?["dimension"]?.ToString() == dim) is { AfterFetch: { } sorter } sorted)
                    {
                        // the default order comes from the aggregate (refetched), the others from Ordenar<Lista>
                        var defaultValue = _ir.Dimension(dim)?["initial"]?.ToString();
                        steps.Add(new JsonObject
                        {
                            ["if"] = $"{local} = {PrototypeExpr.Literal(JsonValue.Create(defaultValue ?? ""), _p.DimType(dim))}", ["label"] = _p.Pt ? "Ordem padrao?" : "Default order?",
                            ["then"] = new JsonArray(new JsonObject { ["node"] = "IRefreshDataNode", ["properties"] = new JsonObject { ["DataSource"] = sorted.Alias } }),
                            ["else"] = new JsonArray(new JsonObject { ["call"] = sorter, ["as"] = sorter }),
                        });
                    }
                    Refresh(RefreshesFor(owner, local));
                    break;
                }
                case "openPopup":
                {
                    var modal = effect["modal"]!.ToString();
                    if (!owner.Popups.TryGetValue(modal, out var popup)) break;
                    Flush();
                    var inputs = effect["inputs"] as JsonObject ?? [];
                    var values = new JsonObject();
                    foreach (var (input, val) in inputs)
                        if (popup.Inputs.TryGetValue(input, out var local)) values[local] = PrototypeExpr.Val(val, scope);
                    if (popup.List != null && popup.Index != null && inputs.FirstOrDefault().Value is JsonNode keyVal)
                    {
                        var search = (_p.Pt ? "Posicao" : "Position") + popup.Name;
                        var entity = _p.EntityName(popup.Collection!);
                        steps.Add(new JsonObject { ["call"] = "IClientActionSignature:ListIndexOf", ["as"] = search,
                            ["args"] = new JsonObject { ["List"] = popup.List.Name + ".List", ["Condition"] = (PrototypeExpr.TypeOf(keyVal, scope) == "Identifier" ? $"{entity}.{KeyOf(popup.Collection!)}" : $"IdentifierToInteger({entity}.{KeyOf(popup.Collection!)})") + " = " + PrototypeExpr.Val(keyVal, scope) } });
                        values[popup.Index] = search + ".Position";
                    }
                    if (popup.NewRecord != null && _ir.Modal(modal)?["record"]?["new"] is JsonObject fresh)
                    {
                        var entity = _p.Data.ByCollection(popup.Collection!);
                        foreach (var (f, v) in fresh)
                            if (entity?.Fields.FirstOrDefault(x => x.Name == f) is { } field && f != entity.Key)
                                values[$"{popup.NewRecord}.{f}"] = field.References != null ? $"IntegerToIdentifier({PrototypeExpr.Literal(v, "Integer")})" : PrototypeDataModel.FieldLiteral(field, v);
                    }
                    values[popup.IsOpen] = "True";
                    steps.Add(new JsonObject { ["assign"] = values, ["as"] = (_p.Pt ? "Abrir" : "Open") + popup.Name });
                    if (popup.Record != null) steps.Add(new JsonObject { ["node"] = "IRefreshDataNode", ["properties"] = new JsonObject { ["DataSource"] = popup.Record.Alias } });
                    // data.bind: the popup's own source is fetched now, with the inputs just assigned
                    foreach (var (_, alias, _) in owner.DataActions.Where(d => d.OnDemand && d.Source.Owner == "m:" + modal))
                        Refresh([new JsonObject { ["node"] = "IRefreshDataNode", ["properties"] = new JsonObject { ["DataSource"] = alias } }]);
                    break;
                }
                case "call":
                {
                    // data.bind (2.12): the producer's server action, then what the binding says (refresh a source, a feedback message,
                    // the download of a file the action returns)
                    Flush();
                    var action = effect["action"]!.ToString();
                    var args = new JsonObject();
                    foreach (var (input, value) in effect["args"] as JsonObject ?? []) args[input] = value?.ToString();
                    steps.Add(new JsonObject { ["call"] = "IServerAction:" + action, ["as"] = action, ["args"] = args });
                    var outputs = PrototypeCapture.Objects(effect["outputs"]);
                    foreach (var then in (effect["then"] as JsonArray ?? []).Select(t => t!.ToString()))
                    {
                        if (then.StartsWith("refresh ", StringComparison.Ordinal))
                        {
                            var name = then[8..].Trim();
                            foreach (var (_, alias, _) in owner.DataActions.Where(d => d.Source.As.Equals(name, StringComparison.OrdinalIgnoreCase)))
                                Refresh([new JsonObject { ["node"] = "IRefreshDataNode", ["properties"] = new JsonObject { ["DataSource"] = alias } }]);
                        }
                        else if (then.StartsWith("message", StringComparison.Ordinal))
                        {
                            var text = then[7..];
                            var message = text.StartsWith('=') ? text[1..].Trim() : PrototypeExpr.Quote(text.Trim());
                            steps.Add(new JsonObject { ["node"] = "IMessageNode", ["as"] = _p.Pt ? "Confirmacao" : "Feedback", ["properties"] = new JsonObject { ["Message"] = message, ["Type"] = "Success" } });
                        }
                        else if (then == "download")
                        {
                            var file = outputs.FirstOrDefault(o => o["type"]?.ToString() == "Binary Data")?["name"]?.ToString();
                            var fileName = outputs.FirstOrDefault(o => o["type"]?.ToString() == "Text" && (o["name"]?.ToString() ?? "").Contains("Nome", StringComparison.OrdinalIgnoreCase) | (o["name"]?.ToString() ?? "").Contains("Name", StringComparison.OrdinalIgnoreCase))?["name"]?.ToString();
                            var mime = outputs.FirstOrDefault(o => o["type"]?.ToString() == "Text" && (o["name"]?.ToString() ?? "").Contains("Mime", StringComparison.OrdinalIgnoreCase))?["name"]?.ToString();
                            if (file == null) continue;
                            var properties = new JsonObject { ["FileContent"] = action + "." + file, ["FileName"] = fileName != null ? action + "." + fileName : PrototypeExpr.Quote(action + ".pdf"), ["SaveToDisk"] = true };
                            if (mime != null) properties["MimeType"] = action + "." + mime;
                            steps.Add(new JsonObject { ["node"] = "IDownloadNode", ["as"] = _p.Pt ? "Baixar" : "Download", ["properties"] = properties });
                        }
                    }
                    break;
                }
                case "closePopup":
                {
                    var modal = effect["modal"]?.ToString() ?? e["modal"]?.ToString();
                    if (modal == null || !owner.Popups.TryGetValue(modal, out var popup)) break;
                    assign[popup.IsOpen] = "False";
                    break;
                }
                case "toast":
                {
                    if (!owner.DimLocals.TryGetValue("@aviso", out var aviso)) break;
                    if (effect["close"]?.GetValue<bool>() == true) { assign[aviso] = "\"\""; break; }
                    var text = effect["text"] switch
                    {
                        JsonObject t when t.ContainsKey("fmt") => PrototypeExpr.Expr(t, scope),
                        JsonObject t => PrototypeExpr.Val(t, scope),
                        JsonValue s => PrototypeExpr.Quote(s.ToString()),
                        _ => "\"\"",
                    };
                    assign[aviso] = text;
                    assign[owner.DimLocals["@avisoErro"]] = effect["variant"]?.ToString() == "error" ? "True" : "False";
                    break;
                }
                case "navigate":
                {
                    // a hash that names no view (a CSS :target popup, href="#politica") moves nothing natively
                    if (effect["view"] is not JsonValue || !_p.PlanResult.Screens.ContainsKey(effect["view"]!.ToString())) break;
                    var view = effect["view"]!.ToString();
                    var args = new JsonObject();
                    foreach (var (param, val) in effect["params"] as JsonObject ?? []) args[param] = PrototypeExpr.Val(val, scope);
                    destination = new JsonObject { ["node"] = "IDestinationNode", ["properties"] = new JsonObject { ["Destination"] = "IMobileScreen:" + _p.PlanResult.Screens[view] } };
                    if (args.Count > 0) destination["args"] = args;
                    break;
                }
            }
        }
        Flush();
        if (destination != null) steps.Add(destination);
        return steps;
    }

    /// <summary>The scope of a screen action: its inputs (the event parameters), the owner's locals, the popup record of the tree
    /// the event comes from, the outputs of the server call.</summary>
    private PrototypeScope ActionScope(PrototypeOwner owner, JsonObject e, PrototypePopup? popupOverride, IReadOnlyDictionary<string, string>? renames = null)
    {
        var parameters = PrototypeCapture.Objects(e["params"]);
        var popup = popupOverride ?? (e["modal"]?.ToString() is { } m && owner.Popups.TryGetValue(m, out var p) ? p : null);
        var baseScope = popup != null && owner.Kind == "screen" ? _p.PopupScope(owner, popup) : owner.Kind == "block" && owner.Modal != null ? _p.ModalBlockScope(owner) : _p.OwnerScope(owner);
        _server.TryGetValue(e["key"]!.ToString(), out var server);
        return new PrototypeScope
        {
            Dim = baseScope.Dim, DimType = baseScope.DimType, Input = baseScope.Input, View = baseScope.View, Record = baseScope.Record, RecordType = baseScope.RecordType, Count = baseScope.Count,
            Sum = baseScope.Sum, Local = baseScope.Local, First = baseScope.First, FieldType = baseScope.FieldType, ControlType = baseScope.ControlType,
            Field = baseScope.Field,
            Param = name => renames != null && renames.TryGetValue(name, out var final) ? final
                : parameters.Any(x => x["name"]?.ToString() == name) ? name : (baseScope.Param ?? throw new PrototypeExpressionException("parameter " + name))(name),
            ParamType = name => parameters.FirstOrDefault(x => x["name"]?.ToString() == name)?["type"]?.ToString() ?? baseScope.ParamType?.Invoke(name),
            Control = name =>
            {
                // a control bound to a record field is that field; a control of a dimension is the dimension's local
                if (owner.Controls.TryGetValue(name, out var c)) return c.Local;
                var dim = _ir.Dimensions.FirstOrDefault(d => d["name"]?.ToString() == name)?["key"]?.ToString();
                if (dim != null && owner.DimLocals.TryGetValue(dim, out var local)) return local;
                if (baseScope.Field != null) return baseScope.Field(name, null);
                throw new PrototypeExpressionException($"control {name} has no variable in {owner.Name}");
            },
            Inserted = collection => server?.Inserted.TryGetValue(collection, out var output) == true ? $"{server.Name}.{output}" : throw new PrototypeExpressionException($"no record of {collection} is inserted by this event"),
            Updated = field => server?.Updated.TryGetValue(field, out var output) == true ? $"{server.Name}.{output}" : throw new PrototypeExpressionException($"{field} is not returned by this event"),
        };
    }

    // ---- blocks ---------------------------------------------------------------------------------------------------------------

    private (string Event, List<(string Name, string Type)> Params)? BlockEventOf(PrototypeOwner block, JsonObject e)
    {
        var key = e["key"]!.ToString();
        if (block.Modal == null && _ir.Shell != null)
        {
            var declared = PrototypeCapture.Objects(_ir.Shell["events"]).FirstOrDefault(x => x["from"]?.ToString() == key);
            if (declared != null) return block.BlockEvents.FirstOrDefault(b => b.Event == declared["name"]!.ToString());
        }
        return null;
    }

    /// <summary>An event inside a block: its block-local effects, then the trigger of the block event the screens handle (U5).</summary>
    private void BlockEvent(PrototypeOwner block, JsonObject e)
    {
        var key = e["key"]!.ToString();
        var scope = ActionScope(block, e, null);
        var declared = BlockEventOf(block, e);
        var local = new JsonArray();
        var screenEffects = new List<JsonObject>();
        foreach (var effect in PrototypePlanner.Effects(e))
        {
            var kind = effect["kind"]!.ToString();
            if (kind == "setDimension" && block.DimLocals.TryGetValue(effect["dimension"]!.ToString(), out var dl) && block.Inputs.All(i => i.Name != dl))
            {
                var text = PrototypeExpr.Val(effect["value"], scope);
                if (effect["max"] != null) text = $"Min({PrototypeExpr.Val(effect["max"], scope)}, {text})";
                if (effect["min"] != null) text = $"Max({PrototypeExpr.Val(effect["min"], scope)}, {text})";
                if (text != dl) local.Add(new JsonObject { ["assign"] = new JsonObject { [dl] = text }, ["as"] = _p.Pt ? "Definir" : "Set" });
            }
            else screenEffects.Add(effect);
        }
        string? eventName = declared?.Event;
        var eventParams = declared?.Params ?? [];
        if (eventName == null && (screenEffects.Count > 0 || _server.ContainsKey(key)))
        {
            // a modal block: Fechar for a close, else verb + object, with the values the screen needs as parameters
            var first = screenEffects.FirstOrDefault(x => PrototypeCapture.DataEffects.Contains(x["kind"]!.ToString())) ?? screenEffects.FirstOrDefault();
            eventName = first?["kind"]?.ToString() == "closePopup" && screenEffects.Count == 1 ? (_p.Pt ? "Fechar" : "Close") : first != null ? Verb(first["kind"]!.ToString()) + ObjectOf(first) : (_p.Pt ? "Fechar" : "Close");
            if (block.BlockEvents.Any(b => b.Event == eventName)) eventName = block.BlockEvents.First(b => b.Event == eventName).Event;
            else
            {
                eventParams = [];
                if (_server.TryGetValue(key, out var server))
                    foreach (var (inputName, type, _) in server.Inputs) eventParams.Add((inputName, type));
                block.BlockEvents.Add((eventName, eventParams));
                block.LocalNames.Claim(eventName);
            }
        }
        if (eventName != null)
        {
            var args = new JsonObject();
            if (declared != null && eventParams.Count == 1 && PrototypePlanner.Effects(e).FirstOrDefault(x => x["kind"]?.ToString() == "setDimension") is { } set)
                args[eventParams[0].Name] = PrototypeExpr.Val(set["value"], scope);
            else if (_server.TryGetValue(key, out var server))
                foreach (var (inputName, inputType, source) in server.Inputs) if (eventParams.Any(p => p.Name == inputName)) args[inputName] = ToInput(inputType, source, scope);
            var trigger = new JsonObject { ["node"] = "ITriggerNode", ["as"] = (_p.Pt ? "Disparar" : "Trigger") + eventName, ["properties"] = new JsonObject { ["Event"] = $"IMobileBlock:{block.Name}/{eventName}" } };
            if (args.Count > 0) trigger["args"] = args;
            local.Add(trigger);
        }
        if (local.Count == 0)
        {
            // only dimensions bound to their own control: the block re-renders by itself, nothing to compile
            if (PrototypePlanner.Effects(e).All(x => x["kind"]?.ToString() == "setDimension")) { _compiled.Add(key); return; }
            _notCompiled.Add(new JsonObject { ["event"] = key, ["owner"] = block.Name, ["handler"] = e["handler"]?.ToString(), ["why"] = "the event has no effect in the block nor for the screens" });
            return;
        }
        var effects = PrototypePlanner.Effects(e).ToList();
        var firstEffect = effects.First();
        var wanted = eventName != null ? (_p.Pt ? "Notificar" : "Notify") + eventName : Verb(firstEffect["kind"]!.ToString()) + ObjectOf(firstEffect);
        var name = ActionName(block, wanted);
        var parameters = PrototypeCapture.Objects(e["params"]).Select(Param);
        block.Actions.Add(Screen(block, name, $"Event {key} of the prototype in the block {block.Name} (handler {e["handler"]}).", parameters, local.OfType<JsonObject>().Select(s => s.DeepClone().AsObject())));
        block.Bindings[key] = new PrototypeEventBinding(key, null, name, PrototypeCapture.Objects(e["params"]));
        _compiled.Add(key);
    }

    /// <summary>The handlers a screen gives to the events of a block instance (the shell, or a modal block in a popup).</summary>
    private void BlockHandlers(PrototypeOwner screen, PrototypeOwner block, PrototypePopup? popup)
    {
        foreach (var (eventName, eventParams) in block.BlockEvents)
        {
            // the prototype event this block event carries
            JsonObject? e = null;
            if (block.Modal == null && _ir.Shell != null && PrototypeCapture.Objects(_ir.Shell["events"]).FirstOrDefault(x => x["name"]?.ToString() == eventName)?["from"]?.ToString() is { } from) e = _ir.Event(from);
            e ??= block.Bindings.Keys.Select(k => _ir.Event(k)).OfType<JsonObject>().FirstOrDefault(x => BlockEventFor(block, x) == eventName);
            if (e == null) continue;
            try
            {
                var baseScope = ActionScope(screen, e, popup);
                // the handler's parameters never take the name of an input or local of the screen
                string F(string name) => screen.LocalNames.Taken(name) ? name + (_p.Pt ? "Evento" : "Event") : name;
                var single = eventParams.Count == 1 ? F(eventParams[0].Name) : null;
                var scope = new PrototypeScope
                {
                    // a dimension of the block arrives as the event parameter named after it
                    Dim = key => screen.DimLocals.TryGetValue(key, out var local) ? local
                        : _ir.Dimension(key)?["name"]?.ToString() is { } dn && eventParams.Any(p => p.Name == dn) ? F(dn) : baseScope.Dim!(key),
                    DimType = baseScope.DimType, Input = baseScope.Input, View = baseScope.View, Record = baseScope.Record, RecordType = baseScope.RecordType, Count = baseScope.Count,
                    Sum = baseScope.Sum, Local = baseScope.Local, First = baseScope.First, FieldType = baseScope.FieldType, ControlType = baseScope.ControlType,
                    Inserted = baseScope.Inserted, Updated = baseScope.Updated,
                    Field = (f, via) => eventParams.Any(p => p.Name == f) ? F(f) : (baseScope.Field ?? throw new PrototypeExpressionException("field " + f))(f, via),
                    Param = name => eventParams.Any(p => p.Name == name) ? F(name) : baseScope.Param!(name),
                    ParamType = baseScope.ParamType,
                    // the value of the block's control arrives as the event's parameter
                    Control = name => single != null && block.Modal == null ? single : eventParams.Any(p => p.Name == name) ? F(name) : baseScope.Control!(name),
                };
                // the server inputs the block passes are parameters of the handler; the rest come from the screen
                var screenEvent = e.DeepClone().AsObject();
                screenEvent["params"] = new JsonArray(eventParams.Select(p => (JsonNode)new JsonObject { ["name"] = p.Name, ["type"] = p.Type }).ToArray());
                if (_server.TryGetValue(e["key"]!.ToString(), out var server))
                {
                    var bound = new ServerAction { Name = server.Name, EventKey = server.EventKey, Raises = server.Raises, Mapped = server.Mapped, Existing = server.Existing };
                    foreach (var input in server.Inputs) bound.Inputs.Add(eventParams.Any(p => p.Name == input.Name) ? (input.Name, input.Type, new JsonObject { ["param"] = input.Name }) : input);
                    foreach (var o in server.Outputs) bound.Outputs.Add(o);
                    foreach (var (k, v) in server.Inserted) bound.Inserted[k] = v;
                    foreach (var (k, v) in server.Updated) bound.Updated[k] = v;
                    foreach (var w in server.Writes) bound.Writes.Add(w);
                    _server[screenEvent["key"]!.ToString()] = bound;
                    try
                    {
                        var (name, declaration) = ScreenAction(screen, OnlyScreenEffects(screenEvent, block), scope, eventParams.Select(p => new JsonObject { ["name"] = F(p.Name), ["type"] = p.Type }), popup);
                        screen.Actions.Add(declaration);
                        Wire(screen, block, popup, eventName, name, eventParams.Select(p => (p.Name, F(p.Name))).ToList());
                    }
                    finally { _server[screenEvent["key"]!.ToString()] = server; }
                }
                else
                {
                    var (name, declaration) = ScreenAction(screen, OnlyScreenEffects(screenEvent, block), scope, eventParams.Select(p => new JsonObject { ["name"] = F(p.Name), ["type"] = p.Type }), popup);
                    screen.Actions.Add(declaration);
                    Wire(screen, block, popup, eventName, name, eventParams.Select(p => (p.Name, F(p.Name))).ToList());
                }
            }
            catch (PrototypeExpressionException ex) { _notCompiled.Add(new JsonObject { ["event"] = e["key"]?.ToString(), ["owner"] = screen.Name, ["why"] = ex.Message }); }
        }
    }

    private string? BlockEventFor(PrototypeOwner block, JsonObject e)
        => block.Actions.Any(a => a["description"]?.ToString()?.Contains("Event " + e["key"] + " ", StringComparison.Ordinal) == true)
            ? block.Actions.Where(a => a["description"]!.ToString().Contains("Event " + e["key"] + " ", StringComparison.Ordinal))
                .SelectMany(a => a["steps"] as JsonArray ?? []).OfType<JsonObject>().Where(s => s["node"]?.ToString() == "ITriggerNode")
                .Select(s => s["properties"]!["Event"]!.ToString().Split('/').Last()).FirstOrDefault()
            : null;

    /// <summary>The effects a screen handler keeps: everything except what the block did itself (its local dimensions).</summary>
    private JsonObject OnlyScreenEffects(JsonObject e, PrototypeOwner block)
    {
        JsonArray Keep(JsonArray effects) => new(effects.OfType<JsonObject>()
            .Where(x => !(x["kind"]?.ToString() == "setDimension" && block.DimLocals.TryGetValue(x["dimension"]!.ToString(), out var dl) && block.Inputs.All(i => i.Name != dl)))
            .Select(x => (JsonNode)x.DeepClone()).ToArray());
        var copy = e.DeepClone().AsObject();
        copy["effects"] = Keep(e["effects"] as JsonArray ?? []);
        if (e["cases"] is JsonArray cases)
            copy["cases"] = new JsonArray(cases.OfType<JsonObject>().Select(c => (JsonNode)new JsonObject { ["when"] = c["when"]?.DeepClone(), ["effects"] = Keep(c["effects"] as JsonArray ?? []) }).ToArray());
        return copy;
    }

    private void Wire(PrototypeOwner screen, PrototypeOwner block, PrototypePopup? popup, string eventName, string action, List<(string Param, string Input)> parameters)
    {
        var instance = popup == null ? _p.ShellInstance(screen) : "$p.inst." + PrototypePlanner.Safe(screen.View!) + "." + PrototypePlanner.Safe(popup.Modal);
        screen.Wiring.Add(PrototypePlanner.Set(instance + "/" + eventName, "Handler", screen.Ref + "/" + action));
        foreach (var (param, input) in parameters) screen.Wiring.Add(PrototypePlanner.Set(instance + "/" + eventName + "/" + input, "Value", param));
    }

    /// <summary>A modal block resets the dimensions the opening event sets (the first option for the record) when its record
    /// arrives: an Assign in the OnAfterFetch of the record aggregate (not a lifecycle event; no server call).</summary>
    private void ModalBlockReset(PrototypeOwner block)
    {
        if (block.Inputs.Count == 0) return;
        var assign = new JsonObject();
        var scope = _p.ModalBlockScope(block);
        foreach (var e in _ir.Events.Where(x => PrototypePlanner.Effects(x).Any(f => f["kind"]?.ToString() == "openPopup" && f["modal"]?.ToString() == block.Modal)))
            foreach (var effect in PrototypePlanner.Effects(e).Where(f => f["kind"]?.ToString() == "setDimension"))
                if (block.DimLocals.TryGetValue(effect["dimension"]!.ToString(), out var local) && block.Inputs.All(i => i.Name != local))
                {
                    try { assign[local] = PrototypeExpr.Val(effect["value"], scope); }
                    catch (PrototypeExpressionException ex) { _notCompiled.Add(new JsonObject { ["event"] = e["key"]?.ToString(), ["owner"] = block.Name, ["why"] = ex.Message }); }
                }
        if (assign.Count == 0) return;
        var name = ActionName(block, _p.Pt ? "AoReceberRegistro" : "OnRecordReceived");
        block.Actions.Add(Screen(block, name, $"Resets the dimensions of the modal {block.Modal} for the record shown (only Assign).", [], [new JsonObject { ["assign"] = assign, ["as"] = _p.Pt ? "Reiniciar" : "Reset" }]));
        block.Wiring.Add(PrototypePlanner.Set(block.Ref + "/OnInitialize", "Destination", block.Ref + "/" + name));
        block.Wiring.Add(PrototypePlanner.Set(block.Ref + "/OnParametersChanged", "Destination", block.Ref + "/" + name));
    }

    /// <summary>All server action declarations, in a stable order.</summary>
    public IEnumerable<JsonObject> ServerDeclarations() => _server.Values.Where(s => s.Mapped == null && s.Declaration["name"] != null).GroupBy(s => s.Name).Select(g => g.First().Declaration).OrderBy(d => d["name"]!.ToString(), StringComparer.Ordinal);
}
