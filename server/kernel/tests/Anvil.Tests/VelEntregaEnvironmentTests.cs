using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>Speed lane vel-entrega (lentidão 2026-10-12): a read of the environment that failed on the network between the
/// Studio and the OutSystems environment is asked once more on a fresh request; a write never; publish-check only when the
/// request provably never left; what still fails is ENVIRONMENT_UNREACHABLE (EnvironmentNetwork, ConnectedEnvironment).</summary>
public sealed class VelEntregaEnvironmentNetworkTests
{
    public VelEntregaEnvironmentNetworkTests() => StudioAssemblies.Bind();

    // What the Studio's HTTP client answered in the production test (one outer exception, as the thin bridge reports it).
    private const string Plain = "environment_session: CommunicationException: An error occurred while sending the request.";
    // The same failure as the full bridge describes it (EnvironmentSessionHandler.Describe): the connection never opened.
    private const string NeverOpened = "environment_session: CommunicationException: An error occurred while sending the request. <- "
        + "HttpRequestException: A connection attempt failed (personal.example:443) (http ConnectionError) <- SocketException: A connection attempt failed (socket TimedOut)";
    // A reply lost after the request was sent: never proof that nothing reached the server.
    private const string AfterSend = "environment_session: CommunicationException: An error occurred while sending the request. <- "
        + "HttpRequestException: The response ended prematurely. (http ResponseEnded) <- IOException: Unable to read data <- SocketException: timed out (socket TimedOut)";

    [Fact]
    public void ClassifiesTheNetworkFailureAndOnlyAConnectionThatNeverOpenedAsNotSent()
    {
        Assert.True(EnvironmentNetwork.IsUnreachable(Plain));
        Assert.True(EnvironmentNetwork.IsUnreachable(NeverOpened));
        Assert.False(EnvironmentNetwork.IsUnreachable("environment_session: InvalidOperationException: Studio login or environment changed; operation was not submitted"));
        Assert.False(EnvironmentNetwork.IsUnreachable(null));
        Assert.True(EnvironmentNetwork.NeverSent(NeverOpened));
        Assert.False(EnvironmentNetwork.NeverSent(Plain));
        Assert.False(EnvironmentNetwork.NeverSent(AfterSend));
        Assert.True(EnvironmentNetwork.MayRepeat("modules", Plain));
        Assert.True(EnvironmentNetwork.MayRepeat("templates", Plain));
        Assert.False(EnvironmentNetwork.MayRepeat("publish-check", Plain));
        Assert.False(EnvironmentNetwork.MayRepeat("publish-check", AfterSend));
        Assert.True(EnvironmentNetwork.MayRepeat("publish-check", NeverOpened));
        foreach (var write in ConnectedEnvironment.WriteOperations) Assert.False(EnvironmentNetwork.MayRepeat(write, NeverOpened));
        // Every repeatable read is an operation of the bridge and none is a write.
        Assert.All(EnvironmentNetwork.RepeatableReads, read => Assert.Contains(read, EnvironmentOperations.Names));
        Assert.Empty(EnvironmentNetwork.RepeatableReads.Intersect(ConnectedEnvironment.WriteOperations));
    }

    [Fact]
    public void AReadThatFailedOnTheNetworkIsAskedOnceMoreOnAFreshRequest()
    {
        var bridge = new Flaky { Failures = { ["modules"] = new Queue<string>([Plain]) }, Value = new JsonArray() };
        using var session = HeadlessSession.ConnectStudio(bridge, "lab.example", null, true);
        Assert.Empty(session.ListModules());
        Assert.Equal(new[] { "connect", "modules", "modules" }, bridge.Operations);
        Assert.Equal(new[] { "modules" }, session.Connected!.RepeatedReads);
    }

