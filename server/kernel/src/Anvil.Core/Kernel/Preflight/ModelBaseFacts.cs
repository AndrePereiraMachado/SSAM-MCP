using System.Text.Json.Nodes;
using OutSystems.Model;

namespace Anvil.Core.Preflight;

/// <summary>
/// The base module as the A02/A04 rules read it in JobRunner.CheckAgainstBase: through the same ModelSession.Resolve the
/// verbs use, before the first op. Every answer that cannot be read is "unknown" (null or false), never a refusal.
/// </summary>
internal sealed class ModelBaseFacts(ModelSession session, ServiceStudio.Model.ESpace espace) : IBaseFacts
{
    private static readonly string[] RecordKinds = ["IServerEntity", "IEntitySignature", "IStaticEntity", "IStaticEntitySignature",
        "IClientEntity", "IClientEntitySignature", "IStructure", "IStructureSignature"];
    private HashSet<string>? _names;
    private HashSet<string>? _functions;
    private readonly Dictionary<string, IReadOnlyDictionary<string, string>?> _records = new(StringComparer.OrdinalIgnoreCase);

    public ActionNameFact? ActionNameTaken(string name) => ActionNameTaken(name, "server");

    public ActionNameFact? ActionNameTaken(string name, string kind)
    {
        var element = ActionElement(name, kind);
        return element == null ? null : DescribeAction(element);
    }

    internal IObjectSignature? ActionElement(string name, string kind = "server")
        => Index().TryGetValue(name, out var named) ? named.FirstOrDefault(e => InActionScope(e) && ScopeOf(e) == ActionNameRules.Scope(kind)) : null;

    internal IReadOnlyList<ActionNameFact> ActionNames()
        => Index().Values.SelectMany(v => v).Where(InActionScope).Select(DescribeAction).Distinct().ToArray();

    private static ActionNameFact DescribeAction(IObjectSignature element)
        => new(element.GetInterface()?.Name ?? "IActionSignature", TypeResolver.Name(element) ?? "",
            element.Parent is IObjectSignature owner ? TypeResolver.Name(owner) ?? owner.GetInterface()?.Name ?? "module" : "module", ScopeOf(element));

    internal static string ScopeOf(IObjectSignature element)
    {
        // Generated entity actions expose action interfaces for both execution sides. Their owning entity decides
        // the naming scope; interface inheritance alone would classify server CRUD actions as client actions.
        if (ModelSession.Implements(element, "IEntityActionSignature"))
        {
            for (var p = element.Parent as IObjectSignature; p != null; p = p.Parent as IObjectSignature)
            {
                // O11's concrete Entity implements server, client and static interfaces at once; its native flag is
                // the discriminant (the corpus oracle observes IsClientEntity=false on server/static owners).
                if (ModelHost.Prop(p, "IsClientEntity") is bool clientEntity) return clientEntity ? "client" : "server";
                var parentKind = p.GetInterface()?.Name;
                if (parentKind is "IClientEntity" or "IClientEntitySignature") return "client";
                if (parentKind is "IServerEntity" or "IServerEntitySignature" or "IStaticEntity" or "IStaticEntitySignature" or "IEntitySignature") return "server";
            }
            return ModelHost.Prop(element, "IsInsideClientSide") is true ? "client" : "server";
        }
        var kind = element.GetInterface()?.Name;
        if (kind is "IServerAction" or "IServerActionSignature" or "IServiceAction" or "IServiceActionSignature" or "IExtensionActionSignature") return "server";
        if (ModelSession.Implements(element, "IClientAction") || ModelSession.Implements(element, "IClientActionSignature")) return "client";
        return "server";
    }

    private static bool InActionScope(IObjectSignature element)
    {
        if (ModelHost.Prop(element, "WasDeleted") is true) return false;
        if (!(ModelSession.Implements(element, "IEntityActionSignature") || ModelSession.Implements(element, "IServerAction")
            || ModelSession.Implements(element, "IServiceAction") || ModelSession.Implements(element, "IClientAction")
            || ModelSession.Implements(element, "IServerActionSignature") || ModelSession.Implements(element, "IClientActionSignature")
            || ModelSession.Implements(element, "IServiceActionSignature") || ModelSession.Implements(element, "IExtensionActionSignature"))) return false;
        for (var parent = element.Parent as IObjectSignature; parent != null; parent = parent.Parent as IObjectSignature)
            if (new[] { "IMobileScreen", "IMobileBlock", "IWebScreen", "IWebBlock", "IEmail", "IScreenAction" }.Any(k => ModelSession.Implements(parent, k)))
                // A client screen action occupies the global client-action name scope too (native oracle); a server
                // screen action remains local and does not occupy the module's server-action scope.
                return ScopeOf(element) == "client" && ModelHost.Prop(element, "IsInsideClientSide") is true;
        return true;
    }

