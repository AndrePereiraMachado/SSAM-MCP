using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using OutSystems.Model;
using ServiceStudio.Model;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// F1c (owner 2026-11-02, "o ssam deve permitir que o usuario programe junto com ele"): review items A2, A4 and A6 of
/// REVISAO-F1, end to end as ProgramTogetherTests: Delivery.Run, the real job apply, planner and content proof, and a Studio
/// whose merge_from_oml is the Studio's own MatchTree run headless. This Studio also runs the real Verify (TrueChange) of the
/// open module: the capture's baseline and get_errors are ModelHost.Messages of the module at that moment, with their owner
/// keys, as the bridge reads them. The "person" edits the open module right after the delivery's capture (AfterBaseSnapshot)
/// or right after the merge (AfterMerge).
/// </summary>
public class ProgramTogetherF1cTests
{
    private static string Action(string name, string value = "1") => """{"ops":[{"op":"logic","data":{"actions":[{"name":"NAME","kind":"server","outputs":[{"name":"Out","type":"Integer"}],"steps":[{"assign":{"Out":"VALUE"}}]}]}}]}""".Replace("NAME", name).Replace("VALUE", value);

    // ---- A2: an error the person is typing never refuses the delivery ---------------------------------------------------

    [Fact]
    public void A2_AnErrorInAnActionThePersonIsWritingIsANoteNotARefusal()
    {
        // The person writes an action of their own while the delivery runs and is in the middle of its expression.
        var studio = Studio();
        studio.AfterBaseSnapshot = live => { Apply(live, Action("PersonsDraft")); Break(live, "PersonsDraft"); };
        var result = Deliver(studio, Action("DeliveredAction"));
        Assert.True(result["delivered"]?.GetValue<bool>() == true, result["error"]?.ToString() + " " + result["errorAttribution"]?.ToJsonString() + " " + result["errorAttributionError"]);
        Assert.True(result["errorsOutsideDelivery"]!["total"]!.GetValue<int>() >= 1);
        Assert.Contains(result["errorsOutsideDelivery"]!["errors"]!.AsArray(), e => e!["element"]!.ToString().Contains("PersonsDraft", StringComparison.Ordinal));
        Assert.Contains(Notes(result), n => n.Contains("edit in progress", StringComparison.Ordinal) && n.Contains("PersonsDraft", StringComparison.Ordinal));
        Assert.Equal(0, result["newErrors"]!.GetValue<int>());
        Assert.True(Has(studio.Live, "PersonsDraft") && Has(studio.Live, "DeliveredAction"));
    }

    [Fact]
    public void A2_AnErrorOnAnElementTheDeliveryWroteStillRefuses()
    {
        // The guard: the delivery's own action has a new error after the merge; it refuses, nothing is a note.
        var studio = Studio();
        studio.AfterMerge = live => Break(live, "Broken");
        var result = Deliver(studio, Action("Broken"));
        Assert.False(result["delivered"]?.GetValue<bool>() == true);
        Assert.True(result["validation"]!["newErrors"]!.GetValue<int>() > 0, result.ToJsonString());
        Assert.Null(result["errorsOutsideDelivery"]);
    }

    // ---- A4: what the closed refused task left in the module is said by element -----------------------------------------

    [Fact]
    public void A4_TheNextDeliveryNamesTheErrorsAndElementsTheClosedTaskLeftInTheModule()
    {
        var studio = Studio();
        studio.AfterMerge = live => Break(live, "FirstTry");
        var refused = Deliver(studio, Action("FirstTry"));
        Assert.False(refused["delivered"]?.GetValue<bool>() == true);
        studio.AfterMerge = null;
        var next = Deliver(studio, Action("SecondTry"));
        Assert.True(next["delivered"]?.GetValue<bool>() == true, next["error"]?.ToString());
        var closed = next["previousClosed"]!;
        Assert.Equal(refused["taskId"]?.ToString(), closed["taskId"]?.ToString());
        var inherited = closed["inherited"] ?? throw new Xunit.Sdk.XunitException("previousClosed has no inherited: " + closed.ToJsonString());
        Assert.True(inherited["newErrors"]!.GetValue<int>() >= 1);
        Assert.Contains(inherited["errors"]!.AsArray(), e => e!.ToString().Contains("FirstTry", StringComparison.Ordinal));
        Assert.Contains(inherited["elements"]!.AsArray(), e => e!.ToString().Contains("FirstTry", StringComparison.Ordinal));
        Assert.Contains("not new for it", closed["note"]!.ToString(), StringComparison.Ordinal);
    }

    // ---- A6 (e): the next delivery never closes a task whose owner is still alive ---------------------------------------

