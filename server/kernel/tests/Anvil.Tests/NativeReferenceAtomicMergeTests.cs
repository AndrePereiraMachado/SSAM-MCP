using System.Collections;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.CSharp;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>Two sequential native trees through the shared helper in one private SDK command.
/// Full UI wrapper exploration and its headless limitation remain in local artifacts.</summary>
public sealed class NativeReferenceAtomicMergeTests(ITestOutputHelper output)
{
    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public void SequentialTreesShareUndoAndRollbackInMemory(bool failAfterMetadataMerge, bool matchByStructure)
    {
        Assert.Equal("ss4", Environment.GetEnvironmentVariable("ANVIL_LANE") ?? "ss4");
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(NativeReferenceAtomicMergeTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local/data-logic-translator/native-reference-atomic-merge", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work); output.WriteLine("Artifacts: " + work);
        var host = new ModelHost(Path.Combine(work, "model"));
        var fixture = Path.Combine(root, "tests/fixtures/blank-service.oml");
        var oldSignature = Path.Combine(root, "tests/contracts/native-reference/ordinal-primitive.avsig");
        var newSignature = Path.Combine(root, "tests/contracts/native-reference/text-primitives.avsig");
        var originals = new[] { fixture, oldSignature, newSignature }.ToDictionary(p => p, DeliveryReceipt.Hash);
        var moduleKey = host.Inspect(fixture).Key;
        var oldContract = Contract(oldSignature, false);
        var newContract = Contract(newSignature, true);
        var oldLock = Freeze(oldSignature, oldContract, "112");
        var newLock = Freeze(newSignature, newContract, "113");
        oldLock.Write(Path.Combine(work, "old-lock.json")); newLock.Write(Path.Combine(work, "new-lock.json"));
        var basePath = Apply("base", fixture, oldContract, oldLock);
        var foreignPath = Apply("foreign", basePath, newContract, newLock);
        originals[basePath] = DeliveryReceipt.Hash(basePath); originals[foreignPath] = DeliveryReceipt.Hash(foreignPath);
        Assert.True(host.CheckModuleSpecification(foreignPath, newContract)["accepted"]!.GetValue<bool>());

        var load = typeof(ModelHost).GetMethod("Load", [typeof(string)])!;
        var local = load.Invoke(host, [basePath])!;
        var foreign = load.Invoke(host, [foreignPath])!;
        var basis = load.Invoke(host, [basePath])!;
        var report = new JsonObject { ["failAfterMetadataMerge"] = failAfterMetadataMerge, ["mergeApi"] = "ReferenceSignatureMerge.MergeInCurrentCommand + MatchTree.Merge", ["matchByStructure"] = matchByStructure };
        object? aggregator = null, presenter = null;
        Type? undo = null;
        try
        {
            object Reference(object module) => ((IEnumerable)ModelHost.Prop(module, "References")!).Cast<object>()
                .Single(r => ModelHost.Prop(r, "ReferenceKey")!.ToString() == newLock.Producers[0].ProducerKey);
            var originalReference = Reference(local);
            Mutate(local, () => originalReference.GetType().GetMethod("SetName", [typeof(string)])!.Invoke(originalReference, ["LocalRuntimeAlias"]));
            var before = ReadState(local, "before"); report["before"] = before.DeepClone();
            var reordered = before.DeepClone();
            var assignments = Nodes(reordered["body"]!).Single(n => n["type"]!.ToString() == "IAssignNode")["orderedSequences"]!["Assignments"]!.AsArray();
            Assert.Equal(2, assignments.Count);
            var firstAssignment = assignments[0]!.DeepClone(); var secondAssignment = assignments[1]!.DeepClone();
            assignments[0] = secondAssignment; assignments[1] = firstAssignment;
            Assert.False(JsonNode.DeepEquals(before, reordered));
            var swappedTargets = before.DeepClone();
            var condition = Nodes(swappedTargets["body"]!).Single(n => n["type"]!.ToString() == "IIfNode")["properties"]!;
            var trueTarget = condition["TrueTarget"]!.DeepClone(); var falseTarget = condition["FalseTarget"]!.DeepClone();
            Assert.NotEqual(trueTarget.ToString(), falseTarget.ToString());
            condition["TrueTarget"] = falseTarget; condition["FalseTarget"] = trueTarget;
            Assert.False(JsonNode.DeepEquals(before, swappedTargets));
            report["comparatorControls"] = new JsonObject { ["detectsAssignmentOrder"] = true, ["detectsBranchTargets"] = true };
            Assert.Equal(oldLock.Producers[0].SignatureHash, before["hash"]!.ToString());
            Assert.Equal("LocalRuntimeAlias", before["alias"]!.ToString());
            var plan = (ReferenceSignatureMergePlan)typeof(ReferenceSignatureMerge).GetMethod("Analyze")!.Invoke(null, [local, foreign, basis])!;
            Assert.True(plan.HasChanges); Assert.False(plan.HasConflicts);
            report["plan"] = JsonSerializer.SerializeToNode(plan);

            // Publisher.Mutate uses these exact public SDK command APIs, but clears the history
            // immediately. Keep this isolated mock alive until Undo/Redo assertions finish.
            local.GetType().GetMethod("PrepareForSave", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public, Type.EmptyTypes)?.Invoke(local, null);
            var presenterAssembly = Assembly.Load("ServiceStudio.Presenter");
            var aggregatorType = presenterAssembly.GetType("ServiceStudio.Presenter.Commands.MockAggregatorPresenter", true)!;
            aggregator = Activator.CreateInstance(aggregatorType, [local, null, false, null, null, false])!;
            var presenterType = presenterAssembly.GetType("ServiceStudio.Presenter.Commands.MockPresenter", true)!;
            presenter = Activator.CreateInstance(presenterType, [aggregator])!;
            var context = presenterType.GetMethod("GetPresenterContext", Type.EmptyTypes)!.Invoke(presenter, null)!;
            var framework = local.GetType().Assembly;
            var command = framework.GetType("ServiceStudio.Commands.Command", true)!;
            undo = framework.GetType("ServiceStudio.Undo.UndoManager", true)!;
            var execute = command.GetMethods().Single(m => m.Name == "Execute" && m.GetParameters().Length == 3 && m.GetParameters()[2].ParameterType == typeof(Action));
            int UndoCount() => (int)undo.GetMethod("GetUndoCount")!.Invoke(null, [aggregator])!;
            int RedoCount() => (int)undo.GetMethod("GetRedoCount")!.Invoke(null, [aggregator])!;
            Assert.Equal(0, UndoCount()); Assert.Equal(0, RedoCount());
            var treeType = framework.GetType("ServiceStudio.Merge.MatchTree", true)!;
            var stage = "before"; var callbackCount = 0; object? previousMatch = null;
            ReferenceSignatureMergeResult? mergeResult = null;
            Action<object> mergeOne = tree =>
            {
                callbackCount++;
                Assert.InRange(callbackCount, 1, 2);
                if (previousMatch != null)
                {
                    // Disposed Match objects clear both model pointers. The first tree must
                    // already be gone before the helper hands us its second live tree.
                    Assert.Null(ModelHost.Prop(previousMatch, "LocalObject"));
                    Assert.Null(ModelHost.Prop(previousMatch, "ForeignObject"));
                    report["sequentialDisposalVerified"] = true;
                }
                var currentMatch = ModelHost.Prop(Reference(local), "Match")!;
                Assert.Same(tree, ModelHost.Prop(currentMatch, "Tree"));
                previousMatch = currentMatch;
                Assert.False((bool)treeType.GetProperty("HasConflicts")!.GetValue(tree)!);
                treeType.GetMethod("Merge", Type.EmptyTypes)!.Invoke(tree, null);
                if (callbackCount == 1)
                {
                    stage = "structural-merged";
                    var structural = ReadState(local, "afterStructural"); report["afterStructural"] = structural;
                    Assert.Equal(oldLock.Producers[0].SignatureHash, structural["hash"]!.ToString());
                    Assert.Equal("LocalRuntimeAlias", structural["alias"]!.ToString());
                    Assert.False(JsonNode.DeepEquals(before["body"], structural["body"]));
                    Assert.Contains("Working + 1", Expressions(structural["body"]!));
                }
                else
                {
                    stage = "metadata-merged";
                    var metadata = ReadState(local, "afterMetadata"); report["afterMetadata"] = metadata;
                    Assert.Equal(newLock.Producers[0].SignatureHash, metadata["hash"]!.ToString());
                    Assert.Equal("LocalRuntimeAlias", metadata["alias"]!.ToString());
                    Assert.True(JsonNode.DeepEquals(report["afterStructural"]!["body"], metadata["body"]));
                    if (failAfterMetadataMerge) throw new InvalidOperationException("Injected after second native merge");
                }
            };
            var helper = typeof(ReferenceSignatureMerge).GetMethod("MergeInCurrentCommand")!;
            var nativeCallback = Delegate.CreateDelegate(helper.GetParameters()[4].ParameterType, mergeOne.Target, mergeOne.Method);
            Action merge = () => mergeResult = (ReferenceSignatureMergeResult)helper.Invoke(null, [local, foreign, basis, plan, nativeCallback, matchByStructure])!;
            Exception? error = null;
            try { execute.Invoke(null, [context, "Atomic native signature merge experiment", merge]); }
            catch (Exception ex) { error = ex; report["error"] = ex.ToString(); }
            report["lastStage"] = stage; report["peakSimultaneousTrees"] = 1; report["nativeCallbacks"] = callbackCount;
            Assert.Equal("metadata-merged", stage); Assert.Equal(2, callbackCount);
            Assert.Null(ModelHost.Prop(Reference(local), "Match"));
            Assert.Null(ModelHost.Prop(previousMatch!, "LocalObject"));
            if (mergeResult != null)
            {
                Assert.Equal(1, mergeResult.SelectedReferences); Assert.Equal(2, mergeResult.NativeMergeCount);
                report["mergeResult"] = JsonSerializer.SerializeToNode(mergeResult);
            }
            var afterCommand = ReadState(local, "afterCommand"); report["afterCommand"] = afterCommand.DeepClone();
            report["undoCountAfterCommand"] = UndoCount(); report["redoCountAfterCommand"] = RedoCount();
            if (failAfterMetadataMerge)
            {
                Assert.NotNull(error); Assert.Contains("Injected after second native merge", error!.ToString());
                // This is the same live ESpace, read before any serialization/reload or repair.
                Assert.True(JsonNode.DeepEquals(before, afterCommand), report.ToJsonString());
                Assert.Equal(0, UndoCount()); Assert.Equal(0, RedoCount());
            }
            else
            {
                Assert.Null(error); Assert.Equal(1, UndoCount()); Assert.Equal(0, RedoCount());
                var verifyApplied = typeof(ReferenceSignatureMerge).GetMethod("VerifyApplied")!;
                verifyApplied.Invoke(null, [local, foreign, basis, plan]);
                undo.GetMethods().Single(m => m.Name == "Undo" && m.GetParameters().Length == 2).Invoke(null, [aggregator, 1]);
                var undone = ReadState(local, "afterUndo"); report["afterUndo"] = undone;
                Assert.True(JsonNode.DeepEquals(before, undone), report.ToJsonString());
                var rejectedCommit = Assert.Throws<TargetInvocationException>(() => verifyApplied.Invoke(null, [local, foreign, basis, plan]));
                Assert.IsType<InvalidOperationException>(rejectedCommit.InnerException);
                Assert.Contains("did not retain", rejectedCommit.InnerException!.Message);
                Assert.Equal(0, UndoCount()); Assert.Equal(1, RedoCount());
                undo.GetMethod("Redo")!.Invoke(null, [aggregator, 1]);
                var redone = ReadState(local, "afterRedo"); report["afterRedo"] = redone;
                Assert.True(JsonNode.DeepEquals(afterCommand, redone), report.ToJsonString());
                verifyApplied.Invoke(null, [local, foreign, basis, plan]);
                report["postCommandCommitCheck"] = new JsonObject { ["acceptedCommitted"] = true, ["rejectedUndone"] = true, ["acceptedRedone"] = true };
                Assert.Equal(1, UndoCount()); Assert.Equal(0, RedoCount());
            }
            var expectedContract = failAfterMetadataMerge ? oldContract : newContract;
            var expectedLock = failAfterMetadataMerge ? oldLock : newLock;
            var session = (ModelSession)Activator.CreateInstance(typeof(ModelSession), [local])!;
            var proof = session.CheckModuleSpecification(expectedContract);
            var dependencies = (JsonObject)typeof(ModelSession).GetMethod("CheckFrameworkDependencies", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(session, [expectedLock])!;
            report["finalDependencies"] = dependencies;
            Assert.True(dependencies["accepted"]!.GetValue<bool>(), dependencies.ToJsonString());
            report["finalProof"] = proof;
            Assert.True(proof["accepted"]!.GetValue<bool>(), proof.ToJsonString());
            var resultPath = Path.Combine(work, "result.oml");
            File.WriteAllBytes(resultPath, (byte[])typeof(ModelHost).GetMethod("Save")!.Invoke(host, [local])!);
            var reloadPath = Path.Combine(work, "reloaded.oml");
            var roundTrip = host.RoundTrip(File.ReadAllBytes(resultPath), reloadPath);
            Assert.True(roundTrip.Original.IsValid && roundTrip.Reloaded.IsValid);
            var reloaded = load.Invoke(host, [reloadPath])!;
            try { Assert.True(JsonNode.DeepEquals(ReadState(local, "beforeReload"), ReadState(reloaded, "afterReload"))); }
            finally { typeof(ModelHost).GetMethod("Release")!.Invoke(null, [reloaded]); }
            foreach (var (path, hash) in originals) Assert.Equal(hash, DeliveryReceipt.Hash(path));
            report["inputsUnchanged"] = true; report["roundTrip"] = JsonSerializer.SerializeToNode(roundTrip);

            JsonObject ReadState(object module, string observation)
            {
                var reference = Reference(module);
                var session = (ModelSession)Activator.CreateInstance(typeof(ModelSession), [module])!;
                var body = session.ApplyOne(new JsonObject { ["op"] = "dump", ["target"] = "IServerAction:CompareText", ["depth"] = 20 })!.AsObject();
                var digests = new JsonObject();
                report["digests"] ??= new JsonObject();
                report["digests"]![observation] = digests;
                Enrich(body);
                return new JsonObject { ["referenceKey"] = ModelHost.Prop(reference, "Key")!.ToString(),
                    ["producerKey"] = ModelHost.Prop(reference, "ReferenceKey")!.ToString(),
                    ["hash"] = ModelHost.Prop(reference, "ReferenceHash")!.ToString(),
                    ["alias"] = ModelHost.Prop(reference, "Name")!.ToString(), ["body"] = body };
                void Enrich(JsonObject node)
                {
                    if (node["type"]!.ToString() != "IExpression")
                    {
                        var native = session.Resolve("@" + node["key"]!.ToString());
                        var properties = session.Get(native)["properties"]!.DeepClone().AsObject();
                        // IObjectSignature.Digest is a derived GeneralHash (catalog/model-api-11.55.69.json).
                        // Structural matching refreshes this cache; preserve it outside semantic equality.
                        if (properties.TryGetPropertyValue("Digest", out var digest))
                        {
                            digests[node["key"]!.ToString()] = digest?.DeepClone();
                            properties.Remove("Digest");
                        }
                        node["properties"] = properties;
                        // IObjectSignature.Children is an unordered IEnumerable. Preserve native
                        // semantic ordering explicitly through every Model API ISequence property.
                        var sequences = new JsonObject();
                        foreach (var property in native.GetType().GetInterfaces().Where(i => i.Namespace?.StartsWith("OutSystems.Model", StringComparison.Ordinal) == true)
                            .SelectMany(i => i.GetProperties()).Where(p => p.PropertyType.IsGenericType && p.PropertyType.GetGenericTypeDefinition().Name == "ISequence`1")
                            .GroupBy(p => p.Name).Select(g => g.First()).OrderBy(p => p.Name, StringComparer.Ordinal))
                        {
                            var items = ((IEnumerable)property.GetValue(native)!).Cast<object>();
                            sequences[property.Name] = new JsonArray(items.Select(item => session.Get(item)["key"]!.DeepClone()).ToArray());
                        }
                        node["orderedSequences"] = sequences;
                    }
                    if (node["children"] is JsonArray nested)
                    {
                        foreach (var child in nested.OfType<JsonObject>()) Enrich(child);
                        node["children"] = new JsonArray(nested.OfType<JsonObject>().OrderBy(child => child["key"]!.ToString(), StringComparer.Ordinal)
                            .Select(child => child.DeepClone()).ToArray());
                    }
                }
            }
        }
        finally
        {
            File.WriteAllText(Path.Combine(work, "atomic-proof.json"), report.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
            if (aggregator != null && undo != null) undo.GetMethod("ClearHistory")!.Invoke(null, [aggregator]);
            (presenter as IDisposable)?.Dispose(); (aggregator as IDisposable)?.Dispose();
            foreach (var module in new[] { local, foreign, basis }) typeof(ModelHost).GetMethod("Release")!.Invoke(null, [module]);
        }

        FrozenFrameworkDependencies Freeze(string path, JsonObject contract, string version)
        {
            var snapshot = NativeReferenceSnapshot.Read(path);
            var envelope = JsonNode.Parse(File.ReadAllText(path))!;
            var element = envelope["Elements"]!.AsArray().Single(e => e!["Name"]!.ToString() == "CSharpTextCompareOrdinal")!;
            var requirement = FrameworkIntrinsic.CompareOrdinal;
            return FrozenFrameworkDependencies.Create(Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(contract.ToJsonString()))).ToLowerInvariant(),
                [requirement], "fixture.invalid", moduleKey, new("OfflineSignatureFixture", version, new string('a', 64)),
                [new("Runtime", path, DeliveryReceipt.Hash(path), snapshot.ModuleKey, snapshot.SignatureHash.ToString())],
                [new(requirement.Reference, "Runtime", "CSharpTextCompareOrdinal", element["Key"]!.ToString(), requirement.Inputs, requirement.Output)]);
        }
        string Apply(string name, string basisPath, JsonObject contract, FrozenFrameworkDependencies dependencies)
        {
            var ops = dependencies.ReferenceOperations();
            foreach (var op in host.PlanModuleSpecification(basisPath, contract)) ops.Add(op!.DeepClone());
            var job = Path.Combine(work, name + ".json"); var result = Path.Combine(work, name + ".oml");
            File.WriteAllText(job, new JsonObject { ["ops"] = ops }.ToJsonString());
            var receipt = JsonSerializer.SerializeToNode(JobRunner.Run(host, basisPath, job, result, bindings: dependencies.ProducerBindings()))!;
            File.WriteAllText(Path.Combine(work, name + "-apply.json"), receipt.ToJsonString());
            Assert.True(receipt["accepted"]!.GetValue<bool>(), receipt.ToJsonString()); return result;
        }
    }

    private static IEnumerable<JsonObject> Nodes(JsonNode node)
    {
        if (node is not JsonObject obj) yield break;
        yield return obj;
        if (obj["children"] is JsonArray children)
            foreach (var child in children.OfType<JsonObject>())
                foreach (var descendant in Nodes(child)) yield return descendant;
    }
    private static IEnumerable<string> Expressions(JsonNode node)
    {
        if (node is not JsonObject obj) yield break;
        if (obj["text"] is JsonValue text) yield return text.GetValue<string>();
        if (obj["children"] is JsonArray children)
            foreach (var child in children.OfType<JsonObject>())
                foreach (var expression in Expressions(child)) yield return expression;
    }
    private static void Mutate(object module, Action action)
    {
        var method = typeof(Publisher).GetMethod("Mutate")!;
        Action<object> adapter = _ => action();
        var callback = Delegate.CreateDelegate(method.GetParameters()[2].ParameterType, adapter.Target, adapter.Method);
        method.Invoke(null, [module, "Prepare isolated concurrent local alias", callback]);
    }

    private static JsonObject Contract(string signature, bool changedBody)
    {
        var snapshot = NativeReferenceSnapshot.Read(signature);
        return new JsonObject { ["logic"] = new JsonObject { ["actions"] = new JsonArray(new JsonObject {
            ["name"] = "CompareText", ["kind"] = "server", ["public"] = true,
            ["access"] = new JsonObject { ["authenticated"] = true },
            ["inputs"] = new JsonArray(new JsonObject { ["name"] = "Left", ["type"] = "Text" }, new JsonObject { ["name"] = "Right", ["type"] = "Text" }),
            ["outputs"] = new JsonArray(new JsonObject { ["name"] = "Result", ["type"] = "Integer" }),
            ["vars"] = new JsonArray(new JsonObject { ["name"] = "Working", ["type"] = "Integer" }),
            ["steps"] = new JsonArray(new JsonObject { ["call"] = snapshot.Bind("IServerActionSignature:CSharpTextCompareOrdinal"), ["as"] = "Native",
                ["args"] = new JsonObject { ["Left"] = "Left", ["Right"] = "Right" } },
                new JsonObject { ["assign"] = new JsonObject { ["Working"] = "Native.Result", ["Result"] = changedBody ? "Working + 1" : "Working" } }) }) } };
    }
}
