using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>prazos B (production test of 2026-10-12, screens delivery 03:37-03:42 UTC): the producer capture of a consumer
/// delivery reads the environment through the Studio's own login. Those reads hung on the PC's mobile uplink: 89.8 s ending
/// in "CommunicationException: Uma tentativa de conexão falhou ... (host:443)", then 31.2 s and 10.5 s that answered and a
/// 60 s cut by the Studio's WCF SendTimeout. The answer was a raw "BridgeCallException: environment_session:
/// TimeoutException: ..." under DELIVERY_FAILED, and ssam_task read "validate-job" the whole time. Now the cut is typed
/// (ENVIRONMENT_CALL_CUT with cut {operation, cause, afterSeconds, ...}), names that nothing was written, keeps the cached
/// capture, and the task shows the producer-signatures stage while it waits.</summary>
public sealed class EnvironmentCutTests
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(EnvironmentCutTests).Assembly.Location)!)!;

    // The producer captures read the recorded envelopes through the Studio model assemblies.
    public EnvironmentCutTests() => StudioAssemblies.Bind();

    // The texts of the production test, as the bridge client throws them (method: error).
    private const string WcfTimeoutPt = "environment_session: TimeoutException: O canal de solicitação atingiu o tempo limite ao tentar o envio após 00:01:00. "
        + "Aumente o valor de tempo limite passado à chamada para Request ou aumente o valor de SendTimeout na Associação. O tempo alocado para essa operação "
        + "pode ter sido uma parte de um tempo limite maior.";
    private const string ConnectFailedPt = "environment_session: CommunicationException: Uma tentativa de conexão falhou porque o componente conectado não respondeu\r\n"
        + "corretamente após um período de tempo ou a conexão estabelecida falhou\r\nporque o host conectado não respondeu. (andre-machado.outsystemscloud.com:443)";

    [Theory]
    [InlineData(WcfTimeoutPt, "timeout", 60)]
    [InlineData("environment_session: TimeoutException: The request channel timed out attempting to send after 00:01:00. Increase the timeout value.", "timeout", 60)]
    [InlineData(ConnectFailedPt, "connection", null)]
    [InlineData("environment_session: CommunicationException: An error occurred while sending the request.", "connection", null)]
    public void TheStudiosOwnCutsAreClassified(string message, string cause, int? after)
    {
        var classified = EnvironmentCut.Classify(new BridgeCallException(message, null));
        Assert.NotNull(classified);
        Assert.Equal(cause, classified!.Value.Cause);
        Assert.Equal(after, classified.Value.AfterSeconds);
    }

    [Theory]
    [InlineData("environment_session: InvalidOperationException: The connected environment lease expired; reconnect before submitting another operation")]
    [InlineData("environment_session: SignatureCaptureException: ProducerNotFound: X is not referenceable in lab.example")]
    [InlineData("snapshot_module: TimeoutException: The operation has timed out.")]
    [InlineData("environment_session: bridge closed before replying; execution outcome may be unknown")]
    public void AnythingElseIsNotACut(string message)
        => Assert.Null(EnvironmentCut.Classify(new BridgeCallException(message, null)));

    [Fact]
    public void TheAuthorityNamesTheCutReadAndClosesItsLease()
    {
        var environment = SignatureEnvironment.Primitive();
        var bridge = new CuttingBridge(environment) { CutOperation = "extensions", Error = WcfTimeoutPt };
        var authority = new StudioProducerAuthority(host => HeadlessSession.ConnectStudio(bridge, host, null, readOnly: true));
        var destination = Path.Combine(Dir(), "Primitive.avsig");
        var cut = Assert.Throws<EnvironmentCallCutException>(() => authority.Capture("ZZHighCodePrimitives",
            ["IServerActionSignature:CSharpTextCompareOrdinal"], destination, "lab.example"));
        Assert.Equal(EnvironmentCut.Code, cut.Code);
        Assert.Equal("extensions", cut.Operation);          // the read that was running when the Studio's client cut it
        Assert.Equal("timeout", cut.Cause);
        Assert.Equal(60, cut.AfterSeconds);
        Assert.Equal("ZZHighCodePrimitives", cut.Producer);
        Assert.Equal("lab.example", cut.Host);
        Assert.Contains("outside SSAM", cut.Message);
        Assert.Contains("nothing was captured, applied or merged", cut.Message);
        Assert.False(File.Exists(destination));
        Assert.Equal("close", bridge.Operations[^1]);       // the lease is closed after the cut
        var json = cut.Cut("producer-signatures");
        Assert.Equal("service-studio", json["cutBy"]!.ToString());
        Assert.Equal("not-sent", json["writeState"]!.ToString());
        Assert.Equal("producer-signatures", json["stage"]!.ToString());
    }

    [Fact]
    public void ADeliveryWhoseProducerReadIsCutAnswersTypedAndKeepsTheCache()
    {
        WithAuthority(() =>
        {
            var work = Path.Combine(Root, ".local", "environment-cut-tests", Guid.NewGuid().ToString("N"), ".local", "work");
            Directory.CreateDirectory(work);
            var environment = SignatureEnvironment.Primitive();
            var bridge = new CuttingBridge(environment);
            var authority = new StudioProducerAuthority(host => HeadlessSession.ConnectStudio(bridge, host, null, readOnly: true));
            var job = Path.Combine(work, "..", "capture-job.json");
            File.WriteAllText(job, new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "reference", ["producer"] = "Primitive",
                ["elements"] = new JsonArray("IServerActionSignature:CSharpTextCompareOrdinal") }) }.ToJsonString());
            JsonObject Deliver() => Delivery.Run(new Studio(), new DeliveryRequest("Probe", job, work, [], CaptureProducers: ["Primitive=ZZHighCodePrimitives"]),
                (_, _, _) => throw new Exception("producer-aware apply expected"), producerAuthority: authority,
                applyWithProducers: (_, _, _, _) => new JsonObject { ["isValid"] = false, ["accepted"] = false });

            // A first delivery captures and caches the producer (a new task each time).
            var first = Deliver();
            Assert.Contains("job rejected", first["error"]!.ToString());

            // The Studio's client then cuts the re-attestation of the cached capture: typed, nothing written, cache kept.
            bridge.CutOperation = "referenceable"; bridge.Error = ConnectFailedPt;
            var cut = Deliver();
            Assert.Equal(EnvironmentCut.Code, cut["code"]!.ToString());
            Assert.Equal("producer-signatures", cut["stage"]!.ToString());
            Assert.Equal("not-sent", cut["writeState"]!.ToString());
            Assert.Equal("referenceable", cut["cut"]!["operation"]!.ToString());
            Assert.Equal("connection", cut["cut"]!["cause"]!.ToString());
            Assert.Equal("producer-signatures", cut["cut"]!["stage"]!.ToString());
            Assert.Contains("outside SSAM", cut["error"]!.ToString());
            var history = cut["history"]!.AsArray().Select(h => h!["stage"]!.ToString()).ToList();
            Assert.True(history.IndexOf("producer-signatures") > history.IndexOf("validate-job"), string.Join(",", history));
            Assert.Equal(1, environment.Operations.Count(o => o == "signature"));    // never captured again over the cut

            // Once the PC reaches the environment, the cached capture serves the next delivery.
            bridge.CutOperation = null;
            var third = Deliver();
            Assert.True(third["capturedProducers"]!["Primitive"]!["reusedFromCache"]!.GetValue<bool>());
            Assert.Equal(1, environment.Operations.Count(o => o == "signature"));
        });
    }

    [Fact]
    public void AJobThePreflightRefusedKeepsThatRefusalAndSaysTheReadWasCut()
    {
        WithAuthority(() =>
        {
            var work = Dir();
            var environment = SignatureEnvironment.Primitive();
            var bridge = new CuttingBridge(environment) { CutOperation = "referenceable", Error = WcfTimeoutPt };
            var authority = new StudioProducerAuthority(host => HeadlessSession.ConnectStudio(bridge, host, null, readOnly: true));
            var job = Path.Combine(work, "job.json");
            File.WriteAllText(job, """
                {"ops":[{"op":"reference","producer":"Primitive","elements":["IServerActionSignature:CSharpTextCompareOrdinal"]},
                {"op":"logic","data":{"actions":[{"name":"PcPure","outputs":[{"name":"D","type":"Integer"}],"steps":[{"assign":{"D":"ExpiryAlertDays"}}]}]}}]}
                """);
            var result = Delivery.Run(new Studio(), new DeliveryRequest("Probe", job, work, [], CaptureProducers: ["Primitive=ZZHighCodePrimitives"]),
                (_, _, _) => throw new Exception("must not apply"), producerAuthority: authority,
                applyWithProducers: (_, _, _, _) => throw new Exception("must not apply"));
            Assert.Equal(Delivery.PreflightRefused, result["code"]!.ToString());
            Assert.False(result["verifyRan"]!.GetValue<bool>());
            Assert.Contains("outside SSAM", result["verifyReason"]!.ToString());
            Assert.Equal("timeout", result["cut"]!["cause"]!.ToString());
            Assert.Equal(60, result["cut"]!["afterSeconds"]!.GetValue<int>());
        });
    }

    // servidor/fase4-24: prazos B (ENVIRONMENT_CALL_CUT) and vel-entrega (ENVIRONMENT_UNREACHABLE) on one failure: the kernel's
    // single read retry (ConnectedEnvironment) runs once, never on the Studio's own timeout, and the capture answers ONE code.
    private const string SendFailed = "environment_session: CommunicationException: An error occurred while sending the request.";
    private const string NetworkTimeout = "environment_session: CommunicationException: An error occurred while sending the request. <- "
        + "TimeoutException: The request channel timed out attempting to send after 00:01:00.";

    [Fact]
    public void ANetworkFailureOfACaptureReadIsAskedOnceMoreThenOneTypedCut()
    {
        var environment = SignatureEnvironment.Primitive();
        var bridge = new CuttingBridge(environment) { CutOperation = "extensions", Error = SendFailed };
        var authority = new StudioProducerAuthority(host => HeadlessSession.ConnectStudio(bridge, host, null, readOnly: true));
        var cut = Assert.Throws<EnvironmentCallCutException>(() => authority.Capture("ZZHighCodePrimitives",
            ["IServerActionSignature:CSharpTextCompareOrdinal"], Path.Combine(Dir(), "Primitive.avsig"), "lab.example"));
        Assert.Equal(EnvironmentCut.Code, cut.Code);
        Assert.Equal("connection", cut.Cause);
        Assert.Equal("extensions", cut.Operation);
        Assert.True(cut.Repeated);
        Assert.Equal(2, bridge.Operations.Count(o => o == "extensions"));   // the kernel's one retry, never more
        Assert.Contains("asked twice", cut.Message);
        Assert.True(cut.Cut("producer-signatures")["repeated"]!.GetValue<bool>());
        Assert.IsType<EnvironmentUnreachableException>(EnvironmentCut.FindUnreachable(cut));
        Assert.Equal(EnvironmentCut.Code, Errors.FindCoded(cut)!.Code);                // one code: the cut's
    }

    [Theory]
    [InlineData(WcfTimeoutPt, null)]
    [InlineData(NetworkTimeout, false)]
    public void TheStudiosOwnTimeoutIsNeverAskedAgain(string error, bool? repeated)
    {
        Assert.True(EnvironmentNetwork.ClientTimedOut(error));
        Assert.False(EnvironmentNetwork.MayRepeat("extensions", error));
        var environment = SignatureEnvironment.Primitive();
        var bridge = new CuttingBridge(environment) { CutOperation = "extensions", Error = error };
        var authority = new StudioProducerAuthority(host => HeadlessSession.ConnectStudio(bridge, host, null, readOnly: true));
        var cut = Assert.Throws<EnvironmentCallCutException>(() => authority.Capture("ZZHighCodePrimitives",
            ["IServerActionSignature:CSharpTextCompareOrdinal"], Path.Combine(Dir(), "Primitive.avsig"), "lab.example"));
        Assert.Equal(1, bridge.Operations.Count(o => o == "extensions"));
        Assert.Equal(repeated, cut.Repeated);
        Assert.Equal("timeout", cut.Cause);
        Assert.Equal(60, cut.AfterSeconds);
    }

    [Fact]
    public void AnUnreachableReadOutsideTheCaptureIsTheSameCut()
    {
        var unreachable = new EnvironmentUnreachableException("modules", "lab.example", SendFailed, repeated: true);
        Assert.Equal(("connection", (int?)null), EnvironmentCut.Classify(unreachable));
        var cut = EnvironmentCut.FromUnreachable(unreachable, "an environment read of the delivery");
        Assert.Equal(EnvironmentCut.Code, cut.Code);
        Assert.Equal("modules", cut.Operation);
        Assert.Equal("lab.example", cut.Host);
        var json = cut.Cut("open");
        Assert.True(json["repeated"]!.GetValue<bool>());
        Assert.Equal("not-sent", json["writeState"]!.ToString());
        Assert.Same(unreachable, EnvironmentCut.FindUnreachable(new InvalidOperationException("outer", unreachable)));
        Assert.Null(EnvironmentCut.FindUnreachable(new BridgeCallException(SendFailed, null)));
    }

    private static string Dir()
    {
        var dir = Path.Combine(Root, ".local", "environment-cut-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }

    // The module reservations of these deliveries stay in a private authority folder.
    private static void WithAuthority(Action body)
    {
        var before = Environment.GetEnvironmentVariable("ANVIL_AUTHORITY_DIR");
        Environment.SetEnvironmentVariable("ANVIL_AUTHORITY_DIR", Path.Combine(Path.GetTempPath(), "environment-cut-authority-" + Guid.NewGuid().ToString("N")));
        try { body(); }
        finally { Environment.SetEnvironmentVariable("ANVIL_AUTHORITY_DIR", Pa2F1TestAuthority.Restore(before)); }
    }

    /// <summary>The Studio's environment_session over a recorded environment, where the Studio's own client cuts the first
    /// read of CutOperation with Error (what the bridge client throws for that reply).</summary>
    private sealed class CuttingBridge(SignatureEnvironment inner) : IBridgeClient
    {
        public string? CutOperation;
        public string Error = WcfTimeoutPt;
        public List<string> Operations { get; } = [];
        public JsonObject Call(string method, JsonObject? parameters = null)
        {
            var operation = parameters?["operation"]?.ToString() ?? "";
            Operations.Add(operation);
            if (operation == CutOperation) throw new BridgeCallException(Error, null);
            return inner.Call(method, parameters);
        }
    }

    private sealed class Studio : IBridgeClient
    {
        public JsonObject Call(string method, JsonObject? parameters = null) => method switch
        {
            "open_module" => new() { ["opened"] = true },
            "get_active_module" => new() { ["name"] = "Probe", ["key"] = "module-key", ["environment"] = "lab.example" },
            "bridge_manifest" => new() { ["capabilities"] = new JsonArray() },
            "snapshot_module" => Snapshot(parameters),
            _ => throw new Exception("Unexpected bridge call: " + method)
        };

        private static JsonObject Snapshot(JsonObject? parameters)
        {
            if (parameters?["path"] is { } path) File.WriteAllText(path.ToString(), "snapshot");
            return new() { ["key"] = "module-key", ["snapshot_id"] = "snapshot-1" };
        }
    }
}