    public string? ModuleType
    {
        get { try { return espace.ESpaceType.ToString(); } catch { return null; } }
    }

    public bool HasName(string name)
    {
        if (_names == null)
        {
            try { _names = session.NamesOfType("").ToHashSet(StringComparer.OrdinalIgnoreCase); }
            catch { return true; }   // unreadable: every name may exist
        }
        return _names.Contains(name) || IsFunction(name);
    }

    private static readonly string[] ColumnKinds = ["IGroupByAttribute", "IAggregateAttribute", "IAggregatedAttribute", "ICalculatedAttribute"];

    public RawExpressionFact? RawExpression(string target, string prop)
    {
        object? element;
        try { element = session.Resolve(target); }
        catch { return null; }
        if (element is not IObjectSignature owner) return null;
        // An expression property: read-only IExpression (O11, its Text is written) or a parsed ExpressionDefinition (ODC).
        var property = ModelApiMetadata.Properties(owner.GetType()).FirstOrDefault(p => p.Name == prop);
        if (property == null || !(typeof(IExpression).IsAssignableFrom(property.PropertyType)
            || (property.PropertyType.FullName ?? "").Contains("ExpressionDefinition", StringComparison.Ordinal))) return null;
        for (IObjectSignature? p = owner; p != null; p = p.Parent as IObjectSignature)
        {
            if (!ModelSession.Implements(p, "IAggregate")) continue;
            var below = p.GetAllDescendantsOfType<IObjectSignature>().ToArray();
            var sources = below.Where(d => ModelSession.Implements(d, "IAliasedSource")).Select(d => TypeResolver.Name(d)).OfType<string>().Where(n => n.Length > 0).Distinct().ToArray();
            var columns = below.Where(d => ColumnKinds.Any(k => ModelSession.Implements(d, k))).Select(d => TypeResolver.Name(d)).OfType<string>().Where(n => n.Length > 0).Distinct().ToArray();
            return new RawExpressionFact(TypeResolver.Name(p) ?? "aggregate", sources, columns, ModelHost.Prop(p, "IsClientSide") is true);
        }
        return new RawExpressionFact(null, [], [], false);
    }

    public bool NamesOnlyTypes(string name)
    {
        try
        {
            var named = Index().TryGetValue(name, out var list) ? list : [];
            return named.Count > 0 && named.All(o => RecordKinds.Any(kind => ModelSession.Implements(o, kind)));
        }
        catch { return false; }
    }

    public string? GlobalOf(string name)
    {
        // Through the session's Resolve, as a `set` on ISiteProperty:<Name> finds it (the descendants index leaves them out).
        foreach (var (kind, qualifier) in new[] { ("ISiteProperty", "Site"), ("ISetting", "Settings") })
        {
            try
            {
                if (session.Resolve(kind + ":" + name) is IObjectSignature found && (ModelSession.Implements(found, kind) || ModelSession.Implements(found, kind + "Signature")))
                    return qualifier;
            }
            catch { /* not one of these */ }
        }
        return null;
    }

    public bool IsFunction(string name)
    {
        try { _functions ??= ExpressionCheck.ScopeFunctions(espace); }
        catch { return false; }
        return _functions.Contains(name);
    }

    public bool IsClientEntity(string name)
    {
        foreach (var kind in new[] { "IClientEntity", "IClientEntitySignature" })
            if (Resolve(kind + ":" + name) is { } o && (ModelSession.Implements(o, "IClientEntity") || ModelSession.Implements(o, "IClientEntitySignature"))) return true;
        return false;
    }

    public IReadOnlyDictionary<string, string>? Attributes(string record)
    {
        if (_records.TryGetValue(record, out var cached)) return cached;
        IReadOnlyDictionary<string, string>? found = null;
        foreach (var kind in RecordKinds)
        {
            if (Resolve(kind + ":" + record) is not IObjectSignature owner || !ModelSession.Implements(owner, kind) && !ModelSession.Implements(owner, kind + "Signature")) continue;
            var attributes = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            // In an expression the identifier attribute (Id) is the entity's Identifier, whatever its stored type (Long Integer).
            var identifier = ModelHost.Prop(owner, "IdentifierAttribute");
            foreach (var child in owner.Children)
            {
                if (!(ModelSession.Implements(child, "IEntityAttribute") || ModelSession.Implements(child, "IStructureAttribute")
                    || ModelSession.Implements(child, "IEntityAttributeSignature") || ModelSession.Implements(child, "IStructureAttributeSignature"))) continue;
                if (TypeResolver.Name(child) is not { Length: > 0 } name) continue;
                string type;
                if (ReferenceEquals(child, identifier) || identifier == null && kind.Contains("Entity", StringComparison.Ordinal) && name.Equals("Id", StringComparison.OrdinalIgnoreCase))
                    type = record + " Identifier";
                else try { type = UiCatalog.TypeName(ModelHost.Prop(child, "DataType")); } catch { type = ""; }
                attributes[name] = type;
            }
            if (attributes.Count > 0) { found = attributes; break; }
        }
        _records[record] = found;
        return found;
    }

