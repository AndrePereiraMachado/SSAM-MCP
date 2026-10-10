using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core.Delivery;

namespace Anvil.Core.Access;

/// <summary>
/// `anvil access plan|apply|verify` (the O11 lane of `ssam access`). Plan is offline and needs no words: it reads the roles
/// of the current OMLs, validates the manifest, writes one job per owner module and proves each with check-job and apply.
/// Apply needs the user's words; it never publishes. Its mode is ApplyRequest.Execute alone (the CLI flag --execute, parsed
/// strictly by AccessArguments; the words can never set it). Without it, apply only prepares the delivery requests and the
/// receipt; with it, apply runs the ordinary `deliver` per owner module, in order, and never replays an uncertain one. Each
/// prepared delivery is an argv with --expected-environment (the manifest environment), --port and --work, so the printed
/// command and --execute build the same request and both stop on a Studio connected to another environment; --execute
/// runs on that port and store, and refuses when its own --port / --deliver-work (explicit or default) name others.
/// Receipts hold hashes only: manifestSha256, wordsSha256, job hashes, username hashes and the sha256 of each demo
/// allowlist the plan derived "demo" from, never usernames or words.
/// </summary>
public static class AccessCommand
{
    public const string PlanSchema = "ssam-access-plan/1", ApplySchema = "ssam-access-apply/1", LedgerSchema = "ssam-access-ledger/1";
    private static readonly JsonSerializerOptions Indented = new() { WriteIndented = true };

    public sealed record PlanRequest(string ManifestPath, string WorkDirectory, IReadOnlyDictionary<string, string> ModuleBases,
        IReadOnlyDictionary<string, string> Producers, bool CreateAccounts, bool CreateActive);

    public sealed record ApplyRequest(string ManifestPath, string WorkDirectory, string? Words, string? PlanPath, string? OperationId,
        bool Execute, string DeliverWorkDirectory, int BridgePort, string CliLine);

