using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>Lote 4, F3 (24/10/2026, ssam_map of a closed module): the server refused the identity of the connected Studio's
/// session (IDX20803 inside a SOAP fault) and the answer was a generic CLI refusal with the stack. A read is now asked once
/// more on a renewed lease of the Studio's current login; what is still refused, a write, or a renewal that fails is
/// ENVIRONMENT_SESSION_EXPIRED, whose text names the Studio's own sign-in (never a password in the chat).</summary>
public sealed class EnvironmentSessionRenewalTests
{
    public EnvironmentSessionRenewalTests() => StudioAssemblies.Bind();

    // The answer preserved on 24/10 (kernel/.local/answers/d8b6367a...), up to the part that names the identity failure.
    private const string Idx20803 = "environment_session: FaultException: Server was unable to process request. ---> One or more errors occurred. "
        + "---> IDX20803: Unable to obtain configuration from: 'http://server.example/server.identity/.well-known/openid-configuration'.";

    [Fact]
    public void ClassifiesTheIdentityRefusalBeforeTheServerAnswer()
    {
        Assert.True(EnvironmentNetwork.IsSessionExpired(Idx20803));
        Assert.True(EnvironmentNetwork.IsSessionExpired("environment_session: SecurityTokenExpiredException: IDX10223: Lifetime validation failed."));
        Assert.True(EnvironmentNetwork.IsServerAnswer(Idx20803));
        Assert.False(EnvironmentNetwork.IsSessionExpired("environment_session: WebException: The remote server returned an error: (500) Internal Server Error."));
        Assert.False(EnvironmentNetwork.IsSessionExpired("environment_session: CommunicationException: An error occurred while sending the request."));
        Assert.False(EnvironmentNetwork.IsSessionExpired("environment_session: InvalidOperationException: The connected environment lease expired"));
        Assert.False(EnvironmentNetwork.IsSessionExpired(null));
    }

    [Fact]
    public void AReadRefusedForItsIdentityIsAskedOnceMoreOnARenewedLease()
    {
        var bridge = new Renewing { Failures = { ["modules"] = new Queue<string>([Idx20803]) }, Value = new JsonArray() };
        using var session = HeadlessSession.ConnectStudio(bridge, "lab.example", null, true);
        Assert.Empty(session.ListModules());
        Assert.Equal(new[] { "connect", "modules", "connect", "close", "modules" }, bridge.Operations);
        // The second request goes on the new lease; the old one is closed.
        Assert.Equal(new[] { "lease-1", "lease-2" }, bridge.Leases["modules"]);
        Assert.Equal("lease-1", bridge.Closed.Single());
        Assert.Equal(new[] { "modules" }, session.Connected!.RenewedReads);
        Assert.Empty(session.Connected.RepeatedReads);
    }

    [Fact]
    public void ARefusalAfterTheRenewalIsSessionExpiredNotAGenericRefusal()
    {
        var bridge = new Renewing { Failures = { ["modules"] = new Queue<string>([Idx20803, Idx20803]) } };
        using var session = new ConnectedEnvironment(bridge, "lab.example", null, true);
        var error = Assert.Throws<EnvironmentSessionExpiredException>(() => session.Call<ModuleSummary[]>("modules"));
        Assert.Equal("ENVIRONMENT_SESSION_EXPIRED", error.Code);
        Assert.True(error.Renewed);
        Assert.False(error.Write);
        Assert.Equal(2, bridge.Operations.Count(o => o == "modules"));
        var envelope = Errors.Envelope("modules", error, 1);
        Assert.Equal("ENVIRONMENT_SESSION_EXPIRED", envelope["code"]!.ToString());
        Assert.Contains("o11_studio login", envelope["error"]!.ToString());
        Assert.Contains("nothing was changed", envelope["error"]!.ToString());
    }

    [Fact]
    public void ARenewalTheStudioRefusesIsSessionExpiredWithoutAskingAgain()
    {
        var bridge = new Renewing { Failures = { ["modules"] = new Queue<string>([Idx20803]) }, RefuseReconnect = "Studio is not logged in" };
        using var session = new ConnectedEnvironment(bridge, "lab.example", null, true);
        var error = Assert.Throws<EnvironmentSessionExpiredException>(() => session.Call<ModuleSummary[]>("modules"));
        Assert.False(error.Renewed);
        Assert.Contains("<- renewal: ", error.Message);
        Assert.Contains("Studio is not logged in", error.Message);
        Assert.Single(bridge.Operations, o => o == "modules");
    }

    [Fact]
    public void AWriteRefusedForItsIdentityIsNeverRepeated()
    {
        var bridge = new Renewing { Failures = { ["publish-start"] = new Queue<string>([Idx20803]) } };
        using var session = new ConnectedEnvironment(bridge, "lab.example", null, false);
        var error = Assert.Throws<EnvironmentSessionExpiredException>(() => session.Call<PublishOutcome>("publish-start", new { oml = new byte[] { 1 } }));
        Assert.True(error.Write);
        Assert.Contains("outcome on the server is unknown", error.Message);
        Assert.Equal(new[] { "connect", "publish-start" }, bridge.Operations);
        Assert.Empty(session.RenewedReads);
    }

