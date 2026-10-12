using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;
using OutSystems.ObjectKeys;
using OutSystems.RuntimeCommon;
using ServiceStudio.PluginAPI.Debugger;
using ServiceStudio.ServerCommunications.API;

// Metadata is private bootstrap data from the published-model reader. It selects
// addresses; it does not evaluate expressions or claim that a request owns roles.
internal sealed class InspectionVariable {
    public string ModuleKey { get; set; } = "";
    public string FunctionKey { get; set; } = "";
    public string? NodeKey { get; set; }
    public string VariableKey { get; set; } = "";
    public string SourceSha256 { get; set; } = "";
    public string Name { get; set; } = "";
    public string Category { get; set; } = "local";
    public string Path { get; set; } = "";
    internal string Tag => Category switch { "session" => "session", "site" or "setting" => "site", "timer" => "timer", _ => "local" };
    internal void Validate() {
        if (!Regex.IsMatch(ModuleKey, "^[A-Za-z0-9_+]{22}$") || !Regex.IsMatch(FunctionKey, @"^[A-Za-z0-9_+]{22}(?:\.#Preparation)?$") ||
            NodeKey != null && !Regex.IsMatch(NodeKey, "^[A-Za-z0-9_+]{22}$") ||
            !Regex.IsMatch(VariableKey, "^[A-Za-z0-9_+]{22}$") || !Regex.IsMatch(SourceSha256, "^[a-f0-9]{64}$") ||
            Name.Length is < 1 or > 500 || Name.Any(char.IsControl) ||
            Category is not ("input" or "output" or "local" or "return" or "session" or "site" or "setting" or "timer"))
            throw new DebugFailure("debug_invalid_inspection_metadata");
        if (Category == "return") { if (Path != "$return") throw new DebugFailure("debug_invalid_inspection_path"); }
        else if (Tag == "site") {
#if ODC
            if (!Regex.IsMatch(Path, "^[a-fA-F0-9-]{36}\\.[a-fA-F0-9-]{36}$") ||
                !Guid.TryParseExact(Path[..36], "D", out _) || !Guid.TryParseExact(Path[37..], "D", out _)) throw new DebugFailure("debug_invalid_inspection_path");
#else
            Configuration.ValidatePaths([Path]);
#endif
        } else Configuration.ValidatePaths([Path]);
    }
}
internal class InspectionSourceBinding {
    public string ModuleKey { get; set; } = "";
    public string SourceSha256 { get; set; } = "";
    internal void ValidateSource() {
        if (!Regex.IsMatch(ModuleKey, "^[A-Za-z0-9_+]{22}$") || !Regex.IsMatch(SourceSha256, "^[a-f0-9]{64}$"))
            throw new DebugFailure("debug_invalid_inspection_source_binding");
    }
}
internal class InspectionScopeBinding : InspectionSourceBinding {
    public string FunctionKey { get; set; } = "";
    public string NodeKey { get; set; } = "";
    internal void Validate() {
        if (!Regex.IsMatch(ModuleKey, "^[A-Za-z0-9_+]{22}$") || !Regex.IsMatch(FunctionKey, "^[A-Za-z0-9_+]{22}$") ||
            !Regex.IsMatch(NodeKey, "^[A-Za-z0-9_+]{22}$") || !Regex.IsMatch(SourceSha256, "^[a-f0-9]{64}$"))
            throw new DebugFailure("debug_invalid_inspection_scope");
    }
}
internal sealed class InspectionScopeUpdate : InspectionScopeBinding {
    public string? PreviousNodeKey { get; set; }
    public int Generation { get; set; }
    public int Frame { get; set; }
    public InspectionVariable[] Variables { get; set; } = [];
}
internal sealed class InspectionOptions {
    public InspectionVariable[] Variables { get; set; } = [];
    public InspectionScopeBinding[] Scopes { get; set; } = [];
    public InspectionSourceBinding[] Sources { get; set; } = [];
    // Completeness is intentionally not caller-asserted. The model enumerator
    // must account for every supported category before this can become true.
    internal void Validate() {
        if (Variables == null || Variables.Length > 500) throw new DebugFailure("debug_invalid_inspection_metadata");
        foreach (var variable in Variables) variable.Validate();
        if (Variables.Select(v => (v.ModuleKey, v.FunctionKey, v.NodeKey, v.Category, v.Path)).Distinct().Count() != Variables.Length)
            throw new DebugFailure("debug_duplicate_inspection_variable");
        if (Scopes == null || Scopes.Length > 500) throw new DebugFailure("debug_invalid_inspection_scope");
        foreach (var scope in Scopes) scope.Validate();
        if (Sources == null || Sources.Length > 20 || Sources.Select(s => s.ModuleKey).Distinct().Count() != Sources.Length)
            throw new DebugFailure("debug_invalid_inspection_source_binding");
        foreach (var source in Sources) source.ValidateSource();
        if (Scopes.Select(s => (s.ModuleKey, s.FunctionKey, s.NodeKey)).Distinct().Count() != Scopes.Length ||
            Scopes.Select(s => (s.ModuleKey, s.SourceSha256)).Concat(Variables.Select(v => (v.ModuleKey, v.SourceSha256)))
                .Concat(Sources.Select(s => (s.ModuleKey, s.SourceSha256)))
                .GroupBy(s => s.ModuleKey).Any(g => g.Select(s => s.SourceSha256).Distinct().Count() != 1))
            throw new DebugFailure("debug_invalid_inspection_source_binding");
    }
}

