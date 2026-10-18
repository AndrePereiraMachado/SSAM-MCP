using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// fix-ext-refs (2026-10-16, owner: this must never happen): a consumer delivery that needs NEW elements
/// of a producer adds them in ONE delivery, whatever the producer kind (eSpace module, Extension .xif, system). The shape of
/// the incident with synthetic values: consumer ZZ_Report_CS references the extension ZZ_Report_Ext at its old signature
/// with GeneratePowerPoint and ReportSlide; the extension gained GenerateTemplatePowerPoint and TemplateSection and its
/// published signature moved. The Studio's Refresh References answered "up to date" (it only refreshes what the module
/// already references), the candidate carried the published signature, and the live merge had to select it (the path that
/// failed with "No command is open"). Now the delivery runs the Studio's own Manage Dependencies on the live module first
/// (refresh_references with add + published, capability refresh_references:add): the module gets the elements at the
/// published signature in one Studio command, the candidate changes no producer signature, and the merge is the plain
/// native one. Fake bridge, fake producer authority and fake reference reader: nothing live, no Studio.
/// </summary>
public sealed class ExtensionReferenceDeliveryTests
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(ExtensionReferenceDeliveryTests).Assembly.Location)!)!;
    private const string Consumer = "ZZ_Report_CS";
    private const string Producer = "ZZ_Report_Ext";
    private const string ExtKey = "ZZextRptKeyAAAAAAAAAAw";
    private const string OldHash = "11111111-aaaa-4bbb-8ccc-000000000001";
    private const string NewHash = "22222222-aaaa-4bbb-8ccc-000000000002";
    private static readonly string[] JobElements = ["IServerActionSignature:GenerateTemplatePowerPoint", "IStructureSignature:TemplateSection",
        "IServerActionSignature:GeneratePowerPoint", "IStructureSignature:ReportSlide"];

    public ExtensionReferenceDeliveryTests() => StudioAssemblies.Bind();

    private static ModuleReferenceEntry Ext(string hash, bool withNew, string kind = "Extension") => new(Producer, ExtKey, kind, hash,
        (withNew
            ? new[] { ("GeneratePowerPoint", "ReferenceAction", "kGen"), ("ReportSlide", "ReferenceStructure", "kSlide"),
                ("GenerateTemplatePowerPoint", "ReferenceAction", "kTpl"), ("TemplateSection", "ReferenceStructure", "kSec") }
            : new[] { ("GeneratePowerPoint", "ReferenceAction", "kGen"), ("ReportSlide", "ReferenceStructure", "kSlide") })
        .Select(e => new ReferencedExport(e.Item1, e.Item2, e.Item3)).ToArray());

    /// <summary>The live module: its references move only when the Studio's Manage Dependencies runs on it (add + published).</summary>
    private sealed class Studio(string kind = "Extension")
    {
        public string Kind => kind;
        public bool Aligned;
        public IReadOnlyList<ModuleReferenceEntry> Live => [Aligned ? Ext(NewHash, withNew: true, kind) : Ext(OldHash, withNew: false, kind)];
        public IReadOnlyList<ModuleReferenceEntry> Candidate => [Ext(NewHash, withNew: true, kind)];
        public List<string> Reads { get; } = [];
        public JsonArray Read(string path)
        {
            var name = Path.GetFileName(path);
            Reads.Add(name);
            var inventory = name == "foreign.oml" || name.StartsWith("delivered-", StringComparison.Ordinal) ? Candidate : Live;
            return ReferenceClosure.ToJson(inventory);
        }
    }

    private sealed class Stub(Studio studio) : IBridgeClient
    {
        public List<string> Calls { get; } = [];
        public string[] Capabilities { get; init; } = ["refresh_references", "refresh_references:add"];
        public List<JsonObject> Refreshes { get; } = [];
        public List<JsonObject> Merges { get; } = [];
        /// <summary>The Studio's answer to a Manage Dependencies (add) request; by default it adds and aligns.</summary>
        public Func<JsonObject, JsonObject>? ManageAnswer { get; init; }
        /// <summary>The Studio's answer to the merge; by default it merges when the module is aligned and rolls back otherwise.</summary>
        public Func<JsonObject, JsonObject>? MergeAnswer { get; init; }
        /// <summary>The Studio's answer to the plain Refresh References; by default the reference is up to date.</summary>
        public Func<JsonObject, JsonObject>? RefreshAnswer { get; init; }
        /// <summary>The environment the Studio is connected to (a resumed task checks it against its frozen producer captures,
        /// whose fixture belongs to fixture.invalid).</summary>
        public string EnvironmentName { get; init; } = "lab.example";
        /// <summary>The Studio shows a modal "Sign in" (the CX14 idle reads see it).</summary>
        public bool DialogOpen { get; set; }
        /// <summary>The bridge's answer to open_module; by default the module is already open, with no dialog.</summary>
        public Func<JsonObject, JsonObject>? OpenAnswer { get; init; }
        public JsonObject Call(string method, JsonObject? parameters = null)
        {
            Calls.Add(method);
            switch (method)
            {
                case "open_module": return OpenAnswer?.Invoke(parameters!) ?? new() { ["name"] = Consumer, ["opened"] = true, ["alreadyOpen"] = true };
                case "get_active_module": return new() { ["name"] = Consumer, ["key"] = "consumer-key", ["environment"] = EnvironmentName };
                case "snapshot_module":
                    if (parameters?["path"] is { } path) File.WriteAllText(path.ToString(), "OML snapshot " + (studio.Aligned ? "aligned" : "old"));
                    return new() { ["key"] = "consumer-key", ["snapshot_id"] = "snapshot-1", ["baseline"] = new JsonArray() };
                case "bridge_manifest": return new() { ["capabilities"] = new JsonArray(Capabilities.Select(c => (JsonNode)JsonValue.Create(c)!).ToArray()) };
                case "refresh_references":
                    Refreshes.Add(parameters!.DeepClone().AsObject());
                    if (parameters!["add"] is JsonArray add && Capabilities.Contains("refresh_references:add"))
                    {
                        if (ManageAnswer != null) return ManageAnswer(parameters);
                        var asked = add.OfType<JsonObject>().SingleOrDefault(a => a["producer_key"]?.ToString() == ExtKey || a["producer"]?.ToString() == Producer);
                        if (asked != null && parameters["published"]?.GetValue<bool>() == true) studio.Aligned = true;
                        // The bridge's answer (RefreshReferencesHandler.Manage over ManageDependencies.Apply).
                        return new() { ["module"] = Consumer, ["command"] = "Manage Dependencies", ["committed"] = true, ["changed"] = studio.Aligned,
                            ["refreshed"] = new JsonArray(Producer), ["upToDate"] = new JsonArray(),
                            ["added"] = new JsonArray(new JsonObject { ["producer"] = Producer, ["element"] = "GenerateTemplatePowerPoint" }, new JsonObject { ["producer"] = Producer, ["element"] = "TemplateSection" }),
                            ["references"] = new JsonArray(new JsonObject { ["producer"] = Producer, ["key"] = ExtKey, ["kind"] = "Extension", ["hashBefore"] = OldHash, ["hashAfter"] = NewHash }),
                            ["undo"] = "Ctrl+Z in the Studio undoes the Manage Dependencies" };
                    }
                    if (RefreshAnswer != null) return RefreshAnswer(parameters);
                    // The Studio's Refresh References: the reference is up to date (nothing it references changed).
                    return new() { ["module"] = Consumer, ["changed"] = false, ["refreshed"] = new JsonArray(), ["upToDate"] = new JsonArray(Producer) };
                case "merge_from_oml":
                    Merges.Add(parameters!.DeepClone().AsObject());
                    if (MergeAnswer != null) return MergeAnswer(parameters);
                    if (!studio.Aligned)
                        // The live signature selection of the incident: rolled back at the structural merge.
                        return new() { ["operationId"] = parameters["operation_id"]!.DeepClone(), ["merged"] = false, ["reason"] = "rolled back", ["rolledBack"] = true,
                            ["proof"] = "sha256", ["liveSha256"] = "aa11", ["baseSha256"] = "aa11", ["stage"] = "structural-merge",
                            ["error"] = "InvalidOperationException: No command is open. The model cannot be changed outside the scope of a command!",
                            ["referenceSignatures"] = new JsonObject { ["Changes"] = new JsonArray(new JsonObject { ["ProducerKey"] = ExtKey, ["Kind"] = studio.Kind,
                                ["BaseHash"] = OldHash, ["LocalHash"] = OldHash, ["ForeignHash"] = NewHash }), ["HasChanges"] = true } };
                    return new() { ["operationId"] = parameters["operation_id"]!.DeepClone(), ["merged"] = true, ["undoSteps"] = 1, ["result"] = "Merge",
                        ["referenceSignatures"] = new JsonObject { ["Changes"] = new JsonArray(), ["HasChanges"] = false } };
                case "merge_status": return new() { ["operationId"] = parameters?["operation_id"]?.DeepClone(), ["state"] = "unknown" };
                case "get_errors": return new() { ["rawMessages"] = new JsonArray() };
                // The CX14 idle reads (DeliveryTask.InspectPendingUi) and the tab close.
                case "windows": return new() { ["windows"] = DialogOpen
                    ? new JsonArray(new JsonObject { ["type"] = "OutSystems.Studio.DialogWindow", ["title"] = "Sign in", ["isVisible"] = true, ["isModal"] = true, ["texts"] = new JsonArray("Sign in to lab.example to continue?") })
                    : new JsonArray() };
                case "ui_alive": return new() { ["alive"] = true };
                case "list_open_modules": return new() { ["modules"] = new JsonArray(new JsonObject { ["name"] = Consumer, ["key"] = "consumer-key", ["serverSilentMode"] = false, ["hasOpenedActiveESpace"] = true }) };
                case "close_module": return new() { ["closed"] = true };
                default: throw new Exception("Unexpected bridge call: " + method);
            }
        }
    }

    /// <summary>The capture of the extension: kind Extension, at its published signature (a recorded legacy envelope).</summary>
    private sealed class Authority(string kind) : IProducerSignatureAuthority
    {
        private static readonly string Fixture = Path.Combine(Root, "tests", "contracts", "native-reference", "ordinal-primitive.avsig");
        public JsonObject Capture(string producer, IReadOnlyList<string> elements, string destination, string environment)
        {
            File.Copy(Fixture, destination, overwrite: true);
            return new JsonObject { ["producer"] = producer, ["key"] = ExtKey, ["kind"] = kind, ["guard"] = kind == "Extension" ? "extension-version" : "module-version", ["versionIdBefore"] = 177,
                ["signatureHash"] = NewHash, ["foreignDependencies"] = new JsonArray() };
        }
        public JsonObject CaptureByKey(string producerKey, IReadOnlyList<string> elements, string destination, string environment)
            => throw new InvalidOperationException("no owner is captured by key in this delivery");
        public JsonObject Attest(string avsigPath, string environment) => new() { ["attested"] = true };
    }

    private static JsonObject Valid(string basePath, string jobPath, string output, IReadOnlyDictionary<string, string> producers)
    {
        File.WriteAllText(output, "OML candidate");
        return new JsonObject { ["isValid"] = true, ["accepted"] = true };
    }

    private static (string Work, string Job) JobWork(string tag)
    {
        var work = Path.Combine(Root, ".local", "fix-ext-refs-tests", tag + "-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var job = Path.Combine(work, tag + "-job.json");
        File.WriteAllText(job, new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "reference", ["producer"] = Producer,
            ["elements"] = new JsonArray(JobElements.Select(e => (JsonNode)e).ToArray()) }) }.ToJsonString());
        return (work, job);
    }

    private static JsonObject Deliver(Stub bridge, Studio studio, string work, string job,
        Func<string, string, string, IReadOnlyDictionary<string, string>, JsonObject>? apply = null)
        => Delivery.Run(bridge, new DeliveryRequest(Consumer, job, work, [], CaptureProducers: [Producer]),
            (_, _, _) => throw new Exception("producer-aware apply expected"), producerAuthority: new Authority(studio.Kind),
            applyWithProducers: apply ?? Valid, previewSignatures: (_, _, _) => new JsonObject { ["ran"] = false }, referenceInventory: studio.Read);

    /// <summary>The texts that would say the module was not changed: false once the Studio's Manage Dependencies wrote it.</summary>
    private static void NeverSaysNothingWasApplied(string error)
    {
        Assert.DoesNotContain("Nothing was applied", error, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("nothing was written", error, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("module is unchanged", error, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>The declaration of what the Studio's Manage Dependencies wrote before the merge (Delivery.DeclareReferencesAdded).</summary>
    private static void DeclaresTheElementsAdded(JsonObject result, string field = "referencesAdded")
    {
        var declared = Assert.IsType<JsonObject>(result[field]);
        Assert.Equal("Manage Dependencies", declared["command"]!.ToString());
        Assert.True(declared["committed"]!.GetValue<bool>());
        Assert.True(declared["changed"]!.GetValue<bool>());
        Assert.Equal(["GenerateTemplatePowerPoint", "TemplateSection"], declared["added"]!.AsArray().Select(a => a!["element"]!.ToString()).ToArray());
        var reference = Assert.Single(declared["references"]!.AsArray())!;
        Assert.Equal(Producer, reference["producer"]!.ToString());
        Assert.Equal(OldHash, reference["hashBefore"]!.ToString());
        Assert.Equal(NewHash, reference["hashAfter"]!.ToString());
        Assert.Contains("Ctrl+Z", declared["undo"]!.ToString());
        var text = declared["text"]!.ToString();
        Assert.Contains("Manage Dependencies", text);
        Assert.Contains("GenerateTemplatePowerPoint", text);
        Assert.Contains("TemplateSection", text);
        Assert.Contains(Consumer, text);
        Assert.Contains("Ctrl+Z", text);
    }

    private static void WithAuthority(Action body)
    {
        var before = Environment.GetEnvironmentVariable("ANVIL_AUTHORITY_DIR");
        Environment.SetEnvironmentVariable("ANVIL_AUTHORITY_DIR", Path.Combine(Path.GetTempPath(), "fix-ext-refs-authority-" + Guid.NewGuid().ToString("N")));
        try { body(); }
        finally { Environment.SetEnvironmentVariable("ANVIL_AUTHORITY_DIR", Pa2F1TestAuthority.Restore(before)); }
    }

    [Fact]
    public void TheIncidentShapeIsDeliveredInOneDeliveryThroughTheStudiosOwnManageDependencies()
        => WithAuthority(() =>
        {
            var (work, job) = JobWork("one-delivery");
            var studio = new Studio();
            var bridge = new Stub(studio);
            var result = Deliver(bridge, studio, work, job);
            Assert.True(result["delivered"]?.GetValue<bool>() == true, result["error"]?.ToString());
            // One merge, and it selected no producer signature: the module already held the published one.
            var merge = Assert.Single(bridge.Merges);
            Assert.Equal(1, bridge.Calls.Count(c => c == "merge_from_oml"));
            Assert.False(result["merge"]!["referenceSignatures"]!["HasChanges"]!.GetValue<bool>());
            // The Studio was asked once, before the snapshot, for every element the job names, with the published signature.
            var manage = Assert.Single(bridge.Refreshes);
            Assert.True(manage["published"]!.GetValue<bool>());
            var add = Assert.Single(manage["add"]!.AsArray())!;
            Assert.Equal(ExtKey, add["producer_key"]!.ToString());
            Assert.Equal(JobElements, add["elements"]!.AsArray().Select(e => e!.ToString()).ToArray());
            Assert.True(bridge.Calls.IndexOf("refresh_references") < bridge.Calls.LastIndexOf("snapshot_module"));
            // The base the delivery captured holds the elements at the published signature: the candidate changes nothing there.
            Assert.DoesNotContain(result["referenceClosure"]!["changes"]!.AsArray().OfType<JsonObject>(), c => c["signatureChanges"]?.GetValue<bool>() == true);
            Assert.Equal("Manage Dependencies", result["referencesAdded"]!["command"]!.ToString());
            Assert.Equal(2, result["referencesAdded"]!["added"]!.AsArray().Count);
            // Review A1 (D4): the delivered answer declares the Studio write that preceded the merge, with its undo.
            DeclaresTheElementsAdded(result);
            Assert.Equal("before-merge", result["referencesAdded"]!["when"]!.ToString());
        });

    [Fact]
    public void AJobRefusedAfterManageDependenciesDeclaresTheElementsItAddedToTheModule()
        => WithAuthority(() =>
        {
            // Review A1 (D1): the Manage Dependencies committed, then the apply refused the job: the answer says what the Studio
            // wrote to the module before the refusal, never only "merge was not attempted".
            var (work, job) = JobWork("apply-refused");
            var studio = new Studio();
            var bridge = new Stub(studio);
            var result = Deliver(bridge, studio, work, job, (_, _, output, _) =>
            {
                File.WriteAllText(output, "OML candidate");
                return new JsonObject { ["isValid"] = false, ["accepted"] = false, ["errors"] = new JsonArray("op #2: synthetic validation error of the job") };
            });
            Assert.False(result["delivered"]!.GetValue<bool>());
            Assert.DoesNotContain("merge_from_oml", bridge.Calls);
            Assert.True(studio.Aligned, "the fake Studio committed the Manage Dependencies");
            DeclaresTheElementsAdded(result);
            var error = result["error"]!.ToString();
            Assert.Contains("merge was not attempted", error);
            Assert.Contains("Manage Dependencies", error);
            Assert.Contains("GenerateTemplatePowerPoint", error);
            Assert.Contains("Ctrl+Z", error);
            NeverSaysNothingWasApplied(error);
        });

    [Fact]
    public void AMergeRolledBackAfterManageDependenciesNeverSaysNothingWasApplied()
        => WithAuthority(() =>
        {
            // Review A1 (D2): the Manage Dependencies committed, then the merge rolled back for a reason that is not a signature:
            // the live module equals the base the delivery captured AFTER the Manage Dependencies, so nothing was merged, but
            // the module is not the one the person had: the answer says so, with the undo.
            var (work, job) = JobWork("rolled-back");
            var studio = new Studio();
            var bridge = new Stub(studio) { MergeAnswer = p => new JsonObject { ["operationId"] = p["operation_id"]!.DeepClone(), ["merged"] = false,
                ["reason"] = "rolled back", ["rolledBack"] = true, ["proof"] = "sha256", ["liveSha256"] = "aa11", ["baseSha256"] = "aa11", ["stage"] = "structural-merge",
                ["error"] = "InvalidOperationException: synthetic failure of the structural merge",
                ["referenceSignatures"] = new JsonObject { ["Changes"] = new JsonArray(), ["HasChanges"] = false } } };
            var result = Deliver(bridge, studio, work, job);
            Assert.Equal(Delivery.MergeRolledBackCode, result["code"]!.ToString());
            DeclaresTheElementsAdded(result);
            var error = result["error"]!.ToString();
            NeverSaysNothingWasApplied(error);
            Assert.Contains("Nothing was merged", error);
            Assert.Contains("Manage Dependencies", error);
            Assert.Contains("TemplateSection", error);
            Assert.Contains("Ctrl+Z", error);
        });

    // ---- Review round 3 (F2, F3): one rule for every Studio write outside the merge (Delivery.StudioWrites) ----

    /// <summary>The records of the task's Studio writes outside the merge (Delivery.RecordStudioWrite).</summary>
    private static List<JsonObject> Writes(JsonObject result) => (result["studioWrites"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().ToList();

    private static JsonObject Resume(Stub bridge, Studio studio, string work, string taskId)
        => Delivery.Run(bridge, DeliveryTask.ResumeRequest(work, taskId),
            (_, _, _) => throw new Exception("producer-aware apply expected"), producerAuthority: new Authority(studio.Kind),
            applyWithProducers: Valid, previewSignatures: (_, _, _) => new JsonObject { ["ran"] = false }, referenceInventory: studio.Read);

    /// <summary>The open answered the dependencies dialog (MB2): the Studio's Refresh References of every producer then changed the
    /// module; the C26 Refresh References before the snapshot finds it up to date.</summary>
    private static Stub DependenciesDialogStub(Studio studio, Func<JsonObject, JsonObject>? merge = null) => new(studio)
    {
        Capabilities = ["refresh_references"],
        OpenAnswer = _ => new JsonObject { ["name"] = Consumer, ["opened"] = true, ["alreadyOpen"] = true, ["dependenciesDialog"] = new JsonObject {
            ["answered"] = new JsonArray(new JsonObject { ["kind"] = "DependenciesDialogAnswered", ["title"] = "Incompatible or missing dependencies found", ["answer"] = "Cancel" }) } },
        RefreshAnswer = p => p["answer_dependencies"]?.GetValue<bool>() == true
            ? new JsonObject { ["module"] = Consumer, ["moduleKey"] = "consumer-key", ["changed"] = true, ["refreshed"] = new JsonArray(Producer), ["upToDate"] = new JsonArray() }
            : new JsonObject { ["module"] = Consumer, ["changed"] = false, ["refreshed"] = new JsonArray(), ["upToDate"] = new JsonArray(Producer) },
        MergeAnswer = merge,
    };

    private static JsonObject RolledBackOther(JsonObject p) => new() { ["operationId"] = p["operation_id"]!.DeepClone(), ["merged"] = false,
        ["reason"] = "rolled back", ["rolledBack"] = true, ["proof"] = "sha256", ["liveSha256"] = "aa11", ["baseSha256"] = "aa11", ["stage"] = "structural-merge",
        ["error"] = "InvalidOperationException: synthetic failure of the structural merge",
        ["referenceSignatures"] = new JsonObject { ["Changes"] = new JsonArray(), ["HasChanges"] = false } };

    private static JsonObject Blocked(string? command) => new()
    {
        ["module"] = Consumer, ["moduleKey"] = "consumer-key", ["command"] = command, ["changed"] = null, ["blocked"] = true, ["outcome"] = "running",
        ["blockedBy"] = new JsonObject { ["title"] = "Sign in", ["question"] = "Sign in to lab.example to continue?", ["kind"] = "Question" }, ["dialogs"] = new JsonArray(),
        ["next"] = "the person answers the dialog in the Studio; the command then ends by itself (Ctrl+Z undoes it)",
    };

    [Fact]
    public void M1_TheRefreshAfterTheDependenciesDialogIsDeclaredWhenTheMergeRollsBack()
        => WithAuthority(() =>
        {
            var (work, job) = JobWork("mb2-rollback");
            var studio = new Studio();
            var result = Deliver(DependenciesDialogStub(studio, RolledBackOther), studio, work, job);
            Assert.Equal(Delivery.MergeRolledBackCode, result["code"]!.ToString());
            var open = Assert.Single(Writes(result), w => w["stage"]?.ToString() == "open");
            Assert.Equal("Refresh References", open["command"]!.ToString());
            Assert.Equal("changed", open["outcome"]!.ToString());
            var error = result["error"]!.ToString();
            NeverSaysNothingWasApplied(error);
            Assert.Contains("Refresh References", error);
            Assert.Contains(Producer, error);
            Assert.Contains("Ctrl+Z", error);
        });

    [Fact]
    public void M2_TheRefreshAfterTheDependenciesDialogIsDeclaredWhenTheApplyRefuses()
        => WithAuthority(() =>
        {
            var (work, job) = JobWork("mb2-refused");
            var studio = new Studio();
            var result = Deliver(DependenciesDialogStub(studio), studio, work, job, (_, _, output, _) =>
            {
                File.WriteAllText(output, "OML candidate");
                return new JsonObject { ["isValid"] = false, ["accepted"] = false, ["errors"] = new JsonArray("op #2: synthetic validation error of the job") };
            });
            Assert.False(result["delivered"]!.GetValue<bool>());
            Assert.Contains(Writes(result), w => w["stage"]?.ToString() == "open" && w["outcome"]?.ToString() == "changed");
            var error = result["error"]!.ToString();
            Assert.Contains("merge was not attempted", error);
            Assert.Contains("Refresh References", error);
            Assert.Contains("Ctrl+Z", error);
        });

    [Fact]
    public void M3_TheRefreshAfterTheDependenciesDialogIsDeclaredWithItsUndoWhenDelivered()
        => WithAuthority(() =>
        {
            var (work, job) = JobWork("mb2-delivered");
            var studio = new Studio { Aligned = true };
            var result = Deliver(DependenciesDialogStub(studio), studio, work, job);
            Assert.True(result["delivered"]?.GetValue<bool>() == true, result["error"]?.ToString());
            var open = Assert.Single(Writes(result), w => w["stage"]?.ToString() == "open");
            Assert.Equal("changed", open["outcome"]!.ToString());
            Assert.Contains("Ctrl+Z", open["undo"]!.ToString());
            Assert.Contains(Producer, open["text"]!.ToString());
        });

    [Fact]
    public void B1_AManageDependenciesThatWaitsForThePersonIsPendingAndTheResumeDeclaresWhatItWrote()
        => WithAuthority(() =>
        {
            // F3: the bridge answered blocked/outcome running (the Studio asks the person; the command ends by itself after the
            // answer and writes). Never "rolled back, added nothing"; the resume declares the write the waiting command made.
            var (work, job) = JobWork("manage-blocked");
            var studio = new Studio();
            var calls = 0;
            var bridge = new Stub(studio) { EnvironmentName = "fixture.invalid", ManageAnswer = p =>
            {
                calls++;
                if (calls == 1) { studio.Aligned = true; return Blocked("Manage Dependencies"); }
                return new JsonObject { ["module"] = Consumer, ["command"] = "Manage Dependencies", ["committed"] = true, ["changed"] = false, ["added"] = new JsonArray(),
                    ["alreadyReferenced"] = new JsonArray(new JsonObject { ["producer"] = Producer, ["element"] = "GenerateTemplatePowerPoint" }, new JsonObject { ["producer"] = Producer, ["element"] = "TemplateSection" }),
                    ["references"] = new JsonArray(new JsonObject { ["producer"] = Producer, ["key"] = ExtKey, ["kind"] = "Extension", ["hashBefore"] = NewHash, ["hashAfter"] = NewHash, ["published"] = NewHash, ["atPublished"] = true }) };
            } };
            var first = Deliver(bridge, studio, work, job);
            Assert.Equal("STUDIO_DIALOG_PENDING", first["code"]!.ToString());
            var waiting = Assert.Single(Writes(first));
            Assert.Equal("pending", waiting["outcome"]!.ToString());
            var said = first["error"]!.ToString();
            Assert.DoesNotContain("added nothing", said);
            Assert.DoesNotContain("rolled back", said);
            Assert.Contains("during the Manage Dependencies", said);
            Assert.Contains("waits for the person", said);
            Assert.Contains("GenerateTemplatePowerPoint", said);
            Assert.Contains("Ctrl+Z", said);
            var resumed = Resume(bridge, studio, work, first["taskId"]!.ToString());
            Assert.True(resumed["delivered"]?.GetValue<bool>() == true, resumed["error"]?.ToString());
            var ended = Writes(resumed).First();
            Assert.Equal("ended", ended["outcome"]!.ToString());
            var text = ended["text"]!.ToString();
            Assert.Contains("GenerateTemplatePowerPoint", text);
            Assert.Contains(NewHash[..8], text);
            Assert.Contains("Ctrl+Z", text);
            Assert.DoesNotContain("changed nothing", text);
        });

    [Fact]
    public void C6_ARefreshReferencesThatWaitsForThePersonIsPendingAndTheResumeDeclaresIt()
        => WithAuthority(() =>
        {
            var (work, job) = JobWork("refresh-blocked");
            var studio = new Studio { Aligned = true };
            var calls = 0;
            var bridge = new Stub(studio) { EnvironmentName = "fixture.invalid", Capabilities = ["refresh_references"], RefreshAnswer = _ => ++calls == 1 ? Blocked(null)
                : new JsonObject { ["module"] = Consumer, ["changed"] = false, ["refreshed"] = new JsonArray(), ["upToDate"] = new JsonArray(Producer) } };
            var first = Deliver(bridge, studio, work, job);
            Assert.Equal("STUDIO_DIALOG_PENDING", first["code"]!.ToString());
            Assert.Equal("pending", Assert.Single(Writes(first))["outcome"]!.ToString());
            var said = first["error"]!.ToString();
            Assert.DoesNotContain("changed nothing", said);
            Assert.Contains("waits for the person", said);
            var resumed = Resume(bridge, studio, work, first["taskId"]!.ToString());
            Assert.True(resumed["delivered"]?.GetValue<bool>() == true, resumed["error"]?.ToString());
            var ended = Writes(resumed).First();
            Assert.Equal("ended", ended["outcome"]!.ToString());
            Assert.DoesNotContain("changed nothing", ended["text"]!.ToString());
            Assert.Contains("Ctrl+Z", ended["text"]!.ToString());
        });

    [Fact]
    public void AManageDependenciesAfterTheRollbackThatWaitsForThePersonIsPendingNeverAddedNothing()
        => WithAuthority(() =>
        {
            var (work, job) = JobWork("after-rollback-blocked");
            var studio = new Studio();
            var calls = 0;
            var bridge = new Stub(studio) { ManageAnswer = p => ++calls == 1
                ? new JsonObject { ["module"] = Consumer, ["command"] = "Manage Dependencies", ["committed"] = true, ["changed"] = false,
                    ["references"] = new JsonArray(new JsonObject { ["producer"] = Producer, ["key"] = ExtKey, ["hashBefore"] = OldHash, ["hashAfter"] = OldHash }) }
                : Blocked("Manage Dependencies") };
            var result = Deliver(bridge, studio, work, job);
            Assert.Equal(Delivery.MergeRolledBackCode, result["code"]!.ToString());
            var after = Assert.Single(Writes(result), w => w["stage"]?.ToString() == "after-rollback");
            Assert.Equal("pending", after["outcome"]!.ToString());
            var error = result["error"]!.ToString();
            Assert.DoesNotContain("added nothing", error);
            Assert.DoesNotContain("failed inside the Studio", error);
            Assert.Contains("waits for the person", error);
            NeverSaysNothingWasApplied(error);
        });

    // ---- Review round 4 (N1, N2): a record says only what a run observed; an unobserved outcome is pending or unknown ----

    private static JsonObject DialogStall() => new()
    {
        ["verdict"] = "dialog", ["method"] = "refresh_references", ["afterMs"] = 4000,
        ["blockedBy"] = new JsonObject { ["title"] = "Sign in", ["type"] = "OutSystems.Studio.DialogWindow", ["kind"] = "Question" },
    };

    private static JsonObject Unchanged() => new()
    {
        ["module"] = Consumer, ["command"] = "Manage Dependencies", ["committed"] = true, ["changed"] = false, ["added"] = new JsonArray(),
        ["alreadyReferenced"] = new JsonArray(new JsonObject { ["producer"] = Producer, ["element"] = "GenerateTemplatePowerPoint" }, new JsonObject { ["producer"] = Producer, ["element"] = "TemplateSection" }),
        ["references"] = new JsonArray(new JsonObject { ["producer"] = Producer, ["key"] = ExtKey, ["kind"] = "Extension", ["hashBefore"] = NewHash, ["hashAfter"] = NewHash, ["published"] = NewHash, ["atPublished"] = true }),
    };

    /// <summary>Keeps the state of one run beside the task (seen-<name>.json), for the answers the report shows.</summary>
    private static void Keep(string work, string name, JsonObject result) => File.WriteAllText(Path.Combine(work, "seen-" + name + ".json"), result.ToJsonString());

    /// <summary>No answer of this task says a pending command ended unless a run observed its end.</summary>
    private static void NeverSaysItEnded(JsonObject result)
    {
        var error = result["error"]?.ToString() ?? "";
        Assert.DoesNotContain("ended by itself", error);
        Assert.DoesNotContain("has ended", error);
        Assert.All(Writes(result), w => Assert.NotEqual("ended", w["outcome"]?.ToString()));
    }

    [Fact]
    public void H2_AStalledManageDependenciesStaysPendingWhileTheDialogIsStillShown()
        => WithAuthority(() =>
        {
            var (work, job) = JobWork("n1-h2");
            var studio = new Studio();
            var bridge = new Stub(studio) { EnvironmentName = "fixture.invalid",
                ManageAnswer = _ => throw new BridgeCallException("refresh_references: Studio call stopped (dialog): Sign in; this call was not retried", null, DialogStall()) };
            bridge.DialogOpen = true;
            var first = Deliver(bridge, studio, work, job);
            Keep(work, "H2-run1", first);
            Assert.Equal("pending", Assert.Single(Writes(first))["outcome"]!.ToString());
            foreach (var run in new[] { 2, 3 })
            {
                var again = Resume(bridge, studio, work, first["taskId"]!.ToString());
                Keep(work, "H2-run" + run, again);
                Assert.Contains("still pending or idle could not be proven", again["error"]!.ToString());
                NeverSaysItEnded(again);
                Assert.Equal("pending", Assert.Single(Writes(again))["outcome"]!.ToString());
                Assert.Contains("may still be waiting or may have ended", again["error"]!.ToString());
            }
        });

    [Fact]
    public void H1_ABlockedManageDependenciesStaysPendingWhenTheResumeFindsTheDialogStillPending()
        => WithAuthority(() =>
        {
            var (work, job) = JobWork("n1-h1");
            var studio = new Studio();
            var calls = 0;
            var bridge = new Stub(studio) { EnvironmentName = "fixture.invalid", ManageAnswer = _ => ++calls == 1 ? Blocked("Manage Dependencies")
                : throw new BridgeCallException("refresh_references: '" + Consumer + "' has a dialog or merge editor pending in the Studio (Sign in); nothing was refreshed", false) };
            var first = Deliver(bridge, studio, work, job);
            Keep(work, "H1-run1", first);
            Assert.Equal("STUDIO_DIALOG_PENDING", first["code"]!.ToString());
            var again = Resume(bridge, studio, work, first["taskId"]!.ToString());
            Keep(work, "H1-run2", again);
            Assert.Contains("nothing was refreshed", again["error"]!.ToString());
            NeverSaysItEnded(again);
            Assert.Equal("pending", Assert.Single(Writes(again))["outcome"]!.ToString());
            Assert.Contains("may still be waiting or may have ended", again["error"]!.ToString());
        });

    [Fact]
    public void H1b_ABlockedManageDependenciesStaysPendingWhenTheResumeStopsAtTheOpen()
        => WithAuthority(() =>
        {
            var (work, job) = JobWork("n1-h1b");
            var studio = new Studio();
            var opens = 0;
            var bridge = new Stub(studio) { EnvironmentName = "fixture.invalid", ManageAnswer = _ => Blocked("Manage Dependencies"),
                OpenAnswer = _ => ++opens == 1 ? new JsonObject { ["name"] = Consumer, ["opened"] = true, ["alreadyOpen"] = true }
                    : new JsonObject { ["name"] = Consumer, ["opened"] = false, ["alreadyOpen"] = false, ["hint"] = "a dialog is open in the Studio (Sign in)",
                        ["blockedBy"] = new JsonObject { ["title"] = "Sign in", ["question"] = "Sign in to lab.example to continue?", ["kind"] = "Question" } } };
            var first = Deliver(bridge, studio, work, job);
            Keep(work, "H1b-run1", first);
            var again = Resume(bridge, studio, work, first["taskId"]!.ToString());
            Keep(work, "H1b-run2", again);
            Assert.Contains("open_module is blocked", again["error"]!.ToString());
            NeverSaysItEnded(again);
            Assert.Contains("may still be waiting or may have ended", again["error"]!.ToString());
        });

    [Fact]
    public void H10_ABridgeGoneStallEndsOnTheIdleProofAndNeverSaysItWaitedForThePerson()
        => WithAuthority(() =>
        {
            var (work, job) = JobWork("n1-h10");
            var studio = new Studio { Aligned = true };
            var calls = 0;
            var bridge = new Stub(studio) { EnvironmentName = "fixture.invalid", ManageAnswer = _ => ++calls == 1
                ? throw new BridgeCallException("refresh_references: Studio call stopped (bridge-gone); this call was not retried", null,
                    new JsonObject { ["verdict"] = "bridge-gone", ["method"] = "refresh_references", ["afterMs"] = 9000 })
                : Unchanged() };
            var first = Deliver(bridge, studio, work, job);
            Keep(work, "H10-run1", first);
            Assert.DoesNotContain("waits for the person", first["error"]!.ToString());
            var resumed = Resume(bridge, studio, work, first["taskId"]!.ToString());
            Keep(work, "H10-run2", resumed);
            Assert.True(resumed["delivered"]?.GetValue<bool>() == true, resumed["error"]?.ToString());
            var ended = Writes(resumed).First();
            Assert.Equal("ended", ended["outcome"]!.ToString());
            var text = ended["text"]!.ToString();
            Assert.DoesNotContain("waited for the person", text);
            Assert.Contains("stopped answering", text);
            Assert.Contains("Ctrl+Z", text);
        });

    /// <summary>N2: a refresh_references sent with no answer that says what it did is an unknown record, fenced until the
    /// Studio is proven idle; the resume's delivered answer still declares it.</summary>
    private static void UnknownThenDelivered(string tag, Func<Exception> lost, string said)
        => WithAuthority(() =>
        {
            var (work, job) = JobWork(tag);
            var studio = new Studio();
            var calls = 0;
            var bridge = new Stub(studio) { EnvironmentName = "fixture.invalid", ManageAnswer = _ =>
            {
                if (++calls > 1) return Unchanged();
                studio.Aligned = true; // the command ends by itself in the Studio and writes
                throw lost();
            } };
            var first = Deliver(bridge, studio, work, job);
            Keep(work, tag + "-run1", first);
            Assert.False(first["delivered"]!.GetValue<bool>());
            var unknown = Assert.Single(Writes(first));
            Assert.Equal("unknown", unknown["outcome"]!.ToString());
            Assert.Contains(said, unknown["error"]!.ToString());
            Assert.Contains("unknown", first["error"]!.ToString());
            Assert.Contains("Ctrl+Z", first["error"]!.ToString());
            Assert.Equal("refresh_references", first["pendingBridgeOperation"]?["method"]?.ToString());
            var resumed = Resume(bridge, studio, work, first["taskId"]!.ToString());
            Keep(work, tag + "-run2", resumed);
            Assert.True(resumed["delivered"]?.GetValue<bool>() == true, resumed["error"]?.ToString());
            var declared = Writes(resumed).First();
            Assert.Equal("unknown", declared["outcome"]!.ToString());
            Assert.Contains(said, declared["error"]!.ToString());
            Assert.Contains("Ctrl+Z", declared["undo"]!.ToString());
            Assert.Contains("unknown", declared["text"]!.ToString());
            Assert.Equal(2, calls);
        });

    [Fact]
    public void H5_AManageDependenciesWhoseOutcomeTheBridgeCallsUnknownIsDeclaredThroughTheResume()
        => UnknownThenDelivered("n2-h5", () => new BridgeCallException("refresh_references: the Manage Dependencies of '" + Consumer
            + "' did not end within 600 s; its outcome is unknown. Check the module in the Studio (Ctrl+Z undoes it).", null), "its outcome is unknown");

    [Fact]
    public void H6_AManageDependenciesWhoseReplyWasLostIsDeclaredThroughTheResume()
        => UnknownThenDelivered("n2-h6", () => new IOException("refresh_references: bridge closed before replying; execution outcome may be unknown"), "closed before replying");

    [Fact]
    public void H6b_AManageDependenciesWhoseReplyDeadlineExpiredIsDeclaredThroughTheResume()
        => UnknownThenDelivered("n2-h6b", () => new IOException("refresh_references: bridge reply deadline expired; execution outcome may be unknown"), "deadline expired");

    [Fact]
    public void H7_TheRefreshAfterTheDependenciesDialogWithAnUnknownOutcomeIsDeclaredInBothRuns()
        => WithAuthority(() =>
        {
            var (work, job) = JobWork("n2-h7");
            var studio = new Studio { Aligned = true };
            var opens = 0; var refreshes = 0;
            var bridge = new Stub(studio) { EnvironmentName = "fixture.invalid", Capabilities = ["refresh_references"],
                OpenAnswer = _ => ++opens == 1
                    ? new JsonObject { ["name"] = Consumer, ["opened"] = true, ["alreadyOpen"] = true, ["dependenciesDialog"] = new JsonObject {
                        ["answered"] = new JsonArray(new JsonObject { ["kind"] = "DependenciesDialogAnswered", ["title"] = "Incompatible or missing dependencies found", ["answer"] = "Cancel" }) } }
                    : new JsonObject { ["name"] = Consumer, ["opened"] = true, ["alreadyOpen"] = true },
                RefreshAnswer = p => p["answer_dependencies"]?.GetValue<bool>() == true && ++refreshes == 1
                    ? throw new BridgeCallException("refresh_references: '" + Consumer + "' did not end within 600 s; its outcome is unknown. Check the module in the Studio (Ctrl+Z undoes a refresh).", null)
                    : new JsonObject { ["module"] = Consumer, ["changed"] = false, ["refreshed"] = new JsonArray(), ["upToDate"] = new JsonArray(Producer) } };
            var first = Deliver(bridge, studio, work, job);
            Keep(work, "H7-run1", first);
            Assert.Equal(Delivery.ReferencesRefreshFailedCode, first["code"]!.ToString());
            var open = Assert.Single(Writes(first));
            Assert.Equal("open", open["stage"]!.ToString());
            Assert.Equal("unknown", open["outcome"]!.ToString());
            Assert.Contains("unknown", first["error"]!.ToString());
            var resumed = Resume(bridge, studio, work, first["taskId"]!.ToString());
            Keep(work, "H7-run2", resumed);
            Assert.True(resumed["delivered"]?.GetValue<bool>() == true, resumed["error"]?.ToString());
            var declared = Assert.Single(Writes(resumed), w => w["stage"]?.ToString() == "open");
            Assert.Equal("unknown", declared["outcome"]!.ToString());
            Assert.Contains("Ctrl+Z", declared["undo"]!.ToString());
        });

    [Fact]
    public void ARefreshReferencesThatChangedTheModuleBeforeARolledBackMergeIsDeclaredToo()
        => WithAuthority(() =>
        {
            // Review A1, the same family (C26): on a bridge without the Manage Dependencies the delivery runs the Studio's
            // Refresh References before the snapshot; when it changed the module and the merge then rolls back, the answer says
            // so with the undo, never "nothing was applied".
            var (work, job) = JobWork("refreshed");
            var studio = new Studio();
            var bridge = new Stub(studio) { Capabilities = ["refresh_references"],
                RefreshAnswer = _ => new JsonObject { ["module"] = Consumer, ["changed"] = true, ["refreshed"] = new JsonArray(Producer), ["upToDate"] = new JsonArray() },
                MergeAnswer = p => new JsonObject { ["operationId"] = p["operation_id"]!.DeepClone(), ["merged"] = false,
                    ["reason"] = "rolled back", ["rolledBack"] = true, ["proof"] = "sha256", ["liveSha256"] = "aa11", ["baseSha256"] = "aa11", ["stage"] = "structural-merge",
                    ["error"] = "InvalidOperationException: synthetic failure of the structural merge",
                    ["referenceSignatures"] = new JsonObject { ["Changes"] = new JsonArray(), ["HasChanges"] = false } } };
            var result = Deliver(bridge, studio, work, job);
            Assert.Equal(Delivery.MergeRolledBackCode, result["code"]!.ToString());
            var declared = result["referencesRefreshedBeforeMerge"]!.AsObject();
            Assert.Equal("Refresh References", declared["command"]!.ToString());
            Assert.True(declared["changed"]!.GetValue<bool>());
            var error = result["error"]!.ToString();
            NeverSaysNothingWasApplied(error);
            Assert.Contains("Refresh References changed " + Consumer, error);
            Assert.Contains(Producer, error);
            Assert.Contains("Ctrl+Z", error);
            Assert.Null(result["referencesAdded"]);
        });

    [Fact]
    public void AFailureRaisedAfterManageDependenciesKeepsTheDeclarationAndNeverClaimsNothingWasWritten()
        => WithAuthority(() =>
        {
            // Review A1, the family: whatever stage refuses after the commit (here an exception of the apply, as a producer that
            // changed raises one), the answer keeps the declaration and drops the claim that nothing was written.
            var (work, job) = JobWork("raised");
            var studio = new Studio();
            var bridge = new Stub(studio);
            var result = Deliver(bridge, studio, work, job, (_, _, _, _) => throw new InvalidOperationException("ZZ_Report_Ext was republished since its capture; nothing was written"));
            Assert.False(result["delivered"]!.GetValue<bool>());
            DeclaresTheElementsAdded(result);
            var error = result["error"]!.ToString();
            Assert.Contains("republished since its capture", error);
            Assert.Contains("Manage Dependencies", error);
            NeverSaysNothingWasApplied(error);
        });

    [Fact]
    public void AManageDependenciesThatFailedInsideTheStudioIsNamedWithTheRefreshReferencesThatRanInstead()
        => WithAuthority(() =>
        {
            // Review B1 + A1 (the text names what ran): the Manage Dependencies failed inside the Studio (an exception, its command
            // rolled back); the delivery went on with the Studio's Refresh References and the merge rolled back on the signature.
            // The answer names the failure and the fallback, and never blames the Refresh References for what it never does.
            var (work, job) = JobWork("manage-failed");
            var studio = new Studio();
            var bridge = new Stub(studio) { ManageAnswer = _ => new JsonObject { ["module"] = Consumer, ["command"] = "Manage Dependencies", ["committed"] = false,
                ["code"] = "REFERENCES_NOT_ADDED", ["stage"] = "check", ["error"] = "InvalidOperationException: synthetic failure inside the Studio",
                ["reason"] = "nothing was applied: the Studio rolled the Manage Dependencies command back" } };
            var result = Deliver(bridge, studio, work, job);
            Assert.Equal(Delivery.MergeRolledBackCode, result["code"]!.ToString());
            var declared = result["referencesAdded"]!.AsObject();
            Assert.False(declared["committed"]!.GetValue<bool>());
            Assert.Equal("Refresh References", declared["fallback"]!.ToString());
            var error = result["error"]!.ToString();
            Assert.Contains("synthetic failure inside the Studio", error);
            Assert.DoesNotContain("the Studio's Refresh References did not bring", error);
            Assert.Contains("Manage Dependencies failed", error);
        });

    [Fact]
    public void ARollbackOnABridgeWithoutManageDependenciesNeverSendsAnExtensionToAnOmlAndNamesTheExactContinuation()
        => WithAuthority(() =>
        {
            var (work, job) = JobWork("old-bridge");
            var studio = new Studio();
            var bridge = new Stub(studio) { Capabilities = ["refresh_references"] };
            var result = Deliver(bridge, studio, work, job);
            Assert.Equal(Delivery.MergeRolledBackCode, result["code"]!.ToString());
            var error = result["error"]!.ToString();
            Assert.DoesNotContain("as OML", error);
            Assert.DoesNotContain("by hand", error, StringComparison.OrdinalIgnoreCase);
            Assert.Contains("Manage Dependencies", error);
            Assert.Contains("never from an OML", error);
            Assert.False(result["sameJobAgain"]!.GetValue<bool>());
            // The exact continuation: the elements to add, by producer, and the capability the loaded bridge lacks.
            var alignment = result["alignment"]!.AsObject();
            Assert.Equal(Delivery.ManageDependenciesCapability, alignment["requires"]!.ToString());
            Assert.False(alignment["bridgeOffers"]!.GetValue<bool>());
            var entry = Assert.Single(alignment["add"]!.AsArray())!;
            Assert.Equal(Producer, entry["producer"]!.ToString());
            Assert.Equal("Extension", entry["kind"]!.ToString());
            Assert.Equal(JobElements, entry["elements"]!.AsArray().Select(e => e!.ToString()).ToArray());
        });

    [Fact]
    public void ARollbackOnABridgeWithManageDependenciesAlignsTheModuleAndSaysTheSameJobAgain()
        => WithAuthority(() =>
        {
            // A merge that rolled back for another reason (the module was aligned only after it): the kernel's alignment after
            // the rollback runs the Studio's own Manage Dependencies, so the same job is right on the next delivery.
            var (work, job) = JobWork("align-after");
            var studio = new Studio();
            var first = true;
            var bridge = new Stub(studio) { ManageAnswer = p =>
            {
                // The first Manage Dependencies (before the snapshot) committed, but the Studio's catalog still served the old
                // signature (a stale reference cache): the reference stays at the old hash and the merge must select it.
                if (first) { first = false; return new JsonObject { ["module"] = Consumer, ["changed"] = false, ["committed"] = true,
                    ["references"] = new JsonArray(new JsonObject { ["producer"] = Producer, ["key"] = ExtKey, ["hashBefore"] = OldHash, ["hashAfter"] = OldHash }) }; }
                studio.Aligned = true;
                return new JsonObject { ["module"] = Consumer, ["command"] = "Manage Dependencies", ["committed"] = true, ["changed"] = true, ["refreshed"] = new JsonArray(Producer),
                    ["added"] = new JsonArray(new JsonObject { ["producer"] = Producer, ["element"] = "GenerateTemplatePowerPoint" }, new JsonObject { ["producer"] = Producer, ["element"] = "TemplateSection" }),
                    ["references"] = new JsonArray(new JsonObject { ["producer"] = Producer, ["key"] = ExtKey, ["hashBefore"] = OldHash, ["hashAfter"] = NewHash }),
                    ["undo"] = "Ctrl+Z in the Studio undoes the Manage Dependencies" };
            } };
            var result = Deliver(bridge, studio, work, job);
            Assert.Equal(Delivery.MergeRolledBackCode, result["code"]!.ToString());
            Assert.True(result["sameJobAgain"]!.GetValue<bool>(), result["error"]!.ToString());
            Assert.Contains("same job again", result["error"]!.ToString());
            Assert.True(bridge.Refreshes[^1]["published"]!.GetValue<bool>());
            // Review A1 (D3): the text names the command that ran after the rollback (the Manage Dependencies, not the Refresh
            // References), declares what it wrote with the undo, and never says nothing was applied.
            var error = result["error"]!.ToString();
            Assert.Contains("Manage Dependencies of " + Producer + " ran", error);
            Assert.DoesNotContain("Refresh References", error);
            NeverSaysNothingWasApplied(error);
            DeclaresTheElementsAdded(result, "referencesAddedAfterRollback");
            Assert.Equal("after-rollback", result["referencesAddedAfterRollback"]!["when"]!.ToString());
        });

    [Fact]
    public void ManageDependenciesTheStudioRefusedIsOneRefusalWithEveryProblemBeforeAnyMerge()
        => WithAuthority(() =>
        {
            var (work, job) = JobWork("refused");
            var studio = new Studio();
            var bridge = new Stub(studio) { ManageAnswer = _ => new JsonObject { ["module"] = Consumer, ["changed"] = false, ["committed"] = false,
                ["problems"] = new JsonArray(
                    new JsonObject { ["producer"] = Producer, ["element"] = "IServerActionSignature:GenerateTemplatePowerPoint", ["cause"] = "not-in-signature",
                        ["message"] = "GenerateTemplatePowerPoint is not in the published signature of ZZ_Report_Ext.",
                        ["fix"] = "publish ZZ_Report_Ext with GenerateTemplatePowerPoint public, then deliver the same job again" },
                    new JsonObject { ["producer"] = Producer, ["element"] = "IStructureSignature:TemplateSection", ["cause"] = "not-in-signature",
                        ["message"] = "TemplateSection is not in the published signature of ZZ_Report_Ext.",
                        ["fix"] = "publish ZZ_Report_Ext with TemplateSection public, then deliver the same job again" }) } };
            var result = Deliver(bridge, studio, work, job);
            Assert.Equal(Delivery.ReferencesNotAddedCode, result["code"]!.ToString());
            Assert.Equal(2, result["problems"]!.AsArray().Count);
            Assert.Contains("GenerateTemplatePowerPoint", result["error"]!.ToString());
            Assert.Contains("TemplateSection", result["error"]!.ToString());
            Assert.DoesNotContain("merge_from_oml", bridge.Calls);
            Assert.Equal("not-sent", result["writeState"]!.ToString());
        });

    [Fact]
    public void AnEspaceProducerWithNewElementsTakesTheSamePath()
        => WithAuthority(() =>
        {
            // Producer kind is not a branch: an eSpace producer that gained an entity is added by the same Manage Dependencies.
            var (work, job) = JobWork("espace");
            var studio = new Studio("eSpace");
            var bridge = new Stub(studio);
            var result = Deliver(bridge, studio, work, job);
            Assert.True(result["delivered"]?.GetValue<bool>() == true, result["error"]?.ToString());
            Assert.Single(bridge.Refreshes, r => r["add"] is JsonArray);
        });
}
