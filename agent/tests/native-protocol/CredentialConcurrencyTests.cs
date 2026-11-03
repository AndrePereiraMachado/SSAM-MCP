using System.Text.Json.Nodes;
using Ssam.Agent;
using Xunit;

public class CredentialConcurrencyTests
{
    private sealed class Harness
    {
        internal readonly CredentialKinds Kind = new(Path.Combine(Path.GetTempPath(), "credential-concurrency-" + Guid.NewGuid().ToString("N")), "fixture", new())
            { ForceWindows = true, Lookup = _ => Task.FromResult(new[] { "93.184.216.34" }) };
        internal readonly TaskCompletionSource Started = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal readonly TaskCompletionSource Release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal int Logins;
        internal bool Valid = true, Fail;
        internal Harness()
        {
            Kind.Helper = async p => {
                if (p["op"]!.GetValue<string>() == "status") return new() { ["ok"] = true, ["available"] = true, ["authenticated"] = p["privateSession"] != null && Valid };
                if (p["op"]!.GetValue<string>() == "sign-out") return new() { ["ok"] = true };
                Assert.Equal("login", p["op"]!.GetValue<string>());
                Logins++; Started.TrySetResult(); await Release.Task;
                return Fail ? new() { ["ok"] = false, ["code"] = "CREDENTIAL_AUTH_CONTRACT_CHANGED" }
                    : new() { ["ok"] = true, ["authenticated"] = true, ["privateSession"] = new JsonObject { ["token"] = "synthetic-private-token" } };
            };
        }
    }
    private static JsonObject Request(string service = "odc-portal", string profile = "a") => new() {
        ["op"] = "login", ["host"] = "tenant.example.test", ["service"] = service,
        ["auth"] = "credential", ["profile"] = string.Concat(Enumerable.Repeat(profile, 64))
    };

    [Theory]
    [InlineData("odc-portal")]
    [InlineData("service-center")]
    public async Task ConcurrentAndLateLoginUseOneAuthenticatedSession(string service)
    {
        var h = new Harness(); var request = Request(service);
        var first = h.Kind.Execute(request, CancellationToken.None); await h.Started.Task;
        var second = h.Kind.Execute(request, CancellationToken.None);
        var third = h.Kind.Execute(request, CancellationToken.None); h.Release.SetResult();
        foreach (var result in await Task.WhenAll(first, second, third)) Assert.True(result["authenticated"]!.GetValue<bool>());
        Assert.Equal(1, h.Logins);
        var late = await h.Kind.Execute(request, CancellationToken.None);
        Assert.Contains("reused", late["notes"]![0]!.GetValue<string>()); Assert.Equal(1, h.Logins);
        h.Valid = false; await h.Kind.Execute(request, CancellationToken.None); Assert.Equal(2, h.Logins);
    }

    [Fact]
    public async Task SharedFailureConsumesOneAttemptAndLaterExplicitAttemptRecovers()
    {
        var h = new Harness { Fail = true }; var request = Request();
        var first = h.Kind.Execute(request, CancellationToken.None); await h.Started.Task;
        var second = h.Kind.Execute(request, CancellationToken.None); h.Release.SetResult();
        foreach (var task in new[] { first, second }) Assert.Equal("CREDENTIAL_AUTH_CONTRACT_CHANGED", (await Assert.ThrowsAsync<AgentFault>(() => task)).Code);
        Assert.Equal(1, h.Logins); h.Fail = false;
        Assert.True((await h.Kind.Execute(request, CancellationToken.None))["authenticated"]!.GetValue<bool>()); Assert.Equal(2, h.Logins);
    }

    [Fact]
    public async Task CancelledWaiterDoesNotCancelOwnerOrAnotherWaiter()
    {
        var h = new Harness(); var first = h.Kind.Execute(Request(), CancellationToken.None); await h.Started.Task;
        using var cancelled = new CancellationTokenSource();
        var second = h.Kind.Execute(Request(), cancelled.Token); var third = h.Kind.Execute(Request(), CancellationToken.None);
        cancelled.Cancel(); await Assert.ThrowsAnyAsync<OperationCanceledException>(() => second);
        h.Release.SetResult(); await Task.WhenAll(first, third); Assert.Equal(1, h.Logins);
    }

    [Fact]
    public async Task DifferentProfilesServicesAndRuntimeAccountsStaySeparate()
    {
        var h = new Harness(); var other = new Harness(); h.Release.SetResult(); other.Release.SetResult();
        await Task.WhenAll(h.Kind.Execute(Request(), CancellationToken.None), h.Kind.Execute(Request(profile: "b"), CancellationToken.None),
            h.Kind.Execute(Request("service-center"), CancellationToken.None), other.Kind.Execute(Request(), CancellationToken.None));
        Assert.Equal(3, h.Logins); Assert.Equal(1, other.Logins);
    }

    [Fact]
    public async Task SignOutBetweenLoginsDoesNotJoinTheEarlierFlight()
    {
        var h = new Harness(); var first = h.Kind.Execute(Request(), CancellationToken.None); await h.Started.Task;
        var signOut = Request(); signOut["op"] = "sign-out";
        var revoke = h.Kind.Execute(signOut, CancellationToken.None); var next = h.Kind.Execute(Request(), CancellationToken.None);
        h.Release.SetResult(); await Task.WhenAll(first, revoke, next); Assert.Equal(2, h.Logins);
    }
}
