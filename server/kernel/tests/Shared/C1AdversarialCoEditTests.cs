using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using OutSystems.Model;
using ServiceStudio.Model;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// C1 adversarial co-editing suite (PLANO-11H, owner 2026-11-02, verbatim: "o mais importante de todos é nao deixar o ssam
/// travar por que o usuario estava programando junto.. isso é imperdoavel"). A "person" edits the open module while a
/// delivery runs: between the capture and the write (AfterCapture), inside the merge right before the Studio's MatchTree
/// (DuringMerge) and right after the merge, before the proof (AfterMerge). Each case asserts the owner's contract:
/// the delivery lands with the job's intention in the module, the person's edits are kept (or, on the same element, the
/// delivery's value wins and a note says it), no reservation is left held, and no manual step (resume, close, release) is
/// needed. The bridge is modeled on the real one (Anvil.Bridge/MergeHandler.cs Run): merge_from_oml mode=auto with a
/// MatchTree that has conflicts merges NOTHING and answers merged:false "conflicts: use mode=dialog"; every call names the
/// module by module_key (C41), and a key no open tab has refuses before anything runs (Studio.cs Target). Compiled into the
/// O11 (Anvil.Tests) and the ODC (Anvil.Tests.Odc) test projects: the lane is the Studio assemblies the project binds.
/// Runs with the line's Delivery.Run, JobRunner, MergePlanner and content proof; no Studio.
/// </summary>
public sealed class C1AdversarialCoEditTests
{
    // ---- The matrix ----------------------------------------------------------------------------------------------------

    public static readonly string[] Kinds = ["action", "entity", "structure", "role", "screen"];
    public static readonly string[] Edits = ["move", "same-element", "other-element", "add", "delete", "rename", "unsaved", "switch-module", "close-module", "studio-busy"];
    public static readonly string[] Timings = ["after-capture", "during-merge", "after-merge"];

    public static IEnumerable<object[]> Matrix()
    {
        foreach (var kind in Kinds)
            foreach (var edit in Edits)
                foreach (var timing in Timings)
                {
                    if (edit == "move" && kind != "action") continue;          // only flows have canvas positions here
                    yield return [kind, edit, timing];
                }
    }

    [Theory]
    [MemberData(nameof(Matrix))]
    public void PersonEditsWhileTheDeliveryRuns(string kind, string edit, string timing)
    {
        kindOfRun = kind;
        var studio = Studio();
        Seed(studio, kind);
        var hook = PersonEdit(studio, kind, edit);
        switch (timing)
        {
            case "after-capture": studio.AfterCapture = hook; break;
            case "during-merge": studio.DuringMerge = hook; break;
            default: studio.AfterMerge = hook; break;
        }
        var result = Deliver(studio, DeliveryJob(kind));
        List<string> verdict;
        if (edit == "close-module")
        {
            // The one refusal the owner allows ("recusa só se o usuário fechou o módulo"): the module was closed by the person.
            // Even then nothing is left held, and the same delivery once the module is open again lands without any other step.
            verdict = new List<string>();
            if (ReservationOwner() is { } held) verdict.Add("reservation left held by " + held + " after the person closed the module (" + Brief(result) + ")");
            if (result["delivered"]?.GetValue<bool>() != true)
            {
                studio.AfterCapture = studio.DuringMerge = studio.AfterMerge = null; studio.Closed = false;
                var again = Deliver(studio, DeliveryJob(kind));
                verdict.AddRange(Verdict(studio, kind, "none", again, timing).Select(p => "after reopening: " + p));
            }
            else verdict.AddRange(Verdict(studio, kind, "none", result, timing));
        }
        else verdict = Verdict(studio, kind, edit, result, timing);
        if (edit == "same-element" && timing != "after-merge" && result["delivered"]?.GetValue<bool>() != true && result["writeState"]?.ToString() == "not-applied")
        {
            // Evidence for the fix: nothing was written, so the same delivery again (a new capture holds the person's value as
            // its base) is safe; does it land, with the delivery's value winning?
            studio.AfterCapture = studio.DuringMerge = studio.AfterMerge = null;
            var again = Deliver(studio, DeliveryJob(kind));
            var model = Read(studio.Live);
            try { verdict.Add("the same delivery sent again " + (again["delivered"]?.GetValue<bool>() == true && Find(model, "C1E") is { } e && Description(e) == "by delivery"
                ? "lands and the delivery's value wins (so redoing it in the same call is safe and enough)" : "also stops: " + Brief(again))); }
            finally { ModelHost.Release(model); }
        }
        Record(kind, edit, timing, result, verdict);
        Assert.True(verdict.Count == 0, string.Join(" | ", verdict) + " :: " + Brief(result));
    }

    // ---- Kills: the kernel process dies mid-run (finally never runs); the next delivery must go on by itself ---------------

    public static IEnumerable<object[]> KillPoints() => new[] { "during-capture", "after-capture", "after-apply", "merge-sent", "merge-recorded", "during-proof" }.Select(p => new object[] { p });

