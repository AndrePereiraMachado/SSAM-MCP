using System.Collections;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

[CollectionDefinition(nameof(ThinBridgeTests), DisableParallelization = true)]
public sealed class ThinBridgeCollection;

/// <summary>The server half of the thin O11 bridge (docs/O11-BRIDGE-FINA.md section 4). No Studio process: a fake send
/// or a TCP listener of the test stands for the bridge, and models load headless. Studio model types are reached by
/// reflection, as in the other native tests (this project does not reference the model assemblies).</summary>
[Collection(nameof(ThinBridgeTests))]
public sealed class ThinBridgeTests : IDisposable
{
    private const string TestKey = "thin-bridge-test-key";
    // Not under the per-test folder: the first ModelHost of the process keeps the headless runtime settings there.
    private static readonly string ModelWork = Path.Combine(Path.GetTempPath(), "thin-bridge-tests", "model");
    private const string NotSent = "; nothing was sent to the bridge, executed: false";
    private static readonly Guid ForeignHash = Guid.Parse("5d1c3a0e-7b42-4f8e-9a61-2c0f4b8d9e17");
    private static readonly string[] Variables = ["ANVIL_BRIDGE_FLAVOR", "ANVIL_BRIDGE_TIMEOUT_SECONDS", "ANVIL_AUTHORITY_DIR"];
    private readonly Dictionary<string, string?> saved = Variables.ToDictionary(name => name, Environment.GetEnvironmentVariable);
    private readonly string work = Directory.CreateTempSubdirectory("thin-bridge-tests-").FullName;