    [Fact]
    public void AReadThatFailsTwiceIsEnvironmentUnreachableNotAGenericRefusal()
    {
        var bridge = new Flaky { Failures = { ["templates"] = new Queue<string>([Plain, Plain]) } };
        using var session = new ConnectedEnvironment(bridge, "lab.example", null, true);
        var error = Assert.Throws<EnvironmentUnreachableException>(() => session.Call<TemplateSummary[]>("templates"));
        Assert.Equal("ENVIRONMENT_UNREACHABLE", error.Code);
        Assert.True(error.Repeated);
        Assert.Equal("templates", error.Operation);
        Assert.Contains("lab.example", error.Message);
        Assert.Equal(2, bridge.Operations.Count(o => o == "templates"));
        var envelope = Errors.Envelope("templates", error, 1);
        Assert.Equal("ENVIRONMENT_UNREACHABLE", envelope["code"]!.ToString());
        Assert.Contains("could not reach the OutSystems environment", envelope["error"]!.ToString());
    }

    [Fact]
    public void AWriteIsNeverRepeatedAfterANetworkFailure()
    {
        var bridge = new Flaky { Failures = { ["publish-start"] = new Queue<string>([NeverOpened]) } };
        using var session = new ConnectedEnvironment(bridge, "lab.example", null, false);
        var error = Assert.Throws<BridgeCallException>(() => session.Call<PublishOutcome>("publish-start", new { oml = new byte[] { 1 } }));
        Assert.Contains("CommunicationException", error.Message);
        Assert.Single(bridge.Operations, o => o == "publish-start");
        Assert.Empty(session.RepeatedReads);
    }

    [Fact]
    public void PublishCheckIsAskedAgainOnlyWhenTheRequestNeverLeft()
    {
        var previous = new PublishOutcome(true, false, false, 7, 6738, "key", Array.Empty<PublishMessage>(), 10, 10);
        var lost = new Flaky { Failures = { ["publish-check"] = new Queue<string>([Plain]) }, Value = JsonSerializer.SerializeToNode(previous with { Completed = true }, ConnectedEnvironment.Wire) };
        using (var session = new ConnectedEnvironment(lost, "lab.example", null, false))
        {
            var error = Assert.Throws<EnvironmentUnreachableException>(() => session.Call<PublishOutcome>("publish-check", new { previous }));
            Assert.False(error.Repeated);
            Assert.Single(lost.Operations, o => o == "publish-check");
        }
        var neverSent = new Flaky { Failures = { ["publish-check"] = new Queue<string>([NeverOpened]) }, Value = JsonSerializer.SerializeToNode(previous with { Completed = true }, ConnectedEnvironment.Wire) };
        using (var session = new ConnectedEnvironment(neverSent, "lab.example", null, false))
        {
            Assert.True(session.Call<PublishOutcome>("publish-check", new { previous }).Completed);
            Assert.Equal(2, neverSent.Operations.Count(o => o == "publish-check"));
            Assert.Equal(new[] { "publish-check" }, session.RepeatedReads);
        }
    }

    [Fact]
    public void ARefusalOfTheServerIsNotRepeated()
    {
        var bridge = new Flaky { Failures = { ["modules"] = new Queue<string>(["environment_session: InvalidOperationException: The connected environment lease expired"]) } };
        using var session = new ConnectedEnvironment(bridge, "lab.example", null, true);
        Assert.Throws<BridgeCallException>(() => session.Call<ModuleSummary[]>("modules"));
        Assert.Single(bridge.Operations, o => o == "modules");
    }

    internal sealed class Flaky : IBridgeClient
    {
        public readonly List<string> Operations = [];
        public readonly Dictionary<string, Queue<string>> Failures = new();
        public JsonNode? Value;
        public JsonObject Call(string method, JsonObject? parameters = null)
        {
            Assert.Equal("environment_session", method);
            var op = parameters!["operation"]!.ToString();
            Operations.Add(op);
            if (op == "connect") return new JsonObject { ["lease"] = "test-lease", ["host"] = "lab.example", ["username"] = "test-user", ["ideVersion"] = "11.55.69" };
            if (op == "close") return new JsonObject { ["closed"] = true };
            if (Failures.TryGetValue(op, out var queue) && queue.Count > 0) throw new BridgeCallException(queue.Dequeue(), null);
            return new JsonObject { ["value"] = Value?.DeepClone() };
        }
    }
}

