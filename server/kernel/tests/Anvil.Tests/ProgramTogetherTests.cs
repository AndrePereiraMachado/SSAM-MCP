using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using OutSystems.Model;
using OutSystems.Model.Logic;
using OutSystems.Model.Logic.Nodes;
using ServiceStudio.Model;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// F1 (owner 2026-11-02, verbatim: "o ssam deve permitir que o usuario programe junto com ele.. ele deve ser capaz de fazer o
/// merge e é isso"). SSAM never stops because the person works in the Studio: the delivery merges three ways, the proof after
/// the merge requires only what the job wrote, the person's edits and the Studio's own canvas changes are notes, and a refusal
/// never leaves the module reserved. End to end, as DeliveryMergeContentRuleTests: Delivery.Run, the real job apply, the real
/// planner and content proof, and a bridge whose merge_from_oml is the Studio's own MatchTree run headless. The "person" edits
/// the open module between the delivery's capture and its write (AfterBaseSnapshot) or right after the merge (AfterMerge).
/// Each test fails on fase4-28/r3 069d4fc1 and passes with the hotfix, except the content-loss guard, which holds on both.
/// </summary>
public partial class ProgramTogetherTests
{
    private const string Fingerprint = "list_open_modules:model_sha256";

    private static string Action(string name) => """{"ops":[{"op":"logic","data":{"actions":[{"name":"NAME","kind":"server","outputs":[{"name":"Out","type":"Integer"}],"steps":[{"assign":{"Out":"1"}}]}]}}]}""".Replace("NAME", name);

    // ---- Stop 1: the post-merge proof verifies only what the job wrote ------------------------------------------------

    [Fact]
    public void Stop1_FlowNodesTheStudioMovedInTheMergeAreANoteNotAMismatch()
    {
        // Production 2026-11-02 (ProdSSAM_CS, EditTaskComment): the proof refused only on the positions of flow nodes.
        var studio = Studio(fingerprint: true);
        studio.AfterMerge = live => Edit(live, model =>
        {
            foreach (var node in Objects(model).OfType<IFlowNode>()) { node.HorizontalPosition += 40; node.VerticalPosition += 25; }
        });
        var result = Deliver(studio, Action("EditTaskComment"));
        Assert.True(result["delivered"]?.GetValue<bool>() == true, result["error"]?.ToString() + " " + result["contentProof"]?["differences"]?.ToJsonString());
        Assert.True(result["contentProof"]!["accepted"]!.GetValue<bool>());
        Assert.Contains(Notes(result), n => n.Contains("editor-state", StringComparison.Ordinal));
        Assert.True(result["contentProof"]!["editorState"]!["total"]!.GetValue<int>() > 0);
    }

    [Fact]
    public void Stop1_AnActionThePersonCreatedWhileTheDeliveryRanIsKeptAndNoted()
    {
        // The person adds an action of their own between the delivery's capture and its merge: the three-way merge keeps it,
        // the proof does not require the candidate's view of it, and the answer says it.
        var studio = Studio(fingerprint: true);
        studio.AfterBaseSnapshot = live => Apply(live, Action("PersonsOwnAction"));
        var result = Deliver(studio, Action("DeliveredAction"));
        Assert.True(result["delivered"]?.GetValue<bool>() == true, result["error"]?.ToString() + " " + result["contentProof"]?["differences"]?.ToJsonString());
        Assert.Contains(Notes(result), n => n.Contains("did not write", StringComparison.Ordinal));
        Assert.True(Has(studio.Live, "PersonsOwnAction") && Has(studio.Live, "DeliveredAction"), "both the person's and the delivery's action are in the module");
    }

    [Fact]
    public void Stop1_AnElementTheJobWroteMissingAfterTheMergeStillRefuses()
    {
        // Real content loss is never weakened: the action the job created is gone after the merge.
        var studio = Studio(fingerprint: true);
        studio.AfterMerge = live => Edit(live, model =>
        {
            foreach (var action in Actions(model, "LostAction")) action.Delete();
        });
        var result = Deliver(studio, Action("LostAction"));
        Assert.False(result["delivered"]?.GetValue<bool>() == true);
        Assert.Equal("MERGE_CONTENT_MISMATCH", result["code"]?.ToString());
        Assert.Contains(result["contentProof"]!["differences"]!.AsArray(), d => d!["element"]!.ToString().Contains("LostAction", StringComparison.Ordinal));
    }