    public CalleeFact? Callee(string target, JsonObject caller)
    {
        IEnumerable<LogicCallCandidate> candidates;
        try { candidates = LogicOrder.CallCandidates(target, caller); }
        catch { return null; }
        foreach (var candidate in candidates)
        {
            if (Resolve(candidate.Reference) is not IObjectSignature callee) continue;
            var screen = ModelSession.Implements(callee, LogicOrder.MobileScreenAction) || ModelSession.Implements(callee, LogicOrder.WebScreenAction);
            if (candidate.IsImplicitLocal && !screen) continue;
            if (!screen && !ModelSession.Implements(callee, "IActionSignature") && !ModelSession.Implements(callee, "IClientAction")
                && !ModelSession.Implements(callee, "IServerAction") && !ModelSession.Implements(callee, "IServiceAction")) continue;
            if (ModelSession.Implements(callee, "IDataAction") || ModelSession.Implements(callee, "IPreparation")) return null;
            var inputs = new List<ParamFact>(); var outputs = new List<ParamFact>();
            foreach (var child in callee.Children)
            {
                var input = ModelSession.Implements(child, "IInputParameter") || ModelSession.Implements(child, "IInputParameterSignature");
                var output = ModelSession.Implements(child, "IOutputParameter") || ModelSession.Implements(child, "IOutputParameterSignature");
                if (!input && !output || TypeResolver.Name(child) is not { Length: > 0 } name) continue;
                string? type;
                try { type = UiCatalog.TypeName(ModelHost.Prop(child, "DataType")); } catch { type = null; }
                // Mandatory only when the model says so: an unreadable flag never makes an argument required.
                if (input) inputs.Add(new ParamFact(name, type, ModelHost.Prop(child, "IsMandatory") is true));
                else outputs.Add(new ParamFact(name, type, false));
            }
            return new CalleeFact(TypeResolver.Name(callee) ?? candidate.Reference, inputs, outputs);
        }
        return null;
    }

    private static readonly string[] ScreenDataKinds = ["IInputParameter", "ILocalVariable", "IAggregate", "IDataAction"];

    public IReadOnlyCollection<string>? ScreenNames(string owner)
    {
        try
        {
            if (Resolve(owner) is not IObjectSignature screen) return null;
            return screen.Children.Where(c => ScreenDataKinds.Any(k => ModelSession.Implements(c, k))).Select(c => TypeResolver.Name(c)).OfType<string>()
                .Where(n => n.Length > 0).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        }
        catch { return null; }
    }

    private Dictionary<string, List<IObjectSignature>>? _index;

    private Dictionary<string, List<IObjectSignature>> Index() => _index ??= session.AllDescendants().Where(d => !string.IsNullOrEmpty(TypeResolver.Name(d)))
        .GroupBy(d => TypeResolver.Name(d)!, StringComparer.OrdinalIgnoreCase).ToDictionary(g => g.Key, g => g.ToList(), StringComparer.OrdinalIgnoreCase);

    /// <summary>`Kind:Name` through one index of the module built once (the session's Resolve walks the whole module per
    /// call); any other form through the session.</summary>
    private object? Resolve(string reference)
    {
        var colon = reference.IndexOf(':');
        if (colon > 0 && !reference.Contains('/') && !reference.StartsWith('@') && !reference.StartsWith('$'))
        {
            try
            {
                var kind = KindNames.Normalize(reference[..colon]); var name = reference[(colon + 1)..];
                if (!Index().TryGetValue(name, out var named)) return null;
                return ReferencePrecedence.Prefer(named.Where(d => ModelSession.Implements(d, kind)), d => TypeResolver.Name(d), d => d.GetInterface()?.Name, kind, name)
                    ?? ReferencePrecedence.Prefer(named.Where(d => ModelSession.Implements(d, kind + "Signature")), d => TypeResolver.Name(d), d => d.GetInterface()?.Name, kind + "Signature", name);
            }
            catch { return null; }
        }
        try { return session.Resolve(reference); }
        catch { return null; }
    }
}
