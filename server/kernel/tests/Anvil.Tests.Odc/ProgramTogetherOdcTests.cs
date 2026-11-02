using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using OutSystems.Model;
using OutSystems.Model.Merge;
using ServiceStudio.Model;
using Xunit;
using IExpression = OutSystems.Model.Expressions.IExpression;

namespace Anvil.Tests.Odc;

/// <summary>
/// F1c A6 (review REVISAO-F1): the F1 behaviour end to end on the ODC kernel, the cases ProgramTogetherTests proves on O11.
/// Delivery.Run of the ODC kernel, the real ODC job apply, the real MergePlanner (its disposable ODC merge preview) and
/// content proof, and a Studio whose merge_from_oml is the ODC Studio's own MatchTree run headless (as NativeMergePreview
/// and the ODC bridge merge), with the real Verify of the open module. The "person" edits the open module between the
/// delivery's capture and its write (AfterBaseSnapshot) or right after the merge (AfterMerge).
/// Scope: the kernel half of the ODC lane (Delivery, MergePlanner, MergeContentProof, MergeErrorAttribution over the ODC model
/// and MatchTree). The ODC facade's own merge path (kernel-delivery.mjs and the bridge's NativeMergeVerification) is not run.
/// </summary>
public class ProgramTogetherOdcTests
{
    private const string ModuleKey = "module-odc-f1c";
    private static string Action(string name) => """{"ops":[{"op":"logic","data":{"actions":[{"name":"NAME","kind":"server","outputs":[{"name":"Out","type":"Integer"}],"steps":[{"assign":{"Out":"1"}}]}]}}]}""".Replace("NAME", name);

    [Fact]
    public void Stop1_FlowNodesTheStudioMovedInTheMergeAreANoteNotAMismatch() { if (Available()) RunPositions(); }

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static void RunPositions()
    {
        var studio = Studio();
        studio.AfterMerge = live => Edit(live, model =>
        {
            // Every flow node of the module moves on the canvas (the positions, by their Model API properties).
            foreach (var node in Objects(model))
                foreach (var (name, by) in new[] { ("HorizontalPosition", 40), ("VerticalPosition", 25) })
                    if (new[] { node.GetType() }.Concat(node.GetType().GetInterfaces()).Select(t => t.GetProperty(name)).FirstOrDefault(p => p is { CanWrite: true } && p.PropertyType == typeof(int)) is { } p)
                        p.SetValue(node, (int)p.GetValue(node)! + by);
        });
        var result = Deliver(studio, Action("EditTaskComment"));
        Assert.True(result["delivered"]?.GetValue<bool>() == true, result["error"]?.ToString() + " " + result["contentProof"]?["differences"]?.ToJsonString());
        Assert.Contains(Notes(result), n => n.Contains("editor-state", StringComparison.Ordinal));
    }

    [Fact]
    public void Stop1_AnActionThePersonCreatedWhileTheDeliveryRanIsKeptAndNoted() { if (Available()) RunPersonsAction(); }

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static void RunPersonsAction()
    {
        var studio = Studio();
        studio.AfterBaseSnapshot = live => Apply(live, Action("PersonsOwnAction"));
        var result = Deliver(studio, Action("DeliveredAction"));
        Assert.True(result["delivered"]?.GetValue<bool>() == true, result["error"]?.ToString() + " " + result["contentProof"]?["differences"]?.ToJsonString());
        Assert.Contains(Notes(result), n => n.Contains("did not write", StringComparison.Ordinal));
        Assert.True(Has(studio.Live, "PersonsOwnAction") && Has(studio.Live, "DeliveredAction"));
    }

    [Fact]
    public void Stop1_AnElementTheJobWroteMissingAfterTheMergeStillRefuses() { if (Available()) RunLoss(); }

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static void RunLoss()
    {
        var studio = Studio();
        studio.AfterMerge = live => Edit(live, model => { foreach (var action in Actions(model, "LostAction")) action.Delete(); });
        var result = Deliver(studio, Action("LostAction"));
        Assert.False(result["delivered"]?.GetValue<bool>() == true);
        Assert.Equal("MERGE_CONTENT_MISMATCH", result["code"]?.ToString());
        // Stop 2 on ODC: the refusal never leaves the module reserved for the next delivery.
        studio.AfterMerge = null;
        var next = Deliver(studio, Action("AfterTheLoss"));
        Assert.True(next["delivered"]?.GetValue<bool>() == true, next["error"]?.ToString());
        Assert.Equal(result["taskId"]?.ToString(), next["previousClosed"]?["taskId"]?.ToString());
        Assert.Contains(next["previousClosed"]!["inherited"]!["elements"]!.AsArray(), e => e!.ToString().Contains("LostAction", StringComparison.Ordinal));
    }

