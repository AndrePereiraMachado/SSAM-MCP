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

/// <summary>A single disposable native regression. No server, Studio, worker or bridge.
/// The desired assertion stays red if the merge preserves the old hash despite new actions/ABI.</summary>
public sealed class NativeReferenceVersionMergeTests(ITestOutputHelper output)
{
    [Fact]
    public void Version112To113MustPreserveTheFrozenProducerHashAlongWithTheNewActionAbi() => Run(false);

    [Fact]
    public void ExplicitReferenceHashPropertySelectionPreservesTheFrozenHashAndConcurrentLocalAlias() => Run(true);

    [Theory]
    [InlineData("hash")]
    [InlineData("producer")]
    public void ConcurrentNativeProducerChangesAreRejectedBeforeTheMerge(string conflict) => Run(true, conflict);

    [Fact]
    public void MetadataOnlySignatureChangeIsSelectedDespiteNoVisibleTreeDifference() => Run(true, scenario: "metadata-only");

    [Fact]
    public void AlreadyEqualSignatureIsANoop() => Run(true, scenario: "noop");

    [Fact]
    public void EmptyForeignSignatureCannotBeSelected() => Run(true, "invalid-foreign");

    [Fact]
    public void SignatureChangedAfterPlanningIsRejectedBeforeAnySelection() => Run(true, "hash-after-plan");

    [Fact]
    public void LocalAlreadyAtForeignSignatureDoesNotSelectAgain() => Run(true, scenario: "local-equal");