    public static JsonObject Plan(PlanRequest request, Func<string, ModelHost> hostFor, Action<string>? log = null)
    {
        var clock = System.Diagnostics.Stopwatch.StartNew();
        AccessManifest manifest;
        try { manifest = AccessManifest.Read(request.ManifestPath); }
        catch (AccessManifestException ex) { return Refused("manifest", ex.Errors, []); }
        if (request.CreateActive && !request.CreateAccounts) return Refused("options", ["--create-active requires --create-accounts"], []);
        var work = Path.GetFullPath(request.WorkDirectory);
        var bases = new Dictionary<string, string>(manifest.Bases, StringComparer.OrdinalIgnoreCase);
        foreach (var (module, path) in request.ModuleBases) bases[module] = Path.GetFullPath(path);
        var missing = manifest.Modules.Where(m => !bases.ContainsKey(m) && !AccessPlanner.IsDeniedModule(m)).ToList();
        if (missing.Count > 0)
            return Refused("bases", missing.Select(m => $"no base for module {m}: add \"bases\": {{\"{m}\": \"<current OML>\"}} to the manifest or pass --module-base {m}=<oml>").ToList(), []);

        var host = hostFor(Path.Combine(work, "model"));
        var facts = new Dictionary<string, AccessModuleFacts>(StringComparer.OrdinalIgnoreCase);
        var errors = new List<string>();
        foreach (var (module, path) in bases.OrderBy(b => b.Key, StringComparer.OrdinalIgnoreCase))
        {
            if (!File.Exists(path)) { errors.Add($"base of {module} not found: {path}"); continue; }
            var read = AccessBaseReader.Read(host, path);
            if (!string.Equals(read.Module, module, StringComparison.OrdinalIgnoreCase)) { errors.Add($"base {path} is module {read.Module}, not {module}"); continue; }
            facts[module] = read;
            log?.Invoke($"access: {module} base v{read.BaseVersion?.ToString() ?? "?"} roles [{string.Join(", ", read.Roles.Select(r => r.Name))}]"
                + $" demo allowlists [{string.Join(", ", read.DemoAllowlists.Select(a => a.Key + ":" + (a.Value == null ? "unreadable" : $"{a.Value.Count} sha256 {AccessBaseReader.AllowlistSha256(a.Value)[..12]}")))}]"
                + (read.Marker != null ? $" carries manifestVersion {read.Marker.ManifestVersion}" : ""));
        }
        if (errors.Count > 0) return Refused("bases", errors, []);

        var producers = request.Producers.ToDictionary(p => p.Key, p => Path.GetFullPath(p.Value), StringComparer.OrdinalIgnoreCase);
        var options = new AccessPlanOptions(request.CreateAccounts, request.CreateActive, producers.ContainsKey("Users"));
        var ledger = ReadLedger(work, manifest.Environment);
        var plan = AccessPlanner.Plan(manifest, facts, options, ledger);
        if (!plan.Ok) return Refused("validation", plan.Errors, plan.Warnings);

        var folder = Path.Combine(work, "plans", $"v{manifest.ManifestVersion}-{manifest.Sha256[..12]}" + (request.CreateAccounts ? "-accounts" : ""));
        Directory.CreateDirectory(folder);
        File.WriteAllText(Path.Combine(folder, "manifest.canonical.json"), manifest.Canonical);
        var modules = new JsonArray(); var ok = true;
        foreach (var module in plan.Modules)
        {
            var fact = facts[module.Module];
            var entry = new JsonObject
            {
                ["module"] = module.Module, ["status"] = module.Status, ["mode"] = module.Mode, ["moduleDigest"] = module.ModuleDigest,
                ["base"] = new JsonObject { ["path"] = fact.BasePath, ["sha256"] = fact.BaseSha256, ["version"] = fact.BaseVersion },
                ["roles"] = new JsonArray(module.Roles.Select(r => (JsonNode)r).ToArray()),
                // where "demo" came from: the allowlists of the owner module, by count and normalized sha256 (never the names)
                ["demoAllowlists"] = DemoAllowlists(fact),
                ["counts"] = new JsonObject { ["grants"] = module.Grants, ["revokes"] = module.Revokes, ["creates"] = module.Creates },
                ["checks"] = new JsonArray(module.Checks.Select(c => (JsonNode)c).ToArray()),
            };
            modules.Add(entry);
            if (module.Job == null) continue;
            var jobPath = Path.Combine(folder, module.Module + "-access.json");
            File.WriteAllText(jobPath, module.Job.ToJsonString(Indented));
            var jobSha = DeliveryReceipt.Hash(jobPath);
            var jobProducers = module.NeedsUsersProducer ? new Dictionary<string, string> { ["Users"] = producers["Users"] } : new Dictionary<string, string>();
            entry["job"] = new JsonObject { ["path"] = jobPath, ["sha256"] = jobSha, ["ops"] = module.Job["ops"]!.AsArray().Count };
            entry["producers"] = new JsonObject(jobProducers.Select(p => KeyValuePair.Create(p.Key,
                (JsonNode?)new JsonObject { ["path"] = p.Value, ["sha256"] = DeliveryReceipt.Hash(p.Value) })));
            entry["safety"] = Safety(module.Job);

            var check = JobPreflight.Check(jobPath);
            entry["checkJob"] = new JsonObject { ["valid"] = check["valid"]!.DeepClone(), ["errors"] = check["errors"]!.DeepClone(),
                ["actions"] = check["actions"]!.DeepClone(), ["publicActions"] = check["publicActions"]!.DeepClone() };
            if (check["valid"]!.GetValue<bool>() != true) { ok = false; continue; }

            var outPath = Path.Combine(folder, module.Module + "-access.oml");
            log?.Invoke($"access: apply {module.Module} ({module.Mode}) over {Path.GetFileName(fact.BasePath)}");
            var applied = JsonSerializer.SerializeToNode(JobRunner.Run(host, fact.BasePath, jobPath, outPath, log, jobProducers))!.AsObject();
            File.WriteAllText(Path.Combine(folder, module.Module + "-access.result.json"), applied.ToJsonString(Indented));
            var newMessages = applied["validation"]?["new"]?.AsArray().Count ?? -1;
            entry["apply"] = new JsonObject
            {
                ["accepted"] = applied["accepted"]!.DeepClone(), ["isValid"] = applied["isValid"]!.DeepClone(),
                ["newMessages"] = newMessages, ["moduleMessages"] = applied["messages"]!.DeepClone(), ["ops"] = applied["ops"]!.DeepClone(),
                ["objects"] = applied["objects"]!.DeepClone(), ["out"] = outPath, ["outSha256"] = DeliveryReceipt.Hash(outPath),
                ["totalMs"] = applied["timings"]?["totalMs"]?.DeepClone(), ["details"] = applied["details"]!.DeepClone(),
            };
            if (applied["accepted"]!.GetValue<bool>() != true || applied["isValid"]!.GetValue<bool>() != true || newMessages != 0) ok = false;
        }

        var receipt = new JsonObject
        {
            ["schema"] = PlanSchema, ["ok"] = ok, ["createdAtUtc"] = DateTime.UtcNow.ToString("O"),
            ["manifest"] = new JsonObject
            {
                ["path"] = manifest.Path, ["sha256"] = manifest.Sha256, ["manifestVersion"] = manifest.ManifestVersion,
                ["environment"] = manifest.Environment, ["entries"] = manifest.Entries.Count,
            },
            ["options"] = new JsonObject { ["createAccounts"] = request.CreateAccounts, ["createActive"] = request.CreateActive },
            ["modules"] = modules,
            ["users"] = new JsonArray(manifest.Entries.GroupBy(e => e.Username, StringComparer.OrdinalIgnoreCase).Select(g => (JsonNode)new JsonObject
            {
                ["hash"] = AccessManifest.UsernameHash(manifest.Environment, g.Key), ["demo"] = g.First().Demo,
                ["grants"] = g.Count(e => e.Grant), ["revokes"] = g.Count(e => !e.Grant), ["createIfMissing"] = g.Any(e => e.CreateIfMissing),
            }).ToArray()),
            ["warnings"] = new JsonArray(plan.Warnings.Select(w => (JsonNode)w).ToArray()),
            ["errors"] = new JsonArray(),
            ["names"] = "no username in clear: users appear only as hashes (sha256 of environment and username, 16 hex)",
            ["demoAllowlistSha256"] = AccessBaseReader.AllowlistNormalization,
            ["elapsedMs"] = clock.ElapsedMilliseconds,
        };
        var planPath = Path.Combine(folder, "plan.json");
        File.WriteAllText(planPath, receipt.ToJsonString(Indented));
        receipt["planPath"] = planPath; receipt["planSha256"] = DeliveryReceipt.Hash(planPath);
        return receipt;
    }