    [Theory]
    [MemberData(nameof(KillPoints))]
    public void TheKernelProcessIsKilledAndTheNextDeliveryGoesOnByItself(string point)
    {
        kindOfRun = "action";
        var studio = Studio();
        Seed(studio, "action");
        studio.KillAt = point;
        var first = Deliver(studio, DeliveryJob("action"));
        // The process "died" at that point: its task.json is as it was then, and its reservation stays with its owner.
        var killed = studio.Kill();
        Assert.NotNull(killed);
        var problems = new List<string>();
        if (ReservationOwner() != killed) problems.Add("the kill did not leave the reservation held (harness)");
        var next = Deliver(studio, Action("C1AfterKill"));
        if (next["delivered"]?.GetValue<bool>() != true)
        {
            problems.Add("the next delivery stopped: " + (next["code"]?.ToString() ?? "") + " " + Trim(next["error"]?.ToString()));
            // How bad: does the continuation the refusal names (resume the killed task) clear it without the person?
            var resumed = Resume(studio, killed!);
            var again = Deliver(studio, Action("C1AfterKill"));
            problems.Add(again["delivered"]?.GetValue<bool>() == true
                ? "it needs a resume call of the killed task first (resume answered delivered=" + resumed["delivered"] + " code=" + resumed["code"] + "), then the next delivery lands"
                : "STUCK even after resuming the killed task (resume: " + Brief(resumed) + "; again: " + Brief(again) + ")");
            if (again["delivered"]?.GetValue<bool>() == true) next = again;
        }
        if (ReservationOwner() is { } held) problems.Add("a reservation is left held by " + held);
        if (!Has(studio.Live, "C1AfterKill")) problems.Add("the next delivery's action is not in the module");
        // A merge that reached the module before the kill is not undone: its content stays (or is re-delivered).
        if (point is "merge-recorded" or "during-proof" && !Has(studio.Live, "C1New")) problems.Add("the killed task's merged action vanished");
        Record("kill", point, "-", next, problems);
        Assert.True(problems.Count == 0, string.Join(" | ", problems) + " :: first=" + Brief(first) + " next=" + Brief(next));
    }

    // ---- The same delivery twice while the person keeps editing: never a chain of refusals ------------------------------

    [Fact]
    public void ThePersonKeepsEditingTheSameElementAcrossRetries()
    {
        kindOfRun = "action";
        var studio = Studio();
        Seed(studio, "action");
        var round = 0;
        studio.AfterCapture = live => SetDescription(live, "C1E", "by the person " + ++round);
        studio.AfterCaptureEveryTime = true;
        var result = Deliver(studio, DeliveryJob("action"));
        var verdict = Verdict(studio, "action", "same-element", result);
        Record("action", "same-element-repeated", "after-capture", result, verdict);
        Assert.True(verdict.Count == 0, string.Join(" | ", verdict) + " :: " + Brief(result));
    }

    // ---- The hardest cases (coordinator, 02/11 03:35) ---------------------------------------------------------------

    public static IEnumerable<object[]> Hardest()
    {
        foreach (var timing in new[] { "after-capture", "during-merge" })
        {
            foreach (var kind in new[] { "entity", "structure" }) yield return [kind, "same-parent-add", timing];
            foreach (var kind in Kinds) { yield return [kind, "delete-edited", timing]; yield return [kind, "rename-edited", timing]; }
            yield return ["action", "twin-move", timing];
            yield return ["action", "person-error", timing];
        }
    }

    [Theory]
    [MemberData(nameof(Hardest))]
    public void ThePersonDoesTheHardestThingsWhileTheDeliveryRuns(string kind, string edit, string timing)
    {
        kindOfRun = kind;
        var studio = Studio();
        Seed(studio, kind);
        var job = DeliveryJob(kind);
        Action<string> hook;
        switch (edit)
        {
            case "same-parent-add":
                // Both add a child under the same parent (an attribute of C1E).
                var attribute = kind == "entity" ? "IEntityAttribute" : "IStructureAttribute";
                string Add(string name) => $$"""{"op":"create","parent":"{{TypeOf(kind)}}:C1E","type":"{{attribute}}","name":"{{name}}","as":"$a"},{"op":"set","target":"$a","prop":"DataType","value":"Text"}""";
                var withChild = JsonNode.Parse(job)!.AsObject();
                withChild["ops"]!.AsArray().Add(JsonNode.Parse("[" + Add("JobAttr") + "]")!.AsArray()[0]!.DeepClone());
                withChild["ops"]!.AsArray().Add(JsonNode.Parse("[" + Add("JobAttr") + "]")!.AsArray()[1]!.DeepClone());
                job = withChild.ToJsonString();
                hook = live => Apply(live, """{"ops":[""" + Add("PersonAttr") + "]}");
                break;
            case "delete-edited": hook = live => Apply(live, $$"""{"ops":[{"op":"delete","target":"{{TypeOf(kind)}}:C1E"}]}"""); break;
            case "rename-edited": hook = live => Apply(live, $$"""{"ops":[{"op":"rename","target":"{{TypeOf(kind)}}:C1E","name":"C1ERenamed"}]}"""); break;
            case "twin-move":
                // Two unnamed Assign nodes with the same content in one flow (twins), moved on the canvas by the person.
                Apply(studio.Live, """{"ops":[{"op":"logic","data":{"actions":[{"name":"C1Twin","kind":"server","outputs":[{"name":"Out","type":"Integer"}],"steps":[{"assign":{"Out":"1"}},{"assign":{"Out":"1"}}]}]}}]}""");
                hook = live => Edit(live, m => { foreach (var o in Below(Find(m, "C1Twin")!)) Shift(o); });
                break;
            case "person-error":
                // The person removes the output C1Sib assigns: a new TrueChange error that is the person's, not the delivery's.
                studio.RealErrors = true;
                hook = live => Edit(live, m => Delete(Below(Find(m, "C1Sib")!).First(o => ModelHost.Prop(o, "Name")?.ToString() == "Out" && !o.GetType().Name.Contains("Node", StringComparison.Ordinal))));
                break;
            default: throw new ArgumentException(edit);
        }
        if (timing == "after-capture") studio.AfterCapture = hook; else studio.DuringMerge = hook;
        var result = Deliver(studio, job);
        var problems = new List<string>();
        if (result["delivered"]?.GetValue<bool>() != true)
            problems.Add("STOPPED: " + (result["code"]?.ToString() ?? "no code") + " at " + result["stage"] + ": " + Trim(result["error"]?.ToString()));
        if (ReservationOwner() is { } held) problems.Add("reservation left held by " + held);
        var model = Read(studio.Live);
        try
        {
            if (Find(model, "C1New") == null) problems.Add("the job's new element C1New is not in the module");
            switch (edit)
            {
                case "same-parent-add":
                    var e = Find(model, "C1E");
                    var children = e == null ? new List<string?>() : Below(e).Select(o => ModelHost.Prop(o, "Name")?.ToString()).ToList();
                    if (!children.Contains("JobAttr")) problems.Add("the delivery's attribute JobAttr is not under C1E");
                    if (!children.Contains("PersonAttr")) problems.Add("the person's attribute PersonAttr under C1E was lost");
                    break;
                case "delete-edited":
                    if (Find(model, "C1E") is not { } kept || Description(kept) != "by delivery") problems.Add("the person deleted C1E, which the delivery edits: the delivery's version did not win (C1E " + (Find(model, "C1E") == null ? "absent" : "present without the delivery's value") + ")");
                    break;
                case "rename-edited":
                    var renamed = Find(model, "C1ERenamed") ?? Find(model, "C1E");
                    if (renamed == null || Description(renamed) != "by delivery") problems.Add("the person renamed C1E, which the delivery edits: the delivery's description is not on it");
                    break;
            }
        }
        finally { ModelHost.Release(model); }
        if (result["delivered"]?.GetValue<bool>() == true && edit is "delete-edited" or "rename-edited" or "person-error"
            && (result["mergeNotes"] as JsonArray ?? []).Count == 0 && result["normalizations"] == null && result["warnings"] == null)
            problems.Add("delivered, but no note says what the person's edit did to the delivery");
        Record(kind, edit, timing, result, problems);
        Assert.True(problems.Count == 0, string.Join(" | ", problems) + " :: " + Brief(result));
    }