    [Fact]
    public void A2_AnErrorInAnActionThePersonIsWritingIsANoteNotARefusal() { if (Available()) RunPersonsDraft(); }

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static void RunPersonsDraft()
    {
        var studio = Studio();
        studio.AfterBaseSnapshot = live => { Apply(live, Action("PersonsDraft")); Break(live, "PersonsDraft"); };
        var result = Deliver(studio, Action("DeliveredAction"));
        Assert.True(result["delivered"]?.GetValue<bool>() == true, result["error"]?.ToString() + " " + result["errorAttribution"]?.ToJsonString() + " " + result["errorAttributionError"]);
        Assert.Contains(result["errorsOutsideDelivery"]!["errors"]!.AsArray(), e => e!["element"]!.ToString().Contains("PersonsDraft", StringComparison.Ordinal));
        Assert.Contains(Notes(result), n => n.Contains("edit in progress", StringComparison.Ordinal));
    }

    [Fact]
    public void A2_AnErrorOnAnElementTheDeliveryWroteStillRefuses() { if (Available()) RunOwnError(); }

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static void RunOwnError()
    {
        var studio = Studio();
        studio.AfterMerge = live => Break(live, "Broken");
        var result = Deliver(studio, Action("Broken"));
        Assert.False(result["delivered"]?.GetValue<bool>() == true);
        Assert.True(result["validation"]!["newErrors"]!.GetValue<int>() > 0, result.ToJsonString());
        Assert.Null(result["errorsOutsideDelivery"]);
    }

    [Fact]
    public void A6_ANotSentTaskWhoseRunIsAliveIsNeverClosedByTheNextDelivery() { if (Available()) RunAliveOwner(); }

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static void RunAliveOwner()
    {
        var studio = Studio();
        var job = Path.Combine(studio.Work, "running.json"); File.WriteAllText(job, Action("NeverSent"));
        string holder;
        using (var task = new DeliveryTask(new DeliveryRequest("Headless", job, studio.Work, Array.Empty<string>())))
        {
            holder = task.Id; task.State["moduleKey"] = ModuleKey; task.State["environment"] = "dev"; task.Save("snapshot");
        }
        using (new ModuleReservation(Path.Combine(BridgeAccess.DirectoryPath, "reservations"), "dev", ModuleKey, holder)) { }
        using (DurableJson.Lease(Path.Combine(studio.Work, "deliver", holder, "run.lock")))
        {
            JsonObject? next;
            try { next = Deliver(studio, Action("WhileItRuns")); } catch (Exception ex) when (ex is InvalidOperationException or IOException) { next = null; }
            Assert.False(next?["delivered"]?.GetValue<bool>() == true);
            Assert.Null(next?["previousClosed"]);
        }
        Assert.NotEqual(true, DurableJson.Read(Path.Combine(studio.Work, "deliver", holder, "task.json"))["closed"]?.GetValue<bool>());
        Assert.Equal(holder, ReservationOwner());
    }

    // ---- Harness ---------------------------------------------------------------------------------------------------------

    private static bool Available() { try { StudioAssembliesOdc.Bind(); return true; } catch { return false; } }