    /// <summary>The allowlists the plan derived "demo" from, per site property: readable or not, how many names and the sha256
    /// of the normalized list (AccessBaseReader.AllowlistSha256). The same block goes to the apply receipt.</summary>
    private static JsonObject DemoAllowlists(AccessModuleFacts fact)
        => new(fact.DemoAllowlists.OrderBy(a => a.Key, StringComparer.Ordinal).Select(a => KeyValuePair.Create(a.Key, (JsonNode?)(a.Value == null
            ? new JsonObject { ["readable"] = false }
            : new JsonObject { ["readable"] = true, ["count"] = a.Value.Count, ["sha256"] = AccessBaseReader.AllowlistSha256(a.Value) }))));

    /// <summary>What a reviewer checks first: no public action, no UserManager, no password literal.</summary>
    public static JsonObject Safety(JsonObject job)
    {
        var text = job.ToJsonString();
        var actions = job["ops"]!.AsArray().OfType<JsonObject>().Where(o => o["op"]?.ToString() == "logic")
            .SelectMany(o => o["data"]!["actions"]!.AsArray().OfType<JsonObject>()).ToList();
        var literalPasswords = 0;
        void Walk(JsonNode? node)
        {
            switch (node)
            {
                case JsonObject o:
                    foreach (var (key, value) in o)
                    {
                        if ((key.EndsWith(".Password", StringComparison.OrdinalIgnoreCase) || key == "Password") && value is JsonValue v
                            && v.TryGetValue<string>(out var s) && s.TrimStart().StartsWith('"')) literalPasswords++;
                        Walk(value);
                    }
                    break;
                case JsonArray a: foreach (var item in a) Walk(item); break;
            }
        }
        Walk(job);
        return new JsonObject
        {
            ["publicActions"] = actions.Count(a => a["public"]?.GetValue<bool>() == true),
            ["userManagerMentions"] = CountOf(text, "UserManager"),
            ["passwordLiterals"] = literalPasswords,
            ["timers"] = job["ops"]!.AsArray().OfType<JsonObject>().Count(o => o["type"]?.ToString() == "ITimer"),
        };
    }