    // ---- Assertions --------------------------------------------------------------------------------------------------
    private static List<string> Verdict(C1Studio studio, string kind, string edit, JsonObject result, string timing = "after-capture")
    {
        // After the merge the person's edit is newer than the delivery: it stays, and the answer still says it (a note).
        var personLast = timing == "after-merge";
        var problems = new List<string>();
        if (result["delivered"]?.GetValue<bool>() != true)
            problems.Add("STOPPED: " + (result["code"]?.ToString() ?? "no code") + " at " + result["stage"] + ": " + Trim(result["error"]?.ToString()));
        if (ReservationOwner() is { } held) problems.Add("reservation left held by " + held);
        var model = Read(studio.Live);
        try
        {
            // The job's intention: the new element and the delivery's description of E.
            if (Find(model, "C1New") == null) problems.Add("the job's new element C1New is not in the module");
            var e = Find(model, "C1E");
            if (e == null) problems.Add("the seeded element C1E is gone");
            else if (Description(e) != "by delivery" && !(personLast && edit == "same-element" && Description(e) == "by the person"))
                problems.Add("C1E.Description is '" + Description(e) + "', not the delivery's value");
            // The person's edits.
            switch (edit)
            {
                case "same-element":
                    var notes = (result["mergeNotes"] as JsonArray ?? []).Select(n => n?.ToJsonString() ?? "").Concat((result["conflicts"] as JsonArray ?? []).Select(n => n?.ToJsonString() ?? ""));
                    if (!notes.Any(n => n.Contains("C1E", StringComparison.Ordinal) || n.Contains("conflict", StringComparison.OrdinalIgnoreCase)))
                        problems.Add("no note says the person's edit of C1E was replaced by the delivery");
                    break;
                case "other-element":
                    var inner = OtherElementOf(model, kind);
                    if (inner == null || Description(inner) != "by the person") problems.Add("the person's edit of another element of C1E was lost");
                    break;
                case "add": if (Find(model, "C1Mine") == null) problems.Add("the person's own new element C1Mine was lost"); break;
                case "delete": if (Find(model, "C1Sib") != null) problems.Add("the element the person deleted (C1Sib) came back"); break;
                case "rename":
                    if (Find(model, "C1SibRenamed") == null) problems.Add("the person's rename C1Sib -> C1SibRenamed was lost");
                    if (Find(model, "C1Sib") != null) problems.Add("C1Sib is back under its old name");
                    break;
                case "unsaved": if (Find(model, "C1Sib") is not { } s || Description(s) != "unsaved by the person") problems.Add("the person's unsaved edit of C1Sib was lost"); break;
                case "move": if (!studio.Moved(model)) problems.Add("the person's canvas moves were lost (" + studio.MoveDiagnosis(model) + ")"); break;
            }
        }
        finally { ModelHost.Release(model); }
        return problems;
    }

    // ---- The person's edits --------------------------------------------------------------------------------------------