// Native SDK container protocol, without a dependency on Studio's view/model.
// Values/types/children are populated by ServerVariableContainerUtils itself.
internal sealed class NativeInspectionVariable : IServerVariableContainer {
    internal readonly InspectionVariable Definition;
    internal readonly NativeInspectionVariable Root;
    internal readonly Dictionary<string, NativeInspectionVariable> Children = new(StringComparer.Ordinal);
    internal string? Value;
    internal bool Trimmed, Evaluated;
    internal int EvaluationDetail;
    public string Path { get; }
    public string TagName => Definition.Tag;
    // The native FunctionReturn container has no model Object/RootObject.
    public ObjectKey VariableKey => Definition.Category == "return" ? null! : ObjectKey.Parse(Definition.VariableKey);
    public ObjectKey RootObjectKey => Root.VariableKey;
    public IVariableContainer RootVariable => Root;
    public bool ShouldEvaluateChildren { get; set; } = true;
    public bool IsEvaluationDeferred { get; set; }
    public IEnumerable<IServerVariableContainer> VariableChildren => Children.Values;
    public VariableType Type { get; set; }
    public Func<string, bool> IsUnavailable { get; set; } = _ => false;
    internal NativeInspectionVariable(InspectionVariable definition, string? path = null, NativeInspectionVariable? root = null) {
        Definition = definition; Path = path ?? definition.Path; Root = root ?? this;
    }
    public IServerVariableContainer GetOrCreateChild(string name) {
        if (Children.TryGetValue(name, out var found)) return found;
        if (Children.Count >= 20000 || name.Length is < 1 or > 500) throw new DebugFailure("debug_native_container_limit");
        // Native VariableContainer.Path includes the dot before list indexes;
        // only the Studio display name removes it.
        var path = Path + "." + name;
        return Children[name] = new(Definition, path, Root);
    }
    public void SetValue(string value, bool wasTrimmed) { Value = value; Trimmed = wasTrimmed; Evaluated = true; }
}
internal static class NativeInspectionEvaluator {
    static readonly MethodInfo EvaluateMethod = ResolveEvaluate();
    static MethodInfo ResolveEvaluate() {
        var candidates = typeof(ServerVariableContainerUtils).GetMethods(BindingFlags.Static | BindingFlags.NonPublic).Where(m => {
            var p = m.GetParameters();
            return m.Name == "Evaluate" && m.ReturnType == typeof(void) && p.Length is 2 or 3 &&
                p[0].ParameterType == typeof(IEnumerable<IServerVariableContainer>) && p[1].ParameterType == typeof(Func<IEnumerable<IServerVariableContainer>, string>) &&
                (p.Length == 2 || p[2].IsOptional && p[2].DefaultValue == null && p[2].ParameterType.Name == "ILogger");
        }).ToArray();
        return candidates.Length == 1 ? candidates[0] : throw new DebugFailure("debug_native_evaluator_contract_changed");
    }
    internal static void Evaluate(NativeInspectionVariable variable, int frame, int detail, Func<string, string> evaluate) {
        EvaluateMany([variable], frame, detail, evaluate);
    }
    internal static void EvaluateMany(NativeInspectionVariable[] variables, int frame, int detail, Func<string, string> evaluate) {
        if (frame is < 0 or > 100 || detail is < 0 or > 4) throw new DebugFailure("debug_invalid_variables_request");
        var retryMalformedDetail = false;
        Func<IEnumerable<IServerVariableContainer>, string> callback = rows => {
            var request = new XElement("vars", rows.Select(row => new XElement(row.TagName,
                row.TagName == "local" ? new XAttribute("level", frame) : null,
                new XAttribute("detail", detail), new XAttribute("name", row.Path)))).ToString(SaveOptions.DisableFormatting);
            var xml = evaluate(request);
            // The SDK parser catches malformed XML. Validate first so an absent
            // response cannot masquerade as a freshly evaluated empty value.
            using var reader = XmlReader.Create(new StringReader(xml), new XmlReaderSettings {
                DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 4194304 });
            XElement document;
            try { document = XElement.Load(reader); }
            catch (XmlException) {
                // O11 can return malformed compound XML at detail 2 while the
                // same stopped frame returns valid native XML at detail 3.
                // Never repair XML, retry transport failures, or relax XXE/size limits.
                retryMalformedDetail = detail == 2 && xml.Length <= 4194304 &&
                    !xml.Contains("<!DOCTYPE", StringComparison.OrdinalIgnoreCase) &&
                    !xml.Contains("<!ENTITY", StringComparison.OrdinalIgnoreCase);
                throw;
            }
            foreach (var variable in rows)
                if (!document.Elements().Any(e => e.Name.LocalName == variable.TagName && e.Attribute("name")?.Value == variable.Path))
                    throw new DebugFailure("debug_native_value_missing");
            foreach (var variable in variables) variable.EvaluationDetail = detail;
            return xml;
        };
        try { EvaluateMethod.Invoke(null, EvaluateMethod.GetParameters().Length == 2
            ? [variables, callback]
            : [variables, callback, null]); }
        catch (TargetInvocationException e) when (e.InnerException != null) {
            if (retryMalformedDetail && e.InnerException is XmlException) {
                EvaluateMany(variables, frame, 3, evaluate); return;
            }
            System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(e.InnerException).Throw(); throw;
        }
        if (variables.Any(variable => !variable.Evaluated)) throw new DebugFailure("debug_native_evaluation_incomplete");
    }
}