    private static int CountOf(string text, string word)
    {
        var count = 0; var at = 0;
        while ((at = text.IndexOf(word, at, StringComparison.OrdinalIgnoreCase)) >= 0) { count++; at += word.Length; }
        return count;
    }

    public static JsonObject Apply(ApplyRequest request, Func<DeliveryRequest, JsonObject>? deliver, Action<string>? log = null)
    {
        AccessManifest manifest;
        try { manifest = AccessManifest.Read(request.ManifestPath); }
        catch (AccessManifestException ex) { return Refused("manifest", ex.Errors, []); }
        var words = request.Words?.Trim();
        if (string.IsNullOrEmpty(words))
            return Refused("words", ["apply requires the user's authorization words (--words \"...\"); only their SHA-256 is recorded"], []);
        var work = Path.GetFullPath(request.WorkDirectory);
        var planPath = request.PlanPath != null ? Path.GetFullPath(request.PlanPath) : FindPlan(work, manifest);
        if (planPath == null)
            return Refused("plan", [$"no successful plan for this manifest (sha256 {manifest.Sha256[..12]}) under {Path.Combine(work, "plans")}; run access plan first"], []);
        var plan = ReadPlain(planPath);
        if (plan["schema"]?.ToString() != PlanSchema || plan["ok"]?.GetValue<bool>() != true)
            return Refused("plan", ["the plan " + planPath + " did not succeed; fix it and plan again"], []);
        if (plan["manifest"]?["sha256"]?.ToString() != manifest.Sha256)
            return Refused("plan", ["the manifest changed after the plan (sha256 differs); plan again"], []);
        var changed = new List<string>();
        foreach (var module in plan["modules"]!.AsArray().OfType<JsonObject>())
        {
            if (module["job"]?["path"]?.ToString() is not { } job) continue;
            if (!File.Exists(job) || DeliveryReceipt.Hash(job) != module["job"]!["sha256"]!.ToString()) changed.Add(job);
            foreach (var (_, producer) in module["producers"]?.AsObject() ?? new JsonObject())
                if (producer?["path"]?.ToString() is { } p && (!File.Exists(p) || DeliveryReceipt.Hash(p) != producer["sha256"]!.ToString())) changed.Add(p);
        }
        if (changed.Count > 0) return Refused("plan", changed.Select(c => "planned file changed or missing: " + c).ToList(), []);

        var operationId = request.OperationId ?? Guid.NewGuid().ToString("N");
        if (!Guid.TryParseExact(operationId, "N", out _)) return Refused("operation", ["--operation-id must be 32 hex characters (Guid N)"], []);
        var wordsSha = AccessManifest.Hash(words);
        var planSha = DeliveryReceipt.Hash(planPath);
        var receiptPath = Path.Combine(work, "applies", operationId + ".json");
        Directory.CreateDirectory(Path.GetDirectoryName(receiptPath)!);
        using var lease = DurableJson.Lease(receiptPath + ".lock");
        JsonObject receipt;
        if (File.Exists(receiptPath))
        {
            receipt = DurableJson.Read(receiptPath);
            if (receipt["manifestSha256"]?.ToString() != manifest.Sha256 || receipt["wordsSha256"]?.ToString() != wordsSha || receipt["planSha256"]?.ToString() != planSha)
                return Refused("operation", [$"operation {operationId} belongs to another manifest, plan or authorization; use a new operation id"], []);
            if (!request.Execute || receipt["status"]?.ToString() != "prepared")
            {
                receipt["replayed"] = false;
                receipt["note"] = "operation already recorded; returned its receipt without repeating any delivery";
                return Result(receipt, receiptPath, request.Execute);
            }
        }
        else
        {
            var deliveries = new JsonArray();
            var deliverWork = Path.GetFullPath(request.DeliverWorkDirectory);
            foreach (var module in plan["modules"]!.AsArray().OfType<JsonObject>().Where(m => m["status"]?.ToString() == "changes"))
            {
                var name = module["module"]!.ToString(); var job = module["job"]!["path"]!.ToString();
                var checks = string.Join(",", module["checks"]!.AsArray().Select(c => c!.ToString()));
                // The prepared delivery is this argv: the printed command and --execute build the same request from it
                // (DeliverArguments.ForJob), so both carry the environment attestation of the manifest.
                var argv = new List<string> { "deliver", "--module", name, "--job", job, "--checks", checks };
                foreach (var (binding, producer) in module["producers"]?.AsObject() ?? new JsonObject())
                    argv.AddRange(["--producer", $"{binding}={producer!["path"]}"]);
                argv.AddRange(["--expected-environment", manifest.Environment, "--port", request.BridgePort.ToString(), "--work", deliverWork]);
                deliveries.Add(new JsonObject
                {
                    ["module"] = name, ["job"] = job, ["jobSha256"] = module["job"]!["sha256"]!.DeepClone(), ["checks"] = checks,
                    ["producers"] = module["producers"]?.DeepClone() ?? new JsonObject(), ["expectedEnvironment"] = manifest.Environment,
                    ["argv"] = new JsonArray(argv.Select(a => (JsonNode)a).ToArray()),
                    ["command"] = request.CliLine + " " + string.Join(" ", argv.Select(Quote)),
                    ["status"] = "prepared",
                });
            }
            receipt = new JsonObject
            {
                ["schema"] = ApplySchema, ["operationId"] = operationId, ["createdAtUtc"] = DateTime.UtcNow.ToString("O"),
                ["environment"] = manifest.Environment, ["manifestVersion"] = manifest.ManifestVersion,
                ["manifestSha256"] = manifest.Sha256, ["wordsSha256"] = wordsSha, ["planPath"] = planPath, ["planSha256"] = planSha,
                ["modules"] = new JsonArray(plan["modules"]!.AsArray().OfType<JsonObject>().Select(m => (JsonNode)new JsonObject
                {
                    ["module"] = m["module"]!.DeepClone(), ["status"] = m["status"]!.DeepClone(), ["mode"] = m["mode"]!.DeepClone(),
                    ["baseVersion"] = m["base"]?["version"]?.DeepClone(), ["baseSha256"] = m["base"]?["sha256"]?.DeepClone(),
                    ["moduleDigest"] = m["moduleDigest"]!.DeepClone(), ["jobSha256"] = m["job"]?["sha256"]?.DeepClone(), ["counts"] = m["counts"]!.DeepClone(),
                    ["demoAllowlists"] = m["demoAllowlists"]?.DeepClone(),
                }).ToArray()),
                ["counts"] = new JsonObject
                {
                    ["modules"] = plan["modules"]!.AsArray().Count, ["deliveries"] = deliveries.Count,
                    ["grants"] = plan["modules"]!.AsArray().Sum(m => m!["counts"]!["grants"]!.GetValue<int>()),
                    ["revokes"] = plan["modules"]!.AsArray().Sum(m => m!["counts"]!["revokes"]!.GetValue<int>()),
                    ["creates"] = plan["modules"]!.AsArray().Sum(m => m!["counts"]!["creates"]!.GetValue<int>()),
                },
                ["users"] = plan["users"]?.DeepClone(),
                ["environmentAttestation"] = new JsonObject
                {
                    ["expected"] = manifest.Environment, ["source"] = "manifest environment, covered by manifestSha256 and the words",
                    ["enforcedBy"] = "deliver --expected-environment (in every prepared command and in --execute): the delivery stops before any snapshot or merge when the selected Studio is connected to another environment",
                },
                ["demoAllowlistSha256"] = AccessBaseReader.AllowlistNormalization,
                ["deliveries"] = deliveries,
                ["status"] = deliveries.Count == 0 ? "unchanged" : "prepared",
                ["publication"] = "not performed: publication follows the integrator/user policy (O11: the user publishes in Service Studio, 1-Click); the timer AccessReconcileOnPublish applies the manifest after it, AccessReconcileOnDemand re-applies it from Service Center Run Now",
                ["names"] = "no username and no words in clear; only hashes",
            };
            SaveReceipt(receiptPath, receipt);
            log?.Invoke($"access: operation {operationId} prepared {deliveries.Count} delivery request(s)");
        }
        if (!request.Execute || receipt["status"]?.ToString() != "prepared") return Result(receipt, receiptPath, request.Execute);
        if (deliver == null) return Refused("execute", ["no delivery runtime available"], []);
        // Every request is built before the first one runs: a receipt without the attested argv refuses as a whole.
        // The prepared argv also fixes the Studio lane (--port) and the delivery store (--work): the task is registered there
        // and a later `deliver --resume` must name both, so this call runs on them or not at all (never a split between the
        // Studio contacted and the port recorded in task.json).
        var requests = new List<DeliveryRequest>();
        var callStore = Path.GetFullPath(request.DeliverWorkDirectory);
        foreach (var delivery in receipt["deliveries"]!.AsArray().OfType<JsonObject>())
        {
            DeliveryRequest built;
            try { built = DeliveryRequestOf(delivery); }
            catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or IOException) { return Refused("execute", [ex.Message], []); }
            if (!string.Equals(built.ExpectedEnvironment, manifest.Environment, StringComparison.OrdinalIgnoreCase))
                return Refused("execute", [$"the prepared delivery of {delivery["module"]} does not attest the manifest environment; prepare again with a new operation id"], []);
            var lane = new List<string>();
            if (built.BridgePort != request.BridgePort) lane.Add($"Studio port {built.BridgePort} (this call: {request.BridgePort})");
            if (!string.Equals(Path.GetFullPath(built.WorkDirectory), callStore, StringComparison.OrdinalIgnoreCase))
                lane.Add($"delivery store {built.WorkDirectory} (this call: {callStore})");
            if (lane.Count > 0)
                return Refused("execute", [$"the delivery of {delivery["module"]} was prepared for {string.Join(" and ", lane)}; nothing was sent. "
                    + $"Run --execute with --port {built.BridgePort} --deliver-work {Quote(built.WorkDirectory)}, the lane and store it was prepared for"], []);
            requests.Add(built);
        }