    // Review W2-DIAG: one renewal per session. A later read the server refuses for its identity on the same session is the
    // session expired again (renewed), never a second renewal.
    [Fact]
    public void TwoReadsOnOneSessionRenewOnlyOnce()
    {
        var bridge = new Renewing { Failures = { ["modules"] = new Queue<string>([Idx20803]), ["applications"] = new Queue<string>([Idx20803]) }, Value = new JsonArray() };
        using var session = new ConnectedEnvironment(bridge, "lab.example", null, true);
        session.Call<JsonNode>("modules");
        var error = Assert.Throws<EnvironmentSessionExpiredException>(() => session.Call<JsonNode>("applications"));
        Assert.True(error.Renewed);
        Assert.Equal(new[] { "connect", "modules", "connect", "close", "modules", "applications" }, bridge.Operations);
        Assert.Equal(new[] { "modules" }, session.RenewedReads);
    }

    // Review W2-DIAG: the renewed read that then fails on the network answers ENVIRONMENT_UNREACHABLE, never a bare bridge
    // error, and is never asked a third time.
    [Fact]
    public void ARenewedReadLostOnTheNetworkAnswersItsCode()
    {
        const string net = "environment_session: CommunicationException: An error occurred while sending the request. ---> SocketException: No such host is known.";
        var bridge = new Renewing { Failures = { ["modules"] = new Queue<string>([Idx20803, net]) } };
        using var session = new ConnectedEnvironment(bridge, "lab.example", null, true);
        var error = Assert.Throws<EnvironmentUnreachableException>(() => session.Call<JsonNode>("modules"));
        Assert.Equal("ENVIRONMENT_UNREACHABLE", Errors.Envelope("modules", error, 1)["code"]!.ToString());
        Assert.Equal(2, bridge.Operations.Count(o => o == "modules"));
    }

    // Review W2-DIAG: a renewal the Studio answers for another environment closes that lease and asks nothing again.
    [Fact]
    public void ARenewalOnAnotherEnvironmentIsClosed()
    {
        var bridge = new Renewing { Failures = { ["modules"] = new Queue<string>([Idx20803]) }, OtherHostOnReconnect = "other.example" };
        using var session = new ConnectedEnvironment(bridge, "lab.example", null, true);
        Assert.Throws<EnvironmentSessionExpiredException>(() => session.Call<JsonNode>("modules"));
        Assert.Equal(new[] { "lease-2" }, bridge.Closed);
        Assert.Single(bridge.Operations, o => o == "modules");
    }

    // Review W2-DIAG (suggestion 3): a cursor read is never renewed and every write refused for its identity is sent once.
    [Theory]
    [InlineData("publish-check")] [InlineData("publish-start")] [InlineData("application-save")] [InlineData("module-delete")]
    [InlineData("application-delete")] [InlineData("module-associate")]
    public void ANonRepeatableCallRefusedForItsIdentityIsSentOnce(string operation)
    {
        var bridge = new Renewing { Failures = { [operation] = new Queue<string>([Idx20803]) } };
        using var session = new ConnectedEnvironment(bridge, "lab.example", null, false);
        var error = Assert.Throws<EnvironmentSessionExpiredException>(() => session.Call<JsonNode>(operation, new { x = 1 }));
        Assert.False(error.Renewed);
        Assert.Equal(new[] { "connect", operation }, bridge.Operations);
    }

    /// <summary>A Studio bridge whose every connect answers a new lease, and that remembers the lease of each request.</summary>
    private sealed class Renewing : IBridgeClient
    {
        public readonly List<string> Operations = [];
        public readonly List<string> Closed = [];
        public readonly Dictionary<string, List<string>> Leases = new();
        public readonly Dictionary<string, Queue<string>> Failures = new();
        public JsonNode? Value;
        public string? RefuseReconnect;
        public string? OtherHostOnReconnect;
        private int _leases;

        public JsonObject Call(string method, JsonObject? parameters = null)
        {
            Assert.Equal("environment_session", method);
            var op = parameters!["operation"]!.ToString();
            Operations.Add(op);
            if (op == "connect")
            {
                if (_leases > 0 && RefuseReconnect != null) throw new BridgeCallException("environment_session: InvalidOperationException: " + RefuseReconnect, null);
                return new JsonObject { ["lease"] = "lease-" + ++_leases, ["host"] = _leases > 1 && OtherHostOnReconnect != null ? OtherHostOnReconnect : "lab.example", ["username"] = "test-user", ["ideVersion"] = "11.55.69" };
            }
            var lease = parameters["lease"]!.ToString();
            if (op == "close") { Closed.Add(lease); return new JsonObject { ["closed"] = true }; }
            (Leases.TryGetValue(op, out var seen) ? seen : Leases[op] = []).Add(lease);
            if (Failures.TryGetValue(op, out var queue) && queue.Count > 0) throw new BridgeCallException(queue.Dequeue(), null);
            return new JsonObject { ["value"] = Value?.DeepClone() };
        }
    }
}
