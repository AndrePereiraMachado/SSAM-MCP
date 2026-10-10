using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Core;

/// <summary>Carrega a base, aplica um job de verbos num unico comando, verifica e salva o foreign.</summary>
public static class JobRunner
{
    public static object Run(ModelHost host, string? basePath, string jobPath, string outPath, Action<string>? log = null,
        IReadOnlyDictionary<string, string>? bindings = null)
        => new Sources(host, bindings, log).Build(jobPath, basePath, outPath);

    public static string ResolveBase(ModelHost host, string jobPath, IReadOnlyDictionary<string, string>? bindings = null,
        Action<string>? log = null) => new Sources(host, bindings, log).Base(jobPath);

    /// <summary>Contratos JSON antes do runtime no CLI; cada dependencia tambem valida o seu contrato ao executar. N3 (atritos
    /// 3): the problems of expectedMessages are preflight problems (EXPECTED_MESSAGES_INVALID), collected with the others by
    /// JobPreflight.Check; this call only reads the document and never throws for them.</summary>
    public static void ValidateJob(string jobPath, string? lane = null) => MessageExpectations.Inspect(JobDocument.Read(jobPath), jobPath, lane);

    private static object ApplyResolved(ModelHost host, string basePath, JsonArray ops, string outPath, Action<string>? log,
        IReadOnlyList<ExpectedMessage> expected, bool expectedValid, JsonObject? preflight = null, bool builtBase = false, string? opsPointer = "/ops",
        IReadOnlyList<JsonObject>? notes = null)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var signatures=ops.OfType<JsonObject>().Where(op=>op["op"]?.ToString()=="reference")
            .Select(op=>op["producer"]!.ToString()).Distinct(StringComparer.OrdinalIgnoreCase)
            .Where(path=>Path.GetExtension(path).Equals(".avsig",StringComparison.OrdinalIgnoreCase))
            .ToDictionary(path=>path,NativeReferenceSnapshot.Read,StringComparer.OrdinalIgnoreCase);
        bool NativeReference(JsonNode? node)=>node?["op"]?.ToString()=="reference" && signatures.ContainsKey(node["producer"]!.ToString());
        // Frozen references (.avsig) are imported before the edit transaction wherever the job writes them: a later one is
        // hoisted (and reported), never refused.
        var prepared=ops.Where(NativeReference).OfType<JsonObject>().ToArray();
        var firstEdit=ops.Select((op,index)=>(op,index)).FirstOrDefault(x=>!NativeReference(x.op),(null,ops.Count)).index;
        var hoisted=ops.Select((op,index)=>(op,index)).Where(x=>x.index>firstEdit && NativeReference(x.op)).Select(x=>x.index).ToArray();
        var baseBytes = File.ReadAllBytes(basePath);
        // In the resident worker only: a spare instance of exactly this base, taken once and released below like a fresh load.
        var spare = BaseModelCache.Shared?.Take(basePath, baseBytes, reusable: !builtBase);
        var espace = spare?.Model ?? host.Load(baseBytes);
        var loadMs = sw.ElapsedMilliseconds;
        var session = new ModelSession(espace);
        var producers = new Dictionary<string, ServiceStudio.Model.ESpace>(StringComparer.OrdinalIgnoreCase);
        session.ProducerLoader = spec =>
        {
            if (producers.TryGetValue(spec, out var cached)) return cached;
            // As fontes foram resolvidas antes de abrir a transacao do consumidor.
            var p = host.Load(File.ReadAllBytes(spec));
            producers[spec] = p;
            return p;
        };
        Dictionary<string, int>? released = null;
        try
        {
            var phase = sw.ElapsedMilliseconds;
            var before = ModelHost.Messages(espace);
            var verifyBeforeMs = sw.ElapsedMilliseconds - phase;
            var t1 = sw.ElapsedMilliseconds;
            // The footprint starts before anything of the job (frozen references included) enters the model (K7). B3 (atritos
            // 3): no sweep of the module; the ops keep the children of what they name (Verbs.Footprint.cs). The full sweep runs
            // only under the audit of the tests (ModelSession.FootprintAudit).
            phase = sw.ElapsedMilliseconds;
            var audit = ModelSession.FootprintAudit.Value;
            var keysBefore = audit != null ? session.ObjectKeys() : null;
            session.BeginFootprint();
            var footprintMs = sw.ElapsedMilliseconds - phase;
            foreach(var reference in prepared)
                session.PrepareSignatureReference(reference,signatures[reference["producer"]!.ToString()]);
            // Everything the job names that only the base can answer, all at once, before the first op (C20).
            phase = sw.ElapsedMilliseconds;
            CheckAgainstBase(session, espace, ops, preflight, opsPointer, checkFunctions: expectedValid, log: log);
            var baseCheckMs = sw.ElapsedMilliseconds - phase;
            phase = sw.ElapsedMilliseconds;
            // A02 item 6: every failing op is recorded (its dependents skipped) and refused at once, before Verify and save.
            session.OpsPointer = opsPointer;
            var results = session.Apply(ops, log);
            // What only the database upgrade (publish) would refuse, read on the effective model before anything is saved.
            var upgrade = session.DatabaseUpgradeRefusals(ops, MessageExpectations.Lane);
            if (upgrade.Count > 0) throw new InvalidOperationException(string.Join(Environment.NewLine, upgrade));
            var sessionApplyMs = sw.ElapsedMilliseconds - phase;
            phase = sw.ElapsedMilliseconds;
            var dataContract = session.DataContract();
            var dataContractMs = sw.ElapsedMilliseconds - phase;
            var applyMs = sw.ElapsedMilliseconds - t1;
            phase = sw.ElapsedMilliseconds;
            var after = ModelHost.Messages(espace);
            var verifyAfterMs = sw.ElapsedMilliseconds - phase;
            phase = sw.ElapsedMilliseconds;
            var snap = ModelHost.Describe(espace, 0, after);
            var describeMs = sw.ElapsedMilliseconds - phase;
            var delta = MessageDelta.Compute(before, after);
            // What the job created and changed (K7): the policy reads it (Unused* on a created element, the anonymous-access
            // warning on a job screen), the result carries it.
            phase = sw.ElapsedMilliseconds;
            var footprint = session.Footprint();
            if (audit != null && keysBefore != null) audit.AddRange(session.FootprintDifferences(footprint.Footprint, session.Footprint(keysBefore).Footprint));
            // C08: the screens the job declared open to anonymous users, and those of the footprint the base already opened.
            var judged = footprint.Footprint with { AnonymousIntent = session.AnonymousIntentOf(footprint.Footprint) };
            footprintMs += sw.ElapsedMilliseconds - phase;
            var policy = MessageExpectations.Evaluate(delta.New, expected, delta.Preexisting, judged);
            var accepted = snap.IsValid == expectedValid && policy.Accepted && dataContract["accepted"]!.GetValue<bool>();
            // The verdict of every new message (K1), the expectations used (K2) and those no message used (K3, informative).
            var validation = new { @new = delta.New, @fixed = delta.Fixed, preexisting = delta.Preexisting,
                unexpected = policy.Unexpected, missingExpected = policy.MissingExpected, ambiguous = policy.Ambiguous, tolerated = policy.Tolerated,
                allowlisted = policy.Allowlisted, verdicts = policy.Verdicts, matched = policy.Matched, unusedExpectations = policy.UnusedExpectations };
            phase = sw.ElapsedMilliseconds;
            var details = ModelHost.ValidationDetails(espace, 60, delta.New.Concat(delta.Preexisting).ToArray());
            var policyMessages = policy.Diagnostics().ToList();
            foreach (var mismatch in dataContract["differences"]!.AsArray())
                policyMessages.Add("Data property mismatch: " + mismatch!.ToJsonString());
            if (snap.IsValid != expectedValid) policyMessages.Add($"expectValid={expectedValid}, but Verify isValid={snap.IsValid}");
            foreach (var d in details.Concat(policyMessages)) log?.Invoke("  " + d);
            var detailsMs = sw.ElapsedMilliseconds - phase;
            phase = sw.ElapsedMilliseconds;
            var refactorAssertions = session.RefactorContract();
            var bytes = host.Save(espace);
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outPath))!);
            File.WriteAllBytes(outPath, bytes);
            // K6: the builder checks the kernel-result.json next to a candidate against these bytes (I10).
            var outSha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant();
            var saveMs = sw.ElapsedMilliseconds - phase;
            var handles = session.Handles;
            phase = sw.ElapsedMilliseconds;
            // largar o modulo AQUI para o relatorio do que foi libertado (undo, aggregator, close, locks) entrar no resultado
            released = ModelHost.Release(espace);
            var releaseMs = sw.ElapsedMilliseconds - phase;
            phase = sw.ElapsedMilliseconds;
            JsonObject? refactorProof = null;
            if (refactorAssertions.Count > 0) {
                var reloaded = host.Load(outPath);
                try { refactorProof = new ModelSession(reloaded).CheckRefactorContract(refactorAssertions); }
                finally { ModelHost.Release(reloaded); }
                refactorProof["assertions"] = refactorAssertions;
                if (refactorProof["accepted"]!.GetValue<bool>() != true) {
                    accepted = false;
                    policyMessages.Add("Refactor reference sets changed after save/reload: " + refactorProof["differences"]!.ToJsonString());
                }
            }
            var timings = new { loadMs, baseAcquireMs = spare?.AcquireMs, verifyBeforeMs, baseCheckMs, footprintMs, applyMs, sessionApplyMs, dataContractMs, verifyAfterMs, describeMs, detailsMs, saveMs, releaseMs, refactorProofMs = sw.ElapsedMilliseconds - phase, totalMs = sw.ElapsedMilliseconds };
            // Flows whose layout the engine refused keep their geometry; name them in the receipt.
            var layoutRefused = session.AutomaticLayouts.Where(l => l.Refused != null)
                .Select(l => new { action = l.Action, source = "automatic", reason = l.Refused! })
                .Concat(results.OfType<JsonObject>().Where(r => r["op"]?.ToString() == "layout" && r["result"]?["refused"] != null)
                    .Select(r => new { action = r["result"]!["action"]!.ToString(), source = "op", reason = r["result"]!["refused"]!.ToString() }))
                .ToArray();
            foreach (var refusal in layoutRefused) log?.Invoke($"  layout kept for {refusal.action} ({refusal.source}): {refusal.reason}");
            log?.Invoke($"apply: {ops.Count} ops, {snap.Objects} objects, {snap.Validation.Total} messages, isValid={snap.IsValid}, load {loadMs} ms, apply {applyMs} ms");
            // data.integration (contract I7): the report of each integration op, absent when the job has none.
            var integration = new System.Text.Json.Nodes.JsonArray(results.OfType<JsonObject>()
                .Where(r => r["op"]?.ToString() is "rest" or "rest-expose" or "soap" && r["result"]?["integration"] is JsonObject)
                .Select(r => r["result"]!["integration"]!.DeepClone()).ToArray());
            var answer = new { outPath, outSha256, ops = ops.Count, loadMs, applyMs, objects = snap.Objects, isValid = snap.IsValid, messages = snap.Validation.Total, details, validation, accepted, expectedValid, policyMessages, handles, results, footprint = footprint.Json, hoistedReferences = hoisted.Length > 0 ? hoisted : null, flowLayoutEngine = FlowLayout.EngineRevision, automaticLayouts = session.AutomaticLayouts, layoutRefused, released, baseCache = spare?.Receipt, timings, preflight, dataContract, refactorProof, coverage = session.CoverageLedger() };
            // What the kernel applied that the author did not write (atritos 3, section 5.1): notes, iconConversions,
            // expressionRewrites, nameTruncations, indexNoOps, anonymousExposure, ... each only when it has entries.
            var receipt = session.ReceiptFields(policy, footprint.Footprint);
            if (notes is { Count: > 0 })
            {
                if (receipt["notes"] is not JsonArray all) receipt["notes"] = all = new JsonArray();
                for (var n = notes.Count - 1; n >= 0; n--) all.Insert(0, notes[n].DeepClone());
            }
            if (integration.Count == 0 && receipt.Count == 0) return answer;
            var withIntegration = System.Text.Json.JsonSerializer.SerializeToNode(answer, Json.Compact)!.AsObject();
            if (integration.Count > 0) withIntegration["integration"] = integration;
            foreach (var field in receipt.ToArray()) { receipt.Remove(field.Key); withIntegration[field.Key] = field.Value; }
            return withIntegration;
        }
        finally
        {
            // libertar o modulo e os produtores: ESpace.Load regista-os num dicionario estatico do Studio e so Close() os solta
            // (sem isto o worker residente retem todos os modulos que ja aplicou)
            foreach (var p in producers.Values) ModelHost.Release(p);
            if (released == null) ModelHost.Release(espace);
        }
    }

    private static readonly Regex LegacyPrefix = new(@"^op #(\d+)(?: \(([^)]*)\))?:\s*", RegexOptions.Compiled);
    private static readonly Regex FunctionCall = new(@"(?<![\w.])([A-Za-z_][A-Za-z0-9_]*)\s*\(", RegexOptions.Compiled);
    private static readonly Regex StringLiteral = new("\"(?:[^\"]|\"\")*\"", RegexOptions.Compiled);
    private static readonly Regex RoleFunction = new(@"^(?:Check|Grant|Revoke)\w+Role$", RegexOptions.Compiled);

    /// <summary>What only the base can answer, checked before the first op and refused all at once (C20, I2): the types the
    /// job uses without declaring, the SQL names of the base, the names and keys the ops reference without creating, and the
    /// functions the logic expressions call (built-ins of this Studio, functions of the module or its references, the job's
    /// own actions). The refusal is a JobPreflightException (PREFLIGHT_REFUSED) with every problem; the wording of the type
    /// and SQL lines stays the one tools already read.</summary>
    private static void CheckAgainstBase(ModelSession session, ServiceStudio.Model.ESpace espace, JsonArray ops, JsonObject? preflight, string? opsPointer, bool checkFunctions = true, Action<string>? log = null)
    {
        var problems = new List<JsonObject>();
        var lines = new List<string>();
        string? Pointer(int? op) => opsPointer == null || op == null ? null : $"{opsPointer}/{op}";
        var imports = ops.OfType<JsonObject>().Any(o => o["op"]?.ToString() == "reference");
        if (preflight?["unresolvedTypes"] is JsonArray unresolved && !imports)
            foreach (var type in unresolved.OfType<JsonObject>().DistinctBy(x => x["name"]!.ToString()))
            {
                try { TypeResolver.Resolve((OutSystems.Model.IESpace)espace, type["name"]!.ToString()); continue; }
                catch { }
                var op = type["op"] is JsonValue o && o.TryGetValue<int>(out var index) ? index : (int?)null;
                lines.Add($"op #{type["op"]}: unknown type '{type["type"]}' on {type["target"]}; absent from job declarations and base module");
                problems.Add(JobPreflight.Problem(op, Pointer(op), "TYPE_UNRESOLVED", "error",
                    $"unknown type '{type["type"]}' on {type["target"]}: absent from the job's declarations and from the base module",
                    "declare the type earlier in this job (spec), fix its name, or add the reference op that imports it", null, "data"));
            }
        // SQL names the job alone cannot decide ({Entity}.[Attribute] of the base, @parameters of an existing node).
        if (preflight?["unresolvedSql"] is JsonArray { Count: > 0 } openSql)
            foreach (var failure in SqlPreflight.CheckBase((OutSystems.Model.IESpace)espace, session.Resolve, openSql))
            {
                lines.Add(failure);
                var m = LegacyPrefix.Match(failure);
                var op = m.Success ? int.Parse(m.Groups[1].Value) : (int?)null;
                var message = m.Success ? failure[m.Length..] : failure;
                problems.Add(JobPreflight.Problem(op, Pointer(op), "SQL_UNRESOLVED", "error", message,
                    message.Contains("; ", StringComparison.Ordinal) ? message[(message.LastIndexOf("; ", StringComparison.Ordinal) + 2)..] : "fix the name against the base module",
                    null, m.Success && m.Groups[2].Success ? m.Groups[2].Value : "sql"));
            }
        var unresolvedRoots = new HashSet<string>(StringComparer.Ordinal);
        foreach (var group in JobPreflight.BaseReferences(ops, opsPointer).GroupBy(r => r.Reference, StringComparer.Ordinal))
        {
            string? why = null;
            try { session.Resolve(group.Key); }
            catch (UnresolvedReferenceException ex) { why = ex.Message; }
            catch (KeyNotFoundException ex) { why = ex.Message; }
            catch { /* anything else is the op's own business at apply */ }
            if (why == null) continue;
            unresolvedRoots.Add(group.Key);
            var first = group.First();
            var similar = first.Type == "@" ? [] : NameSuggestions.Closest(first.Name, session.NamesOfType(first.Type));
            var fix = similar.Count > 0 ? $"use one of: {string.Join(", ", similar.Select(n => (first.Type.Length > 0 ? first.Type : "") + ":" + n))}; or create it earlier in this job"
                : first.Type == "@" ? "use a key of this same base (ssam_map), a $alias of an earlier op, or Type:Name"
                : "create it earlier in this job, fix the name, or add the reference op that imports it";
            foreach (var r in group)
            {
                var problem = JobPreflight.Problem(r.Op, r.Pointer, "REFERENCE_UNRESOLVED", "error", $"{r.Reference} does not resolve in the base module: {why}", fix, null, r.Kind);
                problems.Add(problem);
                lines.Add(JobPreflight.Text(problem));
            }
        }
        // A02 item 5: the whole path, not only its root. A child the base does not have is refused with the others (CHILD_NOT_FOUND).
        foreach (var group in JobPreflight.BasePaths(ops, opsPointer).GroupBy(p => p.Reference, StringComparer.Ordinal))
        {
            var first = group.First();
            if (unresolvedRoots.Contains(first.Root)) continue;
            object? owner;
            try { owner = session.Resolve(first.Root); }
            catch { continue; }
            string? why = null; string? fix = null; var path = first.Root;
            foreach (var segment in first.Segments)
            {
                path += "/" + segment;
                try { owner = session.Resolve(path); }
                catch (KeyNotFoundException ex)
                {
                    why = ex.Message;
                    var parent = owner as OutSystems.Model.IObjectSignature;
                    var children = parent?.Children.Select(c => TypeResolver.Name(c)).OfType<string>().Where(n => n.Length > 0).Distinct(StringComparer.Ordinal).ToList() ?? [];
                    var bare = segment[(segment.IndexOf(':') + 1)..];
                    fix = segment.Contains(':') && children.Contains(bare, StringComparer.OrdinalIgnoreCase)
                        ? $"write the child by its name: {first.Reference.Replace("/" + segment, "/" + bare)}"
                        : children.Count > 0 ? $"use one of the children: {string.Join(", ", NameSuggestions.Closest(bare, children))}; or create it earlier in this job"
                        : "create it earlier in this job, or fix the path (ssam_map lists the children)";
                    break;
                }
                catch { break; }   // anything else is the op's own business at apply
            }
            if (why == null) continue;
            foreach (var p in group)
            {
                var problem = JobPreflight.Problem(p.Op, p.Pointer, "CHILD_NOT_FOUND", "error", $"{p.Reference} does not resolve in the base module: {why}", fix, null, p.Kind);
                problems.Add(problem);
                lines.Add(JobPreflight.Text(problem));
            }
        }
        // C27 (atritos 3): a raw `set` on an element of the base is judged against that element now: a property it has no way
        // to write (PROPERTY_NOT_WRITABLE, the apply's own wording) and an expression whose quotes are unbalanced
        // (EXPRESSION_SYNTAX), with the others, before the first op. Style where the element keeps its classes elsewhere is
        // written there at apply (StyleRule), never refused.
        var baseTargets = JobPreflight.BaseReferences(ops, opsPointer).Where(r => r.Pointer?.EndsWith("/target", StringComparison.Ordinal) == true && r.Kind == "set" && !unresolvedRoots.Contains(r.Reference)).Select(r => r.Op)
            .Concat(JobPreflight.BasePaths(ops, opsPointer).Where(p => p.Pointer?.EndsWith("/target", StringComparison.Ordinal) == true && p.Kind == "set" && !unresolvedRoots.Contains(p.Root)).Select(p => p.Op))
            .ToHashSet();
        foreach (var index in baseTargets.Order())
        {
            if (ops[index] is not JsonObject set || set["target"]?.ToString() is not { } target || set["prop"]?.ToString() is not { Length: > 0 } prop) continue;
            object element;
            try { element = session.Resolve(target); } catch { continue; }
            JsonObject? problem = null;
            if (!session.CanSet(element, prop) && !(prop == "Style" && session.StyleHasAPlace(element)))
                problem = JobPreflight.Problem(index, Pointer(index) is { } at ? at + "/prop" : null, "PROPERTY_NOT_WRITABLE", "error",
                    ModelSession.PropertyErrorText(element, prop), $"write one of: {string.Join(", ", ModelSession.ClosestWritable(element, prop))}", null, "set");
            else if (set["value"] is JsonValue v && v.TryGetValue<string>(out var text) && ModelSession.IsExpressionProperty(element, prop)
                     && ModelSession.ExpressionRewrite(text).Syntax is { } syntax)
                problem = JobPreflight.Problem(index, Pointer(index) is { } at ? at + "/value" : null, "EXPRESSION_SYNTAX", "error",
                    $"{prop} = {text}: {syntax}", "close every text literal with \" (a quote inside a text is written \"\")", null, "set");
            if (problem == null) continue;
            problems.Add(problem);
            lines.Add(JobPreflight.Text(problem));
        }
        // Functions the logic expressions call: the same rule as the Verify's ExpressionUnknownFunction, before any op. A job
        // that expects an invalid module (expectValid false) asks the Verify for that verdict: it is not refused here.
        var calls = checkFunctions ? LogicLint.AllExpressions(ops)
            .SelectMany(e => FunctionCall.Matches(StringLiteral.Replace(e.Text, "\"\"")).Select(m => (e.Op, Name: m.Groups[1].Value)))
            .Where(c => c.Name is not ("and" or "or" or "not") && !RoleFunction.IsMatch(c.Name)).ToList() : [];
        HashSet<string>? builtins = null, scope = null;
        if (calls.Count > 0) try { builtins = FunctionCatalog.Names; } catch { /* no catalog in this host: Verify judges */ }
        // The module's own functions are read only when a call is no built-in (a walk of the whole module).
        if (builtins != null && calls.Any(c => !builtins.Contains(c.Name))) try { scope = ExpressionCheck.ScopeFunctions(espace); } catch { }
        if (builtins != null && scope != null)
        {
            var declared = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var op in ops.OfType<JsonObject>())
            {
                if (op["name"] is JsonValue n && n.TryGetValue<string>(out var created)) declared.Add(created);
                foreach (var action in (op["data"]?["actions"] as JsonArray ?? new JsonArray()).OfType<JsonObject>())
                    if (action["name"] is JsonValue a && a.TryGetValue<string>(out var actionName)) declared.Add(actionName);
            }
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var (op, name) in calls)
            {
                if (builtins.Contains(name) || scope.Contains(name) || declared.Contains(name)) continue;
                if (!seen.Add(op + "|" + name)) continue;
                var closest = FunctionCatalog.Closest(name, scope);
                var problem = JobPreflight.Problem(op, Pointer(op), "FUNCTION_UNKNOWN", "error",
                    $"'{name}(' is not a built-in function of this Studio ({MessageExpectations.Lane}), nor a function of the module, of its references or of this job",
                    closest.Count > 0 ? "use one of: " + string.Join(", ", closest) : "see `anvil functions --find " + name + "`", null, "logic");
                problems.Add(problem);
                lines.Add(JobPreflight.Text(problem));
            }
        }
        // A04 with the base: callees, entities, root names and the module type the pure preflight could not see. Not for a
        // job that imports producers (their names are not the base's) nor one that expects an invalid module.
        if (checkFunctions && !imports)
        {
            var found = Preflight.PreflightChecks.WithBase(ops, opsPointer, MessageExpectations.Lane, new Preflight.ModelBaseFacts(session, espace));
            foreach (var problem in found.Problems) { problems.Add(problem); lines.Add(JobPreflight.Text(problem)); }
            foreach (var warning in found.Warnings) log?.Invoke("  " + JobPreflight.Text(warning));
        }
        // I6: what only the base could answer.
        foreach (var problem in problems) problem["phase"] ??= "base";
        if (problems.Count > 0) throw JobPreflightException.Of(problems, lines);
    }

    private static readonly Regex VersionSuffix = new(@"(?:[-_][vV]\d+|\s*\(\d+\))$", RegexOptions.Compiled);

    /// <summary>Um job = um ficheiro; tarefa diferente = nome pela intencao; nunca `-vN` (o git guarda as versoes). Sete copias
    /// `virtual-game-store-all-sql-v2..v7` numa sessao fria (plano, item 09). Vale para jobs dentro de `<repo>/tests/`, exceto
    /// `tests/jobs-cold` ate serem consolidados; nomes como `tickets-01-data` ou `rest-consume-get` sao legitimos.</summary>
    public static void CheckJobName(string jobPath)
    {
        var full = Path.GetFullPath(jobPath);
        var root = RepoRoot(Path.GetDirectoryName(full) ?? full);
        if (root == null) return;
        var tests = Path.Combine(root, "tests") + Path.DirectorySeparatorChar;
        if (!full.StartsWith(tests, StringComparison.OrdinalIgnoreCase)) return;
        if (full.Contains(Path.DirectorySeparatorChar + "jobs-cold" + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) return;
        var stem = Path.GetFileNameWithoutExtension(full);
        if (VersionSuffix.IsMatch(stem))
            throw new ArgumentException($"job '{stem}' has a version suffix: edit the same file (git keeps the versions) or name it by intent (e.g. {VersionSuffix.Replace(stem, "")}-inputs-consumed)");
    }

    /// <summary>Ops de um job: um array, `{"ops":[...]}` ou um job COMPOSTO `{"jobs":["job:a","b.json",...]}` que concatena os ops
    /// das partes na ordem dada (o `base` das partes e ignorado: vale o do composto). Determinismo: mesma lista, mesmos ops.</summary>
    public static JsonArray CollectOps(JsonNode job, string jobDir, Action<string>? log = null)
        => CollectOps(job, jobDir, log, null, new HashSet<string>(StringComparer.OrdinalIgnoreCase));

    /// <summary>The documents of the integration ops (soap wsdl, rest openapi, their bundled imports) as absolute paths: a
    /// relative path in a suite job resolves against the job's folder, then the repository root (as `base` does). URLs and
    /// absolute paths stay as written; the facade pins URLs before a job reaches the kernel.</summary>
    private static JsonArray ResolveDocuments(JsonArray ops, string jobDir)
    {
        if (!ops.OfType<JsonObject>().Any(o => o["op"]?.ToString() is "soap" or "rest")) return ops;
        var copy = ops.DeepClone().AsArray();
        string Absolute(string path)
        {
            if (Path.IsPathFullyQualified(path) || Uri.TryCreate(path, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https") return path;
            var local = Path.GetFullPath(Path.Combine(jobDir, path));
            if (File.Exists(local)) return local;
            // C01: the repository of the job, then the kernel that runs (a hosted job lives outside any repository).
            foreach (var root in JobRoots(jobDir))
                if (File.Exists(Path.Combine(root, path))) return Path.GetFullPath(Path.Combine(root, path));
            return path;
        }
        void Document(JsonObject owner, string key, string importsKey)
        {
            if (owner[key] is JsonValue v && v.TryGetValue<string>(out var text)) owner[key] = Absolute(text);
            else if (owner[key] is JsonObject document)
            {
                if (document["path"] is JsonValue p && p.TryGetValue<string>(out var path)) document["path"] = Absolute(path);
                foreach (var (_, dependency) in document[importsKey] as JsonObject ?? new JsonObject())
                    if (dependency is JsonObject d && d["path"] is JsonValue dp && dp.TryGetValue<string>(out var depPath)) d["path"] = Absolute(depPath);
            }
        }
        foreach (var op in copy.OfType<JsonObject>())
        {
            if (op["data"] is not JsonObject data) continue;
            if (op["op"]?.ToString() == "soap") Document(data, "wsdl", "imports");
            else if (op["op"]?.ToString() == "rest" && data["openapi"] is JsonObject openapi)
            {
                if (openapi["path"] is JsonValue p && p.TryGetValue<string>(out var path)) openapi["path"] = Absolute(path);
                foreach (var (_, dependency) in openapi["external"] as JsonObject ?? new JsonObject())
                    if (dependency is JsonObject d && d["path"] is JsonValue dp && dp.TryGetValue<string>(out var depPath)) d["path"] = Absolute(depPath);
            }
        }
        return copy;
    }

    private static JsonArray CollectOps(JsonNode job, string jobDir, Action<string>? log,
        Func<string, string, int, string>? resolveProducer, HashSet<string> active, int offset = 0)
    {
        if (job is JsonArray a) return Prepare(a);
        var obj = job.AsObject();
        if (obj["jobs"] is not JsonArray parts) return Prepare(obj["ops"]?.AsArray() ?? throw new InvalidOperationException("job sem 'ops' nem 'jobs'"));
        if (obj["ops"] is JsonArray own && own.Count > 0) throw new InvalidOperationException("job composto: use 'jobs' OU 'ops', nao os dois");
        var ops = new JsonArray();
        foreach (var part in parts)
        {
            var spec = part!.GetValue<string>();
            var path = Path.GetFullPath(ResolveJobFile(spec, jobDir));
            CheckJobName(path);
            if (!active.Add(path)) throw new ArgumentException($"composite job cycle: {string.Join(" -> ", active)} -> {path}");
            try
            {
                var partJob = JsonNode.Parse(File.ReadAllText(path))!;
                MessageExpectations.Read(partJob, path); // so esquema; o contrato do composto e exclusivamente o do pai
                var partOps = CollectOps(partJob, Path.GetDirectoryName(path)!, log, resolveProducer, active, offset + ops.Count);
                foreach (var n in partOps) ops.Add(n!.DeepClone());
                log?.Invoke($"jobs: {spec}: {partOps.Count} ops");
            }
            finally { active.Remove(path); }
        }
        return ops;

        JsonArray Prepare(JsonArray source)
        {
            source = ResolveDocuments(source, jobDir);
            if (resolveProducer == null) return source;
            var copy = source.DeepClone().AsArray();
            for (var i = 0; i < copy.Count; i++)
                if (copy[i] is JsonObject op && op["op"]?.GetValue<string>() == "reference" && op["producer"] is JsonValue producer)
                    op["producer"] = resolveProducer(producer.GetValue<string>(), jobDir, offset + i);
            return copy;
        }
    }

    /// <summary>"job:&lt;nome&gt;" = &lt;nome&gt;.json na pasta do job, na pasta POSITIVA da mesma faixa (um job de
    /// `tests/jobs-odc-negative` alcanca `tests/jobs-odc`) ou em `tests/jobs`; senao caminho relativo a pasta do job
    /// ou a raiz. A pasta positiva vem antes de `tests/jobs` para que uma faixa nunca herde por engano o job de outra.</summary>
    public static string ResolveJobFile(string spec, string jobDir)
    {
        var candidates = new List<string>();
        if (spec.StartsWith("job:", StringComparison.Ordinal))
        {
            var name = spec[4..] + ".json";
            candidates.Add(Path.Combine(jobDir, name));
            var folder = Path.GetFileName(Path.TrimEndingDirectorySeparator(Path.GetFullPath(jobDir)));
            if (folder.EndsWith("-negative", StringComparison.OrdinalIgnoreCase))
                candidates.Add(Path.Combine(Path.GetDirectoryName(Path.GetFullPath(jobDir))!, folder[..^"-negative".Length], name));
            foreach (var root in JobRoots(jobDir)) candidates.Add(Path.Combine(root, "tests", "jobs", name));
        }
        else
        {
            candidates.Add(Path.IsPathRooted(spec) ? spec : Path.Combine(jobDir, spec));
            if (!Path.IsPathRooted(spec)) foreach (var root in JobRoots(jobDir)) candidates.Add(Path.Combine(root, spec));
        }
        return candidates.FirstOrDefault(File.Exists) ?? throw new FileNotFoundException($"jobs: parte nao encontrada: {spec} (procurado em {string.Join(", ", candidates)})");
    }

    internal static string? RepoRoot(string dir)
    {
        var root = dir;
        while (root != null && !File.Exists(Path.Combine(root, "MANIFESTO.md"))) root = Path.GetDirectoryName(root);
        return root;
    }

    /// <summary>The repository roots of the kernel that runs (C01 of the atritos 3 package): the folder of the Anvil.Core
    /// assembly first (the CLI lives in &lt;kernel&gt;/.local/&lt;lane&gt;/cli, the test host in &lt;kernel&gt;/tests/.../bin), then
    /// AppContext.BaseDirectory (on O11, after StudioAssemblies.Bind, it is the Studio's folder, so it comes second). The
    /// pattern of ApiCatalog, Builtins and VerifyHints; never the current directory, which a hosted run sets elsewhere.</summary>
    internal static IEnumerable<string> RunningRoots()
    {
        var assembly = Path.GetDirectoryName(typeof(JobRunner).Assembly.Location);
        return new[] { string.IsNullOrEmpty(assembly) ? null : RepoRoot(assembly), RepoRoot(AppContext.BaseDirectory) }
            .OfType<string>().Distinct(StringComparer.OrdinalIgnoreCase);
    }

    /// <summary>The roots a relative name of a job resolves against: the repository of the job's folder, then the kernel that
    /// runs, then the current directory's (C01: a hosted job lives in &lt;ws&gt;/odc/.local/jobs/inline, outside any repository).</summary>
    internal static IEnumerable<string> JobRoots(string jobDir)
        => new[] { RepoRoot(Path.GetFullPath(jobDir)) }.Concat(RunningRoots()).Append(RepoRoot(Directory.GetCurrentDirectory()))
            .OfType<string>().Distinct(StringComparer.OrdinalIgnoreCase);

    /// <summary>Cache e deteccao de ciclos por execucao; nunca reutiliza saidas de outra corrida.</summary>
    private sealed class Sources(ModelHost host, IReadOnlyDictionary<string, string>? bindings, Action<string>? log)
    {
        private readonly string work = Path.Combine(host.WorkDirectory, "producers", Guid.NewGuid().ToString("N"));
        private readonly Dictionary<string, string> built = new(StringComparer.OrdinalIgnoreCase);
        private readonly List<string> active = new();

        public string Base(string jobPath)
        {
            var job = JsonNode.Parse(File.ReadAllText(jobPath))!;
            return Resolve(job is JsonObject o ? o["base"]?.GetValue<string>() ?? "tests/fixtures/blank-service.oml"
                : "tests/fixtures/blank-service.oml", Path.GetDirectoryName(Path.GetFullPath(jobPath))!, "base");
        }

        private string Resolve(string spec, string jobDir, string role)
        {
            var source = JobSources.Resolve(spec, jobDir, role, bindings);
            if (!source.IsJob) return source.Path;
            if (built.TryGetValue(source.Path, out var cached)) return cached;
            var digest = System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(source.Path));
            var output = Path.Combine(work, Path.GetFileNameWithoutExtension(source.Path) + "-" + Convert.ToHexString(digest)[..12] + ".oml");
            log?.Invoke($"{role}: building {spec}");
            var result = System.Text.Json.JsonSerializer.SerializeToNode(Build(source.Path, null, output))!;
            if (result["isValid"]?.GetValue<bool>() != true || result["accepted"]?.GetValue<bool>() != true)
                throw new InvalidOperationException($"{role} job '{source.Path}' failed validation: {result["details"]}; {result["policyMessages"]}");
            built[source.Path] = output;
            return output;
        }

        public object Build(string jobPath, string? basePath, string outPath)
        {
            jobPath = Path.GetFullPath(jobPath);
            CheckJobName(jobPath);
            if (active.Contains(jobPath, StringComparer.OrdinalIgnoreCase))
                throw new ArgumentException($"job dependency cycle: {string.Join(" -> ", active)} -> {jobPath}");
            active.Add(jobPath);
            try
            {
                var job = JobDocument.Parse(jobPath);
                // N3: a malformed expectation is a problem of the preflight below, with every other one (never thrown alone).
                var expectations = MessageExpectations.Inspect(job, jobPath);
                var expected = expectations.Expected;
                // Reject cheap deterministic errors before rebuilding any base job.
                var preflight = JobPreflight.Analyze(CollectOps(job, Path.GetDirectoryName(jobPath)!, null), job, null, jobPath);
                JobPreflight.RequireValid(preflight);
                var expectedValid = job is JsonObject obj && obj["expectValid"] is JsonValue ev && ev.TryGetValue<bool>(out var valid) ? valid : true;
                var resolvedBase = basePath == null ? Base(jobPath) : Path.GetFullPath(basePath);
                var ops = CollectOps(job, Path.GetDirectoryName(jobPath)!, log,
                    (spec, dir, index) =>
                    {
                        try { return Resolve(spec, dir, "producer"); }
                        catch (Exception ex) { throw new InvalidOperationException($"op #{index} (reference): {Errors.Text(ex)}", ex); }
                    }, new HashSet<string>(StringComparer.OrdinalIgnoreCase) { jobPath });
                return ApplyResolved(host, resolvedBase, ops, outPath, log, expected, expectedValid, preflight,
                    builtBase: built.ContainsValue(resolvedBase), opsPointer: JobPreflight.OpsPointer(job), notes: expectations.Notes);
            }
            finally { active.RemoveAt(active.Count - 1); }
        }
    }
}