    private static void Break(string live, string action) => Edit(live, model =>
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

    private static IEnumerable<string> Notes(JsonObject result) => (result["mergeNotes"] as JsonArray ?? []).Select(n => n?.ToString() ?? "");

    private static string? ReservationOwner()
    {
        var file = Path.Combine(BridgeAccess.DirectoryPath, "reservations", DurableJson.Hash("dev\n" + ModuleKey) + ".json");
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

    private static List<IObjectSignature> Actions(ESpace model, string name)
        => Objects(model).Where(o => ModelHost.Prop(o, "Name")?.ToString() == name && o.GetType().Name.EndsWith("Action", StringComparison.Ordinal)).ToList();

    private static bool Has(string path, string action)
    {
        var host = new ModelHost(Path.Combine(Path.GetDirectoryName(path)!, "has-" + Guid.NewGuid().ToString("N")[..8]));
        var model = host.Load(File.ReadAllBytes(path));
        try { return Actions(model, action).Count > 0; }
        finally { ModelHost.Release(model); }
    }

    private static string Root { get { var d = Path.GetDirectoryName(typeof(ProgramTogetherOdcTests).Assembly.Location); while (d != null && !File.Exists(Path.Combine(d, "MANIFESTO.md"))) d = Path.GetDirectoryName(d); return d!; } }

    private static OdcStudio Studio()
    {
        var work = Path.Combine(Root, ".local", "lane-odc", "program-together-odc-tests", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        var live = Path.Combine(work, "live.oml"); File.Copy(Path.Combine(Root, "tests", "fixtures", "odc", "blank-mobile.oml"), live);
        var reservation = Path.Combine(BridgeAccess.DirectoryPath, "reservations", DurableJson.Hash("dev\n" + ModuleKey) + ".json");
        if (File.Exists(reservation)) { var held = DurableJson.Read(reservation); held["owner"] = null; DurableJson.Write(reservation, held); }
        var studio = new OdcStudio(new ModelHost(Path.Combine(work, "model")), live, work);
        studio.Capabilities.Add("list_open_modules:model_sha256");
        return studio;
    }

    private static readonly object Serial = new();
    private static JsonObject Deliver(OdcStudio studio, string jobText)
    {
        lock (Serial)
        {
            var job = Path.Combine(studio.Work, "job-" + Guid.NewGuid().ToString("N")[..8] + ".json"); File.WriteAllText(job, jobText);
            var result = Delivery.Run(studio, new("Headless", job, studio.Work, Array.Empty<string>()),
                (basePath, jobPath, output) => JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(Path.GetDirectoryName(output)!, "model")), basePath, jobPath, output))!.AsObject(),
                inspectData: (snapshot, assertions) => new ModelHost(Path.Combine(Path.GetDirectoryName(snapshot)!, "proof-model")).CheckDataContract(snapshot, assertions),
                mergePlanner: new MergePlanner(directory => new ModelHost(Path.Combine(directory, "order-model"))));
            File.WriteAllText(Path.Combine(studio.Work, "delivery-result-" + Guid.NewGuid().ToString("N")[..6] + ".json"), result.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
            return result;
        }
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

    /// <summary>The ODC Studio boundary: the open module is a file; merge_from_oml is the ODC MatchTree headless (the first
    /// pass, then the candidate over the module after it, as NativeMergePreview and the bridge's merge order); the Verify is
    /// the real one of the open module.</summary>
    private sealed class OdcStudio(ModelHost host, string live, string work) : IBridgeClient
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

        private void Merge(byte[] foreignBytes, byte[] baseBytes)
        {
            ESpace? local = null, foreign = null, over = null;
            try
            {
                local = Host.Load(File.ReadAllBytes(Live)); foreign = Host.Load(foreignBytes); over = Host.Load(baseBytes);
                var conflicts = false;
                StudioAdapter.Runtime.Mutate(local, "test: ODC native merge", _ =>
                {
                    using var tree = new MatchTree(local, foreign, over, false, true);
                    conflicts = tree.HasConflicts;
                    if (!conflicts) tree.Merge();
                });
                Assert.False(conflicts, "the ODC MatchTree reported conflicts");
                File.WriteAllBytes(Live, Host.Save(local));
            }
            finally { ModelHost.Release(local); ModelHost.Release(foreign); ModelHost.Release(over); }
        }

        public JsonObject Call(string method, JsonObject? parameters = null)
        {
            switch (method)
            {
                case "bridge_manifest": return new() { ["protocolVersion"] = 2, ["capabilities"] = new JsonArray(Capabilities.Select(c => (JsonNode)c).ToArray()) };
                case "open_module": return new() { ["opened"] = true };
                case "ping": return new() { ["pid"] = 4343 };
                case "get_active_module": return new() { ["name"] = "Headless", ["key"] = ModuleKey, ["environment"] = "dev" };
                case "list_open_modules":
                    var row = new JsonObject { ["name"] = "Headless", ["key"] = ModuleKey, ["environment"] = "dev", ["hasOpenedActiveESpace"] = true, ["serverSilentMode"] = false };
                    if (parameters?["model_sha256_of"] != null) row["modelSha256"] = PrebuiltCandidate.ModelSha256(Live);
                    return new() { ["modules"] = new JsonArray(row) };
                case "snapshot_module":
                    File.Copy(Live, parameters!["path"]!.ToString(), true);
                    var baseline = Messages();
                    if (!baseEdited) { baseEdited = true; AfterBaseSnapshot?.Invoke(Live); }
                    return new() { ["key"] = ModuleKey, ["name"] = "Headless", ["snapshot_id"] = Guid.NewGuid().ToString("N"), ["baseline"] = baseline, ["sha256"] = DeliveryReceipt.Hash(Live) };
                case "merge_from_oml":
                    var firstPass = parameters!["first_pass_path"]?.ToString();
                    var basis = File.ReadAllBytes(parameters["base_path"]!.ToString());
                    var candidate = File.ReadAllBytes(parameters["foreign_path"]!.ToString());
                    if (firstPass != null) { Merge(File.ReadAllBytes(firstPass), basis); Merge(candidate, File.ReadAllBytes(Live)); }
                    else Merge(candidate, basis);
                    AfterMerge?.Invoke(Live);
                    return new() { ["merged"] = true, ["result"] = "Merge", ["hasConflicts"] = false, ["newErrors"] = 0,
                        ["mergeOrder"] = firstPass != null ? new JsonObject { ["passes"] = 2 } : null, ["secondPass"] = firstPass != null ? new JsonObject { ["merged"] = true } : null };
                case "get_errors": return new() { ["rawMessages"] = Messages(), ["settled"] = true };
                default: throw new InvalidOperationException("unexpected bridge call " + method);
            }
        }
    }
}