    [Fact]
    public void A6_ANotSentTaskWhoseRunIsAliveIsNeverClosedByTheNextDelivery()
    {
        var studio = Studio();
        var holder = NotSentHolder(studio);
        // Its process still runs it: the run lease is held.
        using (DurableJson.Lease(Path.Combine(studio.Work, "deliver", holder, "run.lock")))
        {
            var next = TryDeliver(studio, Action("WhileItRuns"));
            Assert.False(next?["delivered"]?.GetValue<bool>() == true);
            Assert.Null(next?["previousClosed"]);
        }
        var state = DurableJson.Read(Path.Combine(studio.Work, "deliver", holder, "task.json"));
        Assert.NotEqual(true, state["closed"]?.GetValue<bool>());
        Assert.Equal(holder, ReservationOwner());
    }

    [Fact]
    public void A6_ARefusedTaskWhoseRunIsAliveIsNeverClosedByTheNextDelivery()
    {
        // A refused applied task (new errors) whose process has not ended (it still holds its run lease, e.g. a resume running).
        var studio = Studio();
        studio.AfterMerge = live => Break(live, "StillRunning");
        var refused = Deliver(studio, Action("StillRunning"));
        var holder = refused["taskId"]!.ToString();
        Assert.Equal(holder, ReservationOwner());
        studio.AfterMerge = null;
        using (DurableJson.Lease(Path.Combine(studio.Work, "deliver", holder, "run.lock")))
        {
            var next = TryDeliver(studio, Action("Meanwhile"));
            Assert.False(next?["delivered"]?.GetValue<bool>() == true);
            Assert.Null(next?["previousClosed"]);
        }
        Assert.NotEqual(true, DurableJson.Read(Path.Combine(studio.Work, "deliver", holder, "task.json"))["closed"]?.GetValue<bool>());
        Assert.Equal(holder, ReservationOwner());
    }

    // ---- Harness ---------------------------------------------------------------------------------------------------------

    /// <summary>The person's expression in progress: every "1" of the action becomes a name that does not exist.</summary>
    internal static void Break(string live, string action) => Edit(live, model =>
    {
        foreach (var node in Objects(model).Where(o => Under(o, action)).OfType<IExpression>().Where(e => e.Text == "1").ToList())
            node.Text = "UndefinedName + 1";
    });

    private static bool Under(IObjectSignature node, string action)
    {
        for (var n = node; n != null; n = n.Parent as IObjectSignature)
            if (ModelHost.Prop(n, "Name")?.ToString() == action && n.GetType().Name.EndsWith("Action", StringComparison.Ordinal)) return true;
        return false;
    }

    private static string NotSentHolder(F1cStudio studio)
    {
        var job = Path.Combine(studio.Work, "running.json"); File.WriteAllText(job, Action("NeverSent"));
        string id;
        using (var task = new DeliveryTask(new DeliveryRequest("Headless_CS", job, studio.Work, Array.Empty<string>())))
        {
            id = task.Id; task.State["moduleKey"] = "module-f1c"; task.State["environment"] = "dev"; task.Save("snapshot");
        }
        using (new ModuleReservation(Path.Combine(BridgeAccess.DirectoryPath, "reservations"), "dev", "module-f1c", id)) { }
        Assert.Equal(id, ReservationOwner());
        return id;
    }

    private static IEnumerable<string> Notes(JsonObject result) => (result["mergeNotes"] as JsonArray ?? []).Select(n => n?.ToString() ?? "");