/// <summary>Through the connected Studio a miss is not read again (the list was already fresh), and create-app picks its
/// template from the templates of the same environment read earlier, without an environment call.</summary>
public sealed class VelEntregaHeadlessTemplateTests
{
    public VelEntregaHeadlessTemplateTests() => StudioAssemblies.Bind();

    private static readonly TemplateSummary[] Templates =
    [
        new("tpl-reactive", "ReactiveWebApp", null, false, "CrossDevice"),
        new("tpl-phone", "PhoneApp", null, true, "Mobile"),
        new("tpl-tablet", "TabletApp", null, true, "Mobile"),
    ];

    [Fact]
    public void AConnectedMissIsNotAskedTwice()
    {
        var bridge = new VelEntregaEnvironmentNetworkTests.Flaky { Value = new JsonArray() };
        using var session = HeadlessSession.ConnectStudio(bridge, "lab.example", null, true);
        Assert.Null(session.FindApplication("FolhaPonto"));
        Assert.Null(session.FindModule("FolhaPonto_CS"));
        Assert.Equal(new[] { "connect", "applications", "modules" }, bridge.Operations);
    }

    [Fact]
    public void KnownTemplatesOfThisEnvironmentAvoidTheTemplatesCall()
    {
        var bridge = new VelEntregaEnvironmentNetworkTests.Flaky { Value = JsonSerializer.SerializeToNode(Templates, ConnectedEnvironment.Wire) };
        using var session = HeadlessSession.ConnectStudio(bridge, "lab.example", null, false);
        Assert.False(session.UseKnownTemplates("other.example", Templates));
        Assert.False(session.UseKnownTemplates("lab.example", Array.Empty<TemplateSummary>()));
        Assert.True(session.UseKnownTemplates("LAB.example", Templates));
        Assert.Equal("tpl-phone", session.FindTemplateForKind("Mobile")!.Key);
        Assert.Equal("tpl-tablet", session.FindTemplateForKind("Mobile", "TabletApp")!.Key);
        Assert.DoesNotContain("templates", bridge.Operations);
        // A kind the known list does not hold, or a preferred label it does not have, reads the server as before.
        Assert.Null(session.FindTemplateForKind("WebResponsive"));
        Assert.Single(bridge.Operations, o => o == "templates");
        Assert.Equal("tpl-reactive", session.FindTemplateForKind("CrossDevice", "ExternalWebPortal")!.Key);
        Assert.Equal(2, bridge.Operations.Count(o => o == "templates"));
    }
}

