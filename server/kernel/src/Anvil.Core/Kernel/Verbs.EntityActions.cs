using System.Text.Json.Nodes;
using Anvil.Reading;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// The op `entity-actions` (EntityActionsExpander): the module's data model is read as its data text (DataDdl, the same reading
/// `ssam_map view:"ddl"` serves), the expander plans the texts, the exceptions and the row structures, and they are written by
/// the verbs the other forms use: create (exceptions), spec (structures) and the logic op's text form (the actions, each read
/// back as its text). Nothing of an existing action is ever overwritten.
/// </summary>
public sealed partial class ModelSession
{
    private JsonNode EntityActions(JsonObject op)
    {
        var data = op["data"] as JsonObject ?? new JsonObject();
        var problems = EntityActionsExpander.Validate(data);
        if (problems.Count > 0) throw EntityActionsRefusal(problems);
        var clock = System.Diagnostics.Stopwatch.StartNew();
        var model = EntityActionsModel();
        problems = EntityActionsExpander.CheckAgainstModel(data, model);
        if (problems.Count > 0) throw EntityActionsRefusal(problems);
        var plan = EntityActionsExpander.Expand(data, model);
        var readMs = clock.ElapsedMilliseconds;
        foreach (var step in plan.Ops)
        {
            ApplyOne(step);
            // The description of an exception, where the lane writes one (an ODC user exception has none).
            if (step["op"]?.ToString() == "create" && step["type"]?.ToString() == "IUserException" && plan.Exceptions.OfType<JsonObject>().FirstOrDefault(x => x["name"]?.ToString() == step["name"]?.ToString())?["description"] is JsonValue description)
            {
                var exception = Resolve(step["as"]!.ToString());
                if (FindProperty(exception, "Description") is { CanWrite: true })
                    ApplyOne(new JsonObject { ["op"] = "set", ["target"] = step["as"]!.DeepClone(), ["prop"] = "Description", ["value"] = description.DeepClone() });
            }
        }
        var created = new JsonArray();
        if (plan.Create.Count > 0)
        {
            JsonNode? written;
            try { written = ApplyOne(new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray(plan.Create.Select(g => (JsonNode)g.Text).ToArray()) } }); }
            catch (KernelRefusalException refusal)
            {
                // A generated text the text form refuses is a defect of the generator, never of the job: the refusal says which.
                var list = new JsonArray();
                foreach (var problem in refusal.Problems?.OfType<JsonObject>() ?? [])
                {
                    var copy = problem.DeepClone().AsObject();
                    var at = copy["pointer"]?.ToString() ?? "";
                    if (at.StartsWith("/flow/", StringComparison.Ordinal) && int.TryParse(at["/flow/".Length..].Split('/')[0], out var index) && index < plan.Create.Count)
                        copy["generated"] = plan.Create[index].Name;
                    copy["pointer"] = "/data";
                    copy["ssamDefect"] = true;
                    list.Add(copy);
                }
                throw new KernelRefusalException(refusal.Code, "entity-actions: a generated text was refused (a defect of the SSAM, nothing to change in the job): " + refusal.Message, list);
            }
            var results = written?["flow"] as JsonArray ?? new JsonArray();
            for (var i = 0; i < plan.Create.Count; i++)
            {
                var g = plan.Create[i];
                created.Add(new JsonObject
                {
                    ["name"] = g.Name, ["kind"] = g.Kind == "ServerAction" ? "server" : "service", ["entity"] = g.Entity, ["role"] = g.Role, ["public"] = g.Public,
                    ["key"] = results.ElementAtOrDefault(i)?["key"]?.DeepClone(),
                });
            }
        }
        var report = new JsonObject
        {
            ["entities"] = new JsonArray(plan.Create.Concat(plan.Unchanged).Select(g => g.Entity).Distinct(StringComparer.Ordinal).Select(e => (JsonNode)e).ToArray()),
            ["created"] = created,
            ["unchanged"] = new JsonArray(plan.Unchanged.Select(g => (JsonNode)g.Name).ToArray()),
            ["kept"] = plan.Kept.Count > 0 ? plan.Kept : null,
            ["skipped"] = plan.Skipped.Count > 0 ? plan.Skipped : null,
            ["exceptions"] = plan.Exceptions.Count > 0 ? plan.Exceptions : null,
            ["structures"] = plan.Structures.Count > 0 ? plan.Structures : null,
            ["notes"] = plan.Notes.Count > 0 ? plan.Notes : null,
            ["ms"] = new JsonObject { ["read"] = readMs, ["total"] = clock.ElapsedMilliseconds },
        };
        Report("entityActions", new JsonObject { ["created"] = created.Count, ["unchanged"] = plan.Unchanged.Count, ["kept"] = plan.Kept.Count });
        var answer = new JsonObject { ["entityActions"] = report };
        if (plan.NoChange) { answer["noChange"] = true; answer["code"] = "NO_CHANGE"; }
        return answer;
    }

    private static KernelRefusalException EntityActionsRefusal(List<JsonObject> problems)
    {
        var code = problems.Select(p => p["code"]?.ToString()).FirstOrDefault(c => c != "ENTITY_ACTIONS_INVALID") ?? "ENTITY_ACTIONS_INVALID";
        return new KernelRefusalException(code, "entity-actions: " + problems.Count + " problem(s), all reported at once: " + string.Join(" | ", problems.Select(p => p["message"]?.ToString())),
            new JsonArray(problems.Select(p => (JsonNode)JobPreflight.PublicProblem(p)).ToArray()));
    }

    /// <summary>What the expander reads of this module: the data text's entities, structures and indexes, the entities its
    /// references name, the module actions (each read as its text, ids stripped) and the names of its other top elements.</summary>
    internal EntityActionsExpander.Model EntityActionsModel()
    {
        var lane = MessageExpectations.Lane;
        var reader = new KernelModelReader();
        var root = (IObjectSignature)_es;
        var document = DdlParser.Parse(DataDdl.Build(root, reader, lane, "", 0).Text, lane);
        var model = new EntityActionsExpander.Model { Lane = lane, OdcApplication = OdcApplicationKind() != null };
        var own = new Dictionary<string, DdlElement>(StringComparer.OrdinalIgnoreCase);
        foreach (var element in document.Elements.Where(e => DdlRules.IsEntityKind(e.Kind) && e.Name.Length > 0)) own.TryAdd(element.Name, element);
        static string? Prop(DdlElement e, string name) => e.Props.TryGetValue(name, out var value) ? value : null;
        foreach (var element in own.Values.Where(e => e.Kind == "ServerEntity"))
        {
            var attributes = element.Children.Where(c => c.Kind == "EntityAttribute").Select(c => new EntityActionsExpander.Attribute(c.Name, Prop(c, "DataType") ?? "Text",
                Prop(c, "IsMandatory") == "True", int.TryParse(Prop(c, "Length"), out var length) ? length : null, c.References, Prop(c, "DeleteRule"), Prop(c, "IsAutoNumber") == "Yes")).ToList();
            // An index statement is a child of the entity it names (DdlParser.Attach).
            var entityIndexes = element.Children.Where(c => c.Kind == "EntityIndex").Select(i => new EntityActionsExpander.Index(i.Name, Prop(i, "Unique") == "True", i.Columns.ToList())).ToList();
            model.Entities.Add(new EntityActionsExpander.Entity(element.Name, element.Kind, Prop(element, "Public") == "True", Prop(element, "Identifier"), attributes, entityIndexes,
                Prop(element, "LabelAttribute"), Prop(element, "IsActiveAttribute")));
        }
        foreach (var structure in document.Elements.Where(e => e.Kind == "Structure" && e.Name.Length > 0))
            model.Structures.Add((structure.Name, structure.Children.Where(c => c.Name.Length > 0).Select(c => (c.Name, Prop(c, "DataType") ?? "")).ToList()));
        model.Reference = name =>
        {
            if (own.TryGetValue(name, out var element))
                return new(true, element.Kind == "StaticEntity", Prop(element, "Public") == "True", Prop(element, "Identifier") ?? "Id", true);
            var signature = TypeResolver.FindEntitySignature(_espace, name);
            if (signature == null) return new(false, false, false, "Id", false);
            var isStatic = Implements(signature, "IStaticEntity") || Implements(signature, "IStaticEntitySignature");
            var identifier = ModelHost.Prop(signature, "IdentifierAttribute") is IObjectSignature id ? TypeResolver.Name(id) ?? "Id" : "Id";
            return new(true, isStatic, true, identifier, false);
        };
        // The module's own actions and other top elements, by name (any case).
        var actions = new Dictionary<string, IObjectSignature>(StringComparer.OrdinalIgnoreCase);
        var tops = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var child in reader.ChildrenOf(root))
        {
            if (child.WasDeleted || reader.NameOf(child) is not { Length: > 0 } name) continue;
            var kind = reader.KindOf(child);
            if (ModuleFlow.ActionKinds.Contains(kind)) actions.TryAdd(name, child);
            else if (Implements(child, "IUserException")) tops.TryAdd(name, "UserException");
            else if (!Implements(child, "IReference") && kind.Length > 0) tops.TryAdd(name, kind);
        }
        HashSet<string>? scope = null;
        model.Existing = name =>
        {
            if (actions.TryGetValue(name, out var action))
            {
                var kind = reader.KindOf(action);
                try
                {
                    var item = ModuleFlow.Extract(root, reader, action, out var found);
                    var read = ModuleFlow.Print(item);
                    var fixedPoint = found.Count == 0 && read.Unprintable.Count == 0;
                    return new(kind, fixedPoint ? EntityActionsExpander.Strip(read.Text) : null, action.ObjectKey?.ToString(), fixedPoint ? ModuleFlow.TextSha(read.Text) : null);
                }
                catch (Exception error) when (error is InvalidOperationException or KeyNotFoundException or NotSupportedException or ArgumentException or NullReferenceException)
                { return new(kind, null, action.ObjectKey?.ToString(), null); }
            }
            if (tops.TryGetValue(name, out var top)) return new(top, null, null, null);
            return (scope ??= ScopeNames()).Contains(name) ? new("Action", null, null, null) : null;
        };
        model.TopElement = name => tops.TryGetValue(name, out var kind) ? kind : actions.TryGetValue(name, out var action) ? reader.KindOf(action) : null;
        return model;
    }
}