    private static string? ReservationOwner()
    {
        var file = Path.Combine(BridgeAccess.DirectoryPath, "reservations", DurableJson.Hash("dev\n" + "module-f1c") + ".json");
        return File.Exists(file) ? DurableJson.Read(file)["owner"]?.ToString() : null;
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

    private static bool Has(string path, string action)
    {
        var host = new ModelHost(Path.Combine(Path.GetDirectoryName(path)!, "has-" + Guid.NewGuid().ToString("N")[..8]));
        var model = host.Load(File.ReadAllBytes(path));
        try { return Objects(model).Any(o => ModelHost.Prop(o, "Name")?.ToString() == action && o.GetType().Name.EndsWith("Action", StringComparison.Ordinal)); }
        finally { ModelHost.Release(model); }
    }

    private static string Root => JobRunner.RepoRoot(Path.GetDirectoryName(typeof(ProgramTogetherF1cTests).Assembly.Location)!)!;

    private static F1cStudio Studio()
    {
        StudioAssemblies.Bind();
        var work = Path.Combine(Root, ".local", "program-together-f1c-tests", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        var live = Path.Combine(work, "live.oml"); File.Copy(Path.Combine(Root, "tests", "fixtures", "blank-service.oml"), live);
        var reservation = Path.Combine(BridgeAccess.DirectoryPath, "reservations", DurableJson.Hash("dev\n" + "module-f1c") + ".json");
        if (File.Exists(reservation)) { var held = DurableJson.Read(reservation); held["owner"] = null; DurableJson.Write(reservation, held); }
        var studio = new F1cStudio(new ModelHost(Path.Combine(work, "model")), live, work);
        studio.Capabilities.Add("list_open_modules:model_sha256");
        return studio;
    }

    /// <summary>The deliveries of this class run one at a time; its module key (module-f1c) is its own reservation.</summary>
    private static readonly object Serial = new();
    private static JsonObject Deliver(F1cStudio studio, string jobText)
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

    /// <summary>A delivery that may refuse by exception (the module reserved): its answer, or null when it threw.</summary>
    private static JsonObject? TryDeliver(F1cStudio studio, string jobText)
    {
        try { return Deliver(studio, jobText); }
        catch (Exception ex) when (ex is InvalidOperationException or IOException) { return null; }
    }

    private static void Apply(string path, string jobText)
    {
        var dir = Path.Combine(Path.GetDirectoryName(path)!, "edit-" + Guid.NewGuid().ToString("N")[..8]); Directory.CreateDirectory(dir);
        var job = Path.Combine(dir, "edit.json"); File.WriteAllText(job, jobText);
        var output = Path.Combine(dir, "edited.oml");
        var applied = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "model")), path, job, output))!;
        Assert.True(applied["accepted"]!.GetValue<bool>(), applied.ToJsonString());
        File.Copy(output, path, true);
    }

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

    /// <summary>The Studio boundary (as ProgramTogetherTests.FakeStudio), with the real Verify: the capture's baseline and
    /// get_errors are the messages of the open module at that moment.</summary>
    private sealed class F1cStudio(ModelHost host, string live, string work) : IBridgeClient
    {
        public ModelHost Host { get; } = host;
        public string Live { get; } = live;
        public string Work { get; } = work;
        public List<string> Capabilities { get; } = ["publish_log", Delivery.MergeOrderCapability];
        public Action<string>? AfterBaseSnapshot { get; set; }
        public Action<string>? AfterMerge { get; set; }
        private bool baseEdited;
        private JsonArray Messages()
            => JsonSerializer.SerializeToNode(new ModelHost(Path.Combine(Work, "verify-" + Guid.NewGuid().ToString("N")[..8])).MessagesFromOml(Live))!.AsArray();
        public JsonObject Call(string method, JsonObject? parameters = null)
        {
            switch (method)
            {
                case "bridge_manifest": return new() { ["protocolVersion"] = 2, ["capabilities"] = new JsonArray(Capabilities.Select(c => (JsonNode)c).ToArray()) };
                case "open_module": return new() { ["opened"] = true };
                case "ping": return new() { ["pid"] = 4242 };
                case "get_active_module": return new() { ["name"] = "Headless_CS", ["key"] = "module-f1c", ["environment"] = "dev" };
                case "list_open_modules":
                    var row = new JsonObject { ["name"] = "Headless_CS", ["key"] = "module-f1c", ["environment"] = "dev", ["hasOpenedActiveESpace"] = true, ["serverSilentMode"] = false };
                    if (parameters?["model_sha256_of"] != null) row["modelSha256"] = PrebuiltCandidate.ModelSha256(Live);
                    return new() { ["modules"] = new JsonArray(row) };
                case "snapshot_module":
                    File.Copy(Live, parameters!["path"]!.ToString(), true);
                    var baseline = Messages();
                    if (!baseEdited) { baseEdited = true; AfterBaseSnapshot?.Invoke(Live); }
                    return new() { ["key"] = "module-f1c", ["name"] = "Headless_CS", ["snapshot_id"] = Guid.NewGuid().ToString("N"), ["baseline"] = baseline, ["sha256"] = DeliveryReceipt.Hash(Live) };
                case "merge_from_oml":
                    var path = parameters!["first_pass_path"]?.ToString();
                    MergeProbe.Replay(Host, File.ReadAllBytes(Live), File.ReadAllBytes(parameters["base_path"]!.ToString()),
                        File.ReadAllBytes(parameters["foreign_path"]!.ToString()), path == null ? null : File.ReadAllBytes(path), Live);
                    AfterMerge?.Invoke(Live);
                    return new() { ["merged"] = true, ["result"] = "Merge", ["hasConflicts"] = false, ["newErrors"] = 0,
                        ["mergeOrder"] = path != null ? new JsonObject { ["passes"] = 2 } : null, ["secondPass"] = path != null ? new JsonObject { ["merged"] = true } : null };
                case "get_errors": return new() { ["rawMessages"] = Messages(), ["settled"] = true };
                default: throw new InvalidOperationException("unexpected bridge call " + method);
            }
        }
    }
}
