using System.Collections;
using System.Diagnostics;
using System.Text.Json.Nodes;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// screen {data:{generate:{...}}}: screens from entities and blocks (ScreenGenerator, gen-screen/1). The module's data model,
/// actions, blocks and screens are read here (GenModule); the planner writes the documents and the flow texts; they are
/// compiled as a job of their own would compile them: every block and screen document by the document form of the html op,
/// then every flow text by the logic op, in one pass, so a screen action is a shell before its document's events bind and
/// a navigation finds every screen. Nothing of the job's own ops changes; the receipt lists everything it created.
/// </summary>
public sealed partial class ModelSession
{
    private JsonNode GenerateScreens(JsonObject op)
    {
        var watch = Stopwatch.StartNew();
        var data = op["data"]!.AsObject();
        // The pointers of a refusal are relative to the op's data: the apply rebases them onto the op (/ops/<i>/data).
        var pointer = "";
        var module = ReadGenModule();
        var readMs = watch.ElapsedMilliseconds;
        // The developer's view of what the generator read (the corpus harness picks its entities from it); never on by default.
        if (Environment.GetEnvironmentVariable("SSAM_GEN_SCREEN_FACTS") is { Length: > 0 } factsFile)
            File.WriteAllText(factsFile, System.Text.Json.JsonSerializer.Serialize(module, new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
        var plan = ScreenGenerator.Plan(data, module, pointer);
        var receipt = plan.Receipt;
        var timings = new JsonObject { ["readMs"] = readMs, ["planMs"] = watch.ElapsedMilliseconds - readMs };
        receipt["timings"] = timings;
        if (plan.Create.Count == 0)
        {
            timings["totalMs"] = watch.ElapsedMilliseconds;
            return new JsonObject { ["generate"] = receipt, ["noChange"] = true };
        }
        // The job of the generated roots: the blocks, then the screens (documents never name each other), then one logic op with
        // every flow text (the screen and block actions fill the shells the documents made; the data actions are created).
        var ops = new JsonArray();
        foreach (var root in plan.Create.Where(r => r.Kind == "block").Concat(plan.Create.Where(r => r.Kind == "screen")))
            ops.Add(new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = root.Html } });
        var flows = plan.Create.SelectMany(r => r.Flows).ToList();
        if (flows.Count > 0) ops.Add(new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray(flows.Select(f => (JsonNode)f).ToArray()) } });
        var (savedOps, savedIndex) = (_applyOps, _applyIndex);
        var flowTexts = FlowTextsWritten.Count;
        var compiled = new JsonArray();
        try
        {
            for (var i = 0; i < ops.Count; i++)
            {
                var generated = ops[i]!.AsObject();
                _applyOps = ops; _applyIndex = i;
                try
                {
                    var result = ApplyOne(generated);
                    var root = result?["root"]?.ToString();
                    compiled.Add(new JsonObject { ["op"] = generated["op"]!.ToString(), ["root"] = root, ["key"] = result?["key"]?.DeepClone(), ["widgets"] = result?["widgets"]?.DeepClone() });
                }
                catch (KernelRefusalException refusal)
                {
                    // A generated text the compile refuses is a defect of the generator (its family rule), never the request's: the
                    // refusal names the root and carries the compile's problems, with the text, so the defect is reproducible.
                    var what = generated["op"]!.ToString() == "html" ? "the document of " + RootName(generated) : "the flow texts";
                    var problems = new JsonArray((refusal.Problems ?? new JsonArray()).Select(p => p?.DeepClone()).ToArray());
                    foreach (var p in problems.OfType<JsonObject>()) { p["generated"] = what; p["ssamDefect"] = true; }
                    throw new KernelRefusalException("GEN_SCREEN_COMPILE", $"screen generate: {what} did not compile ({refusal.Code}: {refusal.Message}); a defect of the generator (gen-screen/1), not of the request",
                        problems);
                }
                catch (Exception error)
                {
                    var what = generated["op"]!.ToString() == "html" ? "the document of " + RootName(generated) : "the flow texts";
                    throw new InvalidOperationException($"screen generate: {what} failed: {Unwrap(error)} (a defect of the generator gen-screen/1, not of the request)", error);
                }
            }
        }
        finally
        {
            (_applyOps, _applyIndex) = (savedOps, savedIndex);
            // The flow texts of the generated job are not texts of this job's ops (the patch round reads those by op index).
            if (FlowTextsWritten.Count > flowTexts) FlowTextsWritten.RemoveRange(flowTexts, FlowTextsWritten.Count - flowTexts);
        }
        receipt["compiled"] = compiled;
        timings["compileMs"] = watch.ElapsedMilliseconds - readMs - timings["planMs"]!.GetValue<long>();
        timings["totalMs"] = watch.ElapsedMilliseconds;
        Report("generatedScreens", new JsonObject { ["created"] = plan.Create.Count, ["unchanged"] = plan.Unchanged.Count, ["roots"] = new JsonArray(plan.Create.Select(r => (JsonNode)(r.Kind + ":" + r.Name)).ToArray()) });
        return new JsonObject { ["generate"] = receipt };
    }

    private static string RootName(JsonObject op)
    {
        var html = op["data"]?["html"]?.ToString() ?? "";
        var m = System.Text.RegularExpressions.Regex.Match(html, "^<(screen|block) name=\"([^\"]+)\"");
        return m.Success ? m.Groups[1].Value + " " + m.Groups[2].Value : "a root";
    }

    // ---- the facts ---------------------------------------------------------------------------------------------------------
    private static string KindOf(object o) => ModelHost.Kind((o as IObjectSignature)?.GetInterface()?.Name ?? o.GetType().Name);
    private static string NameOfElement(object o) => TypeResolver.Name(o) ?? ModelHost.Prop(o, "Name")?.ToString() ?? "";
    private static IEnumerable<object> SequenceOf(object? value, string property) => value != null && ModelHost.Prop(value, property) is IEnumerable s and not string ? s.Cast<object>().Where(x => x != null) : [];
    private static bool Flag(object o, string property) => ModelHost.Prop(o, property) is { } v && (v is true || v.ToString() is "True" or "Yes");

    /// <summary>What the generator reads of this module: its entities (and its references'), the actions it can call, the
    /// blocks it can show, its UI flows, screens and blocks, and every top-level name.</summary>
    public GenModule ReadGenModule()
    {
        var espace = (IObjectSignature)_espace;
        var lane = MessageExpectations.Lane;
        var type = _espace.ESpaceType.ToString();
        var runtime = type is "CrossDevice" or "Reactive" ? "Reactive" : type is "Mobile" ? "Mobile" : type.Contains("Library", StringComparison.OrdinalIgnoreCase) ? "Library" : type;
        var entities = new List<GenEntity>();
        var actions = new List<GenAction>();
        var blocks = new List<GenBlock>();
        var roots = new List<GenRootFact>();
        var flows = new List<string>();
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var roleRefs = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var locals = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        void Top(IObjectSignature o, string? producer)
        {
            var kind = KindOf(o);
            var name = NameOfElement(o);
            if (producer == null && name.Length > 0) names.Add(name);
            if (kind is "Role" or "RoleSignature" && name.Length > 0) roleRefs.TryAdd(name, kind + ":" + name);
            switch (kind)
            {
                case "ServerEntity" or "StaticEntity" or "Entity" or "ServerEntitySignature" or "StaticEntitySignature" or "EntitySignature":
                    if (GenEntityOf(o, kind, producer) is { } e) entities.Add(e);
                    break;
                case "ServerAction" or "ServiceAction" or "ServerActionSignature" or "ServiceActionSignature":
                    actions.Add(new GenAction(name, kind.StartsWith("Service", StringComparison.Ordinal) ? "service" : "server", producer,
                        SequenceOf(o, "InputParameters").Select(GenParamOf).ToList(), SequenceOf(o, "OutputParameters").Select(GenParamOf).ToList()));
                    break;
                case "MobileBlockSignature":
                    blocks.Add(GenBlockOf(o, kind, producer));
                    break;
                case "MobileFlow":
                    if (producer != null) break;
                    flows.Add(name);
                    foreach (var child in o.Children.OfType<IObjectSignature>())
                    {
                        var ck = KindOf(child);
                        if (ck is not ("MobileScreen" or "MobileBlock")) continue;
                        var cn = NameOfElement(child);
                        names.Add(cn);
                        // The names of its screen and data actions: a module action of the same name makes a call ambiguous.
                        foreach (var action in child.Children.OfType<IObjectSignature>())
                            if (KindOf(action) is "ScreenAction" or "DataAction" && NameOfElement(action) is { Length: > 0 } an) locals.Add(an);
                        if (ck == "MobileBlock") blocks.Add(GenBlockOf(child, ck, null));
                        var layout = child.Children.OfType<IObjectSignature>().FirstOrDefault(w => KindOf(w) == "MobileBlockInstanceWidget") is { } instance
                            && ModelHost.Prop(instance, "SourceBlock") is { } source ? NameOfElement(source) : null;
                        var roleList = SequenceOf(child, "Roles").ToList();
                        var anonymous = Flag(child, "AnonymousAccess") || roleList.Any(r => NameOfElement(r).Equals("Anonymous", StringComparison.OrdinalIgnoreCase));
                        var roles = string.Join(", ", roleList.Select(r => KindOf(r) + ":" + NameOfElement(r)).Order(StringComparer.Ordinal));
                        roots.Add(new GenRootFact(ck == "MobileScreen" ? "screen" : "block", cn, ModelHost.Prop(child, "Description")?.ToString(), layout,
                            roles.Length > 0 ? roles : null, name, anonymous));
                    }
                    break;
            }
        }
        foreach (var o in espace.Children.OfType<IObjectSignature>())
        {
            if (KindOf(o) == "Reference")
            {
                var producer = NameOfElement(o);
                foreach (var signature in o.Children.OfType<IObjectSignature>()) Top(signature, producer);
                continue;
            }
            Top(o, null);
        }
        return new GenModule(NameOfElement(espace), lane, runtime, entities, actions, blocks, roots, flows, names, roleRefs, locals);
    }

    /// <summary>The facts of a module file (loaded, read, released): what a corpus run picks its entities from.</summary>
    public static GenModule ReadGenModule(ModelHost host, byte[] oml)
    {
        var espace = host.Load(oml);
        try { return new ModelSession(espace).ReadGenModule(); }
        finally { ModelHost.Release(espace); }
    }

    private static GenParam GenParamOf(object p) => new(NameOfElement(p), UiCatalog.TypeName(ModelHost.Prop(p, "DataType")), Flag(p, "IsMandatory"));

    private static GenEntity? GenEntityOf(IObjectSignature e, string kind, string? producer)
    {
        var name = NameOfElement(e);
        if (name.Length == 0) return null;
        var isStatic = kind.StartsWith("Static", StringComparison.Ordinal) || Flag(e, "IsStaticEntity");
        var identifier = ModelHost.Prop(e, "IdentifierAttribute") is { } id ? NameOfElement(id) : "Id";
        var attributes = new List<GenAttribute>();
        foreach (var a in SequenceOf(e, "Attributes"))
        {
            var dataType = ModelHost.Prop(a, "DataType");
            string? target = dataType is OutSystems.Model.Types.IIdentifierType it ? TypeResolver.Name(it.Entity) : null;
            var length = ModelHost.Prop(a, "Length") is { } l && int.TryParse(l is IExpression le ? le.Text : l.ToString(), out var n) ? n : 0;
            var label = ModelHost.Prop(a, "Label") as string;
            attributes.Add(new GenAttribute(NameOfElement(a), UiCatalog.TypeName(dataType), Flag(a, "IsMandatory"), length, Flag(a, "IsAutoNumber"), target,
                string.IsNullOrWhiteSpace(label) ? null : label));
        }
        // Writable: its entity actions are here (the module's own entity, or a reference that does not expose it read-only).
        var actionNames = e.Children.OfType<IObjectSignature>().Where(c => KindOf(c).Contains("EntityAction", StringComparison.Ordinal)).Select(NameOfElement).ToList();
        var writable = !isStatic && (producer == null
            ? true
            : actionNames.Any(n => n.StartsWith("CreateOrUpdate", StringComparison.Ordinal)) && !Flag(e, "ExposeReadOnly"));
        var labelAttribute = ModelHost.Prop(e, "LabelAttribute") is { } la ? NameOfElement(la) : null;
        var order = ModelHost.Prop(e, "OrderByAttribute") is { } ob ? NameOfElement(ob) : null;
        var entityLabel = ModelHost.Prop(e, "Label") as string;
        return new GenEntity(name, producer, isStatic, identifier, name + " Identifier", attributes, writable,
            string.IsNullOrEmpty(labelAttribute) ? null : labelAttribute, string.IsNullOrEmpty(order) ? null : order,
            string.IsNullOrWhiteSpace(entityLabel) || entityLabel == name ? null : entityLabel);
    }

    private static GenBlock GenBlockOf(IObjectSignature b, string kind, string? producer)
    {
        var name = NameOfElement(b);
        var inputs = SequenceOf(b, "InputParameters").Select(GenParamOf).ToList();
        var events = SequenceOf(b, "Events").Select(e => new GenEvent(NameOfElement(e), Flag(e, "IsMandatory"), SequenceOf(e, "InputParameters").Select(GenParamOf).ToList())).ToList();
        var placeholders = b.GetAllDescendantsOfType<IObjectSignature>()
            .Where(o => o.GetType().GetInterfaces().Any(i => i.Name is "IPlaceholderWidgetSignature" or "IPlaceholderWidget"))
            .Select(NameOfElement).Where(n => n.Length > 0).Distinct(StringComparer.Ordinal).ToList();
        return new GenBlock(name, kind + ":" + name, producer, inputs, events, placeholders, ModelHost.Prop(b, "Description")?.ToString());
    }
}
