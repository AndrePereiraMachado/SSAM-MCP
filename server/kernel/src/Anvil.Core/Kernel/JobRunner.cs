using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Core;

/// <summary>Carrega a base, aplica um job de verbos num unico comando, verifica e salva o foreign.</summary>
public static partial class JobRunner
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
        IReadOnlyList<JsonObject>? notes = null, bool autoPatch = true, JsonNode? sentJob = null, string? sourceDirectory = null)
    {
        var elapsed = System.Diagnostics.Stopwatch.StartNew();
        var sentOps = ops.DeepClone().AsArray();
        try { return ApplyResolvedCore(host, basePath, ops, outPath, log, expected, expectedValid, preflight, builtBase, opsPointer, notes, null,
            refuseVerifyErrors: autoPatch && expectedValid); }
        // A refusal for an owner's rule goes through the patch round (JobRunner.Probe.cs) once this model is released: the job
        // with its patches applied on a fresh copy of the base says what the refusal could not see and which patch is not good.
        catch (Exception refusal) when (opsPointer != null && PatchRoundApplies(refusal))
        {
            if (AutoPatchApplies(refusal, autoPatch, expectedValid, opsPointer))
            {
                var outcome = AutoPatchLoop(refusal, sentOps, opsPointer,
                    (applied, probe) => ApplyResolvedCore(host, basePath, applied, outPath, log, expected, expectedValid,
                        JobPreflight.Analyze(applied, opsPointer.Length == 0 ? applied : new JsonObject { ["ops"] = applied.DeepClone() }),
                        builtBase, opsPointer, notes, probe), log, sentJob);
                if (outcome is AutoPatchResult patched) return AutoPatchReceipt(patched, sentJob ?? (opsPointer.Length == 0 ? sentOps : new JsonObject { ["ops"] = sentOps.DeepClone() }),
                    outPath, Errors.Normalizations(refusal), elapsed.ElapsedMilliseconds, ops, sourceDirectory);
                System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture((Exception)outcome).Throw();
            }
            System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(PatchRound(refusal, host, basePath, ops, log, expected, expectedValid, builtBase, opsPointer)).Throw();
            throw;
        }
    }

    private static object ApplyResolvedCore(ModelHost host, string basePath, JsonArray ops, string outPath, Action<string>? log,
        IReadOnlyList<ExpectedMessage> expected, bool expectedValid, JsonObject? preflight, bool builtBase, string? opsPointer,
        IReadOnlyList<JsonObject>? notes, Probe? probe, bool refuseVerifyErrors = false)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var signatures=ops.OfType<JsonObject>().Where(op=>op["op"]?.ToString()=="reference")
            .Select(op=>op["producer"]!.ToString()).Distinct(StringComparer.OrdinalIgnoreCase)
            .Where(path=>Path.GetExtension(path).Equals(".avsig",StringComparison.OrdinalIgnoreCase))
            .ToDictionary(path=>path,NativeReferenceSnapshot.Read,StringComparer.OrdinalIgnoreCase);
        bool NativeReference(JsonNode? node)=>node?["op"]?.ToString()=="reference" && signatures.ContainsKey(node["producer"]!.ToString());
        // Frozen references (.avsig) are imported before the edit transaction wherever the job writes them: a later one is
        // hoisted (and reported), never refused.
        var prepared=ops.Where(NativeReference).OfType<JsonObject>().ToList();
        var firstEdit=ops.Select((op,index)=>(op,index)).FirstOrDefault(x=>!NativeReference(x.op),(null,ops.Count)).index;
        var hoisted=ops.Select((op,index)=>(op,index)).Where(x=>x.index>firstEdit && NativeReference(x.op)).Select(x=>x.index).ToArray();
        var baseBytes = File.ReadAllBytes(basePath);
        var producers = new Dictionary<string, ServiceStudio.Model.ESpace>(StringComparer.OrdinalIgnoreCase);
        ServiceStudio.Model.ESpace LoadProducer(string spec)
        {
            if (producers.TryGetValue(spec, out var cached)) return cached;
            // As fontes foram resolvidas antes de abrir a transacao do consumidor.
            var p = host.Load(File.ReadAllBytes(spec));
            producers[spec] = p;
            return p;
        }
        // data.bind of the prototype ops (docs/PROTOTIPO-NATIVO.md 2.12): what still needs a binding is proposed, built offline and
        // refused at once, before the base is loaded for the edit; a complete binding's frozen producer signature is imported
        // before the transaction like a reference op's.
        if (ops.OfType<JsonObject>().Any(o => o["op"]?.ToString() == "prototype" && o["data"]?["bind"] is JsonObject))
        {
            try
            {
                foreach (var reference in PrototypeBindPrepass.Run(host, baseBytes, ops, opsPointer, LoadProducer, log))
                {
                    var file = reference["producer"]!.ToString();
                    if (!signatures.ContainsKey(file)) signatures[file] = NativeReferenceSnapshot.Read(file);
                    prepared.Add(reference);
                }
            }
            catch { foreach (var p in producers.Values) ModelHost.Release(p); throw; }
        }
        // In the resident worker only: a spare instance of exactly this base, taken once and released below like a fresh load.
        var spare = BaseModelCache.Shared?.Take(basePath, baseBytes, reusable: !builtBase);
        var espace = spare?.Model ?? host.Load(baseBytes);
        // The Studio's defaults of the screen reading, before any op runs: measured outside the job's command (once per Studio
        // identity and context: the module and the theme of each of its UI flows, and of a new flow; in a copy of the base bytes)
        // when this Studio was never measured here for such a context. A flow the job gives a theme of its own is measured when
        // its first page is written.
        StudioDefaults.Remember(espace, baseBytes);
        StudioDefaults.Prepare(espace);
        var loadMs = sw.ElapsedMilliseconds;
        // A job keeps the reads its answers name (the basedOn of a next text or data edit, the edit a refusal hands back) in the store.
        var session = new ModelSession(espace) { BaseSha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(baseBytes)).ToLowerInvariant(), KeepReadings = true };
        session.ProducerLoader = LoadProducer;
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
            {
                try { session.PrepareSignatureReference(reference,signatures[reference["producer"]!.ToString()]); }
                catch (Exception ex)
                {
                    // primeira-certa A7: a frozen producer signature that cannot be imported stops before the apply; its refusal
                    // keeps its own exception and code, and says so in the format of the single refusal.
                    if (Errors.Diagnosis(ex) == null)
                        Errors.Annotate(ex, false, "a frozen producer signature of the job could not be imported (" + Errors.Text(ex) + "): the apply and the Verify did not run",
                            ["apply"], Errors.FindCoded(ex)?.Problems is { Count: > 0 } ? null : ReferenceProblems(ex, reference, ops.IndexOf(reference), opsPointer));
                    throw;
                }
            }
            // lentidao 2026-10-12 (cause 3): the normalizations of the preflight (the job alone), again on these ops (idempotent: a
            // composite or an integration job collects its ops anew), then those only the base decides (the attributes of a module
            // record, the null functions the module does not declare), before the base check and the first op; each is listed in
            // the answer (normalizations), never refused. Not for a job that expects an invalid module.
            phase = sw.ElapsedMilliseconds;
            session.Normalized(preflight?["normalizations"] as JsonArray ?? new JsonArray());
            // One reading of the base for the normalizations and the base check (its index of names and records is built once).
            var baseFacts = new Preflight.ModelBaseFacts(session, espace);
            if (expectedValid)
            {
                session.Normalized(Preflight.JobNormalizer.Pure(ops, opsPointer, MessageExpectations.Lane));
                session.Normalized(Preflight.JobNormalizer.WithBase(ops, opsPointer, MessageExpectations.Lane, baseFacts));
            }
            var normalizeMs = sw.ElapsedMilliseconds - phase;
            // Everything the job names that only the base can answer, all at once, before the first op (C20).
            phase = sw.ElapsedMilliseconds;
            var baseCheck = CheckAgainstBase(session, espace, ops, preflight, opsPointer, checkFunctions: expectedValid, log: log, facts: baseFacts);
            // motor2 review: a node the module type has not, with its certain patch (a Download in a Mobile module), is applied
            // as the patch writes it for this round's apply and Verify (never saved: the job is refused for it), so the round
            // proves the patch and judges the rest of the op; then the pointers of the base phase speak of the job as sent.
            Preflight.NodeRules.ApplyForDiagnosis(ops, baseCheck.Problems, opsPointer, log);
            Preflight.SentJob.TranslateAll(baseCheck.Problems, ops, opsPointer);
            var baseCheckMs = sw.ElapsedMilliseconds - phase;
            phase = sw.ElapsedMilliseconds;
            // A02 item 6: every failing op is recorded (its dependents skipped). primeira-certa A2: kept, not thrown, so the
            // Verify of what did apply joins the refusal; an op the preflight refused whole is never run.
            session.OpsPointer = opsPointer;
            session.KeepFailures = true;
            session.SkipOps = RefusedWholeButDocuments(preflight, ops);
            session.KnownProblems = (preflight?["problems"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().Concat(baseCheck.Problems).ToList();
            var results = session.Apply(ops, log);
            // What only the database upgrade (publish) would refuse, read on the effective model before anything is saved.
            // Not on a model the Studio could not check at the end of the apply (a failed op left it half-built).
            var upgrade = session.EndOfApplyFailure == null ? session.DatabaseUpgradeRefusals(ops, MessageExpectations.Lane) : [];
            // primeira-certa A1/A2: a problem of any phase is refused once, with the problems of every phase, the Verify's
            // included; nothing is saved.
            if (preflight?["valid"]?.GetValue<bool>() == false || baseCheck.Problems.Count > 0 || session.Kept != null || upgrade.Count > 0)
            {
                var refusal = Diagnosis(session, espace, before, ops, preflight, baseCheck, upgrade, expected, expectedValid, opsPointer, log);
                // What was rewritten comes with what stayed, so the correction does not undo a normalization.
                Errors.AttachNormalizations(refusal, session.Normalizations());
                if (probe == null) throw refusal;
                probe.Execution = Errors.Diagnosis(refusal);
                probe.Normalizations = session.Normalizations();
                // The patch round reads the refusal of its job with this model still loaded (the keys of the Verify's messages).
                Classify(probe, session, (Errors.FindCoded(refusal)?.Problems ?? new JsonArray()).OfType<JsonObject>());
                if (session.EndOfApplyFailure == null) ClassifyUnusedLiterals(probe, MessageDelta.Compute(before, ModelHost.Messages(espace)).New);
                return probe;
            }
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
            // primeira-certa A3: a candidate only the Verify refuses answers its errors as the single refusal does too: each
            // with the op, the pointer into the job, the element, the key and a fix (the delivery shows them, never only text).
            JsonArray? verifyProblems = null;
            if (!accepted && expectedValid && policy.Unexpected.Count > 0)
            {
                try
                {
                    var mapped = session.VerifyProblems(policy.Unexpected, ops, opsPointer, MessageExpectations.Lane, VerifyHints.TryRead())
                        .Where(p => p["severity"]?.ToString() != "warning").ToList();
                    Preflight.SentJob.TranslateAll(mapped, ops, opsPointer);
                    verifyProblems = new JsonArray(mapped.Select(p => (JsonNode)JobPreflight.PublicProblem(p)).ToArray());
                }
                catch (Exception ex) { log?.Invoke("  verify problems not mapped: " + Errors.Text(ex)); }
            }
            var detailsMs = sw.ElapsedMilliseconds - phase;
            var certainVerifyErrors = (verifyProblems ?? new JsonArray()).OfType<JsonObject>()
                .Where(problem => problem["severity"]?.ToString() != "warning").ToList();
            if (!accepted)
            {
                var unmapped = policy.Diagnostics().Where(message => message.StartsWith("Ambiguous ", StringComparison.Ordinal)
                    || message.StartsWith("Missing ", StringComparison.Ordinal)).ToList();
                foreach (var message in policy.Unexpected)
                    if (!certainVerifyErrors.Any(p => p["code"]?.ToString() == message.Id && (p["key"] == null || p["key"]?.ToString() == message.Key
                        || p["key"]?.ToString() == message.OwnerKey || p["element"]?.ToString() == message.Path)))
                        unmapped.Add(message.ToString());
                if (dataContract["accepted"]!.GetValue<bool>() != true)
                    unmapped.AddRange(policyMessages.Where(m => m.StartsWith("Data property mismatch:", StringComparison.Ordinal)));
                if (snap.IsValid != expectedValid && certainVerifyErrors.Count == 0) unmapped.Add($"expectValid={expectedValid}, but Verify isValid={snap.IsValid}");
                if (unmapped.Count == 0 && certainVerifyErrors.Count == 0) unmapped.AddRange(policyMessages);
                if (unmapped.Count > 0)
                {
                    verifyProblems ??= new JsonArray();
                    var problem = JobPreflight.Problem(null, opsPointer, "VERIFY_REFUSED", "error", string.Join("; ", unmapped.Distinct()),
                        "resolve every unmapped validation and policy verdict before saving");
                    problem["phase"] = "verify"; verifyProblems.Add(JobPreflight.PublicProblem(problem));
                }
            }
            // Preserve the existing saved rejected-result contract for Verify choices and policy failures.
            // Only a complete certain set enters auto-patching; the final probe remains strict below.
            // Count after policy aggregation: an unmapped VERIFY_REFUSED must prevent silent promotion.
            var completeVerifyErrors = (verifyProblems ?? new JsonArray()).OfType<JsonObject>()
                .Where(problem => problem["severity"]?.ToString() != "warning").ToList();
            if (probe == null && refuseVerifyErrors && !accepted && completeVerifyErrors.Count > 0
                && completeVerifyErrors.All(Preflight.PatchCertainty.IsCertain))
            {
                var problems = verifyProblems ?? new JsonArray();
                if (problems.Count == 0) problems.Add(JobPreflight.PublicProblem(JobPreflight.Problem(null, opsPointer,
                    "VERIFY_REFUSED", "error", string.Join("; ", policyMessages), "resolve the candidate's validation verdict before saving")));
                var refusal = new JobPreflightException("Verify refused the candidate", problems) {
                    VerifyRan = true, Phases = preflight == null ? ["base", "apply", "verify"] : ["preflight", "base", "apply", "verify"]
                };
                Errors.AttachNormalizations(refusal, session.Normalizations());
                throw refusal;
            }
            if (probe != null)
            {
                probe.Execution = new JsonObject { ["verifyRan"] = true,
                    ["phases"] = preflight == null ? new JsonArray("base", "apply", "verify") : new JsonArray("preflight", "base", "apply", "verify") };
                probe.Normalizations = session.Normalizations();
                Classify(probe, session, verifyProblems?.OfType<JsonObject>() ?? []);
                ClassifyUnusedLiterals(probe, delta.New);
                if (!probe.Final || !accepted || verifyProblems is { Count: > 0 } || probe.Found.Count > 0) return probe;
            }
            phase = sw.ElapsedMilliseconds;
            var refactorAssertions = session.RefactorContract();
            var bytes = host.Save(espace);
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outPath))!);
            if (probe?.Final != true) File.WriteAllBytes(outPath, bytes);
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
                var reloaded = probe?.Final == true ? host.Load(bytes) : host.Load(outPath);
                try { refactorProof = new ModelSession(reloaded).CheckRefactorContract(refactorAssertions); }
                finally { ModelHost.Release(reloaded); }
                refactorProof["assertions"] = refactorAssertions;
                if (refactorProof["accepted"]!.GetValue<bool>() != true) {
                    accepted = false;
                    policyMessages.Add("Refactor reference sets changed after save/reload: " + refactorProof["differences"]!.ToJsonString());
                }
            }
            if (probe?.Final == true)
            {
                if (!accepted)
                {
                    var problem = JobPreflight.Problem(null, opsPointer, "REFACTOR_CONTRACT_REFUSED", "error",
                        string.Join("; ", policyMessages), "resolve the refactor contract before saving");
                    problem["phase"] = "verify";
                    probe.Found.Add((problem, null));
                    return probe;
                }
                File.WriteAllBytes(outPath, bytes);
            }
            var timings = new { loadMs, baseAcquireMs = spare?.AcquireMs, verifyBeforeMs, normalizeMs, baseCheckMs, footprintMs, applyMs, sessionApplyMs, dataContractMs, verifyAfterMs, describeMs, detailsMs, saveMs, releaseMs, refactorProofMs = sw.ElapsedMilliseconds - phase, totalMs = sw.ElapsedMilliseconds };
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
                .Where(r => r["op"]?.ToString() is "rest" or "rest-consume" or "rest-expose" or "soap" && r["result"]?["integration"] is JsonObject)
                .Select(r => r["result"]!["integration"]!.DeepClone()).ToArray());
            // data.entityActions: the receipt of each entity-actions op (what it created, kept unchanged, kept and why).
            var entityActions = new System.Text.Json.Nodes.JsonArray(results.OfType<JsonObject>()
                .Where(r => r["op"]?.ToString() == EntityActionsExpander.Op && r["result"]?["entityActions"] is JsonObject)
                .Select(r => { var copy = r["result"]!["entityActions"]!.DeepClone().AsObject(); if (r["result"]?["noChange"] is { } same) copy["noChange"] = same.DeepClone(); return (JsonNode)copy; }).ToArray());
            var answer = new { outPath, outSha256, ops = ops.Count, loadMs, applyMs, objects = snap.Objects, isValid = snap.IsValid, messages = snap.Validation.Total, details, validation, accepted, expectedValid, policyMessages, handles, results, footprint = footprint.Json, hoistedReferences = hoisted.Length > 0 ? hoisted : null, flowLayoutEngine = FlowLayout.EngineRevision, automaticLayouts = session.AutomaticLayouts, layoutRefused, released, baseCache = spare?.Receipt, timings, preflight, dataContract, refactorProof, coverage = session.CoverageLedger() };
            // What the kernel applied that the author did not write (atritos 3, section 5.1): notes, iconConversions,
            // expressionRewrites, nameTruncations, indexNoOps, anonymousExposure, ... each only when it has entries.
            var receipt = session.ReceiptFields(policy, footprint.Footprint);
            if (notes is { Count: > 0 })
            {
                if (receipt["notes"] is not JsonArray all) receipt["notes"] = all = new JsonArray();
                for (var n = notes.Count - 1; n >= 0; n--) all.Insert(0, notes[n].DeepClone());
            }
            if (verifyProblems is { Count: > 0 })
            {
                receipt["problems"] = verifyProblems;
                receipt["verifyRan"] = true;
                receipt["phases"] = preflight == null ? new JsonArray("base", "apply", "verify") : new JsonArray("preflight", "base", "apply", "verify");
            }
            if (integration.Count == 0 && receipt.Count == 0) return answer;
            var withIntegration = System.Text.Json.JsonSerializer.SerializeToNode(answer, Json.Compact)!.AsObject();
            if (integration.Count > 0) withIntegration["integration"] = integration;
            if (entityActions.Count > 0) withIntegration["entityActions"] = entityActions;
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

    /// <summary>The expression with every call of <paramref name="name"/> renamed to <paramref name="to"/>, outside its text
    /// literals (a text that only looks like the call stays as written): the patch of an unknown function one built-in
    /// certainly means, here (FUNCTION_UNKNOWN) and in the Verify mapped to the job (ModelSession.VerifyProblems).</summary>
    internal static string RenameCall(string text, string name, string to)
    {
        var rename = new Regex(@"(?<![\w.])" + Regex.Escape(name) + @"(?=\s*\()", RegexOptions.IgnoreCase);
        return string.Concat(StringLiteral.Split(text).Zip(StringLiteral.Matches(text).Select(m => m.Value).Append(""), (code, literal) => rename.Replace(code, to) + literal));
    }

    /// <summary>What only the base can answer, checked before the first op and refused all at once (C20, I2): the types the
    /// job uses without declaring, the SQL names of the base, the names and keys the ops reference without creating, and the
    /// functions the logic expressions call (built-ins of this Studio, functions of the module or its references, the job's
    /// own actions). The refusal is a JobPreflightException (PREFLIGHT_REFUSED) with every problem; the wording of the type
    /// and SQL lines stays the one tools already read. primeira-certa A2: the problems are returned, never thrown here: the
    /// caller goes on to the apply and the Verify and refuses once with every phase (Diagnosis).</summary>
    private static BaseCheck CheckAgainstBase(ModelSession session, ServiceStudio.Model.ESpace espace, JsonArray ops, JsonObject? preflight, string? opsPointer, bool checkFunctions = true, Action<string>? log = null,
        Preflight.ModelBaseFacts? facts = null)
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
            // A documentation property the element cannot write is dropped by the apply and listed (JobNormalizer), never refused.
            if (!session.CanSet(element, prop) && Preflight.JobNormalizer.Droppable(prop)) continue;
            // motor2 (C11): a property the element means by another name is written there by the apply (PROPERTY_ALIASED).
            if (!session.CanSet(element, prop) && Preflight.PropertyAliases.Meant(element.GetType().GetInterfaces().Select(t => t.Name), prop) is { } meant
                && session.CanSet(element, meant)) continue;
            if (!session.CanSet(element, prop) && !(prop == "Style" && session.StyleHasAPlace(element)))
                problem = JobPreflight.Problem(index, Pointer(index) is { } at ? at + "/prop" : null, "PROPERTY_NOT_WRITABLE", "error",
                    ModelSession.PropertyErrorText(element, prop), $"write one of: {string.Join(", ", ModelSession.ClosestWritable(element, prop))}", null, "set");
            else if (set["value"] is JsonValue v && v.TryGetValue<string>(out var text) && ModelSession.IsExpressionProperty(element, prop)
                     && SetSyntax(text) is { } syntax)
                problem = JobPreflight.Problem(index, Pointer(index) is { } at ? at + "/value" : null, "EXPRESSION_SYNTAX", "error",
                    $"{prop} = {text}: {syntax.Problem}", syntax.Fix, null, "set");
            if (problem == null) continue;
            problems.Add(problem);
            lines.Add(JobPreflight.Text(problem));
        }
        // Functions the logic expressions call: the same rule as the Verify's ExpressionUnknownFunction, before any op. A job
        // that expects an invalid module (expectValid false) asks the Verify for that verdict: it is not refused here.
        // G5 (2026-10-11): the expressions an html page op writes from its bindings, sources and variables are read too (job
        // 0314 of the html replay reached the Verify with 18 ExpressionUnknownFunction 'Lower' in its bindings).
        // B3 (2026-10-12): and the expressions the edit form of an html op writes (the plan of a refused edit never reaches the
        // Verify, so an unknown function such as JSONSerialize came only in a later round).
        var calls = checkFunctions ? LogicLint.AllExpressions(ops).Concat(HtmlPageExpressions(ops)).Concat(HtmlEditExpressions(ops))
            .SelectMany(e => FunctionCall.Matches(StringLiteral.Replace(e.Text, "\"\"")).Select(m => (e.Op, Name: m.Groups[1].Value)))
            .Where(c => c.Name is not ("and" or "or" or "not") && !RoleFunction.IsMatch(c.Name)).ToList() : [];
        HashSet<string>? builtins = null, scope = null;
        if (calls.Count > 0) try { builtins = FunctionCatalog.Names; } catch { /* no catalog in this host: Verify judges */ }
        // The module's own functions are read only when a call is no built-in (a walk of the whole module).
        if (builtins != null && calls.Any(c => !builtins.Contains(c.Name))) try { scope = ExpressionCheck.ScopeFunctions(espace); } catch { }
        if (builtins != null && scope != null)
        {
            var actionNames = session.BuiltinActionNames();
            if (actionNames != null)
                foreach (var reference in ops.OfType<JsonObject>().Where(o => o["op"]?.ToString() == "reference"
                    && !Path.GetExtension(o["producer"]?.ToString()).Equals(".avsig", StringComparison.OrdinalIgnoreCase)))
                {
                    try
                    {
                        var producerNames = session.ProducerLoader == null ? null
                            : new ModelSession(session.ProducerLoader(reference["producer"]!.ToString())).BuiltinActionNames();
                        if (producerNames == null) { actionNames = null; break; }
                        actionNames.UnionWith(producerNames);
                    }
                    catch { actionNames = null; break; }
                }
            var declared = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var op in ops.OfType<JsonObject>())
            {
                if (op["name"] is JsonValue n && n.TryGetValue<string>(out var created)) declared.Add(created);
                if (op["op"]?.ToString() == "reference")
                    foreach (var element in (op["elements"] as JsonArray ?? new JsonArray()).OfType<JsonValue>())
                        if (element.TryGetValue<string>(out var selector) && selector.IndexOf(':') is var colon && colon > 0
                            && (selector[..colon].EndsWith("Action", StringComparison.Ordinal) || selector[..colon].EndsWith("ActionSignature", StringComparison.Ordinal)))
                            declared.Add(selector[(colon + 1)..]);
                foreach (var action in (op["data"]?["actions"] as JsonArray ?? new JsonArray()).OfType<JsonObject>())
                    if (action["name"] is JsonValue a && a.TryGetValue<string>(out var actionName)) declared.Add(actionName);
                if (op["data"] is JsonObject flowData && flowData.ContainsKey("flow"))
                    foreach (var text in FlowTextForm.Texts(flowData))
                        if (FlowTextForm.Header(text.Text) is { } header) declared.Add(header.Name);
                // The client functions of a page (data.scripts): its bindings call them by name, the page creates them as
                // <screen>_<name>.
                if (HtmlPage(op) is { } page)
                    foreach (var script in (page["scripts"] as JsonArray ?? new JsonArray()).OfType<JsonObject>())
                        if (script["name"] is JsonValue s && s.TryGetValue<string>(out var scriptName))
                        {
                            declared.Add(scriptName);
                            if (page["screen"] is JsonValue screen && screen.TryGetValue<string>(out var screenName)) declared.Add(screenName + "_" + scriptName);
                        }
            }
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var (op, name) in calls)
            {
                if (builtins.Contains(name) || scope.Contains(name) || declared.Contains(name)) continue;
                if (!seen.Add(op + "|" + name)) continue;
                var closest = FunctionCatalog.Closest(name, scope);
                // Only the reviewed rename table is certain. Distance and shadowed action names are suggestions.
                var whitelist = FunctionCatalog.Certain(name);
                var candidate = whitelist ?? FunctionCatalog.Nearest(name);
                var certain = whitelist != null && actionNames != null && !actionNames.Contains(name)
                    && !actionNames.Contains(whitelist) && !declared.Contains(name) && !scope.Contains(whitelist);
                var sites = CallSites(ops, op, name, opsPointer);
                var patch = candidate == null || sites.Count == 0 || sites.Any(s => s.Sort) ? null
                    : new JsonArray(sites.Select(s => (JsonNode)new JsonObject { ["op"] = "replace", ["path"] = s.Pointer, ["value"] = RenameCall(s.Text, name, candidate) }).ToArray());
                // Without a certain or a close name, the lookup of the built-ins: the facade turns `anvil functions --find X`
                // into ssam_reference {kind:"functions", query:X} with its continuation (responses.mjs), so the session follows it.
                var problem = JobPreflight.Problem(op, sites.Count == 1 ? sites[0].Pointer : Pointer(op), "FUNCTION_UNKNOWN", "error",
                    $"'{name}(' is not a built-in function of this Studio ({MessageExpectations.Lane}), nor a function of the module, of its references or of this job",
                    candidate != null ? certain ? $"write {candidate}(...), the explicit built-in rename with the same declared arguments"
                        : $"choose whether the intended call is {candidate}(...); an action call or another operation may be intended"
                        : closest.Count > 0 ? "use one of: " + string.Join(", ", closest)
                        : $"no built-in, no function of the module or of its references and no action of this job is named like {name}: write the built-in the expression means (ToLower, Substr, If, ...), or call an action of the module marked Function; the built-ins: `anvil functions --find {name}`", patch, "logic",
                        patchRule: patch == null ? null : certain ? "BUILTIN_FUNCTION_RENAMED" : whitelist != null ? "BUILTIN_FUNCTION_SHADOWED" : "BUILTIN_FUNCTION_NEAREST");
                problems.Add(problem);
                lines.Add(JobPreflight.Text(problem));
            }
        }
        // A04 with the base: callees, entities, root names and the module type the pure preflight could not see. Not for a
        // job that imports producers (their names are not the base's) nor one that expects an invalid module.
        if (checkFunctions && !imports)
        {
            var found = Preflight.PreflightChecks.WithBase(ops, opsPointer, MessageExpectations.Lane, facts ?? new Preflight.ModelBaseFacts(session, espace));
            foreach (var problem in found.Problems) { problems.Add(problem); lines.Add(JobPreflight.Text(problem)); }
            foreach (var warning in found.Warnings) log?.Invoke("  " + JobPreflight.Text(warning));
        }
        // motor2: the module type and the base's own screens (a node the module type has not, a name of a base screen with two
        // meanings), for a job that imports producers too; not for one that expects an invalid module.
        if (checkFunctions)
        {
            var found = Preflight.PreflightChecks.WithModule(ops, opsPointer, MessageExpectations.Lane, facts ?? new Preflight.ModelBaseFacts(session, espace));
            foreach (var problem in found.Problems)
            {
                // The pure pass may have found the same name problem without the base: once (its pointers are the job as sent).
                var sent = Preflight.SentJob.ToSent(problem["pointer"]?.ToString(), ops, opsPointer).Pointer;
                if (Preflight.ActionNameRules.EnrichPreflight(preflight, problem, sent)) continue;
                if (problems.Any(p => p["code"]?.ToString() == problem["code"]?.ToString() && p["pointer"]?.ToString() == problem["pointer"]?.ToString())
                    || preflight?["problems"] is JsonArray pure && pure.OfType<JsonObject>().Any(p => p["code"]?.ToString() == problem["code"]?.ToString() && p["pointer"]?.ToString() == sent)) continue;
                problems.Add(problem); lines.Add(JobPreflight.Text(problem));
            }
            foreach (var warning in found.Warnings) log?.Invoke("  " + JobPreflight.Text(warning));
        }
        // I6: what only the base could answer.
        foreach (var problem in problems) problem["phase"] ??= "base";
        return new(problems, lines);
    }

    private static readonly Regex MissingElement = new(@"signature: (\S+)\s*$", RegexOptions.Compiled);
    /// <summary>The start of the native importer's refusal of a reference at another signature (OdcReferenceImporter).</summary>
    public const string OutdatedReference = "Reference version differs from the captured signature";
    /// <summary>fix/unpublished-library round 2 (A1): NativeReferenceSnapshot.Select's refusals of a KIND the signature cannot
    /// hold (an ODC published signature: server actions, client actions, structures, entities and blocks; an extension's:
    /// server actions and entities). MissingElement names their element too, but publishing the producer never adds that kind.</summary>
    private const string UnsupportedOdcKind = "Unsupported element kind for this frozen producer signature";
    private const string UnsupportedExtensionKind = "Native extension references require a server action or entity signature";

    /// <summary>The problem of a reference op whose frozen producer signature lacks an element the op names (or that fails
    /// to import otherwise): its pointer is the element when the message names it.</summary>
    internal static JsonArray ReferenceProblems(Exception ex, JsonObject reference, int op, string? opsPointer)
    {
        var message = Errors.Text(ex);
        var named = MissingElement.Match(message) is { Success: true } m ? m.Groups[1].Value : null;
        var elements = (reference["elements"] as JsonArray ?? new JsonArray()).Select(e => e?.ToString()).ToList();
        var k = named == null ? -1 : elements.FindIndex(e => string.Equals(e, named, StringComparison.OrdinalIgnoreCase));
        var pointer = opsPointer == null || op < 0 ? null : k >= 0 ? $"{opsPointer}/{op}/elements/{k}" : $"{opsPointer}/{op}";
        // fix/system-reference: the capture of each lane (the ODC delivery captures from the consumer session by itself).
        var capture = MessageExpectations.Lane == "odc" ? "studio_deliver captures it from the consumer session; studio_reference_snapshot outside a delivery" : "o11_dependencies capture";
        // Round 2 (M3): the consumer already references the producer at another signature than the capture. A capture of the
        // same published producer gives the same signature again (a loop): the way out is the Studio's refresh of that
        // reference in the consumer module, then the same delivery.
        var outdated = named == null && message.Contains(OutdatedReference, StringComparison.Ordinal);
        // The producer as the consumer's reference names it: the importer ends its text with it (the op's producer is a path by now).
        var listed = outdated && message.LastIndexOf(": ", StringComparison.Ordinal) is var at and >= 0 ? message[(at + 2)..].Trim() : null;
        var refresh = MessageExpectations.Lane == "odc"
            ? $"studio_refresh_references {{module: the consumer module, producer: \"{listed}\"}}"
            : "o11_studio refresh-references {module: the consumer module}";
        // fix/unpublished-library (family OF): an element the job references may exist only in the producer's open model,
        // added or made Public after its last publication. The fix never invites changing what the job means ("remove it"):
        // publish the producer first (a write: the person's own words), then the same job; else write an element it has.
        var producer = reference["producer"]?.ToString() is { } p && JobSources.IsPathSpec(p) && !p.StartsWith("job:", StringComparison.Ordinal) ? Path.GetFileNameWithoutExtension(p) : reference["producer"]?.ToString();
        var publish = MessageExpectations.Lane == "odc" ? "studio_publish, with the person's own words" : "o11_publish, with the person's own words";
        var lists = MessageExpectations.Lane == "odc" ? "studio_reference_snapshot lists what it publishes" : "o11_dependencies list shows what it publishes";
        // Round 2 (A1): a kind the signature cannot hold keeps REFERENCE_ELEMENT_MISSING on its element, and its fix says so.
        var extensionKind = named != null && message.Contains(UnsupportedExtensionKind, StringComparison.Ordinal);
        var unsupportedKind = extensionKind || (named != null && message.Contains(UnsupportedOdcKind, StringComparison.Ordinal));
        var holds = extensionKind ? "an extension signature holds server actions and entities"
            : "an ODC published signature holds server actions, client actions, structures, entities and blocks (an External Library: server actions and structures)";
        var problem = JobPreflight.Problem(op < 0 ? null : op, pointer, named != null ? "REFERENCE_ELEMENT_MISSING" : outdated ? "REFERENCE_OUTDATED" : "REFERENCE_IMPORT_FAILED", "error", message,
            unsupportedKind ? $"the kind of {named} cannot be referenced through the signature of producer {producer}: {holds}; publishing {producer} does not change this: reference an element of one of those kinds, or add this reference in the Studio (Manage Dependencies)"
            : named != null ? $"the published signature of producer {producer} has no {named}: if {producer} has it in a model not published yet (added or made Public after its last publication), publish {producer} first ({publish}), then deliver the same job again; if it was published after this capture, capture it again ({capture}); else write the kind and name of an element {producer} publishes ({lists})"
                : outdated ? $"the consumer module references {listed} at another version than its published signature: refresh that reference in the Studio ({refresh}; it writes to the module, so the person confirms it first), then deliver the same job again"
                : $"capture the producer again ({capture}) and deliver with it", null, "reference");
        problem["phase"] = "apply";
        return new JsonArray(JobPreflight.PublicProblem(problem));
    }

    /// <summary>The syntax problem of an expression a raw `set` writes: unbalanced quotes (what the apply refuses), else, for
    /// a text the apply writes as it is (no rewrite), the whole syntax (primeira-certa A4, Preflight.ExpressionSyntax).</summary>
    private static (string Problem, string Fix)? SetSyntax(string text)
    {
        var rewrite = ModelSession.ExpressionRewrite(text);
        if (rewrite.Syntax != null) return (rewrite.Syntax, "close every text literal with \" (a quote inside a text is written \"\")");
        return rewrite.Text == null ? Preflight.ExpressionSyntax.Check(text) : null;
    }

    /// <summary>primeira-certa A4: the expressions of op <paramref name="op"/> that call <paramref name="name"/>( and their
    /// pointers in the job: the sites of its logic actions, or the value of a raw `set`.</summary>
    private static List<(string Pointer, string Text, bool Sort)> CallSites(JsonArray ops, int op, string name, string? opsPointer)
    {
        var sites = new List<(string Pointer, string Text, bool Sort)>();
        if (opsPointer == null || op < 0 || op >= ops.Count || ops[op] is not JsonObject source) return sites;
        var call = new Regex(@"(?<![\w.])" + Regex.Escape(name) + @"\s*\(", RegexOptions.IgnoreCase);
        bool Calls(string text) => call.IsMatch(StringLiteral.Replace(text, "\"\""));
        if (source["op"]?.ToString() == "set" && source["value"] is JsonValue v && v.TryGetValue<string>(out var value) && Calls(value))
            sites.Add(($"{opsPointer}/{op}/value", value, false));
        for (var a = 0; a < (source["op"]?.ToString() == "logic" ? (source["data"]?["actions"] as JsonArray)?.Count ?? 0 : 0); a++)
            if (source["data"]!["actions"]![a] is JsonObject action)
                foreach (var site in Preflight.LogicScan.Of(action).Expressions.Where(s => Calls(s.Text)))
                    sites.Add(($"{opsPointer}/{op}/data/actions/{a}{site.Pointer}", site.Text, site.Key == "sort"));
        // B3: an edit string of the edit form that calls it (no rename patch: an edit is html, not one expression).
        if (source["op"]?.ToString() == "html" && Anvil.Reading.ScreenHtmlEdit.IsEdit(source) && source["data"]?["edit"] is JsonArray edits)
            for (var e = 0; e < edits.Count; e++)
                if (edits[e] is JsonValue v2 && v2.TryGetValue<string>(out var edit) && EditExpressions(edit).Any(Calls))
                    sites.Add(($"{opsPointer}/{op}/data/edit/{e}", edit, true));
        // G5: a binding, source or variable default of an html page op (a sort entry is [expression, direction]: its site is
        // the expression alone, so it is patched as any other).
        if (HtmlPage(source) is { } page)
            foreach (var (pointer, text) in HtmlExpander.Expressions(page).Where(e => Calls(e.Text)))
                sites.Add(($"{opsPointer}/{op}/data{pointer}", text, false));
        return sites;
    }

    /// <summary>The data of an html op in its page form (no parent, no components), or null.</summary>
    private static JsonObject? HtmlPage(JsonNode? node)
        => node is JsonObject op && op["op"]?.ToString() == "html" && op["parent"] == null && op["data"] is JsonObject data && data["components"] == null
            && !Anvil.Reading.ScreenHtmlEdit.IsEdit(op) && !ScreenDocument.IsDocumentOp(op) ? data : null;

    /// <summary>B3: every expression the edit form of the html ops writes, with its op (EditExpressions).</summary>
    private static IEnumerable<(int Op, string Text)> HtmlEditExpressions(JsonArray ops)
    {
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op || op["op"]?.ToString() != "html" || !Anvil.Reading.ScreenHtmlEdit.IsEdit(op) || op["data"] is not JsonObject data) continue;
            var texts = data["edit"] is JsonArray list ? list.OfType<JsonValue>().Select(v => v.TryGetValue<string>(out var t) ? t : null).OfType<string>().ToList()
                : data["html"] is JsonValue whole && whole.TryGetValue<string>(out var document) ? [document] : [];
            foreach (var text in texts)
                foreach (var expression in EditExpressions(text)) yield return (i, expression);
        }
    }

    private static readonly Regex HtmlRun = new(@"\{\{(.*?)\}\}", RegexOptions.Compiled | RegexOptions.Singleline);

    /// <summary>The expressions of an ssam-html/1 text: the {{ }} runs (in the text and in attribute values), if, list, os-Visible,
    /// block inputs (:X) and the arguments of the events. Plain text and literal attributes are never an expression.</summary>
    internal static IEnumerable<string> EditExpressions(string html)
    {
        Anvil.Reading.ScreenHtml.Node parsed;
        try { parsed = Anvil.Reading.ScreenHtml.Parse(html); } catch (FormatException) { yield break; }
        foreach (var (node, _) in Anvil.Reading.ScreenHtmlText.Elements(parsed))
        {
            foreach (var (name, value) in node.Attributes)
            {
                if (name is "if" or "list" or "os-Visible" || name.StartsWith(':')) yield return value;
                else if ((name.StartsWith("on", StringComparison.Ordinal) || name.StartsWith('@')) && ScreenDocument.ParseCall(value, out _, out var arguments))
                    foreach (var (_, argument) in arguments) yield return argument;
                foreach (Match run in HtmlRun.Matches(value)) yield return run.Groups[1].Value;
            }
            foreach (var child in node.Children.Where(c => c.IsText))
                foreach (Match run in HtmlRun.Matches(child.Text!)) yield return run.Groups[1].Value;
        }
    }

    /// <summary>G5: every expression the html page ops of the job write (HtmlExpander.Expressions), with its op.</summary>
    private static IEnumerable<(int Op, string Text)> HtmlPageExpressions(JsonArray ops)
    {
        for (var i = 0; i < ops.Count; i++)
            if (HtmlPage(ops[i]) is { } data)
                foreach (var (_, text) in HtmlExpander.Expressions(data)) yield return (i, text);
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
        Func<string, string, int, string, string>? resolveProducer, HashSet<string> active, int offset = 0)
    {
        if (job is JsonArray a) return Prepare(a);
        var obj = job.AsObject();
        if (obj["jobs"] is not JsonArray parts) return Prepare(obj["ops"]?.AsArray() ?? throw new InvalidOperationException("job without 'ops' or 'jobs'"));
        if (obj["ops"] is JsonArray own && own.Count > 0) throw new InvalidOperationException("composite job: use 'jobs' OR 'ops', not both");
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
                var partOps = CollectOps(partJob, JobSources.DirectoryOf(path), log, resolveProducer, active, offset + ops.Count);
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
            {
                if (copy[i] is JsonObject op && op["op"]?.GetValue<string>() == "reference" && op["producer"] is JsonValue producer)
                    op["producer"] = resolveProducer(producer.GetValue<string>(), jobDir, offset + i, "producer");
                // data.bind of a prototype op (docs/PROTOTIPO-NATIVO.md 2.12): its producer binding, resolved as a reference's; an
                // unbound producer leaves it out and the op refuses with the binding it lacks
                if (copy[i] is JsonObject proto && proto["op"]?.GetValue<string>() == "prototype" && proto["data"] is JsonObject data
                    && data["bind"]?["producer"] is JsonValue bound && bound.TryGetValue<string>(out var name) && name.Length > 0)
                {
                    try { data["_producer"] = resolveProducer(name, jobDir, offset + i, "prototype"); }
                    catch (Exception ex) when (Errors.Diagnosis(ex)?["sourceJob"] == null) { data.Remove("_producer"); }
                }
            }
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
        return candidates.FirstOrDefault(File.Exists) ?? throw new FileNotFoundException($"jobs: part not found: {spec} (looked in {string.Join(", ", candidates)})");
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
        private readonly Dictionary<string, JsonObject> builtResults = new(StringComparer.OrdinalIgnoreCase);
        private readonly List<JsonObject> sourceBuilds = new();

        public string Base(string jobPath)
        {
            var job = JsonNode.Parse(File.ReadAllText(jobPath))!;
            return Resolve(job is JsonObject o ? o["base"]?.GetValue<string>() ?? "tests/fixtures/blank-service.oml"
                : "tests/fixtures/blank-service.oml", JobSources.DirectoryOf(jobPath), "base");
        }

        private string Resolve(string spec, string jobDir, string role)
        {
            var source = JobSources.Resolve(spec, jobDir, role, bindings);
            if (!source.IsJob) return source.Path;
            var cacheKey = source.Path + "|autoPatch=" + (JobPreflight.AutoPatch.Value != false);
            var digest = System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(cacheKey));
            var output = Path.Combine(work, Path.GetFileNameWithoutExtension(source.Path) + "-" + Convert.ToHexString(digest)[..12] + ".oml");
            log?.Invoke($"{role}: building {spec}");
            var identity = new JsonObject { ["role"] = role, ["spec"] = spec, ["job"] = source.Path };
            try
            {
                var result = builtResults.TryGetValue(cacheKey, out var previous) ? previous
                    : System.Text.Json.JsonSerializer.SerializeToNode(Build(source.Path, null, output))!.AsObject();
                if (result["isValid"]?.GetValue<bool>() != true || result["accepted"]?.GetValue<bool>() != true)
                {
                    var problems = result["problems"]?.DeepClone().AsArray() ?? new JsonArray(JobPreflight.PublicProblem(JobPreflight.Problem(null, null,
                        "VERIFY_REFUSED", "error", string.Join("; ", (result["policyMessages"] as JsonArray ?? new JsonArray()).Select(p => p?.ToString())),
                        "resolve the source job's validation verdict")));
                    var refusal = new JobPreflightException($"{role} job '{source.Path}' refused validation", problems) { VerifyRan = true, Phases = ["base", "apply", "verify"] };
                    Errors.AttachNormalizations(refusal, result["normalizations"] as JsonArray);
                    throw refusal;
                }
                var receipt = identity.DeepClone().AsObject();
                foreach (var field in new[] { "patchesApplied", "normalizations", "patchedJob", "autoPatch", "accepted", "isValid" })
                    if (result[field] != null) receipt[field] = result[field]!.DeepClone();
                receipt["patchesApplied"] ??= new JsonArray();
                receipt["normalizations"] ??= new JsonArray();
                if (!receipt.ContainsKey("patchedJob")) receipt["patchedJob"] = null;
                sourceBuilds.Add(receipt); builtResults[cacheKey] = result; built[cacheKey] = output;
                return built[cacheKey];
            }
            catch (Exception error)
            {
                var diagnosis = Errors.Diagnosis(error) ?? new JsonObject();
                diagnosis["sourceJob"] ??= identity.DeepClone();
                diagnosis["sourceBuilds"] = new JsonArray(sourceBuilds.Select(p => (JsonNode)p.DeepClone()).ToArray());
                error.Data[Errors.DiagnosisKey] = diagnosis;
                if (Errors.FindCoded(error)?.Problems is { } problems)
                    foreach (var problem in problems.OfType<JsonObject>()) problem["sourceJob"] ??= identity.DeepClone();
                throw;
            }
        }

        public object Build(string jobPath, string? basePath, string outPath)
        {
            jobPath = Path.GetFullPath(jobPath);
            CheckJobName(jobPath);
            if (active.Contains(jobPath, StringComparer.OrdinalIgnoreCase))
                throw new ArgumentException($"job dependency cycle: {string.Join(" -> ", active)} -> {jobPath}");
            active.Add(jobPath);
            var sourceStart = sourceBuilds.Count;
            try
            {
                var job = JobDocument.Parse(jobPath);
                var sentJob = job.DeepClone();
                var jobDirectory = JobSources.DirectoryOf(jobPath);
                // N3: a malformed expectation is a problem of the preflight below, with every other one (never thrown alone).
                var expectations = MessageExpectations.Inspect(job, jobPath);
                var expected = expectations.Expected;
                // The cheap deterministic checks first. primeira-certa A2: a job they refuse still goes on, without saving, to
                // the base check, the apply and the Verify when its base (and its producers) load, so the refusal carries every
                // phase at once; when they do not load, the refusal says the Verify did not run and why.
                // motor2 review: the preflight normalizes a copy. The ops of the apply are read from the job as sent and normalized
                // again, so the marks of what the kernel inserted (SentJob) are on them and every pointer of the answer, the
                // base's, the apply's and the Verify's too, is one of the job as sent.
                var preflightOps = CollectOps(job.DeepClone(), jobDirectory, null);
                // The prototype import is turned off (PrototypeImport): ONE refusal before the base, a producer or the apply.
                if (PrototypeImport.Refusal(preflightOps, JobPreflight.OpsPointer(job)) is { } disabled) throw disabled;
                var preflight = JobPreflight.Analyze(preflightOps, job, null, jobPath);
                var expectedValid = job is JsonObject obj && obj["expectValid"] is JsonValue ev && ev.TryGetValue<bool>(out var valid) ? valid : true;
                var autoPatch = JobPreflight.AutoPatch.Value != false && !(job is JsonObject flags && flags["autoPatch"] is JsonValue flag && flag.TryGetValue<bool>(out var enabled) && !enabled);
                using var inheritedPolicy = JobPreflight.UseAutoPatch(autoPatch);
                string resolvedBase; JsonArray ops;
                try
                {
                    resolvedBase = basePath == null ? Base(jobPath) : Path.GetFullPath(basePath);
                    ops = CollectOps(job, jobDirectory, log,
                        (spec, dir, index, role) =>
                        {
                            try { return Resolve(spec, dir, role); }
                            catch (Exception ex) { throw new InvalidOperationException($"op #{index} (reference): {Errors.Text(ex)}", ex); }
                        }, new HashSet<string>(StringComparer.OrdinalIgnoreCase) { jobPath });
                }
                catch (Exception ex) when (preflight["valid"]?.GetValue<bool>() == false)
                {
                    try { JobPreflight.RequireValid(preflight, $"the base or a producer of the job could not be loaded ({Errors.Text(ex)}): only the job was read, so the base check, the apply and the Verify did not run"); }
                    catch (JobPreflightException rootRefusal)
                    {
                        if (Errors.FindCoded(ex)?.Problems is { } sourceProblems)
                            foreach (var problem in sourceProblems) rootRefusal.Problems.Add(problem!.DeepClone());
                        if (Errors.Diagnosis(ex) is { } sourceDiagnosis) rootRefusal.Data[Errors.DiagnosisKey] = sourceDiagnosis;
                        throw;
                    }
                    throw;
                }
                try
                {
                    sentJob = AutoPatchSource(sentJob, ops, resolvedBase);
                    var result = ApplyResolved(host, resolvedBase, ops, outPath, log, expected, expectedValid, preflight,
                        builtBase: built.ContainsValue(resolvedBase), opsPointer: JobPreflight.OpsPointer(job), notes: expectations.Notes, autoPatch: autoPatch, sentJob: sentJob, sourceDirectory: jobDirectory);
                    if (sourceBuilds.Count == sourceStart) return result;
                    var answer = System.Text.Json.JsonSerializer.SerializeToNode(result)!.AsObject();
                    answer["sourceBuilds"] = new JsonArray(sourceBuilds.Skip(sourceStart).Select(s => (JsonNode)s.DeepClone()).ToArray());
                    return answer;
                }
                // A later phase that stops without the union (a base file that does not load, a frozen producer signature
                // without an element the job names) never hides the preflight's problems: they are refused, with the reason.
                catch (Exception ex) when (preflight["valid"]?.GetValue<bool>() == false && ex is not JobPreflightException)
                {
                    JobPreflight.RequireValid(preflight, $"the base check, the apply and the Verify stopped before the refusal ({Errors.Text(ex)}): only the job was read");
                    throw;
                }
            }
            catch (Exception error)
            {
                if (sourceBuilds.Count > sourceStart)
                {
                    var diagnosis = Errors.Diagnosis(error) ?? new JsonObject();
                    diagnosis["sourceBuilds"] = new JsonArray(sourceBuilds.Skip(sourceStart).Select(s => (JsonNode)s.DeepClone()).ToArray());
                    error.Data[Errors.DiagnosisKey] = diagnosis;
                }
                throw;
            }
            finally { active.RemoveAt(active.Count - 1); }
        }
    }
}