/// <summary>The open of a delivery whose build phase captured the module's tab by key skips the Studio's references check
/// (references_check:false); any other delivery opens as before.</summary>
public sealed class VelEntregaDeliveryOpenTests
{
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void TheOpenAsksForTheReferencesCheckOnlyWithoutABuildCapture(bool skip)
    {
        var root = Path.GetDirectoryName(typeof(VelEntregaDeliveryOpenTests).Assembly.Location);
        while (root != null && !File.Exists(Path.Combine(root, "MANIFESTO.md"))) root = Path.GetDirectoryName(root);
        var work = Path.Combine(root!, ".local", "delivery-tests", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        var job = Path.Combine(work, "job.json"); File.WriteAllText(job, "{\"base\":\"blank-service.oml\",\"ops\":[]}");
        var bridge = new Recording();
        var result = Delivery.Run(bridge, new("Probe", job, work, Array.Empty<string>(), SkipOpenReferencesCheck: skip),
            (_, _, output) => { File.WriteAllText(output, "foreign"); return new JsonObject { ["isValid"] = true, ["accepted"] = true }; });
        Assert.True(result["delivered"]!.GetValue<bool>(), result["error"]?.ToString());
        var open = Assert.Single(bridge.Opens);
        Assert.True(open["answer_dependencies"]!.GetValue<bool>());
        if (skip) Assert.False(open["references_check"]!.GetValue<bool>());
        else Assert.Null(open["references_check"]);
        // A call property: never part of the task identity.
        Assert.DoesNotContain("SkipOpenReferencesCheck", JsonSerializer.Serialize(new DeliveryRequest("Probe", job, work, Array.Empty<string>(), SkipOpenReferencesCheck: true)));
    }

    private sealed class Recording : IBridgeClient
    {
        public readonly List<JsonObject> Opens = [];
        public JsonObject Call(string method, JsonObject? p = null) => method switch
        {
            "open_module" => Open(p!),
            "get_active_module" => new() { ["name"] = "Probe", ["key"] = "module-A" },
            "snapshot_module" => Snapshot(p!),
            "merge_from_oml" => new() { ["merged"] = true, ["newErrors"] = 0 },
            "get_errors" => new() { ["newErrors"] = 0, ["new"] = new JsonArray(), ["fixed"] = new JsonArray(), ["preexisting"] = new JsonArray() },
            "bridge_manifest" => new() { ["capabilities"] = new JsonArray("merge_from_oml:module_key") },
            _ => throw new InvalidOperationException("Unexpected bridge operation: " + method),
        };
        private JsonObject Open(JsonObject p) { Opens.Add(p.DeepClone().AsObject()); return new() { ["opened"] = true, ["alreadyOpen"] = true }; }
        private static JsonObject Snapshot(JsonObject p)
        {
            File.WriteAllText(p["path"]!.ToString(), "snapshot");
            return new() { ["key"] = "module-A", ["snapshot_id"] = "snapshot-A" };
        }
    }
}

/// <summary>The model fingerprint list_open_modules answers (MergeRollbackProof.ModelSha256Hex, in both bridges) names the
/// same model as the kernel's PrebuiltCandidate.ModelSha256 of a capture file: the build phase may then reuse a capture the
/// server holds instead of uploading the same model again.</summary>
public sealed class VelEntregaBridgeFingerprintTests
{
    private static byte[] Oml(string header, string model)
    {
        var head = System.Text.Encoding.UTF8.GetBytes(header);
        return [.. "OML"u8.ToArray(), .. BitConverter.GetBytes((uint)head.Length), .. head, .. System.Text.Encoding.UTF8.GetBytes(model)];
    }

    [Fact]
    public void TheBridgeFingerprintIsTheKernelModelShaAndIgnoresTheWindowStateHeader()
    {
        var dir = Path.Combine(Path.GetTempPath(), "vel-entrega-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(dir);
        try
        {
            var a = Oml("{tree:1}", "model-bytes"); var b = Oml("{tree:2, selection:\"X\"}", "model-bytes"); var c = Oml("{tree:1}", "model-bytes!");
            var file = Path.Combine(dir, "a.oml"); File.WriteAllBytes(file, a);
            Assert.Equal(PrebuiltCandidate.ModelSha256(file), Anvil.Bridge.MergeRollbackProof.ModelSha256Hex(a));
            Assert.Equal(Anvil.Bridge.MergeRollbackProof.ModelSha256Hex(a), Anvil.Bridge.MergeRollbackProof.ModelSha256Hex(b));
            Assert.NotEqual(Anvil.Bridge.MergeRollbackProof.ModelSha256Hex(a), Anvil.Bridge.MergeRollbackProof.ModelSha256Hex(c));
            var raw = "not an oml"u8.ToArray();
            Assert.Equal(Anvil.Bridge.MergeRollbackProof.Sha256Hex(raw), Anvil.Bridge.MergeRollbackProof.ModelSha256Hex(raw));
        }
        finally { Directory.Delete(dir, true); }
    }
}
