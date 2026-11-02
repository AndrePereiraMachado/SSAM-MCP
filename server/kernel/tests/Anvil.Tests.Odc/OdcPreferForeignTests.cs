using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using OutSystems.Model;
using Anvil.Core;
using Anvil.Bridge;
using OutSystems.Model.Merge;
using ServiceStudio.Model;
using ServiceStudio.Presenter.Commands;
using ServiceStudio.Undo;
using Xunit;

namespace Anvil.Tests.Odc;

public sealed class OdcPreferForeignTests {
    public OdcPreferForeignTests() => StudioAssembliesOdc.Bind();

    [Fact]
    public void EveryRequiredReflectionMemberExists() {
        var members = PreferForeign.Find(typeof(MatchTree));
        Assert.Equal("OutSystems.Model.Merge", members.Namespace);
        Assert.Equal("Foreign", members.ForeignCheck.ToString());
    }

    [Fact]
    public void AMissingReflectionMemberDisablesPreferWithAReason() {
        Assert.False(NativePreferForeign.Available(out var reason, typeof(Anvil.Bridge.Thin.Tests.FakeMerge.MatchTree)));
        Assert.Contains("HasUnresolvedConflicts", reason);
    }

    [Fact]
    public void AbsentPreferRetainsTheOldManifestAndLocalIsRefused() {
        var manifest = JsonSerializer.Deserialize<Manifest>("{}", Manifest.Json)!;
        Assert.False(manifest.PreferForeign);
        Assert.DoesNotContain("preferForeign", JsonSerializer.Serialize(manifest, Manifest.Json));
        var file = Path.Combine(Path.GetTempPath(), "odc-prefer-invalid-" + Guid.NewGuid().ToString("N") + ".json");
        try {
            File.WriteAllText(file, "{\"prefer\":\"local\"}");
            Assert.Contains("prefer must be", Assert.Throws<InvalidOperationException>(() => Manifest.Load(file)).Message);
        } finally { File.Delete(file); }
    }

