using System.Collections;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using OutSystems.Model;
using OutSystems.Model.UI;
using ServiceStudio.Model;

namespace Anvil.Core;

/// <summary>
/// Runtime generico dos verbos de escrita e leitura sobre um modulo carregado, dirigido pelo Model API
/// (o catalogo e a mesma reflexao, gerada). Nenhum verbo por tipo de elemento.
///
/// Referencias a objetos: "$alias" (handle criado por um op anterior), "@espace" (o modulo), "@<ObjectKey>",
/// ou "Tipo:Nome" (ex.: "IServerEntity:Booking", "IServerAction:Wallet_Debit"; Tipo pode ser omitido: ":Booking").
/// Ops (JSON): {op:"create", parent, type, name?, as?, args?} | {op:"set", target, prop, value} |
/// {op:"link", from, connector, to} | {op:"move", target, x?, y?, before?, after?, first?, last?} |
/// {op:"duplicate", target, as?, parent?} | {op:"delete", target} | {op:"get", target} | {op:"find", name?, type?}
/// Um job inteiro roda dentro de um unico comando do modelo (Publisher.Mutate): tudo entra ou nada entra.
/// </summary>
public sealed partial class ModelSession
{
    private const BindingFlags Pub = BindingFlags.Public | BindingFlags.Instance;
    private readonly ESpace _espace;
    private readonly IESpace _es;
    private readonly Dictionary<string, object> _handles = new(StringComparer.Ordinal);
    private Dictionary<string, IObjectSignature>? _byKey;
    // A logic op cannot change entity/structure definitions. Keep its lookup snapshot only until it finishes.
    private Dictionary<string, List<IObjectSignature>>? _logicNames;
    private Dictionary<string, OutSystems.Model.Types.ITypeSignature>? _logicTypes;
    private HashSet<string>? _logicActionNames;


    /// <summary>Carrega um modulo produtor (caminho de OML ou "job:&lt;nome&gt;") para o verbo reference; definido pelo JobRunner.</summary>
    public Func<string, ESpace>? ProducerLoader { get; set; }
    private readonly Dictionary<JsonObject, JsonNode> _preparedReferences = new();

    public ModelSession(ESpace espace)
    {
        _espace = espace; _es = (IESpace)espace;
        _handles["@espace"] = espace;
    }

    public IReadOnlyDictionary<string, string> Handles => _handles.Where(h => h.Value is IObjectSignature).ToDictionary(h => h.Key, h => ((IObjectSignature)h.Value).ObjectKey?.ToString() ?? "");

    /// <summary>JobPreflight.OpsPointer of the job the next Apply runs ("/ops", "" for an array job, null for a composite):
    /// the pointers of the problems Apply reports. A property, so Apply keeps its one signature (tests and tools find it by name).</summary>
    public string? OpsPointer { get; set; } = "/ops";

    /// <summary>
    /// Executa todos os ops num unico comando. The whole job in one command, on the disposable copy of the snapshot (A02
    /// item 6, apply that collects everything): a failing op is recorded, the `$alias`es and names it would create are
    /// marked, the ops that use them are skipped (never repeated as failures of their own) and the next op runs. At the end,
    /// with failures, nothing is kept: one failure is thrown as it was (a coded refusal keeps its code; any other becomes
    /// PREFLIGHT_REFUSED with its problem), several become one JobPreflightException PREFLIGHT_REFUSED with every problem,
    /// each with phase "apply" (I6), before the Verify and before anything is saved.
    /// </summary>
    public JsonArray Apply(JsonArray ops, Action<string>? log = null)
    {
        var opsPointer = OpsPointer;
        using var timing = NativePerformanceCapture.Measure("apply.total", cpu: true);
        var results = new JsonArray();
        EndOfApplyFailure = null;
        try
        {
        StudioAdapter.Runtime.Mutate(_espace, "Anvil: apply job", _ =>
        {
            var beforeFlows = ops.OfType<JsonObject>().Any(op => op["op"]?.ToString() is not ("get" or "find" or "dump" or "usages" or "layout"))
                ? CaptureFlowLayouts() : null;
            AutomaticLayouts = [];
            var retiredTypes=ops.OfType<JsonObject>().Any(op=>op["op"]?.ToString()=="delete")?ReferencedManagedCSharpTypes():null;
            var failures = new List<ApplyFailure>();
            var skipped = new List<(int Op, int Because, string Uses)>();
            var isolationWarnings = new List<JsonObject>();
            var blocked = new Blocked();
            Kept = null;
            BeginOwnerRules(ops);
            // The screens an html edit of the job names, as the capture has them before any op, when an earlier op may change them.
            _htmlAtStart = HtmlReadingsAtStart(ops);
            // The module's data text before the first op, when a data text of the job may need it (MergeDdl).
            _ddlAtStart = BaseSha256 != null && ops.OfType<JsonObject>().Any(o => o["op"]?.ToString() == "spec" && o["data"]?["ddl"] != null)
                ? Anvil.Reading.DataDdl.Build((IObjectSignature)_espace, new KernelModelReader(), MessageExpectations.Lane, "", 0).Text : null;
            // primeira-certa A2: an op the preflight refused whole (it cannot be compiled) is never run; what uses it is skipped.
            var refusedBefore = false;
            // C28 (K2, atritos 3): an event argument written before the Destination of its event runs right after it.
            var order = ArgumentOrder(ops, (argument, destination) => Report("reorderedArguments", new JsonObject { ["op"] = argument, ["after"] = destination }));
            foreach (var i in order)
            {
                var node = ops[i];
                if (KeepFailures && (SkipOps?.Contains(i) == true || node is not JsonObject || node["op"] is not JsonValue))
                {
                    refusedBefore = true;
                    if (node is JsonObject refused) blocked.Mark(refused, i);
                    log?.Invoke($"#{i} not run: the preflight refused it");
                    continue;
                }
                var op = node!.AsObject();
                var kind = op["op"]?.GetValue<string>() ?? throw new InvalidOperationException($"op #{i}: missing 'op'");
                var flowTexts = kind == "logic" && op["data"]?["flow"] != null;
                if (!flowTexts && (failures.Count > 0 || refusedBefore) && blocked.UsedBy(op) is { } uses)
                {
                    skipped.Add((i, uses.Op, uses.Name));
                    blocked.Mark(op, uses.Op);
                    log?.Invoke($"#{i} {kind} skipped: it uses {uses.Name} of failed op #{uses.Op}");
                    continue;
                }
                JsonNode? r;
                _applyOps = ops; _applyIndex = i;
                _flowBlocked = flowTexts ? blocked : null;
                _flowDependencySkipped = flowTexts ? (pointer, origin, name) => {
                    var at = opsPointer == null ? null : $"{opsPointer}/{i}/data{pointer}";
                    isolationWarnings.Add(JobPreflight.Problem(i, at, "APPLY_SKIPPED", "warning",
                        $"skipped: it uses {name}, which failed op #{origin} would have created", $"fix op #{origin}; this text runs with it"));
                    log?.Invoke($"#{i} {kind} {pointer} skipped: it uses {name} of failed op #{origin}");
                } : null;
                BeginAnchors(i);
                var opFailed = true;
                try { r = ApplyOne(op); opFailed = false; }
                catch (Exception ex)
                {
                    var msg = $"op #{i} ({kind} {op["name"]?.GetValue<string>() ?? op["prop"]?.GetValue<string>() ?? ""}): {Unwrap(ex)}";
                    // A platform wrapper that omits its cause ("Failed to compare two elements in the array.") names it here:
                    // Errors.Describe keeps the outermost text that contains the root's, so without it the op index was lost.
                    if (ex.GetBaseException() is { } cause && !msg.Contains(cause.Message, StringComparison.Ordinal)) msg += $" <- {cause.GetType().Name}: {cause.Message}";
                    // referencia por resolver: dizer ONDE no job o alvo nasce e listar todos os forward-refs de uma vez (plano, item 14)
                    if (Errors.FindUnresolved(ex) is { } u) msg += ForwardRefs.Explain(ops, i, u.Name);
                    // A name that does not resolve because an earlier failed (or skipped) op would have created it is that op's
                    // consequence, not a fault of its own: the op is skipped, never a second problem.
                    if (!flowTexts && (failures.Count > 0 || refusedBefore) && Blocked.MissingName(ex, msg) is { } missing && blocked.Mentioned(missing) is { } origin)
                    {
                        skipped.Add((i, origin, missing));
                        blocked.Mark(op, origin);
                        log?.Invoke($"#{i} {kind} skipped: {missing} would come from failed op #{origin}");
                        continue;
                    }
                    // primeira-certa A6: a logic op whose action fails runs again without it (and without the actions of the
                    // op that use it), so its other actions reach the Verify; each failure points at its action.
                    if (KeepFailures && kind == "logic" && IsolateActions(op, i, ex, opsPointer, log) is { } isolated)
                    {
                        failures.AddRange(isolated.Failures);
                        isolationWarnings.AddRange(isolated.Warnings);
                        blocked.Mark(isolated.Broken, i);
                        if (isolated.Result != null)
                        {
                            opFailed = false;
                            results.Add(new JsonObject { ["op"] = kind, ["result"] = isolated.Result, ["isolated"] = isolated.Kept });
                            log?.Invoke($"#{i} {kind} applied without {isolated.Broken["data"]!["actions"]!.AsArray().Count} action(s): failed or using a failed one");
                        }
                        continue;
                    }
                    failures.Add(new ApplyFailure(i, kind, op, new InvalidOperationException(msg, ex)));
                    blocked.Mark(op, i);
                    log?.Invoke($"#{i} {kind} failed: {Unwrap(ex)}");
                    continue;
                }
                finally { _flowBlocked = null; _flowDependencySkipped = null; EndAnchors(opFailed); }
                results.Add(new JsonObject { ["op"] = kind, ["result"] = r });
                log?.Invoke($"#{i} {kind} ok");
            }
            _applyOps = null;
            // C36 (atritos 3): a delete whose consumers later ops of this job remove runs now, once they are gone.
            foreach (var (index, pending) in _pendingDeletes.ToArray())
            {
                if (failures.Count > 0) break;
                // Removed meanwhile with an ancestor a later op deleted: nothing left to delete.
                try { if (Resolve(Req(pending, "target")) is IObjectSignature { WasDeleted: true }) continue; } catch (KeyNotFoundException) { continue; }
                try { results.Add(new JsonObject { ["op"] = "delete", ["pendingOf"] = index, ["result"] = Delete(pending) }); }
                catch (Exception ex) { failures.Add(new ApplyFailure(index, "delete", pending, new InvalidOperationException($"op #{index} (delete ): {Unwrap(ex)}", ex))); }
            }
            _pendingDeletes.Clear();
            // Every theme the job wrote with no base theme carries the native widgets' CSS (Verbs.NativeWidgets.cs).
            if (failures.Count == 0) NativeWidgetCss(); else _themesWritten.Clear();
            // Data access on the candidate model (QueryInLoopRule.cs, AggregateConsolidationRule.cs): QUERY_IN_LOOP is one more
            // failure of this refusal; legacy loops, escapes and AGGREGATES_MERGEABLE go to the receipt (highWarnings).
            QueryInLoopReview(ops, failures);
            // The owner's rules on the JSON form of the logic op (Verbs.OwnerRules.cs): new JavaScript and T1/T2 loops it wrote.
            OwnerRulesReview(ops, failures, opsPointer);
            // Checagem de compilação (CompileCheck.cs): what the OutSystems compiler cannot build is one more failure.
            CompileCheckReview(ops, failures);
            AggregateConsolidationReview(ops);
            var failed = failures.Count > 0 || refusedBefore;
            if (failed)
            {
                // primeira-certa A2: kept, not thrown: the caller runs the Verify of what did apply and refuses once, with
                // every phase. The candidate is never saved (JobRunner.ApplyResolved).
                if (!KeepFailures) throw ApplyRefusal(failures, skipped, opsPointer);
                Kept = KeptFailures(failures, skipped, opsPointer);
                Kept.Warnings.AddRange(isolationWarnings.Select(JobPreflight.PublicProblem));
            }
            if(!failed && retiredTypes!=null)
            {
                // Deleting a consumer retires only untouched compiler types that became
                // orphaned in this same transaction; read-only jobs never run cleanup.
                while(OrphanedManagedCSharpTypes(retiredTypes) is {Count:>0} cleanup)
                    foreach(var operation in cleanup.OfType<JsonObject>())
                    {
                        var result=ApplyOne(operation);
                        results.Add(new JsonObject {["op"]="delete",["generated"]="csharp-type-lifecycle",["result"]=result});
                        log?.Invoke("retired unused C# type "+operation["target"]);
                    }
            }
            if (beforeFlows != null) AutomaticLayouts = LayoutChangedFlows(beforeFlows);
        });
        }
        catch (Exception ex) when (KeepFailures && Kept != null)
        {
            // The Studio checks the model when the command ends; an element a failed op left half-built can break that check
            // (ODC screen cards: ListDescriptor.Validate on a List without its content). The kept failures are the refusal;
            // the Verify of what did apply cannot run on that model, and the refusal says so.
            EndOfApplyFailure = $"{ex.GetType().Name}: {ex.Message}";
            log?.Invoke("  the Studio's check at the end of the apply failed: " + EndOfApplyFailure);
        }
        return results;
    }

    /// <summary>Uma mutacao arbitraria dentro de um comando do Studio (o modelo recusa escritas fora de um comando).
    /// Serve os testes que simulam uma alteracao FORA dos verbos deste job (outra ferramenta, a plataforma, um defeito)
    /// para provar que o contrato de dados a continua a cobrar; nao e uma via de autoria.</summary>
    public void Mutate(string label, Action work) => StudioAdapter.Runtime.Mutate(_espace, label, _ => work());

    /// <summary>Um op, sem abrir comando: para quem ja esta dentro de um (ProofGenerator, bridge).</summary>
    public JsonNode? ApplyOne(JsonObject op)
    {
        var kind = op["op"]?.GetValue<string>() ?? throw new InvalidOperationException("missing 'op'");
        VerbSurface.Check(op); // the executed contract: verb, required keys and the closed key set (api --op verbs)
        using var timing = NativePerformanceCapture.MeasureVerb(kind);
        var renamed = kind == "rename" ? Resolve(Req(op, "target")) : null;
        // The owner's rules (Verbs.OwnerRules.cs): what a move into another parent takes along, before the platform recreates it.
        IObjectSignature? moved = null, movedFrom = null; List<IObjectSignature>? movedOwn = null;
        if (kind == "move" && op["into"] != null && _applyOps != null && op["target"] is JsonValue movedRef && movedRef.TryGetValue<string>(out var movedText))
        {
            try { moved = Resolve(movedText) as IObjectSignature; } catch (KeyNotFoundException) { }
            movedFrom = moved?.Parent as IObjectSignature;
            movedOwn = moved?.GetAllDescendantsOfType<IObjectSignature>().Append(moved).Where(o => JavaScriptOrLoop(o) && o.ObjectKey?.ToString() is { } k && _jobWrittenNodes.Contains(k)).ToList();
        }
        Anotar(kind, op, null);   // antes: e a unica altura em que o alvo de um delete ainda existe
        FootprintScopes(kind, op); // B3: the children of what the op names, before it writes (Verbs.Footprint.cs)
        _lastWritten = null;
        var result = kind switch
        {
            "create" => Create(op), "set" => Set(op), "link" => Link(op), "move" => Move(op), "reference" => Reference(op), "usages" => Usages(op), "rename" => Rename(op),
            "duplicate" => Duplicate(op), "delete" => Delete(op), "get" => Get(Resolve(Req(op, "target"))), "find" => Find(op),
            "replace" => Replace(op),
            "layout" => Layout(op),
            "spec" => Spec(op),
            "logic" => Logic(op),
            "agent" => Agent(op),
            "screen" => Screen(op),
            "html" => Html(op),
            "prototype" => Prototype(op),
            // The standard actions of the data model, generated from the module (Verbs.EntityActions.cs).
            "entity-actions" => EntityActions(op),
            // Integration ops (Verbs.Integration.cs): consumed REST, exposed REST, SOAP (O11).
            "rest" => Rest(op),
            // The generator of a consumed REST integration from URLs and samples (Verbs.RestConsume.cs, RestConsume.cs).
            "rest-consume" => RestConsume(op),
            "rest-expose" => RestExpose(op),
            "soap" => Soap(op),
            "dump" => Dump(Resolve(Req(op, "target")), op["depth"]?.GetValue<int>() ?? 3),
            _ => throw new InvalidOperationException("unknown op: " + kind),
        };
        Anotar(kind, op, result);  // depois: create e duplicate so revelam o tipo no resultado
        if (kind == "create") RememberCreate(op, result);
        // A theme the job writes (created, its base theme or its style sheet): with no base theme at the end, it gets the native
        // widgets' CSS (Verbs.NativeWidgets.cs).
        try
        {
            if (kind == "create" && (op["type"]?.ToString() ?? "").EndsWith("Theme", StringComparison.Ordinal) && result?["key"]?.ToString() is { Length: > 0 } themeKey) ThemeWritten(Resolve("@" + themeKey));
            else if (kind == "set" && op["prop"]?.ToString() is "BaseTheme" or "StyleSheet") ThemeWritten(Resolve(Req(op, "target")));
        }
        catch (KeyNotFoundException) { }
        RecordDataAccessOrigin(kind, result);
        RememberWrittenNodes(kind, op, _lastWritten, moved, movedFrom, movedOwn);
        // O contrato afere a propriedade que o rename escreveu (Identifier num registo, Label num no...), nao sempre Name.
        if (renamed != null) RememberData(renamed, result?["property"]?.GetValue<string>() ?? "Name", op["name"]!.DeepClone());
        return result;
    }

    /// <summary>Registers an `as` alias (C30): the alias as written; Resolve also answers to it with or without its $.</summary>
    public void Register(string alias, object obj) { _handles[alias] = obj; Anchor(obj); }

    private static readonly System.Text.RegularExpressions.Regex BareAlias = new(@"^\$?[A-Za-z_][A-Za-z0-9_.~\-]*$", System.Text.RegularExpressions.RegexOptions.Compiled);

    /// <summary>The other spelling of an alias: "$scr" for "scr" and "scr" for "$scr"; null for anything that is not an alias
    /// (a key, a Type:Name, a path).</summary>
    internal static string? AliasCounterpart(string reference)
        => reference.Length > 1 && BareAlias.IsMatch(reference) && !reference.Equals("@espace", StringComparison.Ordinal)
            ? reference.StartsWith('$') ? reference[1..] : "$" + reference : null;

    /// <summary>spec {data}: expande a spec compacta de dados (SpecExpander) em verbos e aplica-os; devolve os ops gerados.</summary>
    private JsonNode Spec(JsonObject op)
    {
        var data = op["data"]?.AsObject() ?? throw new InvalidOperationException("spec: 'data' is required");
        // DL2: the module's data text, compiled against the module as it is now (Verbs.Ddl.cs).
        if (data["ddl"] != null) return DdlSpec(data);
        // C21: a value of the spec written as the literal the Studio stores is reported, with its pointer in the job.
        var rewrites = new List<(string Pointer, string From, string To)>();
        var expanded = SpecExpander.Expand(data, rewrites);
        var at = _applyOps != null && _applyIndex < _applyOps.Count && ReferenceEquals(_applyOps[_applyIndex], op) && OpsPointer != null ? $"{OpsPointer}/{_applyIndex}/data" : "/data";
        foreach (var (pointer, from, to) in rewrites) Report("expressionRewrites", at + pointer, from, to);
        var k = 0;
        foreach (var e in expanded)
        {
            try { ApplyOne(e); }
            catch (Exception ex) { throw new InvalidOperationException($"spec op #{k} ({e["op"]} {e["name"] ?? e["prop"]} on {e["parent"] ?? e["target"]}): {Unwrap(ex)}", ex); }
            k++;
        }
        var deleteRules = OdcExternalDeleteRules(data);
        return new JsonObject { ["expanded"] = expanded.Count, ["aliases"] = new JsonArray(expanded.Where(e => e["as"] != null).Select(e => (JsonNode)e["as"]!.GetValue<string>()).ToArray()),
            ["deleteRuleDefaults"] = deleteRules.Count > 0 ? deleteRules : null };
    }

