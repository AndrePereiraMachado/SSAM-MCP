using System.Text.Json.Nodes;
using Anvil.Bridge;
using Xunit;

namespace Anvil.Tests;

/// <summary>Lane F of the 2026-10-05 package (docs/PACOTE-SESSOES-NOVO.md, C05 3): the session policy of the hidden Service
/// Center window, the part ScWebHandler only calls (ScProtocol.cs ScWebSession and ScWebLogin). When the keep-alive runs,
/// what an expired read does, when a login is asked and how a sign-in page is classified. No Studio, CEF or server.</summary>
public sealed class PacoteFScTests
{
    private const string Host = "lab.example";
    private static readonly DateTime Now = new(2026, 10, 5, 12, 0, 0, DateTimeKind.Utc);

    private static JsonObject Status(bool signedIn, bool loading = false) => new() { ["open"] = true, ["signedIn"] = signedIn, ["loading"] = loading };
    private static string Page(string origin, bool form = false, bool error = false, bool sso = false) =>
        new JsonObject { ["origin"] = origin, ["form"] = form, ["error"] = error, ["sso"] = sso }.ToJsonString();

    [Fact]
    public void TheKeepAliveIsScheduledOnlyWhileTheWindowIsOpenAndSignedIn()
    {
        var idle = Now - ScWebSession.KeepAliveInterval;
        Assert.True(ScWebSession.KeepAliveDue(windowOpen: true, signedIn: true, busy: false, idle, Now));
        Assert.False(ScWebSession.KeepAliveDue(windowOpen: false, signedIn: true, busy: false, idle, Now));
        Assert.False(ScWebSession.KeepAliveDue(windowOpen: true, signedIn: false, busy: false, idle, Now));
        // Another request holds the window, or the session was used recently: no keep-alive read.
        Assert.False(ScWebSession.KeepAliveDue(windowOpen: true, signedIn: true, busy: true, idle, Now));
        Assert.False(ScWebSession.KeepAliveDue(windowOpen: true, signedIn: true, busy: false, Now - TimeSpan.FromSeconds(30), Now));
        Assert.Null(ScWebSession.NextKeepAlive(windowOpen: false, signedIn: true, Now, Now));
        Assert.Null(ScWebSession.NextKeepAlive(windowOpen: true, signedIn: false, Now, Now));
        Assert.Equal(ScWebSession.KeepAliveInterval - TimeSpan.FromSeconds(30), ScWebSession.NextKeepAlive(true, true, Now - TimeSpan.FromSeconds(30), Now));
        Assert.Equal(TimeSpan.Zero, ScWebSession.NextKeepAlive(true, true, Now - TimeSpan.FromHours(1), Now));
        // Well inside the four minutes the window's session lasted in the sessions, and checked more often than that.
        Assert.True(ScWebSession.KeepAliveInterval < TimeSpan.FromMinutes(4));
        Assert.True(ScWebSession.KeepAliveTick < ScWebSession.KeepAliveInterval);
    }

    [Fact]
    public void AnExpiredReadReentersSilentlyOnlyWhileTheStudioIsSignedIn()
    {
        Assert.Equal(ScWebSession.Expired.Reenter, ScWebSession.OnSignInPage(studioSignedIn: true, write: false, "GET", reentered: false));
        // Once per request: a second sign-in page is the answer.
        Assert.Equal(ScWebSession.Expired.Refuse, ScWebSession.OnSignInPage(true, false, "GET", reentered: true));
        // The Studio itself logged out: the only login asked is the Studio's own.
        Assert.Equal(ScWebSession.Expired.StudioSignIn, ScWebSession.OnSignInPage(studioSignedIn: false, write: false, "GET", reentered: false));
        // A write answered by the sign-in page is never resent.
        Assert.Equal(ScWebSession.Expired.Uncertain, ScWebSession.OnSignInPage(true, write: true, "POST", reentered: false));
        Assert.Equal(ScWebSession.Expired.Uncertain, ScWebSession.OnSignInPage(false, write: true, "POST", reentered: false));
        // A read postback carries page state of the old session: not replayed.
        Assert.Equal(ScWebSession.Expired.Refuse, ScWebSession.OnSignInPage(true, write: false, "POST", reentered: false));
    }