    private static Action<string> PersonEdit(C1Studio studio, string kind, string edit) => edit switch
    {
        "move" => live => { Edit(live, m => { foreach (var o in Objects(m)) Shift(o); }); studio.MovedOnce = true; },
        "same-element" => live => SetDescription(live, "C1E", "by the person"),
        "other-element" => live => Edit(live, m => SetProp(OtherElementOf(m, kind) ?? throw new InvalidOperationException("no inner element of C1E"), "Description", "by the person")),
        "add" => live => Apply(live, NewElementJob(kind, "C1Mine")),
        "delete" => live => Apply(live, $$"""{"ops":[{"op":"delete","target":"{{TypeOf(kind)}}:C1Sib"}]}"""),
        "rename" => live => Apply(live, $$"""{"ops":[{"op":"rename","target":"{{TypeOf(kind)}}:C1Sib","name":"C1SibRenamed"}]}"""),
        "unsaved" => live => { SetDescription(live, "C1Sib", "unsaved by the person"); studio.FingerprintBusy = true; },
        "switch-module" => _ => studio.Active = "other",
        "close-module" => _ => studio.Closed = true,
        // The person's own work keeps the Studio UI thread busy: the next step is withdrawn before it runs (UiGate UI_BUSY).
        "studio-busy" => _ => studio.BusyOnce = true,
        _ => throw new ArgumentException(edit),
    };

    private static void Seed(C1Studio studio, string kind)
    {
        // The blank ODC app has no UI flow yet: the person's app gets one first (O11 uses the reactive-ui fixture, which has it).
        if (kind == "screen" && Lane == "odc") Apply(studio.Live, """{"ops":[{"op":"create","parent":"@espace","type":"IMobileFlow","name":"MainFlow"}]}""");
        Apply(studio.Live, NewElementJob(kind, "C1E"));
        Apply(studio.Live, NewElementJob(kind, "C1Sib"));
        SetDescription(studio.Live, "C1E", "seed");
        SetDescription(studio.Live, "C1Sib", "seed");
        if (kind == "action") studio.SeedPositions();
    }

    private static string TypeOf(string kind) => kind switch { "action" => "IServerAction", "entity" => "IEntity", "structure" => "IStructure", "role" => "IRole", "screen" => "IMobileScreen", _ => throw new ArgumentException(kind) };

    private static string NewElementJob(string kind, string name) => kind switch
    {
        "action" => Action(name),
        "entity" => """{"ops":[{"op":"spec","data":{"entities":[{"name":"NAME","attributes":[{"name":"Label","type":"Text","length":50}]}]}}]}""".Replace("NAME", name),
        "structure" => """{"ops":[{"op":"create","parent":"@espace","type":"IStructure","name":"NAME","as":"$st"},{"op":"create","parent":"$st","type":"IStructureAttribute","name":"Label","as":"$label"},{"op":"set","target":"$label","prop":"DataType","value":"Text"}]}""".Replace("NAME", name),
        "role" => """{"ops":[{"op":"create","parent":"@espace","type":"IRole","name":"NAME","as":"$role"}]}""".Replace("NAME", name),
        "screen" => """{"ops":[{"op":"create","parent":"IMobileFlow:MainFlow","type":"IMobileScreen","name":"NAME","as":"$scr"}]}""".Replace("NAME", name),
        _ => throw new ArgumentException(kind),
    };

    /// <summary>The delivery: the description of the seeded C1E and a new element C1New.</summary>
    private static string DeliveryJob(string kind)
    {
        var job = JsonNode.Parse(NewElementJob(kind, "C1New"))!.AsObject();
        job["ops"]!.AsArray().Add(JsonNode.Parse($$"""{"op":"set","target":"{{TypeOf(kind)}}:C1E","prop":"Description","value":"by delivery"}"""));
        return job.ToJsonString();
    }

    private static string Action(string name) => """{"ops":[{"op":"logic","data":{"actions":[{"name":"NAME","kind":"server","outputs":[{"name":"Out","type":"Integer"}],"steps":[{"assign":{"Out":"1"}}]}]}}]}""".Replace("NAME", name);

    /// <summary>Another element of C1E's own body: the Assign node of its flow, the attribute of the entity or structure; for a
    /// role (no body) the sibling C1Sib.</summary>
    private static IObjectSignature? OtherElementOf(ESpace model, string kind)
    {
        if (kind is "role" or "screen") return Find(model, "C1Sib");
        var e = Find(model, "C1E");
        if (e == null) return null;
        return Below(e).FirstOrDefault(o => !ReferenceEquals(o, e) && ModelHost.Prop(o, "Name")?.ToString() == (kind == "action" ? "Out" : "Label"));
    }

    // ---- Model helpers (lane-neutral: Model API by reflection where the two lanes differ) --------------------------------

    private static List<IObjectSignature> Objects(ESpace model) => Below((IObjectSignature)model);

    private static List<IObjectSignature> Below(IObjectSignature top)
    {
        var all = new List<IObjectSignature>(); var pending = new Stack<IObjectSignature>(); pending.Push(top);
        while (pending.TryPop(out var node))
        {
            all.Add(node);
            if (node is ServiceStudio.Model.Interfaces.ITopLevelReferenceElement) continue;
            foreach (var child in node.Children.OfType<IObjectSignature>()) pending.Push(child);
        }
        return all;
    }

    /// <summary>The element of that name that is not a flow node or a reference (unique names per test).</summary>
    private static IObjectSignature? Find(ESpace model, string name)
    {
        var named = Objects(model).Where(o => ModelHost.Prop(o, "Name")?.ToString() == name
            && !o.GetType().Name.Contains("Node", StringComparison.Ordinal) && o is not ServiceStudio.Model.Interfaces.ITopLevelReferenceElement && o.GetType().Name != "ESpace").ToList();
        // The element of the kind under test first (an entity also names its own record and list types, a structure too).
        var wanted = TypeOf(kindOfRun);
        return named.FirstOrDefault(o => o.GetType().GetInterfaces().Any(i => i.Name == wanted)) ?? named.FirstOrDefault();
    }