    // ---- Stop 2: a refusal never leaves the module reserved -----------------------------------------------------------

    [Fact]
    public void Stop2_AContentRefusalFreesTheModuleForTheNextDelivery()
    {
        var studio = Studio(fingerprint: true);
        studio.AfterMerge = live => Edit(live, model =>
        {
            foreach (var action in Actions(model, "Refused")) action.Delete();
        });
        var refused = Deliver(studio, Action("Refused"));
        Assert.Equal("MERGE_CONTENT_MISMATCH", refused["code"]?.ToString());
        studio.AfterMerge = null;
        var next = Deliver(studio, Action("Next"));
        Assert.True(next["delivered"]?.GetValue<bool>() == true, next["error"]?.ToString());
        Assert.Equal(refused["taskId"]?.ToString(), next["previousClosed"]?["taskId"]?.ToString());
        Assert.Null(ReservationOwner());
    }

    [Fact]
    public void Stop2_AnEarlierTaskThatEndedRefusedIsClosedByTheNextDelivery()
    {
        // A merge refused after it applied (new TrueChange errors) ends the task with the module reserved, as the stuck
        // ProdSSAM_CS task did. The next delivery closes it with the module's content as it is and merges.
        var studio = Studio(fingerprint: true);
        studio.NewErrorsOnce = true;
        var refused = Deliver(studio, Action("FirstTry"));
        Assert.False(refused["delivered"]?.GetValue<bool>() == true);
        Assert.Equal("applied", refused["writeState"]?.ToString());
        var holder = refused["taskId"]!.ToString();
        Assert.Equal(holder, ReservationOwner());
        var next = Deliver(studio, Action("SecondTry"));
        Assert.True(next["delivered"]?.GetValue<bool>() == true, next["error"]?.ToString());
        Assert.Equal(holder, next["previousClosed"]?["taskId"]?.ToString());
        var closed = DurableJson.Read(Path.Combine(studio.Work, "deliver", holder, "task.json"));
        Assert.True(closed["closed"]?.GetValue<bool>() == true);
        Assert.Null(ReservationOwner());
    }

    private static List<IObjectSignature> Objects(ESpace model)
    {
        var all = new List<IObjectSignature>(); var pending = new Stack<IObjectSignature>(); pending.Push((IObjectSignature)model);
        while (pending.TryPop(out var node))
        {
            all.Add(node);
            if (node is ServiceStudio.Model.Interfaces.ITopLevelReferenceElement) continue;
            foreach (var child in node.Children.OfType<IObjectSignature>()) pending.Push(child);
        }
        return all;
    }
    /// <summary>The server actions of that name (by kind name: the Model API's action type, never a node that calls it).</summary>
    private static List<IObjectSignature> Actions(ESpace model, string name)
        => Objects(model).Where(o => ModelHost.Prop(o, "Name")?.ToString() == name && o.GetType().Name.EndsWith("Action", StringComparison.Ordinal)).ToList();


    // ---- 2a: a write never sent never holds the module (production 2026-11-02, task c150…) ---------------------------

    /// <summary>A run killed during its capture: the task is registered, has the module's identity and reserved it, its
    /// write was never sent and no failure was recorded (the finally that frees the reservation never ran).</summary>
    private static string KilledDuringCapture(FakeStudio studio)
    {
        var job = Path.Combine(studio.Work, "killed.json"); File.WriteAllText(job, Action("NeverSent"));
        string id;
        using (var task = new DeliveryTask(new DeliveryRequest("Headless_CS", job, studio.Work, Array.Empty<string>())))
        {
            id = task.Id; task.State["moduleKey"] = "module"; task.State["environment"] = "dev"; task.Save("snapshot");
        }
        using (new ModuleReservation(Path.Combine(BridgeAccess.DirectoryPath, "reservations"), "dev", "module", id)) { }
        return id;
    }