    [Fact]
    public void ALoginIsAskedOnlyWhenNothingCanReenterByItself()
    {
        Assert.Equal(ScWebSession.Ask.StudioSignIn, ScWebSession.AskFor(studioSignedIn: false, ScWebLogin.Step.SignedIn, storedLogin: true));
        Assert.Equal(ScWebSession.Ask.Nothing, ScWebSession.AskFor(true, ScWebLogin.Step.Sso, storedLogin: false));
        Assert.Equal(ScWebSession.Ask.Nothing, ScWebSession.AskFor(true, ScWebLogin.Step.Wait, storedLogin: false));
        Assert.Equal(ScWebSession.Ask.Nothing, ScWebSession.AskFor(true, ScWebLogin.Step.Fill, storedLogin: true));
        Assert.Equal(ScWebSession.Ask.StoredLogin, ScWebSession.AskFor(true, ScWebLogin.Step.Fill, storedLogin: false));
        Assert.Equal(ScWebSession.Ask.StoredLogin, ScWebSession.AskFor(true, ScWebLogin.Step.Rejected, storedLogin: true));
        Assert.Equal(ScWebSession.Ask.User, ScWebSession.AskFor(true, ScWebLogin.Step.Interactive, storedLogin: true));
    }

    [Fact]
    public void TheSignInPageIsClassifiedAndAnExpiredPageNeverCountsAsSignedIn()
    {
        Assert.Equal(ScWebSession.Page.SignedIn, ScWebSession.Classify(Host, Status(true), null));
        // The page on screen still shows the logout link, but a read was answered by the sign-in page since.
        Assert.NotEqual(ScWebSession.Page.SignedIn, ScWebSession.Classify(Host, Status(true), Page("https://lab.example"), expired: true));
        Assert.Equal(ScWebSession.Page.Loading, ScWebSession.Classify(Host, Status(false, loading: true), null));
        Assert.Equal(ScWebSession.Page.SignInForm, ScWebSession.Classify(Host, Status(false), Page("https://lab.example", form: true)));
        Assert.Equal(ScWebSession.Page.IdentityProvider, ScWebSession.Classify(Host, Status(false), Page("https://id.outsystems.com", form: true)));
        Assert.Equal(ScWebSession.Page.SingleSignOn, ScWebSession.Classify(Host, Status(false), Page("https://lab.example", sso: true)));
        Assert.Equal(ScWebSession.Page.IdentityProvider, ScWebSession.Classify(Host, Status(false), Page("https://login.example.org")));
    }

    [Fact]
    public void TheSingleSignOnChoiceIsFollowedOnceWithoutACredential()
    {
        var choice = Page("https://lab.example", sso: true);
        Assert.Equal(ScWebLogin.Step.Sso, ScWebLogin.Next(Host, Status(false), choice, null, ssoFollowed: false));
        Assert.Equal(ScWebLogin.Step.Wait, ScWebLogin.Next(Host, Status(false), choice, null, ssoFollowed: true));
        // Another origin's choice is never clicked; a fillable form still goes to the stored login.
        Assert.Equal(ScWebLogin.Step.Wait, ScWebLogin.Next(Host, Status(false), Page("https://other.example", sso: true), null, ssoFollowed: false));
        Assert.Equal(ScWebLogin.Step.Fill, ScWebLogin.Next(Host, Status(false), Page("https://id.outsystems.com", form: true, sso: true), null, ssoFollowed: false));
        // The four-argument form keeps the earlier behavior (no SSO step).
        Assert.Equal(ScWebLogin.Step.Wait, ScWebLogin.Next(Host, Status(false), choice, null));
        // The scripts read no value and no cookie.
        Assert.Contains("sso:s", ScWebLogin.State);
        Assert.DoesNotContain(".value", ScWebLogin.State);
        Assert.DoesNotContain("cookie", ScWebLogin.State, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("cookie", ScWebLogin.SsoClick, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(".value", ScWebLogin.SsoClick);
    }

    [Fact]
    public void EverySessionAnswerCarriesTheFieldsTheFacadeDetectsTheBridgeBy()
    {
        var body = new JsonObject();
        ScWebSession.Describe(body, windowOpen: true, signedIn: true, Now);
        Assert.Equal("studio-sso", body["reentry"]?.GetValue<string>());
        Assert.Equal(120, body["keepAlive"]?["intervalSeconds"]?.GetValue<int>());
        Assert.True(body["keepAlive"]?["active"]?.GetValue<bool>());
        Assert.Equal(Now.ToString("o"), body["keepAlive"]?["lastAt"]?.GetValue<string>());
        var closed = new JsonObject();
        ScWebSession.Describe(closed, windowOpen: false, signedIn: false, null);
        Assert.False(closed["keepAlive"]?["active"]?.GetValue<bool>());
    }
}