// One registry per native stop. Replaced on every frame selection and discarded
// on resume, including uncertain resumes. References never encode native paths.
internal sealed class NativeInspection {
    sealed class Entry(InspectionVariable definition, string path) {
        internal readonly InspectionVariable Definition = definition;
        internal readonly string Path = path;
        internal string? Fingerprint;
        internal readonly Dictionary<(int Offset, int Limit), string> PageFingerprints = new();
        internal int Revision;
    }
    readonly Dictionary<string, Entry> refs = new(StringComparer.Ordinal);
    readonly Dictionary<(InspectionVariable, string), string> identities = new();
    readonly Dictionary<int, InspectionVariable> returnDefinitions = new();
    readonly Dictionary<int, InspectionScopeUpdate> boundScopes = new();
    readonly InspectionOptions options;
    readonly DebugPolicy.PrivateValues privateValues;
    readonly ThreadData thread;
    readonly Func<string, string> evaluate;
    readonly string? nativeRequestIdSha256;
    readonly PrivateInspectionWire? privateWire;
    int generation = 1, frame;
    internal NativeInspection(InspectionOptions options, DebugPolicy.PrivateValues privateValues, ThreadData thread, Func<string, string> evaluate,
        DebugTransportEvent.RequestProvenance? provenance = null, PrivateInspectionWire? privateWire = null) {
        this.options = options; this.privateValues = privateValues; this.thread = thread; this.evaluate = evaluate; frame = thread.StackTop.StackLevel;
        this.privateWire = privateWire;
        if (provenance is { Present: true, IsFallback: false, RawRequestId: { Length: > 0 and <= 512 } requestId } &&
            !requestId.Any(char.IsControl) && thread is ServerThreadData server && server.RequestId == requestId) {
            nativeRequestIdSha256 = Fingerprint(requestId); privateValues.Add(requestId);
        }
    }
    static string Fingerprint(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
    internal void Invalidate() { refs.Clear(); identities.Clear(); returnDefinitions.Clear(); generation++; }
    internal object SelectFrame(int value) {
        if (!thread.Stack.Any(f => f.StackLevel == value)) throw new DebugFailure("debug_frame_missing");
        Invalidate(); frame = value; return Scope();
    }
    string Reference(InspectionVariable definition, string path) {
        if (identities.TryGetValue((definition, path), out var existing)) return existing;
        if (refs.Count >= 20000) throw new DebugFailure("debug_inspection_reference_limit");
        var id = Guid.NewGuid().ToString("N"); refs[id] = new(definition, path); identities[(definition, path)] = id; return id;
    }
    object Context() {
        var current = thread.Stack.Single(f => f.StackLevel == frame);
        return new { runtime = "server", threadId = thread.ThreadId, eventId = thread.EventId.ToString(), frame, generation,
            moduleKey = current.FunctionId?.ESpaceKey.ToString(), functionKey = current.FunctionId?.ObjectKey.ToString(),
            // Native frame type: a reader refuses scopes of non-breakpointable owners (screen Aggregates) by it.
            functionType = current.FunctionType == null ? null : Safe(current.FunctionType),
            nodeKey = current.Breakpoint?.ObjectKey.ToString(),
            previousNodeKey = current.PreviousBreakpoint?.ObjectKey.ToString(),
            previousModuleKey = current.PreviousBreakpoint?.ESpaceKey.ToString(),
            correlation = new {
                nativeClientCallContextSha256 = thread.CallContextId >= 0
                    ? Fingerprint(thread.CallContextId.ToString(System.Globalization.CultureInfo.InvariantCulture)) : null,
                nativeRequestIdSha256, nativeRequestIdProvenance = nativeRequestIdSha256 != null,
                requestOwnershipProved = false
            } };
    }
    internal object BindScope(InspectionScopeUpdate update) {
        update.Validate();
        var current = thread.Stack.Single(f => f.StackLevel == frame);
        if (update.Generation != generation || update.Frame != frame) throw new DebugFailure("debug_stale_scope_context");
        if (update.ModuleKey != current.FunctionId?.ESpaceKey.ToString() || update.FunctionKey != current.FunctionId?.ObjectKey.ToString() ||
            update.NodeKey != current.Breakpoint?.ObjectKey.ToString() ||
            update.PreviousNodeKey != current.PreviousBreakpoint?.ObjectKey.ToString() ||
            current.PreviousBreakpoint != null && current.PreviousBreakpoint.ESpaceKey != current.FunctionId?.ESpaceKey)
            throw new DebugFailure("debug_inspection_scope_frame_mismatch");
        var sources = options.Scopes.Select(s => (s.ModuleKey, s.SourceSha256))
            .Concat(options.Variables.Select(v => (v.ModuleKey, v.SourceSha256)))
            .Concat(options.Sources.Select(s => (s.ModuleKey, s.SourceSha256))).Where(s => s.ModuleKey == update.ModuleKey).Distinct().ToArray();
        if (sources.Length != 1 || sources[0].SourceSha256 != update.SourceSha256)
            throw new DebugFailure("debug_inspection_scope_source_mismatch");
        new InspectionOptions { Variables = update.Variables }.Validate();
        if (update.Variables.Any(v => v.ModuleKey != update.ModuleKey || v.FunctionKey != update.FunctionKey ||
                v.NodeKey != update.NodeKey || v.SourceSha256 != update.SourceSha256 || v.Category == "return"))
            throw new DebugFailure("debug_inspection_scope_variable_mismatch");
        if (boundScopes.ContainsKey(frame)) throw new DebugFailure("debug_inspection_scope_already_bound");
        // Commit only after complete validation. An uncertain caller can query
        // scope to observe the binding; it must not blindly resend this update.
        Invalidate(); boundScopes.Add(frame, update); return Scope();
    }
    internal object Scope() {
        var (definitions, metadataBound) = Visible();
        return new { ok = true, context = Context(), scopeComplete = false, metadataBound, unavailableCategories = new[] { "client" },
            categoriesNotEnumerated = new[] { "input", "output", "local", "return", "session", "site", "setting", "timer" }.Except(definitions.Select(v => v.Category)).ToArray(),
            variables = definitions.Select(v => new { reference = Reference(v, v.Path), name = Safe(v.Name), category = v.Category, moduleKey = v.ModuleKey,
                functionKey = v.FunctionKey, variableKey = v.Category == "return" ? null : v.VariableKey,
                source = v.Category == "return" ? "native-return-event" : "published-model", sourceSha256 = v.SourceSha256 }).ToArray() };
    }
    // The roots listed by Scope() for the selected frame; read-frame reads exactly these.
    (List<InspectionVariable> Definitions, bool MetadataBound) Visible() {
        var current = thread.Stack.Single(f => f.StackLevel == frame);
        var functionDefinitions = (boundScopes.TryGetValue(frame, out var bound) ? bound.Variables : options.Variables).Where(v => v.ModuleKey == current.FunctionId?.ESpaceKey.ToString()
            && v.FunctionKey == current.FunctionId?.ObjectKey.ToString()).ToArray();
        var returning = current.BreakpointType == BreakpointType.AtFunctionReturn;
        var definitions = functionDefinitions.Where(v => (v.NodeKey == null || v.NodeKey == current.Breakpoint?.ObjectKey.ToString())
            && (v.Category != "return" || returning)).ToList();
        // Mirror DebuggerManager's native return-event rule. The address belongs
        // to this runtime frame, not to an invented model variable. Require one
        // pinned source for its owner before exposing an evaluation reference.
        if (returning && !definitions.Any(v => v.Category == "return") && functionDefinitions.Length > 0
            && functionDefinitions.Select(v => v.SourceSha256).Distinct().Count() == 1) {
            if (!returnDefinitions.TryGetValue(frame, out var returned)) {
                var owner = functionDefinitions[0];
                returned = new InspectionVariable { ModuleKey = owner.ModuleKey, FunctionKey = owner.FunctionKey,
                    SourceSha256 = owner.SourceSha256, Name = "Return value", Category = "return", Path = "$return" };
                returnDefinitions[frame] = returned;
            }
            definitions.Add(returned);
        }
        var metadataBound = bound != null || current.PreviousBreakpoint == null && (options.Scopes.Any(s => s.ModuleKey == current.FunctionId?.ESpaceKey.ToString() &&
            s.FunctionKey == current.FunctionId?.ObjectKey.ToString() && s.NodeKey == current.Breakpoint?.ObjectKey.ToString()) ||
            functionDefinitions.Any(v => v.NodeKey == null || v.NodeKey == current.Breakpoint?.ObjectKey.ToString()));
        return (definitions, metadataBound);
    }
    string Safe(string text) => privateValues.Contains(text) ? DebugPolicy.Redacted : text;
    static void ValidatePage(Request request) {
        if (request.Offset < 0 || request.Limit is < 1 or > 150) throw new DebugFailure("debug_invalid_inspection_page");
        if (request.TextOffset < 0 || request.TextLimit is < 1 or > 16384) throw new DebugFailure("debug_invalid_inspection_text_page");
    }
    internal object ReadMany(Request request) {
        ValidatePage(request);
        if (request.References == null || request.References.Length is < 1 or > 500 ||
            request.References.Distinct().Count() != request.References.Length) throw new DebugFailure("debug_invalid_inspection_references");
        // Validate the whole batch before the first native evaluation.
        var entries = request.References.Select(reference => refs.TryGetValue(reference, out var entry) ? entry
            : throw new DebugFailure("debug_stale_reference")).ToArray();
        var variables = entries.Select(entry => new NativeInspectionVariable(entry.Definition, entry.Path)).ToArray();
        NativeInspectionEvaluator.EvaluateMany(variables, frame, request.TextOffset > 0 ? Math.Max(2, request.Depth) : request.Depth, evaluate);
        return new { ok = true, context = Context(), values = entries.Select((entry, index) => ReadEvaluated(request, entry, variables[index])).ToArray() };
    }
    internal object Read(Request request) {
        if (request.Op == "private-read" && privateWire == null) throw new DebugFailure("debug_private_inspection_not_enabled");
        if (request.Reference == null || !refs.TryGetValue(request.Reference, out var entry)) throw new DebugFailure("debug_stale_reference");
        ValidatePage(request);
        var path = entry.Path;
        if (request.Op == "expand" && request.ChildPath != null) {
            if (!Regex.IsMatch(request.ChildPath, @"^(?:\.[A-Za-z_][A-Za-z0-9_]*|\[(?:0|[1-9][0-9]{0,8})\])+$") || request.ChildPath.Length > 500)
                throw new DebugFailure("debug_invalid_inspection_child_path");
            path += Regex.Replace(request.ChildPath, @"(?<!\.)\[", ".[");
            var reference = Reference(entry.Definition, path); entry = refs[reference];
        }
        // Evaluate into a fresh native container each time: vanished children
        // must disappear, and old values must never be returned after a failure.
        var variable = new NativeInspectionVariable(entry.Definition, path);
        NativeInspectionEvaluator.Evaluate(variable, frame, request.TextOffset > 0 ? Math.Max(2, request.Depth) : request.Depth, evaluate);
        if (request.Op == "private-read") {
            var fingerprint = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Fingerprint(variable))));
            bool? changed = entry.Fingerprint == null ? null : entry.Fingerprint != fingerprint;
            entry.Fingerprint = fingerprint; entry.Revision++;
            var context = Context(); var reference = Reference(entry.Definition, path);
            return new { ok = true, context, reference, evaluationRevision = entry.Revision, changed, evaluatedAt = DateTimeOffset.UtcNow,
                valueComplete = false, privateValueReturnedPublicly = false,
                privatePayload = privateWire!.Seal(new { context, variable = new { @ref = reference,
                    moduleKey = entry.Definition.ModuleKey, sourceSha256 = entry.Definition.SourceSha256 }, value = PrivateValue(variable) }) };
        }
        return ReadEvaluated(request, entry, variable);
    }
    static object PrivateValue(NativeInspectionVariable variable) => new {
        type = variable.Type.ToString(), value = variable.Value, path = variable.Path,
        unavailable = variable.IsUnavailable(variable.Value!), undefined = variable.Value == "-undefined-",
        trimmed = variable.Trimmed, deferred = variable.IsEvaluationDeferred,
        children = variable.Children.Values.Select(PrivateValue).ToArray()
    };
    bool Blocked(Entry entry) => DebugPolicy.Sensitive(entry.Definition.Name) || DebugPolicy.Sensitive(entry.Path) || privateValues.Contains(entry.Path);
    // read-frame passes its own page window and the list items it already evaluated in the level batch.
    object ReadEvaluated(Request request, Entry entry, NativeInspectionVariable variable, int? pageOffset = null, int? pageLimit = null,
        IReadOnlyDictionary<string, NativeInspectionVariable>? prefetched = null, List<NativeInspectionVariable>? pageItems = null) {
        var path = entry.Path; var offset = pageOffset ?? request.Offset; var limit = pageLimit ?? request.Limit;
        var fingerprint = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Fingerprint(variable))));
        bool? changed = entry.Fingerprint == null ? null : entry.Fingerprint != fingerprint;
        entry.Fingerprint = fingerprint; entry.Revision++;
        var blocked = Blocked(entry);
        var redacted = blocked;
        var page = blocked ? (Items: Array.Empty<NativeInspectionVariable>(), Total: 0L, Missing: Array.Empty<NativeInspectionVariable>())
            : ChildPage(variable, offset, limit, request.Depth, prefetched);
        pageItems?.AddRange(page.Items);
        var pageKey = (offset, limit);
        var pageFingerprint = Fingerprint(Wire.Json(page.Items.Select(Fingerprint).ToArray()));
        if (entry.PageFingerprints.TryGetValue(pageKey, out var previousPage) && previousPage != pageFingerprint) changed = true;
        entry.PageFingerprints[pageKey] = pageFingerprint;
        var children = page.Items.Select(v => Describe(v, onRedaction: () => redacted = true)).ToArray();
        var described = Describe(variable, request.TextOffset, request.TextLimit, () => redacted = true);
        var next = offset + children.Length;
        return new { ok = true, context = Context(), reference = Reference(entry.Definition, path), evaluationRevision = entry.Revision,
            evaluatedAt = DateTimeOffset.UtcNow, changed, value = described, children, offset,
            nextOffset = !blocked && next < page.Total ? (int?)next : null,
            availableChildren = page.Total, nativeEvaluationDetail = variable.EvaluationDetail,
            collectionCoverage = blocked ? null : CollectionCoverage(variable), deferred = variable.IsEvaluationDeferred,
            nativeTrimmed = variable.Trimmed, redacted };
    }
    // evaluateMissing=false only plans: it returns the unevaluated missing list items for a level batch.
    (NativeInspectionVariable[] Items, long Total, NativeInspectionVariable[] Missing) ChildPage(NativeInspectionVariable variable, int offset, int limit, int depth,
        IReadOnlyDictionary<string, NativeInspectionVariable>? prefetched = null, bool evaluateMissing = true) {
        var all = variable.Children.Values.ToArray();
        var length = ListLength(variable);
        bool IsIndex(string name) => Regex.IsMatch(name, @"^\[(?:0|[1-9][0-9]{0,8})\]$");
        if (length is not >= 0 or > 999999999 || variable.Trimmed || variable.IsEvaluationDeferred ||
            variable.Children.Keys.Where(IsIndex).Any(name => long.Parse(name[1..^1]) >= length))
            return (all.Skip(offset).Take(limit).ToArray(), all.LongLength, []);
        var metadata = variable.Children.Where(kv => !IsIndex(kv.Key)).Select(kv => kv.Value).ToArray();
        var total = metadata.LongLength + length.Value;
        var page = new List<NativeInspectionVariable>(); var missing = new List<NativeInspectionVariable>();
        for (long index = offset; index < total && page.Count < limit; index++) {
            if (index < metadata.Length) { page.Add(metadata[(int)index]); continue; }
            var name = "[" + (index - metadata.Length).ToString(System.Globalization.CultureInfo.InvariantCulture) + "]";
            if (!variable.Children.TryGetValue(name, out var child) && (prefetched == null || !prefetched.TryGetValue(variable.Path + "." + name, out child))) {
                // The native Length authorizes the address, not a fabricated value.
                // Every missing item on this page must be evaluated by the native SDK.
                child = new NativeInspectionVariable(variable.Definition, variable.Path + "." + name);
                missing.Add(child);
            }
            page.Add(child);
        }
        if (evaluateMissing && missing.Count > 0) NativeInspectionEvaluator.EvaluateMany(missing.ToArray(), frame, depth, evaluate);
        return (page.ToArray(), total, missing.ToArray());
    }
    const int MaxFrameLevels = 16, MaxFrameChars = 3000000, MaxBatch = 500;
    int EvaluateBatch(NativeInspectionVariable[] variables, int depth) {
        var commands = 0;
        foreach (var chunk in variables.Chunk(MaxBatch)) { NativeInspectionEvaluator.EvaluateMany(chunk, frame, depth, evaluate); commands++; }
        return commands;
    }
    // One bounded read of the selected frame: every Scope() root, then child pages level by level up to maxNodes.
    // Each level is one native batch (plus one for list items beyond the native enumeration). Every node gets the
    // same reference read/refresh/expand/private-read use; redaction, revisions and staleness are those of read.
    // Anything beyond the budget is a continuation: nextOffset (roots or a container page) or a pending reference.
    internal object ReadFrame(Request request) {
        if (request.MaxNodes is < 1 or > 20000) throw new DebugFailure("debug_invalid_inspection_budget");
        if (request.Offset < 0) throw new DebugFailure("debug_invalid_inspection_page");
        if (request.TextOffset != 0 || request.TextLimit is < 1 or > 16384) throw new DebugFailure("debug_invalid_inspection_text_page");
        if (request.Depth is < 0 or > 4) throw new DebugFailure("debug_invalid_variables_request");
        var definitions = Visible().Definitions;
        var selected = definitions.Skip(request.Offset).Take(request.MaxNodes).ToArray();
        var roots = selected.Select(d => Reference(d, d.Path)).ToArray();
        var level = roots.Select(r => refs[r]).ToList();
        var values = new List<object>(); var pending = new List<string>();
        int nodes = selected.Length, commands = 0, size = 0, depth = 0; var complete = true;
        while (level.Count > 0) {
            if (depth++ >= MaxFrameLevels || size > MaxFrameChars || nodes >= request.MaxNodes && depth > 1) {
                pending.AddRange(level.Select(e => Reference(e.Definition, e.Path))); complete = false; break;
            }
            var variables = level.Select(e => new NativeInspectionVariable(e.Definition, e.Path)).ToArray();
            commands += EvaluateBatch(variables, request.Depth);
            // Plan every page of the level against the remaining budget, then evaluate all missing items at once.
            var limits = new int[level.Count]; var missing = new List<NativeInspectionVariable>(); var planned = nodes;
            for (var i = 0; i < level.Count; i++) {
                if (Blocked(level[i])) continue;
                var plan = ChildPage(variables[i], 0, request.MaxNodes - planned, request.Depth, evaluateMissing: false);
                limits[i] = plan.Items.Length; planned += limits[i]; missing.AddRange(plan.Missing);
                if (limits[i] < plan.Total) complete = false;
            }
            commands += EvaluateBatch(missing.ToArray(), request.Depth);
            var prefetched = missing.GroupBy(v => v.Path, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
            var next = new List<Entry>();
            for (var i = 0; i < level.Count; i++) {
                if (size > MaxFrameChars || refs.Count + limits[i] + 1 >= 20000) {
                    pending.AddRange(level.Skip(i).Select(e => Reference(e.Definition, e.Path))); complete = false; break;
                }
                var items = new List<NativeInspectionVariable>();
                var value = ReadEvaluated(request, level[i], variables[i], 0, limits[i], prefetched, items);
                values.Add(value); size += Wire.Json(value).Length; nodes += items.Count;
                foreach (var child in items.Where(c => c.Children.Count > 0 || c.IsEvaluationDeferred)) {
                    var entry = refs[Reference(child.Definition, child.Path)];
                    if (Blocked(entry)) continue; // described as redacted by its parent page; never expanded
                    next.Add(entry);
                }
            }
            level = next;
        }
        var rootNext = request.Offset + selected.Length < definitions.Count ? (int?)(request.Offset + selected.Length) : null;
        return new { ok = true, op = "read-frame", context = Context(), scopeComplete = false, maxNodes = request.MaxNodes, nodesRead = nodes,
            budgetExhausted = nodes >= request.MaxNodes, rootOffset = request.Offset, nextOffset = rootNext, roots, values, pending,
            complete = complete && rootNext == null && pending.Count == 0, nativeCommands = commands };
    }
    static long? ListLength(NativeInspectionVariable variable) =>
        variable.Type == VariableType.RecordList && variable.Children.TryGetValue("Length", out var child) &&
        long.TryParse(child.Value, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var parsed) && parsed >= 0
            ? parsed : null;
    static bool IndexName(string name) => Regex.IsMatch(name, @"^\[(?:0|[1-9][0-9]{0,8})\]$");
    // ServerVariableContainerUtils types a list only by its "Record.List" element; item element names do not
    // matter. Indexed children under any other native type have no native length: flagged, never completed.
    static bool UnqualifiedList(NativeInspectionVariable variable) => variable.Type != VariableType.RecordList && variable.Children.Keys.Any(IndexName);
    static object? CollectionCoverage(NativeInspectionVariable variable) {
        if (UnqualifiedList(variable)) return new { declaredLength = (long?)null, enumeratedItems = variable.Children.Keys.LongCount(IndexName),
            complete = false, missingItems = (long?)null, source = "native-indexed-children-without-record-list" };
        if (variable.Type != VariableType.RecordList) return null;
        var length = ListLength(variable);
        var indexes = variable.Children.Keys.Where(IndexName)
            .Select(name => long.Parse(name[1..^1], System.Globalization.CultureInfo.InvariantCulture)).ToArray();
        var inRange = length.HasValue && indexes.All(index => index < length.Value);
        return new { declaredLength = length, enumeratedItems = indexes.Length,
            complete = inRange && indexes.LongLength == length && !variable.Trimmed && !variable.IsEvaluationDeferred,
            missingItems = inRange ? length - indexes.LongLength : null,
            source = "native-container-length-and-indexed-children" };
    }
    object Describe(NativeInspectionVariable value, int textOffset = 0, int textLimit = 4096, Action? onRedaction = null) {
        // An unknown element with indexed children is a container, not a scalar (its InnerText is descendants).
        var scalar = value.Type is VariableType.Scalar or VariableType.Unknown && !UnqualifiedList(value);
        // The server can answer a declared address with this native sentinel.
        // A complete rendering of the marker is not an observed runtime value.
        // Keep the SDK's IsUnavailable result distinct; quoted Text is data.
        var undefined = scalar && value.Value == "-undefined-";
        // Native binary rendering contains only the byte count. Quoted Text
        // with the same spelling remains ordinary data, like the sentinel above.
        var nativeSummary = scalar && Regex.IsMatch(value.Value ?? "", @"^BinaryData \([0-9]+ bytes\)$");
        // ODC settings use GUID addresses; the native display name is essential
        // to recognizing credentials. Preserve the real address for evaluation.
        var redacted = false;
        var text = scalar ? DebugPolicy.FullValue(value.Definition.Name + "." + value.Path, value.Value, privateValues, complete: true,
            onRedaction: () => { redacted = true; onRedaction?.Invoke(); }) as string : null;
        if (text != null && textOffset > text.Length) throw new DebugFailure("debug_inspection_text_offset_out_of_range");
        var length = text == null ? 0 : Math.Min(textLimit, text.Length - textOffset);
        var next = textOffset + length;
        return new { reference = Reference(value.Definition, value.Path), path = Safe(value.Path),
        category = value.Definition.Category, type = value.Type.ToString(),
        // Native compound InnerText contains descendants. Display leaf values
        // only, avoiding disclosure under a differently named parent.
        value = text == null ? null : text.Substring(textOffset, length), textOffset, textLength = text?.Length,
        nextTextOffset = text != null && next < text.Length ? (int?)next : null,
        valueComplete = scalar && !undefined && !nativeSummary && !redacted && !value.IsUnavailable(value.Value!) && !value.Trimmed && !value.IsEvaluationDeferred && textOffset == 0 && (text == null || next == text.Length),
        nativeSummary,
        redacted,
        fullEvaluationDetail = value.Trimmed ? (int?)2 : null,
        unavailable = value.IsUnavailable(value.Value!), undefined, trimmed = value.Trimmed, deferred = value.IsEvaluationDeferred,
        hasChildren = value.Children.Count > 0 || value.IsEvaluationDeferred };
    }
    static string Fingerprint(NativeInspectionVariable value) => Wire.Json(new { value.Path, value.Type, value.Value, value.Trimmed,
        value.IsEvaluationDeferred, children = value.Children.Values.Select(Fingerprint).ToArray() });
}