    [Fact]
    public void Stop2a_ANotSentTaskKilledDuringItsCaptureNeverStopsTheNextDelivery()
    {
        var studio = Studio(fingerprint: true);
        var holder = KilledDuringCapture(studio);
        Assert.Equal(holder, ReservationOwner());
        var next = Deliver(studio, Action("AfterTheKill"));
        Assert.True(next["delivered"]?.GetValue<bool>() == true, next["error"]?.ToString());
        Assert.Equal(holder, next["previousClosed"]?["taskId"]?.ToString());
        Assert.Null(ReservationOwner());
    }

    [Fact]
    public void Stop2a_ANotSentTaskWithoutARecordedFailureCloses()
    {
        var studio = Studio(fingerprint: true);
        var holder = KilledDuringCapture(studio);
        var closed = DeliveryTask.CloseKnownFailure(studio.Work, holder, "the write was never sent", studio);
        Assert.True(closed["closed"]?.GetValue<bool>() == true);
        Assert.Null(ReservationOwner());
    }

    [Fact]
    public void Stop2_AChecksFailureAfterTheMergeIsSettledByTheNextDelivery()
    {
        // PROVA-HOSPEDADA O1: a requested check that fails after the merge applied ends the task with the module reserved.
        var studio = Studio(fingerprint: true);
        var job = Path.Combine(studio.Work, "checked.json"); File.WriteAllText(job, Action("Checked"));
        Anvil.Core.Delivery.DeliveryRequest request = new("Headless_CS", job, studio.Work, new[] { "NoSuchElement" });
        JsonObject refused;
        lock (Serial)
            refused = Delivery.Run(studio, request,
                (basePath, jobPath, output) => JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(Path.GetDirectoryName(output)!, "model")), basePath, jobPath, output))!.AsObject(),
                inspectData: (snapshot, assertions) => new ModelHost(Path.Combine(Path.GetDirectoryName(snapshot)!, "proof-model")).CheckDataContract(snapshot, assertions),
                mergePlanner: new MergePlanner(directory => new ModelHost(Path.Combine(directory, "order-model"))));
        Assert.False(refused["delivered"]?.GetValue<bool>() == true);
        Assert.Equal("applied", refused["writeState"]?.ToString());
        Assert.Contains(refused["failures"]!.AsArray(), f => f!["stage"]?.ToString() == "checks");
        var holder = refused["taskId"]!.ToString();
        Assert.Equal(holder, ReservationOwner());
        var next = Deliver(studio, Action("AfterTheChecks"));
        Assert.True(next["delivered"]?.GetValue<bool>() == true, next["error"]?.ToString());
        Assert.Equal(holder, next["previousClosed"]?["taskId"]?.ToString());
        Assert.Null(ReservationOwner());
    }

    [Fact]
    public void Stop1_TheSameElementEditedByBothIsSaidInANote()
    {
        // The job sets one property of an action; the person edits another property of the same action meanwhile.
        var studio = Studio(fingerprint: true);
        Apply(studio.Live, Action("Both"));
        studio.AfterBaseSnapshot = live => Edit(live, model => { foreach (var a in Actions(model, "Both")) a.GetType().GetProperty("Description")!.SetValue(a, "the person's text"); });
        var result = Deliver(studio, """{"ops":[{"op":"set","target":"ServerAction:Both","prop":"Public","value":true}]}""");
        Assert.True(result["delivered"]?.GetValue<bool>() == true, result["code"] + " " + result["error"] + " " + result["contentProof"]?["differences"]?.ToJsonString());
        // The Studio's merge treats both edits of one element as a conflict and keeps the person's side: the delivery merges again.
        Assert.Contains(Notes(result), n => n.Contains("the same element", StringComparison.Ordinal));
        Assert.Equal("the person's text", DescriptionOf(studio.Live, "Both"));
    }
    // ---- Harness ---------------------------------------------------------------------------------------------------------

    private static IEnumerable<string> Notes(JsonObject result) => (result["mergeNotes"] as JsonArray ?? []).Select(n => n?.ToString() ?? "");

    private static string? ReservationOwner()
    {
        var directory = Path.Combine(BridgeAccess.DirectoryPath, "reservations");
        var file = Path.Combine(directory, DurableJson.Hash("dev\n" + "module") + ".json");
        return File.Exists(file) ? DurableJson.Read(file)["owner"]?.ToString() : null;
    }

    private static bool Has(string path, string action)
    {
        var host = new ModelHost(Path.Combine(Path.GetDirectoryName(path)!, "has-" + Guid.NewGuid().ToString("N")[..8]));
        var model = host.Load(File.ReadAllBytes(path));
        try { return Actions(model, action).Count > 0; }
        finally { ModelHost.Release(model); }
    }

    private static string Root => JobRunner.RepoRoot(Path.GetDirectoryName(typeof(ProgramTogetherTests).Assembly.Location)!)!;
    private static string Work()
    {
        var work = Path.Combine(Root, ".local", "program-together-tests", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        return work;
    }

    private static FakeStudio Studio(bool fingerprint)
    {
        StudioAssemblies.Bind();
        var work = Work();
        var live = Path.Combine(work, "live.oml"); File.Copy(Path.Combine(Root, "tests", "fixtures", "blank-service.oml"), live);
        // Each test owns its module reservation: the store of the reservations is the process's, so start free.
        var reservation = Path.Combine(Path.Combine(BridgeAccess.DirectoryPath, "reservations"), DurableJson.Hash("dev\n" + "module") + ".json");
        if (File.Exists(reservation)) { var held = DurableJson.Read(reservation); held["owner"] = null; DurableJson.Write(reservation, held); }
        var studio = new FakeStudio(new ModelHost(Path.Combine(work, "model")), live, work);
        if (fingerprint) studio.Capabilities.Add(Fingerprint);
        return studio;
    }

    private static readonly object Serial = new();
    private static JsonObject Deliver(FakeStudio studio, string jobText)
    {
        lock (Serial)
        {
            var job = Path.Combine(studio.Work, "job-" + Guid.NewGuid().ToString("N")[..8] + ".json"); File.WriteAllText(job, jobText);
            var result = Delivery.Run(studio, new("Headless_CS", job, studio.Work, Array.Empty<string>()),
                (basePath, jobPath, output) => JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(Path.GetDirectoryName(output)!, "model")), basePath, jobPath, output))!.AsObject(),
                inspectData: (snapshot, assertions) => new ModelHost(Path.Combine(Path.GetDirectoryName(snapshot)!, "proof-model")).CheckDataContract(snapshot, assertions),
                mergePlanner: new MergePlanner(directory => new ModelHost(Path.Combine(directory, "order-model"))));
            File.WriteAllText(Path.Combine(studio.Work, "delivery-result-" + Guid.NewGuid().ToString("N")[..6] + ".json"), result.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
            return result;
        }
    }

    /// <summary>Applies a job to an OML in place (a person's edit in the Studio).</summary>
    private static void Apply(string path, string jobText)
    {
        var dir = Path.Combine(Path.GetDirectoryName(path)!, "edit-" + Guid.NewGuid().ToString("N")[..8]); Directory.CreateDirectory(dir);
        var job = Path.Combine(dir, "edit.json"); File.WriteAllText(job, jobText);
        var output = Path.Combine(dir, "edited.oml");
        var applied = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "model")), path, job, output))!;
        Assert.True(applied["accepted"]!.GetValue<bool>(), applied.ToJsonString());
        File.Copy(output, path, true);
    }

    /// <summary>Edits an OML in place through the Model API, in one command (a person's edit in the Studio).</summary>
    private static void Edit(string path, Action<ESpace> edit)
    {
        var host = new ModelHost(Path.Combine(Path.GetDirectoryName(path)!, "edit-model-" + Guid.NewGuid().ToString("N")[..8]));
        var model = host.Load(File.ReadAllBytes(path));
        try
        {
            StudioAdapter.Runtime.Mutate(model, "test: the person's edit in the Studio", _ => edit(model));
            File.WriteAllBytes(path, host.Save(model));
        }
        finally { ModelHost.Release(model); }
    }

    /// <summary>The Studio boundary: the open module is a file (environment "dev", key "module"). merge_from_oml runs the
    /// Studio's MatchTree headless; AfterBaseSnapshot edits the open module once, right after the delivery's capture;
    /// AfterMerge edits it after each merge; NewErrorsOnce makes the first verification report a new error; OtherTabAtSnapshot
    /// makes that snapshot (1-based count) answer another module's tab once.</summary>
    private sealed class FakeStudio(ModelHost host, string live, string work) : IBridgeClient
    {
        public ModelHost Host { get; } = host;
        public string Live { get; } = live;
        public string Work { get; } = work;
        public List<string> Capabilities { get; } = ["publish_log", Delivery.MergeOrderCapability];
        public Action<string>? AfterBaseSnapshot { get; set; }
        public Action<string>? AfterMerge { get; set; }
        public bool NewErrorsOnce { get; set; }
        public int OtherTabAtSnapshot { get; set; }
        public bool SignatureConflictOnce { get; set; }
        private int snapshots;
        private bool baseEdited;
        public JsonObject Call(string method, JsonObject? parameters = null)
        {
            switch (method)
            {
                case "bridge_manifest": return new() { ["protocolVersion"] = 2, ["capabilities"] = new JsonArray(Capabilities.Select(c => (JsonNode)c).ToArray()) };
                case "open_module": return new() { ["opened"] = true };
                case "ping": return new() { ["pid"] = 4242 };
                case "get_active_module": return new() { ["name"] = "Headless_CS", ["key"] = "module", ["environment"] = "dev" };
                case "list_open_modules":
                    var row = new JsonObject { ["name"] = "Headless_CS", ["key"] = "module", ["environment"] = "dev", ["hasOpenedActiveESpace"] = true, ["serverSilentMode"] = false };
                    if (parameters?["model_sha256_of"] != null && Capabilities.Contains(Fingerprint)) row["modelSha256"] = PrebuiltCandidate.ModelSha256(Live);
                    return new() { ["modules"] = new JsonArray(row) };
                case "snapshot_module":
                    snapshots++;
                    if (OtherTabAtSnapshot == snapshots) { OtherTabAtSnapshot = 0; return new() { ["key"] = "other", ["name"] = "OtherModule", ["snapshot_id"] = Guid.NewGuid().ToString("N"), ["baseline"] = new JsonArray() }; }
                    File.Copy(Live, parameters!["path"]!.ToString(), true);
                    if (!baseEdited) { baseEdited = true; AfterBaseSnapshot?.Invoke(Live); }
                    return new() { ["key"] = "module", ["name"] = "Headless_CS", ["snapshot_id"] = Guid.NewGuid().ToString("N"), ["baseline"] = new JsonArray(), ["sha256"] = DeliveryReceipt.Hash(Live) };
                case "merge_from_oml":
                    var path = parameters!["first_pass_path"]?.ToString();
                    // As the real bridge (Anvil.Bridge MergeHandler, mode auto): a MatchTree with conflicts, or a producer signature
                    // changed concurrently, merges nothing and says why.
                    if (SignatureConflictOnce) { SignatureConflictOnce = false;
                        return new() { ["merged"] = false, ["hasConflicts"] = true, ["newErrors"] = 0, ["reason"] = "producer signature changed concurrently: review referenceSignatures before retrying" }; }
                    var merging = Path.Combine(Work, "merging-" + Guid.NewGuid().ToString("N")[..8] + ".oml");
                    var replay = MergeProbe.Replay(Host, File.ReadAllBytes(Live), File.ReadAllBytes(parameters["base_path"]!.ToString()),
                        File.ReadAllBytes(parameters["foreign_path"]!.ToString()), path == null ? null : File.ReadAllBytes(path), merging);
                    if (replay.HasConflicts)
                        return new() { ["merged"] = false, ["hasConflicts"] = true, ["newErrors"] = 0, ["reason"] = "conflicts: use mode=dialog" };
                    File.Copy(merging, Live, true);
                    AfterMerge?.Invoke(Live);
                    return new() { ["merged"] = true, ["result"] = "Merge", ["hasConflicts"] = false, ["newErrors"] = 0,
                        ["mergeOrder"] = path != null ? new JsonObject { ["passes"] = 2 } : null, ["secondPass"] = path != null ? new JsonObject { ["merged"] = true } : null };
                case "find_element": return new() { ["count"] = 0, ["matches"] = new JsonArray() };
                case "get_errors":
                    var errors = NewErrorsOnce ? 1 : 0; NewErrorsOnce = false;
                    return errors > 0 ? new() { ["newErrors"] = errors, ["new"] = new JsonArray() } : new() { ["newErrors"] = 0, ["new"] = new JsonArray(), ["rawMessages"] = new JsonArray() };
                default: throw new InvalidOperationException("unexpected bridge call " + method);
            }
        }
    }
}