    private void Run(bool selectReferenceHash, string? concurrentChange = null, string scenario = "normal")
    {
        Assert.Equal("ss4", Environment.GetEnvironmentVariable("ANVIL_LANE") ?? "ss4");
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(NativeReferenceVersionMergeTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local/data-logic-translator/native-reference-version-merge", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work); output.WriteLine("Artifacts: " + work);
        var host = new ModelHost(Path.Combine(work, "model"));
        var fixture = Path.Combine(root, "tests/fixtures/blank-service.oml");
        var oldSignature = Path.Combine(root, "tests/contracts/native-reference/ordinal-primitive.avsig");
        var newSignature = Path.Combine(root, "tests/contracts/native-reference/text-primitives.avsig");
        var originalHashes = new[] { fixture, oldSignature, newSignature }.ToDictionary(p => p, DeliveryReceipt.Hash);
        var oldEnvelope = JsonNode.Parse(File.ReadAllText(oldSignature))!;
        var newEnvelope = JsonNode.Parse(File.ReadAllText(newSignature))!;
        Assert.Equal(oldEnvelope["ModuleKey"]!.ToString(), newEnvelope["ModuleKey"]!.ToString());
        Assert.NotEqual(oldEnvelope["SignatureHash"]!.ToString(), newEnvelope["SignatureHash"]!.ToString());

        var oldContract = Contract(oldSignature, includeLength: false);
        var includeLength = scenario != "metadata-only";
        var newContract = Contract(newSignature, includeLength);
        var moduleKey = host.Inspect(fixture).Key;
        var oldLock = Freeze(oldSignature, oldEnvelope, oldContract, [FrameworkIntrinsic.CompareOrdinal], "112");
        var newLock = Freeze(newSignature, newEnvelope, newContract, includeLength ? [FrameworkIntrinsic.CompareOrdinal, FrameworkIntrinsic.Utf16Length] : [FrameworkIntrinsic.CompareOrdinal], "113");
        oldLock.Write(Path.Combine(work, "producer-112-lock.json"));
        newLock.Write(Path.Combine(work, "producer-113-lock.json"));

        var basePath = Apply("base", fixture, oldContract, oldLock);
        var baseProof = Inspect("base", basePath, oldContract, oldLock);
        Assert.True(baseProof["contract"]!["accepted"]!.GetValue<bool>(), baseProof.ToJsonString());
        Assert.True(baseProof["dependencies"]!["accepted"]!.GetValue<bool>(), baseProof.ToJsonString());
        var foreignPath = Apply("foreign", basePath, newContract, newLock);
        var foreignProof = Inspect("foreign", foreignPath, newContract, newLock);
        Assert.True(foreignProof["contract"]!["accepted"]!.GetValue<bool>(), foreignProof.ToJsonString());
        Assert.True(foreignProof["dependencies"]!["accepted"]!.GetValue<bool>(), foreignProof.ToJsonString());

        var baseHash = DeliveryReceipt.Hash(basePath); var foreignHash = DeliveryReceipt.Hash(foreignPath);
        var mergedPath = Path.Combine(work, "merged.oml");
        var mergeBasePath = scenario == "noop" ? foreignPath : basePath;
        if (concurrentChange != null)
        {
            var failure = Assert.ThrowsAny<Exception>(() => ExplicitHashMerge(host, basePath, foreignPath, mergedPath,
                newLock.Producers[0].ProducerKey, newLock.Producers[0].SignatureHash, Path.Combine(work, "selection.json"), concurrentChange));
            Assert.Contains(concurrentChange == "producer" ? "producer-identity-changed" : concurrentChange == "invalid-foreign" ? "invalid-foreign-signature" : "concurrent-signature", failure.ToString());
            Write("rejection.json", new JsonObject { ["kind"] = concurrentChange, ["error"] = failure.ToString(), ["mergeOutputExists"] = File.Exists(mergedPath) });
            Assert.False(File.Exists(mergedPath));
            Assert.Equal(baseHash, DeliveryReceipt.Hash(basePath)); Assert.Equal(foreignHash, DeliveryReceipt.Hash(foreignPath));
            foreach (var (path, hash) in originalHashes) Assert.Equal(hash, DeliveryReceipt.Hash(path));
            return;
        }
        var merged = selectReferenceHash
            ? ExplicitHashMerge(host, mergeBasePath, foreignPath, mergedPath, newLock.Producers[0].ProducerKey,
                newLock.Producers[0].SignatureHash, Path.Combine(work, "selection.json"), scenario: scenario)
            : JsonSerializer.SerializeToNode(MergeProbe.ThreeWay(host, File.ReadAllBytes(basePath), File.ReadAllBytes(foreignPath), mergedPath))!.AsObject();
        Write("merge.json", merged);
        Assert.True(merged["LocalIsValid"]!.GetValue<bool>(), merged.ToJsonString()); Assert.False(merged["HasConflicts"]!.GetValue<bool>());
        var afterMerge = Inspect("merged", mergedPath, newContract, newLock);
        var reloadedPath = Path.Combine(work, "reloaded.oml");
        var reload = host.RoundTrip(File.ReadAllBytes(mergedPath), reloadedPath);
        Write("reload.json", JsonSerializer.SerializeToNode(reload)!);
        var afterReload = Inspect("reloaded", reloadedPath, newContract, newLock);

        var summary = new JsonObject {
            ["lane"] = "ss4", ["studioDirectory"] = StudioAssemblies.Directory,
            ["expectedOldHash"] = oldLock.Producers[0].SignatureHash, ["expectedNewHash"] = newLock.Producers[0].SignatureHash,
            ["base"] = baseProof, ["foreign"] = foreignProof, ["merged"] = afterMerge, ["reloaded"] = afterReload,
            ["baseSha256"] = baseHash, ["foreignSha256"] = foreignHash,
            ["mergedSha256"] = DeliveryReceipt.Hash(mergedPath), ["reloadedSha256"] = DeliveryReceipt.Hash(reloadedPath),
            ["frozenLockFingerprint"] = newLock.Fingerprint, ["mergeConflicts"] = merged["HasConflicts"]!.DeepClone(), ["explicitHashSelection"] = selectReferenceHash, ["scenario"] = scenario, ["mergeBasePath"] = mergeBasePath,
            ["scope"] = "One offline v112-to-v113 signature import/merge/reload. Native actions and typed callee ABI are independently checked. No post-proof repair."
        };
        Write("summary.json", summary); output.WriteLine("Summary: " + Path.Combine(work, "summary.json"));
        Assert.Equal(baseHash, DeliveryReceipt.Hash(basePath)); Assert.Equal(foreignHash, DeliveryReceipt.Hash(foreignPath));
        foreach (var (path, hash) in originalHashes) Assert.Equal(hash, DeliveryReceipt.Hash(path));
        Assert.True(reload.Original.IsValid && reload.Reloaded.IsValid);
        Assert.True(afterMerge["contract"]!["accepted"]!.GetValue<bool>(), afterMerge.ToJsonString());
        Assert.True(afterReload["contract"]!["accepted"]!.GetValue<bool>(), afterReload.ToJsonString());
        // Actions/calls can be present and Verify green while this independent metadata proof fails.
        Assert.True(afterReload["dependencies"]!["accepted"]!.GetValue<bool>(),
            "Frozen producer proof after native merge/reload: " + afterReload["dependencies"]!["differences"]!.ToJsonString());

        FrozenFrameworkDependencies Freeze(string signature, JsonNode envelope, JsonObject contract,
            FrameworkIntrinsic[] requirements, string version)
        {
            var bindings = requirements.Select(requirement => {
                var name = requirement.Reference == FrameworkIntrinsic.CompareOrdinal.Reference ? "CSharpTextCompareOrdinal" : "CSharpTextUtf16Length";
                var element = envelope["Elements"]!.AsArray().Single(e => e!["Name"]!.ToString() == name)!;
                return new FrameworkIntrinsicBinding(requirement.Reference, "Runtime", name, element["Key"]!.ToString(), requirement.Inputs, requirement.Output);
            });
            return FrozenFrameworkDependencies.Create(Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(contract.ToJsonString()))).ToLowerInvariant(),
                requirements, "fixture.invalid", moduleKey, new("OfflineSignatureFixture", version, new string('a', 64)),
                [new("Runtime", signature, DeliveryReceipt.Hash(signature), envelope["ModuleKey"]!.ToString(), envelope["SignatureHash"]!.ToString())], bindings);
        }
        string Apply(string name, string basis, JsonObject contract, FrozenFrameworkDependencies dependencies)
        {
            var operations = dependencies.ReferenceOperations();
            foreach (var operation in host.PlanModuleSpecification(basis, contract)) operations.Add(operation!.DeepClone());
            var job = Path.Combine(work, name + ".json"); var target = Path.Combine(work, name + ".oml");
            Write(name + ".json", new JsonObject { ["ops"] = operations });
            var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, basis, job, target, bindings: dependencies.ProducerBindings()))!;
            Write(name + "-apply.json", result);
            Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
            Assert.True(result["isValid"]!.GetValue<bool>()); return target;
        }
        JsonObject Inspect(string name, string path, JsonObject contract, FrozenFrameworkDependencies dependencies)
        {
            var contractProof = host.CheckModuleSpecification(path, contract);
            var snapshot = host.Inspect(path);
            var reference = Assert.Single(snapshot.References, r => r.Key == dependencies.Producers[0].ProducerKey);
            var module = typeof(ModelHost).GetMethod("Load", [typeof(string)])!.Invoke(host, [path])!;
            try
            {
                var session = Activator.CreateInstance(typeof(ModelSession), [module])!;
                var check = typeof(ModelSession).GetMethod("CheckFrameworkDependencies", BindingFlags.Instance | BindingFlags.NonPublic)!;
                var dependencyProof = (JsonObject)check.Invoke(session, [dependencies])!;
                var nativeReference = ((IEnumerable)ModelHost.Prop(module, "References")!).Cast<object>()
                    .Single(r => ModelHost.Prop(r, "ReferenceKey")?.ToString() == reference.Key);
                var metadata = nativeReference.GetType().GetField("ReferenceHashPropertyMetadata", BindingFlags.Public | BindingFlags.Static)!.GetValue(null)!;
                var flags = new JsonObject();
                foreach (var property in metadata.GetType().GetProperties().Where(p => p.GetIndexParameters().Length == 0
                    && (p.Name.Contains("Diff", StringComparison.OrdinalIgnoreCase) || p.Name.Contains("Merge", StringComparison.OrdinalIgnoreCase))))
                    flags[property.Name] = JsonSerializer.SerializeToNode(property.GetValue(metadata));
                foreach (var field in metadata.GetType().GetFields(BindingFlags.Public | BindingFlags.Instance).Where(f =>
                    f.Name.Contains("Diff", StringComparison.OrdinalIgnoreCase) || f.Name.Contains("Merge", StringComparison.OrdinalIgnoreCase)))
                    flags[field.Name] = JsonSerializer.SerializeToNode(field.GetValue(metadata));
                var proof = new JsonObject { ["referenceHash"] = reference.ReferenceHash, ["referenceKey"] = reference.Key,
                    ["verifyValid"] = snapshot.IsValid, ["elementsByType"] = JsonSerializer.SerializeToNode(reference.ElementsByType),
                    ["referenceHashMetadata"] = flags, ["contract"] = contractProof, ["dependencies"] = dependencyProof };
                Write(name + "-proof.json", proof); return proof;
            }
            finally { typeof(ModelHost).GetMethod("Release")!.Invoke(null, [module]); }
        }
        void Write(string name, JsonNode value) => File.WriteAllText(Path.Combine(work, name), value.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
    }

    // The product helper owns every merge tree and selection. Test-only preview trees observe the
    // native differences; they are disposed before invoking the same command path as MergeProbe.
    private static JsonObject ExplicitHashMerge(ModelHost host, string basePath, string foreignPath, string saveTo,
        string producerKey, string expectedHash, string selectionPath, string? concurrentChange = null, string scenario = "normal")
    {
        var load = typeof(ModelHost).GetMethod("Load", [typeof(string)])!;
        var release = typeof(ModelHost).GetMethod("Release")!;
        var local = load.Invoke(host, [scenario == "local-equal" ? foreignPath : basePath])!;
        var foreign = load.Invoke(host, [foreignPath])!;
        var basis = load.Invoke(host, [basePath])!;
        try
        {
            object Reference(object module) => ((IEnumerable)ModelHost.Prop(module, "References")!).Cast<object>()
                .Single(r => ModelHost.Prop(r, "ReferenceKey")?.ToString() == producerKey);
            var localReference = Reference(local);
            // Simulate a user-only alias edit relative to the original base. A hash selection must
            // not take the entire foreign reference and discard this concurrent local name.
            Mutate(local, "Test-only concurrent reference change", _ =>
            {
                if (scenario == "normal") localReference.GetType().GetMethod("SetName", [typeof(string)])!.Invoke(localReference, ["LocalRuntimeAlias"]);
                // Deliberate negative fixture edits, never a post-merge hash repair.
                if (concurrentChange == "hash") localReference.GetType().GetProperty("ReferenceHash")!.SetValue(localReference, Guid.NewGuid());
                if (concurrentChange == "producer")
                {
                    var property = localReference.GetType().GetProperty("ReferenceKey")!;
                    var different = property.PropertyType.GetMethod("Parse", [typeof(string)])!.Invoke(null, [Guid.NewGuid().ToString()]);
                    property.SetValue(localReference, different);
                }
            });
            if (concurrentChange == "invalid-foreign") Mutate(foreign, "Test-only invalid signature", _ =>
                Reference(foreign).GetType().GetProperty("ReferenceHash")!.SetValue(Reference(foreign), Guid.Empty));
            var analyze = typeof(ReferenceSignatureMerge).GetMethod("Analyze")!;
            var plan = (ReferenceSignatureMergePlan)analyze.Invoke(null, [local, foreign, basis])!;
            var type = local.GetType().Assembly.GetType("ServiceStudio.Merge.MatchTree")!;
            var helper = typeof(ReferenceSignatureMerge).GetMethod("MergeInCurrentCommand")!;
            var verifyApplied = typeof(ReferenceSignatureMerge).GetMethod("VerifyApplied")!;
            var selection = new JsonObject { ["plan"] = JsonSerializer.SerializeToNode(plan),
                ["mergeApi"] = "ReferenceSignatureMerge.MergeInCurrentCommand + MatchTree.Merge" };
            var callbacks = new JsonArray(); selection["callbacks"] = callbacks;
            var callbackCount = 0;
            var initialHash = ModelHost.Prop(localReference, "ReferenceHash")!.ToString();
            var initialAlias = ModelHost.Prop(localReference, "Name")!.ToString();
            var initialProducer = ModelHost.Prop(localReference, "ReferenceKey")!.ToString();
            var conflicts = plan.HasConflicts;
            object Pair(object tree)
            {
                var match = ModelHost.Prop(localReference, "Match")!;
                Assert.Same(tree, ModelHost.Prop(match, "Tree"));
                var descriptor = localReference.GetType().GetField("ReferenceHashPropertyDescriptor", BindingFlags.Public | BindingFlags.Static)!.GetValue(null)!;
                return match.GetType().GetMethod("GetPropertyPair")!.Invoke(match, [descriptor])!;
            }
            if (!plan.HasConflicts)
            {
                using var preview = (IDisposable)Activator.CreateInstance(type, [local, foreign, basis, false, true])!;
                conflicts = (bool)type.GetProperty("HasConflicts")!.GetValue(preview)!;
                selection["hasNoDifferencesBefore"] = (bool)type.GetProperty("HasNoDifferences")!.GetValue(preview)!;
                var pair = Pair(preview);
                selection["property"] = "ReferenceHash";
                selection["base"] = ModelHost.Prop(pair, "BaseValue")!.ToString();
                selection["local"] = ModelHost.Prop(pair, "LocalValue")!.ToString();
                selection["foreign"] = ModelHost.Prop(pair, "ForeignValue")!.ToString();
                selection["difference"] = ModelHost.Prop(pair, "Difference")!.ToString();
                selection["before"] = ModelHost.Prop(pair, "MergeAction")!.ToString();
                Assert.Equal(expectedHash, selection["foreign"]!.ToString());
                Assert.Equal("None", selection["before"]!.ToString());
            }
            Assert.Null(ModelHost.Prop(localReference, "Match"));
            Action<object> mergeOne = tree =>
            {
                callbackCount++;
                Assert.False(plan.HasConflicts);
                var pair = Pair(tree);
                Assert.Equal(expectedHash, ModelHost.Prop(pair, "ForeignValue")!.ToString());
                Assert.False((bool)type.GetProperty("HasConflicts")!.GetValue(tree)!);
                var callback = new JsonObject { ["hasNoDifferences"] = (bool)type.GetProperty("HasNoDifferences")!.GetValue(tree)!,
                    ["selection"] = ModelHost.Prop(pair, "MergeAction")!.ToString() };
                callbacks.Add(callback);
                selection["after"] = callback["selection"]!.DeepClone();
                type.GetMethod("Merge", Type.EmptyTypes)!.Invoke(tree, null);
                callback["referenceHashAfterMerge"] = ModelHost.Prop(localReference, "ReferenceHash")!.ToString();
            };
            var nativeCallback = Delegate.CreateDelegate(helper.GetParameters()[4].ParameterType, mergeOne.Target, mergeOne.Method);
            ReferenceSignatureMergeResult? applied = null;
            try
            {
                Mutate(local, "Test-only product reference signature merge", _ =>
                {
                    if (concurrentChange == "hash-after-plan") localReference.GetType().GetProperty("ReferenceHash")!.SetValue(localReference, Guid.NewGuid());
                    applied = (ReferenceSignatureMergeResult)helper.Invoke(null, [local, foreign, basis, plan, nativeCallback, false])!;
                });
                verifyApplied.Invoke(null, [local, foreign, basis, plan]);
            }
            catch (Exception error)
            {
                // Rejected plans never reach a native merge callback, and the SDK command rolls
                // back the deliberate hash-after-plan edit before this independent observation.
                selection["error"] = error.ToString();
                selection["nativeCallbacksBeforeRejection"] = callbackCount;
                selection["matchAfterRejectedMerge"] = ModelHost.Prop(localReference, "Match") != null;
                selection["referenceHashAfterRejectedCommand"] = ModelHost.Prop(localReference, "ReferenceHash")!.ToString();
                File.WriteAllText(selectionPath, selection.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
                Assert.Equal(0, callbackCount);
                Assert.Empty(callbacks);
                Assert.Null(ModelHost.Prop(localReference, "Match"));
                Assert.Equal(initialHash, ModelHost.Prop(localReference, "ReferenceHash")!.ToString());
                Assert.Equal(initialAlias, ModelHost.Prop(localReference, "Name")!.ToString());
                Assert.Equal(initialProducer, ModelHost.Prop(localReference, "ReferenceKey")!.ToString());
                throw;
            }
            Assert.NotNull(applied);
            Assert.False(plan.HasConflicts);
            Assert.Null(ModelHost.Prop(localReference, "Match"));
            selection["selected"] = applied.SelectedReferences;
            selection["nativeMergeCount"] = applied.NativeMergeCount;
            Assert.Equal(applied.NativeMergeCount, callbackCount);
            Assert.Equal(callbackCount, callbacks.Count);
            Assert.Equal(scenario == "normal" ? 2 : scenario == "metadata-only" ? 1 : 0, applied.NativeMergeCount);
            Assert.Equal(scenario is "normal" or "metadata-only" ? 1 : 0, applied.SelectedReferences);
            using (var preview = (IDisposable)Activator.CreateInstance(type, [local, foreign, basis, false, true])!)
                selection["hasNoDifferencesAfter"] = (bool)type.GetProperty("HasNoDifferences")!.GetValue(preview)!;
            selection["localAliasAfterMerge"] = ModelHost.Prop(Reference(local), "Name")!.ToString();
            selection["referenceHashAfterMerge"] = ModelHost.Prop(Reference(local), "ReferenceHash")!.ToString();
            File.WriteAllText(selectionPath, selection.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
            if (scenario == "normal") Assert.Equal("LocalRuntimeAlias", selection["localAliasAfterMerge"]!.ToString());
            if (scenario is "metadata-only" or "noop" or "local-equal")
            {
                Assert.True(selection["hasNoDifferencesBefore"]!.GetValue<bool>());
                Assert.True(selection["hasNoDifferencesAfter"]!.GetValue<bool>());
                Assert.Equal(scenario == "metadata-only" ? 1 : 0, selection["selected"]!.GetValue<int>());
            }
            var bytes = (byte[])typeof(ModelHost).GetMethod("Save")!.Invoke(host, [local])!;
            File.WriteAllBytes(saveTo, bytes);
            return new JsonObject { ["LocalIsValid"] = host.Inspect(saveTo).IsValid, ["HasConflicts"] = conflicts,
                ["selection"] = selection };
        }
        finally
        {
            release.Invoke(null, [local]); release.Invoke(null, [foreign]); release.Invoke(null, [basis]);
        }
        static void Mutate(object module, string description, Action<object> action)
        {
            var method = typeof(Publisher).GetMethod("Mutate")!;
            var callback = Delegate.CreateDelegate(method.GetParameters()[2].ParameterType, action.Target, action.Method);
            method.Invoke(null, [module, description, callback]);
        }
    }
    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static JsonObject Contract(string signature, bool includeLength)
    {
        var snapshot = NativeReferenceSnapshot.Read(signature);
        JsonObject Parameter(string name) => new() { ["name"] = name, ["type"] = "Text" };
        JsonObject Action(string name, string call, JsonArray inputs, JsonObject arguments) => new() {
            ["name"] = name, ["kind"] = "server", ["public"] = true, ["access"] = new JsonObject { ["authenticated"] = true },
            ["inputs"] = inputs, ["outputs"] = new JsonArray(new JsonObject { ["name"] = "Result", ["type"] = "Integer" }),
            ["steps"] = new JsonArray(new JsonObject { ["call"] = snapshot.Bind(call), ["as"] = "Native", ["args"] = arguments },
                new JsonObject { ["assign"] = new JsonObject { ["Result"] = "Native.Result" } })
        };
        var actions = new JsonArray(Action("CompareText", "IServerActionSignature:CSharpTextCompareOrdinal",
            new JsonArray(Parameter("Left"), Parameter("Right")), new JsonObject { ["Left"] = "Left", ["Right"] = "Right" }));
        if (includeLength) actions.Add(Action("MeasureText", "IServerActionSignature:CSharpTextUtf16Length",
            new JsonArray(Parameter("Value")), new JsonObject { ["Value"] = "Value" }));
        return new JsonObject { ["logic"] = new JsonObject { ["actions"] = actions } };
    }
}