    /// <summary>C17 (atritos 3), ODC lane: an attribute that references an entity of another app or of the system (User) keeps
    /// only Ignore (each app has its own database; the ODC Studio sets Ignore at merge, lab 10: "the Studio set Delete Rule
    /// Ignore on Cart.UserId (requested Protect)"). Without deleteRule it gets Ignore, reported in the receipt notes; an
    /// explicit Protect or Delete is refused with ODC_DELETE_RULE_FORCED and the patch to Ignore.</summary>
    private JsonArray OdcExternalDeleteRules(JsonObject data)
    {
        var defaulted = new JsonArray();
        if (MessageExpectations.Lane != "odc") return defaulted;
        var forced = new List<JsonObject>();
        foreach (var section in new[] { "entities", "clientEntities" })
            for (var e = 0; e < (data[section] as JsonArray)?.Count; e++)
            {
                if (data[section]![e] is not JsonObject entity || entity["name"]?.ToString() is not { } entityName) continue;
                for (var a = 0; a < (entity["attributes"] as JsonArray)?.Count; a++)
                {
                    if (entity["attributes"]![a] is not JsonObject attribute || attribute["name"]?.ToString() is not { } attributeName) continue;
                    if (attribute["type"]?.ToString() is not { } type || !type.TrimEnd().EndsWith(" Identifier", StringComparison.OrdinalIgnoreCase)) continue;
                    object target;
                    try { target = Resolve($"${entityName}.{attributeName}"); } catch { continue; }
                    if (FindProperty(target, "DataType")?.GetValue(target) is not OutSystems.Model.Types.IIdentifierType identifier || identifier.Entity is not { } referenced
                        || !IsExternalEntity(referenced)) continue;
                    var rule = attribute["deleteRule"]?.ToString();
                    var path = $"{entityName}.{attributeName}";
                    if (rule == null)
                    {
                        ApplyOne(new JsonObject { ["op"] = "set", ["target"] = $"${entityName}.{attributeName}", ["prop"] = "DeleteRule", ["value"] = "Ignore" });
                        defaulted.Add((JsonNode)path);
                        Note("ODC_DELETE_RULE_IGNORE", $"{path} references {TypeResolver.Name(referenced)} of another app or of the system: its Delete Rule is Ignore, the only one ODC keeps there");
                    }
                    else if (!rule.Equals("Ignore", StringComparison.OrdinalIgnoreCase))
                        forced.Add(JobPreflight.Problem(null, $"/{section}/{e}/attributes/{a}/deleteRule", "ODC_DELETE_RULE_FORCED", "error",
                            $"{path} references {TypeResolver.Name(referenced)}, an entity of another app or of the system, with deleteRule {rule}: ODC keeps only Ignore there (the Studio rewrites it at merge and the delivery would not match the candidate)",
                            "\"deleteRule\": \"Ignore\" (or leave it out)",
                            new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = $"/{section}/{e}/attributes/{a}/deleteRule", ["value"] = "Ignore" })));
                }
            }
        if (forced.Count > 0)
            throw new KernelRefusalException("ODC_DELETE_RULE_FORCED", string.Join(" | ", forced.Select(p => p["message"]!.ToString())),
                new JsonArray(forced.Select(p => (JsonNode)JobPreflight.PublicProblem(p)).ToArray()));
        return defaulted;
    }

    /// <summary>An entity the module only references (another app's public entity, a system entity such as User).</summary>
    private bool IsExternalEntity(object entity)
        => entity is IObjectSignature signature && !ReferenceEquals(signature.Parent, _espace)
           && (Implements(entity, "ITopLevelReferenceElement") || entity.GetType().Name.StartsWith("Reference", StringComparison.Ordinal) || Implements(entity, "IEntitySignature") && !Implements(entity, "IEntity"));

    /// <summary>rest {data}: a consumed REST client (RestExpander); rest-expose {data}: an exposed REST service
    /// (RestExposeExpander); soap {data}: a SOAP client imported from its WSDL (SoapPlan, O11). Verbs.Integration.cs.</summary>
    private JsonNode Rest(JsonObject op) => RestOp(op["data"] as JsonObject ?? throw new InvalidOperationException("rest: 'data' is required (api --op rest)"));
    // rest-consume {data}: the generator of a consumed REST integration from URLs and samples (Verbs.RestConsume.cs).
    private JsonNode RestConsume(JsonObject op) => RestConsumeOp(op["data"] as JsonObject ?? throw new InvalidOperationException("rest-consume: 'data' is required (api --op rest-consume)"));
    private JsonNode RestExpose(JsonObject op) => RestExposeOp(op["data"] as JsonObject ?? throw new InvalidOperationException("rest-expose: 'data' is required (api --op rest-expose)"));
    private JsonNode Soap(JsonObject op) => SoapOp(op["data"] as JsonObject ?? throw new InvalidOperationException("soap: 'data' is required (api --op soap)"));

    private JsonNode Screen(JsonObject op)
    {
        if (op["data"] is JsonObject tree && tree.ContainsKey("owners")) return ScreenTree(tree);
        // Screens from entities and blocks (Verbs.ScreenGenerator.cs, ScreenGenerator.cs): the module's own standard screens.
        if (ScreenGenerator.IsGenerate(op["data"] as JsonObject)) return GenerateScreens(op);
        string? TryRef(string[] names)
        {
            foreach (var name in names) { try { Resolve(name); return name; } catch (KeyNotFoundException) { } }
            return null;
        }
        ScreenContract? Contract(string reference) => Resolve(reference) is IObjectSignature o ? ScreenContracts.Read(o, reference) : null;
        var expanded = ScreenExpander.Expand(op["data"]?.AsObject() ?? throw new InvalidOperationException("screen: data is required"), TryRef, Contract, _espace.ESpaceType.ToString());
        for (var i = 0; i < expanded.Count; i++)
        {
            try { ApplyOne(expanded[i]); }
            catch (Exception ex) { throw new InvalidOperationException($"screen op #{i} ({expanded[i]["op"]} {expanded[i]["prop"]}): {Unwrap(ex)}", ex); }
        }
        return new JsonObject { ["expanded"] = expanded.Count };
    }

    /// <summary>logic {data}: compila a spec declarativa de logica (LogicExpander) em verbos, com as referencias (entidades,
    /// actions, exceptions) resolvidas contra ESTE modulo antes de aplicar; devolve os ops gerados e os aliases.</summary>
    private JsonNode Logic(JsonObject op)
    {
        // The text form (ssam-flow/1, Verbs.Flow.cs): an action written as the text ssam_map view "flow" reads.
        if (op["data"] is JsonObject textForm && textForm.ContainsKey("flow")) return FlowOp(op);
        _mappingRewrites.Clear();
        try
        {
            _logicNames = Descendants().Where(o => !string.IsNullOrEmpty(TypeResolver.Name(o)))
                .GroupBy(o => TypeResolver.Name(o)!, StringComparer.OrdinalIgnoreCase).ToDictionary(g => g.Key, g => g.ToList(), StringComparer.OrdinalIgnoreCase);
            _logicTypes = new(StringComparer.OrdinalIgnoreCase);
            _logicActionNames = op["data"]?["actions"]?.AsArray().OfType<JsonObject>().Select(a => a["name"]?.ToString() ?? "").ToHashSet(StringComparer.OrdinalIgnoreCase) ?? [];
            return LogicCore(op);
        }
        finally { _logicNames = null; _logicTypes = null; _logicActionNames = null; _mappingRewrites.Clear(); }
    }

    private JsonNode LogicCore(JsonObject op)
    {
        var data = op["data"]?.AsObject() ?? throw new InvalidOperationException("logic: 'data' is required");
        LogicExpander.ConstructionPlan construction;
        using (NativePerformanceCapture.Measure("logic.expand"))
            construction = LogicExpander.ExpandConstruction(data, candidates =>
            {
                foreach (var c in candidates)
                {
                    try
                    {
                        var resolved = Resolve(c);
                        if (c.StartsWith("IClientEntity:", StringComparison.Ordinal) && (resolved as IObjectSignature)?.GetInterface()?.Name is not ("IClientEntity" or "IClientEntitySignature")) continue;
                        if (c.StartsWith("IServerEntity:", StringComparison.Ordinal) && (resolved as IObjectSignature)?.GetInterface()?.Name is "IClientEntity" or "IClientEntitySignature") continue;
                        if (Implements(resolved, "IClientAction")) return "IClientAction:" + TypeResolver.Name(resolved);
                        if (Implements(resolved, "IClientActionSignature")) return "IClientActionSignature:" + TypeResolver.Name(resolved);
                        return c;
                    }
                    catch (Exception) { }
                }
                return null;
            }, (candidate, caller) => InClientFlow(LogicOrder.IsClient(caller), () => ResolveLogicCall(candidate, caller)));
        var expanded = construction.Operations;
        // A declared action is (owner, name) (I5 of the atritos 2 package): the same screen action name on two screens is two
        // actions, so a replacement is keyed by "owner/name" (the parent of its create op), never by the name alone.
        var replacements = new List<(string Name, string Key, string Type, IObjectSignature Target, string OldKey, JsonObject Declaration)>();
        foreach (var action in data["actions"]!.AsArray().OfType<JsonObject>())
        {
            var name = action["name"]!.GetValue<string>();
            var type = LogicOrder.ActionType(action);
            var existing = OwnedAction(name, action);
            var replace = action["replace"]?.GetValue<bool>() ?? false;
            if (existing != null && !replace) throw new InvalidOperationException(DuplicateAction(name));
            if (replace && existing == null) throw new InvalidOperationException($"logic: action '{name}' does not exist; omit replace to create it");
            if (replace && existing != null)
            {
                if (!Implements(existing, type)) throw new InvalidOperationException($"logic: replace cannot change action kind for '{name}'");
                replacements.Add((name, ReplacementKey(LogicOrder.Owner(action), name), type, existing, existing.ObjectKey!.ToString()!, action));
            }
        }
        // The actions as they read before the op replaces them: what they had (a JavaScript, a For Each) is theirs, never new
        // (OwnerRulesReview, Verbs.OwnerRules.cs).
        var readBefore = new Dictionary<string, Anvil.Reading.FlowItem>(StringComparer.OrdinalIgnoreCase);
        if (_applyOps != null)
            foreach (var replacement in replacements)
                if (FlowItemOf(replacement.Target) is { } read) readBefore[replacement.Key] = read;
        var preserved = replacements.ToDictionary(r => r.Key, r => Consumers(r.Target)
            .Where(c => !replacements.Any(other => ReferenceEquals(c.Referer, other.Target) || IsInside(c.Referer, other.Target)))
            .Select(c => ((IObjectSignature)c.Referer).ObjectKey!.ToString()!).ToHashSet(StringComparer.Ordinal), StringComparer.OrdinalIgnoreCase);
        // A stable signature keeps the action's identity (its key) while the body changes: event handlers, expression
        // functions and consumers in other modules stay bound to the same native declaration. UI actions (screen, client)
        // and, since C14, server and service actions: kind, Public, Function, and the name, order, type (and, for server and
        // service actions, Mandatory) of every parameter.
        var retainedActions = new Dictionary<string, IObjectSignature>(StringComparer.OrdinalIgnoreCase);
        bool StableSignature(IObjectSignature target, JsonObject declaration)
        {
            var type = LogicOrder.ActionType(declaration);
            // A REST callback's parameters are the platform's own (Request, CustomizedRequest...): its body changes, never them.
            if (type == LogicOrder.RestCallback) return true;
            var serverSide = type is "IServerAction" or "IServiceAction";
            if (!serverSide && declaration["kind"]?.ToString() is not ("screen" or "client")) return false;
            if (type == "IClientAction" || serverSide)
            {
                if ((ModelHost.Prop(target, "Public") is true) != (declaration["public"]?.GetValue<bool>() == true)) return false;
                if (((ModelHost.Prop(target, "IsFunction") ?? ModelHost.Prop(target, "Function")) is true) != (declaration["function"]?.GetValue<bool>() == true)) return false;
            }
            foreach (var (section, kind) in new[] { ("inputs", "IInputParameter"), ("outputs", "IOutputParameter") })
            {
                var actual = target.Children.Where(p => Implements(p, kind)).ToArray();
                var wanted = declaration[section]?.AsArray().OfType<JsonObject>().ToArray() ?? [];
                if (actual.Length != wanted.Length) return false;
                for (var i = 0; i < actual.Length; i++)
                {
                    if (TypeResolver.Name(actual[i]) != wanted[i]["name"]!.ToString() || UiCatalog.TypeName(ModelHost.Prop(actual[i], "DataType")) != wanted[i]["type"]!.ToString()) return false;
                    if (serverSide && kind == "IInputParameter" && (ModelHost.Prop(actual[i], "IsMandatory") is not false) != (wanted[i]["mandatory"]?.GetValue<bool>() != false)) return false;
                }
            }
            return true;
        }
        foreach (var replacement in replacements)
        {
            var declaration = replacement.Declaration;
            var keep = StableSignature(replacement.Target, declaration);
            // A public action whose signature changes breaks the consumers the kernel knows of: refused, naming them, before
            // anything is deleted (C14). Consumers replaced by the same job are not counted (preserved excludes them).
            if (!keep && ModelHost.Prop(replacement.Target, "Public") is true && preserved[replacement.Key] is { Count: > 0 } consumers)
            {
                var paths = Consumers(replacement.Target).Where(c => c.Referer is IObjectSignature referer && referer.ObjectKey != null && consumers.Contains(referer.ObjectKey.ToString()!))
                    .Select(c => ModelHost.PathOf(c.Referer)).Distinct().OrderBy(p => p, StringComparer.Ordinal).ToArray();
                const string fix = "keep the signature (only the body changes and the key stays), replace those consumers in the same job, or declare a new action and move the consumers to it";
                throw new KernelRefusalException("SIGNATURE_CHANGE_BREAKS_CONSUMERS",
                    $"logic: replace of public action '{replacement.Name}' changes its signature (Public, Function, or the name, order, type or Mandatory of a parameter) "
                    + $"and {paths.Length} consumer(s) use it: {string.Join("; ", paths.Take(12))}{(paths.Length > 12 ? "; ..." : "")}. Fix: {fix}",
                    new JsonArray(paths.Select(p => (JsonNode)JobPreflight.PublicProblem(JobPreflight.Problem(null, null, "SIGNATURE_CHANGE_BREAKS_CONSUMERS", "error",
                        $"{p} uses public action '{replacement.Name}', whose signature this replace changes", fix))).ToArray()));
            }
            var removed = replacement.Target.GetAllDescendantsOfType<IObjectSignature>().Append(replacement.Target).ToHashSet();
            if (keep)
            {
                var retained = replacement.Target.Children.OfType<IObjectSignature>().Where(p => Implements(p, "IInputParameter") || Implements(p, "IOutputParameter") || LogicOrder.IsCallbackParameter(p)).ToArray();
                removed.ExceptWith(retained.SelectMany(p => p.GetAllDescendantsOfType<IObjectSignature>().Append(p))); removed.Remove(replacement.Target);
                foreach (var child in replacement.Target.Children.OfType<IObjectSignature>().Where(p => !retained.Contains(p)).ToArray()) child.Delete();
                // A retained input keeps no default the declaration no longer gives (the declaration's own default is set again).
                var declaredInputs = declaration["inputs"]?.AsArray().OfType<JsonObject>().ToArray() ?? [];
                foreach (var input in retained.Where(p => Implements(p, "IInputParameter")))
                    if (declaredInputs.FirstOrDefault(d => d["name"]?.ToString() == TypeResolver.Name(input)) is { } declared && declared["default"] == null
                        && ModelHost.Prop(input, "DefaultValue") is IExpression { Text.Length: > 0 } staleDefault)
                        staleDefault.Text = "";
                retainedActions[replacement.Key] = replacement.Target;
            }
            else replacement.Target.Delete();
            foreach (var alias in _handles.Where(h => h.Value is IObjectSignature sig && removed.Contains(sig)).Select(h => h.Key).ToArray()) _handles.Remove(alias);
            if (_byKey != null) foreach (var key in _byKey.Where(kv => removed.Contains(kv.Value)).Select(kv => kv.Key).ToArray()) _byKey.Remove(key);
            // O contrato de dados tem de esquecer o que ESTE job destruiu, tal como o verbo `delete` ja faz. Sem
            // isto, um `replace` deixa o contrato a segurar a chave do objecto antigo e a cobra-la no fim:
            // "Public expected true, actual unavailable: KeyNotFoundException: no object with key ...". A
            // assercao e sobre um objecto que o proprio job mandou embora, e falhar por causa dela e ruido.
            // Continua a falhar, e bem, quando quem destroi e a PLATAFORMA sem ninguem pedir -- que e para isso
            // que o contrato existe.
            foreach (var ido in removed) EsquecerApagado(ido);
        }
        foreach (var batch in construction.Batches())
        using (NativePerformanceCapture.Measure(batch.ExpressionPhase ? "logic.bodyExpressions" : "logic.structure", cpu: true))
        foreach (var k in batch.OriginalOrdinals)
        {
            var e = expanded[k];
            try
            {
                if (e["op"]?.ToString() == "create" && e["name"] is { } actionName && retainedActions.TryGetValue(ReplacementKey(e["parent"]?.ToString() ?? "", actionName.ToString()), out var retained) && e["type"]?.ToString().Split('.').Last() is "IScreenAction" or "IClientAction" or "IServerAction" or "IServiceAction" or LogicOrder.RestCallback)
                    Register(e["as"]!.ToString(), retained);
                else if (e["op"]?.ToString() == "create" && e["type"]?.ToString() is "IInputParameter" or "IOutputParameter" && e["parent"] is { } parent && retainedActions.Values.Any(v => _handles.TryGetValue(parent.ToString(), out var value) && ReferenceEquals(v, value)))
                    Register(e["as"]!.ToString(), ((IObjectSignature)Resolve(parent.ToString())).Children.Single(p => TypeResolver.Name(p) == e["name"]!.ToString() && Implements(p, e["type"]!.ToString())));
                else ApplyOne(e);
            }
            catch (Exception ex)
            {
                var failed = new InvalidOperationException($"logic op #{k} ({e["op"]} {e["name"] ?? e["prop"]} on {e["parent"] ?? e["target"] ?? e["from"]}): {Unwrap(ex)}", ex);
                // primeira-certa A6: the declared action this generated op belongs to, for the isolation of the apply.
                if (ActionOfGenerated(e, expanded, data) is { } action) failed.Data[LogicActionKey] = action;
                throw failed;
            }
        }
        var healed = new JsonArray();
        foreach (var replacement in replacements)
        {
            var current = OwnedAction(replacement.Name, replacement.Declaration)!;
            var keys = Consumers(current).Select(c => ((IObjectSignature)c.Referer).ObjectKey!.ToString()!).ToHashSet(StringComparer.Ordinal);
            var missing = preserved[replacement.Key].Except(keys).ToArray();
            if (missing.Length > 0) throw new InvalidOperationException($"logic: replacement '{replacement.Name}' failed to relink consumers: {string.Join(", ", missing)}; transaction aborted");
            healed.Add(new JsonObject { ["name"] = replacement.Name, ["oldKey"] = replacement.OldKey,
                ["identityRetained"] = retainedActions.ContainsKey(replacement.Key), ["key"] = current.ObjectKey!.ToString(), ["healedConsumers"] = preserved[replacement.Key].Count });
        }
        FlushPendingMappings($"/ops/{_applyIndex}/data/actions");
        ReportJsonMappings(data);
        RememberJsonLogic(data, readBefore);
        return new JsonObject { ["expanded"] = expanded.Count, ["replaced"] = replacements.Count > 0,
            ["healedConsumers"] = preserved.Values.Sum(v => v.Count), ["replacements"] = healed,
            ["aliases"] = new JsonArray(expanded.Where(e => e["as"] != null).Select(e => (JsonNode)e["as"]!.GetValue<string>()).ToArray()) };

    }

    private IObjectSignature? OwnedAction(string name, JsonObject declaration)
    {
        var owner = LogicOrder.Owner(declaration);
        if (owner == "@espace") return OwnedAction(name);
        var parent = UINamed(owner); if (parent == null) return null; var type = LogicOrder.ActionType(declaration);
        var matches = parent.Children.OfType<IObjectSignature>().Where(o => Implements(o, type) && (type == "IPreparation" || TypeResolver.Name(o) == name)).ToArray();
        if (matches.Length > 1) throw new ArgumentException("Ambiguous owned action " + owner + "/" + name);
        return matches.SingleOrDefault();
    }
    private IObjectSignature? OwnedAction(string name) => ((IObjectSignature)_es).Children.OfType<IObjectSignature>().FirstOrDefault(o => ReferenceEquals(o.Parent, _espace)
        && (Implements(o, "IServerAction") || Implements(o, "IServiceAction") || Implements(o, "IClientAction"))
        && string.Equals(TypeResolver.Name(o), name, StringComparison.OrdinalIgnoreCase));
    private IObjectSignature? OwnedActionInScope(string name, string kind) => ((IObjectSignature)_es).Children.OfType<IObjectSignature>().FirstOrDefault(o => ReferenceEquals(o.Parent, _espace)
        && (Implements(o, "IServerAction") || Implements(o, "IServiceAction") || Implements(o, "IClientAction"))
        && Preflight.ModelBaseFacts.ScopeOf(o) == Preflight.ActionNameRules.Scope(kind)
        && string.Equals(TypeResolver.Name(o), name, StringComparison.OrdinalIgnoreCase));
    private static string DuplicateAction(string name) => $"action '{name}' already exists in this module; to rewrite its body keeping consumers use \"replace\": true in a logic spec; otherwise pick another name";
    /// <summary>"owner/name" of a declared action, case-insensitive like LogicOrder's key: the owner is the parent its create
    /// op names (LogicOrder.Owner), "@espace" for a module action.</summary>
    private static string ReplacementKey(string owner, string name) => (owner + "/" + name).ToLowerInvariant();

    // ---- verbos ---------------------------------------------------------------------------

    private JsonNode Create(JsonObject op) => CreateCore(op, nativeNameProbe: false);

    private JsonNode CreateCore(JsonObject op, bool nativeNameProbe)
    {
        var parent = Resolve(Req(op, "parent"));
        var typeName = Req(op, "type");
        var name = op["name"]?.GetValue<string>();
        var args = op["args"]?.AsObject();
        // D2 (atritos 3, C21): an attribute or index name longer than the Studio keeps is written as the Studio keeps it (the
        // first 28 characters, numbered when taken), so the data proof expects that name; reported in nameTruncations.
        var shortType = typeName.Split('.').Last();
        if (name is { Length: > NameTruncation.MaxLength } && shortType is "IEntityAttribute" or "EntityIndex" or "IEntityIndex")
        {
            var siblings = shortType == "IEntityAttribute"
                ? (parent as IObjectSignature)?.Children.Where(c => Implements(c, "IEntityAttribute")).Select(c => TypeResolver.Name(c)).OfType<string>() ?? []
                : EntityIndexes.Names(parent);
            var kept = NameTruncation.Truncate(name, siblings);
            Report("nameTruncations", (PathOf(parent as IObjectSignature ?? (IObjectSignature)_es) is { Length: > 0 } owner ? owner + "/" : "") + name, name, kept);
            op["name"] = kept; name = kept;
        }
        if (ReferenceEquals(parent, _espace) && typeName.Split('.').Last() is "IServerAction" or "IServiceAction" or "IClientAction")
        {
            if (op.ContainsKey("replace")) throw new InvalidOperationException("create: use replace:true on an action inside a logic spec");
            if (!nativeNameProbe && name != null && OwnedActionInScope(name, typeName) != null) throw new InvalidOperationException(DuplicateAction(name));
        }
        // Um item de grupo so existe dentro do seu grupo. O ODC recusa no create ("A Button Group Item must be placed
        // inside a Button Group widget"); o O11 aceita e o Verify nativo cai com NullReferenceException fora de qualquer op
        // (ButtonGroupItemDescriptor.GetVariableTypeFromParent, cobertura testada fase 1). Recusa-se aqui nas duas faixas.
        if (typeName.Split('.').Last() is "IButtonGroupItem" or "IRadioButton" && GroupMissing(parent, typeName.Split('.').Last()) is { } groupRefusal)
            throw new InvalidOperationException(groupRefusal);
        // IEntityIndex is the Model API name of the same native index: it goes to the constructor that takes its attributes
        // (the generic create had no parameter for them and made an index without attributes, 62a884e8).
        if (typeName == "EntityIndex" || typeName.Split('.').Last() == "IEntityIndex")
        {
            // C21: the same index again is a no-op, reported in indexNoOps.
            string? kept = null;
            var index = EntityIndexes.Create(parent, name, args, Resolve,
                (requested, existing) => { kept = existing; Report("indexNoOps", PathOf((IObjectSignature)parent) + "/" + requested, requested, existing); });
            // The data proof expects the index the module keeps (its name), not the name asked for.
            if (kept != null) op["name"] = kept;
            if (_byKey != null && index is IObjectSignature indexSig && indexSig.ObjectKey != null) _byKey[indexSig.ObjectKey.ToString()!] = indexSig;
            if (op["as"]?.GetValue<string>() is { } indexAlias) Register(indexAlias, index);
            return Summary(index);
        }
        var options = FindCreate(parent, typeName);
        if (options.Count == 0) throw new InvalidOperationException($"{Describe(parent)} cannot create {typeName} (no Create method in the API)");
        // Several Create forms without a name parameter, one of them named after the element (the REST callbacks:
        // CreateOnBeforeRequestCallback, CreateOnAfterResponseCallback...): that one, never the first of the list.
        if (name != null && options.Count > 1 && options.Where(o => o.Method.Name.Equals("Create" + name + "Callback", StringComparison.OrdinalIgnoreCase)
                || o.Method.Name.Equals("Create" + name, StringComparison.OrdinalIgnoreCase)).ToList() is { Count: 1 } named)
            options = named;
        // Every arg must reach a parameter of the Create form that runs: an arg nobody consumes was dropped in silence before.
        if (args is { Count: > 0 })
        {
            string[] Parameters((MethodInfo Method, bool Generic, Type Target) option)
                => option.Method.GetParameters().Where(p => p.Name != null && !(p.Name == "name" && p.ParameterType == typeof(string)) && p.ParameterType != typeof(Type))
                    .Select(p => p.Name!).ToArray();
            var fitting = options.Where(o => args.All(a => Parameters(o).Contains(a.Key, StringComparer.Ordinal))).ToList();
            if (fitting.Count == 0)
            {
                var accepted = options.SelectMany(Parameters).Distinct(StringComparer.Ordinal).OrderBy(p => p, StringComparer.Ordinal).ToArray();
                var unused = args.Select(a => a.Key).Where(k => !accepted.Contains(k, StringComparer.Ordinal)).ToArray();
                throw new InvalidOperationException($"create {typeName}: args {string.Join(", ", (unused.Length > 0 ? unused : args.Select(a => a.Key)).Select(k => "'" + k + "'"))} "
                    + $"are not parameters of any Create form of {typeName} under {Describe(parent)}, so they would be dropped; accepted args: "
                    + (accepted.Length == 0 ? "none (create it without args and write its properties with set)" : string.Join(", ", accepted) + " (other properties: set after the create)"));
            }
            options = fitting;
        }
        object? created = null;
        var failures = new List<string>();
        foreach (var (method, generic, target) in options)
        {
            var m = generic ? method.MakeGenericMethod(target) : method;
            var ps = m.GetParameters();
            var values = new object?[ps.Length];
            for (var k = 0; k < ps.Length; k++)
            {
                var p = ps[k];
                if (p.Name == "name" && p.ParameterType == typeof(string)) { values[k] = name; continue; }
                if (args != null && args.ContainsKey(p.Name!)) { values[k] = Convert(args[p.Name!], p.ParameterType); continue; }
                if (p.ParameterType == typeof(Type)) { values[k] = target; continue; } // CreateWidget(Type, ...): the candidate itself
                if (p.HasDefaultValue) { values[k] = p.DefaultValue; continue; }
                if (typeof(IObjectSignature).IsAssignableFrom(p.ParameterType) || p.ParameterType.IsInterface)
                    throw new InvalidOperationException($"{m.Name} needs arg '{p.Name}' ({p.ParameterType.Name})");
                values[k] = p.ParameterType.IsValueType ? Activator.CreateInstance(p.ParameterType) : null;
            }
            try { created = m.Invoke(parent, values); }
            catch (TargetInvocationException ex) when (options.Count > 1 && ex.GetBaseException() is { } cause && (cause.Message.Contains("unknown WidgetKind") || cause.Message.Contains("can't be children")
                || cause.Message.Contains("Couldn't find any concrete class implementing") || cause.Message.Contains("are not allowed in") // ODC: a same-name interface of another API area
                || cause is InvalidCastException)) // ODC: a Create form that does not fit this parent (the ODC factory nests the invocation exception)
            { failures.Add($"{target.FullName}: {ex.GetBaseException().Message}"); continue; }
            if (created != null) break;
        }
        if (created == null) throw new InvalidOperationException($"{Describe(parent)} could not create {typeName}: {string.Join(" | ", failures)}");
        // A04 NAME_COLLISION at apply: the Studio renames a newcomer whose name is taken in its scope (Categorias becomes
        // Categorias2) and says nothing; every expression of the job that names it then reads the other element. The rename
        // is the platform's own verdict, observed here; widgets and flow nodes (named by aliases, never by expressions of
        // the job) keep the Studio's choice.
        // The Studio numbers the newcomer from the name without its trailing digits (Adicionar2 taken becomes Adicionar3, Wv1
        // becomes Wv2), so the rename is the name's stem followed by digits, never only the name followed by digits.
        if (name != null && created is not IWidget && created is not OutSystems.Model.IFlowNode && TypeResolver.Name(created) is { Length: > 0 } actual
            && !string.Equals(actual, name, StringComparison.OrdinalIgnoreCase)
            && System.Text.RegularExpressions.Regex.IsMatch(actual, "^" + System.Text.RegularExpressions.Regex.Escape(System.Text.RegularExpressions.Regex.Replace(name, @"\d+$", "")) + @"\d+$", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
        {
            // Only the internal offline oracle consumes the actual native name and removes this object itself.
            if (nativeNameProbe) return Summary(created);
            var taken = (parent as IObjectSignature)?.Children.FirstOrDefault(c => !ReferenceEquals(c, created) && string.Equals(TypeResolver.Name(c), name, StringComparison.OrdinalIgnoreCase));
            // primeira-certa A6: what the Studio created is this failed op's: anchored, so the isolation of a logic op removes
            // it and the Verify of the refusal never reports the renamed element (a flow without Start) as a fault of its own.
            Anchor(created, created: true);
            var collision = new InvalidOperationException($"create {typeName.Split('.').Last()} '{name}' under {Describe(parent)}: the name collides with "
                + (taken != null ? $"{Describe(taken)}" : "an element of the same name in that scope") + $" and the Studio renamed it to '{actual}'; "
                + $"every expression of this job that names '{name}' would read the other element. Fix: give it another name (or '{actual}' explicitly), or use the existing '{name}' instead of creating it");
            // The facts of the collision for a caller that generated the op (the prototype importer turns them into its name map).
            collision.Data[NameCollisionData] = new JsonObject
            {
                ["type"] = typeName.Split('.').Last(), ["name"] = name, ["actual"] = actual,
                ["parentType"] = parent is IObjectSignature ps ? ShortType(ps) : null, ["parentName"] = TypeResolver.Name(parent),
                ["taken"] = taken != null ? Describe(taken) : null,
            }.ToJsonString();
            throw collision;
        }
        Anchor(created, created: true);
        _lastWritten = created as IObjectSignature;
        if (op["as"]?.GetValue<string>() is { } alias) Register(alias, created);
        if (_byKey != null && created is IObjectSignature sig && sig.ObjectKey != null) _byKey[sig.ObjectKey.ToString()!] = sig;
        if (op["source"]?.GetValue<string>() is { } source)
        {
            var sp = FindProperty(created, "SourceBlock") ?? throw new InvalidOperationException($"{Describe(created)} has no SourceBlock (only block instances take 'source')");
            var definition = Convert(JsonValue.Create(source), sp.PropertyType);
            sp.SetValue(created, definition);
            Unhide(definition);   // hidden indirect block references must be exposed before merge (item 17)
        }
        var cleared = op["empty"]?.GetValue<bool>() is true ? ClearDefaults(created) : null;
        var summary = Summary(created);
        if (cleared != null && summary is JsonObject so) so["emptied"] = cleared;
        return summary;
    }

    /// <summary>A recusa de um item de grupo fora do grupo; null quando o pai e o grupo, o Content dele ou algo dentro dele.</summary>
    private static string? GroupMissing(object parent, string itemType)
    {
        var (group, item, groupLabel) = itemType == "IButtonGroupItem" ? ("IButtonGroup", "Button Group Item", "Button Group") : ("IRadioGroup", "Radio Button", "Radio Group");
        for (var p = parent as IObjectSignature; p != null; p = p.Parent as IObjectSignature)
            if (Implements(p, group)) return null;
        return $"create {itemType}: a {item} must be placed inside a {groupLabel} widget, and {Describe(parent)} is not inside one. "
            + $"Create the {group} first (\"empty\": true drops its sample items) and create the {itemType} with the group, or its Content, as parent";
    }

    /// <summary>The module kind when this is known to be an ODC application (not a library); null on O11, for an ODC library,
    /// or when the module states no kind (a blank or synthetic module): the refusal needs a known app.</summary>
    private string? OdcApplicationKind()
    {
        if (MessageExpectations.Lane != "odc") return null;
        // Read as `get @espace` reads it (the model API properties of the module object): plain reflection on the class
        // sees no Kind, which made every ODC module look like an app of an unknown kind.
        var espace = Resolve("@espace");
        var kind = FindProperty(espace, "Kind")?.GetValue(espace)?.ToString() ?? "";
        return kind.Length == 0 || kind.Contains("Library", StringComparison.OrdinalIgnoreCase) ? null : kind;
    }

    /// <summary>A27: while a client flow resolves the action it calls (the Action of an Execute Client Action node, a logic
    /// call from client logic), a reference that admits a client and a server action of the same name takes the client one.</summary>
    private bool _preferClient;

    private T InClientFlow<T>(bool client, Func<T> work)
    {
        var was = _preferClient;
        _preferClient = client;
        try { return work(); }
        finally { _preferClient = was; }
    }

    private JsonNode Set(JsonObject op)
    {
        var target = Resolve(Req(op, "target"));
        op = AliasRule(target, op);
        var clientFlow = op["prop"]?.ToString() == "Action" && Implements(target, "IExecuteClientActionNode");
        var (written, weight) = IconRule(target, op);
        // CSS, SQL e JavaScript formatados em varias linhas antes de chegar ao modelo (CodeFormat/CodeFormatHook.cs).
        written = CodeFormatRule(target, written);
        // C27: Style on a widget that keeps its classes in StyleClasses or in the extended property `class`.
        (written, var done) = StyleRule(target, written);
        if (done != null) { Touch(target); AnchorProperty(target, op); return done; }
        var result = InClientFlow(clientFlow || _preferClient, () => SetCore(target, written));
        // A mapping that waited for the other side of its assignment (a new one gets its Value before its Variable).
        if (_pendingMappings.Count > 0 && WritePendingMapping(target) is { } mapped && result is JsonObject setResult) setResult["mapping"] = mapped;
        // The weight the conversion table gives goes with the converted name, as the merge writes it.
        if (weight != null) SetCore(target, new JsonObject { ["op"] = "set", ["target"] = op["target"]?.DeepClone(), ["prop"] = "Weight", ["value"] = weight });
        AnchorProperty(target, op);
        return result;
    }

    /// <summary>motor2 (C11): a property written by the name another element of the family uses (Handler on a lifecycle
    /// event, Destination on a widget event, Name on an extended property) is written to the one this element has for it,
    /// listed in normalizations (PROPERTY_ALIASED), when the element cannot write the name as written and can write the alias.</summary>
    private JsonObject AliasRule(object target, JsonObject op)
    {
        if (op["prop"]?.ToString() is not { Length: > 0 } prop || CanSet(target, prop)) return op;
        var interfaces = target.GetType().GetInterfaces().Select(i => i.Name);
        if (Preflight.PropertyAliases.Meant(interfaces, prop) is not { } to || !CanSet(target, to)) return op;
        var copy = op.DeepClone().AsObject();
        copy["prop"] = to;
        var raw = _applyOps != null && _applyIndex < _applyOps.Count && _applyOps[_applyIndex]?["op"]?.ToString() == "set";
        var at = OpsPointer != null && _applyOps != null && _applyIndex < _applyOps.Count ? $"{OpsPointer}/{_applyIndex}" + (raw ? "/prop" : "") : null;
        Normalized([Preflight.JobNormalizer.Entry(Preflight.PropertyAliases.Rule, at, prop, to,
            $"{ShortType(target)} {op["target"]} has no property {prop}; the one it has for it is {to}")]);
        return copy;
    }

    // C17: the weight each converted icon takes from the conversion table (a later `set Weight` keeps it).
    private readonly Dictionary<object, string> _iconWeights = new(ReferenceEqualityComparer.Instance);

    /// <summary>C17 (atritos 3), ODC lane: an icon name outside the active library that the Studio's conversion table maps is
    /// written as the table says (name and weight), reported in iconConversions; a name in neither is refused (ICON_UNKNOWN,
    /// with the closest names) at apply, before the Verify. Without a table (O11) the op is unchanged.</summary>
    private (JsonObject Op, string? Weight) IconRule(object target, JsonObject op)
    {
        var prop = op["prop"]?.ToString();
        if (prop is not ("Icon" or "Weight") || op["value"] is not JsonValue v || !v.TryGetValue<string>(out var text) || !Implements(target, "IIcon")) return (op, null);
        if (IconCatalog.Current is not { } icons) return (op, null);
        var path = op["target"]?.ToString() ?? Describe(target);
        if (prop == "Weight")
        {
            if (!_iconWeights.TryGetValue(target, out var forced) || string.Equals(forced, text, StringComparison.Ordinal)) return (op, null);
            Report("iconConversions", path + "/Weight", text, forced);
            return (Rewritten(op, forced), null);
        }
        var verdict = IconCatalog.Judge(text, icons);
        if (verdict.Unknown)
            throw new KernelRefusalException("ICON_UNKNOWN", $"set Icon on {Describe(target)}: '{text}' is not an icon of {icons.Library} nor a name its conversion table maps; closest: {string.Join(", ", verdict.Closest)}",
                new JsonArray(JobPreflight.PublicProblem(JobPreflight.Problem(null, "/value", "ICON_UNKNOWN", "error",
                    $"'{text}' is not an icon of {icons.Library} (the active library of this Studio) nor a name its conversion table maps",
                    "use one of: " + string.Join(", ", verdict.Closest), verdict.Closest.Count > 0 ? new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = "/value", ["value"] = verdict.Closest[0] }) : null))));
        if (!verdict.Converted) return (op, null);
        Report("iconConversions", path, text, verdict.Name + (verdict.Weight != null ? "/" + verdict.Weight : ""));
        if (verdict.Weight != null) _iconWeights[target] = verdict.Weight;
        return (Rewritten(op, verdict.Name), verdict.Weight);

        static JsonObject Rewritten(JsonObject op, string value)
        {
            var copy = op.DeepClone().AsObject();
            copy["value"] = value;
            return copy;
        }
    }

    // The target comes first: the body belongs to the set handler for the source scan of SurfaceTests.
    private JsonNode SetCore(object target, JsonObject op)
    {
        using var preparationTiming = NativePerformanceCapture.Measure("set.prepare");
        Touch(target);
        var prop = Req(op, "prop");
        var value = op["value"];
        // The parameter interface exposes Description, but JavaScript parameters reject it at runtime.
        // This is documentation only, so follow the same dropped-property contract as a missing setter.
        if (Preflight.JobNormalizer.Droppable(prop) && target is IObjectSignature parameter
            && parameter.Parent is IObjectSignature parent && Implements(parent, "IJavaScriptNode")
            && (Implements(parameter, "IInputParameter") || Implements(parameter, "IOutputParameter")))
            return DropDocumentation(target, prop, op);
        if (prop == "Schedule" && target is OutSystems.Model.Processes.ITimer)
        {
            var schedule = TimerScheduleValue.Prepare(value, FindProperty(target, "CronSchedule") != null);
            prop = schedule.Property;
            value = JsonValue.Create(schedule.Value);
        }
        // Names the Studio shows for an enum value (Changed Attributes) are the value it stores (Optimized).
        if (value is JsonValue enumText && enumText.TryGetValue<string>(out var shown) && ValueAliases.Normalize(prop, shown) is var stored && stored != shown)
            value = JsonValue.Create(stored);
        if (prop == "Public" && value?.ToString().Equals("true", StringComparison.OrdinalIgnoreCase) == true && Implements(target, "IServerAction")
            && OdcApplicationKind() is { } appKind)
            throw new InvalidOperationException($"set Public: {Describe(target)} is a server action of an ODC app ({appKind}); ODC apps do not expose public server actions "
                + "(the live Studio raises an error the headless Verify does not). Keep it Public No and call it from the app's own screens, "
                + "use a service action to serve other apps, or move it to a library.");
        if (target is EntityIndex nativeIndex && prop == "Unique")
        {
            var unique = value?.GetValue<bool>() ?? throw new InvalidOperationException("EntityIndex.Unique requires a boolean");
            RememberData(target, prop, Normal(unique), Req(op, "target"));
            preparationTiming.Dispose();
            using (NativePerformanceCapture.MeasureSet(target.GetType(), prop, "nativeProperty")) nativeIndex.Unique = unique;
            return new JsonObject { ["set"] = prop, ["via"] = "native property" };
        }
        var pi = FindProperty(target, prop);
        // O11: the record mapping of an assignment or an argument lives beside its Value (IRecordMappings, Verbs.Mapping.cs).
        if (prop == "Value" && pi is { CanWrite: false } && StudioAdapter.Runtime.Mappings is { } mappings && mappings.Owns(target))
        {
            preparationTiming.Dispose();
            return SetMappedValue(target, pi, mappings, value, Req(op, "target"));
        }
        // The app name of a module (ESpace.AppName, which the ODC Studio shows as the module's DisplayName) has no setter
        // on the Model API interfaces, only on the module class itself, where OdcAppFactory sets it when it creates an
        // app. Only that property of the module is reached this way.
        if (prop == "AppName" && (pi == null || !pi.CanWrite) && Implements(target, "IESpace")
            && target.GetType().GetProperty("AppName", BindingFlags.Public | BindingFlags.Instance) is { CanWrite: true } appName && appName.PropertyType == typeof(string))
            pi = appName;
        if (prop == "Roles" && pi?.GetValue(target) is ICollection<OutSystems.Model.Logic.IRoleSignature> roles)
        {
            var wanted = value!.AsArray().Select(v => (OutSystems.Model.Logic.IRoleSignature)Resolve(v!.ToString())).ToArray();
            preparationTiming.Dispose();
            using (NativePerformanceCapture.MeasureSet(target.GetType(), prop, "rolesCollection"))
            {
                foreach (var role in roles.ToArray()) if (!wanted.Contains(role)) roles.Remove(role);
                foreach (var role in wanted) if (!roles.Contains(role)) roles.Add(role);
            }
            if (wanted.Any(r => AnonymousIntent.IsAnonymousRole(TypeResolver.Name(r)))) DeclareAnonymous(target);
            return new JsonObject { ["set"] = prop, ["via"] = "Model API collection" };
        }
        if (pi != null && pi.CanWrite)
        {
            // C27 (ODC): an expression property parsed by the platform takes the same rewrites as IExpression.Text.
            if (pi.PropertyType.FullName == "OutSystems.Model.Expressions.ExpressionDefinition" && value is JsonValue dv && dv.TryGetValue<string>(out var definition))
                value = JsonValue.Create(Expression(target, prop, definition, Req(op, "target")));
            // A sort whose Attribute a normalization reversed (`-X`): the direction written is the declared one reversed.
            if (prop == "SortDirection" && _sortFlips.Count > 0) value = SortDirectionValue(target, value);
            var converted = Convert(value, pi.PropertyType);
            // Mudar o DataType de um atributo que tem DefaultValue tipado pelo identificador (uma FK com
            // Entities.X.Y, ou um valor que deixa de caber no tipo novo) faz o proprio Verify do Studio lancar
            // "Condition is false" depois da escrita (medido nas duas faixas em 2026-09-23). Recusa-se antes.
            // Reescrever o MESMO tipo identificador nao e mudanca (o plano do contrato C# reemite o tipo quando a static
            // muda): passa como antes da guarda; so a troca real de tipo e recusada.
            var currentType = prop == "DataType" ? FindProperty(target, "DataType")?.GetValue(target) : null;
            if (prop == "DataType" && (Implements(target, "IEntityAttribute") || Implements(target, "IStructureAttribute"))
                && UiCatalog.Prop(target, "DefaultValue") is IExpression { Text.Length: > 0 } currentDefault
                && (currentType is OutSystems.Model.Types.IIdentifierType || converted is OutSystems.Model.Types.IIdentifierType)
                && !(currentType is OutSystems.Model.Types.IIdentifierType was && converted is OutSystems.Model.Types.IIdentifierType now && Equals(was.Entity, now.Entity)))
                throw new InvalidOperationException($"set DataType on {Describe(target)}: the attribute has a DefaultValue ({currentDefault.Text}) typed by an identifier; clear it first (set DefaultValue \"\"), then change the type (the Studio's own validation fails otherwise), or replace the attribute by a new one");
            // Um ITimeOfDay guarda a hora no seu proprio item (Hour/Minute), nao em Values, e o Studio nunca lhe muda o
            // Interval (fica Any). Com AtOrOn/Every/Between, a ordenacao que o Schedule refaz a cada filho criado ou alterado
            // (SortScheduleItemsComparer) le Values nulo e cai em NullReferenceException assim que ha dois (ODC, 2026-10-03).
            if (prop == "Interval" && Implements(target, "ITimeOfDay") && converted?.ToString() != "Any")
                throw new InvalidOperationException($"set Interval on {Describe(target)}: a time of day keeps Interval Any (its time is its own Hour and Minute, which the timer's Schedule writes, e.g. \"10:00 14:30\"); {converted} leaves it without values and the platform fails ordering the schedule items once two exist. Set the timer's Schedule or CronSchedule (e.g. \"0 10 * * *\"), or use IHour/IMinute items for {converted}");
            // O Identifier de um registo de static entity e o seu nome (o setter chama SetName), e SetName sufixa uma
            // colisao EM SILENCIO (Received -> Received2), ao contrario do `rename`, que a recusa. Medido no ODC em
            // static-entity-lifecycle; a mesma guarda do rename, antes de escrever, nas duas faixas.
            List<(string, JsonNode?, bool)>? renaming = null; string? oldIdentifier = null;
            if (prop == "Identifier" && converted is string wanted && target is ServiceStudio.Model.AbstractObject named && !string.Equals(TypeResolver.Name(named), wanted, StringComparison.Ordinal))
            {
                var final = ServiceStudio.Model.AbstractObject.NameClash(named, wanted);
                if (!string.Equals(final, wanted, StringComparison.Ordinal))
                    throw new InvalidOperationException($"set Identifier: '{wanted}' clashes with an existing name in that scope (the Studio would use '{final}'); pick another identifier");
                // O Identifier de um registo e o seu nome: a plataforma reescreve o que o cita (defaults, filtros, o
                // Label igual ao nome antigo). O contrato absorve essas reescritas como faz no rename.
                oldIdentifier = TypeResolver.Name(named); renaming = SnapshotAssertions();
            }
            RememberValue(target, prop, Remembered(converted, value), Req(op, "target"));
            // Clear old placeholder content before changing the definition; otherwise the Studio retains
            // populated, now-orphaned placeholders even when the new block has no corresponding slot.
            if (prop == "SourceBlock" && op["empty"]?.GetValue<bool>() is true) ClearDefaults(target);
            // A new Action (execute node) or Handler (event handler) keeps the argument values of the parameters that keep
            // their name; the arguments the new target has no parameter for go.
            var arguments = prop is "Action" or "Handler" ? CaptureArguments(target) : null;
            preparationTiming.Dispose();
            try { using (NativePerformanceCapture.MeasureSet(target.GetType(), prop, "property.SetValue")) pi.SetValue(target, converted); }
            catch (TargetInvocationException ex) when (ex.InnerException != null)
            {
                // A plataforma recusa algumas escritas com uma asserção opaca ("Condition is false": mudar o DataType de uma
                // FK com DefaultValue ou consumidores, medido no O11 em 2026-09-23). Diz-se o alvo e a propriedade.
                throw new InvalidOperationException($"set {prop} on {Describe(target)}: the platform refused the write ({ex.InnerException.GetType().Name}: {ex.InnerException.Message}). For a DataType change on a foreign key, clear the DefaultValue and remove the consumers first, or replace the attribute by a new one", ex.InnerException);
            }
            if (renaming != null) AbsorbPlatformRewrites(renaming, "set Identifier", oldIdentifier, converted as string);
            if (prop == "AnonymousAccess" && AnonymousIntent.Opens(converted)) DeclareAnonymous(target);
            // Num tema com CSS do Theme Editor, ITheme.StyleSheet escreve a metade do autor e le a efetiva, que
            // so a interface recompoe: sem isto o get seguinte devolve o texto antigo e a escrita fica invisivel.
            JsonObject? styleSheet = null;
            if (prop == "StyleSheet" && ThemeCss.Of(target) is { } sheet && ThemeCss.IsSplit(sheet))
            {
                ThemeCss.Recompute(sheet);
                styleSheet = ThemeCss.Landing(sheet);
            }
            // Some compound native properties have invalid getters until the remaining setters run
            // (e.g. ComboBox.SourceEntity before SourceAttribute). Expose the assigned reference
            // directly; read back the completed model during the independent proof.
            var unhidden = Unhide(converted);
            var cleared = op["empty"]?.GetValue<bool>() is true ? ClearDefaults(target) : null;
            var rebound = arguments != null ? RebindArguments(target, pi.GetValue(target), arguments) : null;
            return new JsonObject { ["set"] = prop, ["via"] = "property", ["emptied"] = cleared, ["unhidden"] = unhidden > 0 ? unhidden : null, ["styleSheet"] = styleSheet, ["arguments"] = rebound };
        }
        if (target is OutSystems.Model.Logic.Nodes.IRefreshDataNode refresh && prop is "StartIndex" or "MaxRecords")
        {
            var text = value?.GetValue<string>() ?? "";
            // Left out (logic node default): the Max. Records of the aggregate it refreshes, or 50 when that is empty.
            if (prop == "MaxRecords" && text.Trim().Length == 0 && !_verbatim) text = RefreshMaxRecords(refresh);
            preparationTiming.Dispose();
            using (NativePerformanceCapture.MeasureSet(target.GetType(), prop, "refreshDataSetter"))
                if (prop == "StartIndex") refresh.SetStartIndex(text); else refresh.SetMaxRecords(text);
            return new JsonObject { ["set"] = prop, ["via"] = "Model API setter" };
        }
        // propriedade so-leitura que devolve uma expressao (Input.Variable, Button.Enabled, Dropdown.List, Aggregate.MaxRecords...): escreve o Text
        // ODC (no IRecordMappings): a mapping (`Source mapTo { ... }`) is a conversion expression the platform builds from the
        // whole text, which only the setter writes; the Text of an existing value holds its source alone (an edit wrote the
        // mapping inside it: `... mapTo { ... } mapTo {  }`, a syntax error; re-check of 2026-10-12, probe E2 on ODC).
        // Junction 24-1-final: on the ODC lane this branch writes such a value whole through OdcWholeValue (the 24.1 fixes,
        // b5c28f8e), which also removes the conversion the value had (two assignments that trade places kept the old one when
        // the mapping went to the setter below); the exclusion stays for any other runtime without mappings.
        if (pi != null && !pi.CanWrite && pi.GetValue(target) is IExpression expr
            && !(prop == "Value" && StudioAdapter.Runtime.Mappings == null && MessageExpectations.Lane != "odc" && value is JsonValue mapped && mapped.TryGetValue<string>(out var mappedText)
                && Anvil.Reading.FlowMapping.Split(mappedText) != null && FindMethod(target, "Set" + prop, 1) != null))
        {
            // C27: plain words are the text they mean, Type:Entity/Attribute is Entity.Attribute; unbalanced quotes refuse.
            var expressionText = value is JsonValue ev && ev.TryGetValue<string>(out var given) ? Expression(target, prop, given, Req(op, "target")) : value?.ToString() ?? "";
            RememberData(target, prop, JsonValue.Create(expressionText), Req(op, "target"));
            // Preserve evaluation order: the source value conversion occurs at the
            // same write site, and only metadata identifies its diagnostic group.
            preparationTiming.Dispose();
            if (prop == "Value" && MessageExpectations.Lane == "odc") {
                if (OdcWholeValue(target, expressionText, Req(op, "target")) is { } whole) return whole;
                // The value read again: with a conversion, the element's Value is the conversion, which OdcWholeValue removed.
                if (pi.GetValue(target) is IExpression now) expr = now;
            }
            using (NativePerformanceCapture.MeasureSet(target.GetType(), prop, "expression.Text")) expr.Text = expressionText;
            OdcParsed(target, pi, prop, expressionText);
            if (op["empty"]?.GetValue<bool>() is true) ClearDefaults(target);
            return new JsonObject { ["set"] = prop, ["via"] = "expression.Text" };
        }
        if (target is OutSystems.Model.Logic.Nodes.IRecordListToExcelNode excel && prop == "AttributeSelection")
        {
            var selection = value?.AsArray().Select(v => v!.GetValue<string>()).ToArray() ?? throw new ArgumentException("AttributeSelection requires strings");
            preparationTiming.Dispose();
            using (NativePerformanceCapture.MeasureSet(target.GetType(), prop, "excelSelection"))
            {
                foreach (var attribute in excel.AttributeSelection.ToArray()) excel.RemoveAttributeSelection(attribute);
                foreach (var attribute in selection) excel.AddAttributeSelection(attribute);
            }
            return new JsonObject { ["set"] = prop, ["via"] = "Model API attribute selection" };
        }
        // expressoes e afins: Set<Prop>(string)
        var setter = FindMethod(target, "Set" + prop, 1) ?? (pi != null && !pi.CanWrite ? FindMethod(target, "Set" + prop, 1) : null);
        if (setter != null)
        {
            // C27: an expression written through its setter (an empty DefaultValue; ODC IMobileScreen.SetTitle takes an
            // ExpressionDefinition) takes the same rewrites as expression.Text.
            var setterType = setter.GetParameters()[0].ParameterType;
            if ((setterType == typeof(string) || setterType.FullName == "OutSystems.Model.Expressions.ExpressionDefinition")
                && value is JsonValue sv && sv.TryGetValue<string>(out var setterText) && IsExpressionProperty(target, prop))
                value = JsonValue.Create(Expression(target, prop, setterText, Req(op, "target")));
            var converted = Convert(value, setter.GetParameters()[0].ParameterType);
            RememberValue(target, prop, Remembered(converted, value), Req(op, "target"));
            var arguments = prop is "Action" or "Handler" ? CaptureArguments(target) : null;
            preparationTiming.Dispose();
            using (NativePerformanceCapture.MeasureSet(target.GetType(), prop, "setter.Invoke")) setter.Invoke(target, new[] { converted });
            var rebound = arguments != null ? RebindArguments(target, pi?.GetValue(target) ?? converted, arguments) : null;
            return new JsonObject { ["set"] = prop, ["via"] = setter.Name, ["arguments"] = rebound };
        }
        // Uma lista que o Model API so edita por um par Add.../Remove... sobre arrays do seu tipo de elemento
        // (ISemanticSearchNode.SearchAttributes: AddSearchableAttributes/RemoveSearchableAttributes, ODC): o set escreve a
        // lista inteira, tirando o que sobra e acrescentando o que falta.
        if (pi != null && !pi.CanWrite && value is JsonArray items && ListEditors(target, pi) is { } editors)
        {
            var wanted = items.Select(item => Convert(item, editors.Element)!).ToArray();
            preparationTiming.Dispose();
            using (NativePerformanceCapture.MeasureSet(target.GetType(), prop, "listAddRemove"))
            {
                var current = ((IEnumerable)pi.GetValue(target)!).Cast<object>().ToArray();
                Array Typed(object[] values) { var array = Array.CreateInstance(editors.Element, values.Length); Array.Copy(values, array, values.Length); return array; }
                if (current.Where(c => !wanted.Contains(c)).ToArray() is { Length: > 0 } stale) editors.Remove.Invoke(target, [Typed(stale)]);
                if (wanted.Where(w => !current.Contains(w)).Distinct().ToArray() is { Length: > 0 } missing) editors.Add.Invoke(target, [Typed(missing)]);
            }
            return new JsonObject { ["set"] = prop, ["via"] = editors.Add.Name + "/" + editors.Remove.Name };
        }
        // Text parsed by the object itself: From<Prop>(string), read back by To<Prop>(). The ISchedule of an ODC workflow
        // Start is written only this way (FromCronExpression): the ITimer has CronSchedule for it, the Start node has not.
        if (value is JsonValue parsed && FindMethod(target, "From" + prop, 1) is { } parser && parser.GetParameters()[0].ParameterType == typeof(string))
        {
            preparationTiming.Dispose();
            using (NativePerformanceCapture.MeasureSet(target.GetType(), prop, "parser.Invoke")) parser.Invoke(target, new object[] { parsed.GetValue<string>() });
            return new JsonObject { ["set"] = prop, ["via"] = parser.Name, ["readBack"] = FindMethod(target, "To" + prop, 0)?.Invoke(target, null)?.ToString() };
        }
        // lentidao 2026-10-12 (cause 2): a documentation property this type has no way to write (IUserException.Description) is
        // dropped and listed (normalizations), never refused; any other property stays PROPERTY_NOT_WRITABLE.
        if (Preflight.JobNormalizer.Droppable(prop))
            return DropDocumentation(target, prop, op);
        throw new InvalidOperationException(PropertyError(target, prop));
    }

    private JsonObject DropDocumentation(object target, string prop, JsonObject op)
    {
        var raw = _applyOps != null && _applyIndex < _applyOps.Count && _applyOps[_applyIndex]?["op"]?.ToString() == "set";
        var at = OpsPointer != null && _applyOps != null && _applyIndex < _applyOps.Count ? $"{OpsPointer}/{_applyIndex}" + (raw ? "/prop" : "") : null;
        Normalized([Preflight.JobNormalizer.Dropped(at, ShortType(target), prop, op["target"]?.ToString() ?? Describe(target))]);
        return new JsonObject { ["set"] = prop, ["dropped"] = true, ["via"] = $"dropped: {ShortType(target)} has no way to write {prop}" };
    }

    /// <summary>O par Add*/Remove* (um so de cada) que recebe um array do tipo de elemento da lista `list`.</summary>
    private static (MethodInfo Add, MethodInfo Remove, Type Element)? ListEditors(object target, PropertyInfo list)
    {
        if (!list.PropertyType.IsGenericType || list.PropertyType.GetGenericTypeDefinition() != typeof(IEnumerable<>)) return null;
        var element = list.PropertyType.GetGenericArguments()[0];
        MethodInfo? Only(string verb) => AllMethods(target).Where(m => m.Name.StartsWith(verb, StringComparison.Ordinal)
            && m.GetParameters() is [{ ParameterType: var p }] && p == element.MakeArrayType()).ToList() is [var single] ? single : null;
        return Only("Add") is { } add && Only("Remove") is { } remove ? (add, remove, element) : null;
    }

    private JsonNode Link(JsonObject op)
    {
        var from = Resolve(Req(op, "from"));
        var to = Resolve(Req(op, "to"));
        Touch(from);
        var connector = op["connector"]?.GetValue<string>() ?? "Target";
        var pi = FindProperty(from, connector);
        if (pi != null && pi.CanWrite)
        {
            if (!pi.PropertyType.IsInstanceOfType(to)) throw new InvalidOperationException($"'{connector}' expects {pi.PropertyType.Name}, got {Describe(to)}");
            pi.SetValue(from, to);
            return new JsonObject { ["linked"] = connector, ["via"] = "property" };
        }
        // colecoes do dono (Roles de uma tela, RequiredScripts...): connector = nome da propriedade, Add(to)
        if (pi != null && !pi.CanWrite && pi.GetValue(from) is { } coll && coll is not string)
        {
            var add = coll.GetType().GetMethod("Add", new[] { to.GetType() }) ?? coll.GetType().GetMethods().FirstOrDefault(m => m.Name == "Add" && m.GetParameters().Length == 1 && m.GetParameters()[0].ParameterType.IsInstanceOfType(to));
            if (add != null)
            {
                add.Invoke(coll, new[] { to });
                if (connector == "Roles" && AnonymousIntent.IsAnonymousRole(TypeResolver.Name(to))) DeclareAnonymous(from);
                return new JsonObject { ["linked"] = connector, ["via"] = "collection.Add" };
            }
        }
        // Nos que ligam por CreateConnector(target) em vez de propriedade: processos (BPT) e o comentario de
        // fluxo, que pendura um ICommentConnector no no comentado.
        //
        // A sobrecarga escolhe-se pelo TIPO DO ALVO, nunca pela ordem em que as interfaces aparecem. A classe
        // concreta Comment implementa cinco areas do modelo ao mesmo tempo (Logic.Nodes, UI.Web, UI.Mobile,
        // Processes, BusinessProcesses) e expoe uma sobrecarga de CreateConnector por area; ModelApiMetadata.Methods
        // enumera Type.GetInterfaces(), cuja ordem o CLR nao garante. Com FirstOrDefault, o link morria a dizer que
        // o conector nao existe -- existindo na mesma instancia uma sobrecarga que servia.
        var cc = AllMethods(from).FirstOrDefault(m => m.Name == "CreateConnector"
            && m.GetParameters() is { Length: 1 } ps && ps[0].ParameterType.IsInstanceOfType(to));
        if (connector is "Target" or "CreateConnector" && cc != null)
        {
            var conn = cc.Invoke(from, new[] { to });
            if (op["as"]?.GetValue<string>() is { } alias && conn != null) Register(alias, conn);
            return new JsonObject { ["linked"] = "CreateConnector", ["via"] = "method" };
        }
        var targets = FindProperty(from, "Targets")?.GetValue(from);
        if (connector is "Target" or "Targets" && targets != null)
        {
            var add = targets.GetType().GetMethod("Add");
            if (add != null && add.GetParameters()[0].ParameterType.IsInstanceOfType(to)) { add.Invoke(targets, new[] { to }); return new JsonObject { ["linked"] = "Targets", ["via"] = "collection" }; }
        }
        var choices = AllProperties(from).Where(p => p.CanWrite && p.PropertyType.IsInstanceOfType(to) || HasAdd(p, from, to)).Select(p => p.Name)
            .Concat(AllMethods(from).Where(m => m.Name == "CreateConnector" && m.GetParameters().Length == 1).Select(m => m.Name)).Distinct().OrderBy(n => n).ToArray();
        throw new InvalidOperationException($"{Describe(from)} has no connector '{connector}'. Accepted (writable property, collection.Add, CreateConnector/Targets): {string.Join(", ", choices)}; similar: {string.Join(", ", NameSuggestions.Closest(connector, choices))}; see anvil api --name {ShortType(from)}");
    }

    private static string PropertyError(object target, string name)
    {
        var properties = AllProperties(target).ToArray();
        var writable = properties.Where(p => p.CanWrite).Select(p => p.Name).Distinct().OrderBy(n => n).ToArray();
        var expressions = properties.Where(p => !p.CanWrite && typeof(IExpression).IsAssignableFrom(p.PropertyType))
            .Select(p => p.Name).Distinct().OrderBy(n => n).ToArray();
        var setters = AllMethods(target).Where(m => m.Name.StartsWith("Set", StringComparison.Ordinal) && m.GetParameters().Length == 1)
            .Select(m => m.Name[3..]).Distinct().OrderBy(n => n).ToArray();
        var parsers = AllMethods(target).Where(m => m.Name.StartsWith("From", StringComparison.Ordinal) && m.GetParameters() is [{ ParameterType: var p }] && p == typeof(string))
            .Select(m => m.Name[4..]).Distinct().OrderBy(n => n).ToArray();
        var similar = NameSuggestions.Closest(name, writable.Concat(expressions).Concat(setters).Concat(parsers));
        return $"{Describe(target)} has no writable property or setter '{name}'. Writable: {string.Join(", ", writable)}; " +
            $"expression.Text: {string.Join(", ", expressions)}; Set<X>: {string.Join(", ", setters)}; " +
            (parsers.Length > 0 ? $"From<X>(text): {string.Join(", ", parsers)}; " : "") + $"similar: {string.Join(", ", similar)}; see anvil api --name {ShortType(target)}";
    }

    private static bool HasAdd(PropertyInfo property, object owner, object target)
    {
        if (property.CanWrite || property.GetIndexParameters().Length != 0) return false;
        try { return property.GetValue(owner)?.GetType().GetMethods().Any(m => m.Name == "Add" && m.GetParameters().Length == 1 && m.GetParameters()[0].ParameterType.IsInstanceOfType(target)) == true; }
        catch { return false; }
    }

    /// <summary>move {target, x/y | first | last | before | after}: REORDENA dentro do mesmo pai (ou posiciona um no de
    /// fluxo na tela). Com `into` muda de pai ou de pasta (MoveInto, Reparent.cs). Sem `into`, um irmao de outro pai cai
    /// numa asserção interna (`Condition is false`) que nao ensina nada, por isso e recusado aqui com o caminho dos dois
    /// pais. Devolve a ORDEM que ficou, para o job nao precisar de um dump so para conferir.</summary>
    private JsonNode Move(JsonObject op)
    {
        var target = Resolve(Req(op, "target"));
        Touch(target);
        if (op["into"] != null) return MoveInto(op, target);
        if (op["x"] != null || op["y"] != null)
        {
            if (target is not OutSystems.Model.IFlowNode n) throw new InvalidOperationException($"{Describe(target)} is not a flow node");
            if (op["x"] != null) n.HorizontalPosition = op["x"]!.GetValue<int>();
            if (op["y"] != null) n.VerticalPosition = op["y"]!.GetValue<int>();
            return new JsonObject { ["moved"] = "position", ["x"] = n.HorizontalPosition, ["y"] = n.VerticalPosition };
        }
        if (target is not IObjectSignature sig || sig.Parent is not IObjectSignature owner) throw new InvalidOperationException("move: target has no parent");
        return Reorder(op, sig, owner);
    }

    /// <summary>A reordenacao de `target` na sequencia de `owner` (first/last/before/after), tambem usada depois de um
    /// reparent para pôr o objeto no lugar pedido dentro do pai novo.</summary>
    private JsonNode Reorder(JsonObject op, IObjectSignature sig, IObjectSignature owner)
    {
        object target = sig;
        var seq = FindSequenceContaining(owner, sig) ?? throw new InvalidOperationException(
            $"move: {Describe(owner)} does not keep {Describe(sig)} in an ordered sequence, so there is no order to change " +
            $"(the Studio lists that kind by itself). Sequences of this parent: {string.Join(", ", Sequences(owner))}");
        var seqType = seq.GetType().GetInterfaces().First(i => i.IsGenericType && i.GetGenericTypeDefinition().Name.StartsWith("ISequence"));
        object?[] a;
        string mname;
        if (op["first"]?.GetValue<bool>() == true) { mname = "MoveToStart"; a = new object?[] { target }; }
        else if (op["last"]?.GetValue<bool>() == true) { mname = "MoveToEnd"; a = new object?[] { target }; }
        else if (op["before"] != null) { mname = "MoveBeforeSibling"; a = new object?[] { Sibling(op["before"]!.GetValue<string>(), "before"), target }; }
        else if (op["after"] != null) { mname = "MoveAfterSibling"; a = new object?[] { Sibling(op["after"]!.GetValue<string>(), "after"), target }; }
        else throw new InvalidOperationException($"move: {Describe(target)} needs a direction: x/y (no de fluxo), first, last, before or after");
        var assertionsBefore = SnapshotAssertions();   // a ordem dos atributos de um indice (AttributeKeys) muda com o move: reescrita legitima
        seqType.GetMethod(mname)!.Invoke(seq, a);
        var absorbed = AbsorbPlatformRewrites(assertionsBefore, "move", Describe(target), mname);
        return new JsonObject { ["moved"] = mname, ["target"] = Describe(target), ["order"] = Order(seq), ["dataContractRewrites"] = absorbed };

        object Sibling(string reference, string role)
        {
            var sibling = Resolve(reference);
            var siblingOwner = (sibling as IObjectSignature)?.Parent as IObjectSignature;
            if (siblingOwner == null || siblingOwner.ObjectKey?.ToString() != owner.ObjectKey?.ToString())
                throw new InvalidOperationException($"move {role}: {Describe(sibling)} is not a sibling of {Describe(target)} " +
                    $"({Describe(sibling)} is inside {(siblingOwner == null ? "no parent" : PathOf(siblingOwner))}, " +
                    $"{Describe(target)} is inside {PathOf(owner)}). move only REORDERS inside the same parent; " +
                    "to change the parent use \"into\": the new parent (before/after then name a sibling inside it).");
            return sibling;
        }
    }

    /// <summary>Os nomes das propriedades ISequence do objeto: e a lista do que se pode reordenar nele.</summary>
    private static IEnumerable<string> Sequences(IObjectSignature owner) => AllProperties(owner)
        .Where(p => p.PropertyType.IsGenericType && p.PropertyType.Name.StartsWith("ISequence", StringComparison.Ordinal))
        .Select(p => p.Name).Distinct().OrderBy(n => n, StringComparer.Ordinal);

    /// <summary>Os nomes da sequencia na ordem em que ficaram (tipo quando o objeto nao tem nome). Cortada em 40 para
    /// nao encher o resultado de um container grande.</summary>
    private static JsonNode Order(object sequence)
    {
        var names = new JsonArray();
        var total = 0;
        foreach (var item in ((IEnumerable)sequence).Cast<object>())
        {
            total++;
            if (names.Count < 40) names.Add(TypeResolver.Name(item) is { Length: > 0 } n ? n : "<" + ShortType(item) + ">");
        }
        return total > names.Count ? new JsonObject { ["first"] = names, ["total"] = total } : names;
    }

    /// <summary>duplicate {target, as?, parent?}: a copia que o Studio faz (copiar e colar nativos, Ctrl+D). Sem `parent`
    /// cola no MESMO pai, no fim da sequencia; `parent` cola noutro pai compativel (outro contentor, bloco, UI flow).
    /// Em ambos, quando o pai do Model API nao guarda aquele tipo, cola no contentor nativo dentro dele que o guarda (os
    /// outcomes de uma decisao de processo vivem num Flows.Decision que o Model API esconde). O nome ganha o sufixo que a
    /// plataforma escolhe (`Body` -> `Body2`) e a copia nasce SEM consumidores: nada passa a apontar para ela, e quem usava
    /// o original continua a usar o original. Copiar um contentor, uma action ou uma tela leva tudo o que esta dentro.
    /// O que a colagem nativa recusaria e recusado aqui com o motivo e o destino que serviria (Verbs.Duplicate.cs).</summary>
    private JsonNode Duplicate(JsonObject op)
    {
        var target = Resolve(Req(op, "target")) as IObjectSignature ?? throw new InvalidOperationException("duplicate: target is not a model object");
        // Um indice nao se duplica: a plataforma recusa dois indices com os mesmos atributos ("Condition is false", medido
        // 2026-09-23); cria-se outro com uma composicao diferente.
        if (EntityIndexes.TypeName(target) is "EntityIndex" or "EntityIndexAttribute")
            throw new InvalidOperationException($"duplicate: {Describe(target)} cannot be duplicated (the platform refuses two indexes with the same attributes); create another EntityIndex with a different composition");
        var source = target as ServiceStudio.Model.AbstractObject ?? throw new InvalidOperationException("duplicate: target is not a model object");
        if (NotCopyable(source) is { } notCopyable) throw new InvalidOperationException(notCopyable);
        var chosen = op["parent"]?.GetValue<string>() is { } parentRef
            ? Resolve(parentRef) as ServiceStudio.Model.AbstractObject ?? throw new InvalidOperationException($"duplicate: parent '{parentRef}' is not a model object")
            : null;
        var owner = PasteDestination(source, (target.Parent as ServiceStudio.Model.AbstractObject) ?? _espace, chosen);
        var from = TypeResolver.Name(target);
        IObjectSignature copy;
        try { copy = ((IObject)owner).Duplicate(target); }
        // o texto da plataforma vai junto: o envelope mostra a mensagem mais exterior que ainda contem a da raiz (Errors)
        catch (InvalidOperationException ex) when (IsPasteRefusal(ex)) { throw new InvalidOperationException($"{PasteRefusal(source, owner)} [platform: {ex.Message}]", ex); }
        // A colagem nativa converte o que o destino so aceita convertido (uma preparation colada no modulo vira server
        // action); isso nao e uma copia: o job inteiro desfaz-se.
        if (copy is ServiceStudio.Model.AbstractObject pasted && pasted.AbstractObjectKind != source.AbstractObjectKind)
            throw new InvalidOperationException($"duplicate: {Describe(owner)} turned the copy of {Describe(target)} into {Describe(copy)}; that is a conversion, not a copy: pick a parent of the same kind as {Describe(target.Parent ?? (object)_es)}");
        _lastWritten = copy;
        if (op["as"]?.GetValue<string>() is { } alias) Register(alias, copy);
        if (_byKey != null && copy.ObjectKey != null) _byKey[copy.ObjectKey.ToString()!] = copy;
        var summary = Summary(copy);
        if (summary is JsonObject so) { so["from"] = from; so["parent"] = PathOf(owner) is { Length: > 0 } path ? path : TypeResolver.Name(owner); }
        return summary;
    }

    private JsonNode Delete(JsonObject op)
    {
        var target = Resolve(Req(op, "target")) as IObjectSignature ?? throw new InvalidOperationException("delete: target is not a model object");
        Touch(target.Parent);
        // reconnect:true rejoins the flow around a node with one exit before it goes: every connector that reached it now
        // reaches its next node, so removing a step of an action is one op and not a delete plus hand-made links.
        var reconnected = op["reconnect"]?.GetValue<bool>() is true ? Reconnect(target) : null;
        // delete seguro: o Studio nao bloqueia (os consumidores viram referencias invalidas = erros de TrueChange); aqui recusa-se,
        // salvo "force": true
        var consumers = target is ServiceStudio.Model.AbstractObject ? DeleteConsumers(target) : new();
        // C36 (atritos 3): an empty placeholder content (a block instance's, with no widget) that fills the placeholder being
        // deleted goes with it, as in the Studio; it is reported, never counted as a consumer (lab 43: three empty HeaderActions).
        var cascaded = new JsonArray();
        if (op["force"]?.GetValue<bool>() is not true && op["breaks"] == null)
            foreach (var empty in consumers.Where(c => EmptyPlaceholderContent(c.Referer, target)).ToArray())
            {
                cascaded.Add((JsonNode)empty.Path);
                EsquecerApagado((IObjectSignature)empty.Referer);
                ((IObjectSignature)empty.Referer).Delete();
                consumers.Remove(empty);
            }
        // C36: consumers that later ops of this job delete (or repoint with replace) are not consumers once they run: the
        // delete waits for the end of the apply and is judged again then (Apply, pending deletes).
        if (consumers.Count > 0 && op["force"]?.GetValue<bool>() is not true && op["breaks"] == null && _applyOps != null
            && _applyIndex < _applyOps.Count && ReferenceEquals(_applyOps[_applyIndex], op) && LaterRemoved(consumers, target))
        {
            _pendingDeletes.Add((_applyIndex, op));
            return new JsonObject { ["pending"] = true, ["consumers"] = consumers.Count, ["cascaded"] = cascaded.Count > 0 ? cascaded : null,
                ["note"] = "every consumer is removed by a later op of this job: the delete runs at the end of the apply" };
        }
        // breaks: the exact consumers the caller accepts to break (the paths a DELETE_HAS_CONSUMERS refusal listed). Equal to
        // the real consumers, the delete runs and they become the broken references the job expects; different, it refuses
        // with CONSUMERS_CHANGED and the current list, before anything is deleted.
        var breaks = op["breaks"] is JsonArray accepted ? accepted.Select(b => b?.ToString() ?? "").Where(b => b.Length > 0).ToHashSet(StringComparer.Ordinal) : null;
        if (breaks != null && !breaks.SetEquals(consumers.Select(c => c.Path)))
            throw new KernelRefusalException("CONSUMERS_CHANGED", $"delete: refused, the consumers of {Describe(target)} are not the ones breaks names: now {consumers.Count} ("
                + string.Join("; ", consumers.Select(c => c.Path)) + "), breaks names " + breaks.Count + " (" + string.Join("; ", breaks) + "). Nothing was deleted",
                ConsumerProblems("CONSUMERS_CHANGED", target, consumers, "\"breaks\": [" + string.Join(", ", consumers.Select(c => "\"" + c.Path + "\"")) + "] (and the user's words name each one), or delete/rewrite them earlier in this job"));
        if (consumers.Count > 0 && op["force"]?.GetValue<bool>() is not true && breaks == null)
            throw new KernelRefusalException("DELETE_HAS_CONSUMERS", $"delete: refused, {Describe(target)} is used by {consumers.Count} consumer(s): " +
                string.Join("; ", consumers.Take(8).Select(c => c.Path)) + " (list them with usages, fix or remove those usages, or pass \"force\": true to break them"
                + "; or name those paths exactly in \"breaks\", or delete the consumers earlier in this job"
                + (target is OutSystems.Model.IFlowNode && reconnected == null ? "; a flow node with one exit is removed with {\"op\":\"delete\",\"target\":\"...\",\"reconnect\":true}" : "") + ")",
                ConsumerProblems("DELETE_HAS_CONSUMERS", target, consumers, "delete or rewrite the consumer earlier in this job, or \"breaks\": [<its path>] with the user's words naming it"));
        var s = Summary(target);
        var soapClient = Implements(target, "ISOAPAction") ? target.Parent as IObjectSignature : null;
        EsquecerApagado(target);   // o que este job apagou nao pode ser cobrado pelo contrato no fim
        target.Delete();
        // A deleted SOAP method takes the client's structures no remaining method uses (ImportedWSDL.RemoveUnusedStructures).
        var removedStructures = soapClient != null ? RemoveUnusedSoapStructures(soapClient) : null;
        var result = new JsonObject { ["deleted"] = s, ["brokenConsumers"] = consumers.Count, ["reconnected"] = reconnected };
        if (cascaded.Count > 0)
        {
            result["cascaded"] = cascaded;
            foreach (var path in cascaded) Note("DELETE_CASCADED", $"{path} was an empty placeholder content of the deleted {Describe(target)}: deleted with it");
        }
        if (breaks != null) result["breaks"] = new JsonArray(consumers.Select(c => (JsonNode)c.Path).ToArray());
        if (removedStructures is { Count: > 0 }) result["removedStructures"] = removedStructures;
        return result;
    }

    /// <summary>The connectors that reach <paramref name="node"/> are moved to its single exit (Target). A node with no exit
    /// (End, Raise) or with several (If, Switch, For Each) is refused with the links to write by hand.</summary>
    private JsonObject Reconnect(IObjectSignature node)
    {
        if (node is not OutSystems.Model.IFlowNode)
            throw new InvalidOperationException($"delete reconnect: {Describe(node)} is not a flow node; reconnect:true removes a node of an action flow with one exit (Assign, Execute Action, Aggregate, ...): {{\"op\":\"delete\",\"target\":\"<node>\",\"reconnect\":true}}");
        var exits = FlowTargets(node).Select(p => (p.Name, Value: SafeGet(p, node))).Where(e => e.Value != null).ToArray();
        if (exits.Length != 1 || exits[0].Name != "Target")
            throw new InvalidOperationException($"delete reconnect: {Describe(node)} has {exits.Length} exit(s) ({string.Join(", ", exits.Select(e => e.Name))}); reconnect:true rejoins the flow only around a node with exactly one exit (Target). "
                + "Link the previous node to the next by hand ({\"op\":\"link\",\"from\":\"<previous>\",\"to\":\"<next>\"}) and delete it without reconnect");
        var next = exits[0].Value!;
        var flow = node.Parent as IObjectSignature ?? throw new InvalidOperationException($"delete reconnect: {Describe(node)} has no flow");
        var relinked = new JsonArray();
        foreach (var other in flow.GetAllDescendantsOfType<IObjectSignature>().Where(o => !ReferenceEquals(o, node) && !IsInside(o, node)))
            foreach (var property in FlowTargets(other))
                if (ReferenceEquals(SafeGet(property, other), node) && property.PropertyType.IsInstanceOfType(next))
                {
                    property.SetValue(other, next);
                    Touch(other);
                    relinked.Add((JsonNode)(Named(other) + "." + property.Name));
                }
        return new JsonObject { ["next"] = Named(next), ["relinked"] = relinked };

        static object? SafeGet(PropertyInfo property, object owner) { try { return property.GetValue(owner); } catch { return null; } }
    }

    /// <summary>The writable connector properties of a flow node or condition (Target, TrueTarget, FalseTarget, CycleTarget...).</summary>
    private static IEnumerable<PropertyInfo> FlowTargets(object o) => AllProperties(o)
        .Where(p => p.CanRead && p.CanWrite && p.GetIndexParameters().Length == 0 && !p.PropertyType.IsValueType && p.PropertyType != typeof(string)
            && p.Name.EndsWith("Target", StringComparison.Ordinal))
        .GroupBy(p => p.Name, StringComparer.Ordinal).Select(g => g.First());

    /// <summary>Arvore de filhos (tipo, nome, chave) ate uma profundidade: para ler como o Studio monta uma tela.</summary>
    public JsonNode Dump(object o, int depth)
    {
        var j = new JsonObject { ["type"] = ShortType(o), ["name"] = TypeResolver.Name(o), ["key"] = (o as IObjectSignature)?.ObjectKey?.ToString(), ["iface"] = (o as IObjectSignature)?.GetInterface()?.FullName, ["class"] = o.GetType().FullName, ["asm"] = o.GetType().Assembly.Location };
        if (o is IExpression ex) j["text"] = ex.Text;
        else if (UiCatalog.Prop(o, "Text") is string txt && !string.IsNullOrEmpty(txt)) j["text"] = txt;
        if (depth > 0 && o is IObjectSignature sig)
        {
            var kids = new JsonArray();
            foreach (var c in sig.Children) kids.Add(Dump(c, depth - 1));
            if (kids.Count > 0) j["children"] = kids;
        }
        return j;
    }

    /// <summary>
    /// reference {producer, elements[], as?}: Manage Dependencies headless. Carrega o produtor (OML ou job:&lt;nome&gt;), resolve
    /// cada elemento por Tipo:Nome nele (tem de ser Public e valido) e chama IESpace.RefreshDependencies(IShareable[]) (Model API V1):
    /// clona para um ESpace descartavel, monta o MatchTree e faz o merge com dependencias, criando Reference + elementos referenciados.
    /// Limite conhecido: ReferenceHash fica vazio (o refresh contra o catalogo do servidor corrige).
    /// </summary>
    internal void PrepareSignatureReference(JsonObject op, NativeReferenceSnapshot snapshot)
    {
        var selected=op["elements"]?.AsArray().Select(e=>snapshot.Select(e!.GetValue<string>())).Distinct().ToArray()
            ?? throw new InvalidOperationException("reference: 'elements' is required");
        var existing=_espace.References.SingleOrDefault(r=>r.ReferenceKey.Equals(Keys.Parse(snapshot.ModuleKey)));
        var before=existing?.DirectChildren.Count() ?? 0;
        var hashBefore=existing?.ReferenceHash;
        var imported=StudioAdapter.Runtime.ImportReference(_espace,snapshot,selected);
        _byKey=null;
        if(op["as"]?.GetValue<string>() is {} importedAlias)Register(importedAlias,imported);
        _preparedReferences.Add(op,new JsonObject {["producer"]=snapshot.Name,["producerKey"]=snapshot.ModuleKey,["environment"]=snapshot.Environment,
            ["kind"]=snapshot.ModuleKind.ToString(),["signatureHash"]=snapshot.SignatureHash.ToString(),
            ["source"]=snapshot.Attestation?.Source,["versionId"]=snapshot.Attestation?.VersionId,["system"]=snapshot.Attestation?.IsSystem,
            ["requested"]=selected.Length,["closure"]=new JsonArray(snapshot.WithClosure(selected).Except(selected)
                .Select(e=>(JsonNode)(NativeReferenceSnapshot.InterfaceOf(e.Kind)+":"+e.Name)).ToArray()),
            ["added"]=imported.DirectChildren.Count()-before,["referenceExisted"]=existing!=null,
            ["referenceHashBefore"]=hashBefore?.ToString(),["referenceHash"]=imported.ReferenceHash.ToString(),
            ["references"]=new JsonArray(_es.References.Select(r=>(JsonNode)r.Name).ToArray())});
    }

    private JsonNode Reference(JsonObject op)
    {
        if(_preparedReferences.Remove(op,out var prepared))return prepared;
        var spec = Req(op, "producer");
        var loader = ProducerLoader ?? throw new InvalidOperationException("reference: no producer loader in this session (use JobRunner)");
        var producer = loader(spec);
        var pes = (IESpace)producer;
        var producerName = TypeResolver.Name(pes) ?? spec;
        var snap = ModelHost.Describe(producer, 0);
        if (!snap.IsValid) throw new InvalidOperationException($"reference: producer {producerName} is not valid ({snap.Validation.Total} messages): fix it first");
        var psession = new ModelSession(producer);
        var names = op["elements"]?.AsArray().Select(e => e!.GetValue<string>()).ToList() ?? throw new InvalidOperationException("reference: 'elements' (list of Tipo:Nome) is required");
        var shareables = new List<IShareable>();
        foreach (var n in names)
        {
            var e = psession.Resolve(n);
            if (UiCatalog.Prop(e, "Public") is false) throw new InvalidOperationException($"reference: {Describe(e)} in {producerName} is not Public; expose it in the producer with \"public\": true in spec or set ${TypeResolver.Name(e)} Public true, then rebuild the producer job or take a new snapshot and include {ShortType(e)}:{TypeResolver.Name(e)} in elements. Alternatively compare the value inside a public server action in the producer.");
            shareables.Add(e as IShareable ?? throw new InvalidOperationException($"reference: {Describe(e)} cannot be referenced (not IShareable)"));
        }
        var before = _es.References.Select(r => r.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
        _es.RefreshDependencies(shareables.ToArray());
        _byKey = null;
        var reference = _es.References.FirstOrDefault(r => string.Equals(r.Name, producerName, StringComparison.OrdinalIgnoreCase));
        if (op["as"]?.GetValue<string>() is { } alias && reference != null) Register(alias, reference);
        var elements = reference == null ? new JsonArray() : new JsonArray(((IObjectSignature)reference).Children.Select(c => (JsonNode)(ShortType(c) + ":" + TypeResolver.Name(c))).ToArray());
        return new JsonObject
        {
            ["producer"] = producerName, ["added"] = names.Count, ["referenceExisted"] = before.Contains(producerName),
            ["referenceElements"] = elements, ["references"] = new JsonArray(_es.References.Select(r => (JsonNode)r.Name).ToArray()),
        };
    }

    private JsonNode Layout(JsonObject op)
    {
        var target = Resolve(Req(op, "target"));
        // action, preparation, data action, handler: qualquer objeto com Nodes de IActionNode
        var nodes = (UiCatalog.Prop(target, "Nodes") as System.Collections.IEnumerable)?.OfType<OutSystems.Model.IFlowNode>()
              ?? throw new InvalidOperationException($"layout: {Describe(target)} has no flow nodes");
        var r = FlowLayout.Apply(nodes, TypeResolver.Name(target) ?? ShortType(target));
        var result = new JsonObject { ["action"] = r.Action, ["engineRevision"] = r.EngineRevision, ["rows"] = r.Rows, ["columns"] = r.Columns, ["moved"] = r.Moved, ["separatedEnds"] = r.SeparatedEnds };
        // The engine refusal keeps the current geometry; the job continues and the receipt lists it.
        if (r.Refused != null) { result["refused"] = r.Refused; result["keptGeometry"] = true; }
        return result;
    }

    private JsonNode Find(JsonObject op)
    {
        var name = op["name"]?.GetValue<string>();
        var type = op["type"]?.GetValue<string>();
        var max = op["max"]?.GetValue<int>() ?? 50;
        var arr = new JsonArray();
        foreach (var o in Descendants())
        {
            if (name != null && !string.Equals(TypeResolver.Name(o), name, StringComparison.OrdinalIgnoreCase)) continue;
            if (type != null && !Implements(o, type)) continue;
            arr.Add(Summary(o));
            if (arr.Count >= max) break;
        }
        return arr;
    }

    public JsonNode Get(object o)
    {
        if (EntityIndexes.Read(o) is { } index) { index["iface"] = QualifiedType(o); return index; }
        // `iface`: a interface qualificada (ou a classe nativa), para uma leitura contar como execucao NESSE tipo na descoberta
        // sem inferencias pelo nome curto (fase 3, 2026-09-23).
        var j = new JsonObject { ["type"] = ShortType(o), ["name"] = TypeResolver.Name(o), ["key"] = (o as IObjectSignature)?.ObjectKey?.ToString(), ["iface"] = QualifiedType(o) };
        var props = new JsonObject();
        foreach (var pi in AllProperties(o).GroupBy(p => p.Name).Select(g => g.OrderByDescending(p => p.CanWrite).First()))
        {
            if (pi.GetIndexParameters().Length > 0 || pi.Name is "Parent" or "Children" or "Metadata" or "TextResources" or "TextResourcesIds") continue;
            object? v;
            try { v = pi.GetValue(o); } catch { continue; }
            var t = pi.PropertyType;
            if (v == null) { props[pi.Name] = null; continue; }
            if (t.IsPrimitive || t.IsEnum || v is string || v is decimal || v is DateTime || Nullable.GetUnderlyingType(t) != null) props[pi.Name] = JsonValue.Create(v.ToString());
            else if (v is IExpression ex) props[pi.Name] = ex.Text;   // expressoes ANTES de IObjectSignature: senao get mostra @chave em vez do texto (plano, item 06a)
            else if (v is IObjectSignature s)
            {
                try { props[pi.Name] = s.ObjectKey == null ? null : "@" + s.ObjectKey; }
                catch (InvalidOperationException) { props[pi.Name] = null; } // Studio's None-type sentinel has no object key.
            }
            else if (v is IEnumerable en && v is not string) props[pi.Name] = en.Cast<object>().Count();
            else props[pi.Name] = v.ToString();
        }
        ThemeCss.Describe(o, props);   // as metades do CSS que o Model API do O11 nao publica
        j["properties"] = props;
        return j;
    }

    // ---- resolucao e reflexao ---------------------------------------------------------------

    public object Resolve(string reference)
    {
        if (_handles.TryGetValue(reference, out var h)) return h;
        // C30 (atritos 3): an alias answers with and without its $ ("as":"scr" then "$scr/...", or "as":"$scr" then "scr").
        if (AliasCounterpart(reference) is { } other && _handles.TryGetValue(other, out h)) return h;
        var producerIdentity=reference.IndexOf(":@",StringComparison.Ordinal);
        if(producerIdentity>0)
        {
            // Compiler-bound dependencies use producer + original element identity.
            // Local keys and names can change independently during import/rename.
            var type=reference[..producerIdentity];var keys=reference[(producerIdentity+2)..].Split('/');
            if(keys.Length!=2)throw new ArgumentException("Expected Type:@producerKey/originalElementKey");
            var producerKey=Keys.Parse(keys[0]);var elementKey=Keys.Parse(keys[1]);
            var producer=_espace.References.SingleOrDefault(r=>r.ReferenceKey.Equals(producerKey))
                ?? throw new KeyNotFoundException("Producer is not imported: "+keys[0]);
            var candidates=producer.DirectChildren.OfType<IObjectSignature>().Where(o=>
                ModelHost.Prop(o,"OriginalKey") is {} original && original.Equals(elementKey)
                && (Implements(o,type) || Implements(o,type+"Signature"))).ToArray();
            return candidates.Length==1?candidates[0]:throw new KeyNotFoundException("Native producer element is absent or ambiguous: "+reference);
        }
        // Qualified source imports resolve each segment uniquely, before generic child lookup.
        if(reference.StartsWith("IReference:",StringComparison.Ordinal) && reference.Split('/').Length==3)
        {
            var parts=reference["IReference:".Length..].Split('/');
            return NativeBlock(new UiNativeImport(parts[0],parts[1],parts[2]));
        }
        if (reference.StartsWith('@'))
        {
            var key = reference[1..];
            // GetAllDescendantsOfType omits some native children (e.g. IdentifierType).
            // Include the same graph exposed by inspect, while retaining O11's native index adapters.
            _byKey ??= new KernelModelReader().Walk(_es).Concat(Descendants()).Where(d => d.ObjectKey != null)
                .GroupBy(d => d.ObjectKey!.ToString()!).ToDictionary(g => g.Key, g => g.First());
            if (_byKey.TryGetValue(key, out var o) && !o.WasDeleted) return o;
            // Native setters/create can materialize children after the lookup cache was built.
            var fresh = new KernelModelReader().Walk(_es).FirstOrDefault(n => n.ObjectKey?.ToString() == key && !n.WasDeleted);
            if (fresh != null) { _byKey[key] = fresh; return fresh; }
            if (!reference.Contains('/')) throw new KeyNotFoundException("no object with key " + key);
            // Full native keys may contain slashes. Only fall back to a key/child path if the full key is absent.
        }
        var slash = reference.IndexOf('/');
        if (slash > 0)
        {
            // caminho: "$pai/Filho/#Tipo[2]/Neto" resolve segmento a segmento
            object current = Resolve(reference[..slash]);
            foreach (var segment in reference[(slash + 1)..].Split('/', StringSplitOptions.RemoveEmptyEntries))
            {
                var owner = current as IObjectSignature ?? throw new InvalidOperationException($"'{reference}': {Describe(current)} is not a model object");
                current = ResolveChild(owner, segment);
            }
            return current;
        }
        var colon = reference.IndexOf(':');
        if (colon >= 0)
        {
            // A27: the kind with or without the I of its interface (ServerActionSignature:X is IServerActionSignature:X).
            var type = Preflight.KindNames.Normalize(reference[..colon]); var name = reference[(colon + 1)..];
            List<IObjectSignature> named;
            var stableType = type is "IServerEntity" or "IEntitySignature" or "IStaticEntity" or "IStaticEntitySignature"
                or "IClientEntity" or "IClientEntitySignature" or "IStructure" or "IStructureSignature" or "IEntityActionSignature"
                or "IUserException" or "IUserExceptionSignature" or "IExtensionActionSignature"
                or "IServerAction" or "IServerActionSignature" or "IServiceAction" or "IServiceActionSignature"
                or "IClientAction" or "IClientActionSignature";
            if (_logicNames != null && stableType && !_logicActionNames!.Contains(name))
                named = _logicNames.GetValueOrDefault(name) ?? [];
            else if (_logicNames != null && _logicActionNames!.Contains(name) && _handles.TryGetValue("$" + name, out var fresh)
                && fresh is IObjectSignature freshAction && ReferenceEquals(freshAction.Parent, _espace)
                && (type is "IServerAction" or "IServiceAction" or "IClientAction") && Implements(fresh, type)
                && !(_logicNames.GetValueOrDefault(name) ?? []).Any(o => Implements(o, type) || Implements(o, type + "Signature")))
                return fresh; // no preexisting compatible symbol can change the original traversal precedence
            else named = Descendants().Where(d => string.Equals(TypeResolver.Name(d), name, StringComparison.OrdinalIgnoreCase)).ToList();
            // An element without a name answers to its Label (an If, an Assign), as in inspect (C21).
            if (named.Count == 0 && !stableType) named = Descendants().Where(d => string.IsNullOrEmpty(TypeResolver.Name(d)) && string.Equals(LabelOf(d), name, StringComparison.OrdinalIgnoreCase)).ToList();
            // Varios objectos podem casar por nome sem distincao de maiusculas e implementar o tipo pedido (um IEvent
            // 'onclick' e o IBuiltinEvent 'OnClick' de um botao implementam ambos IEvent): a ordem de GetAllDescendants
            // nao e estavel entre processos, e "o primeiro" mudava de corrida para corrida (platform-events-lifecycle,
            // 2026-09-23). Prefere-se o nome exacto e o tipo exacto; entre iguais fica a ordem de travessia.
            // In a client flow, between a client and a server action of the same name that the reference both admits, the client
            // one (A27; the team rule: List* in client lambdas). An explicit kind still decides alone.
            Func<IObjectSignature, bool>? client = _preferClient ? d => Implements(d, "IClientAction") || Implements(d, "IClientActionSignature") : null;
            var hit = ReferencePrecedence.Prefer(named.Where(d => type.Length == 0 || Implements(d, type)), d => TypeResolver.Name(d), ShortType, type, name, client);
            // elementos referenciados de outros modulos (OutSystemsUI etc.) so expoem a interface *Signature
            hit ??= ReferencePrecedence.Prefer(named.Where(d => Implements(d, type + "Signature")), d => TypeResolver.Name(d), ShortType, type + "Signature", name, client);
            // System exceptions by the names people write (AllExceptions, Database Exception, DatabaseException).
            if (hit == null && type == "ISystemException") hit = SystemExceptionNamed(name);
            if (hit != null) return hit;
            var kinds = named.Select(ShortType).Distinct().ToList();
            // Each candidate with its key, so the job can name the one it means exactly (Kind:Name or @key).
            var keyed = named.Where(d => d.ObjectKey != null).GroupBy(ShortType).Select(g => g.Key + " (" + string.Join(", ", g.Take(3).Select(d => "@" + d.ObjectKey)) + ")").Take(6).ToList();
            throw new UnresolvedReferenceException(reference, type, name, kinds.Count == 0
                ? $"no {type} named {name}: not in this module, not in its references, and not created by an EARLIER op of this job (create it first, or add the dependency with the reference verb)"
                : $"no {type} named {name}; objects with that name: {string.Join(", ", keyed.Count == kinds.Count ? keyed : kinds)}");
        }
        throw new InvalidOperationException($"unresolved reference '{reference}' (use $alias, @key or Type:Name)");
    }

    private object ResolveChild(IObjectSignature owner, string childName)
    {
        // desambiguacao explicita: "arg:Nome" = argumento pelo nome do parametro; "param:Nome" = parametro/filho pelo nome
        // (um no JavaScript tem um IInputParameter Text E um IArgument Text)
        if (childName.StartsWith("arg:", StringComparison.OrdinalIgnoreCase))
        {
            var an = childName[4..];
            foreach (var c in owner.Children) if (string.Equals(ArgumentName(c), an, StringComparison.OrdinalIgnoreCase)) return c;
            foreach (var c in owner.GetAllDescendantsOfType<IObjectSignature>()) if (string.Equals(ArgumentName(c), an, StringComparison.OrdinalIgnoreCase)) return c;
            throw new KeyNotFoundException($"{Describe(owner)} has no argument for parameter '{an}'");
        }
        if (childName.StartsWith("param:", StringComparison.OrdinalIgnoreCase))
        {
            var pn = childName[6..];
            foreach (var c in owner.Children) if (string.Equals(TypeResolver.Name(c), pn, StringComparison.OrdinalIgnoreCase)) return c;
            throw new KeyNotFoundException($"{Describe(owner)} has no child named '{pn}'");
        }
        if (childName.StartsWith('#'))
        {
            var spec = childName[1..]; var index = 1;
            var br = spec.IndexOf('[');
            if (br > 0) { index = int.Parse(spec[(br + 1)..].TrimEnd(']')); spec = spec[..br]; }
            var hits = owner.Children.Where(c => Implements(c, spec)).ToList();
            if(hits.Count<index)hits=hits.Concat(UIWidgets(owner).Where(c=>Implements(c,spec))).Distinct().ToList();
            // ODC keeps a widget's default caption inside its Content (button, link, label); SS11 puts it beside it.
            if (hits.Count < index) hits = hits.Concat(owner.Children.OfType<IObjectSignature>().Where(c => Implements(c, "IContent"))
                .SelectMany(c => c.Children.OfType<IObjectSignature>().Where(x => Implements(x, spec)))).Distinct().ToList();
            // C30: the branches of an If widget by position (#IIfBranchWidget[1] is True, [2] is False).
            if (hits.Count < index) hits = hits.Concat(new[] { "TrueBranch", "FalseBranch" }.Select(p => ModelHost.Prop(owner, p)).OfType<IObjectSignature>()
                .Where(b => Implements(b, spec))).Distinct().ToList();
            if (hits.Count >= index) return hits[index - 1];
            throw new KeyNotFoundException($"{Describe(owner)} has no child #{index} of type {spec} (has {hits.Count})");
        }
        if (childName.StartsWith("**", StringComparison.Ordinal))
        {
            // "**Tipo[n]": n-esimo DESCENDENTE desse tipo, em qualquer profundidade (conteudo de exemplo dentro de placeholders)
            var spec = childName[2..]; var index = 1;
            var br = spec.IndexOf('[');
            if (br > 0) { index = int.Parse(spec[(br + 1)..].TrimEnd(']')); spec = spec[..br]; }
            var hits = Descendants(owner, spec);
            if (hits.Count >= index) return hits[index - 1];
            throw new KeyNotFoundException($"{Describe(owner)} has no descendant #{index} of type {spec} (has {hits.Count})");
        }
        // "EntityIndex:X/<Atributo>": o atributo de indice, pelo nome do atributo que referencia (nas duas faixas).
        if (EntityIndexes.IndexAttribute(owner, childName) is { } indexAttribute) return indexAttribute;
        // A child by a typed name, `Screen/IScreenAction:Load` or `Entity/IEntityIndex:AutoIndex_X` (a name never holds a
        // colon): the child, or the one descendant, of that kind and name. Before, only a plain name was a segment, and the
        // typed one, which ssam_map prints, was refused although the child was there.
        if (TypedChild(owner, childName) is { } typed) return typed;
        foreach (var c in owner.Children)
        {
            if (string.Equals(TypeResolver.Name(c), childName, StringComparison.OrdinalIgnoreCase)) return c;
            if (string.Equals(ArgumentName(c), childName, StringComparison.OrdinalIgnoreCase)) return c;
            if (string.Equals(TypeResolver.Name(c.GetType().GetProperty("Attribute")?.GetValue(c)), childName, StringComparison.OrdinalIgnoreCase)) return c;
            // handler de evento de bloco: $instancia/<NomeDoEvento>
            if (string.Equals(TypeResolver.Name(UiCatalog.Prop(c, "Event")), childName, StringComparison.OrdinalIgnoreCase)) return c;
        }
        foreach (var c in owner.GetAllDescendantsOfType<IObjectSignature>())
            if (string.Equals(ArgumentName(c), childName, StringComparison.OrdinalIgnoreCase)) return c;
        foreach(var widget in UIWidgets(owner))if(string.Equals(TypeResolver.Name(widget),childName,StringComparison.OrdinalIgnoreCase))return widget;
        // Label of a child without a name, True/False of an If, a property of the owner that returns a model object
        // ($botao/OnClick, $tela/OnReady, $agg/OnAfterFetch), then one descendant by name: the same rules as inspect (C21).
        if (ResolveChildFallback(owner, childName) is { } fallback) return fallback;
        // LF-09 (atritos 3): an argument of a call or an event is named by the inputs of what it calls, not by child kinds.
        if (CalleeInputs(owner) is { } callee)
            throw new KeyNotFoundException($"{Describe(owner)} has no child '{childName}': " + (callee.Inputs.Count > 0
                ? $"its arguments are the inputs of {callee.Callee}: {string.Join(", ", callee.Inputs)}; closest: {string.Join(", ", NameSuggestions.Closest(childName, callee.Inputs, 3))}"
                : callee.Producer != null
                    ? $"{callee.Callee} of producer {callee.Producer} has no inputs in the signature this module holds (refresh the reference of {callee.Producer}, or capture its published signature)"
                    : callee.Callee == null
                        ? "it has no Destination or Action yet (set it first: its inputs become the arguments)"
                        : $"{callee.Callee} takes no inputs"));
        throw new KeyNotFoundException($"{Describe(owner)} has no child '{childName}' (children: {string.Join(", ", owner.Children.Select(c => ShortType(c) + (TypeResolver.Name(c) is { Length: > 0 } n ? ":" + n : "")).Distinct().Take(12))})");
    }

    private static readonly System.Text.RegularExpressions.Regex TypedSegment = new(@"^([A-Za-z][A-Za-z0-9_]*):(.+)$", System.Text.RegularExpressions.RegexOptions.Compiled);

    private static object? TypedChild(IObjectSignature owner, string segment)
    {
        var m = TypedSegment.Match(segment);
        if (!m.Success || segment.StartsWith("arg:", StringComparison.OrdinalIgnoreCase) || segment.StartsWith("param:", StringComparison.OrdinalIgnoreCase)) return null;
        var kind = Preflight.KindNames.Normalize(m.Groups[1].Value); var name = m.Groups[2].Value.Trim();
        bool Is(object o) => Implements(o, kind) || Implements(o, kind + "Signature") || kind is "IEntityIndex" && EntityIndexes.TypeName(o) == "EntityIndex";
        bool Named(object o) => string.Equals(TypeResolver.Name(o), name, StringComparison.OrdinalIgnoreCase);
        var direct = EntityIndexes.IncludeNative(owner.Children.OfType<IObjectSignature>()).Where(c => Is(c) && Named(c)).ToArray();
        if (direct.Length == 1) return direct[0];
        var below = EntityIndexes.IncludeNative(owner.GetAllDescendantsOfType<IObjectSignature>()).Where(c => Is(c) && Named(c)).Distinct().Take(2).ToArray();
        return below.Length == 1 ? below[0] : null;
    }

    /// <summary>Nome do parametro de um argumento (IArgument.Parameter.Name), ou null se nao for argumento.</summary>
    private static string? ArgumentName(object c)
    {
        var param = c.GetType().GetProperty("Parameter")?.GetValue(c);
        return param == null ? null : TypeResolver.Name(param);
    }

    private IEnumerable<IObjectSignature> Descendants() => EntityIndexes.IncludeNative(((IObjectSignature)_es).GetAllDescendantsOfType<IObjectSignature>());

    /// <summary>Every object of the module and its references, in the traversal order Resolve uses (the base facts of the
    /// preflight index them once instead of walking the module per reference).</summary>
    internal IEnumerable<IObjectSignature> AllDescendants() => Descendants();

    /// <summary>Interfaces com esse nome no Model API V1, nos assemblies ja carregados e nos plugins do Studio
    /// (Plugins/**/ServiceStudio.Plugin.*.dll: os widgets do Reactive vivem la, como IContainer, IList, IInput).</summary>
    // The logic spec names the aggregated column by its Service Studio 11 interface (the expander runs in preflight, before
    // the lane's assemblies are bound); ODC Studio calls it IAggregatedAttribute: the create resolves the lane's name.
    private List<Type> TypeCandidates(string typeName)
    {
        var found = ModelApiMetadata.Types(typeName);
        if (found.Length == 0 && typeName == "IAggregateAttribute") found = ModelApiMetadata.Types(ModelApiMetadata.AggregateColumnType);
        return found.ToList();
    }

    /// <summary>Descendentes que implementam a interface, na ORDEM DO DOCUMENTO (C28, atritos 3): pre-ordem sobre os filhos, os
    /// widgets na ordem da sua sequencia (a arvore do Studio), a mesma que "**Tipo[n]" usa. GetAllDescendantsOfType nao segue
    /// essa ordem (v02e: `**IButton[1]` era o BtnReiniciar, depois do tabuleiro); o que a pre-ordem nao alcanca fica no fim,
    /// na ordem de travessia.</summary>
    public static List<IObjectSignature> Descendants(IObjectSignature owner, string typeName)
    {
        var rank = DocumentOrder(owner);
        return EntityIndexes.IncludeNative(owner.GetAllDescendantsOfType<IObjectSignature>()).Where(c => Implements(c, typeName))
            .Select((c, i) => (c, i)).OrderBy(x => rank.TryGetValue(x.c, out var r) ? r : int.MaxValue).ThenBy(x => x.i).Select(x => x.c).ToList();
    }

    /// <summary>The pre-order rank of every object under <paramref name="owner"/>: the widgets of a sequence (Widgets, Rows,
    /// Cells) in that order first, then the other children.</summary>
    private static Dictionary<object, int> DocumentOrder(IObjectSignature owner)
    {
        var rank = new Dictionary<object, int>(ReferenceEqualityComparer.Instance);
        void Visit(IObjectSignature node)
        {
            IEnumerable<IObjectSignature> widgets;
            try { widgets = UIWidgets(node); } catch { widgets = []; }
            foreach (var child in widgets.Concat(node.Children.OfType<IObjectSignature>()))
                if (rank.TryAdd(child, rank.Count)) Visit(child);
        }
        Visit(owner);
        return rank;
    }

    public static bool Implements(object o, string typeName) => EntityIndexes.TypeName(o) == typeName || o.GetType().GetInterfaces().Any(i => i.Name == typeName || i.FullName == typeName);

    /// <summary>Acha o Create do pai para um tipo pelo NOME (o mesmo nome existe em mais de um namespace do Model API):
    /// tipado, pelo retorno; generico, por qualquer interface da API com esse nome que satisfaca a restricao.</summary>
    private IReadOnlyList<(MethodInfo Method, bool Generic, Type Target)> FindCreate(object parent, string typeName)
        => ModelApiMetadata.Creation(parent.GetType(), typeName, () => FindCreateCore(parent, typeName));

    private List<(MethodInfo Method, bool Generic, Type Target)> FindCreateCore(object parent, string typeName)
    {
        var candidates = TypeCandidates(typeName);
        if (candidates.Count == 0) throw new KeyNotFoundException($"unknown Model API type: {typeName} (not in OutSystems.Model.V1 nor in the Studio plugins)");
        // preferencia: nome completo dado > plugins NRWidgets (widgets do Reactive) > Model API V1 > resto.
        // Extensions/ExternalLibraries descrevem modulos de extensao (C#, bibliotecas externas), nunca o que um eSpace
        // cria: no ODC o mesmo nome (IStaticEntity, IEntity, IStructure) existe la e em OutSystems.Model.Data.
        // Processes/BusinessProcesses nodes (IStartNode, IEndNode, ICommentNode) share names with the Logic nodes.
        int Rank(Type t) => t.FullName == typeName ? 0 : t.Namespace?.StartsWith("ServiceStudio.Plugin.NRWidgets") == true ? 1
            : t.Namespace is "OutSystems.Model.Extensions" or "OutSystems.Model.ExternalLibraries" ? 3
            : t.Namespace?.StartsWith("OutSystems.Model.Processes") == true || t.Namespace?.StartsWith("OutSystems.Model.BusinessProcesses") == true ? 3
            : t.Namespace?.StartsWith("OutSystems.Model") == true ? 2 : 4;
        // CreateSibling (ODC IObject) creates BESIDE the object, not inside it: never a way to create a child.
        var methods = AllMethods(parent).Where(m => m.Name.StartsWith("Create", StringComparison.Ordinal) && !m.Name.StartsWith("CreateSibling", StringComparison.Ordinal)).ToList();
        var result = new List<(MethodInfo, bool, Type)>();
        foreach (var t in candidates.OrderBy(Rank))
        {
            foreach (var m in methods)
                if (!m.IsGenericMethodDefinition && (m.ReturnType == t || m.Name == "Create" + t.Name.TrimStart('I') && t.IsAssignableFrom(m.ReturnType)))
                    result.Add((m, false, t));
            // ODC also offers CreateWidget(Type type, ...): the form its own authoring uses for placeholder contents
            // (the generic form casts the placeholder's owner and fails there). The Type argument is the candidate.
            foreach (var m in methods)
                if (!m.IsGenericMethodDefinition && m.GetParameters() is { Length: > 0 } ps && ps[0].ParameterType == typeof(Type) && m.ReturnType.IsAssignableFrom(t))
                    result.Add((m, false, t));
            foreach (var m in methods)
                if (m.IsGenericMethodDefinition && m.GetGenericArguments()[0].GetGenericParameterConstraints().All(c => c.IsAssignableFrom(t)))
                    result.Add((m, true, t));
            foreach (var m in methods)
                if (!m.IsGenericMethodDefinition && t.IsAssignableFrom(m.ReturnType) && !result.Any(r => r.Item1 == m))
                    result.Add((m, false, t));
        }
        // Some types have only a GetOrCreate<X> factory (IESpace.GetOrCreateLocale(Culture), which a localized image
        // needs): the create of last resort, never ahead of a Create, and it answers the existing object if there is one.
        if (result.Count == 0)
            foreach (var t in candidates.OrderBy(Rank))
                foreach (var m in AllMethods(parent))
                    if (!m.IsGenericMethodDefinition && m.Name == "GetOrCreate" + t.Name.TrimStart('I') && t.IsAssignableFrom(m.ReturnType))
                        result.Add((m, false, t));
        return result.Distinct().ToList();
    }

    private static IEnumerable<MethodInfo> AllMethods(object o) => ModelApiMetadata.Methods(o.GetType());

    /// <summary>Todas as propriedades de todas as interfaces do Model API do objeto. A mesma propriedade aparece
    /// varias vezes (a versao `new` gravavel da interface concreta e as somente-leitura das assinaturas): nao deduplicar aqui.</summary>
    private static IEnumerable<PropertyInfo> AllProperties(object o) => ModelApiMetadata.Properties(o.GetType());

    private static PropertyInfo? FindProperty(object o, string name)
    {
        PropertyInfo? found = null;
        foreach (var p in AllProperties(o))
            if (string.Equals(p.Name, name, StringComparison.Ordinal)) { if (p.CanWrite) return p; found ??= p; }
        return found;
    }

    private static MethodInfo? FindMethod(object o, string name, int paramCount)
        => AllMethods(o).FirstOrDefault(m => string.Equals(m.Name, name, StringComparison.Ordinal) && m.GetParameters().Length == paramCount);

    private static object? FindSequenceContaining(IObjectSignature parent, IObjectSignature child)
    {
        foreach (var p in AllProperties(parent))
        {
            if (!p.PropertyType.IsGenericType || !p.PropertyType.Name.StartsWith("ISequence")) continue;
            object? v; try { v = p.GetValue(parent); } catch { continue; }
            if (v is IEnumerable en && en.Cast<object>().Any(x => ReferenceEquals(x, child))) return v;
        }
        return null;
    }

    private OutSystems.Model.Types.ITypeSignature LogicDataType(string spec)
    {
        if (_logicTypes == null) return TypeResolver.Resolve(_es, spec);
        if (!_logicTypes.TryGetValue(spec, out var type)) _logicTypes[spec] = type = TypeResolver.Resolve(_es, spec);
        return type;
    }

    /// <summary>What the data contract remembers for a written value: the expression TEXT when the platform stores a
    /// parsed definition (ODC ExpressionDefinition), because the proof reads the text back; otherwise the value itself.</summary>
    private static object? Remembered(object? converted, JsonNode? value)
        => converted != null && converted.GetType().FullName?.StartsWith("OutSystems.Model.Expressions.ExpressionDefinition", StringComparison.Ordinal) == true
            ? value?.ToString() : converted;

    private object? Convert(JsonNode? value, Type target)
    {
        var nullable = Nullable.GetUnderlyingType(target);
        if (value == null) return null;
        var t = nullable ?? target;
        if (value is JsonValue jv)
        {
            if (t == typeof(string)) return jv.ToString();
            if (t == typeof(bool)) return jv.TryGetValue<bool>(out var b) ? b : bool.Parse(jv.ToString());
            if (t == typeof(int)) return jv.TryGetValue<int>(out var i) ? i : int.Parse(jv.ToString());
            if (t == typeof(long)) return jv.TryGetValue<long>(out var l) ? l : long.Parse(jv.ToString());
            if (t == typeof(decimal)) return jv.TryGetValue<decimal>(out var d) ? d : decimal.Parse(jv.ToString());
            // Binary content (CreateImage, CreateLocalizedImage, SetImageContent): JSON has no bytes, so the job carries base64.
            if (t == typeof(byte[]))
            {
                try { return System.Convert.FromBase64String(jv.ToString()); }
                catch (FormatException) { throw new ArgumentException($"Byte[] value must be base64 text (the file content, e.g. a PNG); got {jv.ToString().Length} characters that are not base64"); }
            }
            if (t.IsEnum)
            {
                var names = Enum.GetNames(t);
                if (!names.Contains(jv.ToString(), StringComparer.OrdinalIgnoreCase))
                    throw new ArgumentException($"Invalid {t.Name} value '{jv}'; allowed: {string.Join(", ", names)}; see anvil api --name {t.Name}");
                return Enum.Parse(t, jv.ToString(), ignoreCase: true);
            }
            var s = jv.ToString();
            if (typeof(OutSystems.Model.Types.ITypeSignature).IsAssignableFrom(t) && !typeof(IObjectSignature).IsAssignableFrom(t) || t.Name is "ITypeSignature" or "IBasicType" or "IRecordTypeSignature" or "IListType")
            {
                // Identities returned by inspect must be usable for type references too.
                var resolved = s.StartsWith('@') || s.StartsWith('$') ? Resolve(s) : LogicDataType(s);
                if (!t.IsInstanceOfType(resolved)) throw new InvalidOperationException($"type '{s}' is {ShortType(resolved)}, not {t.Name}");
                return resolved;
            }
            if (t.IsInterface)
            {
                var o = Resolve(s);
                if (!t.IsInstanceOfType(o)) throw new InvalidOperationException($"'{s}' is {ShortType(o)}, not {t.Name}");
                return o;
            }
            // ODC: writable expression properties (static record values, defaults) hold a parsed ExpressionDefinition,
            // where SS11 exposes a read-only IExpression whose Text is written. Same text, parsed by the platform.
            if (t.FullName == "OutSystems.Model.Expressions.ExpressionDefinition") return ParseDefinition(t, s);
            return System.Convert.ChangeType(s, t);
        }
        throw new InvalidOperationException($"cannot convert {value.GetType().Name} to {t.Name}");
    }

    /// <summary>
    /// ODC: the value of an assignment or an argument keeps its record mapping in a conversion of its own (its
    /// ValueTypeConversion, as O11 does), which the platform reads into the value's text (Src mapTo { Total: Amount }). Written as
    /// the text of the value, a mapping or a record literal is not parsed (the text parser reads neither: NotParsedExpression),
    /// and the conversion there wraps whatever the text says (Src mapTo { new } mapTo { old }). Such a value is written whole
    /// through the element's setter (the parsed definition: the conversion it says, or the literal), after the conversion
    /// there is removed; a plain value over a conversion removes it first too (the developer's mapping the text left out, or
    /// the automatic one of the value before, which would stay hidden around the new value: the platform makes its automatic
    /// conversion again where the types differ). Null: written as text, as before.
    /// </summary>
    private JsonObject? OdcWholeValue(object target, string text, string path)
    {
        var mapping = Anvil.Reading.FlowMapping.Split(text) != null;
        var literal = !mapping && Anvil.Reading.FlowMapping.SplitRecord(text) != null;
        var conversion = (target as IObjectSignature)?.Children.OfType<IObjectSignature>().FirstOrDefault(c => Implements(c, "ITypeConversionExpression"));
        if (!mapping && !literal && conversion == null) return null;
        var setter = FindMethod(target, "SetValue", 1);
        if (setter == null || setter.GetParameters()[0].ParameterType.FullName != "OutSystems.Model.Expressions.ExpressionDefinition") return null;
        if (conversion != null) ApplyOne(new JsonObject { ["op"] = "delete", ["target"] = "@" + conversion.ObjectKey, ["force"] = true });
        if (!mapping && !literal) return null;
        var definitionType = setter.GetParameters()[0].ParameterType;
        // A record literal into an argument is built with the record type the argument takes (a generic Element takes it from
        // the List), with the scope of the action as it is now: untyped, the platform retypes it while it fills its fields and
        // fails ("Cannot create an object under a deleted parent"); tried again at most twice, as the platform settles the type.
        for (var attempt = 0; ; attempt++) {
            if (literal) RefreshScopes(target);
            var definition = (literal && ArgumentRecordType(target) is { } concrete && definitionType.GetNestedType("RecordLiteral") is { } literalType
                ? RecordLiteral(definitionType, literalType, Anvil.Reading.FlowMapping.SplitRecord(text)!, definitionType.GetMethod("Parse", BindingFlags.Public | BindingFlags.Static, [typeof(string)])!, concrete)
                : null) ?? Convert(JsonValue.Create(text), definitionType);
            RememberValue(target, "Value", Remembered(definition, JsonValue.Create(text)), path);
            try {
                using (NativePerformanceCapture.MeasureSet(target.GetType(), "Value", "setter.Invoke")) setter.Invoke(target, [definition]);
                break;
            } catch (TargetInvocationException error) when (literal && attempt < 2 && error.GetBaseException() is InvalidOperationException { Message: var message }
                && message.Contains("deleted parent", StringComparison.Ordinal)) { }
        }
        OdcParsed(target, FindProperty(target, "Value"), "Value", text);
        return new JsonObject { ["set"] = "Value", ["via"] = setter.Name, ["conversion"] = conversion == null ? null : "replaced" };
    }

    // The record type an argument takes (ConcreteParameterType): a generic one (ListAppend's Element) takes it from another
    // argument of the call (its List, written before it: ApplyFlowText's order of the arguments); while the platform has not
    // typed it, the item type of the list another argument names, when that is a parameter or local of the action.
    private static object? ArgumentRecordType(object argument)
    {
        if (ModelHost.Prop(argument, "ConcreteParameterType") is { } concrete) return concrete;
        if (argument is not IObjectSignature { Parent: IObjectSignature call } || call.Parent is not IObjectSignature action) return null;
        var siblings = call.Children.OfType<IObjectSignature>().Where(c => !ReferenceEquals(c, argument) && Implements(c, "IArgument")).ToList();
        foreach (var sibling in siblings) {
            if (ModelHost.Prop(sibling, "Value") is not IExpression { Text: { } named } || !Anvil.Reading.FlowSyntax.IsIdentifier(named.Trim())) continue;
            var variable = action.Children.OfType<IObjectSignature>().FirstOrDefault(c => !c.WasDeleted && (Implements(c, "ILocalVariable") || Implements(c, "IInputParameter") || Implements(c, "IOutputParameter"))
                && string.Equals(ModelHost.Prop(c, "Name")?.ToString(), named.Trim(), StringComparison.OrdinalIgnoreCase));
            if (variable != null && ModelHost.Prop(variable, "DataType") is OutSystems.Model.Types.IListType list) return list.ElementType;
        }
        return null;
    }

    /// <summary>The scope caches of an element and its owners up to the module dropped (the platform's own invalidation): an
    /// expression parsed next sees what the same command created before it (a local, a call node), which a cached scope of the
    /// action does not have yet.</summary>
    internal static void RefreshScopes(object element)
    {
        for (var at = element as IObjectSignature; at != null; at = at.Parent as IObjectSignature) {
            foreach (var name in new[] { "InvalidateTopLevelScopeEntriesCaches", "IncreaseScopeEntryChildrenGeneration" })
                at.GetType().GetMethod(name, BindingFlags.Public | BindingFlags.Instance, Type.EmptyTypes)?.Invoke(at, null);
            if (Implements(at, "IESpace")) break;
        }
    }

    // ODC: an expression the platform keeps as text it could not parse (NotParsedExpression) reads back as the text written and
    // means nothing (the Verify refuses it: ParserUnexpectedElement): refused at the write, with the element and the value.
    private static void OdcParsed(object target, PropertyInfo? property, string prop, string text)
    {
        if (MessageExpectations.Lane != "odc" || text.Trim().Length == 0 || property?.GetValue(target) is not { } now || now.GetType().Name != "NotParsedExpression") return;
        var message = "the platform keeps " + prop + " = `" + (text.Length <= 160 ? text : text[..160] + "...") + "` of " + Describe(target) + " as text it does not parse (the Verify refuses it)";
        throw new KernelRefusalException("FLOW_NOT_EXACT", "set " + prop + ": " + message,
            new JsonArray(JobPreflight.PublicProblem(JobPreflight.Problem(null, null, "FLOW_NOT_EXACT", "error", message,
                "write the value in a form the platform parses (a record literal only as an argument, a mapping as Source mapTo { Field: value }); nothing was kept"))));
    }

    // ODC: the platform parses the text. Its reading of a mapping (Source mapTo { Field: value, ... }) splits the fields at
    // every comma, even inside a call or a text (If(a, b, c); Replace(x, ",", "")), so a mapping the platform itself prints
    // can fail to parse back ("Missing colon separator in mapping"). Then the mapping is built from its parts: the source and
    // each field and value, every one parsed by the platform (FlowMapping splits them as the text grammar scans).
    private static object ParseDefinition(Type t, string text)
    {
        var parse = t.GetMethod("Parse", BindingFlags.Public | BindingFlags.Static, [typeof(string)])!;
        try {
            var parsed = parse.Invoke(null, [text])!;
            // A record literal the parser read as something else (its text kept unparsed): built from its fields, as below.
            if (Anvil.Reading.FlowMapping.SplitRecord(text) is { } fieldsOf && t.GetNestedType("RecordLiteral") is { } literalType && !literalType.IsInstanceOfType(parsed)
                && RecordLiteral(t, literalType, fieldsOf, parse) is { } built) return built;
            return parsed;
        }
        catch (TargetInvocationException error) when (error.InnerException is ArgumentException && Anvil.Reading.FlowMapping.Split(text) is { } mapping
            && t.GetNestedType("TypeConversion") is { } conversion)
        {
            var pair = typeof(ValueTuple<,>).MakeGenericType(t, t);
            var fields = (IList)Activator.CreateInstance(typeof(List<>).MakeGenericType(pair))!;
            foreach (var (field, value) in mapping.Fields) fields.Add(Activator.CreateInstance(pair, parse.Invoke(null, [field]), ParseDefinition(t, value)));
            var build = conversion.GetConstructor([t, typeof(IEnumerable<>).MakeGenericType(pair)]) ?? throw error.InnerException!;
            return build.Invoke([ParseDefinition(t, mapping.Source), fields]);
        }
        // The same reading of a record literal ({ Field: value, ... }) splits its fields at every comma too ("Missing colon
        // separator in record field"): the literal is built from its fields, each value parsed by the platform, without a type
        // (as the platform's own reading of a literal leaves it).
        catch (TargetInvocationException error) when (error.InnerException is ArgumentException && Anvil.Reading.FlowMapping.SplitRecord(text) is { } record
            && t.GetNestedType("RecordLiteral") is { } literal)
        {
            return RecordLiteral(t, literal, record, parse) ?? throw error.InnerException!;
        }
    }

    // A record literal built from its fields, each value parsed by the platform, of the record type given (or without one);
    // null when the definition type has no constructor for it (or none that takes that type).
    private static object? RecordLiteral(Type t, Type literal, List<(string Field, string Value)> record, MethodInfo parse, object? type = null)
    {
        var pair = typeof(ValueTuple<,>).MakeGenericType(typeof(string), t);
        var build = literal.GetConstructors().FirstOrDefault(c => c.GetParameters() is { Length: 2 } ps && ps[1].ParameterType == typeof(IEnumerable<>).MakeGenericType(pair)
            && (type == null || ps[0].ParameterType.IsInstanceOfType(type)));
        if (build == null) return null;
        var fields = (IList)Activator.CreateInstance(typeof(List<>).MakeGenericType(pair))!;
        foreach (var (field, value) in record) fields.Add(Activator.CreateInstance(pair, field, ParseDefinition(t, value)));
        return build.Invoke([type, fields]);
    }

    // `iface` = a interface qualificada que o objecto declara (GetInterface().FullName): o `type` curto e ambiguo no ODC
    // (IStaticEntity existe em Data e em Extensions) e uma prova nova precisa de saber que tipo executou.
    // Para os tipos nativos sem interface do Model API (EntityIndex no O11) a classe concreta qualificada, a mesma que o
    // ledger regista no delete/set, para o create nao ficar sem tipo qualificado (fase 3, 2026-09-23).
    private static JsonNode Summary(object o) => new JsonObject { ["type"] = ShortType(o), ["name"] = TypeResolver.Name(o), ["key"] = (o as IObjectSignature)?.ObjectKey?.ToString(), ["iface"] = QualifiedType(o) };
    private static string ShortType(object o) => EntityIndexes.TypeName(o) ?? (o as IObjectSignature)?.GetInterface()?.Name ?? o.GetType().Name;
    /// <summary>Um block instance nasce com o conteudo de exemplo dos placeholders (Tabs traz 3 TabsHeaderItem, etc.);
    /// "empty": true no create apaga esses filhos para o job por os seus.</summary>
    private static JsonObject ClearDefaults(object created)
    {
        var info = new JsonObject { ["placeholders"] = 0, ["deleted"] = 0 };
        if (created is not IObjectSignature sig) return info;
        var errors = new JsonArray();
        var placeholders = sig.Children.Where(c => c.GetType().Name.Contains("Placeholder")).ToList();
        info["placeholders"] = placeholders.Count;
        info["childTypes"] = string.Join(",", sig.Children.Select(c => c.GetType().Name).Distinct());
        // block instance: conteudo de exemplo dos placeholders; widget composto (ButtonGroup, Tabs nativas...): filhos de exemplo
        // dentro dos contentores internos ("content"), que sao widgets sem nome
        // block instance: apaga o conteudo de exemplo de cada placeholder; widget composto (ButtonGroup, ListItem...): apaga os
        // widgets-filho de exemplo (os itens nascem como filhos diretos; expressoes e eventos nao sao IWidget e ficam)
        var victims = placeholders.Count > 0
            ? placeholders.SelectMany(ph => ph.Children.Where(w => w is IWidget)).ToList()
            : sig.Children.Where(c => c is IWidget).ToList();
        foreach (var w in victims)
        {
            try { w.Delete(); info["deleted"] = info["deleted"]!.GetValue<int>() + 1; }
            catch (Exception ex) { errors.Add(ShortType(w) + ": " + Unwrap(ex)); }
        }
        if (errors.Count > 0) info["errors"] = errors;
        return info;
    }

    // ---- refatoracao: usages / rename / delete seguro (indice de referers do proprio Studio, publico em AbstractObject) ----

    /// <summary>Consumidores de um objeto fora da sua propria subarvore: tipo, nome, chave e caminho ate o elemento de topo.</summary>
    private List<(ServiceStudio.Model.AbstractObject Referer, string Path)> Consumers(object target)
    {
        var ao = target as ServiceStudio.Model.AbstractObject ?? throw new InvalidOperationException($"{Describe(target)} is not a model object");
        var list = new List<(ServiceStudio.Model.AbstractObject, string)>();
        foreach (var r in ao.Referers)
        {
            if (r == null || ReferenceEquals(r, ao) || IsInside(r, ao)) continue;
            list.Add((r, PathOf(r)));
        }
        return list;
    }

    /// <summary>Referers que o proprio Studio mantem e limpa sozinho ao apagar (lista de atributos das fontes de aggregate,
    /// registos de exemplo da entidade): contam como uso "derivado", nao bloqueiam o delete.</summary>
    private static bool IsDerived(ServiceStudio.Model.AbstractObject r, string path)
    {
        var t = ShortType(r);
        // O valor do registo de exemplo da entidade: no SS11 chama-se SampleRecord, no ODC e um IRecord com
        // IRecordAttributeValue por atributo (sonda: um atributo recem-criado, sem consumidor de autoria nenhum,
        // ja nasce com um destes). Em ambas as plataformas o Studio cria e limpa isto sozinho quando o atributo sai,
        // por isso conta como uso derivado; sem esta linha nenhum atributo de entidade pode ser apagado no ODC sem force.
        return t.Contains("AttributeReference") || t.Contains("SampleRecord") || t.Contains("RecordAttributeValue")
            || path.Contains("/SampleRecord", StringComparison.Ordinal) || path.Contains("IAddSourceOperation:", StringComparison.Ordinal);
    }

    /// <summary>
    /// Consumidores que a plataforma cria junto com o alvo e acerta sozinha quando ele sai: o Studio apaga sem perguntar e
    /// o modulo fica como estava (medido nas duas faixas na cobertura testada, fase 1: com force o Verify nao muda). Alem
    /// dos derivados (IsDerived): o IDecisionOutcomeNode de cada conector de uma Decision (a plataforma regenera o fluxo da
    /// decisao), a propriedade On*Callback com que o cliente/servico REST guarda o proprio callback, o IArgument com que o
    /// no SQL passa o parametro que ele mesmo declara, e a DefaultScreen do modulo (o Studio apaga a tela e deixa so o
    /// aviso "Unknown Default Screen"). Os tipos gerados -- o registo anonimo `X Record` e o tipo `X List` de uma entidade
    /// ou structure, a excecao `Not X` de um role -- so contam como derivados enquanto ninguem fora do alvo os usar: uma
    /// variavel do tipo `X List` parte com o alvo e continua a recusar o delete.
    /// </summary>
    private bool PlatformKept(IObjectSignature target, ServiceStudio.Model.AbstractObject r, string path)
        => AuthoredUses(target, r, path, new HashSet<object>(ReferenceEqualityComparer.Instance)).Count == 0;

    /// <summary>Os consumidores de autor que fazem `r` contar: o proprio `r`, nenhum (a plataforma mantem-no) ou, quando `r`
    /// e um tipo gerado em uso, quem usa esse tipo (a variavel `X List`, o aggregate cujo output e `X Record List`).</summary>
    private List<(ServiceStudio.Model.AbstractObject Referer, string Path)> AuthoredUses(IObjectSignature target,
        ServiceStudio.Model.AbstractObject r, string path, HashSet<object> visiting)
    {
        if (IsDerived(r, path)) return [];
        var owner = target.Parent as IObjectSignature;
        var parent = ((IObjectSignature)r).Parent as IObjectSignature;
        if (Implements(r, "IDecisionOutcomeNode")) return [];
        if (owner != null && ReferenceEquals(parent, owner) && ShortType(r) == "CustomProperty"
            && (TypeResolver.Name(r) ?? "").EndsWith("Callback", StringComparison.Ordinal)) return [];
        if (owner != null && ReferenceEquals(parent, owner) && Implements(r, "IArgument") && Implements(target, "ISQLInputParameter")) return [];
        if (r is IESpace && ReferenceEquals(UiCatalog.Prop(r, "DefaultScreen"), target)) return [];
        var generated = parent != null && Implements(parent, "IAnonymousStructure") ? parent
            : Implements(r, "IListType") || Implements(r, "IRoleException") ? (IObjectSignature)r : null;
        if (generated is not ServiceStudio.Model.AbstractObject type) return [(r, path)];
        if (!visiting.Add(type)) return [];
        return Consumers(type).Where(c => !ReferenceEquals(c.Referer, target) && !IsInside(c.Referer, target))
            .SelectMany(c => AuthoredUses(target, c.Referer, c.Path, visiting)).ToList();
    }

    /// <summary>Quem parte se o alvo sair: os consumidores do alvo e de tudo o que esta dentro dele (a FK que cita o tipo
    /// identificador de uma entidade, o Execute de uma action de entidade, a expressao que le um atributo), fora da
    /// subarvore e menos o que a plataforma mantem (AuthoredUses). Os filhos contam porque o registo anonimo `X Record`,
    /// que recusava todo delete de entidade ou structure, deixou de contar. Um consumidor dentro de outro (o IArgument de
    /// um Execute que ja conta) nao se repete: fica o de fora.</summary>
    private List<(ServiceStudio.Model.AbstractObject Referer, string Path)> DeleteConsumers(IObjectSignature target)
    {
        var list = new List<(ServiceStudio.Model.AbstractObject Referer, string Path)>();
        var seen = new HashSet<object>(ReferenceEqualityComparer.Instance);
        var visiting = new HashSet<object>(ReferenceEqualityComparer.Instance);
        foreach (var node in new KernelModelReader().Walk(target))
        {
            if (node is not ServiceStudio.Model.AbstractObject ao || !ao.HasReferers) continue;
            foreach (var r in ao.Referers)
            {
                if (r == null || ReferenceEquals(r, target) || IsInside(r, target)) continue;
                foreach (var use in AuthoredUses(target, r, PathOf(r), visiting)) if (seen.Add(use.Referer)) list.Add(use);
            }
        }
        return list.Where(c => !list.Any(o => !ReferenceEquals(o.Referer, c.Referer) && IsInside(c.Referer, o.Referer))).ToList();
    }

    private static bool IsInside(IObjectSignature o, IObjectSignature root)
    {
        for (var p = o.Parent; p != null; p = p.Parent) if (ReferenceEquals(p, root)) return true;
        return false;
    }

    /// <summary>Caminho legivel: elementos nomeados do topo ate ao objeto (Tela/Widget/Propriedade).</summary>
    private static string PathOf(IObjectSignature o)
    {
        var parts = new List<string>();
        for (IObjectSignature? cur = o; cur != null && cur is not IESpace; cur = cur.Parent as IObjectSignature)
        {
            var n = TypeResolver.Name(cur);
            parts.Add(string.IsNullOrEmpty(n) ? ShortType(cur) : $"{ShortType(cur)}:{n}");
        }
        parts.Reverse();
        // O proprio modulo (DefaultScreen, tema por omissao) nao tem caminho: diz-se quem e, em vez de um caminho vazio.
        if (parts.Count == 0 && o is IESpace) return $"{ShortType(o)}:{TypeResolver.Name(o)}";
        return string.Join("/", parts);
    }

    private static JsonObject UsageEntry((ServiceStudio.Model.AbstractObject Referer, string Path) u, bool derived) => new()
    {
        ["type"] = ShortType(u.Referer), ["name"] = TypeResolver.Name(u.Referer), ["key"] = ((IObjectSignature)u.Referer).ObjectKey?.ToString(),
        ["text"] = u.Referer is IExpression ex ? ex.Text : null, ["path"] = u.Path, ["derived"] = derived,
    };

    /// <summary>usages {target, max?}: quem usa este objeto (expressoes, argumentos, fontes de aggregate, widgets...), agrupado por tipo.</summary>
    private JsonNode Usages(JsonObject op)
    {
        var target = Resolve(Req(op, "target"));
        var max = op["max"]?.GetValue<int>() ?? 200;
        var offset = op["offset"]?.GetValue<int>() ?? 0;
        if (max < 1 || offset < 0) throw new ArgumentException("usages: max must be positive and offset non-negative");
        if (op["scope"] != null || op["includeInternal"] != null)
            return JsonSerializer.SerializeToNode(new KernelModelReader().Read(_es, "@" + ((IObjectSignature)target).ObjectKey,
                new Anvil.Reading.ReadingOptions(Max: max, Offset: offset, Usages: true,
                    Scope: op["scope"]?.GetValue<string>() ?? "subtree", IncludeInternal: op["includeInternal"]?.GetValue<bool>() ?? false)))!;
        var cons = Consumers(target).OrderBy(c => ((IObjectSignature)c.Referer).ObjectKey?.ToString(), StringComparer.Ordinal).ToList();
        // derived = o que o delete nao conta (PlatformKept), para o usages explicar a recusa com as mesmas regras
        bool Kept((ServiceStudio.Model.AbstractObject Referer, string Path) c) => target is IObjectSignature root ? PlatformKept(root, c.Referer, c.Path) : IsDerived(c.Referer, c.Path);
        var entries = cons.Skip(offset).Take(max).ToArray();
        var byType = new JsonObject();
        foreach (var g in cons.GroupBy(c => ShortType(c.Referer))) byType[g.Key] = g.Count();
        return new JsonObject
        {
            ["scope"] = "direct", ["includeInternal"] = false,
            ["limitations"] = "Legacy direct references only. Use scope:subtree for references to identifiers, parameters, attributes and other children (delete also refuses on those).",
            ["target"] = Describe(target), ["count"] = cons.Count, ["real"] = cons.Count(c => !Kept(c)), ["byType"] = byType,
            ["returned"] = entries.Length, ["offset"] = offset, ["omitted"] = cons.Count - entries.Length,
            ["truncated"] = entries.Length != cons.Count,
            ["nextOffset"] = offset + entries.Length < cons.Count ? JsonValue.Create(offset + entries.Length) : null,
            ["entries"] = new JsonArray(entries.Select(u => (JsonNode)UsageEntry(u, Kept(u))).ToArray()),
        };
    }

    /// <summary>rename {target, name}: muda o nome que o Studio mostra e edita para o tipo do alvo (NameProperty: Name,
    /// Identifier de registo, Label de no de fluxo ou de condicao de Switch, Property/Event de extended property/event).
    /// Onde o nome e unico no escopo (Name, Identifier) recusa a colisao (o Studio sufixaria em silencio). Reporta os
    /// consumidores, que continuam ligados por chave (expressoes, SQL e JS regeneram o texto). Literais, descricoes e
    /// URLs nao propagam.</summary>
    private JsonNode Rename(JsonObject op)
    {
        var target = Resolve(Req(op, "target"));
        Touch(target);
        var name = Req(op, "name");
        // Um indice renomeia-se pela classe nativa (SetName), igual nas duas faixas; nada o cita, nada e reescrito.
        if (EntityIndexes.TypeName(target) == "EntityIndex") { var indexBefore = SnapshotAssertions(); var renamedIndex = EntityIndexes.Rename(target, name); AbsorbPlatformRewrites(indexBefore, "rename", renamedIndex["from"]?.ToString(), name); return renamedIndex; }
        var ao = target as ServiceStudio.Model.AbstractObject ?? throw new InvalidOperationException($"{Describe(target)} is not a model object");
        var prop = NameProperty(target);
        var oldName = NameOf(target, prop) ?? "";
        // A colisao so existe onde o nome e unico entre irmaos. Um Label (If, Assign, ForEach...) repete-se a vontade, e o
        // NameClashHandler da plataforma nem conhece esses tipos: perguntar-lhe dava "Cannot find handler for object".
        if (prop is "Name" or "Identifier")
        {
            string final;
            try { final = ServiceStudio.Model.AbstractObject.NameClash(ao, name); }
            // O handler so existe para irmaos nomeados numa coleccao. OnApplicationReady, as callbacks de processo e a
            // Preparation tem Name na API mas sao um lugar unico do dono: o Studio nao os renomeia.
            catch (InvalidOperationException ex) when (ex.Message.StartsWith("Cannot find handler", StringComparison.Ordinal))
            { throw new InvalidOperationException($"rename: {Describe(target)} has a fixed name; the Studio does not rename it"); }
            if (!string.Equals(final, name, StringComparison.Ordinal))
                throw new InvalidOperationException($"rename: '{name}' clashes with an existing name in that scope (the Studio would use '{final}'); pick another name");
        }
        if (prop == "Name" && !_verbatim && !string.Equals(oldName, name, StringComparison.OrdinalIgnoreCase)) RenameCaptured(target, oldName, name);
        var before = Consumers(target);
        var textsBefore = before.Select(c => (c.Referer as IExpression)?.Text).ToList();
        var typeBefore = prop == "Name" ? TypeOfElement(target) : null;
        var assertionsBefore = SnapshotAssertions();   // o que o contrato de dados le agora; o que mudar DURANTE o rename e reescrita da plataforma
        // Um tipo do modelo implementa varias interfaces e mais do que uma pode declarar a mesma propriedade; a ordem de
        // Type.GetInterfaces() NAO e garantida pelo CLR, por isso "a primeira escrevivel" e uma aposta. Foi esta mesma
        // aposta que partiu o CreateConnector do ICommentConnector. Aqui escrevia-se numa Name e lia-se outra: o
        // IBlockEvent aceitava a escrita e ficava com o nome velho. Escolhe-se pela que PEGA -- confirmada pela
        // releitura da MESMA propriedade -- em vez de pela ordem em que a reflexao as devolve.
        var escreviveis = AllProperties(target).Where(p => string.Equals(p.Name, prop, StringComparison.Ordinal) && p.CanWrite).ToArray();
        foreach (var p in escreviveis)
        {
            try { p.SetValue(target, name); }
            catch when (escreviveis.Length > 1) { continue; }
            if (string.Equals(NameOf(target, prop) ?? "", name, StringComparison.Ordinal)) break;
        }
        // Escrever nao e o mesmo que ter escrito. Ha tipos -- IBlockEvent, medido em 2026-09-17 -- cujo setter de
        // Name aceita o valor e nao o guarda: o `rename` devolvia ok com `consumers:3`, o `find` pelo nome novo vinha
        // vazio, o nome velho continuava la e o modulo fechava valido. Sucesso falso e o pior contrato que esta
        // ferramenta pode ter, porque um job assim ENTREGA PROVA FALSA. Confere-se o que ficou, em vez de confiar.
        // So se dispara no no-op exacto (ficou igual ao que era, tendo-se pedido outra coisa): normalizacoes do
        // Studio -- que devolvem um terceiro valor -- ficam de fora e continuam a passar como antes.
        if (!string.Equals(oldName, name, StringComparison.Ordinal)
            && string.Equals(NameOf(target, prop) ?? "", oldName, StringComparison.Ordinal))
            throw new InvalidOperationException(
                $"rename: {ShortType(target)} accepted the write to {prop} and kept '{oldName}' -- this type cannot be "
                + "renamed through the model API. Recreate the object with the new name, or rename it in the Studio UI.");
        var typeKept = typeBefore is { } kept ? KeepType(target, kept) : null;
        var after = Consumers(target);
        var propagated = 0;
        for (var i = 0; i < before.Count; i++)
        {
            var now = (before[i].Referer as IExpression)?.Text;
            if (textsBefore[i] != null && now != null && textsBefore[i] != now) propagated++;
        }
        var absorbed = AbsorbPlatformRewrites(assertionsBefore, "rename", oldName, name);
        return new JsonObject
        {
            ["renamed"] = prop == "Name" ? Describe(target) : $"{ShortType(target)} '{NameOf(target, prop)}'", ["property"] = prop,
            ["from"] = oldName, ["to"] = name, ["consumers"] = after.Count, ["expressionsRewritten"] = propagated,
            ["dataContractRewrites"] = absorbed, ["typeKept"] = typeKept,
            ["note"] = "consumers stay linked by key; check literals/descriptions/URLs/CSS by hand (they do not propagate); values this job wrote that the platform rewrote during the rename are expected as rewritten (dataContract.assertions[].platformRewrites)",
        };
    }

    /// <summary>The raw rename of a parameter or local (of an action, or a variable of a screen or block) onto a name a mapping
    /// that names it reads first as an attribute of its source (Source mapTo { Field: Old }: inside the mapping the source's
    /// attributes come first): the value would read that attribute after the rename, and the next read prints it the same.
    /// Refused as the logic text refuses it (FLOW_RENAME_CAPTURED, with a free name); a text checks its own renames before it is
    /// written (RenameCaptures), so this runs for the raw verb only.</summary>
    private void RenameCaptured(object target, string from, string to)
    {
        if (target is IObjectSignature { Parent: IObjectSignature record } attribute && (Implements(record, "IEntitySignature") || Implements(record, "IStructureSignature"))
            && new KernelModelReader().KindOf(attribute).EndsWith("Attribute", StringComparison.Ordinal)) { AttributeRenameCaptured(attribute, record, from, to); return; }
        if (!(Implements(target, "IInputParameter") || Implements(target, "IOutputParameter") || Implements(target, "ILocalVariable"))
            || target is not IObjectSignature { Parent: IObjectSignature parent } element) return;
        var reader = new KernelModelReader();
        var actions = Anvil.Reading.ModuleFlow.ActionKinds.Contains(reader.KindOf(parent)) ? [parent]
            : Anvil.Reading.FlowOwners.IsOwner(reader, parent) ? reader.ChildrenOf(parent).Where(c => Anvil.Reading.ModuleFlow.ActionKinds.Contains(reader.KindOf(c))).ToList()
            : new List<IObjectSignature>();
        var extractor = new Anvil.Reading.FlowExtractor<IObjectSignature>(reader, (IObjectSignature)_es);
        foreach (var action in actions) {
            Anvil.Reading.FlowItem item;
            try { item = extractor.Action(action, out _); } catch (Exception error) when (error is InvalidOperationException or KeyNotFoundException or NotSupportedException) { continue; }
            if (RenameCapture(item, from, to) is not { } capture) continue;
            var message = "rename: " + reader.KindOf(element) + " " + capture.Message + " (in " + reader.KindOf(action) + " " + reader.NameOf(action) + ")";
            throw new KernelRefusalException("FLOW_RENAME_CAPTURED", message,
                new JsonArray(JobPreflight.PublicProblem(JobPreflight.Problem(null, null, "FLOW_RENAME_CAPTURED", "error", message, capture.Fix))));
        }
    }

    /// <summary>The rename of an attribute of an entity or structure (the raw verb, and the data text's rename, which runs it) onto
    /// a name a mapping of that record reads in a field value as another element (a parameter, a local, a node, a variable of the
    /// screen): inside the mapping the source's attributes come first, so after the rename that value reads the attribute, the
    /// next read prints the same text and the action means something else (correction 2: SrcRow.Note renamed Prefix, and
    /// `Src mapTo { Key: Prefix + Code }` went from the input Prefix to Src.Prefix). Refused (FLOW_RENAME_CAPTURED) with a free
    /// name. Only the actions in whose scope an element of the new name is are read.</summary>
    private void AttributeRenameCaptured(IObjectSignature attribute, IObjectSignature record, string from, string to)
    {
        var reader = new KernelModelReader();
        var attributes = reader.ChildrenOf(record).Where(c => reader.KindOf(c).EndsWith("Attribute", StringComparison.Ordinal)).Select(reader.NameOf)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var root = (IObjectSignature)_es;
        var actions = new List<IObjectSignature>();
        foreach (var element in reader.Walk(root)) {
            if (element.WasDeleted || ReferenceEquals(element, attribute) || !string.Equals(reader.NameOf(element), to, StringComparison.OrdinalIgnoreCase)
                || reader.KindOf(element).EndsWith("Attribute", StringComparison.Ordinal)) continue;
            for (var at = element.Parent as IObjectSignature; at != null && !ReferenceEquals(at, root); at = at.Parent as IObjectSignature) {
                if (Anvil.Reading.ModuleFlow.ActionKinds.Contains(reader.KindOf(at))) { actions.Add(at); break; }
                if (Anvil.Reading.FlowOwners.IsOwner(reader, at)) { actions.AddRange(reader.ChildrenOf(at).Where(c => Anvil.Reading.ModuleFlow.ActionKinds.Contains(reader.KindOf(c)))); break; }
            }
        }
        if (actions.Count == 0) return;
        var extractor = new Anvil.Reading.FlowExtractor<IObjectSignature>(reader, root);
        foreach (var action in actions.Distinct()) {
            Anvil.Reading.FlowItem item;
            try { item = extractor.Action(action, out _); } catch (Exception error) when (error is InvalidOperationException or KeyNotFoundException or NotSupportedException) { continue; }
            foreach (var (source, fields) in Anvil.Reading.FlowMapping.MappingsOf(item)) {
                // The mapping reads this record: its source typed as it (the same attributes), or, untyped, a field value that
                // names the renamed attribute.
                var typed = SourceAttributes(source, item);
                if (typed != null ? !(typed.Contains(from) && typed.SetEquals(attributes)) : !fields.Any(f => Anvil.Reading.FlowEdits.Renamed(f.Value, from, "\u0001") != f.Value)) continue;
                var at = fields.FindIndex(f => Anvil.Reading.FlowEdits.Renamed(f.Value, to, "\u0001") != f.Value);
                if (at < 0) continue;
                var named = fields[at];
                var taken = new HashSet<string>(attributes.Concat(item.Items.Where(i => Anvil.Reading.FlowItem.Keyed(i.Role)).Select(i => i.Name)), StringComparer.OrdinalIgnoreCase);
                var free = Anvil.Reading.FlowDiff.Numbered(to, taken.Contains);
                var message = "rename: " + reader.KindOf(attribute) + " " + reader.NameOf(record) + "." + from + " is renamed " + to + ", and the mapping `" + source + " mapTo { ... }` of "
                    + reader.KindOf(action) + " " + reader.NameOf(action) + " reads " + to + " in the field value `" + named.Field + ": " + named.Value + "` as another element"
                    + (typed != null ? "" : " (the module could not type `" + source + "`; its values name " + from + ")")
                    + ": inside a mapping the attributes of its source come first, so after the rename the value would read the attribute " + to + " instead";
                throw new KernelRefusalException("FLOW_RENAME_CAPTURED", message,
                    new JsonArray(JobPreflight.PublicProblem(JobPreflight.Problem(null, null, "FLOW_RENAME_CAPTURED", "error", message,
                        "give the attribute a name no element that mapping reads has, e.g. " + free))));
            }
        }
    }

    /// <summary>The type of an element that has one (attribute, variable, parameter) and its size, as written.</summary>
    private (PropertyInfo Property, object? Type, string? Length, string? Decimals)? TypeOfElement(object target)
    {
        if (FindProperty(target, "DataType") is not { CanRead: true, CanWrite: true } property) return null;
        object? type;
        try { type = property.GetValue(target); } catch { return null; }
        return (property, type, SizeText(target, "Length"), SizeText(target, "Decimals"));
    }

    private string? SizeText(object target, string name)
    {
        object? value;
        try { value = FindProperty(target, name)?.GetValue(target); } catch { return null; }
        return value is IExpression expression ? expression.Text : value?.ToString();
    }

    /// <summary>DL2: a rename changes only the name. Writing the Name of an attribute (or of a variable or parameter) makes the
    /// platform guess a type from the new name: renaming the structure attribute Nome (Text 200) to NomeProduto turned it into
    /// the Produto record and dropped its length (Service Studio 11, 2026-10-11). The type and the size it had are written
    /// back; the result names what the platform had changed (typeKept), null when it changed nothing.</summary>
    private JsonObject? KeepType(object target, (PropertyInfo Property, object? Type, string? Length, string? Decimals) before)
    {
        var now = TypeOfElement(target);
        if (now == null || Equals(now.Value.Type, before.Type) && now.Value.Length == before.Length && now.Value.Decimals == before.Decimals) return null;
        var guessed = new JsonObject { ["type"] = now.Value.Type == null ? null : TypeResolver.Name(now.Value.Type) ?? now.Value.Type.ToString(), ["length"] = now.Value.Length, ["decimals"] = now.Value.Decimals };
        before.Property.SetValue(target, before.Type);
        foreach (var (size, text) in new[] { ("Length", before.Length), ("Decimals", before.Decimals) })
            if (SizeText(target, size) != text && FindProperty(target, size) != null)
                SetCore(target, new JsonObject { ["op"] = "set", ["target"] = "@" + ((IObjectSignature)target).ObjectKey, ["prop"] = size, ["value"] = text == null ? null : JsonValue.Create(text) });
        return new JsonObject { ["guessed"] = guessed, ["kept"] = new JsonObject { ["type"] = before.Type == null ? null : TypeResolver.Name(before.Type) ?? before.Type.ToString(),
            ["length"] = before.Length, ["decimals"] = before.Decimals } };
    }

    /// <summary>
    /// A propriedade que o Studio mostra e edita como nome deste tipo, pela reflexao do Model API (as mesmas classes
    /// concretas nas duas faixas, medido em O11 11.55 e ODC 1.7.25):
    ///  * Name gravavel: a grande maioria (actions, entidades, atributos, widgets, aggregates, nos Execute/JSON/SQL...);
    ///  * Identifier: o registo de static entity (IRecord no O11, IStaticEntityRecord no ODC), cujo setter chama SetName;
    ///  * Label: os nos de fluxo que so tem rotulo -- If, Assign, ForEach, Switch, Message (a classe concreta implementa
    ///    IObjectWithWritableLabel, a mesma que a grelha de propriedades do Studio edita) -- e a condicao de Switch;
    ///  * Property de um IExtendedProperty e Event de um IEvent (Extended Event): o Name concreto e um getter que os
    ///    devolve, e o Studio so muda o nome por ali.
    /// Ficam de fora, com recusa curta: o conector de comentario (conectores nao tem nome; o Label que a API lhe publica
    /// continua a ser escrito por `set Label`) e os tipos que nao tem nenhuma destas (Start, End, Raise Exception, Filter,
    /// Sort, Join, Assignment, Comment, itens de agenda...): nem a interface nem a classe concreta tem um nome gravavel,
    /// e um "rename" la nao teria o que mudar.
    /// </summary>
    private static string NameProperty(object target)
    {
        // O que mostra o nome de OUTRO objeto: renomeia-se esse. No ODC a AddSource implementa ainda a Name gravavel do
        // IAliasedSource de Database, mas a escrita nao pega (medido na fase 1): diz-se logo onde esta o nome.
        foreach (var (kind, owner) in NomeEmprestado)
            if (Implements(target, kind)) throw new InvalidOperationException($"rename: {kind} has no name of its own; it shows the name of {owner}");
        var props = AllProperties(target).ToArray();
        bool Writable(string name) => props.Any(p => string.Equals(p.Name, name, StringComparison.Ordinal) && p.CanWrite
            && (name == "Name" || p.PropertyType == typeof(string)));
        if (Writable("Name")) return "Name";
        if (Writable("Identifier")) return "Identifier";
        // Antes do Label: o conector de comentario publica um Label gravavel, mas conectores nao tem nome.
        if (Implements(target, "ICommentConnector")) throw new InvalidOperationException($"rename: {ShortType(target)} is a connector; connectors have no name");
        if (Writable("Label")) return "Label";
        if (Implements(target, "IExtendedProperty") && Writable("Property")) return "Property";
        if (Implements(target, "IEvent") && Writable("Event")) return "Event";
        if (Implements(target, "IConnector")) throw new InvalidOperationException($"rename: {ShortType(target)} is a connector; connectors have no name");
        if (props.Any(p => string.Equals(p.Name, "Name", StringComparison.Ordinal))) throw new InvalidOperationException($"rename: {Describe(target)}: Name is read-only");
        // Um comentario so tem Text: e o que se edita nele, nao um nome.
        var text = Writable("Text") ? "; its only text is the Text property (set Text)" : "";
        throw new InvalidOperationException($"rename: {ShortType(target)} has no name (the Studio shows no Name, Label or Identifier for it){text}");
    }

    private static readonly (string Kind, string Owner)[] NomeEmprestado =
    {
        ("IAddSourceOperation", "the source it adds (rename the IAliasedSource)"),
        ("IEntityDiagramNode", "the entity it draws (rename the entity)"),
        ("IDestinationNode", "the destination it goes to (rename that screen or external site)"),
        ("IGoToDestination", "the destination it goes to (rename that screen or external site)"),
    };

    /// <summary>O nome lido pela MESMA propriedade que o rename escreve. Name le-se como sempre (TypeResolver.Name, o
    /// getter da classe concreta); as outras pela propriedade do Model API.</summary>
    private static string? NameOf(object target, string prop) => prop == "Name" ? TypeResolver.Name(target)
        : AllProperties(target).FirstOrDefault(p => string.Equals(p.Name, prop, StringComparison.Ordinal) && p.CanRead && p.GetIndexParameters().Length == 0)?.GetValue(target) as string;

    /// <summary>
    /// replace {from, to, force?}: todo consumidor de `from` passa a apontar para `to`. Nao e busca e substituicao de
    /// texto: e o mesmo mecanismo que o proprio Studio usa ao clonar e ao apagar um objeto
    /// (<c>AbstractObject.ReplaceReferences</c>, publico nas DUAS plataformas; no ODC ele ainda e publicado na API como
    /// <c>IObjectSignature.ReplaceReferences</c>, que e uma casca de uma linha sobre este mesmo metodo). Quem faz o
    /// trabalho por dentro sao as proprias implementacoes da plataforma: expressoes religam o binding, SQL e JavaScript
    /// reescrevem o texto, temas e fluxos de referencia ajustam o que guardam.
    ///
    /// O metodo e chamado em cada CONSUMIDOR, nao no alvo. Usos derivados (listas de atributos de aggregate, registos de
    /// exemplo) ficam de fora, como no delete. Tipos diferentes exigem `force`, porque trocar por outro tipo quase sempre
    /// quebra o Verify -- e o Verify do job e quem tem a ultima palavra, aqui nao se esconde nada.
    /// </summary>
    private JsonNode Replace(JsonObject op)
    {
        var from = Resolve(Req(op, "from"));
        var to = Resolve(Req(op, "to"));
        if (ReferenceEquals(from, to)) throw new InvalidOperationException("replace: 'from' and 'to' are the same object");
        var a = from as ServiceStudio.Model.AbstractObject ?? throw new InvalidOperationException($"{Describe(from)} is not a model object");
        var b = to as ServiceStudio.Model.AbstractObject ?? throw new InvalidOperationException($"{Describe(to)} is not a model object");
        var fromKind = (from as IObjectSignature)?.GetInterface()?.Name;
        var toKind = (to as IObjectSignature)?.GetInterface()?.Name;
        // Uma entidade nao se reaponta: os consumidores ligam-se aos seus filhos (tipo identificador, atributos, registo
        // anonimo `<E> Record`, tipo lista) e ReplaceReferences deixa o modulo com estruturas anonimas em falta
        // (InvalidGlobalStateException 6 no ODC; "native replacement was incomplete" no O11, medido em 2026-09-23).
        if (Implements(from, "IEntity") || Implements(from, "IServerEntity") || Implements(from, "IStaticEntity") || Implements(from, "IClientEntity"))
            throw new InvalidOperationException($"replace: {Describe(from)} is an entity and cannot be repointed: its consumers bind to its children (identifier type, attributes, anonymous record, list type), which replace does not map. Rename it, or move the consumers to the other entity by hand (attributes can be replaced one by one)");
        if (fromKind != toKind && op["force"]?.GetValue<bool>() is not true)
            throw new InvalidOperationException($"replace: {Describe(from)} is {fromKind} and {Describe(to)} is {toKind}; "
                + "replacing across kinds almost always breaks Verify (signature and type). Pass \"force\": true if that is really the intent");

        var before = Consumers(from).Where(c => !IsDerived(c.Referer, c.Path)).DistinctBy(c => c.Referer).ToList();
        var assertionsBefore = SnapshotAssertions();   // expressoes que este job escreveu e que o reapontamento reescreve
        var touched = new JsonArray();
        foreach (var referer in before.Select(c => c.Referer).Distinct())
        {
            referer.ReplaceReferences(a, b);
            touched.Add(new JsonObject { ["referer"] = PathOf(referer), ["type"] = ShortType(referer) });
        }
        var absorbed = AbsorbPlatformRewrites(assertionsBefore, "replace", Describe(from), Describe(to));
        // A prova sai do proprio modelo: quem sobrou apontando para `from` e quem passou a apontar para `to`.
        var remaining = Consumers(from).Count(c => !IsDerived(c.Referer, c.Path));
        var targetConsumers = Consumers(to).Select(c => c.Referer).ToHashSet();
        var verified = before.Count(c => targetConsumers.Contains(c.Referer));
        if (remaining != 0 || verified != before.Count)
            throw new InvalidOperationException($"replace: native replacement was incomplete: {remaining} consumers still reference the source; "
                + $"{verified}/{before.Count} original consumers were verified on the destination. The job must not be delivered.");
        _replacementTargets.Add((IObjectSignature)a); _replacementTargets.Add((IObjectSignature)b);
        return new JsonObject
        {
            ["replaced"] = Describe(from), ["with"] = Describe(to), ["consumers"] = before.Count,
            ["scope"] = "direct-external-nonderived", ["verification"] = "native-reference-index-in-memory",
            ["rewired"] = verified, ["stillPointingAtFrom"] = remaining,
            ["consumersOfTo"] = Consumers(to).Count(c => !IsDerived(c.Referer, c.Path)),
            ["dataContractRewrites"] = absorbed,
            ["touched"] = touched,
            ["note"] = "Only direct external non-derived references are replaced. Inspect usages with scope:subtree before mapping child targets. JobRunner checks the final direct reference sets again after save/reload. Literals and runtime lookups are outside this proof.",
        };
    }

    private static string Describe(object o) => $"{ShortType(o)} '{TypeResolver.Name(o)}'";
    private static string Req(JsonObject op, string field) => op[field]?.GetValue<string>() ?? throw new InvalidOperationException($"missing '{field}'");
    private static string Unwrap(Exception ex) { while (ex is TargetInvocationException { InnerException: not null } t) ex = t.InnerException!; return ex.GetType().Name + ": " + ex.Message; }

    /// <summary>Elemento de referencia OCULTO (dependencia indireta, `Hidden=true`: blocos/actions/entidades de um produtor que o modulo
    /// nao referencia explicitamente) ligado por uma propriedade: o Studio so o "puxa" com verificacao de dependencias, que o merge
    /// automatico desliga, e o merge descartava os filhos da instancia (2 erros e 56 objetos perdidos, docs/mapa/2026-09-04-fidelidade-do-merge.md).
    /// Desoculta o elemento e os seus filhos ocultos (parametros, eventos). Devolve quantos desocultou.</summary>
    public static int Unhide(object? element)
    {
        if (element == null) return 0;
        var n = 0;
        var typeName = element.GetType().Name;
        if (!typeName.StartsWith("Reference", StringComparison.Ordinal) && !Implements(element, "ITopLevelReferenceElement")) return 0;
        n += SetHiddenFalse(element);
        if (element is IObjectSignature sig)
            foreach (var d in sig.GetAllDescendantsOfType<IObjectSignature>()) n += SetHiddenFalse(d);
        return n;
    }

    private static int SetHiddenFalse(object o)
    {
        var p = o.GetType().GetProperty("Hidden", BindingFlags.Public | BindingFlags.Instance);
        if (p == null || p.PropertyType != typeof(bool) || !p.CanWrite) return 0;
        try
        {
            if (p.GetValue(o) is true) { p.SetValue(o, false); return 1; }
        }
        catch { /* propriedade sem setter utilizavel neste tipo */ }
        return 0;
    }
}