    [Theory]
    [InlineData("description")]
    [InlineData("dependency")]
    [InlineData("role")]
    [InlineData("others")]
    [InlineData("rollback")]
    [InlineData("unknown")]
    [InlineData("deep")]
    [InlineData("unresolved")]
    [InlineData("returned-to-base")]
    [InlineData("third-value")]
    [InlineData("missing-delivery")]
    [InlineData("missing-person-object")]
    [InlineData("two-pass")]
    [InlineData("second-pass-conflict")]
    public void ConflictingDescriptionWinsAndOneUndoKeepsThePersonsOtherAction(string scenario) {
        var root = new DirectoryInfo(AppContext.BaseDirectory);
        while (root != null && !File.Exists(Path.Combine(root.FullName, "MANIFESTO.md"))) root = root.Parent;
        Assert.NotNull(root);
        var work = Path.Combine(root.FullName, ".local", "odc-prefer", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        string Apply(string input, string name, string json) {
            var job = Path.Combine(work, name + ".json");
            var output = Path.Combine(work, name + ".oml");
            File.WriteAllText(job, json);
            var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, input, job, output))!;
            Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
            return output;
        }
        var basisPath = Apply(Path.Combine(root.FullName, "tests", "fixtures", "odc", "blank-mobile.oml"), "base",
            """{"ops":[{"op":"logic","data":{"actions":[{"name":"PreferA","kind":"server","steps":[]},{"name":"PreferSibling","kind":"server","steps":[]}]}}]}""");
        basisPath = Apply(basisPath, "helpers", """{"ops":[{"op":"logic","data":{"actions":[{"name":"H","kind":"server","steps":[]}]}},{"op":"create","parent":"@espace","type":"IRole","name":"PersonRemovedRole"}]}""");
        if (scenario == "deep") {
            var ops = JsonNode.Parse("""{"ops":[{"op":"create","parent":"@espace","type":"IMobileFlow","name":"PreferFlow"},{"op":"create","parent":"IMobileFlow:PreferFlow","type":"IMobileScreen","name":"PreferScreen","as":"$screen"}]}""")!;
            for (var depth = 0; depth < 16; depth++)
                ops["ops"]!.AsArray().Add(new JsonObject { ["op"] = "create", ["parent"] = depth == 0 ? "$screen" : "$depth" + (depth - 1), ["type"] = "IContainer", ["name"] = "Depth" + depth, ["as"] = "$depth" + depth });
            basisPath = Apply(basisPath, "deep", ops.ToJsonString());
        }
        var personJob = JsonNode.Parse("""{"ops":[{"op":"set","target":"IServerAction:PreferA","prop":"Description","value":"person value"},{"op":"set","target":"IServerAction:PreferSibling","prop":"Description","value":"independent person value"}]}""")!;
        var deliveryJob = JsonNode.Parse("""{"ops":[{"op":"set","target":"IServerAction:PreferA","prop":"Description","value":"delivery value"}]}""")!;
        void Add(JsonNode job, string op) => job["ops"]!.AsArray().Add(JsonNode.Parse(op));
        if (scenario == "dependency") {
            Add(personJob, """{"op":"delete","target":"IServerAction:H"}""");
            Add(deliveryJob, """{"op":"logic","data":{"actions":[{"name":"PreferA","kind":"server","replace":true,"steps":[{"call":"H"}]}]}}""");
        }
        if (scenario == "role") {
            Add(personJob, """{"op":"delete","target":"IRole:PersonRemovedRole"}""");
            Add(deliveryJob, """{"op":"create","parent":"@espace","type":"IRole","name":"DeliveryRole"}""");
        }
        if (scenario == "others") {
            Add(personJob, """{"op":"create","parent":"IServerAction:PreferA","type":"IInputParameter","name":"PersonInput","as":"$input"}""");
            Add(personJob, """{"op":"set","target":"$input","prop":"DataType","value":"Text"}""");
        }
        if (scenario == "missing-person-object")
            Add(personJob, """{"op":"create","parent":"@espace","type":"IRole","name":"PersonOnlyRole"}""");
        if (scenario == "deep") {
            Add(personJob, """{"op":"set","target":"IContainer:Depth15","prop":"Name","value":"PersonWidget"}""");
            Add(deliveryJob, """{"op":"set","target":"IContainer:Depth15","prop":"Name","value":"DeliveryWidget"}""");
        }
        var localPath = Apply(basisPath, "person", personJob.ToJsonString());
        var foreignPath = Apply(basisPath, "delivery", deliveryJob.ToJsonString());
        OdcPreferGapTests.RecordBaseBehavior(host, scenario, basisPath, localPath, foreignPath, work);
        var local = host.Load(localPath); var foreign = host.Load(foreignPath); var basis = host.Load(basisPath);
        var beforeModel = host.Load(localPath);
        MockAggregatorPresenter? presenter = null;
        try {
            typeof(ESpace).GetMethod("PrepareForSave", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic, Type.EmptyTypes)?.Invoke(local, null);
            presenter = new MockAggregatorPresenter(local, null, false, null, null, false);
            string Sha() { using var stream = local.SaveToMemoryStream(); return Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(stream.ToArray())); }
            if (scenario is "two-pass" or "second-pass-conflict") {
                var finalJob = scenario == "two-pass"
                    ? """{"ops":[{"op":"create","parent":"@espace","type":"IRole","name":"SecondPassRole"}]}"""
                    : """{"ops":[{"op":"set","target":"IServerAction:PreferSibling","prop":"Description","value":"second-pass conflict"}]}""";
                var finalModel = host.Load(Apply(foreignPath, "second-pass", finalJob));
                try {
                    var beforeHash = Sha();
                    if (scenario == "second-pass-conflict") {
                        var error = Assert.ThrowsAny<InvalidOperationException>(() => NativePreferForeign.Merge(presenter, local, foreign, basis, Sha, finalCandidate: finalModel));
                        Assert.True(error is NativePreferForeign.NotApplied or NativePreferForeign.Unknown);
                        Assert.Contains("second pass has conflicts", error.Message);
                        if (error is NativePreferForeign.NotApplied) Assert.Equal(beforeHash, Sha());
                        using var comparison = new MatchTree(local, beforeModel, beforeModel, false, true);
                        Assert.True(comparison.HasNoDifferences, comparison.Dump());
                        Assert.Equal(0, UndoManager.GetUndoCount(presenter));
                    } else {
                        NativePreferForeign.Merge(presenter, local, foreign, basis, Sha, finalCandidate: finalModel);
                        Assert.Equal(1, UndoManager.GetUndoCount(presenter));
                        Assert.Contains(Objects(local), o => ModelHost.Prop(o, "Name")?.ToString() == "SecondPassRole");
                        UndoManager.Undo(presenter, 1);
                        Assert.DoesNotContain(Objects(local), o => ModelHost.Prop(o, "Name")?.ToString() == "SecondPassRole");
                        using var comparison = new MatchTree(local, beforeModel, beforeModel, false, true);
                        Assert.True(comparison.HasNoDifferences, comparison.Dump());
                    }
                    return;
                } finally { ModelHost.Release(finalModel); }
            }
            if (scenario == "unresolved") {
                var before = Sha();
                var entered = false;
                Assert.Throws<NativePreferForeign.NotApplied>(() => NativePreferForeign.Merge(presenter, local, foreign, basis, Sha,
                    enteringNativeMerge: () => entered = true,
                    afterSelection: tree => tree.Roots.First().MergeAction = OutSystems.Model.Merge.MergeAction.Unknown));
                Assert.False(entered);
                Assert.Equal(before, Sha());
                Assert.Equal(0, UndoManager.GetUndoCount(presenter));
                return;
            }
            if (scenario is "rollback" or "unknown") {
                var before = Sha();
                var reads = 0;
                string Proof() {
                    reads++;
                    using var stream = local.SaveToMemoryStream();
                    File.WriteAllBytes(Path.Combine(work, "rollback-snapshot-" + reads + ".oml"), stream.ToArray());
                    return scenario == "unknown" && reads > 1 ? "unproven" : Sha();
                }
                var error = Assert.ThrowsAny<InvalidOperationException>(() => NativePreferForeign.Merge(presenter, local, foreign, basis, Proof,
                    enteringNativeMerge: scenario == "rollback" ? () => throw new InvalidOperationException("injected at native merge entry") : null,
                    afterNativeMerge: scenario == "unknown" ? () => throw new InvalidOperationException("injected after tree.Merge") : null));
                Assert.True((scenario == "rollback") == (error is NativePreferForeign.NotApplied), error.ToString() + " evidence: " + work);
                if (scenario == "rollback") Assert.Equal(before, Sha());
                Assert.Contains(Objects(local), o => ModelHost.Prop(o, "Name")?.ToString() == "PreferA" && ModelHost.Prop(o, "Description")?.ToString() == "person value");
                Assert.Equal(0, UndoManager.GetUndoCount(presenter));
                return;
            }
            var receipt = NativePreferForeign.Merge(presenter, local, foreign, basis, Sha);
            Assert.NotNull(receipt);
            Assert.Contains("person value", receipt.ToJsonString());
            Assert.Contains("delivery value", receipt.ToJsonString());
            if (scenario == "dependency") {
                Assert.Contains("removed by the person", receipt.ToJsonString());
                Assert.Contains("dependency", receipt.ToJsonString());
            }
            if (scenario == "others") Assert.True(receipt["others"]!.GetValue<int>() > 0);
            if (scenario == "deep") Assert.Contains("PersonWidget", receipt.ToJsonString());
            if (scenario == "role") Assert.DoesNotContain(Objects(local), o => ModelHost.Prop(o, "Name")?.ToString() == "PersonRemovedRole");
            string? Description(string name) => Objects(local)
                .Where(o => o.GetType().Name.Contains("Action") && !o.GetType().Name.Contains("Node"))
                .Where(o => ModelHost.Prop(o, "Name")?.ToString() == name)
                .Select(o => ModelHost.Prop(o, "Description")?.ToString()).FirstOrDefault();
            Assert.Equal("delivery value", Description("PreferA"));
            Assert.Equal("independent person value", Description("PreferSibling"));
            var audit = NativeMergeIntent.Observe(local, foreign, basis, beforeModel);
            Assert.Contains(audit.Preserved, n => n.Element.Contains("PreferSibling") && n.Local == "independent person value");
            NativeMergeVerification.Proof Verify(ESpace model, NativeMergeIntent.Audit proof) => NativeMergeVerification.Verify(
                model, foreign, new HashSet<string>(), Path.Combine(work, "verification.txt"), preserved: proof.IsPreserved);
            Verify(local, audit);
            if (scenario is "returned-to-base" or "third-value" or "missing-delivery" or "missing-person-object") {
                var mergedPath = Path.Combine(work, "merged.oml"); File.WriteAllBytes(mergedPath, host.Save(local));
                var corruptJob = scenario switch {
                    "missing-delivery" => """{"ops":[{"op":"delete","target":"IServerAction:PreferA"}]}""",
                    "missing-person-object" => """{"ops":[{"op":"delete","target":"IRole:PersonOnlyRole"}]}""",
                    "third-value" => """{"ops":[{"op":"set","target":"IServerAction:PreferSibling","prop":"Description","value":"unexpected third value"}]}""",
                    _ => """{"ops":[{"op":"set","target":"IServerAction:PreferSibling","prop":"Description","value":""}]}"""
                };
                var corrupted = host.Load(Apply(mergedPath, "corrupted", corruptJob));
                try {
                    var observed = NativeMergeIntent.Observe(corrupted, foreign, basis, beforeModel);
                    if (scenario is "missing-delivery" or "third-value") Assert.Throws<InvalidOperationException>(() => Verify(corrupted, observed));
                    else Verify(corrupted, observed);
                    if (scenario != "missing-delivery") {
                        var note = observed.Receipt(receipt, NativeMergeIntent.Read(basis, foreign)).ToJsonString();
                        Assert.Contains(scenario == "missing-person-object" ? "PersonOnlyRole" : "independent person value", note);
                        Assert.Contains(observed.Replaced, c => c.Element.Contains(scenario == "missing-person-object" ? "PersonOnlyRole" : "PreferSibling"));
                        Assert.DoesNotContain(observed.Preserved, c => c.Element.Contains(scenario == "missing-person-object" ? "PersonOnlyRole" : "PreferSibling"));
                    }
                } finally { ModelHost.Release(corrupted); }
            }
            Assert.Equal(1, UndoManager.GetUndoCount(presenter));
            var merged = host.Save(local);
            UndoManager.Undo(presenter, 1);
            Assert.Equal("person value", Description("PreferA"));
            Assert.Throws<InvalidOperationException>(() => Verify(local, NativeMergeIntent.Observe(local, foreign, basis, beforeModel)));
            Assert.NotEqual(Convert.ToHexString(merged), Convert.ToHexString(host.Save(local)));
            UndoManager.Redo(presenter, 1);
            Assert.True(host.Inspect(host.Save(local)).IsValid);
        } finally {
            if (presenter != null) { UndoManager.ClearHistory(presenter); (presenter as IDisposable)?.Dispose(); }
            ModelHost.Release(local); ModelHost.Release(foreign); ModelHost.Release(basis); ModelHost.Release(beforeModel);
        }
    }

    private static IEnumerable<AbstractObject> Objects(ESpace model) {
        var pending = new Stack<IObjectSignature>(); pending.Push(model);
        while (pending.TryPop(out var node)) {
            if (node is AbstractObject obj) yield return obj;
            if (node is ServiceStudio.Model.Interfaces.ITopLevelReferenceElement) continue;
            foreach (var child in node.Children.OfType<IObjectSignature>()) pending.Push(child);
        }
    }
}