    private static string? Description(IObjectSignature o) => ModelHost.Prop(o, "Description")?.ToString();

    private static void SetProp(object o, string name, object value)
    {
        var property = o.GetType().GetProperties(BindingFlags.Public | BindingFlags.Instance).FirstOrDefault(p => p.Name == name && p.CanWrite)
            ?? throw new InvalidOperationException(o.GetType().Name + " has no writable " + name);
        property.SetValue(o, value is string text && property.PropertyType != typeof(string) ? Convert.ChangeType(text, property.PropertyType) : value);
    }

    private static void Delete(object o)
    {
        var delete = o.GetType().GetMethods(BindingFlags.Public | BindingFlags.Instance).FirstOrDefault(m => m.Name == "Delete" && m.GetParameters().Length == 0)
            ?? throw new InvalidOperationException(o.GetType().Name + " has no Delete()");
        delete.Invoke(o, null);
    }

    /// <summary>A canvas position property, also when the class implements it only through its interface (IFlowNode).</summary>
    private static PropertyInfo? Position(object o, string name)
        => o.GetType().GetProperty(name) ?? o.GetType().GetInterfaces().Select(i => i.GetProperty(name)).FirstOrDefault(p => p != null);

    private static void Shift(object o)
    {
        foreach (var name in new[] { "HorizontalPosition", "VerticalPosition" })
            if (Position(o, name) is { CanWrite: true } p && p.GetValue(o) is IConvertible now) p.SetValue(o, Convert.ChangeType(Convert.ToDouble(now) + 40, p.PropertyType));
    }

    /// <summary>The person sets a description (the job op the Studio's property grid amounts to).</summary>
    private static string kindOfRun = "action";
    private static void SetDescription(string live, string name, string value)
        => Apply(live, $$"""{"ops":[{"op":"set","target":"{{TypeOf(kindOfRun)}}:{{name}}","prop":"Description","value":{{JsonSerializer.Serialize(value)}}}]}""");

    private static ESpace Read(string path)
    {
        var host = new ModelHost(Path.Combine(Path.GetDirectoryName(path)!, "read-" + Guid.NewGuid().ToString("N")[..8]));
        return host.Load(File.ReadAllBytes(path));
    }

    private static bool Has(string path, string name)
    {
        var model = Read(path);
        try { return Find(model, name) != null; }
        finally { ModelHost.Release(model); }
    }

    /// <summary>A person's edit in the Studio, in one command, on the open module (a file here).</summary>
    private static void Edit(string path, Action<ESpace> edit)
    {
        var host = new ModelHost(Path.Combine(Path.GetDirectoryName(path)!, "edit-" + Guid.NewGuid().ToString("N")[..8]));
        var model = host.Load(File.ReadAllBytes(path));
        try
        {
            StudioAdapter.Runtime.Mutate(model, "test: the person's edit in the Studio", _ => edit(model));
            File.WriteAllBytes(path, host.Save(model));
        }
        finally { ModelHost.Release(model); }
    }