        receipt["status"] = "executing"; SaveReceipt(receiptPath, receipt);
        var failed = false;
        foreach (var (delivery, deliveryRequest) in receipt["deliveries"]!.AsArray().OfType<JsonObject>().Zip(requests))
        {
            if (failed) { delivery["status"] = "not-started"; continue; }
            delivery["status"] = "delivering"; delivery["startedAtUtc"] = DateTime.UtcNow.ToString("O");
            SaveReceipt(receiptPath, receipt);
            JsonObject result;
            try { result = deliver(deliveryRequest); }
            catch (Exception ex)
            {
                // the task lives in the store and lane of the prepared argv (the same ones this call ran on)
                var resume = $"{request.CliLine} deliver --resume <taskId> --work {Quote(deliveryRequest.WorkDirectory)} --port {deliveryRequest.BridgePort}";
                delivery["status"] = "uncertain"; delivery["error"] = Errors.Text(ex);
                delivery["resumeCommand"] = resume;
                delivery["hint"] = "the delivery outcome is unknown; inspect " + Path.Combine(deliveryRequest.WorkDirectory, "deliver")
                    + $" for the task of {delivery["module"]} and resume it with: {resume}; never repeat it";
                failed = true; SaveReceipt(receiptPath, receipt); continue;
            }
            var delivered = result["delivered"]?.GetValue<bool>() == true;
            // What the Studio reported, next to what the manifest expected: the attestation of this delivery.
            var attested = string.Equals(result["environment"]?.ToString(), manifest.Environment, StringComparison.OrdinalIgnoreCase);
            delivery["taskId"] = result["taskId"]?.DeepClone();
            delivery["delivered"] = delivered;
            delivery["environment"] = result["environment"]?.DeepClone();
            delivery["environmentAttested"] = attested;
            delivery["unchanged"] = result["unchanged"]?.DeepClone();
            delivery["writeState"] = result["writeState"]?.DeepClone();
            delivery["resultPath"] = result["work"] is { } taskWork ? Path.Combine(taskWork.ToString(), "result.json") : null;
            delivery["error"] = result["error"]?.DeepClone();
            delivery["status"] = delivered ? attested ? "delivered" : "delivered-unattested" : "failed";
            if (delivered && !attested)
            {
                delivery["error"] = $"the delivery result does not attest environment {manifest.Environment}; inspect {delivery["resultPath"]} before anything else";
                delivered = false;
            }
            if (delivered)
            {
                var module = receipt["modules"]!.AsArray().OfType<JsonObject>().First(m => m["module"]!.ToString() == delivery["module"]!.ToString());
                WriteLedger(work, manifest.Environment, module["module"]!.ToString(), manifest.ManifestVersion, module["moduleDigest"]!.ToString(), operationId);
            }
            else failed = true;
            SaveReceipt(receiptPath, receipt);
        }
        receipt["status"] = failed ? "failed" : "delivered";
        receipt["finishedAtUtc"] = DateTime.UtcNow.ToString("O");
        SaveReceipt(receiptPath, receipt);
        return Result(receipt, receiptPath, true);
    }

    /// <summary>The request of one prepared delivery, parsed from its recorded argv by the same code as `anvil deliver`.</summary>
    public static DeliveryRequest DeliveryRequestOf(JsonObject delivery)
    {
        if (delivery["argv"] is not JsonArray argv || argv.Count == 0 || argv[0]?.ToString() != "deliver")
            throw new InvalidOperationException("the prepared delivery of " + delivery["module"] + " has no deliver argv (prepared by an older version); prepare again with a new operation id");
        var args = argv.Select(a => a!.ToString()).ToList();
        var work = DeliverArguments.Option(args, "--work") ?? throw new InvalidOperationException("the prepared delivery has no --work");
        var port = int.TryParse(DeliverArguments.Option(args, "--port"), out var p) ? p : throw new InvalidOperationException("the prepared delivery has no --port");
        return DeliverArguments.ForJob(args, Path.GetFullPath(work), port);
    }

    private static string Quote(string arg) => arg.Length > 0 && !arg.Any(c => char.IsWhiteSpace(c) || c == '"') ? arg : "\"" + arg.Replace("\"", "\\\"") + "\"";

    /// <summary>The receipt as returned: which mode this call ran in, stated explicitly.</summary>
    private static JsonObject Result(JsonObject receipt, string path, bool execute)
    {
        var copy = WithPath(receipt, path);
        copy["mode"] = execute ? "execute" : "prepare";
        if (!execute && receipt["status"]?.ToString() == "prepared")
            copy["execution"] = "not performed (prepare only): the integrator runs each deliveries[].command, or `access apply ... --execute` from the CLI";
        return copy;
    }

    public static JsonObject Verify() => new()
    {
        ["ok"] = false, ["implemented"] = false, ["phase"] = 2,
        ["reason"] = "not implemented (phase 2): read-only GET with HMAC returning UserId and one boolean per role. Today the user checks the role in the Users application, and AccessAudit (View Data in Service Studio) shows each decision.",
    };

    /// <summary>The checksummed receipt is the checkpoint; the indented copy beside it is for people and is never read back.</summary>
    private static void SaveReceipt(string path, JsonObject receipt)
    {
        DurableJson.Write(path, receipt);
        DurableJson.WriteBytes(Path.ChangeExtension(path, ".readable.json"), System.Text.Encoding.UTF8.GetBytes(receipt.ToJsonString(Indented)));
    }

    private static JsonObject WithPath(JsonObject receipt, string path)
    {
        var copy = receipt.DeepClone().AsObject();
        copy["ok"] = copy["status"]?.ToString() is "prepared" or "delivered" or "unchanged";
        copy["receiptPath"] = path; copy["receiptSha256"] = DeliveryReceipt.Hash(path);
        copy["receiptReadable"] = Path.ChangeExtension(path, ".readable.json");
        return copy;
    }

    private static JsonObject ReadPlain(string path)
        => JsonNode.Parse(File.ReadAllText(path)) as JsonObject ?? throw new InvalidDataException("not a JSON object: " + path);

    private static string? FindPlan(string work, AccessManifest manifest)
    {
        var root = Path.Combine(work, "plans");
        if (!Directory.Exists(root)) return null;
        var candidates = Directory.GetDirectories(root, $"v{manifest.ManifestVersion}-{manifest.Sha256[..12]}*")
            .Select(d => Path.Combine(d, "plan.json")).Where(File.Exists)
            .Where(p => { try { var j = ReadPlain(p); return j["ok"]?.GetValue<bool>() == true && j["manifest"]?["sha256"]?.ToString() == manifest.Sha256; } catch { return false; } })
            .ToList();
        return candidates.Count switch
        {
            1 => candidates[0],
            0 => null,
            _ => throw new ArgumentException("more than one successful plan for this manifest (with and without --create-accounts); pass --plan <plan.json>"),
        };
    }

    public static Dictionary<string, AccessLedgerEntry> ReadLedger(string work, string environment)
    {
        var path = Path.Combine(work, "ledger.json");
        var result = new Dictionary<string, AccessLedgerEntry>(StringComparer.OrdinalIgnoreCase);
        if (!File.Exists(path)) return result;
        var ledger = DurableJson.Read(path);
        foreach (var (module, value) in ledger["environments"]?[environment]?.AsObject() ?? new JsonObject())
            if (value is JsonObject v)
                result[module] = new AccessLedgerEntry(v["manifestVersion"]!.GetValue<int>(), v["moduleDigest"]!.ToString(), v["operationId"]!.ToString());
        return result;
    }

    private static void WriteLedger(string work, string environment, string module, int version, string digest, string operationId)
    {
        var path = Path.Combine(work, "ledger.json");
        var ledger = File.Exists(path) ? DurableJson.Read(path) : new JsonObject { ["schema"] = LedgerSchema, ["environments"] = new JsonObject() };
        var environments = ledger["environments"]!.AsObject();
        if (environments[environment] is not JsonObject modules) environments[environment] = modules = new JsonObject();
        modules[module] = new JsonObject
        {
            ["manifestVersion"] = version, ["moduleDigest"] = digest, ["operationId"] = operationId, ["deliveredAtUtc"] = DateTime.UtcNow.ToString("O"),
        };
        DurableJson.Write(path, ledger);
    }

    private static JsonObject Refused(string stage, IReadOnlyList<string> errors, IReadOnlyList<string> warnings) => new()
    {
        ["ok"] = false, ["stage"] = stage,
        ["errors"] = new JsonArray(errors.Select(e => (JsonNode)e).ToArray()),
        ["warnings"] = new JsonArray(warnings.Select(w => (JsonNode)w).ToArray()),
    };
}