    public void Dispose()
    {
        foreach (var (name, value) in saved) Environment.SetEnvironmentVariable(name, value);
        try { Directory.Delete(work, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    [Fact]
    public void WithoutTheFlavorBridgeClientSendsTodaysLineForEveryVerb()
    {
        Environment.SetEnvironmentVariable("ANVIL_BRIDGE_FLAVOR", null);
        Environment.SetEnvironmentVariable("ANVIL_BRIDGE_TIMEOUT_SECONDS", null);
        UseAuthority();
        using var bridge = new LineBridge();
        // marco-a6: with the CX14 stall probes off the line of every verb is today's (the probes have their own tests, BridgeStall*).
        var client = new BridgeClient(bridge.Port, probeMs: 0);
        var found = client.Call("find_element", new JsonObject { ["name"] = "Probe", ["module_key"] = "K" });
        client.Call("login", new JsonObject { ["path"] = @"C:\missing\login.json" });
        client.Call("merge_from_oml", new JsonObject { ["base_path"] = @"C:\missing\base.oml", ["foreign_path"] = @"C:\missing\foreign.oml" });
        client.Call("ping");
        Assert.Equal(new[] {
            """{"method":"find_element","params":{"name":"Probe","module_key":"K"},"authorization":"thin-bridge-test-key"}""",
            """{"method":"login","params":{"path":"C:\\missing\\login.json"},"authorization":"thin-bridge-test-key"}""",
            """{"method":"merge_from_oml","params":{"base_path":"C:\\missing\\base.oml","foreign_path":"C:\\missing\\foreign.oml"},"authorization":"thin-bridge-test-key"}""",
            """{"method":"ping","params":null,"authorization":"thin-bridge-test-key"}""" }, bridge.Lines);
        Assert.Equal("find_element", found["method"]!.ToString());
    }

    [Fact]
    public void WithTheThinFlavorBridgeClientRefusesBeforeConnectingAndReadsTheFlavorPerCall()
    {
        Environment.SetEnvironmentVariable("ANVIL_BRIDGE_FLAVOR", "thin");
        Environment.SetEnvironmentVariable("ANVIL_BRIDGE_TIMEOUT_SECONDS", "600");
        UseAuthority();
        using var bridge = new LineBridge();
        var client = new BridgeClient(bridge.Port);
        var refused = Assert.Throws<BridgeCallException>(() => client.Call("login", new JsonObject { ["path"] = @"C:\missing\login.json" }));
        Assert.False(refused.Executed);
        Assert.Equal("ping", client.Call("ping")["method"]!.ToString());
        Assert.Equal(new[] { """{"method":"ping","params":null,"authorization":"thin-bridge-test-key"}""" }, bridge.Lines);
        Environment.SetEnvironmentVariable("ANVIL_BRIDGE_FLAVOR", null);
        client.Call("login", new JsonObject { ["path"] = @"C:\missing\login.json" });
        Assert.Equal("""{"method":"login","params":{"path":"C:\\missing\\login.json"},"authorization":"thin-bridge-test-key"}""", bridge.Lines[^1]);
    }

    public static TheoryData<string> PassThroughVerbs => new()
    {
        "ping", "bridge_manifest", "get_active_module", "list_open_modules", "get_errors", "open_module", "close_module", "publish",
        "windows", "ui_alive", "close_dialog", "snapshot_module", "merge_status", "environment_session", "sc_api", "sc_web",
        "studio_login", "sc_session", "publish_log", "merge_from_oml",
    };

    [Theory]
    [MemberData(nameof(PassThroughVerbs))]
    public void ThinPassThroughVerbsReachSendUnchanged(string method)
    {
        var fake = new FakeBridge();
        var thin = new ThinBridge(fake.Send);
        // merge_from_oml without base_path: the thin bridge refuses it itself (SnapshotRegistry), so no plan is added.
        var parameters = new JsonObject { ["module_key"] = "K", ["environment"] = "env.example", ["path"] = @"C:\t\x.oml",
            ["foreign_path"] = @"C:\t\foreign.oml", ["operation"] = "modules", ["max"] = 5 };
        var before = parameters.ToJsonString();
        Assert.Equal(method, thin.Call(method, parameters)["echo"]!.ToString());
        thin.Call(method, null);
        Assert.Equal(new[] { method, method }, fake.Calls.Select(c => c.Method));
        Assert.Same(parameters, fake.Calls[0].Parameters);
        Assert.Equal(before, parameters.ToJsonString());
        Assert.Null(fake.Calls[1].Parameters);
    }

    [Theory]
    [InlineData("login")]
    [InlineData("export_modules")]
    [InlineData("export_status")]
    [InlineData("get_flow_nodes")]
    public void VerbsTheThinBridgeDoesNotHaveAreRefusedWithoutSending(string method)
    {
        var fake = new FakeBridge();
        var error = Assert.Throws<BridgeCallException>(() => new ThinBridge(fake.Send).Call(method, new JsonObject { ["name"] = "Probe" }));
        Assert.False(error.Executed);
        Assert.Equal(method + ": not available with the thin bridge (hosted)" + NotSent, error.Message);
        Assert.Empty(fake.Calls);
    }

    [Fact]
    public void MergeWithBaseCarriesTheReferencePlanTheServerComputes()
    {
        StudioAssemblies.Bind();
        var basePath = Copy("blank-service.oml", "base.oml");
        var same = Merge(basePath, basePath, callerPlan: null);
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse("""{"Changes":[],"Conflicts":[],"HasChanges":false,"HasConflicts":false}"""), same["reference_plan"]));
        Assert.True(JsonNode.DeepEquals(ExpectedPlan(basePath, basePath), same["reference_plan"]));

        // The committed fixture references (System) with an empty ReferenceHash; the candidate carries another one.
        var foreignPath = WithReferenceHash(basePath, ForeignHash, "foreign.oml");
        var expected = ExpectedPlan(basePath, foreignPath);
        Assert.True(expected["HasChanges"]!.GetValue<bool>(), expected.ToJsonString());
        Assert.False(expected["HasConflicts"]!.GetValue<bool>(), expected.ToJsonString());
        var stale = new JsonObject { ["Changes"] = new JsonArray(), ["Conflicts"] = new JsonArray(), ["HasChanges"] = false, ["HasConflicts"] = false };
        var changed = Merge(basePath, foreignPath, callerPlan: stale);
        Assert.True(JsonNode.DeepEquals(expected, changed["reference_plan"]), changed["reference_plan"]!.ToJsonString());
        var change = Assert.Single(changed["reference_plan"]!["Changes"]!.AsArray())!;
        Assert.Equal(ForeignHash.ToString(), change["ForeignHash"]!.ToString());
        Assert.Equal(Guid.Empty.ToString(), change["BaseHash"]!.ToString());
        Assert.Equal("eSpace", change["Kind"]!.ToString());
    }

    [Fact]
    public void AFailureBeforeSendIsExecutedFalseAndNothingIsSent()
    {
        StudioAssemblies.Bind();
        var notOml = Path.Combine(work, "base.oml");
        File.WriteAllText(notOml, "snapshot");
        var foreign = Copy("blank-service.oml", "foreign.oml");
        var fake = new FakeBridge();
        var thin = new ThinBridge(fake.Send);
        foreach (var parameters in new[] {
            new JsonObject { ["base_path"] = notOml, ["foreign_path"] = foreign, ["mode"] = "auto" },
            new JsonObject { ["base_path"] = foreign, ["mode"] = "auto" },
            new JsonObject { ["base_path"] = Path.Combine(work, "missing.oml"), ["foreign_path"] = foreign } })
        {
            var error = Assert.Throws<BridgeCallException>(() => thin.Call("merge_from_oml", parameters));
            Assert.False(error.Executed);
            Assert.StartsWith("merge_from_oml: ", error.Message);
            Assert.EndsWith(NotSent, error.Message);
        }
        Assert.Empty(fake.Calls);
    }

    [Fact]
    public void DeliveryRecordsNotSentWhenTheThinBridgeFailsBeforeTheMerge()
    {
        StudioAssemblies.Bind();
        var job = Path.Combine(work, "job.json");
        File.WriteAllText(job, "{\"ops\":[]}");
        var sent = new List<string>();
        // Shaped like DeliveryResumeTests.Bridge: the snapshot writes text that is not an OML.
        JsonObject Send(string method, JsonObject? parameters)
        {
            sent.Add(method);
            switch (method)
            {
                case "open_module": return new() { ["opened"] = true };
                case "get_active_module": return new() { ["name"] = "Probe", ["key"] = "A" };
                case "snapshot_module": File.WriteAllText(parameters!["path"]!.ToString(), "snapshot"); return new() { ["key"] = "A", ["snapshot_id"] = "base-id" };
                case "merge_from_oml": return new() { ["merged"] = true, ["newErrors"] = 0 };
                default: throw new Exception("Unexpected call: " + method);
            }
        }
        JsonObject Apply(string _, string __, string output) { File.WriteAllText(output, "foreign"); return new() { ["isValid"] = true, ["accepted"] = true }; }
        var result = Delivery.Run(new ThinClient(new ThinBridge(Send)), new("Probe", job, work, Array.Empty<string>()), Apply);
        Assert.False(result["delivered"]!.GetValue<bool>());
        Assert.Equal("not-sent", result["writeState"]!.ToString());
        Assert.Contains("merge_from_oml: ", result["error"]!.ToString());
        Assert.Contains(NotSent, result["error"]!.ToString());
        Assert.Equal(new[] { "open_module", "get_active_module", "snapshot_module" }, sent);
    }

    [Fact]
    public void FindElementRunsOverOneCaptureWithTheReadsFindShape()
    {
        StudioAssemblies.Bind();
        var fixture = Fixture("blank-service.oml");
        var fake = new FakeBridge
        {
            Handler = (method, parameters) =>
            {
                if (method != "snapshot_module") return new() { ["echo"] = method };
                File.Copy(fixture, parameters!["path"]!.ToString());
                return new() { ["key"] = parameters["module_key"]?.DeepClone() };
            },
        };
        var thin = new ThinBridge(fake.Send);
        var target = new JsonObject { ["module_key"] = "Kawk_WFx5USxo7qFAB0lCQ", ["environment"] = "env.example" };
        JsonObject Find(string name, int? max = null, JsonObject? on = null)
        {
            var parameters = (on ?? target).DeepClone().AsObject();
            parameters["name"] = name;
            if (max != null) parameters["max"] = max;
            return thin.Call("find_element", parameters);
        }

        var role = Find("CheckRegisteredRole");
        var snapshot = Assert.Single(fake.Calls);
        Assert.Equal("snapshot_module", snapshot.Method);
        var capture = snapshot.Parameters!["path"]!.ToString();
        Assert.Equal(Path.Combine(Path.GetTempPath(), "thin-bridge"), Path.GetDirectoryName(capture));
        Assert.Equal(".oml", Path.GetExtension(capture));
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse($$"""{"path":{{JsonSerializer.Serialize(capture)}},"module_key":"Kawk_WFx5USxo7qFAB0lCQ","environment":"env.example"}"""), snapshot.Parameters));
        Assert.False(File.Exists(capture), "the server copy of the capture is deleted");
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse("""
            {"query":"CheckRegisteredRole","count":1,"results":[{"name":"CheckRegisteredRole","type":"ActionSignature","key":"I1Fm79oZdUu8QBe+dLY9Cg.#CheckRole","parent":"Registered"}]}
            """), role), role.ToJsonString());

        // Same capture for the following calls: another case, no match, and a cut by max.
        var user = Find("user");
        Assert.Equal("user", user["query"]!.ToString());
        AssertSameResults(JsonNode.Parse("""
            {"query":"user","count":2,"results":[{"name":"User","type":"ServerEntitySignature","key":"CTZe7oRWOESVJTS0gEBD6g","parent":"(System)"},
              {"name":"User","type":"Attribute","key":"2ruFkCbHPEW1rMYR48jU8A","parent":"User Record"}]}
            """)!.AsObject(), user);
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse("""{"query":"ThinBridgeNoSuchElement","count":0,"results":[]}"""), Find("ThinBridgeNoSuchElement")));
        var all = Find("Id", 100);
        Assert.Equal(14, all["count"]!.GetValue<int>());
        var cut = Find("Id", 3);
        Assert.Equal(3, cut["count"]!.GetValue<int>());
        Assert.All(cut["results"]!.AsArray(), r => Assert.Contains(all["results"]!.AsArray(), a => JsonNode.DeepEquals(a, r)));
        Assert.Equal(14, Find("Id")["count"]!.GetValue<int>()); // the default max (20) does not cut

        // The Reads.Find expression evaluated here over the same fixture (descendant order is the model's own, so the
        // results compare as sets).
        foreach (var (name, max) in new[] { ("CheckRegisteredRole", 20), ("user", 20), ("Registered", 20), ("ThinBridgeNoSuchElement", 20), ("Id", 100) })
            AssertSameResults(ReadsFindOracle(fixture, name, max), Find(name, max));
        Assert.Single(fake.Calls);

        // Any other verb drops the capture; other targets take another one.
        thin.Call("get_errors", target.DeepClone().AsObject());
        Find("Registered");
        Find("Registered", on: new JsonObject { ["module_key"] = "Other", ["environment"] = "env.example" });
        Find("Registered", on: new JsonObject { ["module_key"] = "Other", ["environment"] = "env.example" });
        Assert.Equal(new[] { "snapshot_module", "get_errors", "snapshot_module", "snapshot_module" }, fake.Calls.Select(c => c.Method));
        Assert.Equal("Other", fake.Calls[3].Parameters!["module_key"]!.ToString());
        Assert.Equal(3, fake.Calls.Where(c => c.Method == "snapshot_module").Select(c => c.Parameters!["path"]!.ToString()).Distinct().Count());
        Assert.All(fake.Calls.Where(c => c.Method == "snapshot_module"), c => Assert.False(File.Exists(c.Parameters!["path"]!.ToString())));

        // Another verb releases the last capture: no module stays loaded in this process (FunctionCatalogTests and
        // JobSourceTests assert that the Studio registry is empty).
        thin.Call("get_errors", target.DeepClone().AsObject());
        Assert.Equal(0, ModelHost.LoadedModules().Count);
    }

    [Fact]
    public void FindElementFailuresBeforeTheAnswerAreExecutedFalse()
    {
        StudioAssemblies.Bind();
        var fake = new FakeBridge
        {
            Handler = (method, parameters) =>
            {
                if (method == "snapshot_module") File.WriteAllText(parameters!["path"]!.ToString(), "snapshot");
                return new() { ["echo"] = method };
            },
        };
        var thin = new ThinBridge(fake.Send);
        var unnamed = Assert.Throws<BridgeCallException>(() => thin.Call("find_element", new JsonObject { ["module_key"] = "K" }));
        Assert.False(unnamed.Executed);
        Assert.Equal("find_element: InvalidOperationException: 'name' is required" + NotSent, unnamed.Message);
        Assert.Empty(fake.Calls);
        var notOml = Assert.Throws<BridgeCallException>(() => thin.Call("find_element", new JsonObject { ["name"] = "User", ["module_key"] = "K" }));
        Assert.False(notOml.Executed);
        Assert.EndsWith(NotSent, notOml.Message);
        Assert.Equal("snapshot_module", Assert.Single(fake.Calls).Method);
        Assert.False(File.Exists(fake.Calls[0].Parameters!["path"]!.ToString()));
    }

    /// <summary>A resident worker runs many deliveries in one process. The checks of a delivery (find_element) load one
    /// capture of the module on the server; no later verb of that delivery drops it (no data proof, no tab to close), so
    /// the delivery itself releases it when it ends, as the exit of a cold process would.</summary>
    [Fact]
    public void ADeliveryWithChecksReleasesTheThinCaptureWhenItEnds()
    {
        StudioAssemblies.Bind();
        Environment.SetEnvironmentVariable("ANVIL_BRIDGE_FLAVOR", "thin");
        Environment.SetEnvironmentVariable("ANVIL_BRIDGE_TIMEOUT_SECONDS", null);
        UseAuthority();
        var fixture = Fixture("blank-service.oml");
        var job = Path.Combine(work, "job.json");
        File.WriteAllText(job, "{\"ops\":[]}");
        using var bridge = new LineBridge((method, parameters) => method switch
        {
            "open_module" => new() { ["opened"] = true },
            "get_active_module" => new() { ["name"] = "Probe", ["key"] = "A" },
            "snapshot_module" => Snapshot(parameters!),
            "merge_from_oml" => new() { ["merged"] = true, ["newErrors"] = 0, ["has_plan"] = parameters!["reference_plan"] != null },
            "get_errors" => new() { ["newErrors"] = 0, ["new"] = new JsonArray(), ["fixed"] = new JsonArray(), ["preexisting"] = new JsonArray() },
            _ => throw new InvalidOperationException("Unexpected call: " + method),
        });
        JsonObject Snapshot(JsonObject parameters)
        {
            File.Copy(fixture, parameters["path"]!.ToString());
            return new() { ["key"] = "A", ["snapshot_id"] = "base-id" };
        }
        JsonObject Apply(string _, string __, string output) { File.Copy(fixture, output); return new() { ["isValid"] = true, ["accepted"] = true }; }
        Assert.Equal(0, ModelHost.LoadedModules().Count);

        var client = new BridgeClient(bridge.Port);
        var result = Delivery.Run(client, new("Probe", job, work, new[] { "User", "CheckRegisteredRole" }), Apply);

        Assert.True(result["delivered"]!.GetValue<bool>(), result.ToJsonString());
        Assert.True(result["merge"]!["has_plan"]!.GetValue<bool>(), "the merge went through the thin bridge");
        // Both checks ran over one capture of the server: the snapshot after the merge is the thin bridge's own.
        Assert.Equal(new[] { "open_module", "get_active_module", "snapshot_module", "merge_from_oml", "get_active_module", "get_errors", "snapshot_module" }, bridge.Methods);
        Assert.Equal(new[] { 2, 1 }, result["checks"]!.AsArray().Select(c => c!["count"]!.GetValue<int>()));
        // Nothing stays loaded in this process once the delivery returned.
        Assert.Equal(0, ModelHost.LoadedModules().Count);

        // The client stays usable after the release: the next find_element takes a capture again; another release frees it.
        var again = client.Call("find_element", new JsonObject { ["name"] = "Registered", ["module_key"] = "A" });
        Assert.Equal(1, again["count"]!.GetValue<int>());
        Assert.Equal(1, ModelHost.LoadedModules().Count);
        client.ReleaseCapture();
        client.ReleaseCapture();
        Assert.Equal(0, ModelHost.LoadedModules().Count);
    }

    /// <summary>A delivery that fails after its checks loaded the capture releases it too (the finally of Delivery.Run).</summary>
    [Fact]
    public void AFailedDeliveryReleasesTheThinCaptureToo()
    {
        StudioAssemblies.Bind();
        var fixture = Fixture("blank-service.oml");
        var job = Path.Combine(work, "job.json");
        File.WriteAllText(job, "{\"ops\":[]}");
        var fake = new FakeBridge
        {
            Handler = (method, parameters) => method switch
            {
                "open_module" => new() { ["opened"] = true },
                "get_active_module" => new() { ["name"] = "Probe", ["key"] = "A" },
                "snapshot_module" => Copied(parameters!),
                "merge_from_oml" => new() { ["merged"] = true, ["newErrors"] = 0 },
                "get_errors" => new() { ["newErrors"] = 0, ["new"] = new JsonArray(), ["fixed"] = new JsonArray(), ["preexisting"] = new JsonArray() },
                _ => throw new InvalidOperationException("Unexpected call: " + method),
            },
        };
        JsonObject Copied(JsonObject parameters) { File.Copy(fixture, parameters["path"]!.ToString()); return new() { ["key"] = "A", ["snapshot_id"] = "base-id" }; }
        JsonObject Apply(string _, string __, string output) { File.Copy(fixture, output); return new() { ["isValid"] = true, ["accepted"] = true }; }
        var thin = new ThinBridge(fake.Send);
        var result = Delivery.Run(new ThinClient(thin), new("Probe", job, work, new[] { "ThinBridgeNoSuchElement" }), Apply);
        Assert.False(result["delivered"]!.GetValue<bool>());
        Assert.Contains("requested element 'ThinBridgeNoSuchElement' was not found", result["error"]!.ToString());
        Assert.Equal(2, fake.Calls.Count(c => c.Method == "snapshot_module"));
        Assert.Equal(0, ModelHost.LoadedModules().Count);
    }

    /// <summary>servidor/fase4-26 a7 (E1): the hosted kernel (the thin flavor) talks to the bridge of the SSAM agent pack, which
    /// does not run the Studio's Manage Dependencies (refresh_references:add): the answer of a rolled-back merge names the agent
    /// pack, never the local shortcut (reopening the Studio loads the same bridge). Locally the text is the product's.</summary>
    [Fact]
    public void TheRollbackAlignmentOfTheThinFlavorNamesTheAgentPackNeverTheLocalShortcut()
    {
        var alignment = new JsonObject { ["requires"] = Delivery.ManageDependenciesCapability, ["bridgeOffers"] = false,
            ["add"] = new JsonArray(new JsonObject { ["producer"] = "ZZExt", ["kind"] = "Extension", ["elements"] = new JsonArray("ZZAction") }) };
        Environment.SetEnvironmentVariable("ANVIL_BRIDGE_FLAVOR", "thin");
        var hosted = Delivery.AlignmentText(alignment, "ZZExt", null);
        Assert.Contains("agent package", hosted);
        Assert.Contains("MANAGE_DEPENDENCIES_HOSTED_PENDING", hosted);
        Assert.DoesNotContain("Service Studio (SSAM)", hosted);
        Assert.DoesNotContain("next Service Studio opened", hosted);
        Environment.SetEnvironmentVariable("ANVIL_BRIDGE_FLAVOR", null);
        var local = Delivery.AlignmentText(alignment, "ZZExt", null);
        Assert.Contains("Service Studio (SSAM)", local);
        Assert.DoesNotContain("agent package", local);
    }
    [Fact]
    public void TheSocketTimeoutIsTheLargerOfRequestedAndConfigured()
    {
        Environment.SetEnvironmentVariable("ANVIL_BRIDGE_TIMEOUT_SECONDS", null);
        Assert.Equal(120, ThinBridge.EffectiveTimeout(120));
        Environment.SetEnvironmentVariable("ANVIL_BRIDGE_TIMEOUT_SECONDS", "600");
        Assert.Equal(600, ThinBridge.EffectiveTimeout(120));
        Assert.Equal(600, ThinBridge.EffectiveTimeout(330));
        Assert.Equal(900, ThinBridge.EffectiveTimeout(900));
        Environment.SetEnvironmentVariable("ANVIL_BRIDGE_FLAVOR", null);
        Assert.False(ThinBridge.Enabled);
        Environment.SetEnvironmentVariable("ANVIL_BRIDGE_FLAVOR", "thin");
        Assert.True(ThinBridge.Enabled);
    }

    private JsonObject Merge(string basePath, string foreignPath, JsonObject? callerPlan)
    {
        var fake = new FakeBridge();
        var parameters = new JsonObject { ["base_path"] = basePath, ["foreign_path"] = foreignPath, ["mode"] = "auto", ["operation_id"] = "op-1",
            ["base_sha256"] = DeliveryReceipt.Hash(basePath), ["foreign_sha256"] = DeliveryReceipt.Hash(foreignPath), ["module_key"] = "K", ["environment"] = "env.example" };
        if (callerPlan != null) parameters["reference_plan"] = callerPlan;
        var before = parameters.ToJsonString();
        new ThinBridge(fake.Send).Call("merge_from_oml", parameters);
        var call = Assert.Single(fake.Calls);
        Assert.Equal("merge_from_oml", call.Method);
        Assert.Equal(before, parameters.ToJsonString());
        var forwarded = call.Parameters!;
        Assert.NotNull(forwarded["reference_plan"]);
        var rest = forwarded.DeepClone().AsObject(); rest.Remove("reference_plan");
        var original = parameters.DeepClone().AsObject(); original.Remove("reference_plan");
        Assert.True(JsonNode.DeepEquals(original, rest), "only reference_plan is added: " + rest.ToJsonString());
        return forwarded;
    }

    private JsonNode ExpectedPlan(string basePath, string foreignPath)
    {
        var host = new ModelHost(ModelWork);
        var load = typeof(ModelHost).GetMethod("Load", [typeof(string)])!;
        var basis = load.Invoke(host, [basePath])!;
        var foreign = load.Invoke(host, [foreignPath])!;
        try { return JsonSerializer.SerializeToNode(typeof(ReferenceSignatureMerge).GetMethod("Analyze")!.Invoke(null, [basis, foreign, basis]))!; }
        finally { Release(foreign); Release(basis); }
    }

    private string WithReferenceHash(string source, Guid hash, string name)
    {
        var host = new ModelHost(ModelWork);
        var module = typeof(ModelHost).GetMethod("Load", [typeof(string)])!.Invoke(host, [source])!;
        try
        {
            var reference = Assert.Single(((IEnumerable)ModelHost.Prop(module, "References")!).Cast<object>());
            Action<object> change = _ => reference.GetType().GetProperty("ReferenceHash")!.SetValue(reference, hash);
            var mutate = typeof(Publisher).GetMethod("Mutate")!;
            mutate.Invoke(null, [module, "Test-only producer signature change", Delegate.CreateDelegate(mutate.GetParameters()[2].ParameterType, change.Target, change.Method)]);
            var path = Path.Combine(work, name);
            File.WriteAllBytes(path, (byte[])typeof(ModelHost).GetMethod("Save")!.Invoke(host, [module])!);
            return path;
        }
        finally { Release(module); }
    }

    /// <summary>The expression of the full bridge's Reads.Find (kernel/src/Anvil.Bridge/Reads.cs) over a module loaded
    /// here: EntityIndexes.IncludeNative over the descendants, Name or Label, TypeName or Kind, parent by Name.</summary>
    private JsonObject ReadsFindOracle(string oml, string name, int max)
    {
        var host = new ModelHost(ModelWork);
        var module = typeof(ModelHost).GetMethod("Load", [typeof(string)])!.Invoke(host, [oml])!;
        try
        {
            var signature = Type.GetType("OutSystems.Model.IObjectSignature, OutSystems.Model.V1", true)!;
            var descendants = signature.GetMethods().Single(m => m.Name == "GetAllDescendantsOfType" && m.IsGenericMethodDefinition && m.GetParameters().Length == 0)
                .MakeGenericMethod(signature).Invoke(module, null);
            var results = new JsonArray();
            foreach (var o in (IEnumerable)typeof(EntityIndexes).GetMethod("IncludeNative")!.Invoke(null, [descendants])!)
            {
                var n = ModelHost.Prop(o, "Name") as string ?? ModelHost.Prop(o, "Label") as string;
                if (!string.Equals(n, name, StringComparison.OrdinalIgnoreCase)) continue;
                var kind = (Type?)signature.GetMethod("GetInterface", Type.EmptyTypes)!.Invoke(o, null);
                var parent = signature.GetProperty("Parent")!.GetValue(o);
                results.Add(new JsonObject { ["name"] = n, ["type"] = EntityIndexes.TypeName(o) ?? ModelHost.Kind(kind?.Name ?? o.GetType().Name),
                    ["key"] = signature.GetProperty("ObjectKey")!.GetValue(o)?.ToString(), ["parent"] = parent == null ? null : ModelHost.Prop(parent, "Name") as string });
                if (results.Count >= max) break;
            }
            return new JsonObject { ["query"] = name, ["count"] = results.Count, ["results"] = results };
        }
        finally { Release(module); }
    }

    private static void AssertSameResults(JsonObject expected, JsonObject actual)
    {
        Assert.Equal(new[] { "query", "count", "results" }, actual.Select(p => p.Key));
        Assert.Equal(expected["query"]!.ToString(), actual["query"]!.ToString());
        Assert.Equal(expected["count"]!.GetValue<int>(), actual["count"]!.GetValue<int>());
        static string[] Sorted(JsonNode results) => results.AsArray().Select(r => r!.ToJsonString()).Order(StringComparer.Ordinal).ToArray();
        Assert.Equal(Sorted(expected["results"]!), Sorted(actual["results"]!));
        Assert.All(actual["results"]!.AsArray(), r => Assert.Equal(new[] { "name", "type", "key", "parent" }, r!.AsObject().Select(p => p.Key)));
    }

    private static void Release(object module) => typeof(ModelHost).GetMethod("Release")!.Invoke(null, [module]);

    private static string Fixture(string name)
        => Path.Combine(JobRunner.RepoRoot(Path.GetDirectoryName(typeof(ThinBridgeTests).Assembly.Location)!)!, "tests", "fixtures", name);

    private string Copy(string fixture, string name)
    {
        var path = Path.Combine(work, name);
        File.Copy(Fixture(fixture), path);
        return path;
    }

    private void UseAuthority()
    {
        var authority = Path.Combine(work, "authority");
        Directory.CreateDirectory(authority);
        File.WriteAllText(Path.Combine(authority, "bridge.key"), TestKey);
        Environment.SetEnvironmentVariable("ANVIL_AUTHORITY_DIR", authority);
    }

    private sealed class FakeBridge
    {
        public readonly List<(string Method, JsonObject? Parameters)> Calls = [];
        public Func<string, JsonObject?, JsonObject>? Handler;
        public JsonObject Send(string method, JsonObject? parameters)
        {
            Calls.Add((method, parameters));
            return Handler?.Invoke(method, parameters) ?? new JsonObject { ["echo"] = method };
        }
    }

    private sealed class ThinClient(ThinBridge thin) : IBridgeClient
    {
        public JsonObject Call(string method, JsonObject? parameters = null) => thin.Call(method, parameters);
        public void ReleaseCapture() => thin.ReleaseCapture();
    }

    /// <summary>A bridge stand-in on a free port in 7400-7499: records each request line and answers success with the
    /// method name, or with what <c>respond</c> returns for the method and its params.</summary>
    private sealed class LineBridge : IDisposable
    {
        private readonly TcpListener listener;
        private readonly Task loop;
        private readonly List<string> lines = [];
        private readonly Func<string, JsonObject?, JsonObject>? respond;
        public int Port { get; }
        public IReadOnlyList<string> Lines { get { lock (lines) return lines.ToArray(); } }
        public IReadOnlyList<string> Methods => Lines.Select(l => JsonNode.Parse(l)!["method"]!.ToString()).ToArray();

        public LineBridge(Func<string, JsonObject?, JsonObject>? respond = null)
        {
            this.respond = respond;
            TcpListener? found = null;
            for (var port = 7400; port < 7500 && found == null; port++)
            {
                var candidate = new TcpListener(IPAddress.Loopback, port);
                try { candidate.Start(); found = candidate; Port = port; }
                catch (SocketException) { }
            }
            listener = found ?? throw new InvalidOperationException("No free test port in 7400-7499");
            loop = Task.Run(Serve);
        }

        private void Serve()
        {
            while (true)
            {
                TcpClient client;
                try { client = listener.AcceptTcpClient(); }
                catch (Exception ex) when (ex is SocketException or ObjectDisposedException or InvalidOperationException) { return; }
                using (client)
                {
                    var stream = client.GetStream();
                    var reader = new StreamReader(stream, new UTF8Encoding(false));
                    var writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true };
                    var line = reader.ReadLine();
                    if (line == null) continue;
                    lock (lines) lines.Add(line);
                    var request = JsonNode.Parse(line)!;
                    JsonObject reply;
                    try
                    {
                        var data = respond == null ? new JsonObject { ["method"] = request["method"]!.DeepClone() }
                            : respond(request["method"]!.ToString(), request["params"]?.AsObject());
                        reply = new JsonObject { ["success"] = true, ["data"] = data };
                    }
                    catch (Exception ex) { reply = new JsonObject { ["success"] = false, ["error"] = ex.Message, ["executed"] = false }; }
                    writer.WriteLine(reply.ToJsonString());
                }
            }
        }

        public void Dispose()
        {
            listener.Stop();
            loop.Wait(TimeSpan.FromSeconds(5));
        }
    }
}