    /// <summary>A job applied to the open module in place (the person's own work, or the seed).</summary>
    private static void Apply(string path, string jobText)
    {
        var dir = Path.Combine(Path.GetDirectoryName(path)!, "apply-" + Guid.NewGuid().ToString("N")[..8]); Directory.CreateDirectory(dir);
        var job = Path.Combine(dir, "job.json"); File.WriteAllText(job, jobText);
        var output = Path.Combine(dir, "applied.oml");
        var applied = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "model")), path, job, output))!;
        Assert.True(applied["accepted"]!.GetValue<bool>(), "seed/person job refused: " + applied.ToJsonString()[..Math.Min(600, applied.ToJsonString().Length)]);
        File.Copy(output, path, true);
    }

    // ---- Harness -------------------------------------------------------------------------------------------------------

    private const string Environment_ = "c1dev";
    private const string ModuleKey = "c1-module";
    private const string ModuleName = "C1_Headless";
    private static string Lane => typeof(ModelHost).Assembly.GetType("Anvil.Core.StudioAssembliesOdc") == null ? "o11" : "odc";
    private static string Kernel => JobSources.KernelRoot()!;
    /// <summary>The module of the case: a blank service (O11) or mobile app (ODC); screens need a UI flow (O11: reactive-ui).</summary>
    private static string Blank => Lane == "o11" ? Path.Combine(Kernel, "tests", "fixtures", kindOfRun == "screen" ? "reactive-ui.oml" : "blank-service.oml") : Path.Combine(Kernel, "tests", "fixtures", "odc", "blank-mobile.oml");

    private static void Bind()
    {
        var binder = typeof(ModelHost).Assembly.GetType("Anvil.Core.StudioAssembliesOdc") ?? typeof(ModelHost).Assembly.GetType("Anvil.Core.StudioAssemblies");
        binder?.GetMethod("Bind", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static, Type.EmptyTypes)?.Invoke(null, null);
    }

    private static string ReservationFile => Path.Combine(BridgeAccess.DirectoryPath, "reservations", DurableJson.Hash(Environment_ + "\n" + ModuleKey) + ".json");

    private static string? ReservationOwner()
    {
        var file = ReservationFile;
        return File.Exists(file) ? DurableJson.Read(file)["owner"]?.ToString() : null;
    }

    private static C1Studio Studio()
    {
        Bind();
        var work = Path.Combine(Kernel, ".local", "c1-adversarial", Lane, Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        var live = Path.Combine(work, "live.oml"); File.Copy(Blank, live);
        // Each case starts with the module free (the reservation store is the process's).
        if (File.Exists(ReservationFile)) { var held = DurableJson.Read(ReservationFile); held["owner"] = null; DurableJson.Write(ReservationFile, held); }
        return new C1Studio(new ModelHost(Path.Combine(work, "model")), live, work);
    }

    private static readonly object Serial = new();
    private static JsonObject Deliver(C1Studio studio, string jobText)
    {
        lock (Serial)
        {
            var job = Path.Combine(studio.Work, "job-" + Guid.NewGuid().ToString("N")[..8] + ".json"); File.WriteAllText(job, jobText);
            studio.BeginRun();
            JsonObject result;
            try
            {
                result = Delivery.Run(studio, new(ModuleName, job, studio.Work, Array.Empty<string>()),
                    (basePath, jobPath, output) => JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(Path.GetDirectoryName(output)!, "model")), basePath, jobPath, output))!.AsObject(),
                    inspectData: (snapshot, assertions) => new ModelHost(Path.Combine(Path.GetDirectoryName(snapshot)!, "proof-model")).CheckDataContract(snapshot, assertions),
                    mergePlanner: new MergePlanner(directory => new ModelHost(Path.Combine(directory, "order-model"))));
            }
            catch (Exception ex) { result = new JsonObject { ["delivered"] = false, ["code"] = "THROWN", ["error"] = ex.GetType().Name + ": " + ex.Message }; }
            File.WriteAllText(Path.Combine(studio.Work, "result-" + Guid.NewGuid().ToString("N")[..6] + ".json"), result.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
            return result;
        }
    }

    /// <summary>The resume of a task (deliver --resume): the request recorded in its task.json.</summary>
    private static JsonObject Resume(C1Studio studio, string taskId)
    {
        lock (Serial)
        {
            studio.BeginRun();
            try
            {
                return Delivery.Run(studio, DeliveryTask.ResumeRequest(studio.Work, taskId),
                    (basePath, jobPath, output) => JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(Path.GetDirectoryName(output)!, "model")), basePath, jobPath, output))!.AsObject(),
                    inspectData: (snapshot, assertions) => new ModelHost(Path.Combine(Path.GetDirectoryName(snapshot)!, "proof-model")).CheckDataContract(snapshot, assertions),
                    mergePlanner: new MergePlanner(directory => new ModelHost(Path.Combine(directory, "order-model"))));
            }
            catch (Exception ex) { return new JsonObject { ["delivered"] = false, ["code"] = "THROWN", ["error"] = ex.GetType().Name + ": " + ex.Message }; }
        }
    }

    private static string Trim(string? text) => text == null ? "" : text.Length > 400 ? text[..400] + "..." : text;
    private static string Brief(JsonObject r) => $"delivered={r["delivered"]} code={r["code"]} stage={r["stage"]} writeState={r["writeState"]} error={Trim(r["error"]?.ToString())}";

    /// <summary>One line per case in kernel/.local/c1-adversarial/matrix-&lt;lane&gt;.jsonl (the report reads it).</summary>
    private static void Record(string kind, string edit, string timing, JsonObject result, List<string> problems)
    {
        var line = new JsonObject { ["lane"] = Lane, ["kind"] = kind, ["edit"] = edit, ["timing"] = timing, ["green"] = problems.Count == 0,
            ["code"] = result["code"]?.DeepClone(), ["stage"] = result["stage"]?.DeepClone(), ["writeState"] = result["writeState"]?.DeepClone(),
            ["problems"] = new JsonArray(problems.Select(p => (JsonNode?)p).ToArray()), ["error"] = Trim(result["error"]?.ToString()) };
        lock (Serial) File.AppendAllText(Path.Combine(Kernel, ".local", "c1-adversarial", "matrix-" + Lane + ".jsonl"), line.ToJsonString() + "\n");
    }

    /// <summary>The Studio boundary, modeled on Anvil.Bridge: the open module is a file; calls target module_key in any tab
    /// (C41); merge_from_oml mode=auto runs the Studio's MatchTree headless and, as MergeHandler.Run does, merges nothing when
    /// the tree has conflicts (merged:false, "conflicts: use mode=dialog"); its journal answers merge_status. A closed module
    /// refuses every targeted call before it runs, until open_module opens it again; the person may select another tab.
    /// KillAt freezes the task's state at that point (Kill restores it after the run: the process died there).</summary>
    private sealed class C1Studio(ModelHost host, string live, string work) : IBridgeClient
    {
        public ModelHost Host { get; } = host;
        public string Live { get; } = live;
        public string Work { get; } = work;
        public Action<string>? AfterCapture { get; set; }
        public bool AfterCaptureEveryTime { get; set; }
        public Action<string>? DuringMerge { get; set; }
        public Action<string>? AfterMerge { get; set; }
        public string Active { get; set; } = "own";
        public bool Closed { get; set; }
        public bool FingerprintBusy { get; set; }
        public bool BusyOnce { get; set; }
        /// <summary>get_errors answers the TrueChange of the open module (baseline at each capture), as the Studio does.</summary>
        public bool RealErrors { get; set; }
        private JsonArray Messages() { var m = Read(Live); try { return JsonSerializer.SerializeToNode(ModelHost.Messages(m))!.AsArray(); } finally { ModelHost.Release(m); } }
        public bool MovedOnce { get; set; }
        public string? KillAt { get; set; }
        private readonly Dictionary<string, JsonObject> journal = new();
        private readonly Dictionary<string, (double H, double V)> seeded = new();
        private bool captured, merged, afterMerged, duringMergeDone;
        /// <summary>A new delivery run: the hooks fire once per run again.</summary>
        public void BeginRun() { captured = false; merged = false; afterMerged = false; duringMergeDone = false; }
        private string? frozenTask, frozenState;

        public void SeedPositions()
        {
            var model = Read(Live);
            try { foreach (var o in Objects(model)) if (Position(o, "HorizontalPosition") is { } h && Position(o, "VerticalPosition") is { } v && ModelHost.Prop(o, "Key")?.ToString() is { Length: > 0 } n) seeded[n] = (Convert.ToDouble(h.GetValue(o)), Convert.ToDouble(v.GetValue(o))); }
            finally { ModelHost.Release(model); }
        }

        public string MoveDiagnosis(ESpace model)
        {
            var now = Objects(model).Where(o => Position(o, "HorizontalPosition") != null).Select(o => ModelHost.Prop(o, "Key") + "=" + Position(o, "HorizontalPosition")!.GetValue(o)).Take(4);
            return "seeded " + seeded.Count + ": " + string.Join(",", seeded.Take(4).Select(s => s.Key + "=" + s.Value.H)) + "; now: " + string.Join(",", now);
        }

        /// <summary>True when at least one node of the seed keeps the person's +40 move.</summary>
        public bool Moved(ESpace model)
        {
            foreach (var o in Objects(model))
                if (ModelHost.Prop(o, "Key")?.ToString() is { Length: > 0 } n && seeded.TryGetValue(n, out var was)
                    && Position(o, "HorizontalPosition")?.GetValue(o) is IConvertible h && Math.Abs(Convert.ToDouble(h) - (was.H + 40)) < 0.5) return true;
            return false;
        }

        private string? CurrentTask()
        {
            var dir = Path.Combine(Work, "deliver");
            return Directory.Exists(dir) ? new DirectoryInfo(dir).GetDirectories().OrderByDescending(d => d.CreationTimeUtc).FirstOrDefault()?.Name : null;
        }

        private void MaybeFreeze(string point)
        {
            if (KillAt != point || frozenTask != null) return;
            frozenTask = CurrentTask();
            if (frozenTask != null) frozenState = File.ReadAllText(Path.Combine(Work, "deliver", frozenTask, "task.json"));
        }

        /// <summary>The process died at KillAt: its task.json is the one of that moment, its reservation stays with it.</summary>
        public string? Kill()
        {
            if (frozenTask == null || frozenState == null) return null;
            File.WriteAllText(Path.Combine(Work, "deliver", frozenTask, "task.json"), frozenState);
            var state = DurableJson.Read(Path.Combine(Work, "deliver", frozenTask, "task.json"));
            using (new ModuleReservation(Path.Combine(BridgeAccess.DirectoryPath, "reservations"), state["environment"]?.ToString() ?? Environment_, ModuleKey, frozenTask)) { }
            return frozenTask;
        }

        private void RequireOpen(JsonObject? parameters)
        {
            if (Closed) throw new BridgeCallException("Requested module identity is not open in any Studio tab; nothing was executed", false);
            if (parameters?["module_key"] is { } key && key.ToString() != ModuleKey) throw new BridgeCallException("Requested module identity is not open in any Studio tab; nothing was executed", false);
        }

        private JsonObject Own => new() { ["name"] = ModuleName, ["key"] = ModuleKey, ["environment"] = Environment_ };

        public JsonObject Call(string method, JsonObject? parameters = null)
        {
            if (BusyOnce && method is "snapshot_module" or "get_errors" or "open_module" or "merge_from_oml" or "list_open_modules")
            {
                // Anvil.Bridge/UiGate.cs UiBusyException, withdrawn: nothing of the step ran.
                BusyOnce = false;
                throw new BridgeCallException(method + (method == "merge_from_oml" ? ": find the module" : "") + ": the Studio UI thread did not run this step in 2 s (withdrawn from the UI queue; nothing of it ran)", false);
            }
            switch (method)
            {
                case "bridge_manifest": return new() { ["protocolVersion"] = 2, ["capabilities"] = new JsonArray("publish_log", Delivery.MergeOrderCapability, "list_open_modules:model_sha256", "merge_from_oml:module_key") };
                case "ping": return new() { ["pid"] = 4242 };
                case "open_module":
                    Closed = false; Active = "own";
                    return new() { ["opened"] = true, ["alreadyOpen"] = true };
                case "close_module": return new() { ["closed"] = true };
                case "get_active_module":
                    return Active == "own" && !Closed ? Own : new() { ["name"] = "C1_Other", ["key"] = "c1-other", ["environment"] = Environment_ };
                case "list_open_modules":
                    // The fingerprint read of rule (a) comes right after the job apply, before the merge (production c150…:
                    // the process died after the snapshot stage, during the apply).
                    if (captured && !merged && parameters?["model_sha256_of"] != null) MaybeFreeze("after-apply");
                    var rows = new JsonArray();
                    if (!Closed)
                    {
                        var row = new JsonObject { ["name"] = ModuleName, ["key"] = ModuleKey, ["environment"] = Environment_, ["hasOpenedActiveESpace"] = true, ["serverSilentMode"] = false };
                        if (parameters?["model_sha256_of"] != null && !FingerprintBusy) row["modelSha256"] = PrebuiltCandidate.ModelSha256(Live);
                        rows.Add(row);
                    }
                    return new() { ["modules"] = rows };
                case "snapshot_module":
                    RequireOpen(parameters);
                    MaybeFreeze(merged ? "during-proof" : "during-capture");
                    File.Copy(Live, parameters!["path"]!.ToString(), true);
                    var answer = new JsonObject { ["key"] = ModuleKey, ["name"] = ModuleName, ["snapshot_id"] = Guid.NewGuid().ToString("N"), ["baseline"] = RealErrors ? Messages() : new JsonArray(), ["sha256"] = DeliveryReceipt.Hash(Live) };
                    if (!merged && (!captured || AfterCaptureEveryTime))
                    {
                        captured = true;
                        AfterCapture?.Invoke(Live);
                        MaybeFreeze("after-capture");
                    }
                    return answer;
                case "merge_from_oml":
                    RequireOpen(parameters);
                    // F1 (merge of the suite): the person's edit during the merge happens once; a second merge of the same call
                    // (the conflict pass) meets the module as the person left it, never the same edit made again.
                    if (!merged && !duringMergeDone) { duringMergeDone = true; DuringMerge?.Invoke(Live); }
                    RequireOpen(parameters);
                    var operation = parameters!["operation_id"]?.ToString() ?? Guid.NewGuid().ToString("N");
                    var path = parameters["first_pass_path"]?.ToString();
                    var outcome = C1Merge.Run(Host, Live, File.ReadAllBytes(parameters["base_path"]!.ToString()), File.ReadAllBytes(parameters["foreign_path"]!.ToString()),
                        path == null ? null : File.ReadAllBytes(path));
                    var data = new JsonObject { ["mode"] = "auto", ["merged"] = outcome.Merged, ["hasConflicts"] = outcome.Conflicts, ["newErrors"] = 0,
                        ["result"] = outcome.Merged ? "Merge" : null, ["undoSteps"] = outcome.Merged ? (path != null ? 2 : 1) : 0,
                        ["mergeOrder"] = path != null ? new JsonObject { ["passes"] = 2 } : null, ["secondPass"] = path != null ? new JsonObject { ["merged"] = outcome.Merged } : null };
                    if (!outcome.Merged) data["reason"] = outcome.Conflicts ? "conflicts: use mode=dialog" : "no differences";
                    journal[operation] = new JsonObject { ["state"] = outcome.Merged ? "applied" : outcome.Conflicts ? "not-applied" : "unchanged", ["receipt"] = data.DeepClone() };
                    if (outcome.Merged) { merged = true; MaybeFreeze("merge-sent"); }
                    if (outcome.Merged && !afterMerged) { afterMerged = true; AfterMerge?.Invoke(Live); }
                    return data;
                case "merge_status":
                    var id = parameters?["operation_id"]?.ToString() ?? "";
                    return journal.TryGetValue(id, out var recorded) ? recorded.DeepClone().AsObject() : new JsonObject { ["state"] = "unknown" };
                case "get_errors":
                    RequireOpen(parameters);
                    MaybeFreeze("merge-recorded");
                    return new() { ["newErrors"] = 0, ["new"] = new JsonArray(), ["rawMessages"] = RealErrors ? Messages() : new JsonArray() };
                case "find_element": return new() { ["count"] = 1 };
                default: throw new InvalidOperationException("unexpected bridge call " + method);
            }
        }
    }

    /// <summary>merge_from_oml mode=auto over the open module, as Anvil.Bridge/MergeHandler.cs Run: the Studio's MatchTree
    /// (ServiceStudio.Merge in O11, OutSystems.Model.Merge in ODC, found by reflection); a tree with conflicts merges nothing.
    /// With a first-pass copy, the second merge takes the candidate over that copy.</summary>
    private static class C1Merge
    {
        private static Type Tree => AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType("ServiceStudio.Merge.MatchTree") ?? a.GetType("OutSystems.Model.Merge.MatchTree")).FirstOrDefault(t => t != null)
            ?? throw new InvalidOperationException("no MatchTree in the bound Studio assemblies");

        public static (bool Merged, bool Conflicts) Run(ModelHost host, string livePath, byte[] baseBytes, byte[] foreignBytes, byte[]? firstPass)
        {
            var local = host.Load(File.ReadAllBytes(livePath));
            try
            {
                var (merged, conflicts) = One(host, local, firstPass ?? foreignBytes, baseBytes);
                if (conflicts) return (false, true);
                if (firstPass != null)
                {
                    var (second, secondConflicts) = One(host, local, foreignBytes, firstPass);
                    merged |= second;
                    if (secondConflicts && !merged) return (false, true);
                }
                if (merged) File.WriteAllBytes(livePath, host.Save(local));
                return (merged, conflicts);
            }
            finally { ModelHost.Release(local); }
        }

        private static (bool, bool) One(ModelHost host, ESpace local, byte[] foreignBytes, byte[] baseBytes)
        {
            ESpace? foreign = null, basis = null;
            try
            {
                foreign = host.Load(foreignBytes); basis = host.Load(baseBytes);
                bool conflicts = false, none = false;
                StudioAdapter.Runtime.Mutate(local, "test: merge_from_oml auto", _ =>
                {
                    var ctor = Tree.GetConstructors().First(c => c.GetParameters() is { Length: 5 } p && p[3].ParameterType == typeof(bool) && p[4].ParameterType == typeof(bool));
                    using var tree = (IDisposable)ctor.Invoke([local, foreign, basis, false, true]);
                    conflicts = (bool)Tree.GetProperty("HasConflicts")!.GetValue(tree)!;
                    none = (bool)Tree.GetProperty("HasNoDifferences")!.GetValue(tree)!;
                    if (!conflicts && !none) Tree.GetMethod("Merge", Type.EmptyTypes)!.Invoke(tree, null);
                });
                return (!conflicts && !none, conflicts);
            }
            finally { ModelHost.Release(foreign); ModelHost.Release(basis); }
        }
    }
}
