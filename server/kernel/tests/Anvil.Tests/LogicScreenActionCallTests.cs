using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public sealed class LogicScreenActionCallTests
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(LogicScreenActionCallTests).Assembly.Location)!)!;

    [Theory]
    [InlineData("LocalSibling")]
    [InlineData("IMobileScreen:Coverage/LocalSibling")]
    [InlineData("IActionSignature:LocalSibling")]
    [InlineData("OutSystems.Model.UI.Mobile.IScreenAction:LocalSibling")]
    public void ForwardScreenCallsBindToTheirOwnerBeforeTheCallerIsCreated(string target)
    {
        var caller = CallAction("Entry", "screen", "IMobileScreen:Coverage", target);
        var local = ValueAction("LocalSibling", "screen", "IMobileScreen:Coverage");
        var ops = LogicExpander.Expand(Logic(caller, local), _ => null);
        Assert.Equal(new[] { "LocalSibling", "Entry" }, ops.Where(o => o["type"]?.ToString() == "OutSystems.Model.UI.Mobile.IScreenAction").Select(o => o["name"]!.ToString()));
        Assert.Contains(ops, o => o["type"]?.ToString() == "IExecuteClientActionNode");
        Assert.Contains(ops, o => o["prop"]?.ToString() == "Action" && o["value"]?.ToString() == "IMobileScreen:Coverage/LocalSibling");
        Assert.DoesNotContain(ops, o => o["type"]?.ToString() == "IOutputParameter");
        Assert.DoesNotContain(ops, o => o["prop"]?.ToString() == "Value" && o["value"]?.ToString() == "Run.Result");
    }

    [Fact]
    public void QualifiedRecursiveScreenCallsRetainTheirOwnerAndExecutionKind()
    {
        var first = CallAction("First", "screen", "IMobileScreen:Coverage", "IMobileScreen:Coverage/Second");
        var second = CallAction("Second", "screen", "IMobileScreen:Coverage", "First");
        var ops = LogicExpander.Expand(Logic(first, second), _ => null);
        Assert.Equal(new[] { "First", "Second" }, ops.Where(op => op["type"]?.ToString() == LogicOrder.MobileScreenAction).Select(op => op["name"]!.ToString()));
        Assert.Equal(new[] { "IMobileScreen:Coverage/Second", "IMobileScreen:Coverage/First" },
            ops.Where(op => op["prop"]?.ToString() == "Action").Select(op => op["value"]!.ToString()));
        Assert.Equal(2, ops.Count(op => op["type"]?.ToString() == "IExecuteClientActionNode"));
    }

    [Theory]
    [InlineData("server", null, "client", null)]
    [InlineData("service", null, "client", null)]
    [InlineData("data", "IMobileScreen:Coverage", "client", null)]
    [InlineData("DATA", "IMobileScreen:Coverage", "client", null)]
    [InlineData("screen", "IWebScreen:Coverage", "client", null)]
    [InlineData("client", null, "screen", "IMobileScreen:Coverage")]
    [InlineData("screen", "IMobileScreen:Other", "screen", "IMobileScreen:Coverage")]
    public void WrongExecutionOwnerOrKindIsRejectedDuringExpansion(string callerKind, string? callerOwner, string targetKind, string? targetOwner)
    {
        var caller = CallAction("Entry", callerKind, callerOwner, "Sibling");
        var target = ValueAction("Sibling", targetKind, targetOwner);
        var error = Assert.Throws<InvalidOperationException>(() => LogicExpander.Expand(Logic(caller, target), _ => null));
        Assert.True(error.Message.Contains("owner", StringComparison.Ordinal) || error.Message.Contains("cannot be called", StringComparison.Ordinal), error.Message);
    }

    [Theory]
    [InlineData("data", "IMobileScreen:Coverage", "DataSibling")]
    [InlineData("preparation", "IWebScreen:Coverage", "Preparation")]
    public void PreparationsAndDataActionsAreNotCallableSignatures(string kind, string owner, string name)
    {
        var caller = CallAction("Entry", "screen", owner, name);
        var target = new JsonObject { ["name"] = name, ["kind"] = kind, ["owner"] = owner, ["steps"] = new JsonArray() };
        Assert.Contains("cannot invoke", Assert.Throws<InvalidOperationException>(() => LogicExpander.Expand(Logic(caller, target), _ => null)).Message);
    }

    [Theory]
    [InlineData("server", "IServerAction")]
    [InlineData("service", "IServiceAction")]
    public void GenericActionSignaturesRetainDeclaredServerAndServiceExecution(string kind, string nativeType)
    {
        var caller = CallAction("Entry", "screen", "IMobileScreen:Coverage", "IActionSignature:Sibling");
        var ops = LogicExpander.Expand(Logic(caller, ValueAction("Sibling", kind, null)), _ => null);
        Assert.Contains(ops, o => o["type"]?.ToString() == "IExecuteServerActionNode");
        Assert.Contains(ops, o => o["prop"]?.ToString() == "Action" && o["value"]?.ToString() == nativeType + ":Sibling");
    }

    [Fact]
    public void TraditionalScreenCallsRejectNonCallableEventDestinationsBeforeReturningOps()
    {
        var caller = CallAction("Entry", "screen", "IWebScreen:Coverage", "Sibling");
        var error = Assert.Throws<InvalidOperationException>(() =>
            LogicExpander.Expand(Logic(caller, ValueAction("Sibling", "screen", "IWebScreen:Coverage")), _ => null));
        Assert.Contains("not callable IActionSignature", error.Message);
    }

    [Fact]
    public void TraditionalHandlersKeepCallingServerActions()
    {
        var caller = CallAction("Entry", "screen", "IWebScreen:Coverage", "Sibling");
        var ops = LogicExpander.Expand(Logic(caller, ValueAction("Sibling", "server", null)), _ => null);
        Assert.Contains(ops, o => o["type"]?.ToString() == "IExecuteServerActionNode");
        Assert.DoesNotContain(ops, o => o["type"]?.ToString() == "IExecuteClientActionNode");
    }

    [Theory]
    [InlineData("IMobileScreen:Coverage")]
    [InlineData("IMobileBlock:Coverage")]
    public void MobileScreenOutputParametersAreRejectedBeforeNativeMutation(string owner)
    {
        var source = ValueAction("Returning", "client", null);
        source["kind"] = "screen"; source["owner"] = owner;
        var error = Assert.Throws<InvalidOperationException>(() => LogicExpander.Expand(Logic(source), _ => null));
        Assert.Contains("do not support output parameters", error.Message);
    }

    [Theory]
    [InlineData("IMobileScreen:Coverage/Value")]
    [InlineData("IActionSignature:Existing")]
    [InlineData("ILocalVariable:Value")]
    public void StringOnlyResolverCannotPretendToProveNativeActionMetadata(string target)
    {
        var source = Logic(CallAction("Entry", "screen", "IMobileScreen:Coverage", target));
        Assert.Contains("native action metadata", Assert.Throws<InvalidOperationException>(() => LogicExpander.Expand(source, _ => target)).Message);
    }

    [Theory]
    [InlineData("IClientAction", "IExecuteClientActionNode")]
    [InlineData("IServerAction", "IExecuteServerActionNode")]
    [InlineData("IServiceAction", "IExecuteServerActionNode")]
    public void MetadataControlsExecutionAndPreservesTheResolvedIdentity(string kind, string nodeKind)
    {
        var source = Logic(CallAction("Entry", "screen", "IMobileScreen:Coverage", "IActionSignature:Alias"));
        var ops = LogicExpander.Expand(source, _ => null, (_, _) => new LogicCallTarget("@resolved-test-key", kind));
        Assert.Contains(ops, o => o["type"]?.ToString() == nodeKind);
        Assert.Contains(ops, o => o["prop"]?.ToString() == "Action" && o["value"]?.ToString() == "@resolved-test-key");
    }

    [Fact]
    public void ExistingLocalActionPrecedesAnUnrelatedModuleDeclarationWithTheSameName()
    {
        var caller = CallAction("Entry", "screen", "IMobileScreen:Coverage", "Sibling");
        var sibling = ValueAction("Sibling", "server", null);
        var visited = new List<LogicCallCandidate>();
        var ops = LogicExpander.Expand(Logic(caller, sibling), _ => null, (candidate, _) =>
        {
            visited.Add(candidate);
            return candidate.Reference == "IMobileScreen:Coverage/Sibling"
                ? new LogicCallTarget("@existing-local", LogicOrder.MobileScreenAction, "IMobileScreen:Coverage") : null;
        });
        Assert.Contains(visited, c => c.Reference == "IMobileScreen:Coverage/Sibling" && c.IsImplicitLocal);
        Assert.Contains(ops, o => o["prop"]?.ToString() == "Action" && o["value"]?.ToString() == "@existing-local");
        Assert.DoesNotContain(ops, o => o["prop"]?.ToString() == "Action" && o["value"]?.ToString() == "IServerAction:Sibling");
        Assert.Equal(new[] { "Entry", "Sibling" }, ops.Where(o => o["op"]?.ToString() == "create"
            && o["type"]?.ToString() is "IServerAction" or "OutSystems.Model.UI.Mobile.IScreenAction").Select(o => o["name"]!.ToString()));
    }

    [Fact]
    public void AnExplicitOwnerPathNeverBecomesAnImplicitLocalFallback()
    {
        var caller = CallAction("Entry", "screen", "IMobileScreen:Coverage", "IMobileScreen:Coverage/Value");
        var error = Assert.Throws<InvalidOperationException>(() => LogicExpander.Expand(Logic(caller), _ => null, (candidate, _) =>
        {
            Assert.Equal("IMobileScreen:Coverage/Value", candidate.Reference);
            Assert.False(candidate.IsImplicitLocal);
            throw new InvalidOperationException("explicit non-action target rejected");
        }));
        Assert.Contains("explicit non-action", error.Message);
    }

    [Theory]
    [InlineData("reactive-ui")]
    [InlineData("mobile-ui")]
    public void NativeVoidScreenCallsVerifyReloadMergeAndPreserveScreenAndClientIdentities(string fixtureName)
    {
        StudioAssemblies.Bind(null);
        var work = Path.Combine(Root, ".local/lane-ss5/proofs/screen-calls", fixtureName);
        Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        var fixture = Path.Combine(Root, "tests/fixtures", fixtureName + ".oml");
        var contract = Contract(fixtureName);
        var first = Path.Combine(work, "first.oml");
        Run(fixture, host.PlanModuleSpecification(fixture, contract), first);
        var proof = host.CheckModuleSpecification(first, contract);
        Assert.True(proof["accepted"]!.GetValue<bool>(), proof.ToJsonString());
        var before = ReadNative(host, first, contract);
        var changed = contract.DeepClone().AsObject();
        var local = changed["logic"]!["actions"]!.AsArray().Single(a => a!["name"]!.ToString() == "LocalSibling")!;
        local["steps"]![0]!["assign"]!["LocalValue"] = "N + 7";
        var second = Path.Combine(work, "second.oml");
        Run(first, host.PlanModuleSpecification(first, changed), second);
        var merged = Path.Combine(work, "merged.oml");
        var merge = MergeProbe.ThreeWay(host, File.ReadAllBytes(first), File.ReadAllBytes(second), merged);
        Assert.True(merge.LocalIsValid, JsonSerializer.Serialize(merge));
        Assert.False(merge.HasConflicts, JsonSerializer.Serialize(merge));
        var after = host.CheckModuleSpecification(merged, changed, proof["expectedTypes"]!.AsObject());
        Assert.True(after["accepted"]!.GetValue<bool>(), after.ToJsonString());
        var actual = ReadNative(host, merged, changed);
        Assert.Equal(before["localKey"]!.ToString(), actual["localKey"]!.ToString());
        Assert.Equal(before["localInputKey"]!.ToString(), actual["localInputKey"]!.ToString());
        Assert.Equal(before["localStateKey"]!.ToString(), actual["localStateKey"]!.ToString());
        Assert.Equal(before["callKey"]!.ToString(), actual["callKey"]!.ToString());
        Assert.DoesNotContain(host.PlanModuleSpecification(merged, changed), o => o?["op"]?.ToString() is "logic" or "screen");
        WithSession(host, merged, session => ProbeExistingNativeBindings(session, fixtureName, changed));

        // Change only the caller: each existing target must now travel through the native resolver,
        // not the declaration fast path used while creating the whole contract.
        var reboundContract = changed.DeepClone().AsObject();
        reboundContract["logic"]!["actions"]![0]!["steps"]![0]!["args"]!["N"] = "4";
        var rebound = Path.Combine(work, "rebound.oml");
        var reboundPlan = host.PlanModuleSpecification(merged, reboundContract);
        var reboundActions = reboundPlan.OfType<JsonObject>().Single(o => o["op"]?.ToString() == "logic")["data"]!["actions"]!.AsArray();
        Assert.Single(reboundActions);
        Assert.Equal("Entry", reboundActions[0]!["name"]!.ToString());
        Run(merged, reboundPlan, rebound);
        Assert.True(host.CheckModuleSpecification(rebound, reboundContract)["accepted"]!.GetValue<bool>());
        var reboundNative = ReadNative(host, rebound, reboundContract, expectedInput: "4");
        Assert.Equal(actual["localKey"]!.ToString(), reboundNative["targetKey"]!.ToString());
        Assert.Equal(actual["localInputKey"]!.ToString(), reboundNative["localInputKey"]!.ToString());

        // A retained local action and a newly declared module action can share a name.
        // Both calls are consumed; the bare call must still bind locally, and the explicit
        // server call must bind to the module declaration. The proof resolves this independently.
        var shadowContract = changed.DeepClone().AsObject();
        var shadowActions = shadowContract["logic"]!["actions"]!.AsArray();
        shadowActions.Remove(shadowActions.Single(a => a!["name"]!.ToString() == "LocalSibling"));
        shadowActions.Add(ValueAction("LocalSibling", "server", null));
        var shadowSteps = shadowActions[0]!["steps"]!.AsArray();
        shadowSteps[0]!["call"] = "LocalSibling";
        shadowSteps.Insert(1, new JsonObject { ["call"] = "IServerAction:LocalSibling", ["as"] = "RunGlobal",
            ["args"] = new JsonObject { ["N"] = "LocalValue" } });
        shadowSteps[2]!["args"]!["N"] = "RunGlobal.Result";
        var shadow = Path.Combine(work, "shadowed.oml");
        Run(merged, host.PlanModuleSpecification(merged, shadowContract), shadow, expectedMessages: new JsonArray(new JsonObject {
            ["id"] = "ConsecutiveServerInteractions",
            ["element"] = "Entry (ScreenAction) / RunServer (ExecuteServerActionNode)",
            ["why"] = "This binding fixture deliberately consumes two different server targets to prove local/module name resolution; it is not an application performance pattern." }));
        var shadowProof = host.CheckModuleSpecification(shadow, shadowContract);
        Assert.True(shadowProof["accepted"]!.GetValue<bool>(), shadowProof.ToJsonString());
        Assert.Equal(actual["localKey"]!.ToString(), ReadNative(host, shadow, shadowContract)["targetKey"]!.ToString());
        Assert.DoesNotContain(host.PlanModuleSpecification(shadow, shadowContract), o => o?["op"]?.ToString() is "logic" or "screen");

        // The same signature but a different target must fail the independent proof.
        var owner = changed["logic"]!["actions"]![0]!["owner"]!.ToString();
        var mutated = Path.Combine(work, "wrong-target.oml");
        Run(merged, new JsonArray(new JsonObject { ["op"] = "set", ["target"] = owner + "/Entry/RunLocal", ["prop"] = "Action", ["value"] = "IServerAction:ServerSibling" }), mutated, requireAccepted: false);
        var rejected = host.CheckModuleSpecification(mutated, changed, proof["expectedTypes"]!.AsObject());
        Assert.False(rejected["accepted"]!.GetValue<bool>());
        Assert.Contains(rejected["differences"]!.AsArray(), d => d?["property"]?.ToString() == "Action");
        // Make the declared and actual target agree on a foreign screen action. Only the
        // independent ownership check can reject that otherwise matching call target.
        var foreignOwner = owner.Replace(":Coverage", ":Other", StringComparison.Ordinal);
        var foreignAction = ValueAction("ForeignSibling", "screen", foreignOwner);
        var wrongOwnerPath = Path.Combine(work, "wrong-owner.oml");
        Run(merged, new JsonArray(
            new JsonObject { ["op"] = "create", ["parent"] = foreignOwner, ["type"] = "ILocalVariable", ["name"] = "LocalValue", ["as"] = "$foreignValue" },
            new JsonObject { ["op"] = "set", ["target"] = "$foreignValue", ["prop"] = "DataType", ["value"] = "Integer" },
            new JsonObject { ["op"] = "logic", ["data"] = Logic(foreignAction.DeepClone().AsObject()) },
            new JsonObject { ["op"] = "set", ["target"] = owner + "/Entry/RunLocal", ["prop"] = "Action",
                ["value"] = foreignOwner + "/ForeignSibling" }), wrongOwnerPath, requireAccepted: false);
        var wrongOwnerLogic = changed["logic"]!.DeepClone().AsObject();
        wrongOwnerLogic["actions"]!.AsArray().Add(foreignAction.DeepClone());
        wrongOwnerLogic["actions"]![0]!["steps"]![0]!["call"] = foreignOwner + "/ForeignSibling";
        WithSession(host, wrongOwnerPath, session =>
        {
            var negative = (JsonObject)typeof(ModelSession).GetMethod("CheckLogicSpecification")!.Invoke(session, [wrongOwnerLogic, null, null])!;
            Assert.False(negative["accepted"]!.GetValue<bool>());
            Assert.Contains(negative["differences"]!.AsArray(), d => d?["property"]?.ToString() == "callOwner");
            Assert.DoesNotContain(negative["differences"]!.AsArray(), d => d?["property"]?.ToString() == "Action");
            File.WriteAllText(Path.Combine(work, "wrong-owner-proof.json"), negative.ToJsonString());
        });
        if (fixtureName != "traditional-ui")
        {
            // Retain the same target, argument and graph position while changing only the
            // native execute-node kind. The proof must reject executionKind, not Action.
            var wrongKindPath = Path.Combine(work, "wrong-kind.oml");
            Run(merged, new JsonArray(
                new JsonObject { ["op"] = "delete", ["target"] = owner + "/Entry/RunLocal", ["force"] = true },
                new JsonObject { ["op"] = "create", ["parent"] = owner + "/Entry", ["type"] = "IExecuteServerActionNode", ["name"] = "RunLocal", ["as"] = "$wrongCall" },
                new JsonObject { ["op"] = "set", ["target"] = "$wrongCall", ["prop"] = "Action", ["value"] = owner + "/LocalSibling" },
                new JsonObject { ["op"] = "set", ["target"] = "$wrongCall/N", ["prop"] = "Value", ["value"] = "3" },
                new JsonObject { ["op"] = "link", ["from"] = owner + "/Entry/#IStartNode", ["to"] = "$wrongCall" },
                new JsonObject { ["op"] = "link", ["from"] = "$wrongCall", ["to"] = owner + "/Entry/RunClient" }), wrongKindPath, requireAccepted: false);
            WithSession(host, wrongKindPath, session =>
            {
                var negative = (JsonObject)typeof(ModelSession).GetMethod("CheckLogicSpecification")!.Invoke(session, [changed["logic"]!.AsObject(), null, null])!;
                Assert.False(negative["accepted"]!.GetValue<bool>());
                Assert.Contains(negative["differences"]!.AsArray(), d => d?["property"]?.ToString() == "executionKind");
                Assert.DoesNotContain(negative["differences"]!.AsArray(), d => d?["property"]?.ToString() == "Action");
                File.WriteAllText(Path.Combine(work, "wrong-kind-proof.json"), negative.ToJsonString());
            });
        }
        File.WriteAllText(Path.Combine(work, "evidence.json"), new JsonObject
        {
            ["fixture"] = fixtureName, ["verify"] = true, ["reload"] = true, ["merge"] = true,
            ["identityPreserved"] = true, ["idempotent"] = true, ["wrongTargetRejected"] = true,
            ["existingNativeTargetsApplied"] = true, ["implicitNonActionFallback"] = true, ["localPrecedenceVerified"] = true,
            ["wrongOwnerProofRejected"] = true, ["wrongExecutionKindProofRejected"] = fixtureName != "traditional-ui",
            ["actual"] = actual, ["nativeRuntimeExecuted"] = false, ["browserExecuted"] = false
        }.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));

        void Run(string basis, JsonArray ops, string output, bool requireAccepted = true, JsonArray? expectedMessages = null)
        {
            var job = output + ".job.json";
            var declaration = new JsonObject { ["ops"] = ops };
            if (expectedMessages != null) declaration["expectedMessages"] = expectedMessages;
            File.WriteAllText(job, declaration.ToJsonString());
            var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, basis, job, output))!;
            File.WriteAllText(output + ".result.json", result.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
            if (requireAccepted) Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        }
    }

    [Fact]
    public void TraditionalHandlersVerifyServerCallsAndRejectLocalScreenCallsBeforeMutation()
    {
        StudioAssemblies.Bind(null);
        var work = Path.Combine(Root, ".local/lane-ss5/proofs/screen-calls", "traditional-server-calls");
        Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        var fixture = Path.Combine(Root, "tests/fixtures/traditional-ui.oml");
        var contract = Contract("traditional-ui");
        var created = Path.Combine(work, "created.oml");
        Run(fixture, contract, created);
        var first = host.CheckModuleSpecification(created, contract);
        Assert.True(first["accepted"]!.GetValue<bool>(), first.ToJsonString());
        var before = Inspect(created, "3");
        var changed = contract.DeepClone().AsObject();
        changed["logic"]!["actions"]![0]!["steps"]![0]!["args"]!["N"] = "4";
        var updated = Path.Combine(work, "updated.oml"); Run(created, changed, updated);
        var merged = Path.Combine(work, "merged.oml");
        var merge = MergeProbe.ThreeWay(host, File.ReadAllBytes(created), File.ReadAllBytes(updated), merged);
        Assert.True(merge.LocalIsValid, JsonSerializer.Serialize(merge));
        Assert.False(merge.HasConflicts, JsonSerializer.Serialize(merge));
        var proof = host.CheckModuleSpecification(merged, changed, first["expectedTypes"]!.AsObject());
        Assert.True(proof["accepted"]!.GetValue<bool>(), proof.ToJsonString());
        var actual = Inspect(merged, "4");
        Assert.Equal(before["calleeKey"]!.ToString(), actual["calleeKey"]!.ToString());
        Assert.Equal(before["parameterKey"]!.ToString(), actual["parameterKey"]!.ToString());
        Assert.Equal(before["localHandlerKey"]!.ToString(), actual["localHandlerKey"]!.ToString());
        Assert.Empty(host.PlanModuleSpecification(merged, changed));
        File.WriteAllText(Path.Combine(work, "evidence.json"), new JsonObject
        {
            ["nativeServerCallVerified"] = true, ["reload"] = true, ["update"] = true, ["merge"] = true,
            ["idempotent"] = true, ["localScreenCallRejectedBeforeMutation"] = true,
            ["traditionalScreenActionIsCallable"] = false, ["actual"] = actual,
            ["nativeRuntimeExecuted"] = false, ["browserExecuted"] = false
        }.ToJsonString());

        void Run(string basis, JsonObject specification, string output)
        {
            var job = output + ".job.json";
            File.WriteAllText(job, new JsonObject { ["ops"] = host.PlanModuleSpecification(basis, specification) }.ToJsonString());
            var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, basis, job, output))!;
            File.WriteAllText(output + ".result.json", result.ToJsonString());
            Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        }
        JsonObject Inspect(string path, string expectedInput)
        {
            JsonObject? evidence = null;
            WithSession(host, path, session =>
            {
                const string owner = "IWebScreen:Coverage";
                var callee = session.Get(session.Resolve("IServerAction:ServerSibling"));
                var call = session.Get(session.Resolve(owner + "/Entry/RunServer"));
                var target = session.Get(session.Resolve(call["properties"]!["Action"]!.ToString()));
                Assert.Equal(callee["key"]!.ToString(), target["key"]!.ToString());
                Assert.Equal("IExecuteServerActionNode", call["type"]!.ToString());
                var argument = session.Get(session.Resolve(owner + "/Entry/RunServer/N"));
                Assert.Equal(expectedInput, argument["properties"]!["Value"]!.ToString());
                var parameter = session.Get(session.Resolve(argument["properties"]!["Parameter"]!.ToString()));
                Assert.Equal(session.Get(session.Resolve("IServerAction:ServerSibling/N"))["key"]!.ToString(), parameter["key"]!.ToString());
                var localKey = session.Get(session.Resolve(owner + "/LocalSibling"))["key"]!.ToString();
                var invalid = Logic(CallAction("Probe", "screen", owner, owner + "/LocalSibling"));
                var error = Assert.ThrowsAny<Exception>(() => session.Apply(new JsonArray(new JsonObject { ["op"] = "logic", ["data"] = invalid })));
                Assert.Contains("not callable IActionSignature", Errors.Text(error));
                Assert.ThrowsAny<KeyNotFoundException>(() => session.Resolve(owner + "/Probe"));
                Assert.Equal(localKey, session.Get(session.Resolve(owner + "/LocalSibling"))["key"]!.ToString());
                evidence = new JsonObject { ["calleeKey"] = callee["key"]!.DeepClone(), ["parameterKey"] = parameter["key"]!.DeepClone(),
                    ["localHandlerKey"] = localKey, ["inputValue"] = expectedInput };
            });
            return evidence!;
        }
    }

    private static void ProbeExistingNativeBindings(ModelSession session, string fixtureName, JsonObject contract)
    {
        var owner = contract["logic"]!["actions"]![0]!["owner"]!.ToString();
        var localKey = session.Get(session.Resolve(owner + "/LocalSibling"))["key"]!.ToString();
        foreach (var target in new[] { owner + "/LocalSibling", "IActionSignature:LocalSibling" })
        {
            var source = Logic(CallAction("Probe", "screen", owner, target));
            var ops = LogicExpander.Expand(source, _ => null, session.ResolveLogicCall);
            Assert.Contains(ops, o => o["type"]?.ToString() == (fixtureName == "traditional-ui" ? "IExecuteServerActionNode" : "IExecuteClientActionNode"));
            Assert.Contains(ops, o => o["prop"]?.ToString() == "Action" && o["value"]?.ToString() == "@" + localKey);
        }
        foreach (var target in new[] { owner + "/Value", owner + "/Subject" })
        {
            var source = Logic(CallAction("Probe", "screen", owner, target));
            Assert.Contains("not a native action", Assert.Throws<InvalidOperationException>(() => LogicExpander.Expand(source, _ => null, session.ResolveLogicCall)).Message);
        }
        var otherOwner = owner.Replace(":Coverage", ":Other", StringComparison.Ordinal);
        Assert.Contains("own screen/block owner", Assert.Throws<InvalidOperationException>(() => LogicExpander.Expand(
            Logic(CallAction("Probe", "screen", otherOwner, owner + "/LocalSibling")), _ => null, session.ResolveLogicCall)).Message);
        if (fixtureName != "traditional-ui")
        {
            var source = Logic(CallAction("Probe", "screen", owner, "IActionSignature:ClientSibling"));
            var ops = LogicExpander.Expand(source, _ => null, session.ResolveLogicCall);
            Assert.Contains(ops, o => o["type"]?.ToString() == "IExecuteClientActionNode");
            Assert.Contains("cannot be called", Assert.Throws<InvalidOperationException>(() => LogicExpander.Expand(
                Logic(CallAction("Probe", "server", null, "IActionSignature:ClientSibling")), _ => null, session.ResolveLogicCall)).Message);
        }
        var serverKey = session.Get(session.Resolve("IServerAction:ServerSibling"))["key"]!.ToString();
        Assert.Contains("not a native action", Assert.Throws<InvalidOperationException>(() => LogicExpander.Expand(
            Logic(CallAction("Probe", "screen", owner, owner + "/ServerSibling")), _ => null, session.ResolveLogicCall)).Message);
        var implicitServer = LogicExpander.Expand(Logic(CallAction("Probe", "screen", owner, "ServerSibling")), _ => null, session.ResolveLogicCall);
        Assert.Contains(implicitServer, o => o["prop"]?.ToString() == "Action" && o["value"]?.ToString() == "@" + serverKey);
        var serverOps = LogicExpander.Expand(Logic(CallAction("Probe", "screen", owner, "IActionSignature:ServerSibling")), _ => null, session.ResolveLogicCall);
        Assert.Contains(serverOps, o => o["type"]?.ToString() == "IExecuteServerActionNode");
        var returning = ValueAction("ReturningProbe", "client", null);
        returning["kind"] = "screen"; returning["owner"] = owner;
        var returningError = Assert.ThrowsAny<Exception>(() => session.Apply(new JsonArray(new JsonObject { ["op"] = "logic", ["data"] = Logic(returning) })));
        Assert.Contains("do not support output parameters", Errors.Text(returningError));
        Assert.ThrowsAny<KeyNotFoundException>(() => session.Resolve(owner + "/ReturningProbe"));

        // Exercise LogicCore too, not only the pure expansion entry point. Failed calls must
        // leave the existing target identity and caller set unchanged in the loaded native model.
        foreach (var bad in new[] { CallAction("Probe", "screen", owner, owner + "/Value"),
            CallAction("Probe", "screen", otherOwner, owner + "/LocalSibling") })
        {
            Assert.ThrowsAny<Exception>(() => session.Apply(new JsonArray(new JsonObject { ["op"] = "logic", ["data"] = Logic(bad) })));
            Assert.Equal(localKey, session.Get(session.Resolve(owner + "/LocalSibling"))["key"]!.ToString());
            Assert.ThrowsAny<KeyNotFoundException>(() => session.Resolve(owner + "/Probe"));
            Assert.ThrowsAny<KeyNotFoundException>(() => session.Resolve(otherOwner + "/Probe"));
        }
        Assert.ThrowsAny<KeyNotFoundException>(() => session.Resolve(owner + "/Probe"));
        Assert.ThrowsAny<KeyNotFoundException>(() => session.Resolve("IServerAction:Probe"));
    }

    private static JsonObject ReadNative(ModelHost host, string path, JsonObject contract, string expectedInput = "3")
    {
        JsonObject? evidence = null;
        WithSession(host, path, session =>
        {
            var owner = contract["logic"]!["actions"]![0]!["owner"]!.ToString();
            var local = session.Get(session.Resolve(owner + "/LocalSibling"));
            Assert.ThrowsAny<KeyNotFoundException>(() => session.Resolve(owner + "/LocalSibling/#IOutputParameter"));
            var call = session.Get(session.Resolve(owner + "/Entry/RunLocal"));
            var destination = session.Get(session.Resolve(call["properties"]!["Action"]!.ToString()));
            Assert.Equal(local["key"]!.ToString(), destination["key"]!.ToString());
            Assert.Equal(owner.StartsWith("IMobile", StringComparison.Ordinal) ? "IExecuteClientActionNode" : "IExecuteServerActionNode", call["type"]!.ToString());
            var argument = session.Get(session.Resolve(owner + "/Entry/RunLocal/N"));
            Assert.Equal(expectedInput, argument["properties"]!["Value"]!.ToString());
            var parameter = session.Get(session.Resolve(argument["properties"]!["Parameter"]!.ToString()));
            var input = session.Get(session.Resolve(owner + "/LocalSibling/N"));
            Assert.Equal(input["key"]!.ToString(), parameter["key"]!.ToString());
            evidence = new JsonObject
            {
                ["localKey"] = local["key"]!.DeepClone(), ["localInputKey"] = input["key"]!.DeepClone(),
                ["localStateKey"] = session.Get(session.Resolve(owner + "/LocalValue"))["key"]!.DeepClone(),
                ["screenOutputCount"] = 0,
                ["callKey"] = call["key"]!.DeepClone(), ["targetKey"] = destination["key"]!.DeepClone(),
                ["nodeKind"] = call["type"]!.DeepClone(), ["inputValue"] = expectedInput
            };
        });
        return evidence!;
    }

    private static void WithSession(ModelHost host, string path, Action<ModelSession> inspect)
    {
        var module = typeof(ModelHost).GetMethod("Load", [typeof(string)])!.Invoke(host, [path])!;
        try { inspect((ModelSession)Activator.CreateInstance(typeof(ModelSession), module)!); }
        finally { typeof(ModelHost).GetMethod("Release")!.Invoke(null, [module]); }
    }

    private static JsonObject Contract(string fixtureName)
    {
        var traditional = fixtureName == "traditional-ui";
        var sample = traditional ? "traditional-ui-ibuttonwidget.json" : "reactive-ui-ibutton.json";
        var contract = JsonNode.Parse(File.ReadAllText(Path.Combine(Root, "tests/contracts/screen-coverage", sample)))!["contract"]!.DeepClone().AsObject();
        var screen = contract["screens"]![0]!.AsObject();
        var owner = (traditional ? "IWebScreen" : "IMobileScreen") + ":Coverage";
        screen["vars"] = new JsonArray(new JsonObject { ["name"] = "Value", ["type"] = "Integer" },
            new JsonObject { ["name"] = "LocalValue", ["type"] = "Integer" },
            new JsonObject { ["name"] = "ServerSibling", ["type"] = "Integer" });
        screen["widgets"]![0]!["events"]!["OnClick"]!["destination"] = owner + "/Entry";
        // Consume Value in a native expression so the native warning contract remains meaningful.
        screen["widgets"]!.AsArray().Add(new JsonObject { ["name"] = "Output", ["type"] = traditional ? "IExpressionWidget" : "IExpression", ["properties"] = new JsonObject { ["Value"] = "Value + LocalValue + ServerSibling" } });
        if (traditional)
        {
            var localButton = screen["widgets"]![0]!.DeepClone().AsObject();
            localButton["name"] = "LocalTrigger";
            localButton["events"]!["OnClick"] = new JsonObject { ["destination"] = owner + "/LocalSibling", ["args"] = new JsonObject { ["N"] = "3" } };
            screen["widgets"]!.AsArray().Add(localButton);
        }
        var other = screen.DeepClone().AsObject(); other["name"] = "Other"; other["widgets"] = new JsonArray(); other.Remove("vars");
        contract["screens"]!.AsArray().Add(other);
        var steps = new JsonArray();
        if (!traditional)
        {
            steps.Add(new JsonObject { ["call"] = owner + "/LocalSibling", ["as"] = "RunLocal", ["args"] = new JsonObject { ["N"] = "3" } });
            steps.Add(new JsonObject { ["call"] = "IActionSignature:ClientSibling", ["as"] = "RunClient", ["args"] = new JsonObject { ["N"] = "LocalValue" } });
        }
        steps.Add(new JsonObject { ["call"] = "ServerSibling", ["as"] = "RunServer", ["args"] = new JsonObject { ["N"] = traditional ? "3" : "RunClient.Result" } });
        steps.Add(new JsonObject { ["assign"] = new JsonObject { ["Value"] = "RunServer.Result" } });
        var actions = new JsonArray(new JsonObject { ["name"] = "Entry", ["kind"] = "screen", ["owner"] = owner, ["steps"] = steps }, ValueAction("LocalSibling", "screen", owner));
        if (!traditional) actions.Add(ValueAction("ClientSibling", "client", null));
        actions.Add(ValueAction("ServerSibling", "server", null));
        contract["logic"] = new JsonObject { ["actions"] = actions };
        return contract;
    }

    private static JsonObject ValueAction(string name, string kind, string? owner)
    {
        if (kind == "screen") return new JsonObject
        {
            ["name"] = name, ["kind"] = kind, ["owner"] = owner,
            ["inputs"] = new JsonArray(new JsonObject { ["name"] = "N", ["type"] = "Integer" }),
            ["steps"] = new JsonArray(new JsonObject { ["assign"] = new JsonObject { ["LocalValue"] = "N + 1" } })
        };
        var action = new JsonObject
        {
            ["name"] = name, ["kind"] = kind,
            ["inputs"] = new JsonArray(new JsonObject { ["name"] = "N", ["type"] = "Integer" }),
            ["outputs"] = new JsonArray(new JsonObject { ["name"] = "Result", ["type"] = "Integer" }),
            ["steps"] = new JsonArray(new JsonObject { ["assign"] = new JsonObject { ["Result"] = "N + 1" } })
        };
        if (owner != null) action["owner"] = owner;
        return action;
    }
    private static JsonObject CallAction(string name, string kind, string? owner, string target)
    {
        var action = ValueAction(name, kind, owner);
        action["steps"] = new JsonArray(new JsonObject { ["call"] = target, ["as"] = "Run", ["args"] = new JsonObject { ["N"] = "N" } });
        if (kind != "screen") action["steps"]!.AsArray().Add(new JsonObject { ["assign"] = new JsonObject { ["Result"] = "Run.Result" } });
        return action;
    }
    private static JsonObject Logic(params JsonObject[] actions) => new() { ["actions"] = new JsonArray(actions.Select(a => (JsonNode)a).ToArray()) };
}
